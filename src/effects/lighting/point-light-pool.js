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
 * `envLight`, `sceneColor` are taken as plain VALUES: neither is ever
 * reassigned as a variable in the viewer (only their internal fields/textures
 * are updated in place — `rebindLighting()` re-pushes `sceneColor.texture`
 * after a resize, for instance), so the object reference stays valid for this
 * pool's whole lifetime, and `.texture`/`.sunShadowSlotNodes`/`.attrTexNode`
 * are read live at each use, same as the original code.
 * `blendSunVisibilityAcrossFloors` is a plain function reference (an import
 * this module cannot hold itself — see the module header above), injected the
 * same way.
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
  LIGHT_ELEVATION_UNCONFIGURED_SENTINEL,
  elevationRank,
} from './point-light-illumination.js';
import { buildPointLightColorationMaterial, computeColorationAlpha } from './point-light-coloration.js';
import { canBatchLight, computeBucketKey, isColorationEligible } from './point-light-batch.js';
import { createBatchedLightMesh } from './point-light-batch-mesh.js';
import {
  readActiveLightSources,
  readGridSizePixels,
  computeCandleWallClippedShape,
  readSceneWallSegments,
} from '../../foundry/index.js';
import { resolveElevationFloorIndex } from '../../scene/index.js';
import {
  APERTURE_GOBO_DEFAULTS,
  SOFT_FAR_PX_BASE,
  REACH_SOFT_FAR_PX_BASE,
  findAperturesForLight,
  resolveLampHeight,
  deriveApertureGoboPaneCount,
} from './aperture-gobo.js';
import {
  createApertureGoboSharedUniforms,
  buildApertureGoboTerm,
  MAX_APERTURES_PER_LIGHT,
} from './aperture-gobo-render.js';

/** Starting capacity, in FAN VERTICES (not polygon vertices — see the
 * device-lost fix in {@link createPointLightPool}'s own dispose-discipline
 * notes below). Pre-allocated once per light and reused; only grows on the
 * rare frame a light's own polygon exceeds its previous high-water mark. */
const INITIAL_LIGHT_FAN_VERTICES = 192;

const log = createLogger('PointLightPool');

/**
 * Resolve ONE light's own `elevationRank` — its FLOOR INDEX plus its height
 * inside that floor's band — for `point-light-illumination.js`'s height gate.
 * Pure and Node-testable so the FLOOR-RESOLUTION half of this feature (not
 * just the gate arithmetic, already tested in point-light-illumination
 * .test.mjs) is verified without a live scene.
 *
 * ⚠️ **RETURNS A RANK, NOT A BARE HEIGHT (2026-08-03, round 3).** This used
 * to return `raw - bottom` — a height relative to the light's OWN floor —
 * which threw away the floor identity that is the entire point of the
 * comparison. A -20ft basement light and a +5ft upper-storey floorboard both
 * came back as "0 above my own floor" and the gate happily lit the storey.
 * See `point-light-illumination.js#elevationRank` for the full postmortem and
 * the arithmetic; this function is simply the LIGHT side of that same rank.
 *
 * ⚠️ THE SENTINEL CHECK IS ON THE RAW `light.elevation`, NEVER ON THE
 * DERIVED "above floor bottom" VALUE. See `LIGHT_ELEVATION_UNCONFIGURED_
 * SENTINEL`'s own doc for the bug this avoids: a light legitimately placed
 * AT elevation 20 on a floor spanning [20,30) computes an "above floor"
 * height of 0 — the SAME number an untouched light would also produce if
 * the check ran on the derived value — and must NOT be treated as
 * unconfigured just because its own floor's ground happens to be non-zero.
 *
 * @param {{elevation?: number}} light - `foundry/scene-lights.js#
 *   deriveLightSnapshot`'s own `elevation` field (raw, Foundry-document
 *   units; 0 = the schema default, "never touched").
 * @param {Array<{index:number, elevationBottom:number|null, elevationTop:
 *   number|null}>} floors - `getActiveSceneFloors(...).floors`, or an empty
 *   array when no scene/floors are resolvable.
 * @returns {number} this light's `elevationRank`, or
 *   `LIGHT_ELEVATION_UNCONFIGURED_SENTINEL` when the light was never
 *   explicitly placed, or its own floor could not be resolved.
 */
export function resolveLightElevationRank(light, floors) {
  const raw = Number.isFinite(light?.elevation) ? light.elevation : 0;
  if (Math.abs(raw) < 0.0001) return LIGHT_ELEVATION_UNCONFIGURED_SENTINEL;
  if (!Array.isArray(floors) || floors.length === 0) return LIGHT_ELEVATION_UNCONFIGURED_SENTINEL;
  // A light carries no `levelId` (unlike Level art/tiles) — elevation-banding
  // is the ONLY way to find its own floor, the identical fallback a loose
  // tile with no owner already uses (`vt/scene-attr.js#
  // resolveItemFloorAttrUniforms`).
  const resolved = resolveElevationFloorIndex(floors, raw);
  if (!resolved) return LIGHT_ELEVATION_UNCONFIGURED_SENTINEL;
  const bottom = resolved.floor.elevationBottom ?? 0;
  return elevationRank(resolved.index, raw - bottom);
}

/**
 * Resolve an ANCHOR's (candle, lightning) own `elevationRank` from its
 * `floorBinding` (`scene/anchor-authority.js#normalizeFloorBinding`'s own
 * shape) — the sibling of {@link resolveLightElevationRank} for anything
 * anchor-authored instead of a Foundry document, needed for the SAME reason:
 * `candle-flame-render.js`/`lightning-render.js` share a light's own height/
 * elevation gate (`point-light-illumination.js#buildHeightGateNode`), and
 * that gate needs to know where the candle/bolt itself sits, not just where
 * the receiving pixel sits.
 *
 * ⚠️ 'all-levels' (the author's own "show this everywhere" choice, or the
 * kind's default) reads as the SENTINEL, never floor 0 or a guess — an
 * anchor with no locked band has explicitly opted OUT of floor membership
 * entirely (`scene/anchor-authority.js#floorMatches`: `mode !== 'locked'`
 * always passes), so gating it by height would silently narrow a feature the
 * author deliberately widened. Only a 'locked' binding, which already IS an
 * elevation band matching a real Level's own, has anything to resolve.
 *
 * Height WITHIN the resolved floor defaults to 0 (its own floor's ground) but
 * `unitsAboveFloorBottom` lets a caller pass a real one — candles are the
 * first anchor kind to author a z-height (`scene/anchor-catalog.js`'s
 * `candleFlame.params.elevation`, "height off floor"; `lightning` still has
 * no such param, so its own call site keeps passing 0 unchanged). This is
 * the flame sprite's OWN (OLD-gate) height consumer — the light this same
 * candle CASTS is a separate, depth-authority-based consumer
 * (`candle-flame-geometry.js#resolveAnchorElevationWorldUnits`); both are now
 * fed from the same authored `params.elevation` value so they agree.
 *
 * FLOOR-CROSSING (2026-08-05 fix): the floor INDEX is resolved from
 * `floorBinding.bottom + unitsAboveFloorBottom` — the same absolute world
 * elevation `resolveAnchorElevationWorldUnits` computes for the light this
 * anchor casts — not from the raw, un-adjusted `floorBinding.bottom`. Before
 * this fix, a tall enough authored height could only ever nudge the
 * FRACTIONAL part of the rank within the anchor's ORIGINAL floor (capped at
 * `RECEIVER_ELEVATION_RANGE_UNITS_MIRROR / ELEVATION_RANK_FRACTION_DIVISOR`,
 * well under one floor's worth of rank) and could never cross into the next
 * floor's own band the way the light's floor-agnostic `rankOfElevation`
 * already could — the flame and its own light would agree on "higher" but
 * disagree on "which floor". `unitsAboveFloorBottom = 0` (lightning, or an
 * un-elevated candle) resolves to the exact same floor/height as before —
 * this is additive, not a behaviour change for the untouched case.
 *
 * @param {{mode?:string, bottom?:number|null, top?:number|null}|null|undefined} floorBinding
 * @param {Array<{index:number, elevationBottom:number|null, elevationTop:number|null}>} floors
 * @param {number} [unitsAboveFloorBottom] - this anchor's own authored height above its floor's ground (default 0).
 * @returns {number}
 */
