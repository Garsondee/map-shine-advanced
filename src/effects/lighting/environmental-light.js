/**
 * ENVIRONMENTAL LIGHT — the ambient/exterior term of `light.accumulate`
 * (tier 0 of Type-A parity). Reproduces Foundry's environmental illumination:
 * the whole map is multiplied by the scene's ambient background colour, which
 * itself is `mix(ambientDaylight, ambientDarkness, DL)` — where DL is the scene
 * darkness (0..1) — so day is bright, night is Foundry's cool dark, exactly as
 * `AdaptiveIllumination` composites it (docs/reference/foundry-v14-lighting-
 * audit.md §5a, §3). The precise Foundry property this maps to is named in
 * foundry/scene-environment.js (the one place it may be — env/one-darkness).
 *
 * This is the FLOOR every later light sits on: point lights (increment 2,
 * effects/lighting/point-light-illumination.js) MAX into the SAME
 * `buf:scene.illum` this module fills, before the composite below reads it;
 * coloration SCREENs on top of that (docs/planning/Light-Parity.md §3, later).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * COLOUR SPACE — the one thing that makes parity look right or wrong, decided
 * here with the numbers, not hoped:
 *
 * Foundry composites in GAMMA space: its illumination texture MULTIPLIES the
 * sRGB map with no linearisation, no tonemap (audit §18.1 — the canvas has no
 * colour management). MSA works in LINEAR: `buf:scene.color` holds the map
 * already decoded to linear (`vt-sample.tsl.js` srgbDecode / whole-image's
 * SRGBColorSpace tag), and the present pass applies one sRGB OETF at the canvas.
 *
 * A naive `albedo_linear × background_linear` (the "linear multiply", the first
 * thing Light-Parity.md §4 says to try) is measurably too DARK at night: at
 * darkness 1 with Foundry's `#242448`, a mid-grey floor (`albedo_srgb 0.5`)
 * lands at ~0.049 vs Foundry's ~0.071 — a ~30% miss, because multiplication
 * and gamma do not commute. That gap is why V2 lighting never matched. So this
 * does the multiply in GAMMA space, the parity-correct way:
 *
 *     lit_linear = EOTF( OETF(albedo_linear) × background_srgb )
 *
 * `EOTF`/`OETF` are three's own accurate sRGB transfer (the inverse of the
 * decode that filled `buf:scene.color`), so at `background = white` (full
 * daylight, no darkening) the round-trip is the identity and the lit map is
 * PIXEL-IDENTICAL to the unlit map — which is pixel-identical to Foundry's map.
 * A no-op at noon is the strongest parity check there is.
 *
 * `buf:scene.illum` therefore holds the ambient illumination in Foundry's own
 * sRGB space (what its illumination texture is). Stated explicitly because an
 * implied colour space is exactly how the washed-out-map bug is born
 * (CONVENTIONS.md §6; Params.md §3.6 finding #1).
 *
 * @module effects/lighting/environmental-light
 */

import { buildSunVisibilityNode } from './sun-occlusion-render.js';

/**
 * Linear-interpolate two rgb triples, clamping t to [0,1].
 * @param {readonly number[]} a @param {readonly number[]} b @param {number} t
 * @returns {[number,number,number]}
 */
export function mixRgb(a, b, t) {
  const s = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
}

/** The true-black darkness endpoint the realism lever interpolates toward
 * (`computeAmbientBackground`). Frozen so it can never be mutated by a caller. */
const BLACK_RGB = Object.freeze([0, 0, 0]);

/**
 * The ambient background colour (sRGB 0..1) for a frame — Foundry's own ladder.
 *
 * Foundry (`environment.mjs#configureColors`) computes it as
 * `ambientDarkness.mix(ambientDaylight, 1 - DL)`, which is identically
 * `mix(ambientDaylight, ambientDarkness, DL)` — DL the scene darkness — so
 * daylight at DL 0, Foundry's cool dark at DL 1. Pure, so the ladder is
 * Node-tested against that formula (the parity check Light-Parity.md §5 asks for).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE DARKNESS-REALISM LEVER (2026-07-19, author-requested). Foundry floors
 * the darkest the scene ever gets at the scene's `ambientDarkness` COLOUR
 * (e.g. `[0.188,0.188,0.188]` ≈ 19% — verified: at DL 1 the formula above is
 * exactly `ambientDarkness`, never black), deliberately so GMs/players can
 * still read the map. That is the DEFAULT here (`darknessRealism01 = 0`) —
 * exact Foundry parity. The lever pulls the darkness ENDPOINT toward true
 * black: at `darknessRealism01 = 1`, the endpoint IS black, so DL 1 crushes
 * the unlit map to nothing ("realistic" pitch dark). Because it only moves the
 * darkness end of the mix, DL 0 (noon) is IDENTICAL at every lever value — the
 * lever only bites as the scene darkens. `bright` is unaffected downstream
 * (its weight is 1, so lights still reach full intensity at their cores in
 * either mode); only the unlit floor and `dim` darken. Two useful modes from
 * one scalar, Foundry-safe by default. See vt-pan-viewer.js#setDarknessRealism.
 *
 * @param {{ambient?: {daylight?: number[], darkness?: number[]}, darkness01?: number}} env - the snapshot.
 * @param {number} [darknessRealism01=0] - 0 = Foundry parity (floor at the
 *   darkness colour), 1 = true dark (floor at black). Clamped/`mixRgb`-safe.
 * @returns {[number,number,number]} the sRGB ambient background.
 */
export function computeAmbientBackground(env, darknessRealism01 = 0) {
  const ambient = env?.ambient ?? {};
  const daylight = ambient.daylight ?? [0.93, 0.93, 0.93];
  const darkness = ambient.darkness ?? [0.14, 0.14, 0.28];
  // Pull the darkness endpoint toward black by the realism lever, THEN mix
  // daylight→(that endpoint) by DL. mixRgb clamps the lever and treats a
  // non-finite value as 0 (Foundry parity), so a bad input never over-darkens.
  const darknessEndpoint = mixRgb(darkness, BLACK_RGB, darknessRealism01);
  return mixRgb(daylight, darknessEndpoint, env?.darkness01 ?? 0);
}

