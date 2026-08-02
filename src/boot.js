/**
 * Map Shine Advanced 0.6.0
 * ========================
 * src/boot.js — the ONE entry point of the V3 rebirth (docs/planning/Keyhole.md §3).
 *
 * `module.json`'s `esmodules` points at this file and NOTHING else. Everything the
 * module does in the new architecture is reached from here: init/ready hooks, the
 * virtual-texture core (src/vt/), the frame graph (src/graph/), the Foundry adapter
 * (src/foundry/), and the effects. None of it exists yet — this is Stage 0.
 *
 * THE DOCTRINE (Keyhole §0), enforced from the first line:
 *   1. One path per behavior. No fallback that routes through legacy code.
 *   2. `legacy/` is frozen and quarantined — src/ NEVER imports from legacy/.
 *   3. Nothing is ever allocated at world resolution (enforced later in the allocator).
 *   4. The hard case ships first (the torture scene is Stage 0's fixture).
 *
 * STAGE 0 (Keyhole §8) proved the new tree was wired and the new Three booted —
 * originally a colored triangle; the boot heartbeat below now proves the same
 * thing with a live FPS/frame-gap readout instead (2026-07-20 — the triangle
 * was a good instrument while the eye had to judge stutter directly, and stopped
 * adding anything once the numbers said it plainly). Real map rendering has
 * long since landed on top of it.
 *
 * This file also hosts the MSA CONTROL PANEL (src/diag/debug-panel.js) in the
 * same corner box as the heartbeat — docs/planning/Control-Panel.md's five-zone
 * shell, evolved from what started as a one-click-report dev panel. Its Lab zone
 * is still that registry: any module can add its own report via
 * `MapShine.debug.registerReport(...)`.
 */

// THE NODE BUILD (docs/planning/Shaders.md). It does NOT export WebGLRenderer —
// which is why the TSL port was all-or-nothing: one import, and every renderer
// moves at once. WebGPURenderer picks WebGPU or WebGL2 itself.
import * as THREE from './vendor/three/three.webgpu.js';
import { installSoak } from './diag/soak.js';
import { installDebugPanel } from './diag/debug-panel.js';
import { installFlightRecorder } from './diag/flight-recorder.js';
import { createPerfLab, runSweep } from './diag/perf-lab.js';
import { describeWindBake } from './diag/wind-probe.js';
// THE PERFORMANCE INSTRUMENT (docs/planning/Performance.md). The taxonomy and
// the report brain are pure and land ahead of the profiler that will feed them,
// so `perf-profile` is registered from day one and honestly answers
// "not armed yet" rather than existing as an unreachable module.
import {
  EFFECT_ZONING,
  FRAME_BUDGET_MS,
  PASS_BUDGETS_MS,
  ZONES,
  validateEffectZoning,
  validateZoneTaxonomy,
} from './diag/perf-zones.js';
import { buildPerfReport, summarizeTierComparison } from './diag/perf-report.js';
import { buildVramInventory } from './diag/vram-inventory.js';
import { createFrameProfiler } from './diag/frame-profiler.js';
import { createProfiledFrameWaiter, runProfileSession } from './diag/perf-session.js';
// The benchmark route drives the EXISTING camera-path player rather than growing
// a second motion system — a fixed route is what makes two runs comparable.
import { generatePresetKeyframes, normalizeCameraPath, playCameraPath, stopCameraPath } from './foundry/index.js';

/**
 * The benchmark route's duration. 60s at a steady traverse (author, 2026-07-28)
 * — long enough that virtual-texture residency, bakes and any slow leak all get
 * a chance to show up, and long enough that no single unlucky frame can dominate
 * the averages. The profiler's gap ring is sized to hold the whole run.
 */
const BENCHMARK_SWEEP_MS = 60000;
/**
 * How long to settle after FORCING a new performance tier, before a tier-
 * comparison run starts measuring it (see `perf-report-all-tiers` below). 3×
 * `DEFAULT_SETTLE_FRAMES` (30) — a tier change can rebuild several effects'
 * materials at once (candle flame + light, water/specular/fluid's own rungs),
 * not just settle the usual "first residency pass" a normal profile settles
 * for. Author, 2026-07-29: "I don't mind if it takes longer, we can give
 * things longer to settle" — this is that ask, as a number.
 */
const TIER_SETTLE_FRAMES = 90;
import { createPerfHud } from './diag/perf-hud.js';
import { createLogger } from './core/log.js';
import { ambientVectorFromWind, phaseBoundaryHours, resolveSky, applySkyEdit } from './world/index.js';
import {
  runVtLiveDecodeTest,
  startVtPanViewer,
  stopVtPanViewer,
  getVtPanViewerDiagnostics,
  setVtPanViewerFloor,
  setVtPanViewerGpuProbe,
  setVtPanViewerGpuZoneTimer,
  getVtPanViewerGpuZoneStatus,
  readVtPanViewerRenderInfo,
  readVtPanViewerFrameSamples,
  setVtPanViewerWindOverlay,
  setVtPanViewerWindOverlayResolution,
  setVtPanViewerWindDiagnosticParticles,
  setVtPanViewerWindGusts,
  setVtPanViewerWindAmbient,
  setVtPanViewerSunHour,
  sweepVtPanViewerTimeOfDay,
  setVtPanViewerTimeRate,
  setVtPanViewerTimeMode,
  getVtPanViewerTimeDialState,
  setVtPanViewerSkyRealism,
  setVtPanViewerGradeEnvStrength,
  setVtPanViewerCloudCover,
  rebakeVtPanViewerWindField,
  triggerVtPanViewerWindDoorImpulse,
  resetVtPanViewerFrameStats,
  setVtPanViewerIsolateItem,
  getVtPanViewerDrawListIds,
  getVtPanViewerIsolateItemId,
  runZoomThrashTest,
  soakPanStep,
  soakSwitchFloorStep,
  soakZoomStep,
  refreshVtPanViewerItems,
  runOrientationSelfTest,
  getParticleReadback,
  getSourceBitmap,
  readPageBitmapPixels,
  resolveRendererRequiredLimits,
  setDarknessRealism,
  getDarknessRealism,
  setAlbedoClarity,
  getAlbedoClarity,
  resetAlbedoClarity,
  setUiShadow,
  getUiShadow,
  sampleVtPanViewerIllumPixel,
  probeVtPanViewerPixels,
  runInteractiveVtPanViewerPixelProbe,
  probeVtPanViewerWindAndParticles,
  runInteractiveVtPanViewerWindProbe,
  startVtPanViewerLiveMarkers,
  stopVtPanViewerLiveMarkers,
} from './vt/index.js';
import { PASSES, validatePassGraph, PASS_SEAMS, PASS_IMPLS } from './graph/index.js';
import {
  createEffectRegistry,
  UI_WINDOW_SHADOW,
  UI_SHADOW_PARAMS,
  CANDLE_FLAME,
  CANDLE_FLAME_PARAMS,
  LIGHTNING,
  LIGHTNING_PARAMS,
  DOOR_GRAPHICS,
  VEGETATION,
  VEGETATION_PARAMS,
  BLOOM,
  BLOOM_PARAMS,
  BLOOM_PRESETS,
  bloomPreset,
  SUN_SHADOWS,
  layerSmearTierPlan,
  SUN_SHADOW_PARAMS,
  describeEffectSettings,
  deriveEffectLayers,
  resolveEffectEnabled,
  effectEnableKey,
  GLOBAL_SETTING_KEYS,
  PERFORMANCE_PROFILES,
  ENABLE_OVERRIDES,
  choiceLabels,
  resolveAnchorSizePx,
  resolveAnchorLightRadiusPx,
  GRADE_PRESETS,
  gradePreset,
  GRADE,
  GRADE_LOOK_PARAMS,
} from './effects/index.js';
import { NotBuiltError } from './core/not-built.js';
import {
  getActiveSceneFloors,
  computeVisibleFloorIndices,
  collectSceneLayers,
  collectTokens,
  diagnoseTokens,
  SCENE_LAYER_DOCUMENTS,
  TOKEN_DOCUMENTS,
  computeSceneDimensions,
  computeItemPlacement,
  floorElevationBands,
  readGridDistancePixels,
  discoverAuthoredMasks,
  importV2Anchors,
  registerPixiProxy,
  getPixiResidencyReport,
  registerCanvasCompositing,
  applyArtSuppression,
  restoreFoundryArt,
  getCanvasCompositingReport,
  registerCanvasTearDownWatchdog,
  registerSettings,
  readSetting,
  writeSetting,
  registerControlPanelButton,
  syncControlPanelButtonState,
  watchSceneWallStructure,
  watchDoorOpenings,
  readSceneDoors,
  watchDoorGraphics,
  saveAuthoredAnchors,
  loadAuthoredAnchors,
  registerSkySettings,
  readWorldSky,
  writeWorldSky,
  readSceneSky,
  writeSceneSky,
  setSceneSkyOverride,
  watchSceneSky,
} from './foundry/index.js';
import { engageFoundryFallback } from './diag/render-fallback.js';
import { buildSettingsPanel } from './diag/settings-panel.js';
import { registerMarkerSource, getAllMarkerPoints } from './diag/marker-overlay.js';
import {
  beginSceneLoad,
  beginSceneLoadPhase,
  reportSceneLoadProgress,
  endSceneLoad,
  getLoadingScreenState,
  resetLoadingSceneMemory,
} from './ui/loading-screen.js';
import { LOAD_PHASES } from './ui/load-progress.js';
import { installPainter, openCameraPathDialog, installAnchorMode, createAstrolabe } from './ui/index.js';
import {
  SORT_LAYERS,
  makeLayerKey,
  createMaskAuthority,
  RequiredMaskMissingError,
  createSkyReachAccess,
  createAnchorAuthority,
  mergeAnchorSources,
  anchorKindByV2EffectTarget,
  anchorKindById,
  maskKindById,
  assembleLayerDescriptors,
} from './scene/index.js';
import {
  buildEffectCard,
  buildParamControl,
  buildInheritableRangeRow,
  collapsedStatusLine,
} from './diag/effect-controls.js';
import {
  createWaterSeams,
  createWaterRegistration,
  WATER_PARAMS,
  createFluidSeams,
  createFluidRegistration,
  FLUID_PARAMS,
  createSpecularSeams,
  createSpecularRegistration,
  SPECULAR_PARAMS,
  SPECULAR_DEBUG_CHANNELS,
  createWindowSeams,
  createWindowRegistration,
  WINDOW_PARAMS,
  WINDOW_DEBUG_CHANNELS,
} from './effects/index.js';
import {
  buildSunShadowsReport,
  buildWaterBodyReport,
  buildSpecularReport,
  buildWindowLightReport,
} from './diag/effect-status-reports.js';

const MODULE_ID = 'map-shine-advanced';

/** Boot-heartbeat HUD width — the live perf/info readout above the control panel. */
const HEARTBEAT_W = 210;
/** The heartbeat's own render target. Tiny and visually hidden (author, 2026-07-20:
 * "the rotating triangle isn't adding anything" — now that the numbers say it
 * directly, nobody needs to watch a shape spin to infer the same fact) — but the
 * renderer still submits a REAL frame here every tick, on purpose: that is what
 * keeps this loop an independent proof the main thread isn't blocked (a stall here
 * is a stall everywhere), keeps soak's context-loss watch pointed at a live WebGPU
 * canvas, and keeps the frame-gap/FPS sampling below physically honest. */
const HEARTBEAT_CANVAS_PX = 8;
const VERSION = '0.6.0-dev.0';
// (The product CODENAME was removed 2026-07-27 — there isn't one any more.
// "Keyhole" survives as the name of the ARCHITECTURE and its plan of record
// (docs/planning/Keyhole.md, graph/three-allocator.js#enforceKeyholeLaw): the
// O(screen)-not-O(world) law. It is no longer shown to a user, stamped into a
// report, or printed in the console banner.)
const STAGE = 'Stage 1 · the law, running';

const TAG = `[MSA ${VERSION}]`;

/**
 * THE FRAME PROFILER (docs/planning/Performance.md), constructed once and handed
 * to the viewer as a seam. Disarmed — which it is in all normal play — every
 * entry point returns on a single boolean read before touching a clock, an array
 * or an allocation, so the render loop pays essentially nothing for its presence.
 * Owned HERE rather than inside the viewer so the perf lab can arm it without
 * reaching through the render loop for a handle.
 */
const perfProfiler = createFrameProfiler();

/**
 * The last completed profile, or null. Held here so the `perf-profile` REPORT
 * can be a pure readout: the flight recorder runs every registered report on one
 * export click, so arming must live in an ACTION or every bundle export would
 * silently start a measurement run.
 */
let lastPerfProfile = null;
/**
 * Every tier's COMPLETE `perf-profile` report from the last all-tiers run,
 * keyed by profile — held here, never inside `lastPerfProfile`/what gets
 * copied to the clipboard. The first version of the all-tiers report nested
 * all five in full and ran to ~300KB, almost none of it load-bearing for a
 * comparison (author, 2026-07-29: "so much information it becomes impossible
 * to scan"). Kept in memory anyway (cheap — a few hundred KB against a
 * multi-hundred-MB VT atlas) so a specific tier's full zone/effect breakdown
 * is still reachable without a second ~10-minute run: `MapShine.getTierReport
 * ('extreme')` from the console. See `perf-report-all-tiers` below.
 */
let lastAllTiersReports = null;

// ---------------------------------------------------------------------------
// Namespace. Legacy is disconnected, so there is no live `window.MapShine` to
// collide with — but we still create-if-absent and stamp our own fields so the
// V3 tree owns this namespace cleanly.
// ---------------------------------------------------------------------------
const MapShine = (globalThis.MapShine = globalThis.MapShine || {});
MapShine.version = VERSION;
MapShine.__stage = STAGE;
MapShine.THREE = THREE; // single Three instance for the whole V3 tree
// THE DARKNESS-REALISM LEVER (2026-07-19, author-requested): MapShine
// .setDarknessRealism(v), v in [0,1]. 0 = Foundry parity (DEFAULT — the unlit
// floor at scene darkness 1 stays at Foundry's readable ~19% darkness colour,
// never pitch black); 1 = "realistic" (darkness 1 crushes the unlit map to
// true black). Takes effect on the next rendered frame (no reload). Also
// available as a dropdown in the debug panel ("Darkness at max"). See
// vt-pan-viewer.js#setDarknessRealism / environmental-light.js.
MapShine.setDarknessRealism = setDarknessRealism;
MapShine.getDarknessRealism = getDarknessRealism;
// ALBEDO CLARITY (2026-07-28, author-requested tuning surface): the zoom-out
// sharpness repair. `MapShine.setAlbedoClarity({ sharpness, gateLo, gateHi,
// farLo, farHi, farFloor })` — every field optional, takes effect on the next
// frame with no reload (the uniforms are shared across every item on screen).
// `getAlbedoClarity()` reports the live values plus whether they are bound to a
// built material yet; `resetAlbedoClarity()` restores the shipped defaults.
// See buildAlbedoClarityNode's section header in vt-pan-viewer.js.
MapShine.setAlbedoClarity = setAlbedoClarity;
MapShine.getAlbedoClarity = getAlbedoClarity;
MapShine.resetAlbedoClarity = resetAlbedoClarity;
// UI-CAST WINDOW SHADOWS (2026-07-20): open character sheets / journals / context
// menus cast a soft, offset shadow onto the map. As of Stage A it is MSA's first
// REGISTERED effect — declared as data (effects/ui-window-shadow.js), driven
// through the registry + the settings cascade (below), and DEFAULT OFF (gated to
// the Extreme performance profile — expensive, ≈50fps; opt-in for now). Turn it
// on in Foundry Settings ("UI window shadows: my setting" → On, or the profile →
// Extreme), or `MapShine.setUiShadow({ enabled: true })`. Live tuning is unchanged:
// `MapShine.setUiShadow({ strength01, offsetScale, azimuthDeg, elevationDeg,
// heightPx, baseSoftnessPx, maxOffsetPx, scanEveryNFrames, flipY })`. The knob
// meanings live in effects/ui-window-shadow.js's schema (the generated-UI source).
// THE EFFECT REGISTRY (2026-07-20, Stage A of docs/planning/Effect-Registration.md) —
// MSA's first effect declared as data and driven through the ONE door. boot.js
// is the composition root: the registry (effects/, pure) is paired here with the
// runtime `apply` (the low-level vt/#setUiShadow), so the effects zone never
// imports the renderer and the renderer never imports the registry. The
// cascade-resolved { enabled, params } flows registry.apply → setUiShadow →
// _uiShadowState; the frame loop reads only that, so it can never see a settings
// store or UI state (the V2 `resolve-effect-enabled` race is unreachable). After
// this rewire the low-level setUiShadow has exactly ONE caller — this apply.
const effectRegistry = createEffectRegistry();
effectRegistry.register(UI_WINDOW_SHADOW, (resolved) => {
  setUiShadow({ enabled: resolved.enabled, ...resolved.params });
});

// Transient, in-memory param tuning (MapShine.setUiShadow / the debug panel).
// Stage A has no per-scene/-client PARAM persistence yet (Stage B), so live look
// tweaks ride as the highest-precedence param layer rather than being stored —
// still flowing THROUGH the registry, keeping the one door.
const uiShadowLiveOverride = {};
const UI_SHADOW_PARAM_KEYS = Object.keys(UI_SHADOW_PARAMS);

/**
 * Re-resolve UI-shadow's whole cascade from the live settings + the transient
 * override and apply it. Reads settings through the foundry adapter ONLY. Callers
 * guard + ANNOUNCE (never swallow — feedback_instruments_must_not_lie), because
 * a read before the `init` registration would throw (a wiring bug, not silence).
 */
function reapplyUiShadow() {
  const layers = deriveEffectLayers('uiWindowShadow', (key) => readSetting(MODULE_ID, key));
  layers.paramLayers = [uiShadowLiveOverride];
  effectRegistry.resolveAndApply('uiWindowShadow', layers);
}

// MapShine.setUiShadow — the console/API control, now routed THROUGH the cascade
// instead of mutating render state directly. `enabled` writes the PLAYER's client
// setting (persisted; its onChange re-resolves); look/technical params ride the
// transient override and re-resolve at once. To turn the effect on after the
// default-off flip: `MapShine.setUiShadow({ enabled: true })`, or set "UI window
// shadows: my setting" to On (or the performance profile to Extreme) in Foundry's
// Settings. Tuning is unchanged: `MapShine.setUiShadow({ strength01, offsetScale,
// azimuthDeg, elevationDeg, heightPx, flipY, ... })`.
MapShine.setUiShadow = (partial = {}) => {
  const p = partial ?? {};
  if (typeof p.enabled === 'boolean') {
    Promise.resolve(
      writeSetting(MODULE_ID, effectEnableKey('uiWindowShadow', 'player'), p.enabled ? 'on' : 'off')
    ).catch((err) => log.error('ui-shadow enable write failed:', err));
  }
  let changedParam = false;
  for (const k of UI_SHADOW_PARAM_KEYS) {
    if (k in p) {
      uiShadowLiveOverride[k] = p[k];
      changedParam = true;
    }
  }
  if (changedParam) {
    try {
      reapplyUiShadow();
    } catch (err) {
      log.error('ui-shadow reapply failed:', err);
    }
  }
  return getUiShadow();
};
MapShine.getUiShadow = getUiShadow;
// THE PIXEL-READBACK DIAGNOSTIC (2026-07-19, the region-darkness rendering
// audit): `await MapShine.sampleIllumPixel(worldX, worldY)` reads the ACTUAL
// GPU-rendered value of buf:scene.illum at one world position — the ONLY
// instrument in this project that answers "did this actually reach the
// screen" rather than "what does the CPU say it should be" (getRegionDarknessInfo's
// own job). See vt-pan-viewer.js#sampleIllumPixel for the full reasoning.
MapShine.sampleIllumPixel = sampleVtPanViewerIllumPixel;
// THE PIXEL PROBE (2026-07-19, author-requested, buffed same day once the
// author flagged it as THE tool that cracked the region-darkness bug):
// `await MapShine.probePixels([{x,y}, {x,y}, {x,y}])` — up to 3 world
// positions, reading ALL FIVE screen-sized compositor buffers (illum/lit/
// albedo/coloration/occlusion, the last via a byte-not-half-float decode
// path — see diag/pixel-probe.js), PLUS a numbered on-screen marker (thin
// crosshair + thin circle + a chunkier badge) per point for 30s, so a
// screenshot taken right after the call lines up with the JSON report,
// point-for-point. Point 2+ also carries `deltaFromPrev` — an automatic
// diff against the previous point, biggest jump called out, the same
// by-hand "point A vs point B" comparison that found the region-darkness
// discard() bug and the region-aware-ambient seam, now computed for free.
// See vt-pan-viewer.js#probePixels / diag/pixel-probe.js.
MapShine.probePixels = probeVtPanViewerPixels;
// THE INTERACTIVE PIXEL PROBE (2026-07-19, author-requested: "I want to
// click on the screen and set the points"). MapShine.armPixelProbe() also
// exists for console use; the debug-panel "Pixel Probe" button (registered
// below, once MapShine.debug exists) is the primary way to reach it — click
// the button, then click up to 3 spots on the map. See vt-pan-viewer.js
// #armInteractivePixelProbe for the full "why this never steals a click
// from Foundry" reasoning.
MapShine.armPixelProbe = runInteractiveVtPanViewerPixelProbe;
// THE WIND + PARTICLE PROBE (2026-07-21, author-requested: "like a pixel
// probe but for particles... I can click in hot and cold zones and get the
// information from the particles nearby"). Same click-to-set UX as the pixel
// probe, aimed at a genuinely different question: not "what did this pixel
// render," but "what does the wind field's CPU bake say SHOULD be true here,
// and what did the ACTUAL nearby particles' GPU state turn out to be" — side
// by side, so a mismatch between the two is visible directly instead of
// guessed at. `await MapShine.probeWindAndParticles([{x,y},...])` for
// explicit world points (no click); `MapShine.armWindProbe()` for click-to-
// set, the same as `armPixelProbe`. See vt-pan-viewer.js#runWindProbeOnPoints
// / diag/wind-probe.js for the full reasoning.
MapShine.probeWindAndParticles = probeVtPanViewerWindAndParticles;
MapShine.armWindProbe = runInteractiveVtPanViewerWindProbe;
// ⚠️🔬 THE CROSS-FLOOR MASK STACK PROBE (2026-08-02, author-commissioned:
// *"I could click in one place and it'll probe the values for all floors at
// once... the exact colour values for every point, for every floor and for
// every mask. That's some real data baby!"*). The pixel probe above reads
// what the SCREEN got, at the ONE floor being viewed; this reads what the
// MASK AUTHORITY holds, at EVERY floor at once, down to each contributing
// source's own byte and alpha. The two answer different halves of every
// cross-floor question ("is this pixel's shadow wrong" vs "which floor's
// which mask's which source made it wrong"), which is why both exist.
//
//   MapShine.probeMasks(worldX, worldY)   — one point, no click, no markers
//   MapShine.armMaskProbe(3)              — click up to 3 spots; each point
//                                           carries BOTH the GPU buffers and
//                                           the full per-floor mask stack
//
// See scene/mask-authority.js#probeStackAt for the shape and the reasoning.
// ⚠️ REGISTERED INSIDE `install()`, not here: both need `maskAuthority`, which
// is a `const` created there. Assigning at module scope would be a TDZ
// ReferenceError at import time — the same trap `sun-shadow-subsystem.js`'s
// own `getEnvLight` header documents for `envLight`.

// THE SKY'S DEBUG LEVERS (2026-07-23) — `MapShine.setSunHour(6.5)` /
// `MapShine.setCloudCover(0.9)`, and `null` on either to restore the default.
//
// ⚠ NEITHER IS A REAL SOURCE, and the env diagnostics report says so. There is
// still no calendar and no weather owner; `updateEnvSnapshot` still treats
// their absence as an acknowledged gap. These exist because the shadow model
// (effects/shadow-access.js) derives dawn elongation, cloud softening and night
// fading from exactly these two inputs — and a model nobody can exercise is a
// model nobody can trust (feedback_instruments_must_not_lie). With them, the
// whole atmospheric ladder is checkable today: 6.5 → long soft shadows,
// 12 → short crisp ones, cloud 0.9 → almost none.
MapShine.setSunHour = setVtPanViewerSunHour;
MapShine.setCloudCover = setVtPanViewerCloudCover;

/**
 * Boot's own logger. Everything this file says goes through `core/log.js`, which
 * forwards it to the flight recorder as STRUCTURE (level, subsystem, data) — not
 * as a console string a regex has to guess at later. `TAG` survives only where a
 * message is genuinely about the version/codename; the prefix itself is the
 * logger's job now.
 */
const log = createLogger('boot');

/** Guard against double-boot (Foundry hot-reload, duplicate module load). */
if (MapShine.__keyholeBooted) {
  log.warn(`already booted; skipping re-entry.`);
} else {
  MapShine.__keyholeBooted = true;
  install();
}