export function resolveAnchorElevationRank(floorBinding, floors, unitsAboveFloorBottom = 0) {
  if (!floorBinding || floorBinding.mode !== 'locked' || !Number.isFinite(floorBinding.bottom)) {
    return LIGHT_ELEVATION_UNCONFIGURED_SENTINEL;
  }
  if (!Array.isArray(floors) || floors.length === 0) return LIGHT_ELEVATION_UNCONFIGURED_SENTINEL;
  const height = Number.isFinite(unitsAboveFloorBottom) ? unitsAboveFloorBottom : 0;
  const absoluteElevation = floorBinding.bottom + height;
  const resolved = resolveElevationFloorIndex(floors, absoluteElevation);
  if (!resolved) return LIGHT_ELEVATION_UNCONFIGURED_SENTINEL;
  const resolvedFloorBottom = Number.isFinite(resolved.floor?.elevationBottom)
    ? resolved.floor.elevationBottom
    : floorBinding.bottom;
  return elevationRank(resolved.index, absoluteElevation - resolvedFloorBottom);
}

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
 * @param {(TSL: *, args: object) => *} deps.blendSunVisibilityAcrossFloors -
 *   `environmental-light.js`'s own export, injected (not imported — see the
 *   module header's "no explicit parameter list = it did not happen" rule),
 *   forwarded into `buildPointLightIlluminationMaterial` so a light's
 *   background floor blends by floor attribution the SAME way the ambient
 *   fill's own does.
 * @param {object} deps.sceneColor
 * @param {object} deps.uGlobalTimeMs @param {object} deps.lightScene
 * @param {object} deps.colorationScene
 * @param {object} deps.apertureShadowScene - the THIRD dedicated scene
 *   (docs/planning/Aperture-Gobo.md). As of round 10 (2026-08-04) this holds
 *   ONLY the standalone "pattern" debug mesh — the real effect is baked
 *   directly into `material`/`colorationBuilt.material`'s own MAX-blend
 *   draw (see `point-light-illumination.js`'s "THE GOBO IS PART OF THIS
 *   LIGHT'S OWN FALLOFF" header), so this scene is usually empty.
 * @param {number} deps.apertureCount - how many procedural window apertures
 *   THIS light has this frame (`aperture-gobo.js#findAperturesForLight`) —
 *   part of the material rebuild key, same status as `falloffModel`/
 *   `animationType` (see `update()`'s own rebuild check).
 * @param {number} deps.apGoboCols @param {number} deps.apGoboRows - THIS
 *   light's own pane count, derived (round 11, 2026-08-04) from its real
 *   aperture `wallLen` and `(headPx-sillPx)` divided by the "Pane target
 *   width/height" params, rounded and clamped to `[1, MAX_MULLIONS_PER_AXIS]`
 *   — see `update()`'s own "PROCEDURAL PANE COUNT" comment for the full
 *   derivation, computed per-light, not read straight from a param. ALSO
 *   part of the rebuild key (design 4, 2026-08-03) — they are graph-
 *   build-time unroll counts baked into the aperture shadow material, not
 *   shared uniforms (`aperture-gobo-render.js`'s own header).
 * @param {object} deps.apertureGoboShared - `aperture-gobo-render.js#
 *   createApertureGoboSharedUniforms`'s own return, ONE instance for the
 *   whole pool (created once in `createPointLightPool`, never per-light).
 * @returns {object} a new `lightMeshes` entry (not yet stored — the caller
 *   does that, since only the caller knows the `sourceId` key).
 */

/**
 * VALUE equality for a flat numeric polygon array — deliberately NOT `===`.
 * `light.shapePoints` (`foundry/scene-lights.js#readActiveLightSources`)
 * reads straight off Foundry's own live `source.shape.points`; this module
 * has no verified guarantee that reference is stable across frames for an
 * unmoved light (Foundry's own polygon-refresh cadence is not something this
 * codebase has traced), so the re-triangulation dirty-check below compares
 * CONTENT, which is correct regardless of Foundry's own caching behaviour —
 * it can only ever be MORE conservative than a reference check (a same-
 * content-different-array frame still correctly counts as "unchanged"),
 * never less. Polygons here are small (`MAX_LIGHT_EDGES`-bounded, a few dozen
 * numbers at most), so a full pass is negligible next to what it guards.
 * @param {number[]|null} a @param {number[]|null} b
 * @returns {boolean}
 */
function shapePointsUnchanged(a, b) {
  if (a === b) return true; // same reference (incl. both null) — cheap common case, still correct
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function createLightEntry({
  light,
  animationQuality,
  falloffModel,
  windHandle,
  THREE,
  envLight,
  blendSunVisibilityAcrossFloors,
  sceneColor,
  uGlobalTimeMs,
  lightScene,
  colorationScene,
  apertureShadowScene,
  apertureCount,
  apGoboCols,
  apGoboRows,
  apertureGoboShared,
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
    uLightExpectedDepth,
    uApLampHeight,
    apApertures,
  } = buildPointLightIlluminationMaterial({
    THREE,
    uBackgroundColor,
    uDimColor,
    uBrightColor,
    animation: animationEntry,
    uGlobalTimeMs,
    animationQuality,
    falloffModel,
    // APERTURE GOBO (round 10, 2026-08-04) — baked into THIS light's own
    // MAX-blend draw now, not a separate post-process pass. See point-
    // light-illumination.js's own "THE GOBO IS PART OF THIS LIGHT'S OWN
    // FALLOFF" header for the live-found reason.
    apertureCount,
    apGoboCols,
    apGoboRows,
    apertureGoboShared,
    // SHARED WIND (Wind.md Tier 0/1) — OPT-IN, keyed on the light
    // descriptor actually carrying a windExposure (candle lights do, via
    // buildCandleLightSources' cluster-averaged exposure; plain Foundry
    // lights don't, so they build none of this machinery).
    windCenter: { x: light.x, y: light.y },
    windExposure: light.windExposure,
    windResponse: light.windResponse,
    windHandle,
    // SUN SHADOWS, PER-FRAGMENT AND PER-FLOOR (2026-07-24; per-floor added
    // 2026-08-02) — the light samples every resident floor's baked field
    // itself, at each pixel's own world position, so its background floor
    // matches the shadowed ambient exactly where the shadow is AND belongs to
    // the same floor that pixel is actually on. A single sample at the
    // light's ORIGIN is binary, so the whole light flipped between soft and
    // hard-edged as the sun swept the shadow edge across that one point.
    // Sharing envLight's OWN slot nodes + attr sampler + blend function,
    // never a second copy of any of the three.
    sunShadowSlotNodes: envLight.sunShadowSlotNodes,
    attrTexNode: envLight.attrTexNode,
    // THE HEIGHT/ELEVATION GATE — STAGE 2 (2026-08-04). See point-light-
    // illumination.js's own "STAGE 2" header. `attrTexNode` just above stays
    // wired for the SEPARATE sun-shadow floor blend it also feeds; it no
    // longer reaches the height gate at all.
    depthTexNode: envLight.depthTexNode,
    depthFlagsTexNode: envLight.depthFlagsTexNode,
    blendSunVisibilityAcrossFloors,
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
    // THE HEIGHT GATE, on the ANIMATED half of the light too (2026-08-03,
    // round 5). This mesh shares `geometry` with the illumination mesh above
    // and carries the visible coloured glow plus every animated light effect,
    // so leaving it un-gated left the author watching an animated light paint
    // straight through a floor while the illumination underneath it correctly
    // went dark. Same node, same uniform name, one resolved value pushed into
    // both below.
    depthTexNode: envLight.depthTexNode,
    depthFlagsTexNode: envLight.depthFlagsTexNode,
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
    // APERTURE GOBO (round 10) — see the illumination material's own
    // identical call, just above, for why.
    apertureCount,
    apGoboCols,
    apGoboRows,
    apertureGoboShared,
  });
  const colorationMesh = new THREE.Mesh(geometry, colorationBuilt.material);
  colorationMesh.frustumCulled = false;
  colorationScene.add(colorationMesh);

  // APERTURE SHADOW — round 10 (2026-08-04) RETIRED the separate post-
  // process pass entirely (`apertureShadowScene`/`apertureColorationShadow
  // Scene`, the visibility-gate machinery, `buildApertureShadowMaterial`'s
  // own "material"/"visibilityDebugMaterial"/"gateInputsDebugMaterial").
  // `docs/planning/Aperture-Gobo.md` §13's own designs 1-3 history plus
  // `point-light-illumination.js`'s "THE GOBO IS PART OF THIS LIGHT'S OWN
  // FALLOFF" header have the full nine-round story of why. The gobo pattern
  // is now baked directly into `material` and `colorationBuilt.material`
  // above (both builder calls got `apertureCount`/`apGoboCols`/`apGoboRows`/
  // `apertureGoboShared` a few lines up) — no separate mesh, no separate
  // scene, no separate render() call, and nothing left for the render-order/
  // clear-state bug class that bit `apertureColorationShadowScene`'s own
  // first day to repeat. `debugMaterial` (the raw pattern, black/white,
  // useful for visually confirming mullion/frame geometry independent of
  // brightness) is the one piece worth keeping as a standalone diagnostic —
  // built directly from `buildApertureGoboTerm` below, not from the retired
  // `buildApertureShadowMaterial`.
  let apertureShadowDebugMesh = null;
  let apertureShadowDebugMaterial = null;
  if (apertureCount > 0) {
    const { vec4, float, max, select } = THREE.TSL;
    const debugGobo = buildApertureGoboTerm({
      THREE,
      positionWorldXY: THREE.TSL.positionWorld.xy,
      dist: THREE.TSL.length(THREE.TSL.positionLocal.xy),
      apertureCount,
      cols: apGoboCols,
      rows: apGoboRows,
      shared: apertureGoboShared,
    });
    if (debugGobo) {
      apertureShadowDebugMaterial = new THREE.NodeMaterial();
      apertureShadowDebugMaterial.transparent = true;
      apertureShadowDebugMaterial.depthTest = false;
      apertureShadowDebugMaterial.depthWrite = false;
      apertureShadowDebugMaterial.side = THREE.DoubleSide;
      apertureShadowDebugMaterial.blending = THREE.CustomBlending;
      // Ordinary alpha-over, masked by `anyApplicable` — the SAME masking
      // `aperture-gobo-render.js`'s own (now-retired) debugMaterial used, so
      // this overlay stays invisible outside the window's own throw instead
      // of covering the light's ENTIRE radius as an opaque white disc.
      apertureShadowDebugMaterial.blendEquation = THREE.AddEquation;
      apertureShadowDebugMaterial.blendSrc = THREE.SrcAlphaFactor;
      apertureShadowDebugMaterial.blendDst = THREE.OneMinusSrcAlphaFactor;
      apertureShadowDebugMaterial.blendEquationAlpha = THREE.AddEquation;
      apertureShadowDebugMaterial.blendSrcAlpha = THREE.OneFactor;
      apertureShadowDebugMaterial.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
      // Alpha: 0 outside the window's own throw (`anyApplicable` false —
      // fully transparent, the debug mesh's full light-radius footprint
      // stays invisible there); inside it, AT LEAST a faint 0.15 tint (so an
      // open pane's own boundary still reads) rising to a strong 1 at a
      // fully-blocked mullion.
      const debugAlpha = select(debugGobo.anyApplicable, max(float(1).sub(debugGobo.node), float(0.15)), float(0));
      apertureShadowDebugMaterial.fragmentNode = vec4(debugGobo.node, debugGobo.node, debugGobo.node, debugAlpha);
      apertureShadowDebugMesh = new THREE.Mesh(geometry, apertureShadowDebugMaterial);
      apertureShadowDebugMesh.frustumCulled = false;
      apertureShadowScene.add(apertureShadowDebugMesh);
    }
  }

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
    uLightExpectedDepth,
    uBackgroundColor,
    uDimColor,
    uBrightColor,
    colorationMesh,
    colorationMaterial: colorationBuilt.material,
    uColorationAttenuationEased: colorationBuilt.uAttenuationEased,
    uColorationAlpha: colorationBuilt.uColorationAlpha,
    uColorationLightExpectedDepth: colorationBuilt.uLightExpectedDepth,
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
    // APERTURE GOBO — round 10 (2026-08-04): baked into `material`/
    // `colorationBuilt.material` above, no separate mesh for the real
    // effect. `uApLampHeight`/`apApertures` (illumination) and
    // `uApColLampHeight`/`apColApertures` (coloration) are each builder's
    // OWN uniform set — `update()`'s per-frame writer pushes the SAME
    // resolved aperture geometry into both, the same duplication-across-
    // the-mesh-pair pattern `uAttenuationEased`/`uColorationAttenuationEased`
    // already use. `null` on all four when this light has no apertures.
    // `apertureCount`/`apGoboCols`/`apGoboRows` stay stored so `update()`'s
    // rebuild-key check can compare against them without re-deriving from
    // `apApertures?.length`. `apertureShadowDebugMesh`/`Material` are the
    // ONE surviving standalone diagnostic (raw pattern, black/white,
    // independent of brightness) — `null` on both with no apertures too.
    apertureCount,
    apGoboCols,
    apGoboRows,
    uApLampHeight,
    apApertures,
    uApColLampHeight: colorationBuilt.uApColLampHeight,
    apColApertures: colorationBuilt.apColApertures,
    apertureShadowDebugMesh,
    apertureShadowDebugMaterial,
    // RE-TRIANGULATION DIRTY-CHECK (2026-08-09) — see update()'s own call
    // site for why this is a VALUE comparison, not a reference one: `light.
    // shapePoints` reads straight off Foundry's own live `source.shape.
    // points` (`foundry/scene-lights.js#readActiveLightSources`), and this
    // codebase has no verified guarantee that reference is stable across
    // frames for an unmoved light. `NaN`/`null` sentinels guarantee the
    // first frame for any light always takes the full (correct) path — NaN
    // !== NaN, so `lastShapeX === light.x` is false until a real number is
    // stored.
    lastShapeX: NaN,
    lastShapeY: NaN,
    lastShapeRadius: NaN,
    lastShapePoints: null,
  };
}

/**
 * @param {object} deps
 * @param {object} deps.THREE - the injected THREE namespace (never imported).
 * @param {() => object} deps.getWindHandle - ⚠️ A GETTER. `windHandle` is
 *   reassigned on every rebake; see the module header.
 * @param {object} deps.envLight - the environmental-light materials bundle
 *   (a `const`, never reassigned); `.sunShadowSlotNodes`/`.attrTexNode` are
 *   read live per light.
 * @param {(TSL: *, args: object) => *} deps.blendSunVisibilityAcrossFloors -
 *   `environmental-light.js`'s own export — see `createLightEntry`'s own doc
 *   for why this is INJECTED rather than imported.
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
 * @param {() => {enabled: boolean, params: object, debug?: boolean}} deps.getApertureGoboRenderState -
 *   the boot.js-injected APERTURE GOBO data seam (docs/planning/
 *   Aperture-Gobo.md), same shape/injection discipline as
 *   `getSpecularRenderState`/`getWindowRenderState`. REQUIRED, already
 *   defaulted by `vt-pan-viewer.js`'s own top-level destructure (the SAME
 *   single point of defaulting `getCandleRenderState`/`getLightningRenderState`
 *   already use) — this module does not default it a second time, so there
 *   is exactly one place an un-wired caller's safety net lives, not two
 *   that could quietly drift apart. `enabled:false` (the default an un-wired
 *   caller gets) makes `update()` skip the wall-segment read AND assign
 *   every light zero apertures — inert by construction, not by a flag, same
 *   posture as every other un-wired seam in this codebase.
 * @param {object} deps.uGlobalTimeMs - the ONE shared animation-clock TSL
 *   uniform node. NOT owned here — see the module header's "deliberately did
 *   not move" section. Written (`.value = env.time.tMs`) once per frame by
 *   `update()`, on the caller's behalf.
 * @param {(elevation: number) => number} deps.resolveExpectedDepth - THE
 *   DEPTH-AUTHORITY HEIGHT GATE's own CPU resolver (STAGE 2, 2026-08-04),
 *   INJECTED rather than imported for the SAME reason
 *   `blendSunVisibilityAcrossFloors` is: `vt/scene-depth.js` (where
 *   `computeTieSafeExpectedDepth` and the depth authority's own `maxRank` live)
 *   cannot be imported from `effects/` — `vt/` already imports FROM
 *   `effects/`, and this codebase's layering is one-way. `vt-pan-viewer.js`
 *   composes this from `depthAuthority.rankOfElevation(elevation)` +
 *   `computeTieSafeExpectedDepth(rank, depthAuthority.maxRank)`, called fresh
 *   per light per frame by `update()`'s own refresh loop (replacing
 *   `resolveLightElevationRank`/`resolveAnchorElevationRank` for ordinary
 *   Foundry lights — candle/lightning still use the old resolvers, a
 *   deliberate, named deferral, see `point-light-illumination.js`'s own
 *   "STAGE 2" header).
 * @returns {{
 *   lightScene: object, colorationScene: object, apertureShadowScene: object,
 *   lightMeshes: Map, candleWallClipCache: Map, lightningWallClipCache: Map,
 *   update: (darkness01: number, activeRegions: object[], env: object, darknessRealism01: number, currentFloor: object) => number,
 *   getApertureGoboReadout: () => {totalFound: number, dropped: number, litLights: number, enabled: boolean},
 *   getBatchingReadout: () => object,
 *   getWallClipCacheStats: () => {candle: object, lightning: object, regular: object, apertureWalls: object},
 *   invalidateBatchedWindMaterials: () => void,
 *   dispose: () => void,
 * }}
 */

export function createPointLightPool({
  THREE,
  getWindHandle,
  envLight,
  blendSunVisibilityAcrossFloors,
  sceneColor,
  getCandleRenderState,
  getLightningRenderState,
  getLightningActiveStrands,
  /** Fire's per-frame light descriptors, already clustered by `fire-subsystem.js`.
   * Optional so the pool stays constructible in rigs that have no fire. */
  getFireLightSources = null,
  getApertureGoboRenderState,
  // STAGE 2 BATCHING'S OWN REVERT FLAG (S2.5, `docs/planning/Point-Light-
  // Batching-Design.md` §8) — a GETTER for the SAME reason every other
  // live-toggle in this param list is: `vt-pan-viewer.js` owns the `let
  // pointLightBatching` variable and flips it via
  // `MapShine.setPointLightBatching`; this pool just reads whatever it
  // currently says, fresh, every `update()` call. Defaulted OFF so an
  // un-wired caller (tests, a future fixture) gets today's per-light
  // renderer, byte-identical — the safety-slide default, never an opt-in
  // surprise.
  getPointLightBatchingEnabled = () => false,
  // WALL-SEGMENT CACHE INVALIDATION (2026-08-09) — a GETTER for the same
  // reason `getWindHandle` is (see this file's own "GETTERS VS VALUES"
  // trap): boot.js owns the counter and bumps it on createWall/updateWall/
  // deleteWall; this pool just reads whatever it currently says. Defaulted
  // so a caller with no wall-change context (tests, future fixtures) still
  // constructs a working pool — see `apertureSegCache`'s own comment below
  // for why a version that never advances is a correct, if permanently
  // uncached-against-edits, degraded mode rather than a crash.
  getApertureWallVersion = () => 0,
  uGlobalTimeMs,
  resolveExpectedDepth,
  // PERF-INSTRUMENTATION-AUDIT-2026-08-12 — this file had ZERO internal
  // profiler brackets despite owning the busiest lighting draw pass (91 real
  // wall-clipped polygons — the locked perf calibration) and a confirmed 30x
  // mean/max spread on the single opaque `light.pointLightUpdate` bracket
  // vt-pan-viewer.js already wraps `update()` in. `beginById`/`endById`
  // (string form, not vt-pan-viewer.js's own pre-resolved `Z` table) — same
  // reasoning as `specular-surface-subsystem.js`'s own `profiler` param:
  // this pool is constructed independently of that table.
  profiler = null,
}) {
  /** A tiny dedicated Scene for point-light meshes — kept separate from the
   * world scene so a MAX-blended accumulate pass never has to filter out
   * ordinary drawables. */
  const lightScene = new THREE.Scene();
  /** A SEPARATE dedicated Scene for point-light COLORATION meshes (increment
   * 3) — its own render() call, its own target, so a per-frame clear behaves
   * correctly for a channel that should read zero where no light reaches. */
  const colorationScene = new THREE.Scene();
  /** A THIRD dedicated Scene for the APERTURE SHADOW "pattern" debug mesh
   * ONLY (docs/planning/Aperture-Gobo.md). Rounds 1-9 (2026-08-03/04) used
   * this scene for the real effect too — a separate post-process pass,
   * blending/multiplying onto whatever `lightScene`/`colorationScene` had
   * already accumulated. Round 10 retired that architecture entirely: the
   * gobo pattern is now baked directly into `entry.material`/
   * `entry.colorationMaterial`'s own MAX-blend draw (`point-light-
   * illumination.js`'s "THE GOBO IS PART OF THIS LIGHT'S OWN FALLOFF"
   * header has the live-found reason — a separate pass, no matter how it
   * blends, can darken a fragment below what an independent source already
   * legitimately provided there, since it operates on the ALREADY-combined
   * buffer with no way to tell which source contributed what). This scene
   * now holds only the standalone visualization mesh, usually empty. */
  const apertureShadowScene = new THREE.Scene();

  /** APERTURE GOBO's SHARED (one-per-pool, not one-per-light) generator +
   * softness uniforms — created ONCE here, exactly like `uGlobalTimeMs`
   * stays a single shared primitive rather than a per-light copy (see this
   * module's own header). Written every frame in `update()` from the
   * injected `getApertureGoboRenderState()`'s resolved params. */
  const apertureGoboShared = createApertureGoboSharedUniforms(THREE);

  /** THE READOUT — apertures found/dropped/lit-lights, aggregated across
   * every light THIS frame, mutated in place (not reassigned) so the frozen
   * return object below can expose a live view via a plain getter, same
   * "expose a mutable object through a frozen wrapper" shape `lightMeshes`
   * itself already uses. `feedback_silent_cap_corrupts_hard_boundary`: the
   * whole reason this exists is so `findAperturesForLight`'s own per-light
   * cap never drops something with no trace. */
  const apertureGoboReadout = { totalFound: 0, dropped: 0, litLights: 0, enabled: false };

  /** THE BATCHING READOUT (S2.5) — bucket/member counts as of the LAST
   * `update()` call, mutated in place (mirrors `apertureGoboReadout`'s own
   * shape/reason just above). Exists so a light count reported by THIS pool
   * is never silently wrong once `pointLightBatching` is on: today's
   * diagnostics (`vt-pan-viewer.js`'s `getPointLightsInfo`-shaped block)
   * only walk `lightMeshes` and would undercount a batched light entirely —
   * `feedback_pool_health_needs_a_loud_gate`'s own lesson, applied here
   * before that gap ever gets a chance to be silent. Folding this into that
   * diagnostic is its own, separately-scoped task (the module header's own
   * "diagnostics assembly... its own step 5") — this readout is what that
   * future work reads from, not a replacement for it. */
  const batchingReadout = {
    enabled: false,
    illumBucketCount: 0,
    illumLightCount: 0,
    colorBucketCount: 0,
    colorLightCount: 0,
  };

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

  /** bucketKey -> {mesh, reconcile, dispose, layout} (`point-light-batch-
   * mesh.js#createBatchedLightMesh`'s own return) — S2.5's illumination
   * bucket registry. Same "hide, never delete" lifecycle as `lightMeshes`
   * above (see that Map's own doc for why): a bucket key with zero members
   * THIS frame is reconciled with an empty array (`mesh.visible` goes
   * false, `totalVertexCount` goes 0) rather than disposed, because
   * darkness-window membership flips are NORMAL, not rare (design doc §1 —
   * 37/50 census lights carry an activation window), and a bucket's own
   * capacity only grows — rebuilding it from scratch on every empty frame
   * would throw away exactly the reuse this whole design exists for. */
  const illumBuckets = new Map();
  /** The coloration sibling of `illumBuckets` — a SEPARATE registry (own
   * meshes, own materials, own `colorationScene`), same "hide never delete"
   * lifecycle. A bucket key can exist in one registry without the other:
   * `isColorationEligible` (colourless, non-`forceDefaultColor` members)
   * gates coloration membership independently of illumination admission,
   * mirroring today's per-light `uColorationAlpha=0` posture. */
  const colorBuckets = new Map();

  // POOL HEALTH (cache-completeness pass, 2026-08-12) — same hits/misses
  // doctrine as depth-proxy-material-pool.js: a hit is the existing Map
  // entry surviving its own staleness check untouched (no mesh/material/
  // geometry rebuild this frame); a miss is either a brand-new key or an
  // existing one that failed that check and got torn down + recreated.
  // lightMeshes counts PER-LIGHT entries only — a light that batches this
  // frame takes an entirely different path (see the `canBatch` branch's own
  // `continue`) and never reaches lightMeshes' own hit/miss check; its
  // activity shows up in illumBuckets/colorBuckets below instead, which
  // count PER-BUCKET-KEY (not per-light) creation.
  let lightMeshHits = 0;
  let lightMeshMisses = 0;
  let illumBucketHits = 0;
  let illumBucketMisses = 0;
  let colorBucketHits = 0;
  let colorBucketMisses = 0;

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
   * sourceId -> {floorId, x, y, radius, angle, rotation, points, source,
   * reason} — the THIRD sibling of `candleWallClipCache` (2026-08-11, found
   * via the shader-rebuild trace investigation; a real but separate bug from
   * the one that investigation was chasing).
   *
   * `readActiveLightSources` (`foundry/scene-lights.js`) calls
   * `computeLightWallClippedShape` for every real placed light Foundry's own
   * darkness gate disabled but MSA's darkness model says should stay on (the
   * "Aesthetic mode disagrees with Foundry's darkness verdict" fix — see that
   * file's own header). Unlike the candle/lightning call sites, that call had
   * NO cache around it at all: on a scene where Foundry's gate and MSA's
   * model disagree for most/all real lights (routine in Aesthetic mode, the
   * default), every one of them re-ran Foundry's own `ClockwiseSweepPolygon`
   * sweep — vertex identification, edge identification, boundary
   * constraints — from scratch, every single frame. Live-measured at 9.9% of
   * a frame in a Chrome trace, the new #1 cost once the shader-rebuild fix
   * landed.
   *
   * Invalidated on floor OR radius, matching the candle cache's own
   * precedent, PLUS position/angle/rotation, which candles' cache does not
   * check: a candle is a static anchor, but a real Foundry light can be
   * attached to a moving token, and skipping a position check here would
   * silently render a moving light's wall-clip from its OLD position — a
   * correctness bug the candle precedent structurally cannot have.
   */
  const regularLightWallClipCache = new Map();

  /** {floorId, wallVersion, segments}|null — the aperture-flagged wall
   * segment list, recomputed only when the current floor or the wall
   * structure (createWall/updateWall/deleteWall, via `getApertureWallVersion`)
   * actually changed (2026-08-09, PERF: `readSceneWallSegments` walks every
   * wall on the scene and `findAperturesForLight`'s own perf comment already
   * established the per-light scan needs pre-filtering — this closes the
   * OTHER half, the pre-filter itself re-running from scratch every frame
   * regardless of whether any wall moved). Unlike `candleWallClipCache`/
   * `lightningWallClipCache` above, this is ONE set of segments shared by
   * every light this frame, not per-source — a plain nullable object, not a
   * Map. `enabled` is deliberately NOT part of the cache key: the mapping
   * from (floor, wall version) to segments is correct regardless of whether
   * the effect happens to be on right now, so toggling it does not need to
   * invalidate anything the walls themselves did not. */
  let apertureSegCache = null;

  /** LIFETIME hit/miss/eviction counters for the four caches above, one key
   * each — perf-instrumentation-audit-2026-08-12. Same "mutated in place,
   * exposed via a plain getter" shape as `apertureGoboReadout`/
   * `batchingReadout` (this file's own precedent), except these are
   * cumulative across the pool's whole lifetime rather than reset every
   * `update()` — matching `depth-proxy-material-pool.js`'s own convention
   * (the report samples start/end around a measurement window and reports
   * the DELTA, since a lifetime total alone says nothing about what
   * happened during any one window). `apertureWalls` has no `evictions`
   * key: it is a single nullable object, not a Map — there is nothing to
   * evict, only replace, which a miss already counts. */
  const wallClipCacheStats = {
    candle: { hits: 0, misses: 0, evictions: 0 },
    lightning: { hits: 0, misses: 0, evictions: 0 },
    regular: { hits: 0, misses: 0, evictions: 0 },
    apertureWalls: { hits: 0, misses: 0 },
  };

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
    // STAGE 2 BATCHING (S2.5) — read fresh every frame, same as every other
    // live toggle this pool reads (`getApertureGoboRenderState` etc.). The
    // two SHARED resource bundles below are cheap object literals over
    // values already stable for this pool's whole lifetime (`envLight`/
    // `sceneColor`/`blendSunVisibilityAcrossFloors`/`apertureGoboShared`/
    // `uGlobalTimeMs` — see this module's own "GETTERS VS VALUES" header)
    // plus THIS frame's `windHandle` — built once here, read only at
    // bucket-CREATION time (a brand-new bucket key), matching
    // `createLightEntry`'s own identical shared-resource shape one call
    // site down. Field names/shapes match `buildIlluminationShadingCore`'s/
    // `buildColorationShadingCore`'s own documented `shared` params exactly
    // (point-light-illumination.js / point-light-coloration.js).
    const pointLightBatchingEnabled = getPointLightBatchingEnabled() === true;
    const illumSharedResources = {
      attrTexNode: envLight.attrTexNode,
      depthTexNode: envLight.depthTexNode,
      depthFlagsTexNode: envLight.depthFlagsTexNode,
      sunShadowSlotNodes: envLight.sunShadowSlotNodes,
      blendSunVisibilityAcrossFloors,
      apertureGoboShared,
      uGlobalTimeMs,
      windHandle,
    };
    const colorSharedResources = {
      albedoTexture: sceneColor.texture,
      depthTexNode: envLight.depthTexNode,
      depthFlagsTexNode: envLight.depthFlagsTexNode,
      apertureGoboShared,
      uGlobalTimeMs,
      windHandle,
    };
    // Hoisted above its previous single use (candles' own wall-clip cache,
    // below) so `readActiveLightSources` can also key its OWN wall-clip cache
    // by the SAME floor value — one read, both consumers, never two floor
    // values disagreeing about which is "current" this frame.
    const currentFloorId = currentFloor?.id ?? null;
    // darkness01 gates each light's OWN activation window (LightData.darkness
    // {min,max}, default {0,1} — "always on"; see foundry/scene-lights.js's
    // header for why this lives in the reader, not here). `regularLightWallClipCache`
    // (this closure's own declaration has the full mechanism/why) is what
    // stops the darkness-mismatch recompute path inside it from re-running
    // Foundry's ClockwiseSweepPolygon from scratch every frame.
    // WALL-CLIP FOR REAL FOUNDRY LIGHTS (perf-instrumentation-audit-2026-08-12,
    // "Give point-light wall-clipping its own perf zone" — V4-Testament.md,
    // filed 2026-08-11, deferred as "needs profiler access threaded through
    // two files with zero existing references"). This is that pass: the ONE
    // call site `readActiveLightSources` measured at 9.9% of a frame in a
    // live Chrome trace on a scene where Foundry's darkness gate and MSA's
    // model disagree for most lights (routine in Aesthetic mode).
    profiler?.beginById('light.pointLightWallClip');
    const {
      lights: foundryLights,
      seenSourceIds: seenLightSourceIds,
      wallClipHits,
      wallClipMisses,
    } = readActiveLightSources(darkness01, {
      wallClipCache: regularLightWallClipCache,
      floorId: currentFloorId,
    });
    wallClipCacheStats.regular.hits += wallClipHits;
    wallClipCacheStats.regular.misses += wallClipMisses;
    // Prune against `seenSourceIds`, NOT the filtered `foundryLights` — same
    // reasoning as the lightning cache's own prune a few dozen lines down,
    // but deliberately the WIDER set: a light merely outside its own
    // darkness01 window this frame is still real and must keep its cache
    // entry (see readActiveLightSources' own doc for why the two sets
    // differ). Only a light gone from `seenSourceIds` entirely — genuinely
    // deleted — should be evicted.
    if (regularLightWallClipCache.size && seenLightSourceIds) {
      for (const id of regularLightWallClipCache.keys()) {
        if (!seenLightSourceIds.has(id)) {
          regularLightWallClipCache.delete(id);
          wallClipCacheStats.regular.evictions += 1;
        }
      }
    }
    profiler?.endById('light.pointLightWallClip');
    // THE HEIGHT/ELEVATION GATE's OWN per-frame floor lookup — RETIRED here
    // (STAGE 2, 2026-08-04): `resolveExpectedDepth` (injected) resolves
    // straight from `depthAuthority`'s already-rebuilt rank table, no
    // separate `getActiveSceneFloors` call needed for this consumer any more.
    // CANDLE LIGHTS (effects/candle-flame-render.js) — authored by us from the
    // anchor authority, shaped EXACTLY like a Foundry light source so they flow
    // through this SAME pool: region-aware ambient, the soft edge, coloration
    // and MAX-blending, all for free. This is the "point light we control": its
    // radius/colour come from the candle effect's params, not a Foundry doc.
    profiler?.beginById('light.pointLightSourceBuild');
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
    // never disagree about which floor is active — see the hoisted
    // `currentFloorId` declaration above, shared with `readActiveLightSources`.
    for (const candle of candleLights) {
      let cached = candleWallClipCache.get(candle.sourceId);
      if (!cached || cached.floorId !== currentFloorId || cached.radius !== candle.radius) {
        wallClipCacheStats.candle.misses += 1;
        const result = computeCandleWallClippedShape({
          x: candle.x,
          y: candle.y,
          radius: candle.radius,
          levelId: currentFloorId,
        });
        cached = { floorId: currentFloorId, radius: candle.radius, ...result };
        candleWallClipCache.set(candle.sourceId, cached);
      } else {
        wallClipCacheStats.candle.hits += 1;
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
        wallClipCacheStats.lightning.misses += 1;
        const result = computeCandleWallClippedShape({
          x: strike.x,
          y: strike.y,
          radius: strike.wallClipRadiusPx,
          levelId: currentFloorId,
        });
        cached = { floorId: currentFloorId, radius: strike.wallClipRadiusPx, ...result };
        lightningWallClipCache.set(strike.sourceId, cached);
      } else {
        wallClipCacheStats.lightning.hits += 1;
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
        if (!liveLightningIds.has(id)) {
          lightningWallClipCache.delete(id);
          wallClipCacheStats.lightning.evictions += 1;
        }
      }
    }

    // FIRE LIGHTS — already clustered and built by `fire-subsystem.js`.
    // Animates via `candleFlicker`'s own wind-aware noise (`registry.js`'s
    // `firePuff` entry, 2026-08-09) rather than a clock shared with the flame
    // particles — the two are independent now (the particle rebuild gave the
    // flame its own per-particle age-driven animation; there is no single
    // shared phase left to lock the light to). They arrive here already shaped
    // like a Foundry light and flow through this one pool for region-aware
    // ambient, the soft edge, coloration and MAX-blending.
    //
    // ⚠️ THE FIRE'S LIGHT IS THE FIRE'S COST. Measured on the candle: every
    // flame billboard in a scene was 0.022 ms while its lights were 13.1 ms of
    // a 20.4 ms frame across 91 draw calls, because a 24 px billboard covers
    // ~576 px² against a 400 px light's ~785,000, drawn twice. Fire's radii are
    // larger, which is why `buildFireLightSources` clusters by tier before this
    // list ever reaches the pool.
    const fireLights = getFireLightSources ? (getFireLightSources() ?? []) : [];

    const lights = [...foundryLights, ...candleLights, ...lightningLights, ...fireLights];
    // Read ONCE per frame — a scene's grid size does not change light-to-light,
    // only scene-to-scene.
    const gridSizePixels = readGridSizePixels().gridSizePixels;
    profiler?.endById('light.pointLightSourceBuild');

    // APERTURE-GOBO SETUP (perf-instrumentation-audit-2026-08-12) — the wall-
    // segment cache rebuild/filter this block's own "PERF (2026-08-09)"
    // comments below already identify as a real, self-diagnosed concern,
    // plus the shared-uniform writes and the no-active-regions ambient
    // pre-resolve. See `apertureSegCache`'s own declaration for the cache
    // mechanism this zone's hit/miss counters track.
    profiler?.beginById('light.pointLightApertureSetup');
    // APERTURE GOBO (docs/planning/Aperture-Gobo.md) — read ONCE per frame,
    // shared by every light below, same "read once, use per-light" shape as
    // `gridSizePixels` just above.
    //
    // "Disabled" reduces to EXACTLY "no wall segments to assign" rather than
    // a separate branch per light: `findAperturesForLight` against an empty
    // list always returns zero apertures, which is the SAME code path (and
    // the SAME zero-cost material) a light with no nearby window takes —
    // there is no second "is the effect on" gate anywhere below this line.
    const apertureGoboState = getApertureGoboRenderState();
    const apertureGoboParams = apertureGoboState.params ?? {};
    // PERF (2026-08-09, ROUND 2 — round 1 is the filter inside the `if`
    // below): `readSceneWallSegments` walks every wall on the scene and
    // re-derives solid/blocksExterior/aperture for each one — real work that
    // used to be paid every single frame regardless of whether any wall had
    // moved since the last one. Walls only change on createWall/updateWall/
    // deleteWall (editing-cadence, not frame-cadence — the exact same
    // observation §5.8 already made for sun-shadow/water's bake gates), so
    // this is cached against (current floor, wall-structure version) and
    // only recomputed when either changed. `getApertureWallVersion` is a
    // GETTER bumped by boot.js on those three hooks — see this function's own
    // param doc for why capturing the number instead would freeze the cache
    // forever at whatever version existed when the pool was constructed.
    let apertureWallSegments = [];
    if (apertureGoboState.enabled) {
      const wallVersion = getApertureWallVersion();
      if (
        !apertureSegCache ||
        apertureSegCache.floorId !== currentFloorId ||
        apertureSegCache.wallVersion !== wallVersion
      ) {
        wallClipCacheStats.apertureWalls.misses += 1;
        const rawWallSegments = readSceneWallSegments(currentFloorId);
        // `findAperturesForLight`'s own loop is `if (!seg?.aperture)
        // continue` — on a wall-dense scene the overwhelming majority of
        // segments fail that check, and it re-runs, unchanged, for EVERY
        // light every frame (O(lights x walls)). Filtering to aperture-only
        // segments ONCE here, before the per-light loop, makes that per-light
        // scan operate over just the walls that could ever matter — provably
        // equivalent output: every segment this array drops would have
        // failed `findAperturesForLight`'s own first line anyway.
        const filteredWallSegments = rawWallSegments.length
          ? rawWallSegments.filter((seg) => seg?.aperture)
          : rawWallSegments;
        apertureSegCache = { floorId: currentFloorId, wallVersion, segments: filteredWallSegments };
      } else {
        wallClipCacheStats.apertureWalls.hits += 1;
      }
      apertureWallSegments = apertureSegCache.segments;
    }
    // Clamped against the SHADER's own hard cap (`aperture-gobo-render.js`'s
    // `MAX_APERTURES_PER_LIGHT`, the unroll count its uniform sets are built
    // to), not just the params schema's own declared `max` — belt and braces:
    // if a future schema edit ever authored a looser range than the shader
    // actually supports, this line is what keeps `findAperturesForLight` from
    // handing back more apertures than `entry.apApertures` has slots for,
    // rather than silently under-writing the tail of the CPU-assigned list.
    const maxAperturesPerLight = Math.min(
      Number.isFinite(apertureGoboParams.maxAperturesPerLight)
        ? apertureGoboParams.maxAperturesPerLight
        : APERTURE_GOBO_DEFAULTS.maxAperturesPerLight,
      MAX_APERTURES_PER_LIGHT
    );
    // ROUND 14 (2026-08-04) — `findAperturesForLight`'s own new 4th param;
    // see that function's own header for the live bug this closes (a large
    // light's own radius alone let it sweep in far-away, unrelated
    // `light:PROXIMITY` walls as if they were its own window).
    const maxApertureDistancePx = Number.isFinite(apertureGoboParams.maxApertureDistancePx)
      ? apertureGoboParams.maxApertureDistancePx
      : APERTURE_GOBO_DEFAULTS.maxApertureDistancePx;

    // THE SHARED UNIFORMS — one write each, read by EVERY light's material
    // (see `createApertureGoboSharedUniforms`'s own header for why these are
    // not per-light). Written even when disabled (to their honest defaults)
    // rather than skipped — cheap, and means flipping the effect back on
    // mid-session never resumes from a stale value.
    apertureGoboShared.uSillPx.value = Number.isFinite(apertureGoboParams.sillPx)
      ? apertureGoboParams.sillPx
      : APERTURE_GOBO_DEFAULTS.sillPx;
    apertureGoboShared.uHeadPx.value = Number.isFinite(apertureGoboParams.headPx)
      ? apertureGoboParams.headPx
      : APERTURE_GOBO_DEFAULTS.headPx;
    // `cols`/`rows` — NOT shared uniforms (design 4, 2026-08-03): they are
    // GRAPH-BUILD-TIME unroll counts, resolved as plain JS integers and
    // compared against each entry's OWN cached value, alongside
    // `apertureCount`, to decide whether that light's material needs
    // rebuilding this frame (`aperture-gobo-render.js`'s own header explains
    // why a live uniform can't safely control an unroll count).
    //
    // PROCEDURAL PANE COUNT (round 11, 2026-08-04) — cols/rows are no longer
    // a single pool-wide pair read straight from a param: the author's own
    // ask was a pane count that "keeps it looking logical" across different
    // wall lengths, so each light now derives its OWN cols/rows from its OWN
    // aperture's real `wallLen` (`aperture-gobo.js#findAperturesForLight`)
    // divided by a TARGET pane size, via `deriveApertureGoboPaneCount` — see
    // the per-light call below, right after `findAperturesForLight` returns
    // (that function applies its own divide-by-zero floor, so only the
    // param-vs-default resolution happens here). Only the target size
    // (`paneWidthPx`/`paneHeightPx`) is resolved once, pool-wide; the derived
    // counts are not.
    const apertureGoboPaneWidthPx = Number.isFinite(apertureGoboParams.paneWidthPx)
      ? apertureGoboParams.paneWidthPx
      : APERTURE_GOBO_DEFAULTS.paneWidthPx;
    const apertureGoboPaneHeightPx = Number.isFinite(apertureGoboParams.paneHeightPx)
      ? apertureGoboParams.paneHeightPx
      : APERTURE_GOBO_DEFAULTS.paneHeightPx;
    apertureGoboShared.uFrame.value = Number.isFinite(apertureGoboParams.frame)
      ? apertureGoboParams.frame
      : APERTURE_GOBO_DEFAULTS.frame;
    apertureGoboShared.uMullion.value = Number.isFinite(apertureGoboParams.mullion)
      ? apertureGoboParams.mullion
      : APERTURE_GOBO_DEFAULTS.mullion;
    // THE REVEAL (round 12, 2026-08-04) — `computeApertureRevealNarrowing`'s
    // own input; 0 disables it, byte-identical to the pre-round-12 symmetric
    // frame gate.
    apertureGoboShared.uWallThicknessPx.value = Number.isFinite(apertureGoboParams.wallThicknessPx)
      ? apertureGoboParams.wallThicknessPx
      : APERTURE_GOBO_DEFAULTS.wallThicknessPx;
    // GLASS QUALITY & GRIME (round 13, 2026-08-04) —
    // `computeApertureGlassWarpOffset`/`computeApertureGrimeFactor`'s own
    // inputs; `uDistortionPx`/`uGrimeAmount` at 0 are each an exact no-op
    // through their own formula.
    apertureGoboShared.uGlassQuality.value = Number.isFinite(apertureGoboParams.glassQuality)
      ? apertureGoboParams.glassQuality
      : APERTURE_GOBO_DEFAULTS.glassQuality;
    apertureGoboShared.uDistortionPx.value = Number.isFinite(apertureGoboParams.distortionPx)
      ? apertureGoboParams.distortionPx
      : APERTURE_GOBO_DEFAULTS.distortionPx;
    apertureGoboShared.uGrimeAmount.value = Number.isFinite(apertureGoboParams.grimeAmount)
      ? apertureGoboParams.grimeAmount
      : APERTURE_GOBO_DEFAULTS.grimeAmount;
    const apertureGoboSoftness = Number.isFinite(apertureGoboParams.softness)
      ? apertureGoboParams.softness
      : APERTURE_GOBO_DEFAULTS.softness;
    apertureGoboShared.uSoftFarPx.value = SOFT_FAR_PX_BASE * apertureGoboSoftness;
    // THE REACH BLUR (round 15) — same live `softness` dial, a much bigger
    // far value (`aperture-gobo.js#REACH_SOFT_FAR_PX_BASE`'s own header) —
    // see that constant's header for why this is a SEPARATE growth signal
    // from `uSoftFarPx` above, not a duplicate of it.
    apertureGoboShared.uReachSoftFarPx.value = REACH_SOFT_FAR_PX_BASE * apertureGoboSoftness;
    // EDGE SUPPRESSION (round 17) — `aperture-gobo.js#APERTURE_GOBO_
    // DEFAULTS`'s own header: a direct, guaranteed manual override, opt-in
    // (0 = off).
    apertureGoboShared.uEdgeSuppressPercent.value = Number.isFinite(apertureGoboParams.edgeSuppressPercent)
      ? apertureGoboParams.edgeSuppressPercent
      : APERTURE_GOBO_DEFAULTS.edgeSuppressPercent;
    // DIM-RADIUS SUPPRESSION, round 18 — two independent percentage
    // anchors, replacing round 17's single auto-anchored-to-the-edge
    // fraction (`aperture-gobo.js#APERTURE_GOBO_DEFAULTS`'s own "DIM-RADIUS
    // SUPPRESSION, ROUND 18" header).
    apertureGoboShared.uDimRadiusFadeStartPercent.value = Number.isFinite(apertureGoboParams.dimRadiusFadeStartPercent)
      ? apertureGoboParams.dimRadiusFadeStartPercent
      : APERTURE_GOBO_DEFAULTS.dimRadiusFadeStartPercent;
    apertureGoboShared.uDimRadiusFadeEndPercent.value = Number.isFinite(apertureGoboParams.dimRadiusFadeEndPercent)
      ? apertureGoboParams.dimRadiusFadeEndPercent
      : APERTURE_GOBO_DEFAULTS.dimRadiusFadeEndPercent;
    // DEBUG CHANNEL — round 10 (2026-08-04) retired the 4-way picker back
    // to 2: 'off' (the real effect, always baked into `entry.material`/
    // `entry.colorationMaterial` now — nothing to toggle) and 'pattern'
    // (the standalone raw-gobo debug mesh, `entry.apertureShadowDebugMesh`,
    // useful for visually confirming mullion/frame geometry independent of
    // brightness). 'visibility'/'gate-inputs' were the retired visibility
    // gate's own instruments — see point-light-illumination.js's own "THE
    // GOBO IS PART OF THIS LIGHT'S OWN FALLOFF" header for why that gate no
    // longer exists to have inputs.
    const apertureGoboDebugChannel = apertureGoboState.debugChannel ?? 'off';
    apertureGoboShared.uStrength.value = Number.isFinite(apertureGoboParams.strength)
      ? apertureGoboParams.strength
      : APERTURE_GOBO_DEFAULTS.strength;

    apertureGoboReadout.totalFound = 0;
    apertureGoboReadout.dropped = 0;
    apertureGoboReadout.litLights = 0;
    apertureGoboReadout.enabled = apertureGoboState.enabled === true;

    // PERF (2026-08-09): with no active darkness regions, `computeRegion
    // AdjustedDarkness(light.x, light.y, darkness01, activeRegions)` returns
    // the bare `darkness01` for EVERY light — its own first line proves this
    // (`region-geometry.js`: `if (!Array.isArray(regions) || regions.length
    // === 0) return darkness01;`), so `computeAmbientColors` then resolves an
    // IDENTICAL triple for every light too. Resolved once here and reused,
    // rather than recomputed (a `{...env}` spread + two `mixRgb` allocations)
    // per light per frame for a scene-uniform answer. `null` when regions
    // ARE active — the per-light loop below falls back to the original,
    // region-aware per-light computation in that case, unchanged.
    const sharedAmbientNoRegions =
      Array.isArray(activeRegions) && activeRegions.length > 0
        ? null
        : computeAmbientColors({ ...env, darkness01 }, darknessRealism01);
    profiler?.endById('light.pointLightApertureSetup');

    // PER-LIGHT RECONCILE (perf-instrumentation-audit-2026-08-12) — the
    // biggest, most complex phase of `update()`: per-light aperture
    // assignment, the batching-vs-per-light admission decision, mesh
    // create/rebuild, the re-triangulation dirty-check and every per-light
    // uniform write. Likely the dominant cost inside `light.pointLightUpdate`
    // on any scene with real light counts — this is the zone to read first
    // once a live report exists.
    profiler?.beginById('light.pointLightReconcile');
    const seen = new Set();
    // bucketKey -> {members: [], flags: {...}} — fresh every frame; a light
    // absent this frame (deleted, or outside its own darkness01 window —
    // `readActiveLightSources` already filtered it out of `lights` before
    // this function ever sees it) simply never gets pushed, and the
    // reconcile pass after this loop naturally drops it from its bucket,
    // same as `seen`/`lightMeshes`' own per-light equivalent.
    const illumBatchGroups = new Map();
    const colorBatchGroups = new Map();
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
      // APERTURE GOBO ASSIGNMENT — a cheap CPU pass per light
      // (`aperture-gobo.js#findAperturesForLight`), computed BEFORE the
      // rebuild check below because `apertureCount` is itself part of that
      // check: like `falloffModel`/`animationType`, the NUMBER of aperture
      // uniform sets a light's material was built with is baked into its
      // graph at construction time (`aperture-gobo-render.js`'s own header —
      // deliberately no `Loop`/`uniformArray`, so the unroll count IS the
      // shader). `apertureWallSegments` is already `[]` when the effect is
      // disabled (filtering an empty array is still empty), so this
      // naturally resolves to zero for every light with no extra branch.
      // Pre-filtered to `aperture === true` once above, not the raw wall
      // list — see that filter's own comment.
      const {
        apertures: lightApertures,
        dropped,
        totalFound,
      } = findAperturesForLight(
        { x: light.x, y: light.y, radius: light.radius },
        apertureWallSegments,
        maxAperturesPerLight,
        maxApertureDistancePx
      );
      const apertureCount = lightApertures.length;
      apertureGoboReadout.totalFound += totalFound;
      apertureGoboReadout.dropped += dropped;
      if (apertureCount > 0) apertureGoboReadout.litLights += 1;

      // PROCEDURAL PANE COUNT, per-light (round 11, 2026-08-04) — a wide
      // window naturally gets more panes than a narrow one, instead of one
      // pool-wide count stretched or squeezed to fit every wall length.
      // `deriveApertureGoboPaneCount` (aperture-gobo.js) is the ONE shared
      // derivation `bench-aperture-gobo.js` also imports, so production and
      // the shader-lab bench can never quietly drift apart. Uses the FIRST
      // aperture as the representative wall: sharing one pane count across
      // more than one aperture on the SAME light is not a new simplification
      // this round introduces — `cols`/`rows` were already one pair shared
      // across every aperture on a light before this round; this only
      // changes where the pair's VALUE comes from.
      const { cols: apertureGoboCols, rows: apertureGoboRows } = deriveApertureGoboPaneCount({
        wallLen: lightApertures[0]?.wallLen,
        sillPx: apertureGoboShared.uSillPx.value,
        headPx: apertureGoboShared.uHeadPx.value,
        paneWidthPx: apertureGoboPaneWidthPx,
        paneHeightPx: apertureGoboPaneHeightPx,
      });

      // STAGE 2 BATCHING (S2.5) — admission is decided HERE, right where
      // `apertureCount`/`falloffModel` are both already resolved (design
      // doc §3.1/§3.5: aperture-lit lights and any falloff model outside
      // the closed list NEVER batch, full stop — they fall through to the
      // UNCHANGED per-light path below, which is ALSO Stage 2's own safety
      // slide: flag OFF makes `canBatch` false for every light, byte-
      // identical to before this branch existed).
      const canBatch = pointLightBatchingEnabled && canBatchLight({ apertureCount, falloffModel });
      if (canBatch) {
        // A light that batches THIS frame but had a per-light entry from a
        // PREVIOUS frame (its own apertureCount just dropped to 0 — the only
        // realistic transition, since falloffModel is constant per source)
        // must have that entry HIDDEN, never left visible: `seen.add`
        // already ran above, so the generic end-of-loop "not in seen"
        // cleanup below will NOT hide it — this light is very much seen,
        // just by the other path now. Hidden, not deleted, the same "hide
        // never delete" doctrine `lightMeshes` itself documents.
        const staleEntry = lightMeshes.get(light.sourceId);
        if (staleEntry) {
          staleEntry.mesh.visible = false;
          staleEntry.colorationMesh.visible = false;
          if (staleEntry.apertureShadowDebugMesh) staleEntry.apertureShadowDebugMesh.visible = false;
        }

        const animationEntry = resolveLightAnimation(light.animation.type);
        const windPresent = Number.isFinite(light.windExposure);
        const bucketKey = computeBucketKey({
          animationType: light.animation.type,
          animationResolved: animationEntry !== null,
          animationQuality,
          falloffModel,
          windPresent,
        });

        // SHARED per-frame values — the SAME formulas the per-light path
        // below uses on its own copy of the same light, just written into a
        // packed-vertex member object instead of a per-light uniform.
        let localAmbient = sharedAmbientNoRegions;
        if (!localAmbient) {
          const localDarkness01 = computeRegionAdjustedDarkness(light.x, light.y, darkness01, activeRegions);
          localAmbient = computeAmbientColors({ ...env, darkness01: localDarkness01 }, darknessRealism01);
        }
        const attenuationEased = easeAttenuation(light.attenuation01);
        const exposure = computeExposure(light.luminosity01);
        const expectedDepth = resolveExpectedDepth ? resolveExpectedDepth(light.elevation) : 0;
        const reverseSign = light.animation.reverse ? -1 : 1;
        // Same `?? 1` fallback the per-light path's own uniform write uses
        // (`entry.uIllumWindExposure.value = light.windExposure ?? 1`) —
        // writing a raw `undefined` into a Float32Array silently becomes
        // NaN (`feedback_raw_seed_into_noise_coordinate`), and this is
        // written regardless of `windPresent` (a bucket with no `aWind`
        // buffer simply never reads it — see `layout.buffers`).
        const windExposureSafe = light.windExposure ?? 1;
        const windResponseSafe = light.windResponse ?? 1;

        const illumAnimated = !!animationEntry?.buildIlluminationSeed;
        let illumGroup = illumBatchGroups.get(bucketKey);
        if (!illumGroup) {
          illumGroup = {
            members: [],
            flags: { animated: illumAnimated, windPresent, animationEntry, animationQuality, falloffModel },
          };
          illumBatchGroups.set(bucketKey, illumGroup);
        }
        illumGroup.members.push({
          sourceId: light.sourceId,
          x: light.x,
          y: light.y,
          radius: light.radius,
          shapePoints: light.shapePoints,
          ratio: light.ratio,
          attenuationEased,
          exposure,
          expectedDepth,
          bg: localAmbient.background,
          dim: localAmbient.dim,
          bright: localAmbient.bright,
          speedRaw: light.animation.speedRaw,
          reverseSign,
          seed: light.animation.seed,
          intensityRaw: light.animation.intensityRaw,
          windExposure: windExposureSafe,
          windResponse: windResponseSafe,
        });

        // COLORATION MEMBERSHIP — independent of illumination admission,
        // the SAME `hasColor || forceDefaultColor` rule the per-light path's
        // own `uColorationAlpha` gate already applies
        // (point-light-batch.js#isColorationEligible, the ONE place this
        // rule lives now).
        const forceDefaultColor = animationEntry?.forceDefaultColor === true;
        if (isColorationEligible({ hasColor: light.hasColor, forceDefaultColor })) {
          const colorAnimated = !!animationEntry?.buildColorationSeed;
          let colorGroup = colorBatchGroups.get(bucketKey);
          if (!colorGroup) {
            colorGroup = {
              members: [],
              flags: { animated: colorAnimated, windPresent, animationEntry, animationQuality, falloffModel },
            };
            colorBatchGroups.set(bucketKey, colorGroup);
          }
          colorGroup.members.push({
            sourceId: light.sourceId,
            x: light.x,
            y: light.y,
            radius: light.radius,
            shapePoints: light.shapePoints,
            attenuationEased,
            colorationAlpha: computeColorationAlpha(light.alpha01, 1),
            expectedDepth,
            ratio: light.ratio,
            lightColor: light.color,
            speedRaw: light.animation.speedRaw,
            reverseSign,
            seed: light.animation.seed,
            intensityRaw: light.animation.intensityRaw,
            windExposure: windExposureSafe,
            windResponse: windResponseSafe,
          });
        }
        continue;
      }

      if (
        entry &&
        (entry.animationType !== light.animation.type ||
          entry.animationQuality !== animationQuality ||
          entry.falloffModel !== falloffModel ||
          entry.apertureCount !== apertureCount ||
          // `cols`/`rows` join the rebuild key for the SAME reason
          // `apertureCount` is already in it (design 4, 2026-08-03): both
          // are graph-build-time unroll counts baked into the aperture
          // shadow material, not shared uniforms — see aperture-gobo-
          // render.js's own header. A change is GLOBAL (one param, every
          // light), so every light's cached value goes stale on the same
          // frame and all of them rebuild together.
          entry.apGoboCols !== apertureGoboCols ||
          entry.apGoboRows !== apertureGoboRows)
      ) {
        lightScene.remove(entry.mesh);
        colorationScene.remove(entry.colorationMesh);
        entry.material.dispose();
        entry.colorationMaterial.dispose();
        // APERTURE SHADOW DEBUG — round 10: the ONE surviving standalone
        // mesh, only present when the PREVIOUS apertureCount was > 0 (the
        // real effect itself is baked into `entry.material`/
        // `entry.colorationMaterial` above and needs no separate teardown).
        if (entry.apertureShadowDebugMesh) {
          apertureShadowScene.remove(entry.apertureShadowDebugMesh);
          entry.apertureShadowDebugMaterial.dispose();
        }
        entry.geometry.dispose();
        lightMeshes.delete(light.sourceId);
        entry = null;
      }
      if (!entry) {
        lightMeshMisses += 1;
        entry = createLightEntry({
          light,
          animationQuality,
          falloffModel,
          windHandle,
          THREE,
          envLight,
          blendSunVisibilityAcrossFloors,
          sceneColor,
          uGlobalTimeMs,
          lightScene,
          colorationScene,
          apertureShadowScene,
          apertureCount,
          apGoboCols: apertureGoboCols,
          apGoboRows: apertureGoboRows,
          apertureGoboShared,
        });
        lightMeshes.set(light.sourceId, entry);
      } else {
        lightMeshHits += 1;
      }
      // THE PER-FRAME APERTURE UNIFORM WRITE — a wall's position doesn't
      // change frame to frame, but a light standing near a door can SWING
      // past one, so these are written every frame like every other
      // per-light uniform in this loop, never just once at creation.
      // `entry.apApertures` is `null` when `apertureCount` is 0 (this light
      // has no windows at all this frame) — nothing to write. TWO uniform
      // sets as of round 10 (illumination's own `apApertures` AND
      // coloration's own `apColApertures` — see point-light-coloration.js's
      // own header for why coloration needs the gobo baked in too) — both
      // written from the SAME `lightApertures`, the same duplication-
      // across-the-mesh-pair pattern this loop already uses for every other
      // shared-value uniform pair.
      if (entry.apApertures && entry.apApertures.length > 0) {
        const lampHeightPx = resolveLampHeight(light, apertureGoboParams);
        entry.uApLampHeight.value = lampHeightPx;
        if (entry.uApColLampHeight) entry.uApColLampHeight.value = lampHeightPx;
        for (let i = 0; i < entry.apApertures.length; i++) {
          const src = lightApertures[i];
          const dst = entry.apApertures[i];
          dst.uA.value.set(src.A.x, src.A.y);
          dst.uDir.value.set(src.dir.x, src.dir.y);
          dst.uNrm.value.set(src.nrm.x, src.nrm.y);
          dst.uSLAWallLen.value.set(src.sL, src.a, src.wallLen);
          const dstCol = entry.apColApertures?.[i];
          if (dstCol) {
            dstCol.uA.value.set(src.A.x, src.A.y);
            dstCol.uDir.value.set(src.dir.x, src.dir.y);
            dstCol.uNrm.value.set(src.nrm.x, src.nrm.y);
            dstCol.uSLAWallLen.value.set(src.sL, src.a, src.wallLen);
          }
        }
      }
      // RE-TRIANGULATION DIRTY-CHECK (2026-08-09) — triangulateLightFan,
      // the BufferAttribute re-upload and writeLightEdgePoints all derive
      // PURELY from (light.x, light.y, light.radius, light.shapePoints); if
      // none of those four differ from what was last written for THIS
      // light, redoing them produces byte-identical output. `shapePoints`
      // FAILURE-SAFE by construction: `shapePointsUnchanged` on the very
      // first frame compares against the `null` sentinel and correctly
      // reports "changed", so a light's first frame always takes the full,
      // correct path — this can only skip work that would have been a
      // no-op, never skip a real change.
      const lightShapeChanged = !(
        light.x === entry.lastShapeX &&
        light.y === entry.lastShapeY &&
        light.radius === entry.lastShapeRadius &&
        shapePointsUnchanged(light.shapePoints, entry.lastShapePoints)
      );
      let normalizedPolygon;
      if (lightShapeChanged) {
        // REUSE, not reallocate (see lightMeshes' own doc — this is the
        // device-lost fix, not an optimisation): triangulateLightFan writes
        // into entry.scratchArray when it already has room. It returns a
        // DIFFERENT array only on the rare frame this light's polygon outgrows
        // its previous high-water mark, in which case (and ONLY then) a new
        // BufferAttribute replaces the old one.
        const triangulated = triangulateLightFan(light.shapePoints, light.x, light.y, light.radius, entry.scratchArray);
        const { array, vertexCount } = triangulated;
        normalizedPolygon = triangulated.normalized;
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
        entry.lastShapeX = light.x;
        entry.lastShapeY = light.y;
        entry.lastShapeRadius = light.radius;
        entry.lastShapePoints = light.shapePoints;
      }
      // Mirrors Foundry's OWN mesh placement exactly: geometry is normalized
      // to local unit-radius space by triangulateLightFan, then
      // positioned/scaled back out to world space here.
      entry.mesh.position.set(light.x, light.y, 0);
      entry.mesh.scale.set(light.radius, light.radius, 1);
      entry.mesh.visible = true;
      // APERTURE SHADOW DEBUG — round 10: the ONE surviving standalone
      // Object3D (shares `geometry` with `entry.mesh` but needs its OWN
      // transform sync, same as before). The real effect is baked into
      // `entry.material`/`entry.colorationMaterial` now and needs no
      // per-frame visibility toggle of its own — it's simply always part of
      // whatever those two materials draw. Visible only in the 'pattern'
      // debug channel; `null` when this light has no apertures.
      if (entry.apertureShadowDebugMesh) {
        entry.apertureShadowDebugMesh.position.set(light.x, light.y, 0);
        entry.apertureShadowDebugMesh.scale.set(light.radius, light.radius, 1);
        entry.apertureShadowDebugMesh.visible = apertureGoboDebugChannel === 'pattern';
      }
      // PER-LIGHT REGION-AWARE AMBIENT — see this function's own header for
      // the full "hard edge on a soft light" bug this fixes. Skipped when no
      // region is active (`sharedAmbientNoRegions` set above) — every light
      // would resolve to the identical answer; see that constant's own doc.
      let localAmbient = sharedAmbientNoRegions;
      if (!localAmbient) {
        const localDarkness01 = computeRegionAdjustedDarkness(light.x, light.y, darkness01, activeRegions);
        localAmbient = computeAmbientColors({ ...env, darkness01: localDarkness01 }, darknessRealism01);
      }
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
      // HEIGHT/ELEVATION GATE — STAGE 2 (2026-08-04); candle CAST-light
      // elevation authored 2026-08-05. See point-light-illumination.js's own
      // "STAGE 2 — THE DEPTH-AUTHORITY HEIGHT GATE" section. `light.elevation`
      // is a real absolute-world-units value for candle-cast lights now
      // (`buildCandleLightSources` → `resolveAnchorElevationWorldUnits`, fed
      // from the candle's own `params.elevation` "height off floor") — still
      // `undefined` for lightning-cast lights (`buildLightningLightSources`
      // carries no such field; lightning has no authored height yet). Either
      // way, their own FLAME SPRITE/BOLT RIBBON visuals are a completely
      // separate render path, gated by the OLD `resolveAnchorElevationRank`
      // instead (see that function's own doc) — fed the SAME authored height
      // for candles, so the two no longer disagree. `resolveExpectedDepth`
      // normalizes `undefined`/non-finite the same way `resolveLightElevation
      // Rank` used to (→ treated as elevation 0 — `depth-authority.js#rankOf
      // Elevation`'s own "no special-casing needed" design point), so
      // lightning keeps its pre-existing, ungated-by-default reach with no
      // branch here.
      if (entry.uLightExpectedDepth && resolveExpectedDepth) {
        const expectedDepth = resolveExpectedDepth(light.elevation);
        entry.uLightExpectedDepth.value = expectedDepth;
        // The coloration twin carries its OWN copy of this uniform (two
        // independently-built materials, same light) — it must be pushed too,
        // or the animated glow gates against a stale value and keeps
        // drawing through solid floors.
        if (entry.uColorationLightExpectedDepth) entry.uColorationLightExpectedDepth.value = expectedDepth;
        // RAW elevation, stashed for the diagnostics ONLY (vt-pan-viewer.js's
        // own height-gate report) — the ONE number an author can check
        // straight against Foundry's own light sheet, unlike `expectedDepth`
        // itself (an opaque depth-space float — feedback_aggregate_cannot_
        // name_the_source). `null`, never `undefined`, for a candle/lightning
        // -cast light that carries no elevation field at all — the report's
        // own "was this ever a real Foundry elevation" question.
        entry.lastElevationRaw = Number.isFinite(light.elevation) ? light.elevation : null;
      }
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
      // first setup() call). Guarded by the SAME `lightShapeChanged` check
      // as triangulateLightFan above (2026-08-09) — identical inputs, so an
      // unchanged light's edge points are already correct from last frame
      // and `entry.uEdgeCount.value` already holds the right count.
      // `normalizedPolygon` is `triangulateLightFan`'s own normalization of
      // this SAME (shapePoints, x, y, radius) — passed straight through so
      // this call does not redo that divide-and-subtract pass (2 fresh
      // Float64Arrays) a second time for identical output.
      if (lightShapeChanged) {
        entry.uEdgeCount.value = writeLightEdgePoints(
          light.shapePoints,
          light.x,
          light.y,
          light.radius,
          entry.edgePoints,
          normalizedPolygon
        );
      }
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
        if (entry.apertureShadowDebugMesh) {
          entry.apertureShadowDebugMesh.visible = false;
        }
      }
    }
    profiler?.endById('light.pointLightReconcile');

    // BATCH RECONCILE (perf-instrumentation-audit-2026-08-12) — isolated from
    // the per-light reconcile above on purpose: batching (S2.5) exists to
    // REDUCE cost, so its own overhead should be independently visible and
    // comparable, not folded into the loop it is meant to be cheaper than.
    // Near-zero when `pointLightBatchingEnabled` is off (both group maps stay
    // empty and these loops iterate zero times), so this behaves as a
    // 'conditional' zone in effect even though the brackets are unconditional.
    profiler?.beginById('light.pointLightBatchReconcile');
    // STAGE 2 BATCHING (S2.5) — reconcile every bucket THIS frame's admitted
    // lights grouped into, then hide (never delete — see `illumBuckets`' own
    // doc) any EXISTING bucket key with zero members this frame. A brand-new
    // key gets its mesh built once here and added to the SAME scene the
    // per-light meshes already share (design doc §3.4: MAX blending is
    // order-independent, proven — buckets and per-light meshes coexist in
    // one scene with no ordering requirement between them).
    batchingReadout.enabled = pointLightBatchingEnabled;
    batchingReadout.illumBucketCount = illumBatchGroups.size;
    batchingReadout.illumLightCount = 0;
    batchingReadout.colorBucketCount = colorBatchGroups.size;
    batchingReadout.colorLightCount = 0;
    for (const [key, group] of illumBatchGroups) {
      let bucket = illumBuckets.get(key);
      if (!bucket) {
        illumBucketMisses += 1;
        bucket = createBatchedLightMesh({
          THREE,
          channel: 'illumination',
          shared: illumSharedResources,
          flags: group.flags,
        });
        lightScene.add(bucket.mesh);
        illumBuckets.set(key, bucket);
      } else {
        illumBucketHits += 1;
      }
      const result = bucket.reconcile(group.members);
      batchingReadout.illumLightCount += result.memberCount;
    }
    for (const [key, bucket] of illumBuckets) {
      if (!illumBatchGroups.has(key)) bucket.reconcile([]);
    }
    for (const [key, group] of colorBatchGroups) {
      let bucket = colorBuckets.get(key);
      if (!bucket) {
        colorBucketMisses += 1;
        bucket = createBatchedLightMesh({
          THREE,
          channel: 'coloration',
          shared: colorSharedResources,
          flags: group.flags,
        });
        colorationScene.add(bucket.mesh);
        colorBuckets.set(key, bucket);
      } else {
        colorBucketHits += 1;
      }
      const result = bucket.reconcile(group.members);
      batchingReadout.colorLightCount += result.memberCount;
    }
    for (const [key, bucket] of colorBuckets) {
      if (!colorBatchGroups.has(key)) bucket.reconcile([]);
    }
    profiler?.endById('light.pointLightBatchReconcile');

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
      if (entry.apertureShadowMaterial) {
        try {
          entry.apertureShadowMaterial.dispose();
          entry.apertureShadowDebugMaterial.dispose();
          entry.apertureShadowVisibilityDebugMaterial.dispose();
          entry.apertureShadowGateInputsDebugMaterial.dispose();
        } catch (err) {
          log.error(`point-light aperture-shadow material dispose failed for '${id}' — VRAM may be leaked:`, err);
        }
      }
      try {
        entry.geometry.dispose();
      } catch (err) {
        log.error(`point-light geometry dispose failed for '${id}' — VRAM may be leaked:`, err);
      }
    }
    lightMeshes.clear();
    for (const bucket of illumBuckets.values()) {
      try {
        bucket.dispose();
      } catch (err) {
        log.error('point-light illumination bucket dispose failed — VRAM may be leaked:', err);
      }
    }
    illumBuckets.clear();
    for (const bucket of colorBuckets.values()) {
      try {
        bucket.dispose();
      } catch (err) {
        log.error('point-light coloration bucket dispose failed — VRAM may be leaked:', err);
      }
    }
    colorBuckets.clear();
  }

  /** The aperture-gobo readout — apertures found/dropped/lit-lights as of
   * the LAST `update()` call. A plain function reading the mutable object
   * `update()` writes in place, mirroring `getPointLightsInfo`'s own posture
   * elsewhere: a diagnostics consumer (the debug panel report) pulls this,
   * nothing pushes it. */
  function getApertureGoboReadout() {
    return { ...apertureGoboReadout };
  }

  /** THE BATCHING READOUT (S2.5) — see `batchingReadout`'s own doc. */
  function getBatchingReadout() {
    return { ...batchingReadout };
  }

  /** THE WALL-CLIP CACHE HEALTH READOUT (perf-instrumentation-audit-2026-08-12)
   * — see `wallClipCacheStats`' own doc. LIFETIME counters, unlike the two
   * readouts above (which `update()` resets and rewrites every call): a
   * caller wanting "what happened during THIS window" samples this once
   * before and once after, same convention `depth-proxy-material-pool.js`
   * already established. Deep-copied (nested per-cache objects), not a
   * shallow spread — the two readouts above are flat and a shallow copy is
   * enough for them; this one is not. */
  function getWallClipCacheStats() {
    return {
      candle: { ...wallClipCacheStats.candle },
      lightning: { ...wallClipCacheStats.lightning },
      regular: { ...wallClipCacheStats.regular },
      apertureWalls: { ...wallClipCacheStats.apertureWalls },
    };
  }

  /** POOL HEALTH — lightMeshes/illumBuckets/colorBuckets' own hit/miss
   * counters (see their own declaration for the exact hit/miss doctrine).
   * Lifetime counters, same before/after sampling convention as
   * getWallClipCacheStats above and depth-proxy-material-pool.js. */
  function getMeshPoolStats() {
    return {
      lightMeshes: { hits: lightMeshHits, misses: lightMeshMisses, size: lightMeshes.size },
      illumBuckets: { hits: illumBucketHits, misses: illumBucketMisses, size: illumBuckets.size },
      colorBuckets: { hits: colorBucketHits, misses: colorBucketMisses, size: colorBuckets.size },
    };
  }

  /**
   * Invalidate every batched bucket's material — the bucket sibling of the
   * per-light `entry.animationType = '__wind_rebake_pending__'` sentinel
   * trick `vt-pan-viewer.js`'s own wind-rebake handler uses. A bucket
   * material bakes in `windHandle` at CONSTRUCTION time (same as a per-light
   * material — see `point-light-illumination.js`'s own "SHARED WIND" seed-
   * injection block), but a bucket's KEY (`computeBucketKey`) has no
   * wind-HANDLE-identity component, only a `windPresent` boolean — so unlike
   * a per-light entry, waiting for "next frame's key mismatch" would never
   * fire. Disposing every bucket outright and clearing both registries is
   * the fix: the very next `update()` call finds no existing bucket for any
   * key, so every batched light rebuilds its bucket fresh against THIS
   * frame's `getWindHandle()` result, same as a freshly-appearing light
   * would. Removes each mesh from its scene BEFORE disposing (the scene
   * itself is NOT being torn down here, unlike this pool's own `dispose()`
   * above — an undisposed-but-orphaned mesh reference left in a live scene
   * is exactly the zombie-node class the per-light rebuild path already
   * avoids via its own `lightScene.remove(entry.mesh)` call).
   */
  function invalidateBatchedWindMaterials() {
    for (const bucket of illumBuckets.values()) {
      lightScene.remove(bucket.mesh);
      bucket.dispose();
    }
    illumBuckets.clear();
    for (const bucket of colorBuckets.values()) {
      colorationScene.remove(bucket.mesh);
      bucket.dispose();
    }
    colorBuckets.clear();
  }

  return Object.freeze({
    lightScene,
    colorationScene,
    apertureShadowScene,
    lightMeshes,
    candleWallClipCache,
    lightningWallClipCache,
    update,
    getApertureGoboReadout,
    getBatchingReadout,
    getWallClipCacheStats,
    getMeshPoolStats,
    invalidateBatchedWindMaterials,
    dispose,
  });
}