/**
 * Foundry's fixed lighting-level weights (`CONFIG.Canvas.lightLevels`,
 * `client/config.mjs`, default `{dark:0, halfdark:0.5, dim:0.25, bright:1}`).
 * These are engine-wide constants, not per-scene data — unless a module
 * overrides `CONFIG.Canvas.lightLevels` (not modeled here), every scene uses
 * these exact two values for the dim/bright ladder a light's illumination
 * reads (audit §5a). Only `dim`/`bright` are needed for point-light
 * illumination; `dark`/`halfdark` belong to darkness sources (later).
 */
export const FOUNDRY_LIGHT_WEIGHTS = Object.freeze({ dim: 0.25, bright: 1 });

/**
 * The three ambient colours a light's illumination channel reads (audit §5a,
 * `COMPUTE_ILLUMINATION`), derived from the SAME scalar darkness this module
 * already uses for `computeAmbientBackground` — i.e. still screen-uniform,
 * not yet per-pixel (that needs the `_Outdoors` darkness field, increment 1b):
 *
 *   background = mix(daylight, darkness, DL)         (computeAmbientBackground)
 *   bright     = mix(background, ambientBrightest, weightBright=1) = ambientBrightest
 *   dim        = mix(background, bright, weightDim=0.25)
 *
 * `bright` collapses to `ambientBrightest` exactly because Foundry's own
 * `weightBright` is always 1 — stated as a full `mix` (not hardcoded to
 * `brightest` directly) so the formula stays legible against the audit and
 * survives a future weights override without a silent behaviour change.
 *
 * The `darknessRealism01` lever (see `computeAmbientBackground`) flows through
 * here unchanged: it darkens `background` (and therefore `dim`, which is mixed
 * from it), but NOT `bright` — `bright`'s weight is 1, so it collapses to
 * `ambientBrightest` regardless of the floor, keeping light cores full-bright
 * in realistic mode while the unlit floor goes dark.
 *
 * @param {{ambient?: {daylight?: number[], darkness?: number[], brightest?: number[]}, darkness01?: number}} env
 * @param {number} [darknessRealism01=0] - 0 = Foundry parity, 1 = true dark.
 * @returns {{background: [number,number,number], dim: [number,number,number], bright: [number,number,number]}}
 */
export function computeAmbientColors(env, darknessRealism01 = 0) {
  const background = computeAmbientBackground(env, darknessRealism01);
  const brightest = env?.ambient?.brightest ?? [1, 1, 1];
  const bright = mixRgb(background, brightest, FOUNDRY_LIGHT_WEIGHTS.bright);
  const dim = mixRgb(background, bright, FOUNDRY_LIGHT_WEIGHTS.dim);
  return { background, dim, bright };
}

/**
 * GLOBAL ILLUMINATION's own contribution to the ambient FLOOR (2026-07-19 —
 * "the global light fix"). Foundry treats the scene-wide "sun" as just
 * another light (`GlobalLightSource extends BaseLightSource`), but verified
 * against source (`client/canvas/sources/global-light-source.mjs`) it skips
 * `PointEffectSourceMixin` entirely — no wall-clipped circular geometry, no
 * `.data.radius`/`.ratio` the way a real point light gets. Its shape is
 * unconditionally the whole scene rect, oversized to `maxR*1.2` — so within
 * every visible pixel, its own `dist` (distance-from-origin, radius-normalized)
 * sits near 0, which collapses its own switchColor/falloff math down to a
 * CONSTANT: always the `bright` (or `dim`, if not in "bright" mode) colour,
 * always fully applied. Reproducing that as a genuine mesh would mean faking
 * a `dist≈0` result through machinery built for a real radius; instead this
 * computes the same constant directly and MAXES it into the ambient floor —
 * mathematically identical, without a fake circular light standing in for a
 * rectangle.
 *
 * EXPOSURE (`AdaptiveIlluminationShader.EXPOSURE`, audit's own formula,
 * `client/canvas/rendering/shaders/lighting/base-lighting.mjs`):
 * `exposure = luminosity*2 - 1`. For a light whose own `dist≈0` everywhere
 * visible (true of the global light, NOT of an ordinary point light — see
 * `point-light-illumination.js`'s own per-fragment exposure term for that
 * case), the `exposure > 0` branch's spatial smoothstep term also collapses:
 * `finalExposure = quartExposure*(1-smoothstep(...,dist≈0)) + quartExposure
 * ≈ quartExposure*(1-0) + quartExposure = 2*quartExposure = exposure*0.5`.
 *
 * @param {{luminosity01: number, bright: boolean}|null} globalLightConfig -
 *   `foundry/scene-lights.js#deriveGlobalLightConfig`'s return, or `null`
 *   (not enabled / outside its darkness window) — in which case this returns
 *   `null` too: nothing to raise the floor with.
 * @param {{dim: number[], bright: number[]}} ambientColors - THIS frame's
 *   `computeAmbientColors(env)` result — the same dim/bright a point light's
 *   switchColor reads, so the global light's colour stays on the SAME ladder.
 * @returns {[number,number,number]|null}
 */
export function computeGlobalLightFloor(globalLightConfig, ambientColors) {
  if (!globalLightConfig) return null;
  const base = globalLightConfig.bright ? ambientColors.bright : ambientColors.dim;
  const exposure = globalLightConfig.luminosity01 * 2 - 1;
  const factor = exposure > 0 ? 1 + exposure * 0.5 : 1 + exposure;
  const clampedFactor = Math.max(0, factor);
  return [base[0] * clampedFactor, base[1] * clampedFactor, base[2] * clampedFactor];
}

/**
 * MAX-combine an optional floor (e.g. `computeGlobalLightFloor`'s result) into
 * an rgb triple, per channel — Foundry's own `MAX_COLOR` composite rule
 * (audit §3, §18.2), applied here at the scalar-ambient level rather than via
 * a blend-mode render, since there is no mesh to blend.
 *
 * @param {readonly number[]} rgb @param {readonly number[]|null} floor
 * @returns {[number,number,number]}
 */
