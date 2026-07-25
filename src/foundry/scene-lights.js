/**
 * THE LIGHT-SOURCE READER — reads `canvas.effects.lightSources` for the
 * point-light illumination rung of `light.accumulate` (docs/planning/
 * Light-Parity.md §5 increment 2; docs/reference/foundry-v14-lighting-
 * audit.md §1-§2 for the mechanism this mirrors), PLUS the scene's own
 * Global Illumination config (added 2026-07-19, the "global light fix"),
 * PLUS (2026-07-20) each light's `animation` config — the last item in
 * Light-Parity.md §5's build order, see effects/lighting/animations/
 * registry.js for where `animation.type` gets consumed.
 *
 * Foundry has ALREADY resolved grid units to PIXELS and computed the
 * wall-clipped visibility polygon by the time a source is live in this
 * collection: `client/canvas/placeables/light.mjs#_getLightSourceData`
 * converts `dim`/`bright` to `dimRadius`/`brightRadius` (grid × distancePixels)
 * BEFORE the source is ever initialized, and `PointLightSource._initialize`
 * sets `data.radius = max(dim,bright)` — so `.radius`/`.ratio` read off a live
 * source are ready to consume as-is. (Unlike `readGridDistancePixels` in
 * scene-occlusion-sources.js, which converts an AUTHORED grid-unit field
 * itself — a different, still-grid-units field on Token, not AmbientLight.)
 *
 * PER-LIGHT DARKNESS ACTIVATION WINDOW (`LightData.darkness = {min,max}`,
 * `common/data/data.mjs` — a real, general per-light field: a GM can
 * configure ANY light, not just the sun, to "only turn on after dusk").
 * `deriveLightSnapshot` now takes the scene's `darkness01` and returns `null`
 * (skip, not draw) when it falls outside the light's own window — the SAME
 * "return null to skip a degenerate light" convention already used for a
 * zero radius or a malformed polygon.
 *
 * STILL EXCLUDES `sourceId === 'globalLight'` from THIS reader specifically
 * — but no longer because global light is unhandled. Verified against
 * source (`client/canvas/sources/global-light-source.mjs`): `GlobalLightSource
 * extends BaseLightSource` DIRECTLY, skipping `PointEffectSourceMixin`
 * entirely — it never gets a `.data.radius`/`.ratio` computed at all, and its
 * shape is unconditionally `canvas.dimensions.sceneRect.toPolygon()` (a huge
 * scene-covering rectangle, oversized to `maxR*1.2`), not a wall-clipped
 * circular polygon. Forcing it through the SAME circular mesh/switchColor/
 * falloff pipeline built for real point lights would mean re-deriving radius/
 * ratio semantics that do not really apply to it. Instead: `deriveGlobalLight
 * Config`/`readGlobalLightConfig` read the scene's `environment.globalLight`
 * config DIRECTLY (a plain schema-backed document field, not a live PIXI
 * source's derived geometry) and hand back a small, purpose-built shape the
 * AMBIENT FLOOR (not a mesh) raises to — see `effects/lighting/
 * environmental-light.js#computeGlobalLightFloor`.
 *
 * Split pure-vs-live the same way `scene-environment.js`/`scene-occlusion-
 * sources.js` already do: `deriveLightSnapshot`/`deriveGlobalLightConfig` are
 * the testable validation logic, `readActiveLightSources`/
 * `readGlobalLightConfig` are the live, impure gatherers. Never throws.
 *
 * @module foundry/scene-lights
 */

/** @param {*} v @returns {number} clamped to [0,1]; a non-finite input reads as 0 */
function clamp01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/**
 * Validate and normalize one raw light-source read into the shape the
 * illumination pass consumes, or `null` if it should not be drawn this frame.
 *
 * @param {*} raw - `{sourceId, x, y, radius, ratio, attenuation, luminosity,
 *   darknessMin, darknessMax, shapePoints}`, already plucked from a live
 *   `PointLightSource` (or a Node-test stand-in with the same shape).
 * @param {number} [darkness01] - the scene's current darkness (0..1). Missing
 *   or non-finite reads as 0 (matches `deriveDarkness`'s own "could not read"
 *   floor) — a light with the schema-default window ({min:0,max:1}) still
 *   draws either way, so an absent darkness never hides an ordinary light.
 * @returns {{sourceId: string, x: number, y: number, radius: number,
 *   ratio: number, attenuation01: number, luminosity01: number,
 *   alpha01: number, color: [number,number,number], hasColor: boolean,
 *   shadows01: number, animation: ReturnType<typeof deriveAnimationSnapshot>,
 *   shapePoints: number[]}|null}
 */
