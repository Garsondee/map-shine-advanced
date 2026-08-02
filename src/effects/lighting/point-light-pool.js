/**
 * THE POINT-LIGHT POOL — the mesh pool, its two dedicated scenes, the candle
 * wall-clip cache, and the per-frame reconcile, as one owned unit. Extraction
 * step 3 of `docs/planning/VT-Pan-Viewer-Extraction.md` (2026-07-25),
 * following step 1 (`sun-shadow-subsystem.js`) and step 2
 * (`../vegetation-shadow-subsystem.js`) exactly.
 *
 * ============================================================================
 * THE RULE THIS FOLLOWS (Extraction plan §1)
 * ============================================================================
 *
 * "A subsystem is not extracted while it still reads closure state. No
 * explicit parameter list = it did not happen." Every input this module needs
 * is named in {@link createPointLightPool}'s destructured argument — and, one
 * level down, in {@link createLightEntry}'s: that helper is a genuine
 * TOP-LEVEL function (not nested inside `createPointLightPool`, purely so the
 * size ratchet measures it separately — see its own header), so it takes
 * every one of `createPointLightPool`'s closure values it needs as an
 * explicit param too, rather than reaching for them.
 *
 * ============================================================================
 * ⚠️ ONE THING DELIBERATELY DID NOT MOVE: `uGlobalTimeMs`
 * ============================================================================
 *
 * The obvious first instinct is that the shared animation-clock uniform
 * belongs to whichever subsystem writes it — and `updatePointLightMeshes`
 * (now `update()` below) is the only writer. But it is read by roughly a
 * dozen OTHER consumers with no relationship to point lights at all: the wind
 * sim's input bundle, vegetation motion sync, several TSL light-animation
 * builders, and diagnostics. Moving the uniform NODE itself in here would
 * mean every one of those unrelated callers reaching back INTO this module
 * for a general-purpose clock — the wrong owner, chosen only because this is
 * where the one WRITE happens to live. `uGlobalTimeMs` stays a `vt-pan-
 * viewer.js` primitive, exactly like `dimensions`/`scene`, and is taken here
 * as a plain VALUE (it is a `const`, never reassigned — only `.value` is
 * written, which this module still does, on the caller's behalf, via
 * `update()`).
 *
 * ============================================================================
 * ⚠️ GETTERS VS VALUES (Extraction plan trap #1)
 * ============================================================================
 *
 * `getWindHandle` is a GETTER: `windHandle` is REASSIGNED in the viewer on
 * every rebake (a handle is frozen at construction; a rebake mints a new one
 * with `version + 1` — `world/wind-access.js`'s own header). Capturing the
 * value would freeze every light's wind response at whatever bake existed
 * when this pool was constructed.
 *
 * `envLight`, `sunShadows`, `sceneColor` are taken as plain VALUES: none of
 * the three is ever reassigned as a variable in the viewer (only their
 * internal fields/textures are updated in place — `rebindLighting()` re-
 * pushes `sceneColor.texture` after a resize, for instance), so the object
 * reference stays valid for this pool's whole lifetime, and `.texture`/
 * `.uSunShadowRect` are read live at each use, same as the original code.
 *
 * `getCandleRenderState` is already a getter-shaped seam injected into
 * `startVtPanViewer` from `boot.js` (the same "vt/ never imports boot.js"
 * discipline `effects/vegetation-shadow-subsystem.js`'s header describes for
 * the shadow handle) — passed straight through, unchanged.
 *
 * ============================================================================
 * WHAT STAYS EXPOSED, AND WHY (Extraction plan §3's "return an object")
 * ============================================================================
 *
 * `lightScene`/`colorationScene` are read directly by the viewer's own render
 * loop (`renderer.render(pointLights.lightScene, camera)` — the buf:
 * scene.illum/scene.coloration multi-call sequence, whose ordering and
 * autoClearColor handling is genuinely viewer-render-loop concern and stays
 * there). `lightMeshes`/`candleWallClipCache` are read by wind-rebake
 * marking and by diagnostics (`getPointLightsInfo`, deliberately NOT touched
 * by this step — Extraction plan §2 defers "diagnostics assembly" to its own
 * step 5, because it reads everything and is easiest done last). Exposing
 * the live Maps directly (rather than wrapping them) keeps every external
 * call site a pure rename (`lightMeshes` → `pointLights.lightMeshes`), which
 * is the lowest-risk edit available for something with this much fan-out.
 *
 * @module effects/lighting/point-light-pool
 */

import { createLogger } from '../../core/log.js';
import { buildCandleLightSources } from '../candle-flame-geometry.js';
import { buildLightningLightSources } from '../lightning-geometry.js';
import { resolveLightAnimation } from './animations/registry.js';
import { computeRegionAdjustedDarkness } from './region-geometry.js';
import { computeAmbientColors } from './environmental-light.js';
import {
  buildPointLightIlluminationMaterial,
  easeAttenuation,
  computeExposure,
  triangulateLightFan,
  writeLightEdgePoints,
  computeEdgeSoftMarginNormalized,
} from './point-light-illumination.js';
import { buildPointLightColorationMaterial, computeColorationAlpha } from './point-light-coloration.js';
import { readActiveLightSources, readGridSizePixels, computeCandleWallClippedShape } from '../../foundry/index.js';