export function maxRgb(rgb, floor) {
  if (!floor) return [rgb[0], rgb[1], rgb[2]];
  return [Math.max(rgb[0], floor[0]), Math.max(rgb[1], floor[1]), Math.max(rgb[2], floor[2])];
}

/**
 * Build the two fullscreen materials of the environmental-light pass:
 *   - `illumMaterial`     → fills `buf:scene.illum` with the ambient background
 *                           (sRGB). Constant per frame today; becomes per-pixel
 *                           when `_Outdoors` indoor/outdoor lands (increment 1b).
 *   - `compositeMaterial` → reads albedo (`buf:scene.color`, linear) + illum +
 *                           coloration, writes the gamma-space result (see
 *                           header) to the post-lighting colour buffer.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * COLORATION IS ADDED HERE, IN GAMMA SPACE (2026-07-19 — the fix for "MSA
 * lights wash the scene to a single hue"). Foundry ADDs the coloration layer
 * onto the scene (`coloration-effects.mjs`: `blendMode = ADD`), and its whole
 * canvas is sRGB with no colour management — so the add happens in GAMMA
 * space. MSA's earlier separate `colorationAddQuad` blended additively into
 * the LINEAR `buf:scene.lit`, which is wrong the same way a linear multiply
 * would be (this file's header essay): adding a fixed coloration value in
 * linear space disproportionately lifts the map's DARKER channels once the
 * present pass applies the sRGB OETF, flattening the map's channel ratios
 * toward the light's single hue = the monochrome wash. Folding the add into
 * THIS composite, BEFORE the final EOTF, makes it a gamma-space add exactly
 * like Foundry: `EOTF( OETF(albedo)×illum + coloration )`. At any pixel with
 * no coloration (coloration buffer 0 — e.g. noon, no point lights) this is
 * byte-identical to the old `EOTF(OETF(albedo)×illum)`, so the noon no-op
 * parity check still holds.
 *
 * The caller owns the render targets and the QuadMesh draws (the frame loop in
 * vt-pan-viewer, matching how `runMaskOcclusionPass`/present are wired); this
 * module owns only the TSL, so the shader logic lives in `effects/lighting/`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * UI-SHADOW MULTIPLIES HERE, NOT IN A SEPARATE PASS (2026-07-20 v6, author-
 * measured PERFORMANCE FIX: throttling the DOM read barely moved the FPS,
 * proving the earlier separate `uiShadowQuad.render()` call — not the DOM
 * read — was the dominant per-frame cost; a whole extra render pass carries
 * real fixed overhead even for trivial GPU math). `uiShadowVisNode`
 * (effects/lighting/light-visibility.js#buildUiShadowVisibility, optional) is
 * `1` (lit) everywhere except inside a window's projected shadow footprint,
 * where it eases toward `0`. Folding its multiply into `illumTexNode.rgb`
 * HERE is mathematically IDENTICAL to writing it back into `buf:scene.illum`
 * via a separate pass (this composite already samples illum AFTER the ambient
 * fill + regions + point lights have all accumulated into it, same as the
 * separate pass would have read) — zero extra draw calls, and it now matches
 * the EXISTING precedent exactly: coloration is likewise added only inside
 * this composite, never written back upstream. Omitting `uiShadowVisNode`
 * (undefined) uses `illumTexNode.rgb` unmultiplied — a no-op, so every OTHER
 * caller of this function is unaffected.
 *
 * @param {object} args
 * @param {*} args.THREE - the renderer namespace (carries `.TSL`).
 * @param {*} args.albedoTexture - `buf:scene.color`'s texture (linear map).
 * @param {*} args.illumTexture - `buf:scene.illum`'s texture (sRGB ambient).
 * @param {*} args.colorationTexture - `buf:scene.coloration`'s texture (the
 *   accumulated point-light coloration, sRGB-magnitude, 0 where no light
 *   tints). Added in gamma space inside the composite — see the essay above.
 * @param {*} [args.uiShadowVisNode] - optional scalar TSL node, 1..0, the
 *   UI-window-shadow visibility term (see essay above). Multiplies the illum
 *   sample before it combines with albedo; omitted = untouched (no-op).
 * @param {*} [args.outdoorsTexture] - THE SKY LIGHT's gate (2026-07-23): the
 *   `_Outdoors` mask as a texture covering `outdoorsRect` in world space, R
 *   channel 0..1. Omitted → the sky terms are compiled out entirely and every
 *   material below is byte-identical to what it was before the sky existed.
 * @param {*} [args.attrTexture] - `buf:scene.attr` (screen-space, same as
 *   `albedoTexture`/`illumTexture` — `sceneColor.textures[1]`, see
 *   `specular-render.js`'s identical param for precedent). R = the fragment's
 *   OWN floor index / 255. Omitted → the sun-shadow floor gate below compiles
 *   out entirely (JS-time branch, `tsl/no-uniform-gates`) and this pass is
 *   byte-identical to before the gate existed.
 * @param {*} [args.depthTexture] - `buf:scene.depth`'s DEPTH attachment
 *   (`vt/scene-depth.js`, screen-space, device px) — forwarded UNSAMPLED as
 *   `depthTexNode` below, purely a pass-through hub for point lights' own
 *   height/elevation gate (STAGE 2, 2026-08-04); this pass has no use for it
 *   itself. Omitted → `depthTexNode` is `null` and every consumer's own gate
 *   compiles out.
 * @param {*} [args.depthFlagsTexture] - `buf:scene.depth`'s COLOUR attachment
 *   (same target's B channel = flags byte) — the sibling pass-through,
 *   forwarded as `depthFlagsTexNode`.
 * @param {Array<{texture: *}>} [args.sunShadowFields] - `sunShadows.fields`
 *   (`sun-shadow-subsystem.js` §5) — ONE baked field per resident floor slot,
 *   fixed-length, built once at the subsystem's own construction. Each slot
 *   gets its OWN rect + floor-index uniform pair here (`setSunShadowRect`/
 *   `setSunShadowFloorIndex`, both now indexed) and every slot is blended in
 *   ARITHMETICALLY (`blendSunVisibilityAcrossFloors`, exported below) — never
 *   a `select()`/branch fold over the array, which would strand every branch
 *   but the last (`feedback_tsl_select_chain_strands_vars`). Omitted or empty
 *   → the whole block compiles out, byte-identical to before shadows existed.
 * @returns {{
 *   illumMaterial: *, compositeMaterial: *,
 *   uBackgroundSrgb: *, albedoTexNode: *, illumTexNode: *, colorationTexNode: *,
 *   depthTexNode: (*|null), depthFlagsTexNode: (*|null),
 *   setAmbient: (bgSrgb: number[]) => void,
 *   setSky: (multiplierRgb: number[]) => void,
 *   setViewRect: (rect: object) => void,
 *   setOutdoorsRect: (rect: object) => void,
 * }}
 */
