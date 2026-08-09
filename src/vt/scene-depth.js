/**
 * `buf:scene.depth` — THE DEPTH AUTHORITY'S GPU HALF (docs/planning/Depth-
 * Buffer.md). A real, samplable depth attachment carrying the drawable
 * ranked highest at each pixel — `scene/depth-authority.js`'s CPU-side
 * ranking (already live, `vt-pan-viewer.js`'s `updateResidencyUnguarded`),
 * turned into a GPU resource every effect can query the same way.
 *
 * ============================================================================
 * WHAT IS PROVEN, AND WHERE
 * ============================================================================
 * Every mechanism this file uses was proven FIRST in
 * `tools/shader-lab/bench-scene-depth.js` (`window.lab.run('scene-depth', …)`)
 * against a real WebGPU device, before landing here — this project's own
 * hardest-earned lesson (`docs/planning/Light-Elevation-Occlusion-Failure.md`,
 * fifteen rounds) is that a shader compiling is not a shader being correct:
 *   - order-independence of the depth TEST itself (scenario 1)
 *   - a lossless rank round-trip through the REAL `createDepthAuthority`
 *     (scenario 2)
 *   - `.discard()`-based holes with zero blend artifacts (scenario 3)
 *   - the real tower-bridge map producing correct per-floor structure
 *     (scenario 4)
 *   - a SEPARATE material sampling the depth texture via its own TSL
 *     fragment shader — the exact shape {@link querySceneDepth} uses
 *     (scenario 5)
 *
 * ⚠️ NAMED HONESTLY: {@link computeExpectedStoredDepth} — the formula that
 * lets a caller with no drawn geometry of its own (a light) ask "is the
 * surface here above my rank" — is NOT on the list above. A "scenario 6" was
 * planned to render real geometry at known ranks and compare the GPU-sampled
 * depth against this formula's prediction, the same discipline every other
 * line above actually got; it was never built. `bench-scene-depth.js` has
 * scenarios 1-5 only — grep it before trusting a docstring that says
 * otherwise. This formula is algebra, cross-checked against the vendored
 * `makeOrthographic` source (see its own doc), NOT empirically GPU-verified.
 * If a light gated on this formula ever self-occludes (its own floor's
 * ground going dark under it) or fails to occlude something genuinely above
 * it, THIS is the first place to suspect — build the missing scenario 6
 * before spending time anywhere else.
 *
 * ============================================================================
 * WHY A DEDICATED CAMERA, NOT THE SHARED WORLD CAMERA
 * ============================================================================
 * `vt-pan-viewer.js`'s own world camera is `OrthographicCamera(left, right,
 * top, bottom, -1, 1)` at the default position `(0,0,0)` — a near/far pair
 * that has never needed to mean anything precise because every existing
 * drawable sits at world Z=0. Reusing it for real depth-ranking would mean
 * either changing ITS near/far (risking every other consumer of that camera
 * for a feature they don't use) or reverse-engineering what near=-1 even
 * means for this purpose. Neither is necessary: {@link DEPTH_PASS_CAMERA_Z},
 * {@link DEPTH_PASS_NEAR} and {@link DEPTH_PASS_FAR} describe this module's
 * OWN camera, built fresh, with the EXACT parameters
 * `bench-scene-depth.js` already proved (position z=5, looking at the
 * origin, near=0.01, far=10, `depthFunc:LessDepth`, clear depth 1). Only the
 * X/Y framing is shared with the world camera — via
 * {@link module:scene/world-quad.computeCameraFrustum}, the SAME pure
 * function, called again with the SAME `rect`, never the camera object
 * itself — which is what keeps `screenUV` indexing the same world position
 * in both this pass and the main world draw.
 *
 * ============================================================================
 * WHY THE QUERY NEVER RECOMPUTES A PROJECTION ON THE GPU
 * ============================================================================
 * `querySceneDepth` takes an already-resolved `expectedDepth` float — a
 * plain JS number, computed ONCE on the CPU by {@link computeExpectedStoredDepth}
 * when a caller (a light, at build or refresh time) knows its own rank —
 * never a raw rank converted to depth-space inside the shader. This mirrors
 * how `uLightExpectedDepth` is already a CPU-resolved, per-light uniform in
 * `effects/lighting/point-light-illumination.js` (STAGE 2, 2026-08-04 — see
 * that file's own "STAGE 2" header for the real consumer this formula feeds),
 * and it means the GPU side of this module is EXACTLY scenario 5's
 * already-proven shape: sample the depth texture once at `screenUV`, compare
 * against a plain uniform float.
 * Nothing about `OrthographicCamera`'s own projection matrix needs to be
 * reasoned about inside a fragment shader.
 *
 * @module vt/scene-depth
 */

