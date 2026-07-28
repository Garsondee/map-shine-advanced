/**
 * @fileoverview vt/vt-pan-viewer.js — Keyhole Stage 1 part 4b: the real
 * residency-driven streaming loop, keyboard pan/zoom/floor-switch.
 *
 * Builds directly on the smoke test's now-PROVEN atlas + indirection + vtSample
 * pipeline (Stage 1 part 4a, three live-tested fixes: Y-flip, coordinate-space
 * mismatch, clamp-bound conflation) — reuses the EXACT same UV-remap formula
 * rather than inventing a new one, specifically to avoid re-debugging
 * orientation/coordinate issues that are already solved. What's NEW here is
 * making residency dynamic: pan/zoom/floor-switch recompute the needed page
 * set every time the view changes, diff against what's currently resident,
 * decode+upload only what's newly needed, and unpin what fell out of view.
 *
 * MULTI-MIP (the single-mip cut is gone — this is Stage 1's coarse-fallback
 * increment). On floor load, every floor pins its COARSE set (the top few mip
 * levels, residency.coarseTopMipsForCap) as 'coarse' — permanently resident,
 * so the whole world always renders soft and floor switches are instant. Each
 * residency update chooses a mip analytically (residency.planResidency /
 * chooseMip — top-down camera, no GPU feedback), requests the fine set + a
 * coarser prefetch set at THEIR real mips, and the shader (vt-sample.glsl.js)
 * walks requested→coarsest and samples the finest-resident level. Zooming out
 * now serves coarser mips (bounded working set) instead of piling up mip-0
 * pages; a still-streaming texel resolves through the coarse pins as blur,
 * never black, never magenta.
 *
 * Uses the REAL Keyhole Q2 default atlas (512 MB, 2048-page capacity) — the
 * smoke test's small test atlas already proved the concept; this is the step
 * toward the actual Stage 1 gate (torture scene pans at 60fps, 20-cycle soak,
 * zero context loss on the 3070).
 *
 * MULTI-FLOOR COMPOSITING (author-reported live bug, 2026-07-15: a real
 * multi-level scene's upper floor showed solid BLACK where a hole in its art
 * should reveal the floor below). Verified against the real Foundry source
 * before building anything: floors are NOT swapped on floor-switch in real
 * Foundry — `client/documents/scene.mjs#_configureLevelTextures` draws the
 * viewed floor PLUS every other floor listed in ITS OWN `visibility.levels`
 * set, simultaneously, elevation-sorted, alpha-composited (see
 * `foundry/active-scene-source.js`'s `computeVisibleFloorIndices()`, which
 * replicates that exact rule). This module now renders one quad PER
 * currently-visible floor (not one quad total, rebound per switch): each
 * floor gets its own persistent `{geometry,material,mesh}` layer, created
 * once and toggled `visible` per residency update; materials are
 * alpha-blended (`transparent:true`) and depth-test disabled with explicit
 * `renderOrder = floorIndex` (== elevation-ascending, since
 * `getActiveSceneFloors` already sorts that way) standing in for real depth —
 * a flat 2D layered composite is exactly what a top-down multi-floor stack
 * is, so no actual Z-buffer is needed. The torture-fixture button's default
 * `visibleFloorIndices` (`(i) => [i]`) preserves the exact old single-floor
 * behavior — this is purely additive for callers that don't opt in.
 *
 * @module vt/vt-pan-viewer
 */

import { PageCache } from './page-cache.js';
import { PageTable, computeIndirectionAtlasLayout } from './page-table.js';
import { resolveRendererRequiredLimits, planImageTiles, WEBGPU_SPEC_MIN_TEXTURE_DIM } from './texture-limits.js';
// mipChainByteLength: exact GPU-resident sizes (level 0 + the full mip chain)
// for the honest VRAM accounting below (the BC-compression fix for the
// ~2.5GB WebGPU memory wall; the mip chain itself is the "MSA noisier than
// PIXI zoomed out" fix). The encoder core is block-compress.js (Node-tested).
// Intra-zone (vt/), no door.
import { mipChainByteLength } from './block-compress.js';
// The BC-compression client (worker + IndexedDB cache). Opaque whole images come
// back as BC1 blocks (8× smaller), alpha images as BC7 (4×, carries the alpha) —
// the WebGPU-memory-ceiling fix; any failure returns null and the loader keeps
// the raw texture. Intra-zone.
import { requestCompressedTexture, requestCoarseAlphaGrid } from './compressed-textures.js';
import {
  acquirePages,
  acquirePackedPages,
  getSourceDimensions,
  getDecodeStats,
  pageWorldRect,
  computePagePlacement,
} from './decode-pool.js';
import { createLogger } from '../core/log.js';
import { buildViewerDiagnostics } from './vt-pan-viewer-diagnostics.js';
import { loadMaskImageTexture } from './mask-image.js';

/** Log door for the onPageDecoded ingest seam's containment guard — the one
 * place this file reports a CONSUMER's failure rather than its own. */
const ingestLog = createLogger('vt-ingest');
/** Log door for new call sites in this file — the rest still calls
 * console.* directly (ratcheted debt, not this fix's job to migrate). */
const log = createLogger('vt-pan-viewer');
import {
  createInitialViewState,
  applyKey,
  applyPanByPixels,
  applyZoomAtPixel,
  viewToWorldRect,
  clampRectToBounds,
  clampHalfSpan,
  computeTargetPanVelocity,
  easeVelocityTowardTarget,
  integratePan,
  easedZoomFactor,
} from './view-state.js';
import { coarsePinSet, coarseTopMipsForCap, computeCoarsePinBudget } from './residency.js';
import { describeSceneAttrMrt, buildSceneAttrZeroMrt, buildRealFloorAttrMrtNode } from './scene-attr.js';
import { ThreeAllocator, PASSES, planFrame, runPassPlan } from '../graph/index.js';
import { PROBE_CORNERS, classifyPixel, diagnoseOrientation } from '../diag/orientation-probe.js';
import { decodeHalfFloatRgba, decodeByteRgba, diffProbeBuffers } from '../diag/pixel-probe.js';
import { createGpuProbe } from '../diag/gpu-probe.js';
import { createGpuZoneTimer } from '../diag/gpu-zone-timer.js';
import { sortByLayer } from '../scene/layer-order.js';
import {
  computeCameraFrustum,
  worldToNdc,
  ndcToWorld,
  clientToNdc,
  ndcToPixel,
  buildQuadPositions,
  QUAD_UVS,
  QUAD_INDICES,
  computeTileSubPlacement,
  rectsOverlap,
} from '../scene/world-quad.js';
import {
  computeQuadCorners,
  computeQuadBounds,
  computeItemPlacement,
  readSceneDarkness,
  readSceneAmbient,
  readGamePaused,
  watchGamePaused,
  watchWorldTimeOfDay,
  readGlobalLightConfig,
  readActiveDarknessRegions,
  readGridDistancePixels,
  readGridSizePixels,
  computeTokenOcclusionRadiusPx,
  getActiveSceneFloors,
  readSceneWallSegments,
} from '../foundry/index.js';
import { engageFoundryFallback, clearFoundryFallback } from '../diag/render-fallback.js';
import {
  OCCLUSION_MODES,
  computeOcclusionState,
  createHoverFadeState,
  mapElevation,
  buildElevationTable,
} from '../scene/occlusion.js';
import { buildEnvSnapshot, createDayClock } from '../world/index.js';
import {
  buildEnvironmentalLightMaterials,
  computeAmbientColors,
  computeGlobalLightFloor,
  maxRgb,
  mixRgb,
  computeShapeMeshBounds,
  writeRegionPolygonPoints,
  applyDarknessAdjustment,
  regionOverlapsElevationBand,
  DARKNESS_ADJUST_MODES,
  buildRegionRectangleMaterial,
  buildRegionEllipseMaterial,
  buildRegionPolygonMaterial,
  buildRegionConeMaterial,
  buildRegionRingMaterial,
  buildRegionLineMaterial,
  buildRegionEmanationRectangleMaterial,
  buildRegionEmanationPolygonMaterial,
  buildUiShadowVisibility,
  mapWindowRectToStamp,
  MAX_UI_SHADOW_STAMPS,
  DEFAULT_WORKSPACE_LIGHT,
  buildCandleFlameMaterial,
  buildCandleFlameGeometry,
  candleAnimationQualityTier,
  createDoorGraphicsSubsystem,
  KNOWN_DEFERRED_ANIMATIONS,
  createParticleEngine,
  WIND_DIAGNOSTIC_PARTICLES,
  createGustEngine,
  WIND_GUSTS,
  VEGETATION_KINDS,
  detectSelfVegetationKind,
  vegetationMeshSegments,
  buildTessellatedQuadGeometry,
  createVegetationShadowSubsystem,
  padPlacement,
  vegetationShadowPadPx,
  VEG_SHADOW_RENDER_ORDER_MAGNITUDE,
  VEG_SHADOW_SMEAR_TAPS,
  createShadowHandle,
  createSunShadowSubsystem,
  // (maxThrowForHeightPx / shadowPenumbraPx / BASE_SOFTNESS_PX / edgeRamp01
  // left with the vegetation-shadow code in extraction step 2 — this file has
  // no remaining caller for any of them.)
  createPointLightPool,
  createWaterBodySubsystem,
  createWaterSurfaceSubsystem,
  createFluidSurfaceSubsystem,
  createSpecularSurfaceSubsystem,
  createWindowSurfaceSubsystem,
  // `surface.response`'s outdoor/indoor split reads the SAME world-space
  // outdoors gate `buf:scene.attr`'s G channel does — injected rather than
  // re-derived, so "world XY → mask UV → sample" still exists exactly once.
  buildWorldSpaceOutdoorsGate,
  createSkyHandle,
  buildGradePresentMaterial,
  buildBloomMaterials,
  hexToRgb01,
  resolveEnvGrade,
  scaleGradeToIdentity,
  identityCubeLut,
} from '../effects/index.js';
import { makeFrameClock, DEFAULT_PAUSE_RAMP_SEC } from '../core/frame-clock.js';
import {
  computeWindOverlayGridFromBake,
  buildWindOverlayGeometry,
  buildWindArrowMaterial,
  buildWindHeatmapMaterial,
} from '../diag/wind-field-overlay.js';
import { decomposeWindAt } from '../diag/wind-probe.js';
import {
  computeWindBakeGridSpec,
  rasterizeWallsToGrid,
  ambientVectorFromWind,
  buildWindSimMaterials,
  doorwayImpulseFromWallSegment,
  gatherActiveImpulseSlots,
  computeThawWindowMs,
  floodFillOpenFromBoundary,
  summarizeEnclosure,
  downsampleMax,
  cropGridMargin,
  distanceFromDoorThreshold,
  opennessFalloffFromDistance,
  downsampleDistanceMin,
  DOOR_FALLOFF_REACH_CELLS,
  distanceFromNearestSolid,
  wallAvoidanceDirectionFromDistance,
  wallProximityFromDistance,
  WALL_DEFLECT_REACH_CELLS,
  WIND_SIM_DEFAULT_DECAY_PER_SECOND,
  WIND_SIM_DEFAULT_RELAX_ITERATIONS,
  WIND_SIM_RELAX_BLEND,
  WIND_SIM_MAX_ACTIVE_IMPULSES,
  createWindHandle,
  // Shared with wind turbulence's own octaves — divergence-free, therefore
  // area-preserving, which is what makes vegetation's leaf flutter a genuine
  // "mass preserving" distortion rather than a stretch. See its own header.
  curlNoise2D,
} from '../world/index.js';

/**
 * Which TSL material builder handles each region-shape "kind" (the SAME
 * kind string `updateRegionDarknessMeshes` computes per shape) — a plain
 * lookup rather than a long ternary/switch chain, given there are now 9
 * cases (2026-07-19, the cone/ring/line/emanation shape-support build).
 * `emanation-ellipse` deliberately maps to the SAME builder as `ellipse` —
 * see `updateRegionDarknessMeshes`'s own `kind==='emanation-ellipse'`
 * comment for why that reuse is exact (or a documented approximation) for a
 * circle/ellipse-based emanation, not a new material at all.
 */
const REGION_MATERIAL_BUILDERS = {
  rectangle: buildRegionRectangleMaterial,
  ellipse: buildRegionEllipseMaterial,
  polygon: buildRegionPolygonMaterial,
  cone: buildRegionConeMaterial,
  ring: buildRegionRingMaterial,
  line: buildRegionLineMaterial,
  'emanation-ellipse': buildRegionEllipseMaterial,
  'emanation-rectangle': buildRegionEmanationRectangleMaterial,
  'emanation-polygon': buildRegionEmanationPolygonMaterial,
};

/** Whole-image mode: the largest tile dimension we will EVER upload as one
 * texture, INDEPENDENT of the hardware's `maxTextureDimension2D`. A 12000² floor
 * is a single 549MB texture at the 16384 cap, and allocating that in one shot on
 * top of ~1.65GB already resident stalled the driver ~2.2s → Windows TDR →
 * device lost on a floor switch (2026-07-18 flight recorder: died with
 * `estTextureVramMB:2190` while floor 1's first image was still `loading`).
 * Capping tile size forces such an image into a grid of smaller tiles (12000² →
 * 2×2 of 6000² ≈ 137MB each), each uploaded + GPU-drained on its own — no single
 * giant allocation for the driver to choke on. `Math.min(textureLimit, this)`
 * also subsumes the weak-hardware quarter-split (a lower HW limit still wins).
 * Reuses planImageTiles + computeTileSubPlacement, both already tested for the
 * multi-tile case. */
const MAX_WHOLE_TILE_DIM = 8192;

/** Resolution cap for the RAW fallback ONLY — the path taken when the compressed
 * worker is unavailable (CSP-blocked / crashed) and we can't get BC1/BC7 blocks.
 * The compressed path is the real memory fix; but if it's gone, uploading a full
 * 12000² layer raw is 549 MB, and both floors raw is ~2.75 GB — a guaranteed
 * device loss every time the worker can't run. Capping the fallback's uploaded
 * resolution (longest side ≤ this) keeps even an all-raw scene well under the
 * WebGPU ceiling: softer art, but the device lives. The device-lost slide to
 * Foundry is the LAST resort; this keeps us from needing it on every floor switch
 * in a worker-less environment (safety slide: degrade, never detonate). */
const MAX_RAW_FALLBACK_DIM = 4096;

/**
 * WHOLE-IMAGE RENDER MODE (2026-07-17 — the "load images like PIXI" path the
 * author chose after the tile-streaming/virtual-texture architecture kept
 * losing the WebGPU device to upload churn). Each item's art is loaded WHOLE
 * (one texture when it fits the raised 16384 cap — the mansion's 12000² case;
 * or the smallest tile grid that fits, `planImageTiles`, on weaker hardware)
 * and drawn as plain quad(s) — no atlas, no page cache, no residency
 * streaming, no upload churn, matching Foundry's own PIXI GPU footprint.
 *
 * THE ONLY ENGINE (2026-07-22 — feedback_mode_forks_silently_drop_features):
 * the old page-streaming/virtual-texture path (atlas.js, vt-sample.tsl.js,
 * ensureItemMesh/streamPackResidency/bindMeshToPack) has been REMOVED
 * entirely, not merely defaulted off. It was the architecture that kept
 * losing the device — more machinery, not a better engine — and it had
 * silently dropped two cross-cutting features (occlusion, masks) that were
 * built only for it while this whole-image path shipped as the default.
 * There is now exactly one loading/rendering path for every item; a future
 * feature CANNOT be added to "the other mode" because there isn't one.
 *
 * The device-lost safety slide still sits underneath this, and
 * `getDiagnostics().wholeImage` reports exactly what each item did (tiles,
 * decode status/errors, VRAM) so a breakage is visible in a flight recorder,
 * not a mystery.
 */

/**
 * THE DARKNESS-REALISM LEVER (2026-07-19, author-requested). 0 = Foundry
 * parity (DEFAULT): at scene darkness 1 the unlit floor stays at Foundry's own
 * `ambientDarkness` colour (~19% for the mansion), never pitch black, so it
 * stays readable — matching how Foundry itself renders (`environment.mjs#
 * configureColors`, verified). 1 = "realistic": the darkness endpoint is true
 * black, so darkness 1 crushes the unlit map to nothing. Any value between
 * interpolates. Only affects the DARKNESS end of the ambient mix — noon is
 * identical at every value; only `background`/`dim` darken, `bright` (light
 * cores) never does. See effects/lighting/environmental-light.js#compute
 * AmbientBackground for the math, and MapShine.setDarknessRealism (boot.js).
 * Default 0 keeps every existing scene's look unchanged.
 */
let _darknessRealism01 = 0;
/** @param {number} v - 0 (Foundry parity) .. 1 (true dark). Non-finite → 0. */
export function setDarknessRealism(v) {
  _darknessRealism01 = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
}
/** @returns {number} the current darkness-realism lever value (0..1). */
export function getDarknessRealism() {
  return _darknessRealism01;
}

/**
 * UI-SHADOW state (2026-07-20) — open Foundry windows cast a soft offset shadow
 * on the map. A screen-space visibility producer folded into light.accumulate,
 * sibling to region-darkness: it MULTIPLY-darkens buf:scene.illum where a window
 * floats, AFTER the point lights (v2, author feedback) — so a light inside a
 * window's shadow keeps its own soft attenuation (just dimmer), instead of the
 * hard MAX crease a before-lights multiply produced. DEFAULT ON (feedback_default_on_new_
 * features); a no-op whenever no windows are open (every stamp strength 0 → the
 * multiply is × 1). Tuned via MapShine.setUiShadow(...); toggled in the debug
 * panel. `light` is DEFAULT_WORKSPACE_LIGHT — a fixed decorative key, NOT
 * env.sun (UI chrome shadows should not swing with in-world time of day; see
 * effects/lighting/light-visibility.js). `flipY` is the one Y-flip knob
 * (feedback_y_flip_recurring_risk) — DEFAULT FALSE, corrected 2026-07-20 v3
 * (author-reported live: dragging a window UP moved its shadow DOWN, the
 * exact inverted-drag signature of a bad flip). `screenUV.y=0` is ALREADY at
 * the top on this backend — vt-pan-viewer.js's own occlusion-mask comment
 * proves it ("matches the v=0-is-top convention already proven by the
 * orientation self-test"), the SAME top-down convention
 * mapWindowRectToStamp's DOM rects use — so flipping was actively wrong, not
 * merely untested. Kept as a knob (not deleted) only in case a future
 * WebGPU/WebGL2 backend split ever disagrees with itself again — flip it if a
 * window's shadow ever again moves opposite its drag. `lastWindowCount`/
 * `lastStampCount` are written by the frame loop so the debug report can
 * prove the reader is finding windows rather than silently doing nothing
 * (feedback_instruments_must_not_lie).
 */
const _uiShadowState = {
  enabled: true,
  azimuthDeg: DEFAULT_WORKSPACE_LIGHT.azimuthDeg,
  elevationDeg: DEFAULT_WORKSPACE_LIGHT.elevationDeg,
  heightPx: DEFAULT_WORKSPACE_LIGHT.heightPx,
  strength01: DEFAULT_WORKSPACE_LIGHT.strength01,
  baseSoftnessPx: 10,
  maxOffsetPx: 400,
  // Cosmetic offset-length multiplier (author-requested 2026-07-20 v4: "make
  // the shadow offset x5"). Deliberately independent of heightPx, which alone
  // still drives the penumbra — see DEFAULT_WORKSPACE_LIGHT's own comment.
  offsetScale: DEFAULT_WORKSPACE_LIGHT.offsetScale,
  // How many frames between DOM window-rect re-scans (2026-07-20 v5, author-
  // measured perf fix: 120fps → 78fps at scanEveryNFrames:1). See
  // updateUiShadowStamps' own header for why the DOM read — not the shader —
  // is the cost. 6 ≈ a scan every ~50ms at 120fps; window drag still reads as
  // smooth. Raise it for more headroom, or set to 1 to restore per-frame
  // precision (e.g. while diagnosing a positioning bug).
  scanEveryNFrames: 6,
  flipY: false,
  lastWindowCount: 0,
  lastStampCount: 0,
};

/**
 * Tune / toggle the UI-cast window shadows. Merges the given fields; unknown or
 * non-finite numbers are ignored (never NaN into a uniform). Returns the merged
 * state so a console caller can read back what took.
 * @param {Partial<{enabled:boolean, azimuthDeg:number, elevationDeg:number, heightPx:number, strength01:number, baseSoftnessPx:number, maxOffsetPx:number, offsetScale:number, scanEveryNFrames:number, flipY:boolean}>} [partial]
 * @returns {object} a copy of the live state.
 */
export function setUiShadow(partial = {}) {
  const p = partial ?? {};
  if (typeof p.enabled === 'boolean') _uiShadowState.enabled = p.enabled;
  if (typeof p.flipY === 'boolean') _uiShadowState.flipY = p.flipY;
  const num = (k, lo, hi) => {
    if (Number.isFinite(p[k])) _uiShadowState[k] = Math.min(hi, Math.max(lo, p[k]));
  };
  num('azimuthDeg', -3600, 3600);
  num('elevationDeg', 0.5, 90);
  num('heightPx', 0, 4000);
  num('strength01', 0, 1);
  num('offsetScale', 0.1, 20);
  num('baseSoftnessPx', 0, 400);
  num('maxOffsetPx', 0, 4000);
  num('scanEveryNFrames', 1, 60);
  return { ..._uiShadowState };
}

/** @returns {object} a copy of the live UI-shadow state (incl. last detected counts). */
export function getUiShadow() {
  return { ..._uiShadowState };
}

/**
 * Where to mount the VT canvas so it BECOMES the scene display (author request,
 * 2026-07-15: "make this the only display... fill the scene viewing space so we
 * don't have PIXI and threejs alongside each other"). We mount into Foundry's
 * own `canvas#board` container and sit at a z-index ABOVE the board
 * (`--z-index-canvas: 0`, verified in foundry2.css) but BELOW Foundry's UI
 * (`--z-index-ui: 60`) — so the VT view opaquely OCCLUDES the PIXI canvas while
 * every Foundry UI panel (and the debug panel at z-index 90) stays clickable on
 * top. This is the VISUAL half of Stage 2's severance; the VRAM half (stopping
 * Foundry from decoding full-res duplicates into PIXI at all) is the separate
 * proxy-texture-interception step. Falls back to a full-window overlay on
 * document.body if the board isn't in the DOM yet (e.g. no scene active).
 *
 * @returns {{host: HTMLElement, fill: boolean}}
 */
function resolveMountHost() {
  const board = document.getElementById('board');
  if (board?.parentElement) return { host: board.parentElement, fill: true };
  return { host: document.body, fill: true };
}

/** The scene-area size to render at, from the mount host's live client box. */
function measureHost(host) {
  const w = Math.max(1, host.clientWidth || window.innerWidth);
  const h = Math.max(1, host.clientHeight || window.innerHeight);
  return { width: w, height: h };
}

let _active = null;

/**
 * THE BISECT (2026-07-16). Three guesses into a black screen, stop guessing.
 *
 * My sampler CANNOT return alpha 0: every path yields alpha 1 — a real texel, the
 * magenta tripwire, or the out-of-world guard's opaque black. Yet the readback says
 * alpha 0 at centre. So exactly one of these is true, and they need opposite fixes:
 *
 *   A. the fragment shader NEVER RUNS (geometry / camera / material never draws)
 *      and we are reading the render target's transparent clear, or
 *   B. it runs and something AFTER the sampler zeroes the alpha.
 *
 * A hardcoded constant separates them in one click: if solid red appears, the
 * geometry+camera+material pipeline is fine and the bug is inside my node graph
 * (case B). If it stays black, nothing is drawing and the graph is innocent
 * (case A) — and I have been debugging the wrong file entirely.
 */

function disposeActive() {
  if (!_active) return;
  // { capture: true } MUST match the addEventListener call exactly — the two
  // are treated as distinct registrations otherwise, and removal silently no-ops.
  try {
    window.removeEventListener('keydown', _active.onKeyDown, { capture: true });
  } catch (_) {}
  try {
    if (_active.onKeyUp) window.removeEventListener('keyup', _active.onKeyUp, { capture: true });
  } catch (_) {}
  try {
    if (_active.clearHeldKeys) {
      window.removeEventListener('blur', _active.clearHeldKeys);
      document.removeEventListener('visibilitychange', _active.clearHeldKeys);
    }
  } catch (_) {}
  try {
    if (_active.onResize) window.removeEventListener('resize', _active.onResize);
  } catch (_) {}
  try {
    _active.renderer.setAnimationLoop(null);
  } catch (_) {}
  // The live marker overlay is its OWN requestAnimationFrame loop, independent
  // of the renderer's — it must be cancelled here too, or a Stop/Restart (or a
  // real scene switch) leaks a rAF loop pointing at a torn-down `mount.host`.
  try {
    _active.stopLiveMarkers?.();
  } catch (err) {
    log.error('live marker overlay stop failed — a stray rAF loop may leak:', err);
  }
  for (const state of _active.itemStates.values()) {
    try {
      state.material?.dispose();
    } catch (_) {}
    try {
      state.geometry?.dispose();
    } catch (_) {}
    // Whole-image mode's per-tile GPU resources (geometry/material/texture).
    // renderer.dispose() below frees the backend, but dispose these too so a
    // Stop/Restart doesn't leak the JS-side handles (parallels state.geometry).
    for (const t of state.wholeImage?.tiles ?? []) {
      try {
        t.geometry?.dispose();
        t.material?.dispose();
        t.tex?.dispose();
      } catch (_) {
        // A handle already freed (or a texture that never finished uploading)
        // can throw on dispose; renderer.dispose() below frees the backend
        // regardless, so this is best-effort cleanup of the JS-side wrappers.
      }
    }
    for (const pack of state.packs.values()) {
      try {
        pack.indirectionTexture.dispose();
      } catch (_) {}
    }
  }
  try {
    _active.disposeOcclusionMask?.();
  } catch (err) {
    log.error('occlusion mask dispose failed — VRAM may be leaked:', err);
  }
  // buf:scene.color — a screen-sized RGBA16F target. Leaking one per
  // Stop/Restart cycle is exactly the VRAM bleed this project exists to end,
  // and the debug panel's Stop/Start buttons make that cycle one click.
  // `allocator.dispose()` reports rather than swallows (see its own note).
  try {
    _active.disposeSceneColor?.();
  } catch (err) {
    console.error('[vt-pan-viewer] scene.color dispose failed — VRAM may be leaked:', err);
  }
  // light.accumulate's scene.illum + scene.lit — same per-cycle VRAM-leak
  // reasoning as scene.color above. Uses the scoped logger (log/one-door), so
  // a leak here lands in the flight-recorder bundle, like the occlusion one.
  try {
    _active.disposeLighting?.();
  } catch (err) {
    log.error('lighting dispose failed — VRAM may be leaked:', err);
  }
  // scene.sunShadow (a 1024² RGBA8 world-space target) + the bake material +
  // the caster height DataTexture — found UNDISPOSED anywhere in this chain
  // while extracting the subsystem (2026-07-25, VT-Pan-Viewer-Extraction.md
  // step 1): every Stop/Restart cycle was leaking one target + one
  // NodeMaterial. Same per-cycle VRAM-leak reasoning as the rest of this list.
  try {
    _active.disposeSunShadows?.();
  } catch (err) {
    log.error('sun shadow dispose failed — VRAM may be leaked:', err);
  }
  // water.body + its two jump-flood ping-pong targets (three RGBA16F
  // world-space targets) + three bake materials + the mask DataTexture.
  try {
    _active.disposeWaterBody?.();
  } catch (err) {
    log.error('water body dispose failed — VRAM may be leaked:', err);
  }
  // SHINE's two meshes + shared geometry + two NodeMaterials + the uploaded
  // `_Specular` DataTexture (~13 MB RGBA on a 10k map — the largest single
  // allocation the effect makes). Same per-cycle VRAM-leak reasoning as the
  // rest of this list.
  try {
    _active.disposeSpecular?.();
  } catch (err) {
    log.error('specular dispose failed — VRAM may be leaked:', err);
  }
  // WINDOW LIGHT's mesh + geometry + two NodeMaterials + the uploaded
  // `_Window` DataTexture. Same per-cycle VRAM-leak reasoning as the rest of
  // this list.
  try {
    _active.disposeWindowLight?.();
  } catch (err) {
    log.error('window light dispose failed — VRAM may be leaked:', err);
  }
  // The candle flame billboard's own mesh/geometry/material (its lights are in
  // the shared pool, freed by disposePointLights below).
  try {
    _active.disposeCandleFlame?.();
  } catch (err) {
    log.error('candle flame dispose failed — VRAM may be leaked:', err);
  }
  // The door leaves' own meshes/geometries/materials + cached textures — same
  // per-cycle VRAM-leak reasoning as the candle flame just above.
  try {
    _active.disposeDoorGraphics?.();
  } catch (err) {
    log.error('door graphics dispose failed — VRAM may be leaked:', err);
  }
  // The wind field debug overlay's own mesh/geometry/material — same per-
  // cycle VRAM-leak reasoning as the candle flame just above.
  try {
    _active.disposeWindFieldOverlay?.();
  } catch (err) {
    log.error('wind overlay dispose failed — VRAM may be leaked:', err);
  }
  // Wind.md Tier 2's ping/pong/publish render targets + solid mask texture +
  // sim materials — same per-cycle VRAM-leak reasoning.
  try {
    _active.disposeWindSim?.();
  } catch (err) {
    log.error('wind sim dispose failed — VRAM may be leaked:', err);
  }
  // Every point-light mesh/material/geometry — same per-cycle VRAM-leak
  // reasoning, a separate call mirroring disposeOcclusionMask's own split
  // (one dispose function per resource-owning subsystem, not a grab-bag).
  try {
    _active.disposePointLights?.();
  } catch (err) {
    log.error('point-light dispose failed — VRAM may be leaked:', err);
  }
  // Every region-darkness mesh's own material + the shared quad geometry.
  try {
    _active.disposeRegionDarknessMeshes?.();
  } catch (err) {
    log.error('region-darkness dispose failed — VRAM may be leaked:', err);
  }
  // THE TIME HOOKS (`pauseGame`, `updateWorldTime`). Not VRAM, but the same
  // class of leak: every scene switch builds a new viewer, and an un-removed
  // hook keeps a dead closure alive and fires it forever. `installPauseWatch`
  // is idempotent per viewer, so without this each switch would stack another
  // listener writing a scale target into a frame clock nobody is ticking.
  try {
    _active.disposeTimeWatches?.();
  } catch (err) {
    log.error('time-hook teardown failed — a stale pause/world-time listener may persist:', err);
  }
  // THE RENDERER ITSELF (found in audit, 2026-07-17: teardown freed every
  // texture/material/geometry it OWNED but never the renderer's own backend —
  // Renderer.dispose() (three.webgpu.js) is what actually frees the GPU
  // device/context, every compiled pipeline, bind groups and query pools.
  // Every scene switch builds a brand-new WebGPURenderer (startVtPanViewer)
  // without this, so every switch — and every debug-panel Stop/Start, every
  // zoom-thrash restart, every safety-slide restart after a fatal error —
  // abandoned a live GPU context. Browsers cap how many of those can exist at
  // once and force-lose the OLDEST to make room, which can corrupt whatever
  // context is left live — a far better explanation for "tokens land in the
  // wrong place after a scene switch" than anything in the placement math
  // (which reads straight from the live document, unaffected by this). LAST,
  // after every resource the backend owns has already been told to let go.
  try {
    _active.renderer.dispose();
  } catch (err) {
    log.error('renderer dispose failed — GPU context may be leaked:', err);
  }
  try {
    _active.canvas.remove();
  } catch (_) {}
  _active = null;
}

export function stopVtPanViewer() {
  disposeActive();
  return { stopped: true, at: new Date().toISOString() };
}

/**
 * Start the renderer.
 *
 * @param {object} options
 * @param {any} options.THREE
 * @param {(viewedFloorIndex:number) => Array<object>} options.buildItems - THE DRAW
 *   LIST for a given viewed floor: every drawable, as a `SceneLayerItem`
 *   (`foundry/scene-layers.js`) carrying a `key` for the sort law, an `id`, a
 *   `src`, and a `_placement`. Called fresh on every residency update, so the
 *   list follows the scene rather than being captured once.
 *
 *   Two callers, ONE path (doctrine #1): real scenes pass a closure over
 *   `collectSceneLayers(canvas.scene, …)` — Level backgrounds AND foregrounds
 *   (roof art) AND tiles; the torture fixture FABRICATES the same shapes, since
 *   it has no Foundry documents. Neither gets its own renderer.
 * @param {{width:number, height:number, sceneRect:object}} options.dimensions - the
 *   scene's canvas-space dimensions (`foundry/scene-geometry.js#computeSceneDimensions`).
 *   THE WORLD, in the coordinate sense: Foundry's padded canvas rect, +Y down.
 *   Art no longer defines the world — art is PLACED into it — which is why the
 *   view can be framed before any decode finishes.
 * @param {number} options.floorCount - how many floors the floor-switch keys cycle.
 * @param {number} [options.initialFloorIndex] - which floor the view opens on
 *   (default 0). MUST match whatever Foundry itself is currently viewing when
 *   called from an automatic re-sync (boot.js's `canvasReady` handler) — this
 *   was the root cause of a real live bug (2026-07-15): every call used to
 *   hardcode floor 0 regardless of caller intent, so switching floors via
 *   Foundry's own UI (which re-fires `canvasReady` and re-invoked this function
 *   wholesale) silently snapped the view back to floor 0 every time, AND
 *   repeatedly reallocating the full 512MB atlas + page cache on every ordinary
 *   floor switch caused a real crash after a few toggles. boot.js's
 *   `canvasReady` handler now only calls this for an ACTUAL scene change; a
 *   same-scene floor switch uses the far cheaper `setVtPanViewerFloor()`.
 * @param {(item:object) => Array<{name:string, url:string}|{name:string, channelUrls:{r:string,g:string,b:string}}>} [options.extraLayersForItem] -
 *   MULTI-LAYER (Keyhole §4.1, the mask pile-up killer): the ADDITIONAL layer-packs
 *   beyond albedo that an item streams — every painted mask (_Outdoors, _Fire,
 *   _Specular, _Tree, _Bush …). Each entry is either `{name, url}` (a single-file
 *   mask — the normal case) or `{name, channelUrls:{r,g,b}}` (CHANNEL-PACKING: 3
 *   single-channel mask files composited into ONE RGBA virtual texture at decode
 *   time, per decode-pool.js's `acquirePackedPages`).
 *
 *   Either shape becomes its OWN virtual texture (own PageTable → own namespaced
 *   page keys → own indirection texture), streamed through the SAME fixed atlas +
 *   page cache as albedo. That is what makes V2's actual cause of death —
 *   `O(world × floors × masks)` textures all held at world resolution at once —
 *   architecturally impossible: masks page through the keyhole exactly like
 *   albedo, so the working set stays `O(screen)` however many layers exist.
 *
 *   Only albedo is DISPLAYED (masks are inputs, not pixels, until an effect
 *   consumes them — `setDisplayLayer` can bind one for visual verification
 *   against the fixture's known patterns). Default `() => []`: real scenes store
 *   masks as scene flags rather than URLs, so their mask streaming is a later
 *   step; the fixture emits real mask PNGs on disk, so it is proven there first.
 * @param {(p:{done:number, total:number, detail:string|null}) => void} [options.onLoadProgress] -
 *   called once per item during the INITIAL load only (never per frame), so a
 *   loading screen can show honest counts. The item TOTAL is known immediately
 *   from buildItems; page totals are not known until each item's header is read,
 *   which is why progress is reported per item rather than per page.
 * @param {() => {occluders:Array<object>, visionActive:boolean}} [options.getOcclusionInputs] -
 *   the occluder set for the occlusion mask. Currently unused: the mask PRODUCER
 *   isn't built (see `diag/render-fallback.js`'s sibling note and
 *   `scene/occlusion.js`) — the shader path is real, but its mask is an inert
 *   placeholder, so every item renders unoccluded.
 * @param {(info:{ownerId:string, layerName:string, table:object, page:{mip:number,px:number,py:number},
 *   contentWindow:{dx:number,dy:number,dw:number,dh:number}, bitmap:ImageBitmap}) => void} [options.onPageDecoded] -
 *   THE INGEST SEAM (scene/mask-authority.js's input): called SYNCHRONOUSLY for
 *   each decoded COARSEST-mip page (`page.mip === table.maxMip` — one page, the
 *   whole item) right after decode, before upload. The bitmap is closed after
 *   the upload loop — do not retain it; read pixels during the call. boot.js
 *   wires this to the mask authority so derived masks (skyReach/coverAbove)
 *   distill from the pager's own traffic: no second fetch, no second decode, no
 *   GPU readback, no cache pressure. Injected exactly like extraLayersForItem —
 *   the viewer stays authority-ignorant. A throwing callback is contained and
 *   loudly logged; it can never break streaming.
 * @param {(info:{ownerId:string, grid:{w:number,h:number,data:Uint8Array},
 *   imageWidth:number, imageHeight:number}) => void} [options.onItemAlpha] -
 *   THE ART-OPACITY SEAM (2026-07-24, `scene/mask-authority.js#ingestItemAlpha`).
 *   Called once per non-token item with its coarse alpha grid, for EVERY floor —
 *   cover physics must not depend on which floor is being viewed, so this
 *   deliberately does not wait for a floor to become visible. It exists because
 *   `onPageDecoded` above can no longer deliver art opacity: that seam is fed by
 *   PACKS, and whole-image mode has no albedo pack, so `coverAbove` (and with it
 *   `skyReach`) had been uniformly zero on every scene since the streaming
 *   engine was retired. See `vt/coarse-alpha.js`'s header.
 * @param {(info:object) => void} [options.onDeviceLost] - THE SAFETY SLIDE'S
 *   seam-restore hook. Called when the GPU device is lost UNEXPECTEDLY (never on
 *   our own teardown — that is filtered by reason:"destroyed"). The viewer has
 *   already removed its dead canvas and announced the fallback by the time this
 *   runs; boot.js wires this to restoreFoundryArt() so Foundry's suppressed art
 *   comes back on. Injected so vt/ never reaches into the interface seam itself.
 * @returns {Promise<object>} initial diagnostics (see getDiagnostics() for the shape).
 */
export async function startVtPanViewer({
  THREE,
  followFoundryCamera = false,
  // PER-ZONE TIMING (docs/planning/Performance.md). Owned by boot.js and handed
  // in, exactly like `gpuProbe` is constructed here: the clock lives in `diag/`
  // because `time/one-clock` allows it there and nowhere near this file. Null on
  // the torture fixture, which deliberately does not profile — so every call
  // below is optional-chained rather than assuming a profiler exists.
  profiler = null,
  buildItems,
  dimensions,
  floorCount,
  initialFloorIndex = 0,
  extraLayersForItem,
  getOcclusionInputs,
  onLoadProgress,
  onPageDecoded,
  onItemAlpha,
  getCoverItems,
  onDeviceLost,
  getCandleRenderState,
  getDoorRenderState,
  getVegetationRenderState,
  getBloomRenderState,
  getGradeLookState,
  sampleWindExposureAt,
  getMaskAuthorityVersion,
  probeMaskAuthorityLiveAt,
  getOutdoorsMaskGrid,
  getCasterHeightField,
  getSunShadowRenderState,
  getWaterMaskGrid,
  getFloorsWithWater,
  getWaterMaskUrl,
  getWaterRenderState,
  getSpecularMaskUrl,
  getSpecularMaskRect,
  getSpecularRenderState,
  getWindowMaskUrl,
  getWindowMaskRect,
  getWindowRenderState,
  getFluidMaskItems,
  getFluidRenderState,
  onFluidCornersResolver,
}) {
  extraLayersForItem ??= () => [];
  getOcclusionInputs ??= () => ({ occluders: [], visionActive: false });
  onPageDecoded ??= () => {};
  onItemAlpha ??= () => {};
  // EVERY floor's cover art, unfiltered by visibility — see
  // `primeCoverAlphaGrids`. A getter, not an array: the scene's item set
  // changes as documents are created/deleted, and a captured array would
  // freeze cover physics at load (the trap the extraction plan names first).
  // Defaulting to empty means an un-wired caller (the torture fixture) simply
  // primes nothing rather than throwing.
  getCoverItems ??= () => [];
  // WIND OVERLAY EXPOSURE (Wind.md) — same "absence = fully outdoors"
  // default the candle geometry itself falls back to when un-sampled
  // (computeCandleFlameArrays' own convention), so an un-wired caller (the
  // torture fixture) still renders, just without indoor/outdoor contrast.
  sampleWindExposureAt ??= () => 1;
  // THE MASK-DRIVEN WIND REBAKE TRIGGER (2026-07-21 — see bakeWindField's own
  // 'mask-change' reason for the full story). `null` = "no version to watch"
  // (the torture fixture has no mask authority), which the poll below already
  // treats as inert — never wired means never triggers, same posture as
  // sampleWindExposureAt's own default just above.
  getMaskAuthorityVersion ??= () => null;
  // THE WIND PROBE's live mask-authority cross-check (2026-07-22) — see
  // runWindProbeOnPoints' own header for the full reasoning. Default reports
  // itself as unwired rather than pretending to have an answer.
  probeMaskAuthorityLiveAt ??= () => ({ skipped: true, reason: 'not wired (no mask authority for this viewer)' });
  // THE SKY LIGHT's gate (2026-07-23, docs/planning/Sky.md): the `_Outdoors`
  // mask grid for a floor, uploaded to a texture so the illumination pass can
  // ask "is this screen pixel outdoors" per-fragment. `null` = unwired (the
  // torture fixture), which bakes a 1×1 fully-outdoors placeholder — and since
  // the sky ships at `realism01 = 0` that is a no-op either way, so an unwired
  // caller renders exactly as it did before the sky existed.
  getOutdoorsMaskGrid ??= () => null;
  // SUN SHADOWS' two seams. `null`/disabled leaves the shadow field baked white
  // (a provable no-op) rather than leaving it unwritten — the ambient fill
  // always samples it, so "off" has to be a written value. Un-wired callers
  // (the torture fixture) therefore render exactly as they did before.
  getCasterHeightField ??= () => null;
  getSunShadowRenderState ??= () => ({ enabled: false, params: {} });
  // THE WATER BODY PACK's two seams (docs/planning/Water.md §5.1, Phase 2d).
  // `getWaterMaskGrid` is boot's door onto `maskAuthority.getDerived('water',
  // floorIndex)`; `getFloorsWithWater` onto `floorsWithAuthored('water')`,
  // which is the cross-floor rule's own input (§4). Unwired (the torture
  // fixture) means "no floor has water", so `resolveWaterFloor` returns
  // `floorIndex: null` and the subsystem never bakes at all — inert by
  // construction, not by a flag, exactly like the sun-shadow seams above.
  getWaterMaskGrid ??= () => null;
  getFloorsWithWater ??= () => [];
  // THE HIGH-RES SHORELINE's source (2026-07-26): the resolved floor's own
  // `_Water` file URL. Unwired means no hi-res mask, which keeps the surface
  // hidden entirely rather than falling back to the blocky SDF-thresholded
  // edge this change exists to stop drawing (water-render.js's header).
  getWaterMaskUrl ??= () => null;
  // WATER's look/enable seam — default-ON, matching the manifest's own
  // `enabledFromProfile: 'low'`: tier 0 is a mask read and a tint, so an
  // un-wired caller still gets water rather than a silently-disabled effect.
  getWaterRenderState ??= () => ({ enabled: true, params: {} });
  // SHINE's three seams (docs/planning/Specular.md). `getSpecularMaskUrl` is
  // boot's door onto the floor's authored `_Specular` file — the ONLY thing
  // that carries the mask's COLOUR, and therefore the whole material, since the
  // authority's own grid is extracted R-only and for a colour mask R is not
  // presence. `getSpecularMaskRect` is the world rect that file covers. Unwired
  // (the torture fixture) means no mask at all, so both meshes stay hidden and
  // the pass takes a true JS early-return — inert by construction, not by a
  // flag, exactly like the water and sun-shadow seams above.
  getSpecularMaskUrl ??= () => null;
  getSpecularMaskRect ??= () => null;
  // Default-ON, matching the manifest's `enabledFromProfile: 'low'`. Safe to
  // default on in a way water's is not even quite: with no `_Specular` file the
  // effect renders literally nothing, so a scene that never opted in cannot be
  // surprised by it.
  getSpecularRenderState ??= () => ({ enabled: true, params: {} });
  // WINDOW LIGHT's three seams (docs/planning/Windows.md). `getWindowMaskUrl`
  // is boot's door onto the floor's authored `_Window` file (`_Windows`/
  // `_Structural` V2 aliases resolve to it at discovery) — the ONLY thing
  // that carries the mask's COLOUR, exactly as specular's does above.
  // `getWindowMaskRect` is the world rect that file covers. Unwired (the
  // torture fixture) means no mask at all, so the mesh stays hidden and the
  // pass takes a true JS early-return — inert by construction, not by a flag,
  // exactly like specular's seams just above.
  getWindowMaskUrl ??= () => null;
  getWindowMaskRect ??= () => null;
  // Default-ON, matching the manifest's `enabledFromProfile: 'low'`. Safe in
  // the same way specular's is: with no `_Window` file the effect renders
  // literally nothing, so a scene that never opted in cannot be surprised.
  getWindowRenderState ??= () => ({ enabled: true, params: {} });
  // FLUID's seams (docs/planning/Fluid.md). `getFluidMaskItems` lists every
  // file at its own resolution — fluid has NO coarse-grid consumer, because
  // connected components and geodesic arc length are high-frequency questions
  // and the ≤512 derivation grid merges tubes a tube's width apart (correction
  // #2). Unwired means no mask, so the mesh never becomes visible and the whole
  // effect is inert by construction rather than by a flag.
  getFluidMaskItems ??= () => [];
  onFluidCornersResolver ??= () => {};
  // Deliberately NOT defaulted. `feedback_seam_default_hides_unwired`: water
  // shipped its render-state seam declared, defaulted and never passed, and the
  // only symptom was that every control silently did nothing while every test
  // passed. The subsystem reports the absence loudly instead.

  // THE CANDLE EFFECT's data seam (effects/candle-flame-render.js): boot injects
  // `{ enabled, params: {sizePx, color, lightRadiusPx}, anchors: [{id,x,y}] }` for
  // the active floor. vt/ owns the GPU lifecycle (the flame billboard mesh + the
  // candle lights merged into the light pool) but knows nothing about the anchor
  // authority or the settings cascade — same injection discipline as the mask
  // authority's closures. Default = the effect off, so an un-wired caller is inert.
  getCandleRenderState ??= () => ({ enabled: false, params: {}, anchors: [] });
  // THE DOOR-GRAPHICS data seam (effects/door-graphics-render.js): boot injects
  // `{ enabled, params: {animateMotion, motionDurationScale}, doors: [...] }`
  // — the renderable door snapshots (foundry/scene-doors.js) for the active
  // floor. vt/ owns the GPU lifecycle (the leaf meshes in doorScene, drawn into
  // the lit scene albedo) and the per-frame open/close animation clock, but
  // knows nothing about the Foundry read or the settings cascade — same
  // injection discipline as the candle seam above. Default = the effect off, so
  // an un-wired caller (the torture fixture) draws no doors.
  getDoorRenderState ??= () => ({ enabled: false, params: {}, doors: [] });
  // VEGETATION's data seam (effects/vegetation-render.js): boot injects
  // `{ enabled, params: {windResponse, swayAmount, intensity}, urlByItemId }`
  // — same injection discipline as the candle's seam just above. Default =
  // the effect off with an empty lookup, so an un-wired caller (the torture
  // fixture) renders every item through its ordinary, non-vegetation path.
  getVegetationRenderState ??= () => ({ enabled: false, params: {}, urlByItemId: new Map() });
  // BLOOM's data seam (effects/bloom-render.js): boot injects `{ enabled, params }`
  // (the resolved BLOOM_PARAMS). vt/ owns the GPU pyramid (mip targets + the
  // dual-filter passes) but knows nothing about the registry/cascade — same
  // injection discipline as the candle/vegetation seams. Default = the effect
  // off, so an un-wired caller (the torture fixture) runs no bloom pass at all.
  getBloomRenderState ??= () => ({ enabled: false, params: {} });
  // THE COLOUR GRADE (Look) effect's resolved state — same injection shape as
  // bloom. Default disabled ⇒ the artistic grade is identity (parity holds).
  getGradeLookState ??= () => ({ enabled: false, params: {} });
  // THE SAFETY SLIDE'S seam-restore hook (see the renderer.onDeviceLost handler
  // below). Injected exactly like the others so vt/ stays ignorant of the
  // interface seam: the composition root (boot.js) wires this to
  // restoreFoundryArt(), because un-suppressing canvas.environment is a Foundry-
  // adapter concern this file must not reach into directly.
  onDeviceLost ??= () => {};
  // Captured for runZoomThrashTest's "blank slate" restart (2026-07-16) —
  // the SAME fully-resolved params this call itself used, so a later restart
  // reproduces an identical fresh viewer without the caller needing to
  // remember/re-supply them.
  const startupParams = {
    THREE,
    buildItems,
    dimensions,
    floorCount,
    initialFloorIndex,
    extraLayersForItem,
    getOcclusionInputs,
    onPageDecoded,
    onDeviceLost,
  };
  // World space IS Foundry canvas space (foundry/scene-geometry.js) — the padded
  // rect, +Y down. RECTANGULAR: `Scene#padding` defaults to 0.25 and the default
  // scene is 4000x3000, so a square world is the exception, not the rule.
  const world = { width: dimensions.width, height: dimensions.height };
  disposeActive();

  const diag0 = { errors: [] };
  // Hoisted so the catch can TEAR THE CANVAS DOWN. It is appended before any
  // risky work and is opaque (background:#000), so a failure that leaves it in
  // place puts a black rectangle over a perfectly healthy Foundry canvas — which
  // is what used to block the safety slide (diag/render-fallback.js).
  let canvas = null;
  try {
    /**
     * THE DANGLING-INDIRECTION FIX (author-reported 2026-07-17, under a
     * zoom/floor thrash test: "tiles of textures at the wrong scale and in the
     * wrong place appearing across the scene"). Full mechanism in
     * page-cache.js's `onEvict` header — the short version: an evicted slot's
     * identity changes, and any indirection texel still pointing at it now
     * resolves to a DIFFERENT page's pixels (wrong mip = wrong scale, wrong
     * coords = wrong place, or another pack's texture entirely). It renders as
     * confident garbage, never as blur.
     *
     * `pageOwners` is what makes an evicted KEY resolvable back to the exact
     * texel that references it. Bounded by construction: an entry is added only
     * when a texel is actually written (writeIndirection, which itself only
     * runs for a verifiably-resident page) and removed the instant that page is
     * evicted — so it can never hold more than the cache's own resident set.
     * @type {Map<string, {pack: object, page: {mip:number, px:number, py:number}}>}
     */
    const pageOwners = new Map();

    /**
     * Zero the one indirection texel that points at `key`, if any still does.
     *
     * SAFE EVEN FOR A STALE ENTRY, and this is the load-bearing reason it can
     * be this simple: within one pack, texel address and page key are a
     * BIJECTION — `pageKey(mip,px,py)` encodes exactly the `(mip, px, py)` this
     * texel's address is derived from, so no key other than `key` can ever
     * write this texel. A `pageOwners` entry left behind by a `buf.fill(0)`
     * rebuild therefore cannot clear someone else's live pointer; the worst it
     * can do is re-clear an already-clear texel, which the alpha guard below
     * skips outright.
     */
    function clearIndirectionForKey(key) {
      const owner = pageOwners.get(key);
      if (!owner) return; // never written to any indirection, or already cleared
      pageOwners.delete(key);
      const { pack, page } = owner;
      const o = pack.indirectionLayout.origins[page.mip];
      const i = ((o.y + page.py) * pack.width + (o.x + page.px)) * 4;
      if (pack.buf[i + 3] === 0) return; // already reads "not resident" — nothing to clear
      // All-zero reads as "not resident" to the sampler, which then walks up to
      // the coarse pin — blur, the §4.1 guarantee, instead of another page's
      // pixels. Alpha included: writeIndirection sets it to 255 to mean
      // resident, so leaving it set would keep the texel "live" while its RG
      // slot bits read 0 — i.e. confidently pointing at slot 0.
      pack.buf[i] = 0;
      pack.buf[i + 1] = 0;
      pack.buf[i + 2] = 0;
      pack.buf[i + 3] = 0;
      pack.indirectionTexture.needsUpdate = true;
    }

    const cache = new PageCache({
      budgetBytes: 512 * 1024 * 1024,
      onEvict: clearIndirectionForKey,
    });

    const mount = resolveMountHost();
    let canvasW = measureHost(mount.host).width;
    let canvasH = measureHost(mount.host).height;
    canvas = document.createElement('canvas');
    canvas.id = 'msa-vt-pan-viewer-canvas';
    canvas.width = canvasW;
    canvas.height = canvasH;
    // THE INTERFACE SEAM (2026-07-17) — on a real scene MSA now sits UNDERNEATH
    // Foundry's PIXI canvas, not on top of it. See foundry/canvas-compositing.js
    // for the full finding; the short version:
    //
    // Foundry's `interface` group holds EVERY interactive layer (tokens, tiles,
    // walls, grid, controls, notes, drawings, templates — CONFIG.Canvas.layers)
    // and draws all the chrome: selection borders, control icons, rulers,
    // target reticles, drag previews. It renders into `canvas#board`. MSA used
    // to mount at z-index 5 with an OPAQUE background, which meant input worked
    // (pointer-events:none let clicks through) while every one of those was
    // invisible behind us. Selection worked; you just could not see it.
    //
    // So: MSA draws the ART underneath, Foundry's PIXI canvas goes transparent
    // and draws only its CHROME on top. They render DISJOINT sets — which is
    // what keeps this from being V2's two-authoritative-renderers blunder
    // (Engine-Postmortem.md §1). There is no shared picture, so there is
    // nothing to synchronise.
    const boardEl = followFoundryCamera ? document.getElementById('board') : null;
    const stackUnderBoard = !!boardEl && boardEl.parentElement === mount.host;
    Object.assign(canvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      // z-index 0 and inserted BEFORE #board in tree order (see below), which
      // is what actually puts us under it. Deliberately NOT z-index:-1 — a
      // negative z-index paints behind the stacking context's background, and
      // our mount host is <body> (canvas#board's parent, game.hbs:31). Equal
      // z-index + tree order is well-defined CSS; negative z-index depends on
      // who forms the stacking context.
      //
      // The torture fixture (followFoundryCamera:false) has NO Foundry scene
      // and owns its own camera and input, so it stays on top at 5: above board
      // (0) + hud (1), below Foundry UI (60) and the debug panel (90).
      zIndex: stackUnderBoard ? '0' : '5',
      display: 'block',
      // Stays OPAQUE, and now that is correct rather than destructive: we are
      // the bottom of the stack, so this is the "nothing here" backdrop.
      background: '#000',
      // FOUNDRY OWNS ALL INPUT when following its camera (author decision
      // 2026-07-16). This is now BELT AND BRACES rather than the load-bearing
      // fix — a canvas underneath #board cannot swallow a click anyway. It is
      // kept precisely because it WAS load-bearing: with 'auto' on top, this
      // canvas swallowed every click, drag and drop aimed at Foundry's board.
      // Dropping tokens silently created no documents at all (diagnoseTokens:
      // tokenDocsFound: 1 on a scene the author had dropped many tokens onto)
      // and marquee select did nothing. It looked for hours like a rendering
      // bug and was an input bug. If the stacking ever regresses, this keeps
      // that catastrophe from coming back with it.
      pointerEvents: followFoundryCamera ? 'none' : 'auto',
      // NOT 'grab'. The cursor was permanently a hand, which promises a drag
      // that is not always what a click does (author-reported). It becomes
      // 'grabbing' only for the duration of an actual pan, then reverts.
      cursor: 'default',
    });
    // Tree order IS the stacking order at equal z-index: earlier paints lower.
    if (stackUnderBoard) mount.host.insertBefore(canvas, boardEl);
    else mount.host.appendChild(canvas);

    // WebGPURenderer — the NODE renderer, which picks WebGPU or WebGL2 itself
    // (docs/planning/Shaders.md). NOT "the WebGPU renderer": its WebGLBackend is
    // the WebGL2 rung of §4.3's ladder, from this same TSL source.
    //
    // preserveDrawingBuffer is GONE — it is not a WebGPU concept (0 hits in the
    // node build). It existed so a button-click gl.readPixels() could read the
    // last frame; that diagnostic now renders into an explicit RenderTarget
    // instead (see sampleDiagnostics), which is the readback path both backends
    // actually implement.
    // RAISE THE WEBGPU TEXTURE CAP (2026-07-17, the PIXI-parity direction —
    // see texture-limits.js). WebGPU's default maxTextureDimension2D is 8192,
    // but the author's Level art is 12000² — which is the whole reason a floor
    // had to be sliced into thousands of streamed pages (the upload churn that
    // killed the device). Ask the adapter for its real limit and request up to
    // 16384 (never more than it supports, never below the 8192 floor), so a
    // whole floor can live in ONE texture, PIXI-style. `requiredLimits` is
    // forwarded straight to adapter.requestDevice by three's WebGPURenderer.
    // On WebGL2 or when there's no adapter, this stays undefined and three
    // picks its defaults; a device that genuinely can't be created still trips
    // the safety slide below.
    const requiredLimits = await resolveRendererRequiredLimits();
    // `trackTimestamp: true` REQUESTS the per-render-pass GPU timer. It is a
    // CONSTRUCTOR-ONLY flag (three.webgpu.js:64637) that three then ANDs with the
    // adapter feature check during init() (:75258) — which is why the previous
    // reading of "supported:false" proved nothing: the flag was never passed, so
    // it reported false on hardware that supports timestamp queries perfectly
    // well. Requesting it here does NOT turn measurement on; see the two lines
    // after init().
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, requiredLimits, trackTimestamp: true });
    await renderer.init(); // REQUIRED before any use — the backend is chosen here
    // CAPTURE THE CAPABILITY, THEN PARK THE FLAG. Post-init the flag is
    // `requested && hasFeature`, so this one read is the honest answer to "can
    // this device time passes at all". Setting it back to false immediately means
    // `initTimestampQuery` returns on its first line (:76493) and the query pool
    // is never allocated — one boolean per pass in normal play, which is what
    // makes the instrument free when it is not measuring.
    if (renderer.backend) {
      renderer.backend.__msaTimestampCapable = renderer.backend.trackTimestamp === true;
      renderer.backend.trackTimestamp = false;
    }

    // PIXEL-RATIO PARITY (2026-07-19 — "MSA mushes the artwork's pen outlines
    // away when zoomed out; PIXI keeps them crisp"). This used to hard-code
    // setPixelRatio(1) regardless of the display's real density, while
    // Foundry's OWN canvas renders at window.devicePixelRatio by default
    // (client setting "pixelRatioResolutionScaling", initial:true — verified
    // against client/canvas/board.mjs: `resolution: ... ? window.
    // devicePixelRatio : 1`). On any display with devicePixelRatio > 1 (the
    // common case — 125%/150%/200% Windows scaling, Retina), PIXI's canvas
    // therefore has MORE actual pixels than MSA's for the identical
    // on-screen view, so PIXI samples the map texture at a FINER (less
    // minified) level for what looks like the same zoom — exactly why its
    // thin dark outlines survive while MSA's, covering the same view with
    // fewer samples, fall a mip level (or more) further into the chain. The
    // mip chain built earlier this session is real and correct; it was never
    // going to close a gap caused by rendering at a coarser backing
    // resolution than Foundry in the first place.
    //
    // THE FIX mirrors Foundry's OWN resolved value rather than re-deriving
    // the policy: `canvas.app.renderer` is the live PIXI Renderer (read the
    // same way foundry/canvas-compositing.js already reads
    // `canvas.app.renderer.background`), and `.resolution` is its
    // post-setting number (verified against the vendored @pixi/core
    // Renderer class). Reading Foundry's actual value — instead of
    // `window.devicePixelRatio` directly — stays correct even if the player
    // has Foundry's own "Disable Resolution Scaling" setting off. Defensive
    // like every other live canvas.* read in this file (syncFoundryCamera):
    // missing/invalid falls back to the OLD behaviour, never worse than
    // before this fix. Capped at 4 as a sanity bound against a garbage
    // read turning into a device-killing allocation (Keyhole.md §0) — not a
    // policy choice; no real display exceeds this today.
    //
    // COST, stated plainly: this is a real fill-rate trade. A 2x-resolution
    // display now shades 4x the pixels through MSA's full effects pipeline
    // (region darkness, point lights, illumination); 3x is 9x. That is the
    // SAME cost PIXI already pays at ITS default setting, not a new one MSA
    // introduces — but if frame rate suffers, Foundry's own "Disable
    // Resolution Scaling" client setting is the lever, exactly as it would
    // be for Foundry's own canvas.
    const foundryResolution = globalThis.canvas?.app?.renderer?.resolution;
    const pixelRatio = Number.isFinite(foundryResolution) && foundryResolution > 0 ? Math.min(foundryResolution, 4) : 1;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(canvasW, canvasH, false);

    // THE DRAWING BUFFER, in actual device pixels — NOT canvasW/canvasH, which
    // stay in CSS pixels for every camera/layout computation in this file
    // (syncFoundryCamera's halfSpan math, measureHost, etc. — those must NOT
    // change, since Foundry's own camera framing is itself CSS-pixel/stage-
    // scale based). `renderer.getDrawingBufferSize()` is three's own
    // canonical width*pixelRatio/height*pixelRatio (verified against the
    // vendored source, Renderer.getDrawingBufferSize -> canvasTarget's, same
    // floor() three uses internally) — reading it back rather than
    // recomputing canvasW*pixelRatio by hand avoids a second place that could
    // round differently from what three actually allocated.
    //
    // WHY THIS EXISTS: describeSceneColor/describeOcclusionMask below feed
    // this into every screenSized render target (scene.color, scene.illum,
    // scene.lit, scene.coloration, occlusion.mask) — the buffers the world
    // quad (map art) actually gets drawn INTO. Before this, those buffers
    // were sized off canvasW/canvasH directly (CSS pixels) — accidentally
    // correct only because pixelRatio was hard-coded to 1. Fixing pixelRatio
    // alone, without this, would have changed nothing but the canvas's own
    // backing-buffer size: the map would still have been RENDERED (and its
    // texture SAMPLED/minified) at the old, coarser CSS-pixel resolution,
    // then upscaled onto a bigger canvas — the actual sharpness bug
    // untouched. This is the half that makes the pixel-ratio fix real.
    const drawBufSize = renderer.getDrawingBufferSize(new THREE.Vector2());
    let drawBufW = drawBufSize.width;
    let drawBufH = drawBufSize.height;

    // The texture cap the device ACTUALLY granted (see resolveRendererRequiredLimits
    // above + texture-limits.js). Whole-image mode plans each image into tiles
    // under min(this, MAX_WHOLE_TILE_DIM) — the memory cap wins, so a 12000²
    // floor loads as a 2×2 grid, never one device-killing 549MB allocation.
    const textureLimit = renderer.backend?.device?.limits?.maxTextureDimension2D ?? WEBGPU_SPEC_MIN_TEXTURE_DIM;

    // THE DEVICE-LOST SAFETY SLIDE (author flight-recorder, 2026-07-17: a real
    // "WebGPU Device Lost: A valid external Instance reference no longer exists"
    // after three scene loads on the 12000² mansion, taking BOTH MSA's and
    // Foundry's contexts down at once). A lost device is a fact of GPU life —
    // driver reset, TDR under load, sleep/resume, an iGPU/dGPU switch, or (the
    // cause this session's renderer-dispose fix addresses) leaked contexts from
    // scene swaps that never disposed. Three's DEFAULT onDeviceLost only logs
    // and freezes; with no handler here, MSA's canvas went dead-black WHILE
    // still occluding Foundry's suppressed art (environmentRenderable:false) —
    // a black screen with no way out but reload, the exact opposite of the
    // safety slide the whole project ranks above the visuals
    // ([[feedback_safety_slide_outranks_doctrine]]).
    //
    // `device.lost` with reason "destroyed" is filtered out by the backend
    // (three.webgpu.js) — so our own renderer.dispose() during teardown does
    // NOT reach here. This fires only for a genuine, unexpected loss.
    const defaultOnDeviceLost = renderer.onDeviceLost.bind(renderer);
    let deviceLostSlid = false;
    renderer.onDeviceLost = (info) => {
      // Three's default FIRST: it sets the renderer's own `_isDeviceLost` guard,
      // which makes every internal render() a no-op — the belt to our braces of
      // stopping the loop, so an in-flight upload chunk that resumes the loop
      // (requestDecodeUpload) can never paint on a dead device.
      try {
        defaultOnDeviceLost(info);
      } catch (_) {
        // Three's own logger threw — irrelevant next to the slide below, which
        // is the part that keeps the session usable. Never let it block us.
      }
      if (deviceLostSlid) return; // device.lost resolves once, but stay idempotent
      deviceLostSlid = true;
      const detail = `${info?.message || 'unknown'}${info?.reason ? ` (reason: ${info.reason})` : ''}`;
      // THE RACE GUARD: if a newer viewer has already taken over (`_active` is
      // not us), this renderer is a corpse the new viewer's own disposeActive
      // already dealt with — sliding now would call disposeActive() on the LIVE
      // viewer and tear IT down. Our own intentional teardown is filtered
      // upstream (reason:"destroyed"), so this only guards an unexpected loss
      // that races a scene switch. Still freeze this renderer (above), just
      // don't touch the module-level state that no longer belongs to us.
      if (_active?.renderer !== renderer) {
        log.warn(`WebGPU device lost on a viewer that is no longer active — frozen, not sliding: ${detail}`);
        return;
      }
      log.error(`WebGPU device lost — sliding to Foundry's own renderer: ${detail}`);
      // THE DEATH-STATE SNAPSHOT (author flight-recorder, 2026-07-17, SECOND
      // loss): the last diagnostic in the recorder was from the floor switch
      // ~23s earlier, so we were blind about the GPU/cache/decode state at the
      // instant it died — and "heavy load / TDR" had been GUESSED twice with no
      // proof (exactly the [[feedback_plausible_diagnosis_rots]] trap). These
      // are all plain-JS counters — no GPU access, safe on a dead device —
      // logged so they ride the flight-recorder export. What to read next time:
      //   • decodeStats.heldSources > 0, or mainThreadFallbackSourceDecodes
      //     climbing -> a full ~576MB source bitmap was mid-decode on the main
      //     thread when it died (the mask-404 retry path feeds this) -> a
      //     transient-memory death; fix the 404s + cap concurrent held sources.
      //   • neither -> a pure GPU-time TDR on the upload burst; cut
      //     MAX_MS_PER_UPLOAD_CHUNK / pages-per-pass.
      try {
        log.error('device-lost state snapshot (read this to stop guessing the cause):', {
          view: view ? { halfSpanPx: view.halfSpanPx, floorIndex: view.floorIndex } : null,
          cacheStats: cache.stats(),
          decodeStats: getDecodeStats(),
          sceneColorBytes: sceneColor ? sceneColor.width * sceneColor.height * 8 : null,
          // WHOLE-IMAGE VRAM AT DEATH — the number this hunt kept missing. Sum of
          // every uploaded whole-image texture (w·h·4). Read estTextureVramMB
          // (this + sceneColor) against a plausible WebGPU budget: if it
          // is multiple GB AND the frame-gap hitches spike right before this, it
          // is a VRAM-ceiling death and the fix is to hold FEWER full-res layers
          // (drop off-floor occlusion layers) — not to sequence
          // uploads harder. loading > 0 means it died mid floor-load, so peak was
          // even higher than the tally shows.
          wholeImage: (() => {
            let bytes = 0;
            let ready = 0;
            let loading = 0;
            const items = [];
            for (const [id, s] of itemStates) {
              const wi = s.wholeImage;
              if (!wi) continue;
              // HONEST per-format bytes — the same accounting the floor-switch
              // report uses. Before this, every whole tile was counted as raw
              // sw·sh·4, so a 68 MB BC1 floor read as 549 MB here: the snapshot
              // meant to END the memory guessing was itself lying about the very
              // number in question (memory: feedback_instruments_must_not_lie).
              const isBc7 = wi.compressed && wi.compressed.startsWith('bc7');
              const isBc1 = wi.compressed && wi.compressed.startsWith('bc1');
              const rs = wi.rawScale || 1;
              let b = 0;
              for (const t of wi.tiles) {
                // mipChainByteLength: the FULL chain's bytes, not just level 0
                // (the mip-chain fix — see block-compress.js). The raw branch's
                // *4/3 matches three.webgpu.js's OWN mip-overhead accounting
                // (`size * 1.333` for a generateMipmaps:true texture) — an
                // approximation there because the GPU's auto-generated chain
                // isn't bytes this codebase computes itself, unlike the
                // hand-built BC chain, which is exact.
                if (isBc7) b += mipChainByteLength('bc7', t.tile.sw, t.tile.sh);
                else if (isBc1) b += mipChainByteLength('bc1', t.tile.sw, t.tile.sh);
                else b += Math.round(t.tile.sw * rs) * Math.round(t.tile.sh * rs) * 4 * (4 / 3);
              }
              bytes += b;
              if (wi.status === 'ready') ready++;
              else if (wi.status === 'loading') loading++;
              items.push({ id, status: wi.status, mb: +(b / (1024 * 1024)).toFixed(1), compressed: wi.compressed });
            }
            const otherBytes = sceneColor ? sceneColor.width * sceneColor.height * 8 : 0;
            return {
              totalMB: +(bytes / (1024 * 1024)).toFixed(1),
              estTextureVramMB: +((bytes + otherBytes) / (1024 * 1024)).toFixed(1),
              ready,
              loading,
              items,
            };
          })(),
        });
      } catch (err) {
        log.error('device-lost snapshot failed (the slide below still runs):', err);
      }
      loopActive = false;
      try {
        renderer.setAnimationLoop(null);
      } catch (_) {
        // Stopping the loop on a lost device can throw; disposeActive() below
        // stops it again anyway. The loopActive=false above is the real guard.
      }
      // Un-suppress Foundry's art (injected — see the param doc). MUST happen or
      // removing our dead canvas below just reveals a still-suppressed (blank)
      // Foundry scene.
      try {
        onDeviceLost(info);
      } catch (err) {
        log.error('onDeviceLost seam-restore callback threw:', err);
      }
      // Stop occluding Foundry + announce, unmissably (diag/render-fallback.js).
      engageFoundryFallback({
        reason: "Its GPU device was lost — Foundry's own renderer is drawing this scene. Reload to retry MSA.",
        detail,
        canvas,
      });
      // Free what we still can and drop the dead viewer, so the next scene load
      // starts clean rather than short-circuiting on a corpse. Every step is
      // best-effort/try-caught inside disposeActive — safe on a lost device.
      disposeActive();
    };

    // ========================================================================
    // buf:scene.color — THE FIRST REAL RENDER TARGET (2026-07-17)
    // ========================================================================
    //
    // Until now `renderFrame` drew straight to the canvas backbuffer, so there
    // was NOWHERE for an effect to draw: `graph/passes.js` declares nine effect
    // seams that all `modifies: ['buf:scene.color']`, and the buffer they all
    // name did not exist. This is that buffer. It is the unblocking step for
    // every effect (Keyhole.md §4.2's RT inventory starts here).
    //
    // It is ALSO the first real caller of `ThreeAllocator` — Keyhole's own law
    // (§0, §4.6: "nothing is ever allocated at world resolution, ever"), which
    // until this line was a unit-tested function nothing called. It is not
    // optional: `gpu/allocator-only` fails the build on `new *RenderTarget(`
    // anywhere but the allocator, so this is the only door and it is now open.
    //
    // ⚠️ COLOUR SPACE — the one thing most likely to make this look wrong, and
    // this project has already lost a session to exactly this class of bug (the
    // washed-out map). The chain, stated so it can be checked rather than hoped:
    //   scene → RT   : RT texture is NoColorSpace, so three applies NO transfer
    //                  function. Linear values land in the buffer untouched.
    //   RT → canvas  : the present material samples it (no decode — the node
    //                  system only decodes an SRGBColorSpace texture), and the
    //                  renderer applies the sRGB OETF once, at the canvas,
    //                  exactly as it does today for the direct draw.
    // Net: ONE OETF, same as before. Set NoColorSpace EXPLICITLY rather than
    // relying on a default — an implied colour space is how these bugs are born
    // (Params.md §3.6 finding #1, same disease).
    //
    // RGBA16F per §4.2 ("scene.color (RGBA16F)"): effects need HDR headroom
    // (bloom has nothing to bloom from in 8-bit). Costs 2 bytes/channel, and
    // §4.2's whole inventory is budgeted on that.
    const allocator = new ThreeAllocator({ THREE });
    const describeSceneColor = () => ({
      // Device pixels (drawBufW/H), NOT CSS pixels (canvasW/H) — see this
      // function's siting, right after where drawBufW/H is computed, for why
      // the distinction is load-bearing (the pixel-ratio-parity fix).
      resolvedW: drawBufW,
      resolvedH: drawBufH,
      // O(screen), not O(world) — sized from the drawing buffer, so it scales
      // with the player's monitor and never with the map. See the allocator's
      // own note on why this is NOT `allowWorldScale`.
      screenSized: true,
      type: THREE.HalfFloatType,
      colorSpace: THREE.NoColorSpace,
      filter: 'linear',
      depth: false, // the draw list is already depth-sorted by the layering law
    });
    // `scene.color` is the ONE MRT target in this file — `buf:scene.attr`,
    // B0-1's floor-attribute buffer, as a real second attachment (full
    // mechanism + safe-default proof in vt/scene-attr.js's own header).
    // `describeSceneColorMrt()` keeps attachment 0 IDENTICAL to plain
    // `describeSceneColor()` (still used unchanged below); attachment 1 is
    // B0-1 §2.1's RGBA8/Nearest/NoColorSpace, named 'attr' for `MRTNode`.
    const describeSceneColorMrt = () => describeSceneAttrMrt({ THREE, resolvedW: drawBufW, resolvedH: drawBufH });
    const sceneColor = allocator.create('scene.color', describeSceneColorMrt());
    // Renderer-global safe default: every material that doesn't declare its
    // own `mrtNode` writes `attr = vec4(0,0,0,0)` for free — zero changes to
    // existing transparent materials. `runGeometryWorldPass` scopes this to
    // its own render() calls only; never left globally set (its own header).
    const sceneAttrZeroMrt = buildSceneAttrZeroMrt(THREE);

    // ========================================================================
    // light.accumulate — buf:scene.illum + the lit composite (2026-07-18).
    // ========================================================================
    //
    // Tier 0 of Type-A parity (docs/planning/Light-Parity.md): the whole map
    // multiplied by Foundry's ambient background (day/night) — the FLOOR every
    // later light (point lights, coloration, darkness) sits on. Two more
    // screen targets, both through the allocator law, same RGBA16F/linear/
    // NoColorSpace shape as scene.color (reuse describeSceneColor):
    //   scene.illum : the ambient illumination, sRGB (Foundry's own space —
    //                 see effects/lighting/environmental-light.js's colour
    //                 essay for why this multiply lives in gamma, not linear).
    //   scene.lit   : albedo × illum, the post-light colour the present pass
    //                 reads. This IS "modifies buf:scene.color" (graph/passes.js)
    //                 ping-ponged for the ONE modifier that exists today; when
    //                 surface/water land they extend it into a general swap.
    const sceneIllum = allocator.create('scene.illum', describeSceneColor());
    const sceneLit = allocator.create('scene.lit', describeSceneColor());
    // buf:scene.coloration (2026-07-19, increment 3) — the point-lights'
    // coloration channel accumulates HERE (MAX-blended across lights, see
    // point-light-coloration.js's own header), separately from illum, then is
    // ADDED onto the lit scene INSIDE the composite, in GAMMA space (audit §6's
    // "ADD onto scene", done the Foundry-correct way — see environmental-
    // light.js's composite essay for why a linear-space add washed the scene
    // to a single hue and gamma-space fixes it).
    const sceneColoration = allocator.create('scene.coloration', describeSceneColor());

    // ========================================================================
    // UI-SHADOW — open Foundry windows cast a soft offset shadow (2026-07-20).
    // ========================================================================
    // Built BEFORE envLight (below) because its `visNode` is composed directly
    // into the composite shader — NO separate quad/material/render() call (v6,
    // author-measured PERFORMANCE FIX: the v5 DOM-read throttle barely moved
    // the FPS, proving the extra `render()` CALL itself — not the DOM read —
    // was the dominant cost; folding the box-SDF math into the ALREADY-
    // running composite pass removes that call entirely). TSL lives in
    // effects/lighting/light-visibility.js (browser-only); the geometry
    // mapper is Node-tested there. Reads open windows from the DOM read-only
    // — never touches their input (canvas is pointer-events:none; keyhole-
    // interface-seam + keyhole-input-model-decision hold). See
    // _uiShadowState / setUiShadow.
    const uiShadow = buildUiShadowVisibility({ THREE });

    // ── THE OUTDOORS MASK, ON THE GPU (2026-07-23, docs/planning/Sky.md) ──
    // The `_Outdoors` grid as a single-channel-ish texture so the sky light can
    // be gated per-fragment. Starts as a 1×1 "everything outdoors" placeholder
    // so the sampler exists at material-build time (the materials are built
    // ONCE, at startup, long before any mask has streamed in) and the real one
    // is swapped in by `bakeOutdoorsTexture` via the shared texture node —
    // exactly the `rebindPresent` pattern used for resize.
    //
    // A placeholder of "fully outdoors" is the safe default here specifically
    // because the sky ships neutral: at `realism01 = 0` the multiplier is
    // [1,1,1] and the veil [0,0,0], so "the whole map is outdoors" and "the
    // whole map is indoors" render identically. The placeholder cannot be
    // mistaken for real data because nothing it gates does anything yet.
    let outdoorsTexture = makeOutdoorsPlaceholderTexture(THREE);
    /** The world rect `outdoorsTexture` covers. The placeholder covers the whole
     * scene so the uniform is never nonsense before the first real bake. */
    let outdoorsRect = { ...dimensions.sceneRect };
    /** The LAST thing `bakeOutdoorsTexture` actually did, success or failure —
     * reported verbatim in getEnvSnapshotInfo() so "the sky does nothing" is
     * always answerable from the Diagnostics report rather than the console
     * (feedback_instruments_must_not_lie: a silently-swallowed
     * RequiredMaskMissingError must not look identical to "working as
     * intended"). `null` before the first attempt. */
    let lastOutdoorsBakeResult = null;

    // ── SUN SHADOWS (docs/planning/Sun-Shadows.md) ───────────────────────
    // Extracted (2026-07-25, VT-Pan-Viewer-Extraction.md step 1) into its own
    // module — `effects/lighting/sun-shadow-subsystem.js` — the first
    // subsystem pulled out of this function's closure. `getShadowHandle` and
    // `getEnvLight` are GETTERS, not values: `shadowHandle` is reassigned on
    // every sky change, and `envLight` does not exist yet at this line (it is
    // built two statements below, and itself needs `sunShadows.texture` as
    // one of ITS OWN params — see the new module's own header for why that
    // ordering is safe). Both closures are only ever invoked later, from the
    // frame loop, by which point both bindings are long since initialized.
    //
    // `renderSunShadowPass`/`createSunShadowCasterTexture` stay HERE rather
    // than moving into the subsystem: `renderer-state/graph-only` and
    // `gpu/textures-in-vt-only` only allow `.setRenderTarget(`/`new
    // ...Texture(` inside vt/graph/diag — moving them into effects/lighting/
    // tripped both walls. The subsystem decides WHEN to bake; these two tiny
    // functions are the ONLY code that actually touches the renderer/GPU
    // memory for it, exactly where those walls already say that belongs.
    function renderSunShadowPass(target, quad) {
      const prev = renderer.getRenderTarget();
      // `allocator.create()` returns the WebGLRenderTarget/RenderTarget itself
      // (see sceneColor/sceneIllum/bloomMips' own call sites) — NOT a wrapper
      // with a `.target` field. `.target` was undefined, so this bound the
      // canvas's own render context instead of the shadow field's texture: the
      // WebGPU backend's `_getDefaultRenderPassDescriptor` then read `.samples`
      // off a context shape it did not expect and crashed (live, 2026-07-24).
      renderer.setRenderTarget(target);
      quad.render(renderer);
      renderer.setRenderTarget(prev);
    }
    /**
     * The ONE `new THREE.DataTexture(...)` door for a subsystem's baked mask
     * grid — shared by sun shadows and the water body pack (2026-07-26,
     * generalized from `createSunShadowCasterTexture` when water needed the
     * same upload with a different filter).
     *
     * THE FILTER IS THE CALLER'S CHOICE AND IT IS LOAD-BEARING BOTH WAYS:
     *   LINEAR  — sun shadows. A silhouette edge must be a ramp, not a
     *             staircase of mask texels; the march's contact-hardening
     *             feathers against that gradient.
     *   NEAREST — the water body pack. Its seed pass decides which texels
     *             straddle the water/land interface, and LINEAR would smear
     *             that interface into a one-texel ramp with no defensible
     *             threshold (see water-body.js's `WATER_MASK_FILTER`).
     * Passing the wrong one is silent in both directions, which is why each
     * caller states its own and neither inherits a default.
     */
    function createMaskDataTexture(data, w, h, filter = 'linear') {
      const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      const f = filter === 'nearest' ? THREE.NearestFilter : THREE.LinearFilter;
      tex.minFilter = f;
      tex.magFilter = f;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      return tex;
    }
    /**
     * FLUID's pack (`effects/fluid/fluid-pack.js`) — RGBA **float**, not bytes.
     * Its channels are an arc-length coordinate, a cross-section coordinate, a
     * tube id and a radius in world px; quantising any of them to 8 bits would
     * turn the arc length into ~1/255 steps, which on a 3,000 px tube is a
     * 12 px staircase in the one value the slug pattern scrolls along.
     *
     * `FloatType` rather than `HalfFloatType` because the pack is authored as a
     * `Float32Array` and half would need a conversion whose only benefit is
     * VRAM — 8.8 MB against 17.6 MB at full pack size. `packToHalfFloat` exists
     * and is tested for the day that trade is worth making; it is not yet.
     */
    /**
     * SHINE'S ISLAND PACK — per-texel parallax for each connected metal region
     * (`effects/specular/specular-islands.js`).
     *
     * ⚠️ **NEAREST, where the fluid pack beside it is LINEAR, and the
     * difference is not a preference.** That pack carries smooth fields (arc
     * length, distance-from-centre) and interpolating them is exactly right.
     * This one carries a per-ISLAND constant, and interpolating across an
     * island boundary produces a motion vector belonging to neither island — a
     * band around every metal object sliding at a rate nothing authored. Same
     * reasoning that makes water's jump-flood ping-pong targets nearest.
     *
     * ⚠️ **`UnsignedByteType`, NOT `FloatType`, and the difference was a live
     * bug.** The first version packed `RGBAFormat` + `FloatType` and the shader
     * read ZERO out of it while the identical CPU bake measured correct. This
     * file's OWN wind-grid note (search `HalfFloatType matches this project`)
     * already records why: FloatType has patchier filtering support, and WebGPU
     * makes `rgba32float` filterable only behind an optional feature. The
     * island pack's values are all bounded, so a byte is not a compromise --
     * it is the format that removes the question. `createFluidPackTexture`
     * above still uses FloatType.
     *
     * @param {Uint8Array} data @param {number} w @param {number} h @returns {*}
     */
    function createSpecularPackTexture(data, w, h) {
      const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.colorSpace = THREE.NoColorSpace;
      tex.generateMipmaps = false;
      // Row 0 is minY, matching MaskGrid and the pack builder's own convention.
      tex.flipY = false;
      tex.needsUpdate = true;
      return tex;
    }

    function createFluidPackTexture(data, w, h) {
      const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
      // LINEAR: the pack is a smooth field (arc length, distance-from-centre),
      // so interpolating between texels is exactly right and is what lets a
      // ~6-texel-wide tube shade as a smooth cylinder rather than as 6 bands.
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      // flipY:false — v=0 is the image's TOP row, matching the world-quad
      // convention every tile uses and the row order `downsample` produces.
      // feedback_y_flip_recurring_risk: verify orientation at every NEW mapping.
      tex.flipY = false;
      tex.needsUpdate = true;
      return tex;
    }

    /**
     * Fluid's per-item sim ping-pong half — `gpu/allocator-only` reasons this
     * lives here rather than in `effects/fluid/fluid-surface-subsystem.js`
     * (that file is walled from `new ...RenderTarget(` the same way it is
     * from `renderer.setRenderTarget(`; see its own header for both). LINEAR
     * so the advect pass's fractional backtrace interpolates smoothly — the
     * SAME filter/format wind's own ping-pong RTs use, sized tiny per item
     * (≤512×64) so it sails under the Keyhole 2048px cap with no exception.
     */
    function createFluidSimRenderTarget(name, width, height) {
      return allocator.create(name, {
        resolvedW: width,
        resolvedH: height,
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.NoColorSpace,
        filter: 'linear',
        depth: false,
      });
    }
    function disposeFluidSimRenderTarget(rt) {
      allocator.dispose(rt);
    }

    const sunShadows = createSunShadowSubsystem({
      THREE,
      allocator,
      dimensions,
      getCasterHeightField,
      getSunShadowRenderState,
      getMaskAuthorityVersion,
      getShadowHandle: () => shadowHandle,
      getEnvLight: () => envLight,
      renderSunShadowPass,
      // LINEAR — see createMaskDataTexture's own doc for why each caller
      // states its filter rather than inheriting one.
      createCasterTexture: (data, w, h) => createMaskDataTexture(data, w, h, 'linear'),
    });

    // ── THE WATER BODY PACK (docs/planning/Water.md §5.1, Phase 2d) ──────
    // `res:waterBody`: R signed distance to shore (world px, negative inside),
    // G depth01, BA the unit shore tangent — baked by a GPU jump flood ON MASK
    // VERSION CHANGE, never per frame. The subsystem owns its three render
    // targets and the version poll; the two GPU-touching callbacks stay HERE
    // for the same directory-scoped-wall reason the sun-shadow pair does
    // (`renderer-state/graph-only`, `gpu/textures-in-vt-only`).
    //
    // `renderSunShadowPass` is reused VERBATIM rather than copied: it is a
    // plain save/bind/render/restore triplet with nothing sun-specific in it,
    // and a second identical copy is exactly the kind of fork that made V2's
    // water a 15k-line family (Water.md §2.4). Only its NAME reads as
    // sun-specific, which the alias below fixes at the call site.
    const waterBody = createWaterBodySubsystem({
      THREE,
      allocator,
      getWaterMaskGrid,
      getFloorsWithWater,
      getMaskAuthorityVersion,
      renderWaterPass: renderSunShadowPass,
      // NEAREST — the seed pass needs a crisp water/land interface.
      createWaterMaskTexture: (data, w, h, filter) => createMaskDataTexture(data, w, h, filter),
    });

    const envLight = buildEnvironmentalLightMaterials({
      THREE,
      albedoTexture: sceneColor.texture,
      illumTexture: sceneIllum.texture,
      colorationTexture: sceneColoration.texture,
      uiShadowVisNode: uiShadow.visNode,
      outdoorsTexture,
      sunShadowTexture: sunShadows.texture,
    });
    envLight.setOutdoorsRect(outdoorsRect);
    // The one-time initial push (subsequent pushes happen internally, from
    // the subsystem's own rebake, whenever the caster rect actually moves).
    envLight.setSunShadowRect(sunShadows.getRect());

    /**
     * Rebuild the outdoors texture from the mask authority for `floorIndex`.
     * Cheap and idempotent — called when the mask version moves (the same poll
     * that already triggers a wind rebake) and on a floor change. Never throws:
     * a floor with no discovered `_Outdoors` makes the mask authority throw
     * `RequiredMaskMissingError`, which boot's own handler already turns into a
     * loud, throttled warning; here that simply leaves the previous texture in
     * place rather than tearing the frame down.
     */
    function bakeOutdoorsTexture(floorIndex) {
      let grid = null;
      try {
        grid = getOutdoorsMaskGrid(floorIndex);
      } catch (err) {
        log.warn('sky: outdoors mask unavailable, keeping the previous gate —', err?.message ?? err);
        lastOutdoorsBakeResult = { ok: false, floorIndex, reason: String(err?.message ?? err) };
        return lastOutdoorsBakeResult;
      }
      if (!grid?.spec || !grid?.data) {
        lastOutdoorsBakeResult = { ok: false, floorIndex, reason: 'no outdoors grid for this floor' };
        return lastOutdoorsBakeResult;
      }
      const { w, h } = grid.spec;
      if (!(w > 0 && h > 0)) {
        lastOutdoorsBakeResult = { ok: false, floorIndex, reason: `degenerate grid ${w}x${h}` };
        return lastOutdoorsBakeResult;
      }

      // R8 would do, but RGBA/UnsignedByte matches every other DataTexture in
      // this file and avoids a per-backend format-support question for one
      // channel's worth of memory. Row 0 = minY (MaskGrid's own documented
      // convention), and DataTexture defaults to flipY:false, so uv.v=0 samples
      // row 0 = minY — which is exactly what `quadUvToWorld` hands it. Three
      // spaces, one direction (see environmental-light.js's own orientation note).
      const data = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const v = grid.data[i] ?? 255;
        data[i * 4 + 0] = v;
        data[i * 4 + 1] = v;
        data[i * 4 + 2] = v;
        data[i * 4 + 3] = 255;
      }
      const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      // LINEAR so a doorway reads as a soft transition rather than a stair-step
      // of mask texels — the sky fading in at a threshold is the whole point.
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;

      outdoorsTexture?.dispose();
      outdoorsTexture = tex;
      envLight.outdoorsTexNode.value = tex;
      outdoorsRect = {
        minX: grid.spec.x,
        minY: grid.spec.y,
        maxX: grid.spec.x + grid.spec.width,
        maxY: grid.spec.y + grid.spec.height,
      };
      envLight.setOutdoorsRect(outdoorsRect);
      lastOutdoorsBakeResult = { ok: true, floorIndex, cols: w, rows: h, rect: outdoorsRect };
      return lastOutdoorsBakeResult;
    }
    // QuadMesh (never a hand-rolled quad — same Y-flip law the present pass
    // documents at length below): the vendor owns v=0-at-top on both backends.
    const illumQuad = new THREE.QuadMesh(envLight.illumMaterial);
    const compositeQuad = new THREE.QuadMesh(envLight.compositeMaterial);

    // ========================================================================
    // post.bloom — the dual-filter bloom pyramid (2026-07-23, docs/planning/Bloom.md)
    // ========================================================================
    // MSA's first POST effect and the first citizen of the `post` stage. Reads
    // scene.lit, builds a 6-mip HALF-RES blur pyramid, and additively composites
    // an independently-weighted tight CORE (mips 0..2) + wide ATMOSPHERE (mips
    // 3..5) band back into scene.lit BEFORE present — so the grade grades the
    // bloom together with the scene. Every mip goes through the allocator law
    // (screenSized: they are fractions of the drawing buffer, O(screen)). The
    // bright-pass input is clamped by the SHARED _Outdoors gate (the same nodes
    // envLight/grade use, so a mask rebake reaches bloom too — never a private
    // texture() that would freeze on the placeholder).
    const BLOOM_MIP_COUNT = 6;
    const BLOOM_ATMO_TOP = 3; // composite reads mips[0] (core) and mips[3] (atmosphere)
    const bloomNum = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d);
    // Map a 0..1 spread knob → the tent-filter UV reach (resolution-independent).
    const bloomSpreadToRadius = (s) => 0.0015 + Math.max(0, Math.min(1, Number(s) || 0)) * 0.0085;
    const describeBloomMip = (w, h) => ({
      resolvedW: Math.max(1, w),
      resolvedH: Math.max(1, h),
      screenSized: true,
      type: THREE.HalfFloatType,
      colorSpace: THREE.NoColorSpace,
      filter: 'linear',
      depth: false,
    });
    // Mip k covers ceil(drawBuf / 2^(k+1)): m0 = half-res, each step halves again.
    const bloomMipW = (k) => Math.max(1, Math.ceil(drawBufW / 2 ** (k + 1)));
    const bloomMipH = (k) => Math.max(1, Math.ceil(drawBufH / 2 ** (k + 1)));
    const bloomMips = [];
    for (let k = 0; k < BLOOM_MIP_COUNT; k++) {
      bloomMips.push(allocator.create(`bloom.mip${k}`, describeBloomMip(bloomMipW(k), bloomMipH(k))));
    }
    const bloom = buildBloomMaterials({
      THREE,
      litTexture: sceneLit.texture,
      coreTexture: bloomMips[0].texture,
      atmoTexture: bloomMips[BLOOM_ATMO_TOP].texture,
      // Share envLight's outdoor-gate nodes (mask texture + rect uniforms), so the
      // clamp tracks a mask rebake and can never gate a different half of the map
      // than the sky light / grade do.
      outdoorsTexNode: envLight.outdoorsTexNode,
      uViewRect: envLight.uViewRect,
      uOutdoorsRect: envLight.uOutdoorsRect,
    });
    const bloomBrightQuad = new THREE.QuadMesh(bloom.brightMaterial);
    const bloomDownKarisQuad = new THREE.QuadMesh(bloom.downsampleKaris.material);
    const bloomDownQuad = new THREE.QuadMesh(bloom.downsample.material);
    const bloomUpQuad = new THREE.QuadMesh(bloom.upsampleMaterial);
    const bloomCompositeQuad = new THREE.QuadMesh(bloom.compositeMaterial);

    // THROTTLE (2026-07-20 v5; kept as a SECONDARY optimization after v6
    // removed the dominant cost — the extra render() call, see uiShadow's own
    // construction comment above and buildUiShadowVisibility's header). The
    // DOM read itself is still real, non-zero main-thread work: it is
    // `canvas.getBoundingClientRect()` +
    // `document.querySelectorAll` + one `getBoundingClientRect()` per open
    // window, all on the MAIN thread, every single frame. `getBoundingClient
    // Rect()` forces the browser to flush any pending layout (a synchronous
    // reflow) — in a live Foundry session (chat, combat tracker, animations
    // constantly touching the DOM) that flush is real, repeated work, and
    // Foundry v14's ApplicationV2 core chrome (sidebar/hotbar/players list)
    // ALSO carries the `.application` class the query matches, widening the
    // scan. A frame-count throttle (not a time-based one — `time/one-clock`
    // in tools/verify-structure.mjs reserves `performance.now()`/`Date.now()`
    // to core/frame-clock.js + diag/, and this file is already at its
    // grandfathered ratchet limit) skips the DOM read on most frames and
    // reuses the PREVIOUS scan's uniforms/count in between — window drag
    // motion still reads as smooth (the shadow catches up within a handful
    // of frames, imperceptible), while the reflow only happens 1/Nth as
    // often. Tunable via MapShine.setUiShadow({ scanEveryNFrames }).
    let _uiShadowFrameCounter = 0;

    /**
     * Read this frame's open, framed Foundry windows (ApplicationV2 `.application`
     * and legacy `.app.window-app`, both identified by a direct-child
     * `.window-header` — which excludes docked UI like the sidebar), map each to
     * a shadow stamp, and push them into `uiShadow`'s uniforms (consumed every
     * frame by the composite shader's `visNode` multiply — v6: there is no
     * longer a separate draw to skip, so correctness now depends on this
     * function actively clearing the uniforms when disabled, not merely on the
     * caller declining to render). Records detected/active counts on
     * `_uiShadowState` so the debug report can prove it is finding windows
     * (never a silent no-op). On a throttled (skipped) frame, the uniforms are
     * left untouched — the composite keeps using the most recent known window
     * positions rather than flickering off.
     * @returns {number}
     */
    function updateUiShadowStamps() {
      if (!_uiShadowState.enabled || !canvas) {
        _uiShadowState.lastWindowCount = 0;
        _uiShadowState.lastStampCount = 0;
        _uiShadowFrameCounter = 0;
        // MUST clear explicitly now (v6): visNode is always evaluated by the
        // composite shader, so stale non-zero uniforms from before a disable
        // would keep casting a shadow forever — there's no draw-skip to hide it.
        uiShadow.setStamps([]);
        return 0;
      }
      _uiShadowFrameCounter++;
      const interval = Math.max(1, Math.round(_uiShadowState.scanEveryNFrames));
      // -1 so the FIRST call (counter becomes 1) always scans immediately —
      // no delay when the feature is freshly enabled or a window just opened.
      if ((_uiShadowFrameCounter - 1) % interval !== 0) {
        return _uiShadowState.lastStampCount;
      }
      const canvasRect = canvas.getBoundingClientRect();
      uiShadow.setResolution(canvasRect.width, canvasRect.height);
      uiShadow.setFlipY(_uiShadowState.flipY);
      const light = {
        azimuthDeg: _uiShadowState.azimuthDeg,
        elevationDeg: _uiShadowState.elevationDeg,
        heightPx: _uiShadowState.heightPx,
      };
      const opts = {
        strength01: _uiShadowState.strength01,
        baseSoftnessPx: _uiShadowState.baseSoftnessPx,
        maxOffsetPx: _uiShadowState.maxOffsetPx,
        offsetScale: _uiShadowState.offsetScale,
      };
      const stamps = [];
      let detected = 0;
      const els = document.querySelectorAll('.application, .app.window-app');
      for (const el of els) {
        // Only floating, framed windows (a title bar to grab) — not docked apps.
        if (!el.querySelector(':scope > .window-header')) continue;
        if (el.classList.contains('minimized')) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        detected++;
        if (stamps.length >= MAX_UI_SHADOW_STAMPS) continue; // count all, cast the first N
        stamps.push(
          mapWindowRectToStamp(
            { left: r.left, top: r.top, width: r.width, height: r.height },
            { left: canvasRect.left, top: canvasRect.top, width: canvasRect.width, height: canvasRect.height },
            light,
            opts
          )
        );
      }
      uiShadow.setStamps(stamps);
      _uiShadowState.lastWindowCount = detected;
      _uiShadowState.lastStampCount = stamps.length;
      return stamps.length;
    }

    /** Re-assert the light pass's samplers after a resize. Belt-and-braces:
     * RenderTarget#setSize mutates textures IN PLACE (see rebindPresent /
     * onResize), so the nodes already point at the right objects; this only
     * flags needsUpdate, matching how rebindPresent behaves. */
    function rebindLighting() {
      envLight.albedoTexNode.value = sceneColor.texture;
      envLight.illumTexNode.value = sceneIllum.texture;
      envLight.colorationTexNode.value = sceneColoration.texture;
      envLight.illumMaterial.needsUpdate = true;
      envLight.compositeMaterial.needsUpdate = true;
    }

    // ========================================================================
    // light.accumulate — POINT LIGHTS, illumination only (increment 2a,
    // 2026-07-18). See effects/lighting/point-light-illumination.js's own
    // header for the full model (switchColor/falloff/MAX-blend) and its
    // documented tier-0 gaps (no soft edge, no elevation occlusion, no
    // coloration/darkness/animations/global-light-window).
    // ========================================================================

    /** THE ONE SHARED ANIMATION-CLOCK UNIFORM (2026-07-20, WebGPU-performance
     * rework: "let's not leave any CPU stuff in if we can avoid it" —
     * light-animation-clock.js's own header has the full mechanism). Every
     * animated light's illumination/coloration material reads THIS SAME
     * uniform node (shared, like uBackgroundColor/uDimColor/uBrightColor
     * already are — an established pattern, not a new one) to compute its
     * OWN `time` in-shader; written ONCE per frame (inside `pointLights.
     * update()` below), never per-light — replaces what used to be a
     * `computeAnimationTime` JS call PER ANIMATED LIGHT PER FRAME.
     *
     * Declared here (rather than staying where it used to sit, deeper in this
     * section) because `pointLights`, just below, needs it to already exist:
     * it is taken as a plain VALUE (never reassigned — only `.value` is
     * written), and this node is read by roughly a dozen OTHER consumers well
     * beyond point lights (wind sim, vegetation motion, several TSL light-
     * animation builders) — see `point-light-pool.js`'s own header for why it
     * deliberately did NOT move into that module alongside its one writer. */
    const uGlobalTimeMs = THREE.TSL.uniform(THREE.TSL.float(0));

    /**
     * THE POINT-LIGHT POOL (extraction step 3 of docs/planning/VT-Pan-Viewer-
     * Extraction.md) — the mesh pool, its two dedicated scenes, the candle
     * wall-clip cache, and the per-frame reconcile, all in
     * effects/lighting/point-light-pool.js. Constructed HERE because
     * `envLight`/`sunShadows`/`sceneColor` already exist at this point in the
     * file (all `const`, never reassigned — safe to pass as plain values;
     * each subsystem reads `.texture`/`.uSunShadowRect` live at its own use
     * point, same as the pre-extraction code did).
     *
     * ⚠️ `getWindHandle` is a GETTER, not `windHandle` itself: `windHandle`
     * is declared with `let` FURTHER DOWN in this function and reassigned on
     * every rebake. Referencing it here inside an arrow function is safe —
     * the closure captures the BINDING, and the arrow function is not
     * INVOKED until `pointLights.update()` runs from the frame loop, long
     * after `let windHandle = createWindHandle();` has executed. The exact
     * same TDZ-safe pattern `sun-shadow-subsystem.js`'s `getEnvLight` uses for
     * the mirror-image case (constructed before `envLight` exists).
     *
     * `uGlobalTimeMs` is passed in as a plain value (declared just below,
     * before `pointLights` is ever USED, only after it is CONSTRUCTED — see
     * that uniform's own declaration for why it stays a viewer-level
     * primitive rather than moving into this pool).
     */
    const pointLights = createPointLightPool({
      THREE,
      getWindHandle: () => windHandle,
      envLight,
      sunShadows,
      sceneColor,
      getCandleRenderState,
      uGlobalTimeMs,
    });

    // ------------------------------------------------------------------
    // Region-driven darkness ("Adjust Darkness Level" behavior, 2026-07-19)
    // ------------------------------------------------------------------
    //
    // See effects/lighting/region-darkness.js's own header for the mechanism
    // (a per-shape bounding quad + an analytic per-fragment containment test
    // against positionWorld, discard()ing outside it), its named scope
    // limitations (union-not-CSG, missing cone/ring/line/emanation shapes —
    // both real, one-click Foundry authoring features, not edge cases), and
    // the 2026-07-19 corrections (elevation-band gated, min-composite
    // overlap resolution) implemented in updateRegionDarknessMeshes below.

    /** A tiny dedicated Scene for region-darkness meshes — rendered AFTER the
     * ambient fill, BEFORE point lights, so a region's own mode/modifier can
     * OVERWRITE the ambient floor within its footprint (point lights then
     * MAX-blend on top of the RESULT, same as always). */
    const regionScene = new THREE.Scene();

    /** ONE shared unit quad — every region mesh (rectangle/ellipse/polygon
     * alike) tests containment analytically against `positionWorld` in its
     * OWN fragment shader, so the mesh's local geometry never needs to
     * match the true shape; a single reusable `PlaneGeometry(1,1)`, scaled/
     * positioned per shape, is exactly enough — unlike lightMeshes below,
     * NO per-instance geometry, so none of that pool's BufferAttribute-
     * churn concern applies here at all. */
    const regionQuadGeometry = new THREE.PlaneGeometry(1, 1);

    /** The RAW ambient endpoints (NOT the pre-mixed background) every region
     * material re-mixes by its OWN per-fragment adjusted darkness — shared,
     * updated once per frame. (Point lights used to share an analogous
     * uLightBackgroundColor/uDim/uBright trio; those are now PER-LIGHT, not
     * shared — see `updatePointLightMeshes`'s own header, 2026-07-19.) */
    const uRegionDaylightColor = THREE.TSL.uniform(THREE.TSL.vec3(0.93, 0.93, 0.93));
    const uRegionDarknessColor = THREE.TSL.uniform(THREE.TSL.vec3(0.14, 0.14, 0.28));

    /** `${regionId}:${shapeIndex}` -> { mesh, material, kind, uMode,
     * uModifier, uBaseDarkness01, ...kind-specific uniforms }. Reconciled
     * every frame in updateRegionDarknessMeshes; same hide-not-dispose
     * lifecycle gap lightMeshes documents (a region genuinely deleted is
     * only hidden, full cleanup needs a deleteRegion hook — not built this
     * cut, bounded leak: grows with distinct darkness-regions ever seen). */
    const regionMeshes = new Map();

    /**
     * Reconcile the region-darkness mesh pool against this frame's live
     * darkness-adjusting regions.
     *
     * OVERLAP RESOLUTION — CORRECTED (2026-07-19). `renderOrder` used to be a
     * bare incrementing counter in `readActiveDarknessRegions`' own iteration
     * order, on the (checked-and-found-WRONG) assumption that Foundry
     * resolves overlaps by "last one wins". Verified against source instead:
     * `illumination-effects.mjs#invalidateDarknessLevelContainer` sorts
     * region meshes by their OWN adjusted darkness level, DESCENDING, so the
     * region computing the LOWEST (brightest) value draws LAST and wins via
     * a plain opaque overwrite — "the final darkness level at a point is the
     * minimum of the adjusted darkness levels" (that file's own comment).
     * This function reproduces that exactly: compute each active region's
     * own adjusted-darkness value once (mode/modifier are per-region, and
     * `darkness01` is the same base for all of them — see
     * `computeRegionAdjustedDarkness`'s own doc for why this is safe to
     * evaluate independently, not chained), sort descending, THEN assign
     * `renderOrder` in that sorted order — never leaving it to THREE's own
     * incidental draw order for `depthTest:false` objects, since order
     * genuinely determines the result here (unlike the point-lights' own
     * MAX-blend, which is commutative and order-independent).
     *
     * ELEVATION GATING (2026-07-19, the multi-floor darkness fix). Real
     * Foundry gates this whole behavior by the region's own `elevation.
     * {bottom,top}` against a per-pixel depth mask (`adjust-darkness-
     * level.mjs`'s shader `_preRender`, verified against source) — MSA
     * ignored this entirely before now, so a region authored for one floor
     * darkened every floor. Filters to regions whose elevation range
     * overlaps the CURRENTLY VIEWED floor's own band (read live each frame,
     * matching this function's existing "read live Foundry state every
     * frame" posture) — a per-FLOOR approximation of Foundry's per-PIXEL
     * test, architecturally honest for a floor-based viewer. An unrestricted
     * region (elevation left untouched — the common case) passes this for
     * every floor, so ordinary regions are completely unaffected.
     */
    /**
     * Read + elevation-filter this frame's darkness-adjusting regions ONCE —
     * shared by `updateRegionDarknessMeshes` (draws them) AND
     * `updatePointLightMeshes` (2026-07-19: a light needs to know the SAME
     * active-region set to compute its own LOCAL region-adjusted ambient
     * floor — see that function's own header for why). Extracted rather
     * than each caller re-reading/re-filtering independently, so the two
     * can never see a different active-region set within the same frame.
     * @returns {{regions: object[], currentFloor: object|null}} elevation-
     *   filtered active regions, PLUS the same `currentFloor` descriptor this
     *   function already derives internally — 2026-07-20, widened (was
     *   `regions` alone) so `updatePointLightMeshes` can reuse the IDENTICAL
     *   floor lookup for candle wall-clipping (see that function's own
     *   `currentFloor.id`-consuming code) rather than a second, potentially
     *   drifting `getActiveSceneFloors` call — same "read once, shared by
     *   both" reasoning as this function's own header already states for
     *   `activeRegions`.
     */
    function readElevationFilteredDarknessRegions() {
      const { regions } = readActiveDarknessRegions();

      // getActiveSceneFloors was designed for boot.js's own scene-load/
      // floor-switch call sites, not a per-frame hot path — wrapped here
      // (unlike its other callers) because a throw reaching this function
      // would crash light.accumulate for the WHOLE frame, not just this one
      // reader. Falls back to "no floor identified" (unrestricted band, every
      // region stays active) on any failure — fail open, never a black frame.
      let currentFloor = null;
      try {
        // `globalThis.canvas`, NOT the bare `canvas` identifier (2026-07-23,
        // ROOT-CAUSE FIX): this file declares its OWN local `let canvas` for
        // the WebGPU render surface's DOM element (this function's own
        // enclosing scope, see that declaration's header) — every bare
        // `canvas` reference inside this closure resolves to THAT DOM
        // element, never Foundry's global, so `canvas?.scene` was silently
        // always `undefined` and this lookup ALWAYS fell to "no floor
        // identified" regardless of scene/floor state. The established fix
        // for exactly this shadow already exists elsewhere in this SAME file
        // (`followFoundryCamera`'s `globalThis.canvas?.stage`) — this
        // function and bakeWindField's own floor lookup just predated/missed
        // that convention. `globalThis.canvas` bypasses the local shadow
        // entirely and needs no `typeof` guard (a property read, unlike a
        // bare identifier, never throws when unset).
        const sceneDoc = globalThis.canvas?.scene ?? null;
        const floorsResult = getActiveSceneFloors(sceneDoc);
        currentFloor = floorsResult.ok ? floorsResult.floors.find((f) => f.index === view.floorIndex) : null;
      } catch (err) {
        log.error('region-darkness elevation lookup (getActiveSceneFloors) failed — treating as unrestricted:', err);
      }
      // A floor we couldn't identify (no active scene, or the index isn't in
      // this frame's floor list) reads as unrestricted — fail OPEN (every
      // region still active), never silently darkness-mute the whole scene
      // because a floor lookup came up empty this one frame.
      const floorBottom = currentFloor?.elevationBottom ?? null;
      const floorTop = currentFloor?.elevationTop ?? null;
      const filtered = regions.filter((region) =>
        regionOverlapsElevationBand(region.elevationBottom, region.elevationTop, floorBottom, floorTop)
      );
      // ⚠️ THE GATING DECISION, RECORDED (2026-07-26). "15 of 15 regions active"
      // reads identically whether every region genuinely belongs to this floor's
      // band or the floor lookup returned null and the filter FAILED OPEN — and
      // fail-open is exactly how an upper floor's building-shaped darkness ends
      // up painted on the ground floor, looking for all the world like a shadow
      // bug. Two states, one number, no way to tell them apart: the same
      // instrument gap that hid sky-reach for three rounds
      // (feedback_instruments_must_not_lie).
      lastRegionGating = {
        floorIndex: view?.floorIndex ?? null,
        floorBand: { bottom: floorBottom, top: floorTop },
        failedOpen: floorBottom === null && floorTop === null,
        total: regions.length,
        kept: filtered.length,
        dropped: regions.length - filtered.length,
        bands: regions.map((r) => ({
          key: r.key,
          bottom: r.elevationBottom ?? null,
          top: r.elevationTop ?? null,
          kept: regionOverlapsElevationBand(r.elevationBottom, r.elevationTop, floorBottom, floorTop),
        })),
      };
      return { regions: filtered, currentFloor };
    }
    /** The last elevation-gating decision, verbatim — see its assignment above. */
    let lastRegionGating = null;

    function updateRegionDarknessMeshes(darkness01, activeRegions) {
      const sortedByBrightestLast = activeRegions
        .map((region) => ({ region, adjusted: applyDarknessAdjustment(darkness01, region.mode, region.modifier) }))
        .sort((a, b) => b.adjusted - a.adjusted);

      const seen = new Set();
      let renderOrder = 0;

      /**
       * Reconcile/update ONE shape's mesh. Shared by both passes below — a
       * hole shape uses the exact same kind-dispatch/mesh-pooling machinery
       * as an ordinary shape, just with `uMode`/`uModifier` overridden by
       * the caller (see the hole pass' own comment for why that override is
       * an exact identity, not an approximation).
       */
      function renderRegionShape(region, shape, shapeIndex, uMode, uModifier) {
        const bounds = computeShapeMeshBounds(shape);
        if (!bounds) return; // unsupported/degenerate shape — never a mesh, matches pointInRegionShapes' own skip.
        // A circle reuses the ellipse material (radiusX=radiusY=radius).
        // An emanation reuses whichever material matches its OWN base
        // shape's type — computeShapeMeshBounds already guaranteed the
        // base is one of these 4 supported types, or `bounds` would be
        // null and this shape would already have been skipped above.
        const kind =
          shape.type === 'circle'
            ? 'ellipse'
            : shape.type === 'emanation'
              ? shape.base.type === 'rectangle'
                ? 'emanation-rectangle'
                : shape.base.type === 'polygon'
                  ? 'emanation-polygon'
                  : 'emanation-ellipse' // circle or ellipse base
              : shape.type;
        const key = `${region.regionId}:${shapeIndex}`;
        seen.add(key);
        let entry = regionMeshes.get(key);
        if (!entry || entry.kind !== kind) {
          // A shape's TYPE changing under the same id/index is not a real
          // Foundry event (shapes are not retyped in place), handled
          // anyway — same defensive posture as lightMeshes' own reconcile.
          if (entry) {
            entry.mesh.removeFromParent();
            entry.material.dispose();
          }
          const commonArgs = { THREE, uDaylightColor: uRegionDaylightColor, uDarknessColor: uRegionDarknessColor };
          const buildMaterial = REGION_MATERIAL_BUILDERS[kind];
          const built = buildMaterial(commonArgs);
          const mesh = new THREE.Mesh(regionQuadGeometry, built.material);
          mesh.frustumCulled = false;
          regionScene.add(mesh);
          entry = { mesh, kind, ...built };
          regionMeshes.set(key, entry);
        }
        entry.mesh.position.set(bounds.cx, bounds.cy, 0);
        entry.mesh.scale.set(bounds.halfWidth * 2, bounds.halfHeight * 2, 1);
        entry.mesh.visible = true;
        entry.mesh.renderOrder = renderOrder++;
        entry.uMode.value = uMode;
        entry.uModifier.value = uModifier;
        entry.uBaseDarkness01.value = darkness01;
        if (kind === 'rectangle') {
          entry.uOrigin.value.set(shape.x ?? 0, shape.y ?? 0);
          entry.uSize.value.set(shape.width ?? 0, shape.height ?? 0);
          entry.uAnchor.value.set(shape.anchorX ?? 0, shape.anchorY ?? 0);
          entry.uRotationRad.value = ((shape.rotation ?? 0) * Math.PI) / 180;
        } else if (kind === 'ellipse') {
          entry.uOrigin.value.set(shape.x ?? 0, shape.y ?? 0);
          const radiusX = shape.type === 'circle' ? shape.radius : shape.radiusX;
          const radiusY = shape.type === 'circle' ? shape.radius : shape.radiusY;
          entry.uRadii.value.set(radiusX ?? 0, radiusY ?? 0);
          entry.uRotationRad.value = ((shape.rotation ?? 0) * Math.PI) / 180;
        } else if (kind === 'polygon') {
          entry.uPointCount.value = writeRegionPolygonPoints(shape.points, entry.points);
        } else if (kind === 'cone') {
          entry.uOrigin.value.set(shape.x ?? 0, shape.y ?? 0);
          entry.uRadius.value = shape.radius ?? 0;
          const angleDeg = shape.angle ?? 0;
          entry.uFullCircle.value = angleDeg >= 360;
          // half-angle in radians — clamped to [0,360] before halving so a
          // malformed >360 authored value can't overshoot; harmless either
          // way since uFullCircle already short-circuits the angle test at
          // >=360, this just keeps the uniform itself a sane number.
          entry.uHalfAngleRad.value = (Math.min(Math.max(angleDeg, 0), 360) * Math.PI) / 360;
          entry.uRotationRad.value = ((shape.rotation ?? 0) * Math.PI) / 180;
        } else if (kind === 'ring') {
          entry.uOrigin.value.set(shape.x ?? 0, shape.y ?? 0);
          const radius = shape.radius ?? 0;
          entry.uInnerRadius.value = Math.max(0, radius - (shape.innerWidth ?? 0));
          entry.uOuterRadius.value = radius + (shape.outerWidth ?? 0);
        } else if (kind === 'line') {
          entry.uOrigin.value.set(shape.x ?? 0, shape.y ?? 0);
          entry.uLength.value = shape.length ?? 0;
          entry.uWidth.value = shape.width ?? 0;
          entry.uRotationRad.value = ((shape.rotation ?? 0) * Math.PI) / 180;
        } else if (kind === 'emanation-ellipse') {
          // Reuses buildRegionEllipseMaterial's own uOrigin/uRadii/
          // uRotationRad — the SAME uniform names, just fed the BASE
          // shape's own radii pre-grown by the emanation's radius (a
          // circle/ellipse's true Minkowski sum with a disk IS exactly a
          // bigger circle/ellipse for a circular base, and this file's own
          // documented approximation for an ellipse base — see
          // pointInEmanation's own doc for the exactness caveat).
          const base = shape.base;
          const growRadius = Math.max(0, shape.radius ?? 0);
          entry.uOrigin.value.set(base.x ?? 0, base.y ?? 0);
          const baseRadiusX = base.type === 'circle' ? base.radius : base.radiusX;
          const baseRadiusY = base.type === 'circle' ? base.radius : base.radiusY;
          entry.uRadii.value.set((baseRadiusX ?? 0) + growRadius, (baseRadiusY ?? 0) + growRadius);
          entry.uRotationRad.value = ((base.rotation ?? 0) * Math.PI) / 180;
        } else if (kind === 'emanation-rectangle') {
          const base = shape.base;
          entry.uOrigin.value.set(base.x ?? 0, base.y ?? 0);
          entry.uSize.value.set(base.width ?? 0, base.height ?? 0);
          entry.uAnchor.value.set(base.anchorX ?? 0, base.anchorY ?? 0);
          entry.uRotationRad.value = ((base.rotation ?? 0) * Math.PI) / 180;
          entry.uGrowRadius.value = Math.max(0, shape.radius ?? 0);
        } else if (kind === 'emanation-polygon') {
          const base = shape.base;
          entry.uPointCount.value = writeRegionPolygonPoints(base.points, entry.points);
          entry.uGrowRadius.value = Math.max(0, shape.radius ?? 0);
        }
      }

      // Pass 1: every NON-hole shape, in brightest-region-first order — same
      // behaviour as before this shape gained hole support at all.
      for (const { region } of sortedByBrightestLast) {
        const shapes = Array.isArray(region.shapes) ? region.shapes : [];
        for (let shapeIndex = 0; shapeIndex < shapes.length; shapeIndex++) {
          const shape = shapes[shapeIndex];
          if (shape?.hole) continue; // holes render in pass 2, below.
          renderRegionShape(region, shape, shapeIndex, region.mode, region.modifier);
        }
      }
      // Pass 2: every hole shape, drawn AFTER every non-hole shape across
      // EVERY region (renderOrder keeps counting up from wherever pass 1
      // left off) — so a hole always wins the overlap and reveals the raw
      // ambient floor, regardless of which region authored it or how the
      // regions themselves were sorted by brightness above. This sidesteps
      // real Foundry's exact ClipperLib per-region hole/non-hole run
      // ordering (`client/documents/region.mjs#_createClipperPolyTree`) in
      // favour of a simpler global rule — see region-darkness.js's own
      // module header for the documented trade-off.
      //
      // Reuses the SAME mesh-pooling/kind-dispatch machinery as an ordinary
      // shape — a hole needs no new shader material at all. Overriding
      // uMode=BRIGHTEN, uModifier=0 makes computeRegionColor's own formula
      // collapse to an EXACT identity (`applyDarknessAdjustment`'s own
      // BRIGHTEN case is `base*(1-0) = base`), so the hole mesh paints the
      // scene's raw ambient colour back over whatever the non-hole pass
      // drew underneath it.
      for (const { region } of sortedByBrightestLast) {
        const shapes = Array.isArray(region.shapes) ? region.shapes : [];
        for (let shapeIndex = 0; shapeIndex < shapes.length; shapeIndex++) {
          const shape = shapes[shapeIndex];
          if (!shape?.hole) continue;
          renderRegionShape(region, shape, shapeIndex, DARKNESS_ADJUST_MODES.BRIGHTEN, 0);
        }
      }

      for (const [key, entry] of regionMeshes) {
        if (!seen.has(key)) entry.mesh.visible = false;
      }
    }

    // (lightMeshes/candleWallClipCache moved into point-light-pool.js
    // alongside updatePointLightMeshes — see the pointer comment above
    // `colorationScene`'s old declaration. Exposed as `pointLights.
    // lightMeshes`/`.candleWallClipCache` for the external readers below.
    // uGlobalTimeMs itself moved UP, before `pointLights`'s own construction
    // — it must already be a real object at that point, since it is passed
    // in as a plain VALUE there, not a lazy getter like windHandle.)

    /** The last-applied ambient colours (background/dim/bright) — tracked
     * for getPointLightsInfo() so the diagnostic reports what was ACTUALLY
     * used, not a recomputed guess (feedback_instruments_must_not_lie). */
    let lastAmbientColors = null;
    /** The last-computed global-illumination floor (null = not active this
     * frame) — same "report what was actually used" reasoning. */
    let lastGlobalLightFloor = null;
    /** The last-read grid size (px/square) — tracked for the SAME reason as
     * lastAmbientColors, specifically to let getPointLightsInfo() report the
     * ACTUAL number feeding computeEdgeSoftMarginNormalized, not a guess. */
    let lastGridSizePixels = null;

    // (updatePointLightMeshes moved to effects/lighting/point-light-
    // pool.js as `pointLights.update(...)` — extraction step 3. Called
    // from the render loop below in the exact same spot.)

    // ------------------------------------------------------------------
    // THE WIND FIELD BAKE (2026-07-22, THE RETHINK — docs/planning/
    // Wind-Rethink.md §4). world/wind-bake.js + world/wind-enclosure.js own
    // the pure math (rasterize walls, flood-fill for openness) — this is
    // just getting it real Foundry wall data and a real GPU destination.
    // Baked ONCE (on the viewer starting, a wall/door change, or the manual
    // "Rebake" debug action — NOT per frame; a flood-fill over a few
    // thousand cells is cheap but still real CPU work no render frame should
    // ever pay for). The live ambient DIRECTION/SPEED (uWindDirectionDeg/
    // uWindSpeed01) is a SEPARATE, per-frame-cheap uniform pair the candle/
    // overlay materials read directly — changing it updates the moving noise
    // instantly; `openness` only changes when geometry does, via a rebake.
    // ------------------------------------------------------------------
    const uWindDirectionDeg = THREE.TSL.uniform(THREE.TSL.float(0));
    const uWindSpeed01 = THREE.TSL.uniform(THREE.TSL.float(0));
    /**
     * THE WIND HANDLE (world/wind-access.js, Wind.md §5.1) — the ONE object
     * every wind consumer receives. Rebuilt (never mutated) by `bakeWindField`
     * below; see its construction site for what goes in.
     *
     * Starts as a BAKE-LESS handle rather than `null`: a consumer constructed
     * before the first bake (or in a scene where the bake never runs) still
     * gets the organic gust/flutter field, exactly as it did when every
     * optional `sampleWind` argument was simply omitted — degrade to "no baked
     * structure", never to "no wind" and never to a crash. That also means no
     * consumer needs a null check of its own.
     *
     * This replaces three separate closure locals (`windBakedField`,
     * `windWallAvoidField`, `windLiveField`) that four call sites each had to
     * forward correctly and by hand. `wind/handle-only` (tools/verify-structure
     * .mjs) now fails the build if anything outside world/ names them again.
     */
    let windHandle = createWindHandle();
    /** Incremented on every bake — a consumer holding derived state (a built
     * material, an uploaded storage buffer) compares against the version it
     * built with. This is the mechanical fix for the class of bug where a mesh
     * kept a material whose baked texture was frozen at the startup bake
     * forever (see this file's own `updateWindFieldOverlay` for the hand-found
     * instance that motivated it). */
    let windHandleVersion = 0;
    /** The two baked wind DataTextures, kept only so the NEXT bake can dispose
     * them (the handle hands them out but does not own their lifetime — a
     * frozen value object has no dispose step, and inventing one would give the
     * handle a second responsibility it does not need). Null until the first
     * bake. */
    let bakedOpennessTexture = null;
    let bakedWallAvoidTexture = null;
    // NOTE — the raw per-cell arrays (`solid`/`openness`/wall-avoidance) used to
    // live here as their own closure local, pushed to each consumer separately.
    // They are now `windHandle.cells` (2026-07-23, Wind.md §5.1): ONE
    // geometry-derived grid (2026-07-22, THE RETHINK, Wind-Rethink.md §4) that
    // already replaced FIVE separate ones, finally travelling with the rest of
    // the field instead of beside it. `openness` is
    // `world/wind-enclosure.js#floodFillOpenFromBoundary`'s output downsampled
    // to this resolution — 1 where a cell reaches the map's open exterior
    // through open space (walls/doors only), 0 where sealed; `solid` is the
    // coarse wall rasterization, kept for the wind+particle probe's display
    // (Tier 2's `windSolidMaskTexture` below rasterizes its own, more
    // conservative mask independently — untouched by that rethink). The
    // particle engines read these as a STORAGE BUFFER rather than trusting a
    // texture sample inside a compute shader, a path never verified in this
    // renderer (the retired compute spike proved storage buffers, not textures).

    // THE MASK-DRIVEN WIND REBAKE TRIGGER (2026-07-21). Root cause of a real,
    // author-reported bug: `bakeWindField('startup')` runs synchronously very
    // early — before the outdoors mask has any realistic chance to have
    // streamed in through the async VT page-decode pipeline (mask-authority's
    // own header: "STALENESS IS LAZY, NOT SCHEDULED... products recompute on
    // the NEXT READ" — a PULL model, no push notification exists to wire
    // into). The four PRE-EXISTING rebake reasons ('startup'/'manual'/
    // 'wall:*'/'ambient-change') never included "the mask data changed" —
    // that dependency was simply never wired, so a wind-exposure snapshot
    // baked before real mask content arrived stayed WRONG for the entire
    // session, in a room that was correctly, unambiguously painted (memory:
    // keyhole-wind-wake-turbulence's own addendum — this is the fix for the
    // root cause it diagnosed). THROTTLED, not per-frame: mask-authority's
    // own `version` bumps on every ingested page (there can be dozens during
    // a scene's initial decode burst), and re-running the ~64-iteration
    // relaxation on every single one would visibly cost real time during
    // exactly the moment the app is already busiest. Polling a plain integer
    // (`getMaskAuthorityVersion()`) is essentially free; the THROTTLE bounds
    // how often a detected change actually triggers the (cheap-but-not-free)
    // rebake, not how often it's checked.
    const MASK_VERSION_POLL_INTERVAL_MS = 500;
    let lastMaskVersionPollMs = -Infinity;
    let lastSeenMaskVersion = null;

    /**
     * Called once per frame (see renderFrame): if enough wall-clock time has
     * passed AND mask-authority's own version counter has moved since the
     * last bake, rebake the wind field — the mask-driven analogue of the
     * existing wall/door-change auto-rebake, closing the ONE gap that watcher
     * never covered.
     * @param {number} nowMs - the shared clock's own tMs (never a fresh
     *   `performance.now()` — core/frame-clock.js is the one clock).
     */
    function pollMaskAuthorityForWindRebake(nowMs) {
      if (nowMs - lastMaskVersionPollMs < MASK_VERSION_POLL_INTERVAL_MS) return;
      lastMaskVersionPollMs = nowMs;
      const v = getMaskAuthorityVersion();
      if (v == null) return; // unwired (torture fixture) — inert, never bakes
      if (lastSeenMaskVersion === null) {
        lastSeenMaskVersion = v;
        // FIRST OBSERVATION — nothing to compare for the WIND (which wants a
        // change), but the SKY wants the mask itself, and this is the earliest
        // moment one is known to exist. Baking here is what stops the sky gate
        // sitting on its 1×1 placeholder until something unrelated happens to
        // edit a mask. The wind's own "not a change, don't rebake" reasoning is
        // unaffected and unchanged.
        bakeOutdoorsTexture(view?.floorIndex ?? 0);
        return;
      }
      if (v === lastSeenMaskVersion) return;
      lastSeenMaskVersion = v;
      bakeWindField('mask-change');
      // The sky's gate is derived from the same masks, so it goes stale at
      // exactly the same moments. One trigger, two bakes — never two polls that
      // could drift into disagreeing about which mask version is current.
      bakeOutdoorsTexture(view?.floorIndex ?? 0);
    }

    // ------------------------------------------------------------------
    // WIND.MD TIER 2 — THE TRANSIENT SIM (world/wind-sim.js + wind-sim-gpu.js).
    // D_live: ping-pong render targets holding the CURRENT transient, plus a
    // THIRD, STABLE "published" target every consumer binds to ONCE (see
    // wind-sim-gpu.js#buildWindPublishMaterial's own header for why a
    // ping-pong texture identity cannot be baked into a dozen consumer
    // shader graphs the way `bakedField` is). All (re)allocated together in
    // bakeWindField()'s regrid branch — cols/rows only ever change with the
    // scene/grid-size, the SAME rare event that already forces a Tier 1
    // rebake, never per frame.
    // ------------------------------------------------------------------
    let windSolidMaskTexture = null; // R8-ish DataTexture, NEAREST filtered, 1=solid
    let windSimGridKey = null; // `${cols}x${rows}` — when this changes, the RTs below get reallocated
    let windPingRT = null;
    let windPongRT = null;
    let windPublishRT = null;
    let windSimMaterials = null; // { advectDissipate, splat, relax, publish, dispose() } | null (rebuilt lazily)
    let windPingIsCurrent = true; // which of ping/pong currently holds the LATEST D_live
    let windThawUntilMs = 0; // sim ticks while nowMs < this; frozen otherwise
    let windIsThawed = false; // tracked explicitly so the freeze<->thaw transition logs exactly once each way
    let windForceThaw = false; // debug/perf-lab override — see setVtPanViewerWindForceThaw
    /** @type {import('../world/index.js').WindContributor[]} */
    let windActiveImpulses = []; // oneShot contributors (doors, test gusts), pruned each tick

    /**
     * Read walls, rasterize, relax, upload — see this block's own header.
     * NOT per-floor scoped yet (`readSceneWallSegments(null)` reads every
     * wall regardless of level) — a deliberate, honest simplification for
     * this first cut (see `scene-wall-clip.js`'s own per-floor precedent
     * for the natural follow-up), not a silent gap: most scenes have no
     * per-floor wall scoping at all, and a wrongly-included wall from
     * another floor just over-blocks the bake slightly, never crashes it.
     * Never throws — a bake failure logs and leaves the PREVIOUS bake (or
     * none) in place, exactly like every other "read live Foundry state"
     * step in this file.
     *
     * @param {string} [reason] - WHY this bake ran ('manual' | 'ambient-change'
     *   | 'wall:createWall' | 'wall:updateWall' | 'wall:deleteWall' |
     *   'mask-change' — a mask-authority version bump, throttled via
     *   `pollMaskAuthorityForWindRebake`; see that function's own header for
     *   the bug this closes | 'floor-change' — `setFloorIndex` re-baking so
     *   the per-floor wall scoping below never goes stale across a floor
     *   switch, see that function's own header for the bug this closes)
     *   — stamped into the log line only, so opening a
     *   door in a live Foundry session shows up as its OWN log entry distinct
     *   from a manual Rebake click or
     *   an ambient-dial change. An instrument that only ever says "baked",
     *   never "baked BECAUSE", can't prove the auto-invalidation hook (boot.js)
     *   actually fired versus the author coincidentally having clicked Rebake
     *   moments earlier (feedback_instruments_must_not_lie).
     */
    function bakeWindField(reason = 'manual') {
      try {
        const gridSizePixels = readGridSizePixels().gridSizePixels;
        // CONSUMPTION-RESOLUTION grid — what the particle/gust storage
        // buffers and the sampleWind texture actually sample.
        //
        // BOUNDED TO THE REAL SCENE RECT, NOT THE PADDED CANVAS (2026-07-23,
        // author: "Don't render the wind particles or the overlay outside of
        // the scene... We need the grid to align with the grid of the actual
        // scene too"). This was previously `sceneX:0, sceneY:0, sceneWidth:
        // dimensions.width, sceneHeight: dimensions.height` — `dimensions.
        // width`/`.height` are `foundry/scene-geometry.js#computeSceneDimensions`'s
        // PADDED canvas size (`sceneWidth + 2×gridSnappedPadding`, that
        // module's own header: "the canvas is ~1.5× the art, and the art is
        // *inset* at `sceneRect`, not at the origin"), and `0,0` is the
        // padded rect's OWN corner, not the real map's. So the wind grid was
        // computing openness across the padding margin surrounding the map
        // too — walls/doors never exist out there, so it read as wide-open
        // exterior, and particles/the overlay happily filled it. FIX: origin
        // + extent now come from `dimensions.sceneX/sceneY/sceneWidth/
        // sceneHeight` — the REAL playable rect (`Scene#getDimensions()`'s
        // own `sceneRect`, replicated verbatim in `computeSceneDimensions`).
        // Bonus: `sceneX`/`sceneY` are `Math.ceil(padding×sceneWidth/
        // gridSize)×gridSize` minus `shiftX`/`shiftY` (that function's own
        // doc) — an exact multiple of Foundry's OWN grid square size on any
        // scene that hasn't been manually grid-shifted (`shiftX`/`shiftY`
        // default 0), so this origin lands ON a real Foundry grid line, same
        // phase as `cellSize` being an exact fraction of `gridSizePixels`
        // below — the wind grid's cell boundaries now coincide with the
        // map's own grid squares, not just its extent.
        //
        // RESOLUTION (2026-07-23, author: "make the wind resolution
        // higher") — QUARTERED (was HALVED): `gridSizePixels/4` so each
        // Foundry grid square gets a 4×4 sub-grid instead of 2×2, same
        // "narrow corridor still gets a real open centreline cell" reasoning
        // as the original halving, just finer. HONEST COST: this ~4×s the
        // consumption grid's own cell count (both axes double, same 512-cell
        // safety cap as before — a map whose long axis already exceeds ~128
        // true grid squares was ALREADY hitting that cap at the old /2 and
        // gets no finer here; the cap itself is intentionally untouched, a
        // deliberate ceiling on worst-case bake cost, not a bug), and the
        // FINE flood-fill grid below (OPENNESS_REFINE×) scales by the exact
        // same ~4× on top of that — a real, one-time-per-bake CPU cost
        // increase (wall/door/floor changes, never per-frame), traded
        // deliberately for the finer wind detail that was asked for.
        const gridSpec = computeWindBakeGridSpec({
          sceneX: dimensions.sceneX,
          sceneY: dimensions.sceneY,
          sceneWidth: dimensions.sceneWidth,
          sceneHeight: dimensions.sceneHeight,
          gridSizePixels: gridSizePixels / 4,
          maxAxisCells: 512,
        });
        // PER-FLOOR WALL SCOPING (2026-07-22, live author report: "reading
        // the wall from the floor above"). `readSceneWallSegments(null)`
        // used to read EVERY wall on the scene regardless of level — a
        // known, previously-documented simplification. On a multi-floor
        // scene, that means an UPPER floor's interior walls silently sealed
        // the GROUND floor's own openness computation, even on a ground
        // floor genuinely wall-free — exactly the "no walls at all, wind
        // still dies" report, except this time the dead-end was real wall
        // data from the wrong floor, not the painted mask. FIX: resolve the
        // CURRENTLY VIEWED floor's own Level id the SAME way candle
        // wall-clipping already does (`updatePointLightMeshes`'s own
        // `currentFloor.id`, sourced from `getActiveSceneFloors` matched
        // against `view.floorIndex` — `readElevationFilteredDarknessRegions`'s
        // own header has the full precedent), and scope the wall read to
        // it. `readSceneWallSegments`'s own `levelId` param already treats
        // an EMPTY `wall.levels` set as "applies to every floor" (Foundry's
        // own convention for an unscoped exterior/structural wall — those
        // still count everywhere); only a wall an author explicitly scoped
        // to ANOTHER floor is excluded now. Falls back to unscoped
        // (byte-identical to the prior behaviour) if the floor can't be
        // identified — never a harder failure than before this fix.
        let currentLevelIdForWind = null;
        // WHY the lookup landed where it did, not just what it returned —
        // (2026-07-23, live: LIVE TEST #3 showed `currentLevelIdForWind`
        // resolving to null on a FRESH LOAD, no floor switch involved, which
        // the floor-switch fix above cannot explain — see that memory entry
        // for the full trail). Every branch that can leave the id null now
        // names itself, so the NEXT log line says which of "getActiveScene
        // Floors failed", "view isn't set yet", or "no floor in the array
        // matched view.floorIndex" (and if the last one, lists what indices
        // WERE available) actually happened, instead of the caller having to
        // re-derive it by reading code again.
        let windLevelLookupDiag = 'resolved';
        try {
          // `globalThis.canvas`, NOT the bare `canvas` identifier — SAME
          // root-cause shadow as `readElevationFilteredDarknessRegions`
          // above (see that function's own comment for the full
          // explanation): this file's local `let canvas` (the WebGPU render
          // surface's DOM element) shadowed Foundry's global here too, which
          // is EXACTLY why `windLevelLookupDiag` kept reporting
          // "getActiveSceneFloors failed: no active scene" on a fresh load
          // with a real, open scene — `canvas?.scene` was reading the DOM
          // element's (nonexistent) `.scene`, never Foundry's actual scene.
          const sceneDocForWind = globalThis.canvas?.scene ?? null;
          const floorsResultForWind = getActiveSceneFloors(sceneDocForWind);
          if (!floorsResultForWind.ok) {
            windLevelLookupDiag = `getActiveSceneFloors failed: ${floorsResultForWind.error}`;
          } else if (!view) {
            windLevelLookupDiag = 'view is not set yet';
          } else {
            const currentFloorForWind = floorsResultForWind.floors.find((f) => f.index === view.floorIndex);
            if (!currentFloorForWind) {
              const available = floorsResultForWind.floors.map((f) => `${f.index}:${f.id}`).join(', ');
              windLevelLookupDiag = `no floor matched view.floorIndex=${view.floorIndex} — available: [${available}]`;
            } else {
              currentLevelIdForWind = currentFloorForWind.id ?? null;
            }
          }
        } catch (err) {
          windLevelLookupDiag = `threw: ${err?.message ?? err}`;
        }
        const walls = readSceneWallSegments(currentLevelIdForWind);
        // TOTAL (unscoped) wall count, purely for the diagnostics line below
        // (2026-07-23 — this bake's own scoping was hard to trust from the
        // log alone: "N wall segments" never said whether N was ALREADY the
        // filtered count or the whole scene, so a scoping failure that
        // silently fell back to unscoped was indistinguishable from correct
        // scoping that simply found few walls on this floor. Reading
        // `walls.length` next to the RAW `canvas.scene.walls.size` makes
        // that distinction a one-line fact instead of a guess.
        const totalWallCountForWind = globalThis.canvas?.scene?.walls?.size ?? null;
        // A SECOND, independent question: even when `currentLevelIdForWind`
        // resolves, is `wall.levels` actually the queryable `Set` `readScene
        // WallSegments`'s own filter assumes (`typeof levels.has ===
        // 'function'`)? A live document should always give a real Set
        // (SceneLevelsSetField, verified in Foundry's own source), but this
        // makes that assumption checkable instead of assumed — a Proxy or
        // serialized wall shape that isn't a real Set would silently make
        // EVERY wall read as "unscoped" (the filter's own guard clause
        // quietly no-ops), independent of whether the level id above
        // resolved correctly, and nothing about that would ever throw.
        let wallLevelsShapeDiag = 'n/a';
        try {
          const rawWalls = globalThis.canvas?.scene?.walls;
          if (rawWalls) {
            let taggedCount = 0;
            let sampleShape = null;
            for (const w of rawWalls) {
              const lv = w?.levels;
              const size = typeof lv?.size === 'number' ? lv.size : Array.isArray(lv) ? lv.length : 0;
              if (size > 0) {
                taggedCount++;
                if (!sampleShape) sampleShape = `${lv?.constructor?.name ?? typeof lv}, has() is ${typeof lv.has}`;
              }
            }
            wallLevelsShapeDiag = `${taggedCount} walls carry a non-empty levels field (sample shape: ${sampleShape ?? 'none tagged'})`;
          }
        } catch (err) {
          wallLevelsShapeDiag = `threw: ${err?.message ?? err}`;
        }
        const cols = gridSpec.cols;
        const rows = gridSpec.rows;
        // The COARSE solid mask — kept ONLY for Tier 2's windSolidMaskTexture
        // (world/wind-sim-gpu.js's transient sim, untouched by this rethink)
        // and the probe's diagnostic display. `superCover:true` (the
        // conservative default) is fine for both; neither depends on fine
        // openings surviving the way `openness` below does.
        const solidMask = rasterizeWallsToGrid(walls, gridSpec);

        // WALL-AVOIDANCE DEFLECTION (2026-07-23, author: "walls perpendicular
        // to the wind aren't preventing the wind from penetrating... how can
        // we prevent wind from crossing walls with confidence? How can we
        // divert and diminish its strength so that it breaks around objects
        // instead of just losing all its energy") — see `world/wind-
        // enclosure.js`'s own "WALL-AVOIDANCE DEFLECTION" section header for
        // the full reasoning; this is that module's three functions run
        // straight off the COARSE `solidMask` above (no fine-grid pass
        // needed here, unlike openness — see that header for why). One extra
        // BFS per bake, same rare-event trigger as everything else in this
        // block.
        const wallDistance = distanceFromNearestSolid(solidMask, cols, rows);
        const wallAvoidDir = wallAvoidanceDirectionFromDistance(wallDistance, cols, rows);
        const wallProximity = wallProximityFromDistance(wallDistance, { reachCells: WALL_DEFLECT_REACH_CELLS });

        // OPENNESS (2026-07-22, THE RETHINK — docs/planning/Wind-Rethink.md
        // §4) — THE single geometry-derived answer to "how much outside wind
        // reaches this cell," replacing what used to be five separate
        // mechanisms. Computed on a grid OPENNESS_REFINE× finer than
        // `gridSpec`, rasterized WITHOUT the diagonal over-seal guard
        // (`superCover:false`) — at coarse, over-sealed resolution a curved
        // or narrow real opening can fuse into one solid band
        // (author-confirmed live: removing physical door walls did nothing,
        // because the entrance GEOMETRY around them — not the doors
        // themselves — had already sealed at that resolution). A leak in a
        // fine, non-over-sealed CONNECTIVITY mask is harmless: there is no
        // solve left for it to corrupt, it can only help wind find a real
        // opening. `floodFillOpenFromBoundary` then answers "is this cell
        // connected to the map's open EXTERIOR through open space" purely
        // from walls/doors — the painted `_Outdoors` mask is NOT consulted
        // anywhere in this block, by design: the author's decisive
        // experiment deleted every wall in the scene and found wind still
        // died at the painted mask's boundary, proving the mask — not
        // geometry — had been deciding wind presence. This binary result
        // (`fineOpen`) feeds the graded door-distance falloff just below,
        // which produces the FINAL `opennessArray` — see that block's own
        // header. `downsampleMax`/`downsampleDistanceMin` (any fine cell in
        // a coarse cell's footprint reached/closest ⇒ the coarse cell
        // reflects it — a door that only opens part of a coarse cell still
        // admits wind) bring everything back to `gridSpec`'s own resolution
        // for everything downstream.
        const OPENNESS_REFINE = 4;
        // MAP-EDGE OPENNESS MARGIN (2026-07-23, author: "a building, fully
        // enclosed with walls, sits right on the edge of the map... wind
        // just starts inside the building") — see `cropGridMargin`'s own
        // header (world/wind-enclosure.js) for the full mechanism: the fine
        // grid used for the flood-fill below is rasterized on a rect padded
        // a few cells beyond the real scene rect on every side, so even an
        // edge-flush wall gets a genuinely open neighbour to separate it
        // from the grid's own outer border (which `floodFillOpenFromBoundary`
        // otherwise treats as automatically "outside"). `fineCols`/`fineRows`
        // below are the TRUE (unpadded) fine size — the margin is cropped
        // back off immediately after each flood-fill and never reaches
        // anything downstream, so the published grid's own extent is
        // byte-identical to before this fix (still exactly the real scene
        // rect — the earlier "don't leak into the padding margin" fix stays
        // fully intact).
        const OPENNESS_MARGIN_CELLS = OPENNESS_REFINE * 2;
        const fineCellSize = gridSpec.cellSize / OPENNESS_REFINE;
        const fineCols = cols * OPENNESS_REFINE;
        const fineRows = rows * OPENNESS_REFINE;
        const paddedFineSpec = {
          minX: gridSpec.minX - OPENNESS_MARGIN_CELLS * fineCellSize,
          minY: gridSpec.minY - OPENNESS_MARGIN_CELLS * fineCellSize,
          cols: fineCols + OPENNESS_MARGIN_CELLS * 2,
          rows: fineRows + OPENNESS_MARGIN_CELLS * 2,
          cellSize: fineCellSize,
        };
        const paddedFineSolid = rasterizeWallsToGrid(walls, paddedFineSpec, { superCover: false });
        const paddedFineOpen = floodFillOpenFromBoundary(paddedFineSolid, paddedFineSpec.cols, paddedFineSpec.rows);
        const fineOpen = cropGridMargin(
          paddedFineOpen,
          paddedFineSpec.cols,
          paddedFineSpec.rows,
          OPENNESS_MARGIN_CELLS
        );

        // DOOR-DISTANCE PENETRATION FALLOFF (2026-07-22, same day as binary
        // openness — author, immediately after confirming binary worked
        // live: "opening a door now floods the interior with wind... the
        // effect of the wind drops off as it travels further away from the
        // nearest door that is open... we'd have something very subtle"). A
        // SECOND fine flood-fill, on a mask where a door — open OR closed —
        // ALWAYS counts as a barrier (`deriveWallBlocksExterior`,
        // `foundry/scene-walls.js`), answers "is this cell reachable WITHOUT
        // ever crossing a door at all" — the genuinely outdoor, in-the-open
        // space the "looks amazing outside" look depends on; it never falls
        // off. `distanceFromDoorThreshold` then measures how far a cell
        // that's ONLY reachable via an open door has travelled from that
        // door's own threshold, and `opennessFalloffFromDistance` turns both
        // into the FINAL per-cell openness — 1 outdoors/at the door, fading
        // over `DOOR_FALLOFF_REACH_CELLS`, 0 wherever binary openness was
        // already 0. Same fine geometry, reused; only whether a door counts
        // as passable differs between the two rasterizations.
        const wallsExteriorView = walls.map((w) => ({ ...w, solid: w.blocksExterior }));
        const paddedFineSolidExterior = rasterizeWallsToGrid(wallsExteriorView, paddedFineSpec, { superCover: false });
        const paddedFineOpenExterior = floodFillOpenFromBoundary(
          paddedFineSolidExterior,
          paddedFineSpec.cols,
          paddedFineSpec.rows
        );
        const fineOpenExterior = cropGridMargin(
          paddedFineOpenExterior,
          paddedFineSpec.cols,
          paddedFineSpec.rows,
          OPENNESS_MARGIN_CELLS
        );
        const fineDoorDistance = distanceFromDoorThreshold(fineOpen, fineOpenExterior, fineCols, fineRows);
        const doorDistance = downsampleDistanceMin(fineDoorDistance, cols, rows, OPENNESS_REFINE);
        const exteriorOpenness = downsampleMax(fineOpenExterior, cols, rows, OPENNESS_REFINE);
        const opennessArray = opennessFalloffFromDistance(doorDistance, exteriorOpenness, {
          reachCells: DOOR_FALLOFF_REACH_CELLS * OPENNESS_REFINE,
        });

        // RGBA — B carries openness (the SAME channel `windReach` used
        // before the rethink, so nothing about the texture's shape moved).
        // R/G are always written 0 — the now-deleted wall-relaxation used to
        // carry dvx/dvy there; kept well-defined rather than repurposed
        // because Tier 2's advect pass independently reads this SAME
        // texture's `.xy` as a transport velocity (world/wind-sim-gpu.js) —
        // see world/wind-field.js#sampleWind's own header for the full
        // channel contract. A NOW CARRIES `exteriorOpenness` (2026-07-23,
        // author: "turbulence indoors needs to be happening only when that
        // section becomes exposed to an open door... rooms that have their
        // doors shut are still nearly still") — was "unused, always 1" until
        // now; `sampleWind` needs a way to tell "genuinely outdoors" apart
        // from "indoor, reached only via an open door" (both can read
        // `openness` near 1), and `exteriorOpenness` — already computed just
        // above for the door-distance falloff, previously discarded after
        // use — is exactly that distinction, already sitting right here.
        // HalfFloatType matches this project's OWN established choice for
        // float-ish render targets (sceneColor/sceneIllum/etc), not
        // FloatType, which has patchier linear-filtering support across
        // backends.
        const n = cols * rows;
        const data = new Uint16Array(n * 4);
        const zeroHalf = THREE.DataUtils.toHalfFloat(0);
        for (let i = 0; i < n; i++) {
          data[i * 4 + 0] = zeroHalf;
          data[i * 4 + 1] = zeroHalf;
          data[i * 4 + 2] = THREE.DataUtils.toHalfFloat(opennessArray[i] ?? 1);
          data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(exteriorOpenness[i] ?? 1);
        }
        bakedOpennessTexture?.dispose();
        const tex = new THREE.DataTexture(data, cols, rows, THREE.RGBAFormat, THREE.HalfFloatType);
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.needsUpdate = true;
        bakedOpennessTexture = tex;

        // THE WALL-AVOIDANCE TEXTURE — a SEPARATE texture from the openness one
        // (no channel left to repurpose there: B carries openness, A carries
        // exteriorOpenness, and R/G must stay well-defined zeros for Tier 2's
        // independent `.xy` read). R=dirX, G=dirY, B=proximity; A always 1,
        // unused — matching the openness texture's own "pad to RGBA, only some
        // channels meaningful" convention. Same cols/rows/origin/cellSize, so
        // the handle hands both to `sampleWind` with the IDENTICAL UV maths.
        const wallAvoidData = new Uint16Array(n * 4);
        const oneHalf = THREE.DataUtils.toHalfFloat(1);
        for (let i = 0; i < n; i++) {
          wallAvoidData[i * 4 + 0] = THREE.DataUtils.toHalfFloat(wallAvoidDir.dirX[i] ?? 0);
          wallAvoidData[i * 4 + 1] = THREE.DataUtils.toHalfFloat(wallAvoidDir.dirY[i] ?? 0);
          wallAvoidData[i * 4 + 2] = THREE.DataUtils.toHalfFloat(wallProximity[i] ?? 0);
          wallAvoidData[i * 4 + 3] = oneHalf;
        }
        bakedWallAvoidTexture?.dispose();
        const wallAvoidTex = new THREE.DataTexture(wallAvoidData, cols, rows, THREE.RGBAFormat, THREE.HalfFloatType);
        wallAvoidTex.minFilter = THREE.LinearFilter;
        wallAvoidTex.magFilter = THREE.LinearFilter;
        wallAvoidTex.wrapS = THREE.ClampToEdgeWrapping;
        wallAvoidTex.wrapT = THREE.ClampToEdgeWrapping;
        wallAvoidTex.needsUpdate = true;
        bakedWallAvoidTexture = wallAvoidTex;

        // (The raw per-cell arrays every non-texture consumer reads — the two
        // particle kernels' storage buffers and the wind probe — now ride into
        // the handle below as its `cells`, rather than living in a second
        // closure local that had to be pushed around separately.)

        // TIER 2's OWN SOLID MASK — a plain 0/1 upload (NOT the dvx/dvy
        // deviation above) so the sim's relax pass can tell which GPU texel
        // neighbours are walls. RGBA8 (not R8 — same "universally supported"
        // reasoning as the RGBA-not-RG choice just above) with NEAREST
        // filtering — LINEAR would blur a wall/open boundary into a
        // fractional "half solid" reading right where relax's into-wall
        // cancellation needs a crisp 0 or 1 (world/wind-sim-gpu.js#
        // buildWindRelaxMaterial reads this texture at exactly the cell
        // boundary every neighbour sample).
        windSolidMaskTexture?.dispose();
        const solidData = new Uint8Array(n * 4);
        for (let i = 0; i < n; i++) {
          const v = solidMask[i] ? 255 : 0;
          solidData[i * 4 + 0] = v;
          solidData[i * 4 + 1] = v;
          solidData[i * 4 + 2] = v;
          solidData[i * 4 + 3] = 255;
        }
        const solidTex = new THREE.DataTexture(solidData, cols, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
        solidTex.minFilter = THREE.NearestFilter;
        solidTex.magFilter = THREE.NearestFilter;
        solidTex.wrapS = THREE.ClampToEdgeWrapping;
        solidTex.wrapT = THREE.ClampToEdgeWrapping;
        solidTex.needsUpdate = true;
        windSolidMaskTexture = solidTex;

        // TIER 2's PING/PONG/PUBLISH RENDER TARGETS — only reallocated on a
        // genuine REGRID (cols/rows changed, or first bake ever). Neither
        // `screenSized` nor `allowWorldScale`: cols/rows are ALWAYS <=256
        // (Tier 1's own [64,256] clamp, computeWindBakeGridSpec), so this
        // sails under the Keyhole law's plain 2048px cap with no exception
        // needed — a genuinely tiny, fixed-size allocation regardless of map
        // size (Wind.md §2's own "half a megabyte at the worst case" claim).
        const gridKey = `${cols}x${rows}`;
        if (gridKey !== windSimGridKey) {
          allocator.dispose(windPingRT);
          allocator.dispose(windPongRT);
          allocator.dispose(windPublishRT);
          const describeWindSimRT = () => ({
            resolvedW: cols,
            resolvedH: rows,
            type: THREE.HalfFloatType,
            format: THREE.RGBAFormat,
            colorSpace: THREE.NoColorSpace,
            filter: 'linear',
            depth: false,
          });
          windPingRT = allocator.create('wind.sim.ping', describeWindSimRT());
          windPongRT = allocator.create('wind.sim.pong', describeWindSimRT());
          windPublishRT = allocator.create('wind.sim.publish', describeWindSimRT());
          // A fresh regrid means fresh GPU memory of UNDEFINED content —
          // clear all three explicitly so a NaN bit-pattern can never enter
          // the sim (it would propagate through every multiply forever). A
          // FRESH local Color, deliberately not the file's shared
          // `_clearColorScratch` (declared further down, line ~3237) — this
          // function has ALREADY bitten a temporal-dead-zone bug once (see
          // this file's own "THE INITIAL WIND BAKE... must run here, not
          // earlier" comment) from reaching for a `let`/`const` declared
          // below it; a throwaway allocation here (rare — regrid only, never
          // per frame) is cheaper than re-earning that lesson.
          const prevRT = renderer.getRenderTarget();
          const prevClearColor = renderer.getClearColor(new THREE.Color());
          const prevClearAlpha = renderer.getClearAlpha();
          renderer.setClearColor(0x000000, 0);
          for (const rt of [windPingRT, windPongRT, windPublishRT]) {
            renderer.setRenderTarget(rt);
            renderer.clear(true, false, false);
          }
          renderer.setRenderTarget(prevRT);
          renderer.setClearColor(prevClearColor, prevClearAlpha);
          windSimGridKey = gridKey;
          windPingIsCurrent = true;
        }
        // Tier 2's D_live rides into the handle below as `windPublishRT.texture`
        // — a STABLE texture reference across ordinary (non-regrid) bakes even
        // though its CONTENT changes every tick, which is exactly why consumers
        // need no per-tick rebuild for it (see wind-sim-gpu.js#
        // buildWindPublishMaterial's own header).
        //
        // D_rest (and the solid mask) changed — Tier 2's own materials read
        // BOTH baked in at build time (unlike the ping-pong textures, which
        // are re-pointed live), so they need the SAME "dispose, rebuild
        // lazily on next tick" treatment as candleFlameMat below.
        windSimMaterials?.dispose();
        windSimMaterials = null;

        // ── THE WIND HANDLE (world/wind-access.js, Wind.md §5.1) ────────────
        // Assembled HERE and nowhere else: this is the only code that has all
        // of it at once (the freshly-baked openness/wall-avoidance textures,
        // the raw per-cell arrays, Tier 2's published target, the live ambient
        // uniforms, and the CPU exposure query). Every consumer below receives
        // this ONE object instead of hand-assembling four arguments — the
        // `wind/handle-only` tripwire (tools/verify-structure.mjs) fails the
        // build if any of them tries. `version` increments on every bake, so a
        // consumer holding derived state (a built material, an uploaded storage
        // buffer) can tell that it must refresh — see wind-access.js's own
        // header for the two live bugs that arrangement replaces.
        windHandleVersion += 1;
        windHandle = createWindHandle({
          version: windHandleVersion,
          ambientWind: { directionDeg: uWindDirectionDeg, speed01: uWindSpeed01 },
          grid: {
            originX: gridSpec.minX,
            originY: gridSpec.minY,
            cellSize: gridSpec.cellSize,
            cols,
            rows,
          },
          opennessTexture: tex,
          wallAvoidTexture: wallAvoidTex,
          liveTexture: windPublishRT?.texture ?? null,
          cells: {
            solid: solidMask,
            openness: opennessArray,
            wallAvoidDirX: wallAvoidDir.dirX,
            wallAvoidDirY: wallAvoidDir.dirY,
            wallProximity,
          },
          cpuExposureAt: sampleWindExposureAt,
        });

        // `bakedField` is a graph-BUILD-time shape (a NEW texture object is a
        // NEW uniform binding, and whether it's present/absent at all is a
        // JS-time branch inside sampleWind — no-uniform-gates), so every
        // consumer's material must be rebuilt to pick it up — the SAME
        // "tear down, let the exists-check below recreate it" discipline an
        // animation-type/quality change already uses, just applied to every
        // sampleWind consumer at once instead of one. `liveField` does NOT
        // need this (its texture reference is stable — see above); only
        // `bakedField`'s own change forces this.
        if (candleFlameMat) {
          candleFlameMat.material?.dispose();
          candleFlameMat = null;
        }
        for (const entry of pointLights.lightMeshes.values()) entry.animationType = '__wind_rebake_pending__';
        if (windOverlayMat) {
          windOverlayMat.material?.dispose();
          windOverlayMat = null;
        }
        if (windHeatMat) {
          windHeatMat.material?.dispose();
          windHeatMat = null;
        }
        // FORCE A GEOMETRY REBUILD TOO, NOT JUST THE MATERIAL (2026-07-23) —
        // `updateWindFieldOverlay` now samples POSITIONS straight from THIS
        // bake's own grid spec (`windHandle.grid`, see that function's own header), and
        // its own per-point `windExposure` attribute is a CPU snapshot taken
        // only when the geometry rebuilds. Without this, a rebake with the
        // camera sitting still (e.g. a door opening while the author isn't
        // panning/zooming) would rebuild the material but leave the OLD
        // geometry — built from the PREVIOUS bake's grid — bound, so the
        // overlay could show stale cell positions/exposure until the next
        // view-triggered rebuild happened to also fire. Nulling this forces
        // `windOverlayNeedsRebuild`'s own `!windOverlayLastView` branch next
        // call, unconditionally.
        windOverlayLastView = null;
        // THE PARTICLE ENGINE'S OWN OPENNESS GRID (fix-13, author-reported:
        // "still not fixed" after fix-12's texture→storage-buffer pivot — TWO
        // different sampling mechanisms both read back EXACTLY the same
        // stale data, not two independent bugs). ROOT CAUSE: the engine is
        // constructed ONCE, right after `bakeWindField('startup')`, and its
        // storage buffer was uploaded once and never touched again — it
        // stayed frozen at that first bake's content forever, no matter how
        // many times a LATER wall/door change produced a genuinely different
        // grid (a rebake DOES fire via the wall-
        // change watcher; the overlay/candle correctly showed it, the
        // particle engine never got told). Every consumer above (candle/
        // overlay/heat) is explicitly invalidated right here and rebuilds
        // lazily on its next per-frame call, so it always shows the CURRENT
        // bake. Unlike their "dispose + lazy rebuild" (their materials bake
        // origin/cellSize/cols/rows in as graph-build-time constants), the
        // particle engine's storage buffer can be refreshed IN PLACE —
        // cols/rows are stable across an ordinary rebake (only a scene/grid-
        // size change touches them, which the method below detects and
        // refuses to hot-patch), so this is a data overwrite, not a rebuild.
        // (openness itself is PURELY geometric — unlike the now-deleted
        // wall-relaxation, it never depends on wind speed/direction at all,
        // so even the very first 'startup' bake already carries real,
        // position-varying data; this explicit push still matters because a
        // LATER wall/door edit is the thing that changes it.)
        particleEngine?.updateWind(windHandle);
        // The gust engine reads the SAME handle; refresh it identically
        // (a no-op until it has been constructed, same as the particle engine).
        gustEngine?.updateWind(windHandle);

        // DIAGNOSTICS — a direct INSTRUMENT, not a guess
        // (feedback_instruments_must_not_lie): how much of the mapped area
        // wind can actually reach, straight from the SAME grids every
        // consumer reads (`world/wind-enclosure.js#summarizeEnclosure`), not
        // a second computation that could itself drift from the real one.
        const enclosure = summarizeEnclosure(solidMask, opennessArray);
        log.info(
          `wind field baked (${reason}): floor level "${currentLevelIdForWind ?? '(unscoped)'}" [${windLevelLookupDiag}], ` +
            `${cols}x${rows} cells, ${walls.length}/${totalWallCountForWind ?? '?'} wall segments (scoped/total), ` +
            `${wallLevelsShapeDiag}, ` +
            `${enclosure.solidCells} solid, ${enclosure.openCells} open-to-exterior, ` +
            `${enclosure.enclosedCells} sealed (${enclosure.enclosedPct}%)`
        );
        return {
          ok: true,
          reason,
          cols,
          rows,
          levelId: currentLevelIdForWind,
          levelLookupDiag: windLevelLookupDiag,
          wallCount: walls.length,
          totalWallCount: totalWallCountForWind,
          wallLevelsShapeDiag,
          ...enclosure,
        };
      } catch (err) {
        log.error(`wind field bake failed (${reason}) — the previous bake (or none) stays in place:`, err);
        return { ok: false, reason, error: err?.message ?? String(err) };
      }
    }

    /** @param {number} directionDeg @param {number} speed01 */
    function setWindAmbient(directionDeg, speed01) {
      if (Number.isFinite(directionDeg)) uWindDirectionDeg.value = directionDeg;
      if (Number.isFinite(speed01)) uWindSpeed01.value = Math.max(0, speed01);
      // The bake depends on the SAME direction/speed it was last computed
      // from — changing either without re-baking would leave the moving
      // ambient and the static structure disagreeing about which way the
      // "prevailing" wind blows, so re-run it immediately (cheap — see
      // bakeWindField's own header).
      bakeWindField('ambient-change');
    }

    // The initial bake fires further down (after candleFlameMat/windOverlayMat
    // are actually declared — see the comment beside renderer.setAnimationLoop
    // below for why it CANNOT run here: bakeWindField's own rebuild-trigger
    // code reaches for those `let` bindings, and calling it this early hit
    // their temporal dead zone — ReferenceError, caught live).

    /**
     * Register a Wind.md Tier 2 one-shot (a door gust, or a debug test gust)
     * and extend the thaw window to cover it. Pure bookkeeping — the actual
     * sim tick (below) is what turns this into a visible push.
     *
     * @param {import('../world/wind-field.js').WindContributor} contributor -
     *   already-built and finite (callers use `doorwayImpulseFromWallSegment`,
     *   itself Node-tested — see world/wind-sim.js).
     */
    function registerWindImpulse(contributor) {
      windActiveImpulses.push(contributor);
      const windowMs = computeThawWindowMs({
        lifetimeMs: contributor.lifetimeMs,
        decayPerSecond: WIND_SIM_DEFAULT_DECAY_PER_SECOND,
      });
      windThawUntilMs = Math.max(windThawUntilMs, contributor.startMs + windowMs);
    }

    /**
     * A door just opened (Wind.md §4) — read from `foundry/scene-walls.js#
     * watchDoorOpenings` via boot.js, or a debug "test gust" button. Builds
     * the impulse from the CURRENT ambient (see `doorwayImpulseFromWallSegment`'s
     * own header for why the impulse direction is DERIVED from the ambient,
     * never guessed) and registers it. A no-op (never throws) if the sim
     * hasn't baked at least once yet, or the segment is degenerate.
     *
     * @param {{x1:number,y1:number,x2:number,y2:number}} wallSegment
     */
    function triggerWindDoorImpulse(wallSegment) {
      try {
        const ambient = ambientVectorFromWind({
          directionDeg: uWindDirectionDeg.value,
          speed01: uWindSpeed01.value,
        });
        const nowMs = uGlobalTimeMs.value;
        const contributor = doorwayImpulseFromWallSegment(wallSegment, {
          ambientX: ambient.x,
          ambientY: ambient.y,
          nowMs,
        });
        if (!contributor) return { ok: false, reason: 'degenerate wall segment' };
        registerWindImpulse(contributor);
        log.info(
          `wind door impulse registered: at (${Math.round(contributor.at.x)},${Math.round(contributor.at.y)}), ` +
            `impulse (${contributor.impulse.x.toFixed(1)},${contributor.impulse.y.toFixed(1)}), thaw until +${Math.round(windThawUntilMs - nowMs)}ms`
        );
        return { ok: true, contributor, thawUntilMs: windThawUntilMs };
      } catch (err) {
        log.error('wind door impulse failed:', err);
        return { ok: false, reason: err?.message ?? String(err) };
      }
    }

    /** Perf-lab / debug override — force the sim to stay thawed regardless
     * of active impulses, so its GPU cost is actually measurable through the
     * SAME sweep mechanism every other effect uses (setForcedEnabled-style),
     * per Wind.md §9's own "measured in the perf lab before defaulting on".
     * @param {boolean} on */
    function setWindForceThaw(on) {
      windForceThaw = !!on;
    }

    /**
     * THE TIER 2 TICK — advect+dissipate, splat, relax x N, publish. Called
     * once per rendered frame (see renderFrame's own call site: inside the
     * gpuProbe timing bracket, so the perf lab can actually see this cost),
     * but does REAL WORK only while thawed — the frozen branch below is a
     * handful of comparisons, not a skipped-but-still-compiled shader
     * (Wind.md §3.1: "ZERO per-frame sim cost" while frozen).
     *
     * @param {number} nowMs @param {number} dtSec
     */
    function tickWindSim(nowMs, dtSec) {
      if (windActiveImpulses.length > 0) {
        windActiveImpulses = windActiveImpulses.filter((c) => nowMs < c.startMs + c.lifetimeMs);
      }
      const thawed = windForceThaw || nowMs < windThawUntilMs;
      if (!thawed) {
        if (windIsThawed) {
          windIsThawed = false;
          // A stale last-gust image must not sit frozen on screen forever —
          // one cheap clear, then genuinely nothing until the next thaw
          // (feedback_instruments_must_not_lie: refreezing must mean "gone",
          // not "frozen mid-gust").
          if (windPublishRT) {
            const prevRT = renderer.getRenderTarget();
            const prevClearColor = renderer.getClearColor(new THREE.Color());
            const prevClearAlpha = renderer.getClearAlpha();
            renderer.setClearColor(0x000000, 0);
            renderer.setRenderTarget(windPublishRT);
            renderer.clear(true, false, false);
            renderer.setRenderTarget(prevRT);
            renderer.setClearColor(prevClearColor, prevClearAlpha);
          }
          log.info('wind sim refroze');
        }
        return;
      }
      if (!windHandle.hasBake || !windSolidMaskTexture || !windPingRT || !windPongRT || !windPublishRT) return;
      if (!windSimMaterials) {
        windSimMaterials = buildWindSimMaterials({
          THREE,
          pingTexture: windPingRT.texture,
          pongTexture: windPongRT.texture,
          publishTexture: windPingRT.texture,
          // Tier 2 is part of the wind SYSTEM, not a consumer of it: its advect
          // pass transports ON the resting field, so it legitimately needs
          // D_rest's texture rather than a sample of it. The handle exposes that
          // under its own name (`restFieldTexture`) precisely so it stays
          // distinct from the consumer-facing shapes.
          restFieldTexture: windHandle.restFieldTexture,
          solidMaskTexture: windSolidMaskTexture,
          ambientWind: { directionDeg: uWindDirectionDeg, speed01: uWindSpeed01 },
          cols: windHandle.grid.cols,
          rows: windHandle.grid.rows,
          cellSize: windHandle.grid.cellSize,
          originX: windHandle.grid.originX,
          originY: windHandle.grid.originY,
          decayPerSecond: WIND_SIM_DEFAULT_DECAY_PER_SECOND,
          relaxBlend: WIND_SIM_RELAX_BLEND,
          maxImpulseSlots: WIND_SIM_MAX_ACTIVE_IMPULSES,
        });
      }

      const { slots } = gatherActiveImpulseSlots(windActiveImpulses, nowMs, WIND_SIM_MAX_ACTIVE_IMPULSES);
      for (let i = 0; i < windSimMaterials.splat.slots.length; i++) {
        const slotUniforms = windSimMaterials.splat.slots[i];
        const active = slots[i];
        if (active) {
          slotUniforms.uPos.value.set(active.x, active.y);
          slotUniforms.uVec.value.set(active.vx, active.vy);
          slotUniforms.uRadius.value = active.radius;
          slotUniforms.uGain.value = active.gain;
        } else {
          slotUniforms.uGain.value = 0; // fully inert — see buildWindSplatMaterial's own doc
        }
      }

      const prevRT = renderer.getRenderTarget();
      let currentRT = windPingIsCurrent ? windPingRT : windPongRT;
      let otherRT = windPingIsCurrent ? windPongRT : windPingRT;

      windSimMaterials.advectDissipate.uDtSec.value = dtSec;
      for (const n of windSimMaterials.advectDissipate.prevTexNodes) n.value = currentRT.texture;
      renderer.setRenderTarget(otherRT);
      windSimMaterials.advectDissipate.quad.render(renderer);
      [currentRT, otherRT] = [otherRT, currentRT];

      windSimMaterials.splat.uDtSec.value = dtSec;
      for (const n of windSimMaterials.splat.prevTexNodes) n.value = currentRT.texture;
      renderer.setRenderTarget(otherRT);
      windSimMaterials.splat.quad.render(renderer);
      [currentRT, otherRT] = [otherRT, currentRT];

      for (let iter = 0; iter < WIND_SIM_DEFAULT_RELAX_ITERATIONS; iter++) {
        for (const n of windSimMaterials.relax.prevTexNodes) n.value = currentRT.texture;
        renderer.setRenderTarget(otherRT);
        windSimMaterials.relax.quad.render(renderer);
        [currentRT, otherRT] = [otherRT, currentRT];
      }

      windSimMaterials.publish.sourceTexNode.value = currentRT.texture;
      renderer.setRenderTarget(windPublishRT);
      windSimMaterials.publish.quad.render(renderer);

      renderer.setRenderTarget(prevRT);
      windPingIsCurrent = currentRT === windPingRT;

      if (!windIsThawed) {
        windIsThawed = true;
        log.info(`wind sim thawed (${slots.length} active impulse(s))`);
      }
    }

    /**
     * FLUID's per-item sim tick — the ONLY place `effects/fluid/
     * fluid-surface-subsystem.js`'s ping-pong actually gets rendered.
     * `prepareSimTick` (that file) does every JS-side step (rewrite each
     * item's pump texture, decide what "current" means, re-point every
     * re-pointed node) and hands back a declarative job list; this function's
     * entire job is to run it, mirroring `tickWindSim`'s own split between
     * "decide" (its own body, `world/wind-sim-gpu.js`) and "render" (the
     * `renderer.setRenderTarget`/`quad.render` calls, walled to `vt/` —
     * `renderer-state/graph-only`).
     */
    function tickFluidSim(nowMs, dtSec) {
      const { clears, advects } = fluidSurface.prepareSimTick(nowMs, dtSec);
      if (!clears.length && !advects.length) return;
      const prevRT = renderer.getRenderTarget();
      if (clears.length) {
        // Fresh GPU memory is undefined content — a NaN entering the sim
        // would propagate through every subsequent multiply/interpolate
        // forever. Same posture as wind's own regrid clear above.
        const prevClearColor = renderer.getClearColor(new THREE.Color());
        const prevClearAlpha = renderer.getClearAlpha();
        renderer.setClearColor(0x000000, 0);
        for (const rt of clears) {
          renderer.setRenderTarget(rt);
          renderer.clear(true, false, false);
        }
        renderer.setClearColor(prevClearColor, prevClearAlpha);
      }
      for (const { quad, destRT } of advects) {
        renderer.setRenderTarget(destRT);
        quad.render(renderer);
      }
      renderer.setRenderTarget(prevRT);
    }

    // ------------------------------------------------------------------
    // THE CANDLE FLAME BILLBOARD (effects/candle-flame-render.js). ONE batched
    // world-quad mesh holding every candle on the active floor (one geometry,
    // one draw call — the batched outcome the particles/one-engine wall wants,
    // reached WITHOUT InstancedMesh/Sprite, so the wall never fires). Drawn
    // additively over the fully-lit scene so it GLOWS regardless of scene
    // darkness — a flame emits light, it is not lit by it — while the candle's
    // own LIGHT (merged into the pool above) illuminates the floor around it.
    // Geometry is rebuilt ONLY when the anchor set or size changes (a cheap
    // integer checksum), never per frame; the colour/intensity uniforms update
    // every frame (cheap). World-space quads, so the camera owns the one Y-flip.
    // ------------------------------------------------------------------
    const candleFlameScene = new THREE.Scene();
    let candleFlameMesh = null;
    let candleFlameMat = null; // { material, uIntensity, uLean, uWindResponse } — colour/per-candle brightness are baked geometry attributes, not uniforms
    let candleFlameKey = null; // checksum of the geometry currently on the GPU
    let candleFlameQuality = null; // the quality tier the current material was BUILT at

    /** Cheap string fold into an existing integer checksum — `candleFlameSignature`'s
     * only way to fold a colour hex (a string) into its otherwise-numeric hash. */
    function hashStrInto(h, s) {
      const str = String(s ?? '');
      for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
      return h;
    }

    /** Cheap change-detector over the anchor positions + size + wind exposure +
     * colour, so the geometry (which BAKES center/windExposure/flameColor/
     * flameIntensity as attributes) is rebuilt only on a real change (scene
     * load, floor switch, a size/colour tweak — global OR per-candle — or the
     * outdoors mask streaming in and changing a candle's exposure). */
    function candleFlameSignature(anchors, sizePx, colorHex) {
      let h = (anchors.length * 1000003 + Math.round((sizePx || 0) * 100)) | 0;
      h = hashStrInto(h, colorHex);
      for (const a of anchors) {
        h = (h * 31 + Math.round(a.x) + Math.round(a.y) * 7) | 0;
        h = (h * 31 + Math.round((a.windExposure ?? 1) * 15)) | 0; // coarse — a real exposure change rebuilds
        // PER-CANDLE OVERRIDES (2026-07-22) — colour/size/brightness are now
        // baked per-vertex (candle-flame-render.js#computeCandleFlameArrays),
        // so an edit to any of them must trigger the same rebuild a global
        // change already does.
        const p = a?.params;
        h = (h * 31 + Math.round((p?.intensity ?? 1) * 100)) | 0;
        if (p?.useCustomColor) h = hashStrInto(h, p.customColor);
        if (p?.useCustomSize) h = (h * 31 + Math.round(Number(p.customSizePx) || 0)) | 0;
      }
      return h;
    }

    function updateCandleFlame() {
      const state = getCandleRenderState();
      const anchors = state.enabled ? (Array.isArray(state.anchors) ? state.anchors : []) : [];
      if (!anchors.length) {
        if (candleFlameMesh) candleFlameMesh.visible = false;
        return;
      }
      const sizePx = Number(state.params?.sizePx) > 0 ? Number(state.params.sizePx) : 1;
      // The flame's chaotic-life detail is a graph-BUILD-time tier (like the
      // light pool's), so a live animationQuality change rebuilds the material.
      const qualityTier = candleAnimationQualityTier(state.params?.animationQuality);
      if (!candleFlameMat || candleFlameQuality !== qualityTier) {
        // uGlobalTimeMs (the ONE clock, set fresh by updatePointLightMeshes
        // just before this runs each frame) drives the flame's GPU wind.
        const prev = candleFlameMat;
        candleFlameMat = buildCandleFlameMaterial({
          THREE,
          uGlobalTimeMs,
          quality: qualityTier,
          windHandle,
        });
        candleFlameQuality = qualityTier;
        if (!candleFlameMesh) {
          candleFlameMesh = new THREE.Mesh(new THREE.BufferGeometry(), candleFlameMat.material);
          candleFlameMesh.frustumCulled = false; // world-space, camera bounds vary per frame
          candleFlameScene.add(candleFlameMesh);
        } else {
          candleFlameMesh.material = candleFlameMat.material;
        }
        prev?.material?.dispose(); // free the superseded material on a tier change
      }
      const colorHex = state.params?.color;
      const sig = candleFlameSignature(anchors, sizePx, colorHex);
      if (sig !== candleFlameKey || !candleFlameMesh.geometry.getAttribute('position')) {
        const old = candleFlameMesh.geometry;
        // colorHex is the EFFECT-WIDE fallback baked onto every un-customised
        // candle's vertices; a candle with its own useCustomColor bakes ITS
        // colour instead (computeCandleFlameArrays' own header).
        const { geometry } = buildCandleFlameGeometry(THREE, anchors, { sizePx, colorHex });
        candleFlameMesh.geometry = geometry;
        if (old) old.dispose(); // free the previous frame's GPU buffers, not per-frame (only on change)
        candleFlameKey = sig;
      }
      candleFlameMat.uIntensity.value = 1;
      // WIND RESPONSE (Wind.md §8.1) — a live uniform like uIntensity above,
      // not baked into geometry: a param change takes effect next frame, no
      // material rebuild.
      const windResponseParam = Number(state.params?.windResponse);
      candleFlameMat.uWindResponse.value = Number.isFinite(windResponseParam) ? windResponseParam : 1;
      candleFlameMesh.visible = true;
    }

    /** Free the flame's own GPU resources (its lights live in the shared pool,
     * disposed by disposePointLights). Safe whether or not anything was built. */
    function disposeCandleFlame() {
      try {
        candleFlameMesh?.geometry?.dispose();
        candleFlameMat?.material?.dispose();
      } catch (err) {
        log.error('candle flame dispose failed — GPU buffers may leak until renderer.dispose():', err);
      }
      candleFlameMesh = null;
      candleFlameMat = null;
      candleFlameKey = null;
    }

    // ── DOOR GRAPHICS (effects/door-graphics-subsystem.js) ────────────────
    // Extracted 2026-07-26 (VT-Pan-Viewer-Extraction.md §11) as prep for Water
    // Phase 3 — read that module's header first: it is also the TEMPLATE
    // tier-0 water follows, because a door is an OPAQUE, LIT map element drawn
    // into buf:scene.color BEFORE lighting, which is exactly what water's own
    // surface wants.
    const doorGraphics = createDoorGraphicsSubsystem({ THREE, dimensions, getDoorRenderState });
    const syncDoorGraphics = doorGraphics.sync;
    const disposeDoorGraphics = doorGraphics.dispose;

    /** Draw the door leaves INTO the currently-bound target (buf:scene.color,
     * bound by runGeometryWorldPass) WITHOUT clearing it, so they composite over
     * the map and get lit downstream. No-op when nothing is built.
     *
     * Stays HERE rather than in the subsystem: `renderer-state/graph-only`
     * allows `.autoClear* =` only inside vt/graph/diag (trap #5). */
    function renderDoorGraphicsInto() {
      if (!doorGraphics.leafCount) return;
      const prev = renderer.autoClearColor;
      renderer.autoClearColor = false;
      renderer.render(doorGraphics.scene, camera);
      renderer.autoClearColor = prev;
    }

    /** Constructed lazily, after the startup bake (see the construction site
     * near bakeWindField('startup') for why) — see runSurfaceParticlesPass and
     * renderFrame's particle step for the two readers; both tolerate `null`
     * (nothing drawn/stepped) until construction actually runs. */
    let particleEngine = null;
    /** RELABELED + gated OFF by default (2026-07-22, author: "these aren't
     * dust motes, they're wind diagnostic particles... this should be an
     * optional debugging visualisation") — same idiom as windOverlayEnabled
     * just below: a scene nobody has opened this toggle for allocates no
     * arena, compiles no compute kernel, and draws nothing (particle-arena.js
     * has no dispose path once built, so construction itself is deferred to
     * first enable via setWindDiagnosticParticlesEnabled, not just gated
     * per-frame — see constructParticleEngineIfNeeded's own call site). */
    let windParticlesEnabled = false;

    /** WIND GUSTS (effects/particles/gust-runtime.js) — a SEPARATE ribbon-trail
     * effect from the diagnostic dots above; same deferred-construction /
     * off-by-default discipline (its arena has no dispose path either), same two
     * readers (runSurfaceParticlesPass draws it, renderFrame's sim block steps
     * it), both tolerating `null` until constructGustEngineIfNeeded runs. */
    let gustEngine = null;
    let windGustsEnabled = false;

    // ------------------------------------------------------------------
    // THE WIND FIELD DEBUG OVERLAY (diag/wind-field-overlay.js, Wind.md Tier
    // 0 — "a way to visualise the field early on"). A grid of arrows over
    // the CURRENT VIEW, each sampling the EXACT SAME `sampleWind()` the
    // candle flame/light already read — proof, not illustration, that the
    // field is genuinely shared. OFF by default (a diagnostic, not a
    // product feature); toggled via setWindFieldOverlayEnabled below.
    // Mirrors the candle flame block immediately above: a Scene, a rebuilt-
    // on-change geometry, a material whose only per-frame write is nothing
    // at all (it reads uGlobalTimeMs directly, like the flame's own wind).
    // ------------------------------------------------------------------
    const windOverlayScene = new THREE.Scene();
    let windOverlayMesh = null;
    let windOverlayMat = null;
    // THE FORCE HEATMAP (author's ask, 2026-07-21) — a sibling mesh in the
    // SAME scene, drawn UNDER the arrows: full-cell quads coloured blue→red by
    // wind magnitude (diag/wind-field-overlay.js#buildWindHeatmapMaterial),
    // sharing the arrows' grid points and every rebuild/rebake trigger so the
    // two can never disagree about where a cell is or how strong it is.
    let windHeatMesh = null;
    let windHeatMat = null;
    let windOverlayEnabled = false;
    /** How many REAL bake cells to skip per displayed arrow, minimum
     * (2026-07-23, REPURPOSED — was "samples per grid square, up to 4x
     * finer"; now the overlay shows the ACTUAL bake grid 1:1 by default, so
     * "finer than the real cells" no longer means anything — there is no
     * data to sample between them). 1 = every real cell (the accurate,
     * default view); 2+ = a deliberately decluttered every-Nth-cell preview,
     * still genuine cell centers, never a re-derived approximation — see
     * `computeWindOverlayGridFromBake`'s own header. */
    let windOverlayResolution = 1;
    /** The last-built grid's own {cx,cy,w,h,spacing,resolution} — rebuilding
     * on every sub-pixel pan would be pure churn (this is a debug tool, but
     * the codebase's own rebuild-on-real-change discipline still applies,
     * same reasoning as candleFlameSignature just above); rebuild only once
     * the view has moved/zoomed enough that the old grid stops covering it
     * well, OR the resolution lever changed. ALSO forced to `null` on every
     * rebake (bakeWindField's own disposal block) — see that block's own
     * comment for why a material-only invalidation isn't enough now that
     * geometry itself is sourced from the bake's own grid. */
    let windOverlayLastView = null;

    function windOverlayNeedsRebuild(view_) {
      if (!windOverlayLastView) return true;
      if (view_.resolution !== windOverlayLastView.resolution) return true;
      const dx = Math.abs(view_.cx - windOverlayLastView.cx);
      const dy = Math.abs(view_.cy - windOverlayLastView.cy);
      const dw = Math.abs(view_.w - windOverlayLastView.w) / Math.max(1, windOverlayLastView.w);
      const dh = Math.abs(view_.h - windOverlayLastView.h) / Math.max(1, windOverlayLastView.h);
      const moved = Math.max(dx, dy) > windOverlayLastView.spacing * 0.3;
      const zoomed = dw > 0.15 || dh > 0.15;
      return moved || zoomed;
    }

    function updateWindFieldOverlay() {
      // Also bails (meshes stay hidden) before ANY bake has ever completed —
      // this function's own point source is the bake's own grid (see below),
      // which the handle only carries once a real bake has run, so there is
      // genuinely nothing to show yet, not an error.
      if (!windOverlayEnabled || !view || !windHandle.hasBake) {
        if (windOverlayMesh) windOverlayMesh.visible = false;
        if (windHeatMesh) windHeatMesh.visible = false;
        return;
      }
      // CLAMPED TO THE REAL SCENE RECT (2026-07-23, author: "Don't render the
      // wind particles or the overlay outside of the scene") — same
      // `clampRectToBounds` used for particle/gust spawning (renderFrame's
      // own sims.particles block has the full reasoning); the raw camera
      // view can point at the padding margin or beyond, but the baked grid
      // itself only covers the true `sceneRect` now, so drawing past it would
      // show arrows/heatmap cells for area no wind was ever computed for.
      const rect = clampRectToBounds(viewToWorldRect(view, canvasW / canvasH), dimensions.sceneRect);
      const cx = (rect.minX + rect.maxX) / 2;
      const cy = (rect.minY + rect.maxY) / 2;
      const w = rect.maxX - rect.minX;
      const h = rect.maxY - rect.minY;
      const windInputs = { THREE, uGlobalTimeMs, windHandle };
      if (!windOverlayMat) windOverlayMat = buildWindArrowMaterial(windInputs);
      if (!windHeatMat) windHeatMat = buildWindHeatmapMaterial(windInputs);
      if (windOverlayNeedsRebuild({ cx, cy, w, h, resolution: windOverlayResolution })) {
        // THE REAL BAKE GRID, NOT AN INDEPENDENT LATTICE (2026-07-23, author:
        // "make the overlay show the exact resolution accurately. I want to
        // be able to picture it accurately") — see `computeWindOverlayGrid
        // FromBake`'s own header for the full reasoning. `windHandle.grid`
        // is the SAME grid spec `bakeWindField` computed openness into and
        // every other consumer (particles, gusts, sampleWind) reads — the
        // overlay can no longer show a cell that doesn't correspond to a
        // real one, or silently coarsen without saying so.
        const { points, spacingPx } = computeWindOverlayGridFromBake({
          cols: windHandle.grid.cols,
          rows: windHandle.grid.rows,
          cellSize: windHandle.grid.cellSize,
          originX: windHandle.grid.originX,
          originY: windHandle.grid.originY,
          minX: rect.minX,
          minY: rect.minY,
          maxX: rect.maxX,
          maxY: rect.maxY,
          stride: windOverlayResolution,
        });
        // REAL per-point exposure (2026-07-21, author-reported: the overlay
        // read identically turbulent indoors and outdoors) — a CPU sample
        // per grid point, ONCE per rebuild (not per frame), same cost class
        // as sampling a handful of candle anchors, just a few thousand at
        // 4x resolution over a big view. Shared by BOTH meshes (arrows +
        // heatmap) — one sample, two consumers.
        const pointsWithExposure = points.map((p) => ({ ...p, windExposure: sampleWindExposureAt(p.x, p.y) }));
        // ARROWS — slightly inset (0.85) so neighbours read as distinct glyphs.
        const oldArrow = windOverlayMesh?.geometry;
        const { geometry: arrowGeom } = buildWindOverlayGeometry(THREE, pointsWithExposure, {
          sizePx: spacingPx * 0.85,
        });
        if (!windOverlayMesh) {
          windOverlayMesh = new THREE.Mesh(arrowGeom, windOverlayMat.material);
          windOverlayMesh.frustumCulled = false;
          windOverlayMesh.renderOrder = 1; // arrows draw OVER the heatmap wash
          windOverlayScene.add(windOverlayMesh);
        } else {
          windOverlayMesh.geometry = arrowGeom;
          // THE BUG (2026-07-21, author-reported: rebaking never visibly
          // changed anything): a geometry rebuild alone does NOT pick up a
          // material rebuild that happened in between — `windOverlayMat` can
          // be a BRAND NEW object (bakeWindField nulls it on every rebake,
          // see this function's own build-path above) while this MESH kept
          // pointing at whatever material object it was constructed with,
          // forever, because nothing ever told it otherwise. The candle
          // flame's own rebuild (updateCandleFlame) already does this
          // reassignment correctly — this path was missing its equivalent
          // line. A stale material still reads LIVE uniform values correctly
          // (uWindDirectionDeg/uWindSpeed01 mutate in place) and even live
          // vertex attributes off whatever geometry is CURRENTLY bound
          // (windExposure), which is why direction/speed changes and
          // per-point exposure were never fully dead — but the baked WALL
          // texture is a graph-BUILD-time binding, so it was frozen at
          // whatever `windBakedField` existed the FIRST time this mesh's
          // material was built (the initial, windless startup bake) —
          // exactly matching "rebaking never changes the walls' effect".
          windOverlayMesh.material = windOverlayMat.material;
        }
        if (oldArrow) oldArrow.dispose();
        // HEATMAP — near-full-cell (0.94) quads so cells read as distinct
        // coloured "grid spaces" (the author's word) with a hairline gap,
        // not one seamless wash. Same points, same per-point exposure, its
        // own geometry (a different quad size) and material. The material-
        // reassignment on rebuild matters here for the SAME baked-texture
        // reason spelled out for the arrows just above.
        const oldHeat = windHeatMesh?.geometry;
        const { geometry: heatGeom } = buildWindOverlayGeometry(THREE, pointsWithExposure, {
          sizePx: spacingPx * 0.94,
        });
        if (!windHeatMesh) {
          windHeatMesh = new THREE.Mesh(heatGeom, windHeatMat.material);
          windHeatMesh.frustumCulled = false;
          windHeatMesh.renderOrder = 0; // the wash sits beneath the arrows (renderOrder 1)
          windOverlayScene.add(windHeatMesh);
        } else {
          windHeatMesh.geometry = heatGeom;
          windHeatMesh.material = windHeatMat.material;
        }
        if (oldHeat) oldHeat.dispose();
        windOverlayLastView = { cx, cy, w, h, spacing: spacingPx, resolution: windOverlayResolution };
      }
      windOverlayMesh.visible = true;
      windHeatMesh.visible = true;
    }

    /** Free the overlay's own GPU resources. Safe whether or not anything was built. */
    function disposeWindFieldOverlay() {
      try {
        windOverlayMesh?.geometry?.dispose();
        windOverlayMat?.material?.dispose();
        windHeatMesh?.geometry?.dispose();
        windHeatMat?.material?.dispose();
      } catch (err) {
        log.error('wind overlay dispose failed — GPU buffers may leak until renderer.dispose():', err);
      }
      windOverlayMesh = null;
      windOverlayMat = null;
      windHeatMesh = null;
      windHeatMat = null;
      windOverlayLastView = null;
    }

    /** Tear down Wind.md Tier 2's own GPU resources (ping/pong/publish
     * render targets + the solid mask texture + the sim materials) — same
     * per-cycle VRAM-leak reasoning as disposeWindFieldOverlay just above.
     * Tier 1's own baked textures are NOT touched here (disposed by the next
     * bakeWindField call or the renderer's own final dispose — unchanged,
     * pre-existing behaviour). */
    function disposeWindSim() {
      try {
        windSimMaterials?.dispose();
        allocator.dispose(windPingRT);
        allocator.dispose(windPongRT);
        allocator.dispose(windPublishRT);
        windSolidMaskTexture?.dispose();
      } catch (err) {
        log.error('wind sim dispose failed — GPU buffers may leak until renderer.dispose():', err);
      }
      windSimMaterials = null;
      windPingRT = null;
      windPongRT = null;
      windPublishRT = null;
      windSolidMaskTexture = null;
      windSimGridKey = null;
      windActiveImpulses = [];
      windThawUntilMs = 0;
      windIsThawed = false;
    }

    /** @param {boolean} on */
    function setWindFieldOverlayEnabled(on) {
      windOverlayEnabled = !!on;
    }

    /** Debug-only wind visualization, off by default (see windParticlesEnabled's
     * own comment) — enabling for the FIRST time in a session builds the
     * engine (constructParticleEngineIfNeeded, defined near the original
     * construction site further down, hoisted so this call site doesn't care
     * about textual order); every enable after that just resumes step/draw,
     * since there is no dispose path to rebuild from (particle-arena.js's own
     * accepted limitation — reference_bufferattribute_no_dispose_trap).
     * @param {boolean} on */
    function setWindDiagnosticParticlesEnabled(on) {
      windParticlesEnabled = !!on;
      if (windParticlesEnabled) constructParticleEngineIfNeeded();
    }

    /** Wind Gusts (ribbon trails), off by default — same deferred-build idiom as
     * the diagnostic particles: first enable builds the engine, later toggles
     * just resume step/draw (no dispose path to rebuild from).
     * @param {boolean} on */
    function setWindGustsEnabled(on) {
      windGustsEnabled = !!on;
      if (windGustsEnabled) constructGustEngineIfNeeded();
    }

    /** @param {number} n - real bake cells to skip per displayed arrow,
     * 1..4 (2026-07-23, REPURPOSED — was "sub-samples per grid square,
     * finer than the real data"; the overlay now shows the actual bake grid,
     * so 1 = every real cell, exact; 2..4 = a deliberately decluttered
     * every-Nth-cell view, see `windOverlayResolution`'s own declaration).
     * Clamped; takes effect on the next updateWindFieldOverlay (an immediate
     * rebuild, not waiting for the pan/zoom threshold — a lever should feel
     * responsive). */
    function setWindFieldOverlayResolution(n) {
      const clamped = Math.max(1, Math.min(4, Math.round(Number(n) || 1)));
      windOverlayResolution = clamped;
    }

    // ------------------------------------------------------------------
    // present.composite — buf:scene.color → the canvas.
    // ------------------------------------------------------------------
    //
    // Written fresh in TSL, NOT harvested from graph/fullscreen-present.js:
    // that module is GLSL (ShaderMaterial + gl_Position), was the last GLSL in
    // src/, and cannot run under WebGPURenderer at all. Two things from it are
    // worth carrying forward, and are recorded here because the file itself is
    // now deleted:
    //
    // 1. IT HAND-APPLIED THE sRGB OETF, and we must NOT. It did that because a
    //    raw ShaderMaterial bypasses three's colour management. A NodeMaterial
    //    does not — the node system applies output colour space at the canvas.
    //    Hand-applying it here would DOUBLE the gamma. That is the trap.
    //
    // 2. ⬜ ITS HDR TONE-MAP IS A REAL DESIGN DECISION, DEFERRED, NOT DROPPED.
    //    `passes.js` gives present.composite "tonemap + present" as its job.
    //    There is no tone map here yet — still correct as of 2026-07-18:
    //    light.accumulate is now LIVE but ambient-ONLY (the map multiplied by
    //    an ambient colour ≤1.0, so the lit result stays ≤1.0 — no HDR yet).
    //    Point lights (increment 2) are the first thing that can push a pixel
    //    over 1.0; the rolloff gets restored then, not before. When that
    //    happens, the decision to restore is V3's, and it was
    //    deliberate: a HUE-PRESERVING HIGHLIGHT ROLLOFF, **not global ACES**.
    //    A global ACES curve desaturates the whole image and bleaches
    //    saturated light cores toward white. Instead: everything below a knee
    //    (default 0.9) stays pixel-identical to the linear input — so
    //    Foundry-matched midtones and light bodies are untouched — and only
    //    the over-knee "filament" compresses toward 1.0, scaling RGB uniformly
    //    so a hot core keeps its colour. Rebuild that in TSL at that point;
    //    do not reach for a stock tone-mapping node.
    // 3. ⚠️ Y-FLIP — USE THREE'S OWN QuadMesh, NEVER A HAND-ROLLED ONE.
    //    The first cut of this pass used `new THREE.Mesh(new THREE.PlaneGeometry(2,2))`
    //    and the whole map came out upside down (author-caught, 2026-07-17).
    //    Read from the vendored source rather than guessed, so it stays true:
    //
    //      three.webgpu.js:56350  NodeBuilder.isFlipY() { return false }  ← WebGPU
    //      three.webgpu.js:64344  NodeBuilder.isFlipY() { return true  }  ← WebGL
    //
    //    Three inserts a compensating flip into `texture()` ONLY when isFlipY()
    //    is true, normalising BOTH backends to one rule: **v=0 is the TOP of a
    //    render-target texture.** Its own fullscreen geometry agrees —
    //    `QuadGeometry` (three.webgpu.js:49443) is a fullscreen TRIANGLE whose
    //    uvs `[0,-1, 0,1, 2,1]` put **v=0 at the screen TOP**:
    //
    //      PlaneGeometry:  v=0 at the screen BOTTOM   ← what I used. Inverted.
    //      QuadGeometry:   v=0 at the screen TOP      ← matches the RT rule.
    //
    //    So a PlaneGeometry fullscreen quad samples the image's top at the
    //    screen's bottom. Exactly upside down, and BACKEND-DEPENDENT — the one
    //    thing `keyhole-webgpu-tsl-decision` says must never happen ("ONE source
    //    per effect, never a WebGL2 twin").
    //
    //    THE FIX IS NOT A COMPENSATING FLIP. Two flips that cancel is how you
    //    end up with four (feedback_y_flip_recurring_risk). `QuadMesh` bundles
    //    three's geometry AND its camera, so the vendor owns the convention on
    //    both backends — and they must get it right, because every three user
    //    would notice if they didn't. `zones/no-handrolled-fullscreen-quad` in
    //    tools/verify-structure.mjs now fails the build on the mistake I made.
    // THE GRADE STACK, folded into present (docs/planning/Grade.md §5). Reads
    // scene.lit — the map AFTER light.accumulate + particles + flames — applies
    // the environmental grade (outdoor-gated) then the artistic grade, and hands
    // the result to the canvas (which does the sRGB encode). Ships neutral: both
    // grades at identity ⇒ this is `present(scene.lit)` unchanged, so the
    // Foundry-parity check holds until a grade is dialled in.
    //
    // Shares envLight's outdoor-gate NODES (the same mask texture + rect
    // uniforms), so a mask rebake reaches the grade too and the sky light and
    // grade can never gate different halves of the map. QuadMesh, not a
    // hand-rolled quad — the whole Y-flip essay above still applies (grade-
    // present builds a NodeMaterial that a QuadMesh wraps below).
    // A placeholder identity 3D LUT, so the LUT sampler always compiles (the
    // Colour Grade effect's LUT strength gates it; a real .cube swaps in via
    // gradePresent.setLut). 2³ is the smallest identity — plenty as a no-op.
    const lutPlaceholder = makeIdentityLutTexture(THREE);
    const gradePresent = buildGradePresentMaterial({
      THREE,
      litTexture: sceneLit.texture,
      outdoorsTexNode: envLight.outdoorsTexNode,
      uViewRect: envLight.uViewRect,
      uOutdoorsRect: envLight.uOutdoorsRect,
      lutTexture: lutPlaceholder,
    });
    const presentMaterial = gradePresent.material;
    const presentQuad = new THREE.QuadMesh(presentMaterial);

    /** Re-point the present material at a freshly-allocated target (resize). */
    function rebindPresent() {
      gradePresent.rebindLit(sceneLit.texture);
    }

    // ========================================================================
    // THE PASS RUNNER, WIRED (2026-07-18) — graph/passes.js stops being a
    // comment for this stage range.
    // ========================================================================
    //
    // Before this, `renderFrame` below just wrote the two draw calls inline.
    // That was accurate (geometry.world and present.composite really are two
    // separate `renderer.render()` calls against two targets, since the
    // 2026-07-17 split) but HARDCODED — passes.js's own order was decoration,
    // not a dependency. Keyhole.md named this the #1 gate blocking every
    // future effect: "if it is hardcoded, passes.js becomes a comment."
    //
    // The fix is deliberately the SMALLEST thing that makes the claim false.
    // `runGeometryWorldPass`/`runPresentCompositePass` are the SAME two GPU
    // calls, byte-for-byte, just named and looked up through a plan instead of
    // written inline. `framePlan` is computed ONCE here (passes.js doesn't
    // change mid-session) via `planFrame`, which is real code that walks the
    // REAL `PASSES` array — not a private duplicate of its order.
    //
    // What this buys, concretely: when `masks.occlusion` (the next item on
    // the infrastructure menu) flips from 'seam' to 'live', wiring it in is
    // "add one line to `passImpls`, widen `fromStage` to 'masks'" — this
    // function's control flow does not change again. That is the whole point
    // of a graph the render loop actually reads instead of merely validates.
    //
    // NOT separately invocable from outside this closure (same honest caveat
    // graph/pass-impls.js already records for these two ids) — these remain
    // private to the active viewer instance, called only from `renderFrame`
    // below via `passImpls`. `PASS_IMPLS` in graph/pass-impls.js is unchanged:
    // it still honestly names `startVtPanViewer` as the reachable entry point,
    // because externally that is still the only door in.
    function runGeometryWorldPass() {
      // MRT scoped, never left set (scene-attr.js's own header): a stale MRT
      // node would silently empty light.accumulate's single-attachment
      // targets right after this pass — save/set/restore.
      const previousMRT = renderer.getMRT();
      renderer.setMRT(sceneAttrZeroMrt);
      profiler?.begin(Z.geomWorld);
      renderer.setRenderTarget(sceneColor);
      renderer.render(scene, camera);
      profiler?.end(Z.geomWorld);
      // Door leaves composite over the map INTO the same target (not cleared),
      // so the light.accumulate pass lights them like the tiles beneath them.
      // Class-B overlay, same safe zero-default, no mrtNode override needed.
      profiler?.begin(Z.geomDoors);
      renderDoorGraphicsInto();
      profiler?.end(Z.geomDoors);
      renderer.setRenderTarget(null);
      renderer.setMRT(previousMRT);
    }
    function runPresentCompositePass() {
      // THE SUN-SHADOW DEBUG VIEW (author, 2026-07-26) — when a view is picked
      // it REPLACES the present entirely rather than blending over it: the
      // point is to see the shadow field alone, on white, with nothing else in
      // the frame to mistake it for. `off` (the default, and the only thing a
      // player ever has) returns null and costs one comparison.
      const debugQuad = sunShadows.getDebugQuad(getSunShadowRenderState().params?.debugView ?? 'off');
      profiler?.begin(Z.presentBlit);
      (debugQuad ?? presentQuad).render(renderer); // three's own fullscreen path — carries its own camera
      profiler?.end(Z.presentBlit);
    }
    // light.accumulate — ambient/exterior light PLUS point-light illumination
    // as of 2026-07-18 (coloration, darkness sources, animations, the global
    // light's darkness-window gate are later rungs of docs/planning/Light-
    // Parity.md §5). Runs AFTER geometry.world (which fills sceneColor) and
    // before present.composite (which reads sceneLit): the env snapshot is
    // already refreshed for this frame by updateEnvSnapshot() up in renderFrame.
    function runLightAccumulatePass() {
      const env = lastEnvSnapshot?.env ?? {};
      const darkness01 = env.darkness01 ?? 0;
      // The darkness-realism lever (see setDarknessRealism): 0 = Foundry parity
      // (default), 1 = true dark. Read once per frame, applied to the ambient
      // floor here and to the region-darkness endpoint below (same endpoint,
      // so a region that darkens to full also respects realistic mode).
      const darknessRealism01 = _darknessRealism01;
      profiler?.begin(Z.lightAmbient);
      lastAmbientColors = computeAmbientColors(env, darknessRealism01);
      // dim/bright no longer read here directly — point lights now compute
      // their OWN local (region-aware) dim/bright per light, every frame,
      // inside updatePointLightMeshes (2026-07-19) — see that function's
      // own header. `background` is still the scene-wide floor
      // envLight/regions read.
      const { background } = lastAmbientColors;

      // GLOBAL ILLUMINATION ("the sun") — 2026-07-19, the "global light fix".
      // Raises the illum FLOOR only, not the dim/bright ladder point lights
      // read for their own switchColor (see environmental-light.js#compute
      // GlobalLightFloor's header for why it isn't a mesh). Safe under MAX-
      // blend order (illumQuad fills first, point-light meshes draw after):
      // a point light's own un-raised edge value can only ever be <= the
      // already-raised fill, so MAX-ing it in is a no-op there, never a
      // darkening.
      const globalLight = readGlobalLightConfig(darkness01);
      lastGlobalLightFloor = computeGlobalLightFloor(globalLight.config, lastAmbientColors);
      const raisedBackground = maxRgb(background, lastGlobalLightFloor);

      envLight.setAmbient(raisedBackground);
      // THE SKY LIGHT's screen→world gate needs THIS frame's camera rect. Pushed
      // here, beside setAmbient, because the two are the same kind of thing —
      // per-frame scalars the illumination pass reads — and separating them is
      // how one of them ends up updated on a different cadence from the other.
      if (view) envLight.setViewRect(viewToWorldRect(view, canvasW / canvasH));
      profiler?.end(Z.lightAmbient);

      // SUN SHADOWS — re-march ONLY if the quantised sun, the masks, the floor
      // or a param moved. Almost every frame this is three comparisons and a
      // return; the expensive path is a few times a minute at most. It runs
      // BEFORE illumQuad below, because that fill samples the field this writes.
      profiler?.begin(Z.lightSunBake);
      sunShadows.maybeBake(view?.floorIndex ?? 0);
      profiler?.end(Z.lightSunBake);

      // THE WATER BODY PACK — same posture, same reason it lives in the FRAME
      // LOOP rather than a residency pass: a mask repaint is not a camera
      // event, so a camera-gated rebake would leave the author's brushstrokes
      // invisible until they panned (`feedback_residency_sync_vs_render_loop`,
      // and the trap Water.md §5.1 names in advance). Almost every frame this
      // is one integer compare and a return; the jump flood itself runs only
      // when the mask version or the resolved floor actually moves — which
      // `waterBody.getStatus()` reports as `bakes` vs `polls` so the two can
      // be seen NOT to track each other.
      profiler?.begin(Z.lightWaterBake);
      waterBody.maybeBake(view?.floorIndex ?? 0);
      profiler?.end(Z.lightWaterBake);
      // Re-crop the tier-0 surface quad to the water's AABB — gated on the same
      // bake generation, so a quiet frame costs one integer compare. The
      // viewRect is for tier 3's synthesised eye ONLY and is never gated —
      // same call specular makes below, for the same reason.
      profiler?.begin(Z.lightWaterSync);
      waterSurface.sync(view?.floorIndex ?? 0, view ? viewToWorldRect(view, canvasW / canvasH) : null);
      profiler?.end(Z.lightWaterSync);
      // FLUID: same cadence, same shape — cheap to call, one string compare when
      // nothing changed, and it owns its own mask-url change detection.
      profiler?.begin(Z.lightFluidSync);
      fluidSurface.sync(view?.floorIndex ?? 0);
      profiler?.end(Z.lightFluidSync);

      // REGION-DRIVEN DARKNESS ("Adjust Darkness Level", 2026-07-19) — the
      // RAW ambient endpoints (not the pre-mixed background: each region
      // re-mixes by its OWN per-fragment adjusted darkness). The darkness
      // endpoint is pulled toward black by the SAME realism lever as the
      // ambient floor (mix(darkness, black, realism) = darkness × (1-realism)),
      // so a region that darkens an area also honours realistic mode rather
      // than flooring at Foundry's darkness colour there.
      const rawDaylight = env?.ambient?.daylight ?? [0.93, 0.93, 0.93];
      const rawDarkness = env?.ambient?.darkness ?? [0.14, 0.14, 0.28];
      const realismScale = 1 - darknessRealism01;
      uRegionDaylightColor.value.set(rawDaylight[0], rawDaylight[1], rawDaylight[2]);
      uRegionDarknessColor.value.set(
        rawDarkness[0] * realismScale,
        rawDarkness[1] * realismScale,
        rawDarkness[2] * realismScale
      );
      // SHINE's readability-floor subtraction (2026-07-27, author-diagnosed) —
      // the IDENTICAL triple `uRegionDarknessColor` just received, one line up.
      // Not a coincidence: both are "Foundry's darkness endpoint, pulled toward
      // black by the SAME realism lever" — reusing rather than re-deriving it
      // is what keeps specular's floor and the region system's floor from ever
      // disagreeing about what "the floor" is.
      specularSurface.setDarknessFloor(
        rawDarkness[0] * realismScale,
        rawDarkness[1] * realismScale,
        rawDarkness[2] * realismScale
      );
      // Read ONCE, shared by both — see readElevationFilteredDarknessRegions'
      // own header for why a light needs the SAME active-region set a
      // region-mesh draw uses (2026-07-19, the per-light-region-aware-
      // ambient fix), and (2026-07-20) the SAME currentFloor for candle
      // wall-clipping — never a second, potentially-drifting floor lookup.
      profiler?.begin(Z.lightRegions);
      const { regions: activeRegions, currentFloor } = readElevationFilteredDarknessRegions();
      updateRegionDarknessMeshes(darkness01, activeRegions);
      profiler?.end(Z.lightRegions);

      profiler?.begin(Z.lightPointUpdate);
      lastGridSizePixels = pointLights.update(darkness01, activeRegions, env, darknessRealism01, currentFloor);
      profiler?.end(Z.lightPointUpdate);
      // Reconcile the flame billboard from the same candle render state the
      // light merge above just read (drawn below, into scene.lit).
      profiler?.begin(Z.lightCandleSync);
      updateCandleFlame();
      profiler?.end(Z.lightCandleSync);
      // Every loaded vegetation mesh's live motion/shadow uniforms — SAME
      // "every frame, not just on residency pass" placement as the candle
      // call just above (see `syncAllVegetationMotionForFrame`'s own header
      // for the live-test bug this fixes: a FOH/ROH slider drag "did nothing
      // until I panned the camera").
      profiler?.begin(Z.lightVegSync);
      syncAllVegetationMotionForFrame();
      profiler?.end(Z.lightVegSync);
      // The wind field debug overlay (a no-op grid rebuild check when disabled).
      profiler?.begin(Z.lightWindOverlaySync);
      updateWindFieldOverlay();
      profiler?.end(Z.lightWindOverlaySync);

      // THE "BLACK OUTSIDE THE LIGHT RADIUS" FIX (2026-07-19). buf:scene.illum
      // is built from THREE sequential render() calls to the SAME target
      // (illumQuad, then regionScene, then lightScene) — a prior version of
      // this comment claimed "later render() calls to the SAME bound target
      // do not [clear]", stated confidently and NEVER actually verified: read
      // against the vendored three.webgpu.js (Background#update:
      // `renderContext.clearColor = renderer.autoClearColor === true`,
      // evaluated on EVERY render() call, gated only by `renderer.autoClear`
      // — which this project's own "ghost-hunting round 2/3" notes (above,
      // this file's history) already confirmed defaults `true` and is
      // NEVER overridden anywhere) — the claim is FALSE. Every one of these
      // three render() calls clears the colour buffer first by default. So
      // regionScene's call wiped illumQuad's ambient fill down to (0,0,0,0)
      // everywhere except inside a region's own footprint, and lightScene's
      // call then wiped THAT down to (0,0,0,0) everywhere except inside a
      // light's own mesh (a light's own switchColor/falloff math needs no
      // texture read, so MAX-blending it against a freshly-zeroed buffer
      // still shows correctly — which is exactly why every light looked
      // right while everything between and beyond them read as pure black).
      // This has been true since point lights first landed (increment 2a,
      // TWO calls — illumQuad, lightScene — already exhibited a 2-step
      // version); it went unnoticed because every test view stayed inside
      // overlapping light coverage until this session's zoomed-out tests.
      //
      // FIX: disable colour-clearing for the DURATION of this multi-call
      // sequence (the exact idiom the vendored three.webgpu.js uses
      // internally in several places for the identical situation — save the
      // flag, set false, do the multi-draw, restore). Safe here specifically
      // because illumQuad's OWN draw is a fullscreen, opaque, unconditional
      // overwrite (fills 100% of the target regardless of prior content), so
      // skipping the hardware clear before it changes nothing — the ONLY
      // effect of this flag is preventing regionScene/lightScene's later
      // calls from wiping what illumQuad (and each other) already drew.
      // `sceneIllum` has no depth/stencil buffer (describeSceneColor's own
      // `depth:false`), so autoClearColor alone is the complete, correct fix
      // — no depth/stencil clearing is being silently skipped alongside it.
      // UI-SHADOW (2026-07-20 v6): read open windows, project their stamps,
      // push uniforms into `uiShadow` — consumed by the COMPOSITE shader below
      // (envLight.compositeMaterial, built with uiShadow.visNode), NOT drawn
      // here. No separate render() call for this feature at all (the v6 perf
      // fix: an extra render pass was the dominant per-frame cost, not the DOM
      // read — see buildUiShadowVisibility's header). With no windows open,
      // updateUiShadowStamps clears every uniform, visNode evaluates to a
      // uniform 1, and the composite's multiply is a provable no-op.
      profiler?.begin(Z.lightUiShadow);
      updateUiShadowStamps();
      profiler?.end(Z.lightUiShadow);
      const previousAutoClearColor = renderer.autoClearColor;
      renderer.autoClearColor = false;
      profiler?.begin(Z.lightDrawIllum);
      renderer.setRenderTarget(sceneIllum);
      illumQuad.render(renderer); // buf:scene.illum = ambient background (sRGB), raised by global illumination if active
      profiler?.end(Z.lightDrawIllum);
      // Darkness-region meshes OVERWRITE (discard outside their own shape,
      // no blending) the ambient fill within their own footprint — BEFORE
      // point lights, so a light sitting inside a darkened/brightened region
      // MAX-blends against the REGION-ADJUSTED floor, not the base one.
      profiler?.begin(Z.lightDrawRegions);
      renderer.render(regionScene, camera);
      profiler?.end(Z.lightDrawRegions);
      // MAX-blends every active point light on top of the (possibly region-
      // adjusted) ambient fill — same target, same camera as geometry.world/
      // occlusion (world-space).
      profiler?.begin(Z.lightDrawPoints);
      renderer.render(pointLights.lightScene, camera);
      profiler?.end(Z.lightDrawPoints);
      // WINDOW LIGHT (docs/planning/Windows.md) — ADDS on top of everything
      // above, same target, same camera, same guarded (autoClearColor=false)
      // sequence: a torch standing in a sunbeam should be brighter than
      // either alone, which is what ADD (rather than MAX) gives. `sync`
      // BEFORE the visibility check, never inside it — same reasoning
      // `runSurfaceResponsePass` states for specular: gating the load on
      // `hasContent()` would mean the mesh could never become visible in the
      // first place.
      profiler?.begin(Z.lightDrawWindow);
      windowSurface.sync(view?.floorIndex ?? 0);
      if (windowSurface.hasContent()) renderer.render(windowSurface.scene, camera);
      profiler?.end(Z.lightDrawWindow);
      renderer.autoClearColor = previousAutoClearColor;
      // COLORATION (increment 3, 2026-07-19) — its OWN target, a SINGLE
      // render() call (autoClearColor restored above), so the ordinary
      // "first render() after setRenderTarget clears" behaviour is correct
      // and wanted here: an area with no lights nearby should stay exactly
      // black/zero (no ambient floor to pre-fill, unlike illum's), and a
      // fresh per-frame clear is exactly what makes that true rather than
      // accumulating stale coloration from a previous frame.
      profiler?.begin(Z.lightDrawColoration);
      renderer.setRenderTarget(sceneColoration);
      renderer.render(pointLights.colorationScene, camera);
      profiler?.end(Z.lightDrawColoration);
      // scene.lit = EOTF(OETF(albedo) × illum + coloration) — the coloration
      // is ADDED inside the composite now, in GAMMA space (Foundry parity;
      // the old separate additive quad blended in LINEAR space and washed the
      // scene to one hue — see environmental-light.js's composite essay). The
      // coloration target above is fully rendered before this reads it.
      profiler?.begin(Z.lightDrawComposite);
      renderer.setRenderTarget(sceneLit);
      compositeQuad.render(renderer);
      profiler?.end(Z.lightDrawComposite);
      // CANDLE FLAMES — an additive glow on top of the fully-composited lit
      // scene. compositeQuad already filled sceneLit; an ordinary render() here
      // would WIPE it first (autoClearColor defaults true — the exact trap the
      // illum sequence above documents), so guard the clear for this one draw.
      if (candleFlameMesh && candleFlameMesh.visible) {
        profiler?.begin(Z.lightDrawCandle);
        const prevFlameAutoClear = renderer.autoClearColor;
        renderer.autoClearColor = false;
        renderer.render(candleFlameScene, camera);
        renderer.autoClearColor = prevFlameAutoClear;
        profiler?.end(Z.lightDrawCandle);
      }
      // THE WIND FIELD DEBUG OVERLAY — same guarded-additive draw as the
      // candle flame just above (same target, same camera, same "don't wipe
      // what compositeQuad/the flame already drew" guard). OFF by default.
      if (windOverlayMesh && windOverlayMesh.visible) {
        profiler?.begin(Z.lightDrawWindOverlay);
        const prevWindAutoClear = renderer.autoClearColor;
        renderer.autoClearColor = false;
        renderer.render(windOverlayScene, camera);
        renderer.autoClearColor = prevWindAutoClear;
        profiler?.end(Z.lightDrawWindOverlay);
      }
      renderer.setRenderTarget(null);
    }

    /**
     * surface.response (docs/planning/Specular.md) — SHINE, tiers 0-2.
     *
     * Draws the specular subsystem's own dedicated scene into scene.lit: a
     * MULTIPLY mesh that lets a real conductor suppress the diffuse it replaces,
     * then an ADD mesh for the highlights. Same guarded-clear discipline as the
     * candle flame and the particles above — `light.accumulate` ended with
     * `setRenderTarget(null)`, so re-bind and turn `autoClearColor` OFF or the
     * first `render()` wipes the whole composited scene.
     *
     * ⚠️ NO MRT SCOPING HERE, and that is checked rather than skipped:
     * `runGeometryWorldPass` saves/sets/RESTORES the renderer-global attr MRT,
     * so by the time this runs there is no attr attachment bound and scene.lit
     * is single-attachment. Setting an `mrtNode` on these materials would be
     * actively harmful — `MRTNode` matches its keys against the bound target's
     * TEXTURE NAMES, and a key with no match yields an empty output struct, i.e.
     * no fragment output at all (vt/scene-attr.js's own header).
     *
     * Skips ENTIRELY when the effect is off or no `_Specular` mask has loaded —
     * a true JS early-return, zero GPU work, not a uniform set to zero
     * (Effects.md Law 4).
     */
    function runSurfaceResponsePass() {
      // The per-frame push happens BEFORE the visibility check, never inside
      // it: `sync` is what SETS visibility (it learns the mask arrived and the
      // params resolved), so gating it on `hasContent()` would mean the meshes
      // could never become visible in the first place — a deadlock that would
      // read on screen as "the effect does nothing", with every test green.
      specularSurface.sync(view?.floorIndex ?? 0, view ? viewToWorldRect(view, canvasW / canvasH) : null);
      if (!specularSurface.hasContent()) return;
      const previousAutoClear = renderer.autoClearColor;
      renderer.setRenderTarget(sceneLit);
      renderer.autoClearColor = false;
      profiler?.begin(Z.surfSpecular);
      renderer.render(specularSurface.scene, camera);
      profiler?.end(Z.surfSpecular);
      renderer.autoClearColor = previousAutoClear;
      renderer.setRenderTarget(null);
    }

    /**
     * surface.particles (docs/planning/Particles.md §16) — draw the GPU particles
     * additively over the fully-lit scene. light.accumulate ended with
     * setRenderTarget(null), so re-bind sceneLit and GUARD the clear
     * (autoClearColor=false) exactly like the candle flame above — an unguarded
     * render() would wipe what the lighting pass composited. Positions were
     * advanced by particleEngine.step() in renderFrame (sims.particles) before the
     * plan runs; this only draws: ONE InstancedBufferGeometry, positions straight
     * from the arena, never a scene object per particle.
     */
    function runSurfaceParticlesPass() {
      const drawParticles = windParticlesEnabled && particleEngine?.scene;
      const drawGusts = windGustsEnabled && gustEngine?.scene;
      if (!drawParticles && !drawGusts) return;
      // Bind sceneLit ONCE and guard the clear (light.accumulate ended with
      // setRenderTarget(null)); draw whichever of the two additive effects are
      // enabled — they are independent toggles sharing one guarded pass, so a
      // scene running only one pays for only one render() but no extra bind.
      const prevParticleAutoClear = renderer.autoClearColor;
      renderer.setRenderTarget(sceneLit);
      renderer.autoClearColor = false;
      if (drawParticles) {
        profiler?.begin(Z.surfDust);
        renderer.render(particleEngine.scene, camera);
        profiler?.end(Z.surfDust);
      }
      if (drawGusts) {
        profiler?.begin(Z.surfGusts);
        renderer.render(gustEngine.scene, camera);
        profiler?.end(Z.surfGusts);
      }
      renderer.autoClearColor = prevParticleAutoClear;
      renderer.setRenderTarget(null);
    }

    /**
     * post.bloom (docs/planning/Bloom.md) — the dual-filter bloom pyramid, run
     * AFTER surface.particles (scene.lit fully composited) and BEFORE
     * present.composite (the grade). Reads scene.lit, builds the blur pyramid
     * through the bloom mip targets, and additively composites the two-band
     * result back into scene.lit. Skips ENTIRELY when disabled — a true JS
     * early-return, zero GPU work (Effects.md: gating by uniform is not gating).
     */
    function runPostBloomPass() {
      const st = getBloomRenderState();
      if (!st.enabled) return;
      const p = st.params || {};

      // Push resolved params into the build-once uniforms.
      profiler?.begin(Z.bloomUniforms);
      const u = bloom.uniforms;
      u.threshold.value = bloomNum(p.threshold, 1.0);
      u.knee.value = bloomNum(p.knee, 0.5);
      u.strength.value = bloomNum(p.strength, 1.0);
      u.coreStrength.value = bloomNum(p.coreStrength, 1.0);
      u.atmoStrength.value = bloomNum(p.atmoStrength, 0.5);
      u.spillEnabled.value = p.outdoorSpillSuppress === false ? 0 : 1;
      u.spillLo.value = bloomNum(p.spillLumLo, 0.42);
      u.spillHi.value = bloomNum(p.spillLumHi, 0.92);
      const ct = hexToRgb01(p.coreTint ?? '#ffffff');
      const at = hexToRgb01(p.atmoTint ?? '#fff0dc');
      u.coreTint.value.set(ct[0], ct[1], ct[2]);
      u.atmoTint.value.set(at[0], at[1], at[2]);

      profiler?.end(Z.bloomUniforms);
      const prevAutoClear = renderer.autoClearColor;

      // 1) BRIGHT — masked soft-knee threshold of scene.lit → mip0 (full overwrite).
      profiler?.begin(Z.bloomBright);
      renderer.setRenderTarget(bloomMips[0]);
      bloomBrightQuad.render(renderer);
      profiler?.end(Z.bloomBright);

      // 2) DOWNSAMPLE — mip0→mip1 with the Karis average (firefly fix), then the
      //    plain 13-tap down the rest of the chain. uInvTexel = 1/sourceRes.
      profiler?.begin(Z.bloomDown);
      for (let k = 0; k < BLOOM_MIP_COUNT - 1; k++) {
        const src = bloomMips[k];
        if (k === 0) {
          bloom.downsampleKaris.inputNode.value = src.texture;
          bloom.downsampleKaris.uInvTexel.value.set(1 / src.width, 1 / src.height);
          renderer.setRenderTarget(bloomMips[k + 1]);
          bloomDownKarisQuad.render(renderer);
        } else {
          bloom.downsample.inputNode.value = src.texture;
          bloom.downsample.uInvTexel.value.set(1 / src.width, 1 / src.height);
          renderer.setRenderTarget(bloomMips[k + 1]);
          bloomDownQuad.render(renderer);
        }
      }

      // 3) UPSAMPLE (additive tent) — two INDEPENDENT bands. Guard the clear so
      //    the additive blend accumulates the coarser mip into the finer one
      //    (an unguarded render would wipe the downsample content first).
      profiler?.end(Z.bloomDown);
      renderer.autoClearColor = false;
      // CORE band: mip2 → mip1 → mip0 (tight spread) ⇒ mip0 = smooth blur of 0..2.
      profiler?.begin(Z.bloomUpCore);
      bloom.upsample.uFilterRadius.value = bloomSpreadToRadius(bloomNum(p.coreSpread, 0.4));
      for (const k of [1, 0]) {
        bloom.upsample.inputNode.value = bloomMips[k + 1].texture;
        renderer.setRenderTarget(bloomMips[k]);
        bloomUpQuad.render(renderer);
      }
      profiler?.end(Z.bloomUpCore);
      // ATMOSPHERE band: mip5 → mip4 → mip3 (wide spread) ⇒ mip3 = smooth blur of 3..5.
      profiler?.begin(Z.bloomUpAtmo);
      bloom.upsample.uFilterRadius.value = bloomSpreadToRadius(bloomNum(p.atmoSpread, 0.7));
      for (const k of [4, 3]) {
        bloom.upsample.inputNode.value = bloomMips[k + 1].texture;
        renderer.setRenderTarget(bloomMips[k]);
        bloomUpQuad.render(renderer);
      }
      profiler?.end(Z.bloomUpAtmo);

      // 4) COMPOSITE — core (mip0) + atmosphere (mip3) additively into scene.lit.
      //    autoClearColor is still false here — an unguarded clear would wipe the
      //    whole composited scene, so it MUST stay off until after this draw.
      profiler?.begin(Z.bloomComposite);
      renderer.setRenderTarget(sceneLit);
      bloomCompositeQuad.render(renderer);
      profiler?.end(Z.bloomComposite);

      renderer.autoClearColor = prevAutoClear;
      renderer.setRenderTarget(null);
    }
    // 'masks.occlusion'/'light.accumulate': the "add one line, widen fromStage"
    // the comment above predicted, done twice now. Both are hoisted function
    // declarations, so referencing them here (defined later / above in this
    // closure) is valid. See each pass's own definition for its scope note.
    const passImpls = {
      'masks.occlusion': runMaskOcclusionPass,
      'geometry.world': runGeometryWorldPass,
      'light.accumulate': runLightAccumulatePass,
      'surface.response': runSurfaceResponsePass,
      'surface.particles': runSurfaceParticlesPass,
      'post.bloom': runPostBloomPass,
      'present.composite': runPresentCompositePass,
    };
    // Today this resolves to exactly ['masks.occlusion', 'geometry.world',
    // 'present.composite'] — asserted against the real PASSES in
    // graph/__tests__/run-frame.test.mjs, so a future live pass added to this
    // stage range without a `passImpls` entry fails a Node test instead of
    // silently never running.
    const framePlan = planFrame(PASSES, { fromStage: 'masks', toStage: 'present' });
    /** What `runPassPlan` actually ran on the most recent frame — for `getFramePlanInfo`. */
    let lastFramePlanRan = [];

    // ========================================================================
    // frame.snapshot — THE res:env THIRD, WIRED (2026-07-18). Status STAYS
    // 'future' in graph/passes.js on purpose — read this before "finishing" it.
    // ========================================================================
    //
    // graph/passes.js declares frame.snapshot as creating THREE resources:
    // res:env (time/sun/weather/wind/darkness), res:view (camera/viewport),
    // res:scene (scene docs). Only res:env has a real, fully-designed shape
    // today (world/environment.js#buildEnvSnapshot, built + Node-tested this
    // session's predecessor). res:view/res:scene do not yet have a real
    // consumer to define their shape against — inventing one now would be
    // designing for a hypothetical, exactly what this project's own doctrine
    // warns against. So: build the real third, wire it in for real every
    // frame, and leave the pass's status honestly 'future' until all three
    // exist. Flipping to 'live' with only one of three declared outputs real
    // would be a MISSING finding waiting to happen the moment anything reads
    // res:view/res:scene from a live-status pass (pass-health.js's own job).
    //
    // NOT routed through runPassPlan/framePlan above: planFrame correctly
    // SKIPS a 'future'-status pass (that is what 'future' means), so this is
    // called directly, the same way updateCamera()/syncTokenPlacements()
    // already are — genuinely-not-ready work stays hand-wired until the
    // moment it can honestly claim 'live', never faked into the graph early.
    const frameClock = makeFrameClock();
    /** The env snapshot from the most recent frame, plus where darkness came
     * from — for getEnvSnapshotInfo() / the Diagnostics debug report. */
    let lastEnvSnapshot = null;

    // ── THE SKY ────────────────────────────────────────────────────────────
    // `todHour` HAS a real source as of 2026-07-23: the day clock
    // (world/day-clock.js), driven by the astrolabe in `aesthetic` mode or by
    // Foundry's own world clock in `synced` mode. It owns the hour; nothing
    // else may. The long-standing "no calendar, no author-facing control" gap
    // that every comment in this region used to acknowledge is CLOSED.
    const dayClock = createDayClock();
    /** Unsubscribe for the world-clock watcher — only live in `synced` mode. */
    let worldTimeUnsub = null;
    /** Cloud cover 0..1 — now a real authored value from the sky settings
     * (world- or scene-scoped), not the debug lever it was. `null` = nothing
     * has set it, so the DEFAULT_WEATHER clear sky answers. */
    let cloudCoverOverride = null;
    /** Who last set `cloudCoverOverride` — see `setCloudCover`'s own doc. */
    let cloudCoverSource = 'default';
    /** The sky-light lever, 0..1. 0 = exact Foundry parity (a mathematical
     * no-op) — see effects/sky-access.js for why the default cannot be else. */
    let skyRealism01 = 0;
    /** THE ENVIRONMENTAL GRADE strength, 0..1 (docs/planning/Grade.md). 0 =
     * neutral (the automatic ToD/weather look is off). This is the lever that
     * carries the cloud desaturation the deleted sky veil couldn't. */
    let gradeEnvStrength = 0;
    // THE ARTISTIC GRADE — a first-class effect (`effects/grade/grade.js`). Its
    // resolved {enabled, params} arrive via the injected `getGradeLookState`
    // (like getBloomRenderState), read + pushed each frame below. Disabled ⇒
    // identity ⇒ an un-authored scene is pixel-unchanged.
    /** Bumped whenever the sky handle is rebuilt, same contract as
     * `shadowHandleVersion`. */
    let skyHandleVersion = 0;
    /** THE SKY HANDLE (effects/sky-access.js) — the outdoor light described
     * once. Starts neutral so a frame before the first env snapshot is a no-op. */
    let skyHandle = createSkyHandle();
    /** Bumped whenever the sky changes, so a consumer caching anything derived
     * from `shadowHandle` can tell (the same contract windHandle.version has). */
    let shadowHandleVersion = 0;
    /** THE SHADOW HANDLE (effects/shadow-access.js) — the sky described ONCE.
     * Starts neutral (overhead clear noon) so a caster built before the first
     * env snapshot still gets a finite, sane answer rather than a null check. */
    let shadowHandle = createShadowHandle();

    function updateEnvSnapshot() {
      const time = frameClock.tick();
      // THE DAY CLOCK, ticked on the SIM delta — so time-of-day decelerates
      // with everything else when Foundry pauses, rather than being the one
      // system that carries on regardless. See world/day-clock.js#tick.
      const todHour = dayClock.tick(time.dtSec);
      const darkness = readSceneDarkness();
      // The ambient palette Foundry itself renders from (canvas.colors) — read
      // through the ONE adapter so the light pass reproduces Foundry's ladder
      // rather than re-reading a global. `readSceneAmbient` never throws and
      // reports source/reason exactly like `readSceneDarkness`.
      const ambient = readSceneAmbient();
      // Weather was previously never passed AT ALL, so `cloudCover01` was
      // permanently 0 and the atmospheric half of the shadow model could not
      // be exercised. Same posture: a debug lever over an acknowledged gap.
      const weather = cloudCoverOverride === null ? undefined : { cloudCover01: cloudCoverOverride };
      const env = buildEnvSnapshot({
        time,
        todHour,
        weather,
        darknessInput: darkness.darkness01,
        ambientInput: { daylight: ambient.daylight, darkness: ambient.darkness, brightest: ambient.brightest },
      });
      // THE SHADOW HANDLE — rebuilt only when the sky actually MOVED, not every
      // frame: it is an immutable value object, and churning a new one per
      // frame would defeat the version-compare its own consumers rely on.
      const skyKey = `${env.sun.elevationDeg.toFixed(3)}|${env.sun.azimuthDeg.toFixed(3)}|${env.sun.dayFactor01.toFixed(4)}|${env.weather.cloudCover01.toFixed(4)}|${skyRealism01.toFixed(4)}`;
      if (skyKey !== lastSkyKey) {
        lastSkyKey = skyKey;
        shadowHandleVersion += 1;
        shadowHandle = createShadowHandle({
          version: shadowHandleVersion,
          sun: env.sun,
          weather: env.weather,
        });
        // THE SKY HANDLE rides the SAME rebuild guard as the shadow handle, and
        // deliberately so: they are two descriptions of one afternoon, and a
        // frame where the shadows had moved on but the light had not would be
        // exactly the "shadows answering to a different sky" construction
        // `env/one-sun` exists to prevent — reintroduced one layer up.
        skyHandleVersion += 1;
        skyHandle = createSkyHandle({
          version: skyHandleVersion,
          sun: env.sun,
          weather: env.weather,
          realism01: skyRealism01,
        });
        envLight.setSky(skyHandle.ambientMultiplierRgb);
      }

      // THE ENVIRONMENTAL GRADE (docs/planning/Grade.md) — resolved from THIS
      // frame's env (ToD saturation + the weather desaturation that replaces the
      // deleted sky veil), scaled by the strength lever so it ships neutral, and
      // pushed to the present-pass grade. Cheap enough to do every frame (a
      // handful of scalars); no rebuild-guard needed, unlike the handles above.
      gradePresent.setEnvGrade(scaleGradeToIdentity(resolveEnvGrade(env), gradeEnvStrength));

      // THE ARTISTIC (Look) GRADE — read the effect's resolved params and push.
      // Converts the authored schema (split-tone COLOURS, a tone-map NAME, a LUT
      // NAME) into the primitive's shape (lift/gain vectors) + the tail. Disabled
      // ⇒ identity + no tone map, so parity holds. The LUT texture is swapped
      // lazily when the name changes (loadNamedLut), not per frame.
      pushGradeLook();

      const clock = dayClock.read();
      lastEnvSnapshot = {
        env,
        darkness,
        ambient,
        todHourSource: clock.mode === 'synced' ? 'foundry-world-clock' : 'day-clock:aesthetic',
        dayClock: clock,
        timeScale: time.timeScale,
        paused: time.paused,
        cloudSource:
          cloudCoverOverride === null ? 'default:no-weather-owner-yet' : `${cloudCoverSource}:${cloudCoverOverride}`,
        shadow: { version: shadowHandleVersion, ...shadowHandle.atmosphere },
      };
      return env;
    }
    /** Last sky signature — see updateEnvSnapshot's own rebuild guard. */
    let lastSkyKey = '';

    // ── THE PAUSE RAMP ─────────────────────────────────────────────────────
    // Foundry's pause eases the whole world to a standstill over five seconds
    // and back (author-chosen, symmetric). ONE call into the frame clock does
    // it for every effect at once: `uGlobalTimeMs` (animated lights, candle
    // flames, the wind overlay) and `dtSec` (wind sim, particles, gusts) are
    // all downstream of the clock's scale, so nothing here enumerates effects.
    // That is the whole dividend of the `time/one-clock` wall.
    //
    // `watchGamePaused` fires once immediately, so a client loading into an
    // already-paused world arrives stopped rather than running at full speed
    // until someone toggles it. The FIRST application is instant (ramp 0) for
    // the same reason: easing down from full speed on load would look like a
    // five-second stutter at startup, not like a pause.
    /** Unsubscribe for the pause watcher (canvas teardown). Declared BEFORE
     * `installPauseWatch` so the hoisted function can never hit its TDZ. */
    let pauseUnsub = null;
    function installPauseWatch() {
      if (pauseUnsub) return;
      let first = true;
      pauseUnsub = watchGamePaused((paused) => {
        frameClock.setScaleTarget(paused ? 0 : 1, first ? 0 : DEFAULT_PAUSE_RAMP_SEC);
        first = false;
      });
    }

    /**
     * THE DAY CLOCK's control surface — what the astrolabe drives. Every one of
     * these is a READ of Foundry at most; none of them writes `game.time`. See
     * world/day-clock.js's header for why that asymmetry is the design.
     * @param {number} hour @returns {object}
     */
    function setTimeOfDay(hour) {
      const accepted = dayClock.setHour(hour);
      return { accepted, ...dayClock.read() };
    }
    /** @param {number} hour @returns {object} sweep to an hour rather than snapping. */
    function sweepTimeOfDay(hour) {
      dayClock.syncTo(hour);
      return dayClock.read();
    }
    /** @param {number} hoursPerMinute @returns {object} */
    function setTimeRate(hoursPerMinute) {
      dayClock.setRate(hoursPerMinute);
      return dayClock.read();
    }
    /**
     * Switch time authority. Entering `synced` subscribes to Foundry's world
     * clock and jumps to it at once (no sweep — arriving in a mode should show
     * that mode's truth immediately); leaving it unsubscribes, so an aesthetic
     * scene can never be nudged by a combat round.
     * @param {string} mode - 'aesthetic' | 'synced'
     * @returns {object}
     */
    function disposeTimeWatches() {
      if (pauseUnsub) {
        pauseUnsub();
        pauseUnsub = null;
      }
      if (worldTimeUnsub) {
        worldTimeUnsub();
        worldTimeUnsub = null;
      }
    }

    function setTimeMode(mode) {
      const applied = dayClock.setMode(mode);
      if (worldTimeUnsub) {
        worldTimeUnsub();
        worldTimeUnsub = null;
      }
      if (applied === 'synced') {
        let first = true;
        worldTimeUnsub = watchWorldTimeOfDay((hour) => {
          if (first) dayClock.jumpTo(hour);
          else dayClock.syncTo(hour);
          first = false;
        });
      }
      return dayClock.read();
    }

    /**
     * `MapShine.setSunHour(h)` — kept as an alias for `setTimeOfDay` so every
     * existing note, doc and habit still works. It is no longer a "debug lever
     * over an acknowledged gap": the gap is closed, and this writes the real
     * day clock. Returns `accepted: false` in `synced` mode, where the world
     * clock is the only authority.
     * @param {number|null} hour @returns {object}
     */
    function setSunHour(hour) {
      if (hour === null || hour === undefined) {
        dayClock.jumpTo(12);
        return { accepted: true, ...dayClock.read(), note: 'reset to noon' };
      }
      return setTimeOfDay(hour);
    }
    /**
     * Cloud cover 0..1, or `null` for the clear-sky default. No longer a debug
     * lever: the sky settings (world- or scene-scoped) drive this for real, and
     * it feeds BOTH the sky light's colour/veil and the shadow handle's
     * softening from the same number.
     *
     * `source` is who is actually calling — `resolveAndApplySky` (boot.js)
     * passes `'sky-settings'` on every real resolve; a bare console call
     * (`MapShine.setCloudCover(0.5)`, still exported for exactly this) leaves it
     * at the default. The env-diagnostics `cloudSource` field reports whichever
     * one it was — calling every path "debug-override" (this function's OWN
     * former label, from before sky-settings existed) would tell a GM reading a
     * live scene's own authored weather that they are looking at a console poke
     * nobody made (feedback_instruments_must_not_lie).
     * @param {number|null} cover01 @param {string} [source]
     * @returns {object}
     */
    function setCloudCover(cover01, source = 'console') {
      cloudCoverOverride =
        cover01 === null || cover01 === undefined ? null : Math.min(1, Math.max(0, Number(cover01) || 0));
      cloudCoverSource = cloudCoverOverride === null ? 'default' : source;
      return { cloudCoverOverride, source: cloudCoverSource };
    }

    /**
     * THE SKY-LIGHT LEVER, 0..1 (docs/planning/Sky.md §8). `0` — the default —
     * makes the sky light a mathematical no-op, preserving the
     * pixel-identical-to-Foundry-at-noon parity check exactly. `1` is the full
     * atmospheric model.
     * @param {number} realism01 @returns {object}
     */
    function setSkyRealism(realism01) {
      skyRealism01 = Math.min(1, Math.max(0, Number(realism01) || 0));
      // Force the shared rebuild guard to fire so the change lands THIS frame
      // rather than waiting for the sun to move — a lever whose effect appears
      // some seconds later reads as broken.
      lastSkyKey = '';
      return { skyRealism01, note: skyRealism01 === 0 ? 'exact Foundry parity (the sky light is a no-op)' : null };
    }

    /**
     * THE ENVIRONMENTAL GRADE strength, 0..1 (docs/planning/Grade.md). This is
     * the automatic ToD/weather look — and the cloud desaturation the deleted
     * sky veil couldn't do. The env grade itself is re-pushed every frame from
     * env, so no rebuild-guard poke is needed here.
     * @param {number} strength01 @returns {object}
     */
    function setGradeEnvStrength(strength01) {
      gradeEnvStrength = Math.min(1, Math.max(0, Number(strength01) || 0));
      return { gradeEnvStrength };
    }

    /**
     * Read the Colour Grade effect's resolved params and push them to the
     * present grade — the artistic scope. Converts the authored SCHEMA
     * (`grade.js#GRADE_LOOK_PARAMS`: split-tone colours as hex, a tone-map name,
     * a LUT name) into the primitive's shape (lift/gain vectors) + the tail.
     * Disabled ⇒ identity + tone map 'none' ⇒ parity holds.
     */
    function pushGradeLook() {
      const st = getGradeLookState();
      if (!st?.enabled) {
        gradePresent.setArtGrade({}, { toneMapping: 'none', lutStrength: 0 });
        return;
      }
      const p = st.params || {};
      // Split-tone colours → the primitive's lift (shadows) / gain (highlights).
      // Scaled/mixed toward neutral so a picked colour is a TINT, not a full
      // channel replacement: lift neutral is black (× a small amount), gain
      // neutral is white (mix toward the tint). See Grade.md §14.
      const shadowRgb = hexToRgb01(p.shadows ?? '#000000');
      const highRgb = hexToRgb01(p.highlights ?? '#ffffff');
      const lift = [shadowRgb[0] * 0.15, shadowRgb[1] * 0.15, shadowRgb[2] * 0.15];
      const gain = [mix1(1, highRgb[0], 0.3), mix1(1, highRgb[1], 0.3), mix1(1, highRgb[2], 0.3)];
      gradePresent.setArtGrade(
        {
          exposure: p.exposure,
          contrast: p.contrast,
          saturation: p.saturation,
          vibrance: p.vibrance,
          temperature: p.temperature,
          tint: p.tint,
          lift,
          gamma: [1, 1, 1],
          gain,
        },
        // LUT strength stays 0 for now: the LUT shader path + placeholder are
        // wired, but bundled .cube loading is the next rung (grade.js's
        // `bundled-lut-loading`), so there is no real LUT to blend toward yet.
        { toneMapping: p.toneMapping ?? 'neutral', lutStrength: 0 }
      );
    }

    // THE OCCLUSION MASK — a REAL render target as of 2026-07-18, RADIAL-only.
    //
    // scene/occlusion.js has the full model ported and Node-tested, and the
    // shader in buildWholeImageMaterial() implements
    // Foundry's algorithm for real. This is the PRODUCER: runMaskOcclusionPass()
    // below renders each occludable token's RADIAL disc into this screen-space
    // RGBA target with MIN blending, every frame (tokens already sync position
    // every frame via syncTokenPlacements — this rides the same cadence).
    //
    // ⚠️ SCOPE — read before assuming this is Foundry-complete. The REAL
    // Foundry producer (client/canvas/layers/masks/occlusion.mjs) has TWO
    // independent halves: tokens (vision polygons + radial discs — what THIS
    // builds) and SURFACES, driven entirely by Region documents
    // (Scene#getSurfaces(), region.polygonTree) — a system this
    // project has not touched at all. Level/roof art defaults to SURFACE mode
    // (foundry/scene-layers.js:273), so THE HEADLINE "see the token under the
    // roof" case is NOT affected by this increment — it needs the Regions
    // half, a separate, materially larger piece of work. What this DOES make
    // real: any author-authored tile with RADIAL occlusion.modes set.
    // VISION (token sight-based reveal) is also not built this cut — see
    // runMaskOcclusionPass's own header.
    //
    // The clear value is Foundry's own (`CanvasOcclusionMask#clearColor =
    // [0,1,1,1]`), which is exactly "nothing occludes anything":
    //   R = 0 -> Fade says "occlude everywhere", but the per-object fade WEIGHT
    //            is what gates it, and that stays 0 — FADE is not wired this
    //            cut either (it needs testTokenOcclusion's spatial hit-test,
    //            not just RADIAL's radius-only shape; a documented future step).
    //   G = written per-frame by real token discs.
    //   B/A = 1 always (VISION/SURFACE not built) -> step() -> never occluded.
    const describeOcclusionMask = () => ({
      // Device pixels — see describeSceneColor's note (same pixel-ratio-parity fix).
      resolvedW: drawBufW,
      resolvedH: drawBufH,
      screenSized: true,
      type: THREE.UnsignedByteType,
      colorSpace: THREE.NoColorSpace,
      // NEAREST, not linear: a mask texel is an ELEVATION INDEX, not a colour
      // — interpolating one is meaningless (matches Foundry's own
      // `textureConfiguration.scaleMode: PIXI.SCALE_MODES.NEAREST`).
      filter: 'nearest',
      depth: false,
    });
    const occlusionMaskRT = allocator.create('occlusion.mask', describeOcclusionMask());
    const occlusionMask = {
      rt: occlusionMaskRT,
      texture: occlusionMaskRT.texture,
      visionActive: false, // stays false — vision half not built this cut
      elevationTable: [-Infinity],
    };

    // ========================================================================
    // masks.occlusion — THE PRODUCER, RADIAL-ONLY (2026-07-18). See the
    // occlusionMask block above for the full scope note (SURFACE/Regions and
    // VISION are NOT built this cut).
    // ========================================================================

    /** Reused across every renderer.setClearColor()/getClearColor() this pass
     * does, every frame — a fresh THREE.Color per frame would be exactly the
     * kind of small per-frame allocation this project's own hot-path
     * discipline avoids elsewhere (see frame-clock.js, itemStates pooling). */
    const _clearColorScratch = new THREE.Color();

    /** A tiny dedicated Scene for occlusion discs — kept separate from the
     * main `scene` so this pass's draw list is exactly the discs, nothing
     * else, with no risk of interacting with the main geometry pass. */
    const occlusionScene = new THREE.Scene();

    /** ONE shared unit-radius circle (24 segments), reused via per-mesh scale
     * — avoids rebuilding geometry per token per frame. Real Foundry draws a
     * genuine circle (PIXI.Graphics#drawCircle); CircleGeometry is the
     * equivalent primitive here, chosen over a quad+SDF specifically to avoid
     * needing a TSL discard node this cut. */
    const occlusionDiscGeometry = new THREE.CircleGeometry(1, 24);

    /** tokenItemId -> { mesh, material, uElevation } — reconciled each pass,
     * mirroring itemStates' own add/remove/update shape. Materials are
     * REUSED across frames (never rebuilt) so a token's shader compiles
     * exactly once, on first appearance. KNOWN GAP, bounded and documented
     * rather than silently ignored: an entry is never removed for a token
     * that is genuinely DELETED (only hidden — mesh.visible:false — when it
     * drops out of the current draw list), so this grows with the count of
     * distinct tokens ever seen in the session, not per frame. Full lifecycle
     * cleanup needs a deleteToken hook wired from boot.js; not built this cut. */
    const occlusionDiscs = new Map();

    /**
     * Build (once, on first appearance) one token's disc mesh — a flat green-
     * channel-only writer, MIN-blended into occlusionMask.
     *
     * MIN BLENDING (THREE.CustomBlending + MinEquation + OneFactor/OneFactor,
     * both RGB and alpha): the lowest occluder elevation wins at any pixel —
     * Foundry's own composite rule (occlusion.mjs's `PIXI.BLEND_MODES.MIN_ALL`).
     * R/B/A are written as their OWN channel's clear value (0/1/1) — a
     * deliberate no-op under MIN, so this disc affects ONLY the green
     * (RADIAL) channel, exactly like Foundry's own bit-packed padding trick
     * (`0xFF0000 | (occlusionElevation << 8) | ...`), expressed here as plain
     * floats instead of hex-OR'd bytes — TSL has no 8-bit-packing constraint
     * to work around.
     */
    function buildOcclusionDisc() {
      const { uniform, float, vec4 } = THREE.TSL;
      const uElevation = uniform(float(1));
      const material = new THREE.NodeMaterial();
      material.transparent = false;
      material.depthTest = false;
      material.depthWrite = false;
      material.blending = THREE.CustomBlending;
      material.blendEquation = THREE.MinEquation;
      material.blendSrc = THREE.OneFactor;
      material.blendDst = THREE.OneFactor;
      material.blendEquationAlpha = THREE.MinEquation;
      material.blendSrcAlpha = THREE.OneFactor;
      material.blendDstAlpha = THREE.OneFactor;
      material.fragmentNode = vec4(float(0), uElevation, float(1), float(1));
      const mesh = new THREE.Mesh(occlusionDiscGeometry, material);
      mesh.frustumCulled = false;
      occlusionScene.add(mesh);
      return { mesh, material, uElevation };
    }

    /**
     * Render this frame's occlusion mask: gather occludable tokens from the
     * CURRENT draw list, build the real elevation table, reconcile the disc
     * pool, draw with MIN blending, then refresh every drawn item's
     * uOcclusionElevation uniform against the fresh table.
     *
     * RADIAL-ONLY — see the occlusionMask block's header for the full scope
     * note. Token filter: real document data (`occludableRadius > 0`,
     * `!hidden`) — NOT Foundry's own `_getOccludableTokens` (which branches
     * on a world SETTING plus PIXI Token object state like `.controlled`/
     * `.interactive` this project's documents-only adapter doesn't read;
     * Keyhole.md §4.3 draws from documents, never placeables). A documented
     * simplification, not a bug: every visible token with a nonzero
     * occludable radius contributes a disc, always.
     */
    function runMaskOcclusionPass() {
      profiler?.begin(Z.masksSync);
      const distancePixels = readGridDistancePixels().distancePixels;
      const occluders = [];
      for (const it of lastItems) {
        if (it.kind !== 'token') continue;
        if (it.hidden) continue; // dimmed-for-GM tokens still occlude in real Foundry; hidden ones do not
        const radiusPx = computeTokenOcclusionRadiusPx({
          footprint: it.footprint,
          occludableRadius: it.occludableRadius ?? 0,
          distancePixels,
        });
        if (radiusPx <= 0) continue;
        occluders.push({
          id: it.id,
          elevation: it.key.elevation,
          centerX: it.footprint.centerX,
          centerY: it.footprint.centerY,
          radiusPx,
        });
      }

      occlusionMask.elevationTable = buildElevationTable(occluders.map((o) => o.elevation));

      // Reconcile the disc pool: add new, update every survivor, hide stale
      // (see occlusionDiscs' own doc for why "hide" not "dispose").
      const seen = new Set();
      for (const o of occluders) {
        seen.add(o.id);
        let entry = occlusionDiscs.get(o.id);
        if (!entry) {
          entry = buildOcclusionDisc();
          occlusionDiscs.set(o.id, entry);
        }
        entry.mesh.position.set(o.centerX, o.centerY, 0);
        entry.mesh.scale.set(o.radiusPx, o.radiusPx, 1);
        entry.mesh.visible = true;
        entry.uElevation.value = mapElevation(occlusionMask.elevationTable, o.elevation);
      }
      for (const [id, entry] of occlusionDiscs) {
        if (!seen.has(id)) entry.mesh.visible = false;
      }

      // Render into occlusionMask.rt — same symmetric save/restore pattern as
      // every other renderer-global-state touch in this file (rebindPresent,
      // the orientation self-test). Global clear colour is renderer state;
      // leaving it set to Foundry's cyan would corrupt the NEXT render call
      // (sceneColor's own clear) if not restored.
      profiler?.end(Z.masksSync);
      profiler?.begin(Z.masksDraw);
      const prevClearColor = renderer.getClearColor(_clearColorScratch); // writes into + returns the scratch object
      const prevClearAlpha = renderer.getClearAlpha();
      renderer.setRenderTarget(occlusionMask.rt);
      renderer.setClearColor(0x00ffff, 1); // Foundry's own CanvasOcclusionMask#clearColor = [0,1,1,1]
      renderer.clear(true, false, false);
      // SAME camera as geometry.world — see the streaming/whole-image
      // maskUV fixes' own notes: this is what makes screenUV line up between
      // this pass's output and the fragment that samples it, without hand-
      // deriving a new world->screen transform.
      renderer.render(occlusionScene, camera);
      renderer.setRenderTarget(null);
      renderer.setClearColor(prevClearColor, prevClearAlpha);
      profiler?.end(Z.masksDraw);

      // uOcclusionElevation refresh — every drawn item, every frame (cheap: a
      // per-item float set, no shader rebuild). uOcclusionWeights is NOT
      // touched here — it is static for an item's lifetime this cut (see
      // ensureItemMesh's/buildWholeImageMaterial's own notes on why).
      for (const state of itemStates.values()) {
        const elevation = state.item?.key?.elevation;
        if (elevation === undefined) continue;
        const value = mapElevation(occlusionMask.elevationTable, elevation);
        if (state.appearance) state.appearance.uOcclusionElevation.value = value;
        if (state.wholeImage) {
          for (const t of state.wholeImage.tiles) {
            if (t.appearance) t.appearance.uOcclusionElevation.value = value;
          }
        }
      }
    }

    // itemId -> item state (see ensureItemLoaded). ONE entry per DRAWABLE, not
    // per floor: a floor's background, its foreground (roof) art and every tile
    // are all just items, each with its own virtual texture, each placed in
    // world space by its own quad. That is what lets a roof and a rug sit at
    // different elevations on the same floor — the thing a per-floor model
    // structurally cannot express.
    const itemStates = new Map();
    const itemLoadErrors = [];
    /**
     * Items whose source is permanently broken (404, undecodable) — never
     * re-attempted. See the skip in updateResidency's phase 1 for the full
     * finding and the deliberate trade-off. Kept beside `itemLoadErrors`
     * because they are two halves of one thing: that array is what the author
     * SEES, this set is what the loader DOES, and letting them drift apart is
     * how "the report says one broken item" coexisted with "we re-fetch it
     * seventy-seven times".
     * @type {Set<string>}
     */
    const failedItemIds = new Set();

    /**
     * THE SHARED COARSE-PIN BUDGET (item 1b, 2026-07-17) — see
     * `residency.js#computeCoarsePinBudget`'s header for the full finding and
     * why an equal per-pack share, not a priority tier, is the fix. Read by
     * `ensureItemLoaded`/`buildPack` every time a NEW pack is created (an
     * already-loaded pack's coarse pin, once granted, is never re-evaluated —
     * this only governs pack CREATION, matching how the budget itself only
     * needs to be a reasonable bound, not perfectly live).
     *
     * Initialized to a conservative non-zero default (matches the mask cap
     * this replaces) rather than 0/uncapped — if `refreshCoarsePinBudget()`
     * were ever somehow skipped, falling back to UNCAPPED would silently
     * reopen exactly the bug this exists to close. There is no code path that
     * skips it (see its two call sites below), but the safe direction on an
     * uncomputed value is always the bounded one, not the dangerous one.
     */
    let currentCoarseBudget = { totalBudgetPages: 0, perPackMaxPages: 24, packCount: 1 };

    /**
     * Recompute the shared budget from the WHOLE scene's current pack count —
     * every floor, not just the viewed one (a background-prewarmed floor's
     * packs compete for the SAME budget). Deduplicated by item id: a token
     * visible from two floors is ONE pack (loaded once, `itemStates` keyed by
     * id), not two — counting it twice would UNDER-allocate everyone else for
     * no reason.
     *
     * Recomputed fresh on every call rather than cached — a cached pack count
     * is exactly the staleness class that just cost a session on token
     * placement (a snapshot outliving the thing it snapshotted). This is
     * comparatively cheap (pure document reads via `buildItems`, no I/O, no
     * GPU) and only runs on hook-driven passes, never per frame.
     */
    function refreshCoarsePinBudget() {
      const seen = new Set();
      for (let f = 0; f < floorCount; f++) {
        for (const item of buildItems(f)) seen.add(item.id);
      }
      // cache.capacityPages, not cache.stats() — a plain constant field, no
      // reason to pay for stats()'s full diagnostic scan just to read it.
      currentCoarseBudget = computeCoarsePinBudget(cache.capacityPages, seen.size);
      // THE RESERVE (item 1b, reservation half, 2026-07-17) — kept in lockstep
      // with the SAME totalBudgetPages the per-pack cap is computed from, so
      // "how big is the coarse budget" has exactly one source of truth. See
      // page-cache.js's header for why capping the ASK alone (the first cut)
      // wasn't enough: 'view' and 'coarse' competed for the same slots on
      // equal footing, so a busy viewport could pin the WHOLE cache before a
      // background-prewarmed floor's coarse request ever got a turn — and
      // that request is made exactly once, at pack creation, never retried.
      cache.coarseReservePages = currentCoarseBudget.totalBudgetPages;
    }
    let loopActive = false; // tracks whether the render loop is running (batch uploads pause/restore it)
    let onPageDecodedFailures = 0; // ingest-seam containment counter (first 3 logged, all counted)

    /**
     * Build ONE layer-pack — one virtual texture = one floor × one layer
     * (albedo, or a mask like _Outdoors/_Fire): its PageTable, flattened-pyramid
     * indirection texture, per-mip uniform arrays, coarse-pin set, cached source
     * bitmap — and stream its coarse pins in. Every pack goes through the SAME
     * shared atlas + page cache (its page keys are namespaced by the table id,
     * so albedo and each mask never collide), which is the entire mask-pile-up
     * proof: N mask layers cost N small page-tables + their visible pages, never
     * N world-resolution textures. Factored out of the old single-layer
     * ensureFloorLoaded so albedo and masks share one code path.
     *
     * `coarsePinMaxPages` lets a non-displayed mask keep a lighter permanent
     * soft-floor than the displayed albedo — a mask is an input, not the hero
     * image, so a blurrier always-resident floor for it is fine, and it keeps
     * the permanently-pinned page count healthy when many packs coexist.
     *
     * `source` is either `{ url }` (the normal, single-file case — albedo and
     * every unpackable mask) or `{ channelUrls: {r,g,b} }` (CHANNEL-PACKING,
     * §4.1: 3 single-channel mask files composited into one RGBA virtual
     * texture at decode time via decode-pool.js's `acquirePackedPages` — see
     * that function's header for why this halves+ the pack count without
     * touching a single line of atlas/cache/table code: a packed page is just
     * another 256² RGBA page as far as everything downstream is concerned).
     */
    async function buildPack(ownerId, name, source, { coarsePinMaxPages } = {}) {
      const isPacked = !!source.channelUrls;
      // Read dimensions WITHOUT holding a full 576 MB bitmap (getSourceDimensions
      // parses the PNG header) — the pack keeps only the URL(s); pages are
      // sliced on demand through the bounded, IndexedDB-backed acquire path.
      // For a packed pack, the 3 channel sources are assumed to share
      // dimensions (they're masks of the same floor at the same resolution,
      // like the fixture's authored trio) — the 'r' source is the reference.
      const dimUrl = isPacked ? source.channelUrls.r : source.url;
      const { width: srcWidth, height: srcHeight } = await getSourceDimensions(dimUrl);

      // RECTANGULAR SOURCES ARE SUPPORTED as of 2026-07-16 — the loud
      // non-square throw that used to stand here is gone, along with the
      // limitation behind it. `PageTable` now takes independent
      // worldWidthPx/worldHeightPx (see its header for why this was overdue:
      // square scene art is the exception, so most real scenes could not render
      // at all, and tiles — essentially never square — were blocked outright).
      const table = new PageTable({
        id: `panviewer:${ownerId}:${name}`,
        worldWidthPx: srcWidth,
        worldHeightPx: srcHeight,
      });

      // The indirection is a flattened mip pyramid (all mips in one small
      // texture) — see page-table.js's computeIndirectionAtlasLayout + the
      // shader header. buf/texture are sized to the packed pyramid, not just mip 0.
      const indirectionLayout = computeIndirectionAtlasLayout(table);
      const { width, height } = indirectionLayout;
      const buf = new Uint8Array(width * height * 4); // all-zero = not resident everywhere, initially
      const indirectionTexture = new THREE.DataTexture(buf, width, height, THREE.RGBAFormat);
      indirectionTexture.flipY = false;
      indirectionTexture.generateMipmaps = false;
      indirectionTexture.minFilter = THREE.NearestFilter;
      indirectionTexture.magFilter = THREE.NearestFilter;

      // This indirection texture is no longer sampled by any shader (the
      // streaming/virtual-texture engine that read it via `pages0` was
      // removed 2026-07-22 — see feedback_mode_forks_silently_drop_features;
      // vt-core.test.mjs still proves the PageTable/layout math it was built
      // against). `indirectionLayout` still sizes the buffer above for the
      // coarse-pin bookkeeping masks use.

      // COARSE PINS (§4.1): the top few mip levels of THIS pack, pinned
      // permanently so the whole floor always renders (soft) and floor switches
      // are instant. Decode + upload + pin them once, now.
      const topMips = coarseTopMipsForCap(table, coarsePinMaxPages ? { maxPages: coarsePinMaxPages } : {});
      const coarsePages = coarsePinSet(table, { topMips });
      const coarseKeySet = new Set(coarsePages.map((p) => p.key));

      const pack = {
        name,
        ownerId, // the owning item — carried so the onPageDecoded ingest seam can attribute pages
        table,
        // Pages are sliced/composited on demand via acquirePages/acquirePackedPages;
        // no full bitmap is ever held on the pack itself. `packId` is the
        // synthetic IndexedDB identity for a packed pack's COMPOSITED result
        // (distinct from any individual channel source URL).
        source: isPacked
          ? { kind: 'packed', channelUrls: source.channelUrls, packId: `packed://${ownerId}/${name}` }
          : { kind: 'single', url: source.url },
        indirectionTexture,
        buf,
        width,
        height,
        indirectionLayout,
        coarsePages,
        coarseKeySet,
        coarseTopMips: topMips,
        residentViewKeys: new Set(),
        lastRequestedMip: 0,
        lastRequestedMipFraction: 0, // smooth mip-blend uniform companion (residency.chooseMipFraction)
      };
      await requestDecodeUpload(pack, coarsePages, 'coarse');
      return pack;
    }

    // Mask packs get a lighter permanent soft-floor than the displayed albedo —
    // a mask is an input, not the hero image. HALF of the item's own dynamic
    // share (`currentCoarseBudget.perPackMaxPages`, item 1b), capped at 24 —
    // the ORIGINAL fixed value, kept as an upper ceiling because it was
    // empirically fine for masks; the new part is that it can now go LOWER
    // than 24 too, when the scene's total pack count demands it, instead of
    // being a flat number blind to how many packs exist.
    function maskCoarsePinMaxPages() {
      return Math.max(1, Math.min(24, Math.floor(currentCoarseBudget.perPackMaxPages / 2)));
    }

    /**
     * Load ONE drawable: its albedo virtual texture, any extra layer-packs
     * (masks) that ride along with it, and its world placement.
     *
     * The placement is what makes this different from the old per-floor loader:
     * an item is NOT the whole world any more. `computeItemPlacement` resolves
     * where this specific image lands in canvas space (a Level's art centred on
     * the padded `sceneRect`; a tile at its own x/y/rotation/anchor), and that
     * needs the texture's NATIVE size — which is why it happens here, after
     * buildPack has read the header, rather than in the pure collection step.
     */
    /**
     * Load every EXTRA layer-pack (mask) an item declares, tolerating any
     * single layer's failure without losing the rest. Factored out
     * 2026-07-22: this used to run ONLY on the non-whole-image path — see
     * `ensureItemLoaded`'s own header for the real bug that discovery
     * (`layerErrors` shared with `getDiagnostics().layerLoadErrors`, per this
     * function's own comment) found empty despite `mask-authority#
     * getIngestStatus` reporting `outdoorsIngested:false`: whole-image mode
     * returned BEFORE this loop ever ran, so no mask pack was EVER attempted,
     * let alone failed — a structural gap, not a load error. Extracting this
     * lets BOTH modes share the identical, already-correct logic instead of
     * two copies drifting apart.
     * @param {object} item
     * @returns {Promise<{packs: Map<string,object>, layerErrors: Array<object>}>}
     */
    async function loadExtraLayerPacks(item) {
      const packs = new Map();
      // Per-pack load failures are collected here AND surfaced in diagnostics
      // (getDiagnostics.layerLoadErrors) — not just console — because the
      // author debugs by pasting reports, not reading the console
      // ([[keyhole-debug-panel]] protocol). A silent fallback-to-albedo (mask
      // 404 / not synced to the server) looks identical to "masks unsupported"
      // in the residency report; this makes the actual reason legible there.
      const layerErrors = [];
      for (const layerDesc of extraLayersForItem(item)) {
        const { name } = layerDesc;
        // CHANNEL-PACKING: a layer descriptor is either { name, url } (single
        // source — the normal case) or { name, channelUrls: {r,g,b} } (packed
        // — see buildPack's header). errorUrl is just for a legible error log.
        const source = layerDesc.channelUrls ? { channelUrls: layerDesc.channelUrls } : { url: layerDesc.url };
        const errorUrl = layerDesc.channelUrls
          ? `r:${layerDesc.channelUrls.r} g:${layerDesc.channelUrls.g} b:${layerDesc.channelUrls.b}`
          : layerDesc.url;
        if (packs.has(name)) {
          console.warn(`[vt-pan-viewer] ${item.id}: duplicate layer name "${name}" ignored.`);
          continue;
        }
        try {
          packs.set(name, await buildPack(item.id, name, source, { coarsePinMaxPages: maskCoarsePinMaxPages() }));
        } catch (err) {
          // A missing/broken mask must not take the whole item (or its albedo)
          // down — record it and carry on with the packs that did load. A
          // single absent mask is a data gap, not an architecture failure.
          const message = String(err?.message || err);
          layerErrors.push({ item: item.id, layer: name, url: errorUrl, error: message });
          console.error(`[vt-pan-viewer] ${item.id}: layer "${name}" failed to load (${errorUrl}):`, err);
        }
      }
      return { packs, layerErrors };
    }

    async function ensureItemLoaded(item) {
      const existing = itemStates.get(item.id);
      if (existing) {
        existing.item = item; // refresh (renderOrder/key change per update)
        return existing;
      }

      // No albedo atlas, no page streaming for the floor art —
      // `ensureWholeImageMeshes` decodes/uploads that directly, matching
      // Foundry's own PIXI GPU footprint (only the floor textures, nothing
      // else). `getSourceDimensions` reads only the image header (~30 bytes),
      // not the 144-megapixel body.
      //
      // MASKS still go through `loadExtraLayerPacks` (fixed 2026-07-22, real
      // bug found live: this used to skip `extraLayersForItem` entirely,
      // which silently meant NO mask, on ANY scene, could ever reach the mask
      // authority — not a load failure, nothing ever threw, just never
      // attempted). Masks are coarse-pinned data (a handful of ≤248² pages,
      // `maskCoarsePinMaxPages()`) loaded through the small decode/pack
      // machinery `buildPack` still provides; only the ALBEDO atlas/VT
      // pipeline that used to sit alongside it (streaming mode, removed
      // 2026-07-22 — see feedback_mode_forks_silently_drop_features) is gone.
      const dims = await getSourceDimensions(item.src);
      const { packs, layerErrors } = await loadExtraLayerPacks(item);
      const state = {
        item,
        packs, // masks only — there is no albedo pack any more
        layerErrors,
        imageSize: { width: dims.width, height: dims.height },
        placement: null,
        placementKey: null,
        worldBounds: null,
        geometry: null,
        material: null,
        mesh: null,
        hoverFade: createHoverFadeState(),
        occluded: false,
      };
      refreshItemPlacement(state, item);
      itemStates.set(item.id, state);
      requestItemAlphaGrid(item, dims);
      return state;
    }

    /** Items whose coarse alpha has been asked for — one request per item per
     * session (the worker's own IndexedDB cache handles across sessions). */
    const alphaRequested = new Set();
    /** Reported in diagnostics so "sky-reach has no casters" is always
     * attributable: asked / arrived / refused, never inferred. */
    const alphaGridStats = { requested: 0, delivered: 0, failed: 0, skippedTokens: 0 };

    /**
     * THE ART-OPACITY REQUEST (see `onItemAlpha`'s own doc, and
     * `vt/coarse-alpha.js` for the defect this repairs).
     *
     * Fire-and-forget on purpose: `coverAbove` is a lazily-recomputed CPU
     * product, so a grid that lands three seconds after the floor drew simply
     * makes the next derivation better. Blocking the load on it would trade a
     * visible stall for a shadow nobody is looking at yet.
     *
     * TOKENS ARE SKIPPED — the authority excludes them from cover physics
     * anyway (they move constantly and are not architecture), so decoding their
     * art would be pure waste. Counted, not silently dropped.
     */
    /**
     * Ask for the coarse alpha of EVERY cover item in the scene — every floor's
     * background, foreground and tiles, whether or not the viewed floor can see
     * them.
     *
     * THE BUG THIS FIXES (author, 2026-07-26: *"it shows only the shadow for
     * overhead elements on the floor above… the actual background image covers a
     * huge amount of space"*). `boot.js` deliberately hands the mask authority an
     * UNFILTERED item list — its own comment says "cover physics must not depend
     * on what the user is currently viewing" — but the ALPHA, without which an
     * item contributes nothing at all, was only ever requested from
     * `ensureItemLoaded`, i.e. only for items on the DRAW list. So the authority
     * knew about the floor above's background and had `alpha: null` for it
     * forever. The one class that worked was tiles, because a tile with an empty
     * levels set is "present on every floor" and is therefore always drawn.
     *
     * NO `getSourceDimensions` CALL for these: that is a ranged header fetch per
     * item, and the alpha worker already returns the source's true dimensions.
     * Passing `null` skips a network round-trip per off-screen item and loses
     * nothing (`requestItemAlphaGrid` only uses `dims` as a fallback).
     */
    function primeCoverAlphaGrids() {
      for (const item of getCoverItems()) requestItemAlphaGrid(item, null);
    }

    function requestItemAlphaGrid(item, dims) {
      if (item?._placement?.kind === 'token') {
        alphaGridStats.skippedTokens++;
        return;
      }
      if (!item?.src || alphaRequested.has(item.id)) return;
      alphaRequested.add(item.id);
      alphaGridStats.requested++;
      requestCoarseAlphaGrid(item.src)
        .then((res) => {
          if (!res?.grid) {
            alphaGridStats.failed++;
            return;
          }
          alphaGridStats.delivered++;
          onItemAlpha({
            ownerId: item.id,
            grid: { w: res.gridW, h: res.gridH, data: res.grid },
            // The SOURCE image's own size — placement resolves from the file's
            // native dimensions, never from the reduced grid's (that would
            // shrink every item to a 512px square).
            imageWidth: res.width || dims?.width || 0,
            imageHeight: res.height || dims?.height || 0,
          });
        })
        .catch((err) => {
          alphaGridStats.failed++;
          // Through the ONE log door, so this lands in the flight-recorder
          // bundle rather than only in a console nobody exports (log/one-door).
          // A failure here is invisible on screen — the shadow is simply absent
          // — so it MUST be recoverable from a report.
          ingestLog.warn(`coarse alpha failed for "${item.id}":`, err);
        });
    }

    /**
     * (Re)resolve an item's world placement, rebuilding its quad only when the
     * placement actually changed.
     *
     * Recomputed every residency pass rather than cached at load, so a tile the
     * GM drags, rotates or resizes follows its document instead of freezing
     * where it first appeared. The `placementKey` compare keeps that cheap: the
     * common case is "nothing moved", which costs one string build and no GPU work.
     */
    function refreshItemPlacement(state, item) {
      const placement = computeItemPlacement(item, state.imageSize, dimensions);
      const key = `${placement.x},${placement.y},${placement.width},${placement.height},${placement.anchorX},${placement.anchorY},${placement.rotation}`;
      if (key === state.placementKey) return false;
      state.placement = placement;
      state.placementKey = key;
      state.worldBounds = computeQuadBounds(placement);
      if (state.geometry) {
        const pos = state.geometry.getAttribute('position');
        const corners = computeQuadCorners(placement);
        const buf = buildQuadPositions(corners);
        for (let i = 0; i < buf.length; i++) pos.array[i] = buf[i];
        pos.needsUpdate = true;
        state.geometry.computeBoundingSphere();
      }
      return true;
    }

    /**
     * TOKEN PLACEMENT: TRACKED EVERY FRAME, NOT ONLY ON A DOCUMENT HOOK
     * (2026-07-17 — "the token stops just short of the final position").
     *
     * The root cause was two-layered, and neither layer alone would have been
     * enough to fix live: (1) `computeItemPlacement` was trusting a footprint
     * CACHED at collection time instead of re-deriving it (fixed above, in
     * `foundry/scene-layers.js`) — but (2) even a perfectly fresh derivation
     * only runs when something calls `refreshItemPlacement`, and until now that
     * was EXCLUSIVELY a document-hook-triggered `updateResidency()` pass.
     *
     * The live evidence for why hooks alone are not enough: `documentSync
     * .passLog` showed FOUR CONSECUTIVE real passes reading the exact same
     * (stale) token position, no new pass triggered after, while a fresh read
     * of the SAME live document — moments later — had already moved on by
     * 670px. Something in Foundry keeps `TokenDocument#x/y` settling toward its
     * final value without firing another `updateToken`/`moveToken` we can hook
     * — real-time-paced waypoint commits, client-side prediction, or something
     * this environment cannot single-step to confirm. Rather than keep
     * chasing which exact hook is missing (this is the third round on this
     * exact bug), this makes the RENDERER converge regardless of hook
     * completeness — the same way Foundry's OWN Token placeable stays in sync:
     * by sampling the live document continuously, every tick, not by reacting
     * to discrete write events that may not describe a continuously-settling
     * field.
     *
     * Deliberately NOT routed through `updateResidency()` — that pass does
     * real GPU/streaming work (this scene's cache is already oversubscribed,
     * see item 1b) and must stay event-driven, not run every frame. This
     * touches ONLY pure JS geometry: `refreshItemPlacement` compares a
     * placementKey and returns early when nothing moved, so the steady-state
     * cost is one string build and a `!==` per token, every frame. Visibility
     * and streaming are untouched here — still owned by `updateResidency()`.
     */
    function syncTokenPlacements() {
      for (const state of itemStates.values()) {
        if (state.item?._placement?.kind !== 'token') continue;
        refreshItemPlacement(state, state.item);
      }
    }

    const scene = new THREE.Scene();

    // ── WATER TIER 0: the surface (effects/water/water-surface-subsystem.js)
    // Constructed HERE, after `scene` — that module owns the mesh, the
    // AABB crop and the high-res mask load, and its header explains why the
    // ordering is a caller requirement (trap #4, hit three times).
    const waterSurface = createWaterSurfaceSubsystem({
      THREE,
      scene,
      waterBody,
      getWaterMaskUrl,
      createMaskTexture: createMaskDataTexture,
      loadMaskImage: (url) => loadMaskImageTexture({ url, THREE }),
      getWaterRenderState,
      timeMsNode: uGlobalTimeMs, // tier 2's field travels on THE shared clock
      // TIER 3 — envLight's OWN uniforms, shared rather than duplicated: two
      // view rects updated on different cadences is exactly how two consumers
      // of one frame end up disagreeing about where a world point is. The
      // identical objects `specularSurface` below receives.
      uViewRect: envLight.uViewRect,
      uOutdoorsRect: envLight.uOutdoorsRect,
      outdoorsTexNode: envLight.outdoorsTexNode,
      buildOutdoorsGate: buildWorldSpaceOutdoorsGate,
      getSkyHandle: () => skyHandle,
    });

    // ── FLUID, tiers 0-4 (docs/planning/Fluid.md) ──────────────────────────
    // Beside water's surface for the same trap-#4 reason: it takes `scene`, so
    // it must be constructed after `scene` exists. It owns the whole chain —
    // mask fetch, tube-net extraction, pack bake, mesh crop, and (tier `fill`)
    // a per-item semi-Lagrangian sim — because unlike water there is no GPU
    // flood to schedule (correction #3: three of the pack's four channels are
    // CPU-only, so the bake is a pure function plus one upload; the SIM is the
    // one genuine per-tick GPU pass, driven by `tickFluidSim` below).
    const fluidSurface = createFluidSurfaceSubsystem({
      THREE,
      scene,
      getFluidMaskItems,
      loadMaskImage: (url) => loadMaskImageTexture({ url, THREE }),
      createPackTexture: createFluidPackTexture,
      createSimRenderTarget: createFluidSimRenderTarget,
      disposeSimRenderTarget: disposeFluidSimRenderTarget,
      getFluidRenderState,
      timeMsNode: uGlobalTimeMs, // THE shared clock — never a private one
    });

    // THE ITEM → WORLD QUAD resolver, handed back to boot's fluid seam.
    //
    // It lives HERE because resolving a placement needs the item's TEXTURE
    // SIZE, and only the viewer knows that — it is what `itemStates` tracks.
    // Boot owns the mask lookup (it has the authority); the viewer owns the
    // geometry. Passing the function back rather than moving either half is
    // what keeps `vt/` from importing boot and boot from learning about
    // texture sizes.
    //
    // Returns null while an item's art has not resolved yet, which simply
    // defers that item to a later frame rather than baking a quad of the wrong
    // size — a tile whose mask baked against a placeholder size would sit
    // permanently misaligned with no error anywhere.
    onFluidCornersResolver((item) => {
      const state = itemStates.get(item.id);
      const size = state?.imageSize;
      if (!size || !(size.width > 0) || !(size.height > 0)) return null;
      return computeQuadCorners(computeItemPlacement(item, size, dimensions));
    });

    // ── SHINE, tiers 0-2 (effects/specular/specular-surface-subsystem.js) ──
    // Constructed beside water's surface for the same trap-#4 reason, but it
    // does NOT take `scene`: it owns its own, because it reads buf:scene.illum
    // and therefore cannot draw inside geometry.world the way water's surface
    // does. See `runSurfaceResponsePass` below and the module's own header.
    //
    // `sceneColor.textures[1]` is buf:scene.attr — MRT attachment 1, and this
    // is its FIRST consumer anywhere in the renderer (post.grade is still a
    // seam). A missing attachment compiles the floor gate OUT rather than
    // crashing, and `getStatus().floorGate` reports which happened, because
    // "metal draws over upper-floor roofs" is silent on screen.
    const specularSurface = createSpecularSurfaceSubsystem({
      THREE,
      getSpecularMaskUrl,
      getSpecularMaskRect,
      loadMaskImage: (opts) => loadMaskImageTexture({ ...opts, THREE }),
      createMaskTexture: createMaskDataTexture,
      illumTexture: sceneIllum.texture,
      attrTexture: sceneColor.textures?.[1] ?? null,
      // The island pack's own uploader — NEAREST, see its own header.
      createPackTexture: createSpecularPackTexture,
      // THE shared clock, never a private one: the shimmer's slow drift stops
      // when Foundry pauses, like every other animation in this renderer.
      timeMsNode: uGlobalTimeMs,
      // envLight's OWN uniforms, shared rather than duplicated: two view rects
      // updated on different cadences is exactly how two consumers of one frame
      // end up disagreeing about where a world point is.
      uViewRect: envLight.uViewRect,
      uOutdoorsRect: envLight.uOutdoorsRect,
      outdoorsTexNode: envLight.outdoorsTexNode,
      buildOutdoorsGate: buildWorldSpaceOutdoorsGate,
      getSpecularRenderState,
      // THE SKY HANDLE, as a getter — it is REBUILT (not mutated) whenever the
      // sun moves, so capturing the value here would pin the neutral handle the
      // viewer starts with and the sun glint would never move.
      getSkyHandle: () => skyHandle,
    });

    // ── WINDOW LIGHT, tier 0 (effects/window/window-surface-subsystem.js) ──
    // Unlike SHINE, this draws INSIDE `light.accumulate`, not after it: the
    // mask is read as LIGHT and ADDED onto `buf:scene.illum` itself (see
    // `window-render.js`'s header for why that also means no `illumTexture`
    // input here at all — this pass CONTRIBUTES to illum rather than reading
    // it). It still needs its own scene, for the same reason the point-light
    // pool and specular both do: `runLightAccumulatePass` renders it as an
    // explicit `renderer.render(windowSurface.scene, camera)` call, right
    // after the point-light MAX-blend.
    //
    // `sceneColor.textures[1]` is the SAME buf:scene.attr read specular takes
    // above — the floor gate is identical in shape and identical in caveat
    // (the alpha lane is confirmed broken; only R is trusted).
    //
    // `cloudFactorNode` is deliberately OMITTED — `world/cloud-field.js`
    // (docs/planning/Windows.md §4) does not exist yet, so the builder's own
    // constant-1 default is what ships. The day that field lands, this is a
    // one-line addition here and nowhere else.
    const windowSurface = createWindowSurfaceSubsystem({
      THREE,
      getWindowMaskUrl,
      getWindowMaskRect,
      loadMaskImage: (opts) => loadMaskImageTexture({ ...opts, THREE }),
      createMaskTexture: createMaskDataTexture,
      attrTexture: sceneColor.textures?.[1] ?? null,
      uViewRect: envLight.uViewRect,
      getWindowRenderState,
    });

    /**
     * THE VEGETATION-SHADOW SUBSYSTEM (extraction step 2 of docs/planning/
     * VT-Pan-Viewer-Extraction.md). Constructed HERE, immediately after
     * `scene`, rather than beside the vegetation code it serves — deliberately,
     * for trap #4: a `const` is in its temporal dead zone until its own line
     * runs, so declaring it early makes it impossible for a load path to reach
     * it too soon. Its two injected functions (`setTileGeometry`,
     * `buildVegetationMaterial`) are `function` declarations further down and
     * are therefore hoisted — already defined by the time this line executes.
     *
     * ⚠️ `getShadowHandle` is a GETTER, not `shadowHandle` itself: the handle
     * is REASSIGNED whenever the sky changes (a handle is frozen at
     * construction; a rebake mints a new one). Passing the value would freeze
     * every vegetation shadow at the sky it booted under.
     */
    const vegShadows = createVegetationShadowSubsystem({
      THREE,
      scene,
      dimensions,
      getShadowHandle: () => shadowHandle,
      setTileGeometry: (rec, placement, imageW, imageH, segments, padPx) =>
        setTileGeometry(rec, placement, imageW, imageH, segments, padPx),
      buildVegetationMaterial: (tex, item, kind, params, opts) =>
        buildVegetationMaterial(tex, item, kind, params, opts),
    });

    // THE WORLD-SPACE CAMERA. Frustum values are set per frame by updateCamera()
    // from the live view rect; the placeholder args just construct it.
    //
    // This replaces the old fullscreen-quad-with-remapped-UVs model, in which
    // the quad WAS the screen and its UV WAS the world position. That only
    // worked because those two spaces were conflated, which stops being true the
    // moment anything has to sit at a specific spot in a padded canvas.
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);

    /**
     * Point the camera at the current view rect.
     *
     * THE Y-FLIP LIVES HERE AND NOWHERE ELSE (scene/world-quad.js explains why,
     * and Node-tests the orientation chain end to end): computeCameraFrustum
     * returns `top = minY`, INVERTED from the usual Y-up convention, so Three
     * maps the smallest world Y to NDC +1 = the top of the screen. That is what
     * lets every quad use raw Foundry coordinates with no conversion.
     *
     * Called every frame from renderFrame(), so a mouse drag tracks the cursor
     * at display rate without waiting on any streaming work — the job
     * reframeVisibleLayers() used to do by rewriting UVs, now done by moving the
     * camera, which is both cheaper and impossible to compound (the exact bug
     * class the deleted reframe path produced live on 2026-07-15).
     */
    function updateCamera() {
      if (!view) return;
      const rect = viewToWorldRect(view, canvasW / canvasH);
      const f = computeCameraFrustum(rect);
      camera.left = f.left;
      camera.right = f.right;
      camera.top = f.top;
      camera.bottom = f.bottom;
      camera.updateProjectionMatrix();
    }

    // ======================================================================
    // WHOLE-IMAGE MODE — every item's art loads WHOLE, one texture per tile
    // of planImageTiles, drawn as plain quad(s). No atlas, no page cache, no
    // residency, no upload churn: the fix for the WebGPU device loss, and now
    // the ONLY loading/rendering path (the streaming/virtual-texture engine
    // this replaced was removed 2026-07-22 — see
    // feedback_mode_forks_silently_drop_features).
    // ======================================================================

    /** A NodeMaterial that samples ONE whole texture with the full tint/alpha/
     * occlusion chain (uTint/uAlpha/occlusion are live uniform handles).
     *
     * OCCLUSION HERE WAS NEW (2026-07-18) — whole-image mode was already the
     * DEFAULT active path for real scenes at the time, so wiring occlusion
     * into ONLY the old streaming path's material (`ensureItemMesh`, removed
     * 2026-07-22 along with the rest of that engine — see
     * feedback_mode_forks_silently_drop_features) would have made
     * masks.occlusion real but INVISIBLE on every deployed scene. Math is the
     * direct expression of scene/occlusion.js's `computeOcclusionAlpha`. */
    // uvScale defaults to [1,1] (raw path: texture IS the image). The BC1 path
    // passes [w/padW, h/padH] < 1: a block-compressed texture's dimensions MUST
    // be a multiple of 4 (WebGPU rejects e.g. 1050×1050 as BC1 — the device-loss
    // trigger this replaced), so it is uploaded at the padded size and the mesh
    // samples only the logical [0..w/padW, 0..h/padH] sub-rect. The padding lives
    // at the bottom/right (v→1, u→1) as edge-clamped replication (see gatherBlock),
    // so clamping the UV max there hides it with no image squash or shift.
    /**
     * The occlusion uniforms shared by every whole-image-style material
     * (this function was the ONLY caller until `buildVegetationMaterial`
     * below became the second — extracted 2026-07-23 rather than copied, so
     * this ~10-line concern can't quietly drift between two call sites the
     * way duplicated logic always eventually does). `uOcclusionElevation` is
     * the one LIVE member (refreshed per-frame elsewhere, by
     * `refreshItemOcclusionElevation()`); the rest are fixed for the item's
     * lifetime (`item.occlusion.modes` never changes at runtime).
     * @param {object} item
     */
    function buildOcclusionUniforms(item) {
      const { uniform, float, vec4 } = THREE.TSL;
      const uOcclusionElevation = uniform(float(1)); // 1 = "above every real elevation" — inert until refreshed
      const uOcclusionWeights = uniform(vec4(0, 0, 0, 0));
      const uUnoccludedAlpha = uniform(float(1));
      const uOccludedAlpha = uniform(float(0));
      const modes = item?.occlusion?.modes ?? OCCLUSION_MODES.NONE;
      const st = computeOcclusionState({
        occlusionMode: modes,
        occluded: false,
        visionActive: false,
        hoverFadeAmount: 0,
      });
      uOcclusionWeights.value.set(st.fade, st.radial, st.vision, st.surface);
      uOccludedAlpha.value = item?.occlusion?.alpha ?? 0;
      return { uOcclusionElevation, uOcclusionWeights, uUnoccludedAlpha, uOccludedAlpha };
    }

    /**
     * The occlusion SAMPLE + blend factor — same shape as
     * scene/occlusion.js#computeOcclusionAlpha (step(edge,x) is 0 when
     * x<edge; 1-step therefore means "the occluder recorded here sits BELOW
     * me"). screenUV is the correct space here (same camera, same target
     * size) — occlusionMask is rendered screen-sized. Returns the 0..1 factor
     * a caller mixes its own unoccluded/occluded alpha through — FUNCTION
     * form only (`.mix()` as a METHOD takes its receiver as the interpolant,
     * not the first value, and cost a whole session the one time this
     * project used it by mistake — reference_tsl_method_chaining_trap).
     * @param {ReturnType<typeof buildOcclusionUniforms>} occ
     */
    function occlusionAlphaFactor(occ) {
      const { float, step, mix, texture, screenUV } = THREE.TSL;
      const maskSample = texture(occlusionMask.texture, screenUV);
      const gate = float(1).sub(step(occ.uOcclusionElevation, maskSample));
      const amounts = gate.mul(occ.uOcclusionWeights);
      const amount = amounts.x.max(amounts.y).max(amounts.z).max(amounts.w);
      return mix(occ.uUnoccludedAlpha, occ.uOccludedAlpha, amount);
    }

    // (resolveItemFloorAttrUniforms moved to vt/scene-attr.js — same logic,
    // new home, to stay under the size ratchet's per-function cap.)

    function buildWholeImageMaterial(tex, item, uvScale = [1, 1]) {
      const { Fn, uniform, vec2, vec3, vec4, float, uv } = THREE.TSL;
      const uTint = uniform(vec3(1, 1, 1));
      const uAlpha = uniform(float(1));
      const uUvScale = uniform(vec2(uvScale[0], uvScale[1]));
      // THE TEXTURE'S OWN TEXEL DIMENSIONS — what converts a UV derivative into
      // the texel footprint the clarity gate needs. Read off the texture rather
      // than passed in, because `tex.image` is already exactly right for BOTH
      // paths and a hand-passed size is one more thing to get wrong: the
      // CompressedTexture constructor stores {width,height} = the PADDED size
      // (which is what uv 1.0 addresses there — uvScale crops back to the
      // logical rect afterwards), and the raw path's `new Texture(bitmap)`
      // stores the bitmap's own size. Both are the number we want.
      const uTexSize = uniform(vec2(tex.image?.width || 1, tex.image?.height || 1));
      const occ = buildOcclusionUniforms(item);

      const material = new THREE.NodeMaterial();
      material.transparent = true;
      material.depthTest = false;
      material.depthWrite = false;
      material.side = THREE.DoubleSide; // negative scaleX flips winding — see world-quad.js
      // buf:scene.attr REAL WRITER (scene-attr.js "THE REAL WRITERS") — base
      // map art IS the floor. Reads its own alpha via TSL.output, NOT a
      // closure variable (see buildRealFloorAttrMrtNode's own doc for the
      // live crash that class of trick caused: Fn()'s callback is deferred,
      // so a variable set inside it is still unset the instant Fn(...)()
      // returns).
      material.colorNode = Fn(() => {
        // ALBEDO CLARITY (see buildAlbedoClarityNode's section header): a
        // drop-in replacement for the bare `texture(tex, uv)` this used to be.
        // Same linear units in and out; it only puts back the local contrast
        // minification averaged away, and only while minifying.
        const uvS = uv().mul(uUvScale).toVar();
        const clear = buildAlbedoClarityNode(THREE, tex, uvS, uTexSize);
        const c = vec4(clear.rgb, clear.a).toVar();
        c.rgb.mulAssign(uTint);
        c.a.mulAssign(uAlpha);
        c.a.mulAssign(occlusionAlphaFactor(occ));
        return c;
      })();
      material.mrtNode = buildRealFloorAttrMrtNode({
        THREE,
        item,
        viewedFloorIndex: view.floorIndex,
        sceneDoc: globalThis.canvas?.scene ?? null,
        logError: log.error,
        envLight,
      });
      return {
        material,
        appearance: {
          uTint,
          uAlpha,
          uOcclusionElevation: occ.uOcclusionElevation,
          uOcclusionWeights: occ.uOcclusionWeights,
          uUnoccludedAlpha: occ.uUnoccludedAlpha,
          uOccludedAlpha: occ.uOccludedAlpha,
        },
      };
    }

    // ── VEGETATION MOTION TUNING (2026-07-23, author: "All trees/bushes sway
    // ── in the exact same direction the exact same amount at the exact same
    // ── time... At gale the trees look and act very much like they do at a
    // ── light breeze. We have a wonderfully complex nuanced wind simulation,
    // ── let's make that visible.") EVERY tuning constant this comment used to
    // ── list here (clump cell size/spread, gale bend/rate gain, sway curve/
    // ── rate, flutter rate/amplitude) is now a LIVE param instead — see
    // ── `effects/vegetation.js#VEGETATION_PARAMS` — after the SAME-DAY
    // ── follow-up ("distortions are very very strong... the more controls the
    // ── better") asked for exactly that: direct author control over frequency/
    // ── rate/amplitude, not code constants only a rebuild can retune. Only the
    // ── render-order bookkeeping magnitude below is still a plain constant —
    // ── it is plumbing (which mesh paints over which), never a "look" knob.
    // (`VEG_SHADOW_RENDER_ORDER_MAGNITUDE` — and the four smear/pad constants
    // that used to sit below — now live in
    // `effects/vegetation-shadow-subsystem.js` with the code that owns them;
    // extraction step 2 of docs/planning/VT-Pan-Viewer-Extraction.md. They are
    // imported at the top of this file because call sites here still read
    // them.)

    // ── GALE-STRENGTH SAFETY NET (2026-07-23, SAME DAY, live-test author
    // ── report: "at gale strength the trees can self intersect... a
    // ── distorted dissolved blob... we have to be careful to get leaf
    // ── flutter and sway without them becoming a blender of nonsense at
    // ── gale strength"). All four constants below were reverse-engineered
    // ── from the OLD V2 vegetation shaders (legacy/compositor-v2/effects/
    // ── vegetation-bulk-wind.js), which never exhibited this failure —
    // ── V2 hard-capped both displacement channels AND actively DAMPED
    // ── flutter (not just left it unscaled) as wind approached its max,
    // ── while only the RIGID bulk term was allowed to grow. None of these
    // ── are authored params, matching V2's own posture: they are structural
    // ── "never exceed" backstops (the same idiom `deflectAroundWalls`'s wall
    // ── energy cap and `computeWindTurbulence`'s energy cap already use),
    // ── not creative dials — the creative dials are `swayAmount`/`swayCurve`/
    // ── `flutterAmount`/etc. above, which choose a look WITHIN these limits.

    /** Hard ceiling on `windHandle.node()`'s OWN magnitude before it drives
     * bend/oscillate amplitude. `sampleWind`'s own JSDoc warns its result is
     * "no longer bounded to [-1,1] once wind/bakedField/liveField contribute
     * a real prevailing speed" — Tier 2's transient door-gust sim is exactly
     * such a contributor. Rescales the WHOLE vector (never distorts
     * direction) down to this ceiling if exceeded. */
    const VEG_MAX_LOCAL_SPEED = 2.5;
    /** Hard ceiling on the FINAL bend+oscillate displacement, world px, AFTER
     * every multiplier (swayAmount/windResponse/kind/curve) is applied — the
     * backstop for several independent sliders being cranked to their own
     * maxima at once, which would otherwise compound into a multi-thousand-
     * pixel throw. Generous: normal tuning never approaches it. */
    const VEG_MAX_DISPLACE_PX = 320;
    /** Hard ceiling on the flutter UV shuffle. Slightly tighter than V2's own
     * proven `flutterCap` (0.006, vegetation-bulk-wind.js) — V2 never stacks
     * a Wind-response/intensity family on top the way this project's live
     * param set does, so a little extra headroom below V2's own number. */
    const VEG_FLUTTER_UV_CAP = 0.005;
    /**
     * THE FOLIAGE-PRESENCE GATE — mip level, and why a COARSE mip is the whole
     * trick (2026-07-28, the performance audit).
     *
     * MEASURED PROBLEM: `geometry.worldDraw` was 13.6 ms, 62% of frame GPU, and
     * `Isolate draw item` proved ONE item is 97% of it — removing 68% of the
     * draw calls saved 2.9%, so it was never overdraw. That one item is a
     * vegetation-bearing tile, and its FRAGMENT stage runs `curlNoise2D`
     * ("4 noise evals" by its own header) plus a full `windHandle.node()`
     * wind-field sample **on every pixel it covers** — a layer that covers the
     * whole screen — and then multiplies the result into a UV offset that does
     * nothing wherever the art has no foliage. Full price, thrown away, on the
     * overwhelming majority of the map. (`surface.specularDraw` has the exact
     * same shape; see docs/planning/Performance-Insights.md §3/§4.)
     *
     * THE GATE: one extra fetch from a COARSE mip, whose alpha is the average
     * over a large neighbourhood. Alpha 0 there means no foliage anywhere in
     * that footprint, so the flutter provably cannot move any into this
     * fragment and the whole noise+wind block is skipped.
     *
     * ⚠️ WHY THIS IS VISUALLY LOSSLESS AND NOT A "CLOSE ENOUGH". Flutter
     * displaces the sample UV by at most `VEG_FLUTTER_UV_CAP` (0.005 UV). At
     * mip 6 one texel spans 64 base texels — on a 3375px tile that is ~0.019 UV,
     * nearly 4× the cap, and the fetch is bilinear so it straddles two of those.
     * A fragment whose coarse alpha is 0 therefore has NO foliage within a
     * radius several times the furthest flutter could ever reach. The gate can
     * only skip work that could not have changed the pixel.
     *
     * Deliberately NOT a uniform gate (`tsl/no-uniform-gates`): this is a
     * per-fragment data test on the art itself, which is exactly the kind that
     * rule exists to encourage over "is the effect switched on" branching.
     */
    const VEG_FLUTTER_GATE_LOD = 6;
    /** Above this coarse-mip alpha, assume foliage may reach this fragment.
     * Small but non-zero: a bilinear fetch of an all-zero neighbourhood can
     * return a denormal rather than exact 0, and treating that as "foliage"
     * would silently disable the gate everywhere. */
    const VEG_FLUTTER_GATE_ALPHA_EPS = 0.002;
    /** Asymmetric gale damping for flutter ONLY — V2's own approach: fine
     * per-pixel flutter is DAMPED as wind approaches gale, opposite of
     * scaling it up alongside everything else. `flutterGaleFrequency` (the
     * author's own live dial, above) still speeds the pattern's EVOLUTION up
     * at gale; this independently keeps its AMPLITUDE from following it
     * there. `mix(1, FLOOR, smoothstep(START, END, galeness))`. Floor
     * lowered further 2026-07-23 (was 0.45; live-test author: "a lot less
     * strong during a gale... otherwise leaf flutter turns into a distortion
     * which makes trees turn into alien blobs") — flutter at full gale now
     * survives at barely a quarter of its own undamped ceiling. */
    const VEG_FLUTTER_GALE_DAMP_FLOOR = 0.3;
    const VEG_FLUTTER_GALE_DAMP_START = 0.4;
    const VEG_FLUTTER_GALE_DAMP_END = 0.95;
    /** Power curve on the LOCAL wind speed driving flutter (2026-07-23,
     * SAME live-test round: "should be nearly zero at windless... just the
     * smallest touch"). Flutter's own `localSpeed` was scaling LINEARLY —
     * so the small always-on organic jitter `sampleWind` carries even at
     * zero ambient wind (a sealed room's air still stirs a little, by
     * design) was still visibly moving leaves. A steep exponent leaves that
     * baseline reading as barely a whisper while the top of the range (a
     * genuine gale, `localSpeed` near its own 1.0 ceiling) is UNCHANGED —
     * `pow(1, x) = 1` regardless of the exponent — so this reshapes the ramp
     * without lowering the peak (the peak is brought down separately, by
     * `VEG_FLUTTER_GALE_DAMP_FLOOR` and `VEG_FLUTTER_UV_CAP` above). */
    const VEG_FLUTTER_SPEED_CURVE = 2.2;

    /**
     * A stable 0..1 hash of a QUANTIZED world position — the per-clump
     * decorrelation source. `fract(sin(dot))` is the same idiom the particle
     * kernels already use for their own per-particle randomness.
     * @param {*} cell - vec2 node, already quantized to clump cells.
     * @param {number} salt - decorrelates independent draws from one cell.
     */
    function vegClumpHash(cell, salt) {
      const { float, vec2, dot, sin, fract } = THREE.TSL;
      return fract(sin(dot(cell, vec2(float(127.1), float(311.7))).add(float(salt))).mul(float(43758.5453)));
    }

    /**
     * VEGETATION — the same whole-image sample + occlusion chain as
     * `buildWholeImageMaterial` above (shared via `buildOcclusionUniforms`/
     * `occlusionAlphaFactor`, not copied), plus everything that makes a plant
     * look wind-driven. See `docs/planning/Vegetation.md` for the design and
     * `effects/vegetation.js`'s own header for why this contains no wind maths
     * of its own — every lean comes from `windHandle.node()`.
     *
     * ============================================================================
     * WIND IS SAMPLED PER-CLUMP-CELL (not per vertex) — RIGIDITY, 2026-07-23
     * ============================================================================
     *
     * The first cut sampled ONCE per mesh at a uniform centre, which is exactly
     * why the author reported every plant swaying identically: a `_Tree` mask
     * painted across a whole map is ONE mesh, so the entire forest shared one
     * wind vector. Tessellation fixed THAT — but the very next live test
     * ("at gale strength the trees can self intersect... a distorted
     * dissolved blob") exposed the opposite mistake: sampling wind at each
     * vertex's OWN exact position lets a single visual clump straddle a real
     * spatial gradient in the field (or simply a clump-cell boundary), so its
     * OWN vertices could move in different-enough directions to visibly
     * shear or fold. Read against the OLD V2 vegetation shader (legacy/
     * compositor-v2/effects/vegetation-bulk-wind.js), which never exhibited
     * this: V2's islands are genuinely RIGID BODIES — `computeVegetationBulk
     * WindOffset` depends only on the island's shared anchor, never on an
     * individual vertex's position, so an island translates as one piece and
     * cannot internally self-intersect no matter how dense its mesh is.
     *
     * The fix here is the same principle adapted to this cheap grid-cell
     * stand-in for true connected-component islands (`true-clump-
     * differentiation` remains the deferred, more faithful version): wind is
     * now sampled ONCE per clump cell, at the CELL'S OWN CENTRE, and every
     * vertex inside that cell reads the IDENTICAL vector. A cell can only
     * translate/rotate as a whole — never shear — while DIFFERENT cells still
     * read different wind (so the original lockstep bug stays fixed).
     * `positionLocal.xy` is still used for the cell lookup itself and for
     * per-fragment flutter (see layer 4 below), since `computeQuadCorners`
     * emits world-space corners with no mesh transform.
     *
     * FOUR LAYERS, in order of scale:
     *   1. PER-CLUMP DECORRELATION — quantized-cell hash → phase, amplitude and
     *      direction jitter, so neighbouring plants differ even under a locally
     *      uniform field. All vertices in a cell share it, so a plant moves as a
     *      plant instead of shearing.
     *   2. PERSISTENT BEND — a DC lean downwind growing with wind², so a gale
     *      leaves the canopy bent OVER. The single biggest reason a gale
     *      previously read like a breeze: only the oscillation was scaling.
     *   3. OSCILLATING SWAY — amplitude on a >1 power curve, and RATE rising
     *      with wind. Fast thrash vs slow undulation. UNLIKE Tier 2, there is
     *      no longer a root-pinned/tip-swaying height weight here at all —
     *      the SAME live-test round reported "trees at the top of the map
     *      move a lot... trees near the bottom hardly move at all", and V2
     *      (grepped for confirmation) has NO such weighting anywhere: it
     *      simply doesn't need one, because a rigid island already moves as
     *      one piece. The old weight used the TEXTURE's own v-coordinate as a
     *      root/tip proxy, which is only meaningful for a single-plant sprite
     *      (Case 1) — for a scene-wide painted mask (Case 2, the overwhelming
     *      common case) it has no "root vs crown" meaning at all and was
     *      producing exactly the reported map-wide gradient.
     *   4. LEAF FLUTTER (fragment) — a curl-noise UV shuffle. Divergence-free
     *      ⇒ AREA-PRESERVING, which is precisely the author's "mass preserving
     *      distortions": leaves move without the canopy stretching or thinning.
     *      Shares `world/wind-field.js#curlNoise2D` with wind turbulence rather
     *      than inventing private noise (`wind/sample-through-the-door`). Still
     *      sampled per-FRAGMENT (not per-cell) — flutter is a texture-space
     *      shuffle, not a geometry displacement, so it cannot self-intersect
     *      the mesh; its own risk is pure amplitude, guarded by
     *      `VEG_FLUTTER_UV_CAP` and the gale-damping curve below instead.
     *
     * ⚠ EXPOSURE is passed as a constant `float(1)` ("no shelter data" —
     * `sampleWind`'s own documented fallback), not a per-vertex mask sample.
     * This damps only the ORGANIC gust/flutter term; the courtyard-vs-open
     * payoff comes from the COHERENT term, which `windHandle.node()` gates
     * INTERNALLY from `centerXY` via `openness` and is unaffected — see
     * `world/wind-field.js#sampleWind`'s own param doc for why the two are
     * separate inputs.
     *
     * EVERY DISPLACEMENT CHANNEL IS NOW HARD-CAPPED — see this function's
     * enclosing scope for `VEG_MAX_LOCAL_SPEED`/`VEG_MAX_DISPLACE_PX`/
     * `VEG_FLUTTER_UV_CAP`/`VEG_FLUTTER_GALE_DAMP_*`, all reverse-engineered
     * from V2's own proven ceilings — plus SCENE-EDGE-FADE pinning (author:
     * "pin the edges to the edge of the map by having a fading zone which
     * lowers the amount of movement/distortion as it approaches the scene
     * edge"), mirroring V2's own `vegetationSceneEdgeFade`.
     *
     * @param {*} tex - the loaded whole-image texture.
     * @param {object} item - the owning item (occlusion + look defaults).
     * @param {import('../effects/vegetation.js').VegetationKind} kind
     * @param {object} initialParams - current resolved params; the returned
     *   uniforms are live handles the caller refreshes each frame.
     * @param {object} [opts]
     * @param {boolean} [opts.asShadow=false] - build the SHADOW variant: the same
     *   wind motion (a moving plant's shadow moves with it) on a PADDED,
     *   un-translated quad, sweeping the silhouette along the sun's throw and
     *   emitting flat darkness instead of canopy colour.
     * @param {[number,number]} [opts.uvScale]
     * @param {[number,number]} [opts.shadowPadUv] - how much of the shadow quad
     *   is padding, as a fraction of the ART's size, per axis. The fragment
     *   undoes exactly this to map itself back onto the plant. Must match the
     *   geometry `vegShadows.attachTileShadow` built or the shadow lands off its
     *   plant — which is why both come from the ONE `vegetationShadowPadPx`.
     * @returns {{material:*, appearance:object, motion:object, shadow:object|null, windHandleVersion:number}}
     */
    function buildVegetationMaterial(
      tex,
      item,
      kind,
      initialParams,
      // isFloorSurface (buf:scene.attr): true ONLY for Case-1 embedded
      // vegetation (grass AS the ground) — a real attr writer, like base map
      // art. Case-2 overlays (a tree ON existing ground) omit it and stay
      // zero-writers. Ignored whenever asShadow is true either way.
      { asShadow = false, uvScale = [1, 1], shadowPadUv = [0, 0], isFloorSurface = false } = {}
    ) {
      const {
        Fn,
        If,
        uniform,
        vec2,
        vec3,
        vec4,
        float,
        uv,
        texture,
        clamp,
        positionLocal,
        sin,
        cos,
        length,
        pow,
        max,
        min,
        smoothstep,
        step,
        mix,
      } = THREE.TSL;
      const uTint = uniform(vec3(1, 1, 1));
      const uAlpha = uniform(float(1));
      const uUvScale = uniform(vec2(uvScale[0], uvScale[1]));
      const occ = buildOcclusionUniforms(item);

      // SCENE-EDGE-FADE PINNING (2026-07-23, author: "pin the edges to the
      // edge of the map by having a fading zone which lowers the amount of
      // movement/distortion as it approaches the scene edge"). `uSceneMin`/
      // `uSceneSize` are build-time constants from the REAL scene rect
      // (`dimensions.sceneRect`, the same bounds every other wind/particle
      // system is already clamped to — see `bakeWindField`'s own note) —
      // never the mesh's own placement, so a canopy tile that happens to sit
      // AT the boundary pins there too, and never changes without a whole
      // scene reload. `uEdgeFadeWidthPx` is the one LIVE part (width, in
      // world px — human-friendly, matches every other px-scale param in this
      // file) — normalised against `uSceneSize` PER AXIS, in-shader, every
      // frame, so an authored PX width reads as the SAME physical distance on
      // both axes even when the scene isn't square (unlike V2's own single
      // combined normalised width, which this deliberately improves on).
      const sceneRect = dimensions.sceneRect;
      const uSceneMin = uniform(vec2(sceneRect.x, sceneRect.y));
      const uSceneSize = uniform(vec2(Math.max(1, sceneRect.width), Math.max(1, sceneRect.height)));
      const uEdgeFadeWidthPx = uniform(float(initialParams?.edgeFadeWidthPx ?? 0));

      const uIntensity = uniform(float(initialParams?.intensity ?? 1));
      const uWindResponse = uniform(float(initialParams?.windResponse ?? 1));
      const uSwayAmount = uniform(float(initialParams?.swayAmount ?? 0));
      // SWAY CHARACTER — was VEG_SWAY_BASE_RATE/VEG_SWAY_CURVE/VEG_GALE_BEND_
      // GAIN/VEG_GALE_RATE_GAIN (code constants) until the author's follow-up
      // ("frequency, evolution rate, amplitude... the more controls the
      // better") asked for direct, live access to exactly this family.
      const uSwayFrequency = uniform(float(initialParams?.swayFrequency ?? 1));
      const uSwayCurve = uniform(float(initialParams?.swayCurve ?? 1));
      const uGaleBendAmount = uniform(float(initialParams?.galeBendAmount ?? 0));
      const uGaleRateGain = uniform(float(initialParams?.galeRateGain ?? 0));
      const uFlutterAmount = uniform(float(initialParams?.flutterAmount ?? 0));
      // FLUTTER CHARACTER — was VEG_FLUTTER_BASE_RATE/VEG_FLUTTER_GALE_RATE/
      // VEG_FLUTTER_UV_AMPLITUDE, plus a per-kind-only spatial scale. `uFlutter
      // Scale` multiplies `kind.flutterSpaceFreq` (still the per-kind BASE —
      // trees and bushes keep their own relative chatter fineness) rather than
      // replacing it, the same "shared param × per-kind code constant" shape
      // `swayMultiplier` already uses.
      const uFlutterFrequency = uniform(float(initialParams?.flutterFrequency ?? 1));
      const uFlutterGaleFrequency = uniform(float(initialParams?.flutterGaleFrequency ?? 0));
      const uFlutterUvScale = uniform(float(initialParams?.flutterUvScale ?? 0));
      const uFlutterScale = uniform(float(initialParams?.flutterScale ?? 1));
      // CLUMP DECORRELATION — was VEG_CLUMP_CELL_PX/_PHASE_SPREAD_SEC/_AMP_
      // SPREAD/_DIR_SPREAD_RAD. Direction is authored in DEGREES (human-
      // friendly, matches ui-window-shadow.js's own `azimuthDeg` precedent)
      // and converted to radians once here, at construction — the conversion
      // itself never changes frame to frame, only the degree value does.
      const uClumpSizePx = uniform(float(initialParams?.clumpSizePx ?? 150));
      const uClumpPhaseSpread = uniform(float(initialParams?.clumpPhaseSpread ?? 0));
      const uClumpAmpSpread = uniform(float(initialParams?.clumpAmpSpread ?? 0));
      const uClumpDirSpreadRad = uniform(float(((initialParams?.clumpDirSpread ?? 0) * Math.PI) / 180));
      const uKindSwayMul = uniform(float(kind.swayMultiplier));
      // The prevailing strength dial (0..1) — drives the CHARACTER terms (bend,
      // rate) that must respond to "how windy is the scene" rather than to the
      // local vector's own magnitude alone.
      const uGaleness = windHandle.ambient ? windHandle.ambient.speed01 : float(0);

      // SHADOW-ONLY uniforms. Written per-frame by the caller from
      // `shadowHandle.forCaster()` — the sky changes far slower than a frame,
      // so these are CPU-resolved and pushed, never recomputed per-vertex.
      const uShadowPenumbraUv = uniform(vec2(0, 0));
      const uShadowStrength = uniform(float(0));
      // THE SMEAR (2026-07-24, author live report: *"at the moment the shadows
      // move but they don't smear"*). The full throw, expressed in this tile's
      // UV space; the fragment sweeps from 0 to this and MAX-combines, so the
      // shadow is the union of the silhouette all the way from the plant's feet
      // to the tip. Zero (sun overhead) collapses the sweep to a single tap
      // under the plant, which is the correct noon shadow.
      const uShadowSmearUv = uniform(vec2(0, 0));
      const uShadowSmearTaper = uniform(float(0));
      /** Mip level for the FURTHEST smear station (interior stations scale
       * toward it) — sized so a station's texel footprint covers the gap to the
       * next one. See `alphaAt`'s own doc for the ladder this removes. */
      const uShadowSmearLod = uniform(float(0));

      const material = new THREE.NodeMaterial();
      material.transparent = true;
      material.depthTest = false;
      material.depthWrite = false;
      material.side = THREE.DoubleSide;

      material.positionNode = Fn(() => {
        // THE WORLD POSITION OF THIS VERTEX — the cell lookup below still
        // needs it, even though the WIND SAMPLE itself no longer uses it
        // directly (see this function's own "WIND IS SAMPLED PER-CLUMP-CELL"
        // header for why).
        const worldXY = vec2(positionLocal.x, positionLocal.y);
        const tSec = uGlobalTimeMs.mul(float(0.001));

        // (1) PER-CLUMP DECORRELATION — one quantized cell, three independent
        // draws. Shared by every vertex in the cell, so a plant stays coherent.
        const cell = worldXY.div(uClumpSizePx).floor();
        const phase = vegClumpHash(cell, 0).mul(uClumpPhaseSpread);
        const ampJitter = float(1)
          .sub(uClumpAmpSpread)
          .add(vegClumpHash(cell, 37.7).mul(uClumpAmpSpread.mul(float(2))));
        const dirJitter = vegClumpHash(cell, 91.3)
          .sub(float(0.5))
          .mul(uClumpDirSpreadRad.mul(float(2)));

        // THE FIELD — sampled at the CLUMP CELL'S OWN CENTRE, not this
        // vertex's exact position. Every vertex sharing a cell now reads the
        // IDENTICAL wind vector, so a cell can only translate/rotate as a
        // whole, never shear internally (the gale-blob/self-intersection fix
        // — see this function's own header).
        const cellCenterXY = cell.add(vec2(float(0.5), float(0.5))).mul(uClumpSizePx);
        const rawWindLean = windHandle.node(THREE.TSL, {
          centerXY: cellCenterXY,
          time: uGlobalTimeMs,
          exposure: float(1), // see this function's own "⚠ EXPOSURE" note
        });
        // HARD CAP on the sample's OWN magnitude (`VEG_MAX_LOCAL_SPEED`) —
        // rescales the WHOLE vector, never distorts its direction, so
        // `leanDir` below stays properly unit-length regardless.
        const rawSpeed = length(rawWindLean);
        const speedCapScale = min(float(1), float(VEG_MAX_LOCAL_SPEED).div(max(rawSpeed, float(1e-4))));
        const windLean = rawWindLean.mul(speedCapScale);
        const localSpeed = length(windLean);
        // Rotate the local wind by this clump's own jitter — a stand of trees
        // leans broadly together but never as one rigid sheet.
        const ca = cos(dirJitter);
        const sa = sin(dirJitter);
        const leanX = windLean.x.mul(ca).sub(windLean.y.mul(sa));
        const leanY = windLean.x.mul(sa).add(windLean.y.mul(ca));
        const leanDir = vec2(leanX, leanY).div(max(localSpeed, float(1e-4))); // unit-ish

        // (2) PERSISTENT BEND — the gale's defining pose. Grows with the SQUARE
        // of prevailing strength so it stays negligible in a breeze and
        // dominant in a gale, and rides `localSpeed` so a sheltered courtyard
        // does not bend at all however hard it blows outside.
        const galeness = clamp(uGaleness, float(0), float(1));
        const bend = leanDir.mul(localSpeed).mul(galeness).mul(galeness).mul(uGaleBendAmount);

        // (3) OSCILLATING SWAY — amplitude on a >1 curve, rate rising with wind.
        // NO root-pinned/tip-swaying weight here (Tier 2 had one; removed —
        // see this function's own header for why it was actually the top-vs-
        // bottom-of-map bug, not a real "canopy" concept for a scene-wide mask).
        const rate = uSwayFrequency.mul(float(1).add(galeness.mul(uGaleRateGain)));
        const swing = sin(tSec.add(phase).mul(rate).mul(float(6.2831853)));
        const amplitude = pow(max(localSpeed, float(0)), uSwayCurve).mul(ampJitter);
        const oscillate = leanDir.mul(amplitude).mul(swing);

        // SCENE-EDGE-FADE — computed from the REST position (never the
        // displaced one, which would make the fade depend on the very
        // displacement it is supposed to gate). See this function's own
        // header + the uniform block above.
        const sceneUv = worldXY.sub(uSceneMin).div(uSceneSize);
        const edgeDistX = min(sceneUv.x, float(1).sub(sceneUv.x));
        const edgeDistY = min(sceneUv.y, float(1).sub(sceneUv.y));
        const edgeFadeWidthNormX = uEdgeFadeWidthPx.div(uSceneSize.x);
        const edgeFadeWidthNormY = uEdgeFadeWidthPx.div(uSceneSize.y);
        const edgeFade = smoothstep(float(0), max(edgeFadeWidthNormX, float(1e-5)), edgeDistX).mul(
          smoothstep(float(0), max(edgeFadeWidthNormY, float(1e-5)), edgeDistY)
        );

        const rawDisplace = bend.add(oscillate).mul(uSwayAmount).mul(uWindResponse).mul(uKindSwayMul).mul(edgeFade);
        // FINAL HARD CAP (`VEG_MAX_DISPLACE_PX`) — the backstop for several
        // independent sliders maxed out simultaneously. Rescales, never
        // distorts direction.
        const rawDisplaceLen = length(rawDisplace);
        const displaceCapScale = min(float(1), float(VEG_MAX_DISPLACE_PX).div(max(rawDisplaceLen, float(1e-4))));
        const displace = rawDisplace.mul(displaceCapScale);

        // The shadow variant rides the IDENTICAL displacement and is NOT
        // translated (2026-07-24). It used to be pushed bodily by the sun's
        // throw, which is what made it a detached copy sliding around rather
        // than a shadow: a real shadow occupies EVERY position between the
        // caster's foot and its tip, so its quad has to span both ends and the
        // throw has to happen in the fragment (see the smear loop in
        // colorNode). The quad is pre-padded by the caster's maximum possible
        // throw, so this stays a build-time-constant geometry that never
        // rebuilds as the sun moves.
        return positionLocal.add(vec3(displace.x, displace.y, float(0)));
      })();

      material.colorNode = Fn(() => {
        // (4) LEAF FLUTTER — a curl-noise UV shuffle. Divergence-free ⇒ area
        // preserving ⇒ "mass preserving": leaves move, the canopy neither
        // stretches nor thins. Skipped entirely for the shadow (a blurred
        // silhouette gains nothing from per-leaf detail, and it would double
        // the fragment noise cost for something nobody can resolve).
        let sampleUv = uv().mul(uUvScale);
        if (!asShadow) {
          // ── THE FOLIAGE-PRESENCE GATE ──────────────────────────────────
          // See VEG_FLUTTER_GATE_LOD's own header for the measurement that
          // motivated this and the proof it cannot change a pixel. Everything
          // from here to the end of this block is skipped wherever the art has
          // no foliage within reach — which is most of the map, and was the
          // single largest GPU cost in the frame.
          //
          // `sampleUv` becomes a VAR because TSL's If() is a real branch in the
          // emitted shader: a plain `let` reassignment inside the callback would
          // rebind a JS variable at graph-BUILD time, not write a value at
          // shader-RUN time, and the displacement would silently apply
          // unconditionally (exactly the class of bug
          // `reference_tsl_fn_deferred_execution_trap` records).
          const gatedUv = sampleUv.toVar('vegSampleUv');
          const coarseFoliageAlpha = texture(tex).sample(sampleUv).level(float(VEG_FLUTTER_GATE_LOD)).a;
          If(coarseFoliageAlpha.greaterThan(float(VEG_FLUTTER_GATE_ALPHA_EPS)), () => {
            const galeness = clamp(uGaleness, float(0), float(1));
            // `rate`/`spaceFreq` are LIVE uniform nodes here, not the plain JS
            // numbers curlNoise2D's own JSDoc describes — safe (verified against
            // the vendored TSL `ConvertType`/`float()`: a node passed to `float()`
            // is cast/passed through, never re-wrapped as a NEW constant), and it
            // is what makes "Flutter frequency" a live, per-frame-tunable rate
            // rather than a number only a material rebuild could change.
            const flutterRate = uFlutterFrequency.add(galeness.mul(uFlutterGaleFrequency));
            // ONE octave — the stated fragment-cost ceiling (4 noise evals).
            const flutterVec = curlNoise2D(THREE.TSL, {
              p: vec2(positionLocal.x, positionLocal.y),
              timeSec: uGlobalTimeMs.mul(float(0.001)),
              spaceFreq: float(kind.flutterSpaceFreq).mul(uFlutterScale),
              rate: flutterRate,
              phaseX: 613,
              phaseY: -157,
            });
            // Strength rises with the LOCAL wind, so sheltered foliage is still
            // and exposed foliage shimmers — the same locality the sway obeys.
            // Already clamped to [0,1] below, independent of `VEG_MAX_LOCAL_
            // SPEED` (the sway cap) — flutter never needed the higher ceiling.
            const localSpeed = clamp(
              length(
                windHandle.node(THREE.TSL, {
                  centerXY: vec2(positionLocal.x, positionLocal.y),
                  time: uGlobalTimeMs,
                  exposure: float(1),
                })
              ),
              float(0),
              float(1)
            );
            // ASYMMETRIC GALE DAMPING (2026-07-23, live-test author report: "we
            // have to be careful to get leaf flutter and sway without them
            // becoming a blender of nonsense at gale strength") — reverse-
            // engineered from V2's own proven curve (legacy/compositor-v2/
            // effects/vegetation-bulk-wind.js): fine per-pixel flutter is
            // ACTIVELY DAMPED as wind approaches gale, the opposite of scaling
            // it up alongside the rate term. `flutterGaleFrequency` still
            // speeds the pattern's EVOLUTION up at gale (the author's own live
            // dial); this independently keeps AMPLITUDE from following it.
            const flutterGaleDamp = mix(
              float(1),
              float(VEG_FLUTTER_GALE_DAMP_FLOOR),
              smoothstep(float(VEG_FLUTTER_GALE_DAMP_START), float(VEG_FLUTTER_GALE_DAMP_END), galeness)
            );
            // SCENE-EDGE-FADE — same mechanism and same uniforms as the sway
            // displacement above (positionNode's own local `edgeFade` cannot be
            // shared across Fn() scopes, so it is recomputed here from the SAME
            // uniforms — the existing `galeness`/`localSpeed` split between the
            // two stages is the same established pattern in this function).
            const worldXY = vec2(positionLocal.x, positionLocal.y);
            const sceneUv = worldXY.sub(uSceneMin).div(uSceneSize);
            const edgeDistX = min(sceneUv.x, float(1).sub(sceneUv.x));
            const edgeDistY = min(sceneUv.y, float(1).sub(sceneUv.y));
            const edgeFadeWidthNormX = uEdgeFadeWidthPx.div(uSceneSize.x);
            const edgeFadeWidthNormY = uEdgeFadeWidthPx.div(uSceneSize.y);
            const edgeFade = smoothstep(float(0), max(edgeFadeWidthNormX, float(1e-5)), edgeDistX).mul(
              smoothstep(float(0), max(edgeFadeWidthNormY, float(1e-5)), edgeDistY)
            );
            // STEEP RESPONSE CURVE (2026-07-23, live-test author: "nearly zero
            // at windless... just the smallest touch") — see `VEG_FLUTTER_
            // SPEED_CURVE`'s own header. `pow(1, x) = 1`, so the gale ceiling
            // is untouched here; only the ramp up to it steepens.
            const localSpeedCurved = pow(localSpeed, float(VEG_FLUTTER_SPEED_CURVE));
            // Normalised against the LIVE base frequency (not a fixed constant)
            // so the ratio still reads 1 at calm even after the author retunes
            // "Flutter frequency" itself — only the gale ADD-ON should ever move
            // the ratio away from 1.
            const flutterStrength = localSpeedCurved
              .mul(uFlutterAmount)
              .mul(uFlutterUvScale)
              .mul(flutterRate.div(max(uFlutterFrequency, float(1e-4))))
              .mul(flutterGaleDamp)
              .mul(edgeFade);
            const rawFlutterDisplacement = flutterVec.mul(flutterStrength);
            // HARD CAP (`VEG_FLUTTER_UV_CAP`, matches V2's own proven ceiling
            // almost exactly) — rescales, never distorts direction.
            const flutterMag = length(rawFlutterDisplacement);
            const flutterCapScale = min(float(1), float(VEG_FLUTTER_UV_CAP).div(max(flutterMag, float(1e-5))));
            // addAssign, not `sampleUv = ...`: a shader-run-time write into the
            // var, so it happens only on the taken branch. See the gate header.
            gatedUv.addAssign(rawFlutterDisplacement.mul(flutterCapScale));
          });
          sampleUv = gatedUv;
        }

        if (asShadow) {
          // ═══════════════════════════════════════════════════════════════
          // THE SMEARED SILHOUETTE (2026-07-24 — author: *"at the moment the
          // shadows move but they don't smear"*, and *"the tree shadows are
          // already too far away from their producers at dawn and dusk"*).
          // ═══════════════════════════════════════════════════════════════
          //
          // A shadow is not the caster translated by the throw. It is the
          // caster's silhouette swept along the throw, from the ground contact
          // (t=0, directly under the plant) to the tip (t=1, the full offset).
          // A single translated copy is the ONLY thing the old code drew, which
          // is exactly why it read as a detached duplicate sliding around at
          // dawn — the plant's own feet were never in shadow at all.
          //
          // THE GEOMETRY THAT MAKES THIS POSSIBLE: this quad is PADDED by the
          // caster's maximum possible throw (`shadowPadUv` below) and is NOT
          // translated, so it spans both ends of the sweep. `artUv` undoes the
          // padding, mapping this fragment back onto the plant's own texture;
          // everything outside the art reads alpha 0 (never a clamped edge
          // column smeared across the pad, which would paint a black bar).
          //
          // A ground point is shadowed if ANY t along the sweep finds opaque
          // art, so the taps MAX-combine — a union, not an average, which is
          // what keeps a long streak solid instead of ghosting.
          // Undo the pad, per axis (the pad is a fixed fraction of each axis, so
          // the two differ on a non-square tile): meshUv 0..1 → artUv -pad..1+pad.
          const base = vec2(
            sampleUv.x.mul(float(1 + 2 * shadowPadUv[0])).sub(float(shadowPadUv[0])),
            sampleUv.y.mul(float(1 + 2 * shadowPadUv[1])).sub(float(shadowPadUv[1]))
          );
          const p = uShadowPenumbraUv;
          /** Alpha of the plant at an art UV, with everything outside the art
           * reading 0 — the pad is empty ground, not a stretched edge pixel.
           *
           * `lod` is THE LADDER FIX (2026-07-25, author's dawn screenshot: "a
           * series of shadows which are detached from each other"). The sweep
           * has a FIXED station count, so a longer throw means wider gaps
           * between stations — and a caster thinner than that gap lands as its
           * own separate copy: a ladder, worst at dawn/dusk when the throw is
           * longest. Sampling each station from a MIP level whose texels are as
           * wide as the gap makes consecutive stations OVERLAP, so the streak is
           * continuous at any length, and a thin caster melts into the single
           * faint smooth smudge the author said they'd accept — for ONE fetch
           * per station, not a wider multi-tap. */
          const alphaAt = (at, lod) => {
            const inX = step(float(0), at.x).mul(step(at.x, float(1)));
            const inY = step(float(0), at.y).mul(step(at.y, float(1)));
            const uvc = vec2(at.x.clamp(0, 1), at.y.clamp(0, 1));
            const s = lod ? texture(tex).sample(uvc).level(lod) : texture(tex, uvc);
            return s.a.mul(inX).mul(inY);
          };
          /** The feathered 5-tap cross — the penumbra, applied only at the two
           * ENDS of the sweep. The interior of a streak has no edge to feather,
           * so paying 5 fetches per station there would buy nothing. */
          const crossAt = (at, lod) =>
            alphaAt(at, lod)
              .add(alphaAt(at.add(vec2(p.x.negate(), float(0))), lod))
              .add(alphaAt(at.add(vec2(p.x, float(0))), lod))
              .add(alphaAt(at.add(vec2(float(0), p.y.negate())), lod))
              .add(alphaAt(at.add(vec2(float(0), p.y)), lod))
              .div(float(5));

          // t = 0 — the ground contact, always solid AND sharp (lod 0): this is
          // what stops the shadow ever fully detaching from the plant, and the
          // one place the silhouette should stay crisp.
          let smeared = crossAt(base);
          for (let s = 1; s <= VEG_SHADOW_SMEAR_TAPS; s++) {
            const t = s / VEG_SHADOW_SMEAR_TAPS;
            const at = base.sub(uShadowSmearUv.mul(float(t)));
            // Blur grows along the sweep: the foot stays sharp, the tip
            // dissolves — the same contact-hardening the sun march does, and
            // what makes the stations merge instead of laddering.
            const tapLod = uShadowSmearLod.mul(float(t));
            const tapAlpha = s === VEG_SHADOW_SMEAR_TAPS ? crossAt(at, tapLod) : alphaAt(at, tapLod);
            // Taper the TIP (t→1), never the foot. A shadow fades out at its far
            // end as the penumbra swallows it; it does not fade where it meets
            // the thing casting it.
            const faded = tapAlpha.mul(float(1).sub(uShadowSmearTaper.mul(float(t))));
            smeared = max(smeared, faded);
          }
          const shadowAlpha = smeared.mul(uShadowStrength).mul(occlusionAlphaFactor(occ));
          // Flat black with alpha — under ordinary alpha blending this IS a
          // multiply-darken of whatever ground is beneath it.
          return vec4(float(0), float(0), float(0), shadowAlpha);
        }

        const c = texture(tex, sampleUv).toVar();
        c.rgb.mulAssign(uTint);
        c.a.mulAssign(uAlpha);
        c.a.mulAssign(uIntensity);
        c.a.mulAssign(occlusionAlphaFactor(occ));
        return c;
      })();

      // buf:scene.attr REAL WRITER, Case-1 embedded vegetation only (see
      // isFloorSurface's own doc above — never true alongside asShadow, so
      // no separate shadow-path guard is needed here). Reads its own alpha
      // via TSL.output, not a closure variable (buildRealFloorAttrMrtNode's
      // own doc has the live-crash story).
      if (isFloorSurface) {
        material.mrtNode = buildRealFloorAttrMrtNode({
          THREE,
          item,
          viewedFloorIndex: view.floorIndex,
          sceneDoc: globalThis.canvas?.scene ?? null,
          logError: log.error,
          envLight,
        });
      }

      return {
        material,
        appearance: {
          uTint,
          uAlpha,
          uOcclusionElevation: occ.uOcclusionElevation,
          uOcclusionWeights: occ.uOcclusionWeights,
          uUnoccludedAlpha: occ.uUnoccludedAlpha,
          uOccludedAlpha: occ.uOccludedAlpha,
        },
        motion: {
          uIntensity,
          uWindResponse,
          uSwayAmount,
          uSwayFrequency,
          uSwayCurve,
          uGaleBendAmount,
          uGaleRateGain,
          uFlutterAmount,
          uFlutterFrequency,
          uFlutterGaleFrequency,
          uFlutterUvScale,
          uFlutterScale,
          uClumpSizePx,
          uClumpPhaseSpread,
          uClumpAmpSpread,
          uClumpDirSpreadRad,
          uEdgeFadeWidthPx,
        },
        shadow: asShadow
          ? { uShadowPenumbraUv, uShadowStrength, uShadowSmearUv, uShadowSmearTaper, uShadowSmearLod }
          : null,
        windHandleVersion: windHandle.version,
      };
    }

    /**
     * Rebuild a tile mesh's world quad from the item's CURRENT placement (called
     * on load and on any placement change). Geometry only — texture is untouched.
     *
     * `segments > 1` builds a TESSELLATED grid instead of the plain 4-vertex
     * quad — used only by vegetation, so each vertex can sample the wind at its
     * own world position (see `buildVegetationMaterial`'s own header). The
     * segment count is stored on `t` so a later placement change can tell a
     * cheap in-place buffer rewrite (same size — the common case) from a genuine
     * RESIZE that changed the count and needs fresh, differently-sized
     * attributes. Getting that wrong would silently write past the end of the
     * old array, so it is checked rather than assumed.
     */
    // (`attachVegetationTileShadow`, `padPlacement` and
    // `vegetationShadowPadPx` moved to `effects/vegetation-shadow-subsystem.js`
    // — extraction step 2. The first is now `vegShadows.attachTileShadow`; the
    // other two are pure and imported directly, because `setTileGeometry` just
    // below and the Case-2 overlay build both still call them.)

    /**
     * @param {object} t - the tile record.
     * @param {object} placement
     * @param {number} imageW @param {number} imageH
     * @param {number} [segments]
     * @param {number} [padPx=0] - grow this tile's world quad outward by this
     *   much on every side WITHOUT moving its art (the material's
     *   `shadowPadUv` undoes it). Used by the vegetation shadow so a swept
     *   shadow has somewhere to land; 0 for every ordinary drawable.
     */
    function setTileGeometry(t, placement, imageW, imageH, segments = 1, padPx = 0) {
      t.sub = computeTileSubPlacement(placement, imageW, imageH, t.tile);
      // Grow in the item's LOCAL frame (width/height, pre-rotation) so a rotated
      // tile's pad rotates with it — the same reason `computeQuadCorners` is the
      // one place rotation is applied.
      if (padPx > 0) t.sub = padPlacement(t.sub, padPx);
      const n = Math.max(1, Math.floor(segments));
      const corners = computeQuadCorners(t.sub);
      const positionAttr = t.geometry.getAttribute('position');
      if (n <= 1) {
        const positions = buildQuadPositions(corners);
        if (positionAttr && t.segments === 1) {
          positionAttr.array.set(positions);
          positionAttr.needsUpdate = true;
        } else {
          t.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
          t.geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
          t.geometry.setIndex(Array.from(QUAD_INDICES));
        }
        t.segments = 1;
        return;
      }
      const grid = buildTessellatedQuadGeometry(corners, n);
      if (positionAttr && t.segments === n) {
        // Same tessellation, moved — reuse the array (BufferAttribute has no
        // dispose(); reallocating per placement change is the leak-shaped
        // mistake reference_bufferattribute_no_dispose_trap names).
        positionAttr.array.set(grid.positions);
        positionAttr.needsUpdate = true;
      } else {
        t.geometry.setAttribute('position', new THREE.BufferAttribute(grid.positions, 3));
        t.geometry.setAttribute('uv', new THREE.BufferAttribute(grid.uvs, 2));
        t.geometry.setIndex(new THREE.BufferAttribute(grid.indices, 1));
      }
      t.segments = n;
    }

    // Serialize whole-image loads so only ONE giant image is ever in flight
    // (fetch → decode → upload → GPU-drain → close). Two 12000² floor-1 images
    // loading at once meant two ~576 MB source bitmaps alive AND two ~549 MB GPU
    // uploads submitted back-to-back — the memory-plus-queue spike that lost the
    // device on a floor switch (2026-07-18). One at a time trades a slightly
    // slower reveal for a bounded peak.
    let wholeImageLoadChain = Promise.resolve();

    /** Build (once) the whole-image drawable for an item: plan → async decode
     * each tile's source rect → texture → quad mesh. Idempotent; the async load
     * fills in `state.wholeImage.tiles` as bitmaps arrive. Every failure is
     * captured on `state.wholeImage.error`, never thrown — a broken item must
     * not take the scene down, and the diagnostics must be able to name it. */
    function ensureWholeImageMeshes(state, item) {
      if (state.wholeImage) return state.wholeImage;
      const imageW = state.imageSize.width;
      const imageH = state.imageSize.height;

      // VEGETATION CASE 1 (Vegetation.md) — the item's OWN texture is itself
      // `_Tree`/`_Bush`-suffixed (an artist dropped e.g. `oak-cluster_Tree.webp`
      // directly onto the map as a tile — the file IS the vegetation, no
      // separate albedo). Detected here, ONCE, from the item's own src — a pure
      // string match, no discovery involved (see effects/vegetation-render.js's
      // own header for why this case needs none). When detected AND the effect
      // is enabled, this item's material becomes `buildVegetationMaterial`
      // instead of the ordinary `buildWholeImageMaterial` at BOTH load paths
      // below — same texture, same quad, same occlusion handling, just a
      // wind-driven positionNode added. When the effect is disabled, the tile
      // still renders normally (static) rather than disappearing — a GM's
      // placed content must never vanish just because a look toggle is off
      // (the safety-slide doctrine).
      const vegKind = detectSelfVegetationKind(item.src, VEGETATION_KINDS);
      const vegState = vegKind ? getVegetationRenderState() : null;
      const vegActive = !!(vegKind && vegState?.enabled);
      // TESSELLATION (2026-07-23) — a vegetation tile subdivides so each vertex
      // can sample the wind at its OWN world position; everything else stays
      // the plain 4-vertex quad it always was. See
      // `effects/vegetation-render.js#vegetationMeshSegments` for why this is
      // the fix for "everything sways identically".
      const vegSegments = vegActive
        ? vegetationMeshSegments(state.placement?.width ?? 0, state.placement?.height ?? 0)
        : 1;
      // ⚠ ACCEPTED LIMITATION, stated rather than hidden: `ensureWholeImageMeshes`
      // is idempotent FOREVER (the guard at this function's own top) — the
      // material choice made here is a ONE-TIME, construction-time decision,
      // never revisited. Toggling the effect off AFTER this tile already loaded
      // will not stop it swaying until the next scene load/reload. This is the
      // SAME tradeoff Wind.md §9 already documents for the candle flame's own
      // material (a later wind rebake doesn't reach an already-built kernel
      // either) — not a new gap, the established one, extended to a second
      // consumer. Live per-frame motion-uniform muting (zeroing uSwayAmount/
      // uWindResponse without a rebuild) is the cheap fix, deferred rather than
      // built blind into an already-large pass.

      // Cap tile size for MEMORY safety, not just the HW limit: a single 12000²
      // upload TDR'd the device on a floor switch. See MAX_WHOLE_TILE_DIM.
      const plan = planImageTiles(imageW, imageH, Math.min(textureLimit, MAX_WHOLE_TILE_DIM));
      const wi = {
        status: 'loading',
        error: null,
        imageSize: { width: imageW, height: imageH },
        limit: textureLimit,
        plan: { cols: plan.cols, rows: plan.rows, whole: plan.whole, tiles: plan.tiles.length },
        tiles: [], // filled as each tile decodes: {tile, sub, tex, geometry, material, mesh, appearance}
        src: item.src,
        renderOrder: item.renderOrder,
        bitmapsFreed: 0, // decoded CPU bitmaps closed after GPU upload (memory reclaimed)
        bitmapsRetained: 0, // bitmaps left un-closed (upload could not be forced) — should stay 0
        compressed: null, // null | 'bc1'|'bc7' (+ '(cached)') | 'error:fellback'
        rawScale: 1, // <1 only on the capped RAW fallback (worker unavailable) — see MAX_RAW_FALLBACK_DIM
        // SOURCE alpha, as the decoder actually handed it to the worker, BEFORE
        // any BC7 encoding touches it (2026-07-18 diagnostic: "background renders
        // totally black in isolation, but a same-format/same-dimension overhead
        // tile on the same floor looks correct"). min/max/mean over every alpha
        // byte in the real decode. If this already reads near-zero, the bug is
        // upstream of the encoder (decode/premultiply); if it reads sane
        // (mostly-255-with-real-holes) yet the item still renders black, the bug
        // is downstream (encode/pack/GPU-upload) — this field is what tells the
        // two apart instead of guessing a third time.
        alphaStats: null,
      };
      state.wholeImage = wi;

      // wi.loadPromise: the async body below ALWAYS resolves (every error path
      // sets wi.status='error' + wi.error and does not re-throw — see the catch
      // block), so this is safe for a caller to await without a try/catch of its
      // own. Fire-and-forget callers (the normal per-frame refresh path) ignore
      // it exactly as before; startVtPanViewer's startup sequence uses it to
      // actually WAIT for the viewed floor's compression before dropping the
      // loading curtain (2026-07-18 — "encoding during loading" fix: this
      // promise used to be thrown away entirely, so the curtain could drop
      // claiming "Ready" while the floor you were looking at still had
      // invisible art compressing in the background — exactly the "0%/98%
      // gate" class of lie load-progress.js's header exists to forbid, just
      // relocated from the progress bar to the floor switch).
      wi.loadPromise = (async () => {
        // Take our place in the serialized load queue: only one giant image is
        // ever in flight at a time (see wholeImageLoadChain).
        const priorLoad = wholeImageLoadChain;
        let releaseLoad;
        wholeImageLoadChain = new Promise((res) => {
          releaseLoad = res;
        });
        // WebGPU-only handle: wait for the GPU to FINISH each upload before the
        // next starts, bounding queue depth so a burst of giant copies can't
        // back up into a TDR (the guard the streaming path uses too).
        const gpuQueue = renderer.backend?.isWebGPUBackend ? renderer.backend.device?.queue : null;
        try {
          // Our chain promise is only ever RESOLVED (releaseLoad in finally),
          // never rejected, so a plain await cannot propagate a prior failure.
          await priorLoad;
          // Backend must be up before we can force-upload a tile (initTexture
          // throws otherwise). init() is idempotent and resolves instantly once
          // the device exists, so awaiting it here just removes a startup race.
          await renderer.init();

          // COMPRESSED PATH — the WebGPU-memory-ceiling fix. Both floors of raw
          // 12000² art exceed Chrome's ~2.5 GB device-loss wall; compressed they
          // fit far under it. The worker returns BC1 for OPAQUE images (8×, e.g. a
          // floor background 549→72 MB) and BC7 for ALPHA images (4×, carries the
          // overhead/roof overlays' alpha holes the multifloor composite needs —
          // those used to stay raw at 549 MB each and lost the device on a floor
          // switch). Any worker failure/unavailability returns null and we FALL
          // THROUGH to the proven raw path — compression must never break
          // rendering (the safety slide).
          try {
            const c = await requestCompressedTexture(item.src);
            if (c && (c.format === 'bc1' || c.format === 'bc7') && c.levels?.length) {
              // A block-compressed texture's dimensions MUST be a multiple of 4
              // (the 4×4 block). The worker encodes ceil(w/4)×ceil(h/4) blocks with
              // edge-clamped padding, so each level's block buffer IS a valid
              // encoding of ITS OWN padded size (already applied by the worker —
              // see bc-compress.worker.js) — upload at padW×padH (WebGPU rejects
              // the raw 1050×1050 etc. that lost the device) and let the
              // material's uvScale sample only the logical w×h sub-rect. The
              // block count (hence byte length) already matches the padded size,
              // so only the width/height and the format enum change between
              // BC1 and BC7.
              //
              // THE MIP CHAIN (2026-07-19 — "MSA looks noisier than PIXI zoomed
              // out"): levels[0] is the full-resolution level exactly as
              // before; levels[1..] are the pre-encoded mip chain
              // (bc-compress.worker.js — a block-compressed texture cannot have
              // its mips GPU-auto-generated, so a real chain must be supplied).
              // Handing THREE the full array is all multi-level upload needs
              // (verified against three.webgpu.js: `_copyCompressedBufferToTexture`
              // reads each `mipmaps[i].width/height` independently, and
              // `getMipLevels` uses `mipmaps.length` directly as the level
              // count) — no other call here changes.
              const threeFormat = c.format === 'bc7' ? THREE.RGBA_BPTC_Format : THREE.RGBA_S3TC_DXT1_Format;
              const mipmaps = c.levels.map((lvl) => ({ data: lvl.blocks, width: lvl.width, height: lvl.height }));
              const padW = mipmaps[0].width;
              const padH = mipmaps[0].height;
              const tex = new THREE.CompressedTexture(mipmaps, padW, padH, threeFormat);
              // Block rows are top-first (getImageData order), same as the raw
              // bitmap path — so v=0 = top, matching the world-quad convention.
              // Y-FLIP is a recurring bug class (memory: y_flip_recurring_risk):
              // if a compressed floor renders upside-down, this is the line.
              tex.flipY = false;
              tex.colorSpace = THREE.SRGBColorSpace;
              tex.generateMipmaps = false; // already forced by isCompressedTexture; explicit for clarity — mips are hand-supplied above
              tex.minFilter = THREE.LinearMipmapLinearFilter; // real trilinear across the supplied chain
              tex.magFilter = THREE.LinearFilter;
              tex.anisotropy = ART_TEXTURE_ANISOTROPY; // see the constant's own doc
              tex.needsUpdate = true;
              try {
                renderer.initTexture(tex);
              } catch (_) {
                // Backend not up yet — Three uploads the CompressedTexture lazily
                // on first render. Correct, just not forced.
              }
              const wholeTile = { sx: 0, sy: 0, sw: c.width, sh: c.height, col: 0, row: 0 };
              const compressedUvScale = [c.width / padW, c.height / padH];
              const { material, appearance, motion } = vegActive
                ? buildVegetationMaterial(tex, item, vegKind, vegState.params, {
                    uvScale: compressedUvScale,
                    isFloorSurface: true, // Case-1 embedded veg IS the floor here — see the function's own doc
                  })
                : buildWholeImageMaterial(tex, item, compressedUvScale);
              const geometry = new THREE.BufferGeometry();
              const t = { tile: wholeTile, sub: null, tex, geometry, material, appearance, motion, mesh: null };
              setTileGeometry(t, state.placement, imageW, imageH, vegSegments);
              const mesh = new THREE.Mesh(geometry, material);
              mesh.frustumCulled = false;
              mesh.visible = false; // the refresh loop decides visibility + renderOrder
              mesh.renderOrder = wi.renderOrder;
              t.mesh = mesh;
              scene.add(mesh);
              if (vegActive) {
                vegShadows.attachTileShadow(
                  t,
                  item,
                  vegKind,
                  vegState.params,
                  state,
                  imageW,
                  imageH,
                  vegSegments,
                  compressedUvScale
                );
              }
              wi.tiles.push(t);
              wi.compressed = c.cached ? `${c.format}(cached)` : c.format;
              wi.alphaStats = c.alphaStats ?? null;
              wi.status = 'ready';
              scheduleResidencyUpdate().catch(() => {
                // Non-fatal: the next real input refreshes visibility anyway.
              });
              return; // compressed → done (releaseLoad still runs in the finally below)
            }
          } catch (err) {
            // The compressed attempt must never sink the item — fall through to raw.
            wi.compressed = 'error:fellback';
            log.warn(`BC1 path failed for "${item.id}", using raw:`, err);
          }

          // RAW PATH (fallback). Reached only when the compressed worker gave us
          // nothing (unavailable/failed). Main thread resolves a data-relative src
          // fine; createImageBitmap decodes OFF the main thread, and its crop args
          // slice each tile's source rect directly — no full-image hold.
          // SAFETY-SLIDE CAP: without compression, a full-res upload is the 549 MB
          // device-killer this whole change exists to prevent. Downscale the
          // fallback so even an all-raw scene stays under the WebGPU ceiling
          // (softer art, live device). rawScale=1 when the image already fits.
          const rawScale = Math.min(1, MAX_RAW_FALLBACK_DIM / Math.max(imageW, imageH));
          wi.rawScale = rawScale;
          if (rawScale < 1) wi.compressed = 'raw:capped';
          const res = await fetch(item.src);
          if (!res.ok) throw new Error(`HTTP ${res.status} for ${item.src}`);
          const blob = await res.blob();
          for (const tile of plan.tiles) {
            const rw = Math.max(1, Math.round(tile.sw * rawScale));
            const rh = Math.max(1, Math.round(tile.sh * rawScale));
            const bitmap =
              rawScale < 1
                ? await createImageBitmap(blob, tile.sx, tile.sy, tile.sw, tile.sh, {
                    resizeWidth: rw,
                    resizeHeight: rh,
                    resizeQuality: 'high',
                  })
                : await createImageBitmap(blob, tile.sx, tile.sy, tile.sw, tile.sh);
            const tex = new THREE.Texture(bitmap);
            tex.flipY = false; // v=0 = image top row — the world-quad convention
            tex.colorSpace = THREE.SRGBColorSpace; // art is sRGB; sample decodes to linear
            // Real mips (2026-07-19 — "MSA noisier than PIXI zoomed out"): this
            // used to force generateMipmaps:false + LinearFilter, copied from
            // atlas.js's page atlas where that pairing is correct for a DIFFERENT
            // reason (an atlas slot's neighbours are arbitrary bookkeeping — see
            // atlas.js's header). This is one ordinary whole image; minifying it
            // with no mip chain is plain aliasing. THREE.Texture defaults to
            // generateMipmaps:true — an uncompressed texture CAN have its chain
            // GPU-auto-generated (unlike the BC1/BC7 path above, which cannot and
            // gets a hand-built chain instead), so this now just stops overriding
            // that default.
            tex.generateMipmaps = true;
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.anisotropy = ART_TEXTURE_ANISOTROPY; // see the constant's own doc
            tex.needsUpdate = true;
            // Force the GPU upload NOW, then free the decoded CPU-side bitmap.
            // Three otherwise retains the ImageBitmap forever via `tex.image`
            // (w·h·4 bytes — ~576 MB for one 12000² tile), redundant with the
            // GPU copy. On a multi-floor scene those retained bitmaps stack and
            // pushed the device past its memory ceiling on floor switch
            // (2026-07-18). initTexture runs copyExternalImageToTexture
            // synchronously (verified against the vendored WebGPU backend), so
            // the pixels are on the GPU before we close.
            try {
              renderer.initTexture(tex);
              if (typeof bitmap.close === 'function') bitmap.close();
              wi.bitmapsFreed++;
            } catch (_) {
              // Upload could not be forced (should not happen — init() awaited
              // above). Leave the bitmap so Three uploads it lazily on first
              // render; closing before upload would blank the tile.
              wi.bitmapsRetained++;
            }
            // Wait for the GPU to FINISH this ~549 MB copy before the next giant
            // upload, so a floor switch's two big copies can't queue up unbounded
            // into a TDR. Healthy: returns in well under a ms.
            if (gpuQueue) {
              try {
                await gpuQueue.onSubmittedWorkDone();
              } catch (_) {
                // A lost/dying device rejects this; the device-lost handler owns
                // recovery, so there is nothing to do here but stop waiting.
              }
            }
            const { material, appearance, motion } = vegActive
              ? buildVegetationMaterial(tex, item, vegKind, vegState.params, { isFloorSurface: true })
              : buildWholeImageMaterial(tex, item);
            const geometry = new THREE.BufferGeometry();
            const t = { tile, sub: null, tex, geometry, material, appearance, motion, mesh: null };
            setTileGeometry(t, state.placement, imageW, imageH, vegSegments);
            const mesh = new THREE.Mesh(geometry, material);
            mesh.frustumCulled = false;
            mesh.visible = false; // the refresh loop decides visibility + renderOrder
            mesh.renderOrder = wi.renderOrder;
            t.mesh = mesh;
            scene.add(mesh);
            if (vegActive) {
              vegShadows.attachTileShadow(t, item, vegKind, vegState.params, state, imageW, imageH, vegSegments);
            }
            wi.tiles.push(t);
          }
          wi.status = 'ready';
          // The meshes were added mid-load with visible:false, and nothing else
          // sets their visibility until the NEXT input event — which is why the
          // big textures stayed BLACK until the user panned. Re-run the refresh
          // now so they appear the instant they finish loading.
          scheduleResidencyUpdate().catch(() => {
            // Non-fatal: the next real input refreshes visibility anyway.
          });
        } catch (err) {
          wi.status = 'error';
          wi.error = String(err?.message || err);
          log.error(`whole-image load failed for "${item.id}" (${item.src}):`, err);
        } finally {
          // Release the next queued load regardless of outcome, or one broken
          // image would stall every subsequent whole-image load forever.
          releaseLoad();
        }
      })();

      return wi;
    }

    /** Update a whole-image item each refresh: reposition on placement change,
     * set visibility + renderOrder. Cheap; the textures never re-upload. */
    function refreshWholeImageItem(state, item, show, placementChanged) {
      const wi = state.wholeImage;
      if (!wi) return;
      wi.renderOrder = item.renderOrder;
      // Read the vegetation state ONCE per item, and only when this item
      // actually carries a shadow — the overwhelming majority of items are not
      // vegetation and must pay nothing for this. NOTE: uniform SYNC (motion/
      // shadow) does NOT happen here any more — see `syncAllVegetationMotion
      // ForFrame`'s own header for why it moved to the per-frame render loop.
      // This function only decides visibility, which legitimately does only
      // need to change on a residency pass (placement/screen-visibility).
      let vegState = null;
      for (const t of wi.tiles) {
        if (t.shadow) {
          vegState = getVegetationRenderState();
          break;
        }
      }
      for (const t of wi.tiles) {
        if (placementChanged)
          setTileGeometry(t, state.placement, wi.imageSize.width, wi.imageSize.height, t.segments ?? 1);
        t.mesh.visible = show;
        t.mesh.renderOrder = item.renderOrder;
        // A Case-1 self-vegetation tile's own ground shadow (see
        // `vegShadows.attachTileShadow`): same placement, same wind motion.
        if (t.shadow) {
          if (placementChanged) {
            // The SAME pad the material was built with — a shadow quad rebuilt
            // without it would silently drop the pad and re-clip every swept
            // shadow at the plant's own edge, which is the bug this padding
            // exists to fix, reintroduced by a refresh.
            setTileGeometry(
              t.shadow.rec,
              state.placement,
              wi.imageSize.width,
              wi.imageSize.height,
              t.segments ?? 1,
              t.shadow.padPx ?? 0
            );
          }
          // UNLIKE the tile itself — which is real placed content and keeps
          // rendering when the effect is off — the shadow is purely this
          // effect's output, so it hides the moment the effect is disabled.
          // Residency owns "on screen AND the effect is on". The per-frame sync
          // ANDs in the third term it cannot know here — "has any strength left
          // to draw with" — because that changes with a slider or the sky, not
          // with placement. Stored so the two halves can be combined without
          // either pass having to recompute the other's.
          t.shadow.residentVisible = show && !!vegState?.enabled;
          t.shadow.mesh.visible = t.shadow.residentVisible;
          // CASE 1: `item` is the canopy tile itself — see
          // VEG_SHADOW_RENDER_ORDER_MAGNITUDE's own header for the sign.
          t.shadow.mesh.renderOrder = item.renderOrder - VEG_SHADOW_RENDER_ORDER_MAGNITUDE;
        }
      }
    }

    // ======================================================================
    // VEGETATION CASE 2 (Vegetation.md) — a plain albedo with a DISCOVERED
    // SIBLING `_Tree`/`_Bush` file (V2's original convention). Unlike Case 1
    // (effects/vegetation-render.js's own header), which swaps the OWNING
    // item's OWN material, this builds a genuinely SEPARATE overlay mesh
    // drawn just above the item's own art — the item's normal albedo
    // rendering is completely untouched. A background painted with BOTH
    // `_Tree` and `_Bush` gets TWO overlays, one per kind (canopy above
    // undergrowth via each kind's own `renderOrderNudge`).
    // ======================================================================

    /**
     * Load ONE image URL as a standalone THREE texture — the compressed-
     * first, raw-fallback dance `ensureWholeImageMeshes` already uses,
     * DELIBERATELY NOT refactored out of that function: touching the
     * device-loss-hardened whole-image loader (the fix for two confirmed,
     * hard-won device-loss incidents) for a second caller's convenience is
     * real risk for a small textual saving. Vegetation sibling masks are
     * companion assets, never a 12000px hero floor, so this deliberately
     * skips `ensureWholeImageMeshes`' own multi-tile SPLIT (`planImageTiles`)
     * — one texture, one tile, always; the risk that split exists to manage
     * does not apply here. Shares the SAME `wholeImageLoadChain` queue (this
     * closure's own serialization gate) so the total number of giant-image
     * operations in flight stays bounded across BOTH systems — a second,
     * unlinked queue would silently reopen the exact risk the shared one
     * exists to close.
     *
     * @param {string} url
     * @returns {Promise<{tex: *, width: number, height: number, compressed: string|null}|null>}
     *   null on total failure — the caller must tolerate this; one broken
     *   sibling mask must never take the owning item's own art down with it.
     */
    async function loadVegetationOverlayTexture(url) {
      const priorLoad = wholeImageLoadChain;
      let releaseLoad;
      wholeImageLoadChain = new Promise((res) => {
        releaseLoad = res;
      });
      const gpuQueue = renderer.backend?.isWebGPUBackend ? renderer.backend.device?.queue : null;
      try {
        await priorLoad;
        await renderer.init();

        try {
          const c = await requestCompressedTexture(url);
          if (c && (c.format === 'bc1' || c.format === 'bc7') && c.levels?.length) {
            const threeFormat = c.format === 'bc7' ? THREE.RGBA_BPTC_Format : THREE.RGBA_S3TC_DXT1_Format;
            const mipmaps = c.levels.map((lvl) => ({ data: lvl.blocks, width: lvl.width, height: lvl.height }));
            const padW = mipmaps[0].width;
            const padH = mipmaps[0].height;
            const tex = new THREE.CompressedTexture(mipmaps, padW, padH, threeFormat);
            tex.flipY = false; // v=0 = image top row — the world-quad convention
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.generateMipmaps = false;
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.anisotropy = ART_TEXTURE_ANISOTROPY; // see the constant's own doc
            tex.needsUpdate = true;
            try {
              renderer.initTexture(tex);
            } catch (_) {
              // Backend not up yet — Three uploads the CompressedTexture lazily on first render.
            }
            return {
              tex,
              width: c.width,
              height: c.height,
              compressed: c.cached ? `${c.format}(cached)` : c.format,
            };
          }
        } catch (err) {
          log.warn(`vegetation overlay: BC1/BC7 path failed for "${url}", using raw:`, err);
        }

        // RAW FALLBACK — same MAX_RAW_FALLBACK_DIM safety cap as the albedo path.
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        const blob = await res.blob();
        const bitmap = await createImageBitmap(blob);
        const rawScale = Math.min(1, MAX_RAW_FALLBACK_DIM / Math.max(bitmap.width, bitmap.height));
        let finalBitmap = bitmap;
        if (rawScale < 1) {
          finalBitmap = await createImageBitmap(blob, 0, 0, bitmap.width, bitmap.height, {
            resizeWidth: Math.max(1, Math.round(bitmap.width * rawScale)),
            resizeHeight: Math.max(1, Math.round(bitmap.height * rawScale)),
            resizeQuality: 'high',
          });
          bitmap.close();
        }
        const tex = new THREE.Texture(finalBitmap);
        tex.flipY = false;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.anisotropy = ART_TEXTURE_ANISOTROPY; // see the constant's own doc
        tex.needsUpdate = true;
        try {
          renderer.initTexture(tex);
          finalBitmap.close();
        } catch (_) {
          // Upload could not be forced — leave the bitmap for Three's own lazy upload.
        }
        if (gpuQueue) {
          try {
            await gpuQueue.onSubmittedWorkDone();
          } catch (_) {
            // A lost/dying device rejects this; the device-lost handler owns recovery.
          }
        }
        return {
          tex,
          width: finalBitmap.width,
          height: finalBitmap.height,
          compressed: rawScale < 1 ? 'raw:capped' : null,
        };
      } catch (err) {
        log.error(`vegetation overlay texture load failed for "${url}":`, err);
        return null;
      } finally {
        releaseLoad();
      }
    }

    /**
     * Build (once per detected kind) this item's Case-2 overlay mesh(es).
     * Idempotent per kind (mirrors `ensureWholeImageMeshes`' own "already
     * built" guard) — safe to call every residency pass; async loads fill in
     * `state.vegetationOverlays[kindId]` as they complete, tolerating this
     * item never having had a placement resolved yet (falls back to {0,0} —
     * `refreshVegetationOverlay`'s own placement-changed geometry rewrite
     * corrects it the moment a real placement exists).
     * @param {object} state @param {object} item
     */
    function ensureVegetationOverlay(state, item) {
      const vegState = getVegetationRenderState();
      if (!vegState.enabled) return;
      const found = vegState.urlByItemId.get(item.id);
      if (!found) return;
      state.vegetationOverlays ??= {};
      for (const kind of VEGETATION_KINDS) {
        const url = found[kind.id];
        if (!url) continue;
        if (state.vegetationOverlays[kind.id]) continue; // already built or building
        const entry = { status: 'loading', mesh: null, material: null, geometry: null, tex: null, shadow: null };
        state.vegetationOverlays[kind.id] = entry;
        loadVegetationOverlayTexture(url)
          .then((loaded) => {
            if (!loaded) {
              entry.status = 'error';
              return;
            }
            // FRESH params (not the ones read above) — params legitimately
            // change while a giant texture is still decoding/uploading.
            const freshParams = getVegetationRenderState().params;
            // TESSELLATED (2026-07-23) — one vertex per ~160 world px so the
            // canopy can sample the wind at many real positions instead of one.
            const segments = vegetationMeshSegments(state.placement?.width ?? 0, state.placement?.height ?? 0);
            const corners = computeQuadCorners(state.placement);

            /** Both meshes share this grid SHAPE; each gets its OWN buffers
             * (a BufferAttribute cannot be shared between two geometries that
             * are updated independently). `padPx` grows the quad outward
             * without moving the art — the shadow's sweep needs somewhere to
             * land (see `vegetationShadowPadPx`). */
            const makeGeometry = (padPx = 0) => {
              const c = padPx > 0 ? computeQuadCorners(padPlacement(state.placement, padPx)) : corners;
              const grid = buildTessellatedQuadGeometry(c, segments);
              const g = new THREE.BufferGeometry();
              g.setAttribute('position', new THREE.BufferAttribute(grid.positions, 3));
              g.setAttribute('uv', new THREE.BufferAttribute(grid.uvs, 2));
              g.setIndex(new THREE.BufferAttribute(grid.indices, 1));
              return g;
            };

            // THE SHADOW, built FIRST so it is added to the scene before the
            // canopy — its renderOrder puts it underneath regardless, but
            // keeping construction order and draw order aligned makes the
            // intent readable.
            const shadowPadPx = vegetationShadowPadPx(kind);
            const shadowBuilt = buildVegetationMaterial(loaded.tex, item, kind, freshParams, {
              asShadow: true,
              shadowPadUv: [
                shadowPadPx / Math.max(1, Math.abs(state.placement?.width ?? 1)),
                shadowPadPx / Math.max(1, Math.abs(state.placement?.height ?? 1)),
              ],
            });
            // The smear LOD's scale factor — see the Case-1 site's own note.
            // `loaded.tex.image` carries the decoded art's true pixel width.
            shadowBuilt.shadow.artTexelsPerWorldPx =
              (loaded.tex?.image?.width ?? 1) / Math.max(1, Math.abs(state.placement?.width ?? 1));
            const shadowGeometry = makeGeometry(shadowPadPx);
            const shadowMesh = new THREE.Mesh(shadowGeometry, shadowBuilt.material);
            shadowMesh.frustumCulled = false;
            shadowMesh.visible = false;
            // ABOVE the owning item's own renderOrder — `item` here IS the
            // ground (a background/tile with a discovered sibling mask), and
            // the shadow must draw AFTER it or the ground's own (typically
            // opaque) art paints straight over the shadow and erases it. See
            // VEG_SHADOW_RENDER_ORDER_MAGNITUDE's own header — this was a
            // real, silent bug (nothing rendered wrong, nothing rendered).
            // Still comfortably BELOW the canopy's own renderOrderNudge.
            shadowMesh.renderOrder = item.renderOrder + VEG_SHADOW_RENDER_ORDER_MAGNITUDE;
            scene.add(shadowMesh);

            const { material, appearance, motion } = buildVegetationMaterial(loaded.tex, item, kind, freshParams);
            const geometry = makeGeometry();
            const mesh = new THREE.Mesh(geometry, material);
            mesh.frustumCulled = false;
            mesh.visible = false; // the refresh loop decides visibility + renderOrder
            mesh.renderOrder = item.renderOrder + kind.renderOrderNudge;
            scene.add(mesh);

            entry.status = 'ready';
            entry.mesh = mesh;
            entry.geometry = geometry;
            entry.material = material;
            entry.appearance = appearance;
            entry.motion = motion;
            entry.segments = segments;
            entry.tex = loaded.tex;
            entry.compressed = loaded.compressed;
            entry.shadow = {
              mesh: shadowMesh,
              geometry: shadowGeometry,
              material: shadowBuilt.material,
              uniforms: shadowBuilt.shadow,
              // Its own independent motion uniform set — see
              // syncVegetationMotionUniforms's own header for why this must
              // be synced separately from the canopy's `entry.motion` above.
              motion: shadowBuilt.motion,
            };
          })
          .catch((err) => {
            entry.status = 'error';
            log.error(`vegetation overlay build failed for item "${item.id}" kind "${kind.id}":`, err);
          });
      }
    }

    // (`syncVegetationShadowUniforms` moved to
    // `effects/vegetation-shadow-subsystem.js` as `vegShadows.syncUniforms` —
    // extraction step 2. It reads the shadow handle through a GETTER there,
    // because `shadowHandle` below is reassigned every time the sky changes.)

    /**
     * Push the CURRENT resolved vegetation params into one mesh's live sway/
     * flutter/clump uniforms — mirrors `vegShadows.syncUniforms`'s own
     * shape exactly (same "take the uniforms object directly" discipline, for
     * the same reason). Called once per mesh per frame for EVERY vegetation
     * mesh that exists (a canopy AND its shadow each carry their own
     * independent motion uniform set — `buildVegetationMaterial` builds
     * `positionNode` unconditionally, not gated by `asShadow` — so both need
     * their own sync call or a live retune would visibly desync a plant from
     * its own shadow). This is what makes every `VEGETATION_PARAMS` motion
     * knob (2026-07-23 follow-up: "frequency, evolution rate, amplitude...
     * the more controls the better") a genuine LIVE control rather than a
     * value only baked in once at mesh construction.
     *
     * Fallbacks below are the SAME "safe if params is momentarily absent"
     * values `buildVegetationMaterial`'s own uniform construction uses — 0
     * for every additive amount/spread (a missing param degrades to "no
     * effect", never a guessed look), 1 for multiplicative gains/curves and
     * `clumpSizePx` (0 there would be a divide-by-zero in the shader, not
     * merely a duller look).
     *
     * @param {object|null} motion - a `buildVegetationMaterial(...).motion` object.
     * @param {object} params - the live resolved vegetation params.
     */
    function syncVegetationMotionUniforms(motion, params) {
      if (!motion) return;
      const p = params ?? {};
      motion.uIntensity.value = p.intensity ?? 1;
      motion.uWindResponse.value = p.windResponse ?? 1;
      motion.uSwayAmount.value = p.swayAmount ?? 0;
      motion.uSwayFrequency.value = p.swayFrequency ?? 1;
      motion.uSwayCurve.value = p.swayCurve ?? 1;
      motion.uGaleBendAmount.value = p.galeBendAmount ?? 0;
      motion.uGaleRateGain.value = p.galeRateGain ?? 0;
      motion.uFlutterAmount.value = p.flutterAmount ?? 0;
      motion.uFlutterFrequency.value = p.flutterFrequency ?? 1;
      motion.uFlutterGaleFrequency.value = p.flutterGaleFrequency ?? 0;
      motion.uFlutterUvScale.value = p.flutterUvScale ?? 0;
      motion.uFlutterScale.value = p.flutterScale ?? 1;
      motion.uClumpSizePx.value = Math.max(1, p.clumpSizePx ?? 150);
      motion.uClumpPhaseSpread.value = p.clumpPhaseSpread ?? 0;
      motion.uClumpAmpSpread.value = p.clumpAmpSpread ?? 0;
      motion.uClumpDirSpreadRad.value = ((p.clumpDirSpread ?? 0) * Math.PI) / 180;
      motion.uEdgeFadeWidthPx.value = Math.max(0, p.edgeFadeWidthPx ?? 0);
    }

    /**
     * Push EVERY loaded vegetation mesh's live motion/shadow uniforms, once
     * per rendered frame — called from `renderFrame`, right alongside
     * `updateCandleFlame()`.
     *
     * WHY THIS EXISTS (2026-07-23, SAME DAY, author-reported): "I tried
     * changing the FOH controls for vegetation and it didn't do anything...
     * Correction. It didn't do anything until I panned the camera." The sync
     * calls used to live inside `refreshWholeImageItem`/`refreshVegetation
     * Overlay` — which sounds like "every frame" from their own (now
     * corrected) comments, but those two functions are ONLY called from
     * `updateResidencyUnguarded`, which itself only runs on a residency pass
     * (pan/zoom/placement change), never from the render loop. Candles never
     * had this gap because `updateCandleFlame()` was already wired into
     * `renderFrame` directly. This function is vegetation's equivalent,
     * iterating the SAME persistent `itemStates` map `updateResidencyUnguarded`
     * populates rather than requiring a residency pass to reach every mesh.
     *
     * Deliberately touches ONLY uniform values — never geometry, visibility or
     * renderOrder, which legitimately still belong on the residency pass
     * (they only need to change when placement or on-screen-ness changes, not
     * every frame).
     */
    function syncAllVegetationMotionForFrame() {
      const vegState = getVegetationRenderState();
      for (const state of itemStates.values()) {
        if (state.wholeImage) {
          for (const t of state.wholeImage.tiles) {
            if (t.motion) syncVegetationMotionUniforms(t.motion, vegState.params);
            if (t.shadow) {
              // A zero-strength shadow is a fully transparent quad padded to
              // ~1.29x the item's area, paying 15 texture fetches per fragment
              // to output nothing. Don't draw it.
              const draws = vegShadows.syncUniforms(t.shadow.uniforms, t.shadow.kind, state.placement, vegState.params);
              t.shadow.mesh.visible = !!t.shadow.residentVisible && draws;
              syncVegetationMotionUniforms(t.shadow.motion, vegState.params);
            }
          }
        }
        if (state.vegetationOverlays) {
          for (const kind of VEGETATION_KINDS) {
            const entry = state.vegetationOverlays[kind.id];
            if (!entry || entry.status !== 'ready') continue;
            syncVegetationMotionUniforms(entry.motion, vegState.params);
            if (entry.shadow) {
              // Same zero-strength skip as Case 1 above.
              const draws = vegShadows.syncUniforms(entry.shadow.uniforms, kind, state.placement, vegState.params);
              entry.shadow.mesh.visible = !!entry.shadow.residentVisible && draws;
              syncVegetationMotionUniforms(entry.shadow.motion, vegState.params);
            }
          }
        }
      }
    }

    /** Per-frame refresh — geometry-on-placement-change + visibility +
     * renderOrder, mirroring `refreshWholeImageItem`'s own shape exactly. A
     * kind still `loading`/`error` is simply skipped (nothing to show yet, or
     * ever, for that one kind — the OTHER kind and the item's own art are
     * unaffected either way).
     *
     * UNLIKE Case 1 (a real tile that keeps its own legitimate content when
     * the effect is disabled — see `ensureWholeImageMeshes`'s own vegetation
     * branch), an overlay has no non-vegetation content of its own: "disabled"
     * MUST mean invisible, not "keeps showing whatever was already built".
     * Re-checked every frame (cheap — one boolean read) rather than only at
     * build time, so toggling the setting OFF hides an ALREADY-BUILT overlay
     * immediately, not just suppresses building new ones. */
    function refreshVegetationOverlay(state, item, show, placementChanged) {
      if (!state.vegetationOverlays) return;
      const vegState = getVegetationRenderState();
      const enabled = vegState.enabled;
      for (const kind of VEGETATION_KINDS) {
        const entry = state.vegetationOverlays[kind.id];
        if (!entry || entry.status !== 'ready') continue;
        if (placementChanged) {
          // Rewrite BOTH meshes' vertex buffers in place — same tessellation,
          // new corners. (BufferAttribute has no dispose(); reusing the array
          // is the rule, not an optimisation — reference_bufferattribute_no_
          // dispose_trap.) A genuine RESIZE that changes the segment count is
          // not hot-patched: `entry.segments` is baked into these buffers'
          // lengths, so the rebuilt grid must match it exactly.
          const grid = buildTessellatedQuadGeometry(computeQuadCorners(state.placement), entry.segments ?? 1);
          for (const g of [entry.geometry, entry.shadow?.geometry]) {
            if (!g) continue;
            const attr = g.getAttribute('position');
            if (attr && attr.array.length === grid.positions.length) {
              attr.array.set(grid.positions);
              attr.needsUpdate = true;
            }
          }
        }
        // NOTE: uniform SYNC (sky + motion) does NOT happen here — this
        // function only runs on a residency pass (pan/zoom/placement change),
        // not every frame, which is exactly why a live slider drag used to
        // look like it "did nothing" until the camera moved (author-reported
        // 2026-07-23). See `syncAllVegetationMotionForFrame`'s own header —
        // it now owns every vegetation uniform push, called every frame from
        // `renderFrame`, mirroring `updateCandleFlame`'s own placement.
        entry.mesh.visible = show && enabled;
        entry.mesh.renderOrder = item.renderOrder + kind.renderOrderNudge;
        if (entry.shadow?.mesh) {
          // Same two-halves split as Case 1 above — see that comment.
          entry.shadow.residentVisible = show && enabled;
          entry.shadow.mesh.visible = entry.shadow.residentVisible;
          // CASE 2: `item` IS the ground — see
          // VEG_SHADOW_RENDER_ORDER_MAGNITUDE's own header for the sign.
          entry.shadow.mesh.renderOrder = item.renderOrder + VEG_SHADOW_RENDER_ORDER_MAGNITUDE;
        }
      }
    }

    let view = null; // set once the first item is loaded
    /** Wall-clock cost of the pre-first-draw shader precompile; null if it failed. */
    let shaderCompileMs = null;
    const frameTimes = [];
    let lastError = null;

    // --- HITCH INSTRUMENTATION (2026-07-16, author-reported: rapid full-range
    // zoom can "temporarily stop" — the fix for the confirmed no-yield-points
    // decode-burst bug didn't fully resolve it, and the author asked for a
    // dedicated stress test to pin down what's ACTUALLY happening instead of
    // guessing further). frameGapTimes is DIFFERENT from frameTimes above —
    // frameTimes only measures renderer.render()'s own synchronous duration;
    // it CANNOT see a stall happening elsewhere (updateContinuousInputs, or
    // an async decode/upload chain's own synchronous stretches between
    // yields) that delays the NEXT animation frame from running at all.
    // frameGapTimes measures the ACTUAL wall-clock time between successive
    // renderFrame invocations — the only signal that reveals a true freeze,
    // since JS is single-threaded and ANY long synchronous stretch anywhere
    // delays every rAF callback equally, wherever that code physically lives.
    const frameGapTimes = [];
    let lastFrameStartMs = null;
    const HITCH_THRESHOLD_MS = 50; // ~3 frames' worth at 60fps — a real, user-perceptible stall, not ordinary jitter
    const HITCH_LOG_MAX = 200; // capped so a long thrash run can't grow this unboundedly
    const hitchLog = []; // {atMs, gapMs, decodeStats, cacheStats} per hitch — full context AT THE MOMENT it happened

    // GPU PROBE (2026-07-20) — the Performance Lab's WHOLE-FRAME measurement
    // engine, gated OFF in normal play. See diag/gpu-probe.js: it times real GPU
    // work via `device.queue.onSubmittedWorkDone()`. The viewer only drives it
    // (beginFrame/endFrame in renderFrame) and reports its stats; the perf lab
    // flips it on for a sweep via setVtPanViewerGpuProbe().
    //
    // ⚠️ 2026-07-27: this comment used to justify the probe as "robust where the
    // earlier three `trackTimestamp` timer reported `supported:false`". That
    // reading was wrong — `trackTimestamp` is a CONSTRUCTOR-ONLY flag defaulting
    // to false (three.webgpu.js:64637) that this file never passed, AND-ed with
    // the feature check at :75258, so it reported false on hardware that supports
    // timestamp queries perfectly well. Per-pass GPU timing lives in
    // diag/gpu-zone-timer.js; this probe remains the coarse whole-frame number
    // and the fallback when timestamps really are unavailable. See
    // diag/gpu-probe.js's header for the full correction.
    const gpuProbe = createGpuProbe();

    // PER-PASS GPU TIMING (docs/planning/Performance.md). Constructed here rather
    // than in boot.js because it needs the `renderer` this closure owns; the
    // profiler it feeds is injected from boot, so ownership of the DATA still
    // sits outside the render loop. `THREE.InspectorBase` is handed in rather
    // than imported so this file keeps its single THREE seam.
    const gpuZoneTimer = profiler
      ? createGpuZoneTimer({ renderer, InspectorBase: THREE.InspectorBase, profiler })
      : null;

    /**
     * ZONE INDICES, RESOLVED ONCE. Every id below is declared in
     * `diag/perf-zones.js` and cross-checked against the live pass graph by its
     * Node suite, so a typo here becomes `-1` — which every begin/end treats as a
     * no-op rather than writing into a neighbouring slot.
     *
     * Integers, not strings, and looked up OUT of the loop on purpose: the hot
     * path must never hash a zone id 50 times a frame. With no profiler (the
     * torture fixture) every entry is -1 and the whole thing is inert.
     */
    const Z = {
      tickInputs: profiler?.indexOf('tick.continuousInputs') ?? -1,
      tickTokens: profiler?.indexOf('tick.tokenSync') ?? -1,
      tickDoors: profiler?.indexOf('tick.doorSync') ?? -1,
      tickEnv: profiler?.indexOf('tick.envSnapshot') ?? -1,
      tickWindPoll: profiler?.indexOf('tick.windRebakePoll') ?? -1,
      tickCamera: profiler?.indexOf('tick.camera') ?? -1,
      simsWind: profiler?.indexOf('sims.wind') ?? -1,
      simsFluid: profiler?.indexOf('sims.fluid') ?? -1,
      simsDust: profiler?.indexOf('sims.particlesDust') ?? -1,
      simsGusts: profiler?.indexOf('sims.particlesGusts') ?? -1,
      masksSync: profiler?.indexOf('masks.occlusionSync') ?? -1,
      masksDraw: profiler?.indexOf('masks.occlusionDraw') ?? -1,
      geomWorld: profiler?.indexOf('geometry.worldDraw') ?? -1,
      geomDoors: profiler?.indexOf('geometry.doorDraw') ?? -1,
      lightAmbient: profiler?.indexOf('light.ambient') ?? -1,
      lightSunBake: profiler?.indexOf('light.sunShadowBake') ?? -1,
      lightWaterBake: profiler?.indexOf('light.waterBodyBake') ?? -1,
      lightWaterSync: profiler?.indexOf('light.waterSurfaceSync') ?? -1,
      lightFluidSync: profiler?.indexOf('light.fluidSurfaceSync') ?? -1,
      lightRegions: profiler?.indexOf('light.regionSetup') ?? -1,
      lightPointUpdate: profiler?.indexOf('light.pointLightUpdate') ?? -1,
      lightCandleSync: profiler?.indexOf('light.candleSync') ?? -1,
      lightVegSync: profiler?.indexOf('light.vegetationSync') ?? -1,
      lightWindOverlaySync: profiler?.indexOf('light.windOverlaySync') ?? -1,
      lightUiShadow: profiler?.indexOf('light.uiShadowStamps') ?? -1,
      lightDrawIllum: profiler?.indexOf('light.drawIllum') ?? -1,
      lightDrawRegions: profiler?.indexOf('light.drawRegions') ?? -1,
      lightDrawPoints: profiler?.indexOf('light.drawPointLights') ?? -1,
      lightDrawWindow: profiler?.indexOf('light.drawWindowLight') ?? -1,
      lightDrawColoration: profiler?.indexOf('light.drawColoration') ?? -1,
      lightDrawComposite: profiler?.indexOf('light.drawComposite') ?? -1,
      lightDrawCandle: profiler?.indexOf('light.drawCandleFlame') ?? -1,
      lightDrawWindOverlay: profiler?.indexOf('light.drawWindOverlay') ?? -1,
      surfSpecular: profiler?.indexOf('surface.specularDraw') ?? -1,
      surfDust: profiler?.indexOf('surface.drawDust') ?? -1,
      surfGusts: profiler?.indexOf('surface.drawGusts') ?? -1,
      bloomUniforms: profiler?.indexOf('bloom.uniformPush') ?? -1,
      bloomBright: profiler?.indexOf('bloom.bright') ?? -1,
      bloomDown: profiler?.indexOf('bloom.downsample') ?? -1,
      bloomUpCore: profiler?.indexOf('bloom.upsampleCore') ?? -1,
      bloomUpAtmo: profiler?.indexOf('bloom.upsampleAtmo') ?? -1,
      bloomComposite: profiler?.indexOf('bloom.composite') ?? -1,
      presentBlit: profiler?.indexOf('present.blit') ?? -1,
    };

    function renderFrame(nowMs) {
      // GPU PROBE THROTTLE (2026-07-21) — while a sample is awaiting GPU
      // completion, submit NOTHING new this tick: no camera update, no pass
      // plan, no present. This is what makes the probe measure ONE frame's
      // true GPU execution time instead of pipeline queue depth (see
      // diag/gpu-probe.js's isMeasuring() doc) — the render loop would
      // otherwise keep submitting new frames every ~8ms regardless of the
      // probe's state, so by the time one onSubmittedWorkDone() resolved it
      // had waited through several OTHER frames' pipelined work too. First
      // live evidence: a reading of "41.9ms GPU cost" alongside an unbroken
      // 8.4ms felt cadence — physically impossible for one frame's real
      // execution time, only possible for queue depth. Skipped ticks record
      // no hitch/gap either (see resetFrameStats, called before each sweep
      // config's felt phase specifically to keep this throttling from
      // smearing into felt readings).
      if (gpuProbe.isActive() && gpuProbe.isMeasuring()) return;
      const now = nowMs ?? performance.now();

      // HITCH DETECTION — see this file's own header note on frameGapTimes
      // for why this is a DIFFERENT (and more revealing) measurement than
      // frameTimes below. Recorded FIRST, before any other work this frame,
      // so it reflects the true gap since the PREVIOUS frame actually ran.
      if (lastFrameStartMs !== null) {
        const gapMs = now - lastFrameStartMs;
        frameGapTimes.push(gapMs);
        if (frameGapTimes.length > 300) frameGapTimes.shift();
        if (gapMs > HITCH_THRESHOLD_MS) {
          hitchLog.push({
            atMs: Math.round(now),
            gapMs: Math.round(gapMs * 10) / 10,
            halfSpanPx: view?.halfSpanPx ?? null,
            decodeStats: getDecodeStats(),
            cacheStats: cache.stats(),
          });
          if (hitchLog.length > HITCH_LOG_MAX) hitchLog.shift();
        }
      }
      lastFrameStartMs = now;

      // Continuous-input easing (held-key pan, eased zoom) runs BEFORE the
      // timed render() call below, so its (small) CPU cost is never folded
      // into renderMsAvgLast120 — that diagnostic stays a clean measurement
      // of pure GPU-render cost, exactly as it was before this existed
      // (needed as-is for the Stage 1 gate's "60fps" evidence).
      profiler?.begin(Z.tickInputs);
      updateContinuousInputs(now);
      profiler?.end(Z.tickInputs);
      // Also a small, per-frame CPU-only cost — kept OUT of the `t0` GPU-render
      // timing window below for the same reason updateContinuousInputs is, per
      // the comment above it. See syncTokenPlacements' own header for why this
      // runs every frame rather than only on a document hook.
      profiler?.begin(Z.tickTokens);
      syncTokenPlacements();
      profiler?.end(Z.tickTokens);
      // Reconcile + animate the door leaves BEFORE the pass plan, so their fresh
      // geometry is on the GPU when runGeometryWorldPass draws doorScene into the
      // lit target. Same CPU-only, kept-out-of-t0 posture as syncTokenPlacements.
      profiler?.begin(Z.tickDoors);
      syncDoorGraphics(now);
      profiler?.end(Z.tickDoors);
      // frame.snapshot's res:env third — see its own header above. Also a
      // small per-frame CPU-only cost, kept OUT of the t0 GPU-render window
      // for the same reason as updateContinuousInputs/syncTokenPlacements.
      // Idempotent, so calling it per frame is free — and it means the pause
      // watch installs itself the moment a real `game` exists, without needing
      // a lifecycle hook of its own or a guess about boot ordering.
      installPauseWatch();
      profiler?.begin(Z.tickEnv);
      updateEnvSnapshot();
      profiler?.end(Z.tickEnv);
      const t0 = performance.now();
      // GPU probe (perf lab only; inert otherwise) — mark the render start so
      // endFrame below can time to GPU completion. See diag/gpu-probe.js.
      gpuProbe.beginFrame();
      // The profiler's frame opens here, inside the same bracket as the GPU
      // probe, so the two instruments describe the SAME span of work rather than
      // two subtly different ones. Fed the rAF timestamp already in hand — no new
      // clock read (`time/one-clock` forbids one in this file anyway).
      profiler?.beginFrame(now);
      // The mask-driven rebake check (see pollMaskAuthorityForWindRebake's own
      // header) — BEFORE tickWindSim, so a mask-triggered rebake this frame is
      // reflected in this SAME frame's wind sim/sampling, not one frame late.
      // WALL time, deliberately (2026-07-23). This is a THROTTLE on a
      // housekeeping poll ("check the mask version at most every N ms"), not a
      // simulation step — and `tMs` now stops dead while Foundry is paused. Fed
      // sim time, the throttle would never elapse again during a pause, so a
      // mask edit made while paused would not trigger its rebake until someone
      // un-paused. The rest of this frame block genuinely wants sim time and
      // keeps it; this one line is the deliberate opt-out.
      profiler?.begin(Z.tickWindPoll);
      pollMaskAuthorityForWindRebake(lastEnvSnapshot?.env?.time?.realMs ?? 0);
      profiler?.end(Z.tickWindPoll);
      // Wind.md Tier 2 — INSIDE the gpuProbe bracket (not before it) so its
      // own render passes are actually visible to the perf lab's sweep, per
      // Wind.md §9's "measured before defaulting on". Before updateCamera/
      // runPassPlan so windLiveField's published texture is fresh BEFORE
      // anything downstream (candle flame, lights, the debug overlay)
      // samples it this frame.
      profiler?.begin(Z.simsWind);
      tickWindSim(lastEnvSnapshot?.env?.time?.tMs ?? uGlobalTimeMs.value, lastEnvSnapshot?.env?.time?.dtSec ?? 0);
      profiler?.end(Z.simsWind);
      // FLUID's own sim tick — same clock, same "inside the gpuProbe bracket"
      // reasoning as tickWindSim above, and it must run AFTER this frame's own
      // fluidSurface.sync() call (earlier in this same function, beside
      // waterSurface.sync) so a mask-triggered rebake this frame already has
      // its sim resources built by the time this looks for them.
      profiler?.begin(Z.simsFluid);
      tickFluidSim(lastEnvSnapshot?.env?.time?.tMs ?? uGlobalTimeMs.value, lastEnvSnapshot?.env?.time?.dtSec ?? 0);
      profiler?.end(Z.simsFluid);
      // sims.particles — advance the GPU particle sim right after the wind field
      // it samples, before the draw (surface.particles, in the plan below) reads
      // its positions. A DIRECT renderer.compute(): the sims stage is out of
      // framePlan's range, exactly like tickWindSim above. World rect = the live
      // view, so motes wrap inside what's on screen and stay present as you pan
      // — CLAMPED to the scene's own `sceneRect` (2026-07-23, author: "We
      // shouldn't spawn particles outside of the scene"). Unclamped, a mote
      // respawning "anywhere in the current view" (this function's own prior
      // comment) meant panning/zooming out past the map's edge — into the
      // padded margin, or further — happily reseeded motes out there too,
      // since `viewToWorldRect` itself is deliberately NOT clamped to world
      // bounds (that function's own doc: page-residency math needs the raw
      // rect). `clampRectToBounds` (view-state.js) intersects it against
      // `dimensions.sceneRect` — the SAME real-scene bounds `bakeWindField`
      // now computes openness within, so a mote can never exist somewhere
      // wind was never even calculated for. Computed ONCE and shared by both
      // engines below — identical expression, one clamp, not two.
      const windSpawnRect = clampRectToBounds(viewToWorldRect(view, canvasW / canvasH), dimensions.sceneRect);
      if (windParticlesEnabled && view && particleEngine) {
        profiler?.begin(Z.simsDust);
        particleEngine.step(renderer, {
          dtSec: lastEnvSnapshot?.env?.time?.dtSec ?? 0,
          tMs: lastEnvSnapshot?.env?.time?.tMs ?? uGlobalTimeMs.value,
          worldRect: windSpawnRect,
        });
        profiler?.end(Z.simsDust);
      }
      // sims.particles — the gust ribbons ride the same wind field; step them in
      // the same spot, right after the wind sim and before their draw.
      if (windGustsEnabled && view && gustEngine) {
        profiler?.begin(Z.simsGusts);
        gustEngine.step(renderer, {
          dtSec: lastEnvSnapshot?.env?.time?.dtSec ?? 0,
          tMs: lastEnvSnapshot?.env?.time?.tMs ?? uGlobalTimeMs.value,
          worldRect: windSpawnRect,
        });
        profiler?.end(Z.simsGusts);
      }
      // Re-derive the camera from the live view EVERY frame: this is what makes
      // a drag track the cursor at display rate without waiting on streaming,
      // and it is the single place the Y-flip is applied (see updateCamera).
      profiler?.begin(Z.tickCamera);
      updateCamera();
      profiler?.end(Z.tickCamera);

      // TWO PASSES, FOR REAL (2026-07-17), NOW GRAPH-DRIVEN (2026-07-18).
      // `graph/passes.js` has always declared these as separate nodes —
      // `geometry.world` creates buf:scene.color, `present.composite` reads
      // it — and since 2026-07-17 they really are two separate
      // `renderer.render()` calls against two targets. Until now THIS
      // function still hardcoded their order; now it asks `framePlan`
      // (computed once above, from the real `PASSES`) which passes are live
      // in this stage range and runs exactly those, via `passImpls`. Same two
      // GPU calls, same order, same targets — now looked up instead of
      // written inline, so the next pass to go live here (masks.occlusion —
      // see the infrastructure menu in Keyhole.md) plugs into `passImpls`
      // without this function's control flow changing again.
      //
      // The gap between geometry.world and present.composite is where every
      // effect goes. Nine seams in passes.js declare `modifies:
      // ['buf:scene.color']` — that buffer is a real thing they could modify.
      // `profiler.passHooks` is ONE object built once at profiler construction,
      // not a closure pair allocated here per frame — see frame-profiler.js. It
      // yields a `pass.<id>` zone for every live pass, so a pass going live later
      // is instrumented for free and no second copy of the frame order exists.
      lastFramePlanRan = runPassPlan(framePlan.ids, passImpls, {}, profiler?.passHooks);

      frameTimes.push(performance.now() - t0);
      if (frameTimes.length > 120) frameTimes.shift();
      // Closes the profiler's frame AFTER the pass plan, so a frame's zones are
      // complete before it is counted. Called with no argument on purpose: the
      // profiler reads its own clock in diag/, where `time/one-clock` permits it.
      profiler?.endFrame();
      // EVERY FRAME WHILE ARMED, not occasionally: `resolveQueriesAsync` is what
      // resets three's query index, and the pool holds only 1024 passes (~40
      // frames at this pass count). Skip it and measurement stops silently while
      // rendering carries on. Fire-and-forget — awaiting here would serialise
      // CPU and GPU and reproduce the exact "queue depth, not cost" mistake
      // documented at the top of this function.
      gpuZoneTimer?.collect();

      // GPU probe (perf lab only; inert otherwise) — the frame's passes are now
      // submitted, so await GPU completion to time the real work. See diag/gpu-probe.js.
      gpuProbe.endFrame(renderer.backend?.device?.queue);
    }

    /**
     * Decode + upload a set of pages (at each page's OWN mip) and pin them with
     * `pinClass`. Shared by the coarse-pin load and the per-view residency
     * update so there is exactly ONE decode/upload path.
     *
     * TWO PASSES ON PURPOSE (confirmed live 2026-07-15 — the actual cause of
     * "no texture bound to target" on every pan/zoom): the render loop runs
     * CONTINUOUSLY, so a render() can land between two separate upload calls
     * and desync THREE's texture-unit binding cache. Pass 1 does all the
     * (async, GL-free) decoding — safe to interleave. Pass 2 uploads
     * everything already-decoded in one tight SYNCHRONOUS loop (no `await`
     * between GL calls), with the loop paused and atlas.prepareForUploadBatch()
     * resetting the stale binding cache first (see atlas.js for the full root cause).
     */
    async function requestDecodeUpload(pack, pages, pinClass) {
      // Pass 1: reserve cache slots (pin) and collect the pages that actually
      // need decoding (not already resident). cache.request is sync + GL-free.
      const toDecode = []; // { page, slot }
      for (const page of pages) {
        const alreadyInCache = cache.isResident(page.key);
        const { resident, slot } = cache.request(page.key, { pin: pinClass });
        // A miss here for pinClass:'view' is ordinary pressure — the coarse
        // fallback covers it, never a crash. A miss for pinClass:'coarse'
        // (item 1b) is DIFFERENT: there is no fallback BELOW the coarse pin
        // itself — it IS the fallback. `cache.coarseReservePages` (page-
        // cache.js) exists specifically to make this branch structurally
        // unreachable for 'coarse'; `cacheStats.coarseReserveMisses` in
        // diagnostics is the tripwire if that guarantee is ever wrong.
        if (!resident) continue;
        if (!alreadyInCache) toDecode.push({ page, slot });
      }
      if (toDecode.length === 0) return;

      // Pass 2: acquire the decoded page bitmaps — IndexedDB-first, else a
      // bounded slice from the (briefly-held, immediately-released) full source.
      // This is the decode-memory fix: no per-pack 576 MB bitmap is ever held.
      let decodedForUpload = [];
      try {
        const slotByKey = new Map(toDecode.map((t) => [t.page.key, t.slot]));
        const requestedPages = toDecode.map((t) => t.page);
        // CHANNEL-PACKING branch: a 'packed' pack composites 3 single-channel
        // sources into one RGBA page (acquirePackedPages); everything else
        // (albedo, unpackable masks) takes the original single-source path.
        // Both return the identical {page, bitmap} shape — the atlas upload
        // below doesn't know or care which path produced a page.
        const acquired =
          pack.source.kind === 'packed'
            ? await acquirePackedPages(pack.source.packId, pack.source.channelUrls, pack.table, requestedPages, {})
            : await acquirePages(pack.source.url, pack.table, requestedPages, {});
        decodedForUpload = acquired
          .map((a) => ({ slot: slotByKey.get(a.page.key), decoded: a.bitmap }))
          .filter((x) => x.slot !== undefined);

        // THE INGEST SEAM (see startVtPanViewer's onPageDecoded doc): offer
        // each COARSEST-mip page — one page, the whole item — to the injected
        // consumer while its bitmap is still alive (Pass 3 closes them).
        // Fine-mip pages never reach the callback, so the pan/zoom hot path
        // pays one integer compare per decoded page and nothing else. Own
        // guard, deliberately NOT the enclosing catch: a consumer bug must
        // read as "ingest failed", never as "decode failed" (which would
        // poison lastError and look like a streaming defect).
        for (const a of acquired) {
          if (a.page.mip !== pack.table.maxMip) continue;
          try {
            const rect = pageWorldRect(pack.table, a.page.mip, a.page.px, a.page.py, {});
            onPageDecoded({
              ownerId: pack.ownerId,
              layerName: pack.name,
              table: pack.table,
              page: a.page,
              // bitmap.width IS this page's pageSizePx (the acquire calls above
              // use the same default) — deriving it from the bitmap itself
              // means the two can never drift.
              contentWindow: computePagePlacement(rect, rect.unclamped, a.bitmap.width),
              bitmap: a.bitmap,
            });
          } catch (err) {
            onPageDecodedFailures++;
            if (onPageDecodedFailures <= 3) {
              ingestLog.error(
                `onPageDecoded consumer threw for ${pack.ownerId}/${pack.name} (failure ${onPageDecodedFailures}):`,
                err
              );
            }
          }
        }
      } catch (err) {
        lastError = `decode failed for pack "${pack.name}": ${err?.message || err}`;
        console.error('[vt-pan-viewer]', lastError);
        return;
      }

      // Pass 3 (was: chunked GPU atlas upload — removed 2026-07-22 along with
      // the streaming/virtual-texture engine, see
      // feedback_mode_forks_silently_drop_features). Masks are the only thing
      // that still calls this function, and they are consumed purely
      // CPU-side via the onPageDecoded ingest seam above (Pass 2, already
      // fired, bitmap already read) — nothing ever samples a pack's
      // indirection/atlas texture in a shader any more
      // (`ensureWholeImageMeshes`/`buildWholeImageMaterial` only ever bind an
      // item's OWN whole texture). Just release the decoded bitmaps so they
      // don't leak.
      for (const { decoded } of decodedForUpload) decoded.close?.();
    }

    // Which layer-pack is DISPLAYED (albedo by default). Every pack STREAMS
    // regardless — this only changes which one is bound to the shader, so a mask
    // can be eyeballed against the fixture's known patterns for correctness.
    let displayLayerName = 'albedo';

    /**
     * ISOLATE ONE DRAW ITEM — `''` shows the whole draw list (normal).
     *
     * WHY THIS EXISTS (2026-07-17): the ghost artefact has now had FIVE
     * diagnoses from me. Every one found a real bug — an impossible one I had
     * recorded in the plan doc, a genuine release/await race, a scene-wide
     * coarse-pin starvation, a six-caller pin leak, a fallback-vs-non-fallback
     * mip blend — and none of them was the ghost. Each cost the author a
     * round-trip to disprove.
     *
     * The asymmetry is the point: the author can SEE the artefact and I cannot.
     * Reasoning from aggregate counters about a visual bug is what produced
     * five plausible-and-wrong answers. This turns "which of the 11 items is
     * the ghost?" into eleven clicks the author can do in half a minute, and
     * the answer is a FACT rather than my sixth theory.
     *
     * Deliberately gates VISIBILITY only, at the very end of the pass —
     * residency, streaming and placement all run exactly as normal, so
     * isolating cannot itself change what the pager does and mask the bug.
     */
    let isolateItemId = '';

    let lastItems = []; // exposed in diagnostics — the current sorted draw list
    // How many packs had their speculative tier declined this update (see
    // PREFETCH_MIN_HEADROOM_FRACTION). Persistently non-zero means the scene's
    // REQUIRED working set is close to the cache budget — the honest signal that
    // the cache is genuinely full, as opposed to full of speculation.
    let prefetchSkippedPacks = 0;

    /**
     * THE FRAME'S WORK: resolve the draw list, stream what it needs, order it.
     *
     * Item-based, not floor-based. A floor's background, its foreground (roof)
     * art and every tile on it are peers here — each with its own virtual
     * texture and its own world quad — which is precisely what lets a roof sit
     * ABOVE the tokens on its floor and BELOW the floor above it. A per-floor
     * model has nowhere to put that.
     */
    /**
     * Adopt Foundry's camera. Foundry's stage is the ONE source of truth for the
     * view — MSA does not have a camera on a real scene, it reads this one
     * (keyhole-input-model-decision).
     *
     * Read from the v14 source rather than assumed (board.mjs:1703-1715):
     *   this.stage.pivot.set(constrained.x, constrained.y);   // world CENTRE
     *   this.stage.scale.set(constrained.scale, constrained.scale);  // uniform
     *   Hooks.callAll("canvasPan", this, constrained);
     *
     * `scale` is screen-px per world-px, so half the viewport in WORLD px is
     * (viewportPx / 2) / scale. The axis matters and cost a live round-trip:
     * **halfSpanPx is the half-VERTICAL span**, not the horizontal one --
     * viewToWorldRect derives `halfX = halfSpanPx * aspect` from it and says so in
     * its own doc, which I did not read. Computing it from canvasW over-spanned by
     * the aspect ratio (2239/1271 ≈ 1.76x), so MSA rendered ~1.76x more zoomed out
     * than Foundry believed. Everything downstream inherited that: a token dropped
     * at the top-right landed short and toward the centre, because Foundry mapped
     * the click with ITS scale and MSA drew the result with a wider view. Foundry's
     * hit boxes were right the whole time; the picture the author was aiming at was
     * the thing that lied.
     *
     * @returns {boolean} did the view actually change?
     */
    /**
     * The view as of the last residency update — the baseline the sub-pixel
     * threshold below measures against, so a slow drift cannot creep past it
     * one under-threshold step at a time. See syncFoundryCamera.
     * @type {{cx:number, cy:number, halfSpan:number}|null}
     */
    let lastResidencyView = null;

    function syncFoundryCamera() {
      const stage = globalThis.canvas?.stage;
      if (!stage) return false;
      const scale = stage.scale?.x;
      // Guard the degenerate cases explicitly: a zero/NaN scale would make
      // halfSpanPx Infinity/NaN and silently take the whole view with it.
      if (!Number.isFinite(scale) || scale <= 0) return false;
      const cx = stage.pivot?.x;
      const cy = stage.pivot?.y;
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) return false;

      const halfSpan = canvasH / 2 / scale; // VERTICAL — see above; canvasW here was the bug

      // THE CAMERA ALWAYS TRACKS EXACTLY. Never debounce this half: a camera
      // that lags is a camera that disagrees, which is the whole reason this
      // reads canvas.stage per frame in the first place.
      view.centerXPx = cx;
      view.centerYPx = cy;
      view.halfSpanPx = halfSpan;

      // RESIDENCY IS A DIFFERENT QUESTION, AND IT USED TO BE ASKED WITH `!==`.
      //
      // Exact float equality against FOUNDRY'S OWN EASED camera: it asymptotes
      // toward its target, so for seconds after the user stops it is still
      // moving by thousandths of a pixel — and every one of those reported
      // `changed`, which scheduled a FULL residency pass (11 packs replanned,
      // released, re-requested). Caught in the author's own report, 2026-07-17,
      // on a view they had stopped touching: panVelocity {0,0}, halfSpanPx
      // IDENTICAL across five consecutive hitches, and yet 236 passes with
      // `misses` climbing 662 -> 1908 and `evictions` 4448 -> 5897 across half
      // a pixel of residual zoom. With the cache at its cap that is ~25
      // evictions per pass, forever, for a view that is not moving.
      //
      // The threshold is ONE SCREEN PIXEL of world distance, which is the
      // honest bound: a camera move too small to change any rendered pixel
      // cannot change which pages are needed, so a pass over it is pure churn.
      // Measured against the view at the LAST RESIDENCY UPDATE, not the last
      // frame — comparing to the last frame would let a slow drift accumulate
      // forever, each step under the bar, and never re-stream at all.
      const worldPerScreenPx = (2 * halfSpan) / Math.max(1, canvasH);
      if (!lastResidencyView) {
        lastResidencyView = { cx, cy, halfSpan };
        return true;
      }
      const changed =
        Math.abs(lastResidencyView.cx - cx) >= worldPerScreenPx ||
        Math.abs(lastResidencyView.cy - cy) >= worldPerScreenPx ||
        Math.abs(lastResidencyView.halfSpan - halfSpan) >= worldPerScreenPx;
      if (changed) lastResidencyView = { cx, cy, halfSpan };
      // NOTE there is deliberately no eased-target assignment here. `view` has no
      // targetHalfSpanPx — the eased target is a CLOSURE variable of that name
      // (see renderFrame), and setting the field on `view` created a property
      // nothing reads while the real target sat untouched at its load-time value.
      // The whole easing path is skipped when following Foundry anyway: Foundry
      // has already eased this pan, and easing an eased value lags the real
      // camera. A camera that lags is a camera that disagrees.
      return changed;
    }

    /**
     * ONE RESIDENCY PASS. **Never call this directly — call
     * `scheduleResidencyUpdate()`.** It is named `unguarded` so a direct call
     * reads as the mistake it is (`zones/one-door`'s logic, at function scope:
     * if the safe path is not the obvious one, the unsafe one gets used).
     *
     * THE PIN LEAK THIS ISOLATION FIXES (found 2026-07-17 in the author's own
     * thrash report, not by reasoning): SIX call sites invoked this directly,
     * bypassing `scheduleResidencyUpdate`'s in-flight guard — `setFloorIndex`,
     * `applyKeyAndUpdate`, `setDisplayLayer`, resize, the initial load. The
     * thrash test does BOTH at once: eased zoom schedules a guarded pass every
     * frame while `setFloorIndex` fires an unguarded one. Two concurrent runs.
     *
     * This function mutates shared per-pack state ACROSS AWAITS, so two runs
     * interleave on `pack.residentViewKeys`:
     *
     *   run A: unpin (keys not in A's candidates) -> await -> residentViewKeys = A's set
     *   run B: unpin (keys not in B's candidates) -> await -> residentViewKeys = B's set
     *
     * Whichever assigns last WINS, and every page the loser pinned is now
     * ORPHANED: still pinned, tracked by nobody, so no future pass can ever
     * unpin it. The view tier fills with pins for pages nothing is looking at.
     *
     * THE DATA THAT PROVED IT, from the author's report — `pinnedView` against
     * `halfSpanPx` in the hitch log:
     *   halfSpan 6705 (fully zoomed OUT) -> pinnedView 1536  <- the exact cap
     *   halfSpan   86 (fully zoomed IN)  -> pinnedView 1097
     * At full zoom-out the coarse pins cover the world and the view tier should
     * be near EMPTY. 1536 is not pressure; it is leakage. Those orphans then
     * jam the cache (`misses: 1062`) so real requests get refused — which is
     * blur at best, and starves everything else at worst.
     */
    async function updateResidencyUnguarded() {
      // Refreshed every pass, not cached — the scene's total pack count
      // changes as documents are created/deleted, and a NEW item created since
      // the last pass must see the CURRENT count when it first requests its
      // coarse pin a few lines below (item 1b). See refreshCoarsePinBudget's
      // own header for why staleness here is the exact bug class this exists
      // to prevent.
      refreshCoarsePinBudget();
      // ⚠️ COVER ALPHA IS PRIMED FOR EVERY FLOOR, NOT THE DRAW LIST (2026-07-26).
      // The draw list is filtered by what the viewed floor can SEE; cover
      // physics must not be. Before this, an upper floor's background art was
      // only ever decoded if that floor happened to be visible, so on the
      // author's bridge map the entire deck cast nothing while the crates
      // sitting on it cast fine — tiles default to an EMPTY levels set, which
      // means "present on every floor", so they were always drawn and always
      // had alpha. `alphaRequested` dedupes, so this is one decode per item per
      // session no matter how often residency runs.
      primeCoverAlphaGrids();
      // sortByLayer stamps `renderOrder` on each item — THE law
      // (scene/layer-order.js). Rebuilt every update because the draw list
      // itself changes with the viewed floor.
      const items = sortByLayer(buildItems(view.floorIndex));
      const wantedIds = new Set(items.map((i) => i.id));
      prefetchSkippedPacks = 0;
      lastUpdate.placementChanges = 0;
      lastUpdate.itemCount = items.length;
      passSeq++;
      const thisPass = passSeq;

      // Items that dropped OUT of the draw list: release their VIEW pages (never
      // their coarse pins — those stay resident always, §4.1/§4.5) and hide the
      // mesh. Unpin never evicts directly — PageCache's LRU decides that under
      // real pressure — so a quick switch-and-back is free.
      for (const [id, state] of itemStates) {
        if (wantedIds.has(id)) continue;
        for (const pack of state.packs.values()) {
          for (const key of pack.residentViewKeys) cache.unpin(key);
          pack.residentViewKeys = new Set();
        }
        if (state.mesh) state.mesh.visible = false;
        // WHOLE-IMAGE items draw through state.wholeImage.tiles[].mesh, NOT
        // state.mesh — so hiding state.mesh above does nothing for them. Without
        // this, an item that LEAVES the draw list on a floor switch (e.g. the
        // upper floor's roof/overhead when you drop to the ground floor, which
        // Foundry's cross-floor rule excludes from the ground's draw list) kept
        // its meshes visible: the ceiling of the floor above hung over the floor
        // below, and never cleared. Latent since the whole-image path landed —
        // only observable now that the floor switch stopped losing the device
        // first. (memory: y_flip-class "verify at every NEW seam" — visibility is
        // that seam here.)
        if (state.wholeImage) {
          for (const t of state.wholeImage.tiles) {
            if (t.mesh) t.mesh.visible = false;
          }
        }
      }

      const worldRect = viewToWorldRect(view, canvasW / canvasH);

      // PHASE 1 — lock in EVERY item's COARSE pins before ANY item's view-tier
      // streaming (real live bug, 2026-07-16: whole-screen MAGENTA under the
      // castle-courtyard test). PageCache protects 'coarse' and 'view' pins
      // identically, so an earlier item's large view-tier request could saturate
      // the cache before a later item's small coarse-pin request even ran — and a
      // coarse-pin request that finds nothing evictable simply FAILS, for pages
      // whose entire job is to GUARANTEE something is always resident. Front-
      // loading every coarse pin makes that structurally impossible.
      const states = [];
      for (const item of items) {
        // A PERMANENTLY-BROKEN ITEM IS NOT RETRIED (item 1d, 2026-07-17). Found
        // in the author's own thrash report: ten identical `HTTP 404` entries
        // for one token image, and `mainThreadFallbackSourceDecodes: 12`.
        // `ensureItemLoaded` throws for a broken source, so `itemStates` never
        // gets an entry, so it was re-attempted on EVERY residency pass —
        // seventy-seven of them in that session — each paying a ranged fetch, a
        // worker dimensions round-trip, AND a main-thread fallback decode
        // attempt (the last of which is the operation this file elsewhere calls
        // "a giant-image decode the render loop could feel"). `itemLoadErrors`
        // deduped the REPORT; nothing deduped the WORK, so the report looked
        // tidy while the cost repeated forever.
        //
        // The trade, stated because it IS a real one: a source that starts
        // working later (a server hiccup, an asset uploaded mid-session) now
        // needs a reload rather than fixing itself on the next pass. That is
        // the right way round — an asset that 404s is overwhelmingly gone, not
        // late, and paying an unbounded per-frame cost forever on the chance it
        // returns is exactly the "reactive mechanism" shape Keyhole exists to
        // delete. The failure stays LOUD either way: it is in `layerLoadErrors`
        // in every report, permanently, not silently skipped.
        if (failedItemIds.has(item.id)) continue;
        try {
          states.push([item, await ensureItemLoaded(item)]);
        } catch (err) {
          // One broken item (404 art, undecodable file) must not take the scene
          // down. Recorded rather than thrown — the debug panel surfaces this,
          // since the author debugs by pasting reports, not reading the console.
          const message = String(err?.message || err);
          failedItemIds.add(item.id);
          if (!itemLoadErrors.some((e) => e.id === item.id)) {
            itemLoadErrors.push({ id: item.id, src: item.src, error: message });
            console.error(`[vt-pan-viewer] item "${item.id}" failed to load (${item.src}):`, err);
          }
        }
      }

      // PHASE 2 — view-tier streaming + mesh update, now that every coarse pin
      // is locked in and can't be starved.
      for (const [item, state] of states) {
        // Counted, not just done. A document-driven refresh that runs and moves
        // NOTHING is indistinguishable from a hook that never fired — and those
        // two need opposite fixes. See `lastUpdate`'s declaration.
        const changed = refreshItemPlacement(state, item);
        if (changed) {
          lastUpdate.placementChanges++;
          lastUpdate.placementChangesTotal++;
        }
        if (item.kind === 'token') {
          tokenPassLog.push({
            pass: thisPass,
            id: item.id,
            x: state.placement.x,
            y: state.placement.y,
            changed,
          });
          if (tokenPassLog.length > TOKEN_PASS_LOG_MAX) tokenPassLog.shift();
        }
        const onScreen = rectsOverlap(state.worldBounds, worldRect);
        const show = onScreen && (isolateItemId === '' || item.id === isolateItemId);

        // Load the art whole and draw it — no page streaming, no atlas upload
        // churn (the fix for the WebGPU device loss). Masks still page through
        // `state.packs`/the shared cache for their own coarse-pin decode
        // (loadExtraLayerPacks), independent of this draw step.
        ensureWholeImageMeshes(state, item);
        refreshWholeImageItem(state, item, show, changed);
        // VEGETATION CASE 2 — a separate overlay, alongside whatever the item's
        // own art just did above. Cheap no-op for the overwhelming majority of
        // items (a Map lookup that finds nothing — see ensureVegetationOverlay's
        // own header) so this costs nothing on a scene with no sibling masks.
        ensureVegetationOverlay(state, item);
        refreshVegetationOverlay(state, item, show, changed);
      }

      lastItems = items;
    }

    /**
     * Swap the DISPLAYED layer-pack (e.g. 'albedo' → 'Outdoors') — visual
     * verification that a mask actually streamed correctly, against the
     * fixture's known patterns. The pack is already resident; this just rebinds
     * on the next residency pass.
     * @param {string} name
     */
    async function setDisplayLayer(name) {
      displayLayerName = name;
      await scheduleResidencyUpdate();
      return { displayLayer: displayLayerName };
    }

    /**
     * Show ONLY one draw item (`''` = show all). See isolateItemId's header for
     * why this exists rather than a sixth theory.
     * @param {string} id
     */
    async function setIsolateItem(id) {
      isolateItemId = id ?? '';
      await scheduleResidencyUpdate();
      return {
        isolateItemId,
        showing: isolateItemId === '' ? 'ALL items (normal)' : isolateItemId,
        drawListIds: lastItems.map((i) => i.id),
      };
    }

    // --- Mouse pan/zoom (native-Foundry feel) --------------------------------
    // The camera is re-derived from the live view state every frame
    // (updateCamera, called from renderFrame), so a drag tracks the cursor at
    // display rate for free. This replaces reframeVisibleLayers(), which used to
    // rewrite every quad's UVs per pointermove — cheaper, and structurally immune
    // to the UV-compounding bug that path produced live on 2026-07-15.

    // Coalesced residency: a fast drag fires far more pointermove events than a
    // decode/upload cycle can service, so overlapping updateResidency() runs
    // would stack up and thrash the atlas. Run at most one at a time; if the
    // view moved again meanwhile, run exactly once more. updateResidency() reads
    // the live `view` each run, so the final run always reflects the latest view.
    /**
     * THE DOCUMENT-REFRESH DISCRIMINATOR (2026-07-17, author-reported: "when I
     * move a token it clearly moves in the document but it only updates the
     * token's new position in threejs once I pan the camera or zoom").
     *
     * The whole read path — the `updateToken` hook, refreshVtPanViewerItems,
     * updateResidency, buildItems' live document reads, refreshItemPlacement's
     * geometry rewrite — was re-read line by line and is CORRECT. Which is
     * exactly the point at which this project stops guessing: six rounds of
     * theory→live-test cost a session in 2026-07-15, and the thing that ended it
     * was instrumentation, not a seventh theory.
     *
     * These three counters make the three candidate causes DISTINGUISHABLE in
     * one report, which is the only property that matters here:
     *
     *   docRefreshes === 0        -> the hook never reached us. Fix boot.js.
     *   docRefreshes > 0 but
     *     placementChanges === 0  -> we ran and read the SAME position. The doc
     *                                read is stale/mis-timed. Fix the source.
     *   docRefreshes > 0 and
     *     placementChanges > 0    -> we ran AND moved the geometry, and the
     *                                screen still disagrees. Fix the upload
     *                                (BufferAttribute -> GPU under WebGPU).
     *
     * `placementChanges` counts items whose placementKey ACTUALLY changed, so a
     * zero here means "nothing moved", never "I did not look" — every pass
     * writes all three fields (doctrine #5, feedback_instruments_must_not_lie).
     *
     * COUNTERS, NOT TIMESTAMPS, and that was the `time/one-clock` wall's doing:
     * the first cut stamped `performance.now()` on each field and the wall
     * (correctly) failed the build. It asked the right question — does a
     * diagnostic need its own private clock? — and the answer was no. The three
     * counters discriminate all three causes on their own; the timestamps were
     * decoration that would have added two private clock reads to a codebase
     * whose predecessor died partly of 41 of them.
     *
     * ROUND 2 (2026-07-17) — the first cut of this ANSWERED ONE QUESTION AND
     * NOT THE ONE THAT MATTERED, which is worth recording because it is this
     * project's most expensive recurring mistake in miniature:
     *
     *   documentSync: { docRefreshes: 1, placementChanges: 0 }
     *
     * That says *a* hook fired. It does NOT say WHICH — and "did `updateToken`
     * fire at all?" was the entire open question. `docRefreshes: 1` is equally
     * consistent with "updateToken fired and the read was stale" and with
     * "updateToken never fired and this 1 came from some other document" — two
     * causes needing opposite fixes, collapsed onto one number. Hence
     * `byHook`: the count keyed by the hook NAME that drove it.
     *
     * `placementChangesTotal` is cumulative for the same reason: `placementChanges`
     * describes only the LAST pass, so any later no-op pass silently erases the
     * evidence of the one that mattered. A number that a later event can reset
     * to a value meaning "nothing happened" is not a measurement.
     */
    const lastUpdate = {
      itemCount: 0,
      placementChanges: 0,
      placementChangesTotal: 0,
      docRefreshes: 0,
      byHook: {},
    };

    /**
     * ROUND 3 — the same author move, a DIFFERENT symptom: liveVsRendered showed
     * a REAL 807.8px gap, docRefreshes:4 (2 updateToken + 2 moveToken, matching
     * two movement segments) but placementChangesTotal:1. That is one report;
     * it does not say whether the gap is STRUCTURAL (a hook genuinely missed) or
     * TRANSIENT (the async residency pass legitimately had not caught up yet —
     * plausible given item 1b's finding, the SAME scene's cache is already at
     * `freePages:0` with 246 coarse pins short, so streaming a token's freshly-
     * moved-to pages can be slow). Those need OPPOSITE next actions — more hook
     * plumbing vs the cache-budget work already tracked as 1b — so guessing is
     * exactly the six-rounds trap this project already paid for once.
     *
     * `passLog`: one entry per token item per REAL updateResidency() PASS (not
     * per hook — hooks that fire synchronously back-to-back coalesce into ONE
     * pass via `scheduleResidencyUpdate`'s do-while, so `docRefreshes` and
     * "actual passes" are NOT the same count; conflating them is how the last
     * report read stranger than it was). `pass` is a plain incrementing
     * counter, not a timestamp — `time/one-clock` again.
     *
     * A second report, taken a few seconds after the FIRST without touching
     * anything, is what actually distinguishes the two causes: if `passLog`
     * shows a LATER pass converging on the live position, it was transient; if
     * `totalPasses` stops advancing for that item while `liveVsRendered` still
     * disagrees, no further pass is even being attempted and the hook is the gap.
     */
    let passSeq = 0;
    const TOKEN_PASS_LOG_MAX = 24;
    const tokenPassLog = [];

    let residencyInFlight = false;
    let residencyDirty = false;
    /**
     * THE ONLY WAY TO RUN A RESIDENCY PASS. The sole caller of
     * `updateResidencyUnguarded` — see its header for the pin leak that six
     * direct callers caused, and the live numbers that proved it.
     *
     * Nothing is dropped: a request arriving mid-pass sets `residencyDirty` and
     * the in-flight run loops again, so the LAST state always wins and exactly
     * one pass touches shared per-pack state at a time. Callers that used to
     * `await updateResidency()` for its completion still get it whenever no
     * pass is running (the common case — startup, a lone floor switch): the
     * do-while runs inline and this await resolves after it. When a pass IS
     * running, returning early is the point.
     */
    async function scheduleResidencyUpdate() {
      if (residencyInFlight) {
        residencyDirty = true;
        return;
      }
      residencyInFlight = true;
      try {
        do {
          residencyDirty = false;
          await updateResidencyUnguarded();
        } while (residencyDirty);
      } finally {
        residencyInFlight = false;
      }
    }

    // Drag-to-pan with the primary (or middle) button — native Foundry's
    // canvas-drag pan. Pointer capture keeps the drag alive when the cursor
    // leaves the canvas or slips over a Foundry UI panel mid-drag.
    let dragging = false;
    let dragPointerId = null;
    let lastPointerX = 0;
    let lastPointerY = 0;

    function onPointerDown(e) {
      // RIGHT-DRAG PANS — verified in the vendored source, not remembered
      // (author caught this): Canvas#_onDragRightMove (board.mjs:2278) is literally
      // `this.pan(...)`, and mouse-handler.mjs:462 routes `button === 2` to the
      // right-drag handler. LEFT-drag in Foundry is the SELECT box, so panning on
      // it would fight every placeable layer the moment tokens land.
      // Middle (1) is kept as a common convenience that collides with nothing.
      if (e.button !== 2 && e.button !== 1) return;
      dragging = true;
      dragPointerId = e.pointerId;
      lastPointerX = e.clientX;
      lastPointerY = e.clientY;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (_) {}
      canvas.style.cursor = 'grabbing';
      e.preventDefault();
    }

    function onPointerMove(e) {
      if (!dragging || e.pointerId !== dragPointerId) return;
      const dx = e.clientX - lastPointerX;
      const dy = e.clientY - lastPointerY;
      if (dx === 0 && dy === 0) return;
      lastPointerX = e.clientX;
      lastPointerY = e.clientY;
      const next = applyPanByPixels(view, dx, dy, canvasH, world);
      if (next === view) return;
      view = next;
      scheduleResidencyUpdate().catch((err) => console.error('[vt-pan-viewer] pan residency failed:', err));
      e.preventDefault();
    }

    function endDrag(e) {
      if (!dragging || (e && e.pointerId !== dragPointerId)) return;
      dragging = false;
      dragPointerId = null;
      try {
        if (e) canvas.releasePointerCapture(e.pointerId);
      } catch (_) {}
      canvas.style.cursor = 'default';
    }

    // --- CAMERA SMOOTHING (2026-07-16 — see view-state.js's own header for the
    // full "why two different models for pan vs zoom" design note) ----------
    // Drag stays EXACTLY as above: 1:1, zero smoothing — direct manipulation
    // should never lag behind the cursor. Only DISCRETE inputs (held keys,
    // wheel ticks) are eased here.
    const heldPanKeys = new Set(); // raw KeyboardEvent.key values currently held
    let panVelocity = { x: 0, y: 0 }; // current, smoothed, world px/sec
    let targetHalfSpanPx = null; // set once the initial view exists; eased toward every frame
    let zoomAnchorSx = 0;
    let zoomAnchorSy = 0; // screen-space anchor for the in-flight eased zoom
    let lastFrameTimeMs = null;

    const PAN_SPEED_SCREENFULS_PER_SEC = 1.2; // matches the old discrete step's own halfSpanPx-proportional feel
    const PAN_RAMP_HALF_LIFE_SEC = 0.08; // ~80ms to close half the gap to full speed — responsive, not laggy
    const ZOOM_EASE_HALF_LIFE_SEC = 0.12; // ~120ms glide between zoom levels instead of a hard jump
    const MAX_DT_SEC = 0.1; // clamp after a stall (backgrounded tab, etc.) — avoid a huge catch-up jump

    /** Set a new eased-zoom TARGET (does not move the view itself — see updateContinuousInputs). */
    function setZoomTarget(factor, sx, sy) {
      targetHalfSpanPx = clampHalfSpan((targetHalfSpanPx ?? view.halfSpanPx) * factor, world);
      zoomAnchorSx = sx;
      zoomAnchorSy = sy;
    }

    /**
     * Runs once per animation frame, BEFORE render — eases held-key pan
     * velocity and any in-flight zoom target toward their goals, reusing the
     * EXACT SAME reframe + coalesced-residency pattern the drag/wheel paths
     * above already use (so continuous motion streams pages exactly as
     * proven-safe as a fast mouse drag, not a new mechanism).
     * @param {number} nowMs
     */
    function updateContinuousInputs(nowMs) {
      if (lastFrameTimeMs === null) {
        lastFrameTimeMs = nowMs;
        return;
      }
      const dtSec = Math.min(MAX_DT_SEC, Math.max(0, (nowMs - lastFrameTimeMs) / 1000));
      lastFrameTimeMs = nowMs;
      if (dtSec <= 0 || !view) return;

      let dirty = false;

      // FOLLOW FOUNDRY'S CAMERA, per frame. Reading canvas.stage is a couple of
      // property reads, so doing it every frame is cheaper than the alternative and
      // cannot drift: there is no event to miss and no ordering to get wrong.
      //
      // It was driven off the canvasPan hook, which AWAITED a full residency
      // rebuild — sort the draw list, re-request pages — on every event of a drag.
      // That is what made pan/zoom "a bit laggy and awkward, not smooth any more"
      // (author-reported). The camera must move at frame rate; residency is
      // debounced behind scheduleResidencyUpdate, which already exists for exactly
      // this and is what MSA's own input used.
      if (followFoundryCamera && syncFoundryCamera()) dirty = true;

      // MSA'S OWN CAMERA INTEGRATION — skipped entirely when following Foundry.
      //
      // Gating the input LISTENERS was not enough (author-reported live: "it keeps
      // trying to push the camera back to the same position and zoom every
      // frame"). This block runs per-frame regardless of input: it eases
      // view.halfSpanPx toward targetHalfSpanPx — still holding the value captured
      // at load — and REPLACES `view` wholesale via integratePan/applyZoomAtPixel.
      // So every frame it overwrote whatever syncFoundryCamera had just adopted and
      // dragged the view back to the load-time camera. Two cameras fighting: the
      // precise failure this model exists to prevent, reproduced by my own loop.
      if (!followFoundryCamera) {
        // Continuous keyboard pan: ease velocity toward what the held keys
        // imply, then integrate position — replaces the old discrete per-
        // keydown jump with a smooth glide whose speed scales with the CURRENT
        // zoom (screenfuls/sec, matching the old step's own feel).
        const targetVelocity = computeTargetPanVelocity(heldPanKeys, view.halfSpanPx * PAN_SPEED_SCREENFULS_PER_SEC);
        panVelocity = easeVelocityTowardTarget(panVelocity, targetVelocity, dtSec, PAN_RAMP_HALF_LIFE_SEC);
        if (Math.abs(panVelocity.x) > 0.01 || Math.abs(panVelocity.y) > 0.01) {
          const nextView = integratePan(view, panVelocity, dtSec, world);
          if (nextView !== view) {
            view = nextView;
            dirty = true;
          }
        }

        // Smoothed zoom: ease halfSpanPx toward the last input's target,
        // re-anchored around the SAME screen point every frame via the
        // existing, already-tested applyZoomAtPixel — never a new formula.
        if (targetHalfSpanPx !== null) {
          const factor = easedZoomFactor(view.halfSpanPx, targetHalfSpanPx, dtSec, ZOOM_EASE_HALF_LIFE_SEC);
          if (factor !== 1) {
            const nextView = applyZoomAtPixel(view, factor, zoomAnchorSx, zoomAnchorSy, canvasW, canvasH, world);
            if (nextView !== view) {
              view = nextView;
              dirty = true;
            }
          }
        }
      }

      if (dirty) {
        scheduleResidencyUpdate().catch((err) =>
          console.error('[vt-pan-viewer] continuous-input residency failed:', err)
        );
      }
    }

    // Safety against a "stuck key" bug (a keyup that fires while this window
    // doesn't have focus can be missed entirely — a well-known class of issue
    // for any held-key input system, and this project has already hit the
    // adjacent "backgrounded tab" class of bug once, see tab-out load
    // protection in project memory): clear held keys whenever the window
    // loses focus or the tab is hidden, so a stray missed keyup can never
    // leave the camera panning forever.
    function clearHeldKeys() {
      heldPanKeys.clear();
    }

    function onWheel(e) {
      // Native Foundry: wheel up = zoom in, wheel down = zoom out, toward the
      // cursor. Anchor to the canvas's own client box so any page scroll offset
      // never skews the world-point-under-cursor math.
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      // Scale the per-event factor by the wheel's actual deltaY magnitude
      // (clamped) rather than a flat constant — a trackpad's fine-grained
      // continuous deltas used to get the SAME big jump as a single discrete
      // mouse-wheel notch, which read as much jumpier on a trackpad than a
      // wheel. A notch is typically |deltaY|~100; normalize against that.
      const magnitude = Math.min(2, Math.max(0.15, Math.abs(e.deltaY) / 100));
      const baseFactor = e.deltaY < 0 ? 0.8 : 1.25; // == applyZoomKey's in/out factors at magnitude 1
      setZoomTarget(Math.pow(baseFactor, magnitude), sx, sy);
      // Stop the page (and Foundry's own hidden canvas) from also scrolling/zooming.
      e.preventDefault();
      e.stopPropagation();
    }

    // Shared by the real keydown handler AND the soak harness (MapShine.soakHooks.pan)
    // — one code path applies a key, so a soak run exercises exactly what a real
    // user's keypress would, not a separate simulated approximation of it.
    async function applyKeyAndUpdate(key) {
      const ctx = { world, floorCount };
      const next = applyKey(view, key, ctx);
      if (next === view) return false;
      view = next;
      await scheduleResidencyUpdate();
      return true;
    }

    /**
     * ONE realistic zoom step — exposed for `MapShine.soakHooks.zoom`
     * (2026-07-17, author-directed: the burst-mode thrash test reaches states a
     * real user genuinely cannot produce — confirmed live, the author could not
     * reproduce its ghost artefact through deliberate aggressive manual
     * scroll-zooming for 15-20s). SAME factor and anchor as a real keyboard
     * zoom key (`ZOOM_IN_KEYS`/`ZOOM_OUT_KEYS` above, and `onWheel`'s own
     * magnitude-1 case) — NOT a new formula, and NOT the thrash's
     * `clampHalfSpan(0/Infinity, world)` full-range jump. `setZoomTarget` only
     * moves the EASED target; the glide itself happens in
     * `updateContinuousInputs` on subsequent real animation frames, exactly as
     * it does for a real keypress or wheel notch — this function does not
     * shortcut that.
     * @param {'in'|'out'} direction
     */
    function zoomStep(direction) {
      setZoomTarget(direction === 'in' ? 0.8 : 1.25, canvasW / 2, canvasH / 2);
    }

    /**
     * Set the floor index DIRECTLY (not via a synthetic keypress) and run
     * exactly one residency update — the SAME cheap path `applyKeyAndUpdate`
     * uses for an ordinary floor-switch keypress, deliberately NOT a call to
     * `startVtPanViewer` (a full teardown + fresh 512MB atlas + fresh page
     * cache). This is the fix for a real live bug (2026-07-15): the boot.js
     * `canvasReady` handler used to call `startVtPanViewer` on every floor
     * switch (since Foundry's own `Scene#view()` re-fires `canvasReady` on a
     * same-scene level change, confirmed in source) — which both reset the
     * view to floor 0 every time (silently ignoring the switch) AND, worse,
     * repeatedly reallocated the full GPU atlas on ordinary floor toggles,
     * which crashed after a few switches. A same-scene floor sync should cost
     * what a keypress costs, nothing more.
     * @param {number} floorIndex
     * @returns {Promise<boolean>} true if the floor actually changed.
     */
    async function setFloorIndex(floorIndex) {
      if (!view || view.floorIndex === floorIndex) return false;
      view = { ...view, floorIndex };
      // WIND REBAKE ON FLOOR SWITCH (2026-07-23, live author report: on a
      // real two-floor map, the floor BELOW kept reading the floor ABOVE's
      // wall layout for wind purposes). `bakeWindField`'s per-floor wall
      // scoping (see that function's own header) resolves `currentLevelIdFor
      // Wind` fresh every time it runs — but nothing was ever calling it
      // AGAIN when the floor itself changed. Its five pre-existing triggers
      // ('startup'/'manual'/'wall:*'/'ambient-change'/'mask-change') all
      // answer "did the WALLS or MASK change", never "did the VIEWED FLOOR
      // change" — so the baked grid simply kept whatever the previous
      // floor's bake left behind until one of those unrelated events
      // happened to fire, which is exactly why this stayed invisible on
      // every single-floor test (there is no other floor for it to go stale
      // against) and only surfaced on the real multi-floor scene. This is
      // the ONE place `view.floorIndex` changes after startup (verified: no
      // other call site reassigns it), so it is the correct, complete
      // chokepoint — every floor switch, whichever UI path triggered it
      // (keyboard/digit key, debug panel, or boot.js's `canvasReady`
      // same-scene sync), now re-derives the wall scoping. Synchronous and
      // cheap enough to run unconditionally (same cost as any other rebake);
      // `bakeWindField` never throws (catches and logs internally), so this
      // cannot turn a floor switch into a hard failure.
      bakeWindField('floor-change');
      // The SKY's `_Outdoors` gate is per-floor for exactly the same reason the
      // wind bake is: a cellar and the street above it have entirely different
      // ideas about what is open sky. Leaving it stale would light the floor
      // below through the floor above's windows — the same class of bug the
      // wind rebake above was added to fix, and the same chokepoint fixes it.
      bakeOutdoorsTexture(floorIndex);
      await scheduleResidencyUpdate();
      return true;
    }

    const ZOOM_IN_KEYS = new Set(['+', '=', 'PageUp']);
    const ZOOM_OUT_KEYS = new Set(['-', '_', 'PageDown']);

    function onKeyDown(e) {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable))
        return;
      // Decide SYNCHRONOUSLY whether this key does anything (applyKey itself is
      // pure/sync) so preventDefault() fires before the event finishes — calling
      // it after any async work below would be too late for the browser to
      // actually suppress e.g. arrow-key page scroll.
      const ctx = { world, floorCount };
      if (applyKey(view, e.key, ctx) === view) return; // no-op key, let the browser handle it normally
      // Foundry's own KeyboardManager binds arrow keys to core.panUp/Left/Down/Right
      // (repeat:true, always active — confirmed live 2026-07-15 by tracing
      // foundryvttsourcecode_v14/.../client-keybindings.mjs) and digit keys can
      // trigger hotbar slots — both listen on `window` in the bubble phase, same
      // as this handler was. Registered in the CAPTURE phase (below) so this
      // handler ALWAYS runs first regardless of registration order, and
      // stopImmediatePropagation() here stops Foundry's own handler (and
      // anyone else's) from also acting on a key this viewer has claimed —
      // without this, arrow-key presses were panning Foundry's own canvas
      // instead of (or as well as) this viewer's view, and the view state
      // never actually changed.
      e.stopImmediatePropagation();
      e.preventDefault();

      // CAMERA SMOOTHING (2026-07-16): pan keys go to the CONTINUOUS held-key
      // system (updateContinuousInputs, run every frame) instead of a discrete
      // per-keydown jump — this is the actual fix for "jerky" keyboard pan
      // (OS key-repeat timing made the old discrete path visibly steppy). "Is
      // this a pan key" is asked of view-state.js's own pan-velocity function
      // (rather than a second hardcoded key list here that could drift from
      // its internal one) — a key that produces zero velocity alone is, by
      // definition, not one it recognizes.
      // Zoom keys set an eased TARGET (screen-center anchor, matching
      // applyZoomKey's own "just changes halfSpan, center stays put" shape)
      // instead of jumping instantly; each OS key-repeat re-nudges the target
      // further, exactly like the old discrete path let holding '+' keep
      // zooming in, just arriving smoothed now instead of as instant jumps.
      // Floor-switch (digits/Tab) and anything else applyKey recognizes stays
      // on the EXACT original discrete path — `applyKeyAndUpdate` is
      // UNCHANGED and still the one MapShine.soakHooks.pan calls directly, so
      // the soak harness's contract is untouched by this.
      const velocityIfPanKey = computeTargetPanVelocity(new Set([e.key]), 1);
      if (velocityIfPanKey.x !== 0 || velocityIfPanKey.y !== 0) {
        heldPanKeys.add(e.key); // Set dedupes — OS key-repeat re-adding is a harmless no-op
        return;
      }
      if (ZOOM_IN_KEYS.has(e.key) || ZOOM_OUT_KEYS.has(e.key)) {
        setZoomTarget(ZOOM_IN_KEYS.has(e.key) ? 0.8 : 1.25, canvasW / 2, canvasH / 2);
        return;
      }
      applyKeyAndUpdate(e.key).catch((err) => console.error('[vt-pan-viewer] updateResidency failed:', err));
    }

    /** Release tracking for the continuous held-key pan system. */
    function onKeyUp(e) {
      heldPanKeys.delete(e.key);
    }

    // The scene area resizes (window resize, sidebar collapse, Foundry
    // relayout). Re-measure the host, resize the drawing buffer to match, and
    // recompute residency at the new aspect so the map never stretches. Debounced
    // to a rAF-ish microtask via a simple in-flight guard is overkill here — the
    // handler is cheap and resize events are coarse.
    let resizePending = false;
    function onResize() {
      if (resizePending || !_active) return;
      resizePending = true;
      queueMicrotask(async () => {
        resizePending = false;
        if (!_active) return;
        const { width, height } = measureHost(mount.host);
        if (width === canvasW && height === canvasH) return;
        canvasW = width;
        canvasH = height;
        renderer.setSize(canvasW, canvasH, false);
        // Re-read the drawing buffer, not canvasW*pixelRatio by hand — same
        // reasoning as the initial setup above (avoids a second place that
        // could round differently from what three actually allocated).
        const resized = renderer.getDrawingBufferSize(new THREE.Vector2());
        drawBufW = resized.width;
        drawBufH = resized.height;
        // buf:scene.color tracks the drawing buffer — that IS what screenSized
        // means. `allocator.resize()` re-enforces the law on the new size
        // (its own doc: "a resize storm can't smuggle a world-res target past
        // the law that create() already enforced"). Device pixels (drawBufW/H),
        // matching describeSceneColorMrt's own resolvedW/H — see its note.
        // `RenderTarget.setSize()` only mutates width/height on the EXISTING
        // texture array (verified against the vendored source) — it never
        // reconstructs attachments or re-reads `desc.attachments`, so this
        // resize keeps attachment 1's name/type/filter exactly as `create()`
        // set them. The MRT descriptor is passed anyway (not the plain
        // single-attachment one) so the keyhole-law check sees the SAME
        // shape this target was actually created with.
        allocator.resize(sceneColor, drawBufW, drawBufH, describeSceneColorMrt());
        // light.accumulate's targets track the drawing buffer too (same
        // screenSized law). setSize mutates textures in place, so the samplers
        // stay valid; rebind* only flag needsUpdate.
        allocator.resize(sceneIllum, drawBufW, drawBufH, describeSceneColor());
        allocator.resize(sceneLit, drawBufW, drawBufH, describeSceneColor());
        allocator.resize(sceneColoration, drawBufW, drawBufH, describeSceneColor());
        // post.bloom's mip chain tracks the drawing buffer too — each mip a
        // fixed fraction of it. setSize mutates the SAME texture object in place
        // (as for scene.color above), so the composite material's baked
        // texture(bloomMips[0/3].texture) nodes stay valid — no rebind needed.
        for (let k = 0; k < BLOOM_MIP_COUNT; k++) {
          allocator.resize(bloomMips[k], bloomMipW(k), bloomMipH(k), describeBloomMip(bloomMipW(k), bloomMipH(k)));
        }
        rebindPresent();
        rebindLighting();
        // buf:occlusion tracks the drawing buffer too — same reasoning. No
        // rebind needed afterward: RenderTarget#setSize (three.webgpu.js:4934)
        // mutates the SAME texture object's .image dimensions in place rather
        // than replacing it, so every material's already-baked `texture(
        // occlusionMask.texture, screenUV)` node keeps pointing at the right
        // object — verified against the vendored source before relying on it.
        allocator.resize(occlusionMask.rt, drawBufW, drawBufH, describeOcclusionMask());
        await scheduleResidencyUpdate().catch((err) => console.error('[vt-pan-viewer] resize residency failed:', err));
      });
    }

    // The initial view. Opens on `initialFloorIndex` (defaults to 0, but a
    // real-scene auto-start passes whatever Foundry itself is currently viewing
    // — see this function's own param doc for why that match matters). Frames a
    // generous chunk of the world so it immediately reads as "the map fills the
    // display" rather than a tiny zoomed-in patch — that view is served largely
    // by coarse pins, so it's instant.
    //
    // The world is the SCENE's canvas rect now, not the first floor image's
    // size: art no longer defines the world (it's placed INTO it), so the view
    // no longer has to wait on a decode to know where it is.
    const clampedInitialFloor = Math.max(0, Math.min(floorCount - 1, initialFloorIndex));
    view = createInitialViewState({
      world,
      floorIndex: clampedInitialFloor,
      halfSpanPx: Math.max(world.width, world.height) * 0.25,
    });
    targetHalfSpanPx = view.halfSpanPx; // eased-zoom target starts equal to the actual value — no zoom-on-load

    // THE SKY'S GATE, baked NOW rather than waiting for the mask-version poll's
    // "first observation" tick (pollMaskAuthorityForWindRebake, throttled to
    // MASK_VERSION_POLL_INTERVAL_MS). That poll exists to catch a LIVE EDIT, not
    // to discover a scene's masks in the first place — waiting on it here would
    // leave the sky reading the fully-outdoors placeholder for up to that
    // interval on every fresh load, for no reason.
    bakeOutdoorsTexture(clampedInitialFloor);

    // THE INITIAL LOAD, walked explicitly so it can be REPORTED.
    //
    // updateResidency() would load these items anyway (its phase-1 loop calls the
    // same idempotent ensureItemLoaded), but it runs on every residency update and
    // has no business knowing about a loading screen. Doing the first pass here
    // keeps the progress feed out of the per-frame path entirely, and gives honest
    // per-item counts (§4.5's "pages resident / pages needed", at the granularity
    // we actually know before anything is decoded: the item count is known
    // immediately from buildItems, the page totals are not).
    //
    // ensureItemLoaded is idempotent, so updateResidency's own loop below is then
    // a no-op for these — one path, walked twice, not two paths.
    //
    // THE COARSE-PIN BUDGET, computed BEFORE the first ensureItemLoaded call of
    // the session — this loop (and prewarm, started further below) is where
    // NEW packs first request their coarse pin, and that request reads
    // `currentCoarseBudget` (item 1b). Must happen before either.
    refreshCoarsePinBudget();
    const initialItems = buildItems(view.floorIndex);
    onLoadProgress?.({ done: 0, total: initialItems.length, detail: null });
    for (let i = 0; i < initialItems.length; i++) {
      const item = initialItems[i];
      try {
        await ensureItemLoaded(item);
      } catch (err) {
        // A single broken item must not take the scene down — updateResidency
        // records it properly below; here we only keep the count honest.
        console.error(`[vt-pan-viewer] initial load: item "${item.id}" failed:`, err);
      }
      onLoadProgress?.({ done: i + 1, total: initialItems.length, detail: item.kind });
    }

    // Through the guard like every other caller (nothing else is running yet,
    // so this executes inline and the await genuinely resolves after it).
    await scheduleResidencyUpdate();

    // WAIT FOR THE VIEWED FLOOR'S TEXTURE COMPRESSION (2026-07-18 — "encoding
    // during loading", author-requested after watching the upper floor's
    // background/overhead sit invisible for a minute-plus after a floor
    // switch with zero on-screen explanation). scheduleResidencyUpdate() just
    // KICKED OFF each item's BC1/BC7 encode via ensureWholeImageMeshes — it
    // does not wait for any of them (they run in the background, serialized
    // through wholeImageLoadChain). Without this, the loading curtain drops
    // the instant the ITEM LIST is built, while the actual pixels for the
    // floor the author is looking at are still cooking — the "0%/98% two-gate
    // 'Ready!' lie" load-progress.js's header puts on the kill list, just
    // relocated to right after the curtain instead of inside it.
    //
    // Deliberately scoped to the VIEWED floor only: waiting for every floor in
    // the scene here would make a heavy multi-floor scene's FIRST load take
    // as long as visiting every floor once, even for an author who only ever
    // opens floor 0 this session. Other floors are prewarmed in the
    // background further below (non-blocking) so a later floor switch is
    // fast without holding up THIS floor's curtain.
    const compressing = initialItems
      .map((item) => ({ item, wi: itemStates.get(item.id)?.wholeImage }))
      .filter(({ wi }) => wi?.loadPromise);
    if (compressing.length) {
      onLoadProgress?.({ done: 0, total: compressing.length, detail: 'Compressing textures' });
      for (let i = 0; i < compressing.length; i++) {
        const { item, wi } = compressing[i];
        await wi.loadPromise; // always resolves — see wi.loadPromise's own doc
        onLoadProgress?.({ done: i + 1, total: compressing.length, detail: item.kind });
      }
    }

    // PRECOMPILE BEFORE THE FIRST DRAW. Until now every program compiled lazily
    // inside the first render() — an unbounded synchronous stall in the one frame
    // the user is already waiting on, and invisible because it hid inside the
    // load. See docs/planning/Shaders.md for the full reasoning; the short version:
    //
    //   * compileAsync's NAME IS MISLEADING. `this.compile()` inside it is
    //     SYNCHRONOUS (three.module.js:42011) — createShader/compileShader/
    //     linkProgram all run now, on this thread. Only the WAIT is a promise.
    //   * What makes that wait worth anything is KHR_parallel_shader_compile: the
    //     DRIVER compiles on its own threads and linkProgram returns immediately.
    //     WITHOUT the extension, `programReady` is initialised to TRUE
    //     (three.module.js:36061), isReady() lies at once, this resolves instantly
    //     — and the compile still blocks, just later, at first useProgram.
    //
    // So this is not "make compilation async". It is: do the compile HERE, where
    // the loading screen is watching and its worstStallMs will report the cost,
    // rather than in the first frame where it is invisible. On a GPU with the
    // extension it is genuinely parallel; on one without, it is at least MEASURED.
    // A worker cannot help with either — GL programs belong to the context that
    // made them, so a worker's program is unusable here (Shaders.md §2).
    try {
      const t0 = performance.now();
      await renderer.compileAsync(scene, camera);
      shaderCompileMs = Math.round(performance.now() - t0);
    } catch (err) {
      // Precompiling is an optimisation; failing to precompile must never cost a
      // scene. The programs will compile lazily on first draw exactly as before.
      console.warn('[vt-pan-viewer] shader precompile failed — falling back to lazy compile:', err);
      shaderCompileMs = null;
    }

    // THE INITIAL WIND BAKE (Wind.md Tier 1) — must run here, not earlier:
    // bakeWindField's own rebuild-trigger code reaches for candleFlameMat/
    // windOverlayMat (both declared with `let` further up, but AFTER the
    // function itself is defined) — calling it before those declarations
    // execute hits their temporal dead zone (a live ReferenceError, caught
    // from an actual scene load). Windless by default (uWindDirectionDeg/
    // uWindSpeed01 start at 0/0, matching DEFAULT_WIND), so a scene nobody
    // has dialled wind into still bakes correctly to "no correction
    // anywhere" — every candle/light/overlay material built from here on
    // already has a bake to read, never a stale or missing one.
    bakeWindField('startup');

    // ------------------------------------------------------------------
    // WIND DIAGNOSTIC PARTICLES (RENAMED from "ambient dust" 2026-07-22 —
    // this is a debug-only wind visualization, off by default; see
    // windParticlesEnabled/constructParticleEngineIfNeeded above) — the FIRST
    // particle system built in this codebase (docs/planning/Particles.md
    // §23). A real ambient-dust dressing effect is a separate, later feature
    // that will reuse this same engine. createParticleEngine
    // (effects/particles/particle-runtime.js) owns the arena
    // + the TSL compute kernels + the ONE instanced billboard draw; here we only
    // construct it, step it each frame (sims.particles — a direct renderer.compute,
    // like tickWindSim), and draw its scene additively into scene.lit
    // (surface.particles — runSurfaceParticlesPass). The world rect is set each
    // frame from the live view; a mote that drifts outside it respawns at a
    // fresh random point within it (an exit test, NOT a toroidal wrap — the
    // first version used modulo-wrap and it clustered visibly on every zoom;
    // see particle-runtime.js's own header, fix-6).
    //
    // CONSTRUCTED HERE, NOT EARLIER (fix-9, live-reported 2026-07-21) — the
    // SAME reason bakeWindField itself had to move to this exact spot (see its
    // own comment just above): a build-time input that "becomes real later"
    // must be read AFTER it becomes real, or the reader is stuck with `null`
    // forever. `bakedField`'s numeric constants (origin/cellSize/cols/rows) are
    // baked into the compute kernel's graph as literal JS-time values, and
    // `sampleWind`'s `if (bakedField)` branch is a JS-time check executed ONCE
    // while the kernel is being BUILT — never a runtime GPU branch. The engine
    // used to construct far earlier (near the candle-flame block), well BEFORE
    // this line — so it captured `windBakedField` while it was STILL `null`,
    // and the compiled kernel therefore never included wall-redirection AT
    // ALL, for the entire session, no matter how many times the field was
    // rebaked afterward. That is the actual root cause of "particles aren't
    // using the wind correctly at all... same speed in high and low wind grid
    // spaces" — the field's per-cell magnitude/direction variance (what makes
    // one grid square differ from its neighbour) comes almost entirely from
    // THIS baked correction, not from the (spatially uniform, by design)
    // ambient bias term. Moving construction to here — after the startup bake,
    // exactly where the comment above says every OTHER wind-reading material
    // is safe to build — is the fix; a LATER rebake (a wall edit, an ambient
    // change) still won't reach this already-built kernel, the same accepted
    // limitation candle's own material lives with (Wind.md §9).
    //
    // fix-9's construction-ORDER lesson stayed true; the MECHANISM changed
    // after it (fix-12, particle-runtime.js's own header): `bakedField`'s
    // texture-sampling path turned out to read back as exactly zero from
    // inside a compute shader in this renderer (proven only from fragment/
    // vertex before), so the kernel now reads the handle's own raw cell arrays
    // via a storage buffer instead — same construction-order requirement, no
    // texture involved anymore.
    // ------------------------------------------------------------------
    // RELABELED + DEFERRED (2026-07-22, author request): this used to run
    // unconditionally right here. It is now wrapped in a named function so
    // setWindDiagnosticParticlesEnabled can call it LATER too, the first time
    // a user actually opens the debug toggle — a scene where nobody ever
    // does allocates no arena and compiles no kernel for this at all.
    function constructParticleEngineIfNeeded() {
      if (particleEngine) return; // already built — see particleEngine's own comment on why re-enabling never rebuilds.
      particleEngine = createParticleEngine({
        THREE,
        system: WIND_DIAGNOSTIC_PARTICLES,
        worldRect: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, // placeholder; real rect set per frame in step()
        zDepth: 0,
        // THE SAME HANDLE the candle flame, the lights and the overlay read
        // (Wind.md §5.1) — genuinely populated, because the startup bake just
        // above already ran. It carries both halves this kernel needs: the live
        // ambient uniform NODES (by reference, so a `setWindAmbient` change
        // reaches the kernel next frame with no resync) and the RAW plain-array
        // per-cell grid it uploads as a storage buffer to do its own
        // nearest-cell lookup — rather than depending on texture sampling
        // inside a compute shader, a path never exercised elsewhere in this
        // codebase (the retired compute spike proved storage buffers, not textures).
        windHandle,
        // GALE-FORCE CALIBRATION (author request) — Foundry's own real
        // px-per-grid-distance-unit (e.g. "1 grid square = 1 meter" makes
        // this literally px-per-meter), read ONCE at construction, same
        // discipline as `runMaskOcclusionPass`/the light-mesh pass's own
        // `readGridDistancePixels` calls (a scene's grid never changes
        // mid-session). particle-runtime.js's own GALE_MPS uses this to turn
        // windSpeed01 into an actual, physically-real world-px/sec ceiling.
        pxPerMeter: readGridDistancePixels().distancePixels,
      });
    }
    if (windParticlesEnabled) constructParticleEngineIfNeeded();

    // WIND GUSTS — the ribbon-trail sibling of the diagnostic particles above,
    // built the SAME way (after the startup bake, so its kernel captures a real
    // baked grid, not the empty one it would see earlier). Reads the SAME
    // handle, so the ribbons and the motes cannot end up in different winds.
    function constructGustEngineIfNeeded() {
      if (gustEngine) return; // already built — no dispose path to rebuild from.
      gustEngine = createGustEngine({
        THREE,
        system: WIND_GUSTS,
        worldRect: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, // placeholder; real rect set per frame in step()
        zDepth: 0,
        windHandle,
        pxPerMeter: readGridDistancePixels().distancePixels,
      });
    }
    if (windGustsEnabled) constructGustEngineIfNeeded();

    loopActive = true;
    renderer.setAnimationLoop(renderFrame);

    // Background prewarm (non-blocking, best-effort): stream every OTHER floor's
    // items' coarse pins so a floor switch is instant (§4.5 — coarse pins for
    // every floor always resident). Fire-and-forget so it never delays the
    // initial floor's first paint; a failure on one item can't take the viewer
    // down. Items are per-floor now, so this asks buildItems for each floor's
    // draw list rather than loading "a floor".
    //
    // WHOLE-IMAGE MODE (2026-07-18 — companion to the "wait for the viewed
    // floor" fix above): ensureItemLoaded alone only probes each item's source
    // DIMENSIONS in this mode — it does NOT start BC1/BC7 compression (that is
    // ensureWholeImageMeshes' job, normally triggered only when a floor enters
    // the draw list). Before this, that meant this loop's own doc comment was
    // aspirational, not real: OTHER floors' art never actually started
    // compressing until the author switched to them, so "so a floor switch is
    // instant" was true for streaming-mode coarse pins but false for the
    // whole-image path every real scene now uses.
    //
    // DELIBERATELY BOUNDED TO ADJACENT FLOORS (±1), not every floor in the
    // scene — unlike a coarse pin (a small, fixed-size preview the page cache
    // can always evict), a compressed whole-image texture has NO eviction: once
    // built it stays GPU-resident for the rest of the session. Eagerly
    // compressing every floor of a scene with many floors would grow peak VRAM
    // without bound — reintroducing, via a different door, the exact ceiling
    // this entire session was spent fixing. Adjacent-floor prewarm covers the
    // overwhelmingly common "step up/down one floor" navigation for free; a
    // multi-floor jump still compresses lazily on arrival, same as before this
    // change. Calling ensureWholeImageMeshes here queues its compression onto
    // the SAME serialized wholeImageLoadChain the viewed floor's items used
    // above — since those were DISPATCHED first, they keep priority. Still
    // fire-and-forget: no onLoadProgress call, because the curtain is already
    // down and a background prewarm succeeding or failing must not reopen it.
    for (let f = 0; f < floorCount; f++) {
      if (f === clampedInitialFloor) continue;
      const adjacent = Math.abs(f - clampedInitialFloor) === 1;
      Promise.resolve()
        .then(async () => {
          for (const item of buildItems(f)) {
            const state = await ensureItemLoaded(item);
            if (adjacent) ensureWholeImageMeshes(state, item);
          }
        })
        .catch((err) => console.warn(`[vt-pan-viewer] prewarm floor ${f} failed:`, err));
    }

    // capture:true — see onKeyDown's comment. Must run before Foundry's own
    // window-level keydown listener (registered at Foundry boot, bubble phase).
    // Keyboard camera controls are MSA's own, so they go with the rest of them
    // when Foundry owns input — and these are on WINDOW, so pointer-events:none
    // could never have stopped them stealing WASD from Foundry.
    if (!followFoundryCamera) {
      window.addEventListener('keydown', onKeyDown, { capture: true });
      window.addEventListener('keyup', onKeyUp, { capture: true });
    }
    // Stuck-key safety (see clearHeldKeys' own doc) — a keyup missed while
    // this window/tab wasn't focused would otherwise leave the camera panning
    // forever once focus returns.
    window.addEventListener('blur', clearHeldKeys);
    document.addEventListener('visibilitychange', clearHeldKeys);
    window.addEventListener('resize', onResize);

    // Mouse pan/zoom lives on the canvas itself (topmost element over the map
    // area, so events land here, not on the occluded PIXI canvas beneath). They
    // die automatically when the canvas is removed in disposeActive(). `wheel`
    // must be passive:false so preventDefault() can suppress page scroll.
    canvas.style.cursor = 'default';
    // MSA's OWN camera controls exist only for the standalone torture-fixture
    // viewer, which has no Foundry scene to follow. On a real scene they must not
    // exist at all: a second camera is a second source of truth, and the moment it
    // disagrees with Foundry's stage every drop lands at the wrong world point.
    if (!followFoundryCamera) {
      canvas.addEventListener('pointerdown', onPointerDown);
      // Right-drag pans, so the browser context menu must not fire on release.
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', endDrag);
      canvas.addEventListener('pointercancel', endDrag);
      canvas.addEventListener('wheel', onWheel, { passive: false });
    }

    /**
     * Shared core of `sampleIllumPixel`/`probePixels` — one world-position
     * readback across every screen-sized render target the compositor
     * carries: illum/lit/albedo/coloration (all `HalfFloatType`, decoded via
     * `decodeHalfFloatRgba`) plus occlusion and attr (`UnsignedByteType`, a
     * different GPU format, decoded via `decodeByteRgba` — see that function's
     * own header for why a byte target needs its own decode path). See
     * `sampleIllumPixel`'s own header (below, on the returned API object)
     * for the full reasoning; factored out here so probing 1 point and
     * probing up to 3 run the EXACT same math, never two slightly-diverging
     * copies of it.
     *
     * ⚠️ `attr` IS `buf:scene.color`'s ATTACHMENT 1, NOT ITS OWN TARGET — hence
     * the `textureIndex` argument, which every other read here leaves at the
     * default 0. It was the ONE screen-sized buffer this probe could not see,
     * and it was invisible for exactly as long as it had no consumer: it went
     * live in increment 3 and `effects/specular`'s floor gate (2026-07-26) is
     * still the only thing that has ever READ it. That gate is a plain
     * multiply — `attr.a` near zero, or `attr.r` disagreeing with the quad's
     * own floor, silently zeroes the entire shine pass, both meshes, with
     * every JS-side status field reporting healthy. An unread buffer whose
     * value silently gates a whole effect is `feedback_unconsumed_api_rots_
     * silently` with a fuse attached; measuring it is four lines.
     *
     * @param {number} worldX @param {number} worldY
     * @returns {Promise<{worldX:number, worldY:number, pixel:{x:number,y:number}|null,
     *   buffers: object|null, onScreen: boolean}>}
     */
    async function sampleOnePixel(worldX, worldY) {
      if (!view) return { worldX, worldY, pixel: null, buffers: null, onScreen: false };
      const worldRect = viewToWorldRect(view, canvasW / canvasH);
      const ndc = worldToNdc({ x: worldX, y: worldY }, worldRect);
      const onScreen = ndc.x >= -1 && ndc.x <= 1 && ndc.y >= -1 && ndc.y <= 1;
      // Device pixels, not canvasW/H — these buffers are now sized in DEVICE
      // pixels (the pixel-ratio-parity fix), and readRenderTargetPixelsAsync
      // indexes into the buffer's own pixel grid, not CSS pixels.
      const pixel = ndcToPixel(ndc, drawBufW, drawBufH);
      const readOne = async (target, decode, textureIndex = 0) => {
        const raw = await renderer.readRenderTargetPixelsAsync(target, pixel.x, pixel.y, 1, 1, textureIndex);
        return { raw: raw ? Array.from(raw) : null, rgba: decode(raw) };
      };
      const [illum, lit, albedo, coloration, occlusion, attr] = await Promise.all([
        readOne(sceneIllum, decodeHalfFloatRgba),
        readOne(sceneLit, decodeHalfFloatRgba),
        readOne(sceneColor, decodeHalfFloatRgba),
        readOne(sceneColoration, decodeHalfFloatRgba),
        readOne(occlusionMaskRT, decodeByteRgba),
        // Attachment 1 of scene.color — see the header. `rgba` decodes to
        // [floorIndex/255, outdoors01, presenceBits/255, solidity]; multiply R
        // by 255 to read the floor index back as an integer.
        readOne(sceneColor, decodeByteRgba, 1),
      ]);
      return { worldX, worldY, pixel, onScreen, buffers: { illum, lit, albedo, coloration, occlusion, attr } };
    }

    /** One distinct, high-contrast colour per probe point — index 1..3, wraps if ever called with more. */
    const PROBE_MARKER_COLORS = ['#ff3b30', '#34c759', '#0a84ff'];

    // LIVE PROBE MARKER TRACKING (2026-07-22, author-reported: "old points
    // become visible when using the tool... we don't need to track old
    // points indefinitely"). Every container drawProbeMarkers creates is
    // tracked here so a NEW probe session can wipe whatever the LAST one
    // left on screen immediately, instead of waiting out its own 30s timer —
    // without this, running the pixel/wind probe more than once inside 30s
    // (routine during an actual debugging session) leaves stale markers from
    // an earlier round visually overlapping the current one. Cleared at the
    // START of every top-level probe entry point (armInteractivePixelProbe,
    // runProbeOnPoints, armInteractiveWindProbe, runWindProbeOnPoints) — a
    // NEW session always starts from a clean slate; markers still accumulate
    // normally WITHIN one session (each interactive click adds one, via its
    // own drawProbeMarkers call, same as before).
    let liveProbeMarkerContainers = [];
    function clearProbeMarkers() {
      for (const el of liveProbeMarkerContainers) {
        try {
          el.remove();
        } catch (err) {
          log.error('probe marker cleanup failed — a stray DOM node may linger until its own 30s timeout:', err);
        }
      }
      liveProbeMarkerContainers = [];
    }

    /**
     * Draw numbered probe markers over the canvas for 30s — thin crosshair +
     * thin circle (author's own requirement: "must be thin and minimal, you
     * need to be able to see what I'm pointing at accurately") + a
     * deliberately CHUNKIER numbered badge offset to the side (so it never
     * covers the exact probed pixel). Lets a screenshot taken right after a
     * `probePixels` call be matched, point-for-point, against the JSON
     * report it returned.
     *
     * DOM-only, appended as a sibling of `canvas` inside the SAME `mount.
     * host`, positioned by PERCENTAGE of the canvas's own box — safe
     * because `canvas.style` (this function's own module, above) already
     * sizes the canvas to `width:100%;height:100%` of `mount.host` with
     * `position:absolute;inset:0`; mirroring that exact recipe for this
     * overlay means percentage coordinates line up with the canvas with NO
     * devicePixelRatio or `getBoundingClientRect()` math needed (both
     * already ruled out as bug sources for the render itself, so avoided
     * here too, on principle). `pointer-events:none` throughout — a debug
     * overlay must never steal a click from Foundry (same discipline
     * `canvas.style` itself already documents for the real canvas).
     * Self-removing via `setTimeout`; never throws if `document` is absent
     * (Node/test contexts).
     *
     * @param {Array<{index:number, xPercent:number, yPercent:number}>} points
     */
    function drawProbeMarkers(points) {
      if (typeof document === 'undefined' || !mount?.host || !points.length) return;
      const container = document.createElement('div');
      container.dataset.msaProbeOverlay = 'true';
      Object.assign(container.style, { position: 'absolute', inset: '0', zIndex: '15', pointerEvents: 'none' });
      for (const p of points) {
        const color = PROBE_MARKER_COLORS[(p.index - 1) % PROBE_MARKER_COLORS.length];
        const wrap = document.createElement('div');
        Object.assign(wrap.style, { position: 'absolute', left: `${p.xPercent}%`, top: `${p.yPercent}%` });

        const circle = document.createElement('div');
        Object.assign(circle.style, {
          position: 'absolute',
          left: '-11px',
          top: '-11px',
          width: '22px',
          height: '22px',
          borderRadius: '50%',
          border: `1px solid ${color}`,
          boxSizing: 'border-box',
        });

        const hLine = document.createElement('div');
        Object.assign(hLine.style, {
          position: 'absolute',
          left: '-8px',
          top: '-0.5px',
          width: '16px',
          height: '1px',
          background: color,
        });

        const vLine = document.createElement('div');
        Object.assign(vLine.style, {
          position: 'absolute',
          left: '-0.5px',
          top: '-8px',
          width: '1px',
          height: '16px',
          background: color,
        });

        // The chunkier numbered badge — the ONE deliberately non-minimal
        // element, offset up-and-right so it labels the point without ever
        // sitting on top of the exact probed pixel.
        const badge = document.createElement('div');
        badge.textContent = String(p.index);
        Object.assign(badge.style, {
          position: 'absolute',
          left: '14px',
          top: '-22px',
          minWidth: '18px',
          height: '18px',
          lineHeight: '18px',
          padding: '0 4px',
          borderRadius: '9px',
          background: color,
          color: '#fff',
          fontWeight: '700',
          fontSize: '12px',
          fontFamily: 'system-ui, sans-serif',
          textAlign: 'center',
          boxShadow: '0 0 0 1px rgba(0,0,0,0.6)',
        });

        wrap.appendChild(circle);
        wrap.appendChild(hLine);
        wrap.appendChild(vLine);
        wrap.appendChild(badge);
        container.appendChild(wrap);
      }
      mount.host.appendChild(container);
      liveProbeMarkerContainers.push(container);
      setTimeout(() => {
        container.remove();
        // Drop it from the tracking array too — clearProbeMarkers() would
        // otherwise try to .remove() an already-removed node forever
        // (harmless, since .remove() on a detached node is a no-op, but the
        // array would grow unbounded over a long session).
        liveProbeMarkerContainers = liveProbeMarkerContainers.filter((el) => el !== container);
      }, 30000);
    }

    /**
     * Project a world position to a percentage-of-canvas screen coordinate —
     * the same NDC/pixel math `sampleOnePixel` uses, minus the GPU readback
     * (placement verification needs a position, not a pixel VALUE, so there
     * is no render-target sample to wait on). Pure geometry against the
     * CURRENT view; a caller wanting live tracking through a pan/zoom must
     * re-call this, which `drawWorldMarkers` deliberately does NOT do itself
     * (see that function's header for why).
     * @param {number} worldX @param {number} worldY
     * @returns {{onScreen:boolean, xPercent:number, yPercent:number}}
     */
    function worldToScreenPercent(worldX, worldY) {
      if (!view) return { onScreen: false, xPercent: 0, yPercent: 0 };
      const worldRect = viewToWorldRect(view, canvasW / canvasH);
      const ndc = worldToNdc({ x: worldX, y: worldY }, worldRect);
      const onScreen = ndc.x >= -1 && ndc.x <= 1 && ndc.y >= -1 && ndc.y <= 1;
      const pixel = ndcToPixel(ndc, drawBufW, drawBufH);
      return { onScreen, xPercent: (pixel.x / drawBufW) * 100, yPercent: (pixel.y / drawBufH) * 100 };
    }

    /**
     * Draw a ONE-SHOT teardrop marker at each given world position — the Tier-0
     * candle-placement proof (author, 2026-07-20: "see if the new renderer will
     * correctly pick up old scene candle placement first"). A pure CSS teardrop
     * (a circle with one corner square, rotated 45°) at each point; every marker
     * shares `drawProbeMarkers`'s exact recipe (DOM sibling of `canvas` inside
     * `mount.host`, percentage-positioned, `pointer-events:none`, self-removing).
     *
     * DELIBERATELY STATIC, not per-frame-tracked: this file's animation loop
     * (`renderer.setAnimationLoop(renderFrame)`) is the most-incident-prone code
     * in the project (device-loss history, the floor-switch redraw collision —
     * memory keyhole-floor-switch-canvas-redraw-collision) and a placement PROOF
     * does not need to survive a pan — take the screenshot, compare to the
     * anchors report (same positions, so they line up point-for-point), done.
     * A live-tracking overlay is a real, larger feature (a per-frame DOM
     * reposition loop) deferred to when the candle's actual draw lands.
     *
     * Silently caps at 2000 markers (a DOM-flood guard, not a real limit — no
     * scene has anywhere near that many candles) and no-ops without `document`
     * (Node/test contexts), exactly like `drawProbeMarkers`.
     *
     * @param {Array<{x:number, y:number}>} points - world positions.
     * @param {{color?:string, sizePx?:number, ttlMs?:number}} [opts]
     * @returns {{drawn:number, offScreen:number}}
     */
    function drawWorldMarkers(points, opts = {}) {
      const { color = '#ffaa00', sizePx = 7, ttlMs = 30000 } = opts;
      if (typeof document === 'undefined' || !mount?.host) return { drawn: 0, offScreen: 0 };
      const list = (Array.isArray(points) ? points : []).slice(0, 2000);
      const container = document.createElement('div');
      container.dataset.msaWorldMarkerOverlay = 'true';
      Object.assign(container.style, { position: 'absolute', inset: '0', zIndex: '15', pointerEvents: 'none' });
      let drawn = 0;
      let offScreen = 0;
      for (const p of list) {
        const proj = worldToScreenPercent(p.x, p.y);
        if (!proj.onScreen) {
          offScreen++;
          continue;
        }
        const drop = document.createElement('div');
        Object.assign(drop.style, {
          position: 'absolute',
          left: `${proj.xPercent}%`,
          top: `${proj.yPercent}%`,
          width: `${sizePx}px`,
          height: `${sizePx}px`,
          marginLeft: `${-sizePx / 2}px`,
          marginTop: `${-sizePx}px`, // the flame's round base sits AT the candle; it tapers UP to a point
          background: color,
          // CSS teardrop: a square with one sharp corner (bottom-left) + three
          // rounded. rotate(135deg) turns the sharp corner UP, so the flame
          // points up (round base down, at the wick) and reads as a flame.
          borderRadius: '50% 50% 50% 0',
          transform: 'rotate(135deg)',
          boxShadow: '0 0 0 1px rgba(0,0,0,0.6)',
        });
        container.appendChild(drop);
        drawn++;
      }
      mount.host.appendChild(container);
      setTimeout(() => container.remove(), ttlMs);
      return { drawn, offScreen };
    }

    // ---------------------------------------------------------------------
    // THE LIVE MARKER OVERLAY (2026-07-20, author: "a diagnostic UI would
    // actually be very useful for this module... generically useful for all
    // effects"). Upgrades the one-shot `drawWorldMarkers` proof into a
    // continuously-tracked overlay: a `requestAnimationFrame` loop, entirely
    // INDEPENDENT of `renderer.setAnimationLoop`/`renderFrame` (it touches no
    // render target, no pass, no THREE object — pure DOM position writes), so
    // this file's actual render pipeline is untouched. `getPoints` is injected
    // by the caller (boot wires it to diag/marker-overlay.js's registry) —
    // this file knows nothing about anchors, effects, or candles; it only
    // knows how to project a world position and keep a DOM node pinned to it.
    // ---------------------------------------------------------------------
    let liveMarkerRafId = null;
    let liveMarkerContainer = null;
    let liveMarkerGetPoints = null;

    function tickLiveMarkers() {
      if (!liveMarkerGetPoints) return; // stopped mid-flight (a stray queued frame)
      let points;
      try {
        points = liveMarkerGetPoints() ?? [];
      } catch (err) {
        log.error('live marker overlay: getPoints threw — pausing this tick, not the loop:', err);
        points = [];
      }
      const wraps = liveMarkerContainer.children;
      // Rebuild only when the count changes (a floor switch, an effect
      // toggling off) — otherwise just move the existing nodes. A per-frame
      // full DOM rebuild for a few hundred points would be needless churn.
      if (wraps.length !== points.length) {
        liveMarkerContainer.replaceChildren();
        for (const p of points) {
          const drop = document.createElement('div');
          Object.assign(drop.style, {
            position: 'absolute',
            width: '7px',
            height: '7px',
            marginLeft: '-3.5px',
            marginTop: '-7px',
            background: p.color ?? '#ffaa00',
            // See drawWorldMarkers: rotate(135deg) = sharp corner up = flame
            // points up, round base at the wick (the world position).
            borderRadius: '50% 50% 50% 0',
            transform: 'rotate(135deg)',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.6)',
            display: 'none', // shown below once positioned, avoiding a frame at (0,0)
          });
          liveMarkerContainer.appendChild(drop);
        }
      }
      for (let i = 0; i < points.length; i++) {
        const proj = worldToScreenPercent(points[i].x, points[i].y);
        const drop = liveMarkerContainer.children[i];
        drop.style.display = proj.onScreen ? '' : 'none';
        if (proj.onScreen) {
          drop.style.left = `${proj.xPercent}%`;
          drop.style.top = `${proj.yPercent}%`;
        }
      }
      liveMarkerRafId = requestAnimationFrame(tickLiveMarkers);
    }

    /**
     * Arm the live overlay: `getPoints` is called every animation frame and
     * must be CHEAP (a wrapper over an already-served list, per diag/marker-
     * overlay.js's contract) — never a fresh computation, since this runs at
     * display refresh rate for as long as the overlay is armed. Replaces any
     * previously-armed overlay (idempotent re-arm, not a leak).
     * @param {() => Array<{x:number, y:number, color?:string}>} getPoints
     */
    function startLiveMarkers(getPoints) {
      stopLiveMarkers();
      if (typeof document === 'undefined' || typeof requestAnimationFrame === 'undefined' || !mount?.host) return;
      liveMarkerGetPoints = getPoints;
      liveMarkerContainer = document.createElement('div');
      liveMarkerContainer.dataset.msaLiveMarkerOverlay = 'true';
      Object.assign(liveMarkerContainer.style, {
        position: 'absolute',
        inset: '0',
        zIndex: '15',
        pointerEvents: 'none',
      });
      mount.host.appendChild(liveMarkerContainer);
      liveMarkerRafId = requestAnimationFrame(tickLiveMarkers);
    }

    /** Disarm the live overlay — safe to call whether or not one is armed. */
    function stopLiveMarkers() {
      if (liveMarkerRafId != null && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(liveMarkerRafId);
      liveMarkerRafId = null;
      liveMarkerGetPoints = null;
      try {
        liveMarkerContainer?.remove();
      } catch (err) {
        log.error('live marker overlay container removal failed — a stray DOM node may leak:', err);
      }
      liveMarkerContainer = null;
    }

    /**
     * Shared core of `probePixels`/`runInteractivePixelProbe`: sample up to
     * `PROBE_MARKER_COLORS.length` world points and draw their markers in
     * one batch. Factored out so the console-driven and click-driven probe
     * flows run the EXACT same sampling/marking logic, never two
     * slightly-diverging copies of it.
     *
     * Each point after the first also gets `deltaFromPrev` (see
     * `diffProbeBuffers`'s own header) — an automatic point-N-vs-point-(N-1)
     * diff across every buffer/channel, with the single biggest jump called
     * out. This is the exact by-hand comparison that found
     * `keyhole-region-discard-noop-bug` and the region-aware-ambient seam,
     * now computed for free on every multi-point probe instead of requiring
     * a human to line up two JSON blobs and subtract. Whether a flagged jump
     * is a BUG or an intentional edge (a light's own falloff boundary, a
     * region's authored edge) is for the investigator to judge from where
     * the points were placed — this only surfaces the number.
     * @param {Array<{x:number, y:number}>} points
     */
    async function runProbeOnPoints(points) {
      clearProbeMarkers(); // a NEW probe session starts clean — see this file's own doc on liveProbeMarkerContainers
      const list = (Array.isArray(points) ? points : []).slice(0, PROBE_MARKER_COLORS.length);
      const results = [];
      const markers = [];
      for (let i = 0; i < list.length; i++) {
        const p = list[i] ?? {};
        const sample = await sampleOnePixel(p.x, p.y);
        const index = i + 1;
        const prev = results[results.length - 1] ?? null;
        const deltaFromPrev = prev ? diffProbeBuffers(prev.buffers, sample.buffers) : null;
        results.push({ index, ...sample, deltaFromPrev });
        if (sample.onScreen && sample.pixel) {
          markers.push({
            index,
            // sample.pixel is in device pixels (see sampleOnePixel) — divide
            // by the same unit so the percent lands at the right on-screen spot.
            xPercent: (sample.pixel.x / drawBufW) * 100,
            yPercent: (sample.pixel.y / drawBufH) * 100,
          });
        }
      }
      drawProbeMarkers(markers);
      return results;
    }

    /**
     * THE INTERACTIVE PIXEL PROBE (2026-07-19, author-requested: "I want to
     * click on the screen and set the points... a button to activate pixel
     * probe and the ability to click on the screen to set the three
     * points"). Arms a WINDOW-level, CAPTURE-phase `pointerdown` listener
     * for up to `maxPoints` clicks, converting each click's viewport
     * position to a world position via `clientToNdc`/`ndcToWorld`
     * (scene/world-quad.js — both Node-tested, the exact algebraic inverse
     * of the world→pixel chain the readback itself already uses), drawing
     * an IMMEDIATE numbered marker per click so a click registering is
     * never a silent, uncertain thing.
     *
     * DELIBERATELY does NOT call `preventDefault()`/`stopPropagation()` and
     * NEVER touches `canvas.style.pointerEvents` — "Foundry owns all input"
     * is a LOCKED decision (keyhole-input-model-decision), and this stays
     * inside it: it OBSERVES a click without consuming it, so Foundry's own
     * handling of that same click (selecting whatever is under the cursor,
     * etc.) still happens exactly as it would if this tool did not exist —
     * a real, expected side effect of probing while armed (a developer
     * using a debug tool, not a player mid-game), not a bug.
     *
     * Times out 90s after arming (not per-click) so an abandoned probe
     * cannot leave a listener attached forever; resolves with however many
     * points WERE collected, never rejects — a partial probe (1 or 2
     * points) is still useful, not an error.
     *
     * @param {number} [maxPoints=3]
     * @returns {Promise<Array<{x:number, y:number}>>}
     */
    function armInteractivePixelProbe(maxPoints = 3) {
      clearProbeMarkers(); // a NEW probe session starts clean — see liveProbeMarkerContainers' own doc
      return new Promise((resolve) => {
        const points = [];
        let settled = false;
        let timeoutId = null;
        const finish = () => {
          if (settled) return;
          settled = true;
          window.removeEventListener('pointerdown', onPointerDown, true);
          if (timeoutId) clearTimeout(timeoutId);
          resolve(points);
        };
        const onPointerDown = (e) => {
          const rect = canvas.getBoundingClientRect();
          const worldRect = viewToWorldRect(view, canvasW / canvasH);
          const ndc = clientToNdc(e.clientX, e.clientY, rect);
          const world = ndcToWorld(ndc, worldRect);
          const index = points.length + 1;
          points.push(world);
          // Immediate per-click feedback, keyed to THIS click's own screen
          // position (not re-derived from the world position later) so it
          // lands exactly under the cursor regardless of any camera motion
          // between now and when the final readback recomputes pixel coords.
          drawProbeMarkers([
            {
              index,
              xPercent: ((e.clientX - rect.left) / Math.max(1, rect.width)) * 100,
              yPercent: ((e.clientY - rect.top) / Math.max(1, rect.height)) * 100,
            },
          ]);
          if (points.length >= maxPoints) finish();
        };
        window.addEventListener('pointerdown', onPointerDown, true);
        timeoutId = setTimeout(finish, 90000);
      });
    }

    /**
     * THE WIND + PARTICLE PROBE (2026-07-21) — the pixel-probe's own pattern
     * (`diag/pixel-probe.js`'s header: "the load-bearing instrument for 'the
     * math is right but the picture is wrong'") applied to wind. Born from a
     * live report this exact investigation could not settle by reasoning
     * alone: interior rooms reading "awash with energy" right after Wind.md
     * Tier 1.5 (wake turbulence) shipped, while exterior particles still
     * glued to a windward wall. For each of up to `PROBE_MARKER_COLORS.length`
     * world points, this reports BOTH ground truths side by side:
     *   - the CPU-side bake's own decomposition (`diag/wind-probe.js#
     *     decomposeWindAt`) — `openness` (0/1, geometry-only) and the
     *     resulting `coherentTotal`, plus `paintedExposureForReference` (see
     *     that function's own header for why this does NOT influence wind
     *     — it is shown purely to contrast against `openness`) —
     *     synchronous, no GPU round-trip, always "what SHOULD be true here."
     *   - the ACTUAL nearest live particles' GPU state
     *     (`effects/particles/particle-runtime.js#readbackNearestParticles`)
     *     — "what the kernel ACTUALLY computed nearby," anchored to the
     *     clicked point instead of a semi-random strided sample.
     * A mismatch between the two is the same species of smoking gun that
     * found fix-12/13 in the particle engine's own history — two independent
     * sources of truth disagreeing points at a WIRING bug, not a tuning
     * question.
     *
     * `maskLive` (2026-07-22, pre-rethink) — added after a live report showed
     * a sealed room reading full painted exposure at the SAME point, even
     * after the mask-driven rebake trigger (`pollMaskAuthorityForWindRebake`)
     * landed. STALE POST-RETHINK: this cross-check no longer matters for WIND
     * (the painted mask has zero influence on it now — that was the whole
     * point), but it still answers a genuinely useful, separate question —
     * "is the mask-authority cache fresh" — for shading/rain-occlusion, the
     * mask's remaining real jobs. `maskLive` bypasses mask-authority's own
     * cache entirely — a FRESH `mask-authority.sampleWorld('outdoors', ...)`
     * call made right now, plus which floor was actually queried and whether
     * THAT floor's mask was ever discovered at all.
     *
     * `layerLoadErrors` (2026-07-22) — added after `maskLive` itself showed
     * `outdoorsIngested:false` despite a real discovered URL: discovery
     * (finding a file) and a pack actually LOADING (fetch + decode) are
     * separate steps, and `buildPack`'s own catch already records exactly
     * this failure mode (`_active.getDiagnostics().layerLoadErrors`, the
     * SAME data the "vt-pan-viewer-layers" debug report shows) — folded in
     * here so the answer to "why didn't it ingest" doesn't need a second
     * report. Global (not per-point) — the SAME array on every point.
     *
     * @param {Array<{x:number, y:number}>} points - world positions.
     * @returns {Promise<Array<object>>}
     */
    async function runWindProbeOnPoints(points) {
      clearProbeMarkers(); // a NEW probe session starts clean — see liveProbeMarkerContainers' own doc
      const list = (Array.isArray(points) ? points : []).slice(0, PROBE_MARKER_COLORS.length);
      const results = [];
      const markers = [];
      // PACK LOAD FAILURES (2026-07-22) — a live report showed a mask file
      // genuinely discovered (a real URL) but never ingested (`maskLive.
      // outdoorsIngested:false`). `_active.getDiagnostics().layerLoadErrors`
      // is the EXISTING mechanism (vt-pan-viewer.js's own `buildPack` catch,
      // already surfaced in the "vt-pan-viewer-layers" debug report) that
      // records exactly this — a mask layer that threw while loading, with
      // the real error message, per item. Folding it in here means the
      // answer to "why didn't it ingest" is in the SAME pasteable report,
      // not a second button to click. Called ONCE (not per point) —
      // getDiagnostics() does a real GPU readback (gl.readPixels + a full
      // indirection-buffer scan per its own doc), the same cost the
      // existing debug button already pays, but it must never run per-point.
      const layerLoadErrors = _active?.getDiagnostics ? (_active.getDiagnostics().layerLoadErrors ?? []) : [];
      for (let i = 0; i < list.length; i++) {
        const p = list[i] ?? {};
        const index = i + 1;
        let wind;
        if (windHandle.hasBake) {
          const ambient = ambientVectorFromWind({
            directionDeg: uWindDirectionDeg.value,
            speed01: uWindSpeed01.value,
          });
          wind = decomposeWindAt({
            x: p.x,
            y: p.y,
            ambientX: ambient.x,
            ambientY: ambient.y,
            // The grid spec + the raw per-cell arrays, from the ONE handle —
            // `decomposeWindAt` wants them as one flat object, which is a
            // shape concern of the probe's own report, not a second copy of
            // the data (there is only one array here, borrowed, never cloned).
            openness: { ...windHandle.grid, ...windHandle.cells },
            // Reference-only cross-check (2026-07-22, THE RETHINK) — the
            // painted mask no longer influences wind AT ALL; this is here
            // purely so a report can show "the paint says X but geometry
            // says Y, and Y is what the wind actually does" side by side,
            // the exact confusion the rethink exists to end.
            paintedExposure: sampleWindExposureAt(p.x, p.y),
          });
        } else {
          wind = { ok: false, reason: 'no wind bake has run yet' };
        }
        const particles = particleEngine
          ? await particleEngine.readbackNearestParticles(renderer, p.x, p.y, 12)
          : { ok: false, reason: 'particle engine not constructed yet (scene not loaded far enough)' };
        // LIVE cross-check (2026-07-22) — see this function's own header for
        // why: `wind.exposure` above is wind's CACHED snapshot; this is a
        // FRESH mask-authority query made right now, at this exact point, so
        // a report can tell "the cache is stale" apart from "the live value
        // is ALSO this, so the cache isn't the problem" in one paste.
        const maskLive = probeMaskAuthorityLiveAt(p.x, p.y);
        results.push({ index, world: { x: p.x, y: p.y }, wind, particles, maskLive, layerLoadErrors });
        const proj = worldToScreenPercent(p.x, p.y);
        if (proj.onScreen) markers.push({ index, xPercent: proj.xPercent, yPercent: proj.yPercent });
      }
      drawProbeMarkers(markers);
      return results;
    }

    /**
     * THE INTERACTIVE WIND+PARTICLE PROBE — click-to-set points, mirroring
     * `armInteractivePixelProbe` above STRUCTURALLY (same click-capture/
     * timeout/marker-feedback shape) but kept as its OWN, separate function
     * rather than a shared helper: that function is live, author-confirmed,
     * working code this session cannot re-verify in a browser, and the
     * duplication here is small and self-contained (CONVENTIONS.md §4 — do
     * not refactor working GPU/DOM code you cannot test live for a marginal
     * DRY gain). Same "never steals a click from Foundry" discipline: no
     * `preventDefault`/`stopPropagation`, no touching `canvas.style.
     * pointerEvents` (keyhole-input-model-decision).
     *
     * @param {number} [maxPoints=3]
     * @returns {Promise<Array<{x:number, y:number}>>}
     */
    function armInteractiveWindProbe(maxPoints = 3) {
      clearProbeMarkers(); // a NEW probe session starts clean — see liveProbeMarkerContainers' own doc
      return new Promise((resolve) => {
        const points = [];
        let settled = false;
        let timeoutId = null;
        const finish = () => {
          if (settled) return;
          settled = true;
          window.removeEventListener('pointerdown', onPointerDown, true);
          if (timeoutId) clearTimeout(timeoutId);
          resolve(points);
        };
        const onPointerDown = (e) => {
          const rect = canvas.getBoundingClientRect();
          const worldRect = viewToWorldRect(view, canvasW / canvasH);
          const ndc = clientToNdc(e.clientX, e.clientY, rect);
          const world = ndcToWorld(ndc, worldRect);
          const index = points.length + 1;
          points.push(world);
          drawProbeMarkers([
            {
              index,
              xPercent: ((e.clientX - rect.left) / Math.max(1, rect.width)) * 100,
              yPercent: ((e.clientY - rect.top) / Math.max(1, rect.height)) * 100,
            },
          ]);
          if (points.length >= maxPoints) finish();
        };
        window.addEventListener('pointerdown', onPointerDown, true);
        timeoutId = setTimeout(finish, 90000);
      });
    }

    _active = {
      THREE,
      renderer,
      canvas,
      onResize,
      itemStates,
      occlusionMask,
      cache,
      /** GROUND TRUTH for particle-wind debugging: read the ACTUAL GPU particle
       * velocities back and report whether they vary per-cell (the field is
       * reaching the kernel) or are uniform (it is not). See
       * particle-runtime.js#readbackVelocities. Async (a GPU readback). */
      async getParticleReadback(n = 32) {
        if (!particleEngine)
          return { skipped: true, reason: 'particle engine not constructed (scene not loaded far enough)' };
        return { ...particleEngine.debugState(), ...(await particleEngine.readbackVelocities(renderer, n)) };
      },
      /** Console-callable: probe the wind field + nearest particles at explicit
       * world points (no click). See `runWindProbeOnPoints`'s own header. */
      async probeWindAndParticles(points) {
        return runWindProbeOnPoints(points);
      },
      /** Debug-panel/console-callable: arm click-to-set-point mode, then run the
       * SAME wind+particle probe on whatever was clicked. See
       * `armInteractiveWindProbe`'s own header. */
      async runInteractiveWindProbe(maxPoints = 3) {
        const points = await armInteractiveWindProbe(maxPoints);
        return runWindProbeOnPoints(points);
      },
      /** Perf lab: arm/disarm the gated GPU-completion probe (diag/gpu-probe.js). */
      setGpuProbe(on) {
        gpuProbe.setActive(on);
      },
      /**
       * Perf profile: arm/disarm PER-PASS GPU timing (diag/gpu-zone-timer.js).
       *
       * Unlike `setGpuProbe`, this does NOT throttle the render loop — timestamp
       * queries are recorded by the GPU itself and read back asynchronously, so
       * the picture keeps moving at full rate while it measures. That is the
       * whole reason it is worth having beside the coarse whole-frame probe.
       */
      setGpuZoneTimer(on) {
        if (!gpuZoneTimer) return { skipped: true, reason: 'no profiler seam was passed to this viewer' };
        if (on) return { armed: gpuZoneTimer.arm(), support: gpuZoneTimer.support };
        gpuZoneTimer.disarm();
        return { armed: false, support: gpuZoneTimer.support };
      },
      /** Perf profile: what the GPU zone timer can and did measure. */
      getGpuZoneStatus() {
        return gpuZoneTimer ? gpuZoneTimer.getStatus() : { method: 'none', capable: false, reason: 'no profiler seam' };
      },
      /** Perf profile: renderer.info counters, for per-zone draw-call deltas. */
      readRenderInfo() {
        const size = renderer.getDrawingBufferSize(new THREE.Vector2());
        return {
          drawCalls: renderer.info?.render?.drawCalls ?? 0,
          triangles: renderer.info?.render?.triangles ?? 0,
          width: size.width,
          height: size.height,
          pixelRatio: renderer.getPixelRatio?.() ?? 1,
        };
      },
      /**
       * Perf profile: the RAW frame-gap series and hitch log for the current
       * rolling window.
       *
       * The diagnostics object already exposes percentiles, but a histogram and
       * the 60-bucket shape series need the population, not a summary of it —
       * and re-deriving percentiles from a second, differently-sampled source
       * would produce two numbers that disagree about the same session. One
       * ring, read raw, summarised in exactly one place (diag/perf-report.js).
       */
      readFrameSamples() {
        return {
          gapSamples: frameGapTimes.slice(),
          hitches: hitchLog.slice(),
          hitchThresholdMs: HITCH_THRESHOLD_MS,
          cpuEncodeMsAvgLast120: frameTimes.length
            ? Math.round((frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length) * 100) / 100
            : null,
        };
      },
      /** Perf lab: clear the FELT rolling windows (frameGapTimes/hitchLog). These
       * are a single shared window across the whole session, not per-config — a
       * sweep that read them without clearing would smear one config's felt
       * numbers with whatever came before (an earlier config, or the GPU probe's
       * own throttled skip-ticks, which would otherwise show up as fake
       * multi-second "hitches"). Does NOT touch frameTimes (CPU-encode) or the
       * GPU probe's own samples (gpuProbe.setActive already clears those on its
       * own OFF→ON edge). `lastFrameStartMs = null` so the very next tick after
       * a reset doesn't compute a gap spanning the reset itself. */
      resetFrameStats() {
        frameGapTimes.length = 0;
        hitchLog.length = 0;
        lastFrameStartMs = null;
      },
      /** Tear down buf:scene.color + the present chain (see disposeActive). */
      disposeSceneColor() {
        allocator.dispose(sceneColor);
        presentMaterial.dispose();
        // NOT presentQuad.geometry — QuadMesh shares ONE module-level
        // QuadGeometry across every QuadMesh in the process
        // (three.webgpu.js:49456, `var _geometry2 = new QuadGeometry()`).
        // Disposing it would break every other fullscreen pass three runs.
      },
      /** Tear down light.accumulate's targets + materials (see disposeActive).
       * Geometry is the shared QuadGeometry — never disposed, same as present. */
      disposeLighting() {
        allocator.dispose(sceneIllum);
        allocator.dispose(sceneLit);
        allocator.dispose(sceneColoration);
        for (const mip of bloomMips) allocator.dispose(mip);
        envLight.illumMaterial.dispose();
        // THE SKY GATE - a real DataTexture (up to one texel per mask cell), so
        // it leaks VRAM per scene switch if it is not freed with its materials.
        outdoorsTexture?.dispose();
        outdoorsTexture = null;
        // The grade's identity LUT placeholder (a real Data3DTexture).
        lutPlaceholder?.dispose?.();
        presentMaterial.dispose?.();
        envLight.compositeMaterial.dispose();
      },
      /** Tear down scene.sunShadow + the bake material + the caster height
       * texture (sun-shadow-subsystem.js's own dispose). */
      disposeSunShadows() {
        sunShadows.dispose();
      },
      /** Tear down water.body + the two jump-flood ping-pong targets + the
       * three bake materials + the mask DataTexture (water-body-subsystem.js's
       * own dispose). Same per-Stop/Restart VRAM-leak reasoning as every other
       * entry in this list — three RGBA16F world-space targets is the largest
       * single allocation water makes. */
      disposeWaterBody() {
        waterSurface.dispose();
        fluidSurface.dispose();
        waterBody.dispose();
      },
      /** Tear down SHINE's two meshes, their shared geometry, both
       * NodeMaterials and the uploaded `_Specular` DataTexture. That texture is
       * the largest single allocation this effect makes (~13 MB RGBA at
       * `SPECULAR_MASK_IMAGE_SCALE` on a 10k map), so a missed dispose here is a
       * per-Stop/Restart leak of exactly the size the mask-image module's own
       * header budgets for. */
      disposeSpecular() {
        specularSurface.dispose();
      },
      /** SHINE's own state — for the debug report. `visible: false` with a
       * loaded mask means the resolved floor has no painted metal (the honest
       * "nothing to draw"); `maskImage: 'not loaded'` means no `_Specular` file
       * exists for it at all, which is inert BY DESIGN. `outdoorsGate`/
       * `floorGate` report which branches actually COMPILED — both are silent
       * on screen if they did not, which is precisely why they are reported. */
      getSpecularInfo: () => specularSurface.getStatus(),
      /** Tear down WINDOW LIGHT's mesh, its geometry, both NodeMaterials and
       * the uploaded `_Window` DataTexture — same shape as `disposeSpecular`,
       * same reason: a missed dispose here is a per-Stop/Restart texture leak. */
      disposeWindowLight() {
        windowSurface.dispose();
      },
      /** WINDOW LIGHT's own state — for the debug report. `visible: false`
       * with a loaded mask means the resolved floor painted no window light
       * (the honest "nothing to draw"); `maskImage: 'not loaded'` means no
       * `_Window` file exists for it at all, inert BY DESIGN. `floorGate`
       * reports whether that branch actually COMPILED — silent on screen if
       * it did not, which is precisely why it is reported. */
      getWindowLightInfo: () => windowSurface.getStatus(),
      /** Tear down the candle flame billboard's own mesh/material/geometry (its
       * lights live in the shared pool, freed by disposePointLights). */
      disposeCandleFlame,
      /** Tear down every door leaf mesh + cached door texture (door-graphics.js). */
      disposeDoorGraphics,
      /** Wind field debug overlay (diag/wind-field-overlay.js, Wind.md Tier 0):
       * arm/disarm the live arrow grid. Off by default. */
      setWindFieldOverlayEnabled,
      /** Wind DIAGNOSTIC particles (particle-runtime.js, relabeled from "ambient
       * dust" 2026-07-22) — arm/disarm the mote cloud. Off by default; the
       * companion visualization to the arrow overlay just above. */
      setWindDiagnosticParticlesEnabled,
      /** Wind Gusts (gust-runtime.js) — arm/disarm the ribbon-trail effect that
       * whooshes through the windiest parts of the map. Off by default. */
      setWindGustsEnabled,
      /** 1..4 samples per grid square, per axis — a stress-testable preview
       * of Wind.md's real fieldResolution knob. */
      setWindFieldOverlayResolution,
      /** Tear down the wind overlay's own mesh/material/geometry. */
      disposeWindFieldOverlay,
      /** Wind.md Tier 1 — set the live ambient direction/speed AND re-bake
       * the structure correction to match (see setWindAmbient's own header). */
      setWindAmbient,
      /** THE DAY CLOCK (world/day-clock.js) — the astrolabe's control surface.
       * `setTimeOfDay` snaps, `sweepTimeOfDay` walks there; `setTimeRate` is
       * game-hours per real minute (0 = frozen, the default); `setTimeMode`
       * picks 'aesthetic' (MSA owns the hour) or 'synced' (Foundry's world
       * clock owns it). NONE of them writes `game.time` — see day-clock.js. */
      setTimeOfDay,
      sweepTimeOfDay,
      setTimeRate,
      setTimeMode,
      /** Remove the `pauseGame`/`updateWorldTime` listeners — teardown only. */
      disposeTimeWatches,
      /** Alias for setTimeOfDay, kept so existing notes/habits still work. */
      setSunHour,
      /** Cloud cover 0..1 — a real authored value now (sky settings), feeding
       * BOTH the sky light and the shadow handle from one number. */
      setCloudCover,
      /** The sky-light lever, 0..1. 0 = exact Foundry parity. */
      setSkyRealism,
      /** The environmental grade strength, 0..1 (the ToD/weather look + cloud
       * desaturation). 0 = neutral. docs/planning/Grade.md. */
      setGradeEnvStrength,
      /** Rebuild the sky's `_Outdoors` gate for a floor (floor switch). */
      bakeOutdoorsTexture,
      /** Re-read walls/doors and re-bake without touching direction/speed —
       * for after a live wall/door edit (no auto-invalidation hook yet). */
      bakeWindField,
      /** Wind.md Tier 2 — register a door-gust impulse from a wall segment
       * (world px). See triggerWindDoorImpulse's own header. */
      triggerWindDoorImpulse,
      /** Perf-lab / debug override — force the transient sim to keep
       * ticking regardless of active impulses, so its GPU cost is
       * measurable through the normal sweep mechanism. */
      setWindForceThaw,
      /** A live status readout — thawed/frozen, active impulse count, and
       * how much longer the sim will keep ticking — for the debug panel's
       * own report action (feedback_instruments_must_not_lie: this must be
       * a real read of the state above, never a guess). */
      getWindSimStatus() {
        const nowMs = uGlobalTimeMs.value;
        return {
          thawed: windForceThaw || nowMs < windThawUntilMs,
          forcedThaw: windForceThaw,
          activeImpulseCount: windActiveImpulses.length,
          thawRemainingMs: Math.max(0, Math.round(windThawUntilMs - nowMs)),
          gridCols: windHandle.grid?.cols ?? null,
          gridRows: windHandle.grid?.rows ?? null,
          windHandleVersion,
          simMaterialsBuilt: !!windSimMaterials,
        };
      },
      /** Tear down Tier 2's own ping/pong/publish RTs + solid mask + materials. */
      disposeWindSim,
      /** Tear down every point-light mesh/material/geometry — now
       * `pointLights.dispose()` (effects/lighting/point-light-pool.js,
       * extraction step 3). Kept as a same-named method here so
       * `disposeActive`'s own call site needs no change. */
      disposePointLights() {
        pointLights.dispose();
      },
      /** Tear down every region-darkness mesh's OWN material (see
       * disposeActive). Unlike point lights, every region mesh SHARES
       * `regionQuadGeometry` (one static unit quad, no per-instance vertex
       * data — see updateRegionDarknessMeshes' own header) — disposed ONCE,
       * not per-entry. */
      disposeRegionDarknessMeshes() {
        for (const [key, entry] of regionMeshes) {
          try {
            entry.material.dispose();
          } catch (err) {
            log.error(`region-darkness material dispose failed for '${key}' — VRAM may be leaked:`, err);
          }
        }
        regionMeshes.clear();
        try {
          regionQuadGeometry.dispose();
        } catch (err) {
          log.error('region-darkness shared geometry dispose failed — VRAM may be leaked:', err);
        }
      },
      /** Tear down buf:occlusion + every disc mesh/material (see disposeActive). */
      disposeOcclusionMask() {
        allocator.dispose(occlusionMask.rt);
        for (const entry of occlusionDiscs.values()) {
          try {
            entry.material.dispose();
          } catch (_) {}
        }
        occlusionDiscs.clear();
        occlusionDiscGeometry.dispose();
      },
      /**
       * ORIENTATION SELF-TEST — real pixels, through the real chain.
       *
       * Renders diag/orientation-probe's asymmetric four-corner pattern into
       * the SAME buf:scene.color the map uses, presents it through the SAME
       * QuadMesh, then reads the actual pixels back off the target and asks
       * `diagnoseOrientation` what it sees. Not "does it look right to you" —
       * a named expectation and a measured value.
       *
       * Reads back from the RT rather than the canvas on purpose: a canvas
       * readback needs `preserveDrawingBuffer` and can legitimately return all
       * zero when called from a click handler (that exact false alarm cost a
       * debugging round on 2026-07-15). The RT is stable and readable on both
       * backends — which is why §"the readback path both backends implement".
       */
      async runOrientationSelfTest() {
        // ⚠️ ROUND 2 REDESIGN (2026-07-17) — read this before touching the
        // pattern-generation code below.
        //
        // Round 1 built the pattern as ONE fullscreen quad with a branching
        // TSL shader (nested `select()`/`.and()`/`.lessThan()` picking a
        // colour per screen quadrant). The result: one corner read an EXACT,
        // fully-saturated hit — but the WRONG colour, not a clean permutation
        // — and the other three read faint, muddy values matching none of the
        // four defined colours. That shape (one clean hit + mush, not a clean
        // swap) does not fit a single coordinate bug; it is consistent with
        // TWO things going wrong at once, and blind shader-branching is
        // exactly the code this project's own standing warning
        // (memory: reference_tsl_method_chaining_trap — the `.mix()` bug that
        // cost a session) says to distrust until checked against source.
        // `select()`'s argument order and `.and()`'s semantics WERE checked
        // (three.webgpu.js:35276 ConditionalNode, :34860/34899 `and`) and
        // both are correct — so that specific trap is ruled out, but a
        // branching shader is still more moving parts than this diagnostic
        // needs, and "more moving parts than needed" is itself the risk.
        //
        // Redesigned to remove everything not load-bearing: FOUR SEPARATE
        // quads, one flat, unbranched colour each, positioned by explicit NDC
        // vertex coordinates under the SAME orthographic camera convention
        // QuadMesh itself uses (-1,1,1,-1,0,1 — NDC y=+1 is top BY
        // DEFINITION of that camera, not by interpretation of a shared
        // geometry's uv scheme). A flat `fragmentNode = vec4(r,g,b,1)` is
        // about as low-risk as GPU code gets: one node, no chaining, no
        // per-pixel branching to get subtly backwards.
        //
        // ALSO ADDED: the defensive renderer-state reset the deleted
        // graph/fullscreen-present.js's own header called out as necessary
        // ("scissor off, viewport to logical size, opaque clear... to avoid
        // stale-underlay artifacts") and which this file's fresh TSL present
        // pass never carried over. Cheap, safe, and exactly the kind of stale
        // GL/GPU state this project has been bitten by before (the
        // texture-unit-cache staleness bug from the original VT viewer
        // build — see keyhole-stage-status memory, Round 5).
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, sceneColor.width, sceneColor.height);

        const probeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const probeScene = new THREE.Scene();
        const probeMats = [];
        for (const c of PROBE_CORNERS) {
          const mat = new THREE.NodeMaterial();
          mat.depthTest = false;
          mat.depthWrite = false;
          // `colorNode`, NOT `fragmentNode` (scene.color's MRT build): a
          // `fragmentNode` material bypasses the MRT branch entirely, leaving
          // the new `attr` attachment's write undefined. Same visual result
          // for a flat unlit quad, and it picks up the safe zero-default.
          mat.colorNode = THREE.TSL.vec4(c.rgb[0] / 255, c.rgb[1] / 255, c.rgb[2] / 255, 1);
          probeMats.push(mat);
          // NDC mapping, stated so it can be checked: NDC y=+1 is the TOP of
          // this camera's frustum by definition (top param = 1). v=0 (this
          // corner's OWN stated "top" convention) must therefore map to
          // ndcY=+1, and v=1 to ndcY=-1 — i.e. ndcY = 1 - v*2.
          const ndcX = c.u * 2 - 1;
          const ndcY = 1 - c.v * 2;
          const half = 0.18; // a visible box, comfortably clear of every other corner's box
          const geo = new THREE.BufferGeometry();
          geo.setAttribute(
            'position',
            new THREE.Float32BufferAttribute(
              [
                ndcX - half,
                ndcY + half,
                0,
                ndcX - half,
                ndcY - half,
                0,
                ndcX + half,
                ndcY - half,
                0,
                ndcX - half,
                ndcY + half,
                0,
                ndcX + half,
                ndcY - half,
                0,
                ndcX + half,
                ndcY + half,
                0,
              ],
              3
            )
          );
          probeScene.add(new THREE.Mesh(geo, mat));
        }

        // 1. Draw the pattern into buf:scene.color — the geometry.world slot.
        // Same MRT scoping discipline as runGeometryWorldPass (never leave
        // it set) — scene.color is a real 2-attachment target now.
        const probePreviousMRT = renderer.getMRT();
        renderer.setMRT(sceneAttrZeroMrt);
        renderer.setRenderTarget(sceneColor);
        renderer.setClearColor(0x000000, 1);
        renderer.clear(true, true, true);
        renderer.render(probeScene, probeCamera);
        renderer.setRenderTarget(null);
        renderer.setMRT(probePreviousMRT);

        // 2. Read the REAL pixels back out of it.
        const w = sceneColor.width;
        const h = sceneColor.height;
        const found = {};
        const measured = {};
        for (const c of PROBE_CORNERS) {
          // ⚠️ ROUND 2 CORRECTION. This used to be `(1 - c.v) * (h-1)`,
          // reasoning "readRenderTargetPixels' buffer is bottom-left-origin
          // like classic OpenGL". Round 1's live result contradicted that: one
          // corner read an EXACT hit at the diagonally-opposite-in-Y position.
          //
          // `readRenderTargetPixelsAsync` is NOT one of three's own
          // texture-SAMPLING calls (those go through the `isFlipY()`
          // mechanism this file already cites) — it is a raw GPU memory copy
          // (`encoder.copyTextureToBuffer`, three.webgpu.js:70950-71012).
          // WebGPU's copy origin follows the SAME top-left fragment-coordinate
          // convention as Vulkan/D3D12/Metal (its own backends): row 0 is the
          // TOP of the rendered image, not the bottom. That is the OPPOSITE of
          // classic OpenGL, which is what the original comment assumed.
          //
          // Confidence note, stated honestly rather than presented as another
          // certainty: this is documented WebGPU/Vulkan/D3D12 API behaviour,
          // not a single line grep'd from this vendored bundle the way the
          // isFlipY()/QuadGeometry findings were — but it is corroborated by
          // the actual Round 1 failure pattern, which is exactly what
          // inverting this ONE line predicts. If this is STILL wrong, the
          // improved probe (four solid, well-separated boxes, no shader
          // branching) will now say so as a CLEAN Y-flip rather than mush —
          // the diagnosis logic already knows how to name that.
          const px = Math.round(c.u * (w - 1));
          const py = Math.round(c.v * (h - 1));
          // ⚠️ readRenderTargetPixelsAsync RETURNS the pixel data — it does NOT
          // write into a passed-in buffer. Verified against source after this
          // first read every corner as black (three.webgpu.js:62303, and its
          // real WebGPU-path implementation at 70950: `return new
          // typedArrayType(buffer3)`). The first cut of this probe passed an
          // 8th `buf` argument that the signature does not have — silently
          // ignored — then read that never-written buffer back as the result.
          // The render was correct the whole time; only the readback was blind.
          const raw = await renderer.readRenderTargetPixelsAsync(sceneColor, px, py, 1, 1, 0, 0);
          // ⚠️ AND: an RGBA16F target's real bytes are raw half-float bit
          // patterns, returned as a Uint16Array (WebGPUTextureUtils.
          // _getTypedArrayType: `RGBA16Float -> Uint16Array`) — not something a
          // 0..1 read can use directly. Decoded with THREE.DataUtils.
          // fromHalfFloat rather than a hand-rolled bit-twiddle: three already
          // has this exact, tested function; writing a second one is how a
          // decode bug becomes two decode bugs that disagree.
          const r = THREE.DataUtils.fromHalfFloat(raw[0]);
          const g = THREE.DataUtils.fromHalfFloat(raw[1]);
          const b = THREE.DataUtils.fromHalfFloat(raw[2]);
          const r8 = Math.round(Math.min(1, Math.max(0, r)) * 255);
          const g8 = Math.round(Math.min(1, Math.max(0, g)) * 255);
          const b8 = Math.round(Math.min(1, Math.max(0, b)) * 255);
          measured[c.name] = { rgb: [r8, g8, b8], readAt: { x: px, y: py } };
          found[c.name] = classifyPixel(r8, g8, b8);
        }

        // Each corner built its OWN geometry (unlike the QuadMesh present
        // pass, these are NOT three's shared module-level QuadGeometry — safe
        // to dispose every one of them).
        for (const obj of probeScene.children) {
          obj.geometry?.dispose();
        }
        for (const mat of probeMats) mat.dispose();
        const verdict = diagnoseOrientation(found);

        // 3. Put the map back. The probe scribbled over buf:scene.color; the
        // next renderFrame redraws it, but do not leave the screen showing a
        // test pattern if the loop happens to be paused.
        renderer.setRenderTarget(sceneColor);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        presentQuad.render(renderer);

        return {
          ok: verdict.ok,
          diagnosis: verdict.diagnosis,
          expected: Object.fromEntries(PROBE_CORNERS.map((c) => [c.name, c.label])),
          found,
          measured,
          note: 'Rendered through the REAL buf:scene.color + the REAL present QuadMesh. If this says ok, the geometry.world -> present.composite chain is upright.',
        };
      },

      /** buf:scene.color's live shape — for the diagnostics report. */
      getSceneColorInfo: () => ({
        allocated: !!sceneColor,
        name: sceneColor?.name ?? null,
        width: sceneColor?.width ?? 0,
        height: sceneColor?.height ?? 0,
        // Proof the law is genuinely in the path, not just imported.
        throughAllocator: true,
        screenSized: true,
        megapixels: sceneColor ? +((sceneColor.width * sceneColor.height) / 1e6).toFixed(2) : 0,
        // RGBA16F = 8 bytes/texel. §4.2 budgets ~24MB at 3MP; this is the real number.
        estMB: sceneColor ? +((sceneColor.width * sceneColor.height * 8) / 1048576).toFixed(1) : 0,
      }),

      /** graph/run-frame.js's plan for this viewer's geometry..present stage
       * range, and what it actually ran last frame — the pass runner's own
       * proof-of-life for the diagnostics report. */
      getFramePlanInfo: () => ({
        available: true,
        range: { fromStage: 'masks', toStage: 'present' },
        planned: framePlan.ids,
        skipped: framePlan.skipped,
        ranLastFrame: lastFramePlanRan,
      }),

      /**
       * THE DIAL STATE — a lean, per-frame read for the astrolabe, kept
       * separate from `getEnvSnapshotInfo` below on purpose: that one assembles
       * the whole Diagnostics blob (fresh Foundry reads, the shadow atmosphere,
       * source/reason strings) and the dial repaints every frame. Nine numbers,
       * all already computed, no allocation beyond the literal.
       * `null` before the first frame — the caller simply skips a repaint.
       */
      getTimeDialState: () => {
        if (!lastEnvSnapshot) return null;
        const { env, dayClock: clock } = lastEnvSnapshot;
        return {
          todHour: env.time.todHour,
          phase: env.sun.phase,
          rising: env.sun.rising,
          mode: clock?.mode ?? 'aesthetic',
          canSetHour: clock?.canSetHour !== false,
          rateHoursPerMinute: clock?.rateHoursPerMinute ?? 0,
          windDirectionDeg: env.wind.directionDeg,
          windSpeed01: env.wind.speed01,
          timeScale: lastEnvSnapshot.timeScale ?? 1,
          paused: lastEnvSnapshot.paused === true,
        };
      },

      /** frame.snapshot's real res:env third, live — for the Diagnostics
       * report. `status:'future'` here mirrors graph/passes.js's own status
       * for this pass: res:view/res:scene are not built, so the pass as
       * declared is not fully live even though this piece genuinely is. */
      getEnvSnapshotInfo: () => {
        if (!lastEnvSnapshot) return { available: false, status: 'future' };
        return {
          available: true,
          status: 'future', // graph/passes.js's frame.snapshot — see this file's own header note
          env: lastEnvSnapshot.env,
          darknessSource: lastEnvSnapshot.darkness.source,
          darknessReason: lastEnvSnapshot.darkness.reason,
          ambientSource: lastEnvSnapshot.ambient?.source ?? null,
          ambientReason: lastEnvSnapshot.ambient?.reason ?? null,
          todHourSource: lastEnvSnapshot.todHourSource,
          // THE DAY CLOCK + THE PAUSE RAMP — reported so "why is nothing
          // moving" and "why is the sun there" are answerable from one report.
          // `foundryPaused` is read fresh rather than remembered: if it and
          // `timeScale` ever disagree for longer than the ramp, the watch has
          // come unhooked, and a report that could not show that would be a
          // lying instrument.
          dayClock: lastEnvSnapshot.dayClock ?? null,
          timeScale: lastEnvSnapshot.timeScale ?? null,
          simPaused: lastEnvSnapshot.paused ?? null,
          foundryPaused: readGamePaused(),
          pauseRampSeconds: DEFAULT_PAUSE_RAMP_SEC,
          // THE SKY THE SHADOW HANDLE RESOLVED (2026-07-23) — the SAME
          // atmosphere every caster reads, surfaced so "why is that shadow so
          // soft" is answerable from one report instead of by guessing. The
          // source fields name whether a value is a real input or a debug lever,
          // so a lever can never be mistaken for a real source.
          cloudSource: lastEnvSnapshot.cloudSource ?? null,
          shadowAtmosphere: lastEnvSnapshot.shadow ?? null,
          // THE SKY LIGHT (docs/planning/Sky.md), reported in full because "is
          // it doing anything" was previously answerable only by eyeballing the
          // rendered map — and a report that cannot show a mis-wired feature is
          // indistinguishable from one confirming it works
          // (feedback_instruments_must_not_lie). Four independent questions,
          // each of which can fail alone:
          //   1. is the gate even COMPILED into the shader (skyGateCompiled) —
          //      false only if the viewer started with no outdoorsTexture at
          //      all, which never happens today (always at least the placeholder).
          //   2. did a REAL mask ever load, or is it still the 1×1 fully-
          //      outdoors placeholder (outdoorsBake — `null` = never attempted,
          //      `ok:false` = the mask authority threw or returned nothing,
          //      `ok:true` = a real grid is bound, with its cols/rows/rect).
          //   3. what NUMBER the handle currently computes
          //      (ambientMultiplierRgb) — at realism 0 it MUST read exactly
          //      [1,1,1]; if realism is >0 and it still reads that, the lever
          //      never reached the handle.
          //   4. what the lever/weather inputs actually WERE this frame.
          sky: {
            realism01: skyRealism01,
            cloudCover01: lastEnvSnapshot.env.weather.cloudCover01,
            ambientMultiplierRgb: skyHandle.ambientMultiplierRgb,
            neutral: skyHandle.neutral,
            gateCompiled: envLight.skyGateCompiled,
            outdoorsBake: lastOutdoorsBakeResult,
          },
          // THE GRADE (docs/planning/Grade.md) — the env grade RESOLVED this
          // frame (so "is the cloud desaturation actually happening" is one
          // read: saturation<1 under cloud means yes), its strength lever, the
          // artistic look, and whether the outdoor gate compiled. Same
          // instruments-must-not-lie bar as the sky block above.
          grade: {
            envStrength: gradeEnvStrength,
            envResolved: scaleGradeToIdentity(resolveEnvGrade(lastEnvSnapshot.env), gradeEnvStrength),
            // The artistic (Look) grade effect: on/off + its tone-map curve, so
            // "is a film response active" is answerable from the report.
            artEnabled: getGradeLookState()?.enabled === true,
            artToneMapping: getGradeLookState()?.params?.toneMapping ?? null,
            gateCompiled: gradePresent.gateCompiled,
          },
          notYetBuilt: ['res:view', 'res:scene'],
        };
      },

      /** masks.occlusion's real (RADIAL-only) producer state — for the
       * Diagnostics report. `activeDiscs` counting LESS than `poolSize` is
       * normal (hidden, not disposed — see occlusionDiscs' own doc); the two
       * numbers only diverging AT ALL confirms the pool is genuinely being
       * reconciled, not just growing. */
      getOcclusionMaskInfo: () => ({
        available: true,
        scope: 'RADIAL only — FADE/VISION inert, SURFACE (the roof-over-token default) needs Regions, not built',
        elevationTable: occlusionMask.elevationTable,
        visionActive: occlusionMask.visionActive,
        rt: { width: occlusionMask.rt.width, height: occlusionMask.rt.height },
        poolSize: occlusionDiscs.size,
        activeDiscs: [...occlusionDiscs.values()].filter((e) => e.mesh.visible).length,
      }),
      /** light.accumulate's point-light (tier-0) producer state — for the
       * Diagnostics report. `activeLights` counting LESS than `poolSize` is
       * normal (hidden, not disposed — see lightMeshes' own doc); the two
       * numbers only diverging AT ALL confirms the pool is genuinely being
       * reconciled, not just growing. `ambientColors`/`globalLightFloor` are
       * the LAST-APPLIED values (tracked in runLightAccumulatePass), not a
       * recomputed guess. `globalLightFloor: null` distinguishes "not active
       * this frame" (disabled, or outside its darkness window) from "active
       * but computed to black" (luminosity 0 — a real, if unhelpful, Foundry
       * default) — collapsing those two would be exactly the lying-instrument
       * class this project has already paid for once. */
      getPointLightsInfo: () => {
        // ONE real, visible light's ACTUAL current uniform values — added
        // 2026-07-19 to chase the "lights read monochrome" report down to a
        // measured number instead of a guess (feedback_instruments_must_not_
        // lie / feedback_plausible_diagnosis_rots). `edgeSoftMarginFraction`
        // is what actually reaches the shader as uEdgeSoftMargin — if this
        // is NOT a small fraction of 1 (it should be roughly 0.01-0.25 for
        // ordinary lights), the soft-edge term is starving the light's own
        // bright/dim colour almost everywhere, not just at its true edge.
        let sampleLight = null;
        // AGGREGATE across every active light (2026-07-19, chasing a report
        // that removing coloration for colourless lights — tried two ways,
        // neither touching anything else — took a live scene from "visible,
        // desaturated" to "fully black"). ONE sampled light can't show
        // whether that's "most of this scene's lights are colourless" (i.e.
        // coloration's white wash was carrying real, load-bearing brightness
        // the illumination channel alone doesn't provide for this scene's
        // darkness/attenuation settings) or something narrower. `hasColor`
        // is read off `entry.lastHasColor` (set every frame in
        // updatePointLightMeshes, diagnostic-only) rather than inferred from
        // uColorationAlpha, which is unconditional again right now — see
        // that assignment's own comment for the current (reverted) state.
        let activeCount = 0;
        let colorlessCount = 0; // hasColor === false
        let coloredCount = 0;
        let colorationAlphaSum = 0;
        // ANIMATED LIGHTS (2026-07-20) — per-type counts, tallied in the SAME
        // pass (no second walk of lightMeshes). `builtByType` counts active
        // lights whose animation resolved to a real registry entry;
        // `deferredByType` counts ones that matched KNOWN_DEFERRED_ANIMATIONS
        // (a real Foundry animation this project hasn't ported yet, for a
        // documented reason); `unrecognizedTypes` is anything else non-null —
        // a genuinely unknown string, worth surfacing rather than
        // silently folding into "no animation" (feedback_instruments_must_
        // not_lie: `skipped` must mean "nothing was skipped", never "I did
        // not look").
        const builtByType = {};
        const deferredByType = {};
        const unrecognizedTypes = {};
        for (const [id, entry] of pointLights.lightMeshes) {
          if (!entry.mesh.visible) continue;
          activeCount++;
          if (entry.lastHasColor) coloredCount++;
          else colorlessCount++;
          colorationAlphaSum += entry.uColorationAlpha.value;
          const animType = entry.animationType ?? null;
          if (animType) {
            if (entry.animationEntry) builtByType[animType] = (builtByType[animType] ?? 0) + 1;
            else if (animType in KNOWN_DEFERRED_ANIMATIONS)
              deferredByType[animType] = (deferredByType[animType] ?? 0) + 1;
            else unrecognizedTypes[animType] = (unrecognizedTypes[animType] ?? 0) + 1;
          }
          if (!sampleLight) {
            sampleLight = {
              sourceId: id,
              radiusPx: entry.mesh.scale.x,
              uRatio: entry.uRatio.value,
              uAttenuationEased: entry.uAttenuationEased.value,
              uExposure: entry.uExposure.value,
              uEdgeCount: entry.uEdgeCount.value,
              edgeSoftMarginFraction: entry.uEdgeSoftMargin.value,
              uColorationAlpha: entry.uColorationAlpha.value,
              uLightColor: [entry.uLightColor.value.x, entry.uLightColor.value.y, entry.uLightColor.value.z],
              hasColor: entry.lastHasColor,
              // SHADOW (2026-07-21) — this light's real LightData `shadows`
              // field, now actually reaching the shader. 0 = untouched; a GM
              // raising it should show up here matching what they set in
              // Foundry's own Light Config, proving the plumbing (not a guess).
              uShadows: entry.uShadows.value,
              // PER-LIGHT region-aware ambient (2026-07-19) — what THIS
              // light's own uBackgroundColor/uDim/uBright ACTUALLY read this
              // frame, not a recomputed guess. If a light sits inside a
              // DARKEN region, uBackgroundColor should read noticeably below
              // the scene-wide ambientColors.background reported alongside
              // this — if it doesn't, the per-light region lookup isn't
              // reaching this light (feedback_instruments_must_not_lie).
              uBackgroundColor: [
                entry.uBackgroundColor.value.x,
                entry.uBackgroundColor.value.y,
                entry.uBackgroundColor.value.z,
              ],
              uDimColor: [entry.uDimColor.value.x, entry.uDimColor.value.y, entry.uDimColor.value.z],
              uBrightColor: [entry.uBrightColor.value.x, entry.uBrightColor.value.y, entry.uBrightColor.value.z],
              // ANIMATED LIGHTS — null for a non-animated (or not-yet-built)
              // sample light, real numbers whenever this sample happens to
              // be an animated one. Not a guaranteed-animated sample (this
              // is still just "the first active light this pass"), so a
              // caller checking a SPECIFIC animation should read
              // animationSummary.builtByType below instead.
              //
              // GPU-ONLY (2026-07-20): `time`/flicker-noise/pulse-wave are
              // now computed ENTIRELY in-shader — there is no CPU `.value`
              // left to report for them (this is the whole point of the
              // rework: less CPU work, not just moved reporting). What's
              // still CPU-visible is exactly the raw config this pool DOES
              // write: uGlobalTimeMs (the shared clock — confirms it's
              // ticking) and this light's own speed/seed/intensity.
              animation:
                entry.animationType && entry.animationEntry
                  ? {
                      type: entry.animationType,
                      quality: entry.animationQuality ?? 0,
                      forceDefaultColor: entry.animationEntry.forceDefaultColor,
                      uGlobalTimeMs: uGlobalTimeMs.value,
                      uSpeedRaw: entry.uIllumSpeedRaw?.value ?? entry.uColorSpeedRaw?.value ?? null,
                      uSeed: entry.uIllumSeed?.value ?? entry.uColorSeed?.value ?? null,
                      uIntensityRaw: entry.uIllumIntensityRaw?.value ?? entry.uColorIntensityRaw?.value ?? null,
                    }
                  : null,
            };
          }
        }
        const colorationSummary = {
          activeCount,
          coloredCount,
          colorlessCount,
          colorlessFraction: activeCount > 0 ? colorlessCount / activeCount : null,
          meanColorationAlpha: activeCount > 0 ? colorationAlphaSum / activeCount : null,
        };
        const animationSummary = { builtByType, deferredByType, unrecognizedTypes };
        // CANDLE LIGHT BREAKDOWN (2026-07-20, chasing "perf didn't improve after
        // clustering" down to a measured number instead of a guess — the SAME
        // discipline as sampleLight/colorationSummary above). Candle-authored
        // lights carry a `candle:` sourceId prefix (effects/candle-flame-
        // render.js#buildCandleLightSources); everything else in this SAME pool
        // is a real Foundry light — they share one reconcile, so this is the
        // only way to see the split. `foundryCount` matters because clustering
        // only merges candle lights WITH EACH OTHER — if the map's original
        // author ALSO placed real Foundry AmbientLight documents at the same
        // candle positions (common in commercial map packs), those are
        // UNAFFECTED by clustering and would explain "no perf change" on their
        // own, independent of anything candle-side.
        let candleLightCount = 0;
        let foundryLightCount = 0;
        for (const id of pointLights.lightMeshes.keys()) {
          if (id.startsWith('candle:')) candleLightCount++;
          else foundryLightCount++;
        }
        // CANDLE WALL-CLIP DIAGNOSTIC (2026-07-20, the "candle light bleeds
        // through walls" fix — foundry/scene-wall-clip.js's own header).
        // Reports what ACTUALLY happened per candle (feedback_instruments_
        // must_not_lie), not "it should be working": `sweepCount` = candles
        // successfully wall-clipped via Foundry's own ClockwiseSweepPolygon;
        // `fallbackCount` = candles still on the old naive circle (the exact
        // bug this fix targets, if this is ever nonzero); `sampleReason` is
        // ONE cache entry's own `reason` string (why it fell back, or which
        // level-resolution path a successful clip used) so a live report can
        // show the true cause instead of a guess.
        let candleWallClipSweepCount = 0;
        let candleWallClipFallbackCount = 0;
        let candleWallClipSampleReason = null;
        for (const cached of pointLights.candleWallClipCache.values()) {
          if (cached.source === 'sweep') candleWallClipSweepCount++;
          else candleWallClipFallbackCount++;
          if (candleWallClipSampleReason === null) candleWallClipSampleReason = cached.reason;
        }
        const candleLightBreakdown = {
          candleLightCount,
          foundryLightCount,
          totalPoolSize: pointLights.lightMeshes.size,
          wallClip: {
            sweepCount: candleWallClipSweepCount,
            fallbackCount: candleWallClipFallbackCount,
            sampleReason: candleWallClipSampleReason,
          },
        };
        return {
          available: true,
          scope:
            'Illumination + exposure + per-light/global darkness windows + region-driven per-pixel darkness + ' +
            'coloration (default "Adaptive Luminance" technique only, MAX-blended not screen-blended). Each ' +
            "light's REAL colour is now read from source.colorRGB (was misread as undefined→white for every " +
            'light — the "black and white" root cause, fixed 2026-07-19). A colourless light contributes zero ' +
            "coloration (uColorationAlpha=0), matching Foundry's isRequired/hasColor gate. colorationSummary " +
            'below should now show mostly `coloured`; a high colorlessFraction would mean the colour read is ' +
            'still not landing. No other 12 coloration techniques, no contrast/saturation/shadow adjustments, ' +
            'no darkness sources, no elevation occlusion (docs/planning/Light-Parity.md §5). Animated lights: ' +
            'see animationSummary below for what is ACTUALLY registered right now (live, not a hardcoded ' +
            'claim here) — effects/lighting/animations/registry.js is the source of truth.',
          poolSize: pointLights.lightMeshes.size,
          activeLights: [...pointLights.lightMeshes.values()].filter((e) => e.mesh.visible).length,
          ambientColors: lastAmbientColors,
          globalLightFloor: lastGlobalLightFloor,
          gridSizePixels: lastGridSizePixels,
          // The darkness-realism lever (MapShine.setDarknessRealism): 0 =
          // Foundry parity (floor at the scene's darkness colour), 1 = true
          // dark (floor at black). `ambientColors.background` above already
          // reflects it — at realism 1 with darkness01 1 it reads ~[0,0,0].
          darknessRealism01: _darknessRealism01,
          sampleLight,
          colorationSummary,
          candleLightBreakdown,
          // ANIMATED LIGHTS (2026-07-20) — builtByType/deferredByType/
          // unrecognizedTypes are per-animation-type counts among ACTIVE
          // lights this frame; deferredKnownReasons is KNOWN_DEFERRED_
          // ANIMATIONS itself (why each deferred type isn't built yet), so
          // this report is self-explaining without cross-referencing source.
          animationSummary: { ...animationSummary, deferredKnownReasons: KNOWN_DEFERRED_ANIMATIONS },
        };
      },
      /**
       * THE WATER BODY PACK's own state — for the Diagnostics report and
       * boot's `water-body` report (docs/planning/Water.md §5.1, Phase 2).
       *
       * READ `bakes` AGAINST `polls` FIRST. That comparison IS this phase's
       * exit criterion: a healthy session shows single-digit bakes against
       * thousands of polls, because the jump flood runs only when the mask
       * version or the resolved floor moves. If the two track each other, the
       * version poll is broken and every frame is paying for a full flood —
       * the exact "bake count is not frame count" failure Water.md §5.1 names
       * in advance (`feedback_residency_sync_vs_render_loop` is the precedent).
       *
       * `resolve` is the cross-floor rule's own answer WITH its reason string
       * (§4) — a derived READOUT, never a param. `floorIndex: null` there is
       * not an error: it means no floor in this scene has an authored water
       * mask, so nothing is baked and nothing should be drawn.
       */
      getWaterBodyInfo: () => ({
        ...waterBody.getStatus(),
        // TIER 0's own state (2026-07-26). `surfaceVisible: false` with a
        // healthy bake means the mask holds no water on the resolved floor —
        // the honest "nothing to draw", distinct from a broken bake. `bounds`
        // is the water's measured world AABB, which the quad is cropped to
        // (Law 6); if it ever reads as the whole mask rect, the crop is not
        // working and water is paying fullscreen cost for a river.
        surface: waterSurface.getStatus(),
      }),
      /**
       * FLUID's own chain state — every link, so "why do I see nothing" is
       * answered by reading ONE report rather than by another round trip with
       * the author. This exists because the effect shipped invisible twice:
       * once unwired entirely, once looking for its mask on the wrong KIND of
       * host (a floor, when the tubes were painted on a tile).
       */
      getFluidStatus: () => fluidSurface.getStatus(),
      /** region-darkness's own pool state — for the Diagnostics report.
       * `activeRegions` should be > 0 whenever the scene has a visible,
       * non-hidden, elevation-band-matching region with an active "Adjust
       * Darkness Level" behavior in view (elevation gating landed 2026-07-19
       * — a region scoped to a different floor no longer appears here at
       * all, which is correct, not a bug, if you're expecting to see it and
       * don't: check which floor is currently viewed). `scope` names the
       * SAME simplifications region-darkness.js's own header documents
       * (union-not-CSG/no holes, missing cone/ring/line/emanation shapes) —
       * not a recomputed claim. Overlap resolution and elevation gating are
       * BOTH fixed as of 2026-07-19 (min-composite; per-floor band filter). */
      getRegionDarknessInfo: () => {
        // Added 2026-07-19 while chasing "everything outside the light
        // radius is perfect pixel black" (the real cause turned out to be
        // an autoClear bug in light.accumulate's own render sequence, NOT
        // regions — see runLightAccumulatePass's own header). Kept: this
        // instrument was genuinely useful for the SEPARATE regions audit
        // that followed once that bug was fixed and regions could finally
        // be evaluated for real (elevation gating + overlap resolution,
        // both corrected the same day — see this function's own scope
        // string). Reports what EACH active region ACTUALLY computes, using
        // the SAME applyDarknessAdjustment + mix the shader runs, so a
        // wrong result shows up as a measured value instead of a guess.
        //
        // `geometry` (added 2026-07-19, round 2 of the same chase — the
        // "one specific room isn't darkening" report): `meshCenter`/
        // `meshScale` alone were NOT enough to answer "does this region
        // actually cover world position (x,y)?" — for a rectangle,
        // `computeShapeMeshBounds` centers the MESH on the shape's own
        // ORIGIN CORNER (not its true center) and sizes it to the full
        // diagonal in every direction (a deliberately generous, conservative
        // bound for POSITIONING the quad, never the true footprint) — reading
        // `meshCenter` as "the middle of the shape" undersells how far off
        // that reasoning can be without the real width/height/anchor/rotation
        // too. `geometry` reports the ACTUAL live uniform values driving the
        // shader's own containment test THIS frame (whichever ones this
        // shape's kind has — a rectangle has uOrigin/uSize/uAnchor/
        // uRotationRad, a ring has uInnerRadius/uOuterRadius, etc.) — reading
        // straight off the uniforms themselves, not a separately-tracked
        // shape copy, so it can never drift from what the GPU is really doing.
        const uDaylight = [uRegionDaylightColor.value.x, uRegionDaylightColor.value.y, uRegionDaylightColor.value.z];
        const uDarkness = [uRegionDarknessColor.value.x, uRegionDarknessColor.value.y, uRegionDarknessColor.value.z];
        const regions = [];
        for (const [key, entry] of regionMeshes) {
          if (!entry.mesh.visible) continue;
          const mode = entry.uMode.value;
          const modifier = entry.uModifier.value;
          const baseDarkness01 = entry.uBaseDarkness01.value;
          const adjusted = applyDarknessAdjustment(baseDarkness01, mode, modifier);
          const resultColor = mixRgb(uDaylight, uDarkness, adjusted);
          const geometry = {};
          for (const [uniformName, uniformNode] of Object.entries(entry)) {
            if (!uniformName.startsWith('u') || uniformName === uniformName.toLowerCase()) continue;
            if (['uMode', 'uModifier', 'uBaseDarkness01', 'uDaylightColor', 'uDarknessColor'].includes(uniformName))
              continue;
            const v = uniformNode?.value;
            if (v == null) continue;
            geometry[uniformName] = typeof v === 'object' && 'x' in v && 'y' in v ? [v.x, v.y] : v;
          }
          regions.push({
            key,
            kind: entry.kind,
            mode,
            modifier,
            baseDarkness01,
            adjustedDarkness01: adjusted,
            resultColor,
            meshCenter: [entry.mesh.position.x, entry.mesh.position.y],
            meshScale: [entry.mesh.scale.x, entry.mesh.scale.y],
            geometry,
          });
        }
        return {
          available: true,
          scope:
            'rectangle/ellipse/circle/polygon/cone/ring/line/emanation shapes, hole (subtraction) support — ' +
            'all built 2026-07-19 (see keyhole-region-shapes-and-holes-build memory). Elevation-band-gated ' +
            'against the currently viewed floor, and overlaps resolved by MIN (brightest) adjusted value. ' +
            "NONE of the shape/hole GPU work has been live-verified in a browser before this session's own " +
            "live checks — region-darkness.js's own header has the full citations.",
          poolSize: regionMeshes.size,
          activeRegions: regions.length,
          // ⚠️ READ THIS BEFORE `regions`. `failedOpen: true` means the viewed
          // floor's elevation band could not be resolved, so EVERY region in the
          // scene is active regardless of which floor it belongs to — an upper
          // floor's darkness lands on the one you are looking at, in building-
          // shaped patches that read exactly like a broken shadow. `dropped: 0`
          // with `failedOpen: false` is the healthy single-floor answer.
          elevationGating: lastRegionGating ?? 'not yet evaluated',
          // The shared uniforms EVERY region's material actually reads —
          // if either of these is near [0,0,0], that alone is the bug
          // (a region overwrites its footprint with mix(daylight,darkness,
          // adjusted); a zeroed daylight or darkness endpoint reaches black
          // regardless of `adjusted`'s own value).
          uDaylight,
          uDarkness,
          // Per-region breakdown — look for resultColor near [0,0,0] on a
          // region whose meshScale is large (a big/generous bound covering
          // much of the visible frame, per computeShapeMeshBounds' own
          // "diagonal, not half-diagonal" generous-bound design) — that
          // combination is what would read as "everything outside the
          // light radius is black". Use `geometry` (see this function's own
          // header) to check whether a SPECIFIC world position is actually
          // inside a shape, not just near its mesh's bounding quad.
          regions,
        };
      },
      /**
       * PIXEL-READBACK DIAGNOSTIC (2026-07-19, the region-darkness rendering
       * audit) — reads the ACTUAL rendered value of EVERY screen-sized
       * compositor buffer (illum/lit/albedo/coloration/occlusion/attr) at ONE
       * world position, straight off the GPU, bypassing every CPU-side
       * computation `getRegionDarknessInfo` reports. Built because that
       * function proved a region's MATH is correct (right shape, right
       * coverage, right resultColor) but could NOT answer whether that value
       * actually reached the screen — two DIFFERENT questions, and
       * conflating them is exactly the lying-instrument class this project
       * has paid for before (feedback_instruments_must_not_lie). Async —
       * WebGPU pixel readback has no synchronous path.
       *
       * World→pixel uses `worldToNdc`/`ndcToPixel` (scene/world-quad.js),
       * BOTH Node-tested there before this call trusts them — a NEW
       * world→texel mapping is exactly this project's own recurring Y-flip
       * bug class, so the pure math was verified in isolation first rather
       * than assumed correct here. Single-point, no on-screen marker — see
       * `probePixels` for the multi-point, marker-drawing version.
       *
       * `buffers.{illum,lit,albedo,coloration}` are `HalfFloatType` targets
       * decoded via `decodeHalfFloatRgba`; `buffers.occlusion` and
       * `buffers.attr` are the `UnsignedByteType` ones and are decoded via
       * `decodeByteRgba` instead (see that function's own header — same
       * 0..1-ish shape either way, so every buffer in the report reads
       * uniformly regardless of its underlying GPU format). `attr` is
       * `buf:scene.color`'s attachment 1, read with `textureIndex: 1`, and
       * carries [floorIndex/255, outdoors01, presenceBits/255, solidity] —
       * `attr.r × 255` is the floor index, `attr.a` is "was anything drawn
       * here at all". Both gate `effects/specular` by plain multiply.
       *
       * @param {number} worldX @param {number} worldY
       * @returns {Promise<{worldX:number, worldY:number, pixel:{x:number,y:number}|null,
       *   buffers: {illum:object, lit:object, albedo:object, coloration:object,
       *   occlusion:object}|null, onScreen: boolean}>}
       */
      sampleIllumPixel: async (worldX, worldY) => sampleOnePixel(worldX, worldY),
      /**
       * PROBE UP TO 3 WORLD POSITIONS AT ONCE (2026-07-19, author-requested)
       * — runs the SAME illum/lit/albedo/coloration/occlusion readback as
       * `sampleIllumPixel` for each point, numbered 1..N in call order, AND
       * draws a thin crosshair + thin circle + a chunkier numbered badge on
       * screen for every ON-SCREEN point, for 30 seconds — so a screenshot
       * taken right after this call can be matched, point-for-point, against
       * the returned report ("point 1" in the JSON is the "1" badge in the
       * screenshot). See `drawProbeMarkers`'s own header for the marker
       * styling rationale (thin/minimal so the underlying map stays legible
       * under them; the number alone is deliberately chunkier/solid).
       *
       * Point 2+ also carries `deltaFromPrev` (see `diffProbeBuffers`'s own
       * header) — an automatic diff against the PREVIOUS point in the list,
       * every buffer/channel, with the single biggest jump called out. Place
       * points straddling a suspected seam (just outside / just inside a
       * light, a region edge, an occlusion boundary) and read `deltaFromPrev`
       * first before eyeballing the full buffer dump.
       *
       * @param {Array<{x:number, y:number}>} points - 1..3 world positions;
       *   a 4th+ point is silently dropped (3 is the deliberate cap, matching
       *   the marker colour palette — see `PROBE_MARKER_COLORS`).
       * @returns {Promise<Array<{index:number, worldX:number, worldY:number,
       *   pixel:{x:number,y:number}|null, onScreen:boolean, buffers:object|null,
       *   deltaFromPrev:{perBuffer:object, biggestJump:object}|null}>>}
       */
      probePixels: async (points) => runProbeOnPoints(points),
      /**
       * THE INTERACTIVE FLOW: arm (see `armInteractivePixelProbe`'s own
       * header for the full input-model reasoning), collect up to
       * `maxPoints` clicks, then run the SAME 5-buffer readback + delta +
       * marker draw `probePixels` does for each collected point. This is
       * what the debug-panel "Pixel Probe" action button calls — click the
       * button, then click up to 3 spots on the map.
       * @param {number} [maxPoints=3]
       * @returns {Promise<Array<{index:number, worldX:number, worldY:number,
       *   pixel:{x:number,y:number}|null, onScreen:boolean, buffers:object|null,
       *   deltaFromPrev:{perBuffer:object, biggestJump:object}|null}>>}
       */
      runInteractivePixelProbe: async (maxPoints = 3) => {
        const points = await armInteractivePixelProbe(maxPoints);
        if (!points.length) return [];
        return runProbeOnPoints(points);
      },
      /**
       * THE CANDLE-PLACEMENT PROOF (Tier 0, 2026-07-20): draw a one-shot
       * teardrop at each given world position, against the CURRENT view. See
       * `drawWorldMarkers`'s own header for why this is deliberately static
       * (no per-frame pan tracking) rather than a live overlay.
       * @param {Array<{x:number, y:number}>} points
       * @param {{color?:string, sizePx?:number, ttlMs?:number}} [opts]
       * @returns {{drawn:number, offScreen:number}}
       */
      drawWorldMarkers: (points, opts) => drawWorldMarkers(points, opts),
      /**
       * THE LIVE MARKER OVERLAY — see `startLiveMarkers`'s own header. Armed
       * by the debug panel's "Live marker overlay" toggle; `getPoints` is
       * boot's closure over diag/marker-overlay.js's registry.
       * @param {() => Array<{x:number, y:number, color?:string}>} getPoints
       */
      startLiveMarkers: (getPoints) => startLiveMarkers(getPoints),
      stopLiveMarkers: () => stopLiveMarkers(),
      onKeyDown,
      onKeyUp,
      clearHeldKeys,
      floorCount,
      startupParams, // exposed so runZoomThrashTest can restart an identical fresh viewer ("blank slate")
      getView: () => view,
      applyKeyAndUpdate, // exposed so MapShine.soakHooks.pan drives the EXACT same path a real keypress does
      zoomStep, // exposed so MapShine.soakHooks.zoom drives one real, bounded, eased zoom step (see its own doc)
      setFloorIndex, // exposed so an external (Foundry-driven) floor sync is as cheap as a keypress, never a full restart
      // Re-ask buildItems and reconcile. The draw list is derived from live
      // Foundry documents, but NOTHING here watches them — updateResidency only
      // runs when the VIEW changes, so creating a token while the camera sits
      // still changed the document and never reached the screen (author-reported
      // 2026-07-16: "I drag a token into the scene area but nothing appears").
      // boot.js drives this from the document CRUD hooks.
      //
      // THROUGH scheduleResidencyUpdate, NOT updateResidency DIRECTLY (fixed
      // 2026-07-17). It used to call updateResidency() straight, which BYPASSES
      // the residencyInFlight guard — so a document change landing mid-update
      // started a SECOND concurrent updateResidency over the same itemStates,
      // cache and atlas. That is the interleaving class this file already lost
      // Rounds 4 and 5 to (see prepareForUploadBatch's history): every `await`
      // in updateResidency is a yield point where the other run can act on
      // half-updated shared state. The guard already handles this correctly —
      // it sets residencyDirty and the in-flight run loops again, so a refresh
      // is never dropped, only merged. Nothing was gained by going around it.
      refreshItems: (hookName = '(unnamed)') => {
        lastUpdate.docRefreshes++;
        lastUpdate.byHook[hookName] = (lastUpdate.byHook[hookName] ?? 0) + 1;
        return scheduleResidencyUpdate();
      },
      setDisplayLayer, // exposed so the debug panel can bind a mask for visual verification
      setIsolateItem, // "show only this draw item" — see isolateItemId's header
      getIsolateItemId: () => isolateItemId,
      getDrawListIds: () => lastItems.map((i) => ({ id: i.id, kind: i.kind, renderOrder: i.renderOrder })),
      // --- runZoomThrashTest support (2026-07-16) ---------------------------
      /** Wipe frame-gap/hitch history for a clean measurement window. */
      resetHitchTracking() {
        frameGapTimes.length = 0;
        hitchLog.length = 0;
        lastFrameStartMs = null;
      },
      /**
       * Force the eased-zoom TARGET straight to an extreme, screen-center-
       * anchored — the same mechanism a held '+'/'-' key uses (setZoomTarget),
       * just driven programmatically instead of from a keydown. The NORMAL
       * per-frame render loop (updateContinuousInputs) does all the actual
       * easing/streaming work exactly as it would for a real input — this
       * does not bypass or special-case anything the real code path does.
       * `clampHalfSpan(Infinity/0, worldSizePx)` is a clean way to reach the
       * TRUE min/max without duplicating view-state.js's private constants.
       * @param {'in'|'out'} direction
       */
      forceZoomTarget(direction) {
        targetHalfSpanPx = clampHalfSpan(direction === 'in' ? 0 : Infinity, world);
        zoomAnchorSx = canvasW / 2;
        zoomAnchorSy = canvasH / 2;
      },
      /**
       * A CHEAP zoom read, for the thrash test's per-frame loop.
       *
       * Deliberately not `getDiagnostics()`: that does a `gl.readPixels`, scans the
       * whole indirection buffer and walks every cache slot. Polling it once per
       * frame would make the measuring instrument the dominant cost — the test
       * would be reporting hitches it caused itself.
       */
      getZoomState: () => ({ halfSpanPx: view?.halfSpanPx ?? 0, targetHalfSpanPx }),
      // The full report body lives in vt-pan-viewer-diagnostics.js
      // (extraction step 5, VT-Pan-Viewer-Extraction.md) — every name below
      // is read via ordinary closure capture AT CALL TIME, so a plain value
      // (never a getter) is correct here; see that module's own header for
      // why trap #1 does not apply to a function that is called fresh every
      // time rather than constructed once.
      getDiagnostics() {
        return buildViewerDiagnostics({
          _active,
          canvas,
          loopActive,
          frameTimes,
          lastItems,
          itemStates,
          itemLoadErrors,
          cache,
          renderer,
          shaderCompileMs,
          prefetchSkippedPacks,
          lastUpdate,
          passSeq,
          tokenPassLog,
          canvasW,
          canvasH,
          drawBufW,
          drawBufH,
          pixelRatio,
          mount,
          textureLimit,
          alphaGridStats,
          sunShadows,
          envLight,
          world,
          displayLayerName,
          currentCoarseBudget,
          gpuProbe,
          frameGapTimes,
          HITCH_THRESHOLD_MS,
          hitchLog,
          lastError,
          heldPanKeys,
          panVelocity,
          targetHalfSpanPx,
          view,
        });
      },
    };

    // MSA is rendering again — a previous fallback notice must not outlive it.
    clearFoundryFallback();
    console.log(
      '[vt-pan-viewer] started — filling the scene area (PIXI occluded). Drag to pan, wheel to zoom; ' +
        'Arrow keys/WASD pan, +/- zoom, 0-2/Tab floor-switch.'
    );
    return { ok: true, ..._active.getDiagnostics() };
  } catch (err) {
    diag0.ok = false;
    diag0.fatalError = `${err?.message || err}\n${err?.stack || ''}`;
    console.error('[vt-pan-viewer] fatal error:', err);
    // THE SAFETY SLIDE (Keyhole.md §4.3): hand rendering back to Foundry so the
    // player keeps a working session, and say so unmissably. Reliability outranks
    // the visuals — an MSA that cannot draw must never be the reason a session is
    // unusable. Removing the canvas is the load-bearing part: left in place, it is
    // an opaque black rectangle sitting over a perfectly healthy Foundry canvas.
    engageFoundryFallback({
      reason: 'Its renderer threw while starting up.',
      detail: diag0.fatalError,
      canvas,
    });
    return diag0;
  }
}

/** For the debug panel: current diagnostics without restarting anything. */
export function getVtPanViewerDiagnostics() {
  if (!_active) return { active: false };
  return { active: true, ..._active.getDiagnostics() };
}

/**
 * Sync the already-running viewer to a specific floor index — CHEAP (one
 * residency update, no atlas/page-cache reallocation), the fix for the real
 * live crash described in `startVtPanViewer`'s `initialFloorIndex` doc.
 * boot.js's `canvasReady` handler calls this for a same-scene floor switch
 * instead of `startVtPanViewer`. No-op `{skipped:true}` if nothing is running
 * — the caller (boot.js) is expected to call `startVtPanViewer` first in that
 * case, this never silently starts a viewer on its own.
 * @param {number} floorIndex
 */
/**
 * Re-read the scene's documents and reconcile the draw list.
 *
 * Cheap and idempotent: the same reconcile updateResidency already does on every
 * view change, so an unchanged scene costs one buildItems call and no GPU work.
 * No-op `{skipped:true}` if nothing is running.
 */
/**
 * Re-read the live Foundry documents and reconcile the draw list.
 *
 * @param {string} [hookName] - the hook that drove this, recorded in
 *   diagnostics' `documentSync.byHook`. Not decoration: "which hook fired" was
 *   the open question a refresh COUNT could not answer (2026-07-17).
 */
export async function refreshVtPanViewerItems(hookName) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  await _active.refreshItems(hookName);
  return { refreshed: true };
}

/**
 * ORIENTATION SELF-TEST — is the geometry.world -> present.composite chain
 * upright? Real pixels, real chain, named expectations. See
 * diag/orientation-probe.js for why this exists rather than "look at it".
 *
 * Run it after ANY new screen-space or world->texture mapping lands.
 */
export async function runOrientationSelfTest() {
  if (!_active) return { skipped: true, reason: 'viewer not started — start it, then run this' };
  return _active.runOrientationSelfTest();
}

/**
 * GROUND TRUTH for particle-wind debugging (docs/planning/Particles.md §23) —
 * reads the ACTUAL GPU particle velocities back and reports whether they vary
 * per-cell (the wind field is reaching the compute kernel) or are uniform (it
 * is not, only the ambient bias is). The answer that ends the guessing.
 */
export async function getParticleReadback(n = 32) {
  if (!_active) return { skipped: true, reason: 'viewer not started — start it, then run this' };
  return _active.getParticleReadback(n);
}

export async function setVtPanViewerFloor(floorIndex) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  const changed = await _active.setFloorIndex(floorIndex);
  return { changed, ..._active.getDiagnostics() };
}

/**
 * Arm/disarm the GPU-completion probe (diag/gpu-probe.js) — the Performance Lab's
 * measurement engine. ON only during a sweep: while armed, renderFrame THROTTLES
 * to one frame in flight at a time (submit → wait for GPU completion → submit
 * next), so each sample is a genuine single frame's GPU execution time rather
 * than pipeline queue depth. That throttling visibly drops the displayed
 * framerate for the duration — expected, and why this must never be left on in
 * normal play. No-op `{skipped:true}` if nothing is running.
 * @param {boolean} on
 */
export function setVtPanViewerGpuProbe(on) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  _active.setGpuProbe(on);
  return { gpuProbe: getVtPanViewerDiagnostics().gpuProbe };
}

/**
 * Arm/disarm PER-PASS GPU timing (diag/gpu-zone-timer.js) — the real one, via
 * WebGPU timestamp queries, attributed to whichever profiler zone was open when
 * each pass ran.
 *
 * This does NOT throttle the loop the way `setVtPanViewerGpuProbe` must: the GPU
 * writes the timestamps itself and we read them back asynchronously, so the scene
 * keeps moving at full rate while it measures. No-op `{skipped:true}` if nothing
 * is running.
 * @param {boolean} on
 */
export function setVtPanViewerGpuZoneTimer(on) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  return _active.setGpuZoneTimer(on);
}

/** What the GPU zone timer can measure on this device, and what it actually did. */
export function getVtPanViewerGpuZoneStatus() {
  if (!_active) return { method: 'none', capable: false, reason: 'viewer not started' };
  return _active.getGpuZoneStatus();
}

/** `renderer.info` draw-call/triangle counters + drawing-buffer size. */
export function readVtPanViewerRenderInfo() {
  if (!_active) return null;
  return _active.readRenderInfo();
}

/** The RAW frame-gap series + hitch log, for the profile report's own binning. */
export function readVtPanViewerFrameSamples() {
  if (!_active) return null;
  return _active.readFrameSamples();
}

/**
 * Arm/disarm the wind field debug overlay (diag/wind-field-overlay.js,
 * Wind.md Tier 0) — a live grid of arrows over the current view, each
 * sampling the SAME `sampleWind()` the candle flame/light already read. Off
 * by default. No-op `{skipped:true}` if nothing is running.
 * @param {boolean} on
 */
export function setVtPanViewerWindOverlay(on) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  _active.setWindFieldOverlayEnabled(on);
  return { enabled: !!on };
}

/**
 * Arm/disarm the wind DIAGNOSTIC particle cloud (particle-runtime.js,
 * relabeled from "ambient dust" 2026-07-22 — this is a debug visualization,
 * not the mansion's future ambient-dust dressing effect). Off by default;
 * the companion to setVtPanViewerWindOverlay just above. No-op
 * `{skipped:true}` if nothing is running.
 * @param {boolean} on
 */
export function setVtPanViewerWindDiagnosticParticles(on) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  _active.setWindDiagnosticParticlesEnabled(on);
  return { enabled: !!on };
}

/**
 * Arm/disarm WIND GUSTS (effects/particles/gust-runtime.js) — a small population
 * of ribbon-trail "wind snakes" that appear only where the wind flow is genuinely
 * fast (open gales + funnel pinch-points), more and stronger as the wind rises.
 * A real atmospheric dressing effect, distinct from the diagnostic particle
 * cloud. Off by default. No-op `{skipped:true}` if nothing is running.
 * @param {boolean} on
 */
export function setVtPanViewerWindGusts(on) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  _active.setWindGustsEnabled(on);
  return { enabled: !!on };
}

/**
 * Set the wind overlay's real-cell stride — 1..4 (2026-07-23, REPURPOSED:
 * the overlay now samples the ACTUAL wind-bake grid directly, so 1 shows
 * every real cell exactly and 2..4 deliberately declutters by skipping
 * cells, rather than sub-sampling FINER than the real data ever was).
 * No-op `{skipped:true}` if nothing is running.
 * @param {number} multiplier
 */
export function setVtPanViewerWindOverlayResolution(multiplier) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  _active.setWindFieldOverlayResolution(multiplier);
  return { resolution: multiplier };
}

/**
 * Set Wind.md Tier 1's live ambient direction/speed and re-bake the
 * structure correction to match. No-op `{skipped:true}` if nothing is running.
 * @param {number} directionDeg @param {number} speed01
 */
export function setVtPanViewerWindAmbient(directionDeg, speed01) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  _active.setWindAmbient(directionDeg, speed01);
  return { directionDeg, speed01 };
}

/**
 * Set the hour of day (0..24), or `null` to reset to noon. Since 2026-07-23
 * this drives the REAL day clock (`world/day-clock.js`), not a debug lever over
 * an acknowledged gap — the sun, every shadow's direction and softness, the
 * ambient palette and the scene darkness all follow it.
 *
 * Returns `accepted: false` in `synced` mode, where Foundry's world clock is
 * the sole authority. Failing visibly beats moving a number that the next
 * `updateWorldTime` would silently overwrite.
 * @param {number|null} hour
 */
export function setVtPanViewerSunHour(hour) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  return _active.setSunHour(hour);
}

/**
 * A 1×1 fully-outdoors texture — the sky light's gate before any real mask has
 * streamed in. Module scope rather than inline so the "why a placeholder at
 * all" reasoning has one home (see its call site: the materials are built once,
 * at startup, long before a mask exists).
 * @param {*} THREE @returns {*}
 */
function makeOutdoorsPlaceholderTexture(THREE) {
  const tex = new THREE.DataTexture(
    new Uint8Array([255, 255, 255, 255]),
    1,
    1,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  tex.needsUpdate = true;
  return tex;
}

// ===========================================================================
// ALBEDO CLARITY — "when I zoom out the dark outlines get mushed and the image
// goes low-contrast; PIXI stays sharp" (author, 2026-07-28). This is the THIRD
// round on this one complaint. The mip chain and pixel-ratio parity (both
// 2026-07-19) were the first two — both real fixes, both still not enough.
//
// WHY THE FIRST TWO COULD NOT CLOSE IT. Both asked "which mip level does MSA
// sample?" and made that answer match PIXI. Neither asked what minification
// COSTS once the level is already right — and the answer is that a correctly
// prefiltered minified image is genuinely, unavoidably softer than its source.
// Each texel of a level-2 mip is the average of 16 source texels, so a one-texel
// ink outline that was solid black becomes one sixteenth of a light grey cell.
// That is not a sampler bug. It is what prefiltering IS, and PIXI pays it too.
//
// MEASURED FIRST, so this is not a fourth plausible story (memory:
// feedback_measure_the_output_not_the_equation, feedback_plausible_diagnosis_rots).
// Running the project's OWN BC1 encoder over synthetic pen art at LOD 1.4 — the
// author's actual zoom-out — against a simulated PIXI chain:
//   PIXI (gamma mips, no BC, gamma filter)   RMS contrast 44.8
//   MSA  (gamma mips, BC1,  linear filter)   RMS contrast 41.2   (-8%)
//   isolate BC1 only                         RMS contrast 48.0   (BC1 RAISES it)
//   isolate sRGB-vs-gamma filtering          RMS contrast 37.9   (-15%)
// BC1 was exonerated outright; the filtering colour space is real but small.
// The whole MSA-vs-PIXI texture-path gap is ~8% — nowhere near what the author
// is describing. So the loss is inherent to minification, and no better sampler
// can recover it. Something has to PUT THE CONTRAST BACK.
//
// THE TECHNIQUE: AMD FidelityFX CAS (Contrast Adaptive Sharpening) — the modern
// standard for precisely this. It restores local contrast without the haloing a
// plain unsharp mask produces and without amplifying flat-area noise. Its `amp`
// term eases the sharpening off as a neighbourhood approaches black or white,
// which is exactly what keeps ink outlines from ringing into haloes.
//
// THREE THINGS THAT MAKE THIS A REPAIR RATHER THAN A BLANKET SHARPEN:
//
//  1. THE KERNEL IS SCREEN-SPACE, NOT TEXTURE-SPACE. The four taps sit at
//     ±dFdx/±dFdy — exactly one OUTPUT pixel away, at every zoom. A
//     texture-space kernel would sharpen a fixed count of texels and so change
//     character as you zoom; this one always sharpens what the display actually
//     resolves. The derivatives are taken in strictly uniform control flow (no
//     branch above them): divergent-flow derivatives are undefined behaviour,
//     the trap water-body.js carries its own warning about.
//
//  2. IT ENGAGES ONLY UNDER MINIFICATION. `texelsPerPixel` is the real
//     footprint read off those derivatives, and the gate is 0 at 1:1, ramping
//     in as the art begins to minify. At or above 1:1 there is no lost detail
//     to recover and sharpening would only add ringing — which is why zoomed-in
//     views come out of this completely untouched.
//
//  3. IT SHARPENS IN A PERCEPTUAL SPACE, NOT LINEAR LIGHT. Samples arrive
//     linear (the art is an sRGB-format texture, so the hardware decodes before
//     it filters). Sharpening there would fight the eye: linear-light
//     differences are not what "contrast" means to a viewer, and dark ink on
//     light paper — the exact case in question — is where the two spaces
//     diverge hardest. A gamma-2.0 round trip (sqrt in, square out) is a
//     branch-free stand-in for sRGB at a fraction of a real transfer pair's
//     cost, and it puts the CAS maths in the same space PIXI's whole renderer
//     happens to work in.
//
// ALPHA IS DELIBERATELY LEFT ALONE. Ringing a cutout's alpha would fringe every
// prop silhouette against the floor showing through it — a worse artefact than
// the softness being repaired.
// ===========================================================================

/** Live clarity settings. ONE shared uniform pair drives every whole-image
 * material (memory: keyhole-vt-pan-viewer-extraction trap 2 — shared uniforms
 * must stay shared; per-material copies would make the setter update only
 * whichever material happened to be built last). Default ON, per
 * feedback_default_on_new_features. */
/**
 * ANISOTROPIC FILTERING for art textures — the other half of the 2026-07-28
 * zoom-out sharpness work, and free real estate WebGPU was already offering.
 *
 * Trilinear picks ONE mip level from the LARGER of the two screen-space axes,
 * so any quad whose footprint is not square gets filtered to the blurrier axis
 * and loses detail along the sharper one. That sounds academic under a top-down
 * orthographic camera — and for the floor, which is uniformly scaled, it is.
 * It is NOT academic for props: the author's own scene draws a 303x39 orrery arm
 * at 353x33 and rotates copies of it 90/180/270 degrees. Every one of those has
 * a genuinely anisotropic footprint and every one of them was being filtered as
 * if it were square.
 *
 * 16 is WebGPU's conventional ceiling and implementations clamp to what the
 * device supports, so this needs no capability query. It only takes effect when
 * min/mag/mipmap filtering are ALL linear — verified against the vendored
 * backend (three.webgpu.js's `_samplerDescriptor.maxAnisotropy` is written
 * inside exactly that guard), which every art texture here satisfies. Setting it
 * on a texture that did not satisfy it would be a silently dead knob, which is
 * the class memory:feedback_seam_default_hides_unwired exists to catch.
 */
const ART_TEXTURE_ANISOTROPY = 16;

const ALBEDO_CLARITY_DEFAULTS = {
  /** CAS sharpening strength. 0 = off; 0.2 is stock FidelityFX CAS at maximum.
   * Pen-and-ink map art tolerates — and wants — a little more than photographic
   * content, so the default sits just above stock. Range 0..0.5. */
  sharpness: 0.22,
  /** Minification (source texels per output pixel) where sharpening starts. 1.0
   * = the moment the art stops being pixel-exact. */
  gateLo: 1.0,
  /** Minification where sharpening reaches full strength. */
  gateHi: 1.8,
  /**
   * THE FAR ROLL-OFF (author, 2026-07-28: "large zoom out makes areas look a bit
   * pixelated"). Past a point, every screen pixel is showing roughly one mip
   * texel, so there is no sub-pixel detail left to recover and sharpening starts
   * emphasising the texel grid itself instead — which reads as pixelation. These
   * two ease the strength back down toward `farFloor` once minification passes
   * `farLo`, reaching it at `farHi`.
   *
   * For scale: on the author's 6750² ground, the whole map on screen is about
   * 5.4 texels per pixel, so the default keeps FULL strength through every
   * normal zoom and only backs off beyond a whole-map view.
   */
  farLo: 6.0,
  farHi: 16.0,
  /** Fraction of `sharpness` still applied at and beyond `farHi`. 1 = no
   * roll-off at all; 0 = sharpening fully off at extreme zoom-out. */
  farFloor: 0.35,
};
const _albedoClarity = { ...ALBEDO_CLARITY_DEFAULTS };
/** @type {{ sharpen: any, gate: any }|null} */
let _albedoClarityUniforms = null;

/**
 * The shared clarity uniforms, created on first use (THREE arrives by parameter
 * throughout this file — it is dynamically imported inside the factory, so a
 * module-level `uniform(...)` at load time is not available).
 * @param {*} THREE @returns {{ sharpen: any, gate: any }}
 */
function albedoClarityUniforms(THREE) {
  if (_albedoClarityUniforms === null) {
    const { uniform, float, vec4 } = THREE.TSL;
    _albedoClarityUniforms = {
      sharpen: uniform(float(_albedoClarity.sharpness)),
      // (gateLo, gateHi, farLo, farHi) — the ramp-in pair and the roll-off pair.
      gate: uniform(vec4(_albedoClarity.gateLo, _albedoClarity.gateHi, _albedoClarity.farLo, _albedoClarity.farHi)),
      farFloor: uniform(float(_albedoClarity.farFloor)),
    };
  }
  return _albedoClarityUniforms;
}

/**
 * Tune albedo clarity live — no rebuild, no scene reload (the uniforms are
 * shared, so one write reaches every item on screen).
 * @param {{sharpness?:number, gateLo?:number, gateHi?:number}} next
 * @returns {{sharpness:number, gateLo:number, gateHi:number, applied:boolean}}
 *   `applied:false` means no material has been built yet, so the values are
 *   stored and will be picked up when one is — NOT that the call was ignored
 *   (memory: feedback_instruments_must_not_lie).
 */
export function setAlbedoClarity(next = {}) {
  if (Number.isFinite(next.sharpness)) _albedoClarity.sharpness = Math.max(0, Math.min(0.5, next.sharpness));
  if (Number.isFinite(next.gateLo)) _albedoClarity.gateLo = Math.max(0, next.gateLo);
  if (Number.isFinite(next.gateHi)) _albedoClarity.gateHi = Math.max(0.01, next.gateHi);
  if (Number.isFinite(next.farLo)) _albedoClarity.farLo = Math.max(0, next.farLo);
  if (Number.isFinite(next.farHi)) _albedoClarity.farHi = Math.max(0.01, next.farHi);
  if (Number.isFinite(next.farFloor)) _albedoClarity.farFloor = Math.max(0, Math.min(1, next.farFloor));
  // Keep both ramps well-ordered whichever end the caller moved. A smoothstep
  // with hi <= lo is a hard step, which would pop as you zoom rather than fade.
  if (_albedoClarity.gateHi <= _albedoClarity.gateLo) _albedoClarity.gateHi = _albedoClarity.gateLo + 0.01;
  if (_albedoClarity.farHi <= _albedoClarity.farLo) _albedoClarity.farHi = _albedoClarity.farLo + 0.01;
  if (_albedoClarityUniforms) {
    _albedoClarityUniforms.sharpen.value = _albedoClarity.sharpness;
    _albedoClarityUniforms.gate.value.set(
      _albedoClarity.gateLo,
      _albedoClarity.gateHi,
      _albedoClarity.farLo,
      _albedoClarity.farHi
    );
    _albedoClarityUniforms.farFloor.value = _albedoClarity.farFloor;
  }
  return { ..._albedoClarity, applied: _albedoClarityUniforms !== null };
}

/** Restore every clarity control to its shipped default — the way back from a
 * tuning session that went somewhere odd. */
export function resetAlbedoClarity() {
  return setAlbedoClarity(ALBEDO_CLARITY_DEFAULTS);
}

/** Current albedo-clarity settings, plus whether they are actually bound to a
 * live material yet. @returns {{sharpness:number, gateLo:number, gateHi:number, applied:boolean}} */
export function getAlbedoClarity() {
  return { ..._albedoClarity, applied: _albedoClarityUniforms !== null };
}

/**
 * Sample `tex` through the clarity filter: five screen-space taps, CAS in a
 * perceptual space, gated to minification. See this section's header for why
 * each of those three clauses is load-bearing.
 *
 * @param {*} THREE
 * @param {*} tex - the art texture (already sRGB-decoded on sample by the
 *   hardware, so `rgb` arrives LINEAR and leaves LINEAR — this is drop-in for a
 *   bare `texture(tex, uv)` and changes nothing downstream).
 * @param {*} uvNode - the FINAL uv node (uvScale already applied).
 * @param {*} uTexSizeNode - vec2 of the texture's own texel dimensions, i.e.
 *   what `uv * this` converts a UV derivative into a texel count. For the
 *   block-compressed path that is the PADDED size, because uv 1.0 addresses the
 *   padded width — not the logical width the uvScale crops back to.
 * @returns {{rgb:any, a:any}} linear rgb + the untouched source alpha.
 */
function buildAlbedoClarityNode(THREE, tex, uvNode, uTexSizeNode) {
  const TSL = THREE.TSL;
  const { vec3, float, texture, dFdx, dFdy } = TSL;
  const { sharpen: uSharpen, gate: uGate, farFloor: uFarFloor } = albedoClarityUniforms(THREE);

  // UNIFORM CONTROL FLOW: nothing may branch above these two lines.
  const duvdx = dFdx(uvNode).toVar();
  const duvdy = dFdy(uvNode).toVar();

  // Source texels covered by one output pixel. >1 = minifying = detail is being
  // averaged away = there is something for the sharpen to put back.
  const fx = duvdx.mul(uTexSizeNode);
  const fy = duvdy.mul(uTexSizeNode);
  const texelsPerPixel = TSL.max(fx.dot(fx), fy.dot(fy)).sqrt().toVar();
  // Ramp IN as the art starts to minify, then ease back toward `farFloor` at
  // extreme zoom-out, where a screen pixel already shows about one mip texel and
  // sharpening would emphasise the texel grid rather than recover detail.
  // mix() in FUNCTION form deliberately: `a.mix(b, t)` silently evaluates as
  // mix(b, t, a) (memory: reference_tsl_method_chaining_trap).
  const rampIn = TSL.smoothstep(uGate.x, uGate.y, texelsPerPixel);
  const rollOff = TSL.smoothstep(uGate.z, uGate.w, texelsPerPixel);
  const gate = rampIn.mul(TSL.mix(float(1), uFarFloor, rollOff)).toVar();

  const c = texture(tex, uvNode).toVar();
  const sL = texture(tex, uvNode.sub(duvdx));
  const sR = texture(tex, uvNode.add(duvdx));
  const sU = texture(tex, uvNode.sub(duvdy));
  const sD = texture(tex, uvNode.add(duvdy));

  // Linear → gamma-2.0. The max() guards sqrt against a negative that a future
  // HDR-ish albedo source could introduce; on 8-bit art it never fires.
  const enc = (s) => TSL.max(s.rgb, vec3(0)).sqrt();
  const eC = enc(c).toVar();
  const eL = enc(sL);
  const eR = enc(sR);
  const eU = enc(sU);
  const eD = enc(sD);

  // CAS. `amp` is the ringing brake: it falls to zero as the neighbourhood
  // approaches black OR white, so a solid ink line next to bare paper — the
  // highest-contrast case there is — gets restored without gaining a halo.
  const mn = TSL.min(eC, TSL.min(TSL.min(eL, eR), TSL.min(eU, eD)));
  const mx = TSL.max(eC, TSL.max(TSL.max(eL, eR), TSL.max(eU, eD)));
  const amp = TSL.saturate(TSL.min(mn, vec3(1).sub(mx)).div(TSL.max(mx, vec3(1e-4)))).sqrt();

  // w is NEGATIVE (neighbours subtracted) and the reciprocal renormalises, so a
  // flat neighbourhood comes through exactly unchanged: (e + 4ew)/(1+4w) = e.
  const w = amp.mul(uSharpen).mul(gate).negate();
  const rcp = vec3(1).div(w.mul(4).add(1));
  const sharpened = eC.add(eL.add(eR).add(eU).add(eD).mul(w)).mul(rcp);

  // Gamma-2.0 → linear. Downstream sees exactly the units it always did.
  const lin = TSL.max(sharpened, vec3(0));
  return { rgb: lin.mul(lin), a: c.a };
}

/**
 * A 2³ identity 3D LUT texture — the placeholder the Colour Grade's LUT sampler
 * always compiles against, so `setLut` can later swap in a real `.cube` without
 * a shader rebuild. An identity LUT is a mathematical no-op, so it is invisible
 * until a real look is bound. `FloatType` + `LinearFilter` relies on the
 * `float32-filterable` WebGPU feature (present per the env diagnostics).
 * @param {*} THREE @returns {*}
 */
function makeIdentityLutTexture(THREE) {
  const { size, data } = identityCubeLut(2);
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.FloatType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Scalar lerp — for tinting a grade channel toward a picked colour. */
function mix1(a, b, t) {
  return a + (b - a) * t;
}

/**
 * The astrolabe's per-frame read: hour, sky phase, clock mode, wind, and the
 * pause ramp. `null` before the first frame. Cheap by design — see
 * `getTimeDialState`'s own note for why it is not `getEnvSnapshotInfo`.
 */
export function getVtPanViewerTimeDialState() {
  return _active?.getTimeDialState?.() ?? null;
}

/**
 * THE SKY-LIGHT LEVER, 0..1 (docs/planning/Sky.md §8). `0` — the default — makes
 * the outdoor light a mathematical no-op, so the pixel-identical-to-Foundry
 * parity check holds exactly. `1` is the full atmospheric model: the key/fill
 * colour split and the time-of-day recolouring of the outdoor light. (The cloud
 * DESATURATION is no longer here — a light cannot drain chroma; it is the
 * environmental grade's job, `setVtPanViewerGradeEnvStrength`.) Same proven
 * shape as `setDarknessRealism`.
 * @param {number} realism01
 */
export function setVtPanViewerSkyRealism(realism01) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  return _active.setSkyRealism(realism01);
}

/**
 * THE ENVIRONMENTAL GRADE strength, 0..1 (docs/planning/Grade.md). The
 * automatic ToD/weather look — and the cloud desaturation the sky light can't
 * do (a grade drains chroma luminance-preservingly; a light cannot). `0` =
 * neutral, the default.
 * @param {number} strength01
 */
export function setVtPanViewerGradeEnvStrength(strength01) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  return _active.setGradeEnvStrength(strength01);
}

/**
 * Sweep to an hour rather than snapping — the astrolabe's time-stop buttons.
 * @param {number} hour
 */
export function sweepVtPanViewerTimeOfDay(hour) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  return _active.sweepTimeOfDay(hour);
}

/**
 * Set how fast time of day drifts, in game-hours per real minute. `0` (the
 * default) freezes it. Aesthetic mode only — in `synced` mode Foundry's clock
 * is the only thing that moves the hour.
 * @param {number} hoursPerMinute
 */
export function setVtPanViewerTimeRate(hoursPerMinute) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  return _active.setTimeRate(hoursPerMinute);
}

/**
 * Choose which clock owns time of day: `'aesthetic'` (MSA's own, the dial
 * drives it, Foundry's clock untouched and unread) or `'synced'` (Foundry's
 * world clock drives it and the dial goes read-only). Neither mode ever WRITES
 * `game.time` — see `world/day-clock.js`'s header for why that is structural.
 * @param {string} mode
 */
export function setVtPanViewerTimeMode(mode) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  return _active.setTimeMode(mode);
}

/**
 * Cloud cover 0..1, or `null` for the clear-sky default. Since 2026-07-23 this
 * is a real authored value (`world/sky-settings.js`, per-world or per-scene),
 * not a debug lever over an acknowledged gap — it drives both the sky light's
 * colour/veil and the shadow handle's softening/fading from one number.
 * @param {number|null} cover01
 * @param {string} [source] - who is calling; `'sky-settings'` from the real
 *   pump (boot.js), left at the default for a direct console/test call. See
 *   `setCloudCover`'s own doc for why the label matters.
 */
export function setVtPanViewerCloudCover(cover01, source) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  return _active.setCloudCover(cover01, source);
}

/**
 * Re-read walls/doors and re-bake Wind.md Tier 1's structure correction,
 * WITHOUT touching the live direction/speed — for the manual debug "Rebake"
 * action AND for boot.js's automatic wall/door-change watcher
 * (`foundry/scene-walls.js#watchSceneWallStructure`). No-op `{skipped:true}`
 * if nothing is running.
 *
 * @param {string} [triggerReason] - stamped into the resulting log line as
 *   WHY this bake ran (`bakeWindField`'s own `reason` param) — defaults to
 *   'manual' (the debug button's own case) so every OTHER caller must name
 *   itself explicitly rather than silently reusing that label.
 */
export function rebakeVtPanViewerWindField(triggerReason = 'manual') {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  return _active.bakeWindField(triggerReason);
}

/**
 * Wind.md Tier 2 — register a door-gust impulse from a wall segment (world
 * px). No-op `{skipped:true}` if nothing is running.
 * @param {{x1:number,y1:number,x2:number,y2:number}} wallSegment
 */
export function triggerVtPanViewerWindDoorImpulse(wallSegment) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  return _active.triggerWindDoorImpulse(wallSegment);
}

/**
 * Perf-lab / debug override — force Tier 2's sim to keep ticking regardless
 * of active impulses. No-op `{skipped:true}` if nothing is running.
 * @param {boolean} on
 */
export function setVtPanViewerWindForceThaw(on) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  _active.setWindForceThaw(on);
  return { forcedThaw: !!on };
}

/**
 * Wind.md Tier 2's live status — thawed/frozen, active impulse count, thaw
 * time remaining. `{skipped:true}` if nothing is running (never a guessed
 * "frozen").
 */
export function getVtPanViewerWindSimStatus() {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  return _active.getWindSimStatus();
}

/**
 * Clear the FELT rolling windows (frameGapTimes/hitchLog) — see `_active.resetFrameStats`
 * for why a sweep must call this before each config's felt-sampling phase. No-op
 * `{skipped:true}` if nothing is running.
 */
export function resetVtPanViewerFrameStats() {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  _active.resetFrameStats();
  return { reset: true };
}

/**
 * Bind a different layer-pack to the display (e.g. 'Outdoors', 'Fire', or back
 * to 'albedo') — visual verification that a mask actually streamed, against the
 * fixture's known patterns. The masks stream regardless of what's displayed;
 * this only changes what you SEE. No-op `{skipped:true}` if nothing is running.
 * @param {string} name
 */
export async function setVtPanViewerDisplayLayer(name) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  const result = await _active.setDisplayLayer(name);
  return { ...result, ..._active.getDiagnostics() };
}

/**
 * Show ONLY one draw item (`''` = all). The ghost-hunting tool: see
 * `isolateItemId`'s header inside startVtPanViewer for why it exists.
 * @param {string} id
 */
export async function setVtPanViewerIsolateItem(id) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  return _active.setIsolateItem(id);
}

/**
 * Console-callable wrapper for `_active.sampleIllumPixel` — see that
 * function's own header for what it does and why (the region-darkness
 * rendering audit, 2026-07-19). Call from the browser console as
 * `await MapShine.sampleIllumPixel(worldX, worldY)`.
 * @param {number} worldX @param {number} worldY
 */
export async function sampleVtPanViewerIllumPixel(worldX, worldY) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  return _active.sampleIllumPixel(worldX, worldY);
}

/**
 * Console-callable wrapper for `_active.probePixels` — see that function's
 * own header for the full reasoning. Call as
 * `await MapShine.probePixels([{x, y}, {x, y}, {x, y}])`.
 * @param {Array<{x:number, y:number}>} points - 1..3 world positions.
 */
export async function probeVtPanViewerPixels(points) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  return _active.probePixels(points);
}

/**
 * Console/debug-panel-callable wrapper for `_active.runInteractivePixelProbe`
 * — see that function's own header (and `armInteractivePixelProbe`'s) for
 * the full reasoning. Arms click-to-set-point mode and resolves once up to
 * `maxPoints` clicks have landed (or after a 90s timeout).
 * @param {number} [maxPoints=3]
 */
export async function runInteractiveVtPanViewerPixelProbe(maxPoints = 3) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  return _active.runInteractivePixelProbe(maxPoints);
}

/**
 * Console-callable wrapper for `_active.probeWindAndParticles` — the
 * wind+particle probe's own header (`runWindProbeOnPoints` inside
 * startVtPanViewer) has the full reasoning. Call as
 * `await MapShine.probeWindAndParticles([{x, y}, ...])`.
 * @param {Array<{x:number, y:number}>} points - up to 3 world positions.
 */
export async function probeVtPanViewerWindAndParticles(points) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  return _active.probeWindAndParticles(points);
}

/**
 * Console/debug-panel-callable wrapper for `_active.runInteractiveWindProbe`
 * — arms click-to-set-point mode (`armInteractiveWindProbe`'s own header)
 * and resolves with, for each clicked point, BOTH the CPU-side wind-field
 * decomposition (ambient/structure/wake/exposure/enclosed) AND the nearest
 * real particles' actual GPU state — the click-to-probe cousin of
 * `MapShine.armPixelProbe`, built for wind/particle debugging specifically.
 * @param {number} [maxPoints=3]
 */
export async function runInteractiveVtPanViewerWindProbe(maxPoints = 3) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  return _active.runInteractiveWindProbe(maxPoints);
}

/**
 * Console/debug-panel-callable wrapper for `_active.drawWorldMarkers` — the
 * Tier-0 candle-placement proof (see that function's own header). Call as
 * `await MapShine.drawWorldMarkers([{x, y}, ...], { color, sizePx, ttlMs })`.
 * @param {Array<{x:number, y:number}>} points
 * @param {{color?:string, sizePx?:number, ttlMs?:number}} [opts]
 */
export async function drawVtPanViewerWorldMarkers(points, opts) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  return _active.drawWorldMarkers(points, opts);
}

/**
 * Arm the live, continuously-tracked marker overlay (the generic diagnostic
 * upgrade, 2026-07-20 — see `startLiveMarkers`'s own header in
 * startVtPanViewer). Call as `MapShine.startLiveMarkers(() =>
 * getAllMarkerPoints())`, wiring `getPoints` to diag/marker-overlay.js's
 * registry so every registered effect's points are drawn, not just one.
 * @param {() => Array<{x:number, y:number, color?:string}>} getPoints
 */
export function startVtPanViewerLiveMarkers(getPoints) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  _active.startLiveMarkers(getPoints);
  return { started: true };
}

/** Disarm the live marker overlay. Safe to call whether or not one is armed. */
export function stopVtPanViewerLiveMarkers() {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  _active.stopLiveMarkers();
  return { stopped: true };
}

/** The current draw list's ids — what the isolate dropdown is built from. */
export function getVtPanViewerDrawListIds() {
  if (!_active) return [];
  return _active.getDrawListIds();
}

/** @returns {string} the isolated item id, or `''` when showing everything. */
export function getVtPanViewerIsolateItemId() {
  if (!_active) return '';
  return _active.getIsolateItemId();
}

/** Await one real animation frame — used to drive the thrash test over the ACTUAL render loop, not a synchronous fake. */
function nextAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

/**
 * VT ZOOM THRASH TEST (2026-07-16, author-requested: "force the camera to
 * flush the caches, start with a blank slate, start zoomed out, and thrash it
 * in and out whilst tracking things" — a deterministic, instrumented
 * reproduction of the reported "rapid full-range zoom can temporarily stop"
 * hitch, so real data pins down the cause instead of further guessing).
 *
 * BLANK SLATE: restarts the viewer FRESH (fresh atlas, fresh page cache — the
 * SAME startup params the currently-active viewer was itself created with,
 * captured on every `startVtPanViewer` call), not just a cache-clear — matches
 * the author's own framing exactly.
 *
 * THRASH: flips the eased-zoom TARGET between fully-in and fully-out every
 * SINGLE animation frame for `cycles` frames — the most aggressive version of
 * "rapid thrashing," driven through `forceZoomTarget()` which uses the EXACT
 * SAME mechanism a real held zoom key does (`setZoomTarget`). The normal
 * per-frame render loop (`updateContinuousInputs`) does all the real easing/
 * streaming work exactly as it would for genuine input — nothing here
 * bypasses or special-cases the real code path; this is a driver, not a
 * simulation.
 *
 * INSTRUMENTATION: `resetHitchTracking()` clears frame-gap/hitch history
 * first for a clean measurement window; every frame's ACTUAL wall-clock gap
 * is recorded throughout (see `renderFrame`'s own header for why this is the
 * only signal that reveals a true main-thread freeze, as opposed to
 * `renderMsAvgLast120`, which only measures the render() call's own
 * duration). Each hitch's `decodeStats`/`cacheStats` snapshot is captured at
 * the EXACT moment it happened, not just at the end — this is what actually
 * lets a hitch be correlated with what the streaming system was doing when
 * it occurred (e.g. "was mid-decode of N new pages at mip 5").
 *
 * @param {object} [opts] @param {object} [opts.startupParams] - the fresh-
 *   viewer config to restart with (same shape as `startVtPanViewer`'s own
 *   params) — pass this explicitly so the test is self-contained and doesn't
 *   require a viewer to already be running (e.g. boot.js's debug-panel button
 *   passes the torture fixture's own config directly). Falls back to the
 *   CURRENTLY active viewer's own captured startup params if omitted (handy
 *   for ad-hoc console use against whatever's already loaded) — errors if
 *   neither is available.
 * @param {number} [opts.cycles] - animation frames to thrash across (default
 *   240 ≈ 4s at 60fps). @param {number} [opts.settleFrames] - frames to let
 *   residency catch up after the thrash before reporting (default 30).
 * @returns {Promise<object>} full report: cyclesRun, before/after decode+cache
 *   stats, and the hitch-stats block (count, frame-gap avg/max, recent hitches
 *   with full context).
 */
export async function runZoomThrashTest(opts = {}) {
  const startupParams = opts.startupParams ?? _active?.startupParams;
  if (!startupParams) {
    return {
      skipped: true,
      reason: 'no startup params available — pass opts.startupParams, or start a viewer first',
    };
  }

  const maxFrames = opts.maxFrames ?? 480;
  const settleFrames = opts.settleFrames ?? 30;
  // A leg that hasn't arrived by now is stuck (or the ease was retuned) — flip
  // anyway rather than spend the whole budget on one leg.
  const maxFramesPerLeg = opts.maxFramesPerLeg ?? 150;

  // BLANK SLATE — a genuine restart (fresh atlas + fresh page cache), not
  // merely clearing residency state. startVtPanViewer's own disposeActive()
  // tears down the OLD instance; `_active` after this line is the NEW one.
  await startVtPanViewer(startupParams);
  if (!_active) return { ok: false, error: 'restart failed — see console for the fatal error' };

  // THE TOP FLOOR by default (author, 2026-07-16). The highest floor is the one
  // most likely to composite every floor beneath it through its own
  // `visibility.levels` — the castle-courtyard case — so it carries the most
  // simultaneous textures and is the honest worst case. Overridable.
  const floorCount = startupParams.floorCount ?? 1;
  const floorIndex = opts.floorIndex ?? Math.max(0, floorCount - 1);
  await _active.setFloorIndex(floorIndex);

  _active.resetHitchTracking();
  _active.forceZoomTarget('out'); // start fully zoomed out, per the author's own request
  for (let i = 0; i < 40 && _active; i++) await nextAnimationFrame(); // let the starting zoom ARRIVE before measuring

  const beforeDiag = _active.getDiagnostics();

  // LET THE ZOOM ACTUALLY TRAVEL — flip direction only once it has ARRIVED.
  //
  // THE BUG THIS FIXES (found from the author's own 2026-07-16 report, which came
  // back suspiciously perfect: hitchCount 0, frameGapMaxMs 16.6, and — the tell —
  // `pinnedView: 0` both before AND after, meaning not one view page was ever
  // pinned): the loop used to flip the zoom TARGET every single frame, described
  // in its own comment as "the most aggressive thrash". It is the opposite. Zoom
  // is EASED (~120ms half-life), so one frame closes only ~9% of the gap; flipping
  // the target every frame moves it 9% in, then 9% out, forever. The zoom never
  // went anywhere. It sat at the fully-zoomed-out extreme — where every page is
  // coarse-pinned, hence pinnedView: 0 — so no mip ever changed, no page set ever
  // changed, and the test could not possibly have exercised a residency transition,
  // which is the only thing it exists to stress.
  //
  // Flipping on ARRIVAL instead makes each leg a real full-range sweep across every
  // mip level, which is what actually churns the page set.
  let direction = 'in';
  _active.forceZoomTarget(direction);
  let framesRun = 0;
  let framesThisLeg = 0;
  let legsCompleted = 0;
  let minHalfSpanSeen = Infinity;
  let maxHalfSpanSeen = -Infinity;

  for (let i = 0; i < maxFrames; i++) {
    if (!_active) break; // stopped mid-run (e.g. "Stop/Clear" clicked) — bail cleanly, don't throw
    await nextAnimationFrame();
    framesRun++;
    framesThisLeg++;

    const z = _active.getZoomState(); // cheap on purpose — see getZoomState's doc
    if (z.halfSpanPx < minHalfSpanSeen) minHalfSpanSeen = z.halfSpanPx;
    if (z.halfSpanPx > maxHalfSpanSeen) maxHalfSpanSeen = z.halfSpanPx;

    // "Arrived" within 2% — the ease is asymptotic, so waiting for exact equality
    // would spend most of the budget crawling the last fraction of a pixel.
    const tolerance = Math.max(1, z.targetHalfSpanPx * 0.02);
    if (Math.abs(z.halfSpanPx - z.targetHalfSpanPx) <= tolerance || framesThisLeg >= maxFramesPerLeg) {
      direction = direction === 'in' ? 'out' : 'in';
      _active.forceZoomTarget(direction);
      legsCompleted++;
      framesThisLeg = 0;
    }
  }

  for (let i = 0; i < settleFrames && _active; i++) await nextAnimationFrame(); // let residency catch up before the final read

  if (!_active) return { ok: false, error: 'viewer was stopped mid-run', framesRun };

  const afterDiag = _active.getDiagnostics();
  return {
    floorThrashed: floorIndex,
    floorCount,
    framesRun,
    // THE PROOF THE TEST DID ANYTHING. legsCompleted 0, or a halfSpan range that
    // barely moves, means the zoom never swept and the run is worthless — exactly
    // the failure that made the previous version look like a clean pass.
    legsCompleted,
    halfSpanTraversed: {
      min: Math.round(minHalfSpanSeen),
      max: Math.round(maxHalfSpanSeen),
      ratio: minHalfSpanSeen > 0 ? Math.round((maxHalfSpanSeen / minHalfSpanSeen) * 10) / 10 : null,
    },
    settleFramesRun: settleFrames,
    beforeThrash: { decodeStats: beforeDiag.decodeStats, cacheStats: beforeDiag.cacheStats },
    afterThrash: { decodeStats: afterDiag.decodeStats, cacheStats: afterDiag.cacheStats },
    hitchStats: afterDiag.hitchStats,
    interpretation:
      'ADVERSARIAL MAX-STRESS, NOT A PLAY PROXY (confirmed 2026-07-17): this legs the zoom back and forth at ' +
      'maximum programmatic rate with zero settle time between direction flips — several full-range sweeps in ' +
      'the time it takes to read this sentence. The RANGE it reaches is real (the same clampHalfSpan() bounds a ' +
      "real scroll wheel or +/- key hits), but the RATE is not: the author could not reproduce this run's own " +
      'ghost-artefact finding through 15-20s of deliberate, aggressive manual scroll-zooming. Anything this run ' +
      'finds is a REAL bug in the system (worth understanding — an hours-long real session eventually produces ' +
      'bursts too), but treat it as "found under adversarial load," not "will happen to a GM." For "does this ' +
      'survive a realistic extended session," use MapShine.soak(n) instead — its zoom driver (soakZoomStep) ' +
      'takes one bounded, eased step per cycle through the SAME code path a real zoom key uses. ' +
      'READ legsCompleted AND halfSpanTraversed FIRST — they say whether this run tested anything at all. ' +
      'legsCompleted 0, or a halfSpanTraversed.ratio near 1, means the zoom never swept the range and every other ' +
      'number below is meaningless (that exact false pass is why this loop was rewritten: it used to flip the ' +
      'eased zoom target every frame, which cancels itself out and parks the view at one extreme — the tell was ' +
      'pinnedView: 0). A real run shows a large ratio and several legs. THEN: afterThrash.cacheStats.misses is the ' +
      'headline — a residency transition that cannot fit its pages misses, and misses mean visible blur. ' +
      'hitchStats.hitchCount > 0 with real gapMs values in recentHitches is DIRECT evidence of a main-thread ' +
      "freeze (renderMsAvgLast120 cannot see this). Each hitch entry's decodeStats/cacheStats is a snapshot from " +
      'THAT EXACT moment — compare sourcesDecoded/idbSlices across consecutive hitches to see whether a fresh ' +
      'decode was in flight when the freeze happened.',
  };
}

const SOAK_PAN_KEYS = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];

/**
 * MapShine.soakHooks.pan driver — cycles through the four pan directions so a
 * soak run actually exercises decode/upload/evict repeatedly, via the EXACT
 * same applyKeyAndUpdate() path a real keypress uses. No-op (not an error) if
 * the viewer was never started — `soak()` reports honestly which drivers ran.
 * @param {number} i - the soak cycle index.
 */
export async function soakPanStep(i) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  const key = SOAK_PAN_KEYS[i % SOAK_PAN_KEYS.length];
  await _active.applyKeyAndUpdate(key);
  return { key, ..._active.getDiagnostics() };
}

/** MapShine.soakHooks.switchFloor driver — cycles floors 0,1,2,0,1,2,... */
export async function soakSwitchFloorStep(i) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  const floorIndex = i % _active.floorCount;
  await _active.applyKeyAndUpdate(String(floorIndex));
  return { floorIndex, ..._active.getDiagnostics() };
}

/** One real animation frame's worth of settle, in the same units the eased
 * zoom actually uses: `ZOOM_EASE_HALF_LIFE_SEC` (0.12s) is roughly 7-8 frames
 * at 60fps. Waiting a couple of half-lives per soak step is enough for the
 * glide to make real, visible progress (and for `updateContinuousInputs` to
 * fire `scheduleResidencyUpdate` at least once) without ballooning an n-cycle
 * soak into a multi-second wait per step — a real user's NEXT wheel notch
 * during continuous scrolling usually lands before the previous one fully
 * settles anyway. */
const SOAK_ZOOM_SETTLE_FRAMES = 12;
/** A real zoom gesture is several notches in one direction, not a flip every
 * notch (the exact mistake `runZoomThrashTest`'s own header describes fixing
 * for its OWN legs — "flipping the target every frame... never went
 * anywhere"). A short leg here for the same reason, at soak scale. */
const SOAK_ZOOM_LEG_STEPS = 4;

/**
 * MapShine.soakHooks.zoom driver (2026-07-17) — ONE bounded, eased zoom step
 * per cycle via `zoomStep()`, the exact factor/anchor a real keyboard zoom
 * key uses (see `zoomStep`'s own doc). Alternates direction every
 * `SOAK_ZOOM_LEG_STEPS` cycles rather than every cycle, so a soak run
 * exercises a real zoom-in-then-zoom-out GESTURE, not an instant full-range
 * jump — the thing `runZoomThrashTest` does that the author could not
 * reproduce by hand. No-op (not an error) if the viewer was never started.
 * @param {number} i - the soak cycle index.
 */
export async function soakZoomStep(i) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  const leg = Math.floor(i / SOAK_ZOOM_LEG_STEPS) % 2;
  const direction = leg === 0 ? 'in' : 'out';
  _active.zoomStep(direction);
  for (let f = 0; f < SOAK_ZOOM_SETTLE_FRAMES && _active; f++) await nextAnimationFrame();
  if (!_active) return { skipped: true, reason: 'viewer stopped mid-step' };
  return { direction, ..._active.getDiagnostics() };
}
