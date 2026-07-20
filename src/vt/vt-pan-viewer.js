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
import { computeAtlasLayout, PageAtlas } from './atlas.js';
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
import { requestCompressedTexture, getCompressedTextureStats } from './compressed-textures.js';
import {
  acquirePages,
  acquirePackedPages,
  getSourceDimensions,
  getDecodeStats,
  shouldYieldByTime,
  pageWorldRect,
  computePagePlacement,
} from './decode-pool.js';
import { createLogger } from '../core/log.js';

/** Log door for the onPageDecoded ingest seam's containment guard — the one
 * place this file reports a CONSUMER's failure rather than its own. */
const ingestLog = createLogger('vt-ingest');
/** Log door for new call sites in this file — the rest still calls
 * console.* directly (ratcheted debt, not this fix's job to migrate). */
const log = createLogger('vt-pan-viewer');
import { createVtSampler } from './vt-sample.tsl.js';
import {
  createInitialViewState,
  applyKey,
  applyPanByPixels,
  applyZoomAtPixel,
  viewToWorldRect,
  clampHalfSpan,
  computeTargetPanVelocity,
  easeVelocityTowardTarget,
  integratePan,
  easedZoomFactor,
} from './view-state.js';
import {
  planResidency,
  coarsePinSet,
  coarseTopMipsForCap,
  diffResidency,
  computeCoarsePinBudget,
} from './residency.js';
import { ThreeAllocator, PASSES, planFrame, runPassPlan } from '../graph/index.js';
import { PROBE_CORNERS, classifyPixel, diagnoseOrientation } from '../diag/orientation-probe.js';
import { decodeHalfFloatRgba, decodeByteRgba, diffProbeBuffers } from '../diag/pixel-probe.js';
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
  viewRectToImageRect,
  computeItemViewportPx,
  rectsOverlap,
} from '../scene/world-quad.js';
import {
  computeQuadCorners,
  computeQuadBounds,
  computeItemPlacement,
  tokenFootprint,
  readSceneDarkness,
  readSceneAmbient,
  readActiveLightSources,
  readGlobalLightConfig,
  readActiveDarknessRegions,
  readGridDistancePixels,
  readGridSizePixels,
  computeTokenOcclusionRadiusPx,
  getActiveSceneFloors,
} from '../foundry/index.js';
import { engageFoundryFallback, clearFoundryFallback, describeRenderMode } from '../diag/render-fallback.js';
import {
  OCCLUSION_MODES,
  computeOcclusionState,
  createHoverFadeState,
  mapElevation,
  buildElevationTable,
} from '../scene/occlusion.js';
import { buildEnvSnapshot } from '../world/index.js';
import {
  buildEnvironmentalLightMaterials,
  computeAmbientColors,
  computeGlobalLightFloor,
  maxRgb,
  mixRgb,
  buildPointLightIlluminationMaterial,
  easeAttenuation,
  computeExposure,
  buildPointLightColorationMaterial,
  computeColorationAlpha,
  triangulateLightFan,
  writeLightEdgePoints,
  computeEdgeSoftMarginNormalized,
  computeShapeMeshBounds,
  writeRegionPolygonPoints,
  applyDarknessAdjustment,
  computeRegionAdjustedDarkness,
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
} from '../effects/index.js';
import { makeFrameClock } from '../core/frame-clock.js';

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

/**
 * Nearest-rank percentile of a small sample array, rounded to 0.1ms. Pure,
 * no clock, no allocation-sensitive hot-path concern — this is only ever
 * called from a manually-triggered diagnostics report, never per frame.
 * `null` on an empty array (no lying: "no samples yet" must never read as 0ms).
 * @param {number[]} samples
 * @param {number} p - 0..1
 * @returns {number|null}
 */