export function buildEnvironmentalLightMaterials({
  THREE,
  albedoTexture,
  illumTexture,
  colorationTexture,
  uiShadowVisNode,
  outdoorsTexture,
  sunShadowFields,
  attrTexture,
  depthTexture,
  depthFlagsTexture,
}) {
  const { uniform, texture, uv, vec3, vec4, float, mix, sRGBTransferEOTF, sRGBTransferOETF } = THREE.TSL;

  // ═══════════════════════════════════════════════════════════════════════
  // THE SKY LIGHT (docs/planning/Sky.md) — atmosphere as LIGHT, not a grade.
  // ═══════════════════════════════════════════════════════════════════════
  //
  // `effects/sky-access.js` produces exactly two numbers-per-frame for this
  // pass, and this is where they land:
  //
  //   ambientMultiplierRgb → multiplies the ambient fill (chroma only)
  //   veilAddRgb           → adds into the coloration sum (the desaturator)
  //
  // BOTH ARE MASK-GATED, and gating is the entire reason this belongs in the
  // light rather than in `post.grade`. V2 had to teach its colour corrector
  // about `_Outdoors` ("procedural weather/golden-hour offsets on sky-eligible
  // outdoor pixels") because a full-screen grade is global by nature. As a
  // light, "indoors is not lit by the sky" needs no special case — the mask IS
  // where the light reaches, and it interpolates for free at a doorway.
  //
  // ⚠️ ORIENTATION — the screen→world mapping below is `scene/world-quad.js`'s
  // `quadUvToWorld`, transcribed into TSL. It has NO flip, and that is derived
  // rather than hoped: `QuadGeometry` puts v=0 at the screen TOP and
  // `computeCameraFrustum` puts `top = worldRect.minY`, so uv and world run the
  // same direction. The mask grid agrees independently (`MaskGrid.data` is
  // "row 0 = minY", and a `DataTexture` defaults to `flipY:false`, so uv.v=0
  // samples row 0 = minY). Three spaces, one direction, nothing negated.
  // Asserted in `scene/__tests__/world-quad.test.mjs`, chained to the
  // already-proven `worldToNdc` rather than re-derived.
  const uSkyMultiplier = uniform(vec3(1, 1, 1));
  /** The camera's world rect THIS frame: (minX, minY, maxX, maxY). */
  const uViewRect = uniform(vec4(0, 0, 1, 1));
  /** The world rect the outdoors texture covers: (minX, minY, maxX, maxY). */
  const uOutdoorsRect = uniform(vec4(0, 0, 1, 1));

  const outdoorsTexNode = outdoorsTexture ? texture(outdoorsTexture) : null;

  /**
   * `1` outdoors, `0` indoors, smoothly between — evaluated at the world
   * position under this screen pixel. A JS-time branch, not a uniform gate
   * (`tsl/no-uniform-gates`): with no mask ingested yet the whole lookup is
   * absent from the compiled shader rather than multiplied by a zero.
   *
   * Delegates to the shared `buildOutdoorsGate` (exported below) so the sky
   * light HERE and the environmental grade in the PRESENT pass compute the
   * gate from byte-identical maths — a second inline copy is how the two would
   * drift and gate different halves of the map.
   */
  const outdoorsAt = () => buildOutdoorsGate(THREE.TSL, { uViewRect, uOutdoorsRect, outdoorsTexNode });

  // ═══════════════════════════════════════════════════════════════════════
  // THE SUN'S OWN SHADOW (docs/planning/Sun-Shadows.md) — building, overhead
  // and sky-reach, baked into ONE scene-space visibility field.
  // ═══════════════════════════════════════════════════════════════════════
  //
  // ⚠️ IT MULTIPLIES THE AMBIENT FILL, BEFORE THE POINT LIGHTS. That placement
  // is the doctrine, not a detail:
  //
  //     illum = max( ambient x sunVisibility , pointLights )
  //
  // The sun is a PASSIVE light — it is what casts these shadows, so it can
  // never overpower them. A torch is an ACTIVE light brought in afterwards; it
  // MAX-blends on top and lights the shadowed ground straight back up, with no
  // lift, no override strength, and no shadow shader reading a light buffer.
  // (Author's own statement of the model, 2026-07-24; `composeSunTermWithMaxLight`
  // is its Node-tested scalar form.)
  //
  // The UI-window shadow multiplies in the COMPOSITE instead — AFTER the lights
  // — because it is decorative chrome over the whole picture rather than one
  // light's own occlusion. Do NOT "unify" the two: moving this one after the
  // lights would make a torch inside a building's shadow read dimmer than the
  // same torch outside it, which is `DynamicLightShadowLift` rebuilt backwards.
  // ── PER-SLOT SUN-SHADOW FIELDS (2026-08-02, §5 of sun-shadow-subsystem.js)
  // ─────────────────────────────────────────────────────────────────────────
  // `sunShadowFields` is FIXED-LENGTH (built once by the subsystem — one
  // entry per resident floor slot). One rect + one floor-index uniform PER
  // SLOT, built once here and SHARED (never copied) with every point light's
  // own material via this module's own `sunShadowSlotNodes`/`attrTexNode`
  // return values — the same "one owner, one update" discipline `uViewRect`/
  // `uOutdoorsRect` already use for bloom, generalized from one field to N.
  const sunShadowSlots = (sunShadowFields ?? []).map((field) => ({
    texNode: texture(field.texture),
    uRect: uniform(vec4(0, 0, 1, 1)),
    // -1/255, NOT 0 — see sun-shadow-subsystem.js's own §5: a real floor index
    // is always >= 0, so -1/255 is PROVABLY unreachable by any real fragment,
    // where a clamped 0 would silently read as "floor 0" for an unclaimed
    // slot (Extraction plan trap avoided, not merely worked around).
    uFloorIndex01: uniform(float(-1 / 255)),
  }));

  // THE PER-FLOOR GATE (2026-07-28, generalized to N floors 2026-08-02) — a
  // frame legitimately draws SEVERAL floors at once (Foundry v14's native
  // multi-floor `scene.levels`, gaps and all — not an edge case on a
  // multi-storey map). Without this, one floor's shadow either darkens every
  // OTHER floor's content sharing the same screen pixel (pre-2026-07-28), or
  // — the single-slot gate's own remaining gap, reported live 2026-08-02 —
  // every floor OTHER than the one currently baked gets no shadow at all,
  // because there was nowhere else for its data to live. `attrTexNode.r` is
  // the SAME per-pixel floor index `buf:scene.attr`'s real writers already
  // pack (`vt/scene-attr.js#packFloorAttr`); the per-slot comparison formula
  // (`blendSunVisibilityAcrossFloors`, exported below) is the SAME tuned
  // threshold `specular-render.js`'s own `floorMatch` uses, applied once per
  // slot and combined ARITHMETICALLY — never a `select()`/branch fold, which
  // would strand every branch's shared subgraph but the last
  // (`feedback_tsl_select_chain_strands_vars` — the specular effect lost 12 of
  // 20 debug channels to exactly that mistake).
  const attrTexNode = attrTexture ? texture(attrTexture) : null;

  // THE HEIGHT/ELEVATION GATE'S OWN HUB (STAGE 2, 2026-08-04) — a pure
  // pass-through, same "one owner, one update" discipline as `attrTexNode`
  // just above: this pass never reads either of these itself, it only holds
  // them so every point light's own material can share ONE `texture(...)`
  // node instead of building a second, independently-typed one.
  const depthTexNode = depthTexture ? texture(depthTexture) : null;
  const depthFlagsTexNode = depthFlagsTexture ? texture(depthFlagsTexture) : null;

  // --- illum pass: ambient fill, tinted by the sky where it is open --------
  const uBackgroundSrgb = uniform(vec3(0.93, 0.93, 0.93));
  const illumMaterial = new THREE.NodeMaterial();
  illumMaterial.depthTest = false;
  illumMaterial.depthWrite = false;
  {
    const outdoors = outdoorsAt();
    // `mix(1, skyMultiplier, outdoors)` — indoors keeps the untouched Foundry
    // ambient, outdoors gets the sky's hue. At `realism01 = 0` the multiplier
    // IS `[1,1,1]`, so this is a provable no-op and the pixel-identical-to-
    // Foundry parity check this module's header describes still holds exactly.
    const skyTint = outdoors ? mix(vec3(1, 1, 1), uSkyMultiplier, outdoors) : null;
    const ambient = skyTint ? uBackgroundSrgb.mul(skyTint) : uBackgroundSrgb;
    // A JS-time branch, so a scene with no baked fields compiles to byte-
    // identical shader code — and a freshly-baked all-white slot is a
    // provable no-op even when it IS compiled in.
    // ⚠️ THE FLOOR SOURCE IS `buf:scene.depth`, NOT `buf:scene.attr` (2026-08-05
    // — the shadow cascade's receiver half, and this effect's own entry into
    // [[keyhole-depth-authority-sole-system-decision]]'s "one occlusion system"
    // lock). `blendSunVisibilityAcrossFloors`'s own `attrFloorIndex01` doc has
    // the argument for why the depth pass's answer is the right one; the
    // fullscreen quad reads it at `uv()` rather than `screenUV` because this
    // pass IS the screen (the point-light path, drawing world-space quads,
    // uses `screenUV` for the identical sample — see its own call site).
    const depthFloorHere = depthFlagsTexNode ? depthFlagsTexNode.sample(uv()) : null;
    const floorSource = depthFloorHere ?? attrTexNode;
    const sunVis =
      sunShadowSlots.length === 0
        ? null
        : floorSource
          ? blendSunVisibilityAcrossFloors(THREE.TSL, {
              attrFloorIndex01: floorSource.r,
              presence: depthFloorHere ? depthFloorHere.a : null,
              slots: sunShadowSlots.map((slot) => ({
                sunVis: buildSunVisibilityNode(THREE.TSL, {
                  uViewRect,
                  uShadowRect: slot.uRect,
                  shadowTexNode: slot.texNode,
                }),
                floorIndex01: slot.uFloorIndex01,
              })),
            })
          : // Neither buffer to gate by floor — fall back to slot 0 alone,
            // the exact single-field, no-gating behaviour this had before the
            // per-floor gate existed at all (pre-2026-07-28).
            buildSunVisibilityNode(THREE.TSL, {
              uViewRect,
              uShadowRect: sunShadowSlots[0].uRect,
              shadowTexNode: sunShadowSlots[0].texNode,
            });
    illumMaterial.fragmentNode = vec4(sunVis ? ambient.mul(sunVis) : ambient, float(1));
  }

  // --- composite pass: lit = EOTF( OETF(albedo) × illum × uiShadowVis + coloration ) ------
  const albedoTexNode = texture(albedoTexture);
  const illumTexNode = texture(illumTexture);
  const colorationTexNode = texture(colorationTexture);
  const mapSrgb = sRGBTransferOETF(albedoTexNode.rgb);
  const illumWithUiShadow = uiShadowVisNode ? illumTexNode.rgb.mul(uiShadowVisNode) : illumTexNode.rgb;
  const litSrgb = mapSrgb.mul(illumWithUiShadow);
  // (The sky "veil" that used to add a neutral desaturating term here is GONE,
  // 2026-07-23 — it was the wrong mechanism, a light cannot drain chroma. The
  // environmental GRADE does it correctly in the present pass; see Grade.md §2.)
  const finalSrgb = litSrgb.add(colorationTexNode.rgb); // gamma-space ADD, Foundry parity (see essay above)

  // ⚠️ THE VISION GATE IS DELIBERATELY *NOT* HERE — it lives in its own
  // `vision.gate` fullscreen pass (`effects/vision/vision-mask-render.js#
  // buildVisionGateMaterial`). An earlier cut DID put it in this material and
  // a live run proved it insufficient: the map went correctly dark while
  // candle flames, fire particles and light coronas drew straight through the
  // fog, because those are ADDITIVE draws that land on `scene.lit` AFTER this
  // quad and never pass through it. Gating "the composite" gates the map and
  // nothing else. Do not re-add it here — a gate covering only the map is the
  // exact shape of the leak Law 7 exists to prevent.
  const litLinear = sRGBTransferEOTF(finalSrgb);
  const compositeMaterial = new THREE.NodeMaterial();
  compositeMaterial.depthTest = false;
  compositeMaterial.depthWrite = false;
  compositeMaterial.fragmentNode = vec4(litLinear, albedoTexNode.a);

  /** Push this frame's ambient background into the illum uniform (no per-frame
   * allocation — mutate the existing Vector3, like the occlusion pass's own
   * uniform updates). */
  function setAmbient(bgSrgb) {
    uBackgroundSrgb.value.set(bgSrgb[0], bgSrgb[1], bgSrgb[2]);
  }

  /**
   * Push this frame's sky multiplier (`effects/sky-access.js`). One vector, no
   * per-frame allocation — the same mutate-in-place discipline `setAmbient`
   * uses. A caller that never calls this leaves the pass a provable no-op.
   * @param {readonly number[]} multiplierRgb
   */
  function setSky(multiplierRgb) {
    uSkyMultiplier.value.set(multiplierRgb[0], multiplierRgb[1], multiplierRgb[2]);
  }

  /** The camera's world rect this frame — the screen→world half of the gate. */
  function setViewRect(rect) {
    uViewRect.value.set(rect.minX, rect.minY, rect.maxX, rect.maxY);
  }

  /** The world rect the outdoors texture covers — the world→mask half. */
  function setOutdoorsRect(rect) {
    uOutdoorsRect.value.set(rect.minX, rect.minY, rect.maxX, rect.maxY);
  }

  /** The world rect ONE slot's baked field covers. Same shape, and set from
   * the same place, as `setOutdoorsRect` — pushed only on that slot's REAL
   * rebake (`sun-shadow-subsystem.js`'s own `pushRect`), not every frame.
   * Silently a no-op past the resident slot count — a caller that races ahead
   * of `fields.length` (there is no such caller today) drops the write rather
   * than throwing mid-frame.
   * @param {number} slotIndex @param {{minX:number,minY:number,maxX:number,maxY:number}} rect
   */
  function setSunShadowRect(slotIndex, rect) {
    const slot = sunShadowSlots[slotIndex];
    if (!slot) return;
    slot.uRect.value.set(rect.minX, rect.minY, rect.maxX, rect.maxY);
  }

  /** Which floor slot `slotIndex`'s CURRENTLY bound field data actually
   * belongs to — the caller pushes this for EVERY slot, EVERY frame,
   * unconditionally, right after `sunShadows.maybeBake(...)` for every floor
   * (a slot's rebake is rare; its floor attribution must still read correctly
   * on every frame that skipped one). A non-finite/negative index (an
   * unclaimed slot, `getFloorIndex() === -1`) maps to the SAME `-1/255`
   * sentinel the slot's uniform already starts at — see this module's own
   * §5-referencing comment above for why that must NOT clamp to 0. Same
   * clamp-and-normalize formula as `specular-render.js`'s own `setFloorIndex`
   * for a REAL index, so both effects agree on what `index / 255` means for
   * the identical `buf:scene.attr` channel.
   * @param {number} slotIndex @param {number} index
   */
  function setSunShadowFloorIndex(slotIndex, index) {
    const slot = sunShadowSlots[slotIndex];
    if (!slot) return;
    slot.uFloorIndex01.value = Number.isFinite(index) && index >= 0 ? Math.min(255, index) / 255 : -1 / 255;
  }

  return {
    illumMaterial,
    compositeMaterial,
    uBackgroundSrgb,
    albedoTexNode,
    illumTexNode,
    colorationTexNode,
    setAmbient,
    setSky,
    setViewRect,
    setOutdoorsRect,
    setSunShadowRect,
    setSunShadowFloorIndex,
    /** True when SOME floor buffer was supplied and the per-floor shadow gate
     * is actually compiled into the ambient fill — same diagnostic posture as
     * `skyGateCompiled` below and `specular-render.js`'s `floorGateCompiled`. */
    sunShadowFloorGateCompiled: !!(depthFlagsTexNode || attrTexNode),
    /** WHICH buffer that gate is actually reading. Reported rather than
     * assumed: `buf:scene.depth` and `buf:scene.attr` carry the same
     * `floorIndex / 255` in the same channel, so a shadow gated on the WRONG
     * one looks completely normal until a hole in a floor disagrees — and
     * "which authority is this effect on" is exactly the question
     * [[keyhole-depth-authority-sole-system-decision]]'s lock exists to keep
     * answerable per effect. */
    sunShadowFloorGateSource: depthFlagsTexNode ? 'scene.depth' : attrTexNode ? 'scene.attr' : 'none',
    /** Per-slot `{texNode, uRect, uFloorIndex01}` — SHARED with every point
     * light's own material (`point-light-illumination.js`), which samples the
     * SAME fields per-fragment so its background floor matches the shadowed
     * ambient at THAT pixel rather than one scalar for the whole light. Same
     * share-the-uniform pattern `uViewRect`/`uOutdoorsRect` already use for
     * bloom, generalized from one field to N: one owner, one update per slot,
     * no second copy to drift. */
    sunShadowSlotNodes: sunShadowSlots,
    /** The SAME `buf:scene.attr` sampler this module reads for its own floor
     * gate, shared with point lights for theirs — see `sunShadowSlotNodes`'
     * own doc for why a second `texture(attrTexture)` node is not built there
     * instead. */
    attrTexNode,
    /** `buf:scene.depth`'s DEPTH attachment, UNSAMPLED — every point light's
     * own height/elevation gate shares this ONE node (STAGE 2, 2026-08-04).
     * `null` when no `depthTexture` was supplied, same "compiles out" posture
     * as `attrTexNode`. */
    depthTexNode,
    /** `buf:scene.depth`'s COLOUR attachment (B = flags byte), UNSAMPLED —
     * the gate's Tile-"Restrict Lighting" hard-block input, `depthTexNode`'s
     * sibling. */
    depthFlagsTexNode,
    /** True when at least one shadow field was supplied and the sun-occlusion
     * term is actually compiled into the ambient fill — reported by the
     * diagnostics so "there are no cast shadows" is answerable without
     * guessing whether the feature is even in the shader. */
    sunShadowCompiled: sunShadowSlots.length > 0,
    /** The ONE shared outdoors sampler — the illum fill reads it, AND the
     * environmental grade in the present pass reads THE SAME node, so a mask
     * bake (`.value = newTexture`) updates both. Rebind-not-rebuild, the pattern
     * the present pass uses for a resize. */
    outdoorsTexNode,
    /** The gate's two rect uniforms — shared with the present-pass grade so both
     * compute the same screen→world→mask mapping (see `buildOutdoorsGate`). */
    uViewRect,
    uOutdoorsRect,
    /** True when a mask was supplied and the sky terms are actually compiled
     * in — reported by the diagnostics so "the sky does nothing" is always
     * answerable (feedback_instruments_must_not_lie). */
    skyGateCompiled: !!outdoorsTexNode,
  };
}