import { getActiveSceneFloors } from '../foundry/index.js';
import { resolveElevationFloorIndex } from '../scene/index.js';

/**
 * THE DEDICATED DEPTH-PASS CAMERA'S OWN CONSTANTS — see this module's own
 * header, "WHY A DEDICATED CAMERA". These three numbers are the SINGLE
 * source `computeExpectedStoredDepth` derives its formula from; the actual
 * camera this pass renders with must be constructed with THESE SAME values,
 * never a second, independently-typed copy
 * ([[feedback_shared_field_two_meanings_two_registries]]'s sibling risk: one
 * set of numbers meant to describe ONE camera, transcribed twice).
 * `bench-scene-depth.js`'s own scenario 6 constructs its validation camera
 * from these exact exports, not its own literals, for the same reason.
 */
export const DEPTH_PASS_CAMERA_Z = 5;
export const DEPTH_PASS_NEAR = 0.01;
export const DEPTH_PASS_FAR = 10;

/**
 * The render-target format for `buf:scene.depth` (design doc §4) — a real,
 * samplable `depth32float` attachment plus an RGBA8 payload, both
 * screen-sized. Mirrors `scene-attr.js#describeSceneAttrMrt`'s own shape
 * (a plain descriptor object the SAME `ThreeAllocator.create()` call site
 * every other screen target already uses can pass straight through) — the
 * one new field, `depthTexture: true` (+ `depthTextureType`), is
 * `graph/three-allocator.js`'s own extension (`describe()`/`create()`),
 * built and lab-proven alongside this file, never a bypass of it —
 * `gpu/allocator-only` (tools/verify-structure.mjs) fails the build on a
 * `new *RenderTarget(`/`new *DepthTexture(` anywhere else.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {number} args.resolvedW @param {number} args.resolvedH - device px.
 * @returns {object} a `ThreeAllocator`-shaped descriptor.
 */
export function describeSceneDepthTarget({ THREE, resolvedW, resolvedH }) {
  return {
    resolvedW,
    resolvedH,
    screenSized: true,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.NoColorSpace,
    filter: 'nearest',
    depthTexture: true,
    depthTextureType: THREE.FloatType,
  };
}

/**
 * Map a rank to the world-Z this pass's proxy meshes are placed at —
 * `(rank+1)/(maxRank+1)`, EXACTLY `bench-scene-depth.js`'s own proven
 * formula (never re-derived independently): every real rank lands strictly
 * inside `(0,1)`, so an unwritten texel (cleared to depth 1, the far plane)
 * always loses to anything real — the same fail-open guarantee
 * `buf:scene.attr`'s zero-clear reaches for, from the opposite convention.
 * `maxRank` clamped to >= 1 the same way `depth-authority.js`'s own
 * `maxRank` getter is, so an empty scene never divides by zero.
 *
 * @param {number} rank
 * @param {number} maxRank - `depthAuthority.maxRank` (a COUNT, not a
 *   0-indexed max — see that module's own getter doc).
 * @returns {number} a world-Z in `(0,1)`.
 */