function percentileMs(samples, p) {
  if (!samples || samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Math.round(sorted[idx] * 10) / 10;
}

/** Wall-clock budget per GPU-upload chunk before yielding a real frame — see
 * requestDecodeUpload's Pass 3 for the live-hitch evidence this fixes. */
const MAX_MS_PER_UPLOAD_CHUNK = 10;

/**
 * GPU-COMPLETION BACKPRESSURE — bound how many page uploads can be in flight on
 * the GPU queue before the CPU waits for them to finish (2026-07-17, the THIRD
 * WebGPU device loss on the 12000² mansion). The prior throttle
 * (`MAX_MS_PER_UPLOAD_CHUNK`) bounds only main-thread TIME: in 10ms the loop can
 * enqueue HUNDREDS of `queue.copyExternalImageToTexture` calls without ever
 * waiting for one to complete, so under a full/thrashing cache the GPU queue
 * grows unbounded until Chrome's TDR watchdog kills the device ("A valid
 * external Instance reference no longer exists"). The device-lost snapshot's own
 * guide pointed straight here: `residentPages == capacityPages`, `pinnedView`
 * near cap, `heldSources: 0`, `mainThreadFallbackSourceDecodes: 0` = a pure
 * upload-burst TDR, not a leak or a main-thread decode. After every this-many
 * uploads we `await device.queue.onSubmittedWorkDone()` — draining the queue to
 * a bounded depth. When the GPU is healthy this returns in well under a
 * millisecond (48 pages ≈ 12 MB of copies); when the queue is backing up the
 * wait BALLOONS, which is exactly the signal `_uploadDrain` records for the next
 * crash report — so this is a principled fix AND a decisive instrument. WebGPU
 * backend only (WebGL2 has no equivalent per-page queue-submit cost — see
 * atlas.js). Tune down if a slower card still backs up; tune up if streaming
 * feels needlessly throttled. */
const UPLOAD_PAGES_PER_DRAIN = 48;

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

/** Worst GPU-queue drain wait seen this session + how many drains ran — read in
 * the device-lost snapshot to tell an upload-burst TDR (maxMs balloons) apart
 * from something else (maxMs stays tiny). Reset when a viewer starts. */
let _uploadDrain = { maxMs: 0, count: 0 };

/**
 * WHOLE-IMAGE RENDER MODE (2026-07-17 — the "load images like PIXI" path the
 * author chose after the tile-streaming architecture kept losing the WebGPU
 * device to upload churn). When ON, each item's art is loaded WHOLE (one
 * texture when it fits the raised 16384 cap — the mansion's 12000² case; or the
 * smallest tile grid that fits, `planImageTiles`, on weaker hardware) and drawn
 * as plain quad(s), with the atlas/page-streaming SKIPPED entirely. The whole
 * streaming apparatus (atlas, cache, residency, decode worker, backpressure)
 * stays intact as the OFF path — the escape hatch if this is broken:
 * `MapShine.setWholeImageMode(false)` reverts to it live without a reload.
 *
 * Default ON (the author is testing it) — but the device-lost safety slide is
 * still underneath, and `getDiagnostics().wholeImage` reports exactly what each
 * item did (mode, tiles, decode status/errors, VRAM) so a breakage is visible
 * in a flight recorder, not a mystery.
 */
let _wholeImageEnabled = true;
/** @param {boolean} on */
export function setWholeImageMode(on) {
  _wholeImageEnabled = !!on;
}

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
 * How much of the page cache must remain unprotected before a pack is allowed to
 * pin its SPECULATIVE (prefetch) tier. Below this, prefetch is dropped and only
 * the pages the current view actually needs are pinned.
 *
 * THE BUG THIS FIXES (measured live, 2026-07-16, real 2-floor non-square scene —
 * 3 Level backgrounds + 2 foregrounds + 2 roof tiles = 7 packs):
 *
 *     cacheStats: { capacityPages: 2048, residentPages: 2048, freePages: 0,
 *                   pinnedCoarse: 574, pinnedView: 1320, misses: 215426 }
 *
 * Every pack reported `viewResident: 220` — which is EXACTLY its mip-1 grid
 * (22x10). With `mip.requested: 2` and `coarseTopMips: 5`, the coarse pins
 * already covered mips 2-6, so `plan.fine` (mip 2) and `plan.prefetchCoarser`
 * (mip 3) contributed ZERO new pages: **100% of the pinned view tier was
 * `prefetchFiner`** — insurance for a zoom-in that might never happen. Demand
 * was 7 x (82 + 220) = 2114 pages against a 2048 capacity, so the cache could
 * not satisfy it even in principle.
 *
 * It then never recovered, because of an interaction with the (correct) fix for
 * the "stuck view-miss" bug: a page whose request misses is deliberately NOT
 * recorded as resident, so it is retried on every residency update. Permanent
 * oversubscription therefore became permanent retry churn — the 215k misses.
 *
 * The principle that was violated: speculation was pinned at the same protection
 * level as necessity. `PageCache` never evicts ANY pinned slot ('coarse' and
 * 'view' are equally protected — page-cache.js's `_findLRUEvictable`), so a pack
 * pinning 220 speculative pages permanently denies those slots to pages some
 * other pack actually needs to render.
 *
 * Why admission control rather than simply leaving prefetch UNPINNED (which LRU
 * would then reclaim naturally, and was the first idea): an unpinned page can be
 * evicted by a LATER pack's request *within the same residency update*, after
 * this pack has already written its atlas slot into the indirection texture. The
 * indirection would then point at a slot holding a different page's pixels —
 * wrong content, not blur. Pinning is what makes the indirection trustworthy, so
 * the fix has to be "don't ask for what won't fit", not "ask and let it go".
 *
 * The check is per-pack and evaluated in draw order, so it self-limits: early
 * packs prefetch while there is room, later ones skip it. Order-dependent, but
 * BOUNDED and correct — and the fine tier is never the thing that loses.
 */
const PREFETCH_MIN_HEADROOM_FRACTION = 0.15;

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
  try {
    _active.atlas?.dispose(); // null in whole-image mode — the atlas is never allocated
  } catch (_) {}
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
  buildItems,
  dimensions,
  floorCount,
  initialFloorIndex = 0,
  extraLayersForItem,
  getOcclusionInputs,
  onLoadProgress,
  onPageDecoded,
  onDeviceLost,
}) {
  extraLayersForItem ??= () => [];
  getOcclusionInputs ??= () => ({ occluders: [], visionActive: false });
  onPageDecoded ??= () => {};
  _uploadDrain = { maxMs: 0, count: 0 }; // fresh GPU-backpressure stats per viewer session
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
    const layout = computeAtlasLayout({ budgetBytes: 512 * 1024 * 1024 }); // Keyhole Q2 default

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
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, requiredLimits });
    await renderer.init(); // REQUIRED before any use — the backend is chosen here

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
      //   • cacheStats.residentPages == capacityPages with pinnedView near cap
      //     -> the atlas/cache is SATURATED: a VRAM-pressure death. Shrink the
      //        512MB atlas (computeAtlasLayout budgetBytes) or the view tier.
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
          atlasBytes: atlas ? layout.totalBytes : 0, // 0 in whole-image mode — atlas not allocated
          sceneColorBytes: sceneColor ? sceneColor.width * sceneColor.height * 8 : null,
          // WHOLE-IMAGE VRAM AT DEATH — the number this hunt kept missing. Sum of
          // every uploaded whole-image texture (w·h·4). Read estTextureVramMB
          // (this + atlas + sceneColor) against a plausible WebGPU budget: if it
          // is multiple GB AND the frame-gap hitches spike right before this, it
          // is a VRAM-ceiling death and the fix is to hold FEWER full-res layers
          // (free the atlas; drop off-floor occlusion layers) — not to sequence
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
            const otherBytes =
              (atlas ? layout.totalBytes : 0) + (sceneColor ? sceneColor.width * sceneColor.height * 8 : 0);
            return {
              totalMB: +(bytes / (1024 * 1024)).toFixed(1),
              estTextureVramMB: +((bytes + otherBytes) / (1024 * 1024)).toFixed(1),
              ready,
              loading,
              items,
            };
          })(),
          // GPU-queue backpressure (UPLOAD_PAGES_PER_DRAIN): maxMs BALLOONING (tens+
          // of ms) confirms an upload-burst TDR — the queue could not drain. maxMs
          // staying tiny (sub-ms) with count > 0 RULES OUT queue backup and points
          // the next investigation elsewhere (a leak we haven't found, a driver bug).
          uploadDrain: { ..._uploadDrain },
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
    const sceneColor = allocator.create('scene.color', describeSceneColor());

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

    const envLight = buildEnvironmentalLightMaterials({
      THREE,
      albedoTexture: sceneColor.texture,
      illumTexture: sceneIllum.texture,
      colorationTexture: sceneColoration.texture,
      uiShadowVisNode: uiShadow.visNode,
    });
    // QuadMesh (never a hand-rolled quad — same Y-flip law the present pass
    // documents at length below): the vendor owns v=0-at-top on both backends.
    const illumQuad = new THREE.QuadMesh(envLight.illumMaterial);
    const compositeQuad = new THREE.QuadMesh(envLight.compositeMaterial);

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

    /** A tiny dedicated Scene for point-light meshes — kept separate from
     * the main `scene`, same reasoning as occlusionScene below. */
    const lightScene = new THREE.Scene();

    /** A SEPARATE dedicated Scene for point-light COLORATION meshes
     * (increment 3, 2026-07-19) — rendered into buf:scene.coloration, kept
     * apart from lightScene/illumination for the same "one scene per
     * render-target destination" reasoning as everywhere else in this file. */
    const colorationScene = new THREE.Scene();

    /** Starting capacity, in FAN VERTICES (not polygon vertices — see
     * triangulateLightFan: a polygon of V vertices fans out to 3V mesh
     * vertices), for a light's reusable scratch vertex buffer. Generous for
     * a typical wall-clipped light shape; grows automatically (rare, not
     * per-frame) the one time an actual light polygon exceeds it — see
     * updatePointLightMeshes. */
    const INITIAL_LIGHT_FAN_VERTICES = 192;

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
     * @returns {object[]} elevation-filtered active regions.
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
        const sceneDoc = typeof canvas !== 'undefined' ? (canvas?.scene ?? null) : null;
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
      return regions.filter((region) =>
        regionOverlapsElevationBand(region.elevationBottom, region.elevationTop, floorBottom, floorTop)
      );
    }

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

    /** sourceId -> { mesh, material, geometry, positionAttribute,
     * scratchArray, uRatio, uAttenuationEased }. Reconciled every frame in
     * updatePointLightMeshes, mirroring occlusionDiscs' own add/remove/
     * update shape and its documented lifecycle gap: an entry for a light
     * that's genuinely DELETED is only hidden (mesh.visible:false), never
     * removed — full cleanup needs a deleteAmbientLight hook wired from
     * boot.js; not built this cut.
     *
     * UNLIKE occlusionDiscs (one shared geometry, scaled per instance), each
     * light gets its OWN geometry — shapes differ per light and change
     * frame to frame (walls/radius/position).
     *
     * ⚠️ THE DEVICE-LOST BUG THIS FIXES (2026-07-18, live-crashed within
     * ~30s of point lights first rendering — flight recorder: "WebGPU
     * Device Lost: A valid external Instance reference no longer exists").
     * The first cut of this pool created a BRAND NEW `Float32Array` +
     * `THREE.BufferAttribute` EVERY FRAME for EVERY active light (this
     * comment used to claim that was "cheap CPU work with no GPU stall" —
     * WRONG, and left uncorrected until this crash proved it). Verified
     * against the vendored three.webgpu.js source: `BufferAttribute` has NO
     * `dispose()` method at all, and `BufferGeometry#setAttribute` is a bare
     * `this.attributes[name] = attribute` — nothing frees the OLD
     * attribute's backend GPU buffer when it's replaced. Every active
     * light, every frame, leaked one native GPU buffer, unbounded, until
     * WebGPU's own device-loss watchdog killed the context — the same
     * disease this file's own upload-backpressure/tile-size-cap fixes
     * already named for OTHER unbounded-small-allocation causes (see
     * UPLOAD_PAGES_PER_DRAIN / MAX_WHOLE_TILE_DIM above), this time from
     * per-frame vertex-buffer churn instead of texture uploads.
     *
     * THE FIX: allocate the scratch array + BufferAttribute ONCE per light
     * (on first appearance) and REUSE them every frame — mutate the SAME
     * array's contents, flag `.needsUpdate = true` (the idiomatic three.js
     * "the data changed, re-upload the SAME buffer" signal), and use
     * `geometry.setDrawRange` to tell the renderer how many of the
     * (possibly stale, possibly oversized) vertices are valid THIS frame.
     * `triangulateLightFan`'s `outArray` parameter exists specifically to
     * make this reuse possible; only grows (a new, bigger array/attribute)
     * on the rare frame a light's polygon exceeds its previous high-water
     * mark — an occasional reallocation, not a chronic per-frame one. */
    const lightMeshes = new Map();

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

    /**
     * Reconcile the point-light mesh pool against this frame's live Foundry
     * light sources: add new, refresh every survivor's geometry/uniforms,
     * hide stale (see lightMeshes' own doc for why "hide" not "dispose").
     *
     * PER-LIGHT REGION-AWARE AMBIENT (2026-07-19 — THE REAL "hard edge on a
     * soft, attenuation:1 light" bug, found live via the pixel probe: a
     * point just outside a light's mesh but INSIDE a darkening region read
     * the region's correctly-darkened floor; a point just inside the SAME
     * light's mesh read the GLOBAL, un-adjusted background — a step
     * discontinuity at the light's own boundary, independent of how soft
     * the light's OWN attenuation-driven corona is, because the corona
     * blends toward the WRONG floor). Every light's illumination formula
     * (`point-light-illumination.js`) is `mix(uBackgroundColor,
     * finalColorExposed, falloff)` — `uBackgroundColor` used to be one
     * SHARED, scene-wide uniform, identical for every light, with zero
     * awareness of a region it might be sitting inside. Under MAX-blend
     * (region draws first, opaque; light draws after, MAX) a light's own
     * floor (always >= the raw scene background) can never lose to a
     * DARKENED region's lower value — so the region's darkening was erased
     * everywhere the light's mesh reached, with a hard seam exactly at the
     * mesh boundary.
     *
     * Real Foundry avoids this because every light samples the SAME
     * per-pixel `darknessLevelTexture` regions paint into (this file's own
     * header cites the mechanism). MSA has no such texture yet — this is
     * the CPU-side approximation: EACH light now gets its OWN
     * `uBackgroundColor`/`uDimColor`/`uBrightColor` uniforms (not shared),
     * recomputed every frame from `computeRegionAdjustedDarkness(light.x,
     * light.y, darkness01, activeRegions)` — the SAME pure function/formula
     * `updateRegionDarknessMeshes` uses, just evaluated at the light's own
     * ORIGIN rather than per-fragment. Exact for a light entirely inside
     * (or entirely outside) one region; an approximation — one uniform
     * value for the WHOLE light — for a light whose radius straddles a
     * region boundary, same class of tradeoff as this file's other
     * per-floor-not-per-pixel approximations, not a new one.
     *
     * @param {number} darkness01
     * @param {object[]} activeRegions - THIS frame's elevation-filtered
     *   active darkness regions (`readElevationFilteredDarknessRegions()`),
     *   passed in so this function and `updateRegionDarknessMeshes` always
     *   agree on which regions are active.
     * @param {object} env - this frame's env snapshot (for `ambient.*`).
     * @param {number} darknessRealism01 - the darkness-realism lever, same
     *   value `computeAmbientColors` already takes elsewhere this frame.
     */
    function updatePointLightMeshes(darkness01, activeRegions, env, darknessRealism01) {
      // darkness01 gates each light's OWN activation window (LightData.darkness
      // {min,max}, default {0,1} — "always on"; see foundry/scene-lights.js's
      // header for why this lives in the reader, not here).
      const { lights } = readActiveLightSources(darkness01);
      // Read ONCE per frame, same precedent as runMaskOcclusionPass's own
      // readGridDistancePixels call — a scene's grid size does not change
      // light-to-light, only scene-to-scene.
      const gridSizePixels = readGridSizePixels().gridSizePixels;
      lastGridSizePixels = gridSizePixels;
      const seen = new Set();
      for (const light of lights) {
        seen.add(light.sourceId);
        let entry = lightMeshes.get(light.sourceId);
        if (!entry) {
          const geometry = new THREE.BufferGeometry();
          // Pre-allocate ONCE, sized generously — see INITIAL_LIGHT_FAN_VERTICES
          // and lightMeshes' own doc for why this exists (the device-lost fix).
          const scratchArray = new Float32Array(INITIAL_LIGHT_FAN_VERTICES * 3);
          const positionAttribute = new THREE.BufferAttribute(scratchArray, 3);
          positionAttribute.setUsage(THREE.DynamicDrawUsage); // hints the backend: this buffer's DATA changes often
          geometry.setAttribute('position', positionAttribute);
          // PER-LIGHT (not shared) ambient uniforms — see this function's
          // own header for why. Defaults match the pre-fix shared uniforms'
          // own starting values; overwritten every frame below regardless.
          const uBackgroundColor = THREE.TSL.uniform(THREE.TSL.vec3(0.93, 0.93, 0.93));
          const uDimColor = THREE.TSL.uniform(THREE.TSL.vec3(0.93, 0.93, 0.93));
          const uBrightColor = THREE.TSL.uniform(THREE.TSL.vec3(1, 1, 1));
          const { material, uRatio, uAttenuationEased, uExposure, uEdgeCount, uEdgeSoftMargin, edgePoints } =
            buildPointLightIlluminationMaterial({
              THREE,
              uBackgroundColor,
              uDimColor,
              uBrightColor,
            });
          const mesh = new THREE.Mesh(geometry, material);
          mesh.frustumCulled = false;
          lightScene.add(mesh);
          // COLORATION (increment 3, 2026-07-19) — a SECOND Mesh SHARING this
          // SAME geometry object (no duplicate triangulation/BufferAttribute
          // — see point-light-coloration.js's own header), added to the
          // SEPARATE colorationScene.
          const colorationBuilt = buildPointLightColorationMaterial({ THREE, albedoTexture: sceneColor.texture });
          const colorationMesh = new THREE.Mesh(geometry, colorationBuilt.material);
          colorationMesh.frustumCulled = false;
          colorationScene.add(colorationMesh);
          entry = {
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
          };
          lightMeshes.set(light.sourceId, entry);
        }
        // REUSE, not reallocate (see lightMeshes' own doc — this is the
        // device-lost fix, not an optimisation): triangulateLightFan writes
        // into entry.scratchArray when it already has room. It returns a
        // DIFFERENT array only on the rare frame this light's polygon
        // outgrows its previous high-water mark, in which case (and ONLY
        // then) a new BufferAttribute replaces the old one — an occasional
        // reallocation, not a chronic per-frame one.
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
        // Only the first `vertexCount` vertices are valid THIS frame — the
        // rest of a larger-than-needed scratch buffer is stale data from a
        // previous, bigger frame (triangulateLightFan's own contract).
        entry.geometry.setDrawRange(0, vertexCount);
        // Mirrors Foundry's OWN mesh placement exactly (audit §2): geometry is
        // normalized to local unit-radius space by triangulateLightFan, then
        // positioned/scaled back out to world space here — the same
        // position-then-scale composition PointEffectSourceMixin uses.
        entry.mesh.position.set(light.x, light.y, 0);
        entry.mesh.scale.set(light.radius, light.radius, 1);
        entry.mesh.visible = true;
        // PER-LIGHT REGION-AWARE AMBIENT — see this function's own header
        // for the full "hard edge on a soft light" bug this fixes. Same
        // formula computeAmbientColors already uses elsewhere this frame,
        // just fed THIS light's own local (region-adjusted) darkness
        // instead of the raw scene darkness01.
        const localDarkness01 = computeRegionAdjustedDarkness(light.x, light.y, darkness01, activeRegions);
        const localAmbient = computeAmbientColors({ ...env, darkness01: localDarkness01 }, darknessRealism01);
        entry.uBackgroundColor.value.set(...localAmbient.background);
        entry.uDimColor.value.set(...localAmbient.dim);
        entry.uBrightColor.value.set(...localAmbient.bright);
        entry.uRatio.value = light.ratio;
        // NOT floored (2026-07-19, reversed same day — see
        // keyhole-attenuation-floor-reverted memory). A same-day fix
        // here (computeMinAttenuationFloor) forced every light's corona to a
        // MINIMUM softness, on the theory that a hard edge was always a bug.
        // A direct side-by-side against real Foundry (base-lighting.mjs's
        // own switchColor/FALLOFF, verified in the vendored source) proved
        // that theory wrong: Foundry renders a genuinely HARD edge for a
        // light authored with LOW attenuation and only softens toward
        // attenuation=1 — that contrast IS the parity target, not a defect.
        // easeAttenuation is used unmodified, exactly like Foundry's own
        // `attenuation` uniform.
        const attenuationEased = easeAttenuation(light.attenuation01);
        entry.uAttenuationEased.value = attenuationEased;
        entry.uExposure.value = computeExposure(light.luminosity01);
        // SOFT EDGE (point-light-illumination.js's own header): the SAME
        // reuse discipline as scratchArray above, via TRUNCATION rather than
        // growth — writeLightEdgePoints mutates entry.edgePoints' existing
        // Vector2 instances IN PLACE, never replacing them (a uniformArray's
        // size is fixed forever after its first setup() call).
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
        // hasColor GATE, NOW SAFE + CORRECT (2026-07-19) — the earlier
        // full-black scares from this gate had a ROOT CAUSE, now fixed
        // upstream: foundry/scene-lights.js was reading every light's colour
        // as `undefined` (`source.data.color?.rgb` on a value that is a bare
        // integer, not a Color), so EVERY light looked colourless and the
        // gate zeroed ALL 79 lights' coloration → dim illumination alone →
        // black. With the colour read corrected to `source.colorRGB`, the
        // coloured torches (the vast majority in a normal scene) now report
        // hasColor:true and keep their coloration; ONLY genuinely colourless
        // lights are gated — exactly Foundry's own `isRequired`/`hasColor`
        // rule (coloration-lighting.mjs), and no longer load-bearing for the
        // scene's overall brightness. Applied via the uniform (`uColoration
        // Alpha=0`), NOT a mesh-visibility toggle — a plain per-frame uniform
        // write, the same safe mechanism every other per-light value uses.
        entry.colorationMesh.position.set(light.x, light.y, 0);
        entry.colorationMesh.scale.set(light.radius, light.radius, 1);
        entry.colorationMesh.visible = true;
        // SAME unfloored value as the illumination mesh above — coloration's
        // falloff uses the identical formula (both real Foundry source and
        // this project's own), so both channels harden/soften together at
        // the light's own authored attenuation, matching Foundry exactly.
        entry.uColorationAttenuationEased.value = attenuationEased;
        // A colourless light contributes ZERO coloration (Foundry parity —
        // see the block comment above); a coloured light gets its normal
        // technique-1 alpha and its REAL (now correctly-read) hue below.
        entry.uColorationAlpha.value = light.hasColor ? computeColorationAlpha(light.alpha01, 1) : 0;
        entry.uLightColor.value.set(light.color[0], light.color[1], light.color[2]);
        // DIAGNOSTIC ONLY — not read by any shader. Lets getPointLightsInfo
        // report the true coloured/colourless split (colorationSummary), the
        // number that proves the colour-read fix is working: it should now be
        // mostly `coloured`, where before the fix EVERY light was colourless.
        entry.lastHasColor = light.hasColor;
      }
      for (const [id, entry] of lightMeshes) {
        if (!seen.has(id)) {
          entry.mesh.visible = false;
          entry.colorationMesh.visible = false;
        }
      }
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
    const presentMaterial = new THREE.NodeMaterial();
    presentMaterial.depthTest = false;
    presentMaterial.depthWrite = false;
    // No uv argument: `texture()` defaults to the mesh's own uv attribute,
    // which on a QuadMesh is QuadGeometry's — the one three guarantees against
    // its own render-target convention. Passing `uv()` explicitly would be the
    // same thing; passing anything else re-opens the bug.
    // Reads scene.lit — the map AFTER light.accumulate multiplies in the
    // ambient (2026-07-18). Before lighting landed this read scene.color
    // directly; now the lit buffer is what reaches the canvas.
    const presentTexNode = THREE.TSL.texture(sceneLit.texture);
    presentMaterial.fragmentNode = presentTexNode;
    const presentQuad = new THREE.QuadMesh(presentMaterial);

    /** Re-point the present material at a freshly-allocated target (resize). */
    function rebindPresent() {
      presentTexNode.value = sceneLit.texture;
      presentMaterial.needsUpdate = true;
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
      renderer.setRenderTarget(sceneColor);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
    }
    function runPresentCompositePass() {
      presentQuad.render(renderer); // three's own fullscreen path — carries its own camera
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
      // Read ONCE, shared by both — see readElevationFilteredDarknessRegions'
      // own header for why a light needs the SAME active-region set a
      // region-mesh draw uses (2026-07-19, the per-light-region-aware-
      // ambient fix).
      const activeRegions = readElevationFilteredDarknessRegions();
      updateRegionDarknessMeshes(darkness01, activeRegions);

      updatePointLightMeshes(darkness01, activeRegions, env, darknessRealism01);

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
      updateUiShadowStamps();
      const previousAutoClearColor = renderer.autoClearColor;
      renderer.autoClearColor = false;
      renderer.setRenderTarget(sceneIllum);
      illumQuad.render(renderer); // buf:scene.illum = ambient background (sRGB), raised by global illumination if active
      // Darkness-region meshes OVERWRITE (discard outside their own shape,
      // no blending) the ambient fill within their own footprint — BEFORE
      // point lights, so a light sitting inside a darkened/brightened region
      // MAX-blends against the REGION-ADJUSTED floor, not the base one.
      renderer.render(regionScene, camera);
      // MAX-blends every active point light on top of the (possibly region-
      // adjusted) ambient fill — same target, same camera as geometry.world/
      // occlusion (world-space).
      renderer.render(lightScene, camera);
      renderer.autoClearColor = previousAutoClearColor;
      // COLORATION (increment 3, 2026-07-19) — its OWN target, a SINGLE
      // render() call (autoClearColor restored above), so the ordinary
      // "first render() after setRenderTarget clears" behaviour is correct
      // and wanted here: an area with no lights nearby should stay exactly
      // black/zero (no ambient floor to pre-fill, unlike illum's), and a
      // fresh per-frame clear is exactly what makes that true rather than
      // accumulating stale coloration from a previous frame.
      renderer.setRenderTarget(sceneColoration);
      renderer.render(colorationScene, camera);
      // scene.lit = EOTF(OETF(albedo) × illum + coloration) — the coloration
      // is ADDED inside the composite now, in GAMMA space (Foundry parity;
      // the old separate additive quad blended in LINEAR space and washed the
      // scene to one hue — see environmental-light.js's composite essay). The
      // coloration target above is fully rendered before this reads it.
      renderer.setRenderTarget(sceneLit);
      compositeQuad.render(renderer);
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
    function updateEnvSnapshot() {
      const time = frameClock.tick();
      const darkness = readSceneDarkness();
      // The ambient palette Foundry itself renders from (canvas.colors) — read
      // through the ONE adapter so the light pass reproduces Foundry's ladder
      // rather than re-reading a global. `readSceneAmbient` never throws and
      // reports source/reason exactly like `readSceneDarkness`.
      const ambient = readSceneAmbient();
      // todHour has NO real source yet — no calendar, no author-facing
      // control exists in this session's scope. `world/sun.js#normalizeHour`
      // already treats a non-finite hour as noon ("a broken input reads as
      // noon, LOUDLY neutral — never NaN downstream"); this makes that choice
      // EXPLICIT rather than an implicit fallthrough, so it reads as an
      // acknowledged gap, not a bug, in getEnvSnapshotInfo() below.
      const env = buildEnvSnapshot({
        time,
        todHour: 12,
        darknessInput: darkness.darkness01,
        ambientInput: { daylight: ambient.daylight, darkness: ambient.darkness, brightest: ambient.brightest },
      });
      lastEnvSnapshot = { env, darkness, ambient, todHourSource: 'default:no-calendar-input-yet' };
      return env;
    }

    // PIXI PARITY: in whole-image mode we draw whole textures and NEVER sample
    // the page atlas, so allocating its 512MB DataArrayTexture is pure dead
    // weight — and it was sitting in exactly the VRAM headroom a floor switch
    // needed, so we hit Chrome's WebGPU memory wall ~512MB sooner than Foundry's
    // PIXI does (2026-07-18). Skip it entirely; carry only what PIXI carries.
    const atlas = _wholeImageEnabled ? null : new PageAtlas({ THREE, layout, renderer });

    // THE OCCLUSION MASK — a REAL render target as of 2026-07-18, RADIAL-only.
    //
    // scene/occlusion.js has the full model ported and Node-tested, and the
    // shader in ensureItemMesh()/buildWholeImageMaterial() implements
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

      // NO PER-MIP UNIFORM ARRAYS ANY MORE. The TSL sampler derives every mip's
      // page grid and pyramid origin from `pages0` alone (two integers) — see
      // vt-sample.tsl.js's header for why that is exact, and vt-core.test.mjs for
      // the proof against this very PageTable. `indirectionLayout` still sizes the
      // texture above; it just no longer has to be marshalled into the shader.

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
    async function ensureItemLoaded(item) {
      const existing = itemStates.get(item.id);
      if (existing) {
        existing.item = item; // refresh (renderOrder/key change per update)
        return existing;
      }

      // PIXI PARITY (whole-image mode): no packs, no atlas, no page streaming —
      // build NONE of the streaming apparatus. All we need is the source's real
      // dimensions (for placement + tile planning); ensureWholeImageMeshes does
      // the actual decode/upload. `getSourceDimensions` reads only the image
      // header (~30 bytes), not the 144-megapixel body. This is what makes our
      // GPU footprint match Foundry's PIXI: only the floor textures, nothing
      // else. `buildPack`'s coarse-pin decode+upload (and the 512MB atlas it
      // fills) is skipped entirely.
      if (_wholeImageEnabled) {
        const dims = await getSourceDimensions(item.src);
        const state = {
          item,
          packs: new Map(), // nothing streams
          albedoPack: null,
          layerErrors: [],
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
        return state;
      }

      const packs = new Map();
      // The item's fair share of the SCENE-WIDE coarse budget (item 1b) — was
      // uncapped (up to ~96 pages) before this, with nothing coordinating the
      // total across however many packs the scene actually has.
      const albedoPack = await buildPack(
        item.id,
        'albedo',
        { url: item.src },
        { coarsePinMaxPages: currentCoarseBudget.perPackMaxPages }
      );
      packs.set('albedo', albedoPack);

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

      const imageSize = { width: albedoPack.table.worldWidthPx, height: albedoPack.table.worldHeightPx };
      const state = {
        item,
        packs,
        albedoPack,
        layerErrors,
        imageSize,
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
      return state;
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

    /**
     * Create (once) the world-space quad + shader for ONE draw item.
     *
     * Geometry is the item's four REAL world corners (computeQuadCorners →
     * buildQuadPositions), with static 0..1 UVs — no per-frame UV rewriting.
     *
     * `side: DoubleSide` is load-bearing, not defensive: Foundry flips a tile
     * horizontally with a NEGATIVE texture.scaleX (see scene-geometry.js
     * #computeTextureFit, which deliberately preserves the sign), and a mirrored
     * quad has reversed winding. Back-face culling would make every flipped tile
     * silently vanish.
     *
     * `transparent:true` + `depthTest/depthWrite:false` + explicit `renderOrder`
     * (from sortByLayer — THE law, scene/layer-order.js) is what makes the whole
     * composite work: a real ALPHA HOLE in an upper floor's art blends against
     * whatever a lower floor already painted, and a roof paints over the tokens
     * beneath it purely because its elevation sorts later.
     */
    function ensureItemMesh(state) {
      if (state.mesh) return state;

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(buildQuadPositions(computeQuadCorners(state.placement)), 3)
      );
      geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
      geometry.setIndex(Array.from(QUAD_INDICES));

      // ONE sampler graph per item — each drawable samples its own page table with
      // its own image size, exactly as each had its own ShaderMaterial uniforms.
      // The atlas is the one shared thing.
      const vt = createVtSampler(THREE.TSL, {
        atlasTexture: atlas.texture,
        // THE PAGE TABLE'S REAL TEXTURE, not a placeholder — and this line was the
        // black screen (2026-07-16). It used to pass `atlas.texture` "to be rebound
        // later", which is wrong in a way GLSL uniforms are not: a TextureNode bakes
        // its TYPE into the graph at build time. Seeded with the atlas (a
        // DataArrayTexture) it compiles array-texture sampling; swapping `.value` to
        // a 2D DataTexture afterwards cannot change the emitted shader, so the
        // binding is invalid and WebGPU silently SKIPS THE DRAW. Hence: black,
        // alpha 0, no error, a healthy cache — and a solid-colour test that drew
        // perfectly, because it bound no textures at all.
        //
        // A node graph is not a uniform block. What a uniform lets you swap freely,
        // a node bakes.
        initialPageTable: state.albedoPack.indirectionTexture,
        pagesPerAxis: layout.pagesPerAxis,
        pagesPerLayer: layout.pagesPerLayer,
        pageSizePx: layout.pageSizePx,
        borderPx: 4,
        atlasSizePx: layout.atlasSizePx,
      });
      const { Fn, uniform, vec3, float, vec2, uv } = THREE.TSL;

      // Per-item appearance + occlusion, as live uniform handles.
      const uTint = uniform(vec3(1, 1, 1));
      const uAlpha = uniform(float(1));
      const uOcclusionElevation = uniform(float(0));
      const uOcclusionWeights = uniform(THREE.TSL.vec4(0, 0, 0, 0));
      const uUnoccludedAlpha = uniform(float(1));
      const uOccludedAlpha = uniform(float(0));

      const material = new THREE.NodeMaterial();
      material.transparent = true;
      material.depthTest = false;
      material.depthWrite = false;
      material.side = THREE.DoubleSide; // see this function's doc — negative scaleX flips winding

      // THE OCCLUSION CHAIN, factored out so a debug stage can feed it a CONSTANT
      // mask instead of the texture. That is the whole experiment: the diagnostics
      // print occlusionWeights [0,0,0,0], occlusionElevation 1, unoccludedAlpha 1,
      // occludedAlpha 0 -- with those numbers this block provably multiplies alpha by
      // exactly 1 and does nothing. Yet removing it un-blacks the screen. So it was
      // never the arithmetic, and the only non-arithmetic thing here is the TEXTURE
      // BINDING itself.
      //
      // @param {any} maskSample - vec4 node: the mask's four elevation indices.
      const occlusionAlphaFactor = (maskSample) => {
        // Foundry's algorithm (occlusion.mjs:16): each channel holds an ELEVATION
        // INDEX (R=Fade G=Radial B=Vision A=Surface), and a channel says "occlude me"
        // where the occluder recorded there sits BELOW my own elevation.
        const occluded = float(1).sub(THREE.TSL.step(uOcclusionElevation, maskSample));
        const amounts = occluded.mul(uOcclusionWeights);
        const occ = amounts.x.max(amounts.y).max(amounts.z).max(amounts.w);
        // mix(a, b, t) -- the FUNCTION form. See the warning in vt-sample.tsl.js: the
        // .mix() METHOD takes its receiver as the INTERPOLANT, and this exact line,
        // written as uUnoccludedAlpha.mix(uOccludedAlpha, occ), compiled to
        // mix(0, occ, 1) == 0 and blacked out the entire map for a whole session.
        return { occ, factor: THREE.TSL.mix(uUnoccludedAlpha, uOccludedAlpha, occ) };
      };
      // SCREEN-space UV (2026-07-18) — the ONE-LINE bug Keyhole.md's "THE
      // REMAINING PIECE" named: this used to be positionGeometry.xy (WORLD
      // coords), sampling the mask at the wrong space entirely. The mask
      // target is screen-sized and drawn by runMaskOcclusionPass() through
      // the SAME `camera` this material's own quad is drawn with — so
      // screenUV (THREE's own backend-normalized fragment-position node,
      // three.webgpu.js:37914; matches the v=0-is-top convention already
      // proven by the orientation self-test) lines up by construction,
      // without hand-deriving a new world→screen transform.
      const maskUV = () => THREE.TSL.screenUV;
      const sampleMask = () => THREE.TSL.texture(occlusionMask.texture, maskUV());

      const realChain = (maskSample) =>
        Fn(() => {
          const c = vt.sample(uv()).toVar();
          c.rgb.mulAssign(uTint);
          c.a.mulAssign(uAlpha);
          c.a.mulAssign(occlusionAlphaFactor(maskSample()).factor);
          return c;
        })();

      material.colorNode = realChain(sampleMask);

      // Stash the live uniform handles on the item state: bindMeshToPack writes
      // through these every update, and getDiagnostics reads them back. Losing these
      // two lines is what threw "Cannot read properties of undefined (reading
      // 'uniforms')" and tripped the fallback (2026-07-16) -- a factoring edit ate
      // them along with the code they sat next to.
      state.vt = vt;
      state.appearance = { uTint, uAlpha, uOcclusionElevation, uOcclusionWeights, uUnoccludedAlpha, uOccludedAlpha };

      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false; // we cull explicitly against worldBounds; Three's sphere test is redundant here
      mesh.visible = false;
      scene.add(mesh);

      state.geometry = geometry;
      state.material = material;
      state.mesh = mesh;
      return state;
    }

    // ======================================================================
    // WHOLE-IMAGE MODE (see the _wholeImageEnabled flag's doc). Loads an item's
    // art WHOLE — one texture per tile of planImageTiles, drawn as plain quad(s)
    // — instead of streaming 256px pages through the atlas. No atlas, no cache,
    // no residency, no upload churn: the fix for the WebGPU device loss.
    // ======================================================================

    /** A NodeMaterial that samples ONE whole texture with the same tint/alpha/
     * occlusion chain the streaming path uses. uTint/uAlpha/occlusion are live
     * uniform handles.
     *
     * OCCLUSION HERE IS NEW (2026-07-18) — whole-image mode is the DEFAULT
     * active path for real scenes (see `_wholeImageEnabled`'s own doc), so
     * wiring occlusion into ONLY the streaming material (ensureItemMesh)
     * would make masks.occlusion real but INVISIBLE on every deployed scene.
     * Written fresh rather than sharing a helper with the streaming path's
     * `occlusionAlphaFactor`/`realChain` closures on purpose: that is
     * proven, live-render-affecting code (Rounds 1-9's history), and
     * touching it to extract a shared abstraction is a strictly bigger risk
     * than the small duplication below. Math is IDENTICAL by inspection —
     * both are the direct expression of scene/occlusion.js's
     * `computeOcclusionAlpha`, and if they ever need to change, they change
     * together, on purpose, not by accident of a shared function. */
    // uvScale defaults to [1,1] (raw path: texture IS the image). The BC1 path
    // passes [w/padW, h/padH] < 1: a block-compressed texture's dimensions MUST
    // be a multiple of 4 (WebGPU rejects e.g. 1050×1050 as BC1 — the device-loss
    // trigger this replaced), so it is uploaded at the padded size and the mesh
    // samples only the logical [0..w/padW, 0..h/padH] sub-rect. The padding lives
    // at the bottom/right (v→1, u→1) as edge-clamped replication (see gatherBlock),
    // so clamping the UV max there hides it with no image squash or shift.
    function buildWholeImageMaterial(tex, item, uvScale = [1, 1]) {
      const { Fn, uniform, vec2, vec3, vec4, float, uv, texture, screenUV, step, mix } = THREE.TSL;
      const uTint = uniform(vec3(1, 1, 1));
      const uAlpha = uniform(float(1));
      const uUvScale = uniform(vec2(uvScale[0], uvScale[1]));

      // Occlusion uniforms — see this function's own header. uOcclusionWeights/
      // uUnoccludedAlpha/uOccludedAlpha are STATIC for this item's lifetime
      // (item.occlusion.modes never changes at runtime, and state.occluded/
      // hoverFade are not wired this cut — see runMaskOcclusionPass's header
      // for the RADIAL-only scope), computed ONCE here. uOcclusionElevation is
      // a live uniform, refreshed every frame by refreshItemOcclusionElevation().
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

      const material = new THREE.NodeMaterial();
      material.transparent = true;
      material.depthTest = false;
      material.depthWrite = false;
      material.side = THREE.DoubleSide; // negative scaleX flips winding — see world-quad.js
      material.colorNode = Fn(() => {
        const c = texture(tex, uv().mul(uUvScale)).toVar();
        c.rgb.mulAssign(uTint);
        c.a.mulAssign(uAlpha);
        // Same shape as scene/occlusion.js#computeOcclusionAlpha (and the
        // streaming path's occlusionAlphaFactor): step(edge,x) is 0 when
        // x<edge; 1-step therefore means "the occluder recorded here sits
        // BELOW me". screenUV — see the streaming path's maskUV fix for why
        // this is the correct space (same camera, same target size).
        const maskSample = texture(occlusionMask.texture, screenUV);
        const occ = float(1).sub(step(uOcclusionElevation, maskSample));
        const amounts = occ.mul(uOcclusionWeights);
        const amount = amounts.x.max(amounts.y).max(amounts.z).max(amounts.w);
        // FUNCTION form only — see vt-sample.tsl.js's header: the .mix()
        // METHOD takes its receiver as the interpolant, not the first value,
        // and cost a whole session the one time this project used it by
        // mistake (reference_tsl_method_chaining_trap).
        c.a.mulAssign(mix(uUnoccludedAlpha, uOccludedAlpha, amount));
        return c;
      })();
      return {
        material,
        appearance: { uTint, uAlpha, uOcclusionElevation, uOcclusionWeights, uUnoccludedAlpha, uOccludedAlpha },
      };
    }

    /** Rebuild a tile mesh's world quad from the item's CURRENT placement (called
     * on load and on any placement change). Geometry only — texture is untouched. */
    function setTileGeometry(t, placement, imageW, imageH) {
      t.sub = computeTileSubPlacement(placement, imageW, imageH, t.tile);
      const positions = buildQuadPositions(computeQuadCorners(t.sub));
      if (t.geometry.getAttribute('position')) {
        t.geometry.getAttribute('position').array.set(positions);
        t.geometry.getAttribute('position').needsUpdate = true;
      } else {
        t.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        t.geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
        t.geometry.setIndex(Array.from(QUAD_INDICES));
      }
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
              tex.needsUpdate = true;
              try {
                renderer.initTexture(tex);
              } catch (_) {
                // Backend not up yet — Three uploads the CompressedTexture lazily
                // on first render. Correct, just not forced.
              }
              const wholeTile = { sx: 0, sy: 0, sw: c.width, sh: c.height, col: 0, row: 0 };
              const { material, appearance } = buildWholeImageMaterial(tex, item, [c.width / padW, c.height / padH]);
              const geometry = new THREE.BufferGeometry();
              const t = { tile: wholeTile, sub: null, tex, geometry, material, appearance, mesh: null };
              setTileGeometry(t, state.placement, imageW, imageH);
              const mesh = new THREE.Mesh(geometry, material);
              mesh.frustumCulled = false;
              mesh.visible = false; // the refresh loop decides visibility + renderOrder
              mesh.renderOrder = wi.renderOrder;
              t.mesh = mesh;
              scene.add(mesh);
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
            const { material, appearance } = buildWholeImageMaterial(tex, item);
            const geometry = new THREE.BufferGeometry();
            const t = { tile, sub: null, tex, geometry, material, appearance, mesh: null };
            setTileGeometry(t, state.placement, imageW, imageH);
            const mesh = new THREE.Mesh(geometry, material);
            mesh.frustumCulled = false;
            mesh.visible = false; // the refresh loop decides visibility + renderOrder
            mesh.renderOrder = wi.renderOrder;
            t.mesh = mesh;
            scene.add(mesh);
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
      for (const t of wi.tiles) {
        if (placementChanged) setTileGeometry(t, state.placement, wi.imageSize.width, wi.imageSize.height);
        t.mesh.visible = show;
        t.mesh.renderOrder = item.renderOrder;
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

    /** Ground truth, not theory: actual rendered canvas pixels + one pack's actual indirection buffer contents. */
    /** The cheap, synchronous half: one pack's indirection buffer (plain JS state). */
    function sampleDiagnostics(pack) {
      const out = {};
      if (pack) {
        let nonZeroTexels = 0;
        const distinctSlots = new Set();
        for (let i = 0; i < pack.buf.length; i += 4) {
          if (pack.buf[i + 3] > 0) {
            nonZeroTexels++;
            distinctSlots.add(pack.buf[i] | (pack.buf[i + 1] << 8));
          }
        }
        out.indirectionBuffer = {
          totalTexels: pack.buf.length / 4,
          residentTexels: nonZeroTexels,
          distinctSlotCount: distinctSlots.size,
          distinctSlotsSample: Array.from(distinctSlots).slice(0, 10),
        };
      }
      return out;
    }

    function renderFrame(nowMs) {
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
      updateContinuousInputs(now);
      // Also a small, per-frame CPU-only cost — kept OUT of the `t0` GPU-render
      // timing window below for the same reason updateContinuousInputs is, per
      // the comment above it. See syncTokenPlacements' own header for why this
      // runs every frame rather than only on a document hook.
      syncTokenPlacements();
      // frame.snapshot's res:env third — see its own header above. Also a
      // small per-frame CPU-only cost, kept OUT of the t0 GPU-render window
      // for the same reason as updateContinuousInputs/syncTokenPlacements.
      updateEnvSnapshot();
      const t0 = performance.now();
      // Re-derive the camera from the live view EVERY frame: this is what makes
      // a drag track the cursor at display rate without waiting on streaming,
      // and it is the single place the Y-flip is applied (see updateCamera).
      updateCamera();

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
      lastFramePlanRan = runPassPlan(framePlan.ids, passImpls, {});

      frameTimes.push(performance.now() - t0);
      if (frameTimes.length > 120) frameTimes.shift();
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

      // Pass 3: upload everything decoded, in TIME-BUDGETED CHUNKS (2026-07-16
      // — the worker-decode fix moved the SOURCE-DECODE freeze off the main
      // thread, but a live zoom-thrash-test report then showed a NEW dominant
      // hitch (500ms) whose own snapshot had decode ALREADY FINISHED
      // (sourcesDecoded/idbSlices at their final values right at the hitch) —
      // pointing squarely at THIS loop instead: it used to upload an ENTIRE
      // batch (up to ~120 pages in that report) in one uninterrupted stretch
      // with the render loop explicitly paused for the whole duration. Each
      // individual GPU upload is cheap; 120 of them back-to-back at real
      // driver-call overhead is not. Fixed the same way the decode loop was —
      // yield by TIME BUDGET, not batch-or-nothing — except a chunk boundary
      // here means RESUMING the render loop briefly (a real frame paints)
      // before re-pausing for the next chunk, rather than just awaiting a
      // microtask. `atlas.prepareForUploadBatch()` is safe to call again at
      // the start of every chunk (it only resets the binding-cache staleness
      // the pause/resume dance itself protects against — see that function's
      // own doc); the pause/resume cost itself is cheap and already proven
      // safe (this is the exact same pause the code always did, just more of
      // them instead of one giant one).
      if (decodedForUpload.length > 0) {
        const wasActive = loopActive;
        let lastYieldMs = performance.now();
        // GPU-completion backpressure handle (WebGPU only) — see UPLOAD_PAGES_PER_DRAIN.
        const gpuQueue = renderer.backend?.isWebGPUBackend ? renderer.backend.device?.queue : null;
        let uploadsSinceDrain = 0;
        renderer.setAnimationLoop(null);
        atlas.prepareForUploadBatch();
        for (const { slot, decoded } of decodedForUpload) {
          const srcTex = new THREE.Texture(decoded);
          srcTex.flipY = false;
          srcTex.generateMipmaps = false;
          srcTex.needsUpdate = true;
          atlas.uploadPage(slot, srcTex);
          srcTex.dispose();
          decoded.close?.();

          // Bound the GPU queue depth: after UPLOAD_PAGES_PER_DRAIN uploads, wait
          // for the GPU to actually finish them before enqueuing more (this is the
          // REAL backpressure — the time budget below bounds only MAIN-THREAD time,
          // never queue depth). `drained` defers the timing to the existing `now`
          // read below so this takes NO new wall-clock sample (time/one-clock wall).
          let drained = false;
          if (gpuQueue && ++uploadsSinceDrain >= UPLOAD_PAGES_PER_DRAIN) {
            uploadsSinceDrain = 0;
            try {
              await gpuQueue.onSubmittedWorkDone();
            } catch (_) {
              // A lost/dying device can reject this; the device-lost handler owns
              // the slide. Never let backpressure itself throw out of the loop.
            }
            drained = true;
          }

          const now = performance.now();
          if (drained) {
            // now - lastYieldMs ≈ the drain wait (enqueuing ≤48 pages is ~free CPU),
            // so a BALLOONING value is the GPU failing to keep up — the upload-burst
            // TDR signal the device-lost snapshot reads. Reset the yield clock too:
            // the drain already handed the main thread its breather.
            const drainMs = now - lastYieldMs;
            _uploadDrain.count++;
            if (drainMs > _uploadDrain.maxMs) _uploadDrain.maxMs = drainMs;
            lastYieldMs = now;
          }
          if (shouldYieldByTime(now - lastYieldMs, MAX_MS_PER_UPLOAD_CHUNK)) {
            if (wasActive) renderer.setAnimationLoop(renderFrame); // let a REAL frame paint between chunks
            await nextAnimationFrame();
            renderer.setAnimationLoop(null); // re-pause for the next upload chunk
            atlas.prepareForUploadBatch(); // re-prime the binding cache before resuming uploads
            lastYieldMs = performance.now();
          }
        }
        if (wasActive) renderer.setAnimationLoop(renderFrame); // final restore (never start prematurely at first load)
      }
    }

    /** Write one page's current cache slot into a pack's flattened-pyramid indirection buffer. */
    function writeIndirection(pack, page) {
      const slot = cache.slotOf(page.key);
      if (slot === null) return;
      const o = pack.indirectionLayout.origins[page.mip];
      const x = o.x + page.px;
      const y = o.y + page.py;
      const i = (y * pack.width + x) * 4;
      pack.buf[i] = slot & 0xff;
      pack.buf[i + 1] = (slot >> 8) & 0xff;
      pack.buf[i + 2] = 0;
      pack.buf[i + 3] = 255;
      // This texel now points at `page.key`'s slot. Record it so the cache's
      // onEvict can find and clear THIS texel the instant that slot is
      // reassigned — see clearIndirectionForKey. Registering HERE (rather than
      // at request time) is what keeps the map honest: it maps exactly the
      // texels that actually exist, never the ones we merely asked for.
      pageOwners.set(page.key, { pack, page });
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

    /**
     * Plan + stream one pack's view residency for the current worldRect, then
     * rebuild its indirection buffer fresh from the cache's own slot mapping.
     * This is the per-pack half of the old updateResidency, run for EVERY pack
     * of every visible floor — albedo and each mask alike — so the whole layer
     * stack pages through the one shared cache together (the pile-up proof).
     *
     * worldRect is in the shared (albedo) world units; packs are assumed to
     * share worldSizePx (see buildPack's note), so the same rect plans every
     * pack correctly.
     */
    /**
     * Plan + stream ONE pack's view residency, then rebuild its indirection
     * buffer fresh from the cache's own slot mapping.
     *
     * THE CHANGE THAT MATTERS: residency is planned in this pack's OWN IMAGE
     * space, not in world space. Those used to be the same thing (a floor's art
     * WAS the world), and they are not any more — a tile's texture covers a
     * small patch of canvas, and a Level's art is inset inside the padded rect.
     * `viewRectToImageRect` does the conversion (exactly inverting the item's
     * placement, so it stays correct for a rotated tile).
     *
     * `computeItemViewportPx` supplies the mip selector's screen extent. Passing
     * the canvas size here — the obvious-looking thing — would tell the planner
     * that a 1024px tile drawn 100px wide needs mip 0, i.e. every small tile
     * streams its full resolution: O(tiles) instead of O(screen), which is the
     * exact cost model this whole architecture exists to destroy.
     */
    async function streamPackResidency(pack, state, worldRect) {
      const imageSize = { width: pack.table.worldWidthPx, height: pack.table.worldHeightPx };
      const imageRect = viewRectToImageRect(worldRect, state.placement, imageSize);
      if (!imageRect) {
        // The view doesn't touch this item at all — release its view tier and
        // leave it on coarse pins (which are never evicted, so it stays instantly
        // available, soft, if the camera comes back).
        for (const key of pack.residentViewKeys) cache.unpin(key);
        pack.residentViewKeys = new Set();
        return;
      }

      const quadWorldSize = {
        width: state.worldBounds.maxX - state.worldBounds.minX,
        height: state.worldBounds.maxY - state.worldBounds.minY,
      };
      // Device pixels, not canvasW/H — mip selection should target the actual
      // rendered pixel density (the pixel-ratio-parity fix), same reasoning
      // as describeSceneColor's resolvedW/H, so the streaming path (OFF by
      // default) doesn't quietly stay CSS-pixel-scoped after the default
      // whole-image path was corrected.
      const viewportPx = computeItemViewportPx(worldRect, { width: drawBufW, height: drawBufH }, quadWorldSize);

      // Analytic mip selection (§4.1 — top-down camera, no GPU feedback): the
      // finest mip that resolves at this size, plus BOTH neighbour mips as a
      // prefetch — coarser (zoom-out insurance) AND finer (zoom-in insurance).
      const plan = planResidency(pack.table, imageRect, viewportPx, { guardPages: 1 });
      pack.lastRequestedMip = plan.mip;
      pack.lastRequestedMipFraction = plan.mipFraction; // drives the shader's smooth mip blend

      // RELEASE → MEASURE → REQUEST. The order is the whole point.
      //
      // THE BUG THIS FIXES (live evidence, 2026-07-16, real 2-floor scene, 7 packs):
      // this used to request (and therefore PIN) the new page set and only THEN
      // unpin the pages it no longer wanted. In a static view that is harmless —
      // both sets are identical. But any view change that shifts the page set (a
      // pan, or a zoom that crosses a mip boundary) pinned the OLD set and the NEW
      // set SIMULTANEOUSLY: peak ≈ 2x steady state per pack, ≈3000 pages against a
      // 2048 capacity. And because PageCache never evicts a PINNED slot, nothing
      // could be reclaimed to satisfy the shortfall — so the requests missed, and
      // the (correct) "stuck view-miss" retry re-asked for them on every single
      // update. That is the 215426-misses report: 67s of panning. The report taken
      // at a static default view showed misses: 0 with the identical pin counts
      // (574 coarse + 1320 view = 1894, comfortably inside 2048) — the steady
      // state was never oversubscribed at all, only the TRANSITIONS were.
      //
      // `cache.unpin()` merely clears the pin flag; it does NOT evict (page-cache.js
      // :119). So releasing first is strictly safe — the pages stay resident and
      // merely become LRU-eligible — and it caps peak pinned at max(old, new)
      // instead of old + new.
      const candidates = [...plan.fine, ...plan.prefetchCoarser, ...plan.prefetchFiner].filter(
        (pg) => !pack.coarseKeySet.has(pg.key)
      );
      const candidateKeys = new Set(candidates.map((pg) => pg.key));
      for (const key of pack.residentViewKeys) if (!candidateKeys.has(key)) cache.unpin(key);

      // ADMISSION CONTROL for the speculative tiers. `plan.fine` is what the
      // CURRENT view needs and is always admitted; the prefetch tiers are
      // insurance against a future zoom and are admitted only while the cache can
      // afford to pin them (see PREFETCH_MIN_HEADROOM_FRACTION). Measured AFTER
      // the release above, so pages this pack is already dropping cannot count
      // against its own budget. Headroom counts unprotected slots — PageCache
      // never evicts a pinned slot of either class, so PINNED pages are the real
      // budget, not `residentPages`.
      const cacheStats = cache.stats();
      const headroomPages = cache.capacityPages - (cacheStats.pinnedCoarse + cacheStats.pinnedView);
      const admitPrefetch = headroomPages > cache.capacityPages * PREFETCH_MIN_HEADROOM_FRACTION;
      if (!admitPrefetch) prefetchSkippedPacks++;

      const neededViewPages = admitPrefetch ? candidates : plan.fine.filter((pg) => !pack.coarseKeySet.has(pg.key));
      if (!admitPrefetch) {
        // Declining prefetch also means releasing any speculative pages still held
        // from a previous update — otherwise "declined" would only apply to new
        // ones and the pack would keep hoarding what it can no longer justify.
        const keep = new Set(neededViewPages.map((pg) => pg.key));
        for (const key of pack.residentViewKeys) if (!keep.has(key)) cache.unpin(key);
      }

      // `diff.toUnpin` is deliberately unused: the release above already covers it
      // (prevKeys not in the final needed set), and doing it here would be too late.
      const diff = diffResidency(pack.residentViewKeys, neededViewPages);
      await requestDecodeUpload(pack, diff.toRequest, 'view');
      // GROUND TRUTH, not intent (the "stuck view-miss" bug, 2026-07-16): a page
      // whose request MISSED (cache full, nothing evictable — a normal outcome
      // under pressure) must stay eligible for retry, so only keys that are
      // ACTUALLY resident are recorded. Tracking the ASK instead left a missed
      // page permanently stuck on its coarse-fallback blur even after pressure
      // relieved, self-healing only if you happened to pan away and back.
      pack.residentViewKeys = new Set([...diff.nextKeys].filter((key) => cache.isResident(key)));

      // Rebuild the indirection buffer FRESH from the cache's own current slot
      // mapping every time (never a separately-tracked copy) — this keeps it
      // correct across evictions: an evicted-and-reassigned page must never
      // leave a stale pointer. Both the always-resident coarse pins AND the
      // current view pages are written, so the shader's coarse-fallback walk
      // always finds SOMETHING resident (blur, never magenta).
      pack.buf.fill(0);
      for (const page of pack.coarsePages) writeIndirection(pack, page);
      for (const page of neededViewPages) writeIndirection(pack, page);
      pack.indirectionTexture.needsUpdate = true;
    }

    /**
     * Point one item's shader at a specific pack (its albedo, or a mask when the
     * display layer is switched for visual verification), and push its per-item
     * appearance + occlusion uniforms.
     */
    function bindMeshToPack(state, pack) {
      const u = state.vt.uniforms;
      // NO page-table swap. The texture is baked into the node graph at build time
      // (see vt-sample.tsl.js) — a TextureNode is not a uniform handle, which is
      // the mistake that produced the 2026-07-16 black screen. Switching the
      // displayed pack now requires rebuilding the material; setDisplayLayer is a
      // debug-only mask view, so it is a tracked gap rather than a hot path.
      u.worldSizePx.value.set(pack.table.worldWidthPx, pack.table.worldHeightPx);
      // Only the albedo pack is a PICTURE; every other pack is a mask, i.e. data that
      // must reach the shader byte-exact. See the sampler's srgbDecode.
      u.srgbDecode.value = pack.name === 'albedo' ? 1 : 0;
      // THE WHOLE MIP LAYOUT, in two integers. The shader derives every level's
      // grid and origin from these (vt-sample.tsl.js's header explains why that is
      // exact, and vt-core.test.mjs proves it against the real PageTable).
      u.pages0.value.set(pack.table.pagesX(0), pack.table.pagesY(0));
      u.maxMip.value = pack.table.maxMip;
      u.requestedMip.value = pack.lastRequestedMip; // re-read every update (mip changes with zoom)
      u.requestedMipFrac.value = pack.lastRequestedMipFraction;

      const a = state.appearance;
      const item = state.item;
      const tint = item.tint ?? 0xffffff;
      a.uTint.value.set(((tint >> 16) & 0xff) / 255, ((tint >> 8) & 0xff) / 255, (tint & 0xff) / 255);
      a.uAlpha.value = item.alpha ?? 1;

      // OCCLUSION weights (scene/occlusion.js — the ported model, with citations).
      // `occluded` stays false until the mask producer exists to identify which
      // items a token actually stands under; the weights are still computed from
      // real document data, so wiring the producer in is purely additive.
      const modes = item.occlusion?.modes ?? OCCLUSION_MODES.NONE;
      const st = computeOcclusionState({
        occlusionMode: modes,
        occluded: state.occluded,
        visionActive: occlusionMask.visionActive,
        hoverFadeAmount: state.hoverFade.occlusion,
      });
      a.uOcclusionWeights.value.set(st.fade, st.radial, st.vision, st.surface);
      a.uOcclusionElevation.value = mapElevation(occlusionMask.elevationTable, item.key.elevation);
      a.uUnoccludedAlpha.value = 1;
      a.uOccludedAlpha.value = item.occlusion?.alpha ?? 0;
    }

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

        if (_wholeImageEnabled) {
          // WHOLE-IMAGE PATH: load the art whole and draw it — NO page streaming
          // at all (skipping the pack loop is the entire point: it is the upload
          // churn that lost the device). displayLayer switching is a streaming-
          // path debug feature; whole-image draws the albedo (item.src).
          ensureWholeImageMeshes(state, item);
          refreshWholeImageItem(state, item, show, changed);
        } else {
          // STREAMING PATH (the OFF fallback — MapShine.setWholeImageMode(false)).
          // Stream EVERY pack — albedo AND every mask — through the ONE shared
          // cache: all of an item's layers resident at once, each costing only
          // its visible pages, never a world-resolution texture.
          for (const pack of state.packs.values()) {
            if (onScreen) {
              await streamPackResidency(pack, state, worldRect);
            } else {
              for (const key of pack.residentViewKeys) cache.unpin(key);
              pack.residentViewKeys = new Set();
            }
          }

          ensureItemMesh(state);
          const displayPack = state.packs.get(displayLayerName) ?? state.albedoPack;
          bindMeshToPack(state, displayPack);
          // Isolation is applied HERE, after every streaming decision above, so a
          // hidden item still pages exactly as it would normally — see
          // isolateItemId. `''` is the normal case and costs one string compare.
          state.mesh.visible = show;
          state.mesh.renderOrder = item.renderOrder; // from sortByLayer — THE law
        }
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
        // matching describeSceneColor's own resolvedW/H — see its note.
        allocator.resize(sceneColor, drawBufW, drawBufH, describeSceneColor());
        // light.accumulate's targets track the drawing buffer too (same
        // screenSized law). setSize mutates textures in place, so the samplers
        // stay valid; rebind* only flag needsUpdate.
        allocator.resize(sceneIllum, drawBufW, drawBufH, describeSceneColor());
        allocator.resize(sceneLit, drawBufW, drawBufH, describeSceneColor());
        allocator.resize(sceneColoration, drawBufW, drawBufH, describeSceneColor());
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
    if (_wholeImageEnabled) {
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
            if (_wholeImageEnabled && adjacent) ensureWholeImageMeshes(state, item);
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
     * `decodeHalfFloatRgba`) plus occlusion (`UnsignedByteType`, a different
     * GPU format, decoded via `decodeByteRgba` — see that function's own
     * header for why a byte target needs its own decode path). See
     * `sampleIllumPixel`'s own header (below, on the returned API object)
     * for the full reasoning; factored out here so probing 1 point and
     * probing up to 3 run the EXACT same math, never two slightly-diverging
     * copies of it.
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
      const readOne = async (target, decode) => {
        const raw = await renderer.readRenderTargetPixelsAsync(target, pixel.x, pixel.y, 1, 1);
        return { raw: raw ? Array.from(raw) : null, rgba: decode(raw) };
      };
      const [illum, lit, albedo, coloration, occlusion] = await Promise.all([
        readOne(sceneIllum, decodeHalfFloatRgba),
        readOne(sceneLit, decodeHalfFloatRgba),
        readOne(sceneColor, decodeHalfFloatRgba),
        readOne(sceneColoration, decodeHalfFloatRgba),
        readOne(occlusionMaskRT, decodeByteRgba),
      ]);
      return { worldX, worldY, pixel, onScreen, buffers: { illum, lit, albedo, coloration, occlusion } };
    }

    /** One distinct, high-contrast colour per probe point — index 1..3, wraps if ever called with more. */
    const PROBE_MARKER_COLORS = ['#ff3b30', '#34c759', '#0a84ff'];

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
      setTimeout(() => container.remove(), 30000);
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

    _active = {
      THREE,
      renderer,
      atlas,
      canvas,
      onResize,
      itemStates,
      occlusionMask,
      cache,
      layout,
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
        envLight.illumMaterial.dispose();
        envLight.compositeMaterial.dispose();
      },
      /** Tear down every point-light mesh/material/geometry (see
       * disposeActive). Each light owns its OWN geometry (unlike occlusion
       * discs' shared circle), so geometry disposal happens here too. The
       * three shared ambient-colour uniforms need no disposal — plain JS
       * objects, not GPU resources. */
      disposePointLights() {
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
          mat.fragmentNode = THREE.TSL.vec4(c.rgb[0] / 255, c.rgb[1] / 255, c.rgb[2] / 255, 1);
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
        renderer.setRenderTarget(sceneColor);
        renderer.setClearColor(0x000000, 1);
        renderer.clear(true, true, true);
        renderer.render(probeScene, probeCamera);
        renderer.setRenderTarget(null);

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
        for (const [id, entry] of lightMeshes) {
          if (!entry.mesh.visible) continue;
          activeCount++;
          if (entry.lastHasColor) coloredCount++;
          else colorlessCount++;
          colorationAlphaSum += entry.uColorationAlpha.value;
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
            'no darkness sources, no animations, no elevation occlusion (docs/planning/Light-Parity.md §5)',
          poolSize: lightMeshes.size,
          activeLights: [...lightMeshes.values()].filter((e) => e.mesh.visible).length,
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
        };
      },
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
       * compositor buffer (illum/lit/albedo/coloration/occlusion) at ONE
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
       * decoded via `decodeHalfFloatRgba`; `buffers.occlusion` is the ONE
       * `UnsignedByteType` target and is decoded via `decodeByteRgba` instead
       * (see that function's own header — same 0..1-ish shape either way, so
       * every buffer in the report reads uniformly regardless of its
       * underlying GPU format).
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
      getDiagnostics() {
        const avgMs = frameTimes.length ? frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length : 0;
        // The viewed floor's first item, as the sample subject for the
        // pixel/indirection ground-truth probe below.
        const sampleState = lastItems.length ? itemStates.get(lastItems[0].id) : undefined;
        const albedo = sampleState?.albedoPack;
        const layerResidency = [];
        const layerLoadErrors = [];
        let totalViewResident = 0;
        let totalCoarsePinned = 0;
        let totalCoarseIntended = 0;
        for (const [itemId, state] of itemStates) {
          for (const pack of state.packs.values()) {
            // GROUND TRUTH, not intent (real bug, 2026-07-16: this used to
            // report `pack.coarsePages.length` — the SET SIZE ASKED for —
            // which stayed the same whether or not those pages actually landed
            // in the cache. A coarse-pin request CAN fail under pressure (see
            // updateResidency's phase-1/phase-2 fix comment for the exact
            // scenario) — this masked exactly that failure: a report showing
            // "651 coarse pinned" sat right next to `cacheStats.pinnedCoarse:
            // 434`, a live discrepancy nobody could see. Count actual cache
            // residency per coarse-page key instead.
            const coarseIntended = pack.coarsePages.length;
            let coarseResident = 0;
            for (const page of pack.coarsePages) if (cache.isResident(page.key)) coarseResident++;
            const viewN = pack.residentViewKeys.size;
            totalCoarsePinned += coarseResident;
            totalCoarseIntended += coarseIntended;
            totalViewResident += viewN;
            layerResidency.push({
              item: itemId,
              kind: state.item.kind,
              layer: pack.name,
              coarsePinned: coarseResident,
              coarseIntended,
              viewResident: viewN,
            });
          }
          for (const e of state.layerErrors ?? []) layerLoadErrors.push({ item: itemId, ...e });
        }
        for (const e of itemLoadErrors) layerLoadErrors.push(e);
        // Non-zero here means the "coarse pins are the guaranteed floor"
        // invariant is currently VIOLATED for at least one pack — a page with
        // no resident data at any mip renders magenta, not blur. Should always
        // be 0 after the phase-1/phase-2 ordering fix; kept as a tripwire.
        const coarsePinShortfall = totalCoarseIntended - totalCoarsePinned;

        // THE DRAW LIST, in paint order — the direct answer to "why is this
        // on top of that". Each entry's renderOrder came from sortByLayer
        // (scene/layer-order.js) over its (elevation, sortLayer, sort, zIndex)
        // key, so this table IS the layering, not a summary of it.
        const drawList = lastItems.map((i) => {
          const state = itemStates.get(i.id);
          return {
            renderOrder: i.renderOrder,
            id: i.id,
            kind: i.kind,
            elevation: i.key.elevation,
            sortLayer: i.key.sortLayer,
            sort: i.key.sort,
            zIndex: i.key.zIndex,
            visible:
              state?.mesh?.visible ??
              (state?.wholeImage ? state.wholeImage.tiles.some((tt) => tt.mesh?.visible) : false),
            occlusionModes: i.occlusion?.modes ?? 0,
            // GROUND TRUTH vs RENDERED, for tokens only (2026-07-17 — "stops
            // slightly short" after the moveToken fix). `state.placement` is
            // what refreshItemPlacement last actually wrote to the mesh — a
            // SNAPSHOT from whenever the last residency pass ran. `i._placement
            // .tokenDoc` is the SAME live document reference `lastItems` was
            // built from, re-read HERE, at report-generation time, which can be
            // LATER than the last pass. Re-deriving the footprint fresh from it
            // (not trusting any cached footprint) answers the only question that
            // matters: is MSA's rendered position CURRENTLY behind Foundry's
            // live document, or does it already match right now?
            //   liveVsRendered: null  -> not a token, or not placed yet.
            //   deltaPx ~0            -> MSA matches Foundry AT REPORT TIME. The
            //                            "short" stop was transient (report taken
            //                            mid-movement) or is a rendering/geometry
            //                            issue, not a sync gap.
            //   deltaPx > 0, and a SECOND report taken later still shows the SAME
            //   nonzero delta -> MSA is genuinely stuck behind the live document.
            // WHERE THIS QUAD ACTUALLY IS, and what its page grid was built from
            // (2026-07-17 — the "very large, wrong position, partially
            // transparent, never evicted" ghost). Those four properties together
            // do NOT describe a virtual-texture fault: the sampler's two failure
            // colours are both OPAQUE (magenta = broken pin invariant, black =
            // out-of-world), and a page-level lie would still be confined to that
            // page's own world area rather than appearing "very large". A
            // MISPLACED/MIS-SIZED QUAD explains all four at once — including
            // "never evicted", because a mesh is not a page and zooming can never
            // reclaim it. These two fields tell those apart from ONE report,
            // instead of a fourth round of theory.
            //
            //   placementPx wildly larger than the scene, or origin far outside
            //   world{} -> the quad is wrong: computeItemPlacement / imageSizePx.
            //   placementPx sane, artefact still on screen -> genuinely the
            //   sampler, and the pyramid/mip math is next.
            //
            // imageSizePx is included because it is placement's hidden INPUT
            // (`state.imageSize`, read once from getSourceDimensions at load) and
            // a wrong value there silently mis-sizes the quad forever after —
            // exactly the "never evicted" signature. It is also the field that
            // would expose a regression in readLeadingBytes' PNG-header parse.
            placementPx: state?.placement
              ? {
                  x: Math.round(state.placement.x),
                  y: Math.round(state.placement.y),
                  width: Math.round(state.placement.width),
                  height: Math.round(state.placement.height),
                  rotation: state.placement.rotation ?? 0,
                }
              : null,
            imageSizePx: state?.imageSize ?? null,
            liveVsRendered: (() => {
              if (i.kind !== 'token' || !i._placement?.tokenDoc) return null;
              if (!state?.placement) return null;
              const live = tokenFootprint(i._placement.tokenDoc, i._placement.gridSize);
              const dx = live.centerX - state.placement.x;
              const dy = live.centerY - state.placement.y;
              return {
                liveX: live.centerX,
                liveY: live.centerY,
                renderedX: state.placement.x,
                renderedY: state.placement.y,
                deltaPx: Math.round(Math.hypot(dx, dy) * 10) / 10,
              };
            })(),
            // THE ACTUAL UNIFORM VALUES the shader is running on, read straight off the
            // JS side -- exact, and involving no shader at all. Kept after the bisect
            // scaffolding was stripped because it earned it: printing these is what
            // proved the occlusion weights were clean zeros, which is what forced the
            // search onto the OPERATION rather than the values and found the .mix()
            // trap (reference_tsl_method_chaining_trap).
            uniforms: (() => {
              const a = state?.appearance;
              if (!a) return null;
              return {
                occlusionWeights: a.uOcclusionWeights.value.toArray(),
                occlusionElevation: a.uOcclusionElevation.value,
                alpha: a.uAlpha.value,
                unoccludedAlpha: a.uUnoccludedAlpha.value,
                occludedAlpha: a.uOccludedAlpha.value,
                tint: a.uTint.value.toArray(),
                srgbDecode: state?.vt?.uniforms.srgbDecode.value ?? null,
              };
            })(),
          };
        });

        // A scan of drawList so a token desync doesn't require reading the
        // whole (potentially long) table by eye. Empty array = every token
        // currently matches its live document — the good state.
        const tokenSyncSummary = drawList
          .filter((e) => e.liveVsRendered && e.liveVsRendered.deltaPx > 1)
          .map((e) => ({ id: e.id, deltaPx: e.liveVsRendered.deltaPx }));

        return {
          view,
          layout,
          // buf:scene.color — the first real render target, and the proof that
          // Keyhole's law is IN THE PATH rather than merely imported. If
          // `throughAllocator` is ever false, the law has been routed around.
          sceneColor: _active?.getSceneColorInfo?.() ?? { allocated: false },
          // THE PASS RUNNER (2026-07-18) — proof `renderFrame` is graph-driven,
          // not hardcoded. `ranThisFrame` is what `runPassPlan` actually
          // invoked on the most recent frame; `skipped` names every pass in
          // range that is NOT live yet (seam/future), with its status, so a
          // pass that should have started running (a status flip in
          // passes.js with no code behind it) shows up here as a thrown error
          // instead of silently staying in `skipped`.
          framePlan: _active?.getFramePlanInfo?.() ?? { available: false },
          // frame.snapshot's res:env third, live every frame — time/sun/
          // darkness as measured facts. `status:'future'` is honest: res:view/
          // res:scene are not built, so the DECLARED pass is not fully live
          // even though this reading genuinely is.
          envSnapshot: _active?.getEnvSnapshotInfo?.() ?? { available: false },
          // masks.occlusion (2026-07-18) — see graph/passes.js's own note for
          // the RADIAL-only scope. `elevationTable` should read something
          // other than [-Infinity] whenever an occludable token is on screen.
          occlusion: _active?.getOcclusionMaskInfo?.() ?? { available: false },
          // light.accumulate's point-light rung (2026-07-18) — see
          // graph/passes.js's own note for the illumination-only scope.
          // `activeLights` should be > 0 whenever the scene has torches/
          // lamps within the current view.
          pointLights: _active?.getPointLightsInfo?.() ?? { available: false },
          // region-driven darkness (2026-07-19) — see graph/passes.js's own
          // note. `activeRegions` should be > 0 whenever a darkness-
          // adjusting region is on screen.
          regionDarkness: _active?.getRegionDarknessInfo?.() ?? { available: false },
          // SHADERS (docs/planning/Shaders.md).  is the fork
          // in the road, not a detail: WITH it, compileAsync hands work to driver
          // threads; WITHOUT it, compileAsync resolves instantly having done
          // nothing and the compile stalls the first useProgram instead. This
          // project does not guess about extensions on the design-floor GPU.
          shaders: {
            parallelShaderCompile: !!renderer.backend?.extensions?.get?.('KHR_parallel_shader_compile'),
            precompileMs: shaderCompileMs,
            // Program COUNT is the thing that explodes as effects land (N effects x
            // M variants), so it is watched from the start. Identical ShaderMaterial
            // source shares ONE program (three.module.js:36407 keys the cache on
            // source identity), so today every item mesh costs 1 program between them.
            // renderer.info.programs is WebGLRenderer-only; the node renderer
            // reports differently. Left null rather than guessing a number.
            programCount: renderer.info?.programs?.length ?? null,
            backend: renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2',
          },
          // GROUND TRUTH: is MSA the thing on screen right now, or is Foundry?
          // This could NOT be answered from a report during the 2026-07-16
          // non-square incident — the diagnostics described MSA's internals in
          // detail while saying nothing about whether any of it reached the
          // display. Read from the DOM, not from intent.
          ...describeRenderMode({ canvas, loopActive }),
          // Non-zero = at least one pack could not afford its speculative tier this
          // update. A few is healthy self-limiting; ALL of them, every update,
          // means the required working set itself is at the budget.
          prefetchSkippedPacks,
          // DOES A DOCUMENT CHANGE REACH THE SCREEN? Three counters that make
          // the three candidate causes distinguishable in ONE report — see
          // `lastUpdate`'s declaration for the decision table. Move a token,
          // do NOT pan, then read this.
          documentSync: {
            ...lastUpdate,
            totalPasses: passSeq,
            // Newest last. `docRefreshes` counts HOOK FIRINGS; `totalPasses`
            // counts REAL updateResidency() executions — hooks firing back-to-
            // back synchronously (exactly what two movement segments' paired
            // updateToken+moveToken do) coalesce into fewer passes via
            // scheduleResidencyUpdate's do-while. The two numbers disagreeing is
            // NORMAL, not a bug on its own.
            passLog: tokenPassLog,
            interpretation:
              'Move a token WITHOUT panning, then read these. `byHook` names WHICH hooks drove a ' +
              'refresh. `passLog` is the decisive one for a REMAINING mismatch: it is one row per ' +
              'token per REAL pass (not per hook — see totalPasses vs docRefreshes above). Find the ' +
              "moved token's id in passLog: if its LAST row already equals liveVsRendered.live{X,Y} " +
              'for that item in drawList, MSA is caught up and any on-screen lag is the render not ' +
              'having painted a new frame yet, not a stale read. If its last row does NOT match, and ' +
              'a SECOND report (taken a few seconds later, nothing else touched) shows no NEW row for ' +
              'that id, no further pass is even being attempted — Foundry is not telling us. If a ' +
              'later report DOES add a new, correct row, this is TRANSIENT lag under cache pressure ' +
              '(cross-reference cacheStats.freePages and layerResidencyTotals.coarsePinShortfall — ' +
              'both nonzero means the cache is already oversubscribed and streaming the moved-to ' +
              'position can legitimately take a beat).',
          },
          canvasSizePx: { width: canvasW, height: canvasH },
          // The pixel-ratio-parity fix (2026-07-19): drawBufSizePx is what the
          // world quad actually renders/samples at; it now legitimately
          // differs from canvasSizePx whenever pixelRatio > 1. If they ever
          // look wrong together, this is the first thing to check.
          drawBufSizePx: { width: drawBufW, height: drawBufH },
          pixelRatio,
          mountedInBoard: mount.fill && mount.host !== document.body,
          cacheStats: cache.stats(),
          // WHOLE-IMAGE MODE STATE — the primary instrument for the "load images
          // like PIXI" path (2026-07-17). Read this FIRST when the new path
          // misbehaves: it names, per item, exactly what happened.
          wholeImage: (() => {
            const perItem = [];
            let totalBytes = 0;
            let totalBc1Bytes = 0;
            let ready = 0;
            let errors = 0;
            let freed = 0;
            let retained = 0;
            let appliedCount = 0;
            for (const [id, s] of itemStates) {
              const wi = s.wholeImage;
              if (!wi) continue;
              // HONEST bytes: count what the GPU actually holds for THIS item —
              // BC1 (8×) or BC7 (2× vs BC1) when compressed, raw RGBA8 otherwise.
              // (Before BC7 landed this always counted raw and over-reported the
              // compressed floors ~8× — memory: feedback_instruments_must_not_lie.)
              const isBc7 = wi.compressed && wi.compressed.startsWith('bc7');
              const isBc1 = wi.compressed && wi.compressed.startsWith('bc1');
              const rs = wi.rawScale || 1; // <1 only on the capped raw fallback
              let bytes = 0;
              for (const tt of wi.tiles) {
                // BC1 reference size (projection column) — the FULL chain's
                // bytes, matching what real BC1 usage now costs (mip-chain fix).
                totalBc1Bytes += mipChainByteLength('bc1', tt.tile.sw, tt.tile.sh);
                if (isBc7) bytes += mipChainByteLength('bc7', tt.tile.sw, tt.tile.sh);
                else if (isBc1) bytes += mipChainByteLength('bc1', tt.tile.sw, tt.tile.sh);
                // raw RGBA8 at the ACTUALLY uploaded size (the fallback cap shrinks
                // it), *4/3 for its own now-real mip chain — see the other
                // wholeImage snapshot above for why this one stays an
                // approximation instead of an exact per-level sum.
                else bytes += Math.round(tt.tile.sw * rs) * Math.round(tt.tile.sh * rs) * 4 * (4 / 3);
              }
              totalBytes += bytes;
              freed += wi.bitmapsFreed;
              retained += wi.bitmapsRetained;
              if (isBc1 || isBc7) appliedCount++;
              if (wi.status === 'ready') ready++;
              if (wi.status === 'error') errors++;
              perItem.push({
                id,
                src: wi.src,
                status: wi.status, // loading | ready | error
                error: wi.error,
                grid: wi.plan ? `${wi.plan.cols}×${wi.plan.rows}${wi.plan.whole ? ' (whole)' : ''}` : null,
                imageSize: wi.imageSize,
                tilesDecoded: wi.tiles.length,
                tilesPlanned: wi.plan?.tiles ?? null,
                approxVramMB: +(bytes / (1024 * 1024)).toFixed(1),
                visible: wi.tiles.some((tt) => tt.mesh?.visible),
                renderOrder: wi.renderOrder,
                bitmapsFreed: wi.bitmapsFreed,
                bitmapsRetained: wi.bitmapsRetained,
                compressed: wi.compressed, // null | bc1|bc7 (+ (cached)) | error:fellback
                alphaStats: wi.alphaStats, // {min,max,mean} of the DECODED source alpha, pre-encode, or null
              });
            }
            return {
              enabled: _wholeImageEnabled,
              textureLimit,
              itemCount: perItem.length,
              ready,
              errors,
              approxVramMB: +(totalBytes / (1024 * 1024)).toFixed(1),
              bitmapsFreed: freed,
              bitmapsRetained: retained,
              atlasStillAllocatedMB: atlas ? +(layout.totalBytes / (1024 * 1024)).toFixed(1) : 0,
              estTextureVramMB: +((totalBytes + (atlas ? layout.totalBytes : 0)) / (1024 * 1024)).toFixed(1),
              // PROJECTION (not yet applied): what these exact floors would occupy
              // as GPU-compressed textures. The device dies ~2.5GB uncompressed
              // (estTextureVramMB); compressed, both floors fit well under 1GB —
              // the fight-for-WebGPU fix. Encoder is landed + Node-tested
              // (block-compress.js); encode→IndexedDB-cache→CompressedTexture is next.
              compressed: {
                // REFERENCE projections (hypothetical whole-scene costs), NOT the
                // live bill — that is estTextureVramMB above, now honest per-format.
                bc1IfAllMB: +(totalBc1Bytes / (1024 * 1024)).toFixed(1), // 0.5 B/px, 8× smaller
                bc7IfAllMB: +((totalBc1Bytes * 2) / (1024 * 1024)).toFixed(1), // 1 B/px, 4×, carries alpha
                applied: appliedCount > 0, // are any items ACTUALLY compressed now?
                appliedItems: appliedCount,
                worker: getCompressedTextureStats(), // requests/bc1/bc7/failed/cached
              },
              interpretation:
                'Whole-image mode draws each item as plain texture(s) with NO page streaming — the fix ' +
                'for the upload-churn device loss. Per item, status is loading|ready|error (error names ' +
                'the failed src). grid "1×1 (whole)" = one texture (a 12000² floor at the 16384 cap); ' +
                '"2×2" = the quarter-split fallback on a smaller texture limit. tilesDecoded < ' +
                'tilesPlanned mid-load is normal; staying below it, or status:error, is a LOAD failure ' +
                '(check src/error). enabled:false = reverted to streaming via ' +
                'MapShine.setWholeImageMode(false). CRUCIAL: if the screen is BLACK yet every item is ' +
                'status:ready + visible:true, it is NOT a load failure — the quads are drawing wrong ' +
                '(offscreen placement, a Y-flip, or a colorSpace/sample bug); that is a geometry/shader ' +
                'issue, not a decode one. errors>0 with the streaming path idle means those items show ' +
                'nothing at all. MEMORY (the floor-switch device-loss hunt, 2026-07-18): bitmapsFreed ' +
                'is decoded CPU bitmaps closed right after GPU upload; bitmapsRetained MUST stay 0 — a ' +
                'nonzero value means a ~w·h·4 bitmap (576 MB for a 12000² tile) is still held alongside ' +
                'its GPU copy, the exact doubling that blew the memory ceiling. estTextureVramMB is the ' +
                'honest texture bill: whole-image textures PLUS atlasStillAllocatedMB. As of 2026-07-18 ' +
                'the 512MB streaming atlas is NO LONGER allocated in whole-image mode (atlasStillAllocatedMB ' +
                'should read 0) — we now carry ONLY the floor textures, matching Foundry PIXI. estTextureVramMB ' +
                'is now honest PER FORMAT: opaque items are BC1 (8× smaller), alpha items BC7 (4×), raw only ' +
                'if compression was unavailable. Uncompressed, both floors full-res is ~2.75 GB (the old ' +
                'device-loss trigger); with BC1+BC7 the same scene is ~0.5 GB — the `compressed` block shows ' +
                'the reference projections. If estTextureVramMB still climbs toward ~2.5 GB, compression is ' +
                'NOT being applied (check compressed.applied / per-item compressed) — Chrome WebGPU TDRs the ' +
                'device on a big allocation under pressure where its WebGL would not. Per-item alphaStats ' +
                '{min,max,mean} (2026-07-18) is the SOURCE alpha the decoder handed the worker, BEFORE BC7 ' +
                'touches it — added because a BC7 item can be status:ready+visible:true+compressed:"bc7" ' +
                '(every OTHER instrument says success) and still render solid black. min/max near 255 means ' +
                'the decode is fine and the bug is downstream (encode/pack/GPU-upload); min/max near 0 means ' +
                'it was ALREADY wrong before BC7 ever ran (decode/premultiply). null = raw path or pre-fix cache.',
              items: perItem,
            };
          })(),
          drawList,
          // Empty = every token matches its live document right now (the good
          // state). Non-empty names exactly which tokens are behind and by how
          // much, without reading the full (potentially long) drawList by eye.
          tokenSyncSummary,
          itemsLoaded: itemStates.size,
          world,
          // Multi-LAYER (Keyhole §4.1, the mask pile-up killer): which layer is
          // currently displayed, the packs loaded on the viewed floor, and the
          // per-(floor×pack) residency breakdown + its totals — the evidence
          // that every mask coexists with albedo inside the ONE fixed cache.
          displayLayer: displayLayerName,
          sampleItemLayers: sampleState ? Array.from(sampleState.packs.keys()) : [],
          layerResidency,
          // Why any mask is missing from layerResidency — 404 (not synced to the
          // Foundry server) vs a decode/other error. Empty = every layer loaded.
          layerLoadErrors,
          layerResidencyTotals: {
            packs: layerResidency.length,
            coarsePinnedPages: totalCoarsePinned, // GROUND TRUTH — actually resident, not just requested
            coarseIntendedPages: totalCoarseIntended, // what was ASKED for (pack.coarsePages.length summed)
            // Must be 0 — any shortfall means a coarse-pin request failed under
            // pressure, i.e. some page has NO resident fallback at any mip
            // (renders magenta, not blur). See updateResidency's phase-1/
            // phase-2 comment for the exact bug this tripwire caught.
            coarsePinShortfall,
            viewResidentPages: totalViewResident,
            residentPages: cache.stats().residentPages,
            capacityPages: cache.stats().capacityPages,
          },
          // THE SCENE-WIDE COARSE BUDGET (item 1b, 2026-07-17) — what every
          // pack's coarse-pin request is capped against, and why. Fixes a
          // real 3-floor scene that measured coarseIntendedPages:808 against a
          // 246-page shortfall, freePages:0, and a 2.6s frame freeze — nothing
          // was dividing "~tens of pages total" (§4.1) by how many packs the
          // scene actually had.
          coarsePinBudget: {
            ...currentCoarseBudget,
            // GROUND TRUTH for whether the reserve is actually holding —
            // check THESE two, not the interpretation text below. The first
            // cut (capping what each pack ASKS for) landed alone and still
            // measured a real 81-page shortfall on the author's scene: it
            // capped the ask but never reserved the ROOM, so a busy viewport
            // could still pin the whole cache with 'view' pages before a
            // background pack's coarse request got a turn. cacheStats below
            // is where that second half (page-cache.js's coarseReservePages)
            // actually lives.
            cacheReserveCheck: {
              coarseReservePages: cache.stats().coarseReservePages,
              coarseReserveMisses: cache.stats().coarseReserveMisses,
              interpretation:
                'coarseReserveMisses should read 0 — the reserve is specifically what makes a coarse-pin ' +
                'miss structurally impossible (page-cache.js). If nonzero, the reserve itself is undersized ' +
                'or was not set before some pack requested its coarse pin — a real bug, not routine pressure.',
            },
            interpretation:
              `Every new pack's coarse pin is capped at perPackMaxPages (currently ` +
              `${currentCoarseBudget.perPackMaxPages}), so the SUM across all ${currentCoarseBudget.packCount} ` +
              `packs in the scene stays at or under totalBudgetPages (${currentCoarseBudget.totalBudgetPages}) — ` +
              `a fixed fraction of capacityPages, not a per-pack allowance nobody was adding up. That caps the ` +
              'ASK; cacheReserveCheck (above) covers the ROOM — page-cache.js reserves totalBudgetPages worth ' +
              "of slots that 'view' requests may never claim, so a busy viewport can't fill the whole cache " +
              "before a background pack's coarse request gets a turn. The tradeoff: a pack that would have " +
              'gotten more (a big Level background, previously ~82 pages) now gets less when many packs share ' +
              'the scene, AND the view tier itself now has less room at its OWN peak (it can no longer ever ' +
              'claim the pages reserved for coarse) — both a softer coarse/blurred fallback and slightly less ' +
              'peak view-tier sharpness under heavy pan/zoom, traded for the shortfall/freeze going away. Tune ' +
              'coarseBudgetFraction (residency.js, default 0.25) if that tradeoff feels wrong.',
          },
          // Decode-memory proof (the Bush-failure fix): heldSources is the peak
          // number of full 576MB source bitmaps alive at once — bounded by the
          // semaphore, NOT by layers×floors. idbHits climbing vs idbSlices means
          // pages are being served from IndexedDB (no source re-decode).
          decodeStats: getDecodeStats(),
          // Multi-floor compositing (§ header note): which OTHER floors are
          // ALSO being rendered alongside the current one this update. Derived
          // from the draw list rather than tracked separately: an item knows
          // which levels it is visible on, so the composited set is a fact about
          // the list, not a second piece of state that can disagree with it.
          compositedLevelIds: Array.from(new Set(lastItems.flatMap((i) => i.visibleOnLevelIds ?? []))),
          currentFloorResidentCount: albedo?.residentViewKeys.size ?? 0,
          // Multi-mip state (coarse-fallback gate evidence): the finest mip
          // being tried this view, the floor's top-level, its coarse-pin depth
          // + page count, and the packed-pyramid indirection dimensions (all
          // for the DISPLAYED pack).
          mip: {
            requested: sampleState?.vt?.uniforms.requestedMip.value ?? null,
            // 1 = the sRGB decode is live. Still-washed-out + 0 here = the fix never bound.
            srgbDecode: sampleState?.vt?.uniforms.srgbDecode.value ?? null,
            // Smooth mip blending (2026-07-16): the fractional companion to
            // `requested` — its integer part MUST equal `requested`; its
            // fractional part is the blend weight toward `requested+1`. If
            // these ever disagree, the blend uniform desynced from the walk's
            // starting mip — flag it.
            requestedFraction: sampleState?.vt?.uniforms.requestedMipFrac.value ?? null,
            max: sampleState?.vt?.uniforms.maxMip.value ?? null,
            coarseTopMips: albedo?.coarseTopMips ?? null,
            coarsePinnedPages: albedo?.coarsePages.length ?? null,
            indirectionPyramid: albedo ? `${albedo.width}x${albedo.height}` : null,
          },
          renderMsAvgLast120: Math.round(avgMs * 100) / 100,
          // HITCH STATS (2026-07-16) — the true "did we freeze" signal,
          // distinct from renderMsAvgLast120 above (which only measures
          // render()'s own duration, never a stall elsewhere on the single JS
          // thread that delays the NEXT frame from running at all). Non-empty
          // recentHitches with a real gapMs is direct, ground-truth evidence
          // of an actual main-thread block — see runZoomThrashTest for a
          // dedicated, repeatable way to trigger and capture these.
          hitchStats: {
            frameGapAvgMs:
              frameGapTimes.length > 0
                ? Math.round((frameGapTimes.reduce((a, b) => a + b, 0) / frameGapTimes.length) * 10) / 10
                : null,
            frameGapMaxMs: frameGapTimes.length > 0 ? Math.round(Math.max(...frameGapTimes) * 10) / 10 : null,
            // PERCENTILES (2026-07-18) — added for the infrastructure menu's
            // baseline-capture report (Track 2, item 5): avg/max alone hide
            // whether a session was smooth-with-one-spike or consistently
            // choppy. Computed from a SORTED COPY of the same rolling window
            // avg/max already read — no new sampling, no new clock (this
            // report only runs on demand, not per frame, so sorting ≤300
            // numbers here is free).
            frameGapP50Ms: percentileMs(frameGapTimes, 0.5),
            frameGapP95Ms: percentileMs(frameGapTimes, 0.95),
            frameGapP99Ms: percentileMs(frameGapTimes, 0.99),
            frameGapSampleCount: frameGapTimes.length,
            hitchThresholdMs: HITCH_THRESHOLD_MS,
            hitchCount: hitchLog.length,
            recentHitches: hitchLog.slice(-10),
          },
          lastError,
          ...sampleDiagnostics(sampleState?.packs.get(displayLayerName) ?? albedo),
          // Camera smoothing (2026-07-16): live state of the held-key pan /
          // eased-zoom system — the first thing to check if panning ever
          // seems stuck (heldPanKeys non-empty with no key actually held is
          // exactly the "stuck key" class clearHeldKeys guards against) or
          // zoom never settles (targetHalfSpanPx should converge toward
          // mip.requestedFraction's implied value, not sit far from it forever).
          continuousInput: {
            heldPanKeys: Array.from(heldPanKeys),
            panVelocity,
            targetHalfSpanPx,
            currentHalfSpanPx: view.halfSpanPx,
          },
          controls:
            'Drag to pan, wheel to zoom (native Foundry feel, now eased). Also: Arrow keys/WASD pan (continuous while held), +/- zoom, 0-2 or Tab floor-switch (keys work anywhere, not in a text field).',
        };
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

export async function setVtPanViewerFloor(floorIndex) {
  if (!_active) return { skipped: true, reason: 'viewer not started' };
  const changed = await _active.setFloorIndex(floorIndex);
  return { changed, ..._active.getDiagnostics() };
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