export function deriveLightSnapshot(raw, darkness01) {
  if (!raw || typeof raw.sourceId !== 'string' || raw.sourceId.length === 0) return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const radius = Number(raw.radius);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // A radius-0 (or disabled/suppressed, which Foundry itself resolves to
  // radius via _getPolygonConfiguration's `disabled ? 0 : radius`) light
  // contributes nothing — skip rather than triangulate a degenerate shape.
  if (!Number.isFinite(radius) || radius <= 0) return null;
  // The darkness ACTIVATION window (LightData.darkness, default {min:0,max:1}
  // — i.e. "always on" unless a GM narrows it). A dark01 that cannot be read
  // reads as 0, same floor `deriveDarkness` itself uses.
  const dl01 = Number.isFinite(darkness01) ? darkness01 : 0;
  const darknessMin = clamp01(raw.darknessMin ?? 0);
  const darknessMax = clamp01(raw.darknessMax ?? 1);
  if (dl01 < darknessMin || dl01 > darknessMax) return null;
  const points = Array.isArray(raw.shapePoints) ? raw.shapePoints : null;
  // A valid polygon needs >= 3 vertices (6 flat numbers), even length, and
  // every coordinate finite — Foundry's own sweep can legitimately return a
  // degenerate shape mid-recompute (e.g. an origin sitting exactly on a
  // wall); skip rather than feed the fan-triangulator garbage.
  if (!points || points.length < 6 || points.length % 2 !== 0 || !points.every(Number.isFinite)) return null;
  // Computed once, read twice below (color's own placeholder + hasColor's
  // gate) — see the field comments for why both exist.
  const colorRgb = validRgb(raw.color);
  return {
    sourceId: raw.sourceId,
    x,
    y,
    radius,
    ratio: clamp01(raw.ratio),
    attenuation01: clamp01(raw.attenuation ?? 0.5),
    // LightData.luminosity default 0.5 (common/data/data.mjs) — the EXPOSURE
    // uniform's own neutral point (exposure = luminosity*2-1 = 0 at 0.5), so
    // a light that never sets this reads as a no-op adjustment, matching
    // Foundry's own default exactly. Checked explicitly (not `?? 0.5` then
    // clamp01) so a NaN/malformed read lands on the SAME neutral default as
    // a missing one, rather than clamp01's own generic 0-floor (correct for
    // ratio/attenuation, wrong here — 0 is a real, very different exposure).
    luminosity01: clamp01(Number.isFinite(raw.luminosity) ? raw.luminosity : 0.5),
    // LightData.alpha default 0.5 — the coloration channel's own intensity
    // knob (effects/lighting/point-light-coloration.js#computeColorationAlpha).
    alpha01: clamp01(Number.isFinite(raw.alpha) ? raw.alpha : 0.5),
    // LightData.color default null ("colourless"). CORRECTED (2026-07-19,
    // the "lights read monochrome" bug): a colourless light does NOT tint
    // neutrally in real Foundry — verified against source, this project's
    // earlier assumption here was never checked and was wrong. The
    // coloration layer's own `isRequired` getter (coloration-lighting.mjs)
    // returns `forceDefaultColor || hasColor`, and `hasColor = data.color
    // !== null` (rendered-effect-source.mjs#_initializeColors, `_flags.
    // hasColor`). Technique 1 ("Adaptive Luminance", the ONLY technique this
    // project has built) never sets `forceDefaultColor` (that's only the
    // other 12 "effect" techniques — chroma/fairy-light/energy-field/etc.)
    // — so a colourless light's coloration layer is SKIPPED ENTIRELY in real
    // Foundry, contributing nothing at all, not a neutral tint. `color`
    // still reads as white here (a harmless placeholder value, never
    // actually sampled once hasColor gates the mesh off); `hasColor` is the
    // field vt-pan-viewer.js's updatePointLightMeshes must gate the
    // coloration mesh's visibility on. Getting this backwards is exactly
    // what was desaturating the map toward monochrome: every colourless
    // light was additively washing `white × colorationAlpha × reflection`
    // onto the scene, unconditionally.
    color: colorRgb ?? [1, 1, 1],
    hasColor: colorRgb !== null,
    // LightData.shadows default 0 (common/data/data.mjs) — the coloration
    // channel's own "protect dark map areas from the light's hue" knob
    // (coloration-lighting.mjs's SHADOW block: `mix(1, smoothstep(0.25, 0.35,
    // perceivedBrightness(baseColor.rgb)), shadows)`, verified against the
    // vendored source). A GM raises this on a light to keep ink-dark linework
    // from reading tinted under a saturated torch/candle — the artist-facing
    // fix for "coloured light bleaches black line art" that Foundry itself
    // already ships, previously unread here (see effects/lighting/point-
    // light-coloration.js's own header). 0 = today's unchanged behaviour.
    shadows01: clamp01(Number.isFinite(raw.shadows) ? raw.shadows : 0),
    animation: deriveAnimationSnapshot(raw.animation),
    shapePoints: points,
  };
}