export function rankToDepthZ(rank, maxRank) {
  return (rank + 1) / (Math.max(1, maxRank) + 1);
}

/**
 * THE FORMULA THAT MAKES A LIGHT'S QUERY POSSIBLE WITH NO GEOMETRY OF ITS
 * OWN. A real drawable's stored depth is whatever the GPU computes from its
 * `mesh.position.z` through {@link DEPTH_PASS_CAMERA_Z}'s own orthographic
 * projection — but a light has no mesh in this pass to sample a reference
 * point from (`querySceneDepth`'s own header explains why the query never
 * tries to reconstruct this on the GPU instead). This is that projection,
 * done once, in JS, so a caller with only a RANK (never a drawn pixel) can
 * still ask "is the surface here above me".
 *
 * Derived from `THREE.Matrix4#makeOrthographic`'s own WebGPU-coordinate-
 * system branch (`src/vendor/three/three.webgpu.js:6168-6170`, read before
 * trusting it, not assumed): for a camera at `(0,0,cameraZ)` looking at the
 * origin (so `viewZ = worldZ - cameraZ`, a pure translation — no rotation
 * component touches Z when the camera looks straight down its own -Z axis
 * from a point also on the Z axis), the stored NDC depth is
 * `(cameraZ - near - worldZ) / (far - near)`. Cross-checked against this
 * module's own empirical convention (`LessDepth` wins, found in
 * `bench-scene-depth.js`'s first live run): a HIGHER rank has a LARGER
 * `worldZ` (`rankToDepthZ` increases with rank), which this formula maps to
 * a SMALLER stored depth — consistent with "closer wins under LessDepth",
 * not a second, independent claim.
 *
 * ⚠️ NOT YET VERIFIED AGAINST THE GPU'S OWN ACTUAL OUTPUT — algebra and a
 * vendored-source cross-check ONLY (see this module's own header, "WHAT IS
 * PROVEN, AND WHERE"). The "scenario 6" that was meant to render real
 * geometry at known ranks and compare the GPU-sampled depth to this
 * function's prediction was never built. If a light gated on this value ever
 * misbehaves (self-occludes on its own floor, or fails to occlude something
 * genuinely above it), this formula — not the gate arithmetic that consumes
 * it — is the first thing to suspect.
 *
 * @param {number} rank
 * @param {number} maxRank
 * @returns {number} the stored depth value a real drawable at this rank
 *   would produce — comparable directly against a `querySceneDepth()`
 *   sample from the SAME pass.
 */
export function computeExpectedStoredDepth(rank, maxRank) {
  const z = rankToDepthZ(rank, maxRank);
  return (DEPTH_PASS_CAMERA_Z - DEPTH_PASS_NEAR - z) / (DEPTH_PASS_FAR - DEPTH_PASS_NEAR);
}