/**
 * THE SHARED CORE — sample the outdoors mask at a given WORLD position.
 * Both {@link buildOutdoorsGate} (screen-space callers: a fullscreen quad's
 * `uv()` remapped through the camera's view rect) and
 * {@link buildWorldSpaceOutdoorsGate} (world-space callers: a real mesh's own
 * `positionWorld`, e.g. `buf:scene.attr`'s G channel) resolve `worldX`/`worldY`
 * their own way and hand them here — this is the ONE place "world XY → mask UV
 * → sample" is written, so the two mappings can never independently drift on
 * that shared half.
 *
 * @param {*} TSL - THREE.TSL.
 * @param {*} uOutdoorsRect - vec4 uniform, the rect the mask covers.
 * @param {*} outdoorsTexNode - the `_Outdoors` texture node (already checked non-null).
 * @param {*} worldX @param {*} worldY
 * @returns {*} a scalar 0..1 node.
 */
/**
 * ⚠️⚠️ THE PER-FLOOR SUN-VISIBILITY BLEND — ARITHMETIC, NEVER `select()`
 * (2026-08-02, `feedback_tsl_select_chain_strands_vars`: a `select()`/branch
 * fold over a shared subgraph strands every branch's OWN variable assignment
 * but the last one the graph walk reaches — the specular effect lost 12 of 20
 * debug channels to exactly this, silently, reading a plausible-looking `0`
 * instead of throwing). Each `slots[i].sunVis` is already its OWN fully
 * independent node graph (a fresh `texture(...).sample(...)` per slot, never
 * shared across slots), so there is nothing here FOR a branch to strand — but
 * the combination step is written arithmetically anyway, on principle, so a
 * future edit that adds shared state to a slot's own graph cannot silently
 * reintroduce the trap by changing how this file combines them.
 *
 * The formula, per slot: `weight_i = 1 − smoothstep(0.4/255, 0.9/255,
 * |attrFloorIndex01 − slots[i].floorIndex01|)` — the SAME tuned "same floor"
 * threshold `specular-render.js`'s own `floorMatch` uses (one threshold in
 * this codebase, not a second copy that could disagree). Floor indices are
 * mutually exclusive by construction (`vt/scene-attr.js#packFloorAttr` writes
 * exactly one per fragment), so at most one `weight_i` is ever meaningfully
 * non-zero; the result is `Σ(sunVis_i × weight_i) + (1 − Σweight_i)` — every
 * matched slot contributes its OWN sampled visibility, and whatever fraction
 * of weight matched NOTHING (no resident slot for this fragment's floor)
 * defaults to `1`, i.e. fully lit, never accidentally darkened by a field
 * that was never computed for it. At `slots.length === 1` this is
 * byte-identical to the pre-multi-floor formula, `mix(1, sunVis, weight)` —
 * the single-slot case this generalizes, not a new behaviour for it.
 *
 * @param {*} TSL - THREE.TSL.
 * @param {object} args
 * @param {*} args.attrFloorIndex01 - this FRAGMENT's own floor index / 255.
 *   ⚠️ SOURCED FROM `buf:scene.depth`'s COLOUR ATTACHMENT since 2026-08-05
 *   (`depthFlagsTexNode.r`), not `buf:scene.attr` — the parameter keeps its
 *   name only because renaming it would touch every caller and every test for
 *   no behavioural gain; the VALUE is now the depth authority's own answer.
 *   Both channels carry `floorIndex / 255` and both are written by the same
 *   two-step membership-then-band lookup (`vt/scene-depth.js#
 *   resolveSceneDepthFloorIndex` mirrors `scene-attr.js#computeFloorAttrValues`),
 *   so the arithmetic below is unchanged — but the depth pass decides the
 *   winner with a hard `LessDepth` test and a real alpha-test discard, where
 *   attr decided it with an ALPHA-BLENDED MRT write. That is the difference
 *   between "the surface actually visible here" and "whatever last blended
 *   into this texel", and it is why the sun shadow now falls through a hole
 *   onto exactly the floor the eye sees through it
 *   ([[keyhole-orthographic-hole-stack-model]],
 *   [[keyhole-depth-authority-sole-system-decision]]).
 * @param {*} [args.presence] - `depthFlagsTexNode.a` — 1 where the depth pass
 *   wrote a real surface, 0 where nothing drew. Optional: a caller with no
 *   depth colour to read omits it and gets the pre-2026-08-05 behaviour
 *   exactly.
 * @param {Array<{sunVis: *, floorIndex01: *}>} args.slots - one entry per
 *   resident field slot: `sunVis` is that slot's ALREADY-SAMPLED scalar node
 *   (`buildSunVisibilityNode`'s return, called once per slot by the caller —
 *   HOW a slot samples its own field differs between a screen-space quad and
 *   a world-space mesh, which is exactly why that step stays the caller's,
 *   not this function's); `floorIndex01` is that slot's own uniform.
 * @returns {*} a scalar 0..1 node.
 */