/** @param {*} c @returns {[number,number,number]|null} a finite, clamped rgb triple, or null */
function validRgb(c) {
  if (!Array.isArray(c) || c.length < 3) return null;
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const n = Number(c[i]);
    if (!Number.isFinite(n)) return null;
    out[i] = Math.min(1, Math.max(0, n));
  }
  return out;
}

/** @param {*} v @param {number} min @param {number} max @param {number} fallback @returns {number} */
function clampRange(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * `LightData.animation` (`common/data/data.mjs`, per docs/reference/foundry-v14-
 * lighting-audit.md §1) — read for the animated-lights rung (docs/planning/
 * Light-Parity.md §5's last build-order item; docs/reference/foundry-v14-light-
 * animations-audit.md is the per-animation implementation reference). `seed` is
 * NOT nested under LightData — it lives on `RenderedEffectSource`'s own data and
 * gets merged INTO `source.animation` at source init (`rendered-effect-source.mjs`:
 * `this.animation = this.data.animation = {seed, ...this.data.animation}`), so a
 * live source's `.animation.seed` is already the exact value Foundry itself
 * renders with — read it directly rather than having MSA invent its own random
 * seed (that would desync MSA's animation phase from a live A/B against Foundry
 * for no reason). `type: null`/unrecognized is the "no animation" case — the
 * animation registry (effects/lighting/animations/registry.js) simply has no
 * entry for it, and the light safety-slides to today's default look.
 *
 * @param {*} raw - `{type, speed, intensity, reverse, seed}`, already plucked
 *   from a live source's `.animation` (or `undefined` for a source with none).
 * @returns {{type: string|null, speedRaw: number, intensityRaw: number,
 *   reverse: boolean, seed: number}}
 */
function deriveAnimationSnapshot(raw) {
  return {
    type: typeof raw?.type === 'string' && raw.type.length > 0 ? raw.type : null,
    // LightData.animation.speed/.intensity defaults (audit §1): 5/5, ranges 0-10/1-10.
    speedRaw: clampRange(raw?.speed, 0, 10, 5),
    intensityRaw: clampRange(raw?.intensity, 1, 10, 5),
    reverse: !!raw?.reverse,
    // 0 is a safe fallback (worst case: same-seeded lights start in phase with
    // each other, a cosmetic desync miss, never a crash) — matches this file's
    // own "an unreadable value floors to a harmless default" convention.
    seed: Number.isFinite(raw?.seed) ? raw.seed : 0,
  };
}

/**
 * Live read of every active, non-global point light source currently within
 * its own darkness activation window. Never throws — a Foundry API surprise
 * here must never take a render frame down with it (same reasoning as
 * `readSceneDarkness`/`readSceneAmbient`).
 *
 * @param {number} darkness01 - the scene's current darkness (0..1), from the
 *   SAME env snapshot the caller already built this frame — see this
 *   module's header for why an unreadable value floors to 0 rather than
 *   blocking every light.
 * @returns {{lights: Array<NonNullable<ReturnType<typeof deriveLightSnapshot>>>,
 *   source: 'scene'|'default', reason: string|null}}
 */
export function readActiveLightSources(darkness01) {
  try {
    const collection = typeof canvas !== 'undefined' ? (canvas?.effects?.lightSources ?? null) : null;
    if (!collection) {
      return {
        lights: [],
        source: 'default',
        reason: 'no active scene (canvas.effects.lightSources is absent) — reading as zero lights, not guessed',
      };
    }
    const lights = [];
    for (const source of collection) {
      if (!source || source.sourceId === 'globalLight') continue;
      if (!source.active) continue; // attached && !disabled && !suppressed (BaseEffectSource#active)
      const snap = deriveLightSnapshot(
        {
          sourceId: source.sourceId,
          x: source.x,
          y: source.y,
          radius: source.radius,
          ratio: source.ratio,
          attenuation: source.data?.attenuation,
          luminosity: source.data?.luminosity,
          alpha: source.data?.alpha,
          // THE LIGHT COLOUR — CORRECTED (2026-07-19, the ACTUAL root cause
          // of "MSA lights make the scene black and white"). The old read
          // here was `source.data.color?.rgb` with a confident comment
          // claiming `data.color` is a `Color` instance. That is WRONG for a
          // live SOURCE (as opposed to the AmbientLight DOCUMENT): verified
          // against source, `RenderedPointSource#_initialize`
          // (client/canvas/sources/rendered-effect-source.mjs:212) does
          // `this.data.color = color.valid ? color.valueOf() : null` — and
          // `Color extends Number`, so `.valueOf()` is a PLAIN INTEGER (e.g.
          // 0xFF9900), which has no `.rgb` getter. So `source.data.color.rgb`
          // was `undefined` for EVERY light → every light read as colourless
          // white → the coloration channel washed WHITE (not each torch's
          // real hue) across the whole scene = the desaturation the author
          // reported. Foundry itself pre-computes the normalized [r,g,b] its
          // OWN shaders read as `source.colorRGB` (set by `Color.applyRGB`
          // right beside that line; `null` when the light has no colour), so
          // read THAT — it is exactly the value Foundry renders with, and its
          // null-ness is exactly Foundry's own `hasColor` (deriveLightSnapshot
          // turns a null/invalid colour into hasColor:false, matching the
          // `_flags.hasColor = data.color !== null` on the same source lines).
          color: source.colorRGB,
          shadows: source.data?.shadows,
          darknessMin: source.data?.darkness?.min,
          darknessMax: source.data?.darkness?.max,
          // See deriveAnimationSnapshot's own header for why `source.animation`
          // (not `source.data.animation`) is the correct read — seed lives here.
          animation: source.animation,
          shapePoints: source.shape?.points,
        },
        darkness01
      );
      if (snap) lights.push(snap);
    }
    return { lights, source: 'scene', reason: null };
  } catch (err) {
    return {
      lights: [],
      source: 'default',
      reason: `reading canvas.effects.lightSources threw: ${err?.message ?? err}`,
    };
  }
}

/* -------------------------------------------- */
/*  Global Illumination ("the sun")              */
/* -------------------------------------------- */

/**
 * Validate + gate the scene's Global Illumination config, or `null` if it
 * should not raise the ambient floor this frame (disabled, or the current
 * darkness sits outside its own window — mirrors `GlobalLightSource
 * ._updateCommonUniforms`'s `globalLightThresholds` discard, at scene-scalar
 * granularity rather than per-pixel; the per-pixel upgrade rides the same
 * darkness field the region-darkness work builds).
 *
 * @param {*} raw - `{enabled, darknessMin, darknessMax, luminosity, bright}`,
 *   already plucked from `canvas.scene.environment.globalLight`.
 * @param {number} [darkness01]
 * @returns {{luminosity01: number, bright: boolean}|null}
 */
export function deriveGlobalLightConfig(raw, darkness01) {
  if (!raw?.enabled) return null;
  const dl01 = Number.isFinite(darkness01) ? darkness01 : 0;
  // GlobalLightData reuses LightData.darkness, but ITS OWN class default
  // (GlobalLightSource.defaultData.darkness = {min:0,max:0}) differs from the
  // SCENE SCHEMA's default ({min:0,max:1}, common/documents/scene.mjs — the
  // one that actually applies to an unconfigured scene's real document data,
  // verified against #configureGlobalLight's merge order). Default to the
  // SCHEMA's {0,1} here — "always on once enabled" — not the source class's
  // internal {0,0} fallback, which would silently never activate.
  const darknessMin = clamp01(raw.darknessMin ?? 0);
  const darknessMax = clamp01(raw.darknessMax ?? 1);
  if (dl01 < darknessMin || dl01 > darknessMax) return null;
  return {
    // GlobalLightData.luminosity default 0 (common/documents/scene.mjs) —
    // UNLIKE a normal light's 0.5, so a freshly-enabled Global Illumination
    // with nothing else touched reads as a real (negative) exposure, exactly
    // as Foundry itself would render it — not silently bumped to "neutral".
    luminosity01: clamp01(raw.luminosity ?? 0),
    bright: !!raw.bright,
  };
}

/**
 * Live read of the scene's Global Illumination config. Never throws — same
 * reasoning as every other `readScene*`/`readActive*` function here.
 *
 * @param {number} darkness01
 * @returns {{config: ReturnType<typeof deriveGlobalLightConfig>, source:
 *   'scene'|'default', reason: string|null}}
 */
export function readGlobalLightConfig(darkness01) {
  try {
    const g = typeof canvas !== 'undefined' ? (canvas?.scene?.environment?.globalLight ?? null) : null;
    if (!g) {
      return {
        config: null,
        source: 'default',
        reason: 'no active scene (canvas.scene.environment.globalLight is absent) — reading as disabled',
      };
    }
    const config = deriveGlobalLightConfig(
      {
        enabled: g.enabled,
        darknessMin: g.darkness?.min,
        darknessMax: g.darkness?.max,
        luminosity: g.luminosity,
        bright: g.bright,
      },
      darkness01
    );
    return { config, source: 'scene', reason: null };
  } catch (err) {
    return {
      config: null,
      source: 'default',
      reason: `reading canvas.scene.environment.globalLight threw: ${err?.message ?? err}`,
    };
  }
}