/** Starting capacity, in FAN VERTICES (not polygon vertices — see the
 * device-lost fix in {@link createPointLightPool}'s own dispose-discipline
 * notes below). Pre-allocated once per light and reused; only grows on the
 * rare frame a light's own polygon exceeds its previous high-water mark. */
const INITIAL_LIGHT_FAN_VERTICES = 192;

const log = createLogger('PointLightPool');

/**
 * Build a brand-new pool entry for a light seen for the first time (or
 * rebuilt after an animation-type/quality/falloff change). A genuine
 * TOP-LEVEL function (not nested in {@link createPointLightPool}) purely so
 * the size ratchet's per-function cap measures it separately — nesting a
 * `function` inside another still counts toward the OUTER function's brace
 * span, so every dependency it used to close over is now an explicit param
 * instead. Same lines, same order, no logic change.
 *
 * @param {object} deps
 * @param {object} deps.light - this frame's light descriptor (Foundry or candle).
 * @param {number} deps.animationQuality
 * @param {string} deps.falloffModel
 * @param {object} deps.windHandle - THIS frame's resolved wind handle (the
 *   caller already read it through `getWindHandle()`; passed as a plain
 *   value here since a single call never spans a rebake).
 * @param {object} deps.THREE @param {object} deps.envLight
 * @param {object} deps.sunShadows @param {object} deps.sceneColor
 * @param {object} deps.uGlobalTimeMs @param {object} deps.lightScene
 * @param {object} deps.colorationScene
 * @returns {object} a new `lightMeshes` entry (not yet stored — the caller
 *   does that, since only the caller knows the `sourceId` key).
 */