export function blendSunVisibilityAcrossFloors(TSL, { attrFloorIndex01, slots, presence = null }) {
  const { float, smoothstep, abs } = TSL;
  let totalWeight = float(0);
  let blended = float(0);
  for (const slot of slots) {
    let weight = float(1).sub(
      smoothstep(float(0.4 / 255), float(0.9 / 255), abs(attrFloorIndex01.sub(slot.floorIndex01)))
    );
    // ⚠️ PRESENCE, WHEN THE CALLER CAN SUPPLY IT (2026-08-05, the depth
    // migration). `buf:scene.depth`'s colour attachment clears to `(0,0,0,0)`
    // and is only written where an item passed its own alpha test — so a pixel
    // with NO drawn surface at all reads `floorIndex = 0`, which matches floor
    // 0's slot exactly and would apply the ground floor's shadow to a hole in
    // the map. `buf:scene.attr` had the same shape and the same latent gap; it
    // was invisible there only because an empty pixel has no albedo to darken.
    // A point light does not have that luxury — it multiplies its own falloff
    // by this, and would carve a ground-floor building's silhouette out of a
    // light shining over open nothing.
    //
    // Multiplied into the WEIGHT rather than the result, so an absent surface
    // falls through to this function's existing "matched nothing ⇒ fully lit"
    // arm instead of needing a second, differently-shaped default.
    if (presence) weight = weight.mul(presence);
    blended = blended.add(slot.sunVis.mul(weight));
    totalWeight = totalWeight.add(weight);
  }
  return blended.add(float(1).sub(totalWeight));
}