/**
 * {@link computeExpectedStoredDepth}, ADJUSTED for a caller whose own query
 * is expected to land EXACTLY ON a real item's rank most of the time — TWO
 * genuinely different shapes of caller hit this, not one:
 *
 *   - **A light with no geometry of its own** — `depth-authority.js#
 *     rankOfElevation`'s own header: "a torch standing on its own floor's
 *     ground is not occluded by that ground", i.e. the common case is a TIE,
 *     not a clean gap.
 *   - **An effect querying its OWN drawn item's rank** — e.g. specular's
 *     shine, gated on whether anything ranks ABOVE the Level background it
 *     is painted over: at every pixel where nothing occludes it, the STORED
 *     depth this query samples is that SAME background item's own rank,
 *     rasterized by the SAME depth pass — a tie by construction, every
 *     unoccluded pixel, not an edge case.
 *
 * Either way, a bare `computeExpectedStoredDepth` value compared with
 * `storedDepth.lessThan(expectedDepth)` has no room for the ordinary float
 * noise between a CPU (JS double) prediction and a GPU (float32) rasterized
 * value at that same tie — `bench-scene-depth.js`'s own query material
 * already needed an `epsilon` for exactly this ("scenario 5"'s `isEqual`
 * check) even comparing two GPU-sampled values against EACH OTHER, which is
 * the easier case. Left unguarded, a light could read its own floor's
 * ground as "above" it and go dark everywhere, every frame, the moment
 * rounding tips the wrong way — a global blackout, not a corner case; an
 * effect querying its own item could black itself out on EVERY unoccluded
 * pixel the same way.
 *
 * The fix is a fail-open buffer sized to HALF a single rank's own depth-space
 * gap, never a flat constant — see `[[feedback_margin_sized_to_gap_is_self_
 * defeating]]`, the lesson a flat guess would repeat. Because `rankToDepthZ`→
 * `computeExpectedStoredDepth` is an AFFINE map (one rank step always changes
 * stored depth by the same amount, `1 / ((maxRank+1) * (FAR-NEAR))`,
 * regardless of which rank), half of that step is PROVABLY smaller than the
 * gap between any two genuinely different real ranks — it can absorb float
 * noise at an exact tie but can never bridge two distinct items into a false
 * tie, at any scene size. `feedback_gate_polarity_must_fail_open`: the buffer
 * SUBTRACTS from the block threshold, making blocking harder, never easier,
 * at the boundary — a receiver at or below the query stays visible.
 *
 * @param {number} rank
 * @param {number} maxRank
 * @returns {number} a stored-depth value slightly SMALLER (a slightly higher
 *   apparent rank) than {@link computeExpectedStoredDepth} would return —
 *   use this, never the bare formula, as `uLightExpectedDepth`/`uExpectedDepth`/
 *   similar for any query comparing a GPU-SAMPLED `storedDepth` against a
 *   CPU-resolved rank that is expected to tie with a real item most of the
 *   time (with or without drawn geometry of its own).
 */
export function computeTieSafeExpectedDepth(rank, maxRank) {
  const perRankGap = 1 / ((Math.max(1, maxRank) + 1) * (DEPTH_PASS_FAR - DEPTH_PASS_NEAR));
  return computeExpectedStoredDepth(rank, maxRank) - perRankGap * 0.5;
}

/**
 * Presence-flag bits for `buf:scene.depth`'s colour payload, B channel
 * (design doc §4). Independent booleans, not a value field — there is no
 * receiver-elevation quantisation here the way `scene-attr.js`'s presence
 * byte needs one; RANK already carries exact elevation information, so
 * nothing about "how far above the ground" needs a second, lossy encoding.
 *
 * ⚠️ Two of §4's six named bits are NOT set by {@link computeSceneDepthFlags}
 * yet — stated here, not silently: `occlusionFaded` needs the SAME
 * `buildOcclusionUniforms`/occlusion-fade machinery `scene-attr.js`'s real
 * writers already use, which is a per-item, stateful concern this pure
 * function has no way to answer — left for the caller building the material,
 * exactly the same boundary `buildSceneDepthWriterMaterial` draws for its own
 * `alphaThreshold`/`tex` params. The other five ARE set below — corrected
 * 2026-08-04: an earlier version of this doc claimed `restrictsWeather` was
 * read through a `kind === 'tile'` ternary that was never actually written;
 * the real function below reads `restrictsLight`/`restrictsWeather`
 * COMPLETELY UNSCOPED, any kind.
 *
 * ⚠️ THAT MEANS `DEPTH_FLAG_RESTRICTS_LIGHT` IS NOT SAFE TO TREAT AS A HARD
 * OCCLUSION BLOCK ON ITS OWN. `scene-attr.js#computeFloorAttrValues`'s own
 * OLD overhead-bit computation scopes the identical Foundry flag to
 * `item.kind === 'tile'` ONLY, because a Level's own BACKGROUND gets
 * `restrictsLight: true` UNCONDITIONALLY (mirroring real Foundry's
 * `primary.mjs#restrictsLight = true` for `isBackground`) — treating the raw
 * flag as a block for ANY kind would black out every light on its own floor,
 * everywhere, via that floor's own ground. Any occlusion consumer reading
 * this bit MUST additionally check {@link DEPTH_FLAG_IS_TILE} before treating
 * it as a block — this function deliberately does NOT bake that guard in
 * itself (see this header's own opening line: "this file just reports the
 * raw flag, unopinionated").
 */