function createLightEntry({
  light,
  animationQuality,
  falloffModel,
  windHandle,
  THREE,
  envLight,
  sunShadows,
  sceneColor,
  uGlobalTimeMs,
  lightScene,
  colorationScene,
}) {
  const geometry = new THREE.BufferGeometry();
  // Pre-allocate ONCE, sized generously — see INITIAL_LIGHT_FAN_VERTICES
  // and lightMeshes' own doc for why this exists (the device-lost fix).
  const scratchArray = new Float32Array(INITIAL_LIGHT_FAN_VERTICES * 3);
  const positionAttribute = new THREE.BufferAttribute(scratchArray, 3);
  positionAttribute.setUsage(THREE.DynamicDrawUsage); // hints the backend: this buffer's DATA changes often
  geometry.setAttribute('position', positionAttribute);
  // PER-LIGHT (not shared) ambient uniforms — see update()'s own header for
  // why. Defaults match the pre-fix shared uniforms' own starting values;
  // overwritten every frame regardless.
  const uBackgroundColor = THREE.TSL.uniform(THREE.TSL.vec3(0.93, 0.93, 0.93));
  const uDimColor = THREE.TSL.uniform(THREE.TSL.vec3(0.93, 0.93, 0.93));
  const uBrightColor = THREE.TSL.uniform(THREE.TSL.vec3(1, 1, 1));
  // ANIMATED LIGHTS — resolved ONCE at material-build time (not per-frame):
  // the matched registry entry (or null for no/unbuilt animation) is baked
  // into the node graph via the seed-injection seam — mirrors Foundry's own
  // "swap the shader class at source init" approach exactly.
  const animationEntry = resolveLightAnimation(light.animation.type);
  const {
    material,
    uRatio,
    uAttenuationEased,
    uExposure,
    uEdgeCount,
    uEdgeSoftMargin,
    edgePoints,
    uSpeedRaw: uIllumSpeedRaw,
    uReverseSign: uIllumReverseSign,
    uSeed: uIllumSeed,
    uIntensityRaw: uIllumIntensityRaw,
    uWindCenter: uIllumWindCenter,
    uWindExposure: uIllumWindExposure,
    uWindResponse: uIllumWindResponse,
  } = buildPointLightIlluminationMaterial({
    THREE,
    uBackgroundColor,
    uDimColor,
    uBrightColor,
    animation: animationEntry,
    uGlobalTimeMs,
    animationQuality,
    falloffModel,
    // SHARED WIND (Wind.md Tier 0/1) — OPT-IN, keyed on the light
    // descriptor actually carrying a windExposure (candle lights do, via
    // buildCandleLightSources' cluster-averaged exposure; plain Foundry
    // lights don't, so they build none of this machinery).
    windCenter: { x: light.x, y: light.y },
    windExposure: light.windExposure,
    windResponse: light.windResponse,
    windHandle,
    // SUN SHADOWS, PER-FRAGMENT (2026-07-24) — the light samples the baked
    // field itself, at each pixel's own world position, so its background
    // floor matches the shadowed ambient exactly where the shadow is. A
    // single sample at the light's ORIGIN is binary, so the whole light
    // flipped between soft and hard-edged as the sun swept the shadow edge
    // across that one point. Sharing envLight's OWN rect uniform, never a
    // second copy.
    sunShadowTexture: sunShadows.texture,
    uSunShadowRect: envLight.uSunShadowRect,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  lightScene.add(mesh);
  // COLORATION (increment 3, 2026-07-19) — a SECOND Mesh SHARING this SAME
  // geometry object (no duplicate triangulation/BufferAttribute), added to
  // the SEPARATE colorationScene. Shares illumination's OWN `uRatio` node
  // (the light's base, unjittered ratio — flicker-driven coloration
  // animations jitter it themselves in-shader from this same value) — an
  // established sharing pattern, not a new one (uBackgroundColor/uDimColor/
  // uBrightColor are already shared the identical way).
  const colorationBuilt = buildPointLightColorationMaterial({
    THREE,
    albedoTexture: sceneColor.texture,
    animation: animationEntry,
    uGlobalTimeMs,
    uRatio,
    animationQuality,
    falloffModel,
    // SHARED WIND (Wind.md Tier 0/1) — see the illumination material's own
    // identical call, just above.
    windCenter: { x: light.x, y: light.y },
    windExposure: light.windExposure,
    windResponse: light.windResponse,
    windHandle,
  });
  const colorationMesh = new THREE.Mesh(geometry, colorationBuilt.material);
  colorationMesh.frustumCulled = false;
  colorationScene.add(colorationMesh);
  return {
    mesh,
    material,
    geometry,
    positionAttribute,
    scratchArray,
    uRatio,
    uAttenuationEased,
    uExposure,
    uEdgeCount,
    uEdgeSoftMargin,
    edgePoints,
    uBackgroundColor,
    uDimColor,
    uBrightColor,
    colorationMesh,
    colorationMaterial: colorationBuilt.material,
    uColorationAttenuationEased: colorationBuilt.uAttenuationEased,
    uColorationAlpha: colorationBuilt.uColorationAlpha,
    uLightColor: colorationBuilt.uLightColor,
    uShadows: colorationBuilt.uShadows,
    // ANIMATED LIGHTS — GPU-ONLY (2026-07-20): these four raw uniforms are
    // the ENTIRE per-light animation-config surface left for the CPU to
    // write (Foundry's own animation.speed/reverse/seed/intensity —
    // genuinely unavoidable, this data only exists on the CPU side) —
    // `null` on both when this light isn't animated, so the per-frame
    // writer in update() can skip it entirely. Separate sets for
    // illumination vs coloration (two independent shader graphs) but always
    // written the SAME values.
    animationType: light.animation.type,
    animationQuality,
    falloffModel,
    animationEntry,
    uIllumSpeedRaw,
    uIllumReverseSign,
    uIllumSeed,
    uIllumIntensityRaw,
    uIllumWindCenter,
    uIllumWindExposure,
    uIllumWindResponse,
    uColorSpeedRaw: colorationBuilt.uSpeedRaw,
    uColorReverseSign: colorationBuilt.uReverseSign,
    uColorSeed: colorationBuilt.uSeed,
    uColorIntensityRaw: colorationBuilt.uIntensityRaw,
    uColorWindCenter: colorationBuilt.uWindCenter,
    uColorWindExposure: colorationBuilt.uWindExposure,
    uColorWindResponse: colorationBuilt.uWindResponse,
  };
}

/**
 * @param {object} deps
 * @param {object} deps.THREE - the injected THREE namespace (never imported).
 * @param {() => object} deps.getWindHandle - ⚠️ A GETTER. `windHandle` is
 *   reassigned on every rebake; see the module header.
 * @param {object} deps.envLight - the environmental-light materials bundle
 *   (a `const`, never reassigned); `.uSunShadowRect` is read live per light.
 * @param {object} deps.sunShadows - the sun-shadow subsystem (a `const`,
 *   never reassigned); `.texture` is read live per light.
 * @param {object} deps.sceneColor - the `scene.color` render target (a
 *   `const`, never reassigned); `.texture` is read live per light.
 * @param {() => object} deps.getCandleRenderState - the boot.js-injected
 *   candle-state seam, passed straight through.
 * @param {() => {enabled: boolean, params: object}} [deps.getLightningRenderState] -
 *   the boot.js-injected lightning-state seam (enable + resolved
 *   LIGHTNING_PARAMS). Optional: an un-wired caller casts no bolt light.
 * @param {() => Array<object>} [deps.getLightningActiveStrands] - the
 *   lightning subsystem's own live strand snapshot (effects/lightning-
 *   subsystem.js#activeStrands) — read fresh every frame, same as
 *   `getCandleRenderState`'s anchors.
 * @param {object} deps.uGlobalTimeMs - the ONE shared animation-clock TSL
 *   uniform node. NOT owned here — see the module header's "deliberately did
 *   not move" section. Written (`.value = env.time.tMs`) once per frame by
 *   `update()`, on the caller's behalf.
 * @returns {{
 *   lightScene: object, colorationScene: object,
 *   lightMeshes: Map, candleWallClipCache: Map, lightningWallClipCache: Map,
 *   update: (darkness01: number, activeRegions: object[], env: object, darknessRealism01: number, currentFloor: object) => number,
 *   dispose: () => void,
 * }}
 */

export function createPointLightPool({
  THREE,
  getWindHandle,
  envLight,
  sunShadows,
  sceneColor,
  getCandleRenderState,
  getLightningRenderState,
  getLightningActiveStrands,
  uGlobalTimeMs,
}) {
  /** A tiny dedicated Scene for point-light meshes — kept separate from the
   * world scene so a MAX-blended accumulate pass never has to filter out
   * ordinary drawables. */
  const lightScene = new THREE.Scene();
  /** A SEPARATE dedicated Scene for point-light COLORATION meshes (increment
   * 3) — its own render() call, its own target, so a per-frame clear behaves
   * correctly for a channel that should read zero where no light reaches. */
  const colorationScene = new THREE.Scene();

  /** sourceId -> { mesh, material, geometry, positionAttribute, scratchArray,
   * uRatio, uAttenuationEased, ... }. Reconciled every frame in `update()`.
   *
   * UNLIKE occlusionDiscs (one shared geometry, scaled per instance), each
   * light gets its OWN geometry — shapes differ per light and change frame
   * to frame (walls/radius/position).
   *
   * ⚠️ THE DEVICE-LOST BUG THIS FIXES (2026-07-18, live-crashed within ~30s
   * of point lights first rendering — flight recorder: "WebGPU Device Lost: A
   * valid external Instance reference no longer exists"). The first cut of
   * this pool created a BRAND NEW `Float32Array` + `THREE.BufferAttribute`
   * EVERY FRAME for EVERY active light. Verified against the vendored
   * three.webgpu.js source: `BufferAttribute` has NO `dispose()` method at
   * all, and `BufferGeometry#setAttribute` is a bare `this.attributes[name] =
   * attribute` — nothing frees the OLD attribute's backend GPU buffer when
   * it's replaced. Every active light, every frame, leaked one native GPU
   * buffer, unbounded, until WebGPU's own device-loss watchdog killed the
   * context.
   *
   * THE FIX: allocate the scratch array + BufferAttribute ONCE per light (on
   * first appearance) and REUSE them every frame — mutate the SAME array's
   * contents, flag `.needsUpdate = true`, and use `geometry.setDrawRange` to
   * tell the renderer how many of the (possibly stale, possibly oversized)
   * vertices are valid THIS frame. `triangulateLightFan`'s `outArray`
   * parameter exists specifically to make this reuse possible; only grows (a
   * new, bigger array/attribute) on the rare frame a light's polygon exceeds
   * its previous high-water mark. */
  const lightMeshes = new Map();

  /** sourceId -> {floorId, radius, points, source, reason} — per-candle
   * WALL-CLIPPED shape cache (2026-07-20, the "candle light bleeds through
   * walls" fix — `foundry/scene-wall-clip.js`'s own header has the full
   * mechanism/why). Candles are static per anchor and Foundry's own
   * ClockwiseSweepPolygon computation is unmeasured-but-presumed-nontrivial,
   * so this is recomputed ONLY when a candle's floor or radius actually
   * changes, never every frame. */
  const candleWallClipCache = new Map();

  /** sourceId -> {floorId, radius, points, source, reason} — the SAME
   * per-source wall-clipped shape cache as `candleWallClipCache`, keyed by
   * lightning's own STABLE `wallClipRadiusPx` (never the fluctuating visual
   * `radius` — see `lightning-geometry.js#buildLightningLightSources`'s own
   * header for why the two are deliberately different fields: normalizing a
   * cached shape by one frame's radius and rescaling the mesh by that SAME
   * frame's radius is a lossless round-trip regardless of what the cached
   * shape's own radius was, so a stable cache key costs nothing visually and
   * avoids recomputing the wall sweep every single frame a bolt flickers). */
  const lightningWallClipCache = new Map();

  /**
   * Reconcile the point-light mesh pool against this frame's live Foundry
   * light sources: add new, refresh every survivor's geometry/uniforms, hide
   * stale (see `lightMeshes`' own doc for why "hide" not "dispose").
   *
   * PER-LIGHT REGION-AWARE AMBIENT (2026-07-19 — THE REAL "hard edge on a
   * soft, attenuation:1 light" bug, found live via the pixel probe: a point
   * just outside a light's mesh but INSIDE a darkening region read the
   * region's correctly-darkened floor; a point just inside the SAME light's
   * mesh read the GLOBAL, un-adjusted background — a step discontinuity at
   * the light's own boundary, independent of how soft the light's OWN
   * attenuation-driven corona is, because the corona blends toward the WRONG
   * floor). Every light's illumination formula (`point-light-
   * illumination.js`) is `mix(uBackgroundColor, finalColorExposed, falloff)`
   * — `uBackgroundColor` used to be one SHARED, scene-wide uniform, identical
   * for every light, with zero awareness of a region it might be sitting
   * inside. Under MAX-blend (region draws first, opaque; light draws after,
   * MAX) a light's own floor (always >= the raw scene background) can never
   * lose to a DARKENED region's lower value — so the region's darkening was
   * erased everywhere the light's mesh reached, with a hard seam exactly at
   * the mesh boundary.
   *
   * Real Foundry avoids this because every light samples the SAME per-pixel
   * `darknessLevelTexture` regions paint into. MSA has no such texture yet —
   * this is the CPU-side approximation: EACH light now gets its OWN
   * `uBackgroundColor`/`uDimColor`/`uBrightColor` uniforms (not shared),
   * recomputed every frame from `computeRegionAdjustedDarkness(light.x,
   * light.y, darkness01, activeRegions)` — the SAME pure function/formula
   * `updateRegionDarknessMeshes` uses, just evaluated at the light's own
   * ORIGIN rather than per-fragment. Exact for a light entirely inside (or
   * entirely outside) one region; an approximation for a light whose radius
   * straddles a region boundary.
   *
   * @param {number} darkness01
   * @param {object[]} activeRegions - THIS frame's elevation-filtered active
   *   darkness regions, passed in so this function and
   *   `updateRegionDarknessMeshes` (still in the viewer) always agree on
   *   which regions are active.
   * @param {object} env - this frame's env snapshot (for `ambient.*`).
   * @param {number} darknessRealism01 - the darkness-realism lever, same
   *   value `computeAmbientColors` already takes elsewhere this frame.
   * @param {object} currentFloor - the SAME floor value region-darkness
   *   elevation-filtering already computed this frame, reused (never
   *   re-derived) so a candle's wall-clip and the region-darkness pass can
   *   never disagree about which floor is active.
   * @returns {number} this frame's grid size in px — the caller tracks it
   *   (`lastGridSizePixels`) for diagnostics; this pool has no reason to own
   *   that viewer-level readout itself.
   */
  function update(darkness01, activeRegions, env, darknessRealism01, currentFloor) {
    const windHandle = getWindHandle();
    // THE ONE SHARED ANIMATION-CLOCK WRITE — once per FRAME, not once per
    // LIGHT. env.time.tMs is the ONE clock (time/one-clock wall) — no new
    // performance.now() anywhere in this pass.
    uGlobalTimeMs.value = env.time.tMs;
    // darkness01 gates each light's OWN activation window (LightData.darkness
    // {min,max}, default {0,1} — "always on"; see foundry/scene-lights.js's
    // header for why this lives in the reader, not here).
    const { lights: foundryLights } = readActiveLightSources(darkness01);
    // CANDLE LIGHTS (effects/candle-flame-render.js) — authored by us from the
    // anchor authority, shaped EXACTLY like a Foundry light source so they flow
    // through this SAME pool: region-aware ambient, the soft edge, coloration
    // and MAX-blending, all for free. This is the "point light we control": its
    // radius/colour come from the candle effect's params, not a Foundry doc.
    const candleLightState = getCandleRenderState();
    const candleLights = candleLightState.enabled
      ? buildCandleLightSources(candleLightState.anchors, {
          lightRadiusPx: candleLightState.params?.lightRadiusPx,
          colorHex: candleLightState.params?.color,
          animationQuality: candleLightState.params?.animationQuality,
          windResponse: candleLightState.params?.windResponse,
          // THE PERFORMANCE RUNG — sets light flicker richness AND, far more
          // expensively, how hard candles MERGE into shared lights. Measured
          // 2026-07-29: the two point-light zones were 13.1ms of a 20.4ms frame
          // across 91 draw calls, against 0.022ms for every candle FLAME in the
          // scene. Light count is the dial; this is what turns it.
          perfTier: candleLightState.perfTier,
        })
      : [];
    // WALL-CLIPPING candle lights (2026-07-20) — candleLights' own shapePoints
    // (candleCirclePolygon) is a naive circle with ZERO wall awareness; this
    // replaces it with Foundry's own ClockwiseSweepPolygon result wherever one
    // is available, falling back to the naive circle otherwise (never a crash,
    // never a light that vanishes). `currentFloor` is the SAME value region-
    // darkness elevation-filtering already computed this frame — reused, never
    // re-derived, so a candle's wall-clip and the region-darkness pass can
    // never disagree about which floor is active.
    const currentFloorId = currentFloor?.id ?? null;
    for (const candle of candleLights) {
      let cached = candleWallClipCache.get(candle.sourceId);
      if (!cached || cached.floorId !== currentFloorId || cached.radius !== candle.radius) {
        const result = computeCandleWallClippedShape({
          x: candle.x,
          y: candle.y,
          radius: candle.radius,
          levelId: currentFloorId,
        });
        cached = { floorId: currentFloorId, radius: candle.radius, ...result };
        candleWallClipCache.set(candle.sourceId, cached);
      }
      if (cached.points) candle.shapePoints = cached.points;
      // cached.points === null: candle KEEPS buildCandleLightSources' own
      // naive-circle shapePoints untouched — the pre-fix behaviour, not a gap
      // this change introduces.
    }

    // LIGHTNING ORIGIN-FLASH LIGHTS (effects/lightning-geometry.js) — authored
    // by us from the lightning subsystem's own live strand snapshot, shaped
    // EXACTLY like a candle light so it flows through this SAME pool. Wall-
    // clipped the same way, but keyed on lightning's own STABLE
    // `wallClipRadiusPx` (never the visual `radius`, which jitters with
    // strike intensity every frame — see buildLightningLightSources' own
    // header for why the two are deliberately different fields and why plain
    // exact-equality caching, unlike candle's, is safe here).
    const lightningState = getLightningRenderState ? getLightningRenderState() : { enabled: false, params: {} };
    const lightningStrands = getLightningActiveStrands ? getLightningActiveStrands() : [];
    // TIER 3 ('originFlash') GATES THE ORIGIN-FLASH LIGHT ENTIRELY — below it,
    // no light sources are built at all (not just visually suppressed), the
    // same "a rung nothing reads rots" reasoning lightning-subsystem.js's own
    // tier gates apply to branching/flash. Matches those gates' own posture:
    // a non-finite tier compares false against `>= 3` and fails OFF, never a
    // silent fallback to on — `enabled` is false in every real caller that
    // omits perfTier anyway (vt-pan-viewer.js's own default seam), so this
    // never needs to guess.
    const lightningLights =
      lightningState.enabled && lightningStrands.length && Number(lightningState.perfTier) >= 3
        ? buildLightningLightSources(lightningStrands, env.time.tMs, lightningState.params ?? {})
        : [];
    // `originFlashWallClipEnabled` (default true) is a per-scene author
    // choice, not per-strike — read once, same as V2's own `if (params.
    // originFlashWallClipEnabled === false)` early return.
    const lightningWallClipEnabled = lightningState.params?.originFlashWallClipEnabled !== false;
    for (const strike of lightningLights) {
      if (!lightningWallClipEnabled) continue; // KEEPS the naive-circle shapePoints untouched, unclipped by design
      let cached = lightningWallClipCache.get(strike.sourceId);
      if (!cached || cached.floorId !== currentFloorId || cached.radius !== strike.wallClipRadiusPx) {
        const result = computeCandleWallClippedShape({
          x: strike.x,
          y: strike.y,
          radius: strike.wallClipRadiusPx,
          levelId: currentFloorId,
        });
        cached = { floorId: currentFloorId, radius: strike.wallClipRadiusPx, ...result };
        lightningWallClipCache.set(strike.sourceId, cached);
      }
      if (cached.points) strike.shapePoints = cached.points;
      // cached.points === null: the strike KEEPS its own naive-circle
      // shapePoints (buildLightningLightSources' own fallback) untouched.
    }
    // Prune wall-clip cache entries for sources that no longer fire this
    // frame (a bolt anchor pair edited/removed) — unlike lightMeshes' own
    // "hide, never delete" Map (which needs stable identity for GPU mesh
    // reuse), this cache holds no GPU resources, just cached JS arrays, so
    // dropping a stale entry is free and keeps it from growing unbounded
    // across a long session of edited bolt placements.
    if (lightningWallClipCache.size) {
      const liveLightningIds = new Set(lightningLights.map((s) => s.sourceId));
      for (const id of lightningWallClipCache.keys()) {
        if (!liveLightningIds.has(id)) lightningWallClipCache.delete(id);
      }
    }

    const lights = [...foundryLights, ...candleLights, ...lightningLights];
    // Read ONCE per frame — a scene's grid size does not change light-to-light,
    // only scene-to-scene.
    const gridSizePixels = readGridSizePixels().gridSizePixels;
    const seen = new Set();
    for (const light of lights) {
      seen.add(light.sourceId);
      let entry = lightMeshes.get(light.sourceId);
      // ANIMATED LIGHTS — REBUILD ON LIVE CHANGE (2026-07-20, docs/planning/
      // Light-Parity.md §5's last item). A light's materials are built ONCE
      // per animation TYPE, baked into the node graph at construction time
      // (mirrors Foundry's own _configureShaders shader-class swap) — if a
      // GM edits the light's Animation tab mid-session, this pool entry's
      // animationType goes stale. Rare event, so the simplest correct fix is
      // to tear this entry down and let the "entry doesn't exist" path below
      // recreate it fresh, rather than a second, parallel in-place-patch code
      // path. Dispose what THREE actually HAS a real dispose() for (geometry,
      // both materials) — unlike the BufferAttribute leak this pool's own
      // header documents.
      const animationQuality = light.animation?.quality ?? 0;
      // FALLOFF MODEL — a graph-build-time choice baked into the node graph
      // (point-light-illumination.js), so a change needs the same rebuild as
      // type/quality. In practice constant per source (Foundry → 'foundry',
      // candles → 'inverseSquare'), but keyed here for correctness.
      const falloffModel = light.falloffModel ?? 'foundry';
      if (
        entry &&
        (entry.animationType !== light.animation.type ||
          entry.animationQuality !== animationQuality ||
          entry.falloffModel !== falloffModel)
      ) {
        lightScene.remove(entry.mesh);
        colorationScene.remove(entry.colorationMesh);
        entry.material.dispose();
        entry.colorationMaterial.dispose();
        entry.geometry.dispose();
        lightMeshes.delete(light.sourceId);
        entry = null;
      }
      if (!entry) {
        entry = createLightEntry({
          light,
          animationQuality,
          falloffModel,
          windHandle,
          THREE,
          envLight,
          sunShadows,
          sceneColor,
          uGlobalTimeMs,
          lightScene,
          colorationScene,
        });
        lightMeshes.set(light.sourceId, entry);
      }
      // REUSE, not reallocate (see lightMeshes' own doc — this is the
      // device-lost fix, not an optimisation): triangulateLightFan writes
      // into entry.scratchArray when it already has room. It returns a
      // DIFFERENT array only on the rare frame this light's polygon outgrows
      // its previous high-water mark, in which case (and ONLY then) a new
      // BufferAttribute replaces the old one.
      const { array, vertexCount } = triangulateLightFan(
        light.shapePoints,
        light.x,
        light.y,
        light.radius,
        entry.scratchArray
      );
      if (array !== entry.scratchArray) {
        entry.scratchArray = array;
        entry.positionAttribute = new THREE.BufferAttribute(array, 3);
        entry.positionAttribute.setUsage(THREE.DynamicDrawUsage);
        entry.geometry.setAttribute('position', entry.positionAttribute);
      } else {
        entry.positionAttribute.needsUpdate = true; // same buffer, new contents — re-upload, don't reallocate
      }
      // Only the first `vertexCount` vertices are valid THIS frame.
      entry.geometry.setDrawRange(0, vertexCount);
      // Mirrors Foundry's OWN mesh placement exactly: geometry is normalized
      // to local unit-radius space by triangulateLightFan, then
      // positioned/scaled back out to world space here.
      entry.mesh.position.set(light.x, light.y, 0);
      entry.mesh.scale.set(light.radius, light.radius, 1);
      entry.mesh.visible = true;
      // PER-LIGHT REGION-AWARE AMBIENT — see this function's own header for
      // the full "hard edge on a soft light" bug this fixes.
      const localDarkness01 = computeRegionAdjustedDarkness(light.x, light.y, darkness01, activeRegions);
      const localAmbient = computeAmbientColors({ ...env, darkness01: localDarkness01 }, darknessRealism01);
      // SUN SHADOWS are NOT applied here — the light's own material samples
      // the baked field per-FRAGMENT. Two earlier attempts DID scale these
      // uniforms by a per-light scalar and both failed the same way: a
      // light's origin is one point, so the whole light flipped between soft
      // and hard-edged as the shadow edge swept across it. Deliberately left
      // un-shadowed here; the shader owns it.
      entry.uBackgroundColor.value.set(...localAmbient.background);
      entry.uDimColor.value.set(...localAmbient.dim);
      entry.uBrightColor.value.set(...localAmbient.bright);
      // ANIMATED LIGHTS — GPU-ONLY (2026-07-20). `uRatio` ALWAYS gets the
      // light's real, unjittered ratio now — any flicker/pulse jitter happens
      // entirely in-shader. The only per-frame CPU work left for an animated
      // light is writing its four RAW config scalars — cheap plain float
      // writes, no function calls, no noise generation, no per-light JS math.
      if (entry.animationEntry) {
        const reverseSign = light.animation.reverse ? -1 : 1;
        if (entry.uIllumSpeedRaw) entry.uIllumSpeedRaw.value = light.animation.speedRaw;
        if (entry.uIllumReverseSign) entry.uIllumReverseSign.value = reverseSign;
        if (entry.uIllumSeed) entry.uIllumSeed.value = light.animation.seed;
        if (entry.uIllumIntensityRaw) entry.uIllumIntensityRaw.value = light.animation.intensityRaw;
        if (entry.uColorSpeedRaw) entry.uColorSpeedRaw.value = light.animation.speedRaw;
        if (entry.uColorReverseSign) entry.uColorReverseSign.value = reverseSign;
        if (entry.uColorSeed) entry.uColorSeed.value = light.animation.seed;
        if (entry.uColorIntensityRaw) entry.uColorIntensityRaw.value = light.animation.intensityRaw;
      }
      entry.uRatio.value = light.ratio;
      // NOT floored (2026-07-19, reversed same day — see
      // keyhole-attenuation-floor-reverted memory). A direct side-by-side
      // against real Foundry proved a hard edge at low attenuation IS the
      // parity target, not a defect. easeAttenuation is used unmodified,
      // exactly like Foundry's own `attenuation` uniform.
      const attenuationEased = easeAttenuation(light.attenuation01);
      entry.uAttenuationEased.value = attenuationEased;
      entry.uExposure.value = computeExposure(light.luminosity01);
      // SHARED WIND (Wind.md Tier 0) — written every frame like every other
      // per-light uniform above; `null` for any light the wind machinery
      // wasn't built for (an ordinary Foundry light), so this is a no-op
      // there. A candle's position never moves, but its windExposure CAN (an
      // outdoors mask streaming in later), so this reads the live value
      // rather than trusting what build time saw.
      if (entry.uIllumWindCenter) entry.uIllumWindCenter.value.set(light.x, light.y);
      if (entry.uIllumWindExposure) entry.uIllumWindExposure.value = light.windExposure ?? 1;
      if (entry.uIllumWindResponse) entry.uIllumWindResponse.value = light.windResponse ?? 1;
      if (entry.uColorWindCenter) entry.uColorWindCenter.value.set(light.x, light.y);
      if (entry.uColorWindExposure) entry.uColorWindExposure.value = light.windExposure ?? 1;
      if (entry.uColorWindResponse) entry.uColorWindResponse.value = light.windResponse ?? 1;
      // SOFT EDGE: the SAME reuse discipline as scratchArray above, via
      // TRUNCATION rather than growth — writeLightEdgePoints mutates
      // entry.edgePoints' existing Vector2 instances IN PLACE, never
      // replacing them (a uniformArray's size is fixed forever after its
      // first setup() call).
      entry.uEdgeCount.value = writeLightEdgePoints(
        light.shapePoints,
        light.x,
        light.y,
        light.radius,
        entry.edgePoints
      );
      entry.uEdgeSoftMargin.value = computeEdgeSoftMarginNormalized(gridSizePixels, light.radius);
      // COLORATION — the SAME transform as the illumination mesh (shares
      // geometry, but is a SEPARATE Object3D with its own transform).
      // hasColor GATE, NOW SAFE + CORRECT (2026-07-19) — the earlier full-
      // black scares from this gate had a ROOT CAUSE, now fixed upstream:
      // foundry/scene-lights.js was reading every light's colour as
      // `undefined`, so EVERY light looked colourless and the gate zeroed
      // ALL lights' coloration. With the colour read corrected, coloured
      // torches now report hasColor:true and keep their coloration; ONLY
      // genuinely colourless lights are gated — exactly Foundry's own
      // `isRequired`/`hasColor` rule, and no longer load-bearing for the
      // scene's overall brightness. Applied via the uniform
      // (`uColorationAlpha=0`), NOT a mesh-visibility toggle.
      entry.colorationMesh.position.set(light.x, light.y, 0);
      entry.colorationMesh.scale.set(light.radius, light.radius, 1);
      entry.colorationMesh.visible = true;
      // SAME unfloored value as the illumination mesh above — coloration's
      // falloff uses the identical formula, so both channels harden/soften
      // together at the light's own authored attenuation, matching Foundry
      // exactly.
      entry.uColorationAttenuationEased.value = attenuationEased;
      // A colourless light contributes ZERO coloration (Foundry parity); a
      // coloured light gets its normal technique-1 alpha and its REAL (now
      // correctly-read) hue below. FORCE-DEFAULT-COLOR (2026-07-20): 13 of 22
      // coloration animations set Foundry's `forceDefaultColor` true, meaning
      // their coloration mesh draws even on a colourless light because the
      // ANIMATION supplies its own colour — this is Foundry's `isRequired`
      // gate, verified against source, not a guess.
      const forceDefaultColor = entry.animationEntry?.forceDefaultColor === true;
      entry.uColorationAlpha.value = light.hasColor || forceDefaultColor ? computeColorationAlpha(light.alpha01, 1) : 0;
      entry.uLightColor.value.set(light.color[0], light.color[1], light.color[2]);
      // SHADOW (2026-07-21) — Foundry's own per-light "protect dark map areas
      // from this light's hue" field, previously unread. 0 (default) is a
      // no-op.
      entry.uShadows.value = light.shadows01;
      // DIAGNOSTIC ONLY — not read by any shader. Lets getPointLightsInfo
      // (still in vt-pan-viewer.js, deferred to extraction step 5) report the
      // true coloured/colourless split.
      entry.lastHasColor = light.hasColor;
    }
    for (const [id, entry] of lightMeshes) {
      if (!seen.has(id)) {
        entry.mesh.visible = false;
        entry.colorationMesh.visible = false;
      }
    }
    return gridSizePixels;
  }

  /** Tear down every point-light mesh/material/geometry. Each light owns its
   * OWN geometry (unlike occlusion discs' shared circle), so geometry
   * disposal happens here too. The three shared ambient-colour uniforms need
   * no disposal — plain JS objects, not GPU resources. */
  function dispose() {
    for (const [id, entry] of lightMeshes) {
      try {
        entry.material.dispose();
      } catch (err) {
        log.error(`point-light material dispose failed for '${id}' — VRAM may be leaked:`, err);
      }
      try {
        entry.colorationMaterial.dispose();
      } catch (err) {
        log.error(`point-light coloration material dispose failed for '${id}' — VRAM may be leaked:`, err);
      }
      try {
        entry.geometry.dispose();
      } catch (err) {
        log.error(`point-light geometry dispose failed for '${id}' — VRAM may be leaked:`, err);
      }
    }
    lightMeshes.clear();
  }

  return Object.freeze({
    lightScene,
    colorationScene,
    lightMeshes,
    candleWallClipCache,
    lightningWallClipCache,
    update,
    dispose,
  });
}