function install() {
  // THE BLACK BOX GOES FIRST — before the panel, before the soak, before the
  // pass-graph check below. Every line after this point is captured; anything
  // before it is gone forever, and the earliest failures are the ones nobody can
  // reproduce on request. (The panel used to open a warn/error-only buffer here;
  // the recorder supersedes it and catches every level from every source.)
  installFlightRecorder(MapShine);
  installSoak(MapShine); // exposes MapShine.soak(n) — the stage-gate soak harness
  installDebugPanel(MapShine);
  // The in-app painter (tier 0): registers its "🖌️ Paint _Fire" action on the
  // debug panel and returns a hydrate hook the canvasReady handler calls to pull
  // any saved paint for the newly-loaded scene (docs/planning/Authoring-and-Distribution.md).
  MapShine.__painter = installPainter(MapShine);
  // ANCHOR MODE (2026-07-22) — click-to-place/click-to-edit for discrete point
  // effects (candles today). Installed once, entered per-effect via the
  // Workshop panel below; stays effect-agnostic (ui/anchor-mode.js's own header).
  MapShine.__anchorMode = installAnchorMode(MapShine);

  // THE PASS GRAPH, VALIDATED AT BOOT (Keyhole §"THE FRAMEWORK" — 2026-07-17).
  // Node tests already prove PASSES validates (194+ assertions); this is the
  // SAME check running against the REAL declared graph every real session
  // boots with, not just at `npm test` time — the gap between "the committed
  // file validates" and "the graph a player's session actually runs under
  // validates" is exactly the kind of gap this project's whole second half has
  // been about closing. Loud, never fatal: a malformed pass DECLARATION is a
  // bookkeeping bug, not a reason to take live map rendering down for a table
  // mid-session (the same reasoning as diag/render-fallback.js's safety slide
  // — announce, never silently break, and never break MORE than the actual
  // problem warrants).
  const graphCheck = validatePassGraph(PASSES);
  if (!graphCheck.ok) {
    log.error(`PASS GRAPH INVALID — this is a real bug in graph/passes.js, not a render fault:`);
    for (const e of graphCheck.errors) log.error(`  - ${e}`);
  }

  // The same graph, seam-door, and live-impl checks Node already runs (194+
  // assertions across pass-declarations.test.mjs + pass-impls.test.mjs) —
  // exercised here against the REAL running session instead of the committed
  // file, one click, no console-log copy/paste (keyhole-debug-panel protocol).
  // `live` checks confirm each entry is a REAL function reference (never a
  // string path — see graph/pass-impls.js's header for why), and surface
  // `fusedWith` honestly: geometry.world/present.composite currently share ONE
  // real implementation, and this report says so rather than implying three
  // independent passes exist.
  MapShine.debug.registerReport('pass-graph-health', 'Pass graph health', () => {
    const graph = validatePassGraph(PASSES);
    const seamChecks = PASSES.filter((p) => p.status === 'seam').map((p) => {
      const door = PASS_SEAMS[p.id];
      if (typeof door !== 'function') return { id: p.id, status: 'MISSING DOOR' };
      try {
        door({});
        return { id: p.id, status: 'UNEXPECTED — door did NOT throw (secretly built? update its status)' };
      } catch (err) {
        return {
          id: p.id,
          status:
            err instanceof NotBuiltError ? 'correctly locked' : `UNEXPECTED ERROR TYPE: ${err?.constructor?.name}`,
        };
      }
    });
    const liveChecks = PASSES.filter((p) => p.status === 'live').map((p) => {
      const impl = PASS_IMPLS[p.id];
      if (!impl) return { id: p.id, status: 'MISSING — live pass has no PASS_IMPLS entry' };
      return {
        id: p.id,
        status: typeof impl.fn === 'function' ? 'real function confirmed' : 'BROKEN — fn is not a function',
        export: impl.export,
        fusedWith: impl.fusedWith ?? null,
      };
    });
    return {
      report: 'pass-graph-health',
      generatedAt: new Date().toISOString(),
      graphValid: graph.ok,
      graphErrors: graph.errors,
      passCounts: {
        total: PASSES.length,
        live: PASSES.filter((p) => p.status === 'live').length,
        seam: PASSES.filter((p) => p.status === 'seam').length,
        future: PASSES.filter((p) => p.status === 'future').length,
      },
      seamChecks,
      liveChecks,
    };
  });

  // ORIENTATION SELF-TEST — the standing answer to "how do we stop fighting
  // Y-flips?" (author, 2026-07-17, on an upside-down map). Renders an
  // asymmetric four-corner pattern through the REAL buf:scene.color and the
  // REAL present pass, reads the actual pixels back, and NAMES what it sees:
  // "Y-FLIPPED", "X-FLIPPED", "ROTATED 180°", or ok. One click, after any new
  // screen-space or world→texture mapping — instead of eyeballing content that
  // might be symmetric enough to hide the bug (which is how Y-flips survive).
  MapShine.debug.registerAction('orientation-self-test', 'Orientation self-test', async () => ({
    report: 'orientation-self-test',
    generatedAt: new Date().toISOString(),
    ...(await runOrientationSelfTest()),
  }));

  // (The COMPUTE SPIKE action and `diag/compute-spike.js` were RETIRED
  // 2026-07-27. It was a declared throwaway — a one-shot proof that
  // `renderer.compute()` runs on both backends before the particle kernel was
  // built on it — and its own header said to delete it once green. The particle
  // engine has shipped and dispatches compute every frame, so the proof is now
  // the product; keeping a button for it was Lab clutter.)

  // PARTICLE DIAGNOSTICS (Particles.md §23) — reads the ACTUAL GPU particle
  // velocities back and reports whether they vary per-cell (the wind field is
  // reaching the compute kernel) or are uniform (only the ambient bias is), plus
  // which wind tiers were wired (hasBakedField/hasLiveField). Ground truth for
  // "the particles aren't obeying the wind field", instead of guessing.
  MapShine.debug.registerAction(
    'particle-diagnostics',
    '🌫️ Particle diagnostics (wind readback)',
    async () => ({
      report: 'particle-diagnostics',
      generatedAt: new Date().toISOString(),
      ...(await getParticleReadback(32)),
    }),
    { effect: 'wind' }
  );

  MapShine.debug.registerAction('vt-live-decode', 'Live decode test', async () => ({
    report: 'vt-live-decode',
    generatedAt: new Date().toISOString(),
    ...(await runVtLiveDecodeTest(`modules/${MODULE_ID}/assets/torture/torture_floor0.png`)),
  }));
  // ---------------------------------------------------------------------------
  // THE MASK AUTHORITY — the single source of truth for authored + derived
  // content masks (scene/mask-authority.js's header is the map; the
  // `masks/authority-only` tripwire is the wall). Boot is the composition
  // root: the authority never imports the renderer and the renderer never
  // imports the authority — they meet HERE, as two injected closures
  // (extraLayersForItem = what to stream, onPageDecoded = what streamed).
  // Deliberately NOT exposed on the MapShine namespace: consumers import
  // through scene/index.js, and the debug report below is the author's
  // window. A `MapShine.masks` would be V2's global bus growing back.
  // ---------------------------------------------------------------------------
  const maskAuthority = createMaskAuthority({
    // Bounded pixel access for ingest: ≤256² pages, a handful per pack, once
    // per scene load — never the render loop, never a giant source. The reader
    // itself lives in vt/decode-pool.js (per-page CPU extraction is decode
    // machinery; `no-gpu-readback` correctly refused to host it here).
    readPageImageData: readPageBitmapPixels,
    log: createLogger('masks'),
  });
  MapShine.debug.registerReport('mask-authority', 'Mask authority (authored + derived masks)', () => ({
    report: 'mask-authority',
    generatedAt: new Date().toISOString(),
    ...maskAuthority.getReport(),
  }));

  /**
   * THE SKY-REACH SERVICE (scene/sky-reach-access.js) — "what is between this
   * point and the open sky?", asked once and answered for everyone. Cast shadows
   * consume it today; rain is the next consumer (author, 2026-07-24: *"it needs
   * to be an API / service for other things like rain drops when we get to that
   * stage as well as being a producer for this shadow"*).
   *
   * The missing-mask handler routes a required-`_Outdoors` failure into the SAME
   * throttled warning `safeSampleOutdoors` already owns, so a scene with an
   * unpainted floor degrades loudly once rather than throwing per query.
   */
  const skyReachAccess = createSkyReachAccess({
    maskAuthority,
    onRequiredMaskMissing: (err, context) => {
      if (!(err instanceof RequiredMaskMissingError)) throw err;
      log.warn(`sky-reach (${context}) degraded: ${err.message}`);
    },
  });

  // ---------------------------------------------------------------------------
  // THE ANCHOR AUTHORITY — the "place" sibling of the mask authority (scene/
  // anchor-authority.js's header is the map). Discrete point effects (a candle
  // flame) as the successor to V2's Map Points. Boot is the composition root:
  // foundry/v2-anchor-import.js reads the old flags, this authority serves the
  // result, effects/candle-flame.js consumes it — none reach sideways. NOT on
  // the MapShine namespace (that was V2's global bus); the debug report is the
  // author's window.
  // ---------------------------------------------------------------------------
  const anchorAuthority = createAnchorAuthority({ log: createLogger('anchors') });
  /** Last per-scene V2 → V3 import report, for the debug panel. */
  let lastAnchorImport = null;
  /** RAW V2-imported anchor candidates from the last scene load — kept so a
   * live add/remove/edit can re-merge (scene/anchor-authority.js#
   * mergeAnchorSources, pure) without re-reading Foundry flags. */
  let lastV2AnchorCandidates = [];
  /** The authored overlay for the CURRENT scene — added/edited/removed anchors,
   * loaded once per scene load (foundry/anchor-adapter.js) and mutated +
   * persisted on every live CRUD action below. Shape matches the adapter's
   * payload exactly: `{overrides: {id: rawAnchorFields}, removed: [id,...]}`. */
  let authoredAnchorsPayload = { overrides: {}, removed: [] };
  /** Candle READOUT (not params — a derived status, Params.md §3.6.2): what the
   * last apply resolved and how many anchors it would draw. The teardrop pixels
   * are the deferred surface.particles rung; this proves the chain up TO the draw. */
  let candleReadout = { enabled: false, servedCount: 0, params: null, perfTier: null };

  /** Lightning READOUT — same posture as `candleReadout` just above. */
  let lightningReadout = { enabled: false, servedCount: 0, params: null, perfTier: null };

  /** Vegetation READOUT — same posture as `candleReadout` just above,
   * including `perfTier` (effect-cascade.js#resolveEffectTier, resolved for
   * EVERY effect at the registry door): the flutter shimmer and the ground
   * shadow's smear quality both follow the performance profile from here
   * (vegetation-render.js#vegetationTierPlan), the same seam candles use for
   * flame quality/light clustering. */
  let vegetationReadout = { enabled: false, params: null, perfTier: null };
  /** Bloom READOUT — `enabled: true` pre-resolve, matching what the manifest
   * already declares (`enabledFromProfile: 'low'` = on at every performance
   * profile). It read `false` until 2026-07-27, which was a lie about the window
   * between construction and the first cascade resolve — and, because
   * `reapplyBloom` was reachable from nothing but `MapShine.setBloom`, that
   * window never closed: bloom was off at boot in every scene. `EFFECT_REAPPLIERS`
   * is the real fix; this seed is the belt-and-braces half, the same posture
   * `water-registration.js` takes for the same reason. */
  let bloomReadout = { enabled: true, params: null };
  let sunShadowReadout = { enabled: false, params: null };
  /** Door-graphics READOUT — same posture as the readouts above: what the last
   * apply resolved (enable + the motion params the viewer's door manager reads). */
  let doorReadout = { enabled: false, params: null };
  /** The active floor's renderable door snapshots (foundry/scene-doors.js),
   * refreshed on scene load, floor switch, and any wall CRUD (`refreshDoors`) —
   * NOT re-read every frame. `getDoorRenderState` hands this to the viewer by
   * closure reference, so a fresh read is picked up with no re-wiring (the same
   * relationship `vegetationUrlByItemId`/`activeFloorContext` have). */
  let doorSnapshots = [];
  /** Vegetation's OWN discovered-sibling-mask lookup (Vegetation.md Case 2),
   * item id -> {tree: url|null, bush: url|null}. Rebuilt FRESH every scene load
   * inside `startRealSceneViewer` (see its own construction site) — a
   * module-level `let` so `getVegetationRenderState` below can read the
   * CURRENT scene's map by closure reference, the same relationship
   * `activeFloorContext` already has with its own updater. Deliberately its
   * OWN map rather than a `scene/mask-authority.js`-DERIVED product: that
   * authority's derivation machinery builds CPU scalar products (coverAbove/
   * skyReach) sampled point-wise, and vegetation only ever needs a URL to
   * load as its own whole-image texture — routing THAT through ingest/
   * derivation would be needless, unrelated coupling (see
   * effects/vegetation-render.js's own header). It DOES now read through the
   * authority's own query doors (`authoredStatus`/`authoredStatusForItem`,
   * 2026-07-26) rather than reaching into discovery's raw result directly —
   * only the STORAGE stays separate here, not the read path. */
  let vegetationUrlByItemId = new Map();

  /** The floor the user is currently viewing, as an anchor-authority floor
   * context (`{ elevation }`) — so the marker overlay shows only THIS floor's
   * candles, not every floor's at once (author, 2026-07-20: "it should just
   * show the points on the current active floor"). `null` = unknown → the
   * authority serves ALL floors (fail-open: a floor we can't resolve should
   * show its candles, not hide them silently). Updated on scene load + floor
   * switch, where boot already has the floor list in hand (no new Foundry read). */
  let activeFloorContext = null;
  /** The scene's floor list — the one way to map a floorIndex to a level id for
   * a floor OTHER than the active one, which water's cross-floor borrow needs
   * (it resolves to a LOWER floor than the one being viewed). */
  let lastKnownFloors = null;
  /** EVERY floor's cover art (backgrounds, foregrounds, tiles), unfiltered by
   * visibility — the SAME list handed to the mask authority, kept here so the
   * viewer can decode each item's coarse alpha regardless of whether the viewed
   * floor happens to draw it. Before 2026-07-26 only the DRAW list was decoded,
   * so an upper floor's background silently contributed no cover at all
   * ([[feedback_membership_beats_derived_threshold]]'s sibling defect: the
   * authority knew the item existed and had `alpha: null` for it forever). */
  let coverItems = [];

  /** Resolve the active floor's elevation MIDPOINT (a point interior to its
   * band, so an anchor bound to an adjacent floor's band never matches at a
   * shared boundary) into a floor context. Mirrors the viewer's own floor
   * lookup (vt-pan-viewer.js#readElevationFilteredDarknessRegions: find by
   * `f.index`), falling back to array position, then fail-open to null. */
  function updateActiveFloorContext(floors, floorIndex) {
    lastKnownFloors = Array.isArray(floors) ? floors : null;
    const floor =
      (Array.isArray(floors) ? floors.find((f) => f.index === floorIndex) : null) ?? floors?.[floorIndex] ?? null;
    if (!floor) {
      activeFloorContext = null;
      return;
    }
    const bottom = Number(floor.elevationBottom);
    const top = Number(floor.elevationTop);
    const elevation =
      Number.isFinite(bottom) && Number.isFinite(top)
        ? (bottom + top) / 2
        : Number.isFinite(bottom)
          ? bottom + 0.5
          : null;
    // `levelId` carries the floor's real Foundry Level document id (or the
    // single-floor `'legacy'` sentinel) so the door reader can scope doors to
    // this floor exactly like scene-wall-clip.js does. `'legacy'` maps to null
    // (= every door) at the read site — a scene with no per-Level authoring has
    // no per-floor-scoped walls to hide anyway.
    activeFloorContext =
      elevation == null ? null : { elevation, floorIndex, band: [bottom, top], levelId: floor.id ?? null };
  }

  // THE CANDLE FLAME — MSA's second registered effect, first ported from V2,
  // through the SAME one door as UI-shadow (the velocity test: one manifest +
  // one registry line, no bespoke state/settings/resolver). Its apply resolves
  // the cascade and reads the served anchors; the world-space teardrop DRAW is
  // the deferred surface.particles rung (graph/passes.js), so Tier 0 records a
  // readout proving placement flows end to end — the author's "does the new
  // renderer pick up old candle placement?" answered in the anchors report.
  effectRegistry.register(CANDLE_FLAME, (resolved) => {
    const served = resolved.enabled ? anchorAuthority.anchorsForEffect('candleFlame') : [];
    // `perfTier` (effect-cascade.js#resolveEffectTier, resolved for EVERY effect at
    // the registry door) is carried onto the readout so the renderer can reach it
    // the same way it reaches params — the candle's flame quality, its light's
    // flicker richness and its light CLUSTERING all follow the performance profile
    // from here (candle-flame-geometry.js#candleTierPlan).
    candleReadout = {
      enabled: resolved.enabled,
      servedCount: served.length,
      params: resolved.params,
      perfTier: resolved.perfTier,
    };
    // Keep the live-overlay registration's colour in sync with the resolved
    // look param on every apply (settings change, scene load, initial boot).
    registerCandleMarkerSource();
  });

  // LIGHTNING — the forked-bolt strike effect (V2's LightningEffectV2; the
  // weather/landscape flash sibling is out of scope). Through the SAME one
  // door as the candle, and anchor-driven the same way — a linked start/end
  // pair, not a single point (scene/anchor-catalog.js's own header).
  effectRegistry.register(LIGHTNING, (resolved) => {
    const served = resolved.enabled ? anchorAuthority.anchorsForEffect('lightning') : [];
    lightningReadout = {
      enabled: resolved.enabled,
      servedCount: served.length,
      params: resolved.params,
      perfTier: resolved.perfTier,
    };
    registerLightningMarkerSource();
  });

  // VEGETATION — `_Tree`/`_Bush`, MSA's third registered effect, through the
  // SAME one door. Unlike the candle it is NOT anchor-driven: its "instances"
  // are the tile/background items `vt-pan-viewer.js` already iterates for its
  // own rendering, so `apply` here only needs to update the shared readout —
  // no served-count to compute, no anchor authority involved (see
  // effects/vegetation.js's own header for why one wind sample per mesh needs
  // no per-instance bookkeeping the way per-candle overrides do).
  effectRegistry.register(VEGETATION, (resolved) => {
    vegetationReadout = { enabled: resolved.enabled, params: resolved.params, perfTier: resolved.perfTier };
  });

  // BLOOM — MSA's fourth registered effect and its FIRST post-processing effect,
  // through the SAME one door. Not anchor-driven and not item-driven: it is a
  // whole-image screen pass, so `apply` only refreshes the shared readout the
  // viewer's runPostBloomPass reads each frame (see getBloomRenderState below).
  effectRegistry.register(BLOOM, (resolved) => {
    bloomReadout = { enabled: resolved.enabled, params: resolved.params };
  });

  // SUN SHADOWS (docs/planning/Sun-Shadows.md) — building + overhead +
  // sky-reach as ONE height field. `apply` does two things rather than one,
  // because this effect's params split across two owners:
  //   - the LOOK (strength, softness, edge band) rides the readout the viewer's
  //     bake reads, like bloom's;
  //   - the CASTER SET (building height, which producers are included) is an
  //     input to the mask authority's DERIVATION, so it is pushed there. That
  //     call is change-detecting, so a cascade resolve that alters nothing
  //     costs one comparison and does not dirty a 512² field.
  effectRegistry.register(SUN_SHADOWS, (resolved) => {
    // `perfTier` rides the readout exactly as it does for candles and
    // vegetation — the resolved rung of this effect's ladder, turned into the
    // bake's field resolution, station count and rebake threshold by
    // `layer-smear.js#layerSmearTierPlan` inside the subsystem. Below the
    // `performance` profile `resolved.enabled` is already false (the manifest's
    // own gate), and the subsystem then drops the layer field entirely.
    sunShadowReadout = { enabled: resolved.enabled, params: resolved.params, perfTier: resolved.perfTier };
    const p = resolved.params ?? {};
    // ⚠️ THE DEBUG ISOLATION NO LONGER LIVES HERE (2026-08-02). It used to
    // restrict what the DERIVATION writes, which was right for the retired
    // march model — its caster texture packed `coverBuilding`/`coverSkyReach`
    // directly, so withholding them genuinely removed a producer. The
    // layer-smear packing reads NEITHER (walls come from `1 − outdoors`,
    // sky-reach from `coverAbove`), so those flags stopped isolating anything
    // and every "… only" view rendered the same picture as "all" — which the
    // author then spent hours diagnosing a real artifact through.
    //
    // Isolation is now a LOOK-time multiply on the per-layer strengths
    // (`sun-shadow-debug.js#sunShadowDebugLayers`, applied in
    // `sun-shadow-subsystem.js#bakeSunShadowField`), which is also exactly what
    // Shader Lab's own `layerIsolate` does — so the bench and the live game
    // isolate identically and their pictures can be compared directly. The
    // derivation is therefore always asked for EVERY channel below.
    maskAuthority.setCasterHeightSpec({
      distancePixels: readGridDistancePixels().distancePixels,
      // A disabled effect contributes no casters at all — the height field goes
      // empty rather than staying baked and merely unread, so "off" costs
      // nothing downstream either. `p.wallHeightPx` (renamed 2026-08-02 from
      // `buildingHeightPx` — `sun-shadows.js`'s own schema has the rename);
      // this value is no longer CONSUMED by the layer-smear bake (which reads
      // `wallHeightPx` straight from params, not from the derived field), but
      // `maskAuthority.getBuildingHeightPx()` is still a served product
      // (`boot.js#getCasterHeightField`'s own note: "rain will want it"), so
      // it stays fed the CURRENT value rather than a permanently-stale one.
      buildingHeightPx: resolved.enabled ? (p.wallHeightPx ?? 0) : 0,
      // Every channel, always — a disabled effect still contributes nothing
      // because `resolved.enabled` gates all three together.
      include: {
        building: resolved.enabled,
        overhead: resolved.enabled,
        skyReach: resolved.enabled,
      },
      // THE SILHOUETTE RESOLUTION (2026-07-30, author: "shadows are still very
      // low resolution" on the extreme preset) — `fieldDim` alone (the bake's
      // OWN output resolution) can only smooth the penumbra, never sharpen the
      // caster's own shape (`layer-smear.js`'s own `layerGridDim` doc has the
      // full reasoning, carried over from `sun-occlusion.js`'s retired
      // `casterGridDim`). A disabled effect asks for 0 (share the plain
      // `gridSpec`), same "off costs nothing extra" posture as the rest of
      // this call.
      //
      // ⚠️ RE-POINTED 2026-08-02, layer-smear model. This is the ONLY call
      // site that ever requests a caster-specific grid resolution — without
      // it, `channels.coverOverhead` (the layer-smear model's own overhead
      // channel) silently stays at the SHARED grid's resolution regardless of
      // performance tier, which is the exact resolution ceiling
      // `docs/planning/Sun-Shadows-Layer-Smear.md` was written to lift. Found
      // by grepping every real (non-comment) consumer of the retired
      // `sunShadowTierPlan` before deleting it, rather than assuming the
      // subsystem rewrite alone was the whole story.
      gridMaxDim: resolved.enabled ? (layerSmearTierPlan(resolved.perfTier).layerGridDim ?? 0) : 0,
    });
  });

  // THE COLOUR GRADE (Look) effect — docs/planning/Grade.md §14, the god CC.
  // Same shape as bloom: a whole-image screen pass, so `apply` only refreshes
  // the readout the viewer's per-frame `pushGradeLook` reads. The artistic grade
  // is a first-class effect (its own settings cascade + Workshop card); the
  // ENVIRONMENTAL grade stays on the astrolabe (Atmosphere).
  let gradeLookReadout = { enabled: false, params: null };
  effectRegistry.register(GRADE, (resolved) => {
    gradeLookReadout = { enabled: resolved.enabled, params: resolved.params };
  });

  // DOOR GRAPHICS — MSA's fifth registered effect, ported from V2's
  // DoorMeshManager, through the SAME one door. Not anchor-driven: its
  // "instances" are the scene's own textured door walls (foundry/scene-doors.js),
  // refreshed into `doorSnapshots` on scene load / floor switch / wall CRUD. So
  // `apply` only refreshes the shared readout the viewer's door manager reads
  // each frame (see getDoorRenderState below).
  effectRegistry.register(DOOR_GRAPHICS, (resolved) => {
    doorReadout = { enabled: resolved.enabled, params: resolved.params };
  });

  /** Transient, in-memory vegetation param tuning (MapShine.setVegetation) —
   * mirrors `candleLiveOverride` below exactly: the highest-precedence param
   * layer, so a live FOH/ROH drag (or a console tune) shows at once without
   * being persisted. */
  const vegetationLiveOverride = {};

  /** Re-resolve vegetation's cascade from live settings + the live override and
   * apply — mirrors `reapplyCandle` just below. Called on settings change (see
   * the `init` hook's `onChange`), once after each scene's mask discovery
   * completes, and by `MapShine.setVegetation`. */
  function reapplyVegetation() {
    const layers = deriveEffectLayers('vegetation', (key) => readSetting(MODULE_ID, key));
    layers.paramLayers = [vegetationLiveOverride];
    effectRegistry.resolveAndApply('vegetation', layers);
  }

  /** Transient, in-memory bloom param tuning (MapShine.setBloom / the FOH-ROH
   * card / a preset pick) — the highest-precedence param layer, so live tweaks
   * show at once without being persisted. Mirrors vegetationLiveOverride. */
  const bloomLiveOverride = {};

  /** Re-resolve bloom's cascade from live settings + the live override and
   * apply. Mirrors reapplyVegetation; called on settings change, on ready, and
   * by MapShine.setBloom. */
  function reapplyBloom() {
    const layers = deriveEffectLayers('bloom', (key) => readSetting(MODULE_ID, key));
    layers.paramLayers = [bloomLiveOverride];
    effectRegistry.resolveAndApply('bloom', layers);
  }

  /** Transient live override + re-resolve for SUN SHADOWS. Mirrors reapplyBloom
   * exactly (docs/planning/Sun-Shadows.md). */
  const sunShadowLiveOverride = {};
  function reapplySunShadows() {
    const layers = deriveEffectLayers('sunShadows', (key) => readSetting(MODULE_ID, key));
    layers.paramLayers = [sunShadowLiveOverride];
    effectRegistry.resolveAndApply('sunShadows', layers);
  }

  /** Transient live override + re-resolve for the Colour Grade effect. Mirrors
   * reapplyBloom exactly. */
  const gradeLookLiveOverride = {};
  function reapplyGradeLook() {
    const layers = deriveEffectLayers('grade', (key) => readSetting(MODULE_ID, key));
    layers.paramLayers = [gradeLookLiveOverride];
    effectRegistry.resolveAndApply('grade', layers);
  }

  /** Transient, in-memory candle param tuning (MapShine.setCandle) — the
   * highest-precedence param layer, so live tweaks show at once without being
   * persisted (Stage B adds per-scene persistence). Mirrors uiShadowLiveOverride. */
  const candleLiveOverride = {};

  /** Re-resolve the candle's cascade from live settings + the live override and
   * apply. Mirrors reapplyUiShadow; called on settings change, on ready, after
   * each scene's anchor import, and by MapShine.setCandle. */
  function reapplyCandle() {
    const layers = deriveEffectLayers('candleFlame', (key) => readSetting(MODULE_ID, key));
    layers.paramLayers = [candleLiveOverride];
    effectRegistry.resolveAndApply('candleFlame', layers);
  }

  /** Transient, in-memory lightning param tuning (MapShine.setLightning) —
   * the highest-precedence param layer, mirrors candleLiveOverride exactly. */
  const lightningLiveOverride = {};

  /** Re-resolve lightning's cascade from live settings + the live override and
   * apply. Mirrors reapplyCandle; called on settings change, on ready, after
   * each scene's anchor import, and by MapShine.setLightning. */
  function reapplyLightning() {
    const layers = deriveEffectLayers('lightning', (key) => readSetting(MODULE_ID, key));
    layers.paramLayers = [lightningLiveOverride];
    effectRegistry.resolveAndApply('lightning', layers);
  }

  /** Transient, in-memory door-graphics param tuning (MapShine.setDoors) — the
   * highest-precedence param layer, mirrors candleLiveOverride. */
  const doorLiveOverride = {};

  /** Re-resolve door graphics' cascade from live settings + the live override
   * and apply. Mirrors reapplyCandle; called on settings change, on ready, and
   * by MapShine.setDoors. */
  function reapplyDoors() {
    const layers = deriveEffectLayers('doorGraphics', (key) => readSetting(MODULE_ID, key));
    layers.paramLayers = [doorLiveOverride];
    effectRegistry.resolveAndApply('doorGraphics', layers);
  }

  /** Re-read the active floor's renderable doors into `doorSnapshots` (which
   * `getDoorRenderState` hands the viewer by reference). Cheap — a single walls
   * iteration — but done on real triggers (scene load, floor switch, wall CRUD),
   * NOT every frame. A door OPENING is a wall `ds` update, so it flows through
   * the same `watchDoorGraphics` path as any other wall edit, no door-specific
   * hook of its own (the same "doors are walls with a toggle" economy the wind
   * bake already relies on). The viewer's door manager then animates the visual
   * from the new `open` state. `'legacy'` (single-floor) → null = every door. */
  function refreshDoors() {
    const levelId = activeFloorContext?.levelId;
    doorSnapshots = readSceneDoors(levelId && levelId !== 'legacy' ? levelId : null).doors;
  }

  /**
   * EVERY effect's "re-resolve the cascade and push the result" closure, in ONE
   * list, so the three triggers that must run them — `ready`, a settings change,
   * a scene load — each walk the same set instead of hand-listing it three times.
   *
   * ⚠️ THIS LIST EXISTS BECAUSE THE HAND-LISTED VERSION LOST BLOOM. Bloom's
   * manifest declares `enabledFromProfile: 'low'` — ON at every performance
   * profile, deliberately (`feedback_default_on_new_features`). But `reapplyBloom`
   * was reachable from nowhere except `MapShine.setBloom`, so the cascade that
   * would have resolved it ON never ran at all: bloom sat at its pre-resolve seed
   * of `false` from boot until someone typed a console command. Three
   * near-identical hand-maintained lists, and the newest entry was missing from
   * every one of them — silent, and invisible to a green test suite. Water,
   * fluid, specular and window light were each missing from two of the three for
   * the same reason. No wall catches "the next effect forgot to be applied"; this
   * list is the cheapest one available, and adding a line below is now the job.
   *
   * Thunks, not bare references: `water`/`fluid`/`specular`/`windowLight` are
   * `const`s declared further down this same scope, so naming them directly here
   * would be a temporal-dead-zone throw. An arrow defers the lookup to call time,
   * which is always long after `install()` has returned.
   */
  const EFFECT_REAPPLIERS = [
    ['ui shadow', () => reapplyUiShadow()],
    ['candle', () => reapplyCandle()],
    ['lightning', () => reapplyLightning()],
    ['vegetation', () => reapplyVegetation()],
    ['door graphics', () => reapplyDoors()],
    ['water', () => water.reapply()],
    ['fluid', () => fluid.reapply()],
    ['specular', () => specular.reapply()],
    ['window light', () => windowLight.reapply()],
    ['bloom', () => reapplyBloom()],
    ['colour grade', () => reapplyGradeLook()],
    // Sun shadows MUST run per scene, not only at boot: this apply is what pushes
    // the new scene's `distancePixels` into the caster-height derivation, and an
    // elevation converted with the PREVIOUS scene's grid scale is a building of
    // the wrong height that reads as a tuning problem.
    ['sun shadows', () => reapplySunShadows()],
  ];

  /**
   * Run every reapplier, announcing failures one at a time. An effect that throws
   * must not stop the ten after it — that is how one bad cascade would silently
   * take the whole look down with it.
   * @param {string} when - the trigger, named in the error line ('ready', 'scene load'…).
   */
  function reapplyAll(when) {
    for (const [name, fn] of EFFECT_REAPPLIERS) {
      try {
        fn();
      } catch (err) {
        log.error(`${name} reapply (${when}) failed:`, err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // ANCHOR CRUD — add/remove/edit ONE candle, live (docs the debug-panel
  // Workshop card + ui/anchor-mode.js drive through). Each call: (1) writes
  // THROUGH the authority (validate-at-write, scene/anchor-authority.js — never
  // a parallel state object), (2) snapshots the resulting FULL anchor into
  // `authoredAnchorsPayload` so the SAME edit replays after a reload (merged
  // back against a fresh V2 import by mergeAnchorSources — see the scene-load
  // site below), (3) persists that payload, fire-and-forget with a loud error
  // on failure (never silent — a save that quietly fails would look identical
  // to "it worked" until the next reload discarded the edit). The render loop
  // needs no extra nudge: getCandleRenderState/updateCandleFlame already re-
  // read anchorsForEffect fresh every frame.
  // ---------------------------------------------------------------------------

  /** The full-fidelity shape stored as an authored override — a COMPLETE
   * snapshot, not a diff, so a later scene load reproduces this edit exactly
   * regardless of what the matching V2 candidate (if any) says. */
  function snapshotAnchorForPersistence(resolved) {
    return {
      id: resolved.id,
      kind: resolved.kind,
      x: resolved.x,
      y: resolved.y,
      floorBinding: resolved.floorBinding,
      enabled: resolved.enabled,
      params: resolved.params,
    };
  }

  function persistAuthoredAnchors() {
    Promise.resolve(saveAuthoredAnchors(authoredAnchorsPayload)).catch((err) =>
      log.error('saving authored anchors failed — this edit will NOT survive a reload:', err)
    );
  }

  /** Place a new candle at a world position, bound to whichever floor is
   * currently being viewed (fail-open to all-levels if that is unknown). */
  function addCandle(x, y) {
    const id = `authored:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const raw = {
      id,
      kind: 'candleFlame',
      x,
      y,
      floorBinding: activeFloorContext
        ? { mode: 'locked', bottom: activeFloorContext.band[0], top: activeFloorContext.band[1] }
        : { mode: 'all-levels' },
      enabled: true,
      params: {},
    };
    const resolved = anchorAuthority.addAnchor(raw);
    if (!resolved) {
      log.error(
        'addCandle: the new candle was rejected at ingest — this should be unreachable for a well-formed raw shape'
      );
      return null;
    }
    authoredAnchorsPayload.overrides[id] = snapshotAnchorForPersistence(resolved);
    persistAuthoredAnchors();
    MapShine.debug?.refreshControls?.();
    return resolved;
  }

  /** Patch one candle (position/floor/enabled/params — anchor-authority.js's
   * updateAnchor already re-validates the WHOLE result, so a bad patch is
   * rejected rather than half-applied). */
  function updateCandleAnchor(id, patch) {
    const resolved = anchorAuthority.updateAnchor(id, patch);
    if (!resolved) return null;
    authoredAnchorsPayload.overrides[id] = snapshotAnchorForPersistence(resolved);
    persistAuthoredAnchors();
    MapShine.debug?.refreshControls?.();
    return resolved;
  }

  /** Remove one candle — regardless of whether it was V2-imported or freshly
   * authored; `removed` wins over any matching V2 candidate on the next
   * scene-load merge (mergeAnchorSources' own precedence). */
  function removeCandleAnchor(id) {
    const existed = anchorAuthority.removeAnchor(id);
    if (existed) {
      delete authoredAnchorsPayload.overrides[id];
      if (!authoredAnchorsPayload.removed.includes(id)) authoredAnchorsPayload.removed.push(id);
      persistAuthoredAnchors();
      MapShine.debug?.refreshControls?.();
    }
    return existed;
  }

  // ---------------------------------------------------------------------------
  // LIGHTNING ANCHOR CRUD — a bolt is TWO linked ordinary anchors (`role:
  // 'start'`/`role:'end'` sharing one `params.linkId`), not one point
  // (scene/anchor-catalog.js's own header explains why the core anchor schema
  // stays untouched for this). `ui/anchor-mode.js` calls `addAnchor(x,y)` once
  // per click with no way to pass extra state through — so THIS closure is the
  // two-click state machine: the first click mints a link id and places
  // `role:'start'`; the second places `role:'end'` on that same link id and
  // clears the pending state. Everything else mirrors addCandle/
  // updateCandleAnchor/removeCandleAnchor exactly (validate-at-write through
  // the authority, snapshot into authoredAnchorsPayload, persist).
  // ---------------------------------------------------------------------------

  /** The in-progress bolt's link id between its two clicks, or null when no
   * bolt is mid-placement. Module-scope: a stray click elsewhere (closing the
   * placement tool, switching scenes) simply leaves a single orphaned
   * `role:'start'` anchor — a visible, editable, deletable marker, not a
   * crash — the next placement always starts a FRESH link id regardless. */
  let pendingLightningLinkId = null;

  function addLightningEndpoint(x, y) {
    const floorBinding = activeFloorContext
      ? { mode: 'locked', bottom: activeFloorContext.band[0], top: activeFloorContext.band[1] }
      : { mode: 'all-levels' };
    const role = pendingLightningLinkId ? 'end' : 'start';
    // `crypto.randomUUID()`, NOT `Date.now()` — this is a uniqueness source,
    // not a clock sample, but the `time/one-clock` wall (tools/verify-
    // structure.mjs) can't tell those apart from a bare `Date.now()` call,
    // and a UUID is a genuinely BETTER id anyway (no collision window at
    // all, vs. millisecond-resolution + a short random suffix).
    const linkId = pendingLightningLinkId ?? `lightning:${crypto.randomUUID()}`;
    const id = `authored:${crypto.randomUUID()}`;
    const resolved = anchorAuthority.addAnchor({
      id,
      kind: 'lightning',
      x,
      y,
      floorBinding,
      enabled: true,
      params: { role, linkId },
    });
    if (!resolved) {
      log.error(
        `addLightningEndpoint: the new bolt ${role} was rejected at ingest — this should be unreachable for a well-formed raw shape`
      );
      return null;
    }
    authoredAnchorsPayload.overrides[id] = snapshotAnchorForPersistence(resolved);
    persistAuthoredAnchors();
    MapShine.debug?.refreshControls?.();
    pendingLightningLinkId = role === 'start' ? linkId : null;
    return resolved;
  }

  /** Patch one bolt endpoint (position/floor/enabled/params — role/linkId
   * live in `params` like any other anchor param, so editing them goes
   * through the SAME validate-the-whole-result path as a position drag). */
  function updateLightningAnchor(id, patch) {
    const resolved = anchorAuthority.updateAnchor(id, patch);
    if (!resolved) return null;
    authoredAnchorsPayload.overrides[id] = snapshotAnchorForPersistence(resolved);
    persistAuthoredAnchors();
    MapShine.debug?.refreshControls?.();
    return resolved;
  }

  /** Remove one bolt endpoint — regardless of role, regardless of whether it
   * was V2-imported or freshly authored. Removing EITHER endpoint orphans the
   * other (anchorsForEffect only serves enabled anchors; groupLightning
   * AnchorsIntoSources needs both to form a source), which is the correct,
   * honest behaviour: a lightning bolt with one end deleted is not a bolt. */
  function removeLightningAnchor(id) {
    const existed = anchorAuthority.removeAnchor(id);
    if (existed) {
      delete authoredAnchorsPayload.overrides[id];
      if (!authoredAnchorsPayload.removed.includes(id)) authoredAnchorsPayload.removed.push(id);
      persistAuthoredAnchors();
      MapShine.debug?.refreshControls?.();
    }
    return existed;
  }

  // MapShine.setCandle — the console tuner, routed THROUGH the cascade (never
  // mutating render state directly). Tune live while iterating on the look:
  //   MapShine.setCandle({ sizePx: 20, lightRadiusPx: 500, color: '#ffcc55' })
  // Values ride the transient override and re-resolve at once (not persisted).
  MapShine.setCandle = (partial = {}) => {
    const p = partial ?? {};
    // `enabled` writes the PLAYER enable setting (mirrors setUiShadow) — a real
    // toggle AND the definitive A/B for "is the candle the perf cost": its
    // onChange re-resolves the cascade, which hides the flame + drops the lights.
    if (typeof p.enabled === 'boolean') {
      Promise.resolve(writeSetting(MODULE_ID, effectEnableKey('candleFlame', 'player'), p.enabled ? 'on' : 'off'))
        // Re-resolve ONCE THE WRITE LANDS rather than trusting the setting's
        // onChange to fire for a programmatic set (author-reported 2026-07-20:
        // `setCandle({enabled:false})` left the flames drawn — the flame draw
        // gates on the resolved enable, so the enable never reached it). The
        // cascade honours a player 'off' (effect-cascade.js), the viewer hides
        // the flame on enabled:false, and reapply is idempotent — so this is the
        // safe belt to the onChange's braces, and the A/B lever the perf tool
        // leans on ("toggle the effect, diff gpuFrameMsAvg") now definitely works.
        .then(() => reapplyCandle())
        .catch((err) => log.error('candle enable write/reapply failed:', err));
    }
    let changed = false;
    // Every LOOK/LIGHT/MOTION param the debug-panel card writes (Presence's
    // `enabled` is handled above, through the settings write, not this list).
    for (const k of ['sizePx', 'color', 'lightRadiusPx', 'animationQuality', 'windResponse']) {
      if (k in p) {
        candleLiveOverride[k] = p[k];
        changed = true;
      }
    }
    if (changed) {
      try {
        reapplyCandle();
      } catch (err) {
        log.error('candle reapply (setCandle) failed:', err);
      }
    }
    return { ...candleLiveOverride };
  };

  // MapShine.setLightning — the console tuner AND the FOH/ROH panel's own
  // write path (mirrors MapShine.setCandle exactly, including the "enabled
  // writes the PLAYER setting, then reapplies once the write lands" shape).
  // Every LIGHTNING_PARAMS key is settable, not a hand-picked subset like
  // setCandle's own list — this schema is ~50 params (Look/Detail/Light/
  // Motion/Shape/Response), and a hand-maintained allow-list that size is
  // exactly the kind of silent-drift trap this project's own doctrine warns
  // about (a param added later and forgotten here would be un-settable from
  // the console/FOH-ROH panel with no error, just quietly ignored):
  //   MapShine.setLightning({ brightness: 7, maxDelayMs: 4000 })
  MapShine.setLightning = (partial = {}) => {
    const p = partial ?? {};
    if (typeof p.enabled === 'boolean') {
      Promise.resolve(writeSetting(MODULE_ID, effectEnableKey('lightning', 'player'), p.enabled ? 'on' : 'off'))
        .then(() => reapplyLightning())
        .catch((err) => log.error('lightning enable write/reapply failed:', err));
    }
    let changed = false;
    for (const k of Object.keys(LIGHTNING_PARAMS)) {
      if (k in p) {
        lightningLiveOverride[k] = p[k];
        changed = true;
      }
    }
    if (changed) {
      try {
        reapplyLightning();
      } catch (err) {
        log.error('lightning reapply (setLightning) failed:', err);
      }
    }
    return { ...lightningLiveOverride };
  };

  // MapShine.setVegetation — the console tuner AND the FOH/ROH panel's own
  // write path (mirrors MapShine.setCandle exactly, including the "enabled
  // writes the PLAYER setting, then reapplies once the write lands" shape —
  // see setCandle's own comment for why that ordering matters):
  //   MapShine.setVegetation({ swayAmount: 8, flutterAmount: 0.3 })
  // Values ride the transient override and re-resolve at once (not persisted).
  MapShine.setVegetation = (partial = {}) => {
    const p = partial ?? {};
    if (typeof p.enabled === 'boolean') {
      Promise.resolve(writeSetting(MODULE_ID, effectEnableKey('vegetation', 'player'), p.enabled ? 'on' : 'off'))
        .then(() => reapplyVegetation())
        .catch((err) => log.error('vegetation enable write/reapply failed:', err));
    }
    let changed = false;
    // Every key VEGETATION_PARAMS declares (Presence's `enabled` is handled
    // above, through the settings write, not this list) — kept as an
    // explicit list, not `Object.keys(VEGETATION_PARAMS)`, matching setCandle's
    // own precedent: this file already has the params imported for the panel
    // build below, but the explicit list is what actually gets exercised by a
    // console tuner, so a rename here is a visible typo, not a silent no-op.
    for (const k of [
      'intensity',
      'windResponse',
      'swayAmount',
      'swayFrequency',
      'swayCurve',
      'galeBendAmount',
      'galeRateGain',
      'flutterAmount',
      'flutterFrequency',
      'flutterGaleFrequency',
      'flutterUvScale',
      'flutterScale',
      'clumpSizePx',
      'clumpPhaseSpread',
      'clumpAmpSpread',
      'clumpDirSpread',
      'edgeFadeWidthPx',
      'shadowStrength',
    ]) {
      if (k in p) {
        vegetationLiveOverride[k] = p[k];
        changed = true;
      }
    }
    if (changed) {
      try {
        reapplyVegetation();
      } catch (err) {
        log.error('vegetation reapply (setVegetation) failed:', err);
      }
    }
    return { ...vegetationLiveOverride };
  };

  // MapShine.setDoors — the console tuner for door graphics (mirrors
  // setVegetation, including the "enabled writes the PLAYER setting then
  // reapplies once the write lands" shape):
  //   MapShine.setDoors({ animateMotion: false })   // snap, don't swing
  //   MapShine.setDoors({ motionDurationScale: 0.5 })// open twice as fast
  // Values ride the transient override and re-resolve at once (not persisted).
  MapShine.setDoors = (partial = {}) => {
    const p = partial ?? {};
    if (typeof p.enabled === 'boolean') {
      Promise.resolve(writeSetting(MODULE_ID, effectEnableKey('doorGraphics', 'player'), p.enabled ? 'on' : 'off'))
        .then(() => reapplyDoors())
        .catch((err) => log.error('door graphics enable write/reapply failed:', err));
    }
    let changed = false;
    for (const k of ['animateMotion', 'motionDurationScale']) {
      if (k in p) {
        doorLiveOverride[k] = p[k];
        changed = true;
      }
    }
    if (changed) {
      try {
        reapplyDoors();
      } catch (err) {
        log.error('door graphics reapply (setDoors) failed:', err);
      }
    }
    return { ...doorLiveOverride };
  };

  // MapShine.setSunShadows — the console tuner AND the FOH/ROH card's write
  // path (mirrors setBloom exactly, including the "enabled writes the PLAYER
  // setting, then reapplies once the write lands" shape):
  //   MapShine.setSunShadows({ buildingHeightPx: 400, showSkyReach: false })
  MapShine.setSunShadows = (partial = {}) => {
    const p = partial ?? {};
    if (typeof p.enabled === 'boolean') {
      Promise.resolve(writeSetting(MODULE_ID, effectEnableKey('sunShadows', 'player'), p.enabled ? 'on' : 'off'))
        .then(() => reapplySunShadows())
        .catch((err) => log.error('sun shadows enable write/reapply failed:', err));
    }
    let changed = false;
    // Every key SUN_SHADOW_PARAMS declares, spelled out — the same explicitness
    // setBloom/setVegetation use, so a rename shows up as a visible typo here
    // rather than as a slider that silently stops doing anything.
    for (const k of [
      'strength01',
      'buildingHeightPx',
      'dawnDuskLength',
      'lengthScale',
      'softnessBias',
      'edgeBandPx',
      'debugView',
    ]) {
      if (k in p) {
        sunShadowLiveOverride[k] = p[k];
        changed = true;
      }
    }
    if (changed) {
      try {
        reapplySunShadows();
      } catch (err) {
        log.error('sun shadows reapply (setSunShadows) failed:', err);
      }
    }
    return { ...sunShadowLiveOverride };
  };

  // MapShine.setBloom — the console tuner AND the FOH/ROH card's + preset
  // picker's write path (mirrors MapShine.setVegetation exactly, including the
  // "enabled writes the PLAYER setting, then reapplies once the write lands"
  // shape). Accepts a full preset object (bloomPreset(name)) or a single knob:
  //   MapShine.setBloom({ strength: 1.4, atmoStrength: 0.8, atmoTint: '#ffcf9e' })
  MapShine.setBloom = (partial = {}) => {
    const p = partial ?? {};
    if (typeof p.enabled === 'boolean') {
      Promise.resolve(writeSetting(MODULE_ID, effectEnableKey('bloom', 'player'), p.enabled ? 'on' : 'off'))
        .then(() => reapplyBloom())
        .catch((err) => log.error('bloom enable write/reapply failed:', err));
    }
    let changed = false;
    // Every key BLOOM_PARAMS declares (Presence's `enabled` is handled above,
    // through the settings write, not this list) — explicit, matching
    // setVegetation's precedent so a rename is a visible typo, not a silent no-op.
    for (const k of [
      'threshold',
      'knee',
      'strength',
      'coreStrength',
      'coreTint',
      'atmoStrength',
      'atmoTint',
      'coreSpread',
      'atmoSpread',
      'outdoorSpillSuppress',
      'spillLumLo',
      'spillLumHi',
    ]) {
      if (k in p) {
        bloomLiveOverride[k] = p[k];
        changed = true;
      }
    }
    if (changed) {
      try {
        reapplyBloom();
      } catch (err) {
        log.error('bloom reapply (setBloom) failed:', err);
      }
    }
    return { ...bloomLiveOverride };
  };

  // MapShine.setGrade — the Colour Grade card's + preset picker's + console
  // write path (mirrors MapShine.setBloom). A full preset object (gradePreset
  // (name)) or a single knob: MapShine.setGrade({ contrast: 1.2, toneMapping: 'aces' })
  MapShine.setGrade = (partial = {}) => {
    const p = partial ?? {};
    if (typeof p.enabled === 'boolean') {
      Promise.resolve(writeSetting(MODULE_ID, effectEnableKey('grade', 'player'), p.enabled ? 'on' : 'off'))
        .then(() => reapplyGradeLook())
        .catch((err) => log.error('grade enable write/reapply failed:', err));
    }
    let changed = false;
    for (const k of Object.keys(GRADE_LOOK_PARAMS)) {
      if (k in p) {
        gradeLookLiveOverride[k] = p[k];
        changed = true;
      }
    }
    if (changed) {
      try {
        reapplyGradeLook();
      } catch (err) {
        log.error('grade reapply (setGrade) failed:', err);
      }
    }
    return { ...gradeLookLiveOverride };
  };

  /** The Colour Grade effect's render state, injected into the viewer (which
   * owns the GPU and must not reach the registry). Cheap per-frame read. */
  const getGradeLookState = () => ({ enabled: gradeLookReadout.enabled, params: gradeLookReadout.params ?? {} });

  // THE CANDLE EFFECT's render-state seam, injected into the viewer (vt-pan-
  // viewer.js owns the GPU; it must not reach the authority/registry). Returns
  // the cascade-resolved enable + look/light params (from the last apply) and
  // the ACTIVE-FLOOR candle anchors (same floor filter the overlay uses). Cheap
  // enough to call per frame; a cache keyed on floor/scene/param changes is a
  // later optimisation, noted not hidden.

  // THE OUTDOORS-MASK REQUIREMENT (2026-07-21, author directive, verbatim:
  // "the outdoors mask is a requirement not an option... if no outdoors mask
  // is discovered for any effect or part of the system then you need to just
  // fail"). `mask-authority.js` now THROWS `RequiredMaskMissingError` rather
  // than silently serving `absentValue` (1 = fully outdoors) when a floor's
  // level has NO discovered `_Outdoors` file — see that module's own header
  // for why: a silent numeric default is EXACTLY what let a stale
  // wind-exposure snapshot read a genuinely-indoors, correctly-painted room
  // as fully outdoors without anyone finding out (memory:
  // keyhole-wind-wake-turbulence's own addendum — the live bug that prompted
  // this policy). This is the boot-owned catch that turns that throw into a
  // LOUD, THROTTLED (once per floor, not once per candle per frame) warning
  // plus a documented, clearly-a-fallback value — the safety-slide doctrine
  // (feedback_safety_slide_outranks_doctrine: announce always, never
  // silently, never crash the whole viewer over one missing content file)
  // applied to a NEW failure mode, not a reason to abandon it. A future
  // in-app dialogue is planned to guide a GM through painting the missing
  // mask directly from this warning — NOT built yet; failing loud (here) is
  // the interim behaviour until it exists.
  const warnedMissingOutdoorsFloors = new Set();
  function safeSampleOutdoors(floorIndex, x, y) {
    try {
      return maskAuthority.sampleWorld('outdoors', floorIndex, x, y);
    } catch (err) {
      if (!(err instanceof RequiredMaskMissingError)) throw err; // a real bug elsewhere — never swallow it
      if (!warnedMissingOutdoorsFloors.has(floorIndex)) {
        warnedMissingOutdoorsFloors.add(floorIndex);
        // err.message already names the missing suffix (RequiredMaskMissingError's
        // own constructor derives it from the catalog) — no need to repeat it
        // here, and repeating a mask suffix as a literal would trip
        // masks/authority-only (the catalog is the ONE legal home of that string).
        log.error(`floor ${floorIndex}: wind/shelter indoor-outdoor differentiation DISABLED. ${err.message}`);
      }
      return 1; // the SAME numeric fallback the catalog used to serve silently — the difference now is
      // this is a REPORTED degradation (logged once above, and visible in the "Mask authority" debug
      // report's own requiredMasksMissing list), never a silent one.
    }
  }

  /** The viewer's per-frame read of vegetation's current state (mirrors
   * `getCandleRenderState` just below — the SAME injection discipline: vt/
   * never imports boot.js, boot.js hands it a closure instead). `urlByItemId`
   * is read by reference every call, so a later scene load's fresh Map is
   * picked up automatically with no re-wiring. `perfTier` rides along exactly
   * as it does for candles — vegetation-render.js#vegetationTierPlan turns it
   * into "does this tile's flutter/shadow get built at all, and how fine". */
  const getVegetationRenderState = () => ({
    enabled: vegetationReadout.enabled,
    params: vegetationReadout.params ?? {},
    urlByItemId: vegetationUrlByItemId,
    perfTier: vegetationReadout.perfTier,
  });

  // BLOOM's render-state seam, injected into the viewer (vt-pan-viewer.js owns
  // the GPU pyramid; it must not reach the registry). Returns the cascade-
  // resolved enable + params from the last apply. Cheap to call per frame.
  const getBloomRenderState = () => ({
    enabled: bloomReadout.enabled,
    params: bloomReadout.params ?? {},
  });

  // SUN SHADOWS' two seams into the viewer (docs/planning/Sun-Shadows.md).
  const getSunShadowRenderState = () => ({
    enabled: sunShadowReadout.enabled,
    params: sunShadowReadout.params ?? {},
    // The resolved rung, read fresh by the subsystem on EVERY `maybeBake` —
    // the performance profile is a live client setting with no reload behind
    // it, so dropping from Extreme to Standard mid-session has to reach the
    // next bake, not the next scene load.
    perfTier: sunShadowReadout.perfTier,
  });

  /**
   * The floor's occluder height field, for the viewer to upload as one texture.
   * Goes through `scene/sky-reach-access.js` rather than the mask authority
   * directly — that service is the ONE door for "what is between this point and
   * the sky", shared with rain when it lands, so a second consumer cannot pick a
   * subtly different product the way the candle and the wind overlay each did
   * with `skyReach` vs `outdoors` in 2026-07-21.
   *
   * Returns the three unmerged producer channels PLUS the floor's raw
   * `outdoors` grid (the receiver gate) PLUS `coverAbove` (everything above
   * this floor, merged — the layer-smear model's sky-reach layer), because the
   * viewer packs all of it into one RGBA texture and the bake reads it in a
   * single fetch.
   */
  /** Set for any floor whose sun-shadow field is running without an authored
   * outdoors mask — surfaced in the `sun-shadows` report so the degradation is
   * never silent, and warned once per floor rather than once per frame. */
  const sunShadowDegradedFloors = new Map();
  const getCasterHeightField = (floorIndex) => {
    // A floor with no authored outdoors mask still gets sun shadows — see
    // `getDerived`'s `acknowledgeMissingRequired`. Before 2026-07-25 this
    // returned null, silently disabling EVERY sun shadow on such a scene: the
    // author's bridge map (no interiors → no mask ever painted) showed no
    // sky-reach shadow at all, traceable only from a viewer-diagnostics subfield.
    let field = null;
    let outdoors = null;
    let coverAbove = null;
    let degraded = null;
    try {
      field = skyReachAccess.heightField(floorIndex);
      outdoors = maskAuthority.getDerived('outdoors', floorIndex)?.grid ?? null;
      // ⚠️ FETCHED IN THE SAME TRY, THE SAME WAY AS `outdoors` (2026-08-02 —
      // the layer-smear model's SKY-REACH GRADIENT needs it back; see this
      // grid's own comment below for why it was dropped and why it is
      // restored). `getDerived` can throw `RequiredMaskMissingError` for ANY
      // id on a degraded floor, not only `outdoors` — fetching it outside
      // this try, unconditionally, would let a floor that only `outdoors`
      // itself was known to degrade on throw UNCAUGHT here instead.
      coverAbove = maskAuthority.getDerived('coverAbove', floorIndex)?.grid ?? null;
    } catch (err) {
      if (!(err instanceof RequiredMaskMissingError)) throw err;
      degraded = err.message;
      field = maskAuthority.getDerived('casterHeight', floorIndex, { acknowledgeMissingRequired: true });
      outdoors = maskAuthority.getDerived('outdoors', floorIndex, { acknowledgeMissingRequired: true })?.grid ?? null;
      coverAbove =
        maskAuthority.getDerived('coverAbove', floorIndex, { acknowledgeMissingRequired: true })?.grid ?? null;
    }
    if (!field?.channels || !outdoors) return null;
    // ⚠️ PREFER THE CASTER-RESOLUTION TWINS (2026-08-02, author live: a real
    // scene's walls and sky-reach layer were visibly pixelated on the middle
    // floor, and didn't match Shader Lab's own render of the same data at
    // all). `outdoors`/`coverAbove` above are the SHARED, low-res products
    // every other effect (water/wind) also budgets against, fetched here only
    // for their `RequiredMaskMissingError` side effect (the degraded-mode
    // detection this function's own header describes — `field.channels`
    // itself never throws, see `sky-reach-access.js#heightField`'s own
    // `guarded()` wrapper). `field.channels.outdoors`/`.coverAbove`
    // (`mask-derive.js`'s own doc on `casterChannels` has the full story) are
    // caster-resolution copies of the SAME two grids, scaling with whatever
    // `gridMaxDim` the active performance tier actually requested — exactly
    // like `coverOverhead` already did. Falls back to the shared-resolution
    // pair only if a stale/older product genuinely lacks them.
    outdoors = field.channels.outdoors ?? outdoors;
    coverAbove = field.channels.coverAbove ?? coverAbove;
    if (degraded && !sunShadowDegradedFloors.has(floorIndex)) {
      sunShadowDegradedFloors.set(floorIndex, degraded);
      log.warn(
        `floor ${floorIndex}: sun shadows running WITHOUT an authored outdoors mask — buildings cast nothing ` +
          `(their footprints are unknown, not assumed), and every pixel is treated as able to receive a cast ` +
          `shadow. Upper-floor (sky-reach) and overhead shadows still work. ${degraded}`
      );
    }
    return {
      channels: field.channels,
      outdoors,
      coverAbove,
      // Per-source ledger for the grid above (`mask-derive.js#describeAuthoredSources`)
      // — the sun-shadow report prints it, because a grid MEAN cannot say which
      // source made it wrong and three theories died learning that.
      outdoorsLedger: field.outdoorsLedger ?? null,
      scalePx: field.scalePx,
      // ROUND SEVEN (sun-occlusion.js): the scene-wide building height, live —
      // the march's COLUMN test reads this as a uniform rather than a
      // per-texel channel now, so it has to travel alongside the field itself.
      buildingHeightPx: maskAuthority.getBuildingHeightPx(),
      completeness: field.completeness,
      degradedReason: degraded,
    };
  };

  // DOOR GRAPHICS' render-state seam (effects/door-graphics-render.js): the
  // cascade-resolved enable + motion params, plus the active floor's cached door
  // snapshots. `doorSnapshots` is read by reference every call, so a scene
  // load / floor switch / wall edit (`refreshDoors`) is picked up with no re-
  // wiring — the SAME injection discipline as the vegetation/candle seams. vt/
  // owns the leaf meshes + the open/close clock; it never reaches the Foundry
  // read or the registry.
  const getDoorRenderState = () => ({
    enabled: doorReadout.enabled,
    params: doorReadout.params ?? {},
    doors: doorSnapshots,
  });

  const getCandleRenderState = () => {
    // WIND EXPOSURE per candle (2026-07-20; CORRECTED 2026-07-21) — sample
    // the RAW authored `outdoors` mask ("is this location indoors or
    // outdoors"), NOT `skyReach`. `skyReach` answers a narrower, DIFFERENT
    // question (outdoors ∧ ¬overhead-cover — "does open sky reach THIS
    // texel", V2's own rain-occlusion-only purpose: keeping rain from
    // falling under a bridge/roof, per the author's own explanation of that
    // system's real intent). For general wind shelter, `outdoors` alone is
    // the right signal — it was never the candle's own bug (a lone-story
    // building has coverAbove≡0, so skyReach happened to equal outdoors
    // there), but the debug overlay's identically-turbulent-everywhere
    // report made using the WRONG general-purpose signal worth fixing
    // properly rather than leaving two consumers disagreeing about which
    // mask means "sheltered". A one-array-read CPU query per candle
    // (`safeSampleOutdoors`, above), cheap for the handful a scene has. This
    // is the boot-owned bridge: vt/ never reaches the mask authority.
    const floorIndex = activeFloorContext?.floorIndex ?? 0;
    return {
      enabled: candleReadout.enabled,
      params: candleReadout.params ?? {},
      perfTier: candleReadout.perfTier,
      anchors: anchorAuthority.anchorsForEffect('candleFlame', activeFloorContext).map((a) => ({
        id: a.id,
        x: a.x,
        y: a.y,
        windExposure: safeSampleOutdoors(floorIndex, a.x, a.y),
        // PER-CANDLE OVERRIDES (2026-07-22) — colour/size/brightness/light-
        // reach live here (scene/anchor-catalog.js's per-anchor params).
        // effects/candle-flame-render.js's resolveAnchorColorHex/SizePx/
        // LightRadiusPx read this to decide "does THIS candle differ from
        // the shared look" — omitting it would silently make every override
        // invisible to the renderer despite being correctly stored.
        params: a.params,
      })),
    };
  };

  // THE LIGHTNING data seam (effects/lightning-subsystem.js) — same shape as
  // getCandleRenderState just above, minus the per-anchor windExposure sample
  // (lightning samples the shared wind field directly at each strand vertex's
  // own world position in-shader, not via a baked per-anchor exposure — see
  // effects/lightning-render.js's own header for why that's simpler here than
  // candle's per-anchor bake). vt/ never reaches the anchor authority or the
  // settings cascade; it only ever sees what this closure hands it.
  const getLightningRenderState = () => ({
    enabled: lightningReadout.enabled,
    params: lightningReadout.params ?? {},
    perfTier: lightningReadout.perfTier,
    anchors: anchorAuthority.anchorsForEffect('lightning', activeFloorContext).map((a) => ({
      id: a.id,
      x: a.x,
      y: a.y,
      params: a.params,
    })),
  });

  // WIND EXPOSURE AT AN ARBITRARY WORLD POINT (2026-07-21, Wind.md Tier 0/1 —
  // the debug overlay's own seam). Author-reported: the overlay's arrows
  // looked identically turbulent indoors and outdoors, even at gale
  // strength — traced FIRST to the overlay hard-coding exposure at 1
  // (fixed the same day), and THEN to `skyReach` being the wrong signal
  // entirely for general shelter (see getCandleRenderState's own note,
  // just above — same fix, same reasoning, applied to both consumers so
  // there is exactly ONE idea of "is this location sheltered from wind",
  // not two quietly-different ones). `outdoors` is now sampleable directly
  // through `mask-authority.js#sampleWorld` (scene/mask-derive.js's own
  // `DerivedFloorProducts.outdoors` — it didn't exist as its own point-
  // sampleable product until this fix).
  const sampleWindExposureAt = (x, y) => {
    const floorIndex = activeFloorContext?.floorIndex ?? 0;
    return safeSampleOutdoors(floorIndex, x, y);
  };

  // THE MASK-DRIVEN WIND REBAKE TRIGGER's own version seam (2026-07-21) — see
  // vt-pan-viewer.js#pollMaskAuthorityForWindRebake for the full story (the
  // root-cause fix for a stale wind-exposure snapshot baked before real mask
  // content had streamed in). A cheap O(1) read (`getProductsVersion` forces
  // a recompute-if-dirty, same cost class as any other mask-authority read);
  // never throws, even for a scene with a required-and-missing mask — this
  // must stay safe to poll every frame regardless of what safeSampleOutdoors
  // is doing elsewhere.
  const getMaskAuthorityVersion = () => maskAuthority.getProductsVersion();

  // THE SKY LIGHT's `_Outdoors` gate (2026-07-23, docs/planning/Sky.md): the raw
  // authored outdoors grid for a floor, uploaded by vt/ as a texture so the
  // illumination pass can ask "is this pixel outdoors" per-fragment. The
  // long-promised "increment 1b" (`environmental-light.js` has carried
  // "becomes per-pixel when `_Outdoors` indoor/outdoor lands" in its own
  // source since it was written).
  //
  // Deliberately NOT wrapped in safeSampleOutdoors' swallow-and-warn: a floor
  // with no discovered `_Outdoors` SHOULD throw here, and vt/ catches it into a
  // logged "keep the previous gate" rather than inventing a fully-outdoors
  // default of its own. A silent numeric default is exactly what let a stale
  // wind snapshot read a sealed room as open sky
  // (feedback_required_masks_fail_loud).
  const getOutdoorsMaskGrid = (floorIndex) => maskAuthority.getDerived('outdoors', floorIndex)?.grid ?? null;

  // WATER's three mask-authority seams — see effects/water/water-seams.js for
  // why they ask different questions at deliberately different resolutions.
  const { getWaterMaskGrid, getFloorsWithWater, getWaterMaskUrl } = createWaterSeams({
    maskAuthority,
    getFloors: () => lastKnownFloors,
  });
  const water = createWaterRegistration({
    effectRegistry,
    deriveEffectLayers,
    readSetting: (key) => readSetting(MODULE_ID, key),
    writeSetting,
    moduleId: MODULE_ID,
    effectEnableKey,
    log,
  });

  // SHINE's two mask-authority seams (docs/planning/Specular.md) — see
  // effects/specular/specular-seams.js for why the RECT comes from the coarse
  // grid and the COLOUR can only come from the authored file.
  const { getSpecularMaskRect, getSpecularMaskUrl } = createSpecularSeams({
    maskAuthority,
    getFloors: () => lastKnownFloors,
  });
  // FLUID (docs/planning/Fluid.md) — one seam (the authored file; there is no
  // coarse-grid consumer, correction #2) plus the same registration shape.
  // ⚠️ PER ITEM, not per floor — a `_Fluid` mask lives on a TILE as often as on
  // a level background, and the floor-keyed door cannot see a tile's file at
  // all. That was the bug that made this effect render nothing; see
  // `createFluidSeams`'s own header. `getItemCorners` is deferred to the viewer
  // (it owns the texture sizes a placement needs) and injected back in below.
  /* eslint-disable-next-line prefer-const -- reassigned by the viewer's resolver callback below */
  let fluidItemCorners = () => null;
  /* eslint-disable-next-line prefer-const -- reassigned by the viewer's resolver callback below */
  let fluidItemRenderOrder = () => null;
  const { getFluidMaskItems } = createFluidSeams({
    maskAuthority,
    getItems: () => coverItems,
    getFloors: () => lastKnownFloors,
    getItemCorners: (item) => fluidItemCorners(item),
    getItemRenderOrder: (item) => fluidItemRenderOrder(item),
  });
  const fluid = createFluidRegistration({
    effectRegistry,
    deriveEffectLayers,
    readSetting: (key) => readSetting(MODULE_ID, key),
    writeSetting,
    moduleId: MODULE_ID,
    effectEnableKey,
    log,
  });
  const specular = createSpecularRegistration({
    effectRegistry,
    deriveEffectLayers,
    readSetting: (key) => readSetting(MODULE_ID, key),
    writeSetting,
    moduleId: MODULE_ID,
    effectEnableKey,
    log,
  });

  // WINDOW LIGHT's two mask-authority seams (docs/planning/Windows.md) — same
  // split as SHINE's, for the same reason: the RECT comes from the coarse
  // grid, the COLOUR can only come from the authored file.
  const { getWindowMaskRect, getWindowMaskUrl } = createWindowSeams({
    maskAuthority,
    getFloors: () => lastKnownFloors,
  });
  const windowLight = createWindowRegistration({
    effectRegistry,
    deriveEffectLayers,
    readSetting: (key) => readSetting(MODULE_ID, key),
    writeSetting,
    moduleId: MODULE_ID,
    effectEnableKey,
    log,
  });

  // LIVE MASK-AUTHORITY CROSS-CHECK (2026-07-22, the wind+particle probe's
  // own next question): the probe's `wind.exposure` field reads wind's own
  // CACHED snapshot (`windExposureGrid`, refreshed by bakeWindField — see
  // pollMaskAuthorityForWindRebake). A live author report showed `enclosed:
  // true` (walls say sealed room) but `exposure: 1` (fully outdoors) at the
  // SAME point, even after the mask-driven rebake trigger landed — meaning
  // either that trigger isn't actually firing, or the underlying mask-
  // authority query itself is reading something unexpected (wrong floor,
  // genuinely no mask for THIS level) independent of any caching at all.
  // This closure bypasses wind's cache entirely — a FRESH `sampleWorld` call
  // made at probe time, plus enough floor/authored-status context to tell
  // "stale cache" apart from "wrong floor" apart from "no mask for this
  // level" in one report, instead of guessing which it is.
  const probeMaskAuthorityLiveAt = (x, y) => {
    const floorIndex = activeFloorContext?.floorIndex ?? 0;
    let liveExposure = null;
    let liveError = null;
    try {
      liveExposure = maskAuthority.sampleWorld('outdoors', floorIndex, x, y);
    } catch (err) {
      liveError = err instanceof RequiredMaskMissingError ? err.message : String(err?.message ?? err);
    }
    const report = maskAuthority.getReport();
    const floorReport = report.floors.find((f) => f.index === floorIndex) ?? null;
    // getIngestStatus (2026-07-22) — the THIRD provenance state: discovery
    // finding a URL ("authored") is a DIFFERENT pipeline stage from that
    // file's pixels ever actually being decoded ("ingested"). A file can be
    // genuinely discovered and still never have its content land in
    // scene.ingests (a decode failure, a packing/channel mismatch, or the
    // background item never resolving for this floor at all) — which reads
    // identically to "no file was found" at the sampleWorld level, since
    // both leave `floor.outdoors` null. See mask-authority.js#getIngestStatus's
    // own header for the full reasoning.
    const ingestStatus = maskAuthority.getIngestStatus(floorIndex);
    return {
      floorIndex,
      activeFloorContext,
      floorName: floorReport?.name ?? null,
      authoredOutdoors: floorReport?.authored?.outdoors ?? null,
      requiredMasksMissing: floorReport?.requiredMasksMissing ?? null,
      backgroundItemId: ingestStatus.backgroundItemId,
      outdoorsIngested: ingestStatus.outdoorsIngested,
      liveExposure,
      liveError,
    };
  };

  // THE PERFORMANCE LAB harness (2026-07-20) — boot is the composition root that owns
  // the effect registry, each effect's reapply closure, and the viewer read seam, so it
  // assembles the small contract diag/perf-lab.js sweeps over. The tool never touches
  // effects/ or the settings cascade directly (same injection discipline as
  // getCandleRenderState) — it only asks the harness to toggle an effect and read the
  // cost. A forced toggle is TRANSIENT (resolveAndApply with an override layer, NEVER a
  // written setting), so a sweep can't persist a change; restoring passes null → the
  // effect's own reapply, back on its real cascade + live overrides.
  const reapplyById = {
    candleFlame: reapplyCandle,
    uiWindowShadow: reapplyUiShadow,
    vegetation: reapplyVegetation,
    bloom: reapplyBloom,
    grade: reapplyGradeLook,
    doorGraphics: reapplyDoors,
    water: water.reapply,
    fluid: fluid.reapply,
    specular: specular.reapply,
    window: windowLight.reapply,
  };
  function forceEffectEnabled(id, enabled) {
    if (enabled == null) {
      const restore =
        reapplyById[id] ??
        (() =>
          effectRegistry.resolveAndApply(
            id,
            deriveEffectLayers(id, (k) => readSetting(MODULE_ID, k))
          ));
      restore();
      return;
    }
    const layers = deriveEffectLayers(id, (k) => readSetting(MODULE_ID, k));
    layers.playerEnable = enabled ? 'on' : 'off'; // transient override — nothing written
    effectRegistry.resolveAndApply(id, layers);
  }
  const perfHarness = {
    listEffects: () => effectRegistry.list().map((m) => ({ id: m.id, label: m.title ?? m.id })),
    setForcedEnabled: (id, enabled) => forceEffectEnabled(id, enabled),
    setGpuProbe: (on) => setVtPanViewerGpuProbe(on),
    resetFrameStats: () => resetVtPanViewerFrameStats(),
    readCost: () => {
      const d = getVtPanViewerDiagnostics();
      return {
        active: d.active === true,
        gpuProbe: d.gpuProbe ?? null,
        hitchStats: d.hitchStats ?? null,
        renderMsAvgLast120: d.renderMsAvgLast120 ?? null,
      };
    },
  };
  const perfLab = createPerfLab(perfHarness);
  MapShine.debug.registerAction(
    'perf-lab',
    '🔬 Performance',
    () => {
      perfLab.open();
      return {
        opened: true,
        hint: 'Panel opened (top-right). Click "Run sweep" — the scene will flicker for a few seconds, then restore. The full JSON report is copied to your clipboard when it finishes.',
      };
    },
    { primary: true } // quick-reach, alongside Pixel Probe — both load-bearing, neither buried in a folder
  );

  // ===========================================================================
  // THE PERFORMANCE PROFILE (docs/planning/Performance.md)
  //
  // The sweep above answers "what does bloom cost". This answers "WHERE inside
  // the frame does the time go" — per pass, and inside the heavy passes, per
  // draw and per sync. Same injection discipline: boot assembles a small
  // harness, diag/perf-session.js owns the sequence, and nothing in diag/
  // reaches for a global.
  // ===========================================================================

  // The frame waiter reads a clock, so it is built in diag/ where
  // `time/one-clock` allows one — boot only says WHAT to wait on.
  const waitProfiledFrames = createProfiledFrameWaiter({ readProfile: () => perfProfiler.snapshot() });

  const profileHarness = {
    isGpuProbeArmed: () => getVtPanViewerDiagnostics?.()?.gpuProbe?.active === true,
    profilerOwner: () => perfProfiler.owner(),
    armProfiler: (o) =>
      perfProfiler.arm({
        ...o,
        owner: 'session',
        // Draw-call and triangle deltas per zone, straight off renderer.info —
        // two integer reads per bracket, and enormously diagnostic ("point
        // lights = 340 draw calls" is a different problem from "point lights are
        // fill-rate bound").
        readDrawCalls: () => readVtPanViewerRenderInfo()?.drawCalls ?? 0,
        readTriangles: () => readVtPanViewerRenderInfo()?.triangles ?? 0,
      }),
    disarmProfiler: () => perfProfiler.disarm(),
    readProfile: () => perfProfiler.snapshot(),
    setGpuZoneTimer: (on) => setVtPanViewerGpuZoneTimer(on),
    getGpuZoneStatus: () => getVtPanViewerGpuZoneStatus(),
    resetFrameStats: () => resetVtPanViewerFrameStats(),
    readFrameStats: () => {
      const samples = readVtPanViewerFrameSamples() ?? {};
      const d = getVtPanViewerDiagnostics?.() ?? {};
      return {
        gapSamples: samples.gapSamples ?? [],
        hitches: samples.hitches ?? [],
        hitchThresholdMs: samples.hitchThresholdMs ?? null,
        // The COARSE whole-frame GPU number, from the other instrument. Present
        // only if a sweep armed it — normally null, and null here is honest:
        // attribution.coverage then reports 'unmeasured' rather than dividing by
        // a number nobody measured.
        gpuMs: d.gpuProbe?.sampleCount
          ? { p50: d.gpuProbe.gpuMsMedian, p95: d.gpuProbe.gpuMsP95, sampleCount: d.gpuProbe.sampleCount }
          : null,
        cpuEncodeMs:
          samples.cpuEncodeMsAvgLast120 === null ? null : { p50: samples.cpuEncodeMsAvgLast120, sampleCount: 120 },
      };
    },
    getContext: () => {
      const info = readVtPanViewerRenderInfo();
      return {
        msaVersion: MapShine.version,
        codename: MapShine.codename,
        resolution: info ? { w: info.width, h: info.height, pixelRatio: info.pixelRatio } : null,
        sceneName: activeFloorContext?.sceneName ?? null,
        floorIndex: activeFloorContext?.floorIndex ?? 0,
        // Resolved through the REAL cascade, not a guessed settings key. An
        // effect's on/off state is the product of profile + GM + player layers,
        // and a report that guessed it would mislabel exactly the rows someone
        // is about to act on.
        enabledEffects: effectRegistry
          .list()
          .filter((m) =>
            resolveEffectEnabled(
              m,
              deriveEffectLayers(m.id, (k) => readSetting(MODULE_ID, k))
            )
          )
          .map((m) => m.id),
      };
    },
    waitFrames: (n) => waitProfiledFrames(n),
    getManifests: () => effectRegistry.list(),
    readVram: () =>
      buildVramInventory({
        // `.wholeImage`, NOT the diagnostics root — `estTextureVramMB` lives on
        // the whole-image summary (vt-pan-viewer-diagnostics.js's
        // summarizeWholeImage). Passing the root silently produced an
        // all-null VRAM block on the first real run.
        vtEstimate: getVtPanViewerDiagnostics?.()?.wholeImage ?? null,
        // The MEASURED device-loss wall on the reference machine
        // (keyhole-device-loss-large-map), not a guess.
        ceilingMb: 2500,
      }),
    // The sweep, consumed as an INDEPENDENT cross-check of zone attribution.
    // Two methods measuring the same effect and disagreeing is information —
    // perf-report.js classifies the disagreement rather than averaging it away.
    runSweep: () => runSweep(perfHarness),
  };

  MapShine.debug.registerAction(
    'perf-run',
    '🔬 Profile (per-zone)',
    async () => {
      const started = new Date().toISOString();
      lastPerfProfile = await runProfileSession(profileHarness, {
        generatedAt: started,
        onProgress: (phase, detail) => log.info(`perf profile: ${phase}${detail ? ` — ${detail}` : ''}`),
      });
      // RETURN THE REPORT — do not copy it here. `debug-panel-controls.js`'s
      // makeRunnable is what every action button in this panel is wired to: it
      // awaits entry.fn(), THEN stringifies and copies whatever it returned —
      // after this function has already returned. A copyToClipboard() call
      // inside the action body runs first and is unconditionally overwritten a
      // moment later by the panel's own copy of the return value. Confirmed
      // live 2026-07-27: the clipboard held a five-field summary object, never
      // the report, on every click. Every other action in this file
      // (orientation-self-test, particle-diagnostics, vt-live-decode, …)
      // already follows the real contract — just return the payload.
      return lastPerfProfile;
    },
    // Quick-reach beside the sweep: this is the one you click when something
    // feels slow, and burying it in a folder would make the sweep the default
    // answer to a question it cannot answer.
    { primary: true }
  );

  const perfHud = createPerfHud({
    profiler: perfProfiler,
    arm: () =>
      perfProfiler.arm({
        owner: 'hud', // so a profile session refuses rather than fighting the HUD's resets
        settleFrames: 0, // a live view wants THIS quarter-second, not a settled average
        readDrawCalls: () => readVtPanViewerRenderInfo()?.drawCalls ?? 0,
        readTriangles: () => readVtPanViewerRenderInfo()?.triangles ?? 0,
      }),
    disarm: () => perfProfiler.disarm(),
    setGpuZoneTimer: (on) => setVtPanViewerGpuZoneTimer(on),
    readGpuStatus: () => getVtPanViewerGpuZoneStatus(),
  });

  // The full run: zones AND the on/off sweep, so every effect gets both a direct
  // and a marginal measurement and the report can say where they disagree. Slow
  // and visibly flickery (the sweep throttles the loop by design), which is why
  // it is a separate, deliberate button rather than a flag on the quick one.
  MapShine.debug.registerAction('perf-run-full', '🔬 Profile + effect sweep (slow)', async () => {
    const started = new Date().toISOString();
    lastPerfProfile = await runProfileSession(profileHarness, {
      generatedAt: started,
      includeSweep: true,
      onProgress: (phase, detail) => log.info(`perf profile: ${phase}${detail ? ` — ${detail}` : ''}`),
    });
    // See perf-run's comment: the panel copies the RETURN VALUE, always after
    // entry.fn() resolves — a manual copyToClipboard() here would be silently
    // clobbered. effects[].agreement is already in the report per effect;
    // filtering it into a synthetic summary field would just duplicate what
    // the reader can already see.
    return lastPerfProfile;
  });

  /**
   * Build the FIXED north-to-south benchmark route. Extracted 2026-07-29 (was
   * inline in `perf-benchmark` alone) so the new all-tiers report below plays
   * the BYTE-IDENTICAL route once per tier rather than re-deriving it five
   * times — two derivations of "the same route" is exactly the repeatability
   * bug a fixed benchmark exists to prevent (see the next paragraph).
   *
   * A FIXED ROUTE, so two runs are comparable. Hand-panning twice produces two
   * different workloads, and a 15% "win" measured that way is indistinguishable
   * from a 15% difference in how you moved the camera.
   *
   * GENERATED, NOT RECORDED (author, 2026-07-28: "a north to south full sweep
   * of the map over 60 seconds ... maximum stress"). Deriving the route from
   * the scene's own dimensions means it needs no setup, is identical on every
   * run, and is identical across scenes and machines — which is the whole
   * point of a benchmark. Requiring a hand-recorded path would have made the
   * route itself a variable.
   *
   * The sweep is the STRESS: full-width framing dragged the length of the map,
   * so every frame pages in new virtual-texture content while every effect
   * stays on. A slow, steady traverse also makes residency work visible as
   * hangs rather than hiding it behind a teleport.
   *
   * ⚠️ longJumpFadeCut: false IS LOAD-BEARING, not decoration (found live
   * 2026-07-28 — "the camera didn't start at the north, it just moved down
   * and to the right and finished"). DEFAULT_SETTINGS.longJumpFadeCut is
   * true, and buildCameraTimeline's own heuristic classifies any pan whose
   * distance exceeds LONG_JUMP_FADE_RATIO (0.33) of the map's longest axis
   * as an ACCIDENTAL long jump — fade to black, INSTANT SNAP straight to the
   * end point (skipping the start entirely), fade back in, done in ~1s. A
   * full north-to-south sweep is deliberately ~1.0 of the map height, so it
   * hit that heuristic every time and the "60-second sweep" never happened —
   * it snapped from wherever the camera already was to the south edge and
   * finished in about a second. `generateKeyframePreset` already returns
   * `suggestedLongJumpFadeCut: false` for exactly this reason (the code
   * comment on its 'full' preset branch describes this EXACT failure); the
   * first version of this action built its own settings object and dropped
   * that field instead of reading it (same bug class as
   * `feedback_read_the_producer_never_invent_its_shape`).
   *
   * fadeInMs/fadeOutMs are also zeroed: their defaults (600ms each) are
   * separate awaited steps outside the pan loop, so left at default the
   * measured window would run ~1.2s longer than the actual sweep for no
   * reason relevant to an automated benchmark.
   *
   * playCameraPath() itself always snaps to keyframes[0] before playing
   * (2026-07-29, camera-path-player.js) — so replaying the SAME returned path
   * object for a second/third/... tier is safe and starts from the same place
   * every time; nothing here needs to re-snap by hand.
   * @returns {object} a normalized camera path, ready for `playCameraPath`.
   */
  function buildBenchmarkPath() {
    const preset = generatePresetKeyframes('n_to_s');
    if (!preset?.keyframes?.length) {
      throw new Error(
        // NB: no literal Foundry accessor path in this string — the
        // `foundry/adapter-only` wall greps for those and cannot tell a code
        // path from an error message. Reworded rather than granted an
        // exception (2026-07-28).
        'perf benchmark: could not derive a north-to-south route from this scene. That needs the live scene ' +
          'dimensions, so load a scene first. This action never falls back to a hand-panned window, because a ' +
          'number from an unknown route looks comparable to a previous run and is not.'
      );
    }
    return normalizeCameraPath({
      keyframes: preset.keyframes,
      settings: {
        sweepMs: BENCHMARK_SWEEP_MS,
        easing: 'linear',
        hideUi: false,
        fadeInMs: 0,
        fadeOutMs: 0,
        longJumpFadeCut: preset.suggestedLongJumpFadeCut,
      },
    });
  }

  MapShine.debug.registerAction('perf-benchmark', '🏁 Benchmark: N→S map sweep (60s)', async () => {
    const path = buildBenchmarkPath();
    const started = new Date().toISOString();
    // Start the camera moving, then profile WHILE it moves — the route IS the
    // workload, so the measurement window is exactly its duration.
    const playing = playCameraPath(path).catch((err) => {
      log.error('camera path playback failed during the benchmark run:', err);
    });
    try {
      lastPerfProfile = await runProfileSession(profileHarness, {
        generatedAt: started,
        measureUntil: playing,
        route: `n_to_s:${path.keyframes.length}kf/${BENCHMARK_SWEEP_MS}ms`,
        onProgress: (phase, detail) => log.info(`perf benchmark: ${phase}${detail ? ` — ${detail}` : ''}`),
      });
    } finally {
      stopCameraPath();
      await playing;
    }
    return lastPerfProfile;
  });

  /**
   * FORCE EVERY EFFECT to resolve as if the performance PROFILE were `profile`,
   * without writing the setting — same shape as `forceEffectEnabled` above:
   * `deriveEffectLayers` (real settings) + one field OVERRIDDEN + direct
   * `resolveAndApply`, bypassing each effect's own bespoke reapply closure
   * exactly as that function already does. TRANSIENT by construction — a run
   * that throws partway through can never leave the wrong tier applied to a
   * real save, because nothing here ever calls `writeSetting`. Restoring
   * (`profile: null`) calls `reapplyAll`, which DOES route through every
   * bespoke closure, recovering things like UI shadow's live console-tuned
   * params that get dropped WHILE a profile is forced — the same trade
   * `forceEffectEnabled`'s own restore-via-`reapplyById` already makes.
   *
   * ⚠️ DOES NOT COMPOSE WITH THE EFFECT SWEEP. `forceEffectEnabled` (what
   * `runSweep` uses to toggle one effect at a time) derives THAT effect's
   * layers fresh from the REAL stored settings the moment it touches it — it
   * has no idea a profile is being forced here, so the instant the sweep
   * toggles an effect, that effect's profile silently reverts to whatever is
   * really saved for the rest of the sweep. This is why the all-tiers report
   * below runs the ZONE PROFILE only (`includeSweep` stays false): the zone
   * timer measures whatever is actually drawing and is unaffected by this,
   * while the sweep would quietly produce the SAME numbers in every tier's
   * report and look like a real comparison without being one.
   * @param {string|null} profile - a real `PERFORMANCE_PROFILES` value, or
   *   `null` to restore every effect to its real, settings-derived state.
   */
  function forcePerformanceProfile(profile) {
    if (profile == null) {
      reapplyAll('perf tier report restore');
      return;
    }
    for (const m of effectRegistry.list()) {
      const layers = deriveEffectLayers(m.id, (k) => readSetting(MODULE_ID, k));
      layers.profile = profile; // transient override — nothing written
      effectRegistry.resolveAndApply(m.id, layers);
    }
  }

  // THE ULTIMATE BUTTON (author, 2026-07-29): "make it do the full test at each
  // performance tier ... one big ultimate 'Performance Report' button which
  // does everything ... I don't mind if it takes longer, we can give things
  // longer to settle." Plays the SAME benchmark route once per
  // `PERFORMANCE_PROFILES` tier, each under a transient profile override
  // (`forcePerformanceProfile`, never written), settling LONGER than a single
  // run gets (`TIER_SETTLE_FRAMES`, not `runProfileSession`'s own default 30 —
  // a tier change can rebuild several effects' materials at once: candle
  // flame + light, any water/specular/fluid rung change).
  //
  // A tier that throws is logged and OMITTED, not fatal to the other four —
  // this is a ~5-10 minute run and one bad tier should not cost the rest of
  // it. The real profile is ALWAYS restored in the outer `finally`, whether
  // every tier succeeded or the run was aborted partway.
  MapShine.debug.registerAction(
    'perf-report-all-tiers',
    '📊 Performance Report — ALL TIERS (slow)',
    async () => {
      const path = buildBenchmarkPath(); // throws BEFORE anything is forced if no scene is loaded
      const generatedAt = new Date().toISOString();
      const tierResults = [];
      const tiersFailed = [];
      try {
        for (let i = 0; i < PERFORMANCE_PROFILES.length; i++) {
          const profile = PERFORMANCE_PROFILES[i];
          const tag = `${i + 1}/${PERFORMANCE_PROFILES.length} '${profile}'`;
          try {
            log.info(`perf report (all tiers): forcing tier ${tag}`);
            forcePerformanceProfile(profile);
            const playing = playCameraPath(path).catch((err) => {
              log.error(`perf report (all tiers): camera path playback failed during tier '${profile}':`, err);
            });
            try {
              const report = await runProfileSession(profileHarness, {
                generatedAt: new Date().toISOString(),
                measureUntil: playing,
                settleFrames: TIER_SETTLE_FRAMES,
                route: `n_to_s:${path.keyframes.length}kf/${BENCHMARK_SWEEP_MS}ms:tier=${profile}`,
                onProgress: (phase, detail) =>
                  log.info(`perf report (all tiers) [${profile}]: ${phase}${detail ? ` — ${detail}` : ''}`),
              });
              tierResults.push({ profile, report });
            } finally {
              stopCameraPath();
              await playing;
            }
          } catch (err) {
            log.error(`perf report (all tiers): tier ${tag} failed, continuing to the next tier:`, err);
            tiersFailed.push({ profile, error: String(err?.message ?? err) });
          }
        }
      } finally {
        // ALWAYS, even if every tier threw — a forced tier must never survive
        // past this action, the same guarantee `forceEffectEnabled`'s own
        // restore path already gives the effect sweep.
        log.info('perf report (all tiers): restoring the real performance profile');
        forcePerformanceProfile(null);
      }
      // Kept OUT of what gets copied — see lastAllTiersReports' own doc for why
      // (the ~300KB v1). Console-reachable via MapShine.getTierReport below,
      // without paying for a second run.
      lastAllTiersReports = Object.fromEntries(tierResults.map(({ profile, report }) => [profile, report]));
      lastPerfProfile = {
        report: 'perf-tier-comparison',
        formatVersion: 2, // v1 nested full per-tier reports here; see lastAllTiersReports' doc for why that's gone
        generatedAt,
        route: `n_to_s:${path.keyframes.length}kf/${BENCHMARK_SWEEP_MS}ms`,
        tiersRun: tierResults.map((t) => t.profile),
        tiersFailed,
        note: "Full per-tier reports are not included here — call MapShine.getTierReport('<profile>') in the console for one tier's complete zone/effect breakdown.",
        // frame / perTierHealth / ranked — see summarizeTierComparison's own
        // doc. `ranked` is THE answer to "where should optimisation effort
        // go": every effect AND every unowned shared zone, one list, sorted
        // by peak cost across tiers.
        ...summarizeTierComparison(tierResults),
      };
      return lastPerfProfile;
    },
    { primary: true }
  );
  // THE ESCAPE HATCH for lastAllTiersReports — one full perf-profile report
  // for one tier from the LAST all-tiers run, with no second ~10-minute run.
  // Console-only by design: a "which tier" parameter has no natural home in
  // the debug panel's four primitives (report/action/select/panel all assume
  // a fixed signature), and this is a rare, deliberate "show me everything"
  // ask that a console call fits better than a fifth permanent button
  // (feedback_debug_ui_one_action_one_control).
  MapShine.getTierReport = (profile) => lastAllTiersReports?.[profile] ?? null;

  MapShine.debug.registerAction('perf-hud', '📊 Live zone HUD (toggle)', () => {
    const state = perfHud.toggle();
    return {
      ...state,
      hint: state.visible
        ? 'Top-right overlay, repainting 4x/sec over a rolling window. Pan, zoom, or toggle an effect and watch the ranking move. Toggle again to switch it off — it arms the profiler while visible.'
        : 'HUD off; the profiler and the GPU zone timer are disarmed.',
    };
  });

  // THE CAMERA-PATH TOOL (2026-07-21, author request: revive V2's camera-pass
  // recorder for PIXI mode, with UI-hide, needed to finish releasing maps).
  // Routed to the 'bridge' zone (ZONES map, diag/debug-panel.js) — Control-
  // Panel.md's own stub scaffold already anticipated "Recall camera" there;
  // this is the first real control to land in Bridge.
  MapShine.debug.registerAction('camera-path-open', '🎥 Camera Path', () => {
    openCameraPathDialog();
    return { opened: true, hint: 'Panel opened (top-right). Capture keyframes from the live view, then Play.' };
  });

  MapShine.debug.registerReport(
    'anchors',
    'Anchors + V2 import (candle placement)',
    () => ({
      report: 'anchors',
      generatedAt: new Date().toISOString(),
      candle: candleReadout,
      activeFloor: activeFloorContext,
      lastImport: lastAnchorImport,
      authority: anchorAuthority.getReport(),
    }),
    { effect: 'candleFlame' }
  );

  MapShine.debug.registerReport(
    'lightning-anchors',
    'Anchors + V2 import (lightning placement)',
    () => ({
      report: 'lightning-anchors',
      generatedAt: new Date().toISOString(),
      lightning: lightningReadout,
      activeFloor: activeFloorContext,
      lastImport: lastAnchorImport,
      authority: anchorAuthority.getReport(),
    }),
    { effect: 'lightning' }
  );

  // THE GENERIC LIVE MARKER OVERLAY (2026-07-20, author on seeing the one-shot
  // version drift under pan/zoom: "a diagnostic UI would actually be very
  // useful for this module so as long as we can make it generically useful
  // for all effects, then it's worth keeping and improving"). The candle
  // registers itself into diag/marker-overlay.js's registry — the ONE door any
  // future effect (lightning points, rope endpoints) uses to get its own
  // placements drawn, without hand-rolling a second overlay. Re-registering on
  // every reapplyCandle is cheap and idempotent (registerMarkerSource replaces
  // by id) and keeps the source's colour in sync with the live look param.
  function registerCandleMarkerSource() {
    registerMarkerSource('candleFlame', {
      label: 'Candle flames',
      color: candleReadout.params?.color ?? '#ffaa00',
      // MUST stay cheap (called every animation frame while armed) — this is
      // exactly that: a read of the already-served list, filtered to the active
      // floor so only THIS floor's candles are drawn.
      getPoints: () =>
        anchorAuthority.anchorsForEffect('candleFlame', activeFloorContext).map((a) => ({ x: a.x, y: a.y })),
    });
  }

  /** Same as registerCandleMarkerSource, for lightning's two-endpoint-per-bolt
   * anchors — every served start/end/waypoint draws as its own point (the
   * overlay has no notion of "these two belong to one bolt", same as the
   * placement icons themselves). Colour matches V2's own on-map marker tint
   * for lightning map points (legacy/scene/map-point-interaction.js's
   * EFFECT_COLORS, 0x00aaff) — a small continuity touch, not load-bearing. */
  function registerLightningMarkerSource() {
    registerMarkerSource('lightning', {
      label: 'Lightning bolts',
      color: '#00aaff',
      getPoints: () =>
        anchorAuthority.anchorsForEffect('lightning', activeFloorContext).map((a) => ({ x: a.x, y: a.y })),
    });
  }

  /** Whether the live overlay is currently armed — the toggle action's own state. */
  let liveMarkersArmed = false;

  MapShine.debug.registerAction(
    'live-markers-toggle',
    '🕯️ Live marker overlay: toggle',
    async () => {
      if (liveMarkersArmed) {
        await stopVtPanViewerLiveMarkers();
        liveMarkersArmed = false;
        return { armed: false };
      }
      const result = await startVtPanViewerLiveMarkers(() =>
        getAllMarkerPoints({ onError: (id, err) => log.error(`marker source '${id}' failed:`, err) })
      );
      liveMarkersArmed = !result?.skipped;
      return { armed: liveMarkersArmed, sources: 'candleFlame, lightning (more effects register the same way)' };
    },
    { effect: 'candleFlame' }
  );

  // ---------------------------------------------------------------------------
  // THE CANDLES WORKSHOP PANEL — the FIRST card built from `diag/effect-
  // controls.js`'s generic FOH/ROH renderer (docs/planning/Effects-UI.md), the
  // template every later effect's card copies. FOH = enable + a short curated
  // slider/swatch strip in plain language; "Advanced ▾" opens the FULL
  // CANDLE_FLAME_PARAMS schema, categorised. `extra` adds the one thing a
  // schema alone can't express: placing/editing INDIVIDUAL candles (ui/anchor-
  // mode.js), which is a per-ANCHOR concern, not a per-EFFECT param.
  // ---------------------------------------------------------------------------

  /** The candle anchor kind's own per-instance params (scene/anchor-catalog.js)
   * — intensity + the useCustomX/customX override pairs the edit popup renders. */
  const CANDLE_ANCHOR_PARAMS = anchorKindById('candleFlame')?.params ?? {};

  /** Build the per-candle edit form (ui/anchor-mode.js's popup content) — the
   * ONLY place candle-specific fields are laid out; anchor-mode.js itself
   * knows nothing about brightness/size/reach/colour.
   *
   * `anchor` is read for display values only. `targetIds` (defaults to just
   * `anchor.id` for a single selection) is who every field actually patches —
   * when the popup represents a multi-select, `patch()` fans the same fields
   * out to every selected candle so "edit all their settings at once" is one
   * drag/click/pick, not one per candle. */
  function buildCandleEditForm(anchor, targetIds = [anchor.id]) {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '5px' });
    const patch = (fields) => {
      for (const id of targetIds) updateCandleAnchor(id, fields);
    };

    // Brightness — always its own value; there is no shared "all candles"
    // brightness to inherit from (unlike size/reach below).
    wrap.append(
      buildParamControl('intensity', CANDLE_ANCHOR_PARAMS.intensity, {
        value: anchor.params?.intensity ?? 1,
        onChange: (v) => patch({ params: { intensity: v } }),
      })
    );

    wrap.append(
      buildInheritableRangeRow({
        label: 'Size',
        help: 'This candle’s own flame size. Drag to set it apart from the shared size; reset to match again.',
        min: CANDLE_FLAME_PARAMS.sizePx.min,
        max: CANDLE_FLAME_PARAMS.sizePx.max,
        step: CANDLE_FLAME_PARAMS.sizePx.step,
        effectiveValue: resolveAnchorSizePx(anchor, candleReadout.params?.sizePx),
        isOverridden: anchor.params?.useCustomSize === true,
        onDrag: (v) => patch({ params: { useCustomSize: true, customSizePx: v } }),
        onResetToShared: () => patch({ params: { useCustomSize: false } }),
      })
    );

    wrap.append(
      buildInheritableRangeRow({
        label: 'Light reach',
        help: 'This candle’s own light radius — 0 means it casts no light at all, regardless of the shared setting.',
        min: CANDLE_FLAME_PARAMS.lightRadiusPx.min,
        max: CANDLE_FLAME_PARAMS.lightRadiusPx.max,
        step: CANDLE_FLAME_PARAMS.lightRadiusPx.step,
        effectiveValue: resolveAnchorLightRadiusPx(anchor, candleReadout.params?.lightRadiusPx),
        isOverridden: anchor.params?.useCustomLightRadius === true,
        onDrag: (v) => patch({ params: { useCustomLightRadius: true, customLightRadiusPx: v } }),
        onResetToShared: () => patch({ params: { useCustomLightRadius: false } }),
      })
    );

    // Custom colour — a checkbox + a swatch (two rows, not one combined
    // control: the two generic widgets already exist and compose cleanly;
    // picking a colour also turns the override on, so a user who just wants
    // to pick a colour never has to remember the checkbox separately).
    wrap.append(
      buildParamControl('useCustomColor', CANDLE_ANCHOR_PARAMS.useCustomColor, {
        value: anchor.params?.useCustomColor === true,
        onChange: (v) => patch({ params: { useCustomColor: v } }),
      })
    );
    wrap.append(
      buildParamControl('customColor', CANDLE_ANCHOR_PARAMS.customColor, {
        value: anchor.params?.customColor ?? CANDLE_ANCHOR_PARAMS.customColor.default,
        onChange: (v) => patch({ params: { useCustomColor: true, customColor: v } }),
      })
    );

    // VISIBLE FROM (2026-08-01) — which floors this candle survives on. This
    // form is hand-laid-out, NOT generated from the schema, so a new entry in
    // `scene/anchor-catalog.js` reaches the author only if it is added here
    // too: adding the param without this row would be a control that exists,
    // validates, persists and is read by the authority, while being completely
    // unreachable — the "declared, defaulted, consumed, never wired" shape this
    // project has already shipped once.
    wrap.append(
      buildParamControl('floorVisibility', CANDLE_ANCHOR_PARAMS.floorVisibility, {
        value: anchor.params?.floorVisibility ?? CANDLE_ANCHOR_PARAMS.floorVisibility.default,
        onChange: (v) => patch({ params: { floorVisibility: v } }),
      })
    );

    // Lit — the anchor's own `enabled` flag (not a param; scene/anchor-
    // authority.js's own field), so it goes through `patch({enabled})`
    // directly rather than `patch({params:{...}})`.
    wrap.append(
      buildParamControl(
        'enabled',
        { type: 'bool', label: 'Lit', help: 'Turn this one candle off without deleting it.' },
        { value: anchor.enabled !== false, onChange: (v) => patch({ enabled: v }) }
      )
    );

    return wrap;
  }

  /**
   * THE + IN AN EFFECT CARD'S HEADER, derived from the effect's own manifest
   * (`authoring.paint` — see effect-manifest.js's validateAuthoring).
   *
   * The author's brief was that adding an effect to a map needs "a prominent and
   * reliable place": same slot, same shape, on every card, visible while the card
   * is folded shut. So this is DERIVED, never hand-written per effect — an effect
   * that declares how it is painted gets its button for free, and one that has
   * nowhere on a map to go (bloom, the colour grade) correctly gets none.
   *
   * It opens the brush with THAT mask already selected — Control-Panel.md §5.2
   * step 2's "no mask-picker detour". For an effect painted through more than one
   * mask (vegetation's tree/bush pair) it opens on the first and names the rest in
   * the tooltip; the brush's own toolbar switches between them.
   *
   * Looked up THROUGH THE REGISTRY rather than from an imported manifest, because
   * the registry is the one door (Effect-Registration.md) — and because that means
   * a future effect gets its button by declaring `authoring.paint`, with no second
   * edit here and no new import.
   *
   * @param {string} effectId
   * @returns {{label: string, title: string, onAdd: () => void}|undefined}
   */
  function paintAffordance(effectId) {
    const paint = effectRegistry.get(effectId)?.manifest?.authoring?.paint;
    if (!paint) return undefined;
    const kinds = Array.isArray(paint) ? paint : [paint];
    const suffixes = kinds.map((k) => maskKindById(k)?.suffixes?.[0] ?? k);
    return {
      label: suffixes.length === 1 ? `\u{1F58C} Paint ${suffixes[0]}` : '\u{1F58C} Paint',
      title:
        `Opens the brush on the floor you are viewing, with ${suffixes.join(' / ')} ready to paint. ` +
        'Paint where the effect belongs; it reads the mask live.',
      onAdd: () => MapShine.__painter?.enter({ kind: kinds[0] }),
    };
  }

  function buildCandlesPanel({ attachments } = {}) {
    const schema = CANDLE_FLAME_PARAMS;
    const getValue = (id) => {
      const v = candleReadout.params?.[id];
      return v !== undefined ? v : schema[id]?.default;
    };
    const onChange = (id, value) => MapShine.setCandle({ [id]: value });

    // ENTER PLACEMENT MODE. Real clickable/draggable 🕯️ icons ARE the marker
    // (ui/anchor-mode.js's own header explains why this replaced proximity
    // hit-testing) — no need to separately arm the passive diagnostic overlay.
    const enterCandlePlacement = () => {
      const result = MapShine.__anchorMode.enter({
        kindLabel: 'candle',
        icon: anchorKindById('candleFlame')?.icon,
        listAnchors: () => anchorAuthority.anchorsForEffect('candleFlame', activeFloorContext),
        addAnchor: (wx, wy) => addCandle(wx, wy),
        updateAnchor: (id, patch) => updateCandleAnchor(id, patch),
        removeAnchor: (id) => removeCandleAnchor(id),
        buildEditForm: buildCandleEditForm,
      });
      if (!result?.ok) log.error('could not enter candle placement mode:', result?.reason);
    };

    return buildEffectCard({
      id: 'candleFlame',
      diagnostics: attachments,
      icon: '🕯️',
      title: 'Candle flames',
      subtitle: 'add & tune',
      status: () =>
        collapsedStatusLine({
          enabled: candleReadout.enabled,
          count: anchorAuthority.anchorsForEffect('candleFlame', activeFloorContext).length,
          noun: 'candle',
        }),
      schema,
      fohKeys: ['color', 'sizePx', 'lightRadiusPx'],
      getValue,
      onChange,
      enabled: candleReadout.enabled,
      onToggleEnabled: (next) => MapShine.setCandle({ enabled: next }),
      add: {
        label: '➕ Place',
        title: 'Click the map to drop a candle; click an existing 🕯️ to edit or remove it.',
        onAdd: enterCandlePlacement,
      },
    });
  }

  MapShine.debug.registerPanel('candles-panel', 'Candle flames', buildCandlesPanel, {
    zone: 'workshop',
    effect: 'candleFlame',
    order: 10,
  });

  // ---------------------------------------------------------------------------
  // THE LIGHTNING WORKSHOP PANEL — same FOH/ROH card template the candles
  // panel above uses. `extra` here is a bolt endpoint, not a whole bolt: one
  // click places `role:'start'`, the next places `role:'end'` on the same
  // link id (boot.js's own addLightningEndpoint, above) — ui/anchor-mode.js
  // itself knows nothing about roles/links, only "place a point".
  // ---------------------------------------------------------------------------

  /** The lightning anchor kind's own per-instance params (scene/anchor-
   * catalog.js) — role/linkId/intensity the edit popup can show or patch. */
  const LIGHTNING_ANCHOR_PARAMS = anchorKindById('lightning')?.params ?? {};

  /** Build the per-endpoint edit form (ui/anchor-mode.js's popup content).
   * `role`/`linkId` are shown read-only (structural — set once at placement,
   * never hand-edited); `intensity` and `enabled` (`Lit`) are the two
   * genuinely tunable fields per endpoint. */
  function buildLightningEditForm(anchor, targetIds = [anchor.id]) {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '5px' });
    const patch = (fields) => {
      for (const id of targetIds) updateLightningAnchor(id, fields);
    };

    const roleLine = document.createElement('div');
    Object.assign(roleLine.style, { fontSize: '10px', opacity: '0.75' });
    const role = anchor.params?.role;
    roleLine.textContent =
      role === 'start'
        ? '⚡ Bolt start'
        : role === 'end'
          ? '⚡ Bolt end (impact point)'
          : '⚡ Bolt waypoint (imported from a V2 wandering line — not yet used)';
    wrap.append(roleLine);

    wrap.append(
      buildParamControl('intensity', LIGHTNING_ANCHOR_PARAMS.intensity, {
        value: anchor.params?.intensity ?? 1,
        onChange: (v) => patch({ params: { intensity: v } }),
      })
    );

    wrap.append(
      buildParamControl(
        'enabled',
        {
          type: 'bool',
          label: 'Lit',
          help: 'Turn this ONE endpoint off without deleting it. A bolt needs both ends enabled to strike — disabling either one silences the whole bolt.',
        },
        { value: anchor.enabled !== false, onChange: (v) => patch({ enabled: v }) }
      )
    );

    return wrap;
  }

  function buildLightningPanel({ attachments } = {}) {
    const schema = LIGHTNING_PARAMS;
    const getValue = (id) => {
      const v = lightningReadout.params?.[id];
      return v !== undefined ? v : schema[id]?.default;
    };
    const onChange = (id, value) => MapShine.setLightning({ [id]: value });

    const enterLightningPlacement = () => {
      const result = MapShine.__anchorMode.enter({
        kindLabel: 'lightning bolt',
        icon: anchorKindById('lightning')?.icon,
        listAnchors: () => anchorAuthority.anchorsForEffect('lightning', activeFloorContext),
        addAnchor: (wx, wy) => addLightningEndpoint(wx, wy),
        updateAnchor: (id, patch) => updateLightningAnchor(id, patch),
        removeAnchor: (id) => removeLightningAnchor(id),
        buildEditForm: buildLightningEditForm,
      });
      if (!result?.ok) log.error('could not enter lightning placement mode:', result?.reason);
    };

    return buildEffectCard({
      id: 'lightning',
      diagnostics: attachments,
      icon: '⚡',
      title: 'Lightning',
      subtitle: 'add & tune',
      status: () =>
        collapsedStatusLine({
          enabled: lightningReadout.enabled,
          count: anchorAuthority.anchorsForEffect('lightning', activeFloorContext).length,
          noun: 'endpoint',
        }),
      schema,
      fohKeys: ['outerColor', 'brightness', 'maxDelayMs', 'burstMaxStrikes', 'outsideFlashGain', 'originFlashEnabled'],
      getValue,
      onChange,
      enabled: lightningReadout.enabled,
      onToggleEnabled: (next) => MapShine.setLightning({ enabled: next }),
      add: {
        label: '➕ Place',
        title:
          'Click the map to drop the bolt’s start, then click again for its end. Click an existing ⚡ to edit or remove it.',
        onAdd: enterLightningPlacement,
      },
    });
  }

  MapShine.debug.registerPanel('lightning-panel', 'Lightning', buildLightningPanel, {
    zone: 'workshop',
    effect: 'lightning',
    order: 11,
  });

  // VEGETATION'S OWN FOH/ROH CARD (2026-07-23, same day as Tier 2's shadow +
  // expressive-wind work, author follow-up: "I need you to add the FOH and
  // ROH controls for this into the UI... the more controls the better").
  // Unlike candles, vegetation is NOT anchor-driven — its "instances" are
  // discovered mask/tile matches, not placed points — so this card is just
  // the schema-driven card, no place/edit button, no per-floor count.
  function buildVegetationPanel({ attachments } = {}) {
    const schema = VEGETATION_PARAMS;
    const getValue = (id) => {
      const v = vegetationReadout.params?.[id];
      return v !== undefined ? v : schema[id]?.default;
    };
    const onChange = (id, value) => MapShine.setVegetation({ [id]: value });

    return buildEffectCard({
      id: 'vegetation',
      diagnostics: attachments,
      icon: '🌿',
      title: 'Vegetation',
      subtitle: 'trees & bushes',
      status: () => collapsedStatusLine({ enabled: vegetationReadout.enabled }),
      schema,
      // The plain-language strip (Effects-UI.md §3.2, ≤6) — everything else
      // (frequency/curve/gale-gain/clump spread) lives behind Advanced, per
      // the author's own explicit "the more controls the better" ask.
      fohKeys: ['intensity', 'windResponse', 'swayAmount', 'flutterAmount', 'shadowStrength'],
      getValue,
      onChange,
      enabled: vegetationReadout.enabled,
      onToggleEnabled: (next) => MapShine.setVegetation({ enabled: next }),
      add: paintAffordance('vegetation'),
    });
  }

  MapShine.debug.registerPanel('vegetation-panel', 'Vegetation', buildVegetationPanel, {
    zone: 'workshop',
    effect: 'vegetation',
    order: 20,
  });

  // BLOOM — the schema-driven card + a named-preset picker. Whole-image screen
  // effect, so (like vegetation) no place/edit button; the `extra` is the preset
  // dropdown, which writes a full bloomPreset() through MapShine.setBloom.
  function buildBloomPanel({ attachments } = {}) {
    const schema = BLOOM_PARAMS;
    const getValue = (id) => {
      const v = bloomReadout.params?.[id];
      return v !== undefined ? v : schema[id]?.default;
    };
    const onChange = (id, value) => MapShine.setBloom({ [id]: value });

    // Named-preset picker (docs/planning/Bloom.md) — applies a full preset as a
    // live override, then refreshes the card so the sliders show the new values.
    const presetSelect = document.createElement('select');
    presetSelect.className = 'msa-effect-preset-select';
    presetSelect.title = 'Apply a named bloom preset';
    const prettify = (n) => n.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Preset…';
    presetSelect.appendChild(placeholder);
    for (const name of Object.keys(BLOOM_PRESETS)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = prettify(name);
      presetSelect.appendChild(opt);
    }
    presetSelect.addEventListener('change', () => {
      const name = presetSelect.value;
      presetSelect.value = '';
      if (!name) return;
      MapShine.setBloom(bloomPreset(name));
      MapShine.debug?.refreshControls?.();
    });

    return buildEffectCard({
      id: 'bloom',
      diagnostics: attachments,
      icon: '🌸',
      title: 'Bloom',
      subtitle: 'glow & atmosphere',
      status: () => collapsedStatusLine({ enabled: bloomReadout.enabled }),
      schema,
      // The plain-language strip (Effects-UI.md §3.2, ≤6) — knee, spreads, core
      // tint, and the outdoor-spill floor/ceiling live behind Advanced.
      fohKeys: ['strength', 'threshold', 'coreStrength', 'atmoStrength', 'atmoTint', 'atmoSpread'],
      getValue,
      onChange,
      enabled: bloomReadout.enabled,
      onToggleEnabled: (next) => MapShine.setBloom({ enabled: next }),
      extra: [presetSelect],
    });
  }

  MapShine.debug.registerPanel('bloom-panel', 'Bloom', buildBloomPanel, {
    zone: 'workshop',
    effect: 'bloom',
    order: 80,
  });

  // SUN SHADOWS — the schema-driven card. No preset picker and no place/edit
  // button: it is a whole-scene physical system, not an authored instance, and
  // its only "presets" would be the height of a building, which is one slider.
  //
  // The DEBUG VIEW dropdown lives under Advanced (Technical) because it is
  // diagnostic, not aesthetic — and it is deliberately ONE dropdown rather than
  // the three isolation toggles it replaced on 2026-07-26. Seeing one shadow at
  // a time is the whole request ("allowing me to see just a single shadow at a
  // time out of the whole system"), so a control that can only show one IS the
  // right shape here; three bools that could be set to any of eight
  // combinations was the wrong one (feedback_debug_ui_one_action_one_control).
  function buildSunShadowsPanel({ attachments } = {}) {
    const schema = SUN_SHADOW_PARAMS;
    const getValue = (id) => {
      const v = sunShadowReadout.params?.[id];
      return v !== undefined ? v : schema[id]?.default;
    };
    return buildEffectCard({
      id: 'sunShadows',
      diagnostics: attachments,
      icon: '☀️',
      title: 'Sun shadows',
      subtitle: 'buildings · overhead · sky-reach',
      status: () => collapsedStatusLine({ enabled: sunShadowReadout.enabled }),
      schema,
      fohKeys: ['strength01', 'dawnDuskLength', 'lengthScale', 'buildingHeightPx'],
      getValue,
      onChange: (id, value) => MapShine.setSunShadows({ [id]: value }),
      enabled: sunShadowReadout.enabled,
      onToggleEnabled: (next) => MapShine.setSunShadows({ enabled: next }),
    });
  }

  MapShine.debug.registerPanel('sun-shadows-panel', 'Sun shadows', buildSunShadowsPanel, {
    zone: 'workshop',
    effect: 'sunShadows',
    order: 70,
  });

  // WATER (docs/planning/Water.md §9) — the cascade layer, live override,
  // console setter and card all live in effects/water/water-registration.js;
  // see its header for why this one is a module while the other four effects
  // still inline the identical block.
  MapShine.setWater = water.setWater;
  MapShine.setFluid = fluid.setFluid;
  MapShine.debug.registerPanel(
    'water-panel',
    'Water',
    ({ attachments }) => {
      const readout = water.getReadout();
      return buildEffectCard({
        id: 'water',
        diagnostics: attachments,
        icon: '🌊',
        title: 'Water',
        subtitle: 'tiers 0–3 — placement · volume · motion · light',
        status: () => collapsedStatusLine({ enabled: readout.enabled }),
        schema: WATER_PARAMS,
        // FOH is a strict, SMALL subset, never the whole schema
        // (feedback_foh_roh_must_differ). These three are the mid-session
        // questions: what colour, how much shows through, how fast it hides
        // the bed. The other three are ROH — `shorelineDepth`'s minimum
        // visibly breaks the edge, and the wet-margin pair is set-once detail.
        fohKeys: ['tint', 'opacity', 'absorption', 'foam'],
        getValue: (id) => readout.params?.[id] ?? WATER_PARAMS[id]?.default,
        onChange: (id, value) => MapShine.setWater({ [id]: value }),
        enabled: readout.enabled,
        onToggleEnabled: (next) => MapShine.setWater({ enabled: next }),
        add: paintAffordance('water'),
      });
    },
    { zone: 'workshop', effect: 'water', order: 30 }
  );

  // FLUID (docs/planning/Fluid.md) — goo in glass tubes.
  MapShine.debug.registerPanel(
    'fluid-panel',
    'Fluid',
    ({ attachments }) => {
      const readout = fluid.getReadout();
      return buildEffectCard({
        id: 'fluid',
        diagnostics: attachments,
        icon: '🧪',
        title: 'Fluid',
        subtitle: 'tiers 0–5 — placement · tube · flow · film · fill · structure',
        status: () => collapsedStatusLine({ enabled: readout.enabled }),
        schema: FLUID_PARAMS,
        // FOH is a strict, SMALL subset (feedback_foh_roh_must_differ). The
        // test is "would they change it mid-session, or only while tuning?" —
        // colour, brightness and speed are things a GM reaches for while
        // players are watching; overall strength and how marbled the goo
        // looks are set-once tuning and stay rear-of-house. `slugCount`/
        // `slugWidth` are GONE (fluid.js's own comment on `flowSpeed`
        // explains why), not merely demoted to ROH.
        fohKeys: ['tint', 'glow', 'flowSpeed', 'iridescence'],
        getValue: (id) => readout.params?.[id] ?? FLUID_PARAMS[id]?.default,
        onChange: (id, value) => MapShine.setFluid({ [id]: value }),
        enabled: readout.enabled,
        onToggleEnabled: (next) => MapShine.setFluid({ enabled: next }),
        add: paintAffordance('fluid'),
      });
    },
    { zone: 'workshop', effect: 'fluid', order: 40 }
  );

  // SHINE (docs/planning/Specular.md) — same module shape as water's, for the
  // same reason (`install()` is a frozen god-object; the fifth inlined copy of
  // this block would have pushed it over).
  MapShine.setSpecular = specular.setSpecular;
  /** `MapShine.setSpecularDebug(4)` — the console twin of the picker below. */
  MapShine.setSpecularDebug = specular.setDebugChannel;

  /**
   * THE DEBUG-CHANNEL PICKER — one dropdown that makes the shader say which of
   * its eight multiplicative factors is the zero
   * (`effects/specular/specular.js#SPECULAR_DEBUG_CHANNELS` holds the why and
   * the per-channel reading guide).
   *
   * It sits on the card rather than behind a report because the answer is a
   * PICTURE, not a number: "channel 4 is black" locates the bug in one glance,
   * where a report can only ever tell you what the JS side believes. The
   * channels walk the product left to right — the first BLACK one is the
   * culprit — so this is a ladder to descend, not a menu to browse.
   *
   * Same `msa-effect-preset-select` idiom as the grade card's preset picker,
   * and it does NOT reset itself after a change the way that one does: a
   * diagnostic you are reading has to stay selected while you look at it.
   * @returns {HTMLSelectElement}
   */
  function buildSpecularDebugSelect() {
    const select = document.createElement('select');
    select.className = 'msa-effect-preset-select';
    select.title = 'Show one shader intermediate instead of the effect — the first BLACK channel is the culprit';
    for (const ch of SPECULAR_DEBUG_CHANNELS) {
      const opt = document.createElement('option');
      opt.value = String(ch.n);
      opt.textContent = ch.label;
      // The reading guide, on hover — so "what does black here mean" is
      // answered where the author is looking, not in a doc they would have to
      // go and find mid-investigation.
      opt.title = ch.reads;
      select.appendChild(opt);
    }
    select.value = String(specular.getDebugChannel());
    select.addEventListener('change', () => {
      MapShine.setSpecularDebug(Number(select.value));
    });
    return select;
  }

  MapShine.debug.registerPanel(
    'specular-panel',
    'Metal & shine',
    ({ attachments }) => {
      const readout = specular.getReadout();
      return buildEffectCard({
        id: 'specular',
        diagnostics: attachments,
        icon: '✨',
        title: 'Metal & shine',
        subtitle: 'an animated shimmer field · per-object parallax',
        status: () => collapsedStatusLine({ enabled: readout.enabled }),
        schema: SPECULAR_PARAMS,
        // FOH is a strict, SMALL subset, never the whole schema
        // (feedback_foh_roh_must_differ). The test is "would a GM change this
        // mid-session, or only while tuning?", and these five are chosen
        // against the question an author actually arrives with — "why does the
        // metal not read?", asked four times running.
        //
        // `strength` (is it on at all) and `shimmerContrast` (is it moving)
        // answer that directly. `parallax` is the one control that decides
        // whether the shine reads as a REFLECTION or as paint, which is the
        // difference the whole effect exists for. `unlit shine` is the fix for
        // a dark room whose treasure has vanished. `per-object variety` is
        // here because it is the newest capability and the one an author will
        // want to feel out immediately.
        //
        // `patternSize`, `metalColour`, `driftSpeed`, `breathing` and
        // `sunDirection` are set-once look decisions — ROH. The three per-layer
        // strips are further back still, behind Advanced: they are where a
        // surface gets DESIGNED, not where a session gets adjusted.
        fohKeys: ['strength', 'shimmerGain', 'parallaxStrength', 'islandSpread', 'lightFloor'],
        getValue: (id) => readout.params?.[id] ?? SPECULAR_PARAMS[id]?.default,
        onChange: (id, value) => MapShine.setSpecular({ [id]: value }),
        enabled: readout.enabled,
        onToggleEnabled: (next) => MapShine.setSpecular({ enabled: next }),
        add: paintAffordance('specular'),
        extra: [buildSpecularDebugSelect()],
      });
    },
    { zone: 'workshop', effect: 'specular', order: 50 }
  );

  // ⚠️🔬 THE CROSS-FLOOR MASK STACK PROBE — see the `MapShine.probeMasks`
  // comment near the other probes for the full commission. Registered HERE
  // rather than at module scope because `maskAuthority` is an `install()`-local
  // `const`; touching it from module scope is a TDZ ReferenceError at import.
  MapShine.probeMasks = (worldX, worldY) => maskAuthority.probeStackAt(worldX, worldY);
  MapShine.armMaskProbe = async (maxPoints = 3) => {
    const points = await MapShine.armPixelProbe(maxPoints);
    // Merged, not returned side by side: the whole point is reading the
    // RENDERED pixel and the MASKS that should explain it on the same row.
    return (points ?? []).map((p) => ({
      ...p,
      maskStack: Number.isFinite(p?.worldX) ? maskAuthority.probeStackAt(p.worldX, p.worldY) : null,
    }));
  };
  // ⚠️ `registerAction`, NEVER `registerReport` — this ARMS A CLICK CAPTURE and
  // blocks on the author clicking, which is the exact split `debug-panel.js`
  // documents with teeth: reports are PURE readouts the flight recorder
  // auto-runs on one "export everything" click, actions are side-effecting and
  // never exported. Registered as a report first (2026-08-02) and it did not
  // work at all — the same shape as the ten fake "reports" that would have
  // restarted the author's scene before that split existed. Precedent one
  // screen down: `specular-channel-probe`, which is click-driven the same way.
  MapShine.debug.registerAction('mask-stack-probe', '🔬🏢 Mask stack probe (click 3 pts)', async () => ({
    report: 'mask-stack',
    generatedAt: new Date().toISOString(),
    points: await MapShine.armMaskProbe(3),
    interpretation:
      'One row per FLOOR per point. `masks.<kind>.sources` replays the composite in draw order: each source`s ' +
      '`rawByte` (what it paints) and `alphaByte` (whether it paints at all here) with the running `before`→`after`, ' +
      'so the source that actually decided the pixel is the row where `changed` is true LAST. ⚠️ `hosts` is the ' +
      'other half: an item listed there for a floor it does not belong to is a HOSTING bug (check its ' +
      '`levelsRestricted`/`elevation` against the floor`s own band) — that is exactly how a ground-floor prop ended ' +
      'up defining the roof`s walls. `compositedByte` vs `replayedByte` are computed INDEPENDENTLY; if they ' +
      'disagree the rasterizer diverged from its own sources. `layerSmear` restates the same numbers in the ' +
      'shader`s vocabulary so this and the sun-shadows report`s `channelStats` compare term for term.',
  }));

  // The two "why is this effect not showing" report BODIES live in
  // diag/effect-status-reports.js (see its header); registration stays here so
  // the id/title list is visible where someone looks for "what reports exist".
  MapShine.debug.registerReport(
    'sun-shadows',
    'Sun shadows (building · overhead · sky-reach)',
    () => {
      const floorIndex = activeFloorContext?.floorIndex ?? 0;
      return buildSunShadowsReport({
        floorIndex,
        status: skyReachAccess.status(floorIndex),
        viewer: getVtPanViewerDiagnostics?.() ?? null,
        readout: sunShadowReadout,
        degradedFloors: sunShadowDegradedFloors,
        generatedAt: new Date().toISOString(),
      });
    },
    { effect: 'sunShadows' }
  );

  MapShine.debug.registerReport(
    'specular',
    'Metal & shine (why is it not visible?)',
    () =>
      buildSpecularReport({
        floorIndex: activeFloorContext?.floorIndex ?? 0,
        viewer: getVtPanViewerDiagnostics?.() ?? null,
        maskAuthority,
        readout: specular.getReadout(),
        generatedAt: new Date().toISOString(),
      }),
    { effect: 'specular' }
  );

  // WINDOW LIGHT (docs/planning/Windows.md) — same module shape as specular's,
  // for the same reason.
  MapShine.setWindowLight = windowLight.setWindowLight;
  /** `MapShine.setWindowLightDebug(4)` — the console twin of the picker below. */
  MapShine.setWindowLightDebug = windowLight.setDebugChannel;

  /**
   * THE DEBUG-CHANNEL PICKER — same idiom as SHINE's own picker just above
   * (`effects/window/window.js#WINDOW_DEBUG_CHANNELS` holds the why and the
   * per-channel reading guide). This effect family has shipped invisible
   * three times already in this codebase with every other test green, so the
   * instrument ships alongside tier 0 rather than after the first live
   * "why is it not visible" report.
   * @returns {HTMLSelectElement}
   */
  function buildWindowLightDebugSelect() {
    const select = document.createElement('select');
    select.className = 'msa-effect-preset-select';
    select.title = 'Show one shader intermediate instead of the effect — the first BLACK channel is the culprit';
    for (const ch of WINDOW_DEBUG_CHANNELS) {
      const opt = document.createElement('option');
      opt.value = String(ch.n);
      opt.textContent = ch.label;
      opt.title = ch.reads;
      select.appendChild(opt);
    }
    select.value = String(windowLight.getDebugChannel());
    select.addEventListener('change', () => {
      MapShine.setWindowLightDebug(Number(select.value));
    });
    return select;
  }

  MapShine.debug.registerPanel(
    'window-light-panel',
    'Window light',
    ({ attachments }) => {
      const readout = windowLight.getReadout();
      return buildEffectCard({
        id: 'window',
        diagnostics: attachments,
        icon: '🪟',
        title: 'Window light',
        subtitle: 'the painted mask, read as light — no aperture, no time of day yet',
        status: () => collapsedStatusLine({ enabled: readout.enabled }),
        schema: WINDOW_PARAMS,
        // Both controls are FOH — the schema is small enough that there is no
        // ROH tier yet (feedback_foh_roh_must_differ still applies: this is
        // "the whole thing", not "the important half").
        fohKeys: ['strength', 'contrast'],
        getValue: (id) => readout.params?.[id] ?? WINDOW_PARAMS[id]?.default,
        onChange: (id, value) => MapShine.setWindowLight({ [id]: value }),
        enabled: readout.enabled,
        onToggleEnabled: (next) => MapShine.setWindowLight({ enabled: next }),
        add: paintAffordance('window'),
        extra: [buildWindowLightDebugSelect()],
      });
    },
    { zone: 'workshop', effect: 'window', order: 60 }
  );

  MapShine.debug.registerReport(
    'window-light',
    'Window light (why is it not visible?)',
    () =>
      buildWindowLightReport({
        floorIndex: activeFloorContext?.floorIndex ?? 0,
        viewer: getVtPanViewerDiagnostics?.() ?? null,
        maskAuthority,
        readout: windowLight.getReadout(),
        generatedAt: new Date().toISOString(),
      }),
    { effect: 'window' }
  );

  MapShine.debug.registerReport(
    'water-body',
    'Water body pack (SDF · depth · tangent)',
    () =>
      buildWaterBodyReport({
        floorIndex: activeFloorContext?.floorIndex ?? 0,
        viewer: getVtPanViewerDiagnostics?.() ?? null,
        maskAuthority,
        generatedAt: new Date().toISOString(),
      }),
    { effect: 'water' }
  );

  // THE PERFORMANCE PROFILE (docs/planning/Performance.md).
  //
  // A registerReport, NOT a registerAction, and that distinction is load-bearing:
  // the flight recorder runs every registered REPORT on a single export click
  // (diag/debug-panel.js's own contract note). So this reads the last completed
  // profile and nothing else — arming the profiler is a separate action, or every
  // flight export would silently start a measurement run.
  //
  // Until the profiler lands this answers "not armed" and reports the taxonomy's
  // own health, which is genuinely worth a click: it is where you find out that a
  // zone points at a pass that was renamed.
  // ⚠️ NAMED "last result" ON PURPOSE (2026-07-28). This READ-ONLY report and the
  // 🔬 Profile ACTION that produces its data sat next to each other with nearly
  // identical names, and the author clicked this one twice expecting a run —
  // getting two `status:'not-armed'` payloads with `frames: 0` that look exactly
  // like a real report at a glance. Two controls one letter apart in meaning is
  // an instrument defect, not a user error (memory:
  // feedback_never_blame_the_authors_technique). The label now says which one
  // MEASURES and which one only re-reads.
  MapShine.debug.registerReport('perf-profile', '📄 Performance: last result (read-only)', () => {
    const byStage = {};
    for (const zone of ZONES) byStage[zone.stage] = (byStage[zone.stage] ?? 0) + 1;
    // A completed run wins. This is a PURE readout of it — re-reading costs
    // nothing and never re-measures, which is what lets the flight recorder
    // include the last profile in a bundle without arming anything.
    if (lastPerfProfile) return { ...lastPerfProfile, status: 'complete' };
    const viewer = getVtPanViewerDiagnostics?.() ?? null;
    const generatedAt = new Date().toISOString();
    // ONE SHAPE, ALWAYS. Unarmed, this is a real report whose every measurement
    // field is null — not a different, smaller object. A reader learns the layout
    // before their first run, and the null-vs-zero discipline is visible in the
    // one state where every field is honestly absent.
    const base = buildPerfReport({
      generatedAt,
      msaVersion: MapShine.version,
      zones: ZONES,
      effectZoning: EFFECT_ZONING,
      manifests: [],
      budgetMs: FRAME_BUDGET_MS,
    });
    return {
      ...base,
      status: 'not-armed',
      built: {
        zoneTaxonomy: true,
        reportBrain: true,
        cpuZoneProfiler: true,
        gpuZoneTimer: true,
        liveHud: true,
        benchmarkRoute: true,
        vramInventory: 'partial — the render-target registry is not wired, so only the atlas estimate is real',
      },
      taxonomy: {
        zoneCount: ZONES.length,
        byStage,
        frameBudgetMs: FRAME_BUDGET_MS,
        passBudgetsMs: PASS_BUDGETS_MS,
        // Cross-checked against the LIVE pass graph and effect ids in the Node
        // suite; re-run here so a live session sees drift the tests cannot
        // (a pass that only goes live at runtime, for instance).
        selfCheck: {
          zones: validateZoneTaxonomy(ZONES, {}),
          effectZoning: validateEffectZoning(EFFECT_ZONING, ZONES),
        },
      },
      // Real today: the atlas estimate is the one number that matters against the
      // measured device-loss wall, and it comes from the viewer's own per-format
      // mip-chain accounting rather than three's (which counts a compressed
      // texture as ONE BYTE — see diag/vram-inventory.js).
      vram: buildVramInventory({ vtEstimate: viewer, ceilingMb: 2500 }),
      interpretation:
        '⚠️ NOTHING HAS BEEN MEASURED. This is the READ-ONLY report; it only ever shows the last completed run, ' +
        'and there has not been one this session. It does not and cannot start a measurement. ' +
        'To actually profile, click one of the ACTIONS: "🔬 Profile (per-zone)" for a 10-second window, or ' +
        '"🏁 Benchmark: N→S map sweep (60s)" for the repeatable stress route. Then click THIS report to re-read ' +
        'the result without re-running it. Every cost field above is null rather than zero — that is the shape a ' +
        'completed run fills in. ' +
        'What IS live and worth reading today: taxonomy.selfCheck must report ok:true for BOTH entries (a false means ' +
        'a zone points at a pass or effect that no longer exists, and the profile it eventually produces would carry ' +
        'a row nobody can act on), and vram gives the honest atlas estimate against the measured ~2.5GB device-loss ' +
        "ceiling — honest because it comes from the viewer's own per-format mip-chain accounting, not three's, which " +
        'counts a compressed texture as ONE BYTE. See docs/planning/Performance.md for what remains. ' +
        base.interpretation,
    };
  });

  // FLUID — the whole chain, link by link. Click this FIRST when the tubes
  // are empty: the first line that reads zero names the break.
  MapShine.debug.registerReport(
    'fluid',
    'Fluid (tube net · pack · meshes)',
    () => {
      // A PROPERTY, not a method call — matching `waterBody`/`specular` exactly.
      // The first version called `.getFluidStatus?.()` on the diagnostics
      // object, but `getVtPanViewerDiagnostics()` never had a method by that
      // name: `getFluidStatus` lives on `_active` (vt-pan-viewer.js), and only
      // `vt-pan-viewer-diagnostics.js`'s `buildViewerDiagnostics` (which holds
      // `_active`) can reach it — the diagnostics object it RETURNS exposes the
      // result as a plain field, `fluid`. This surface read `surface: null`
      // through an entire live test while the tubes rendered correctly.
      const status = getVtPanViewerDiagnostics?.()?.fluid ?? null;
      const items = coverItems ?? [];
      // Counted HERE rather than inside the subsystem, because the subsystem only
      // ever sees items the SEAM already matched — so if the seam is the broken
      // link, only a count taken OUTSIDE it can say so. That is exactly the link
      // that was broken (a floor-keyed mask lookup cannot see a tile's file).
      const authored = items.filter((it) => maskAuthority.authoredStatusForItem(it.id, 'fluid').source === 'authored');
      return {
        generatedAt: new Date().toISOString(),
        floorIndex: activeFloorContext?.floorIndex ?? 0,
        enabled: fluid.getReadout().enabled,
        // STEP 1 — DISCOVERY. Zero here means no file was FOUND at all: check the
        // suffix spelling and that the mask sits beside the art it belongs to.
        itemsInScene: items.length,
        itemsWithAuthoredFluidMask: authored.length,
        authoredItems: authored.map((it) => ({ id: it.id, kind: it.kind, levelId: it.levelId ?? null })),
        // STEP 2+ — the seam, the bake, the meshes. `maskedItemCount` at 0 while
        // `itemsWithAuthoredFluidMask` is above 0 means the FLOOR FILTER rejected
        // them (a tile not marked visible on this level), not the mask.
        surface: status,
        params: fluid.getReadout().params,
      };
    },
    { effect: 'fluid' }
  );

  // COLOUR GRADE (the god CC, docs/planning/Grade.md §14) — the same schema-
  // driven card as bloom, with a named-preset picker. The artistic "Look" grade:
  // exposure/white-balance/contrast/saturation/vibrance/split-tone + a filmic
  // tone-map curve (AgX default). Whole-image, so no place/edit button.
  function buildGradePanel({ attachments } = {}) {
    const schema = GRADE_LOOK_PARAMS;
    const getValue = (id) => {
      const v = gradeLookReadout.params?.[id];
      return v !== undefined ? v : schema[id]?.default;
    };
    const onChange = (id, value) => MapShine.setGrade({ [id]: value });

    const presetSelect = document.createElement('select');
    presetSelect.className = 'msa-effect-preset-select';
    presetSelect.title = 'Apply a named colour-grade preset';
    const prettify = (n) => n.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Preset…';
    presetSelect.appendChild(placeholder);
    for (const name of Object.keys(GRADE_PRESETS)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = prettify(name);
      presetSelect.appendChild(opt);
    }
    presetSelect.addEventListener('change', () => {
      const name = presetSelect.value;
      presetSelect.value = '';
      if (!name) return;
      MapShine.setGrade(gradePreset(name));
      MapShine.debug?.refreshControls?.();
    });

    return buildEffectCard({
      id: 'grade',
      diagnostics: attachments,
      icon: '🎞️',
      title: 'Colour Grade',
      subtitle: 'the look — exposure, colour, film response',
      status: () => collapsedStatusLine({ enabled: gradeLookReadout.enabled }),
      schema,
      // The plain strip: the master mood knobs + the film curve. Tint, split-tone
      // and (later) the LUT live behind Advanced.
      fohKeys: ['exposure', 'contrast', 'saturation', 'temperature', 'vibrance', 'toneMapping'],
      getValue,
      onChange,
      enabled: gradeLookReadout.enabled,
      onToggleEnabled: (next) => MapShine.setGrade({ enabled: next }),
      extra: [presetSelect],
    });
  }

  MapShine.debug.registerPanel('grade-panel', 'Colour Grade', buildGradePanel, {
    zone: 'workshop',
    effect: 'grade',
    order: 90,
  });

  // THE WIND FIELD DEBUG OVERLAY (2026-07-21, docs/planning/Wind.md Tier 0 —
  // "a way to visualise the field early on"). A live grid of arrows sampling
  // the EXACT SAME `sampleWind()` the candle flame/light now both read (see
  // world/wind-field.js's own header for the two-winds bug this whole Tier
  // fixes) — proof, on screen, that the field really is shared. Off by
  // default; a plain toggle action, same idiom as live-markers-toggle above.
  let windOverlayArmed = false;

  MapShine.debug.registerAction(
    'wind-overlay-toggle',
    '🌬️ Wind field overlay: toggle',
    () => {
      windOverlayArmed = !windOverlayArmed;
      const result = setVtPanViewerWindOverlay(windOverlayArmed);
      if (result?.skipped) windOverlayArmed = false;
      return { armed: windOverlayArmed, ...result };
    },
    { effect: 'wind' }
  );

  // WIND DIAGNOSTIC PARTICLES (2026-07-22, author: "these aren't dust motes,
  // they're wind diagnostic particles... this should be an optional
  // debugging visualisation"). A mote cloud riding the SAME wind field the
  // arrow overlay above visualises — companion tool, same idiom (off by
  // default, a plain toggle action). Renamed from the old always-on "ambient
  // dust" (particles/dust.js -> particles/wind-diagnostic-particles.js);
  // real dust-as-atmosphere is a separate, later feature reusing this engine.
  let windParticlesArmed = false;

  MapShine.debug.registerAction(
    'wind-particles-toggle',
    '🌬️ Wind diagnostic particles: toggle',
    () => {
      windParticlesArmed = !windParticlesArmed;
      const result = setVtPanViewerWindDiagnosticParticles(windParticlesArmed);
      if (result?.skipped) windParticlesArmed = false;
      return { armed: windParticlesArmed, ...result };
    },
    { effect: 'wind' }
  );

  // WIND GUSTS (2026-07-22, author request) — a SEPARATE atmospheric effect from
  // the diagnostic cloud above: a few ribbon-trail "wind snakes" that whoosh
  // through the windiest parts of the map (funnels + open gales), more and
  // stronger as the wind rises. Off by default, plain toggle, same idiom.
  let windGustsArmed = false;

  MapShine.debug.registerAction(
    'wind-gusts-toggle',
    '🌬️💨 Wind gusts: toggle',
    () => {
      windGustsArmed = !windGustsArmed;
      const result = setVtPanViewerWindGusts(windGustsArmed);
      if (result?.skipped) windGustsArmed = false;
      return { armed: windGustsArmed, ...result };
    },
    { effect: 'wind' }
  );

  // OVERLAY DENSITY. ⚠️ RELABELLED 2026-07-27, because the label described a job
  // this control no longer has. It began as a preview of Wind.md §8's real
  // `fieldResolution` knob ("try higher resolution grids, up to x4"), but
  // vt-pan-viewer.js's own comment records it as REPURPOSED: it is now a STRIDE
  // over the real bake grid, i.e. how many arrows to skip so a dense field stays
  // readable. Same control, opposite meaning — "4× stress test" actually draws
  // FEWER arrows. A control whose label describes its old job is a lying
  // instrument (feedback_instruments_must_not_lie), so the text follows the code.
  let windOverlayResolutionValue = '1';
  MapShine.debug.registerSelect(
    'wind-overlay-resolution',
    '🌬️ Overlay density',
    [
      { value: '1', label: 'Every cell (exact)' },
      { value: '2', label: 'Every 2nd' },
      { value: '3', label: 'Every 3rd' },
      { value: '4', label: 'Every 4th (least clutter)' },
    ],
    () => windOverlayResolutionValue,
    (value) => {
      windOverlayResolutionValue = value;
      setVtPanViewerWindOverlayResolution(Number(value));
    },
    { effect: 'wind' }
  );

  // ══════════════════════════════════════════════════════════════════════
  // THE ASTROLABE (2026-07-23) — the Bridge's hero dial, Control-Panel.md §4.1.
  // ══════════════════════════════════════════════════════════════════════
  //
  // REPLACES, not supplements: the two ambient-wind SELECTS that used to live
  // here (`wind-ambient-direction`, 8 compass values; `wind-ambient-speed`, 4
  // tiers) are DELETED. The dial drives the exact same door they did
  // (`setVtPanViewerWindAmbient`, which also triggers the structure rebake), so
  // this is a control swap, not a rewiring — and leaving the dropdowns in place
  // beside it would be two controls for one value, which is how a params
  // blackboard with 938 keys begins.
  //
  // The dial is a VIEW: it holds no time and no wind of its own. Gestures call
  // the engine; the per-frame `update()` mirrors whatever the engine says back.
  // A dial that cached the hour would be a mirror, and mirrors are what
  // Environment.md §2.4 is about.
  let astrolabe = null;
  let windDirectionDeg = 0;
  let windSpeed01 = 0;
  /** Unsubscribe for the scene-sky watcher (a second GM's edit reaching here). */
  let skyUnsub = null;
  void skyUnsub; // held for a future teardown path; the watcher lives for the session
  const applyAmbientWind = () => setVtPanViewerWindAmbient(windDirectionDeg, windSpeed01);

  /** Compass point for the collapsed Wind card's status line. Wind direction is
   * conventionally named for where it blows TOWARDS here, matching the dial's
   * own arrow. */
  const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const compassOf = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

  // THE WIND CARD (2026-07-27) — wind's ONE home in the Make zone.
  //
  // Wind was living in four places at once: the astrolabe dial (Bridge), six
  // controls loose in Make, three more that had fallen into the Lab because
  // nothing routed them anywhere, and per-effect `windResponse` sliders. The
  // author's note was "wind controls are scattered across the UI". Now there are
  // two, and each has a reason: the ASTROLABE STEERS (direction + strength, live,
  // mid-session) and this card CONFIGURES AND DIAGNOSES (overlays, probes, the
  // bake). The per-effect `windResponse` sliders stay exactly where they are —
  // they belong to the effect that responds, not to wind.
  //
  // An empty schema is deliberate and already supported: `rohGroups({})` returns
  // [] and the FOH loop iterates [], so the card is built entirely from the
  // controls that declared `{ effect: 'wind' }`. Wind has no params of its own —
  // its state is the dial's.
  MapShine.debug.registerPanel(
    'wind-panel',
    'Wind',
    ({ attachments }) =>
      buildEffectCard({
        id: 'wind',
        icon: '🌬️',
        title: 'Wind',
        subtitle: 'steered from the astrolabe; overlays and probes live here',
        status: () =>
          windSpeed01 > 0
            ? `${compassOf(windDirectionDeg)} · ${Math.round(windSpeed01 * 100)}%`
            : 'calm — raise Wind on the astrolabe',
        schema: {},
        fohKeys: [],
        getValue: () => undefined,
        onChange: () => {},
        diagnostics: attachments,
      }),
    { zone: 'workshop', effect: 'wind', order: 25 }
  );

  MapShine.debug.registerPanel(
    'astrolabe',
    '🧭 Astrolabe',
    () => {
      astrolabe = createAstrolabe({
        // The ring's coloured bands ARE the sun model, inverted — never a
        // second, hand-placed copy of when dusk is (world/sun.js's own essay).
        phaseBands: phaseBoundaryHours(),
        // Dragging the ring applies live every pointermove (so the sun tracks
        // the finger) but PERSISTS only on release — a scene-flag write per
        // pointer event would be hundreds of document updates per drag.
        onTimeChange: (hour, committed) => {
          setVtPanViewerSunHour(hour);
          if (committed) void editSky({ todHour: hour });
        },
        onTimeStop: (hour) => {
          sweepVtPanViewerTimeOfDay(hour);
          void editSky({ todHour: hour });
        },
        onTimeRateChange: (rate) => void editSky({ rateHoursPerMinute: rate }),
        onTimeModeChange: (mode) => void editSky({ mode }),
        onWindDirectionChange: (deg, committed) => {
          windDirectionDeg = deg;
          // Direction commits on RELEASE only: `setWindAmbient` re-bakes the
          // whole wall-relaxed structure grid, and firing that per pointermove
          // would rebake a few hundred times per drag.
          if (committed) applyAmbientWind();
        },
        onWindSpeedChange: (v, committed) => {
          windSpeed01 = v;
          if (committed) applyAmbientWind();
        },
        // THE SKY. Every one of these goes through `editSky`, so the astrolabe
        // never decides WHICH scope it is writing to — `applySkyEdit` does, from
        // the one precedence rule. A UI that picked the target itself would be a
        // second copy of that rule, free to disagree with it.
        onCloudChange: (v, committed) => {
          if (committed) void editSky({ cloudCover01: v });
        },
        onSkyRealismChange: (v, committed) => {
          if (committed) void editSky({ realism01: v });
        },
        // THE ENVIRONMENTAL GRADE (docs/planning/Grade.md) — same editSky path
        // as the sky. The ARTISTIC "Look" grade is NOT here any more: it is now
        // a first-class effect with its own Workshop card (below), so it has one
        // home, not two (the astrolabe Look dropdown retired 2026-07-23).
        onGradeEnvChange: (v, committed) => {
          if (committed) void editSky({ gradeEnvStrength: v });
        },
        onSceneOverrideChange: async (enabled) => {
          const result = await setSceneSkyOverride(enabled, skyScope.sky);
          if (!result.ok) log.warn(`scene sky override not changed: ${result.reason}`);
          resolveAndApplySky();
        },
      });
      return astrolabe.root;
    },
    // order:-1 pins the dial above the Bridge's control row no matter when it
    // registers — panel order was Map-insertion order until 2026-07-27.
    { zone: 'bridge', order: -1 }
  );

  // ── THE SKY: per-world by default, per-scene by opt-in ──────────────────
  // Author, 2026-07-23: *"Time of day and weather should be per world by default
  // with an option to make it per scene that you have to enable."*
  //
  // `world/sky-settings.js#resolveSky` owns the precedence (purely, Node-tested)
  // and `foundry/sky-persistence.js` owns the storage. Boot is only the pump
  // between them and the engines — it holds NO sky state of its own, because a
  // third copy is how a value acquires seven homes (Environment.md §0.4).
  let skyScope = { sky: null, source: 'world', sceneOverrides: false };

  /** Push one resolved look block at every engine it drives — sky AND grade,
   * in one place so the resolve path and the edit path can never push different
   * subsets. In `synced` mode the world clock owns the hour and setTimeOfDay is
   * correctly refused; don't fight it or log a "failure" for the mode working. */
  const applyLookToEngines = (sky) => {
    setVtPanViewerTimeMode(sky.mode);
    setVtPanViewerTimeRate(sky.rateHoursPerMinute);
    if (sky.mode === 'aesthetic') setVtPanViewerSunHour(sky.todHour);
    setVtPanViewerCloudCover(sky.cloudCover01, 'sky-settings');
    setVtPanViewerSkyRealism(sky.realism01);
    // THE ENVIRONMENTAL GRADE (docs/planning/Grade.md) — its strength drives the
    // automatic ToD/weather look + cloud desaturation. (The ARTISTIC grade is a
    // separate effect now, resolved through its own cascade, not from here.)
    setVtPanViewerGradeEnvStrength(sky.gradeEnvStrength);
  };

  /** Re-read both stores, decide which wins, and push it at the engines. */
  const resolveAndApplySky = () => {
    const worldRead = readWorldSky();
    const sceneRead = readSceneSky();
    skyScope = resolveSky({
      world: worldRead.sky,
      scene: sceneRead.sky,
      sceneOverrides: sceneRead.sceneOverrides,
    });
    applyLookToEngines(skyScope.sky);
  };

  /** Apply one astrolabe edit to whichever scope is in force, then persist it. */
  const editSky = async (patch) => {
    const { target, sky } = applySkyEdit(
      { world: readWorldSky().sky, scene: readSceneSky().sky, sceneOverrides: skyScope.sceneOverrides },
      patch
    );
    // Apply LOCALLY first so the dial responds at once — the write is async,
    // GM-gated, and may round-trip a socket. A control that waits on a document
    // update before moving reads as broken even when it is working.
    skyScope = { ...skyScope, sky };
    applyLookToEngines(sky);
    const result = target === 'scene' ? await writeSceneSky(sky) : await writeWorldSky(sky);
    if (!result.ok) log.warn(`sky edit not persisted (${target}): ${result.reason}`);
    return result;
  };

  // `watchSceneSky` only calls `Hooks.on('updateScene', ...)` — that never
  // touches `game`, so it is safe to register immediately, unlike the setting
  // below. Left here, beside where the callback it wraps is defined.
  skyUnsub = watchSceneSky(resolveAndApplySky);

  // registerSkySettings → registerSettings → `game.settings.register`, and
  // `game.settings` does not exist until Foundry's `init` hook fires — calling
  // it directly here (at `install()`'s own module-eval time, long before that)
  // crashed on first real load: "Cannot read properties of undefined (reading
  // 'register')". The FIX IS TO REUSE THE EXISTING `Hooks.once('init', ...)`
  // block below (the one that already registers the effect-settings cascade),
  // not to add a second one — `foundry/adapter-only` counts every literal
  // `Hooks.once(...)` in this file against a ratchet that must never grow, and
  // boot.js is explicitly not the adapter (`allow: [foundry/, diag/]`). A
  // SECOND hook registration would be a genuine new violation, caught by the
  // ratchet exactly as it should be; a call added inside the ALREADY-COUNTED
  // hook is a bare function call with no `Hooks.`/`game.`/`canvas.` literal in
  // it, so it costs nothing. See that block, `registerSkySettings(...)`.
  //
  // The FIRST `resolveAndApplySky()` waits one step further, for `canvasReady`
  // (below), because `readSceneSky()` needs `canvas.scene`, which does not exist
  // at `init` either — calling it earlier would silently resolve every scene's
  // sky as "no active scene" until the next unrelated settings change.

  // The dial mirrors the live engines every frame it is visible. Reading back
  // rather than remembering is what keeps the ring honest while time DRIFTS or
  // SWEEPS on its own, and what shows the pause ramp winding down live.
  const pumpAstrolabe = () => {
    // Gated on `isConnected`: the panel builds the dial once and the shell
    // detaches it when another zone is showing, so a closed panel costs one
    // property read per frame, not a repaint.
    if (astrolabe?.root?.isConnected) {
      const dial = getVtPanViewerTimeDialState();
      // `windSpeed01` is the ONE value the dial owns rather than reads back:
      // the wind engine only learns it on commit (a rebake per pointermove
      // would be brutal), so between grab and release the engine genuinely
      // does not know it yet. Everything else mirrors the engine.
      // The sky block rides along from the RESOLVED scope, not from a copy the
      // dial keeps — so the checkbox and the sliders always show the store that
      // is actually in force, including after another GM changes it.
      if (dial) {
        astrolabe.update({
          ...dial,
          windSpeed01,
          cloudCover01: skyScope.sky?.cloudCover01 ?? 0,
          skyRealism01: skyScope.sky?.realism01 ?? 0,
          gradeEnvStrength: skyScope.sky?.gradeEnvStrength ?? 0,
          sceneOverrides: skyScope.sceneOverrides === true,
        });
      }
    }
    requestAnimationFrame(pumpAstrolabe);
  };
  requestAnimationFrame(pumpAstrolabe);
  // A MANUAL rebake — kept as an explicit, immediate-feedback debug action
  // even now that the AUTO path below exists (a GM staring at the report for
  // confirmation shouldn't have to go trigger a document update first).
  MapShine.debug.registerAction(
    'wind-rebake',
    '🌬️ Rebake wind structure',
    () => {
      const result = rebakeVtPanViewerWindField();
      // The note is built by a PURE, Node-tested formatter pinned to the bake's
      // real return shape. It used to be inlined here reading `result.exposure`,
      // a field the Wind rethink deleted — so every click printed a confident,
      // permanent false alarm about the outdoors mask. See describeWindBake.
      return { ...result, note: describeWindBake(result) };
    },
    { effect: 'wind' }
  );

  // AUTO-REBAKE ON WALL/DOOR CHANGE (2026-07-21) — closes Wind.md Tier 1's
  // own recorded follow-up: "NOT yet: createWall/updateWall/deleteWall
  // auto-invalidation (the manual 'Rebake' debug action stands in for now)."
  // A door opening/closing is a WallDocument update (see foundry/scene-
  // walls.js#watchSceneWallStructure's own header for the verified source
  // citation), so this one subscription is what turns "outside wind pushes
  // through an opened door" into a LIVE reaction instead of something that
  // only catches up once a GM remembers to click Rebake.
  //
  // COALESCED, same idiom as vt-pan-viewer.js's onResize (`resizePending` +
  // queueMicrotask): a bulk wall edit (scene import, "align walls") can fire
  // many CRUD hooks in one synchronous tick (client-backend.mjs runs the
  // whole batch's hook callbacks with no `await` between them), so a naive
  // per-hook rebake would re-run the Jacobi relaxation once per document
  // instead of once per BATCH. The microtask fires after that synchronous
  // tick drains, so however many hooks fired, exactly one rebake runs.
  let windRebakePending = false;
  let windRebakeLastHook = null;
  const wallWatch = watchSceneWallStructure((hook) => {
    windRebakeLastHook = hook; // last hook wins the label if several coalesce into one tick
    if (windRebakePending) return;
    windRebakePending = true;
    queueMicrotask(() => {
      windRebakePending = false;
      const result = rebakeVtPanViewerWindField(`wall:${windRebakeLastHook}`);
      if (result && result.ok === false)
        log.error(`auto wind rebake failed after ${windRebakeLastHook}:`, result.error);
    });
  });
  if (!wallWatch.registered) log.warn(`wind auto-rebake not wired — ${wallWatch.reason}`);

  // WIND.MD TIER 2 — THE TRANSIENT SIM (2026-07-21). A door opening fires a
  // real gust, not just Tier 1's slow rebake-and-catch-up. `watchDoorOpenings`
  // is a SEPARATE, narrower subscription from `wallWatch` above (closed->OPEN
  // door transitions only — see foundry/scene-walls.js's own header for why
  // it needs to be its own hook, not folded into the generic wall watcher):
  // Tier 1's rebake answers "what is the new steady state", Tier 2's impulse
  // answers "what does the moment of opening FEEL like" — both fire from the
  // same real event, independently, no coupling between them needed.
  const doorWatch = watchDoorOpenings((wallSegment) => {
    const result = triggerVtPanViewerWindDoorImpulse(wallSegment);
    if (result && result.ok === false && !result.skipped) log.error('door gust impulse failed:', result.reason);
  });
  if (!doorWatch.registered) log.warn(`wind door-gust impulse not wired — ${doorWatch.reason}`);

  // DOOR GRAPHICS' own wall watch — a door opening/closing/moving/being
  // reconfigured is a Wall CRUD event, so re-read the active floor's renderable
  // doors into `doorSnapshots` (which getDoorRenderState hands the viewer by
  // reference). The viewer's door manager then animates any open-state change.
  // A THIRD single-purpose reaction to the same event as wallWatch (wind rebake)
  // and doorWatch (Tier-2 gust) — each small and independent, no coupling.
  const doorGraphicsWatch = watchDoorGraphics(() => {
    try {
      refreshDoors();
    } catch (err) {
      log.error('door graphics refresh (wall change) failed:', err);
    }
  });
  if (!doorGraphicsWatch.registered) log.warn(`door graphics auto-refresh not wired — ${doorGraphicsWatch.reason}`);

  // A debug "test gust" — for verifying Tier 2 looks right WITHOUT needing a
  // real door in a real scene (feedback_instruments_must_not_lie: give the
  // author a way to trigger and SEE the thing being reported, not just trust
  // the log line). Built as a short synthetic wall segment ORIENTED SQUARE TO
  // the CURRENT ambient direction (a wall the wind blows straight at), so the
  // test reliably produces a strong, visible impulse regardless of whichever
  // compass setting is currently dialled in — never a coin-flip on whether
  // the demo shows anything.
  MapShine.debug.registerAction(
    'wind-test-gust',
    '🌬️ Trigger test gust',
    () => {
      const ambient = ambientVectorFromWind({
        // Reads the astrolabe's own live values (2026-07-23) — these used to be
        // the two deleted dropdowns' strings.
        directionDeg: windDirectionDeg,
        speed01: Math.max(0.35, windSpeed01 || 0), // never a silent no-op at Calm
      });
      const mag = Math.hypot(ambient.x, ambient.y) || 1;
      // A wall PERPENDICULAR to the ambient direction — i.e. running along the
      // ambient's own (x,y), so the door in it is square to the flow.
      const ux = ambient.x / mag;
      const uy = ambient.y / mag;
      const halfLen = 80;
      const cx = 0;
      const cy = 0;
      const wallSegment = {
        x1: cx - ux * halfLen,
        y1: cy - uy * halfLen,
        x2: cx + ux * halfLen,
        y2: cy + uy * halfLen,
      };
      return triggerVtPanViewerWindDoorImpulse(wallSegment);
    },
    { effect: 'wind' }
  );

  // ('🌬️ Force sim running' and '🌬️ Wind sim status' were DELETED 2026-07-27.
  // Both existed to MEASURE the Tier-2 sim — one pinned it thawed so its GPU cost
  // could be read, the other printed that state as numbers. The measurement they
  // were built for has happened, and `world/wind-sim.js`'s own ⚠ STALE banner says
  // the field channels the sim advects "now always carry ZERO", so a numeric
  // readout of a subsystem fed zeros is a reading nobody can act on. The test gust
  // survives, because it is the only way to TRIGGER Tier 2 and LOOK at it, which
  // is what that banner asks a future revisit to start with.)

  // (The one-shot "🕯️ Show candle markers" action was DELETED 2026-07-27. It was
  // superseded twice: first by the live marker overlay — the one-shot's own
  // snapshot drifts under pan/zoom, which is why the live version was built —
  // and then by anchor mode, whose real clickable 🕯️ icons ARE the marker. Three
  // ways to see a candle's position, two of them worse, is the clutter this
  // refactor exists to remove.)

  const TORTURE_FLOOR_COUNT = 3;
  const tortureImageUrl = (floorIndex) => `modules/${MODULE_ID}/assets/torture/torture_floor${floorIndex}.png`;

  // MULTI-LAYER (Keyhole §4.1, the mask pile-up killer): the torture fixture
  // emits real mask PNGs on disk (tools/make-torture-world.mjs), so it's where
  // we PROVE the masks page through the same fixed cache as albedo — V2 died of
  // _Fire/_Outdoors/_Specular/_Tree/_Bush all held at world resolution at once,
  // and this streams every one through the keyhole instead. Only albedo
  // displays until a mask is selected (VT Layers: Cycle Displayed Layer).
  //
  // CHANNEL-PACKING (author-confirmed mask taxonomy, 2026-07-16): only the 3
  // SINGLE-CHANNEL masks pack — into R/G/B of one RGBA texture + a shared
  // structural-hole alpha (the hole is a FLOOR property, identical across
  // masks — author-confirmed, see tools/make-torture-world.mjs's
  // fillHoleAlpha). COLOURED and RGBA masks each need a full texture and stay
  // unpacked. Real math: 7 masks → 4 packs (not the plan's original
  // optimistic 13→6) — directly answers the GPU page-cache pressure every
  // live castle-scenario report showed. WHICH kinds exist, their suffixes and
  // the packing rule all live in scene/mask-catalog.js now — this file only
  // knows the fixture's URL pattern and which kinds the fixture generator
  // emits (everything but water). `assembleLayerDescriptors` is the SAME
  // assembly the real-scene discovery path goes through: one policy, two
  // data sources, per the mask authority's whole point.
  const FIXTURE_MASK_KIND_IDS = ['shadow', 'outdoors', 'fire', 'specular', 'window', 'tree', 'bush'];
  const tortureMaskUrlsByKind = (floorIndex) =>
    new Map(
      FIXTURE_MASK_KIND_IDS.map((id) => [
        id,
        `modules/${MODULE_ID}/assets/torture/torture_floor${floorIndex}${maskKindById(id).suffixes[0]}.png`,
      ])
    );
  const tortureLayerUrls = (floorIndex) => assembleLayerDescriptors(tortureMaskUrlsByKind(floorIndex));

  // THE CASTLE-COURTYARD TEST (author, 2026-07-16: "on a castle on floor three
  // looking down into the courtyard... fires/trees/lighting on all three
  // floors, all mutually visible"). Until now this button's `visibleFloorIndices`
  // was left at startVtPanViewer's default `(i) => [i]` — SINGLE FLOOR ONLY —
  // because the torture fixture's scene macro has no real `visibility.levels`
  // data to drive `computeVisibleFloorIndices` (§6's known mismatch). That
  // default silently meant: no floor ever composited beneath another, so an
  // albedo hole showed the canvas's own black backdrop, not a lower floor —
  // and, more importantly, the multi-layer mask streaming this session built
  // was NEVER exercised for more than one floor's fine (view-tier) pages at
  // once, only its always-resident coarse pins. ALWAYS composite all 3 torture
  // floors — the worst case (every floor's every layer streaming fine detail
  // simultaneously) and the direct proof of the castle scenario, not an
  // approximation of it.
  const tortureVisibleFloorIndices = () => Array.from({ length: TORTURE_FLOOR_COUNT }, (_, i) => i);

  // The fixture's synthetic world. It has no Foundry Scene documents to read, so
  // it fabricates the same shapes `collectSceneLayers` produces for a real scene
  // — deliberately, so the fixture and real scenes drive ONE renderer down ONE
  // path rather than forking a second (doctrine #1). The fixture's art IS its
  // world: 12000² per floor, no padding, so sceneRect == the canvas rect.
  const TORTURE_WORLD_PX = 12000;
  const tortureDimensions = computeSceneDimensions({
    width: TORTURE_WORLD_PX,
    height: TORTURE_WORLD_PX,
    padding: 0,
    grid: { size: 100 },
  });

  /**
   * The fixture's draw list: one background item per floor, stacked in an
   * elevation band per floor (bottom = i*10) so the real sort law orders them
   * exactly as it orders a real scene's Levels. All 3 floors always composite —
   * the castle-courtyard worst case (every floor's every layer streaming fine
   * detail at once), which is the whole point of the fixture.
   */
  const buildTortureItems = () =>
    tortureVisibleFloorIndices().map((i) => ({
      id: `torture:floor${i}`,
      kind: 'levelBackground',
      key: makeLayerKey({ elevation: i * 10, sortLayer: SORT_LAYERS.SCENE, sort: i, zIndex: 0 }),
      src: tortureImageUrl(i),
      levelId: `torture${i}`,
      visibleOnLevelIds: [`torture${i}`],
      alpha: 1,
      tint: 0xffffff,
      alphaThreshold: 0.75,
      occlusion: { modes: 0, alpha: 0 },
      restrictsLight: true,
      restrictsWeather: true,
      isUpper: false,
      hidden: false,
      _placement: { kind: 'level', texturesConfig: {} },
      __floorIndex: i, // so extraLayersForItem can find this item's mask set
    }));

  const tortureExtraLayers = (item) => tortureLayerUrls(item.__floorIndex ?? 0);

  MapShine.debug.registerReport('vt-pan-viewer-diagnostics', 'Diagnostics', () => ({
    report: 'vt-pan-viewer-diagnostics',
    generatedAt: new Date().toISOString(),
    ...getVtPanViewerDiagnostics(),
  }));
  // WHY IS MY TOKEN NOT THERE? Reads the live scene documents directly — it does
  // not ask the viewer, so it answers even when the viewer is not running and
  // stays trustworthy if collection itself is the thing that is wrong.
  MapShine.debug.registerReport('tokens', 'Tokens: why is mine not showing?', () => {
    const sceneDoc = typeof canvas !== 'undefined' ? (canvas.scene ?? null) : null;
    const floorsResult = getActiveSceneFloors(sceneDoc);
    if (!floorsResult.ok) return { report: 'tokens', ok: false, reason: floorsResult.reason };
    const floors = floorsResult.floors;
    const viewedFloorIndex = resolveFloorDescriptor(sceneDoc, floors);
    const visibleLevelIds = computeVisibleFloorIndices(floors, viewedFloorIndex)
      .map((i) => floors[i]?.id)
      .filter(Boolean);
    const opts = {
      visibleLevelIds,
      knownLevelIds: floors.map((f) => f.id).filter(Boolean),
      viewedLevelId: floors[viewedFloorIndex]?.id,
      isGM: !!game?.user?.isGM,
    };
    const { items, skipped } = collectTokens(sceneDoc, opts);
    return {
      report: 'tokens',
      generatedAt: new Date().toISOString(),
      sceneName: sceneDoc?.name,
      floors: floors.map((f) => ({ index: f.index, id: f.id, name: f.name, elevationBottom: f.elevationBottom })),
      collectedTokenIds: items.map((i) => i.id),
      // Every drop, with its reason. The absence of this is what let three tokens
      // vanish while the report claimed skippedItems: [].
      skipped,
      ...diagnoseTokens(sceneDoc, opts),
    };
  });

  MapShine.debug.registerAction('vt-pan-viewer-stop', 'Stop / clear', () => ({
    report: 'vt-pan-viewer-stop',
    generatedAt: new Date().toISOString(),
    ...stopVtPanViewer(),
  }));

  // THE MASK-PILE-UP PROOF (Keyhole §4.1). Lists every (floor × layer) pair —
  // albedo AND every mask — with its resident page counts, alongside the fixed
  // cache's own stats. The whole layer stack is resident, yet residentPages
  // stays a small fraction of capacityPages: V2's `O(world × floors × masks)`
  // world-resolution textures replaced by `O(screen)` pages.
  MapShine.debug.registerReport('vt-pan-viewer-layers', 'Layer residency', () => {
    const d = getVtPanViewerDiagnostics();
    return {
      report: 'vt-pan-viewer-layers',
      generatedAt: new Date().toISOString(),
      active: d.active,
      displayLayer: d.displayLayer,
      currentFloorLayers: d.currentFloorLayers,
      layerResidency: d.layerResidency,
      layerLoadErrors: d.layerLoadErrors,
      layerResidencyTotals: d.layerResidencyTotals,
      cacheStats: d.cacheStats,
      decodeStats: d.decodeStats,
      interpretation:
        'GPU side: every (floor × layer) pair appears in layerResidency, and residentPages/evictions/' +
        'misses show the bounded page cache degrading to blur (never crash) under pressure — the mask ' +
        'pile-up killed. layerResidencyTotals.coarsePinShortfall MUST BE 0 — anything else means a ' +
        'coarse pin (the "always something resident, worst case blur" guarantee) failed to land, which ' +
        'is what a magenta screen means (a page with no resident data at any mip). coarsePinnedPages is ' +
        'ground truth (actually resident); coarseIntendedPages is what was asked for — they should match. ' +
        'DECODE-MEMORY side (the Bush-failure fix): decodeStats.heldSources is the peak number of full ' +
        '576MB source bitmaps alive at once — it must stay small (≈ SLICE_MAX_CONCURRENT_SOURCES), NOT ' +
        'grow with layers×floors. idbHits vs idbSlices shows pages served from IndexedDB without re-' +
        'decoding a source. Empty layerLoadErrors = no decode-memory failures. OFF-MAIN-THREAD DECODE: ' +
        'decodeStats.workerStatus should read "active" (if "unavailable", workerUnavailableReason says ' +
        'why, and everything silently fell back to the main thread — slower under pressure but still ' +
        'correct). workerSourceDecodes vs mainThreadFallbackSourceDecodes is the permanent tripwire for ' +
        '"is a giant image still touching the render thread anywhere" — mainThreadFallbackSourceDecodes ' +
        'should stay at or near 0; if it climbs, rangedFetchMisses shows whether the asset server is ' +
        "honoring Range requests (a nonzero value there means every pack's dimension probe is paying " +
        'for a full download just to read a PNG header).',
    };
  });

  // ISOLATE ONE DRAW ITEM — the ghost-hunting control (2026-07-17).
  //
  // The ghost ("tiles of textures at the wrong scale and in the wrong place")
  // has survived five diagnoses from me. Each one found a REAL bug and none of
  // them was the ghost, because I was reasoning about a VISUAL artefact from
  // aggregate counters — I can't see it, the author can. This inverts that:
  // pick items one at a time until the stripes appear, and the ghost's identity
  // stops being my theory and starts being a fact. Which item it is says a lot
  // on its own — a Tile means placement/packing, a Level means floor
  // compositing, a Token means the live-sync path.
  //
  // A dropdown, not a "next item" button: the choices are mutually exclusive
  // and the author should be able to jump straight back to a suspect
  // (feedback_debug_ui_one_action_one_control).
  MapShine.debug.registerSelect(
    'vt-isolate-item',
    'Isolate draw item',
    // A thunk: the draw list doesn't exist at install() and changes with every
    // scene, floor and token update. A snapshot here would be empty forever.
    () => [
      { value: '', label: 'All items (normal)' },
      ...getVtPanViewerDrawListIds().map(({ id, kind, renderOrder }) => ({
        value: id,
        label: `${renderOrder}. ${kind}: ${id}`,
      })),
    ],
    () => getVtPanViewerIsolateItemId(),
    async (id) => setVtPanViewerIsolateItem(id)
  );

  // VT ZOOM THRASH TEST (author-requested, 2026-07-16: "force the camera to
  // flush the caches, start zoomed out and thrash it in and out whilst tracking
  // things" — a deterministic, instrumented reproduction of the reported "rapid
  // full-range zoom can temporarily stop" hitch). Thrashes the LIVE viewer's
  // zoom target between fully-in and fully-out every animation frame for ~4
  // seconds, reusing the viewer's own captured params (real art, floor count,
  // tiles, warm cache), and reports frame-gap/hitch evidence — see
  // runZoomThrashTest's own header for the mechanism. Click once, wait a few
  // seconds. (The synthetic torture-fixture variant was retired 2026-07-20 —
  // real scenes render on all floors now, so this active-scene thrash is the one
  // that verifies a fix against the conditions that produced a real report.)
  //
  // ADVERSARIAL MAX-STRESS, NOT A PLAY PROXY (relabeled 2026-07-17, live-
  // confirmed): a multi-round ghost-artefact hunt traced a ghost to this test's
  // OWN burst-rate zoom — several full-range sweeps in ~8 seconds, zero settle
  // between direction flips — which the author could not reproduce through
  // 15-20s of deliberate, aggressive manual scroll-zooming. The RANGE this test
  // reaches is real (same clampHalfSpan() bounds as a real scroll wheel); the
  // RATE is not. Good for finding races fast (it already has: the coarse-pin
  // budget shortfall, the freeze, the pin leak, a mip-blend mismatch — all real,
  // all confirmed). Bad for "would a GM ever see this" — that question is
  // `MapShine.soak(n)`'s job now, via its `zoom` driver (soakZoomStep: one
  // bounded, eased step per cycle, the same path a real zoom key uses). See
  // runZoomThrashTest's own returned `interpretation` for the same caveat.
  MapShine.debug.registerAction('vt-zoom-thrash-active', 'Zoom thrash (max-stress): active scene', async () => ({
    report: 'vt-zoom-thrash-active',
    generatedAt: new Date().toISOString(),
    subject: typeof canvas !== 'undefined' ? (canvas.scene?.name ?? '(no active scene)') : '(no canvas)',
    // No startupParams — runZoomThrashTest reuses the LIVE viewer's own captured
    // params, so this restarts the scene you are actually looking at rather than
    // swapping it for the fixture.
    ...(await runZoomThrashTest({})),
  }));

  // ---------------------------------------------------------------------------
  // DEFAULT-ON REAL-SCENE RENDERING (author correction, 2026-07-15: "this V3
  // renderer is the main rendering system and this isn't an optional feature
  // we're adding... don't make me have to press buttons"). Both the visual
  // severance (VT viewer occluding PIXI) and the VRAM severance (PIXI proxy
  // textures) were built gated behind manual debug-panel toggles — matching
  // the pattern every OTHER new capability used this session, but WRONG for
  // these two specifically, which are the actual product, not diagnostics.
  // Corrected: both now activate automatically from Foundry's own canvas
  // lifecycle hooks, no click required. See [[feedback_default_on_new_features]]
  // in project memory — this is the established rule (ship default-on, toggle
  // only when explicitly requested), applied here after initially missing it.
  //
  // startRealSceneViewer() is the ONE function both the automatic hook and the
  // manual debug-panel button (kept as a manual retry/force-refresh, not the
  // primary activation path anymore) call — one path per behavior. Accepts
  // `initialFloorIndex` so a caller can open on whatever floor Foundry is
  // ALREADY viewing (see startVtPanViewer's own doc for why a hardcoded 0
  // here was a real live bug: it silently discarded Foundry-side floor
  // switches AND crashed after a few of them from repeated full GPU
  // reallocation — this function is now reserved for genuine (re)starts, a
  // same-scene floor sync uses the cheap `setVtPanViewerFloor` path instead,
  // see the canvasReady handler below).
  // ---------------------------------------------------------------------------
  function resolveFloorDescriptor(sceneDoc, floors) {
    // canvas.level is Foundry's own PUBLIC getter for "the currently
    // displayed Level document" (verified in source, client/canvas/board.mjs)
    // — matched against our floor list by Level document id. Falls back to
    // floor 0 if canvas.level isn't available yet or matches nothing (e.g.
    // the legacy single-floor fallback, whose synthetic id is 'legacy').
    const viewedLevelId = typeof canvas !== 'undefined' ? (canvas.level?.id ?? null) : null;
    const idx = viewedLevelId ? floors.findIndex((f) => f.id === viewedLevelId) : -1;
    return idx >= 0 ? idx : 0;
  }

  /**
   * THE MASTER OFF-SWITCH READ (Keyhole.md §4.3's "one legitimate switch").
   * Wrapped defensively: this setting is registered at Foundry's `init` hook,
   * which always fires before `canvasReady` (the only real caller of
   * `startRealSceneViewer`), so a throw here would mean the EARLIER
   * `registerSettings` call itself failed. In that scenario, treating a broken
   * settings system as "disable the whole renderer" would be a strictly worse
   * failure than the one it's guarding against — a silently-broken settings
   * row must not be able to turn off rendering for every player at the table
   * with no visible cause. Fails OPEN (assume enabled) and reports why.
   */
  function isMsaEnabledSetting() {
    try {
      return readSetting(MODULE_ID, GLOBAL_SETTING_KEYS.msaEnabled) !== false;
    } catch (err) {
      log.error('could not read the msaEnabled setting — assuming enabled:', err);
      return true;
    }
  }

  async function startRealSceneViewer(initialFloorIndex = 0) {
    // THE OFF-SWITCH — checked before anything else in this function, including
    // the loading curtain and the art-availability check below: a player who
    // turned MSA off does not want to see a curtain flash for a renderer that
    // was never going to start. Same shape as the "no art" branch just below
    // (engage the fallback, end any curtain, return {ok:false}) — deliberately,
    // so both "MSA cannot render this" and "MSA was asked not to" degrade the
    // same way. No canvas exists yet at this point, so there is nothing to
    // tear down — this is purely the calm, non-alarming announcement (contrast
    // `render-fallback.js`'s banner wording, which is written for a genuine
    // crash; this is a player's own deliberate choice, not a failure).
    if (!isMsaEnabledSetting()) {
      engageFoundryFallback({
        reason: 'Map Shine Advanced is turned off in your settings.',
      });
      endSceneLoad({ error: 'disabled by setting' });
      return { ok: false, error: 'disabled by setting' };
    }
    const sceneDoc = typeof canvas !== 'undefined' ? (canvas.scene ?? null) : null;
    beginSceneLoadPhase(LOAD_PHASES.SCENE); // no-op unless a curtain is up
    const floorsResult = getActiveSceneFloors(sceneDoc);
    if (!floorsResult.ok) {
      // This path already lands on Foundry's own rendering by construction — it
      // returns BEFORE startVtPanViewer, so no canvas is ever created. That is
      // the CORRECT outcome (the player gets a working session); what was wrong
      // is that it was SILENT, i.e. indistinguishable from MSA working. No
      // canvas to tear down here, so this is purely the announcement.
      engageFoundryFallback({
        reason: `This scene has no art MSA can render (${floorsResult.error}).`,
      });
      // The curtain must never outlive the load it describes — least of all on a
      // path that has just handed rendering back to Foundry, where leaving it up
      // would hide the working session it just rescued.
      endSceneLoad({ error: floorsResult.error });
      return { ok: false, error: floorsResult.error };
    }
    const { floors, skipped } = floorsResult;
    const dimensions = computeSceneDimensions(sceneDoc);
    const isGM = typeof game !== 'undefined' ? !!game.user?.isGM : true;
    // Track the floor being opened so the candle marker overlay shows only its
    // candles (covers both initial load and a full scene change — both route here).
    updateActiveFloorContext(floors, initialFloorIndex);

    /**
     * The real draw list: every visible Level's background AND foreground (roof)
     * art, plus every tile on any visible floor — all keyed for the ONE sort law.
     *
     * `computeVisibleFloorIndices` replicates Foundry's REAL cross-floor
     * visibility rule (a floor's own `visibility.levels` set, NOT "always show
     * the floor below") — see active-scene-source.js's header. Those indices are
     * mapped back to Level ids because that is what the document-level rules
     * (`isVisible`, `includedInLevel`) actually key on.
     */
    // EVERY level id in the scene, visible or not — see the use in buildItems.
    const allLevelIds = floors.map((f) => f.id).filter(Boolean);

    const buildItems = (viewedFloorIndex) => {
      const visibleIndices = computeVisibleFloorIndices(floors, viewedFloorIndex);
      const visibleLevelIds = visibleIndices.map((i) => floors[i]?.id).filter(Boolean);
      const viewedLevelId = floors[viewedFloorIndex]?.id;
      // Tokens join the SAME flat list as level art and tiles, and are sorted by
      // the same law (scene/layer-order.js) — they are drawables with a different
      // sortLayer (TOKENS 700), not a separate pass. That is the whole point of the
      // law being one flat list: nothing downstream learns the word "token".
      return [
        ...collectSceneLayers(sceneDoc, { viewedLevelId, visibleLevelIds, isGM }).items,
        // knownLevelIds is EVERY floor, not the visible ones: it is what lets
        // collectTokens tell "unassigned" (defaultLevel0000 — what a freshly
        // dragged token carries) from "on a floor you cannot currently see". Pass
        // only the visible ids and an upstairs token gets dragged down here.
        ...collectTokens(sceneDoc, { visibleLevelIds, knownLevelIds: allLevelIds, viewedLevelId, isGM }).items,
      ];
    };

    const initialVisibleLevelIds = computeVisibleFloorIndices(floors, initialFloorIndex)
      .map((i) => floors[i]?.id)
      .filter(Boolean);
    const layers = collectSceneLayers(sceneDoc, {
      viewedLevelId: floors[initialFloorIndex]?.id,
      visibleLevelIds: initialVisibleLevelIds,
      isGM,
    });
    const tokens = collectTokens(sceneDoc, {
      visibleLevelIds: initialVisibleLevelIds,
      knownLevelIds: allLevelIds,
      viewedLevelId: floors[initialFloorIndex]?.id,
      isGM,
    });
    // The report must describe what will actually DRAW, tokens included — a report
    // that quietly omits a whole class of drawable is worse than none.
    const collected = {
      items: [...layers.items, ...tokens.items],
      skipped: [...(layers.skipped ?? []), ...tokens.skipped],
    };

    // EVERY level's own mask-hosting items — background, foreground, tiles —
    // regardless of whether that level is currently VISIBLE from the initially-
    // viewed floor. Mask discovery (below) and the mask authority's own
    // cover-physics item set (`maskAuthority.reset`'s `items:`, further down)
    // both need this SAME wide set, for exactly the reason `collectLevelTextures`'s
    // own header already gives for the cover-physics half (the 2026-07-26
    // sky-reach bug): cover/outdoors truth cannot depend on which floor a
    // player happened to be looking at when the scene loaded. ONE call, reused
    // by both, so the two can never drift apart again — a second, narrower call
    // here (scoped to `initialVisibleLevelIds`, as this used to be) is how a
    // level that is not cross-visible from the initially-viewed one silently
    // never reached `discoverAuthoredMasks` at all: not "no mask file found"
    // but "never asked", which `RequiredMaskMissingError` cannot tell apart
    // from a genuine content gap — it fires identically either way, regardless
    // of what is actually painted on disk (found live, 2026-07-29: a scene
    // whose initially-viewed floor was not "Ground Floor" reported Ground
    // Floor's own, genuinely-authored `_Outdoors` file as missing).
    const allLevelsLayers = collectSceneLayers(sceneDoc, {
      viewedLevelId: floors[initialFloorIndex]?.id,
      visibleLevelIds: allLevelIds,
      isGM: true,
    });

    // MASK DISCOVERY TARGETS — every drawable that can host its own mask: a
    // Level's background, a Level's foreground, and every Tile, ALL keyed
    // UNIFORMLY by the item's own id (2026-07-26, `keyhole-mask-any-item-
    // decision`, LOCKED — author: *"all effects can happen on tiles,
    // background images of scenes and foreground images of scenes... if
    // someone makes a map by just using tiles instead of background image
    // and foreground image then we want to account for that"*). One id
    // namespace for all three means `scene/mask-authority.js`'s query doors
    // (`authoredStatus` for a level's own background, `authoredStatusForItem`
    // for anything by its own item id) read the exact SAME underlying map —
    // there is no second, tile-specific key space that could drift from it.
    //
    // `discoverAuthoredMasks` is already item-agnostic — it takes a plain
    // `{id,url,name}[]` and does not care what "floor" means (foundry/
    // mask-discovery.js's own header) — so this needs ZERO changes to that
    // file. The ORIGINAL `floors` array (level-id-keyed, used by
    // allLevelIds/updateActiveFloorContext/buildItems below) stays untouched;
    // discovery reads `allLevelsLayers.items` — EVERY level, not just the
    // initially-visible ones (see that const's own comment) — so a floor with
    // NO background or foreground art at all — an all-Tile floor — contributes
    // no floor-level target and still gets full mask support from its tiles.
    const discoveryTargets = allLevelsLayers.items
      .filter((it) => it.kind === 'levelBackground' || it.kind === 'levelForeground' || it.kind === 'tile')
      .map((it) => ({ id: it.id, url: it.src, name: it.id }));

    // MASK DISCOVERY + AUTHORITY RESET — before the viewer starts, so
    // `layersForItem` is a sync manifest lookup by the time packs build.
    // Discovery is one directory listing per unique art directory (bounded
    // probes only as the announced fallback — see foundry/mask-discovery.js);
    // a total failure serves absence defaults and says so, never blocks the
    // scene (the safety-slide stance: masks degrade, sessions don't). Several
    // targets sharing a directory cost NOTHING extra (the listing cache is
    // per-directory, inside discoverAuthoredMasks itself); only a genuinely
    // new directory costs one more browse call.
    //
    // OWN LOADING-SCREEN PHASE (2026-07-17): this await used to sit silently
    // inside LOAD_PHASES.SCENE — invisible on the listing happy path, but the
    // probe fallback is a real bounded sequence of network round trips that
    // must never sit unlabeled behind an earlier phase's title (exactly the
    // "silent stall" shape Keyhole.md §7's kill list forbids). `total` is
    // `discoveryTargets.length` (every mask-hosting item now, not floors
    // alone — a total that undercounted would make this phase's own progress
    // bar lie about how much work is left); `onProgress` advances it per target.
    beginSceneLoadPhase(LOAD_PHASES.MASKS, { total: discoveryTargets.length });
    let maskDiscovery = null;
    try {
      maskDiscovery = await discoverAuthoredMasks({
        floors: discoveryTargets,
        onProgress: ({ done, total, detail }) => reportSceneLoadProgress(LOAD_PHASES.MASKS, { done, total, detail }),
      });
    } catch (err) {
      log.error('mask discovery failed outright — this scene serves absence defaults:', err);
    }

    // The authority's item set is UNFILTERED (every level visible, GM view):
    // cover physics must not depend on what the current user happens to be
    // viewing. Hidden tiles are collected WITH their flag — the authority
    // excludes them from cover itself and reports them, which beats silently
    // never collecting them.
    maskAuthority.reset({
      sceneKey: String(sceneDoc?.id ?? sceneDoc?.name ?? 'unknown-scene'),
      dimensions,
      floors: (() => {
        // ONE read of each level's band — the ceiling decides what counts as
        // overhead, the bottom is the ground a caster's height is measured
        // from (docs/planning/Sun-Shadows.md §3.1).
        const bands = floorElevationBands(sceneDoc, floors);
        return floors.map((f) => {
          const band = bands.get(f.id) ?? { bottom: -Infinity, top: Infinity };
          return {
            index: f.index,
            id: f.id,
            name: f.name,
            ceilingElevation: band.top,
            bottomElevation: band.bottom,
          };
        });
      })(),
      // SAME collection discovery just used above (`allLevelsLayers`) — not a
      // second, independent call. Two calls with the same intended scope is
      // exactly how this pair drifted apart in the first place (see
      // `allLevelsLayers`'s own comment).
      items: (coverItems = allLevelsLayers.items),
      resolvePlacement: (item, size) => computeItemPlacement(item, size, dimensions),
    });
    if (maskDiscovery) maskAuthority.setDiscovery(maskDiscovery);

    // VEGETATION'S URL LOOKUP — through the mask authority's own two query
    // doors now (2026-07-26): `authoredStatus` for a floor's background,
    // `authoredStatusForItem` for a Tile's own file (see
    // `vegetationUrlByItemId`'s own declaration for why this stays a separate
    // MAP rather than becoming an authority-derived product — only the READ
    // path changed here, not the storage). Both doors degrade to
    // `source: 'default'` safely whether discovery found nothing for that
    // target or never ran at all, so — unlike reading `maskDiscovery.
    // byTargetId` raw — no `if (maskDiscovery)` guard is needed. Must run
    // AFTER `setDiscovery` just above: these doors read `scene.discovery`.
    // Foregrounds/roofs are excluded — V2's own TreeEffectV2/BushEffectV2
    // never populated from foreground art either, and "a canopy overlay on a
    // roof texture" has no obvious meaning to preserve accidentally.
    vegetationUrlByItemId = new Map();
    for (const item of layers.items) {
      if (item.kind !== 'levelBackground' && item.kind !== 'tile') continue;
      const treeStatus =
        item.kind === 'levelBackground'
          ? maskAuthority.authoredStatus(item.levelId, 'tree')
          : maskAuthority.authoredStatusForItem(item.id, 'tree');
      const bushStatus =
        item.kind === 'levelBackground'
          ? maskAuthority.authoredStatus(item.levelId, 'bush')
          : maskAuthority.authoredStatusForItem(item.id, 'bush');
      const tree = treeStatus.source === 'authored' ? treeStatus.url : null;
      const bush = bushStatus.source === 'authored' ? bushStatus.url : null;
      if (tree || bush) vegetationUrlByItemId.set(item.id, { tree, bush });
    }
    // A new scene deserves its own fresh required-mask warnings — otherwise a
    // floor index that happened to warn in a PREVIOUS scene would stay
    // silently suppressed in this one (safeSampleOutdoors' own throttle).
    warnedMissingOutdoorsFloors.clear();

    // V2 CANDLE ASSIMILATION (per scene, non-destructive) — import this old
    // scene's Map Point candles into the anchor authority so the new renderer
    // picks up their placement. Reads flags only; NEVER writes the scene (the
    // reversible cleanup/removal is a separate, gated step, not built in Tier 0).
    // `resolveKind` is injected from the catalog so foundry/ stays a leaf. Import
    // + reset cannot throw on data (both are total); only the settings-dependent
    // reapply is guarded separately so a settings hiccup can't discard good anchors.
    let anchorImport;
    try {
      anchorImport = importV2Anchors(sceneDoc, { resolveKind: anchorKindByV2EffectTarget });
    } catch (err) {
      log.error('V2 anchor import failed — no candles this scene:', err);
      anchorImport = { anchors: [], present: false, report: { present: false, error: String(err?.message ?? err) } };
    }
    lastV2AnchorCandidates = anchorImport.anchors;
    // THE AUTHORED OVERLAY (2026-07-22) — added/edited/removed anchors from
    // MSA's own live authoring UI, layered on top of the fresh V2 read via the
    // SAME pure join every live CRUD action below keeps in sync
    // (scene/anchor-authority.js#mergeAnchorSources' own doc: an override is
    // keyed by anchor id, so editing a V2-imported candle and editing a
    // freshly-authored one go through the identical path). `loadAuthoredAnchors`
    // reads OUR OWN registered flag namespace (unlike the V2 import's foreign-
    // namespace read above), so — matching foundry/paint-adapter.js's
    // un-guarded loadPaintedMasks precedent — it is trusted not to throw.
    const storedAnchors = loadAuthoredAnchors();
    authoredAnchorsPayload = {
      overrides: { ...(storedAnchors?.overrides ?? {}) },
      removed: [...(storedAnchors?.removed ?? [])],
    };
    anchorAuthority.reset({
      sceneKey: String(sceneDoc?.id ?? sceneDoc?.name ?? 'unknown-scene'),
      anchors: mergeAnchorSources(lastV2AnchorCandidates, authoredAnchorsPayload),
    });
    lastAnchorImport = anchorImport.report;
    if (anchorImport.present) {
      log.info(
        `V2 anchors: ${anchorImport.anchors.length} imported from ${anchorImport.groupsTotal} group(s) ` +
          `(${anchorImport.fromLegacy ? 'legacy map-shine' : 'map-shine-advanced'}, ` +
          `coords ${anchorImport.coordsFlipped ? 'Y-flipped to V3' : 'unchanged'}).`
      );
    }
    reapplyAll('scene load');
    // Not an effect reapply — a fresh read of THIS floor's door snapshots, which
    // is why it sits outside the list rather than riding along inside it.
    try {
      refreshDoors();
    } catch (err) {
      log.error('door refresh (scene load) failed:', err);
    }

    return {
      sceneName: sceneDoc?.name,
      floors: floors.map((f) => ({ index: f.index, name: f.name, elevationBottom: f.elevationBottom, url: f.url })),
      skippedLevels: skipped,
      // What the scene model actually found — the first thing to check if a tile
      // or a roof isn't showing up.
      sceneDimensions: {
        canvas: { width: dimensions.width, height: dimensions.height },
        sceneRect: dimensions.sceneRect,
      },
      collectedItems: collected.items.map((i) => ({ id: i.id, kind: i.kind, elevation: i.key.elevation })),
      skippedItems: collected.skipped,
      // What discovery concluded, in the same report the author already reads
      // after a scene start — the full story lives in the mask-authority report.
      maskDiscovery: maskDiscovery
        ? {
            method: maskDiscovery.method,
            targetsWithMasks: maskDiscovery.byTargetId.size,
            probesAttempted: maskDiscovery.probesAttempted,
            failures: maskDiscovery.failures,
          }
        : 'FAILED — see log; absence defaults are being served',
      ...(await startVtPanViewer({
        THREE,
        buildItems,
        // FOUNDRY OWNS ALL INPUT on a real scene (keyhole-input-model-decision):
        // pointer-events:none, no MSA input handlers, and the view follows
        // canvas.stage instead of tracking its own camera. The torture fixture
        // keeps its own camera — it has no Foundry scene to follow.
        followFoundryCamera: true,
        // Per-zone timing (docs/planning/Performance.md). Inert until armed; the
        // torture fixture below deliberately does not pass it, so a soak run
        // never profiles.
        profiler: perfProfiler,
        dimensions,
        floorCount: floors.length,
        initialFloorIndex,
        // THE MASK AUTHORITY'S two seams (see its header): what to stream per
        // item, and what streamed. Real scenes now pull mask layers from
        // discovery instead of streaming albedo alone.
        extraLayersForItem: (item) => maskAuthority.layersForItem(item),
        onPageDecoded: (info) => maskAuthority.ingestDecodedPage(info),
        // THE ART-OPACITY SEAM (2026-07-24) — the input `coverAbove`/`skyReach`
        // lost when the streaming engine took the albedo pack with it, and the
        // reason sky-reach has never been seen working. See
        // `vt/coarse-alpha.js`'s header for the full chain.
        onItemAlpha: (info) => maskAuthority.ingestItemAlpha(info),
        // Cover physics must not depend on what the user is currently viewing —
        // the same rule the authority's own item set already follows. A getter,
        // so a document change that rebuilds `coverItems` is picked up without
        // re-wiring.
        getCoverItems: () => coverItems,
        // Feeds the curtain, when there is one. A floor switch never reaches this
        // function at all (see the canvasReady handler), and these calls no-op
        // when nothing is loading — so the reporting path needs no knowledge of
        // whether a curtain is up.
        onLoadProgress: ({ done, total, detail }) => reportSceneLoadProgress(LOAD_PHASES.ART, { done, total, detail }),
        // THE DEVICE-LOST SAFETY SLIDE'S seam half (see startVtPanViewer's
        // onDeviceLost handler): when the GPU device is lost, the viewer removes
        // its own dead canvas and announces — but only boot.js, the composition
        // root that suppressed Foundry's art, can un-suppress it. Restoring the
        // seam here is what turns "MSA's dead black canvas over hidden Foundry
        // art" back into "Foundry drawing the scene normally".
        onDeviceLost: () => {
          const seam = restoreFoundryArt();
          log.info(`device lost — restored Foundry's own art (seam un-suppressed: ${seam}).`);
        },
        // THE CANDLE EFFECT (effects/candle-flame-render.js): each frame the
        // viewer draws the flame billboards and merges the candle lights into
        // its pool, reading the cascade-resolved enable + params + active-floor
        // anchors from here. Injected only on the real-scene path — the torture
        // fixture has no candles and never resets the anchor authority, so it
        // stays candle-free by construction (the default inert provider).
        getCandleRenderState,
        // THE LIGHTNING EFFECT (effects/lightning-subsystem.js): each frame the
        // subsystem schedules/spawns/reaps bolt strands and merges the origin-
        // flash lights into the pool, reading the cascade-resolved enable +
        // params + active-floor anchors from here. Same real-scene-only
        // injection posture as getCandleRenderState — the torture fixture has
        // no lightning anchors and stays bolt-free by construction.
        getLightningRenderState,
        // DOOR GRAPHICS (effects/door-graphics-render.js): each frame the viewer
        // reconciles + animates the door leaves, reading the cascade-resolved
        // enable + motion params and the active-floor door snapshots from here.
        // Same real-scene-only injection posture as getCandleRenderState — the
        // torture fixture has no doors and stays door-free by construction (the
        // default inert provider).
        getDoorRenderState,
        // VEGETATION (effects/vegetation-render.js + vt-pan-viewer.js's own
        // material glue): each frame's item pass reads the cascade-resolved
        // enable/params and the discovered sibling-mask URLs from here. Same
        // real-scene-only injection posture as getCandleRenderState — the
        // torture fixture has no vegetation masks and stays vegetation-free by
        // construction (the default inert provider).
        getVegetationRenderState,
        // BLOOM (effects/bloom-render.js): the viewer's runPostBloomPass reads
        // the cascade-resolved enable + params from here each frame. Unlike
        // candle/vegetation it needs NO scene data (a whole-image screen effect),
        // so the "real-scene-only" caveat above is only about the torture soak
        // harness staying minimal, not a data dependency — wire it there too if
        // bloom ever needs soak-perf coverage.
        getBloomRenderState,
        // SUN SHADOWS (docs/planning/Sun-Shadows.md) — the look/enable readout
        // and the floor's occluder height field. vt/ owns the bake and the
        // texture; it never reaches the mask authority or the registry itself.
        getSunShadowRenderState,
        getCasterHeightField,
        // THE COLOUR GRADE (Look) effect — same shape as bloom; the viewer's
        // per-frame pushGradeLook reads the cascade-resolved enable + params.
        getGradeLookState,
        // THE WIND OVERLAY's per-point exposure seam (Wind.md) — same
        // real-scene-only reasoning as getCandleRenderState just above (the
        // torture fixture has no mask authority data to sample either).
        sampleWindExposureAt,
        // THE MASK-DRIVEN WIND REBAKE TRIGGER's version seam — same
        // real-scene-only reasoning; the torture fixture's default (`() =>
        // null`, vt-pan-viewer.js's own fallback) is correctly inert.
        getMaskAuthorityVersion,
        // THE WIND PROBE's live mask-authority cross-check — same
        // real-scene-only reasoning as the seams just above.
        probeMaskAuthorityLiveAt,
        // THE SKY LIGHT's mask gate — same real-scene-only reasoning; the
        // torture fixture's default (`() => null`) bakes a fully-outdoors
        // placeholder, which is a no-op while the sky ships neutral.
        getOutdoorsMaskGrid,
        // THE WATER BODY PACK's mask + cross-floor seams (Water.md §5.1) —
        // same real-scene-only reasoning; unwired means no floor has water, so
        // the jump flood never runs (inert by construction, not by a flag).
        getWaterMaskGrid,
        getFloorsWithWater,
        getWaterMaskUrl,
        // WATER's look/enable seam. ⚠️ Its ABSENCE is invisible: the viewer's
        // own default is `{enabled: true, params: {}}`, so water renders
        // perfectly at its hardcoded defaults while every panel control does
        // nothing — which is exactly how this shipped once (2026-07-26). A
        // default-on seam cannot announce that it was never wired.
        getWaterRenderState: water.getRenderState,
        // SHINE's three seams (Specular.md). Same real-scene-only reasoning:
        // `getSpecularMaskUrl` needs the mask authority's authored-status
        // lookup and `getSpecularMaskRect` its grid spec, neither of which the
        // torture fixture has. Unwired, both return null and the effect renders
        // literally nothing — and `getSpecularRenderState` carries the SAME
        // ⚠️ default-on hazard water's does, which is why it is passed here in
        // the same commit as the code that consumes it rather than "later".
        // FLUID is PER ITEM: this lists every item on the floor — tile OR
        // level art — that has its own authored fluid mask. A floor-keyed
        // lookup could not see a tile's file at all, which is what made the
        // effect render nothing (see createFluidSeams' own header).
        getFluidMaskItems,
        getFluidRenderState: fluid.getRenderState,
        // The viewer hands its placement resolver back through this, so the
        // seam can turn an item into a world quad without boot learning about
        // texture sizes.
        onFluidCornersResolver: (fn) => {
          fluidItemCorners = fn;
        },
        // Same handback, for the item's CURRENT renderOrder — see
        // `createFluidSeams`'s own `getItemRenderOrder` doc for why this can't
        // simply read `item.renderOrder` off `coverItems` directly.
        onFluidRenderOrderResolver: (fn) => {
          fluidItemRenderOrder = fn;
        },
        getSpecularMaskUrl,
        getSpecularMaskRect,
        getSpecularRenderState: specular.getRenderState,
        // WINDOW LIGHT's three seams (Windows.md). Same real-scene-only
        // reasoning as SHINE's directly above: unwired, both mask seams
        // return null and the effect renders literally nothing.
        getWindowMaskUrl,
        getWindowMaskRect,
        getWindowRenderState: windowLight.getRenderState,
      })),
    };
  }

  MapShine.debug.registerAction('vt-pan-viewer-start-real-scene', 'Restart: active scene', async () => {
    const sceneDoc = typeof canvas !== 'undefined' ? (canvas.scene ?? null) : null;
    const floorsResult = getActiveSceneFloors(sceneDoc);
    const initialFloorIndex = floorsResult.ok ? resolveFloorDescriptor(sceneDoc, floorsResult.floors) : 0;
    return {
      report: 'vt-pan-viewer-start-real-scene',
      generatedAt: new Date().toISOString(),
      ...(await startRealSceneViewer(initialFloorIndex)),
    };
  });

  // VRAM severance (Keyhole.md §4.3's "single biggest instant win") — the PIXI
  // proxy registration itself. LIVE-CONFIRMED 2026-07-15 (author's residency
  // report: both floors of a real 12000x12000 scene resident at exactly
  // 1024x1024) — the one assumption pixi-proxy-textures.js's header flagged
  // as unverifiable from source alone (does PIXI.Assets.load() itself respect
  // a pre-seeded Assets.cache entry) is now confirmed true, not just reasoned.
  // registerFloorProxies() is called from canvasInit below (unconditional,
  // no toggle — see the default-on note above) and is idempotent per src
  // (registerPixiProxy itself no-ops if that src is already cached).
  async function registerFloorProxies(sceneDoc) {
    const floorsResult = getActiveSceneFloors(sceneDoc);
    if (!floorsResult.ok) return;
    for (const floor of floorsResult.floors) {
      const bitmap = await getSourceBitmap(floor.url);
      const result = await registerPixiProxy(floor.url, bitmap);
      log.info(`VRAM severance — floor ${floor.index} (${floor.name}):`, result);
    }
  }

  // THE TSL SPIKE (docs/planning/Shaders.md §7.5). Loads the node build LAZILY —
  // a 2.8MB vendor bundle must not be on the boot path for a decision we have not
  // taken. Touches nothing that works; renders into its own offscreen canvas.
  MapShine.debug.registerReport('loading-screen-state', 'Loading screen state', () => ({
    report: 'loading-screen-state',
    generatedAt: new Date().toISOString(),
    ...getLoadingScreenState(),
    note:
      'lastLoad.worstStallMs is the headline: a load that completes but froze the main thread for seconds is a ' +
      "bug with a receipt, not a success. lastStartedSceneId is the floor-switch guard's memory — a floor switch " +
      'is suppressed precisely because it matches.',
  }));

  // The curtain correctly refuses to reappear for the same scene, which makes it
  // impossible to look at again without switching scenes back and forth. This
  // forgets that memory so the next redraw is treated as a cold load.
  MapShine.debug.registerAction(
    'loading-screen-arm',
    'Loading Screen: Arm for next redraw (then switch floor/scene)',
    () => ({
      report: 'loading-screen-arm',
      generatedAt: new Date().toISOString(),
      ...resetLoadingSceneMemory(),
      note: 'The next canvasInit will now be treated as a cold load and raise the curtain, even for the scene you are already on.',
    })
  );

  MapShine.debug.registerReport('interface-seam', 'Interface seam (art vs chrome)', () => getCanvasCompositingReport());

  // RENDERER A/B TOGGLE (2026-07-18, author request: "a button that lets me
  // toggle back to the native PIXI render and back again to threejs, for
  // proper A/B visual testing of the lights").
  //
  // NOT a new mechanism — the interface seam already has a fully reversible
  // lever for exactly this (canvas-compositing.js): `canvas.environment
  // .renderable`. false = Foundry's own primary+effects art is suppressed and
  // MSA (stacked underneath, verified z-index 0 vs Foundry's own canvas —
  // vt-pan-viewer.js's stackUnderBoard) shows through. true = Foundry draws
  // its own art again, on top, occluding MSA. MSA's render loop keeps running
  // in EITHER mode (wasted GPU work while hidden, never a correctness issue —
  // pausing it is a possible follow-up, not needed for A/B comparison).
  //
  // A dropdown, not a plain button (feedback_debug_ui_one_action_one_control:
  // mutually-exclusive modes are a dropdown), reading its value from the SAME
  // live fact the interface-seam report already exposes — one source of
  // truth, not a second one invented for this control.
  //
  // Switching TO Foundry is unconditional (`restoreFoundryArt` — showing
  // Foundry's own art is never unsafe). Switching TO MSA reuses
  // `applyArtSuppression`'s existing safety check (decideArtSuppression) and
  // can REFUSE (e.g. the PIXI context is opaque) — a refusal is thrown, not
  // silently swallowed, so the status line reads "failed: <reason>" rather
  // than a false "✓" (feedback_instruments_must_not_lie).
  MapShine.debug.registerSelect(
    'render-compare',
    'Renderer',
    [
      { value: 'msa', label: 'MSA' },
      { value: 'foundry', label: 'Foundry' },
    ],
    () => (getCanvasCompositingReport().environmentRenderable ? 'foundry' : 'msa'),
    async (mode) => {
      if (mode === 'foundry') {
        if (!restoreFoundryArt())
          throw new Error("restoreFoundryArt() could not restore Foundry's own art — see console.");
        return;
      }
      const result = applyArtSuppression();
      if (!result.applied) throw new Error(`refused (${result.code}): ${result.reason}`);
    }
  );

  // THE DARKNESS-REALISM LEVER (2026-07-19, author-requested) — how dark the
  // UNLIT scene gets at maximum scene darkness. "Foundry" (default) floors at
  // Foundry's own readable darkness colour (~19%, never black — parity); the
  // "realistic" end drives that floor to true black. Presets rather than a
  // continuous slider because the debug panel's lever primitive is a select
  // (feedback_debug_ui_one_action_one_control) — three points span the range.
  MapShine.debug.registerSelect(
    'darkness-realism',
    'Darkness at max',
    [
      { value: '0', label: 'Foundry (readable)' },
      { value: '0.5', label: 'Halfway' },
      { value: '1', label: 'Realistic (black)' },
    ],
    () => {
      // Snap the live value to the nearest preset for display (the API accepts
      // any 0..1; the dropdown only offers these three).
      const v = getDarknessRealism();
      if (v <= 0.25) return '0';
      if (v >= 0.75) return '1';
      return '0.5';
    },
    (value) => {
      setDarknessRealism(Number(value));
    }
  );

  // THE GRAPHICS & PERFORMANCE PANEL (2026-07-29, Control-Panel.md §2's Zone 5,
  // built for real — author directive: the off-switch most prominent, then the
  // performance profile, then per-effect toggles, all persisted, styled like a
  // game's own graphics options menu, the ONLY zone a player ever sees).
  //
  // This SUBSUMES the old bespoke 'ui-shadow' select that used to be the whole
  // Settings zone: that control offered On/Off for ONE effect via the low-level
  // `MapShine.setUiShadow`; the generic per-effect list below covers ui-window-
  // shadow (and every other effect) with the full Auto/On/Off vocabulary, so
  // keeping both would have meant two controls for the same setting reading
  // two different axes (a resolved boolean vs. a raw override) — exactly the
  // "same controls twice" mistake this project's own water FOH/ROH incident
  // named (feedback_foh_roh_must_differ). `MapShine.setUiShadow({enabled})`
  // remains a real console API; it just no longer has its own panel row.
  //
  // `diag/settings-panel.js` imports nothing from `effects/` (matches
  // `effect-controls.js`'s own discipline) — this is the seam that supplies it
  // flattened, effect-agnostic data. `effectRegistry.list()` is read FRESH
  // inside the buildFn (not captured here) because `registerPanel`'s buildFn
  // runs lazily, well after every effect in this file has registered; capturing
  // the list at THIS point in `install()` risks an incomplete one.
  const ENABLE_CHOICE_LIST = Object.entries(choiceLabels(ENABLE_OVERRIDES)).map(([value, label]) => ({
    value,
    label,
  }));
  const PROFILE_CHOICE_LIST = Object.entries(choiceLabels(PERFORMANCE_PROFILES)).map(([value, label]) => ({
    value,
    label,
  }));
  MapShine.debug.registerPanel(
    'graphics-settings',
    'Graphics & Performance',
    () =>
      buildSettingsPanel({
        msaEnabledKey: GLOBAL_SETTING_KEYS.msaEnabled,
        profileKey: GLOBAL_SETTING_KEYS.profile,
        a11yKey: GLOBAL_SETTING_KEYS.reducePhotosensitive,
        profiles: PROFILE_CHOICE_LIST,
        enableChoices: ENABLE_CHOICE_LIST,
        effectRows: effectRegistry.list().map((m) => ({
          id: m.id,
          title: m.title ?? m.id,
          photosensitive: m.a11y?.photosensitive === true,
          playerKey: effectEnableKey(m.id, 'player'),
          gmKey: effectEnableKey(m.id, 'gm'),
        })),
        read: (key) => readSetting(MODULE_ID, key),
        write: (key, value) => writeSetting(MODULE_ID, key, value),
        isGM: () => MapShine.debug.isGM(),
        refresh: () => MapShine.debug.refreshControls(),
      }),
    { zone: 'settings', order: -100 } // pin above anything else ever routed to Settings
  );

  // A PASSIVE READOUT proving the reader is finding windows rather than silently
  // doing nothing (feedback_instruments_must_not_lie): how many framed windows
  // were detected last frame, how many are actually casting (capped at the
  // shader's slot count), and the current light/tuning. Pure — safe for the
  // flight recorder to run on every export.
  MapShine.debug.registerReport('ui-shadow-status', 'UI window shadows', () => getUiShadow());

  // THE INTERACTIVE PIXEL PROBE (2026-07-19, author-requested: "I need a
  // button to activate pixel probe and the ability to click on the screen
  // to set the three points"). An ACTION, not a report — it arms a click
  // listener and does not resolve until the author has clicked up to 3
  // points (or 90s elapse), so it must never be swept up by the flight
  // recorder's "run every report" export. Its return value (the same
  // 5-buffer readback + deltaFromPrev `MapShine.probePixels` gives) is
  // copied to the clipboard automatically by the SAME mechanism every other action
  // uses — click, then click up to 3 map points, then paste.
  // `{ primary: true }` self-nominates it into the Lab's quick-reach row. It was
  // hardcoded in the panel's own PRIMARY set until 2026-07-27 — a hand-maintained
  // id list living a file away from the thing it described.
  MapShine.debug.registerAction(
    'pixel-probe',
    'Pixel Probe (click 3 pts)',
    async () => ({
      report: 'pixel-probe',
      generatedAt: new Date().toISOString(),
      points: await MapShine.armPixelProbe(3),
    }),
    { primary: true }
  );

  // THE WIND + PARTICLE PROBE (2026-07-21, author-requested: "like a pixel
  // probe but for particles in this system... I can click in hot and cold
  // zones and then you get the information from the particles nearby").
  // Same "arm, click up to 3 points, resolve" shape as the pixel probe
  // above, aimed at a different question: for each click, reports the
  // CPU-side wind-field ground truth (ambient/structure/wake/exposure/
  // enclosed, split apart instead of pre-summed) AND the nearest real
  // particles' actual GPU state, side by side — see
  // vt-pan-viewer.js#runWindProbeOnPoints for the full reasoning.
  MapShine.debug.registerAction(
    'wind-probe',
    '🌬️🔍 Wind + Particle Probe (click 3 pts)',
    async () => ({
      report: 'wind-probe',
      generatedAt: new Date().toISOString(),
      points: await MapShine.armWindProbe(3),
    }),
    { effect: 'wind' }
  );

  /** Push a specular debug channel and wait for it to actually be on screen.
   * @param {number} n @returns {Promise<void>} */
  async function waitForSpecularChannelToRender(n) {
    specular.setDebugChannel(n);
    // Two rAF ticks: one for the change to reach the next `sync()` (the
    // registration's `debugChannel` is read fresh every frame, no reapply
    // needed), one more as margin against the probe firing mid-frame. Cheap —
    // this is a diagnostic action the author is already waiting on, not a
    // per-frame cost.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  /** Rec.709 luma of a decoded `[r,g,b,a]` readback. @param {number[]|null} rgba @returns {number|null} */
  function specularProbeLuma(rgba) {
    if (!rgba) return null;
    return +(rgba[0] * 0.2126 + rgba[1] * 0.7152 + rgba[2] * 0.0722).toFixed(4);
  }

  /**
   * Every channel worth reading, in the same left-to-right chain order, so a
   * reader can still apply "the first one that looks wrong names the culprit".
   * Only `finalBoosted` is skipped — it is `final` times a constant, so against
   * a NUMBER it carries no information the unscaled channel does not.
   *
   * ⚠️ **`maskUv` AND `patternUv` ARE THE MOST IMPORTANT ENTRIES HERE, and the
   * first version of this list OMITTED them** — under a comment claiming the
   * coordinate probes were "not useful against a numeric readback the way they
   * are against an eyeball." That is exactly backwards, and
   * `specular-material.js#describeSpecularMapping`'s own header already said so
   * in as many words: *"a UV ramp cannot distinguish `viewSpanX = 8000` from
   * `viewSpanX = 20000`, because 0.42 red and 1.0 red are the same impression
   * on a screenshot."* A coordinate is the one quantity an eyeball CANNOT read
   * and a probe reads perfectly.
   *
   * The cost of leaving them out was a whole live round: `mask` and `islands`
   * both came back zero on visibly gold pixels, and because BOTH textures are
   * sampled through the SAME `maskUv`, "the lookup is pointing somewhere
   * unpainted" and "the mask/pack are empty" were indistinguishable — the one
   * distinction these two channels make directly, as numbers, in one run.
   */
  const SPECULAR_CHANNEL_PROBE_IDS = [
    'quad',
    'maskUv',
    'patternUv',
    'mask',
    'strength',
    'presence',
    'tint',
    'islands',
    'islandMotion',
    'floorGate',
    'outdoors',
    'illum',
    'cellular',
    'shimmer',
    'sheen',
    'glint',
    'final',
    // The RAW-light control. Read it against `illum` above — see channel 19's
    // own `reads` for why that one diff is worth more than the shader source.
    'illumDirect',
  ];

  /**
   * THE SPECULAR CHANNEL PROBE (2026-07-27, author-requested directly:
   * *"Use the pixel probe. Set that up so that it can give you useful
   * information."*) — the pixel probe's own pattern (`diag/pixel-probe.js`'s
   * header: "the load-bearing instrument for 'the maths is right but the
   * picture is wrong'"), aimed at specular's own composite instead of another
   * round of reading source and re-guessing.
   *
   * ============================================================================
   * THE MECHANISM THIS REUSES, RATHER THAN BUILDS NEW
   * ============================================================================
   * `specular-render.js`'s debug channels already draw their chosen
   * intermediate OPAQUELY (One/Zero blend) into `scene.lit`, replacing
   * whatever was there — and `MapShine.probePixels` already reads `scene.lit`
   * back off the real GPU as its `lit` buffer. So a debug channel selected via
   * `MapShine.setSpecularDebug(n)` is ALREADY pixel-probeable with zero new
   * render code: switch the channel, let the running frame loop redraw it
   * (the render loop is continuous — confirmed by the live FPS HUD — so a
   * short wait is reliable, not merely hoped for), then probe the SAME three
   * points and read `buffers.lit.rgba`. This function is pure orchestration
   * over two already-shipped, already-tested primitives; it adds no new
   * shader code and cannot introduce a new rendering bug the way another
   * composite edit could.
   *
   * ============================================================================
   * CHANNEL OUTER, POINTS INNER
   * ============================================================================
   * All 3 click points are collected FIRST (via the existing arm-and-click
   * flow), then the outer loop is over CHANNELS, the inner loop over the 3
   * points — one material swap serves all three readbacks, rather than
   * fifteen swaps for fifteen single-point reads. `debugChannel` always
   * returns to 0 in a `finally`, even on a mid-probe error — a diagnostic
   * left stuck on is a second bug wearing the first one's clothes.
   *
   * @param {Array<{worldX:number, worldY:number}>} points - up to 3 already-
   *   collected results, SHAPED LIKE `MapShine.armPixelProbe`'s OWN return
   *   value (`{index, worldX, worldY, pixel, onScreen, buffers,
   *   deltaFromPrev}`), not a raw `{x,y}` click pair — this does not arm its
   *   own click listener, see `specular-channel-probe`'s own action for the
   *   arm-then-run shape and exactly what it passes in here.
   * @returns {Promise<object>}
   */
  async function probeSpecularChannelsAt(points) {
    // ⚠️ `MapShine.probePixels` (called per channel below) wants `{x,y}`, but
    // `armPixelProbe`'s results carry `worldX`/`worldY` — its OWN readback
    // already ran once during arming. Re-passing those objects straight
    // through, unconverted, fed `undefined` into `sampleOnePixel`, which
    // silently became NaN pixel coordinates and crashed deep inside WebGPU's
    // texture readback ("origin.x is not of type unsigned long") — a type
    // error nowhere near the actual bug. Convert HERE, once, so every one of
    // the 15 per-channel `probePixels` calls below gets real numbers.
    const list = (Array.isArray(points) ? points : []).slice(0, 3).map((p) => ({ x: p.worldX, y: p.worldY }));
    const restoreTo = specular.getDebugChannel();
    /** @type {Record<string, Array<object>>} */
    const byChannel = {};
    try {
      for (const id of SPECULAR_CHANNEL_PROBE_IDS) {
        const channel = SPECULAR_DEBUG_CHANNELS.find((c) => c.id === id);
        if (!channel) continue; // a renumbered channel list should never silently drop an id — see the test that pins this
        await waitForSpecularChannelToRender(channel.n);
        const readback = await MapShine.probePixels(list);
        byChannel[id] = readback.map((p) => ({
          index: p.index,
          worldX: p.worldX,
          worldY: p.worldY,
          onScreen: p.onScreen,
          // ⚠️ THE DEVICE PIXEL THIS ACTUALLY READ, carried through so the
          // report can PROVE the three points hit three different texels. The
          // first version dropped it, and when every channel came back
          // identical at three spread-out points there was no way to tell "the
          // shader emitted a constant" from "the readback sampled one texel
          // three times" — two completely different bugs. An instrument that
          // cannot separate its own failure from the one it is measuring is
          // `feedback_instruments_must_not_lie`, and that gap is what led to
          // blaming the author's clicking instead of the code
          // (`feedback_never_blame_the_authors_technique`).
          pixel: p.pixel ?? null,
          // A CONTROL that the debug channel cannot touch: this pass writes
          // only to `scene.lit`, so `albedo` MUST still vary between genuinely
          // different points no matter which channel is on screen. Identical
          // albedo at all three points means the probe is at fault; varying
          // albedo with identical `lit` means the shader genuinely is constant.
          controlAlbedo: p.buffers?.albedo?.rgba ?? null,
          rgba: p.buffers?.lit?.rgba ?? null,
          luma: specularProbeLuma(p.buffers?.lit?.rgba ?? null),
        }));
      }
    } finally {
      // ALWAYS restored, success or throw — see this tool's own header.
      await waitForSpecularChannelToRender(restoreTo);
    }

    // Re-shape channel-outer → point-outer for the report: an author reading
    // "point 2 (dark, metallic)" wants every channel's reading for THAT point
    // together, not scattered across fifteen separate channel blocks.
    const byPoint = list.map((_, i) => {
      const index = i + 1;
      /** @type {Record<string, {rgba: number[]|null, luma: number|null}>} */
      const channels = {};
      for (const id of SPECULAR_CHANNEL_PROBE_IDS) {
        const hit = byChannel[id]?.find((p) => p.index === index);
        if (hit) channels[id] = { rgba: hit.rgba, luma: hit.luma };
      }
      const worldPoint = byChannel[SPECULAR_CHANNEL_PROBE_IDS[0]]?.find((p) => p.index === index);
      return {
        index,
        worldX: worldPoint?.worldX ?? null,
        worldY: worldPoint?.worldY ?? null,
        onScreen: worldPoint?.onScreen ?? null,
        // See `pixel`/`controlAlbedo` above: these two make "the probe read the
        // wrong texel" a FALSIFIABLE claim instead of an assumption.
        pixel: worldPoint?.pixel ?? null,
        controlAlbedo: worldPoint?.controlAlbedo ?? null,
        channels,
        // ⚠️ FACTUAL FLAGS ONLY — deliberately not a verdict on the islands
        // channel. A black `islands` reading at one point does not by itself
        // prove the pack is broken: it could legitimately be an UNLABELLED gap
        // between two real islands (status 2, this exact texel just isn't
        // inside one) — that is CORRECT behaviour, not a bug. `mask`/
        // `strength`/`presence` at the SAME point are what tell the two apart:
        // real coverage there with islands still black is the genuine anomaly.
        flags: {
          // `final` bright while `illum` (the steepened incident actually
          // used) reads dark is the direct, numeric test for "self-
          // illuminating regardless of scene lighting" — no eyeballing.
          brightWhileDarkRoom:
            (specularProbeLuma(channels.final?.rgba) ?? 0) > 0.04 &&
            (specularProbeLuma(channels.illum?.rgba) ?? 1) < 0.04,
          islandsNeverBaked: isCloseRgb(channels.islands?.rgba, [1, 0, 1]),
          islandsBakedEmpty: isCloseRgb(channels.islands?.rgba, [1, 0.6, 0]),
        },
      };
    });

    // ── THE PROBE GRADING ITSELF, before anyone reads a channel ─────────────
    // Answers "is this report trustworthy at all", so a suspicious reading is
    // attributed to the right layer instead of to whoever clicked. Both checks
    // are about the INSTRUMENT, never about the effect.
    const distinctPixels = new Set(byPoint.map((p) => (p.pixel ? `${p.pixel.x},${p.pixel.y}` : 'none')));
    const distinctAlbedo = new Set(byPoint.map((p) => JSON.stringify(p.controlAlbedo)));
    return {
      report: 'specular-channel-probe',
      generatedAt: new Date().toISOString(),
      sanity: {
        pointsProbed: byPoint.length,
        distinctPixelsRead: distinctPixels.size,
        distinctControlAlbedo: distinctAlbedo.size,
        // The one sentence that decides who is at fault when every channel
        // reads the same: `albedo` is untouched by this pass, so if IT is
        // identical across genuinely different clicks, the readback — not the
        // shader, and certainly not the clicking — is what to fix first.
        verdict:
          byPoint.length > 1 && distinctPixels.size === 1
            ? 'PROBE FAULT: every point resolved to ONE device pixel — channel values below are one texel repeated, not a spatial comparison'
            : byPoint.length > 1 && distinctAlbedo.size === 1
              ? 'PROBE SUSPECT: distinct pixels but IDENTICAL control albedo — the readback may be sampling a stale or wrong target'
              : 'probe healthy: distinct pixels AND distinct control albedo, so identical channel values below are the SHADER being constant, not the instrument',
      },
      points: byPoint,
    };
  }

  /** @param {number[]|null} rgba @param {number[]} target @returns {boolean} */
  function isCloseRgb(rgba, target) {
    if (!rgba) return false;
    return (
      Math.abs(rgba[0] - target[0]) < 0.08 &&
      Math.abs(rgba[1] - target[1]) < 0.08 &&
      Math.abs(rgba[2] - target[2]) < 0.08
    );
  }

  // THE SPECULAR CHANNEL PROBE's own action — arm the SAME click-3-points flow
  // every other probe here uses, then run every channel above at those 3
  // points. Designed for exactly the protocol the author asked for: "I'll
  // click where the scene is bright and metallic, dark and metallic and dark
  // and non-metallic."
  MapShine.debug.registerAction(
    'specular-channel-probe',
    '✨🔍 Specular Channel Probe (click 3 pts)',
    async () => {
      const points = await MapShine.armPixelProbe(3);
      if (!points.length)
        return { report: 'specular-channel-probe', generatedAt: new Date().toISOString(), points: [] };
      return probeSpecularChannelsAt(points);
    },
    { effect: 'specular' }
  );

  // THE THIRD GROUP (2026-07-17, ghost-hunting round 3). Five theories dead by
  // direct evidence tonight, in order: environmentRenderable:false (not
  // Foundry's suppressed art), renderer.autoClear defaults true and nothing
  // overrides it — verified against three.webgpu.js — (not a stale
  // sceneColor buffer), totalStuckChildren:0 (not a stuck drag preview),
  // msaCanvasCount:1 (not an orphaned second viewer), and — provably, by
  // reading the code rather than guessing — NOT an MSA mesh at all: every
  // itemStates entry gets `.visible` set by exactly one of two gates on every
  // residency pass (vt-pan-viewer.js:1740 or :1833, the isolation-aware one),
  // with no third writer (`refreshItemPlacement`, called every frame by
  // `syncTokenPlacements`, touches only geometry — never `.visible`, read
  // directly). `scene.add()` is called in exactly one place in the whole
  // file. So whatever draws the ghost is not in this Three.js scene, period.
  //
  // `canvas.environment` and `canvas.interface` are two of THREE siblings
  // under `rendered` (config.mjs: primary/effects → environment; every
  // placeable layer → interface; `visibility` → the THIRD, Foundry's fog of
  // war). `applyArtSuppression` was only ever told about the first two.
  // `CanvasVisibility#visible` (visibility.mjs:499) is
  // `canvas.effects.visionSources.some(s => s.active) || !game.user.isGM` —
  // true the instant a vision source is active, which this session's own
  // early testing ("I tried making the scene dark and adding a light and the
  // token's vision was only present where the light was") means it plausibly
  // has been. Its `explored` container holds `canvas.fog.sprite`
  // (fog.mjs:118) — a real SpriteMesh with a real texture, drawn through
  // FOUNDRY'S OWN camera, which the thrash test never touches. A hypothesis,
  // not a diagnosis (feedback_plausible_diagnosis_rots) — this is the one
  // machine-checked fact that confirms or kills it.
  MapShine.debug.registerReport('fog-of-war-census', 'Fog of war (third PIXI group)', () => {
    const vis = typeof canvas !== 'undefined' ? (canvas?.visibility ?? null) : null;
    if (!vis) {
      return {
        report: 'fog-of-war-census',
        generatedAt: new Date().toISOString(),
        present: false,
        interpretation: 'canvas.visibility is not reachable — not running inside a loaded Foundry scene.',
      };
    }
    const sprite = canvas?.fog?.sprite ?? null;
    const spriteRect = sprite?.getBounds ? sprite.getBounds() : null;
    const visionSources = Array.from(canvas?.effects?.visionSources ?? []);
    return {
      report: 'fog-of-war-census',
      generatedAt: new Date().toISOString(),
      present: true,
      visibilityGroupVisible: vis.visible,
      visibilityGroupRenderable: vis.renderable,
      exploredContainerVisible: vis.explored?.visible ?? null,
      exploredContainerChildCount: vis.explored?.children?.length ?? null,
      isGM: typeof game !== 'undefined' ? (game?.user?.isGM ?? null) : null,
      activeVisionSourceCount: visionSources.filter((s) => s?.active).length,
      totalVisionSourceCount: visionSources.length,
      fogSprite: sprite
        ? {
            visible: sprite.visible,
            alpha: sprite.alpha,
            width: sprite.width,
            height: sprite.height,
            x: sprite.x,
            y: sprite.y,
            bounds: spriteRect
              ? {
                  x: Math.round(spriteRect.x),
                  y: Math.round(spriteRect.y),
                  w: Math.round(spriteRect.width),
                  h: Math.round(spriteRect.height),
                }
              : null,
          }
        : null,
      interpretation:
        'visibilityGroupVisible:false means fog is entirely off this frame — rule this theory out. ' +
        'visibilityGroupVisible:true means canvas.visibility (a SIBLING of the suppressed environment ' +
        'group, never touched by applyArtSuppression) is genuinely drawing, and fogSprite.bounds is a ' +
        "REAL rectangle in FOUNDRY's own screen space — compare it against where the ghost visually " +
        "sits. It is drawn through Foundry's own camera, which the VT thrash test never moves, so once " +
        "MSA's independently-thrashed camera diverges from Foundry's, this sprite would appear at the " +
        'wrong scale and place relative to MSA content, immune to MSA eviction, and outside every ' +
        'MSA draw item — matching everything reported so far.',
    };
  });

  // THE OTHER HALF OF THE SEAM (2026-07-17, ghost-hunting). applyArtSuppression
  // only ever touches `canvas.environment` (`primary` + `effects` per
  // MSA_OWNED_GROUPS) — verified against config.mjs, that is where `primary` and
  // `effects` both declare `parent: "environment"`. Every PLACEABLE layer
  // (tiles, tokens, walls, notes, templates, drawings, regions, sounds,
  // lighting) is declared `group: "interface"`, a SIBLING of `environment`
  // under `rendered` — `environmentRenderable:false` says nothing about it,
  // by design (keyhole-interface-seam: "PIXI keeps the CHROME").
  //
  // Each of those layers is a `PlaceablesLayer`, and EVERY `PlaceablesLayer`
  // owns a `.preview` PIXI.Container (placeables-layer.mjs:348) used to draw a
  // LIVE placeable — actual art, not a read-only overlay — during a drag or
  // creation gesture. It is supposed to empty via `clearPreviewContainer()` on
  // drop/cancel (placeables-layer.mjs:427/1185/1194) — but every one of those
  // call sites is reachable through Foundry's OWN pointer handling, which this
  // session's early bug reports ("it leaves a version of the tile behind")
  // describe going wrong under MSA. A stuck preview would be real PIXI content,
  // entirely outside `canvas.environment` AND outside every MSA draw item — so
  // it would render regardless of `environmentRenderable` and regardless of
  // the isolate-draw-item selection. That is a hypothesis, not a diagnosis
  // (feedback_plausible_diagnosis_rots) — this report is the one machine-
  // checked fact that confirms or kills it: a genuinely empty preview on every
  // layer means look elsewhere entirely.
  // CANVAS CENSUS (2026-07-17, ghost-hunting round 2). Three theories are now
  // DEAD by live evidence: Foundry's own art is off (environmentRenderable:
  // false), MSA's sceneColor target clears unconditionally every frame
  // (renderer.autoClear defaults true in three.webgpu.js and nothing in this
  // file touches it — verified against the vendored source, not assumed), and
  // every PlaceablesLayer.preview is empty (totalStuckChildren:0). Isolating
  // any single MSA draw item still shows the ghost.
  //
  // The remaining candidate: not WHAT draws, but HOW MANY THINGS draw.
  // `disposeActive()` (vt-pan-viewer.js:195) removes the old canvas via
  // `_active.canvas.remove()` wrapped in an empty `catch(_){}` — standard
  // practice everywhere else in that function for a teardown step that must
  // not crash the NEXT viewer's startup, but it means a removal that silently
  // failed would leave a canvas element attached forever, frozen at whatever
  // camera state it had the instant its `setAnimationLoop(null)` killed it:
  // static, wrong scale (a stale zoom), wrong place (a stale pan), and
  // genuinely un-evictable (its renderer is dead, not merely off-screen).
  // That matches everything reported so far. This is a hypothesis, not a
  // diagnosis (feedback_plausible_diagnosis_rots) — the census below is the
  // one machine-checked fact that confirms or kills it.
  MapShine.debug.registerReport('vt-canvas-census', 'VT canvas census (orphaned viewer?)', () => {
    const byId = document.querySelectorAll('#msa-vt-pan-viewer-canvas');
    const allCanvases = Array.from(document.querySelectorAll('canvas'));
    return {
      report: 'vt-canvas-census',
      generatedAt: new Date().toISOString(),
      msaCanvasCount: byId.length,
      totalCanvasCount: allCanvases.length,
      msaCanvases: Array.from(byId).map((c) => {
        const r = c.getBoundingClientRect();
        const cs = window.getComputedStyle(c);
        return {
          width: c.width,
          height: c.height,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          zIndex: cs.zIndex,
          display: cs.display,
          opacity: cs.opacity,
          isConnected: c.isConnected,
        };
      }),
      allCanvases: allCanvases.map((c) => ({
        id: c.id || '(no id)',
        width: c.width,
        height: c.height,
        parentId: c.parentElement?.id || '(no id)',
      })),
      interpretation:
        'msaCanvasCount SHOULD be exactly 1 while a viewer is running (0 if stopped). If it is 2+, ' +
        'disposeActive() failed to remove a previous canvas and an ORPHANED, FROZEN viewer instance ' +
        "is sitting in the DOM — that instance's last rendered frame IS the ghost: static, at whatever " +
        'zoom/pan it had when its render loop was killed, invisible to isolate-draw-item and immune to ' +
        'eviction because it belongs to a dead renderer, not the live one. Compare each msaCanvases ' +
        "entry's rect against where the ghost visually sits on screen.",
    };
  });

  MapShine.debug.registerReport('interface-preview-leak', 'Interface previews (stuck drag ghosts?)', () => {
    const PREVIEW_LAYER_NAMES = [
      'tiles',
      'tokens',
      'walls',
      'notes',
      'templates',
      'drawings',
      'regions',
      'sounds',
      'lighting',
    ];
    const layers = {};
    let totalStuckChildren = 0;
    for (const name of PREVIEW_LAYER_NAMES) {
      const layer = typeof canvas !== 'undefined' ? (canvas?.[name] ?? null) : null;
      const preview = layer?.preview ?? null;
      if (!preview) {
        layers[name] = { present: false };
        continue;
      }
      const children = Array.isArray(preview.children) ? preview.children : [];
      totalStuckChildren += children.length;
      layers[name] = {
        present: true,
        childCount: children.length,
        children: children.map((c) => ({
          constructorName: c?.constructor?.name ?? '(unknown)',
          documentId: c?.document?.id ?? null,
          x: c?.x ?? null,
          y: c?.y ?? null,
          width: c?.width ?? null,
          height: c?.height ?? null,
          visible: c?.visible ?? null,
          alpha: c?.alpha ?? null,
          destroyed: c?._destroyed ?? null,
        })),
      };
    }
    return {
      report: 'interface-preview-leak',
      generatedAt: new Date().toISOString(),
      totalStuckChildren,
      layers,
      interpretation:
        'totalStuckChildren:0 across every layer means every PlaceablesLayer.preview is genuinely ' +
        'empty — the ghost is NOT a stuck Foundry drag/creation preview, rule this theory out entirely. ' +
        "Any nonzero childCount is real PIXI content sitting in canvas.interface, drawn at FOUNDRY'S " +
        "own (un-thrashed) screen coordinates, untouched by MSA's cache, its residency, and its " +
        'isolate-draw-item control alike — because it is not an MSA mesh. x/y/width/height are in ' +
        "that layer's local space; compare against where the ghost visually sits on screen.",
    };
  });

  // Shared by pixi-residency-report and stage-gate-baseline below — both need
  // the active scene doc, and boot.js already has this exact `canvas.scene`
  // ternary repeated as ratcheted debt at several other call sites in this
  // file. Routing both through ONE helper, instead of each report inlining
  // its own copy, keeps `foundry/adapter-only`'s ratchet at its current bound
  // rather than growing it by one violation per new report that needs a scene.
  const getActiveSceneDoc = () => (typeof canvas !== 'undefined' ? (canvas.scene ?? null) : null);

  MapShine.debug.registerReport('pixi-residency-report', 'PIXI residency', () => {
    const sceneDoc = getActiveSceneDoc();
    const floorsResult = getActiveSceneFloors(sceneDoc);
    const srcs = floorsResult.ok ? floorsResult.floors.map((f) => f.url) : [];
    return {
      report: 'pixi-residency-report',
      generatedAt: new Date().toISOString(),
      sceneName: sceneDoc?.name ?? null,
      floorsChecked: srcs,
      ...getPixiResidencyReport(srcs),
      interpretation:
        'width/height at or near 1024 (or below) on a real Level background = the proxy took effect. ' +
        'The original real dimensions (e.g. 12000x12000) resident instead = something regressed — flag it.',
    };
  });

  // ---------------------------------------------------------------------------
  // THE STAGE-GATE BASELINE (2026-07-18) — Keyhole.md's infrastructure menu,
  // Track 2 item 5 ("the performance baseline + regression harness") + item 7
  // ("the multi-scene validation matrix"). ONE report serves both: run it once
  // per scene (the torture fixture, Church, Mansion, one non-square multi-floor
  // scene — Keyhole.md §8's own gate scenes) and each run is a row in the
  // matrix; run it on the SAME scene across sessions and it's the regression
  // diff. Nothing here was previously aggregated in one place — this is
  // read-only (calls existing reports/accessors, changes no render behavior),
  // built specifically so the very first session back at a browser can verify
  // everything built blind this session (the pass runner, frame.snapshot,
  // masks.occlusion) in one click instead of ad hoc clicking around.
  //
  // Every gate below is quoted from Keyhole.md §1/§8 directly rather than
  // reinvented — a threshold I misremembered would be worse than no threshold.
  // Anything NOT instrumented reports `available:false` with a reason, never a
  // guessed or zeroed number (doctrine #5, instruments must not lie) — this
  // project's own crash campaign was killed by exactly this kind of honesty.
  MapShine.debug.registerReport('stage-gate-baseline', 'Stage gate baseline (run once per scene)', () => {
    const sceneDoc = getActiveSceneDoc();
    const floorsResult = getActiveSceneFloors(sceneDoc);
    const srcs = floorsResult.ok ? floorsResult.floors.map((f) => f.url) : [];
    const pixi = getPixiResidencyReport(srcs);
    const pixiTotalMB = pixi.available
      ? Math.round((pixi.entries.reduce((sum, e) => sum + (e.approxBytes ?? 0), 0) / (1024 * 1024)) * 10) / 10
      : null;
    const vt = getVtPanViewerDiagnostics();
    const loading = getLoadingScreenState();
    const wholeImageErrors = (vt.wholeImage?.items ?? [])
      .filter((i) => i.error)
      .map((i) => ({ id: i.id, error: i.error }));

    return {
      report: 'stage-gate-baseline',
      generatedAt: new Date().toISOString(),
      sceneName: sceneDoc?.name ?? null,
      sceneId: sceneDoc?.id ?? null,
      floorCount: floorsResult.ok ? floorsResult.floors.length : null,
      viewerActive: vt.active,
      gates: {
        // Stage 2's gate (Keyhole.md §8): "PIXI ≤ 60 MB".
        pixiResidencyMB: { value: pixiTotalMB, gateMaxMB: 60, pass: pixiTotalMB === null ? null : pixiTotalMB <= 60 },
        // Stage 1's gate (Keyhole.md §8): "interactive ≤ 10 s" — reads the
        // last COMPLETED load's total, per load-progress.js's own receipt.
        // null = no load has completed yet this session (reload the scene
        // before running this report, not a bug).
        loadTimeMs: {
          value: loading.lastLoad?.totalMs ?? null,
          gateMaxMs: 10000,
          pass: loading.lastLoad?.totalMs == null ? null : loading.lastLoad.totalMs <= 10000,
          // A load that completes but froze the main thread for seconds is a
          // bug with a receipt, not a pass — check this even if totalMs is fine.
          worstStallMs: loading.lastLoad?.worstStallMs ?? null,
        },
        // Stage 1's gate (Keyhole.md §8): "torture scene pans at 60 fps
        // target / 30 floor". Reported as frame-GAP percentiles in ms
        // (what's actually tracked) rather than converted to fps, so the
        // raw measurement is never silently reinterpreted: 16.7ms ≈ 60fps,
        // 33.3ms ≈ the 30fps floor. Pan/zoom/floor-switch BEFORE running
        // this report — it reads a 300-frame rolling window, not a live sample.
        frameGapMs: vt.hitchStats ?? { available: false, reason: 'viewer not active' },
        // NOT INSTRUMENTED — the original Stage 2 gate ("zero texImage2D >
        // 32ms") was a WebGL-call-level metric from the V2 crash campaign
        // (Forward+.md §13's slowGlOps). V3's upload path is architecturally
        // different (page-atlas uploads via atlas.js, or whole-image via
        // renderer.initTexture — see Keyhole.md's compression section) and
        // has no equivalent per-call timer. Reported honestly absent rather
        // than mapped onto a metric that no longer means the same thing.
        texImage2DOver32ms: {
          available: false,
          reason: 'no V3 equivalent of this V2 WebGL-call-level metric exists yet',
        },
      },
      vramFacts: {
        estTextureVramMB: vt.wholeImage?.estTextureVramMB ?? null,
        packs: vt.layerResidencyTotals?.packs ?? null,
        // Both should read 0 — see their own field-level interpretation
        // text in the Diagnostics report if either is nonzero.
        coarsePinShortfall: vt.layerResidencyTotals?.coarsePinShortfall ?? null,
        coarseReserveMisses: vt.coarsePinBudget?.cacheReserveCheck?.coarseReserveMisses ?? null,
      },
      errors: {
        layerLoadErrors: vt.layerLoadErrors ?? [],
        wholeImageErrors,
      },
      interpretation:
        'Run once per scene (torture fixture, Church, Mansion, one non-square multi-floor scene), ' +
        'copy the JSON, paste it back — that becomes one row of the multi-scene validation matrix ' +
        '(Keyhole.md Track 2 item 7) or, run again later on the SAME scene, the regression diff ' +
        '(item 5). A `pass:null` means "not measured yet" (e.g. reload the scene so loadTimeMs has a ' +
        'completed load to read) — never read null as a failure. `frameGapMs` needs real pan/zoom/' +
        'floor-switch input before this report captures anything meaningful; a scene sitting idle ' +
        'will show a thin or empty sample.',
    };
  });

  // THE INTERFACE SEAM — MSA owns the ART, Foundry's PIXI keeps the CHROME.
  // Registered HERE, at module load, and that is not stylistic: `canvasConfig`
  // fires inside Canvas#initialize, which runs between the "setup" and "ready"
  // hooks (game.mjs:740/763/779), and it is the ONLY chance to make the PIXI
  // canvas transparent — PIXI derives the GL context's immutable `alpha`
  // attribute from backgroundAlpha at context-creation time. Miss it and the
  // canvas is opaque for the whole session. install() runs at esmodule load,
  // long before setup. Full reasoning in foundry/canvas-compositing.js.
  {
    const seam = registerCanvasCompositing();
    if (!seam.registered) log.warn(`interface seam not registered — ${seam.reason}`);
  }

  if (typeof Hooks !== 'undefined') {
    // canvasInit fires strictly BEFORE Foundry loads scene textures (verified
    // in source, client/canvas/board.mjs) — must register proxies here, not
    // later, or Foundry's own load wins the race.
    // THE CURTAIN GOES UP HERE — at canvasInit, the earliest moment we know a
    // scene is being drawn, so there is no window where Foundry looks frozen with
    // nothing on screen explaining why.
    //
    // BUT canvasInit fires for a FLOOR SWITCH too: Scene#view (scene.mjs:280) calls
    // canvas.draw() on `sceneChanged || levelChanged`, and draw() fires canvasInit
    // (board.mjs:1119) and canvasReady (1192) either way. The hook cannot tell them
    // apart — only the scene id can, and it IS available here (board.mjs sets
    // this.#scene and logs its name immediately before firing canvasInit).
    // beginSceneLoad does that comparison and shows nothing on a floor switch,
    // which is §4.5's headline promise and §7's dead level-transition curtain.
    // THE BLANK-CANVAS GAP (audit, 2026-07-17): canvasInit/canvasReady are
    // BOTH skipped entirely when Foundry draws a BLANK canvas (`Scene
    // #unview()`, or the active scene being deleted) — see
    // foundry/canvas-lifecycle.js's header for the full mechanism and why a
    // plain canvasTearDown listener can't just dispose unconditionally
    // (it would defeat the cheap same-scene floor-switch path below). The
    // `Hooks.on` call itself lives in foundry/ (the wall's adapter-only
    // ratchet is already at its bound); `markCovered()` here is a plain
    // function call, not a new Foundry-global touch.
    const tearDownWatchdog = registerCanvasTearDownWatchdog({
      isViewerActive: () => getVtPanViewerDiagnostics().active,
      onOrphaned: () => {
        stopVtPanViewer();
        lastRealSceneId = null;
        endSceneLoad({ error: 'canvas is blank (scene unviewed or deleted)' });
      },
      logInfo: (msg) => log.info(msg),
    });
    if (!tearDownWatchdog.registered) log.warn(`blank-canvas watchdog not registered — ${tearDownWatchdog.reason}`);

    Hooks.on('canvasInit', (canvasRef) => {
      tearDownWatchdog.markCovered(); // this draw is real — see foundry/canvas-lifecycle.js
      try {
        const sceneDoc = canvasRef?.scene ?? null;
        const verdict = beginSceneLoad({ sceneId: sceneDoc?.id ?? null, sceneName: sceneDoc?.name });
        if (!verdict.shown) log.info(`loading screen suppressed — ${verdict.reason}`);
      } catch (err) {
        // A broken curtain must never block a scene load.
        log.error(`loading screen failed to start:`, err);
      }
    });

    Hooks.on('canvasInit', async (canvasRef) => {
      try {
        await registerFloorProxies(canvasRef?.scene ?? null);
      } catch (err) {
        log.error(`VRAM severance — canvasInit proxy registration failed:`, err);
      }
    });

    // canvasReady fires once the scene is actually drawn — verified in source
    // (client/documents/scene.mjs's Scene#view(): canvas.draw() runs on
    // EITHER a full scene change OR a floor/level switch within the same
    // scene, both of which reach canvasReady) — so this single hook keeps the
    // VT viewer synced to whatever Foundry itself currently considers the
    // viewed scene+floor, automatically, without a separate floor-switch path.
    //
    // TWO DIFFERENT COSTS for two different events, deliberately NOT the same
    // path (this is the fix for a real live bug, 2026-07-15 — see
    // startVtPanViewer's `initialFloorIndex` doc for the full symptom/root-
    // cause trace): a genuine SCENE change needs a full (re)start
    // (startRealSceneViewer — new atlas, new page cache, the works). A
    // same-scene FLOOR switch — which also reaches this handler, per the
    // source citation above — only needs `setVtPanViewerFloor`, the same cost
    // as a keyboard floor-switch keypress. Calling the expensive path for the
    // cheap event was the actual crash: repeated full 512MB-atlas
    // reallocation on ordinary floor toggles.
    let lastRealSceneId = null;
    // DOCUMENT CRUD -> redraw. The draw list is derived from live Foundry
    // documents, but nothing was watching them: updateResidency only re-asks
    // buildItems when the VIEW changes, so a token created while the camera sat
    // still never appeared (author-reported 2026-07-16).
    //
    // THE LIST MUST MATCH buildItems, AND IT DID NOT (author-reported
    // 2026-07-17: "I can move a tile and it's clearly moving the document but
    // it's not currently updating the tile's position when I release it... it
    // only updates when I pan or zoom and it leaves a version of the tile
    // behind"). buildItems is `collectSceneLayers(...)` + `collectTokens(...)`,
    // i.e. Level art AND Tiles AND Tokens — but only Token was watched. So a
    // moved tile kept its MSA art at the old spot while Foundry's interface
    // chrome (its frame and handles, which PIXI still draws) sat at the new
    // one: the "version left behind" is our stale art beside Foundry's
    // correctly-moved selection frame. Nothing was wrong with the renderer; it
    // was simply never told.
    //
    // DERIVED FROM THE COLLECTORS' OWN DECLARATIONS, not a list remembered here
    // — `buildItems` is exactly `collectSceneLayers` + `collectTokens`, and each
    // declares the document types it reads right beside itself. A list kept in
    // boot.js is a list that drifts away from the thing it describes, which is
    // the whole mechanism of this bug (and the reason `tools/run-tests.mjs`
    // discovers suites off disk rather than reading a hand-kept array).
    //
    // Foundry's own hook names are the authority: `Hooks.callAll(`update${type}`)`
    // where type is the documentName — verified in the v14 source at
    // client/data/client-backend.mjs:159/327/451 (create/update/delete).
    const DRAW_LIST_DOCUMENTS = [...SCENE_LAYER_DOCUMENTS, ...TOKEN_DOCUMENTS];

    // THE MASK AUTHORITY'S item set follows the scene-layer half of the same
    // declared document list (tokens never participate in cover, and
    // re-collecting on every token move would be pure waste). It PIGGYBACKS on
    // redrawOn's existing hook registration rather than registering its own —
    // deliberately: a separate Hooks.on + a `canvas.scene` read here was two
    // new foundry/adapter-only violations, and the wall (correctly) refused
    // the ratchet. The hook handler already RECEIVES the changed document, and
    // an embedded document's `.parent` IS its Scene — no global needed.
    const MASK_AUTHORITY_HOOKS = new Set(
      SCENE_LAYER_DOCUMENTS.flatMap((doc) => ['create', 'update', 'delete'].map((verb) => `${verb}${doc}`))
    );
    const refreshMaskAuthorityItems = (hook, sceneDoc) => {
      try {
        if (!sceneDoc) return;
        const floorsResult = getActiveSceneFloors(sceneDoc);
        if (!floorsResult.ok) return;
        const levelIds = floorsResult.floors.map((f) => f.id).filter(Boolean);
        // Kept in `coverItems` too, so the viewer's cover-alpha priming
        // (`getCoverItems`) sees a newly-created upper-floor background at the
        // same moment the authority does — one list, one refresh, no drift.
        maskAuthority.setItems(
          (coverItems = collectSceneLayers(sceneDoc, {
            viewedLevelId: levelIds[0],
            visibleLevelIds: levelIds,
            isGM: true,
          }).items)
        );
      } catch (err) {
        log.error(`mask-authority item refresh failed on ${hook}:`, err);
      }
    };

    const redrawOn = (hook) => {
      Hooks.on(hook, (doc) => {
        // Fire-and-forget: a redraw must never make a document update await GPU
        // work, and a failed redraw must not break Foundry's own bookkeeping.
        // The hook NAME is passed through: diagnostics' documentSync.byHook is
        // how "which hook actually fired" gets answered from a report.
        refreshVtPanViewerItems(hook).catch((err) => log.error(`${hook} redraw failed:`, err));
        if (MASK_AUTHORITY_HOOKS.has(hook)) refreshMaskAuthorityItems(hook, doc?.parent ?? null);
      });
    };
    for (const doc of DRAW_LIST_DOCUMENTS) {
      for (const verb of ['create', 'update', 'delete']) redrawOn(`${verb}${doc}`);
    }

    // MOVEMENT IS NOT AN ORDINARY UPDATE IN v14 — it has its own hook family,
    // and CRUD alone does not cover it (author-reported 2026-07-17: "when I move
    // a token it clearly moves in the document but it only updates... once I pan
    // the camera or zoom"). The instrument said a hook fired and the position
    // was unchanged, so the position lands somewhere other than where we looked.
    //
    // v14 fires these from `TokenDocument.#onUpdateOperationMovement`
    // (client/documents/token.mjs:2880/2883), reached via the static
    // `_onUpdateOperation` — which client-backend.mjs runs at line 339, AFTER
    // the per-document `updateToken` callbacks at line 333. So these fire
    // strictly LATER in the same operation, once the movement is applied and
    // frozen. That ordering is the whole reason they can catch what updateToken
    // apparently could not.
    //
    //   moveToken  - a movement with passed waypoints was applied
    //   stopToken  - movement was constrained/halted partway (final rest position)
    //   pauseToken - movement paused (token.mjs:868)
    //
    // A redundant refresh is FREE — refreshItemPlacement compares a placementKey
    // and returns false when nothing moved, so catching the same move twice
    // costs one string build and no GPU work. Cheap enough that covering the
    // whole family beats guessing which single one is authoritative.
    for (const hook of ['moveToken', 'stopToken', 'pauseToken']) redrawOn(hook);

    Hooks.on('canvasReady', async (canvasRef) => {
      try {
        const sceneDoc = canvasRef?.scene ?? null;
        if (!sceneDoc) return;
        MapShine.__painter?.hydrateFromScene(); // pull any painted masks saved on this scene
        // THE SKY, RE-RESOLVED FOR THIS SCENE — `canvas.scene` did not exist at
        // `init` (where the setting itself gets registered), so this is the
        // first point a per-scene override can actually be read. Also the right
        // place for a later scene SWITCH: a scene with its own sky must apply
        // its own sky the moment it becomes active, not whatever the previous
        // scene (or the world default) happened to leave behind.
        try {
          resolveAndApplySky();
        } catch (err) {
          log.error('sky resolve (canvasReady) failed:', err);
        }
        const floorsResult = getActiveSceneFloors(sceneDoc);
        if (!floorsResult.ok) {
          log.warn(`real-scene VT viewer: ${floorsResult.error}`);
          // THE ZOMBIE-VIEWER GAP (audit, 2026-07-17): this branch used to just
          // warn and return, leaving whatever viewer was already running — built
          // for the PREVIOUS scene — rendering on, now slaved to THIS scene's
          // camera (followFoundryCamera reads canvas.stage every frame
          // regardless of which scene it was built for), with the loading
          // curtain (if beginSceneLoad's canvasInit handler raised one for this
          // draw) stuck up forever, since nothing here ever called
          // endSceneLoad(). "This scene has no art MSA can render" is ALWAYS a
          // genuine scene change — getActiveSceneFloors doesn't depend on the
          // viewed floor, so a same-scene floor switch can never land here —
          // which means stopping unconditionally is always correct and can
          // never defeat the cheap floor-switch path below.
          stopVtPanViewer();
          lastRealSceneId = null;
          endSceneLoad({ error: floorsResult.error });
          return;
        }
        const targetFloorIndex = resolveFloorDescriptor(sceneDoc, floorsResult.floors);

        if (lastRealSceneId === sceneDoc.id && getVtPanViewerDiagnostics().active) {
          // A floor switch. No curtain was raised for it and none is lifted —
          // beginSceneLoad already declined, so there is nothing here to undo.
          // "Floor changes without loading screens" is this branch existing.
          // Re-point the marker overlay at the newly-active floor's candles.
          updateActiveFloorContext(floorsResult.floors, targetFloorIndex);
          // Re-scope door graphics to the newly-active floor (its levelId now
          // sits in activeFloorContext); the viewer reaps the old floor's leaves.
          refreshDoors();
          const result = await setVtPanViewerFloor(targetFloorIndex);
          log.info(`real-scene VT viewer synced to floor ${targetFloorIndex} (same scene).`, result);
          syncInterfaceSeam('floor switch');
          return;
        }

        lastRealSceneId = sceneDoc.id;
        const result = await startRealSceneViewer(targetFloorIndex);
        if (result.ok === false) {
          log.warn(`real-scene VT viewer did not start:`, result.error);
          endSceneLoad({ error: result.error });
          return;
        }
        log.info(`real-scene VT viewer active for "${result.sceneName}" at floor ${targetFloorIndex}.`);

        // LIFT ONLY WHEN THERE IS SOMETHING TO SEE. startVtPanViewer has resolved,
        // so every coarse pin is resident and the render loop is armed — but no
        // frame has PAINTED yet. Waiting one frame is the difference between
        // "Ready" being true and being the §7 "Ready!" lie under a new name.
        beginSceneLoadPhase(LOAD_PHASES.FIRST_FRAME);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        // ONLY NOW hand the art over. MSA has painted a real frame, so
        // suppressing Foundry's `primary`/`effects` swaps one picture for
        // another instead of leaving a hole. Suppressing earlier — or while the
        // PIXI canvas is still opaque — is the one state worse than doing
        // nothing at all: no art from EITHER renderer, with selection borders
        // floating over a void. applyArtSuppression refuses on its own if the
        // canvas is not verifiably transparent; this is just the right MOMENT.
        syncInterfaceSeam('scene load');

        const summary = endSceneLoad();
        if (summary) {
          // worstStallMs is surfaced, not swallowed: a load that completes but
          // froze the main thread for seconds is a bug with a receipt.
          log.info(
            `scene load complete in ${summary.totalMs}ms` +
              (summary.worstStallMs > 0 ? ` (worst main-thread stall: ${summary.worstStallMs}ms)` : ''),
            summary
          );
        }
      } catch (err) {
        log.error(`real-scene VT viewer auto-sync failed:`, err);
        endSceneLoad({ error: String(err?.message || err) });
      }
    });
  }

  // MapShine.soak(n) drives the TORTURE FIXTURE specifically (Keyhole's own
  // Stage-1-gate harness — a controlled, known-content soak, not whatever
  // scene happens to be open). NOTE: inside a real running Foundry world, the
  // canvasReady hook above will usually have already started the REAL-scene
  // viewer before soak(n) runs, so `load`'s own "only if not already active"
  // guard means soak(n) run live now typically exercises the SAME already-
  // running real-scene instance, not the synthetic fixture — a real, worth-
  // flagging change in what "MapShine.soak(n)" measures inside a live world.
  // The Stage-1-gate soak run was captured before this session's default-on
  // change (see keyhole-stage-status memory) and remains valid.
  MapShine.soakHooks.load = async () => {
    if (!getVtPanViewerDiagnostics().active) {
      await startVtPanViewer({
        THREE,
        buildItems: buildTortureItems, // soak the castle-courtyard worst case: all 3 floors composited
        dimensions: tortureDimensions,
        floorCount: TORTURE_FLOOR_COUNT,
        extraLayersForItem: tortureExtraLayers, // soak the FULL layer stack (albedo + masks), not albedo alone
      });
    }
  };
  MapShine.soakHooks.pan = (i) => soakPanStep(i);
  MapShine.soakHooks.switchFloor = (i) => soakSwitchFloorStep(i);
  MapShine.soakHooks.zoom = (i) => soakZoomStep(i);

  log.info(
    `%c${TAG}%c ${STAGE} — new tree live, legacy quarantined. Three r${THREE.REVISION} / WebGL2.` +
      ` Soak harness ready: MapShine.soak(n).`,
    'color:#8fd6ff;font-weight:bold',
    'color:inherit'
  );

  // Foundry defines its globals before loading module esmodules, so `Hooks` is
  // available here. If we are somehow loaded outside Foundry, fall back to the
  // window load event so the boot proof still renders.
  if (typeof Hooks !== 'undefined') {
    Hooks.once('init', () => {
      log.info(`init — ${MODULE_ID}`);
      // Register every effect's cascade settings (client profile + a11y, and a
      // GM-default + player-override enable per effect), DERIVED from the registry
      // so a new effect gets its settings for free (the velocity test). game.
      // settings is touched only inside the foundry adapter. Any settings change
      // re-resolves the cascade — the render state follows the settings, never a
      // hand-written mirror (the ~140 sync functions V2 needed cease to exist).
      try {
        registerSettings(MODULE_ID, describeEffectSettings(effectRegistry.list()), {
          onChange: () => {
            // EVERY registered effect re-resolves on any settings change — the
            // render state follows the settings, never a hand-written mirror.
            // "Every" is now literal: it walks EFFECT_REAPPLIERS rather than a
            // hand-listed six, which is what let bloom, water, fluid, specular
            // and window light miss this trigger entirely.
            reapplyAll('settings change');
          },
        });
      } catch (err) {
        log.error('MSA settings registration failed:', err);
      }

      // THE SKY SETTING (2026-07-23) — registered here, in the SAME `init`
      // hook as the effect-settings cascade above, rather than a second
      // `Hooks.once('init', ...)` of its own: `foundry/adapter-only` ratchets
      // every literal `Hooks.*` call in this file, and a second registration
      // would be a genuine new violation of the "boot.js is not the adapter"
      // rule, not just a number to bump. `resolveAndApplySky` (defined above,
      // where the astrolabe panel is built) is a closure — it does not need to
      // be textually below this point to be safely called from it, only for
      // Foundry to fire `init` after `install()` has finished running, which
      // it always does.
      try {
        registerSkySettings({ onChange: resolveAndApplySky });
      } catch (err) {
        log.error('sky settings registration failed:', err);
      }

      // THE LEFT-PALETTE BUTTON (author request, 2026-07-20). One toggle tool
      // for both GM and player — whether it shows the full shell or just
      // Settings is decided inside the panel itself (debug-panel.js's own
      // isGM() check), never by a second button. `MapShine.debug` already
      // exists by this point (installDebugPanel runs before any hook), so no
      // "not ready yet" guard is needed here. `onVisibilityChange` keeps the
      // toolbar's highlight honest when the panel closes ITSELF (its own
      // Close button, or the GM default-open on boot) rather than via a click
      // on this exact tool.
      registerControlPanelButton({
        isActive: () => MapShine.debug.isPanelVisible(),
        onToggle: (active) => {
          if (active) MapShine.debug.showPanel();
          else MapShine.debug.hidePanel();
        },
      });
      MapShine.debug.onVisibilityChange((visible) => syncControlPanelButtonState(visible));
    });
    Hooks.once('ready', () => {
      bootHeartbeat().catch((err) => log.error('bootHeartbeat failed:', err));
      // Resolve EVERY effect through the FULL cascade from the now-readable
      // settings. Each resolves to whatever its manifest's `enabledFromProfile`
      // and the GM/player overrides say — an effect gated above the active
      // profile lands OFF, one gated at 'low' (bloom) lands ON. Failures are
      // announced per effect and never swallowed
      // (`feedback_instruments_must_not_lie`); the resolver itself is total and
      // cannot throw on data.
      reapplyAll('ready');
    });
  } else {
    log.warn(`no Foundry Hooks found; booting on window load.`);
    if (document.readyState === 'complete') bootHeartbeat();
    else window.addEventListener('load', () => bootHeartbeat(), { once: true });
  }
}

/**
 * Stage 0 proof-of-life: a dedicated MSA overlay canvas rendering a slowly
 * spinning, vertex-colored triangle through the new Three. It sits bottom-right,
 * click-through (`pointer-events:none`), so Foundry's UI stays fully usable while
 * the author imports the torture fixture and runs the soak harness.
 *
 * Deliberately its OWN canvas, not Foundry's — entangling with Foundry's canvas is
 * the adapter's job (src/foundry/), which lands in Stage 2+. Stage 0 only proves
 * the renderer boots.
 */
/**
 * Hand Foundry's art over to MSA, once MSA is confirmed to be painting.
 * Idempotent — `canvasReady` fires for both a scene change and a floor switch,
 * and Foundry's own group teardown/redraw could plausibly reset `renderable`,
 * so this re-asserts on every one rather than trusting a remembered state.
 *
 * Refusal is NOT failure: applyArtSuppression defaults to leaving Foundry
 * rendering whenever it cannot verify the PIXI canvas is transparent, and says
 * so loudly. That is the safety slide, and a table that can play beats a pretty
 * renderer that cannot.
 */
function syncInterfaceSeam(context) {
  const seam = applyArtSuppression();
  if (seam.applied) {
    log.info(
      `interface seam active (${context}) — MSA owns primary+effects (the art); ` +
        `Foundry's PIXI keeps interface (selection, grid, walls, controls) on top.`
    );
  }
  // Re-sync the "Renderer" dropdown (and any other control) against reality
  // NOW — this is the exact moment environmentRenderable can flip. Without
  // this the debug panel's FIRST paint (registered during boot, before any
  // scene has loaded) shows whatever was true at that early instant, and
  // nothing ever repaints it (see refreshControls' own doc). Called
  // unconditionally, not just on seam.applied — a REFUSED suppression is
  // also a real state change the dropdown must reflect (Foundry's art is
  // genuinely still showing then).
  MapShine.debug?.refreshControls?.();
  return seam;
}

async function bootHeartbeat() {
  if (MapShine.__heartbeat) return; // idempotent
  try {
    const host = document.createElement('div');
    host.id = 'msa-keyhole-boot';
    // Sits clear of Foundry's right-hand sidebar (author-reported overlap,
    // 2026-07-16 — the sidebar is ~300px and this used to land on top of the
    // scene directory). `right: 320px` parks it just left of the sidebar rather
    // than under it.
    Object.assign(host.style, {
      position: 'fixed',
      right: '320px',
      bottom: '12px',
      width: `${HEARTBEAT_W}px`,
      zIndex: '90', // above Foundry board, below its notifications
      pointerEvents: 'none',
      fontFamily: 'Signika, sans-serif',
      color: '#cfe8ff',
      textShadow: '0 1px 2px #000',
      userSelect: 'none',
    });

    // Visually hidden on purpose (see HEARTBEAT_CANVAS_PX's own doc) — still a
    // real canvas the renderer submits real frames to every tick.
    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '1px',
      height: '1px',
      opacity: '0',
      overflow: 'hidden',
    });

    // THE HUD — FPS leads (author, 2026-07-20: "I want access to FPS
    // information"), a couple of always-useful lines follow, and a "More" door
    // opens onto everything else ("I'd like access to lots of information in a
    // panel") without the generic module blurb sitting there uninvited every
    // frame — the same progressive-disclosure shape as the control panel's own
    // Advanced View / accordions, applied one level up.
    const hud = document.createElement('div');
    Object.assign(hud.style, {
      fontSize: '11px',
      lineHeight: '1.4',
      fontFamily: 'ui-monospace, Consolas, monospace',
      letterSpacing: '0.02em',
    });
    const fpsLine = document.createElement('div');
    Object.assign(fpsLine.style, { fontSize: '18px', fontWeight: '700' });
    const midLines = document.createElement('div');
    Object.assign(midLines.style, { marginTop: '2px', opacity: '0.85' });

    const moreToggle = document.createElement('button');
    moreToggle.type = 'button';
    moreToggle.textContent = '▾ more';
    Object.assign(moreToggle.style, {
      pointerEvents: 'auto',
      marginTop: '4px',
      background: 'transparent',
      border: 'none',
      padding: '0',
      font: '10px/1.2 Signika, sans-serif',
      color: '#8fd6ff',
      opacity: '0.75',
      cursor: 'pointer',
      letterSpacing: '0.03em',
    });
    const moreLines = document.createElement('div');
    Object.assign(moreLines.style, { marginTop: '3px', opacity: '0.8', display: 'none' });
    let moreOpen = false;
    moreToggle.addEventListener('click', () => {
      moreOpen = !moreOpen;
      moreLines.style.display = moreOpen ? 'block' : 'none';
      moreToggle.textContent = moreOpen ? '▴ less' : '▾ more';
    });

    hud.append(fpsLine, midLines, moreToggle, moreLines);
    host.appendChild(canvas);
    host.appendChild(hud);
    document.body.appendChild(host);

    // Same raised WebGPU texture cap as the VT viewer (vt/texture-limits.js) —
    // so this renderer's device, which the flight recorder reports, agrees with
    // the one that draws the map. Awaited before construction; the heartbeat is
    // fire-and-forget so the one adapter round-trip costs nothing that matters.
    const requiredLimits = await resolveRendererRequiredLimits();
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, alpha: true, requiredLimits });
    renderer.setPixelRatio(1);
    renderer.setSize(HEARTBEAT_CANVAS_PX, HEARTBEAT_CANVAS_PX, false);
    renderer.setClearColor(0x000000, 0);
    // The node renderer must init() before it will draw. Fire-and-forget: the
    // heartbeat is a liveness indicator, and a heartbeat that blocks boot to
    // report that boot is alive would be a poor sort of heartbeat.
    renderer.init().catch((err) => log.error(`heartbeat renderer init failed:`, err));

    // An EMPTY scene, deliberately — still a real render submission every frame
    // (see HEARTBEAT_CANVAS_PX's doc for why that still matters), just nothing
    // left to look at now that the HUD says the same thing in numbers.
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 3.2);

    // Frame-gap sampling on the HEARTBEAT's own loop. Deliberately independent of
    // the VT viewer's instrumentation: this loop keeps running even when the VT is
    // stopped, has failed, or was never started, so it reports the health of the
    // MAIN THREAD rather than of any one subsystem. A stall here is a stall
    // everywhere, whoever caused it.
    const gaps = [];
    let lastT = null;
    let worstGapMs = 0;
    renderer.setAnimationLoop((t) => {
      renderer.render(scene, camera);

      // THE BLACK BOX'S FRAME FEED. Same loop, same `t`, for the same reason the
      // readout below uses it: this is the MAIN THREAD's cadence, and it keeps
      // reporting when the VT is stopped, failed, or never started. The recorder
      // keeps three views of it — a histogram over every frame, a 1-in-N
      // timeline, and every hitch — so the export can answer "what was the frame
      // rate like" without either storing 200k frames or sampling the hitches
      // away. The panel's live readout stays as it is: it answers "right now",
      // which is a different question from "what happened".
      MapShine.flight?.recordFrame(t);

      if (lastT !== null) {
        const gap = t - lastT;
        gaps.push(gap);
        if (gaps.length > 120) gaps.shift();
        if (gap > worstGapMs) worstGapMs = gap;
      }
      lastT = t;

      // Repaint the numbers ~4x/sec — often enough to read, rare enough that the
      // monitor never becomes the thing worth monitoring.
      if (gaps.length && Math.floor(t / 250) !== hud.__lastTick) {
        hud.__lastTick = Math.floor(t / 250);
        const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const fps = avg > 0 ? 1000 / avg : 0;
        const recentWorst = Math.max(...gaps);
        const vt = getVtPanViewerDiagnostics();
        const warn = recentWorst > 50 ? '#ffb4b4' : '#cfe8ff';

        fpsLine.innerHTML = `<span style="color:${warn}">${fps.toFixed(0)} fps</span>`;

        const midRows = [
          `gap ${avg.toFixed(1)}ms (worst ${recentWorst.toFixed(0)}) · all-time ${worstGapMs.toFixed(0)}ms`,
        ];
        if (vt?.active) {
          const c = vt.cacheStats;
          midRows.push(
            `VT ${vt.renderMode} · ${vt.itemsLoaded} items · mip ${vt.mip?.requested ?? '?'}`,
            `pages ${c.residentPages}/${c.capacityPages} · miss ${c.misses} · evict ${c.evictions}`
          );
        } else {
          midRows.push('VT: not running');
        }
        midLines.innerHTML = midRows.join('<br>');

        // THE "MORE" DOOR — the generic module blurb lives here now instead of
        // being always on screen (author, 2026-07-20: "lots of information on it
        // which isn't useful since it's just generic module information"), plus
        // whatever else is worth a glance without opening the Lab's own reports.
        const backend = renderer.backend?.isWebGPUBackend ? 'WebGPU' : renderer.backend ? 'WebGL2' : 'unknown';
        const adapterDesc = renderer.backend?.adapter?.info?.description;
        const heap = performance.memory?.usedJSHeapSize;
        const moreRows = [
          `v${MapShine.version ?? VERSION} · ${STAGE}`,
          `Three r${THREE.REVISION} · ${backend}${adapterDesc ? ` (${adapterDesc})` : ''}`,
        ];
        if (typeof heap === 'number') moreRows.push(`JS heap: ${(heap / 1048576).toFixed(0)}MB`);
        moreRows.push('Full reports: control panel → 🔬 Lab');
        moreLines.innerHTML = moreRows.join('<br>');
      }
    });

    MapShine.__heartbeat = { host, renderer, scene, camera };
    MapShine.__soakWatch?.(canvas); // count any WebGL context loss on the boot canvas
    MapShine.debug?.attachPanel(host); // the control panel lives in the same corner box
    log.info(`boot heartbeat rendering. Gate "boot renders" ✔`);
  } catch (err) {
    // Doctrine #1: fail LOUD, never silently. No V2 fallback exists to hide behind.
    log.error(`boot heartbeat FAILED — the new renderer did not come up:`, err);
    const banner = document.createElement('div');
    Object.assign(banner.style, {
      position: 'fixed',
      right: '12px',
      bottom: '12px',
      padding: '10px 14px',
      zIndex: '90',
      pointerEvents: 'none',
      background: 'rgba(60,0,0,0.85)',
      color: '#ffd9d9',
      font: '12px/1.4 Signika, sans-serif',
      borderRadius: '8px',
      border: '1px solid rgba(255,120,120,0.5)',
    });
    banner.textContent = `${TAG} renderer failed to boot — see console.`;
    document.body.appendChild(banner);
  }
}