export const DEPTH_FLAG_RESTRICTS_LIGHT = 1;
export const DEPTH_FLAG_RESTRICTS_WEATHER = 2;
export const DEPTH_FLAG_IS_LEVEL_BACKGROUND = 4;
export const DEPTH_FLAG_IS_LEVEL_FOREGROUND = 8;
export const DEPTH_FLAG_IS_TILE = 16;

/**
 * Pure, per-item flag byte — never re-derives anything `foundry/scene-
 * layers.js` already read faithfully off Foundry's own documents
 * (`restrictsLight`/`restrictsWeather`, design doc §3's own citation:
 * "already read faithfully... and consumed nowhere"). `item.kind` decides
 * the background/foreground/tile bits; a token or anything else sets none
 * of them (it can still set `restrictsLight`/`restrictsWeather` if a future
 * item shape ever carries those fields for a non-Level/Tile kind — this
 * function does not gate those two bits on `kind` at all, unlike
 * `scene-attr.js`'s own `restrictsLight`-as-overhead reading, which IS
 * kind-scoped (`item.kind === 'tile'`) for a real, load-bearing reason: a
 * Level's own background gets `restrictsLight: true` UNCONDITIONALLY, and
 * folding the raw flag into an occlusion decision for ANY kind would black
 * out every light on its own floor. This file just reports the raw flag,
 * unopinionated — rank alone answers MOST of the occlusion question (a
 * Level's foreground/roof draws at a real, comparably-higher rank, no bit
 * needed), but NOT a Tile's own explicit "Restrict Lighting" flag, which is
 * Foundry's own elevation-BLIND mechanism (ROUND 9,
 * `point-light-illumination.js#buildHeightGateNode`'s own header) — a caller
 * gating light occlusion on this buffer still needs `RESTRICTS_LIGHT &&
 * IS_TILE`, unscoped-by-rank, alongside the rank comparison, not instead of
 * it. See {@link DEPTH_FLAG_RESTRICTS_LIGHT}'s own doc for the guard.
 *
 * @param {{kind?: string, restrictsLight?: boolean, restrictsWeather?: boolean}} [item]
 * @returns {number} 0-31 (bits 0-4; bit 5, `occlusionFaded`, is not this
 *   function's to set — see this module's own flag-bit header).
 */
export function computeSceneDepthFlags(item) {
  if (!item) return 0;
  let bits = 0;
  if (item.restrictsLight === true) bits |= DEPTH_FLAG_RESTRICTS_LIGHT;
  if (item.restrictsWeather === true) bits |= DEPTH_FLAG_RESTRICTS_WEATHER;
  if (item.kind === 'levelBackground') bits |= DEPTH_FLAG_IS_LEVEL_BACKGROUND;
  if (item.kind === 'levelForeground') bits |= DEPTH_FLAG_IS_LEVEL_FOREGROUND;
  if (item.kind === 'tile') bits |= DEPTH_FLAG_IS_TILE;
  return bits;
}