function sampleOutdoorsAtWorldXY(TSL, uOutdoorsRect, outdoorsTexNode, worldX, worldY) {
  const { vec2 } = TSL;
  const outU = worldX.sub(uOutdoorsRect.x).div(uOutdoorsRect.z.sub(uOutdoorsRect.x));
  const outV = worldY.sub(uOutdoorsRect.y).div(uOutdoorsRect.w.sub(uOutdoorsRect.y));
  // Clamped rather than wrapped: a pixel off the map's edge gets the nearest
  // edge value, never a wrapped sample from the opposite side of the scene.
  return outdoorsTexNode.sample(vec2(outU.clamp(0, 1), outV.clamp(0, 1))).r;
}

/**
 * THE OUTDOORS GATE — `1` outdoors, `0` indoors, at the world position under a
 * fullscreen quad's pixel. The ONE definition of the screen→world→mask mapping,
 * shared by the sky light (this file's composite) and the environmental grade
 * (the present pass). A second inline copy is exactly how the two would drift
 * and gate different halves of the map.
 *
 * Returns `null` when no mask node is supplied — a JS-time branch, so the whole
 * lookup is compiled OUT rather than multiplied by a zero (`tsl/no-uniform-gates`).
 * The orientation has no flip and that is derived, not hoped — see this file's
 * own `outdoorsAt` note and `scene/world-quad.js#quadUvToWorld`.
 *
 * @param {*} TSL - THREE.TSL.
 * @param {object} args
 * @param {*} args.uViewRect - vec4 uniform, the camera world rect (minX,minY,maxX,maxY).
 * @param {*} args.uOutdoorsRect - vec4 uniform, the rect the mask covers.
 * @param {*} args.outdoorsTexNode - the `_Outdoors` texture node, or null.
 * @returns {*|null} a scalar 0..1 node, or null if no mask.
 */