/**
 * Resolve an item's owning floor index (R channel, design doc §4) —
 * membership (`item.levelId`) first, elevation-band lookup as the fallback
 * for anything with no owner (a loose tile), the SAME two-step
 * `scene-attr.js#computeFloorAttrValues` already established and the same
 * order for the same reason (`feedback_membership_beats_derived_threshold`:
 * a Level's own foreground sits AT its band's `elevationTop`, which
 * `resolveElevationFloorIndex`'s half-open `[bottom,top)` band would
 * otherwise attribute to the floor above).
 *
 * ⚠️ DUPLICATED LOGIC, NAMED NOT HIDDEN: this is the same ~10-line shape
 * `scene-attr.js` already has, inlined there rather than exported. Left
 * duplicated here rather than refactoring that file's own 950-line, 867-
 * line-tested module as a side effect of building this one — a genuine
 * debt, not an oversight. Extracting both into one shared
 * `scene/layer-order.js` helper is the right eventual fix, ideally no later
 * than whichever of "a THIRD consumer needs this" or "`buf:scene.attr` is
 * deleted" (design doc stage 3) comes first.
 *
 * @param {object} args
 * @param {object} args.item - `item.key.elevation` and `item.levelId` are read.
 * @param {object|null} args.sceneDoc - `globalThis.canvas?.scene ?? null`,
 *   read by the CALLER — this module has no Foundry-global access of its own.
 * @param {number} args.viewedFloorIndex - fallback when the real lookup fails.
 * @param {(msg: string, err: unknown) => void} [args.logError] - defaults
 *   to a no-op.
 * @returns {number} 0-255.
 */
export function resolveSceneDepthFloorIndex({ item, sceneDoc, viewedFloorIndex, logError }) {
  try {
    const floorsResult = getActiveSceneFloors(sceneDoc);
    if (!floorsResult.ok || !floorsResult.floors.length) return viewedFloorIndex;
    const elevation = item?.key?.elevation ?? 0;
    const owned = item?.levelId ? floorsResult.floors.find((f) => f.id === item.levelId) : null;
    const resolved = owned ? { index: owned.index } : resolveElevationFloorIndex(floorsResult.floors, elevation);
    return resolved ? resolved.index : viewedFloorIndex;
  } catch (err) {
    logError?.('buf:scene.depth floor-index lookup (getActiveSceneFloors) failed — using the viewed floor:', err);
    return viewedFloorIndex;
  }
}

/**
 * THE DEPTH-WRITER MATERIAL — one per item, drawn into this pass's own
 * scene (design doc §7: "its own scene, its own meshes… not a material
 * swap on the production meshes",
 * [[feedback_diagnostic_must_not_render_production_materials_elsewhere]]).
 * Proven byte-for-byte in `bench-scene-depth.js#buildDepthWriterMaterial`
 * before this landed:
 * `depthTest:true, depthWrite:true, depthFunc:LessDepth` (see this module's
 * own header for why LessDepth, not GreaterDepth, for THIS camera), a
 * fragment that `.discard()`s below the item's own authored
 * `alphaThreshold` (never a hard-coded 0.5 —
 * `ATTR_SOLIDITY_ALPHA_TEST_THRESHOLD` has no equivalent role here; the
 * alpha TEST here is a real discard, not a blend-factor binarisation,
 * because nothing in this pass blends at all) and otherwise writes the
 * payload. Alpha sampled at `.level(float(0))` — round 10 of the
 * light-elevation investigation's fix, carried over: an implicitly-selected
 * mip on a real texture can read alpha≈0 over visibly opaque paint.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} [args.tex] - a real, already-loaded texture (the SAME one the
 *   item's own production material samples), or absent for "always solid"
 *   (a synthetic/test caller's common case — no real item is textureless).
 * @param {number} [args.alphaThreshold=0.75] - the item's own authored
 *   threshold (`collectLevelTextures`'s default, per `scene-layers.js`).
 * @param {number} args.floorIndex - 0-255, {@link resolveSceneDepthFloorIndex}'s result.
 * @param {number} args.flags - 0-31, {@link computeSceneDepthFlags}'s result.
 * @param {*} [args.positionNode] - a vertex-stage TSL node, applied to
 *   `material.positionNode` when present. EVERY existing caller (ordinary
 *   Level/tile/token proxies) omits this — their real mesh is static, so the
 *   default (no positionNode, i.e. the geometry's own rest-pose position) is
 *   correct. The ONE caller that must not omit it is vegetation's own
 *   proxy (`vt-pan-viewer.js#rebuildSceneDepthProxies`'s `vegetationOverlay`
 *   branch): that proxy shares its geometry with a mesh whose REAL on-screen
 *   position is wind-displaced every frame (`buildVegetationMaterial`'s own
 *   `positionNode`) — leaving this at rest silently rasterizes a silhouette
 *   that never moves while the canopy it is supposed to describe sways
 *   continuously, which is precisely the bug
 *   `buildVegetationSwayDisplacementNode`'s own header records
 *   (`docs/planning/Depth-Buffer.md` §9k).
 * @param {boolean} [args.alwaysOpaque=false] - true only when the caller has
 *   already PROVEN (via `wi.alphaStats.min`, the real decoded source alpha —
 *   never guessed) that every texel of `tex` sits at or above
 *   `alphaThreshold`, so the discard below could structurally never fire.
 *   See the comment beside its use for why this is a separate parameter and
 *   not just a runtime-false condition.
 * @returns {*} a `THREE.NodeMaterial`.
 */
export function buildSceneDepthWriterMaterial({
  THREE,
  tex,
  alphaThreshold = 0.75,
  floorIndex,
  flags,
  positionNode,
  alwaysOpaque = false,
}) {
  const { Fn, float, uniform, vec4, texture } = THREE.TSL;
  const material = new THREE.NodeMaterial();
  material.side = THREE.DoubleSide;
  material.transparent = false;
  material.depthTest = true;
  material.depthWrite = true;
  material.depthFunc = THREE.LessDepth;
  if (positionNode) material.positionNode = positionNode;
  // floorIndex/flags/alphaThreshold are UNIFORMS, never `float(literal)` —
  // `rebuildSceneDepthProxies` builds a brand-new material like this one for
  // EVERY tile on EVERY residency pass (by design — see this function's own
  // caller). A `float(x)` bakes x into the generated shader SOURCE, so two
  // materials that differ only in floorIndex compile to two DIFFERENT
  // pipelines; a scene with many distinct (floorIndex, flags, alphaThreshold)
  // combinations forced a fresh WebGPU pipeline compile on nearly every
  // residency pass, live-measured at a 3.4ms mean / 43ms max CPU cost for
  // what is otherwise a 5-draw-call pass (`docs/planning/Performance.md`,
  // 2026-08-06 profile, zone `geometry.depthDraw`). A `uniform()` keeps the
  // value out of the shader text entirely, so every material sharing this
  // function's same STRUCTURAL shape (textured or not, positionNode or not —
  // a handful of variants, not one per item) compiles ONCE and is reused.
  const uFloorIndex = uniform(float(floorIndex / 255));
  const uFlags = uniform(float(flags / 255));
  // EARLY-Z FAST PATH (PERF, 2026-08-09, §4.3 of the perf audit): a discard()
  // anywhere in a fragment shader forces the GPU to disable early-fragment-
  // tests for the WHOLE shader — hardware can't see that the condition below
  // is rare, only that the shader CONTAINS a discard at all, so even a
  // fragment this pass's own `depthTest:true` would reject before running
  // any shader still pays full shader cost. That defeats the exact
  // optimization this whole pass exists to make available to
  // `runGeometryWorldPass`'s later maskNode query. `!tex` is the SAME
  // "always solid" case this function's own doc already names (no real item
  // is textureless) — folded in here since it is, structurally, the same
  // proof: no texel can ever read below threshold. Skipping the discard
  // entirely — not just relying on it never firing at runtime — is what
  // actually restores early-Z; the GPU only re-enables it when the shader
  // has none at all. This is one more STRUCTURAL variant, same family as
  // textured/untextured and positionNode/not in the comment above: every
  // opaque item shares this leaner shape and compiles once, not once per
  // item.
  if (alwaysOpaque || !tex) {
    material.fragmentNode = Fn(() => vec4(uFloorIndex, float(0), uFlags, float(1)))();
    return material;
  }
  const uAlphaThreshold = uniform(float(alphaThreshold));
  material.fragmentNode = Fn(() => {
    const a = texture(tex).level(float(0)).a;
    a.lessThan(uAlphaThreshold).discard();
    // G (outdoors) is a KNOWN GAP, stated honestly, not faked: wiring it
    // needs the same envLight/uOutdoorsRect plumbing scene-attr.js's real
    // writers take, and no Stage 1 consumer reads it yet (design doc §6's
    // own `d.outdoors` is for a later effect migration). 0 — "indoors" — is
    // the SAME safe default `packFloorAttr` already uses for a floor with
    // no authored outdoors mask, never a fabricated "somewhere outside".
    return vec4(uFloorIndex, float(0), uFlags, float(1));
  })();
  return material;
}