export function buildOutdoorsGate(TSL, { uViewRect, uOutdoorsRect, outdoorsTexNode }) {
  if (!outdoorsTexNode) return null;
  const { uv, mix } = TSL;
  const worldX = mix(uViewRect.x, uViewRect.z, uv().x);
  const worldY = mix(uViewRect.y, uViewRect.w, uv().y);
  return sampleOutdoorsAtWorldXY(TSL, uOutdoorsRect, outdoorsTexNode, worldX, worldY);
}

/**
 * THE WORLD-SPACE OUTDOORS GATE — the sibling {@link buildOutdoorsGate} does
 * NOT cover: a real world-space MESH (a map tile, a vegetation quad) whose
 * OWN `uv()` is its local texture-sample coordinate, not a screen-spanning
 * one. Remapping a tile's local UV through `uViewRect` (as the screen-space
 * gate does) would silently sample the wrong world position — this reads
 * `positionWorld.xy` instead, TSL's own per-fragment world-position varying,
 * and needs no view rect at all.
 *
 * Added for `buf:scene.attr`'s G channel (`docs/planning/v3/B0-1-floor-
 * attribute-buffer.md` §2.1 — "Sampled in the unified pass's fragment shader
 * from the owning floor's low-res outdoors texture") — the first world-space
 * caller of the outdoors mask.
 *
 * @param {*} TSL - THREE.TSL.
 * @param {object} args
 * @param {*} args.uOutdoorsRect - vec4 uniform, the rect the mask covers.
 * @param {*} args.outdoorsTexNode - the `_Outdoors` texture node, or null.
 * @returns {*|null} a scalar 0..1 node, or null if no mask.
 */
export function buildWorldSpaceOutdoorsGate(TSL, { uOutdoorsRect, outdoorsTexNode }) {
  if (!outdoorsTexNode) return null;
  const { positionWorld } = TSL;
  return sampleOutdoorsAtWorldXY(TSL, uOutdoorsRect, outdoorsTexNode, positionWorld.x, positionWorld.y);
}