/**
 * A proxy mesh for this pass — SHARES the item's own existing geometry
 * (design doc §7: "proxy meshes sharing each item's geometry, the same
 * twin-mesh idiom point lights already use") rather than rebuilding quad
 * geometry from scratch. `frustumCulled:false` because `mesh.position.z`
 * moves this mesh far from wherever its geometry's own bounding sphere was
 * computed relative to (the SAME reason every quad in `bench-scene-depth.js`
 * sets it).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.geometry - an EXISTING `THREE.BufferGeometry`, never a new one.
 * @param {*} args.material - {@link buildSceneDepthWriterMaterial}'s result.
 * @param {number} args.z - {@link rankToDepthZ}'s result for this item.
 * @returns {*} a `THREE.Mesh`.
 */
export function buildSceneDepthProxyMesh({ THREE, geometry, material, z }) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.z = z;
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * THE QUERY — one TSL sample, every effect uses it (design doc §6). Proven
 * as `bench-scene-depth.js` scenario 5's own material: sample the ALREADY-
 * WRITTEN depth texture at `screenUV` (a SEPARATE material from the one
 * that wrote it — never the bare/mesh-UV texture node,
 * [[feedback_shared_texture_node_carries_the_wrong_uv]]), compare against
 * `expectedDepth` — a plain float, either sampled the SAME way at a known
 * reference point, or {@link computeExpectedStoredDepth}'s CPU-resolved
 * result for a caller with no geometry of its own. No attempt to convert
 * the sampled value back into an integer rank on the GPU — see this
 * module's own header, "WHY THE QUERY NEVER RECOMPUTES A PROJECTION ON THE
 * GPU".
 *
 * @param {*} TSL
 * @param {object} args
 * @param {*} args.depthTexture - the `THREE.DepthTexture` this pass wrote.
 * @param {*} args.expectedDepth - a float node (uniform or sampled) to
 *   compare THIS fragment's own stored depth against.
 * @returns {{storedDepth: *, isAbove: *, isAtOrBelow: *}} `isAbove`: something
 *   with a HIGHER rank than `expectedDepth` is drawn here (a SMALLER stored
 *   depth, this pass's own `LessDepth` convention). `isAtOrBelow`: the
 *   complement — nothing above, including "exactly this rank" and "nothing
 *   drawn at all" (an unwritten texel clears to depth `1`, the far plane,
 *   which is `>=` any real `expectedDepth` in `(0,1)` — fail-open by the
 *   same construction {@link rankToDepthZ}'s own doc describes, not a
 *   separate `present` check bolted on).
 */
export function querySceneDepth(TSL, { depthTexture, expectedDepth }) {
  const { texture, screenUV } = TSL;
  const storedDepth = texture(depthTexture, screenUV);
  const isAbove = storedDepth.lessThan(expectedDepth);
  return { storedDepth, isAbove, isAtOrBelow: isAbove.not() };
}
