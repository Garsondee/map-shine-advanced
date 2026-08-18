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
import { installFlightRecorder, downloadText } from './diag/flight-recorder.js';
import { createPerfLab, runSweep, runSweepStructuralAB } from './diag/perf-lab.js';
// ALBEDO CLARITY STRUCTURAL A/B (2026-08-15) — deliberately imported DIRECTLY
// here rather than threaded through perf-session.js/buildPerfReport the way
// perf-structural-ab.js's own runStructuralAB is: runProfileSession runs up
// to 3 times per perf-run-full call, so following that exact path would mean
// 12+ viewer restarts. Called once, as its own Phase 4, after every sweep in
// the perf-run-full action body below. See that file's own header.
import { runSharpeningAB } from './diag/perf-sharpening-ab.js';
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
import { buildPerfReport, summarizeTierComparison, formatOffenderSummaryText } from './diag/perf-report.js';
import { buildVramInventory } from './diag/vram-inventory.js';
import { buildPerfStripModel } from './diag/perf-strip.js';
import { createFrameProfiler } from './diag/frame-profiler.js';
import { assembleReckoningReport, summarizeZoneRows } from './diag/reckoning-report.js';
import { createProfiledFrameWaiter, createSceneSettleWaiter, runProfileSession } from './diag/perf-session.js';
// The benchmark route drives the EXISTING camera-path player rather than growing
// a second motion system — a fixed route is what makes two runs comparable.
import {
  generatePresetKeyframes,
  normalizeCameraPath,
  playCameraPath,
  stopCameraPath,
  isCameraPathPlayingCapped,
} from './foundry/index.js';
import { buildLiveSceneExport, sceneExportFilename } from './foundry/index.js';
// THE TOKEN-VISION DIAGNOSTIC — see its own module header, and the
// `token-vision` report registration below.
import { readTokenVisionDiagnostic } from './foundry/index.js';

/**
 * The benchmark route's duration. 60s at a steady traverse (author, 2026-07-28)
 * — long enough that virtual-texture residency, bakes and any slow leak all get
 * a chance to show up, and long enough that no single unlucky frame can dominate
 * the averages. The profiler's gap ring is sized to hold the whole run.
 */
const BENCHMARK_SWEEP_MS = 60000;
/**
 * The rapid-diagonal STRESS sweep's own duration (rapid-diagonal-stress-
 * 2026-08-12, author's own spec: "a much more rapid 5 second sweep to top
 * right"). Deliberately far shorter than BENCHMARK_SWEEP_MS above and
 * covering the map's longest possible traverse (corner to corner, both axes
 * at once) — the point is maximum residency/paging pressure per second, not
 * a representative cruise. Read this phase's hitches/p99 frame time, never
 * its mean, the same "sparse work is not a per-frame cost" discipline
 * perf-report.js already applies elsewhere.
 */
const RAPID_STRESS_SWEEP_MS = 5000;
/**
 * How long to watch AFTER the scripted rapid sweep above ends before giving up
 * (rapid-pan-hitch-2026-08-12, chasing the author's own report: "when the
 * rapid camera pan happens in the test it always results in a hitch that
 * lasts for 10 seconds or so"). The OLD `measureUntil: playing3` stopped
 * measuring the instant the scripted movement finished — exactly when, per
 * that report, the real trouble starts. ~3x the author's own reported ~10s
 * felt duration: enough to see recovery genuinely finish rather than clip the
 * read at an arbitrary boundary, without waiting anywhere near
 * `DEFAULT_SETTLE_WAIT_TIMEOUT_MS` (240s) — that timeout is sized for a
 * genuine cold floor load (multi-floor's own phase, above), a different
 * question from "how long does a pan-triggered hitch take to resolve".
 */
const RAPID_STRESS_RECOVERY_TIMEOUT_MS = 30000;
/**
 * A fixed floor UNDER every event-driven wait in this action
 * (multi-floor-hitch-2026-08-12, author's own report: "when the performance
 * sweep goes up a floor it encounters a hitch which is entirely to do with
 * loading... add at least 5 seconds of pause before carrying out any
 * action"). `waitForSceneSettled` can genuinely report "settled" — nothing
 * left in the trackers it knows how to poll — while a first-frame shader/
 * pipeline compile for content the new floor just made visible is still
 * queued; this is a deliberate belt-and-suspenders margin on TOP of that
 * event-driven wait, never a replacement for it. Applied before every
 * phase's camera sweep starts moving.
 */
const MIN_ACTION_PAUSE_MS = 5000;
/**
 * The SAME margin, sized specifically for a floor change (author's own
 * number: "something like 15 seconds"). Chained AFTER `waitForSceneSettled`
 * resolves — a floor switch is exactly the action the author's report named
 * as the hitch's source, so it gets a larger floor than
 * `MIN_ACTION_PAUSE_MS` alone. Applied to BOTH floor switches this action
 * performs: the forward switch (Phase 2) and the restore switch back to the
 * original floor (Phase 2's own finally, before Phase 3 starts) — the
 * restore is a real floor load too, not a free no-op.
 */
const FLOOR_CHANGE_SETTLE_BUFFER_MS = 15000;

/**
 * How often the scene-load hold re-asks whether the scene is ready.
 *
 * The same 250ms `diag/perf-session.js`'s own settle waiter uses, and a
 * deliberate reuse rather than a second constant meaning the same thing: two
 * numbers that both answer "how often do we check if the scene has settled"
 * are two numbers that will eventually disagree
 * ([[feedback_probed_constants_vs_derived]]). Fine-grained next to the
 * multi-second stages being watched, and cheap — each poll is one object read
 * of the LAST settle sample, never a fresh measurement.
 */
const READY_POLL_MS = 250;
/** Plain fixed-duration wait — no clock read, just a timer (time/one-clock
 * is about READING the current time, which this never does). @param {number} ms */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
import { wallClockMs } from './core/frame-clock.js';
import { validateCue, validateCueStack, orderedCues, cueToFadePatch } from './core/cues-schema.js';
import { validateImpulseList } from './core/impulse-schema.js';
import {
  ambientVectorFromWind,
  phaseBoundaryHours,
  resolveSky,
  applySkyEdit,
  computeSun,
  WIND_DEFAULT_GUSTINESS01,
  CALENDARS,
  CALENDAR_IDS,
  projectWorldTime,
  // THE FADE ENGINE (U2, docs/holy/UI-Testament.md §4.2) — pure core +
  // registry. mergeFadeState/pruneExpired/computeEasedValue/isEntryExpired
  // are the per-tick pump's own math; createFadeSourceRegistry is the door
  // that lets the weather board (this checkpoint's one real consumer) and
  // any future effect (a later checkpoint's) become fadeable without this
  // file learning a new name each time.
  mergeFadeState,
  pruneExpired,
  computeEasedValue,
  isEntryExpired,
  createFadeSourceRegistry,
  WEATHER_ARCHETYPES,
} from './world/index.js';
import {
  runVtLiveDecodeTest,
  startVtPanViewer,
  stopVtPanViewer,
  getVtPanViewerDiagnostics,
  getVtPanViewerRenderTargets,
  setVtPanViewerFloor,
  prepareVtPanViewerFloor,
  // The orchestration below never calls this directly — `prepareFloor`
  // already self-invalidates any prepare it supersedes (every call bumps its
  // own generation counter). It is imported for `ui/floor-transition.js`'s
  // Cancel button: the one caller with a genuine "the author decided to stay
  // on this floor, not switch to another" to express.
  cancelVtPanViewerFloorPrepare,
  prewarmVtPanViewerAdjacentFloors,
  setVtPanViewerGpuProbe,
  setVtPanViewerGpuZoneTimer,
  getVtPanViewerGpuZoneStatus,
  readVtPanViewerRenderInfo,
  readVtPanViewerDrawCallsOnly,
  readVtPanViewerTriangleCountOnly,
  getVtPanViewerPipelineStats,
  readVtPanViewerFrameSamples,
  setVtPanViewerWindOverlay,
  setVtPanViewerWindOverlayResolution,
  setVtPanViewerWindDiagnosticParticles,
  setVtPanViewerWindGusts,
  setVtPanViewerWindAmbient,
  setVtPanViewerWindGustiness,
  getVtPanViewerFireStatus,
  setVtPanViewerSunHour,
  sweepVtPanViewerTimeOfDay,
  setVtPanViewerTimeRate,
  setVtPanViewerTimeMode,
  getVtPanViewerTimeDialState,
  getVtPanViewerTodHour,
  setVtPanViewerSkyRealism,
  setVtPanViewerGradeEnvStrength,
  setVtPanViewerCloudCover,
  setVtPanViewerWeatherArchetype,
  setVtPanViewerWeatherMode,
  setVtPanViewerWeatherBiome,
  setVtPanViewerWeatherVolatility,
  setVtPanViewerWeatherSeed,
  getVtPanViewerWeatherForecast,
  unpinVtPanViewerWeatherAxis,
  addVtPanViewerWeatherEvent,
  releaseVtPanViewerWeatherEvent,
  removeVtPanViewerWeatherEvent,
  getVtPanViewerWeatherActiveEvents,
  setVtPanViewerWeatherTargets,
  setVtPanViewerPrecipKind,
  getVtPanViewerPrecipitationStatus,
  setVtPanViewerPrecipitationTuning,
  rebakeVtPanViewerWindField,
  triggerVtPanViewerWindDoorImpulse,
  forceVtPanViewerLightningStrike,
  resetVtPanViewerFrameStats,
  setVtPanViewerIsolateItem,
  getVtPanViewerDrawListIds,
  getVtPanViewerGeometryComposition,
  getVtPanViewerIsolateItemId,
  runZoomThrashTest,
  soakPanStep,
  soakSwitchFloorStep,
  soakZoomStep,
  refreshVtPanViewerItems,
  runOrientationSelfTest,
  runSceneDepthSelfTest,
  getParticleReadback,
  getSourceBitmap,
  releaseSourceBitmap,
  readPageBitmapPixels,
  resolveRendererRequiredLimits,
  setDarknessRealism,
  getDarknessRealism,
  setAlbedoClarity,
  getAlbedoClarity,
  resetAlbedoClarity,
  ALBEDO_CLARITY_PARAMS,
  setVtPanViewerAlbedoClarityForce,
  getVtPanViewerAlbedoClarityForce,
  setUiShadow,
  getUiShadow,
  sampleVtPanViewerIllumPixel,
  probeVtPanViewerPixels,
  runInteractiveVtPanViewerPixelProbe,
  probeVtPanViewerWindAndParticles,
  runInteractiveVtPanViewerWindProbe,
  setVtPanViewerDebugFirstRenderProbe,
  setVtPanViewerDebugForceMaskNodeOff,
  setVtPanViewerDebugForceOpaqueBlendOff,
  setVtPanViewerShaderRebuildProbe,
  getVtPanViewerShaderRebuilds,
  setVtPanViewerPipelineRebuildProbe,
  getVtPanViewerPipelineRebuilds,
  getVtPanViewerVegetationProxyCacheStats,
  getVtPanViewerPointLightWallClipCacheStats,
  getVtPanViewerPointLightMeshPoolStats,
  getVtPanViewerPoolStats,
  getVtPanViewerDoorPoolStats,
  getVtPanViewerWindBakeStats,
  getPyramidStoreStats,
  getCompressedTextureStats,
  setVtPanViewerEarlyZComposition,
  getVtPanViewerEarlyZComposition,
  getVtPanViewerReckoningCensus,
  setVtPanViewerPointLightBatching,
  getVtPanViewerPointLightBatching,
  setVtPanViewerPointLightMrtMerge,
  getVtPanViewerPointLightMrtMerge,
  getVtPanViewerSceneSettle,
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
  shouldAutoIgnite,
  stableUnit01,
  LIGHTNING,
  LIGHTNING_PARAMS,
  FIRE,
  FIRE_PARAMS,
  extractFiresWithLabels,
  fireMaskSignature,
  extractFireSpawnPoints,
  DOOR_GRAPHICS,
  VEGETATION,
  VEGETATION_PARAMS,
  BLOOM,
  BLOOM_PARAMS,
  BLOOM_PRESETS,
  bloomPreset,
  DEPTH_OF_FIELD,
  DOF_PARAMS,
  DOF_PRESETS,
  dofPreset,
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
  resolveAnchorElevationWorldUnits,
  groupLightningAnchorsIntoSources,
  defaultLightningElevation,
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
  getPixiProxyStats,
  urlsToEvictOnSceneChange,
  registerCanvasCompositing,
  applyArtSuppression,
  restoreFoundryArt,
  getCanvasCompositingReport,
  getFoundryRendererCensus,
  setExploredFogBase,
  getExploredFogBase,
  registerCanvasTearDownWatchdog,
  registerSettings,
  readSetting,
  writeSetting,
  registerControlPanelButton,
  syncControlPanelButtonState,
  registerAnchorViewModeButton,
  syncAnchorViewModeButtonState,
  registerStudioButton,
  syncStudioButtonState,
  registerRemoteButton,
  syncRemoteButtonState,
  registerPlayerButton,
  syncPlayerButtonState,
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
  readFadeState,
  writeFadeState,
  watchFadeState,
  readCueStack,
  writeCueStack,
  watchCueStack,
  registerCalendarSetting,
  installActiveCalendar,
  standDownPf2eDarknessSync,
  buildAlmanacDiagnosticsReport,
} from './foundry/index.js';
import { engageFoundryFallback, getDescribeRenderModeStats } from './diag/render-fallback.js';
import { buildSettingsPanel } from './diag/settings-panel.js';
import { registerMarkerSource, getAllMarkerPoints } from './diag/marker-overlay.js';
import {
  beginSceneLoad,
  beginSceneLoadPhase,
  reportSceneLoadProgress,
  reportSceneLoadBlockers,
  shouldStopWaitingForReady,
  endSceneLoad,
  getLoadingScreenState,
  resetLoadingSceneMemory,
} from './ui/loading-screen.js';
import { LOAD_PHASES } from './ui/load-progress.js';
import {
  installPainter,
  openCameraPathDialog,
  installAnchorMode,
  installAnchorViewMode,
  createAstrolabe,
  buildAstrolabeDial,
  showPerfProgress,
  hidePerfProgress,
  formatPerfProgressText,
  beginFloorTransition,
  updateFloorTransitionProgress,
  endFloorTransition,
  installStudio,
  installRemote,
  installPlayer,
} from './ui/index.js';
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
  createSectionStore,
} from './diag/effect-controls.js';
import {
  createWaterSeams,
  createWaterRegistration,
  WATER,
  WATER_PARAMS,
  WATER_DIALS,
  WATER_DEBUG_CHANNELS,
  WATER_PRESETS,
  waterPreset,
  createFluidSeams,
  createFluidRegistration,
  FLUID_PARAMS,
  createSpecularSeams,
  createSpecularRegistration,
  SPECULAR_PARAMS,
  SPECULAR_LAYER_PARAMS,
  SPECULAR_LAYER_DEFAULTS,
  SPECULAR_DEBUG_CHANNELS,
  createWindowSeams,
  createWindowRegistration,
  WINDOW_PARAMS,
  WINDOW_DEBUG_CHANNELS,
  createApertureGoboRegistration,
  APERTURE_GOBO_PARAMS,
  APERTURE_GOBO_DEBUG_CHANNELS,
  // PRECIPITATION (P1) — the species table + its response model. The
  // SUBSYSTEM is deliberately not imported yet: it has no draw pass to hang
  // on until the sky-reach gate lands (LAW 3), and importing a factory nobody
  // calls is the same unwired-seam debt in a different coat.
  PRECIP_SPECIES,
  PRECIP_SPECIES_IDS,
  resolveSpecies,
  resolveSpeciesFrame,
} from './effects/index.js';
import {
  buildSunShadowsReport,
  buildWaterBodyReport,
  buildWaterHealthReport,
  buildSpecularReport,
  buildWindowLightReport,
} from './diag/effect-status-reports.js';
import { getParamHealth } from './diag/param-read-health.js';
import { beginUiTick, endUiTick } from './diag/ui-perf.js';

const MODULE_ID = 'map-shine-advanced';

/** Boot-heartbeat host box width. Historically sized the standalone perf HUD that
 * used to render here directly; that HUD is now diag/perf-strip.js, mounted inside
 * the control panel (which sets its own explicit width) — this now only sizes the
 * host box itself, left as-is since the box's positioning (`right: 320px` below)
 * was tuned against a real author-reported overlap with Foundry's sidebar. */
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
/**
 * multi-floor-sweep-2026-08-12 — the SECOND floor's complete `perf-profile`
 * report from the last multi-floor run, held here for the same reason
 * `lastAllTiersReports` is: `lastPerfProfile` stays the PRIMARY floor's full
 * report (so a single-floor scene's shape never changes), and this is the
 * escape hatch for the rare "show me everything about the second floor too"
 * ask — `MapShine.getMultiFloorReport()` — without paying for a second run.
 */
let lastMultiFloorSecondReport = null;
/**
 * rapid-diagonal-stress-2026-08-12 — the rapid diagonal stress sweep's
 * complete `perf-profile` report from the last run, same escape-hatch
 * posture as `lastMultiFloorSecondReport` right above:
 * `MapShine.getRapidStressReport()`.
 */
let lastRapidStressReport = null;

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
// ALBEDO CLARITY (2026-07-28, author-requested tuning surface; real UI added
// 2026-08-15 — "Sharpening" card, Make panel): the zoom-out sharpness repair.
// `MapShine.setAlbedoClarity({ sharpness, gateLo, gateHi, farLo, farHi,
// farFloor, enabled })` — every field optional, takes effect on the next
// frame with no reload (the uniforms are shared across every item on screen);
// `enabled:false` zeroes the visible contribution instantly but only compiles
// the taps back out on the NEXT material build (see shouldUseFullAlbedoClarity
// in vt-pan-viewer.js). `getAlbedoClarity()` reports the live values plus
// whether they are bound to a built material yet; `resetAlbedoClarity()`
// restores the shipped defaults. See vt/albedo-clarity.js's own header for
// the full design account.
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
// V4-TESTAMENT STAGE 0 (2026-08-10) — three measurement-only debug flags, the
// SAME "MapShine.xxx = wrapperReachingModuleLevel_active" shape as the wind
// probe above. Discovered the hard way: `startVtPanViewer`'s OWN returned
// object (where these three setters are defined) is never itself spread onto
// MapShine anywhere — only captured locally as a scene-load report/result, or
// merged into a debug REPORT's return value (`vt-pan-viewer-start-real-scene`)
// — so a method living only in that returned object is invisible to
// `MapShine.xxx()` unless it ALSO gets one of these explicit wrappers. See
// setVtPanViewerDebugFirstRenderProbe's own doc in vt-pan-viewer.js.
MapShine.setDebugFirstRenderProbe = setVtPanViewerDebugFirstRenderProbe;
MapShine.setDebugForceMaskNodeOff = setVtPanViewerDebugForceMaskNodeOff;
MapShine.setDebugForceOpaqueBlendOff = setVtPanViewerDebugForceOpaqueBlendOff;
// THE EXPLORED-FOG WASH (Bug #21) — MSA owns the look of explored-but-unseen
// regions now that Foundry no longer re-renders the map to produce it. This is a
// LOOK knob, not an on/off: the suppression itself is unconditional and has no
// flag (author's rule, 2026-08-15). `MapShine.setExploredFogBase('#404040')`,
// or `{r,g,b}`, or 0xRRGGBB; darker = explored areas read dimmer.
MapShine.setExploredFogBase = setExploredFogBase;
MapShine.getExploredFogBase = getExploredFogBase;
// SHADER-REBUILD PROBE — arm, pan, read. See setVtPanViewerShaderRebuildProbe's
// own doc in vt-pan-viewer.js for the console workflow.
MapShine.setShaderRebuildProbe = setVtPanViewerShaderRebuildProbe;
MapShine.getShaderRebuilds = getVtPanViewerShaderRebuilds;
// PIPELINE-REBUILD PROBE — arm, pan, read. See setVtPanViewerPipelineRebuildProbe's
// own doc in vt-pan-viewer.js for the console workflow.
MapShine.setPipelineRebuildProbe = setVtPanViewerPipelineRebuildProbe;
MapShine.getPipelineRebuilds = getVtPanViewerPipelineRebuilds;
// STAGE 1's revert flag — "shade every pixel once"
// (docs/planning/Stage-1-Shade-Once.md). Default OFF until its pixel-diff and
// bench gates pass; kept afterwards as the permanent revert (Testament Law 5).
MapShine.setEarlyZComposition = setVtPanViewerEarlyZComposition;
MapShine.getEarlyZComposition = getVtPanViewerEarlyZComposition;
// PIPELINE HEALTH (2026-08-09, see getVtPanViewerPipelineStats's own header)
// — was only reachable through a full perf-run-full capture before now.
// Console-exposed directly (2026-08-11) so "did renderer.info.programs grow
// during this one pan" is a one-line check, the same weight as
// getEarlyZComposition's own transition counters — no armed profiler
// session needed, this just reads renderer.info straight through.
MapShine.getPipelineStats = getVtPanViewerPipelineStats;
// STAGE 2's revert flag — point-light batching (S2.4,
// docs/planning/Point-Light-Batching-Design.md). Default OFF; nothing reads
// it yet (S2.5, pool integration, is its first real consumer).
MapShine.setPointLightBatching = setVtPanViewerPointLightBatching;
MapShine.getPointLightBatching = getVtPanViewerPointLightBatching;
// S2.15's revert flag — point-light illum/coloration MRT merge (Performance-
// Audit-2026-08.md §3.1). Default OFF; `pointLights.mergedScene` stays
// permanently empty until S2.16 wires real bucket membership, so this flag
// alone cannot change a pixel yet — see its own declaration in vt-pan-
// viewer.js for the full reasoning.
MapShine.setPointLightMrtMerge = setVtPanViewerPointLightMrtMerge;
MapShine.getPointLightMrtMerge = getVtPanViewerPointLightMrtMerge;
// Console-exposed directly (2026-08-12, S2.7) so a pixel-diff gate can prove
// NON-VACUITY without paying for a full perf-run-full capture — illumBuckets/
// colorBuckets `.size` answers "did batching actually admit any lights this
// frame", the same weight as getEarlyZComposition's own tile counters. Was
// already reachable through cache-report's cacheStats snapshot (boot.js's
// `pointLightMeshPools` field); this is the same function, just also given
// its own door.
MapShine.getPointLightMeshPoolStats = getVtPanViewerPointLightMeshPoolStats;
// SCENE SETTLE (2026-08-11, author: the 12k² upper floor "takes an extremely
// long time to appear which causes confusion for you and me... we currently
// don't correctly track when the system is actually finished loading"). ONE
// call, answered from real outstanding-work counters instead of a stopwatch,
// and it names what it is still waiting for. See vt/settle.js.
MapShine.getSceneSettle = getVtPanViewerSceneSettle;
/**
 * IS THIS SCENE SAFE TO LOOK AT AND SAFE TO PLAY? — the one public readiness
 * signal, and the thing every "wait for it" in this project should ask.
 *
 * A thin, stable name over `getSceneSettle()`, which is where the rule actually
 * lives. It exists as its own door for two reasons:
 *
 *   1. `settled` is a word about STREAMING; `ready` is the question everyone
 *      downstream is actually asking, including the Playwright harness, which
 *      currently answers it with `waitForTimeout(8000)` after a comment
 *      admitting the module-booted flag *"only confirms the MODULE booted"*.
 *      Every hard-coded sleep in `tests/` is a guess standing in for this call.
 *   2. It gives the readiness contract a name that does not move if the
 *      implementation does.
 *
 * `waitingFor` is always populated when `ready` is false — an unfinished wait
 * that cannot say what it is waiting for is a stopwatch with extra steps.
 */
MapShine.getSceneReady = () => {
  const s = getVtPanViewerSceneSettle();
  return {
    ready: s?.settled === true,
    waitingFor: s?.waitingFor ?? ['the viewer has not started'],
    blockers: s?.blockers ?? [],
    // Which criteria were actually evaluated vs never measured — so a caller
    // can tell a passed check from an absent one
    // ([[feedback_absent_zone_row_is_a_measurement]]).
    criteria: s?.criteria ?? null,
    unavailable: s?.unavailable ?? [],
    quietForMs: s?.quietForMs ?? 0,
    sampledAtMs: s?.sampledAtMs ?? null,
  };
};
// WORLD-DRAW COMPOSITION (2026-08-12, Testament Track B.1) — geometry.worldDraw
// is one opaque renderer.render() call with no internal timing seam (see
// getGeometryComposition's own doc in vt-pan-viewer.js). This names what's
// actually IN the 13 draws / 266k triangles by item kind, without timing any
// of it — the cheap, safe first step before pointing WebGPU Inspector at
// whatever this flags as heaviest.
MapShine.getGeometryComposition = getVtPanViewerGeometryComposition;
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
// ⚠️ CORRECTED 2026-08-16 — there IS a weather owner now (`world/weather.js`,
// Weather-Manager.md), and `setCloudCover` is one of its real write paths, not
// a lever over an acknowledged gap: it sets the manager's `cloudCover01`
// TARGET and the ease ships it there for real, same as the astrolabe's Cloud
// slider. There is still no CALENDAR (nothing auto-evolves cloud cover over
// time — that is the Almanac's job, see the levers just below), so `todHour`
// remains genuinely hand-set. This note used to say neither lever was real;
// that stopped being true the day the weather owner shipped and nobody came
// back to fix the comment (`feedback_plausible_diagnosis_rots`, applied to
// documentation rather than a diagnosis this time). With them, the whole
// atmospheric ladder is still checkable the same way it always was: 6.5 →
// long soft shadows, 12 → short crisp ones, cloud 0.9 → almost none.
MapShine.setSunHour = setVtPanViewerSunHour;
MapShine.setCloudCover = setVtPanViewerCloudCover;
MapShine.setWeatherArchetype = setVtPanViewerWeatherArchetype;

// THE ALMANAC'S CONSOLE LEVERS (slice 3) — console-first, the same posture the
// two levers just above shipped under before either had real UI:
// `MapShine.setWeatherMode('almanac')` then `MapShine.setWeatherBiome('desert')`
// is enough to watch a whole climate walk itself with no astrolabe control yet
// built for either. `getWeatherForecast(hoursAhead)` is read-only and touches
// no live state at all — safe to call from the console just to look.
MapShine.setWeatherMode = setVtPanViewerWeatherMode;
MapShine.setWeatherBiome = setVtPanViewerWeatherBiome;
MapShine.setWeatherVolatility = setVtPanViewerWeatherVolatility;
MapShine.setWeatherSeed = setVtPanViewerWeatherSeed;
MapShine.getWeatherForecast = getVtPanViewerWeatherForecast;
MapShine.unpinWeatherAxis = unpinVtPanViewerWeatherAxis;

// EVENTS (slice 4, Weather-Manager.md §6) — console-first, same posture as the
// Almanac's own levers just above. `MapShine.addWeatherEvent({kind:'ash-storm'})`
// is enough to watch cloud cover/type roll in with no astrolabe control built
// for it yet. See `world/weather-events.js`'s own header for exactly which of
// the 9 built-ins move a pixel this slice (only `ash-storm` — the rest need
// slice 5/6's machinery).
// PRECIPITATION (P1, docs/planning/Precipitation.md) — console-first, the same
// posture every weather lever above shipped under.
//
// ⚠️ `MapShine.setPrecip(0.8)` MOVES A REAL AXIS TODAY but does not yet draw a
// single drop: the FALL runtime is built and shader-lab-verified, and the
// remaining gap is LAW 3's sky-reach gate (rain must be unrepresentable
// indoors), declared as a seam in `graph/passes.js`. The axis is live now
// because the weather manager owns it and `steady-rain` on the astrolabe shelf
// already sets it — `MapShine.getPrecipitation()` reports exactly that state
// rather than letting "I set it and nothing happened" look like a bug.
MapShine.setPrecip = (v) => setVtPanViewerWeatherTargets({ precip01: v });
MapShine.setTemperature = (v) => setVtPanViewerWeatherTargets({ temperature01: v });
MapShine.setPrecipKind = setVtPanViewerPrecipKind;
/**
 * Every factor deciding whether a drop is visible right now — the live status,
 * plus the species table for reference. Reach for this FIRST when rain is not
 * appearing: it names which of `enabled` / `precip01` / species / sky-gate /
 * `liveCount` is the zero, rather than leaving a bisect
 * (`feedback_count_silent_preconditions`).
 */
MapShine.getPrecipitation = () => ({
  ...getVtPanViewerPrecipitationStatus(),
  species: PRECIP_SPECIES_IDS,
  table: PRECIP_SPECIES,
  resolveSpecies,
  resolveSpeciesFrame,
});
/** Live look dials — the ones the shader lab sweeps. */
MapShine.setPrecipitationTuning = setVtPanViewerPrecipitationTuning;

MapShine.addWeatherEvent = addVtPanViewerWeatherEvent;
MapShine.releaseWeatherEvent = releaseVtPanViewerWeatherEvent;
MapShine.removeWeatherEvent = removeVtPanViewerWeatherEvent;
MapShine.getWeatherActiveEvents = getVtPanViewerWeatherActiveEvents;

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
  // THE STUDIO (U1, docs/holy/UI-Testament.md §5, §9) — the new LANTERN
  // Studio shell, side-by-side with the panel above during rollout. Takes
  // `MapShine.debug` explicitly (never a global read — see shell.js's own
  // doc) so its LAB department can mount the SAME reports/actions/panels
  // registry `installDebugPanel` just built, and so its rail can gate LAB
  // on the same `isGM()` the old panel already uses.
  //
  // The CUES ctx functions below are closure references, not eager reads —
  // installStudio() itself runs NOW, but cueStack/fadeSourceRegistry/the
  // cue engine functions are all declared further down this SAME install()
  // body. Safe because shell.js only calls dept.render() (and therefore
  // only invokes these) on an actual user click into the CUES tab, long
  // after install() has finished running once — the identical pattern
  // installRemote's own weatherBoard ctx already uses just below.
  // THE IMPULSES (U7, docs/holy/UI-Testament.md §9, §4.4) — declared ONCE,
  // consumed identically by the Remote's curated TR corner (installRemote,
  // below) and the Studio's full list (CUES department) — Law 1's "every
  // control is a generated projection of a declaration", never two hand-
  // built button sets that could quietly disagree about what exists. `fire`
  // closes over `MapShine.strikeLightning`/`.gustWind` by NAME rather than
  // capturing the function value here — both are assigned later in this
  // same install() body, safe because neither button is clickable until
  // long after install() has finished running once (the same closure-
  // reference safety every other ctx function passed to installStudio/
  // installRemote below already relies on).
  // Order matches the mock's own #cornerTR exactly (strike, thunder, gust —
  // bolt/cloud/wind, 2026-08-18 fix): this is the ONE shared declaration
  // both the Remote's corner and the Studio's CUES list render off, so
  // reordering it here re-orders both surfaces identically rather than
  // patching a per-surface display order.
  const IMPULSES = [
    {
      id: 'strike',
      label: 'Strike',
      icon: 'bolt',
      // lightning.js's own manifest declares a11y.photosensitive:true —
      // this is what the (still-planned) suppression badge would watch.
      flashClass: true,
      fire: () => MapShine.strikeLightning(),
    },
    {
      id: 'thunder',
      label: 'Thunder',
      icon: 'cloud',
      status: 'planned',
      plannedReason:
        'No audio subsystem exists anywhere in this codebase yet (checked before building, not assumed) — Thunder has nothing real to trigger.',
    },
    {
      id: 'gust',
      label: 'Gust',
      icon: 'wind',
      fire: () => MapShine.gustWind(),
    },
  ];
  // Fail loud at boot, not silently at first click — the same discipline
  // `setWater`'s own unknown-key check already applies to a runtime write,
  // applied here to a declaration instead. A typo'd status value or a
  // future duplicate id is caught the moment this module loads.
  {
    const check = validateImpulseList(IMPULSES);
    if (!check.ok) log.error('IMPULSES failed validateImpulseList:', check.errors);
  }

  MapShine.__studio = installStudio({
    debugPanel: MapShine.debug,
    impulses: IMPULSES,
    listCues: () => orderedCues(cueStack),
    captureCue: (name) => captureCueFromLive(name),
    updateCueFadeMs: (id, overMs) => updateCueFadeMs(id, overMs),
    moveCueOrder: (id, direction) => moveCueOrder(id, direction),
    testFireCue: (id) => testFireCue(id),
    revertCueTest: () => revertCueTest(),
    isCueTestActive: () => isCueTestActive(),
    validateCue: (cue) => validateCue(cue, fadeSourceRegistry.typeOf),
    // THE PAINTER DEPARTMENT (U4) — same closure-reference safety as CUES
    // above. armBrush reuses paintAffordance's own onAdd rather than
    // re-deriving which mask kind to open on, so the tile grid and the
    // EFFECTS department's own 🖌 card button (water's, today) can never
    // disagree about which kind a given effect opens.
    listPaintableEffects: () => listPaintableEffects(),
    armBrush: (effectId) => paintAffordance(effectId)?.onAdd?.(),
    // THE SYSTEM DEPARTMENT (U5) — getSystemPanelCtx is declared much
    // further down install() (it closes over PROFILE_CHOICE_LIST/
    // ENABLE_CHOICE_LIST, built right next to the old settings panel's own
    // registration) — the identical closure-reference safety every other
    // ctx function on this call already relies on.
    getSystemPanelCtx: () => getSystemPanelCtx(),
  });
  // THE REMOTE (U2, docs/holy/UI-Testament.md §4, §9) — side-by-side with
  // both the old panel and the Studio. Every callback below is a closure
  // reference, not an eager read — installRemote() itself runs NOW (this
  // eager point in install()), but the Remote's own shell.js defers calling
  // any of them until the room's first open(), by which point
  // buildAstrolabeOptions/skyScope/editSky (all declared further down this
  // same closure) are fully initialized. See shell.js's own header for why
  // that deferral exists at all.
  MapShine.__remote = installRemote({
    impulses: IMPULSES,
    // 2026-08-18 fix (author report: "the astrolabe looks completely
    // different... the CSS and layout are not the same yet") — the Remote
    // gets its OWN dial, matching the approved mock for real, instead of
    // `createAstrolabe()`'s pre-LANTERN styling (see astrolabe-dial.js's
    // own header for the full story). The old debug panel keeps
    // `createAstrolabe()` unchanged, several lines below — a real,
    // side-by-side split, not a replacement.
    mountAstrolabeDial: (container) => {
      remoteAstrolabe = buildAstrolabeDial({
        onTimeChange: (hour, committed) => {
          setVtPanViewerSunHour(hour);
          if (committed) void editSky({ todHour: hour });
        },
      });
      container.appendChild(remoteAstrolabe.root);
    },
    getPosture: () => skyScope.sky?.mode,
    // The Clock-mode pill (2026-08-18 fix) — exactly the old astrolabe.js
    // instance's own `onTimeModeChange` (see its own registerPanel call
    // below), the SAME editSky path, not a second one.
    onSetMode: (mode) => void editSky({ mode }),
    // Play/pause IS the rate (astrolabe-panel.js's own note) — 'playing'
    // means whatever the current rate is, is non-zero.
    isFlowPlaying: () => (skyScope.sky?.rateHoursPerMinute ?? 0) > 0,
    onFlowToggle: () => {
      const current = skyScope.sky?.rateHoursPerMinute ?? 0;
      if (current > 0) {
        lastNonZeroRateHoursPerMinute = current;
        void editSky({ rateHoursPerMinute: 0 });
      } else {
        void editSky({ rateHoursPerMinute: lastNonZeroRateHoursPerMinute || 1 });
      }
    },
    // The TL corner's speed badge (2026-08-18 fix) — real TIME_RATE_STEPS,
    // the SAME editSky path the old debug panel's own rate slider already
    // writes through, not a second speed vocabulary. Reads the REMEMBERED
    // rate, not the raw live one: production's single-field model uses 0
    // itself to mean "paused" (unlike the mock's own two-field state, which
    // keeps speed and play/pause fully independent), so showing the live
    // value verbatim would flash the badge to a meaningless fallback on
    // every pause instead of the speed flow will actually resume at.
    getFlowRate: () => {
      const live = skyScope.sky?.rateHoursPerMinute ?? 0;
      return live > 0 ? live : lastNonZeroRateHoursPerMinute || 1;
    },
    onSetFlowRate: (rate) => {
      lastNonZeroRateHoursPerMinute = rate;
      void editSky({ rateHoursPerMinute: rate });
    },
    // THE WEATHER BOARD (U2 checkpoint 3) — every field below is a closure
    // reference to state/functions declared further down this SAME install()
    // body (fadeSourceRegistry, fadeWeatherToArchetype, skyScope, editSky).
    // Safe for the identical reason mountAstrolabeDial above already is:
    // nothing here EXECUTES until the Remote's body actually renders, well
    // after install() has finished defining everything once.
    weatherBoard: {
      getWeatherMode: () => (skyScope.sky?.weatherMode === 'almanac' ? 'almanac' : 'director'),
      onWeatherModeChange: (mode) => void editSky({ weatherMode: mode }),
      getWeatherBiome: () => skyScope.sky?.weatherBiome ?? null,
      onWeatherBiomeChange: (id) => void editSky({ weatherBiome: id }),
      getWeatherArchetype: () => skyScope.sky?.weatherArchetype ?? 'custom',
      fadeToArchetype: (archetypeId, overMs) => fadeWeatherToArchetype(archetypeId, overMs),
      getAxisValue: (axisName) => fadeSourceRegistry.readLive(`weather.${axisName}`),
      onAxisCommit: (axisName, value) => void editSky({ [axisName]: value, weatherArchetype: 'custom' }),
    },
    onBaseline: (overMs) => fadeWeatherToBaseline(overMs),
    // THE CUE DECK (U3) — same closure-reference safety as weatherBoard
    // just above. fireCue is the ONLY mutation the deck itself calls
    // (GO / a jump-list click); capture/reorder/test-fire are the CUES
    // department's own job (installStudio above), never the Remote's.
    cueDeck: {
      listCues: () => orderedCues(cueStack),
      fireCue: (id) => fireCueById(id),
    },
    // THE DEBUG ROW (2026-08-18 fix) — fps/ms/vram/sparkline are PUSHED by
    // bootHeartbeat() straight into MapShine.__remote.updateDebugStrip(), not
    // pulled through this ctx (that standalone top-level function has no
    // lexical access to install()'s own locals, unlike weatherBoard/cueDeck's
    // closures above). Only the two real, one-line MapShine.* actions live
    // here.
    debugStrip: {
      onProbe: () => void MapShine.armPixelProbe(3),
      onExport: () => void MapShine.flight?.export(),
    },
  });
  // THE PLAYER ROOM (U5, docs/holy/UI-Testament.md §5.5) — safe to construct
  // unconditionally for every client, GM or not (its own header explains
  // why: unlike Studio/Remote, nothing inside it is ever GM-only). Same
  // closure-reference safety as installStudio's own getSystemPanelCtx above.
  MapShine.__player = installPlayer({ getSystemPanelCtx: () => getSystemPanelCtx() });
  // The in-app painter (tier 0): registers its "🖌️ Paint _Fire" action on the
  // debug panel and returns a hydrate hook the canvasReady handler calls to pull
  // any saved paint for the newly-loaded scene (docs/planning/Authoring-and-Distribution.md).
  // `onFloorChanged` closes the gap `syncActiveFloorContext`'s own header
  // describes: the painter's Floor stepper drives `setVtPanViewerFloor`
  // directly and has no other way to keep fire/candle/lightning/doors
  // pointed at the floor it just switched to.
  // THE BRUSH→RENDER BRIDGE's boot.js half (2026-08-18) — every in-app
  // painted layer, fed straight to maskAuthority.ingestPaintedMask so the
  // SAME lazy recompute every other mask consumer already relies on picks
  // it up on its own next read (fire/water/window/specular/fluid/
  // vegetation all already read maskAuthority.getDerived(kindId,
  // floorIndex) — none of them needed a single line changed for this).
  function ingestPaintedLayers(layersByKey) {
    for (const [key, layer] of Object.entries(layersByKey ?? {})) {
      const sep = key.lastIndexOf('::');
      if (sep === -1) continue;
      const kindId = key.slice(0, sep);
      const floorIndex = Number(key.slice(sep + 2));
      if (!Number.isFinite(floorIndex)) continue;
      try {
        maskAuthority.ingestPaintedMask(floorIndex, kindId, layer);
      } catch (err) {
        log.error(`painted-mask ingest failed for '${key}':`, err);
      }
    }
  }
  MapShine.__painter = installPainter(MapShine, {
    onFloorChanged: syncActiveFloorContext,
    onLayersChanged: (layersByKey) => ingestPaintedLayers(layersByKey),
  });
  // ANCHOR MODE (2026-07-22) — click-to-place/click-to-edit for discrete point
  // effects (candles today). Installed once, entered per-effect via the
  // Workshop panel below; stays effect-agnostic (ui/anchor-mode.js's own header).
  MapShine.__anchorMode = installAnchorMode(MapShine);
  // ANCHOR VIEW MODE (2026-08-06) — the read/toggle sibling: see EVERY
  // anchor at once (on or off) and right-click to flip one. Installed once,
  // entered from its own scene-controls button below (ui/anchor-view-mode.js
  // header explains why this is a separate file from anchor-mode.js above).
  MapShine.__anchorViewMode = installAnchorViewMode(MapShine);

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
  // SCENE SETTLE — "has the map finished appearing, and if not, what is it
  // still waiting for?" Registered as a report so the author can read it from
  // the debug panel during a slow cold load instead of guessing at a loading
  // screen that clears early, and so every capture script can poll ONE thing
  // rather than sleeping a guessed number of seconds. See vt/settle.js.
  MapShine.debug.registerReport('scene-settled', 'Scene settled? (real load completion)', () =>
    getVtPanViewerSceneSettle()
  );
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

  // SCENE-DEPTH SELF-TEST (docs/planning/Depth-Buffer.md) — the same "real
  // pixels, real chain" discipline as the orientation self-test above,
  // aimed at vt/scene-depth.js instead: allocates a real depthTexture-
  // backed target through ThreeAllocator, writes three known ranks through
  // the real depth-writer material, and queries it back through the real
  // formula a future light's own occlusion gate will use — with no drawn
  // geometry of its own to sample a reference point from. This is what
  // makes vt/scene-depth.js a genuinely reachable, genuinely exercised
  // module rather than a file nothing calls.
  MapShine.debug.registerAction('scene-depth-self-test', 'Scene-depth self-test', async () => ({
    report: 'scene-depth-self-test',
    generatedAt: new Date().toISOString(),
    ...(await runSceneDepthSelfTest()),
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

  /** Fire READOUT — same posture as `candleReadout` just above. */
  let fireReadout = { enabled: false, servedCount: 0, params: null, perfTier: null };

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
  /** Depth-of-field READOUT — same seed posture as bloom's own, above, and
   * for the identical reason: the manifest already says `enabledFromProfile:
   * 'low'`, so a `false` seed would misrepresent the window between
   * construction and the first cascade resolve. `EFFECT_REAPPLIERS` (below)
   * is what actually closes that window at boot. */
  let dofReadout = { enabled: true, params: null };
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

  /**
   * Re-resolve `activeFloorContext` (+ door scoping) for an EXPLICIT floor
   * index, reading the CURRENT scene's own floor list fresh.
   *
   * ⚠️ EXISTS BECAUSE `setVtPanViewerFloor` HAS NO IDEA THIS CONTEXT EXISTS.
   * It is `vt/`'s own cheap residency-swap, entirely unaware of boot.js's
   * `activeFloorContext` — by design, the same seam that keeps `vt/` from
   * reaching the anchor authority directly. The ONLY caller that already kept
   * `activeFloorContext` correct was the native `canvasReady` same-scene
   * branch below, which calls `updateActiveFloorContext` + `refreshDoors`
   * itself, inline, before its own `setVtPanViewerFloor` call. Every OTHER
   * direct caller of `setVtPanViewerFloor` (`ui/paint-mode.js`'s own Floor
   * stepper) moved the live view without ever telling boot.js which floor was
   * now active — so `getFireRenderState`'s `activeFloorContext?.floorIndex`
   * (and candle/lightning's anchor filtering, and door scoping) stayed
   * pinned to whatever floor was active when `canvasReady` last ran, while
   * the painter's own `state.floor` moved on ahead of it. Reported live,
   * 2026-08-12: painting/viewing a floor above the one MSA last natively
   * synced to kept showing THAT floor's fire, and the new floor's own
   * painted `_Fire` region never ignited — this is that gap, closed once
   * here so every future direct `setVtPanViewerFloor` caller can just call
   * this alongside it instead of re-deriving the two-call sequence.
   */
  function syncActiveFloorContext(floorIndex) {
    const sceneDoc = canvas?.scene ?? null;
    if (!sceneDoc) return;
    const floorsResult = getActiveSceneFloors(sceneDoc);
    if (!floorsResult.ok) return;
    updateActiveFloorContext(floorsResult.floors, floorIndex);
    refreshDoors();
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

  // FIRE — the vertical slab integral (docs/planning/Fire.md), through the SAME
  // one door. Anchor-driven like the candle, and additionally mask-driven: the
  // painted fire region's own width sets each blob's diameter, which then sets
  // its puff rate, plume height, turbulence and light radius with no further
  // authoring (that half is a later phase; anchors serve today).
  effectRegistry.register(FIRE, (resolved) => {
    const served = resolved.enabled ? anchorAuthority.anchorsForEffect('fire', activeFloorContext) : [];
    fireReadout = {
      enabled: resolved.enabled,
      servedCount: served.length,
      params: resolved.params,
      perfTier: resolved.perfTier,
    };
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

  // DEPTH OF FIELD — MSA's SECOND post-processing effect, through the SAME
  // one door. Same shape as bloom's own registration just above: a
  // whole-image screen pass with no anchor/item of its own, so `apply` only
  // refreshes the shared readout the viewer's runPostDofPass reads each frame
  // (see getDofRenderState below).
  effectRegistry.register(DEPTH_OF_FIELD, (resolved) => {
    dofReadout = { enabled: resolved.enabled, params: resolved.params };
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

  /** Transient, in-memory depth-of-field param tuning (MapShine.setDof / the
   * FOH-ROH card / a preset pick). Mirrors bloomLiveOverride exactly. */
  const dofLiveOverride = {};

  /** Re-resolve depth-of-field's cascade from live settings + the live
   * override and apply. Mirrors reapplyBloom exactly; called on settings
   * change, on ready, and by MapShine.setDof. */
  function reapplyDof() {
    const layers = deriveEffectLayers('depthOfField', (key) => readSetting(MODULE_ID, key));
    layers.paramLayers = [dofLiveOverride];
    effectRegistry.resolveAndApply('depthOfField', layers);
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

  /** Transient, in-memory fire param tuning (MapShine.setFire) — mirrors
   * candleLiveOverride/lightningLiveOverride exactly. */
  const fireLiveOverride = {};

  /** Re-resolve fire's cascade from live settings + the live override. */
  function reapplyFire() {
    const layers = deriveEffectLayers('fire', (key) => readSetting(MODULE_ID, key));
    layers.paramLayers = [fireLiveOverride];
    effectRegistry.resolveAndApply('fire', layers);
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
    // Runs AFTER 'candle' (array order), so candleReadout.params is already
    // fresh for this trigger by the time it reads autoIgniteEnabled etc.
    ['candle auto-ignite', () => refreshCandleIgnition({ force: true })],
    ['lightning', () => reapplyLightning()],
    // ⚠️ 2026-08-08: fire was EXACTLY the bug this list's own header warns
    // about — `reapplyFire` existed, reachable from nowhere but
    // `MapShine.setFire`, so `fireReadout` sat at its boot seed of
    // `{enabled:false,...}` on every real ready/scene-load/settings-change
    // until someone typed a console command. Author, live: fire appeared once
    // (a manual `MapShine.setFire` call during testing had kicked it on for
    // that session) and then was gone with no error on the next reload —
    // exactly "silent, and invisible to a green test suite" from the note
    // above, because nothing exercises boot's own reapply wiring.
    ['fire', () => reapplyFire()],
    ['vegetation', () => reapplyVegetation()],
    ['door graphics', () => reapplyDoors()],
    ['water', () => water.reapply()],
    ['fluid', () => fluid.reapply()],
    ['specular', () => specular.reapply()],
    ['window light', () => windowLight.reapply()],
    ['aperture gobo', () => apertureGobo.reapply()],
    ['bloom', () => reapplyBloom()],
    ['depth of field', () => reapplyDof()],
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
    // A freshly-placed candle should reflect whatever the auto-ignite system
    // has already decided for "right now", not sit lit (its authored default,
    // above) until the next dawn/dusk crossing happens to come along.
    refreshCandleIgnition({ force: true });
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
  // CANDLE AUTO-IGNITE (2026-08-06, author request) — the day/night dice roll
  // itself is pure (effects/candle-ignite.js#shouldAutoIgnite); this is the
  // ONLY place it is actually rolled and written through. Writes go through
  // `updateCandleAnchor` exactly like the manual per-candle "Lit" checkbox
  // does, so the render side needs no awareness this system exists at all —
  // it only ever sees `anchor.enabled` change.
  // ---------------------------------------------------------------------------

  /** The day/night phase as of the LAST check, so the per-frame poll
   * (pumpAstrolabe, below) can cheaply no-op on every frame that ISN'T a
   * dawn/dusk crossing — `null` at boot, so the very first call always runs. */
  let lastCandleIsDay = null;

  /**
   * Re-roll every participating candle's auto-ignite state against the
   * CURRENT day/night phase.
   *
   * @param {{force?: boolean}} [opts] - `force`: re-roll even if the phase
   *   has not flipped since the last call — a slider retune, a freshly
   *   placed candle, or a scene/ready trigger (EFFECT_REAPPLIERS, below) all
   *   need this even though the clock itself hasn't moved.
   */
  function refreshCandleIgnition({ force = false } = {}) {
    // getVtPanViewerTodHour — the zero-allocation sibling of the full dial
    // state (this fires UNGATED every rAF via pumpAstrolabe, 60-120x/sec;
    // the full getVtPanViewerTimeDialState() below is already gated behind
    // the astrolabe panel being open AND a 100ms throttle, so it stays there).
    const todHour = Number(getVtPanViewerTodHour());
    if (!Number.isFinite(todHour)) return; // viewer not ready yet — the next natural trigger tries again
    const isDay = computeSun(todHour).aboveHorizon;
    if (!force && isDay === lastCandleIsDay) return;
    lastCandleIsDay = isDay;

    const params = candleReadout.params ?? {};
    if (params.autoIgniteEnabled !== true) return; // off by default — see CANDLE_FLAME_PARAMS' own doc

    const dayChancePct = params.dayIgniteChancePct;
    const nightChancePct = params.nightIgniteChancePct;
    const reliabilityPct = params.igniteReliabilityPct;

    for (const anchor of anchorAuthority.anchorsForKind('candleFlame')) {
      if (anchor.params?.autoIgnite === false) continue; // this ONE candle opted out — only its manual "Lit" checkbox may move it
      const nextEnabled = shouldAutoIgnite({
        isDay,
        dayChancePct,
        nightChancePct,
        reliabilityPct,
        roll01: stableUnit01(anchor.id),
      });
      if (anchor.enabled !== nextEnabled) updateCandleAnchor(anchor.id, { enabled: nextEnabled });
    }
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
    const params = { role, linkId };
    // A fresh bolt's own "height off floor" (2026-08-05, author's own ask:
    // never zero) — only the start endpoint's value is ever read
    // (`groupLightningAnchorsIntoSources`'s own doc), so only it needs one
    // computed; the end endpoint's own `elevation` stays at the schema
    // default, unused, same as before.
    if (role === 'start') {
      params.elevation = defaultLightningElevation(floorBinding, anchorKindById('lightning')?.params?.elevation);
    }
    const resolved = anchorAuthority.addAnchor({
      id,
      kind: 'lightning',
      x,
      y,
      floorBinding,
      enabled: true,
      params,
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
    // Every CANDLE_FLAME_PARAMS key is settable (Presence's `enabled` is
    // handled above, through the settings write, not this loop) — matches
    // setLightning's own `Object.keys(...)` below rather than a hand-picked
    // subset. This USED to be a hand-maintained list (['sizePx', 'color',
    // 'lightRadiusPx', 'animationQuality', 'windResponse']) with exactly the
    // failure mode setLightning's own comment warns about: the new auto-
    // ignite params added below (2026-08-06) would have been silently
    // un-settable from the debug panel — declared, defaulted, validated, and
    // reachable from nowhere — until someone noticed the sliders looked live
    // but did nothing.
    for (const k of Object.keys(CANDLE_FLAME_PARAMS)) {
      if (k in p) {
        candleLiveOverride[k] = p[k];
        changed = true;
      }
    }
    if (changed) {
      try {
        reapplyCandle();
        // A slider drag under Advanced → Presence (auto-ignite on/off, either
        // chance, Reliability) should re-roll at once, not wait for the next
        // dawn/dusk crossing — `force` because the phase itself likely hasn't
        // moved. Harmless no-op for every OTHER candle param (a colour tweak
        // just re-confirms the same booleans).
        refreshCandleIgnition({ force: true });
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

  /**
   * U7 (docs/holy/UI-Testament.md §9) — the Remote's real "Strike" impulse.
   * `forceVtPanViewerLightningStrike()` fast-forwards every already-placed
   * lightning anchor's own schedule; a scene with none placed on the
   * current floor is a documented, safe no-op (lightning-subsystem.js#
   * forceStrike's own doc/test) — stated here as a static caveat rather
   * than a detected one (the viewer's own public API has no cheap way to
   * report "anchor count" back through this seam yet).
   * @returns {{ok: boolean, message: string}}
   */
  MapShine.strikeLightning = () => {
    const result = forceVtPanViewerLightningStrike();
    if (result.skipped) return { ok: false, message: `Strike skipped — ${result.reason}.` };
    return {
      ok: true,
      message: 'Strike triggered (nothing visible happens if no lightning is placed on this floor).',
    };
  };

  /**
   * MapShine.setFire — the console tuner AND the Workshop card's write path.
   * Mirrors setLightning exactly, including the "enabled writes the PLAYER
   * setting, then reapplies once the write lands" ordering (see setCandle's own
   * comment for why that matters).
   *   MapShine.setFire({ posterize: 1, smokeAmount: 1.5 })
   */
  MapShine.setFire = (partial = {}) => {
    const p = partial ?? {};
    if (typeof p.enabled === 'boolean') {
      Promise.resolve(writeSetting(MODULE_ID, effectEnableKey('fire', 'player'), p.enabled ? 'on' : 'off'))
        .then(() => reapplyFire())
        .catch((err) => log.error('fire enable write/reapply failed:', err));
    }
    let changed = false;
    for (const k of Object.keys(FIRE_PARAMS)) {
      if (k in p) {
        fireLiveOverride[k] = p[k];
        changed = true;
      }
    }
    if (changed) {
      try {
        reapplyFire();
      } catch (err) {
        log.error('fire reapply (setFire) failed:', err);
      }
    }
    return { ...fireLiveOverride };
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

  // MapShine.setDof — the console tuner AND the FOH/ROH card's + preset
  // picker's write path (mirrors MapShine.setBloom exactly, including the
  // "enabled writes the PLAYER setting, then reapplies once the write lands"
  // shape). Accepts a full preset object (dofPreset(name)) or a single knob:
  //   MapShine.setDof({ strength: 0.85, blurPerFloor: 2.0 })
  MapShine.setDof = (partial = {}) => {
    const p = partial ?? {};
    if (typeof p.enabled === 'boolean') {
      Promise.resolve(writeSetting(MODULE_ID, effectEnableKey('depthOfField', 'player'), p.enabled ? 'on' : 'off'))
        .then(() => reapplyDof())
        .catch((err) => log.error('depth of field enable write/reapply failed:', err));
    }
    let changed = false;
    // Every key DOF_PARAMS declares — explicit, matching setBloom's precedent
    // so a rename is a visible typo, not a silent no-op.
    for (const k of ['strength', 'blurPerFloor', 'maxBlur']) {
      if (k in p) {
        dofLiveOverride[k] = p[k];
        changed = true;
      }
    }
    if (changed) {
      try {
        reapplyDof();
      } catch (err) {
        log.error('depth of field reapply (setDof) failed:', err);
      }
    }
    return { ...dofLiveOverride };
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
  // DEPTH OF FIELD's render-state seam — same shape as bloom's own, above.
  const getDofRenderState = () => ({
    enabled: dofReadout.enabled,
    params: dofReadout.params ?? {},
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

  /**
   * THE SHADOW CASCADE's own seam (2026-08-05) — the scene's real floor
   * elevations plus Foundry's own pixels-per-distance-unit, so
   * `effects/lighting/shadow-bands.js` can answer "how many world pixels above
   * this floor does the next one sit". Read LIVE on every call (the sun-shadow
   * subsystem holds it as a getter): a GM can edit a Level's elevation
   * mid-session, and a value captured at boot would pin every shadow in the
   * scene to whatever the levels looked like then.
   *
   * ⚠️ BOTH HALVES ARE READS, NOT DERIVATIONS. The floors come from
   * `getActiveSceneFloors` (already sorted, already carrying the real
   * `elevation.bottom`/`elevation.top` off the Level documents), and the scale
   * is `readGridDistancePixels`, which reads `canvas.dimensions.distancePixels`
   * verbatim — Foundry's OWN pixels-per-grid-distance-unit constant, the same
   * number `computeTokenOcclusionRadiusPx` already uses for light radii. It is
   * deliberately NOT re-derived from `grid.size / grid.distance`, so the shadow
   * system and Foundry's own geometry can never quietly disagree about how long
   * a foot is (`scene-occlusion-sources.js`'s own header states this at length).
   *
   * Returns an empty floor list rather than throwing on any failure — the band
   * plan treats that as "cannot answer" and falls back to the authored
   * `aboveHeightPx` slider, reporting that it did.
   */
  const getShadowFloorPlan = () => {
    try {
      const sceneDoc = globalThis.canvas?.scene ?? null;
      const floorsResult = getActiveSceneFloors(sceneDoc);
      return {
        floors: floorsResult.ok ? floorsResult.floors : [],
        pxPerElevationUnit: readGridDistancePixels().distancePixels,
      };
    } catch (err) {
      log.warn('sun shadows: could not read the scene floor plan — band heights fall back to the slider:', err);
      return { floors: [], pxPerElevationUnit: 0 };
    }
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

  // ANCHOR RENDER-STATE MEMOS (perf audit, 2026-08-12) — `getCandleRenderState`/
  // `getLightningRenderState`/`getFireRenderState` are called every frame
  // (`getFireRenderState`'s own header already said so; the other two are
  // called from the SAME per-frame `point-light-pool.js#update` call, plus
  // again from the flame/bolt sprite render), and each used to re-run its
  // `.map()` over every served anchor unconditionally — a fresh Array plus a
  // fresh per-anchor object EVERY call, the exact per-frame-allocation this
  // codebase's own point-light-pool.js module header says is a hard rule
  // against. An anchor's resolved fields only actually change when: (a) the
  // anchor set itself changes (create/update/delete — `anchorAuthority.
  // getVersion()`), (b) the active floor changes (`activeFloorContext`/
  // `lastKnownFloors` are both REASSIGNED, never mutated in place, by
  // `updateActiveFloorContext` — see that function's own body — so `!==` is
  // a correct, cheap staleness check), or (c) for candle/fire, the outdoor
  // mask a live `windExposure` sample reads streams in or is repainted
  // (`getMaskAuthorityVersion()`, the SAME signal `getMaskDrivenFires`'s own
  // cache already keys on below). Each memo recomputes only when ITS OWN
  // dependency set changed, so a floor switch invalidates all three while an
  // unrelated settings tweak invalidates none.
  let candleAnchorMemo = { anchorVersion: -1, floorContext: null, floors: null, maskVersion: -1, anchors: [] };
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
    const anchorVersion = anchorAuthority.getVersion();
    const maskVersion = getMaskAuthorityVersion();
    if (
      candleAnchorMemo.anchorVersion !== anchorVersion ||
      candleAnchorMemo.floorContext !== activeFloorContext ||
      candleAnchorMemo.floors !== lastKnownFloors ||
      candleAnchorMemo.maskVersion !== maskVersion
    ) {
      candleAnchorMemo = {
        anchorVersion,
        floorContext: activeFloorContext,
        floors: lastKnownFloors,
        maskVersion,
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
          // THIS CANDLE'S OWN DEPTH-AUTHORITY ELEVATION (2026-08-05, cast
          // light; flame sprite joined 2026-08-13) — a real absolute world
          // elevation (`resolveAnchorElevationWorldUnits`, this anchor's
          // floorBinding + `params.elevation` "height off floor"), NOT a
          // pre-computed rank: `vt-pan-viewer.js`'s own `resolveExpectedDepth`
          // (light path, via the point-light pool) and `resolveCandleExpected
          // Depth` (flame-sprite path, updateCandleFlame) each turn this into
          // the tie-safe value their own shader compares — the SAME
          // two-step split every other depth-authority consumer uses
          // (`keyhole-depth-authority-design.md`). Both this candle's LIGHT
          // and its FLAME are now ranked at the SAME height, instead of the
          // light silently defaulting to absolute elevation 0
          // (point-light-pool.js#update's own "light.elevation is undefined
          // for candle-cast lights" comment — this is what closes that gap).
          // Migrated OFF the OLD `resolveAnchorElevationRank`/`elevationRank`
          // mechanism the flame sprite used to carry on its own — see
          // lightning-render.js's own header for the identical prior fix.
          elevation: resolveAnchorElevationWorldUnits(a),
        })),
      };
    }
    return {
      enabled: candleReadout.enabled,
      params: candleReadout.params ?? {},
      perfTier: candleReadout.perfTier,
      anchors: candleAnchorMemo.anchors,
    };
  };

  // THE LIGHTNING data seam (effects/lightning-subsystem.js) — same shape as
  // getCandleRenderState just above, minus the per-anchor windExposure sample
  // (lightning samples the shared wind field directly at each strand vertex's
  // own world position in-shader, not via a baked per-anchor exposure — see
  // effects/lightning-render.js's own header for why that's simpler here than
  // candle's per-anchor bake). vt/ never reaches the anchor authority or the
  // settings cascade; it only ever sees what this closure hands it.
  // See `candleAnchorMemo`'s own doc just above for why this memoizes and on
  // what — lightning has no live wind sample, so its key drops `maskVersion`.
  let lightningAnchorMemo = { anchorVersion: -1, floorContext: null, floors: null, anchors: [] };
  const getLightningRenderState = () => {
    const anchorVersion = anchorAuthority.getVersion();
    if (
      lightningAnchorMemo.anchorVersion !== anchorVersion ||
      lightningAnchorMemo.floorContext !== activeFloorContext ||
      lightningAnchorMemo.floors !== lastKnownFloors
    ) {
      lightningAnchorMemo = {
        anchorVersion,
        floorContext: activeFloorContext,
        floors: lastKnownFloors,
        anchors: anchorAuthority.anchorsForEffect('lightning', activeFloorContext).map((a) => ({
          id: a.id,
          x: a.x,
          y: a.y,
          params: a.params,
          // THE BOLT'S OWN DEPTH-AUTHORITY INPUT (2026-08-05) — a raw absolute
          // world elevation, the SAME `resolveAnchorElevationWorldUnits` call
          // getCandleRenderState's own `elevation` field uses, NOT a
          // pre-computed rank: `lightning-subsystem.js`'s own injected
          // `resolveExpectedDepth` turns this into the tie-safe value the
          // shader actually compares, the SAME two-step split every other
          // depth-authority consumer already uses (vt-pan-viewer.js's own
          // `resolveExpectedDepth` composition, right where it constructs this
          // subsystem). Migrated OFF the OLD `resolveAnchorElevationRank`/
          // `elevationRank` mechanism the flame sprite still uses — see
          // lightning-render.js's own header for why only the ribbon mesh moved.
          elevation: resolveAnchorElevationWorldUnits(a),
        })),
      };
    }
    return {
      enabled: lightningReadout.enabled,
      params: lightningReadout.params ?? {},
      perfTier: lightningReadout.perfTier,
      anchors: lightningAnchorMemo.anchors,
    };
  };

  /**
   * FIRE'S RENDER-STATE SEAM. Same shape as the candle's and the bolt's: boot
   * composes it, `vt/` never reaches the anchor authority or the settings
   * cascade itself.
   *
   * ⚠️ `mPerPx` IS SERVED, NOT ASSUMED. Every derived quantity in the fire's
   * scale chain — its puff frequency, its plume height, whether it reads as
   * laminar or turbulent — depends on how many real METRES a painted pixel is,
   * and that is a property of the scene's grid, not a constant. The same
   * painted blob is a campfire on a 100 px/5 ft map and a housefire on a
   * 20 px/5 ft one, and the puff law has to know which.
   */
  /**
   * THE PAINTED `_Fire` REGION → FIRE SOURCES, cached by mask signature.
   *
   * ⚠️ CACHED, BECAUSE THIS IS A CHAMFER DISTANCE TRANSFORM OVER THE WHOLE
   * FLOOR GRID and `getFireRenderState` is called every frame. The signature is
   * sampled (see `fireMaskSignature`'s own note), so the mask authority's
   * version counter is checked alongside it — a sampled hash can miss a small
   * edit, and a stale bake surviving an edit is its own bug class.
   */
  // BAKE-GATE HEALTH (cache-completeness pass, 2026-08-12) — same bakeRuns/
  // bakeSkips doctrine as mask-authority.js's own recomputeIfDirty: a skip
  // is the floorIndex+signature+version triple matching the cached slot (the
  // chamfer transform below did NOT re-run); a run is a real re-extraction.
  // Kept as two SEPARATE pairs, not one shared counter, because the mask and
  // spawn-cloud caches below are independently-slotted objects that COULD
  // diverge if a future call site reads one without the other — conflating
  // them would be exactly the "one byte, two quantities" trap.
  // A STABLE shared reference for "fire disabled this call" — NOT a fresh
  // `[]` literal, which would compare unequal to itself call-to-call and
  // defeat `fireAnchorMemo`'s own `maskFiresRef` dependency check (see that
  // memo's doc below) every single frame fire happens to be off.
  const EMPTY_FIRE_ARRAY = Object.freeze([]);
  /**
   * THE LIVE-TUNABLE FIRE-MASK SENSITIVITY (2026-08-13, author request — a
   * way to boost detection of small/faint painted fire without a Foundry
   * reload, after a real live case: identical painted pixels registered on
   * one floor and not another, and even a fix to the packed-alpha attenuation
   * this session already found didn't fully explain it). Resolves
   * `FIRE_PARAMS.maskSensitivity` from the live readout — never a second
   * hardcoded copy of the schema's own default, which would drift the moment
   * one of the two changed and not the other. Read fresh on every
   * `getMaskDrivenFires`/`getFireSpawnCloud` call: cheap (one property read +
   * one clamp), and reading it fresh is what lets the cache-key comparison
   * below force a real re-extraction the instant the author releases the
   * slider, same as any other authored-content change already does.
   */
  function resolveFireMaskSensitivity() {
    const raw = Number(fireReadout.params?.maskSensitivity);
    const { min, max, default: def } = FIRE_PARAMS.maskSensitivity;
    return Number.isFinite(raw) ? Math.max(min, Math.min(max, raw)) : def;
  }
  /**
   * The spawn cloud's own threshold keeps THIS ratio to the (live-tunable)
   * paint threshold, preserving their shipped relationship
   * (`fire-spawn-points.js`'s `SPAWN_THRESHOLD` 0.18 / `fire-mask.js`'s
   * `PAINT_THRESHOLD` 0.25) as the one "Mask sensitivity" slider moves,
   * rather than exposing two separate controls for what is conceptually one
   * question — "how much paint counts as real".
   */
  const FIRE_SPAWN_TO_PAINT_THRESHOLD_RATIO = 0.18 / 0.25;
  let fireMaskBakeRuns = 0;
  let fireMaskBakeSkips = 0;
  let fireSpawnBakeRuns = 0;
  let fireSpawnBakeSkips = 0;
  let fireMaskCache = {
    floorIndex: null,
    signature: 0,
    version: -1,
    sensitivity: null,
    fires: [],
    // The connected-component field `fire-spawn-points.js#applyCohesion`
    // needs (getFireMaskLabelGrid, below) — populated ATOMICALLY with `fires`
    // in the same cache-miss branch, so they can never independently go
    // stale relative to each other; the existing signature/version/
    // sensitivity key above already covers both.
    nearestLabel: null,
    spec: null,
  };
  /**
   * THE SPAWN CLOUD — the same painted grid, as the flat point buffer the
   * particle kernels index (`SPAWN_KINDS.extracted`).
   *
   * ⚠️ CACHED ON THE SAME SIGNATURE+VERSION PAIR AS THE FIRES ABOVE, and for a
   * stronger reason: pushing a cloud re-seeds every engine, so recomputing it
   * per frame would restart the whole population sixty times a second and
   * nothing would ever live long enough to be seen. `signature` rides along on
   * the returned object so the subsystem can tell "same cloud" without
   * comparing buffers.
   */
  let fireSpawnCache = { floorIndex: null, signature: 0, version: -1, sensitivity: null, cloud: null };
  const getFireSpawnCloud = (floorIndex) => {
    let grid = null;
    try {
      grid = maskAuthority.getDerived('fire', floorIndex)?.grid ?? null;
    } catch {
      return null;
    }
    if (!grid) return null;
    const version = getMaskAuthorityVersion?.() ?? -1;
    const signature = fireMaskSignature(grid);
    // THE LIVE-TUNABLE SENSITIVITY (2026-08-13, author request — a way to
    // boost detection of small/faint painted fire without a Foundry reload).
    // Rides in the CACHE KEY, same as signature/version: a slider move must
    // force a re-extraction the instant the author stops dragging, exactly
    // like any other authored-content change already does. Spawn's own
    // threshold keeps its EXISTING ratio to the paint threshold (0.18/0.25 ≈
    // 0.72 today) as the single slider moves, rather than exposing two
    // separate, confusing controls for what is conceptually one question
    // ("how much paint counts as real").
    const sensitivity = resolveFireMaskSensitivity();
    if (
      fireSpawnCache.floorIndex === floorIndex &&
      fireSpawnCache.signature === signature &&
      fireSpawnCache.version === version &&
      fireSpawnCache.sensitivity === sensitivity
    ) {
      fireSpawnBakeSkips += 1;
      return fireSpawnCache.cloud;
    }
    fireSpawnBakeRuns += 1;
    const extracted = extractFireSpawnPoints(grid, { threshold: sensitivity * FIRE_SPAWN_TO_PAINT_THRESHOLD_RATIO });
    const cloud = { ...extracted, signature };
    fireSpawnCache = { floorIndex, signature, version, sensitivity, cloud };
    log.info(`fire: painted region on floor ${floorIndex} yielded ${extracted.count} spawn point(s)`);
    return cloud;
  };
  const getMaskDrivenFires = (floorIndex) => {
    let grid = null;
    try {
      grid = maskAuthority.getDerived('fire', floorIndex)?.grid ?? null;
    } catch (err) {
      // An absent `_Fire` mask is the common case, not an error — most scenes
      // have no fire painted at all. Anything else is worth saying once.
      if (!/missing|absent|not found/i.test(String(err?.message ?? err))) {
        log.warn('fire: could not read the painted region for floor', floorIndex, err);
      }
      return [];
    }
    if (!grid) return [];
    const version = getMaskAuthorityVersion?.() ?? -1;
    const signature = fireMaskSignature(grid);
    // See getFireSpawnCloud's own note — same live-tunable sensitivity, same
    // cache-key discipline, so the two never disagree about what "painted"
    // means for one map even as the slider moves.
    const sensitivity = resolveFireMaskSensitivity();
    if (
      fireMaskCache.floorIndex === floorIndex &&
      fireMaskCache.signature === signature &&
      fireMaskCache.version === version &&
      fireMaskCache.sensitivity === sensitivity
    ) {
      fireMaskBakeSkips += 1;
      return fireMaskCache.fires;
    }
    fireMaskBakeRuns += 1;
    // `rescueThreshold` is the SPAWN cloud's own threshold, derived through the
    // very ratio a few lines up that keeps the two in lockstep as the one
    // sensitivity slider moves. See `extractFiresFromMask`'s own "⚠️ THE RESCUE
    // PASS" for the live report this closes: paint in the band between the two
    // thresholds spawned flame particles while producing zero fires, and a fire
    // is the only thing that ever becomes a light — so the upper floor showed
    // flames that could not light anything, with no control able to fix it.
    //
    // Passing it HERE rather than defaulting it inside `extractFiresFromMask`
    // is deliberate: this is the one place that knows both thresholds are two
    // views of a single authored question, and a default buried in the
    // extractor would silently drift the moment the ratio here changed.
    //
    // `extractFiresWithLabels`, not `extractFiresFromMask` — identical fires,
    // same strict/rescue orchestration, but also hands back the connected-
    // component field `applyCohesion` needs to know which painted blob a
    // spawn point belongs to (`getFireMaskLabelGrid`, below). This function
    // still returns `fires` alone; nothing downstream of it sees a shape change.
    const { fires, nearestLabel, spec } = extractFiresWithLabels(grid, {
      paintThreshold: sensitivity,
      rescueThreshold: sensitivity * FIRE_SPAWN_TO_PAINT_THRESHOLD_RATIO,
    });
    fireMaskCache = { floorIndex, signature, version, sensitivity, fires, nearestLabel, spec };
    // Positions ride along, not just the count (2026-08-12) — a live report of
    // "two painted fireplaces, cohesion collapses them together" is otherwise
    // unanswerable without a console dump: this line alone says whether
    // extraction genuinely found two separate peaks (and where) or merged them
    // into one, which is the fork the cohesion pull's own correctness depends on.
    log.info(
      `fire: painted region on floor ${floorIndex} yielded ${fires.length} fire(s)`,
      fires.map((f) => ({ id: f.id, x: Math.round(f.x), y: Math.round(f.y), diameterPx: Math.round(f.diameterPx) }))
    );
    return fires;
  };
  /**
   * `applyCohesion`'s label-scoped grouping needs the SAME connected-component
   * field `getMaskDrivenFires` already computed for this floor's `fires` —
   * never a second, independently-thresholded guess. Reads whatever
   * `fireMaskCache` currently holds rather than re-deriving anything; the
   * caller (`getFireRenderState`, below) always calls `getMaskDrivenFires`
   * first, so the cache is warm for the current floor by the time this runs.
   * Defensively returns `null` on any mismatch (wrong floor, never populated)
   * rather than ever serving a stale floor's labels.
   *
   * @param {number} floorIndex
   * @returns {{nearestLabel: Int32Array, spec: object}|null}
   */
  const getFireMaskLabelGrid = (floorIndex) => {
    if (fireMaskCache.floorIndex !== floorIndex || !fireMaskCache.nearestLabel) return null;
    return { nearestLabel: fireMaskCache.nearestLabel, spec: fireMaskCache.spec };
  };

  // See `candleAnchorMemo`'s own doc for the general shape/reason. Fire's
  // `fires` array is more entangled than candle/lightning's — it wraps BOTH
  // the mask-driven fires (already internally cached by `getMaskDrivenFires`,
  // whose OWN returned array reference is reused here as a dependency signal
  // rather than re-deriving its floorIndex/signature/version key a second
  // time) and the anchor-placed ones, and both branches read `fireReadout.
  // params?.fuel`/`.color` as a fallback — `fireReadout` itself is REASSIGNED
  // wholesale on every settings re-resolve (`effectRegistry.register(FIRE,
  // ...)` below), never mutated in place, so it is a valid, cheap reference
  // key exactly like `activeFloorContext`.
  let fireAnchorMemo = {
    anchorVersion: -1,
    floorContext: null,
    floors: null,
    maskVersion: -1,
    readout: null,
    maskFiresRef: null,
    fires: [],
  };
  const getFireRenderState = () => {
    const grid = canvas?.scene?.grid ?? null;
    const feetPerSquare = Number(grid?.distance) > 0 ? Number(grid.distance) : 5;
    const pxPerSquare = Number(grid?.size) > 0 ? Number(grid.size) : 100;
    // Foundry authors distance in the scene's own units; 5 ft ≈ 1.524 m is the
    // standard D&D square, and `grid.distance` is how many of those a square is.
    const mPerPx = (feetPerSquare * 0.3048) / pxPerSquare;
    const floorIndex = activeFloorContext?.floorIndex ?? 0;

    // THE PAINTED REGION — the primary source. Each blob's own width sets its
    // diameter, so a wide blob is a bonfire and a thin line along a wall is a
    // row of small flames, with no second authoring step. `getMaskDrivenFires`
    // is already cache-gated internally (floorIndex+signature+version); read
    // unconditionally so its returned reference is available as this memo's
    // OWN dependency signal below, even on a frame nothing else changed.
    const maskFiresSource = fireReadout.enabled ? getMaskDrivenFires(floorIndex) : EMPTY_FIRE_ARRAY;
    const anchorVersion = anchorAuthority.getVersion();
    const maskVersion = getMaskAuthorityVersion();
    if (
      fireAnchorMemo.anchorVersion !== anchorVersion ||
      fireAnchorMemo.floorContext !== activeFloorContext ||
      fireAnchorMemo.floors !== lastKnownFloors ||
      fireAnchorMemo.maskVersion !== maskVersion ||
      fireAnchorMemo.readout !== fireReadout ||
      fireAnchorMemo.maskFiresRef !== maskFiresSource
    ) {
      const maskFires = fireReadout.enabled
        ? maskFiresSource.map((f) => ({
            ...f,
            fuel: fireReadout.params?.fuel ?? 'wood',
            color: fireReadout.params?.color ?? '#fdba35',
            windExposure: sampleWindExposureAt(f.x, f.y),
            outdoors01: sampleWindExposureAt(f.x, f.y),
            // A painted fire sits on its floor's own GROUND. An anchor is what
            // you place when you want it up on a table.
            //
            // ⚠️ THIS READ `activeFloorContext.elevation` UNTIL 2026-08-15, AND
            // THAT IS NOT THE GROUND — it is the floor band's MIDPOINT. That
            // field exists for a completely different question: it is the probe
            // point `updateActiveFloorContext` computes to test which floor an
            // ANCHOR's band membership falls in, deliberately placed *interior*
            // to the band so an anchor bound to an adjacent floor never matches
            // at a shared boundary. Reusing it as a painted fire's PHYSICAL
            // HEIGHT is one number carrying two unrelated meanings
            // ([[feedback_one_byte_two_quantities]]) — and the comment directly
            // above it has said "ground" the whole time, so the code and its own
            // stated intent had already drifted apart.
            //
            // `band[0]` is the floor's `elevationBottom` — the SAME quantity a
            // candle resolves through `resolveAnchorElevationWorldUnits`
            // (`floorBinding.bottom + params.elevation`, with a painted fire's
            // "height off floor" being 0 by definition). So a painted fire and a
            // candle standing on the same floorboards now report the same
            // height, instead of the fire silently claiming to float half a
            // storey up.
            //
            // ⚠️ NOT CLAIMED AS THE FIX FOR "fire's light doesn't reach upper
            // floors" (author-reported, same day). It is a real defect on that
            // exact path and it is worth closing, but `depth-authority.js#
            // rankOfElevation` bisects to "the last item at or below this
            // elevation", so with nothing authored between a floor's ground and
            // its midpoint BOTH values resolve to the same rank — which means
            // this cannot be assumed to be the reported symptom's cause. Saying
            // otherwise would be exactly the plausible-diagnosis-that-rots this
            // project has already paid for ([[feedback_plausible_diagnosis_rots]]).
            elevation: activeFloorContext?.band?.[0] ?? activeFloorContext?.elevation ?? 0,
            // This fire HAS a painted shape to conform to — the render's mask
            // clip (fire-render.js) is keyed on this, not on `id`'s `mask:`
            // prefix, so the two never have a chance to silently disagree.
            maskClip: true,
          }))
        : [];
      fireAnchorMemo = {
        anchorVersion,
        floorContext: activeFloorContext,
        floors: lastKnownFloors,
        maskVersion,
        readout: fireReadout,
        maskFiresRef: maskFiresSource,
        fires: [
          ...maskFires,
          ...anchorAuthority.anchorsForEffect('fire', activeFloorContext).map((a) => ({
            id: a.id,
            x: a.x,
            y: a.y,
            diameterPx: Number(a.params?.diameterPx) > 0 ? Number(a.params.diameterPx) : 120,
            intensity: Number.isFinite(a.params?.intensity) ? a.params.intensity : 1,
            fuel: a.params?.fuel ?? fireReadout.params?.fuel ?? 'wood',
            color: a.params?.useCustomColor ? a.params.customColor : (fireReadout.params?.color ?? '#fdba35'),
            windExposure: sampleWindExposureAt(a.x, a.y),
            outdoors01: sampleWindExposureAt(a.x, a.y),
            // A raw absolute world elevation, exactly as the bolt serves — the
            // subsystem's injected `resolveExpectedDepth` turns it into the
            // tie-safe value the shader compares. NEVER a pre-computed rank.
            elevation: resolveAnchorElevationWorldUnits(a),
            // An anchor is placed precisely because the author wants fire
            // somewhere with no `_Fire` paint at all — never clipped.
            maskClip: false,
          })),
        ],
      };
    }

    return {
      enabled: fireReadout.enabled,
      params: fireReadout.params ?? {},
      perfTier: fireReadout.perfTier,
      mPerPx,
      maskFireCount: fireReadout.enabled ? maskFiresSource.length : 0,
      // The particle kernels' shape source — every flame, ember and smoke
      // sprite is born on one of these points.
      spawnCloud: fireReadout.enabled ? getFireSpawnCloud(floorIndex) : null,
      fires: fireAnchorMemo.fires,
      // `fire-spawn-points.js#applyCohesion`'s label-scoped grouping — see
      // `getFireMaskLabelGrid`'s own doc. Safe to read unconditionally here:
      // `maskFiresSource` above already called `getMaskDrivenFires(floorIndex)`
      // this same invocation, so the cache is warm for this exact floor.
      fireLabelGrid: fireReadout.enabled ? getFireMaskLabelGrid(floorIndex) : null,
    };
  };

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

  // FIRE'S MASK, AS A GPU TEXTURE SEAM (2026-08-08) — the same coarse `_Fire`
  // grid `getMaskDrivenFires` already extracts point sources from, handed to
  // `vt/` to bake so the flame's own shader can clip its footprint to the
  // painted shape instead of always drawing a free-floating circle. Unlike
  // `_Outdoors`, an absent `_Fire` is the ordinary case (most floors have no
  // fire painted at all) — swallowed here exactly like `getMaskDrivenFires`'s
  // own try/catch, never the required-mask loud throw above.
  const getFireMaskGrid = (floorIndex) => {
    try {
      return maskAuthority.getDerived('fire', floorIndex)?.grid ?? null;
    } catch {
      return null;
    }
  };

  // PRECIPITATION'S SKY-REACH SEAM (P1, 2026-08-16) — `skyReach` is the DERIVED
  // product `outdoors ∧ ¬coverAbove`, and it is the input LAW 3 rests on: rain
  // must be unrepresentable indoors. Handed to `vt/` to bake as a texture so
  // the FALL's draw can fade bodies over covered ground.
  //
  // ⚠️ ASKED FOR BY NAME HERE AND NOWHERE ELSE. `scene/sky-reach-access.js` is
  // the CPU service for the same question and exists precisely because two
  // consumers reaching for raw products picked DIFFERENT ONES once already
  // (the 2026-07-21 candle/wind `skyReach`-vs-`outdoors` split). This is the
  // GPU half of that one question; it must never become "grab outdoors and
  // hope", which is a genuinely different mask (a walled room with no roof is
  // indoors AND has open sky).
  //
  // Swallowed like `_Fire` above rather than thrown like `_Outdoors`: a floor
  // whose art has not streamed yet yields null, the gate stays disarmed, and
  // disarmed means RAINING (fail-open). A throw here would stop the weather on
  // exactly the maps that have not finished loading.
  const getSkyReachGrid = (floorIndex) => {
    try {
      return maskAuthority.getDerived('skyReach', floorIndex)?.grid ?? null;
    } catch {
      return null;
    }
  };

  /**
   * ⭐ THE ROOFLINE's INPUT (P5, §4.3). `coverAbove` is *"is there opaque art
   * above me on this floor"*, so its BOUNDARY is exactly a roof/canopy edge —
   * which means drips need no new mask and no new authoring at all, and are
   * automatically right for whatever the artist drew.
   *
   * Swallowed like `skyReach` above and for the same reason: a floor whose art
   * has not streamed yet yields null, the roofline stays empty, and an empty
   * roofline simply does not drip. Failing SILENT is correct here (unlike the
   * rain gate, where failing open means raining) — a drip in the wrong place is
   * worse than no drip, which is the whole V2 lesson this feature carries.
   */
  const getCoverAboveGrid = (floorIndex) => {
    try {
      return maskAuthority.getDerived('coverAbove', floorIndex)?.grid ?? null;
    } catch {
      return null;
    }
  };
  /** The deck ALTITUDE at each roofline point, so a bridge drips from bridge
   * height and an awning from awning height (§4.3) with nothing authored. */
  const getCasterHeightGrid = (floorIndex) => {
    try {
      return maskAuthority.getDerived('casterHeight', floorIndex)?.grid ?? null;
    } catch {
      return null;
    }
  };

  // WATER's four mask-authority seams — see effects/water/water-seams.js for
  // why they ask different questions at deliberately different resolutions.
  // `getWaterBackgroundItemId` is the depth-authority migration's own seam
  // (2026-08-15), the same shape `getSpecularBackgroundItemId`/
  // `getWindowBackgroundItemId` already use below.
  const { getWaterMaskGrid, getFloorsWithWater, getWaterMaskUrl, getWaterBackgroundItemId } = createWaterSeams({
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
  const { getSpecularMaskRect, getSpecularMaskUrl, getSpecularBackgroundItemId } = createSpecularSeams({
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

  // WINDOW LIGHT's mask-authority seams (docs/planning/Windows.md) — same
  // split as SHINE's, for the same reason: the RECT comes from the coarse
  // grid, the COLOUR can only come from the authored file. `getWindowBackground
  // ItemId` is the depth-authority migration's own seam (2026-08-05), mirroring
  // SHINE's `getSpecularBackgroundItemId` above.
  const { getWindowMaskRect, getWindowMaskUrl, getWindowBackgroundItemId } = createWindowSeams({
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

  // APERTURE GOBO (docs/planning/Aperture-Gobo.md) — no mask seams to build
  // alongside it (see that module's own header): the only thing the viewer
  // needs from boot is the resolved render state, threaded straight into
  // `startVtPanViewer({...})` below exactly like `getWindowRenderState`.
  const apertureGobo = createApertureGoboRegistration({
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
    depthOfField: reapplyDof,
    grade: reapplyGradeLook,
    doorGraphics: reapplyDoors,
    water: water.reapply,
    fluid: fluid.reapply,
    specular: specular.reapply,
    window: windowLight.reapply,
    apertureGobo: apertureGobo.reapply,
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
  /**
   * Scene/session context, shared by every performance report so two runs are actually
   * comparable (author, 2026-08-06, reviewing a live sweep: the report had no idea what
   * scene, floor, resolution or build it ran against — a real gap once you're trying to
   * tell "did this get faster" apart from "this is a different, lighter scene"). ONE
   * function, read by both `perfHarness` (the sweep) and `profileHarness` (the zone
   * profiler) rather than two copies drifting apart — see `feedback_mode_forks_silently_
   * drop_features` for why a second copy is exactly how that class of bug starts.
   */
  function buildPerfContext() {
    const info = readVtPanViewerRenderInfo();
    return {
      msaVersion: MapShine.version,
      codename: MapShine.codename,
      resolution: info ? { w: info.width, h: info.height, pixelRatio: info.pixelRatio } : null,
      sceneName: activeFloorContext?.sceneName ?? null,
      floorIndex: activeFloorContext?.floorIndex ?? 0,
      // Resolved through the REAL cascade, not a guessed settings key. An effect's on/off
      // state is the product of profile + GM + player layers, and a report that guessed
      // it would mislabel exactly the rows someone is about to act on.
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
  }

  // STRUCTURAL TOGGLES (2026-08-12) — pipeline choices, not effects, and the
  // distinction is the whole reason these need their own hook rather than a
  // sweep config. `setForcedEnabled` routes through the effect registry
  // (resolveAndApply on a layer stack); these are plain viewer-level booleans
  // that no registry knows about, which is exactly why the early-Z question
  // was previously only answerable by driving the app from OUTSIDE via
  // Playwright and running the whole 2-4 minute capture twice.
  //
  // Read-back is REQUIRED, not a convenience: perf-structural-ab (and now
  // perf-lab's runSweepStructuralAB) refuse to flip any toggle they cannot
  // read first, because a throw mid-run that left early-Z off would surface
  // as a rendering regression from nowhere, hours later, with nothing
  // pointing back here.
  //
  // SHARED between `perfHarness` and `profileHarness` via spread below, not
  // two copies of the same id→accessor dispatch — a second hand-maintained
  // copy drifting from the first is exactly
  // [[feedback_hand_maintained_dispatch_lists_forgets_new_effects]]'s shape,
  // just for structural toggles instead of effects. Added to `perfHarness`
  // 2026-08-12 specifically so `perf-lab.js`'s sweep can be run once per
  // toggle state (`runSweepStructuralAB`) — it previously only reached
  // `profileHarness`, which the zone profiler uses but the effect sweep does
  // not.
  const structuralToggleHooks = {
    readStructuralToggle: (id) => {
      if (id === 'earlyZComposition') {
        const s = getVtPanViewerEarlyZComposition();
        return typeof s?.earlyZComposition === 'boolean' ? s.earlyZComposition : null;
      }
      return null;
    },
    setStructuralToggle: (id, on) => {
      if (id === 'earlyZComposition') return setVtPanViewerEarlyZComposition(on);
      return null;
    },
  };

  const perfHarness = {
    listEffects: () => effectRegistry.list().map((m) => ({ id: m.id, label: m.title ?? m.id })),
    setForcedEnabled: (id, enabled) => forceEffectEnabled(id, enabled),
    setGpuProbe: (on) => setVtPanViewerGpuProbe(on),
    resetFrameStats: () => resetVtPanViewerFrameStats(),
    getContext: () => buildPerfContext(),
    readCost: () => {
      const d = getVtPanViewerDiagnostics();
      return {
        active: d.active === true,
        gpuProbe: d.gpuProbe ?? null,
        hitchStats: d.hitchStats ?? null,
        renderMsAvgLast120: d.renderMsAvgLast120 ?? null,
      };
    },
    ...structuralToggleHooks,
  };
  // THE PERFORMANCE CENTER (docs/planning/Performance.md; author directive
  // 2026-08-06: "move all performance monitoring things into a single space
  // which becomes the only place for performance related tools"). Every
  // perf-related report/action/panel below declares `{ zone: 'performance' }`
  // instead of leaving `zone` unset (which defaults to the Lab) or
  // `{primary:true}` (the Lab's own quick-reach row) — debug-panel.js's
  // `renderPerformanceCenter` gathers all of them into diag/perf-strip.js's
  // own expand area, never a rail zone. `perfLab`/`perfHud` used to be
  // SEPARATE floating overlays (`.open()`/toggle-then-appear-top-right);
  // both were refactored the same day into plain embeddable elements
  // (`{ el }`) mounted here via the same `registerPanel` primitive every
  // effect card already uses — no new registration API.
  const perfLab = createPerfLab();
  MapShine.debug.registerPanel('perf-lab-panel', 'Effect sweep', () => perfLab.el, { zone: 'performance' });

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
  // Same reasoning, for the multi-floor sweep's own settle wait
  // (multi-floor-sweep-2026-08-12) — boot only says WHAT to read
  // (`getVtPanViewerSceneSettle`, already imported above).
  const waitForSceneSettled = createSceneSettleWaiter({ readSettle: () => getVtPanViewerSceneSettle() });
  // A SEPARATE waiter, not a reuse of waitForSceneSettled above — same
  // readSettle source, but RAPID_STRESS_RECOVERY_TIMEOUT_MS (30s) instead of
  // that one's DEFAULT_SETTLE_WAIT_TIMEOUT_MS (240s, sized for a cold floor
  // load). See RAPID_STRESS_RECOVERY_TIMEOUT_MS's own doc for why these two
  // timeouts must differ.
  const waitForRapidStressRecovery = createSceneSettleWaiter({
    readSettle: () => getVtPanViewerSceneSettle(),
    timeoutMs: RAPID_STRESS_RECOVERY_TIMEOUT_MS,
  });

  // HIDE-WHILE-MEASURING (Testament Stage 4, 2026-08-11 — "hide itself and
  // cost nothing during tests"). Remembers whether the debug panel was
  // showing BEFORE the harness hid it, so restoreLiveUi() reopens it only if
  // the author had it open — a GM who had already closed it must not have it
  // popped open by a perf run finishing. `hidePanel()` alone (debug-panel.js)
  // is CSS display:none, not a DOM detach — it does not by itself stop
  // per-frame cost (pumpAstrolabe's own throttle gates on isPanelVisible()
  // for exactly this reason, a few hundred lines up); this pair is what
  // actually makes a measurement window pay none of it.
  let debugPanelVisibleBeforeHide = false;
  // SHARPENING A/B KILL SWITCH (2026-08-15) — OFF by default, deliberately
  // the opposite default from multiFloor/rapidStressSweep (both unconditional
  // phases of this same action). Those two have a KNOWN-acceptable cost;
  // this one is four full viewer restarts and has never been timed live —
  // the first real capture with it on IS the timing experiment that decides
  // whether to flip this default (see runSharpeningAB's own header). Console
  // only, same "one action, one control" reasoning `runEarlyZSweepAB` is
  // already built on a few hundred lines down — no panel toggle for this.
  let sharpeningAbEnabled = false;
  MapShine.setSharpeningAbEnabled = (on) => {
    sharpeningAbEnabled = on === true;
    return { enabled: sharpeningAbEnabled };
  };
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
        // fill-rate bound"). This comment used to be untrue: both were wired to
        // `readVtPanViewerRenderInfo()`, which allocates a fresh Vector2 + a
        // fresh 5-field object per call for a value this call site immediately
        // discarded down to one integer — ~320 allocations/frame while armed,
        // the instrument measuring its own GC pressure. Fixed 2026-08-09 by
        // reading straight through to `renderer.info.render` with no
        // allocation at all (see `readDrawCallsOnly`'s own comment).
        readDrawCalls: () => readVtPanViewerDrawCallsOnly(),
        readTriangles: () => readVtPanViewerTriangleCountOnly(),
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
        // ?? null, NOT ?? 0 — an older viewer that does not report this must
        // read as "unknown", not as "nothing was dropped". perf-report.js
        // distinguishes the two.
        hitchesDropped: samples.hitchesDropped ?? null,
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
    getContext: () => buildPerfContext(),
    waitFrames: (n) => waitProfiledFrames(n),
    getManifests: () => effectRegistry.list(),
    readVram: () =>
      buildVramInventory({
        // (2026-08-09) The inventory's OWN header names this its first
        // source ("named render targets, from the allocator's own onCreate
        // hook") — never wired until now. Live-confirmed missing: a real
        // perf report read `renderTargets.count: 0` against ~390 MB of
        // actual screen-sized targets.
        targets: getVtPanViewerRenderTargets(),
        // `.wholeImage`, NOT the diagnostics root — `estTextureVramMB` lives on
        // the whole-image summary (vt-pan-viewer-diagnostics.js's
        // summarizeWholeImage). Passing the root silently produced an
        // all-null VRAM block on the first real run.
        vtEstimate: getVtPanViewerDiagnostics?.()?.wholeImage ?? null,
        // The MEASURED device-loss wall on the reference machine
        // (keyhole-device-loss-large-map), not a guess.
        ceilingMb: 2500,
      }),
    // PIPELINE HEALTH (2026-08-09) — see getVtPanViewerPipelineStats's own
    // header for the mystery this exists to narrow down. Optional on the
    // ProfileHarness typedef (perf-session.js checks `typeof === 'function'`
    // before calling either sample), so the fake harness in that file's own
    // tests needs no update to stay green.
    readPipelineStats: () => getVtPanViewerPipelineStats(),
    // DEPTH-PROXY MATERIAL POOL HEALTH (DEFERRED-S1b, 2026-08-11) — same
    // optional-hook shape as readPipelineStats one line up. Reads straight
    // through to the diagnostics field `rebuildSceneDepthProxies`'s own pool
    // already exposes (vt-pan-viewer.js), so this is a proof-of-work counter,
    // not a new measurement: the pool's OWN lifetime hits/misses/evictions,
    // sampled before/after the window by perf-session.js exactly like
    // pipeline stats, so a report can show whether it actually did anything
    // during THIS run rather than needing a CPU sample profile to find out
    // (which is how this fix's own root cause was originally found).
    // BUG FOUND LIVE, 2026-08-11 (first real perf-run-full capture after this
    // hook shipped): this called `getVtPanViewerDiagnostics()`, whose return
    // shape is `buildViewerDiagnostics(...)` — `depthProxyMaterialPool` is
    // not now and was never one of its fields (grep-verified: the pool's
    // stats live ONLY inside `getEarlyZComposition()`'s return object,
    // vt-pan-viewer.js). Silently always null, in a shape that looks
    // identical to "the harness doesn't implement this hook" —
    // perf-session.js cannot tell the two apart, so the report never said a
    // word. Same wrong-accessor confusion already caught once this session
    // via live console debugging (see `[[feedback_sandboxed_browser_pane_lacks_os_focus]]`'s
    // sibling note) and never propagated back into this wiring. Fixed to the
    // accessor that actually carries the field.
    readDepthProxyPoolStats: () => getVtPanViewerEarlyZComposition?.()?.depthProxyMaterialPool ?? null,
    // SHADER-REBUILD CHURN (2026-08-11) — see shader-rebuild-probe.js's own
    // header for the mechanism and `feedback_pool_health_needs_a_loud_gate`
    // for why this is wired in AUTOMATICALLY rather than staying a manual
    // console tool: the vegetation depth-proxy fix that closed one instance
    // of this bug was only found by hours of Chrome-trace archaeology,
    // because nothing watched the pool's own hit rate loudly enough to
    // matter. Every perf-run-full now arms this for the measured window,
    // same shape as setGpuZoneTimer — optional on the harness typedef, so a
    // caller (or this file's own test fixtures) without it just measures
    // without this instrument, same as every other optional hook here.
    setShaderRebuildProbe: (on) => setVtPanViewerShaderRebuildProbe(on),
    readShaderRebuildStats: () => getVtPanViewerShaderRebuilds(),
    // PIPELINE-REBUILD CHURN (2026-08-12) — one cache layer downstream of the
    // shader-rebuild probe just above: see pipeline-rebuild-probe.js's own
    // header for why a miss here can happen even when that probe reads a
    // clean 0-miss window at the same time. Same auto-arm-for-the-measured-
    // window discipline, same optional-hook shape.
    setPipelineRebuildProbe: (on) => setVtPanViewerPipelineRebuildProbe(on),
    readPipelineRebuildStats: () => getVtPanViewerPipelineRebuilds(),
    // PASS-SLOT ALLOCATOR (perf-instrumentation-audit-2026-08-12, cache
    // completeness pass) — `perfProfiler` is a plain module-level object, not
    // viewer-dependent (see its own `const perfProfiler = createFrameProfiler()`
    // near the top of this file), so this needs no `?.` guard the way every
    // `getVtPanViewer*` hook above does. `capacity()` is already relative to
    // the last `arm()` (`reset()` clears `passSlots` and `passSlotOverflow` on
    // every arm — frame-profiler.js), so a single post-disarm read already IS
    // this window's own count, same reasoning as readShaderRebuildStats above.
    readPassSlotStats: () => perfProfiler.capacity(),
    // WINDOW-SURFACE COMPOSITION (2026-08-12) — chasing a real, still-open
    // finding: `light.drawWindowLight` reports ~4 GPU draw calls per
    // renderer.render() call where "one mesh, one quad" (window-surface-
    // subsystem.js's own header) predicts 1. `getVtPanViewerDiagnostics().
    // windowLight` already exists (fed from `getWindowLightInfo()`, one
    // entry per floor that has ever synced) — this just gives perf-session.js
    // its own named seam to read it through, matching every other optional
    // read-once hook here, rather than reaching into the general diagnostics
    // blob by hand.
    readWindowDiagnostics: () => getVtPanViewerDiagnostics()?.windowLight ?? null,
    // WORLD-DRAW COMPOSITION (2026-08-12, Testament Track B.1) — a snapshot,
    // not a delta, same reasoning as readWindowDiagnostics immediately above:
    // "what's actually in the draw right now" needs no start/end pairing.
    // `null` means the viewer has not started; see getGeometryComposition's
    // own doc in vt-pan-viewer.js for what this answers and its own honest
    // ownership-vs-GPU-time caveat.
    readGeometryComposition: () => getVtPanViewerGeometryComposition(),
    // CACHE HEALTH (perf-instrumentation-audit-2026-08-12) — every cache this
    // composition root can reach that isn't already covered by one of the
    // dedicated probes above (readPipelineStats/readDepthProxyPoolStats/
    // readShaderRebuildStats/readPipelineRebuildStats keep their own existing
    // report fields — see `cache-report.js`'s own header for why those are
    // mirrored into `caches[]` rather than duplicated). A keyed object, not
    // an array: perf-report.js matches start/end snapshots by key, and a
    // plain object needs no separate id field per entry. `null` per key when
    // the underlying read isn't reachable (viewer not started, mask
    // authority not constructed) — never a fabricated zero.
    readCacheStats: () => ({
      vtPageCache: getVtPanViewerDiagnostics()?.cacheStats ?? null,
      vtDecodePool: getVtPanViewerDiagnostics()?.decodeStats ?? null,
      vegetationProxyNodeCache: getVtPanViewerVegetationProxyCacheStats?.() ?? null,
      pointLightWallClip: getVtPanViewerPointLightWallClipCacheStats?.() ?? null,
      maskAuthorityBakeGate: maskAuthority?.getBakeStats?.() ?? null,
      // TIER A (cache-completeness pass, perf-instrumentation-audit-2026-08-12
      // §5F) — three more caches that already had native stats and needed no
      // new instrumentation, only wiring: the BC1/BC7 + coarse-alpha-grid
      // background worker, the coarse-alpha per-item request memoization (a
      // DIFFERENT layer — see cache-report.js's own note on why these two
      // don't collapse into one row), and the water body's jump-flood
      // bake-vs-poll gate (same bakeRuns/bakeSkips doctrine as
      // maskAuthorityBakeGate above, water-body-subsystem.js's own numbers).
      compressedTextureWorker: getVtPanViewerDiagnostics()?.wholeImage?.compressed?.worker ?? null,
      coarseAlphaGridRequests: getVtPanViewerDiagnostics()?.wholeImage?.coarseAlpha ?? null,
      waterBodyBakeGate: getVtPanViewerDiagnostics()?.waterBody ?? null,
      // `wholeImage.sunShadows` (yes, nested under that key — see
      // summarizeWholeImage's own header in vt-pan-viewer-diagnostics.js for
      // why; a mechanical extraction, not a redesign) carries `.floors[]`,
      // one entry per active floor slot, each with its own `.bakeGate` —
      // sun-shadow-subsystem.js's two per-floor gates (caster field vs the
      // shadow field itself). cache-report.js sums both across floors.
      sunShadowBakeGate: getVtPanViewerDiagnostics()?.wholeImage?.sunShadows ?? null,
      // FIRE MASK/SPAWN — this composition root's OWN two single-slot
      // caches (fireMaskCache/fireSpawnCache above), gated on the same
      // floorIndex+signature+version triple. Closure-local counters, read
      // directly — no getter indirection needed, unlike the module-owned
      // caches above.
      fireMaskBakeGate: { bakeRuns: fireMaskBakeRuns, bakeSkips: fireMaskBakeSkips },
      fireSpawnBakeGate: { bakeRuns: fireSpawnBakeRuns, bakeSkips: fireSpawnBakeSkips },
      windFieldBakeGate: getVtPanViewerWindBakeStats?.() ?? null,
      islandPackBakeGate: getVtPanViewerDiagnostics()?.specular ?? null,
      // POOL HEALTH (cache-completeness pass, 2026-08-12) — five more mesh/
      // resource pools: point-light-pool.js's own three registries, this
      // file's own three (regionMeshes/occlusionDiscs/itemStates, one
      // reader), door-graphics-subsystem.js's two, and the IndexedDB
      // page-blob persistence layer (viewer-independent, no `?.()` needed).
      pointLightMeshPools: getVtPanViewerPointLightMeshPoolStats?.() ?? null,
      vtMeshPools: getVtPanViewerPoolStats?.() ?? null,
      doorPools: getVtPanViewerDoorPoolStats?.() ?? null,
      pyramidStore: getPyramidStoreStats(),
      // UI/EDITOR CACHES (cache-completeness pass, 2026-08-12) — lower
      // priority than the render-path pools above (GM-only tooling, not a
      // live-gameplay hot path), but every single cache means these too.
      // describeRenderMode is viewer-independent (module-level, like
      // pyramidStore); the other three read GM-tool state that may not
      // exist yet this session (painter/anchor tools install once at boot
      // but their own internal state only matters once entered).
      describeRenderMode: getDescribeRenderModeStats(),
      paintModeGridCache: MapShine.__painter?.getGridCachePoolStats?.() ?? null,
      anchorMarkerPool: MapShine.__anchorMode?.getMarkerPoolStats?.() ?? null,
      anchorViewMarkerPool: MapShine.__anchorViewMode?.getMarkerPoolStats?.() ?? null,
      // SPECIAL CASES (cache-completeness pass, 2026-08-12 §5F-3) — three
      // caches that do not fit the standard start/end-delta shape, each for
      // a DIFFERENT reason. See cache-report.js's own header for graph/
      // frame-graph.js's pool, deliberately absent (zero live callers —
      // graph/index.js's own header — there is nothing to measure, not
      // "not measured yet"). maskDiscovery and pixiProxy below ARE wired,
      // just not as ordinary hit/miss pairs.
      maskDiscovery: maskAuthority?.getDiscoveryStats?.() ?? null,
      pixiProxy: getPixiProxyStats(),
    }),
    // HIDE-WHILE-MEASURING, the pair — see debugPanelVisibleBeforeHide's own
    // declaration a few lines up for the full rationale. Both optional on the
    // ProfileHarness typedef, matching every other harness hook here
    // (perf-session.js checks `typeof === 'function'` before calling either),
    // so the fake harness in perf-session.test.mjs needs no update to stay
    // green — a run without either hook simply measures with the UI exactly
    // as it already sends it.
    hideLiveUi: () => {
      debugPanelVisibleBeforeHide = MapShine.debug?.isPanelVisible?.() ?? false;
      MapShine.debug?.hidePanel?.();
    },
    restoreLiveUi: () => {
      if (debugPanelVisibleBeforeHide) MapShine.debug?.showPanel?.();
    },
    // The sweep, consumed as an INDEPENDENT cross-check of zone attribution.
    // Two methods measuring the same effect and disagreeing is information —
    // perf-report.js classifies the disagreement rather than averaging it away.
    runSweep: () => runSweep(perfHarness),
    // See `structuralToggleHooks`'s own declaration (above `perfHarness`) for
    // the full rationale — shared between both harnesses, not duplicated.
    ...structuralToggleHooks,
    // ALBEDO CLARITY STRUCTURAL A/B (2026-08-15, diag/perf-sharpening-ab.js)
    // — NOT part of structuralToggleHooks's generic id-dispatch shape, and
    // deliberately so: that dispatcher's "flip the toggle, wait N frames"
    // settle model is wrong here (shouldUseFullAlbedoClarity is a real
    // shader-graph fork baked in at MATERIAL BUILD time — see that
    // function's own doc in vt-pan-viewer.js — no amount of frame-waiting
    // rebuilds an already-compiled material). Only `profileHarness` gets
    // these two: `perfHarness` has no armProfiler/waitFrames/GPU-zone-timer
    // primitives to measure with, so there is nothing for it to do with them.
    readAlbedoClarityForce: () => getVtPanViewerAlbedoClarityForce()?.forced ?? null,
    /**
     * Force the CAS shader variant, then actually make it stick: restart the
     * real-scene viewer on the CURRENTLY VIEWED floor (no material rebuild
     * exists below a full stop/start — confirmed by grepping every
     * `registerAction` in this file for a lighter alternative; there isn't
     * one). No re-entrancy guard exists on `startVtPanViewer` itself, so
     * `stopVtPanViewer()` is called explicitly, every time, before the next
     * start — never assumed. Camera position survives for free: a real-scene
     * start always passes `followFoundryCamera: true`, and the viewer's own
     * `syncFoundryCamera()` overwrites its view from `canvas.stage` on the
     * very first tick, so there is nothing here to capture or restore.
     * @param {boolean|null} mode
     * @returns {Promise<{ok: boolean, error?: string}>}
     */
    restartViewerWithAlbedoClarityForce: async (mode) => {
      setVtPanViewerAlbedoClarityForce(mode);
      const sceneDoc = getActiveSceneDoc();
      const floorsResult = getActiveSceneFloors(sceneDoc);
      if (!floorsResult.ok) {
        return { ok: false, error: floorsResult.error ?? 'could not read this scene’s floors' };
      }
      const floorIndex = resolveFloorDescriptor(sceneDoc, floorsResult.floors);
      stopVtPanViewer();
      const result = await startRealSceneViewer(floorIndex);
      if (result?.ok === false) return result;
      // EVENT-DRIVEN wait first (same instrument the multi-floor phase already
      // trusts), THEN the same fixed margin a real floor change gets — a full
      // restart reconstructs strictly more than a floor switch does (the
      // occlusion mask, scene depth, water body, sun shadows, specular,
      // window light, point-light pool, door graphics — everything), so it
      // earns at least the same buffer, never less.
      await waitForSceneSettled({
        onProgress: (s) =>
          showPerfProgress(
            `sharpening A/B — viewer restarted, settling (${(s?.waitingFor ?? []).join(', ') || 'starting'})`
          ),
      }).catch(() => {});
      await pause(FLOOR_CHANGE_SETTLE_BUFFER_MS);
      return result;
    },
  };

  const perfHud = createPerfHud({
    profiler: perfProfiler,
    arm: () =>
      perfProfiler.arm({
        owner: 'hud', // so a profile session refuses rather than fighting the HUD's resets
        settleFrames: 0, // a live view wants THIS quarter-second, not a settled average
        // Zero-allocation reads (2026-08-09) — see profileHarness's own
        // armProfiler comment above for why this matters more here than
        // almost anywhere else: the live HUD stays armed continuously, not
        // just for one profile run.
        readDrawCalls: () => readVtPanViewerDrawCallsOnly(),
        readTriangles: () => readVtPanViewerTriangleCountOnly(),
      }),
    disarm: () => perfProfiler.disarm(),
    setGpuZoneTimer: (on) => setVtPanViewerGpuZoneTimer(on),
    readGpuStatus: () => getVtPanViewerGpuZoneStatus(),
  });

  // The full run: zones AND the on/off sweep, so every effect gets both a direct
  // and a marginal measurement and the report can say where they disagree.
  //
  // THE ONE BUTTON (2026-08-06, author directive: "I would like a single button
  // which runs both a GPU and CPU report... I don't mind if you make the report
  // generation take much longer, accuracy is more important... imagine that this
  // tool might be used by a lay person, so a single performance button is the
  // way to go"). This USED TO be three separate actions — a quick static zone
  // profile ('perf-run'), a camera-driven benchmark with no sweep
  // ('perf-benchmark'), and this one (zone profile + sweep, no camera movement)
  // — each answering a different sliver of "what's slow" and leaving it to the
  // reader to know which button gives which half. All three are now this ONE
  // action: the camera drives a real N→S traversal (so residency/paging work
  // shows up, not just a static view) WHILE the per-zone CPU+GPU profile
  // measures it, and the effect sweep — the ONLY way to see grade/water/
  // vegetation's cost, none of which have a zone of their own — runs
  // afterward as an independent cross-check (perf-report.js's `effects[]`
  // already reconciles the two automatically). Every settle/sample knob below
  // is turned up for accuracy, not speed, on purpose.
  MapShine.debug.registerAction(
    'perf-run-full',
    // ~2-3 min for a single floor; a multi-floor scene adds a second sweep
    // plus an EVENT-DRIVEN settle wait (vt/settle.js) that can genuinely run
    // several extra minutes on a cold floor — see the multi-floor phase's
    // own header below for why that is correct, not a regression.
    '🔬 Performance Report (this scene, CPU + GPU, ~2–3 min, longer if multi-floor)',
    async () => {
      const path = buildBenchmarkPath(); // throws BEFORE anything runs if no scene is loaded
      // MIN_ACTION_PAUSE_MS's own doc — a fixed floor before this (or any)
      // phase's camera sweep starts moving.
      await pause(MIN_ACTION_PAUSE_MS);
      const started = new Date().toISOString();
      // Start the camera moving, then profile WHILE it moves — the route IS the
      // workload, so the measurement window is exactly its duration and every
      // resident-page/paging cost a static view would never trigger gets a
      // chance to show up.
      // capFrameRate:false — this route drives a MEASUREMENT, not a recording; see
      // isCameraPathPlayingCapped's own doc for the 2026-08-10 bug this fixes.
      const playing = playCameraPath(path, { capFrameRate: false }).catch((err) => {
        log.error('camera path playback failed during the performance report run:', err);
      });
      try {
        lastPerfProfile = await runProfileSession(profileHarness, {
          generatedAt: started,
          measureUntil: playing,
          // ⚠️ THE EFFECT SWEEP IS OFF BY DEFAULT AS OF 2026-08-12, and this is
          // a deliberate removal of work, not an oversight.
          //
          // It costs 18 configs (~1.5-3 minutes, over half this action's total
          // runtime) and has produced ZERO usable per-effect numbers in three
          // consecutive real captures. That is not a tuning problem. The method
          // diffs two WHOLE-FRAME GPU medians, so its resolution floor is set by
          // frame-scale variance — measured at 7.3ms on the 2026-08-12 run, and
          // 12.8ms of that run's own opening-vs-closing baseline drift — while
          // the effects it is asked to price cost ~0.5ms each. Every one of the
          // 15 fell inside the floor and was correctly rejected. Running it
          // again would burn the same minutes to reject them again.
          //
          // What replaced it: `includeStructuralAB` (default on, three short
          // parked blocks) answers a question the sweep never could, using the
          // per-zone GPU timer, which is both finer and more direct. And the
          // effects the sweep was the ONLY route for (water, vegetation, fluid,
          // grade) are now named explicitly by the report's own
          // `effects-unpriceable` finding as a STANDING instrument gap needing a
          // zone bracket — which is the honest status, and more useful than a
          // column of rejected noise that made the gap look like bad luck.
          //
          // Not deleted, just not automatic: perf-lab's sweep remains wired and
          // tested, and passing `includeSweep: true` here still runs it for
          // anyone who wants it on a quiet machine.
          includeSweep: false,
          // 3x the profiler's own default (DEFAULT_SETTLE_FRAMES=30) — this run
          // is already ~2-4 minutes end to end, so a few extra seconds letting
          // shader compiles/the first residency pass/the first bake clear
          // before the timed window starts is free by comparison, and buys a
          // cleaner window than the quick actions this replaces ever had.
          settleFrames: 90,
          route: `n_to_s:${path.keyframes.length}kf/${BENCHMARK_SWEEP_MS}ms`,
          onProgress: (phase, detail) => {
            log.info(`perf report: ${phase}${detail ? ` — ${detail}` : ''}`);
            // ON-SCREEN, INDEPENDENT OF THE DEBUG PANEL (2026-08-11) — hideLiveUi
            // already took the panel away for this whole run; without this the
            // author has nothing to look at for minutes. showPerfProgress lazily
            // creates on its first call and dirty-checks every call after, so
            // this is safe to call on every tick.
            showPerfProgress(formatPerfProgressText(phase, detail));
          },
        });
      } finally {
        stopCameraPath();
        await playing;
        hidePerfProgress();
      }

      // PHASE 2: MULTI-FLOOR (multi-floor-sweep-2026-08-12, author's own
      // design: "single scene camera sweep, then go up a floor (only if
      // there is another floor) wait a long time for the upper floor to
      // settle, then do another sweep on there"). Best-effort and fully
      // isolated from phase 1's own try/finally above: any failure here is
      // caught and recorded in `multiFloor.reason`, never lets a working
      // floor-1 report come back empty-handed because floor 2 misbehaved.
      let multiFloor = null;
      let switchedAwayFromFloorIndex = null; // set only once a REAL switch happened — see the restore finally below
      try {
        // getActiveSceneDoc() (foundry/adapter-only) — never a fresh
        // `typeof canvas` check here; that ratchet is already at its bound.
        const sceneDoc = getActiveSceneDoc();
        const floorsResult = getActiveSceneFloors(sceneDoc);
        if (!floorsResult.ok) {
          multiFloor = { compared: false, reason: floorsResult.error ?? 'could not read this scene’s floors' };
        } else if (floorsResult.floors.length <= 1) {
          multiFloor = { compared: false, reason: 'this scene has only one floor — nothing to switch to' };
        } else {
          const floors = floorsResult.floors;
          const startFloorIndex = resolveFloorDescriptor(sceneDoc, floors);
          const startPos = floors.findIndex((f) => f.index === startFloorIndex);
          // "up" = next HIGHER elevation, i.e. the next entry in `floors`
          // (already elevation-sorted ascending — getActiveSceneFloors' own doc).
          const nextFloor = startPos >= 0 && startPos + 1 < floors.length ? floors[startPos + 1] : null;
          if (!nextFloor) {
            multiFloor = {
              compared: false,
              reason: `already on the top floor (index ${startFloorIndex}, "${floors[startPos]?.name ?? '?'}") — nothing above it to sweep`,
            };
          } else {
            log.info(`perf report: switching floor ${startFloorIndex} -> ${nextFloor.index} for the multi-floor phase`);
            showPerfProgress('switching to the floor above for a second sweep…');
            const switchResult = await setVtPanViewerFloor(nextFloor.index);
            if (switchResult.changed) switchedAwayFromFloorIndex = startFloorIndex;
            // Without this, the second sweep would measure floor 2's art/geometry
            // cost while fire/candle/lightning still rendered floor 1's content and
            // doors stayed scoped to floor 1's level — see `syncActiveFloorContext`'s
            // own header for the general gap this closes.
            if (switchResult.changed) syncActiveFloorContext(nextFloor.index);
            // EVENT-DRIVEN, NOT A GUESSED SLEEP — waitForSceneSettled polls
            // vt/settle.js's real "is everything actually on screen yet?"
            // signal, exactly why that module exists (its own header: "every
            // fixed waitForTimeout... is a guess standing in for this
            // module"). Skipped only when the floor genuinely did not
            // change (nothing to settle from).
            const settleInfo = switchResult.changed
              ? await waitForSceneSettled({
                  onProgress: (s) =>
                    showPerfProgress(
                      `floor ${nextFloor.index} settling — ${(s?.waitingFor ?? []).join(', ') || 'starting'}`
                    ),
                })
              : null;
            // FLOOR_CHANGE_SETTLE_BUFFER_MS's own doc — a fixed margin ON TOP
            // of the event-driven wait above, sized for the specific hitch
            // the author reported here: "the performance sweep goes up a
            // floor it encounters a hitch which is entirely to do with
            // loading". Only after a REAL switch — nothing to buffer
            // against otherwise, so the no-switch path still gets its own
            // MIN_ACTION_PAUSE_MS floor instead.
            showPerfProgress(switchResult.changed ? 'floor settled — extra settle margin…' : 'preparing…');
            await pause(switchResult.changed ? FLOOR_CHANGE_SETTLE_BUFFER_MS : MIN_ACTION_PAUSE_MS);

            const path2 = buildBenchmarkPath();
            const playing2 = playCameraPath(path2, { capFrameRate: false }).catch((err) => {
              log.error('camera path playback failed during the multi-floor phase:', err);
            });
            let floor2Report = null;
            try {
              floor2Report = await runProfileSession(profileHarness, {
                generatedAt: new Date().toISOString(),
                measureUntil: playing2,
                includeSweep: false,
                settleFrames: 90,
                route: `n_to_s:${path2.keyframes.length}kf/${BENCHMARK_SWEEP_MS}ms:floor=${nextFloor.index}${settleInfo?.timedOut ? ':UNSETTLED-TIMEOUT' : ''}`,
                onProgress: (phase, detail) => {
                  log.info(`perf report (floor ${nextFloor.index}): ${phase}${detail ? ` — ${detail}` : ''}`);
                  showPerfProgress(formatPerfProgressText(`floor ${nextFloor.index}: ${phase}`, detail));
                },
              });
            } finally {
              stopCameraPath();
              await playing2;
            }

            lastMultiFloorSecondReport = floor2Report;
            // REUSE summarizeTierComparison — 'profile' just means 'floor' here.
            // Its own header already solved "don't nest two full reports":
            // v1 of the all-tiers report did that and was rejected as "~300KB,
            // mostly duplication" — the full second report lives in
            // lastMultiFloorSecondReport / MapShine.getMultiFloorReport()
            // instead, exactly like lastAllTiersReports/getTierReport.
            const comparison = summarizeTierComparison([
              { profile: `floor-${startFloorIndex}`, report: lastPerfProfile },
              { profile: `floor-${nextFloor.index}`, report: floor2Report },
            ]);
            multiFloor = {
              compared: true,
              baseFloorIndex: startFloorIndex,
              secondFloorIndex: nextFloor.index,
              secondFloorName: nextFloor.name ?? null,
              // THE SWITCH ITSELF, measured separately from steady-state
              // cruising on floor 2 — conflating "just switched" cost with
              // "cruising" cost would hide exactly the transient this phase
              // exists to see (author's own framing: "wait a long time").
              switchTransient: {
                switchMs: settleInfo?.elapsedMs ?? null,
                settled: settleInfo?.settled ?? !switchResult.changed,
                timedOut: settleInfo?.timedOut ?? false,
                blockersAtEnd: settleInfo?.blockers ?? [],
              },
              note:
                'The FULL second-floor report is not nested here — call MapShine.getMultiFloorReport() from the ' +
                "console for it, without paying for a second run. 'ranked' below is the direct answer to 'which " +
                "zone/effect is worst across floors', reusing perf-report-all-tiers' own comparison shape.",
              ...comparison,
            };
          }
        }
      } catch (err) {
        log.error('perf report: multi-floor phase failed — floor-1 report above is still valid:', err);
        multiFloor = { compared: false, reason: `multi-floor phase threw: ${err?.message ?? err}` };
      } finally {
        // ALWAYS return to the floor the author was actually looking at — a
        // performance report must never leave the scene somewhere else than
        // it found it, on any exit path (success, timeout, or thrown error).
        if (switchedAwayFromFloorIndex !== null) {
          try {
            const restoreResult = await setVtPanViewerFloor(switchedAwayFromFloorIndex);
            syncActiveFloorContext(switchedAwayFromFloorIndex);
            // THE RESTORE IS A REAL FLOOR LOAD TOO (multi-floor-hitch-2026-08-12)
            // — Phase 3 (rapid stress) runs next, on whatever this restored,
            // and previously started measuring immediately with zero settle
            // time for it. Same event-driven-wait-then-fixed-margin shape as
            // the forward switch above, so Phase 3 doesn't inherit a loading
            // hitch from switching BACK.
            if (restoreResult.changed) {
              await waitForSceneSettled({
                onProgress: (s) =>
                  showPerfProgress(
                    `floor ${switchedAwayFromFloorIndex} settling (restore) — ${(s?.waitingFor ?? []).join(', ') || 'starting'}`
                  ),
              });
              showPerfProgress('floor restored — extra settle margin…');
              await pause(FLOOR_CHANGE_SETTLE_BUFFER_MS);
            }
          } catch (err) {
            log.error('perf report: failed to restore the original floor after the multi-floor phase:', err);
          }
        }
        hidePerfProgress();
      }
      lastPerfProfile.multiFloor = multiFloor;

      // PHASE 3: RAPID DIAGONAL STRESS (rapid-diagonal-stress-2026-08-12,
      // author's own design: "move to the bottom left of a scene, then do a
      // much more rapid 5 second sweep to top right and specifically record
      // performance in that move as a measure of the performance issues
      // during rapid camera movements"). Independent of phase 2 — runs
      // regardless of whether the multi-floor phase found another floor,
      // stays on whatever floor phase 2's own finally already restored.
      // Best-effort, same posture as phase 2: any failure here is caught and
      // recorded, never invalidates the floor-1 report above it.
      let rapidStressSweep = null;
      try {
        showPerfProgress('preparing for rapid stress sweep…');
        // MIN_ACTION_PAUSE_MS's own doc. On top of whatever margin the floor
        // restore above already added (only when a real multi-floor switch
        // happened) — cheap insurance either way, and this phase's own p99/
        // max are exactly the numbers a lingering load hitch would corrupt.
        await pause(MIN_ACTION_PAUSE_MS);
        showPerfProgress('rapid diagonal stress sweep — bottom-left to top-right…');
        const path3 = buildStressSweepPath(); // throws BEFORE anything runs if no scene is loaded
        const playing3 = playCameraPath(path3, { capFrameRate: false }).catch((err) => {
          log.error('camera path playback failed during the rapid-stress phase:', err);
        });
        // RECOVERY WAIT (rapid-pan-hitch-2026-08-12) — playing3 ALONE only
        // covers the scripted 5s sweep; see RAPID_STRESS_RECOVERY_TIMEOUT_MS's
        // own doc for why that used to be exactly where this report stopped
        // watching. Chained onto playing3, not started in parallel with it —
        // recovery is "what happens once the camera has actually stopped",
        // not "what happens during the sweep too".
        const recoveryWait = playing3.then(() =>
          waitForRapidStressRecovery({
            onProgress: (s) =>
              showPerfProgress(`rapid stress: recovering — ${(s?.waitingFor ?? []).join(', ') || 'settling'}`),
          })
        );
        let stressReport = null;
        try {
          stressReport = await runProfileSession(profileHarness, {
            generatedAt: new Date().toISOString(),
            measureUntil: recoveryWait,
            includeSweep: false,
            // Deliberately NOT 90 like phases 1/2 — this phase's whole point
            // is the FIRST few seconds of rapid movement, and a 5s route has
            // no room for a 90-frame (1.5s @ 60fps) settle before measuring
            // most of it away. A few frames is enough to clear the camera's
            // own snap-to-start, nothing more.
            settleFrames: 5,
            route: `sw_to_ne:${path3.keyframes.length}kf/${RAPID_STRESS_SWEEP_MS}ms`,
            onProgress: (phase, detail) => {
              log.info(`perf report (rapid stress): ${phase}${detail ? ` — ${detail}` : ''}`);
              showPerfProgress(formatPerfProgressText(`rapid stress: ${phase}`, detail));
            },
          });
        } finally {
          stopCameraPath();
          await playing3;
        }
        // Already resolved by the time runProfileSession returned above
        // (measureUntil awaited this same promise) — this re-await is just
        // how the caller gets at the VALUE runProfileSession itself discards.
        const recoveryInfo = await recoveryWait;

        lastRapidStressReport = stressReport;
        // REUSE summarizeTierComparison A THIRD TIME — 'profile' means
        // "which regime" here (steady cruise vs. rapid diagonal). Answers
        // "which zone/effect gets disproportionately worse under rapid
        // movement", which is the whole point of running this phase at all.
        const comparison = summarizeTierComparison([
          { profile: 'steady-sweep', report: lastPerfProfile },
          { profile: 'rapid-diagonal-stress', report: stressReport },
        ]);
        rapidStressSweep = {
          measured: true,
          // The REAL measured span (scripted sweep + however long recovery
          // actually took), not the nominal RAPID_STRESS_SWEEP_MS — see
          // recovery.sweepDurationMsNominal below for that number instead.
          durationMs: stressReport?.window?.durationMs ?? RAPID_STRESS_SWEEP_MS,
          // p99/max, NEVER the mean, for the reason this phase's own route
          // builder doc gives: 5 seconds of deliberately-worst-case movement
          // averaged with itself hides exactly the spikes it exists to catch.
          // Now spans the recovery period too, so a hitch that lands AFTER
          // the camera stops is counted here exactly like one during the
          // sweep itself.
          p99FrameMs: stressReport?.frame?.gapMs?.p99 ?? null,
          maxFrameMs: stressReport?.frame?.gapMs?.max ?? null,
          hitchCount: stressReport?.frame?.hitches?.count ?? null,
          // THE RECOVERY WINDOW ITSELF (rapid-pan-hitch-2026-08-12) — real,
          // measured wait time from when the scripted movement ended to when
          // the scene actually went quiet (or the 30s cap was hit). A
          // `timedOut:true` here is real, useful information — it means
          // whatever the author is feeling took LONGER than 30s to resolve,
          // not that the measurement failed.
          recovery: {
            elapsedMs: recoveryInfo.elapsedMs,
            settled: recoveryInfo.settled,
            timedOut: recoveryInfo.timedOut,
            blockersAtEnd: recoveryInfo.blockers ?? [],
            waitingForAtEnd: recoveryInfo.waitingFor ?? [],
            timeoutMs: RAPID_STRESS_RECOVERY_TIMEOUT_MS,
            // The SCRIPTED sweep duration, not a separately-measured
            // boundary — the actual tween runs on real elapsed time
            // (playCameraPath), so this is a close proxy for "how far into
            // durationMs above the camera actually stopped moving", not an
            // exact one. Frame/hitch records in frame.hitches.items (this
            // report's own window) carry their own atMs — cross-reference
            // against this number to split "during the sweep" from "during
            // recovery" rather than treating it as exact.
            sweepDurationMsNominal: RAPID_STRESS_SWEEP_MS,
            note:
              'Real, measured wait time (getVtPanViewerSceneSettle, same tracker the multi-floor phase uses) ' +
              'from when the scripted sweep ended to when the scene actually went quiet, capped at timeoutMs. ' +
              'durationMs/p99FrameMs/maxFrameMs/hitchCount above already include this period — it is not a ' +
              'separate measurement, only the part of the same window after the camera stopped moving.',
          },
          note:
            'The FULL rapid-stress report is not nested here — call MapShine.getRapidStressReport() from the ' +
            "console for it. 'ranked' below answers 'which zone/effect gets disproportionately worse under rapid " +
            "movement', reusing perf-report-all-tiers' own comparison shape.",
          ...comparison,
        };
      } catch (err) {
        log.error('perf report: rapid-stress phase failed — floor-1 report above is still valid:', err);
        rapidStressSweep = { measured: false, reason: `rapid-stress phase threw: ${err?.message ?? err}` };
      } finally {
        hidePerfProgress();
      }
      lastPerfProfile.rapidStressSweep = rapidStressSweep;

      // PHASE 4: SHARPENING A/B (2026-08-15) — same shape as multiFloor/
      // rapidStressSweep above (runs once, AFTER every runProfileSession
      // camera sweep, bolted onto the finished report — NOT threaded through
      // buildPerfReport the way structuralAB is, because runProfileSession
      // itself runs up to 3 times per perf-run-full call; following that
      // exact pattern here would mean 12+ viewer restarts, not 4). Gated
      // behind the console-only kill switch declared above profileHarness —
      // see that declaration for why this phase, unlike its two siblings, is
      // NOT unconditional.
      let sharpeningAB = null;
      if (sharpeningAbEnabled) {
        try {
          showPerfProgress('sharpening A/B — restarting the viewer to compare CAS variants (this is slow)…');
          sharpeningAB = await runSharpeningAB(profileHarness, {
            onProgress: (phase, detail) => {
              log.info(`perf report: ${phase}${detail ? ` — ${detail}` : ''}`);
              showPerfProgress(formatPerfProgressText(phase, detail));
            },
          });
        } catch (err) {
          log.error('perf report: sharpening A/B phase failed — everything above is still valid:', err);
          sharpeningAB = {
            ran: false,
            skipped: 'threw',
            note: `sharpening A/B phase threw: ${err?.message ?? err}`,
            toggles: [],
          };
        } finally {
          hidePerfProgress();
        }
      } else {
        sharpeningAB = {
          ran: false,
          skipped: 'disabled-by-default',
          note: 'Off by default — the real cost of 4 viewer restarts has never been timed live. Enable with MapShine.setSharpeningAbEnabled(true) before running perf-run-full.',
          toggles: [],
        };
      }
      lastPerfProfile.sharpeningAB = sharpeningAB;

      // Feed the sweep's OWN rich per-effect table (perf-lab.js's tested
      // renderer) from the SAME run, via the raw sweep buildPerfReport echoes
      // back — no second sweep, no reshaping effects[] back into the shape
      // renderResults expects. Guarded since 2026-08-12: with includeSweep off
      // by default there is usually no sweep to render, and pushing a null
      // through would replace the panel's last real result with an empty table
      // that reads as "the sweep ran and found nothing".
      if (lastPerfProfile.sweepRaw?.summary) {
        perfLab.renderResult(lastPerfProfile.sweepRaw.summary, lastPerfProfile.sweepRaw.context ?? null);
      }
      // THE DISPLAYED SUMMARY (2026-08-12, author: "improve the displayed
      // information that appears after a run... a non-technical user" can
      // read it). On screen the moment the run finishes — never requires
      // opening or parsing the JSON this action also returns.
      if (lastPerfProfile.summary) {
        log.info(formatOffenderSummaryText(lastPerfProfile.summary));
      }
      // See perf-run's old comment (now folded into this one): the panel copies
      // the RETURN VALUE, always after entry.fn() resolves — a manual
      // copyToClipboard() here would be silently clobbered.
      MapShine.debug.refreshControls();
      return lastPerfProfile;
    },
    { zone: 'performance' }
  );

  // EARLY-Z A/B, THE FULL SWEEP TWICE (2026-08-12) — author directive, given
  // directly in response to the combined report's first early-Z verdict:
  // *"Make the Early-Z part of the performance sweep. Make it do something
  // like an A/B - even doing the whole sweep twice in both modes."*
  //
  // Not folded into `perf-run-full`: this doubles perf-lab's own sweep cost,
  // which is already the exact ~1.5-3 minute expense `perf-run-full`'s own
  // `includeSweep: false` above was written to avoid paying by default. It is
  // a second, slower, standalone instrument for one specific question, not a
  // replacement for the fast default path.
  //
  // See `perf-lab.js#runSweepStructuralAB` for the method and its own
  // honesty caveats — most importantly, the noise floor this comparison uses
  // is a CONSERVATIVE APPROXIMATION across two independent sweeps, not a
  // same-run measurement the way `perf-structural-ab.js`'s parked A/B's is.
  // Read both: this instrument's own `baseline.gpuMs` (all effects off) is
  // the cleanest possible reading of the toggle's raw pipeline cost, at the
  // price of ~4-8 minutes instead of ~1.
  //
  // CONSOLE-ONLY, NOT A PANEL BUTTON (2026-08-12, author: "just a single
  // performance report button"; see feedback_debug_ui_one_action_one_control
  // — "get rid of anything no longer helpful and tidy everything up"). Not
  // deleted, because it is a genuinely different, real instrument, not a
  // superseded one — `perf-run-full`'s default `includeStructuralAB` already
  // answers this SAME earlyZComposition question with same-run (stronger)
  // evidence for free on every run, so this is now the rare deep-dive escape
  // hatch, not the everyday tool. Call `MapShine.runEarlyZSweepAB()` from the
  // console when the default A/B isn't enough.
  MapShine.runEarlyZSweepAB = async () => {
    profileHarness.hideLiveUi?.();
    try {
      return await runSweepStructuralAB(perfHarness, 'earlyZComposition', {
        onProgress: (phase, detail) => {
          log.info(`early-Z A/B: ${phase}${detail ? ` — ${detail}` : ''}`);
          showPerfProgress(formatPerfProgressText(phase, detail));
        },
      });
    } finally {
      hidePerfProgress();
      profileHarness.restoreLiveUi?.();
    }
  };

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

  /**
   * Build the RAPID DIAGONAL STRESS route (rapid-diagonal-stress-2026-08-12,
   * author's own design: "move to the bottom left of a scene, then do a much
   * more rapid 5 second sweep to top right and specifically record
   * performance in that move as a measure of the performance issues during
   * rapid camera movements"). Same shape as `buildBenchmarkPath` above, just
   * a different preset (`sw_to_ne` — camera-path.js's own corner-to-corner
   * diagonal, added for this) and RAPID_STRESS_SWEEP_MS instead of the
   * steady 60s duration.
   *
   * `longJumpFadeCut: false` IS LOAD-BEARING here too, for the identical
   * reason `buildBenchmarkPath` states it above: a corner-to-corner diagonal
   * is the LONGEST possible pair on the map, guaranteed to trip the
   * long-jump heuristic and fade-cut/teleport instead of sweeping — which
   * would silently turn "rapid movement stress test" into "no movement at
   * all, then an instant cut," the exact bug already found live once on the
   * ORIGINAL north-to-south sweep before this field was ever set explicitly.
   * `generateKeyframePreset`'s own `suggestedLongJumpFadeCut: false` for this
   * preset says so already — read from the producer, not re-guessed.
   * @returns {object} a normalized camera path, ready for `playCameraPath`.
   */
  function buildStressSweepPath() {
    const preset = generatePresetKeyframes('sw_to_ne');
    if (!preset?.keyframes?.length) {
      throw new Error(
        'perf benchmark: could not derive a diagonal stress route from this scene. That needs the live scene ' +
          'dimensions, so load a scene first.'
      );
    }
    return normalizeCameraPath({
      keyframes: preset.keyframes,
      settings: {
        sweepMs: RAPID_STRESS_SWEEP_MS,
        easing: 'linear',
        hideUi: false,
        fadeInMs: 0,
        fadeOutMs: 0,
        longJumpFadeCut: preset.suggestedLongJumpFadeCut,
      },
    });
  }

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
  //
  // NO LONGER "THE" BUTTON — CONSOLE-ONLY (2026-08-12, author: "just a single
  // performance report button"; feedback_debug_ui_one_action_one_control).
  // `perf-run-full` is now the panel's only performance control; this stays a
  // real, deliberately-built capability (nothing here was superseded, it
  // answers a different question — per-tier cost comparison, not "what's
  // slow right now") reachable as `MapShine.runAllTiersPerfReport()` for the
  // rare "compare every quality tier" ask, same posture as `getTierReport`'s
  // own escape-hatch just below.
  MapShine.runAllTiersPerfReport = async () => {
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
          // capFrameRate:false — same fix as perf-run-full above; this is a measurement too.
          const playing = playCameraPath(path, { capFrameRate: false }).catch((err) => {
            log.error(`perf report (all tiers): camera path playback failed during tier '${profile}':`, err);
          });
          try {
            const report = await runProfileSession(profileHarness, {
              generatedAt: new Date().toISOString(),
              measureUntil: playing,
              settleFrames: TIER_SETTLE_FRAMES,
              route: `n_to_s:${path.keyframes.length}kf/${BENCHMARK_SWEEP_MS}ms:tier=${profile}`,
              onProgress: (phase, detail) => {
                log.info(`perf report (all tiers) [${profile}]: ${phase}${detail ? ` — ${detail}` : ''}`);
                // Same on-screen readout as perf-run-full — see its own comment.
                // hidePerfProgress() runs once, after the WHOLE tier loop below,
                // not per tier, so this stays up continuously across tiers
                // instead of flickering closed between each one.
                showPerfProgress(formatPerfProgressText(phase, `[${tag}] ${detail ?? ''}`.trim()));
              },
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
      hidePerfProgress();
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
    MapShine.debug.refreshControls();
    return lastPerfProfile;
  };
  // THE ESCAPE HATCH for lastAllTiersReports — one full perf-profile report
  // for one tier from the LAST all-tiers run, with no second ~10-minute run.
  // Console-only by design: a "which tier" parameter has no natural home in
  // the debug panel's four primitives (report/action/select/panel all assume
  // a fixed signature), and this is a rare, deliberate "show me everything"
  // ask that a console call fits better than a fifth permanent button
  // (feedback_debug_ui_one_action_one_control).
  MapShine.getTierReport = (profile) => lastAllTiersReports?.[profile] ?? null;

  // THE SAME ESCAPE HATCH, for the multi-floor phase's own second-floor
  // report (multi-floor-sweep-2026-08-12) — see lastMultiFloorSecondReport's
  // own doc for why it isn't nested inside the main perf-run-full report.
  MapShine.getMultiFloorReport = () => lastMultiFloorSecondReport;
  // Same escape hatch for the rapid diagonal stress sweep's own full report
  // (rapid-diagonal-stress-2026-08-12).
  MapShine.getRapidStressReport = () => lastRapidStressReport;

  // FIRE'S PER-FRAME COUNTS (wired 2026-08-15) — `{engines, fires, lights,
  // spawnPoints, perEngine}` for the CURRENTLY VIEWED floor. The one number
  // that splits the author's *"fire appears on upper floors but its light
  // doesn't"* report in half: switch to the upper floor and read `lights`.
  // 0 with `fires > 0` ⇒ the descriptors are never built (look upstream, in
  // `fire-subsystem.js`/`buildFireLightSources`); non-zero ⇒ they ARE built and
  // something downstream is discarding them (the pool, or the depth-authority
  // height gate). See `vt-pan-viewer.js#getFireStatus` for why guessing between
  // those without the number is the failure mode, not the shortcut.
  MapShine.getFireStatus = () => getVtPanViewerFireStatus();

  // ═══ ⚖️ THE RECKONING REPORT (TEMPORARY — docs/holy/V4-Reckoning.md) ═══
  // One press, one paste: the campaign's floor-mystery observables in a single
  // clipboard dump (the panel machinery auto-copies every action's result —
  // debug-panel.js's own design). Verdicts lead; raw sections follow. Gathering
  // is per-section fail-soft: a broken section lands in `errors` and the rest of
  // the dump still ships — a half-broken session is exactly when the button
  // matters. The ~2.5 s pause is a REAL armed profiler window on the live frame
  // (owner 'reckoning-report'; if the Live zone ranking HUD owns the profiler,
  // arming throws its own explanatory error — recorded, degraded to the HUD's
  // rolling window, flagged by the verdict layer). Remove this block + the
  // diag/reckoning-report.js module when the Reckoning's R4 gates close.
  // 4 s, not 2.5 s (raised 2026-08-15 after the first live pair): the window is
  // wall-clock, so a floor running at 16 fps returned only 29 measured frames
  // against the ground floor's 291 — thin enough that the report had to caveat
  // its own numbers. A slow floor is exactly where the numbers must be solid.
  const RECKONING_WINDOW_MS = 4000;
  MapShine.reckoningReport = async () => {
    const errors = [];
    const grab = (label, fn) => {
      try {
        return fn();
      } catch (e) {
        errors.push(`${label}: ${e?.message ?? e}`);
        return null;
      }
    };

    const identity = grab('identity', () => ({
      module: MODULE_ID,
      version: game.modules?.get?.(MODULE_ID)?.version ?? 'unknown',
      foundry: game.version ?? 'unknown',
      scene: canvas?.scene?.name ?? null,
      sceneId: canvas?.scene?.id ?? null,
      screen: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    }));
    const census = grab('census', () => getVtPanViewerReckoningCensus());
    const earlyZ = grab('earlyZ', () => getVtPanViewerEarlyZComposition());
    const floorsSection = grab('floors', () => {
      // `getActiveSceneFloors` returns a RESULT WRAPPER ({ok, floors, skipped}),
      // not an array — v1 of this report called `.find` on the wrapper and lost
      // the whole section to "floors.find is not a function" on both floors.
      const res = getActiveSceneFloors(canvas?.scene);
      const floors = res?.ok ? (res.floors ?? []) : [];
      const viewed = census?.view?.floorIndex ?? 0;
      return {
        ok: res?.ok ?? false,
        error: res?.ok ? null : (res?.error ?? 'unknown'),
        count: floors.length,
        viewed,
        visibleIndices: computeVisibleFloorIndices(floors, viewed).map((f) => f?.index ?? f),
        activeFloorContext: activeFloorContext
          ? {
              floorIndex: activeFloorContext.floorIndex,
              levelId: activeFloorContext.levelId ?? null,
              elevation: activeFloorContext.elevation ?? null,
            }
          : null,
        floors: floors.map((f) => ({
          index: f.index,
          id: f.id ?? null,
          name: f.name ?? null,
          bottom: f.elevationBottom ?? null,
          top: f.elevationTop ?? null,
          // WHICH other floors this one composites — the draw-list superset's
          // own cause (foundry/active-scene-source.js#computeVisibleFloorIndices).
          visibilityLevelIds: f.visibilityLevelIds ?? [],
        })),
        skipped: res?.skipped ?? [],
      };
    });
    // THE TEXTURE/VRAM PICTURE — added after the first live pair showed ~83% of
    // the upper-floor frame outside every zone. Driver-level VRAM paging is one
    // of the few mechanisms that can cost that much while touching no pass
    // timestamp, and it is invisible to every other field here.
    const vtDiag = grab('vt.diagnostics', () => getVtPanViewerDiagnostics());
    const vramSection = grab('vram', () =>
      buildVramInventory({
        targets: getVtPanViewerRenderTargets(),
        vtEstimate: vtDiag?.wholeImage ?? null,
        ceilingMb: 2500,
      })
    );
    const wholeImageSection = grab('wholeImage', () => {
      const wi = vtDiag?.wholeImage ?? null;
      if (!wi) return null;
      return {
        itemCount: wi.itemCount ?? null,
        ready: wi.ready ?? null,
        errors: wi.errors ?? null,
        estTextureVramMB: wi.estTextureVramMB ?? null,
        textureLimit: wi.textureLimit ?? null,
        perItem: (wi.perItem ?? []).map((p) => ({
          id: p.id,
          // Basename only — a full asset path per item triples the paste length
          // for nothing; the id already disambiguates.
          src: typeof p.src === 'string' ? p.src.split('/').pop() : p.src,
          status: p.status,
          error: p.error ?? null,
          imageSize: p.imageSize ?? null,
          grid: p.grid ?? null,
          approxVramMB: p.approxVramMB ?? null,
          visible: p.visible ?? null,
          compressed: p.compressed ?? null,
          alphaMin: p.alphaStats?.min ?? null,
        })),
      };
    });
    const effectsSection = grab('effects', () => {
      const rows = effectRegistry.list().map((m) => {
        const layers = deriveEffectLayers(m.id, (key) => readSetting(MODULE_ID, key));
        return {
          id: m.id,
          enabled: resolveEffectEnabled(m, layers),
          gm: layers.gmEnable ?? 'auto',
          player: layers.playerEnable ?? 'auto',
        };
      });
      return {
        profile: readSetting(MODULE_ID, 'performanceProfile') ?? null,
        reducePhotosensitive: readSetting(MODULE_ID, 'reducePhotosensitiveEffects') === true,
        rows,
      };
    });
    // THE FOUNDRY-SIDE CENSUS (added 2026-08-15, report v3) — the one large GPU
    // consumer MSA's own zones can NEVER see, because it lives in Foundry's
    // separate PIXI/WebGL context on Foundry's own ticker.
    //
    // Why it matters, from this repo's own words: `canvas-compositing.js`'s
    // PRIMARY-CACHE-FREEZE FIX (2026-08-13, Bug #18) deliberately leaves
    // `canvas.primary.renderable === true` so `CachedContainer#render` keeps
    // re-rendering every map object into `canvas.primary.renderTexture` each
    // frame — a canvas-RESOLUTION render texture — purely to keep Foundry's own
    // fog shader fed. That file states the cost honestly and then says
    // "Measure before assuming it matters." Nobody ever did. This section is
    // that measurement's raw material: the render texture's size, and how many
    // PIXI objects are actually being re-rendered into it on THIS floor.
    // Both halves live in the foundry adapter (the ONE door for Foundry
    // globals): the seam answers "is Foundry's art showing", the census answers
    // "how much is Foundry's renderer still DOING" — different questions, and
    // only the first had ever been asked.
    const foundryCanvasSection = grab('foundryCanvas', () => ({
      seam: getCanvasCompositingReport(),
      ...getFoundryRendererCensus(),
    }));
    const suspects = grab('suspects', () => ({
      dofEnabled: effectsSection?.rows?.find((r) => r.id === 'depthOfField')?.enabled ?? null,
      windowSurfacesAlive: census?.windowSurfacesAlive ?? null,
      multiFloorReportAvailable: !!lastMultiFloorSecondReport,
      compressedWorker: getCompressedTextureStats(),
    }));

    // The armed window — the only await in the gather.
    let zonesSection = null;
    let armedHere = false;
    let gpuArm = null;
    try {
      // 5 settle frames, not 10: at 16 fps ten frames is 0.6 s of a 4 s window.
      perfProfiler.arm({ owner: 'reckoning-report', settleFrames: 5 });
      armedHere = true;
    } catch (e) {
      errors.push(`zones.arm: ${e?.message ?? e}`);
    }
    try {
      gpuArm = setVtPanViewerGpuZoneTimer(true);
    } catch (e) {
      errors.push(`zones.gpuArm: ${e?.message ?? e}`);
    }
    await new Promise((resolve) => setTimeout(resolve, RECKONING_WINDOW_MS));
    zonesSection = grab('zones.snapshot', () => {
      const snap = perfProfiler.snapshot();
      return {
        frames: snap.frames,
        durationMs: snap.durationMs,
        settleFramesDiscarded: snap.settleFramesDiscarded,
        gpuSupported: gpuArm?.armed === true,
        rows: summarizeZoneRows(snap.zoneStats, snap.frames),
        // The raw frame-to-frame intervals feed `summarizeAttribution`'s
        // percentiles — the honest distribution behind the average, and the only
        // way to tell "uniformly slow" from "fast with periodic 200ms stalls".
        gapSamples: snap.gapSamples,
        gapDropped: snap.gapDropped,
        hitchZones: snap.hitchZones,
        anomalies: snap.anomalies,
      };
    });
    if (armedHere) {
      try {
        perfProfiler.disarm();
      } catch (e) {
        errors.push(`zones.disarm: ${e?.message ?? e}`);
      }
    }
    try {
      setVtPanViewerGpuZoneTimer(false);
    } catch (e) {
      errors.push(`zones.gpuDisarm: ${e?.message ?? e}`);
    }

    return assembleReckoningReport({
      generatedAt: new Date().toISOString(),
      sections: {
        identity,
        floors: floorsSection,
        census,
        earlyZ,
        effects: effectsSection,
        suspects,
        foundryCanvas: foundryCanvasSection,
        vram: vramSection,
        wholeImage: wholeImageSection,
        zones: zonesSection,
        multiFloorRanked: lastMultiFloorSecondReport?.ranked ?? null,
        errors,
      },
    });
  };
  MapShine.debug.registerAction(
    'reckoning-report',
    '⚖️ The Reckoning Report (≈4 s capture)',
    () => MapShine.reckoningReport(),
    { zone: 'performance', primary: true }
  );

  // Its own Show/Hide button lives inside perfHud.el now (2026-08-06) — no
  // external toggle action needed. Deliberately still separate from the ONE
  // report button below: this is a LIVE view for while you pan/zoom/toggle an
  // effect by hand, not a report, and folding it into the report action would
  // mean it could only ever show a snapshot from ~2-4 minutes ago.
  MapShine.debug.registerPanel('perf-hud-panel', 'Live zone ranking', () => perfHud.el, { zone: 'performance' });

  // THE CAMERA-PATH TOOL (2026-07-21, author request: revive V2's camera-pass
  // recorder for PIXI mode, with UI-hide, needed to finish releasing maps).
  // Routed to the 'bridge' zone (ZONES map, diag/debug-panel.js) — Control-
  // Panel.md's own stub scaffold already anticipated "Recall camera" there;
  // this is the first real control to land in Bridge.
  MapShine.debug.registerAction('camera-path-open', '🎥 Camera Path', () => {
    openCameraPathDialog();
    return { opened: true, hint: 'Panel opened (top-right). Capture keyframes from the live view, then Play.' };
  });

  // THE SCENE EXPORTER (2026-08-10, author directive) — see foundry/scene-
  // export.js's own header for the full reasoning: this is the one human-
  // operated bridge to an assistant working on a separate bench world, so an
  // assistant never has to be pointed at the author's real development
  // server. Two registrations sharing one builder: a REPORT (pure — also
  // rides "Export everything" for free) for a quick clipboard copy, and an
  // ACTION for the file the author actually hands over (a full scene export
  // is easily past what anyone should paste into a chat window — the exact
  // reasoning downloadText's own doc already gives for the flight-recorder
  // bundle).
  MapShine.debug.registerReport(
    'scene-export',
    '📦 Scene export (data)',
    () => {
      const r = buildLiveSceneExport();
      return r.ok
        ? { msaVersion: MapShine.version ?? null, ...r.snapshot }
        : { report: 'scene-export', ok: false, reason: r.reason };
    },
    { zone: 'bridge' }
  );
  MapShine.debug.registerAction(
    'scene-export-download',
    '📦 Export Scene (download for AI import)',
    () => {
      const r = buildLiveSceneExport();
      if (!r.ok) return { ok: false, reason: r.reason };
      const text = JSON.stringify({ msaVersion: MapShine.version ?? null, ...r.snapshot }, null, 2);
      const filename = sceneExportFilename(r.snapshot.scene?.name);
      const dl = downloadText(text, filename);
      return {
        ...dl,
        sceneId: r.snapshot.sceneId,
        levels: r.snapshot.levels.length,
        tiles: r.snapshot.tiles.length,
        walls: r.snapshot.walls.length,
        lights: r.snapshot.lights.length,
        regions: r.snapshot.regions.length,
      };
    },
    { zone: 'bridge' }
  );

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

    // Height off floor (2026-08-05) — always its own value, like brightness
    // above: there is no shared "all candles" height to inherit from, so
    // this is a plain param control rather than an inheritable-range-row.
    // Feeds BOTH the flame sprite's own depth-authority gate and the light
    // this candle casts (candle-flame-geometry.js#resolveAnchorElevationWorldUnits,
    // read by both getCandleRenderState's `elevation` field) — see
    // anchor-catalog.js's `elevation` param doc for why depth-authority
    // occlusion needed this authored at all. `patch()`'s `targetIds` fan-out
    // already makes this a genuine batch edit across every selected candle
    // for free.
    wrap.append(
      buildParamControl('elevation', CANDLE_ANCHOR_PARAMS.elevation, {
        value: anchor.params?.elevation ?? 0,
        onChange: (v) => patch({ params: { elevation: v } }),
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

    // Auto-ignite opt-out (2026-08-06) — whether the effect-wide day/night
    // roll (Candle flames panel → Advanced → Presence) is even ALLOWED to
    // touch this candle's own "Lit" above. Sits directly under it since the two
    // controls answer one combined question: "is this candle lit, and who
    // gets to decide that."
    wrap.append(
      buildParamControl('autoIgnite', CANDLE_ANCHOR_PARAMS.autoIgnite, {
        value: anchor.params?.autoIgnite !== false,
        onChange: (v) => patch({ params: { autoIgnite: v } }),
      })
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
        // ⚠️ CORRECTED TWICE (U4 research, 2026-08-18; the brush→render
        // bridge, same day). This used to claim "it reads the mask live" —
        // false at the time: mask-authority.js's own ingest API had exactly
        // two doors (real files on disk, the VT pager's decoded-page
        // stream), and the painter's Save wrote to a scene flag neither
        // read. `ingestPaintedMask` (scene/mask-authority.js) is now a
        // THIRD door, fed on every Save — the effect genuinely updates, on
        // Save, not yet live mid-stroke (see ui/paint-mode.js's own header
        // for that named, separate follow-up).
        'Paint where the effect belongs, then Save — the effect updates on Save (not yet live mid-stroke).',
      onAdd: () => MapShine.__painter?.enter({ kind: kinds[0] }),
    };
  }

  /**
   * Every effect that declares `authoring.paint`, with per-tile mask-found
   * status for the floor you are CURRENTLY viewing — the PAINTER
   * department's own tile grid (U4). Read fresh on every call, never
   * cached: a cached list would report whatever floor was active the last
   * time the department opened, forever.
   * @returns {{id: string, title: string, suffixes: string[], found: boolean}[]}
   */
  function listPaintableEffects() {
    return effectRegistry
      .list()
      .filter((m) => m.authoring?.paint)
      .map((m) => {
        const kinds = Array.isArray(m.authoring.paint) ? m.authoring.paint : [m.authoring.paint];
        const suffixes = kinds.map((k) => maskKindById(k)?.suffixes?.[0] ?? k);
        const found = kinds.some(
          (k) => maskAuthority.authoredStatus(activeFloorContext?.levelId, k)?.source === 'authored'
        );
        return { id: m.id, title: m.title ?? m.id, suffixes, found };
      });
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
      // Anchor View Mode shows every kind's icons at the SAME screen
      // position/z-index this placement session draws its own — leaving
      // both open at once would double-draw every candle icon. One replaces
      // the other rather than stacking (mirrors enterAnchorViewMode's own
      // matching guard, below).
      if (MapShine.__anchorViewMode.isActive()) MapShine.__anchorViewMode.exit();
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

  /** Role-aware icon glyph (`ui/anchor-mode.js`'s `opts.icon` accepts a
   * `(anchor) => glyph` function precisely for this) — start and end read
   * visually distinct at a glance instead of two identical ⚡ with no way to
   * tell which is which. `anchor` is `null` for the toolbar's own generic
   * hint text; falls back to the start glyph there (the more natural "this
   * is what you place first" representative). A waypoint (V2 wandering-line
   * interior point, imported but not yet acted on) gets a neutral marker. */
  function lightningRoleIcon(anchor) {
    const role = anchor?.params?.role;
    if (role === 'end') return '💥';
    if (role === 'waypoint') return '🔹';
    return '⚡';
  }

  /** `[startId, endId]` pairs for every COMPLETE bolt currently served —
   * reuses the SAME pairing `lightning-subsystem.js` itself uses to spawn the
   * real mesh (`groupLightningAnchorsIntoSources`), so the drawn connector
   * line can never disagree with which anchors actually form a bolt. An
   * orphaned single endpoint (placement interrupted mid-pair, or one end
   * deleted) correctly contributes no pair — `anchor-mode.js#drawLines`
   * already skips any id it can't find a marker for, so nothing more is
   * needed here for that case. */
  function lightningLinePairs() {
    const anchors = anchorAuthority.anchorsForEffect('lightning', activeFloorContext);
    const { sources } = groupLightningAnchorsIntoSources(anchors);
    return sources.map((s) => [s.startId, s.endId]);
  }

  /** The OTHER endpoint sharing this one's `linkId` and holding `wantRole` —
   * lets the elevation control below be shown (and correctly patch the START
   * anchor) from EITHER endpoint's own popup. A NULL floor context
   * (`anchorsForEffect`'s own "no filter, show everything" mode) so this
   * lookup always finds the partner regardless of which floor is currently
   * being viewed or either endpoint's own `floorVisibility` — this is a
   * structural lookup (which anchors form one bolt), not a visibility one. */
  function findLightningPartner(anchor, wantRole) {
    const linkId = anchor?.params?.linkId;
    if (!linkId) return null;
    const anchors = anchorAuthority.anchorsForEffect('lightning', null);
    return (
      anchors.find((a) => a.id !== anchor.id && a.params?.linkId === linkId && a.params?.role === wantRole) ?? null
    );
  }

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
          ? '💥 Bolt end (impact point)'
          : '⚡ Bolt waypoint (imported from a V2 wandering line — not yet used)';
    wrap.append(roleLine);

    wrap.append(
      buildParamControl('intensity', LIGHTNING_ANCHOR_PARAMS.intensity, {
        value: anchor.params?.intensity ?? 1,
        onChange: (v) => patch({ params: { intensity: v } }),
      })
    );

    // HEIGHT OFF THE FLOOR (2026-08-05, depth-authority occlusion) — ONE
    // shared value, stored on the start anchor only
    // (`groupLightningAnchorsIntoSources`' own "the start anchor's own value
    // is the bolt's only answer" design), but shown and editable from EITHER
    // endpoint's own popup (author's own ask, 2026-08-05) so nobody has to
    // remember which end "really" owns it. Deliberately writes straight to
    // `startAnchor.id` rather than going through `patch()`/`targetIds` above
    // — unlike `intensity`/`enabled`, "which endpoint's height changes" is
    // never a per-selected-anchor question, it is always "this bolt's start".
    if (role === 'start' || role === 'end') {
      const startAnchor = role === 'start' ? anchor : findLightningPartner(anchor, 'start');
      if (startAnchor) {
        wrap.append(
          buildParamControl('elevation', LIGHTNING_ANCHOR_PARAMS.elevation, {
            value: startAnchor.params?.elevation ?? 0,
            onChange: (v) => updateLightningAnchor(startAnchor.id, { params: { elevation: v } }),
          })
        );
        if (role === 'end') {
          const heightNote = document.createElement('div');
          Object.assign(heightNote.style, { fontSize: '9.5px', opacity: '0.6' });
          heightNote.textContent = 'Shared with this bolt’s ⚡ start point.';
          wrap.append(heightNote);
        }
      } else {
        const heightNote = document.createElement('div');
        Object.assign(heightNote.style, { fontSize: '9.5px', opacity: '0.6' });
        heightNote.textContent = 'This bolt’s ⚡ start point hasn’t been placed yet.';
        wrap.append(heightNote);
      }
    }

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
      if (MapShine.__anchorViewMode.isActive()) MapShine.__anchorViewMode.exit(); // see enterCandlePlacement's own note
      const result = MapShine.__anchorMode.enter({
        kindLabel: 'lightning bolt',
        icon: lightningRoleIcon,
        listAnchors: () => anchorAuthority.anchorsForEffect('lightning', activeFloorContext),
        addAnchor: (wx, wy) => addLightningEndpoint(wx, wy),
        updateAnchor: (id, patch) => updateLightningAnchor(id, patch),
        removeAnchor: (id) => removeLightningAnchor(id),
        buildEditForm: buildLightningEditForm,
        linePairs: lightningLinePairs,
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
          'Click the map to drop the bolt’s ⚡ start, then click again for its 💥 impact point — a line connects the two. Click an existing icon to edit or remove it.',
        onAdd: enterLightningPlacement,
      },
    });
  }

  MapShine.debug.registerPanel('lightning-panel', 'Lightning', buildLightningPanel, {
    zone: 'workshop',
    effect: 'lightning',
    order: 11,
  });

  // ---------------------------------------------------------------------------
  // THE FIRE WORKSHOP PANEL — same FOH/ROH card template as the two above.
  //
  // ⚠️ FIRE HAS TWO SOURCES AND THE CARD SAYS SO. Every other effect here is
  // either painted (water, vegetation) or placed (candle, lightning); fire is
  // both, and its PRIMARY source is the painted region — the region's own width
  // sets each fire's diameter, which then sets everything else. So the card's
  // affordance is Paint, and its status line reports the painted count and the
  // placed count SEPARATELY. An author who paints a region and sees "0 fires"
  // needs to know whether the mask was read at all, not just that nothing drew.
  // ---------------------------------------------------------------------------
  function buildFirePanel({ attachments } = {}) {
    const schema = FIRE_PARAMS;
    const getValue = (id) => {
      const v = fireReadout.params?.[id];
      return v !== undefined ? v : schema[id]?.default;
    };
    const onChange = (id, value) => MapShine.setFire({ [id]: value });

    return buildEffectCard({
      id: 'fire',
      diagnostics: attachments,
      icon: '🔥',
      title: 'Fire',
      subtitle: 'paint a region, or place one',
      status: () => {
        const state = getFireRenderState();
        const painted = state.maskFireCount ?? 0;
        const placed = anchorAuthority.anchorsForEffect('fire', activeFloorContext).length;
        if (!fireReadout.enabled) return 'off';
        if (painted === 0 && placed === 0) return 'nothing painted or placed yet';
        const parts = [];
        if (painted) parts.push(`${painted} painted`);
        if (placed) parts.push(`${placed} placed`);
        return parts.join(' · ');
      },
      schema,
      // A strict, SMALL subset (feedback_foh_roh_must_differ). These are the
      // mid-session questions: how stylised, how big the flames read, how much
      // smoke, how far it lights. Everything else is set-once detail.
      // ⚠️ WIDENED FOR A TUNING SESSION (2026-08-09). The author is driving the
      // look from these controls, so the FOH set is the ones they reach for
      // most — count, lifetime, opacity and the orange-vs-white dial — rather
      // than the usual strict handful. Everything else stays in the ROH card.
      // `maskSensitivity` joined 2026-08-13: a live floor-specific miss (paint
      // that lit on one floor and not another) means this is exactly a
      // reach-for-it-mid-session control right now, not set-once detail.
      fohKeys: [
        'flameCount',
        'flameLifeScale',
        'flameOpacity',
        'flameColorAge',
        'emberCount',
        'smokeCount',
        'maskSensitivity',
      ],
      getValue,
      onChange,
      enabled: fireReadout.enabled,
      onToggleEnabled: (next) => MapShine.setFire({ enabled: next }),
      // ⚠️ NO "➕ Place" AFFORDANCE YET, deliberately. The `fire` ANCHOR KIND is
      // registered (`scene/anchor-catalog.js`) and `getFireRenderState` already
      // serves anchors alongside painted fires, but the add/update/remove
      // persistence helpers the placement mode needs (the candle's
      // `addCandleAnchor`/`updateCandleAnchor` trio and its edit form) are not
      // written. Shipping the button against missing functions would be a
      // control that throws; shipping it against stubs would be a control that
      // silently does nothing, which is worse (`params/no-dead-controls`'s own
      // reasoning). Painting is the primary source anyway — the region's own
      // width sizes each fire, which is the whole point.
      add: paintAffordance('fire'),
    });
  }

  MapShine.debug.registerPanel('fire-panel', 'Fire', buildFirePanel, {
    zone: 'workshop',
    effect: 'fire',
    order: 12,
  });

  // ---------------------------------------------------------------------------
  // MSA ANCHOR VIEW MODE (2026-08-06, author request) — "a button just below
  // the MSA button... to quickly see the anchor handles for effects [and]
  // turn things on and off". Listed by hand, exactly like the two Workshop
  // panels just above register themselves by hand: there are only two anchor
  // kinds today, and each needs its OWN setEnabled (updateCandleAnchor vs
  // updateLightningAnchor each do their own persistence snapshot), so looping
  // ANCHOR_KINDS generically would not skip any real work, just hide these
  // two lines behind a lookup. The scene-controls button itself is
  // registered further down, in the same init hook the MSA button's own
  // lives in (foundry/scene-controls-button.js).
  // ---------------------------------------------------------------------------

  function enterAnchorViewMode() {
    // The two modes draw icons at the same screen position/z-index — one
    // replaces the other rather than stacking (mirrors the matching guard in
    // enterCandlePlacement/enterLightningPlacement, above).
    if (MapShine.__anchorMode.isActive()) MapShine.__anchorMode.exit();
    const result = MapShine.__anchorViewMode.enter({
      kinds: [
        {
          kindId: 'candleFlame',
          label: 'candle',
          icon: anchorKindById('candleFlame')?.icon,
          listAnchors: () => anchorAuthority.anchorsForKindOnFloor('candleFlame', activeFloorContext),
          setEnabled: (id, enabled) => updateCandleAnchor(id, { enabled }),
        },
        {
          kindId: 'lightning',
          label: 'lightning bolt',
          icon: lightningRoleIcon,
          listAnchors: () => anchorAuthority.anchorsForKindOnFloor('lightning', activeFloorContext),
          setEnabled: (id, enabled) => updateLightningAnchor(id, { enabled }),
        },
      ],
      // The toolbar's own Done button and Escape both call MapShine.__anchor
      // ViewMode.exit() directly (ui/anchor-view-mode.js), bypassing the
      // scene-controls tool entirely — without this, ending the session that
      // way would leave the toolbar button showing "active" for a mode that
      // has already closed.
      onExit: () => syncAnchorViewModeButtonState(false),
    });
    if (!result?.ok) log.error('could not enter anchor view mode:', result?.reason);
  }

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

  // DEPTH OF FIELD — the schema-driven card + a named-preset picker. Mirrors
  // buildBloomPanel exactly (whole-image screen effect, no place/edit
  // button). Only 3 params total (one blur band, not bloom's two), so all of
  // them promote to the FOH strip — leaving ROH empty for this effect is the
  // correct, expected shape (Effects-UI.md: "a fully-promoted category
  // yields no bare heading"), not a gap.
  function buildDofPanel({ attachments } = {}) {
    const schema = DOF_PARAMS;
    const getValue = (id) => {
      const v = dofReadout.params?.[id];
      return v !== undefined ? v : schema[id]?.default;
    };
    const onChange = (id, value) => MapShine.setDof({ [id]: value });

    // Named-preset picker (docs/planning/Depth-of-Field.md) — applies a full
    // preset as a live override, then refreshes the card so the sliders show
    // the new values.
    const presetSelect = document.createElement('select');
    presetSelect.className = 'msa-effect-preset-select';
    presetSelect.title = 'Apply a named depth-of-field preset';
    const prettify = (n) => n.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Preset…';
    presetSelect.appendChild(placeholder);
    for (const name of Object.keys(DOF_PRESETS)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = prettify(name);
      presetSelect.appendChild(opt);
    }
    presetSelect.addEventListener('change', () => {
      const name = presetSelect.value;
      presetSelect.value = '';
      if (!name) return;
      MapShine.setDof(dofPreset(name));
      MapShine.debug?.refreshControls?.();
    });

    return buildEffectCard({
      id: 'depthOfField',
      diagnostics: attachments,
      icon: '🌫️',
      title: 'Depth of Field',
      subtitle: 'blur the floors below you',
      status: () => collapsedStatusLine({ enabled: dofReadout.enabled }),
      schema,
      fohKeys: ['strength', 'blurPerFloor', 'maxBlur'],
      getValue,
      onChange,
      enabled: dofReadout.enabled,
      onToggleEnabled: (next) => MapShine.setDof({ enabled: next }),
      extra: [presetSelect],
    });
  }

  MapShine.debug.registerPanel('dof-panel', 'Depth of Field', buildDofPanel, {
    zone: 'workshop',
    effect: 'depthOfField',
    order: 81,
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
  /** `MapShine.setWaterDebug(9)` — the console twin of the picker below
   * (Water-Testament W0). */
  MapShine.setWaterDebug = water.setDebugChannel;
  MapShine.setFluid = fluid.setFluid;

  /**
   * THE DEBUG-CHANNEL PICKER — water's own copy of `buildSpecularDebugSelect()`
   * (Water-Testament W0), one dropdown that makes the shader say which of its
   * terms is the dead one (`effects/water/water.js#WATER_DEBUG_CHANNELS` holds
   * the why and the per-channel reading guide).
   *
   * It sits on the card rather than behind a report because the answer is a
   * PICTURE, not a number: "channel 9 is black" locates the bug in one glance,
   * where a report can only ever tell you what the JS side believes. The
   * channels walk the product roughly in COMPUTATION order — the first BLACK
   * one (or, for a remapped channel, the first away from its documented
   * neutral) is the culprit — so this is a ladder to descend, not a menu to
   * browse.
   *
   * Same `msa-effect-preset-select` idiom as specular's picker, and it does
   * NOT reset itself after a change the way a preset picker does: a
   * diagnostic you are reading has to stay selected while you look at it.
   * @returns {HTMLSelectElement}
   */
  function buildWaterDebugSelect() {
    const select = document.createElement('select');
    select.className = 'msa-effect-preset-select';
    select.title = 'Show one shader intermediate instead of the effect — the first BLACK channel is the culprit';
    for (const ch of WATER_DEBUG_CHANNELS) {
      const opt = document.createElement('option');
      opt.value = String(ch.n);
      opt.textContent = ch.label;
      // The reading guide, on hover — so "what does black here mean" is
      // answered where the author is looking, not in a doc they would have to
      // go and find mid-investigation.
      opt.title = ch.reads;
      select.appendChild(opt);
    }
    select.value = String(water.getDebugChannel());
    select.addEventListener('change', () => {
      MapShine.setWaterDebug(Number(select.value));
    });
    return select;
  }

  /**
   * THE NAMED-LOOK PICKER — `water.js#WATER_PRESETS`, applied through the same
   * `setWater` write path a slider drag uses, so a preset is indistinguishable
   * from having moved every control by hand.
   *
   * Resets to the placeholder after applying, exactly as the grade card's own
   * picker does and unlike the DEBUG-channel select beside it: a preset is a
   * one-shot ACTION whose result then belongs to the sliders, whereas a debug
   * channel is a MODE you are currently reading and must stay selected while
   * you look at it. Same widget, opposite semantics, on purpose.
   */
  function buildWaterPresetSelect() {
    const select = document.createElement('select');
    select.className = 'msa-effect-preset-select';
    select.title = 'Apply a named, author-approved water look — every control at once';
    const prettify = (n) => n.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Preset…';
    select.appendChild(placeholder);
    for (const name of Object.keys(WATER_PRESETS)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = prettify(name);
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      const name = select.value;
      select.value = '';
      if (!name) return;
      const params = waterPreset(name);
      // `waterPreset` returns null rather than falling back to the defaults —
      // see its own doc for why a silent fallback would be indistinguishable
      // from a preset that happens to match them.
      if (!params) {
        log.error(`water preset '${name}' not found — see WATER_PRESETS in effects/water/water.js`);
        return;
      }
      MapShine.setWater(params);
      // The card reads its slider positions at BUILD time, so without this the
      // controls would keep showing the pre-preset values while the water
      // rendered the new ones — the same build-time-vs-live split that made the
      // 📋 button lie, wearing its other face.
      MapShine.debug?.refreshControls?.();
    });
    return select;
  }

  /**
   * ⚠️ THE INERT-CONTROL WARNING — the loudest thing on the water card when the
   * resolved rung is below the rung a shipped control belongs to.
   *
   * ============================================================================
   * WHY THIS EXISTS (2026-08-17, and it cost a whole development cycle)
   * ============================================================================
   * Tier 4 (`shore`) declares `fromProfile: 'quality'`; `DEFAULT_PERFORMANCE_
   * PROFILE` is `'standard'`. So on a default install EVERY tier-4 term —
   * shore swash, break foam, foam trails, caustics, wave shoaling — is compiled
   * out by Effects.md Law 4, exactly as designed. What was NOT designed is that
   * their five sliders stayed on the card, fully draggable, writing values into
   * uniforms no compiled shader reads.
   *
   * The author dragged foam, swash and break to maximum, saw only tier 2's
   * crest foam, and reported *"Foam is set to full and I can't see any"* and
   * *"it doesn't seem to have changed"* — both completely accurate, and neither
   * diagnosable from anything the UI said. Two sessions of shore-foam work were
   * measured green on a bench that sets `tier = 4` explicitly while the live map
   * could not run a line of it (`feedback_bench_must_build_inputs_like_
   * production`, arriving through the tier ladder rather than through the data).
   *
   * `params/no-dead-controls` walls a param with no CONSUMING SOURCE. This is
   * the sibling it cannot see: a param whose consumer exists, compiles, and is
   * gated off at runtime by a profile the author never knowingly chose. The
   * wall cannot catch that statically, so the card says it out loud instead.
   */
  /** @param {() => object} readLive - the card's own live readout accessor.
   *   Passed in rather than captured: the `panels/no-captured-readout` wall
   *   caught this function's first draft doing `water.getReadout()` directly,
   *   which is the wall working on the very session that built it. A build-time
   *   read would be doubly wrong here — this widget exists to report a LIVE
   *   gate, so freezing it would make the honesty warning itself go stale the
   *   moment the author raised their profile. */
  function buildWaterTierWarning(readLive) {
    const wrap = document.createElement('div');
    const tier = readLive().perfTier;
    // `null` = the cascade has not resolved yet (the pre-resolve window
    // `water-registration.js` documents). Say nothing rather than accuse a
    // profile of something before anything has been resolved at all.
    if (!Number.isFinite(tier) || tier >= 4) return wrap;
    Object.assign(wrap.style, {
      flexBasis: '100%',
      border: '1px solid rgba(255,180,90,0.45)',
      background: 'rgba(255,180,90,0.10)',
      borderRadius: '7px',
      padding: '7px 9px',
      font: '11px/1.45 Signika, sans-serif',
      color: '#ffcf9a',
    });
    // NAMED, not "some controls" — the whole failure was that the author could
    // not tell WHICH sliders were inert, so the one thing this must not do is
    // be vague about it.
    wrap.innerHTML =
      `<b>Rung ${tier} of 4 — shore foam is switched off.</b><br>` +
      'Shore swash, Break foam, Foam trails and Caustics all belong to rung 4, which needs the ' +
      '<b>Quality</b> graphics profile (you are on a lower one). Their sliders still move, but nothing reads ' +
      'them at this rung. Raise the profile in <i>Graphics &amp; Performance</i> to switch them on.';
    return wrap;
  }

  MapShine.debug.registerPanel(
    'water-panel',
    'Water',
    ({ attachments }) => {
      // ⚠️ A GETTER, NOT A CAPTURED VALUE (2026-08-17) — see
      // `effect-controls.js#buildSettingsSnapshot`'s own header. `getReadout()`
      // returns a NEW object on every cascade resolve, so a `const readout =`
      // captured here freezes at whatever was resolved when the card was BUILT.
      // Nothing calls `refreshControls()` on a param change (a mid-drag DOM
      // rebuild would yank the slider out from under the pointer), so that
      // capture never refreshed — while the sliders still LOOKED right, because
      // an `<input type=range>` holds the dragged value in its own native DOM
      // state. The 📋 copy button reads `getValue`, so it exported the
      // build-time snapshot: a flawless set of schema defaults, which the author
      // pasted in good faith and which I then reported back as "already the
      // defaults". `feedback_instruments_must_not_lie`, and it cost a round trip.
      const readLive = () => water.getReadout();
      return buildEffectCard({
        id: 'water',
        diagnostics: attachments,
        icon: '🌊',
        title: 'Water',
        subtitle: 'tiers 0–4 — placement · volume · motion · light · shore',
        status: () => collapsedStatusLine({ enabled: readLive().enabled }),
        schema: WATER_PARAMS,
        // FOH is a strict, SMALL subset, never the whole schema
        // (feedback_foh_roh_must_differ). These six are the mid-session
        // questions — what colour, how much shows through, how fast it hides
        // the bed, how broken the surface is, and (2026-08-16, on the author's
        // own ask: *"I have a map with a river and I need to be able to set the
        // direction the water is travelling in"*) which way it runs and how
        // fast. The direction control is the `angle` type, so it renders as a
        // compass dial rather than a 0–360 slider whose two ends are the same
        // heading — see `core/params-schema.js`'s note on why that is a TYPE
        // and not a widget hint.
        //
        // Six is Effects-UI.md §3.2's ceiling, reached deliberately rather than
        // drifted into. REVISED 2026-08-17 (Water-Testament S1): `depth` and
        // `pollution` now answer the "what does this water look like" question
        // more directly than `tint`/`absorption` ever did — those two demote to
        // ROH as hand-tune trims (see their own updated schema help) so the
        // FOH surface stays at the cap instead of growing past it. Everything
        // that stays ROH — the shoreline threshold whose minimum visibly breaks
        // the edge, the wet-margin pair, the whole Light group, the wave
        // geometry — still passes the same judgement test the ORIGINAL six did,
        // just no longer includes color.
        fohKeys: ['depth', 'pollution', 'opacity', 'foam', 'flowAngleDeg', 'flowSpeedPx'],
        getValue: (id) => readLive().params?.[id] ?? WATER_PARAMS[id]?.default,
        onChange: (id, value) => MapShine.setWater({ [id]: value }),
        enabled: readLive().enabled,
        getEnabled: () => readLive().enabled,
        onToggleEnabled: (next) => MapShine.setWater({ enabled: next }),
        add: paintAffordance('water'),
        extra: [buildWaterTierWarning(readLive), buildWaterPresetSelect(), buildWaterDebugSelect()],
      });
    },
    { zone: 'workshop', effect: 'water', order: 30 }
  );

  // THE STUDIO'S OWN WATER CARD (U1, docs/holy/UI-Testament.md §9's exit
  // gate names water specifically) — same real functions/data as the panel
  // above, through registerEffectCard (never a second registry; see ui/
  // rooms/studio/shell.js's own header for why the Studio never imports
  // effects/ or effectRegistry directly). `filterCategory` is this
  // session's own proposal for the category strip — no per-effect taxonomy
  // exists in src/ yet; see Petition P10.
  MapShine.__studio?.registerEffectCard('water', () => {
    const readLive = () => water.getReadout();
    const maskStatus = (() => {
      try {
        return maskAuthority.authoredStatus(activeFloorContext?.levelId, 'water');
      } catch (_) {
        return null;
      }
    })();
    return {
      id: 'water',
      icon: 'water',
      title: 'Water',
      accVar: '--c-atmos',
      filterCategory: 'surface',
      tier: {
        tier: readLive().perfTier,
        maxTier: readLive().maxPerfTier,
        source: readLive().perfTierSource,
      },
      // No `?? '_...'` fallback: 'water' is a permanent scene/mask-catalog.js
      // entry (verify-structure.mjs#masks/authority-only correctly flags a
      // literal suffix here as indistinguishable from a catalog bypass, and
      // the fallback was dead code anyway — the lookup cannot fail for a
      // hardcoded, always-registered kind id).
      mask: { suffix: maskKindById('water')?.suffixes?.[0], found: maskStatus?.source === 'authored' },
      presets: Object.keys(WATER_PRESETS),
      onPresetPick: (name) => {
        const params = waterPreset(name);
        if (!params) {
          log.error(`water preset '${name}' not found — see WATER_PRESETS in effects/water/water.js`);
          return;
        }
        MapShine.setWater(params);
      },
      schema: WATER_PARAMS,
      fohKeys: ['depth', 'pollution', 'opacity', 'foam', 'flowAngleDeg', 'flowSpeedPx'],
      // U6 (docs/holy/UI-Testament.md §9): five authored dials replace this
      // fohKeys strip in the FOH — fohKeys itself stays, both as the ROH-
      // exclusion set (rohGroups reads it unconditionally) and as the
      // fallback for every OTHER effect that has no dials schema yet.
      dialsSchema: WATER_DIALS,
      // Computed FRESH on every card render, never cached — the same
      // "getValue must read live state" rule this card's own comment above
      // already states for readLive(). health.read only ever grows within a
      // session (param-read-health.js's own doc); a freshly opened scene
      // honestly shows a low count until the surface's first sync().
      health: getParamHealth('water', WATER_PARAMS),
      getValue: (id) => readLive().params?.[id] ?? WATER_PARAMS[id]?.default,
      onChange: (id, value) => MapShine.setWater({ [id]: value }),
      enabled: readLive().enabled,
      onToggleEnabled: (next) => MapShine.setWater({ enabled: next }),
      onPaint: paintAffordance('water')?.onAdd,
      status: () => collapsedStatusLine({ enabled: readLive().enabled }),
    };
  });

  // THE CONTROL HEALTH REPORT (U6, docs/holy/UI-Testament.md §9) — what the
  // Studio water card's health badge deep-links to. `READ_TRACKED_EFFECTS`
  // is deliberately a small, explicit, extend-as-you-go map rather than a
  // derived enumeration: `param-read-health.js`'s own tracked-reads Map has
  // no way to know a SCHEMA (each effect owns its own), so this report is
  // honest only about what is actually listed here — water today, more as
  // future petitions wire their own `getRenderState()`-equivalent (see
  // water-registration.js's own U6 comment for the wrapping pattern).
  const READ_TRACKED_EFFECTS = { water: WATER_PARAMS };
  MapShine.debug.registerReport('control-health', 'Control health (declared vs read)', () => {
    const effects = {};
    for (const [effectId, schema] of Object.entries(READ_TRACKED_EFFECTS)) {
      effects[effectId] = getParamHealth(effectId, schema);
    }
    return {
      note:
        'declared = params in the schema. read = observed reaching the RENDERER this session (getRenderState(), ' +
        'never the UI card display) — a read is never later un-read. An orphaned param may be genuinely dead, or ' +
        'simply not yet exercised this session (e.g. before the surface has synced once).',
      effects,
    };
  });

  // FLUID (docs/planning/Fluid.md) — goo in glass tubes.
  MapShine.debug.registerPanel(
    'fluid-panel',
    'Fluid',
    ({ attachments }) => {
      // A GETTER, NOT A CAPTURED VALUE — see the water panel's own note above
      // for the live bug this shape caused (the 📋 button exported build-time
      // defaults while the sliders showed the author's real values).
      const readLive = () => fluid.getReadout();
      return buildEffectCard({
        id: 'fluid',
        diagnostics: attachments,
        icon: '🧪',
        title: 'Fluid',
        subtitle: 'tiers 0–5 — placement · tube · flow · film · fill · structure',
        status: () => collapsedStatusLine({ enabled: readLive().enabled }),
        schema: FLUID_PARAMS,
        // FOH is a strict, SMALL subset (feedback_foh_roh_must_differ). The
        // test is "would they change it mid-session, or only while tuning?" —
        // colour, brightness and speed are things a GM reaches for while
        // players are watching; overall strength and how marbled the goo
        // looks are set-once tuning and stay rear-of-house. `slugCount`/
        // `slugWidth` are GONE (fluid.js's own comment on `flowSpeed`
        // explains why), not merely demoted to ROH.
        fohKeys: ['tint', 'glow', 'flowSpeed', 'iridescence'],
        getValue: (id) => readLive().params?.[id] ?? FLUID_PARAMS[id]?.default,
        onChange: (id, value) => MapShine.setFluid({ [id]: value }),
        enabled: readLive().enabled,
        getEnabled: () => readLive().enabled,
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
  /** `MapShine.setSpecularLayer(1, {streak: 0.4})` — the console twin of the
   * per-layer strips below. This function has existed in
   * `specular-registration.js` since the layers themselves shipped
   * (2026-07-27) but was NEVER attached to `MapShine` and had no UI either —
   * found 2026-08-03 (ROUND 17) auditing every declared control for whether
   * an author can actually reach it. `feedback_unconsumed_api_rots_silently`:
   * fully wired all the way to the shader, unreachable by anyone. */
  MapShine.setSpecularLayer = specular.setSpecularLayer;

  /** Persisted open/closed state for the three shimmer-layer strips —
   * independent of the card's own Advanced state and of each other, same
   * reason `createSectionStore`'s own header gives for the card-level store:
   * `debug-panel.js` rebuilds this whole card from scratch on every slider
   * drag anywhere in it (including these), so a plain `<details open>` would
   * slam shut the instant one was used. */
  const specularLayerSections = createSectionStore();

  /** A short, honest hint for the one layer whose defaults look like a typo
   * if you don't know why: layer 3's parallax depth is NEGATIVE on purpose
   * (`SPECULAR_LAYER_DEFAULTS`'s own comment — it counter-moves against the
   * other two, which is most of what sells "a highlight sliding over a
   * surface" rather than "a texture panning with the camera"). */
  const SPECULAR_LAYER_HINT = ['', '', ' (counter-moving)'];

  /**
   * ONE SHIMMER LAYER'S OWN EIGHT CONTROLS, folded behind its own disclosure.
   *
   * `SPECULAR_LAYER_PARAMS` is ONE shared declaration (labels/ranges/help) —
   * `SPECULAR_LAYER_DEFAULTS[i]` is what makes the three layers actually
   * differ, and `specular.getLayers()[i]` is this session's live override, if
   * any. A flat `schema` object (what `buildEffectCard` generates FOH/ROH
   * from) has no way to express "one declaration, three independent value
   * sets" — hence a hand-built strip, passed through `extraAdvanced`, rather
   * than the generated machinery every OTHER specular control goes through.
   * @param {number} i @returns {HTMLElement}
   */
  function buildSpecularLayerStrip(i) {
    const sectionKey = `specular:layer${i}`;
    const details = document.createElement('details');
    details.open = specularLayerSections.isOpen(sectionKey);
    details.addEventListener('toggle', () => specularLayerSections.setOpen(sectionKey, details.open));
    Object.assign(details.style, {
      border: '1px solid rgba(143,214,255,0.12)',
      borderRadius: '7px',
      background: 'rgba(143,214,255,0.03)',
      flexBasis: '100%',
    });
    const summary = document.createElement('summary');
    Object.assign(summary.style, {
      cursor: 'pointer',
      listStyle: 'none',
      padding: '5px 8px',
      fontSize: '10px',
      fontWeight: '600',
      color: '#8fa3c4',
    });
    summary.innerHTML = `<span class="msa-chev">▸</span> Shimmer layer ${i + 1}${SPECULAR_LAYER_HINT[i] ?? ''}`;
    details.append(summary);

    const body = document.createElement('div');
    Object.assign(body.style, { display: 'flex', flexWrap: 'wrap', gap: '4px', padding: '2px 8px 8px' });
    const defaults = SPECULAR_LAYER_DEFAULTS[i] ?? {};
    for (const [paramId, decl] of Object.entries(SPECULAR_LAYER_PARAMS)) {
      const override = specular.getLayers()[i] ?? {};
      body.append(
        buildParamControl(paramId, decl, {
          value: Number.isFinite(override[paramId]) ? override[paramId] : (defaults[paramId] ?? decl.default),
          onChange: (v) => MapShine.setSpecularLayer(i, { [paramId]: v }),
        })
      );
    }
    details.append(body);
    return details;
  }

  /** The three shimmer layers, one strip each, in their own wrapper. */
  function buildSpecularLayerStrips() {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '4px', flexBasis: '100%' });
    for (let i = 0; i < SPECULAR_LAYER_DEFAULTS.length; i++) wrap.append(buildSpecularLayerStrip(i));
    return wrap;
  }

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
      // A GETTER, NOT A CAPTURED VALUE — see the water panel's own note above
      // for the live bug this shape caused (the 📋 button exported build-time
      // defaults while the sliders showed the author's real values).
      const readLive = () => specular.getReadout();
      return buildEffectCard({
        id: 'specular',
        diagnostics: attachments,
        icon: '✨',
        title: 'Metal & shine',
        subtitle: 'an animated shimmer field · per-object parallax',
        status: () => collapsedStatusLine({ enabled: readLive().enabled }),
        schema: SPECULAR_PARAMS,
        // FOH is a strict, SMALL subset, never the whole schema
        // (feedback_foh_roh_must_differ). The test is "would a GM change this
        // mid-session, or only while tuning?", and these five are chosen
        // against the question an author actually arrives with — "why does the
        // metal not read?", asked five times running now.
        //
        // `strength` (is it on at all) and `shimmerContrast` (is it moving)
        // answer that directly. `parallax` is the one control that decides
        // whether the shine reads as a REFLECTION or as paint, which is the
        // difference the whole effect exists for. `per-object variety` is here
        // because it is a recent capability and the one an author will want to
        // feel out immediately.
        //
        // ⚠️ `lightFloor` SWAPPED OUT FOR `incidentSteepness` (2026-08-03,
        // ROUND 17): a live channel probe showed the darkness-suppression gate
        // added the previous round crushing an ordinarily-lit point to under
        // 1% of its true brightness — `incidentSteepness` is now THE first
        // control an author reaches for when the shine reads as globally too
        // faint, which is a more common way into this card than "make the
        // never-quite-black floor" was.
        //
        // `patternSize`, `metalColour`, `driftSpeed`, `breathing`,
        // `sunDirection` and the new `sheenCeiling`/`glintCeiling` (Response) —
        // set-once look/response decisions — are ROH. The three per-layer
        // strips render below the categorised groups via `extraAdvanced`: a
        // flat schema cannot hold "one declaration, three live value sets", so
        // they were never able to go through `fohKeys`/`schema` at all.
        fohKeys: ['strength', 'incidentSteepness', 'shimmerGain', 'parallaxStrength', 'islandSpread'],
        getValue: (id) => readLive().params?.[id] ?? SPECULAR_PARAMS[id]?.default,
        onChange: (id, value) => MapShine.setSpecular({ [id]: value }),
        enabled: readLive().enabled,
        getEnabled: () => readLive().enabled,
        onToggleEnabled: (next) => MapShine.setSpecular({ enabled: next }),
        add: paintAffordance('specular'),
        extra: [buildSpecularDebugSelect()],
        extraAdvanced: [buildSpecularLayerStrips()],
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
      // A GETTER, NOT A CAPTURED VALUE — see the water panel's own note above
      // for the live bug this shape caused (the 📋 button exported build-time
      // defaults while the sliders showed the author's real values).
      const readLive = () => windowLight.getReadout();
      return buildEffectCard({
        id: 'window',
        diagnostics: attachments,
        icon: '🪟',
        title: 'Window light',
        subtitle: 'the painted mask, read as light — no aperture, no time of day yet',
        status: () => collapsedStatusLine({ enabled: readLive().enabled }),
        schema: WINDOW_PARAMS,
        // Both controls are FOH — the schema is small enough that there is no
        // ROH tier yet (feedback_foh_roh_must_differ still applies: this is
        // "the whole thing", not "the important half").
        fohKeys: ['strength', 'contrast'],
        getValue: (id) => readLive().params?.[id] ?? WINDOW_PARAMS[id]?.default,
        onChange: (id, value) => MapShine.setWindowLight({ [id]: value }),
        enabled: readLive().enabled,
        getEnabled: () => readLive().enabled,
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

  // APERTURE GOBO (docs/planning/Aperture-Gobo.md) — reads NO mask, so
  // unlike window/specular there is no `buildXReport` cross-referencing the
  // mask authority; the whole state worth reporting is the resolved params
  // and `point-light-pool.js`'s own live readout (apertures found/dropped,
  // lights currently showing a pattern), already assembled by
  // `vt-pan-viewer-diagnostics.js#buildViewerDiagnostics` under its own
  // `apertureGobo` key — the SAME bridge `pointLights` uses one line above
  // it in that file, not a direct call from here.
  MapShine.setApertureGobo = apertureGobo.setApertureGobo;
  /** `MapShine.setApertureGoboDebug(true)` — the OLD console twin, kept working
   * (maps to the `'pattern'` channel) alongside the picker below. */
  MapShine.setApertureGoboDebug = (on) => apertureGobo.setDebug(on);
  /** `MapShine.setApertureGoboDebugChannel('pattern')` — the console twin of
   * the picker below. */
  MapShine.setApertureGoboDebugChannel = apertureGobo.setDebugChannel;

  /**
   * THE DEBUG-CHANNEL PICKER — upgraded from a single "Show pattern only"
   * checkbox (2026-08-03) after that ONE channel could not settle "is the
   * gate the gap" against a live scene reading as completely unaffected by
   * the real material with the pattern channel showing a clean, correct
   * shape. Same idiom as window/specular's own pickers
   * (`APERTURE_GOBO_DEBUG_CHANNELS` holds the why and the per-channel
   * reading guide) — `docs/planning/Aperture-Gobo.md` §6.0/§10 names the
   * live A/B this exists to make cheap.
   * @returns {HTMLSelectElement}
   */
  function buildApertureGoboDebugSelect() {
    const select = document.createElement('select');
    select.className = 'msa-effect-preset-select';
    select.title = 'Show one shader intermediate instead of the effect — see each option for what it reads.';
    for (const ch of APERTURE_GOBO_DEBUG_CHANNELS) {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = ch.label;
      opt.title = ch.reads;
      select.appendChild(opt);
    }
    select.value = apertureGobo.getDebugChannel();
    select.addEventListener('change', () => {
      MapShine.setApertureGoboDebugChannel(select.value);
    });
    return select;
  }

  MapShine.debug.registerPanel(
    'aperture-gobo-panel',
    'Window light pattern',
    ({ attachments }) => {
      // A GETTER, NOT A CAPTURED VALUE — see the water panel's own note above
      // for the live bug this shape caused (the 📋 button exported build-time
      // defaults while the sliders showed the author's real values).
      const readLive = () => apertureGobo.getReadout();
      return buildEffectCard({
        id: 'apertureGobo',
        diagnostics: attachments,
        icon: '🪟',
        title: 'Window light pattern',
        subtitle: 'a point light shaped by a real aperture wall — no mask, no painting',
        status: () => collapsedStatusLine({ enabled: readLive().enabled }),
        schema: APERTURE_GOBO_PARAMS,
        fohKeys: ['strength', 'cols', 'rows', 'softness'],
        getValue: (id) => readLive().params?.[id] ?? APERTURE_GOBO_PARAMS[id]?.default,
        onChange: (id, value) => MapShine.setApertureGobo({ [id]: value }),
        enabled: readLive().enabled,
        getEnabled: () => readLive().enabled,
        onToggleEnabled: (next) => MapShine.setApertureGobo({ enabled: next }),
        extra: [buildApertureGoboDebugSelect()],
      });
    },
    { zone: 'workshop', effect: 'apertureGobo', order: 61 }
  );

  MapShine.debug.registerReport(
    'aperture-gobo',
    'Window light pattern (why is it not visible?)',
    () => {
      // ⚠️ THIS ONE WAS NEVER BUGGY — a REPORT's factory re-runs on every
      // invocation, so a capture here is already live, unlike the PANEL
      // factories above (which build a card whose closures outlive the read).
      // It uses the accessor form anyway so `panels/no-captured-readout` can
      // stay a bright line with zero adjudicated exceptions: a rule a reader
      // has to reason about is a rule that eventually gets reasoned around.
      const readLive = () => apertureGobo.getReadout();
      // `apertureGobo` is a PLAIN VALUE here, already resolved by
      // `vt-pan-viewer-diagnostics.js#buildViewerDiagnostics` (the same
      // bridge `pointLights` uses) — not a function to call. A prior version
      // of this line called `.getApertureGoboInfo?.()` directly off the
      // diagnostics object, which doesn't exist there at all (that method
      // lives on the INNER `_active` object `getDiagnostics()` never
      // exposes directly) — it silently evaluated to `undefined` via
      // optional chaining rather than throwing, so it took a live report
      // (not a test) to surface: `available:false`/`unavailable:true` on a
      // scene that was demonstrably rendering. Fixed at the bridge, not by
      // reaching around it a second way.
      const info = getVtPanViewerDiagnostics?.()?.apertureGobo ?? null;
      return {
        enabled: readLive().enabled,
        debugChannel: apertureGobo.getDebugChannel(),
        params: readLive().params,
        // THE MOST LIKELY FIRST-RUN OUTCOME (Aperture-Gobo.md §9.1): this
        // effect SHAPES light Foundry already lets through a wall — it
        // cannot create light through a wall Foundry says is opaque. "0
        // apertures found" on a scene with no window walls (move solid,
        // light PROXIMITY — Foundry's own window convention) is a DATA
        // fact, not a bug, and this report says so loudly rather than
        // leaving a silent zero to be mistaken for one.
        live: info ?? { unavailable: true, reason: 'viewer not started (no _active viewer instance)' },
        generatedAt: new Date().toISOString(),
      };
    },
    { effect: 'apertureGobo' }
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
  MapShine.debug.registerReport(
    'perf-profile',
    '📄 Performance: last result (read-only)',
    () => {
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
        // texture as ONE BYTE — see diag/vram-inventory.js). `targets` (2026-08-09)
        // is a live snapshot independent of whether a profile has ever run.
        vram: buildVramInventory({ targets: getVtPanViewerRenderTargets(), vtEstimate: viewer, ceilingMb: 2500 }),
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
    },
    { zone: 'performance' }
  );

  // THE INLINE RESULT VIEW — author's ask: "an area where you can press a
  // button and get a detailed performance report", not just a clipboard copy.
  // Rebuilt fresh every Performance Center repaint (registerPanel's own
  // contract), so it always shows whatever `lastPerfProfile` currently holds;
  // the four report-producing actions above each call `refreshControls()`
  // right before they return so this updates the moment a run finishes,
  // without this panel needing any polling of its own.
  function buildPerfLastResultPanel() {
    const el = document.createElement('div');
    Object.assign(el.style, {
      width: '100%',
      boxSizing: 'border-box',
      background: '#12161c',
      color: '#dce3ea',
      font: '11px/1.5 ui-monospace, Menlo, Consolas, monospace',
      border: '1px solid rgba(143,214,255,0.25)',
      borderRadius: '10px',
      padding: '10px 12px',
    });
    const head = document.createElement('div');
    Object.assign(head.style, { fontWeight: 'bold', color: '#8fd6ff', marginBottom: '6px' });
    head.textContent = '📄 Last result';
    el.appendChild(head);

    if (!lastPerfProfile) {
      const hint = document.createElement('div');
      hint.style.opacity = '0.7';
      hint.textContent = 'No report yet — run 🔬 Performance Report (or the ALL TIERS report) above.';
      el.appendChild(hint);
      return el;
    }

    const meta = document.createElement('div');
    Object.assign(meta.style, { opacity: '0.75', marginBottom: '6px' });
    meta.textContent = `${lastPerfProfile.report ?? 'perf-profile'} · ${lastPerfProfile.generatedAt ?? ''}`;
    el.appendChild(meta);

    // THE PLAIN-ENGLISH HEADLINE, BEFORE THE JSON (2026-08-06, author: "imagine
    // that this tool might be used by a lay person"). perf-report.js already
    // computes `interpretation` and a severity-ranked `findings[]` for a single
    // run, and `summarizeTierComparison` computes a `ranked[]` for the ALL
    // TIERS shape — both were already being thrown away here in favour of a raw
    // JSON dump nobody but the author could read at a glance.
    if (lastPerfProfile.interpretation) {
      const interp = document.createElement('div');
      Object.assign(interp.style, {
        marginBottom: '8px',
        padding: '8px',
        background: 'rgba(143,214,255,0.06)',
        border: '1px solid rgba(143,214,255,0.2)',
        borderRadius: '6px',
        opacity: '0.95',
      });
      interp.textContent = lastPerfProfile.interpretation;
      el.appendChild(interp);
    }
    if (Array.isArray(lastPerfProfile.findings) && lastPerfProfile.findings.length) {
      const order = { high: 0, medium: 1, low: 2 };
      const sortedFindings = [...lastPerfProfile.findings].sort(
        (a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3)
      );
      const SEVERITY_COLOR = { high: '#ffb4b4', medium: '#ffc478', low: '#8fd6ff' };
      const findingsBox = document.createElement('div');
      Object.assign(findingsBox.style, { marginBottom: '8px', display: 'flex', flexDirection: 'column', gap: '4px' });
      const findingsHead = document.createElement('div');
      Object.assign(findingsHead.style, { fontWeight: 'bold', color: '#8fd6ff', fontSize: '10px' });
      findingsHead.textContent = `Findings (${sortedFindings.length}, worst first)`;
      findingsBox.appendChild(findingsHead);
      // Capped so "the headline" stays a headline — the full list is still in
      // the JSON below, this is a triage list, not the whole report.
      const FINDINGS_SHOWN = 6;
      for (const f of sortedFindings.slice(0, FINDINGS_SHOWN)) {
        const row = document.createElement('div');
        row.style.color = SEVERITY_COLOR[f.severity] ?? '#dce3ea';
        row.textContent = `[${f.severity ?? '?'}] ${f.text}`;
        findingsBox.appendChild(row);
      }
      if (sortedFindings.length > FINDINGS_SHOWN) {
        const more = document.createElement('div');
        more.style.opacity = '0.6';
        more.textContent = `…${sortedFindings.length - FINDINGS_SHOWN} more in findings[] below.`;
        findingsBox.appendChild(more);
      }
      el.appendChild(findingsBox);
    }
    // THE ALL-TIERS SHAPE — no interpretation/findings (summarizeTierComparison's
    // own, different output), so it gets its own compact headline: the top few
    // zones/effects by PEAK cost across every tier, the same `ranked[]` the
    // report's own doc calls "THE answer to where optimisation effort should go".
    if (Array.isArray(lastPerfProfile.ranked) && lastPerfProfile.ranked.length) {
      const rankedBox = document.createElement('div');
      Object.assign(rankedBox.style, { marginBottom: '8px', display: 'flex', flexDirection: 'column', gap: '2px' });
      const rankedHead = document.createElement('div');
      Object.assign(rankedHead.style, { fontWeight: 'bold', color: '#8fd6ff', fontSize: '10px' });
      rankedHead.textContent = 'Ranked by peak GPU cost across tiers (top 8)';
      rankedBox.appendChild(rankedHead);
      for (const r of lastPerfProfile.ranked.slice(0, 8)) {
        const row = document.createElement('div');
        row.textContent = `${r.label ?? r.id} (${r.kind}) — ${r.maxGpuMs == null ? 'unmeasured' : `${r.maxGpuMs}ms`}`;
        rankedBox.appendChild(row);
      }
      el.appendChild(rankedBox);
    }

    const pre = document.createElement('pre');
    Object.assign(pre.style, {
      margin: '0',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      maxHeight: '38vh',
      overflowY: 'auto',
      background: 'rgba(10,14,22,0.6)',
      borderRadius: '6px',
      padding: '8px',
      opacity: '0.9',
    });
    pre.textContent = JSON.stringify(lastPerfProfile, null, 2);
    el.appendChild(pre);
    return el;
  }
  MapShine.debug.registerPanel('perf-last-result-panel', 'Last result', buildPerfLastResultPanel, {
    zone: 'performance',
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

  // ALBEDO CLARITY (2026-08-15) — the zoom-out sharpness repair's first real
  // UI, replacing the console-only `MapShine.setAlbedoClarity(...)` it shipped
  // with. Follows Wind's MECHANICS (a direct getAlbedoClarity()/
  // setAlbedoClarity() pair, no effectRegistry — this is a global rendering-
  // quality knob, not a placeable/scene-authored effect) with Grade's
  // SUBSTANCE (a real populated schema + a real enable toggle). Order sits
  // right beside Grade's (90) — both are whole-image quality knobs, neither
  // has an `add` affordance (nothing to place or paint).
  function buildAlbedoClarityPanel({ attachments } = {}) {
    const schema = ALBEDO_CLARITY_PARAMS;
    // Explicit per-key dispatch, not a blind `[id]` passthrough — schema and
    // real consumer (setAlbedoClarity/buildAlbedoClarityNode) both live in
    // vt/albedo-clarity.js, so this IS the "referenced somewhere else"
    // params/no-dead-controls needs to see each key is genuinely wired, not
    // just a comment claiming so (the check strips comments on purpose).
    const getValue = (id) => {
      const state = getAlbedoClarity();
      switch (id) {
        case 'sharpness':
          return state.sharpness;
        case 'gateLo':
          return state.gateLo;
        case 'gateHi':
          return state.gateHi;
        case 'farLo':
          return state.farLo;
        case 'farHi':
          return state.farHi;
        case 'farFloor':
          return state.farFloor;
        default:
          return undefined;
      }
    };
    const onChange = (id, value) => {
      switch (id) {
        case 'sharpness':
          setAlbedoClarity({ sharpness: value });
          break;
        case 'gateLo':
          setAlbedoClarity({ gateLo: value });
          break;
        case 'gateHi':
          setAlbedoClarity({ gateHi: value });
          break;
        case 'farLo':
          setAlbedoClarity({ farLo: value });
          break;
        case 'farHi':
          setAlbedoClarity({ farHi: value });
          break;
        case 'farFloor':
          setAlbedoClarity({ farFloor: value });
          break;
        default:
          break;
      }
    };

    return buildEffectCard({
      id: 'albedoClarity',
      diagnostics: attachments,
      icon: '🔎',
      title: 'Sharpening',
      subtitle: 'CAS contrast restore for zoomed-out art (Albedo Clarity)',
      status: () => collapsedStatusLine({ enabled: getAlbedoClarity().enabled }),
      schema,
      // The one control worth touching mid-session — would the author drag
      // this while looking at a live scene? Yes for Sharpness, no for five
      // zoom-threshold constants (feedback_foh_roh_must_differ's judgement
      // test). Everything else falls to ROH under Technical.
      fohKeys: ['sharpness'],
      getValue,
      onChange,
      enabled: getAlbedoClarity().enabled,
      onToggleEnabled: (next) => setAlbedoClarity({ enabled: next }),
      // no `add` — nothing to place/paint, matches Grade/Bloom's shape.
    });
  }

  MapShine.debug.registerPanel('albedo-clarity-panel', 'Sharpening', buildAlbedoClarityPanel, {
    zone: 'workshop',
    effect: 'albedoClarity',
    order: 91,
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

  // GUSTINESS (2026-08-15, author: *"It would be nice if the wind model could
  // create discreet wind gusts and therefore could be more unpredictable in
  // terms of it's pattern."*) — see `world/wind-field.js#computeGustEnvelope`
  // for the mechanism and for why the pre-existing `gust` local in `sampleWind`
  // was never this.
  //
  // A SELECT, NOT A SLIDER, for two reasons that both happen to point the same
  // way: the debug panel has no slider primitive at all (registerAction /
  // registerSelect / registerPanel / registerReport is the whole vocabulary),
  // and gustiness genuinely reads as four named weathers rather than as a
  // continuum anyone would want to hunt through by hand. Same shape as the
  // Overlay-density select below.
  //
  // ⚠️ NO REBAKE — `setVtPanViewerWindGustiness`, deliberately NOT
  // `applyAmbientWind()`. Direction/speed rebake because the wind SHADOW is
  // baked against direction; gustiness is invisible to every CPU-side bake, so
  // routing it through the ambient setter would spend a full wall-raster and
  // flood-fill on each change of this dropdown for no effect whatsoever.
  //
  // ⚠️ RELABELLED THE SAME DAY IT SHIPPED, because the thing it controls
  // changed. It began as the ONLY gust control; the author's own correction
  // — *"linking gustiness to overall wind speed makes the most sense. At low
  // wind values the gusts are extremely few and far between but as wind speed
  // increases the gap between wind blasts gets shorter until at full wind speed
  // you get a malestrom of strong wind gusts all the time"* — moved HOW OFTEN
  // onto the wind dial itself. What is left here is HOW PRONOUNCED, and the
  // label says so. A control whose name describes its old job is a lying
  // instrument ([[feedback_instruments_must_not_lie]]), which is exactly the
  // reasoning the Overlay-density control below already records for its own
  // relabelling.
  let windGustinessValue = String(WIND_DEFAULT_GUSTINESS01);
  MapShine.debug.registerSelect(
    'wind-gustiness',
    '🌬️ Gust strength',
    [
      { value: '0', label: 'Off — steady wind' },
      { value: '0.35', label: 'Subtle' },
      { value: '0.7', label: 'Strong' },
      { value: String(WIND_DEFAULT_GUSTINESS01), label: 'Full (default) — rate follows wind speed' },
    ],
    () => windGustinessValue,
    (value) => {
      windGustinessValue = value;
      setVtPanViewerWindGustiness(Number(value));
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
  // THE REMOTE'S OWN SECOND LIVE INSTANCE (U2) — same real handlers
  // (buildAstrolabeOptions, above), a second DOM tree, side by side with the
  // old panel's — never a second copy of the wiring itself.
  let remoteAstrolabe = null;
  /** Remembers the rate a GM was actually running at before the Remote's
   * flow-pause corner button froze it, so un-pausing restores it rather than
   * guessing a default. Session-only, matching the astrolabe's own "no
   * dial keeps its own copy of the hour" rule — this ISN'T a second store
   * of the rate itself, only of "what to go back to". */
  let lastNonZeroRateHoursPerMinute = 1;
  let windDirectionDeg = 0;
  let windSpeed01 = 0;
  /** Unsubscribe for the scene-sky watcher (a second GM's edit reaching here). */
  let skyUnsub = null;
  void skyUnsub; // held for a future teardown path; the watcher lives for the session

  // ══════════════════════════════════════════════════════════════════════
  // THE FADE ENGINE'S LIVE WIRING (U2 checkpoint 3, docs/holy/UI-Testament.md
  // §4.2) — the weather board's mood chips are this checkpoint's FIRST real
  // consumer of world/fade-engine.js. `fadeSourceRegistry` is built with
  // function declarations below it still safely referenced (same hoisting
  // safety as buildAstrolabeOptions, above): nothing CALLS readLive/write
  // until a fade actually starts, well after skyScope/editSky exist.
  // ══════════════════════════════════════════════════════════════════════

  /** id -> {typeOf, readLive, write}. 'weather' is this checkpoint's only
   * registered source; a future effect becomes fadeable by registering its
   * OWN {schema, getValue, onChange} (world/fade-registry.js#schemaFadeSource)
   * — no change here when that day comes. */
  const fadeSourceRegistry = createFadeSourceRegistry();
  fadeSourceRegistry.registerSource('weather', {
    keys: () => ['cloudCover01', 'precip01'],
    typeOf: () => 'float',
    readLive: (field) => skyScope.sky?.[field] ?? 0,
    // LIVE push only — matches the astrolabe's own slider-drag preview
    // ("applies live every pointermove... PERSISTS only on release"). A
    // per-tick editSky() call here would scene-flag-write every frame of
    // every fade — the exact "hundreds of document updates per drag" this
    // codebase already named and designed away from once already.
    write: (field, value) => {
      if (field === 'cloudCover01') setVtPanViewerCloudCover(value, 'fade-engine');
      else if (field === 'precip01') setVtPanViewerWeatherTargets({ precip01: value });
    },
  });

  /** Record<'weather.cloudCover01'|'weather.precip01', FadeEntry> — scene-
   * scoped, reloaded from the scene flag on every canvasReady (below). */
  let fadeState = {};
  /** gestureId -> the archetype id it's fading TOWARD ('custom' for a
   * Baseline fade, which has no named row to relight), so the per-tick pump
   * knows what to persist once every key sharing that gesture has arrived.
   * Bookkeeping ONLY — fadeState itself holds per-KEY entries, never groups. */
  const pendingArchetypeCompletions = new Map();
  /** Captured once per scene — "the scene's authored resting look" the
   * Baseline button fades back to. `null` until the first canvasReady for
   * this scene has run. */
  let baselineWeatherSnapshot = null;
  /** Unsubscribe for the scene-fade watcher (a second GM's fade reaching
   * here) — re-armed on every canvasReady, mirroring skyUnsub's own shape. */
  let fadeUnsub = null;

  /**
   * Start a REAL fade toward a named archetype's own declared axis values.
   * `weatherArchetype` flips to 'custom' immediately (the SAME "a value
   * mid-transition is not the row it left" rule the Cloud slider's own drag
   * already established) and only becomes the target's real id once every
   * key has actually arrived (see pumpWeatherFades).
   * @param {string} archetypeId @param {number} overMs
   */
  function fadeWeatherToArchetype(archetypeId, overMs) {
    const archetype = WEATHER_ARCHETYPES.find((a) => a.id === archetypeId);
    if (!archetype) return;
    const nowMs = wallClockMs();
    const gestureId = `archetype:${archetypeId}:${nowMs}`;
    const targets = {};
    for (const field of ['cloudCover01', 'precip01']) {
      const to = archetype.axes?.[field];
      if (!Number.isFinite(to)) continue;
      targets[`weather.${field}`] = {
        to,
        type: 'float',
        overMs,
        curve: 'ease',
        from: fadeSourceRegistry.readLive(`weather.${field}`),
      };
    }
    if (Object.keys(targets).length === 0) return;
    fadeState = mergeFadeState(fadeState, { id: gestureId, label: archetype.label, targets }, nowMs);
    pendingArchetypeCompletions.set(gestureId, archetypeId);
    void editSky({ weatherArchetype: 'custom' });
    void writeFadeState(fadeState);
  }

  /**
   * The Remote's Baseline button. A no-op (logged, never a silent swallow)
   * if no baseline was ever captured for this scene.
   * @param {number} overMs
   */
  function fadeWeatherToBaseline(overMs) {
    if (!baselineWeatherSnapshot) {
      log.warn('Baseline: no captured resting look for this scene yet.');
      return;
    }
    const nowMs = wallClockMs();
    const gestureId = `baseline:${nowMs}`;
    const targets = {};
    for (const [field, to] of Object.entries(baselineWeatherSnapshot)) {
      targets[`weather.${field}`] = {
        to,
        type: 'float',
        overMs,
        curve: 'ease',
        from: fadeSourceRegistry.readLive(`weather.${field}`),
      };
    }
    fadeState = mergeFadeState(fadeState, { id: gestureId, label: 'Baseline', targets }, nowMs);
    pendingArchetypeCompletions.set(gestureId, 'custom'); // no named row to relight
    void editSky({ weatherArchetype: 'custom' });
    void writeFadeState(fadeState);
  }

  // ══════════════════════════════════════════════════════════════════════
  // CUES (U3, docs/holy/UI-Testament.md §4.3) — console-first engine wiring.
  // No Studio capture flow or Remote deck yet (a natural follow-up, the
  // same "core first, room second" pacing U2 already used) — but every
  // function below is REAL: MapShine.captureCue/fireCue/listCues are
  // genuinely callable today, validated exactly like an authored cue would
  // be once a real capture UI exists. A cue's own targets currently cover
  // only the SAME two weather axes the board's own faders do — the only
  // keys anything has registered with fadeSourceRegistry so far; a
  // capture UI reaching further just needs more registered sources, not a
  // change here (world/fade-registry.js's own whole point).
  // ══════════════════════════════════════════════════════════════════════
  /** @type {import('./core/cues-schema.js').Cue[]} loaded from the scene flag on canvasReady. */
  let cueStack = [];
  let cuesUnsub = null;

  /**
   * "Capture-then-name" (§4.3) — snapshot the CURRENT live weather values
   * as a new cue's targets, append it to the stack, validate the WHOLE
   * stack (a bad capture must not silently corrupt an otherwise-good
   * stack), and only persist if it's clean.
   * @param {string} name @param {number} [overMs] @param {string} [curve]
   * @returns {Promise<{ok: boolean, reason: string|null, cue: object|null}>}
   */
  async function captureCueFromLive(name, overMs = 5000, curve = 'ease') {
    if (typeof name !== 'string' || name.length === 0) {
      return { ok: false, reason: 'a cue needs a name', cue: null };
    }
    const id = `cue-${wallClockMs()}`;
    const targets = {};
    for (const field of ['cloudCover01', 'precip01']) {
      targets[`weather.${field}`] = { to: fadeSourceRegistry.readLive(`weather.${field}`), overMs, curve };
    }
    const order = cueStack.length === 0 ? 0 : Math.max(...cueStack.map((c) => c.order)) + 1;
    const candidate = { id, name, order, targets };
    const nextStack = [...cueStack, candidate];
    const check = validateCueStack(nextStack, fadeSourceRegistry.typeOf);
    if (!check.ok) {
      log.error('captureCue: the captured cue failed validation:', check.errors);
      return { ok: false, reason: check.errors.join('; '), cue: null };
    }
    cueStack = nextStack;
    const result = await writeCueStack(cueStack);
    if (!result.ok) log.warn(`captureCue: stored locally but not persisted: ${result.reason}`);
    MapShine.__remote?.refreshCueDeck();
    return { ok: true, reason: null, cue: candidate };
  }

  /**
   * Fire a cue by id — the Remote's future GO button, callable from the
   * console today. Re-validates before arming ("invalid cue refuses to
   * arm", §9's own U3 checklist) rather than trusting whatever is sitting
   * in the stack.
   * @param {string} id @returns {{ok: boolean, reason: string|null}}
   */
  function fireCueById(id) {
    const cue = cueStack.find((c) => c.id === id);
    if (!cue) return { ok: false, reason: `no cue with id '${id}' in this scene's stack` };
    const check = validateCue(cue, fadeSourceRegistry.typeOf);
    if (!check.ok) {
      log.error(`fireCue '${id}': refused to arm — invalid:`, check.errors);
      return { ok: false, reason: check.errors.join('; ') };
    }
    const nowMs = wallClockMs();
    const patch = cueToFadePatch(cue, fadeSourceRegistry.readLive, fadeSourceRegistry.typeOf);
    fadeState = mergeFadeState(fadeState, patch, nowMs);
    void writeFadeState(fadeState);
    return { ok: true, reason: null };
  }

  /**
   * Set every target of one cue to the SAME new fade time (the CUES
   * department's own per-card control, U3) — re-validates the WHOLE stack
   * before persisting, exactly like captureCueFromLive.
   * @param {string} id @param {number} overMs @returns {{ok: boolean, reason: string|null}}
   */
  function updateCueFadeMs(id, overMs) {
    const ix = cueStack.findIndex((c) => c.id === id);
    if (ix === -1) return { ok: false, reason: `no cue with id '${id}' in this scene's stack` };
    const targets = {};
    for (const [key, t] of Object.entries(cueStack[ix].targets)) targets[key] = { ...t, overMs };
    const nextStack = cueStack.map((c, i) => (i === ix ? { ...c, targets } : c));
    const check = validateCueStack(nextStack, fadeSourceRegistry.typeOf);
    if (!check.ok) return { ok: false, reason: check.errors.join('; ') };
    cueStack = nextStack;
    void writeCueStack(cueStack);
    MapShine.__remote?.refreshCueDeck();
    return { ok: true, reason: null };
  }

  /**
   * Swap a cue's own `order` with its neighbour's (the deck/jump-list
   * sequence, `core/cues-schema.js#orderedCues`) — direction is -1 (up,
   * earlier) or +1 (down, later). A no-op at either end of the stack, not
   * an error — there's nothing wrong with already being first or last.
   * @param {string} id @param {-1|1} direction @returns {{ok: boolean, reason: string|null}}
   */
  function moveCueOrder(id, direction) {
    const ordered = orderedCues(cueStack);
    const ix = ordered.findIndex((c) => c.id === id);
    if (ix === -1) return { ok: false, reason: `no cue with id '${id}' in this scene's stack` };
    const neighbourIx = ix + direction;
    if (neighbourIx < 0 || neighbourIx >= ordered.length) return { ok: true, reason: null }; // already at an end
    const a = ordered[ix];
    const b = ordered[neighbourIx];
    const nextStack = cueStack.map((c) => {
      if (c.id === a.id) return { ...c, order: b.order };
      if (c.id === b.id) return { ...c, order: a.order };
      return c;
    });
    const check = validateCueStack(nextStack, fadeSourceRegistry.typeOf);
    if (!check.ok) return { ok: false, reason: check.errors.join('; ') };
    cueStack = nextStack;
    void writeCueStack(cueStack);
    MapShine.__remote?.refreshCueDeck();
    return { ok: true, reason: null };
  }

  // ── CUE TEST-FIRE + INSTANT REVERT (§5.4) — deliberately isolated from
  // fadeState/pendingArchetypeCompletions, NEVER via mergeFadeState/
  // writeFadeState. A test that overwrote fadeState[key] directly would
  // hijack whatever REAL, concurrent gesture (a mood-chip fade, another
  // cue) already owns that key — pendingArchetypeCompletions tracks
  // completion by counting that gesture's OWN entries in fadeState, so a
  // hijacked key would either fire that gesture's completion early (wrong
  // archetype lands) or strand it pending forever. A preview must never be
  // able to corrupt a real fade's own bookkeeping, so it never touches
  // fadeState at all — it drives fadeSourceRegistry.write() directly,
  // riding the SAME per-frame pump (pumpCueTestPreview, called from
  // pumpAstrolabe below) rather than a second requestAnimationFrame loop
  // (time/one-clock). Never persisted — a test is this GM's own client
  // only, the saved scene and every other client never see it.
  /** @type {{targets: Record<string, {from: unknown, to: unknown, type: string, curve: string, overMs: number}>, startedAtMs: number}|null} */
  let cueTestPreview = null;
  /** @type {Record<string, unknown>|null} pre-test live values, for revert. */
  let cueTestSnapshot = null;

  function pumpCueTestPreview(nowMs) {
    if (!cueTestPreview) return;
    const { targets, startedAtMs } = cueTestPreview;
    let allDone = true;
    for (const [key, target] of Object.entries(targets)) {
      const entry = { ...target, startedAtMs };
      fadeSourceRegistry.write(key, computeEasedValue(entry, nowMs));
      if (!isEntryExpired(entry, nowMs)) allDone = false;
    }
    if (allDone) cueTestPreview = null;
  }

  /**
   * Preview a cue's targets for real (its own curve, capped so a 20-minute
   * cue still previews in a few seconds) — never persisted. Snapshots the
   * PRE-test live values first, so revertCueTest() can restore them exactly.
   * @param {string} id @returns {{ok: boolean, reason: string|null}}
   */
  function testFireCue(id) {
    const cue = cueStack.find((c) => c.id === id);
    if (!cue) return { ok: false, reason: `no cue with id '${id}' in this scene's stack` };
    // Refuse a SECOND test while one is already live — re-snapshotting now
    // would read the FIRST test's own mid-flight values as "the original",
    // so a later revert would restore the wrong thing. One test at a time,
    // enforced here rather than trusted to the UI.
    if (cueTestSnapshot) return { ok: false, reason: 'a test is already active — revert it first' };
    const check = validateCue(cue, fadeSourceRegistry.typeOf);
    if (!check.ok) return { ok: false, reason: check.errors.join('; ') };
    const PREVIEW_CAP_MS = 4000; // a test never takes longer than this to actually see
    const snapshot = {};
    const targets = {};
    for (const [key, t] of Object.entries(cue.targets)) {
      const from = fadeSourceRegistry.readLive(key);
      snapshot[key] = from;
      targets[key] = {
        from,
        to: t.to,
        type: fadeSourceRegistry.typeOf(key),
        curve: t.curve,
        overMs: Math.min(t.overMs, PREVIEW_CAP_MS),
      };
    }
    cueTestSnapshot = snapshot;
    cueTestPreview = { targets, startedAtMs: wallClockMs() };
    return { ok: true, reason: null };
  }

  /** Instantly (well — 400ms, never a jarring snap) restore whatever was
   * live immediately before the last testFireCue(). A no-op, not an error,
   * when there is nothing to revert. */
  function revertCueTest() {
    if (!cueTestSnapshot) return { ok: false, reason: 'nothing to revert' };
    const targets = {};
    for (const [key, value] of Object.entries(cueTestSnapshot)) {
      targets[key] = {
        from: fadeSourceRegistry.readLive(key),
        to: value,
        type: fadeSourceRegistry.typeOf(key),
        curve: 'ease',
        overMs: 400,
      };
    }
    cueTestSnapshot = null;
    cueTestPreview = { targets, startedAtMs: wallClockMs() };
    return { ok: true, reason: null };
  }

  /** Whether a test-fire preview is currently live on THIS client — the
   * CUES department re-derives its own "Revert" affordance from this on
   * every render rather than tracking its own local state, so it stays
   * correct even after navigating to another department and back mid-test.
   * @returns {boolean} */
  function isCueTestActive() {
    return cueTestSnapshot !== null;
  }

  // CUES' CONSOLE DOOR (U3) — no Remote deck UI yet (a real follow-up, not
  // silently built here), but every lever below is genuinely live today,
  // matching setSunHour/setCloudCover/getWind/setWind's own "console-first"
  // precedent above. `MapShine.listCues()` reads the CURRENT scene's own
  // stack — empty until canvasReady has actually hydrated it, or until
  // captureCue has authored the first one.
  MapShine.captureCue = (name, overMs, curve) => captureCueFromLive(name, overMs, curve);
  MapShine.fireCue = (id) => fireCueById(id);
  MapShine.listCues = () => orderedCues(cueStack);
  MapShine.updateCueFadeMs = (id, overMs) => updateCueFadeMs(id, overMs);
  MapShine.moveCueOrder = (id, direction) => moveCueOrder(id, direction);
  MapShine.testFireCue = (id) => testFireCue(id);
  MapShine.revertCueTest = () => revertCueTest();
  MapShine.isCueTestActive = () => isCueTestActive();

  /**
   * The per-tick half of the Fade Engine: pushes every active entry's eased
   * value LIVE (cheap, in-memory) every animation frame, and persists a
   * gesture's completion exactly ONCE, the moment every key it touched has
   * actually arrived. Runs UNCONDITIONALLY (unlike pumpAstrolabe's own dial
   * repaint below) — an in-flight weather fade must keep affecting the
   * rendered sky even while the Remote is closed; closing a panel must
   * never pause the world.
   * @param {number} nowMs
   */
  function pumpWeatherFades(nowMs) {
    const keys = Object.keys(fadeState);
    if (keys.length === 0) return;
    for (const key of keys) {
      const entry = fadeState[key];
      if (isEntryExpired(entry, nowMs)) continue;
      fadeSourceRegistry.write(key, computeEasedValue(entry, nowMs));
    }
    let anyCompleted = false;
    for (const [gestureId, archetypeId] of pendingArchetypeCompletions) {
      const ownEntries = Object.values(fadeState).filter((e) => e.id === gestureId);
      if (ownEntries.length > 0 && ownEntries.every((e) => isEntryExpired(e, nowMs))) {
        pendingArchetypeCompletions.delete(gestureId);
        if (archetypeId !== 'custom') void editSky({ weatherArchetype: archetypeId });
        anyCompleted = true;
      }
    }
    // Re-render the weather board on an actual arrival, not every tick —
    // `refreshWeatherBoard` rebuilds the whole board (chips + faders), which
    // is real DOM churn every rAF frame would be wasteful for.
    //
    // ⚠️ NAMED GAP: buildParamControl's slider has no external "the value
    // changed elsewhere" hook (unlike the astrolabe dial's own update(state)
    // pattern) — its thumb only moves on a user drag or a full rebuild. So
    // while a mood-chip fade is IN FLIGHT, the fader THUMB stays wherever it
    // was until this refresh fires at completion; the actual rendered SKY
    // still eases smoothly the whole time regardless (fadeSourceRegistry's
    // own per-tick write, above, is independent of this UI). A live-updating
    // slider is a real follow-up, not silently claimed as done here.
    if (anyCompleted) MapShine.__remote?.refreshWeatherBoard();
    fadeState = pruneExpired(fadeState, nowMs);
  }
  const applyAmbientWind = () => setVtPanViewerWindAmbient(windDirectionDeg, windSpeed01);

  // WIND'S CONSOLE/UI DOOR (U2) — the astrolabe's own dial already steers
  // wind live; these two just expose that same door on MapShine so the
  // Remote (or the console) never has to reach past the public API for it,
  // matching setSunHour/setCloudCover's own shape above. `direction`/`speed01`
  // land through the identical `applyAmbientWind` commit path the dial uses
  // on pointer-release — never a second write route.
  MapShine.getWind = () => ({ directionDeg: windDirectionDeg, speed01: windSpeed01 });
  MapShine.setWind = ({ directionDeg, speed01 } = {}) => {
    if (Number.isFinite(directionDeg)) windDirectionDeg = directionDeg;
    if (Number.isFinite(speed01)) windSpeed01 = Math.max(0, Math.min(1, speed01));
    applyAmbientWind();
  };

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

  // A FUNCTION, not an inline object — hoisted, so it can sit exactly where
  // the original inline object did (before editSky/skyScope's own `let`/
  // `const` declarations further down this closure) while still safely
  // referencing them: nothing CALLS this until a panel/room actually
  // renders, well after install() has finished defining everything once.
  // The Remote's OWN astrolabe instance (installRemote's mountAstrolabeDial,
  // U2) calls this SAME function a second time to build the identical real
  // handlers — never a hand-copied second set that could silently drift
  // from this one. Both instances read/write the SAME closure state
  // (windDirectionDeg, windSpeed01, editSky, ...), and pumpAstrolabe (this
  // file, further down) updates whichever of the two DOM trees is actually
  // connected at the time.
  function buildAstrolabeOptions() {
    return {
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
      // Dragging Cloud moves the sky OFF whatever named row it was on, so the
      // stored archetype becomes `custom` in the same write. Leaving it
      // naming the old row would persist a sky that claims to be `overcast`
      // at cover 0.2 — the exact lie the manager's derived label prevents at
      // runtime, reintroduced through the store. One edit, both fields.
      onCloudChange: (v, committed) => {
        if (committed) void editSky({ cloudCover01: v, weatherArchetype: 'custom' });
      },
      // THE HORIZON SHELF (docs/planning/Weather-Manager.md §9) — one click,
      // one named sky. Stores the ID, not the four axis values: the row IS
      // the authored intent, and re-deriving the axes from it on load means a
      // future tweak to a row reaches every scene that chose it.
      onArchetypeChange: (id) => {
        void editSky({ weatherArchetype: id });
      },
      // ⭐ THE MODE TOGGLE (Weather-Manager.md §5, §9). Goes through the SAME
      // `editSky` path as everything else on this dial — the mode is per-
      // world/per-scene exactly like the hour and the cloud slider are.
      onWeatherModeChange: (mode) => {
        void editSky({ weatherMode: mode });
      },
      // THE ALMANAC'S CLIMATE (ROH). `null` from the "— none (idle) —"
      // option is a real, honest edit, not a no-op — see
      // `DEFAULT_SKY.weatherBiome`'s own note on why idle is legitimate.
      onWeatherBiomeChange: (id) => {
        void editSky({ weatherBiome: id });
      },
      onWeatherVolatilityChange: (v, committed) => {
        if (committed) void editSky({ weatherVolatility: v });
      },
      // THE PIN GLYPH. Unpinning is live SESSION state (the manager's own
      // `pinnedAxes` Set), not a persisted sky field — releasing a pin lets
      // the walk touch that axis again on its own next transition; it does
      // not itself move anything, so there is nothing here to persist.
      onUnpinCloudCover: () => {
        unpinVtPanViewerWeatherAxis('cloudCover01');
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
    };
  }

  MapShine.debug.registerPanel(
    'astrolabe',
    '🧭 Astrolabe',
    () => {
      astrolabe = createAstrolabe(buildAstrolabeOptions());
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
    // ⭐ THE ALMANAC'S OWN MODE + CLIMATE, restored BEFORE the weather-archetype
    // restore just below — order matters here. `setWeatherArchetype`/
    // `setCloudCover` route through `weather.applyArchetype`, which (in
    // `almanac` mode) makes the walk ADOPT whatever it's given as its current
    // node. That adoption has to land against the RIGHT mode and biome, or a
    // scene saved mid-walk would restore its sky correctly but its Almanac
    // bookkeeping against the previous scene's climate.
    setVtPanViewerWeatherMode(sky.weatherMode);
    setVtPanViewerWeatherBiome(sky.weatherBiome);
    setVtPanViewerWeatherVolatility(sky.weatherVolatility);
    // THE WEATHER RESTORE RULE — exactly ONE of these two is authoritative,
    // never both (see `DEFAULT_SKY.weatherArchetype`'s own note). A named sky
    // applies its whole ROW, so all four cloud axes come back; only a
    // hand-tuned `custom` sky is described by the stored cover.
    if (sky.weatherArchetype && sky.weatherArchetype !== 'custom') {
      setVtPanViewerWeatherArchetype(sky.weatherArchetype, 'sky-settings');
    } else {
      setVtPanViewerCloudCover(sky.cloudCover01, 'sky-settings');
      // ⚠️ ONLY on the `custom` branch, and for exactly the reason the comment
      // above gives for cover: a NAMED row already carries its own `precip01`,
      // so restoring the stored one on top would let a shelf sky and a stale
      // hand-set shower disagree about how hard it is raining.
      setVtPanViewerWeatherTargets({ precip01: sky.precip01 });
    }
    // ⭐ CLIMATE RESTORE — unconditional, unlike precipitation above, BECAUSE
    // temperature is deliberately NOT archetype-owned (`ARCHETYPE_OWNED_AXES`:
    // a sky is not a climate). No row will ever restore it, so if this line is
    // absent a wintry map silently thaws on every refresh and its snow turns
    // to rain — which is exactly the half-persistence the author reported.
    setVtPanViewerWeatherTargets({ temperature01: sky.temperature01 });
    // ⚠️ THE AUTHORED KIND, AND ONLY WHEN IT IS AN EXPLICIT PIN. `applyArchetype`
    // above already set this — to the row's own kind for `snow`, to `auto` for
    // every other row — so restoring the stored value unconditionally would
    // stomp that: a saved `snow` scene would reload, apply the snow ROW (kind
    // = snow), then immediately be reset to `auto` by a stored default and
    // start raining. The Snow button, broken again, by the restore path.
    //
    // `auto` is the DEFAULT, so it carries no information about intent — only
    // a non-auto value means "the GM pinned this", and only that is worth
    // outranking the row (`feedback_derived_zero_collides_with_configured_zero`
    // in its enum form: the default value and a deliberate choice must not be
    // the same token if one is supposed to win).
    if (sky.precipKindAuthored && sky.precipKindAuthored !== 'auto') {
      setVtPanViewerPrecipKind(sky.precipKindAuthored);
    }
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
  // Also re-syncs the weather board's own chip/mode highlighting — a SECOND
  // GM's sky edit must reach THIS client's Remote too, "one writer, many
  // derivers" applied to the UI, not just the render.
  skyUnsub = watchSceneSky(() => {
    resolveAndApplySky();
    MapShine.__remote?.refreshWeatherBoard();
  });

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

  // The dial mirrors the live engines, THROTTLED, while it is visible. Reading
  // back rather than remembering is what keeps the ring honest while time
  // DRIFTS or SWEEPS on its own, and what shows the pause ramp winding down
  // live — none of which needs render-framerate cadence to read as "live" to
  // a human: a clock hand and a wind arrow moving 10x/sec is indistinguishable
  // from 60-120x/sec, and the repaint itself was measured at a real cost
  // (astrolabe.js's own `update()`: 1,415ms/6.9% of one 35.6s capture's main
  // thread — docs/planning/Trace-Analysis-2026-08-11.md §3, Testament Stage 4).
  const ASTROLABE_REPAINT_INTERVAL_MS = 100; // ~10Hz
  let lastAstrolabeRepaintMs = -Infinity;
  // `nowMs` is requestAnimationFrame's OWN callback timestamp — an INPUT this
  // function receives, never a `performance.now()` call boot.js would not be
  // allowed to make (`time/one-clock`, tools/verify-structure.mjs, exempts
  // only diag/ and core/frame-clock.js). The previous version of this
  // function took no parameter at all and silently discarded the one rAF
  // already hands every callback.
  const pumpAstrolabe = (nowMs) => {
    // U6's Law 11 row (docs/holy/UI-Testament.md §9): this whole function IS
    // the Studio/Remote's real steady-state per-frame UI cost — candle
    // ignition, weather-fade pumping, cue-preview pumping run UNGATED every
    // frame; the astrolabe repaint below adds itself in on top whenever its
    // own throttle/visibility gate opens. Wrapping the WHOLE body (rather
    // than just the throttled block) means the mean/max split in the perf
    // report HONESTLY shows that variability rather than hiding it behind a
    // narrower bracket. `diag/ui-perf.js`'s own header explains why this is
    // a self-measuring accumulator, not a perf-zones.js zone.
    const uiTickStartedAt = beginUiTick();
    // UNGATED, unlike the astrolabe repaint below: candles must keep
    // responding to the clock whether or not a GM currently has the dial
    // open. Cheap on every frame that ISN'T a crossing (one computeSun call +
    // a boolean compare) — see refreshCandleIgnition's own doc.
    refreshCandleIgnition();
    // ALSO UNGATED — an in-flight weather fade must keep landing on the
    // rendered sky whether or not the Remote happens to be open right now
    // (pumpWeatherFades's own doc explains why). Piggybacks this rAF loop's
    // real timestamp rather than a second requestAnimationFrame registration.
    pumpWeatherFades(nowMs);
    // A cue TEST preview (§5.4) rides this exact same timestamp too — see
    // pumpCueTestPreview's own doc for why it must never become a second
    // requestAnimationFrame loop.
    pumpCueTestPreview(nowMs);
    // THREE conditions, all must hold: (1) `isConnected` — the panel builds
    // the dial once and the shell detaches it when another zone is showing;
    // (2) NOT explicitly hidden — `isPanelVisible() === false` after
    // MapShine.debug.hidePanel() (perf-session.js calls this while measuring,
    // Testament Stage 4's "hide itself and cost nothing during tests"); a
    // MISSING isPanelVisible (an unusual boot order, or a harness with no
    // debug panel at all) fails OPEN — paints anyway — matching this
    // project's own gate-polarity doctrine
    // (feedback_gate_polarity_must_fail_open): an occasional extra repaint is
    // a far smaller failure than a dial that silently freezes with no visible
    // cause. (3) the throttle window has elapsed.
    const hiddenForMeasurement = MapShine.debug?.isPanelVisible?.() === false;
    // Either DOM tree being connected is enough to justify computing one
    // payload — a GM can have the old panel's dial, the Remote's, both, or
    // neither on screen at a given moment (side-by-side rollout, U1/U2).
    const anyConnected = astrolabe?.root?.isConnected || remoteAstrolabe?.root?.isConnected;
    if (anyConnected && !hiddenForMeasurement && nowMs - lastAstrolabeRepaintMs >= ASTROLABE_REPAINT_INTERVAL_MS) {
      lastAstrolabeRepaintMs = nowMs;
      const dial = getVtPanViewerTimeDialState();
      // `windSpeed01` is the ONE value the dial owns rather than reads back:
      // the wind engine only learns it on commit (a rebake per pointermove
      // would be brutal), so between grab and release the engine genuinely
      // does not know it yet. Everything else mirrors the engine.
      // The sky block rides along from the RESOLVED scope, not from a copy the
      // dial keeps — so the checkbox and the sliders always show the store that
      // is actually in force, including after another GM changes it.
      if (dial) {
        const payload = {
          ...dial,
          windSpeed01,
          cloudCover01: skyScope.sky?.cloudCover01 ?? 0,
          skyRealism01: skyScope.sky?.realism01 ?? 0,
          gradeEnvStrength: skyScope.sky?.gradeEnvStrength ?? 0,
          // The Almanac's own config rides the SAME resolved-scope rule as
          // everything else above — the mode select and biome picker must
          // show the store actually in force, not a copy the dial keeps.
          weatherMode: skyScope.sky?.weatherMode ?? 'director',
          weatherBiome: skyScope.sky?.weatherBiome ?? null,
          weatherVolatility: skyScope.sky?.weatherVolatility ?? 1,
          sceneOverrides: skyScope.sceneOverrides === true,
          // ⚠️ THE SAME RULE APPLIES TO `mode`, and here it is load-bearing,
          // not just cosmetic: `dial.mode` comes from `dayClock.read().mode`,
          // which only ever says 'aesthetic'/'synced' — 'follow' AND
          // 'almanac' both collapse to 'synced' at that layer, by design
          // (Almanac Testament §1). Showing the dial's collapsed value in
          // the mode dropdown would mean 'almanac' displays as "Synced", and
          // if that dropdown's own change handler ever re-fired against its
          // OWN displayed value, it would silently WRITE 'follow' over a
          // true 'almanac' posture — downgrading the Pen's arming with no
          // visible cause. Reading the TRUE posture from the resolved sky
          // scope instead (exactly like weatherMode/weatherBiome above)
          // closes that hole the same way it is already closed for them.
          mode: skyScope.sky?.mode ?? 'aesthetic',
        };
        if (astrolabe?.root?.isConnected) astrolabe.update(payload);
        // The Remote's own dial (2026-08-18 fix) takes a narrower shape than
        // the old panel's bundled payload — no weather-shelf/mode-select
        // fields, since weather-board.js already owns those for the Remote.
        // `cloudCoverEased01`, not `cloudCover01`: the scene must show the
        // sky the map is ACTUALLY rendering, matching `dial`'s own doc above
        // on why the two are deliberately kept separate. `dateText` has no
        // real source yet (see astrolabe-dial.js's own header) — omitted,
        // the dial's own `?? '—'` fallback shows honestly, not faked.
        if (remoteAstrolabe?.root?.isConnected) {
          remoteAstrolabe.update({
            hour: payload.todHour,
            phase: payload.phase,
            windDirectionDeg: payload.windDirectionDeg,
            windSpeed01: payload.windSpeed01,
            cloudCover01: payload.cloudCoverEased01,
          });
          // Keeps the TL corner's flow/speed buttons honest against
          // whatever actually changed rateHoursPerMinute — the old panel's
          // own rate slider, another connected client — not just this
          // corner's own clicks (2026-08-18 fix, shell.js's own note on
          // syncAstrolabePanel).
          MapShine.__remote?.syncAstrolabePanel?.();
        }
      }
    }
    // Ends BEFORE the reschedule below — scheduling next frame's callback is
    // not part of THIS frame's UI work, and including it would count the
    // same fixed rAF-registration cost on every single sample for no signal.
    endUiTick(uiTickStartedAt);
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

  // THE ALMANAC DIAGNOSTIC REPORT (docs/holy/Almanac-Testament.md, stage
  // A2) — the author's own ask, 2026-08-17: *"build a button which will
  // output a report/test the system so that when I do get a chance to
  // actually test it I can use that to get you the data you need."* Every
  // argument here is something ONLY boot.js can hand in — see almanac-
  // diagnostics.js's own header for why `foundry/` cannot gather these itself.
  MapShine.debug.registerReport(
    'almanac-diagnostics',
    '🗓 Almanac Diagnostics',
    () =>
      buildAlmanacDiagnosticsReport({
        calendars: CALENDARS,
        projectWorldTime,
        posture: skyScope.sky?.mode,
        dayClockTodHour: getVtPanViewerTimeDialState()?.todHour ?? null,
      }),
    { zone: 'lab' }
  );

  // An ACTION, never a report — registerReport's own contract is that the
  // flight recorder runs EVERY registered report automatically on export,
  // and a stand-down WRITES a scene flag. GM-gated inside
  // standDownPf2eDarknessSync itself; this button is the deliberate
  // "consent" gesture the Almanac Testament §6.4 names, nothing fires on
  // its own.
  MapShine.debug.registerAction(
    'pf2e-darkness-standdown',
    '🌑 Stand down pf2e darkness sync (this scene)',
    () => standDownPf2eDarknessSync(),
    { zone: 'lab' }
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

  // WALL-STRUCTURE VERSION (2026-08-09, Performance-Audit-2026-08.md §12 —
  // the deferred half of §5.1/§6.8's pre-filter fix). point-light-pool.js
  // used to call `readSceneWallSegments` — a full walk of every wall on the
  // scene — every single frame, even though wall geometry only changes on
  // these three hooks. A SECOND, independent watcher rather than folding
  // into `wallWatch` above, same posture as `watchDoorOpenings` just below
  // being its own subscription: two consumers of the same raw hooks with
  // genuinely different jobs (one rebakes a wind grid, one just bumps a
  // counter) should not be coupled through a shared callback. No coalescing
  // needed here (unlike `wallWatch`'s queueMicrotask) — bumping an integer is
  // O(1), so even a many-hooks-in-one-tick bulk edit costs nothing extra;
  // consumers only ever read the FINAL value, once, on their next frame.
  // Registered here — once, for this module's whole lifetime — rather than
  // inside `startRealSceneViewer`/`createPointLightPool`: that path is a
  // confirmed real restart pair (`stopVtPanViewer`/`startVtPanViewer`), and
  // `watchSceneWallStructure` has no unsubscribe, so registering it there
  // would leak one more set of listeners per scene switch.
  //
  // ⚠️ ORIGINALLY NAMED `apertureWallVersion` — RENAMED 2026-08-15. Started
  // life feeding only the aperture-gobo wall-SEGMENT cache (below), but that
  // name became a lie the moment point-light-pool.js's own candle/lightning/
  // fire/regular-light wall-CLIP SHAPE caches started reading it too (the
  // "lights aren't occluded by walls" investigation found those four caches
  // never invalidated on a real wall edit at all — see this file's own
  // `createPointLightPool` call site). One counter, any wall CRUD — every
  // consumer of "did the walls change" reads the SAME value now.
  let wallStructureVersion = 0;
  const wallStructureWatch = watchSceneWallStructure(() => {
    wallStructureVersion++;
  });
  if (!wallStructureWatch.registered) {
    log.warn(
      `wall-structure version not wired (wall-clip caches will never invalidate) — ${wallStructureWatch.reason}`
    );
  }

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

  /**
   * A synthetic "something the wind just blew past" gust — for verifying
   * Tier 2 looks right WITHOUT needing a real door in a real scene
   * (feedback_instruments_must_not_lie: give the author a way to trigger
   * and SEE the thing being reported, not just trust the log line). Built
   * as a short synthetic wall segment ORIENTED SQUARE TO the CURRENT
   * ambient direction (a wall the wind blows straight at), so it reliably
   * produces a strong, visible impulse regardless of whichever compass
   * setting is currently dialled in — never a coin-flip on whether the
   * demo shows anything.
   *
   * U7 (docs/holy/UI-Testament.md §9): this is ALSO the real "Gust"
   * impulse's own `fire()` — extracted so the debug action and the
   * Remote's own button call exactly one implementation, never two that
   * could quietly drift (this project's own named-and-fixed shape,
   * `feedback_hand_maintained_dispatch_list_forgets_new_effects`'s sibling
   * problem one level over).
   * @returns {{skipped: boolean, reason?: string}}
   */
  function gustWindFromAmbient() {
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
  }

  /**
   * U7 — the Remote's real "Gust" impulse. Always succeeds in the sense
   * that mattered to the debug action it's extracted from (a synthetic
   * wall always exists to blow against) — `{skipped:true}` only if the
   * viewer itself is not running at all.
   * @returns {{ok: boolean, message: string}}
   */
  MapShine.gustWind = () => {
    const result = gustWindFromAmbient();
    if (result.skipped) return { ok: false, message: `Gust skipped — ${result.reason}.` };
    return { ok: true, message: 'Gust triggered.' };
  };

  MapShine.debug.registerAction('wind-test-gust', '🌬️ Trigger test gust', () => gustWindFromAmbient(), {
    effect: 'wind',
  });

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
        getWallStructureVersion: () => wallStructureVersion,
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
        // `phase` is OPTIONAL and defaults to ART, so every existing call site
        // in the viewer keeps meaning exactly what it meant. It exists so the
        // device-creation step — seconds on a cold driver, and previously
        // reported under whatever label happened to still be on screen — can
        // name itself (LOAD_PHASES.DEVICE's own doc has the reasoning).
        onLoadProgress: ({ done, total, detail, phase }) =>
          reportSceneLoadProgress(phase ?? LOAD_PHASES.ART, { done, total, detail }),
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
        // VIDEO-CAPTURE FRAME CAP (2026-08-10, author-requested): the author
        // records promotional videos at 30fps externally, and rendering faster
        // than that while the camera-path tool is playing only steals GPU
        // headroom from the 30 frames the capture actually keeps — see
        // renderFrame's own use of this getter for the throttle itself.
        // `isCameraPathPlaying` already exists in foundry/camera-path-player.js
        // for the debug panel's own play/stop button state; this just gives the
        // render loop the same read, through the SAME injection seam as every
        // other cross-cutting getter here (vt/ never reaches into foundry/).
        // ⚠️ `isCameraPathPlayingCapped`, NOT the plain `isCameraPathPlaying` —
        // see that function's own doc (2026-08-10 fix): perf-run-full/
        // perf-report-all-tiers drive their benchmark route through the SAME
        // player and must NOT be caught by the video-capture 30fps cap this
        // getter feeds.
        getCameraPathPlaying: isCameraPathPlayingCapped,
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
        // FIRE's render-state seam — same injection posture as the two above.
        // ⚠️ Passed, not merely declared: a render-state seam that is declared,
        // defaulted and never passed is exactly how water shipped every control
        // inert with a fully green test suite
        // (`feedback_seam_default_hides_unwired`), and `createFireSubsystem`
        // THROWS on a missing one rather than defaulting for that reason.
        getFireRenderState,
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
        // DEPTH OF FIELD (effects/depth-of-field-render.js): same shape as
        // bloom's own seam just above — a whole-image screen effect needing
        // no scene data, so the torture-soak harness omits it the same way.
        getDofRenderState,
        // SUN SHADOWS (docs/planning/Sun-Shadows.md) — the look/enable readout
        // and the floor's occluder height field. vt/ owns the bake and the
        // texture; it never reaches the mask authority or the registry itself.
        getSunShadowRenderState,
        getCasterHeightField,
        // THE SHADOW CASCADE's floor-elevation seam (2026-08-05) — same
        // real-scene-only reasoning as `getCasterHeightField` just above: the
        // torture fixture has no Foundry Levels to read, and unwired the band
        // heights fall back to the authored `aboveHeightPx` slider and SAY SO
        // in the sun-shadow status report.
        getShadowFloorPlan,
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
        // FIRE'S mask-clip texture seam — same real-scene-only reasoning; an
        // unwired/torture-fixture default of `() => null` leaves every fire
        // unclipped (the fail-open default `bakeFireMaskTexture` already has).
        getFireMaskGrid,
        getSkyReachGrid,
        getCoverAboveGrid,
        getCasterHeightGrid,
        // THE WATER BODY PACK's mask + cross-floor seams (Water.md §5.1) —
        // same real-scene-only reasoning; unwired means no floor has water, so
        // the jump flood never runs (inert by construction, not by a flag).
        getWaterMaskGrid,
        getFloorsWithWater,
        getWaterMaskUrl,
        // THE DEPTH-AUTHORITY MIGRATION's own seam (2026-08-15) — see
        // `getSpecularBackgroundItemId`/`getWindowBackgroundItemId` just below
        // for the identical shape this mirrors.
        getWaterBackgroundItemId,
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
        // STAGE 3 (2026-08-05) — the depth-authority migration's own seam,
        // added alongside `getSpecularMaskRect`/`getSpecularMaskUrl` above
        // for the same reason: unwired, the viewer's own `resolveExpectedDepth`
        // composition has no item id to resolve a rank for and the floor gate
        // compiles out entirely (fails OPEN, not silently broken — see
        // `specular-render.js`'s own `uExpectedDepth` doc).
        getSpecularBackgroundItemId,
        getSpecularRenderState: specular.getRenderState,
        // WINDOW LIGHT's four seams (Windows.md). Same real-scene-only
        // reasoning as SHINE's directly above: unwired, both mask seams
        // return null and the effect renders literally nothing.
        getWindowMaskUrl,
        getWindowMaskRect,
        // The depth-authority migration's own seam (2026-08-05), mirroring
        // `getSpecularBackgroundItemId` above — unwired, the viewer's own
        // `resolveExpectedDepth` composition has no item id to resolve a
        // rank for and the floor gate fails OPEN (see window-render.js's
        // own `uExpectedDepth` doc), not silently broken.
        getWindowBackgroundItemId,
        getWindowRenderState: windowLight.getRenderState,
        // APERTURE GOBO's one seam (docs/planning/Aperture-Gobo.md) — no mask
        // URL/rect pair, unlike SHINE/window just above: its only input is
        // wall geometry `effects/lighting/point-light-pool.js` reads itself.
        getApertureGoboRenderState: apertureGobo.getRenderState,
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
  //
  // EVICTION (added 2026-08-12 — decode-pool.js's `_sourceCache`, which
  // `getSourceBitmap` below pins into, had no caller for its own
  // `releaseSourceBitmap` anywhere in the codebase: every floor of every
  // scene ever visited stayed resident as a full-resolution ImageBitmap
  // — 500MB+ for a 12000² map — for the rest of the session. `canvasInit`
  // fires on EVERY floor switch too, not just a genuine scene change (see
  // this function's own header note + foundry/canvas-lifecycle.js), so
  // eviction cannot key off "registerFloorProxies ran again" — it keys off
  // the scene id actually changing. `urlsToEvictOnSceneChange` (pure,
  // Node-tested) returns [] for a same-scene call, so an ordinary floor
  // switch never evicts anything the still-active viewer might be
  // mid-decode with.
  let lastProxiedSceneId = null;
  let lastProxiedFloorUrls = [];
  async function registerFloorProxies(sceneDoc) {
    const sceneId = sceneDoc?.id ?? null;
    const floorsResult = getActiveSceneFloors(sceneDoc);
    const nextUrls = floorsResult.ok ? floorsResult.floors.map((f) => f.url).filter(Boolean) : [];

    for (const url of urlsToEvictOnSceneChange(lastProxiedSceneId, lastProxiedFloorUrls, sceneId, nextUrls)) {
      releaseSourceBitmap(url);
    }
    lastProxiedSceneId = sceneId;
    lastProxiedFloorUrls = nextUrls;

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
  // lever for exactly this (canvas-compositing.js). Two sub-levers as of
  // 2026-08-13 (see that file's "PRIMARY-CACHE-FREEZE FIX" section):
  // `canvas.primary.sprite.renderable` + `canvas.effects.renderable`. Both
  // false = Foundry's own primary+effects art OUTPUT is suppressed (though
  // primary's internal cache keeps refreshing, deliberately, so Foundry's own
  // fog shader stays fed) and MSA (stacked underneath, verified z-index 0 vs
  // Foundry's own canvas — vt-pan-viewer.js's stackUnderBoard) shows through.
  // Both true = Foundry draws its own art again, on top, occluding MSA. MSA's
  // render loop keeps running in EITHER mode (wasted GPU work while hidden,
  // never a correctness issue — pausing it is a possible follow-up, not
  // needed for A/B comparison).
  //
  // A dropdown, not a plain button (feedback_debug_ui_one_action_one_control:
  // mutually-exclusive modes are a dropdown), reading its value from the SAME
  // live fact the interface-seam report already exposes (the combined
  // `foundryArtRenderable` signal — true only when BOTH sub-levers read
  // true) — one source of truth, not a second one invented for this control.
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
    () => (getCanvasCompositingReport().foundryArtRenderable ? 'foundry' : 'msa'),
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

  /**
   * The SAME flattened, effect-agnostic shape `buildSettingsPanel`'s own
   * `deps` just above already use, reusing the SAME `PROFILE_CHOICE_LIST`/
   * `ENABLE_CHOICE_LIST`/`effectRows` construction so the old panel and the
   * new SYSTEM department/Player room can never disagree about what an
   * effect's row looks like. `ui/rooms/system-panel.js` calls this fresh on
   * every one of ITS OWN internal re-renders (never caches it), so this
   * itself never needs to be memoized either — `effectRegistry.list()` is
   * read fresh here for the identical reason the old panel's own buildFn
   * reads it fresh (a captured list risks missing an effect registered
   * after this point in `install()`).
   * @returns {object} the ctx `ui/rooms/system-panel.js#renderSystemPanel` expects (minus `isGM`).
   */
  function getSystemPanelCtx() {
    return {
      read: (key) => readSetting(MODULE_ID, key),
      write: (key, value) => writeSetting(MODULE_ID, key, value),
      profiles: PROFILE_CHOICE_LIST,
      enableChoices: ENABLE_CHOICE_LIST,
      effectRows: effectRegistry.list().map((m) => ({
        id: m.id,
        title: m.title ?? m.id,
        photosensitive: m.a11y?.photosensitive === true,
        playerKey: effectEnableKey(m.id, 'player'),
        gmKey: effectEnableKey(m.id, 'gm'),
      })),
      keys: {
        msaEnabled: GLOBAL_SETTING_KEYS.msaEnabled,
        profile: GLOBAL_SETTING_KEYS.profile,
        reducePhotosensitive: GLOBAL_SETTING_KEYS.reducePhotosensitive,
        reducedMotion: GLOBAL_SETTING_KEYS.reducedMotion,
        theme: GLOBAL_SETTING_KEYS.theme,
      },
    };
  }

  /**
   * Apply the two U5 a11y settings to the document root — the ONE place
   * `dataset.theme`/`dataset.reduceMotion` ever get set. `ui/tokens.js`'s
   * own injected CSS already has real rules keyed off both attributes
   * (every room's colours key off `[data-theme]`; `[data-reduce-motion="1"]`
   * suppresses transitions) — this function is the missing other half that
   * actually WRITES them, completing what was previously CSS with nothing
   * driving it. Called once at canvasReady and again from the settings
   * adapter's own onChange (below), never polled.
   */
  function applyUiPreferences() {
    document.documentElement.dataset.theme = readSetting(MODULE_ID, GLOBAL_SETTING_KEYS.theme) || 'dark';
    document.documentElement.dataset.reduceMotion =
      readSetting(MODULE_ID, GLOBAL_SETTING_KEYS.reducedMotion) === true ? '1' : '0';
  }

  // A PASSIVE READOUT proving the reader is finding windows rather than silently
  // doing nothing (feedback_instruments_must_not_lie): how many framed windows
  // were detected last frame, how many are actually casting (capped at the
  // shader's slot count), and the current light/tuning. Pure — safe for the
  // flight recorder to run on every export.
  MapShine.debug.registerReport('ui-shadow-status', 'UI window shadows', () => getUiShadow());

  // THE TOKEN-VISION DIAGNOSTIC (2026-08-15) — "why can this token only see a
  // point light?", asked and answered in ONE report instead of a screenshot
  // plus five correlated numbers. Built after the same symptom was reported
  // three times: the revealed area is `vision.light ∩ vision.light.mask`, and
  // an empty mask (token config / game system) is pixel-identical to an
  // inactive global light (MSA's own concern). This names WHICH gate is
  // failing. Control a token first, then run it.
  MapShine.debug.registerReport('token-vision', 'Token vision: why is it dark?', () => readTokenVisionDiagnostic());

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
      // A literal, hand-bumped string — bumped every time this probe's own
      // report shape changes (2026-08-04, light-elevation-occlusion round
      // 11). Exists ONLY so a pasted-back report can PROVE which build
      // produced it, rather than assuming a reload picked up the latest
      // source — removes "is my fix even loaded" as an open question.
      probeBuildTag: 'r15-attr-alpha-test-fix-2026-08-04',
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

  // ==========================================================================
  // THE APERTURE GOBO CHANNEL PROBE (2026-08-03) — `probeSpecularChannelsAt`'s
  // own pattern, adapted. Built after seven live rounds each found a real,
  // fixed, verified bug and STILL produced a scene reading as completely
  // unaffected, and — after bloom, the OTHER window-light effect, and a
  // stale build/cache were each raised and each independently ruled out by
  // the author — the author said directly: "stop assuming this isn't a code
  // bug... enhance the reporting, upgrade the pixel probe." THIS is that:
  // one click-3-points action, `illum` as the PRIMARY buffer (this effect
  // draws into `buf:scene.illum` directly — unlike specular's post-composite
  // `scene.lit` pass), `lit` carried alongside as a secondary check on
  // whatever happens between illum and the pixel the author's eye actually
  // sees (albedo multiply, bloom, grade). Down to TWO channels (`off`/
  // `pattern`) as of round 10 (2026-08-04) — `visibility`/`gate-inputs`
  // retired alongside the separate visibility-gate pass they used to read;
  // see `APERTURE_GOBO_CHANNEL_PROBE_IDS`'s own comment below.
  // ==========================================================================

  // RETIRED (round 10, 2026-08-04): 'visibility'/'gate-inputs' both read the
  // separate visibility-gate pass that no longer exists — the gobo pattern
  // is now baked directly into the light's own MAX-blended illumination/
  // coloration materials (point-light-illumination.js's own "THE GOBO IS
  // PART OF THIS LIGHT'S OWN FALLOFF" header). Probing either of those ids
  // now would silently read whatever 'off' already shows (point-light-
  // pool.js's own debug mesh only distinguishes 'pattern' from everything
  // else) — exactly the "instrument reads something, but not what its own
  // label claims" trap this project treats as a real bug, not a shrug.
  // Removed rather than left in place reading stale data.
  const APERTURE_GOBO_CHANNEL_PROBE_IDS = ['off', 'pattern'];

  /** Push an aperture-gobo debug channel and wait for it to actually be on
   * screen — same 2-rAF margin as `waitForSpecularChannelToRender`, for the
   * same reason (the registration's own channel is read fresh every frame
   * by `point-light-pool.js#update`, no reapply needed, but the probe must
   * not fire mid-frame against the change).
   * @param {'off'|'pattern'} id @returns {Promise<void>} */
  async function waitForApertureGoboChannelToRender(id) {
    apertureGobo.setDebugChannel(id);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  /** Rec.709 luma of a decoded `[r,g,b,a]` readback. @param {number[]|null} rgba @returns {number|null} */
  function apertureGoboProbeLuma(rgba) {
    if (!rgba) return null;
    return +(rgba[0] * 0.2126 + rgba[1] * 0.7152 + rgba[2] * 0.0722).toFixed(4);
  }

  /**
   * @param {Array<{worldX:number, worldY:number}>} points
   * @returns {Promise<object>}
   */
  async function probeApertureGoboChannelsAt(points) {
    const list = (Array.isArray(points) ? points : []).slice(0, 3).map((p) => ({ x: p.worldX, y: p.worldY }));
    const restoreTo = apertureGobo.getDebugChannel();
    /** @type {Record<string, Array<object>>} */
    const byChannel = {};
    try {
      for (const id of APERTURE_GOBO_CHANNEL_PROBE_IDS) {
        await waitForApertureGoboChannelToRender(id);
        const readback = await MapShine.probePixels(list);
        byChannel[id] = readback.map((p) => ({
          index: p.index,
          worldX: p.worldX,
          worldY: p.worldY,
          onScreen: p.onScreen,
          // Same falsifiability discipline `probeSpecularChannelsAt` uses:
          // the device pixel actually read, and a control buffer this pass
          // never writes (`albedo`), so "every channel reads identical" can
          // be told apart from "the probe sampled one texel three times".
          pixel: p.pixel ?? null,
          controlAlbedo: p.buffers?.albedo?.rgba ?? null,
          illum: p.buffers?.illum?.rgba ?? null,
          lit: p.buffers?.lit?.rgba ?? null,
          illumLuma: apertureGoboProbeLuma(p.buffers?.illum?.rgba ?? null),
          litLuma: apertureGoboProbeLuma(p.buffers?.lit?.rgba ?? null),
        }));
      }
    } finally {
      // ALWAYS restored, success or throw.
      await waitForApertureGoboChannelToRender(restoreTo);
    }

    // Re-shape channel-outer → point-outer: an author reading "point 2 (the
    // mullion)" wants every channel's reading for THAT point together.
    const byPoint = list.map((_, i) => {
      const index = i + 1;
      /** @type {Record<string, {illum:number[]|null, lit:number[]|null, illumLuma:number|null, litLuma:number|null}>} */
      const channels = {};
      for (const id of APERTURE_GOBO_CHANNEL_PROBE_IDS) {
        const hit = byChannel[id]?.find((p) => p.index === index);
        if (hit) channels[id] = { illum: hit.illum, lit: hit.lit, illumLuma: hit.illumLuma, litLuma: hit.litLuma };
      }
      const worldPoint = byChannel[APERTURE_GOBO_CHANNEL_PROBE_IDS[0]]?.find((p) => p.index === index);
      const patternDark = (channels.pattern?.illumLuma ?? 1) < 0.05;
      return {
        index,
        worldX: worldPoint?.worldX ?? null,
        worldY: worldPoint?.worldY ?? null,
        onScreen: worldPoint?.onScreen ?? null,
        pixel: worldPoint?.pixel ?? null,
        controlAlbedo: worldPoint?.controlAlbedo ?? null,
        channels,
        // FACTUAL FLAGS ONLY, never a verdict on `off` itself — mirrors
        // specular's own posture. `shadowShouldBeFullyDark` is the
        // load-bearing one, SIMPLER as of round 10 than it used to be: the
        // gobo pattern now MAX-blends as part of the light's own single
        // draw, so "the pattern says fully blocked" is the WHOLE condition
        // for "this fragment should fall back to ambient/whatever else is
        // already there" — there is no separate gate to also check. If this
        // flag is true and `off`'s own illum reading is still bright well
        // above the surrounding ambient, that is direct, numeric proof of a
        // real bug (the pattern isn't reaching this light's own MAX-blend
        // draw), not a two-mechanism ambiguity to disentangle first.
        flags: { patternReachesDark: patternDark, shadowShouldBeFullyDark: patternDark },
      };
    });

    const distinctPixels = new Set(byPoint.map((p) => (p.pixel ? `${p.pixel.x},${p.pixel.y}` : 'none')));
    const distinctAlbedo = new Set(byPoint.map((p) => JSON.stringify(p.controlAlbedo)));
    return {
      report: 'aperture-gobo-channel-probe',
      generatedAt: new Date().toISOString(),
      sanity: {
        pointsProbed: byPoint.length,
        distinctPixelsRead: distinctPixels.size,
        distinctControlAlbedo: distinctAlbedo.size,
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

  // Designed for exactly the protocol this whole family of probes uses:
  // click one point OVER an open pane, one OVER a mullion/frame, one further
  // out for a baseline — same click-3-points flow every other probe here
  // uses.
  MapShine.debug.registerAction(
    'aperture-gobo-channel-probe',
    '🪟🔍 Window Pattern Channel Probe (click 3 pts)',
    async () => {
      const points = await MapShine.armPixelProbe(3);
      if (!points.length)
        return { report: 'aperture-gobo-channel-probe', generatedAt: new Date().toISOString(), points: [] };
      return probeApertureGoboChannelsAt(points);
    },
    { effect: 'apertureGobo' }
  );

  // ==========================================================================
  // THE WATER HEALTH REPORT (2026-08-17) — "a report button for water which
  // outputs absolutely anything and everything to do with foam health and
  // water health in general," asked for directly after a live round where a
  // tier-gate theory was delivered with confidence and turned out to rest on
  // an unchecked premise ("I was at extreme quality the entire time"). The
  // fix for a session that keeps guessing is an instrument that measures.
  //
  // `probeSpecularChannelsAt`'s pattern (this file, above), adapted from
  // "3 CLICKED points" to an AUTOMATIC GRID across the viewed floor's own
  // water bounds — the author asked for coverage "in general", not "click
  // where you think it's broken". `buildWaterHealthReport` (effect-status-
  // reports.js) supplies the static half (cascade, tier ladder, per-floor
  // bake/mask status); this adds the one thing a pure builder cannot be: a
  // real GPU pixel readback, in the SAME mean/max/coverage vocabulary
  // `tools/shader-lab/bench-water.js#gateLadder` already uses for the
  // synthetic bench, so a live number here is directly comparable to a bench
  // number — which is exactly the comparison this whole session was missing.
  // ==========================================================================

  /** The channels worth sweeping — presence/foam terms only, each genuinely
   * "0 = absent, brighter = more present" (unlike `turbidity`/`causticExcess`,
   * which are bias-remapped around a 0.5 NEUTRAL and would make a "> 0.02"
   * coverage test meaningless). Walks tier order so a reader can still apply
   * "the first one that drops to zero coverage names the culprit rung". */
  const WATER_HEALTH_SWEEP_CHANNELS = ['mask', 'inside', 'depth01', 'foamCrest', 'breakFoam', 'foamTail', 'totalFoam'];
  /** Mirrors `water-field.js#WATER_FOAM_SHORE_PX` (140) — crest/break/tail
   * foam are ALL gated to within this many world-px of a shore, never a
   * general open-water effect. Not imported (boot.js reaches the water zone
   * through the effects barrel, and this one constant is not on it) —
   * duplicated on purpose, exactly like the debug-channel catalog's own
   * `reads` prose duplicates shader knowledge for report purposes. If it
   * drifts, the failure mode is a sub-optimally-dense grid, not a wrong one.
   * @type {number} */
  const WATER_HEALTH_FOAM_REACH_PX = 140;
  /** ⚠️ FIRST LIVE RUN, SECOND BUG (2026-08-17): a fixed 5×5 grid over a
   * SMALL on-screen slice (the common case once the view-rect fix above
   * landed) spaced its points ~160px apart — wider than the 140px band every
   * foam term is gated to, so it could stride clean over the entire band and
   * report a confident, wrong "zero everywhere" that was actually "missed
   * the strip". Grid density is now ADAPTIVE: enough rows/cols that the
   * SHORTER swept dimension gets samples roughly `WATER_HEALTH_FOAM_REACH_PX
   * / 3` apart (≥3 samples across any foam band the sweep crosses at all),
   * floored at 5 (this file's original minimum) and capped at 10 (100
   * points × 7 channels — a real cost, accepted the same way
   * `runAllTiersPerfReport` accepts minutes for a report the author is
   * already waiting on) so a huge on-screen span cannot make one run
   * unbounded. @param {{minX:number,minY:number,maxX:number,maxY:number}} rect
   * @returns {number} */
  function waterHealthGridSizeFor(rect) {
    const shortSpan = Math.min(rect.maxX - rect.minX, rect.maxY - rect.minY);
    const bySpacing = Math.ceil(shortSpan / (WATER_HEALTH_FOAM_REACH_PX / 3));
    return Math.max(5, Math.min(10, bySpacing));
  }

  /** An evenly spaced grid strictly INSIDE `bounds` — never on the edge, where
   * antialiasing/rounding could sample a texel just outside the body and read
   * a false zero. @param {{minX:number,minY:number,maxX:number,maxY:number}} bounds
   * @param {number} n @returns {Array<{x:number,y:number}>} */
  function buildWaterHealthGrid(bounds, n) {
    const pts = [];
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const fx = (col + 0.5) / n;
        const fy = (row + 0.5) / n;
        pts.push({
          x: bounds.minX + fx * (bounds.maxX - bounds.minX),
          y: bounds.minY + fy * (bounds.maxY - bounds.minY),
        });
      }
    }
    return pts;
  }

  /** `waitForSpecularChannelToRender`'s own pattern, aimed at water's selector
   * instead — see that function's header for why two rAF ticks. @param {number} n */
  async function waitForWaterChannelToRender(n) {
    water.setDebugChannel(n);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  /**
   * Run the full sweep and merge it onto `buildWaterHealthReport`'s static
   * half. ALWAYS restores the debug channel in a `finally`, even on a mid-
   * sweep throw — a diagnostic left stuck on is a second bug wearing the
   * first one's clothes (`probeSpecularChannelsAt`'s own rule, unchanged).
   * @returns {Promise<object>}
   */
  async function probeWaterFoamHealth() {
    const generatedAt = new Date().toISOString();
    const floorIndex = activeFloorContext?.floorIndex ?? 0;
    const viewer = getVtPanViewerDiagnostics?.() ?? null;
    const base = buildWaterHealthReport({
      floorIndex,
      viewer,
      maskAuthority,
      readout: water.getReadout(),
      tiers: WATER.tiers,
      debugChannels: WATER_DEBUG_CHANNELS,
      generatedAt,
    });

    if (!viewer) {
      return { ...base, coverage: { swept: false, reason: 'viewer not started' } };
    }
    const currentFloor = Array.isArray(viewer?.waterBody)
      ? viewer.waterBody.find((f) => f.floorIndex === floorIndex)
      : null;
    const bounds = currentFloor?.surface?.bounds ?? null;
    if (!bounds) {
      return {
        ...base,
        coverage: {
          swept: false,
          reason:
            'this floor has no water bounds to sweep — no authored water mask resolved here ' +
            '(see `floors[].resolve.reason` above for why, and `authoredWaterFloors` for which floors have one at all)',
        },
      };
    }

    // ⚠️ THE BUG ITS OWN FIRST LIVE RUN SHIPPED (2026-08-17): a grid spread
    // over the water body's FULL world AABB, unconditionally — on any body
    // wider than the current camera (this is the common case, not the
    // exception, on a real map), every point falls off-screen and the whole
    // sweep reports `pointsOnScreen: 0` on every channel. Honest (coveragePct
    // came back `null`, not a fabricated zero) but useless. Fixed by
    // intersecting the body's bounds against `viewer.viewWorldRect` — the
    // SAME rect the renderer itself is using this frame — before laying out
    // the grid, so every point this generates is provably on screen.
    const view = viewer?.viewWorldRect ?? null;
    const sweepRect = view
      ? {
          minX: Math.max(bounds.minX, view.minX),
          minY: Math.max(bounds.minY, view.minY),
          maxX: Math.min(bounds.maxX, view.maxX),
          maxY: Math.min(bounds.maxY, view.maxY),
        }
      : bounds;
    if (!view || sweepRect.minX >= sweepRect.maxX || sweepRect.minY >= sweepRect.maxY) {
      return {
        ...base,
        coverage: {
          swept: false,
          reason: view
            ? 'the camera is not currently looking at this floor`s water body at all (its world bounds and the ' +
              'current view rect do not overlap) — pan/zoom onto the water and re-run'
            : 'no current view rect available (viewer not rendering a frame yet) — cannot know what is on screen',
          bounds,
          viewWorldRect: view,
        },
      };
    }

    const gridSize = waterHealthGridSizeFor(sweepRect);
    const points = buildWaterHealthGrid(sweepRect, gridSize);
    const restoreTo = water.getDebugChannel();
    /** @type {Record<string, object>} */
    const byChannel = {};
    let offScreenCount = 0;
    showPerfProgress(formatPerfProgressText('water health sweep', `0/${WATER_HEALTH_SWEEP_CHANNELS.length} channels`));
    try {
      let done = 0;
      for (const id of WATER_HEALTH_SWEEP_CHANNELS) {
        const channel = WATER_DEBUG_CHANNELS.find((c) => c.id === id);
        // A renumbered channel list should never silently drop an id from the
        // sweep — mirrors `probeSpecularChannelsAt`'s own guard.
        if (!channel) continue;
        await waitForWaterChannelToRender(channel.n);
        const readback = await MapShine.probePixels(points);
        const onScreenReads = readback.filter((p) => p.onScreen && p.buffers?.lit?.rgba);
        offScreenCount = Math.max(offScreenCount, points.length - onScreenReads.length);
        // Reuses `specularProbeLuma` (Rec.709 luma of a decoded rgba) rather
        // than a second copy of the same one-line formula — this project's
        // own rule for a shared pure helper (see `water-registration.js`'s
        // `hexToRgb01` reuse for the identical reasoning).
        const lumas = onScreenReads.map((p) => specularProbeLuma(p.buffers.lit.rgba));
        // A CONTROL this pass cannot touch (mirrors `probeSpecularChannelsAt`):
        // if EVERY point reads the same albedo, the readback — not the shader
        // — is what to distrust below.
        const distinctControlAlbedo = new Set(onScreenReads.map((p) => JSON.stringify(p.buffers?.albedo?.rgba ?? null)))
          .size;
        byChannel[id] = {
          n: channel.n,
          pointsRequested: points.length,
          pointsOnScreen: onScreenReads.length,
          meanLuma: lumas.length ? +(lumas.reduce((a, b) => a + b, 0) / lumas.length).toFixed(4) : null,
          maxLuma: lumas.length ? +Math.max(...lumas).toFixed(4) : null,
          // Fraction of ON-SCREEN samples reading meaningfully non-zero — the
          // SAME vocabulary `bench-water.js#gateLadder` reports for the
          // synthetic fixture, so this live number is comparable to it term
          // for term instead of needing its own separate reading.
          coveragePct: lumas.length ? +((lumas.filter((v) => v > 0.02).length / lumas.length) * 100).toFixed(1) : null,
          distinctControlAlbedo,
        };
        done += 1;
        showPerfProgress(
          formatPerfProgressText('water health sweep', `${done}/${WATER_HEALTH_SWEEP_CHANNELS.length} channels (${id})`)
        );
      }
    } finally {
      await waitForWaterChannelToRender(restoreTo);
      hidePerfProgress();
    }

    return {
      ...base,
      coverage: {
        swept: true,
        gridSize: `${gridSize}×${gridSize}`,
        // `sweptRect` is what the grid actually covers (camera view ∩ body
        // bounds); `bodyBounds` is the WHOLE body, for scale — if they are far
        // apart in size, this sweep saw only a fraction of the water and a
        // "no foam" verdict here does not speak for the rest of it.
        sweptRect: sweepRect,
        bodyBounds: bounds,
        // Loud rather than a silently partial sweep
        // (`feedback_publish_what_the_instrument_cannot_see`): a body bigger
        // than the current viewport only gets measured where it is ON SCREEN.
        note:
          offScreenCount > 0
            ? `${offScreenCount}/${points.length} grid points fell off-screen and were NOT measured — zoom/pan so ` +
              'the whole body is visible and re-run for full coverage.'
            : `all ${points.length} grid points were on-screen for every channel. sweptRect covers ` +
              `${((((sweepRect.maxX - sweepRect.minX) * (sweepRect.maxY - sweepRect.minY)) / ((bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY) || 1)) * 100).toFixed(1)}% ` +
              `of the full water body's area — re-run at different zoom/pan to sample the rest.`,
        channels: byChannel,
      },
      interpretation:
        base.interpretation +
        ' ⚠️ THE COVERAGE SWEEP (real GPU pixel readback, not a guess): read `coverage.channels.totalFoam.coveragePct` ' +
        'FIRST — that is the one number the shipped composite actually draws, a measured percentage of the grid ' +
        'reading visibly non-zero foam. Non-zero `mask`/`inside` coverage with zero `totalFoam` coverage means water ' +
        'IS drawing but the foam terms specifically are dying downstream — compare `foamCrest` (tier 2, always on) ' +
        'against `breakFoam`/`foamTail` (tier 4) to see which rung stopped contributing, same as ' +
        "`bench-water.js`'s own CHAIN classification. Zero coverage on EVERY channel including `mask` means nothing " +
        'is drawing here at all — that points back at `floors`/`authoredWaterFloors` above, not at the shader. A ' +
        '`distinctControlAlbedo` of 1 on a multi-point sweep means the probe itself is suspect (reading one stale ' +
        'texel repeatedly) — mistrust the numbers above it before mistrusting the shader.',
    };
  }

  MapShine.debug.registerAction(
    'water-health',
    '🌊🩺 Water Health Report (foam + everything)',
    () => probeWaterFoamHealth(),
    { effect: 'water' }
  );
  // Console-callable too (mirrors probePixels/probeWindAndParticles) — the
  // debug-panel button is the primary path, this is the fast ad-hoc one.
  MapShine.getWaterHealthReport = probeWaterFoamHealth;

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
        // THE FADE ENGINE'S OWN SCENE LOAD (U2 checkpoint 3) — fade state is
        // scene-scoped exactly like the sky, so a scene SWITCH must re-load
        // it here too, not carry the previous scene's in-flight fades into
        // this one. Baseline's own snapshot is captured fresh every load,
        // AFTER resolveAndApplySky above has settled skyScope to what this
        // scene actually authored — "the resting look" this scene ships
        // with, not whatever the last scene happened to leave in memory.
        try {
          const { state, reason } = readFadeState();
          fadeState = state;
          if (reason) log.info(`fade state (canvasReady): ${reason}`); // "no active scene" etc. — benign, not an error
          pendingArchetypeCompletions.clear();
          baselineWeatherSnapshot = {
            cloudCover01: skyScope.sky?.cloudCover01 ?? 0,
            precip01: skyScope.sky?.precip01 ?? 0,
          };
        } catch (err) {
          log.error('fade state (canvasReady) failed:', err);
        }
        fadeUnsub?.();
        fadeUnsub = watchFadeState(() => {
          const { state } = readFadeState();
          fadeState = state;
          MapShine.__remote?.refreshWeatherBoard();
        });
        // THE CUE STACK'S OWN SCENE LOAD (U3) — scene-scoped exactly like the
        // fade state above; a sold map's authored cues travel WITH its scene,
        // so a scene SWITCH must re-load this scene's own stack, never carry
        // the previous scene's cues forward.
        try {
          const { cues, reason } = readCueStack();
          cueStack = cues;
          if (reason) log.info(`cue stack (canvasReady): ${reason}`); // "no active scene" etc. — benign
        } catch (err) {
          log.error('cue stack (canvasReady) failed:', err);
        }
        MapShine.__remote?.refreshCueDeck();
        cuesUnsub?.();
        cuesUnsub = watchCueStack(() => {
          const { cues } = readCueStack();
          cueStack = cues;
          MapShine.__remote?.refreshCueDeck();
        });
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
          // A floor switch. No curtain is raised for it and none is lifted —
          // beginSceneLoad already declined, so there is nothing here to undo.
          // "Floor changes without loading screens" is this branch existing.
          //
          // PREPARE, THEN COMMIT (2026-08-15). The old floor stays fully drawn
          // — nothing below this comment and above the commit block touches
          // `activeFloorContext`, doors, or `view.floorIndex` — while
          // `prepareVtPanViewerFloor` loads and BC-compresses the target
          // floor's art. See `prepareFloor`'s own doc (vt-pan-viewer.js) for
          // why front-loading this is what stops a half-built upper floor
          // ever being visible: it is not a new visibility gate, it is making
          // sure the EXISTING hide/show pass has nothing left to wait for by
          // the time it runs.
          //
          // No curtain, no deadline, no escalation — the author's explicit
          // call (this session): however long a cold floor takes, the OLD
          // floor is what stays on screen. `ui/floor-transition.js`'s own
          // Cancel button is the only way out (`cancelVtPanViewerFloorPrepare`
          // — an in-progress `canvasReady` firing a second time for a
          // DIFFERENT floor already invalidates the first prepare the same
          // way, since `prepareFloor`'s generation counter bumps on every
          // call regardless of who's calling).
          //
          // `fromFloorIndex` is `activeFloorContext?.floorIndex` READ HERE,
          // BEFORE anything below moves it — by the time this hook fires,
          // Foundry's OWN `canvas.level` has already moved to the target
          // floor (confirmed by reading `Scene#view`/`canvas.draw` — this is
          // WHY the held-floor's placeables can look mismatched during a slow
          // prepare, a known, not-yet-built follow-up), so `activeFloorContext`
          // is the only thing in this file still honestly pointing at the
          // floor still on screen.
          beginFloorTransition({
            fromFloorIndex: activeFloorContext?.floorIndex ?? null,
            toFloorIndex: targetFloorIndex,
            onCancel: cancelVtPanViewerFloorPrepare,
          });
          const prepared = await prepareVtPanViewerFloor(targetFloorIndex, (p) => {
            log.debug?.(`floor ${targetFloorIndex} prepare: ${p.phase} ${p.done}/${p.total}`);
            // Read from THE READINESS SIGNAL (MapShine.getSceneReady, task 3),
            // not from `p` — `p` is prepareFloor's own coarse phase/count, but
            // `waitingFor` is the SAME named-blocker list the cold-load curtain
            // shows, already human-labelled ("textures still being
            // GPU-compressed (3)") by vt/settle.js. Reusing it here means this
            // overlay never invents its own second vocabulary for the same
            // facts.
            updateFloorTransitionProgress(MapShine.getSceneReady?.().waitingFor ?? []);
          });
          endFloorTransition(); // always — success, failure, or cancel all end here the same way
          if (!prepared.ok) {
            // Superseded by a newer floor-switch request (a rapid second
            // `canvasReady`), or cancelled via the overlay's own button — the
            // newer request (or the author's own choice to stay put) owns
            // this outcome, so this firing simply stops here. The old floor
            // is untouched; there is nothing to undo.
            log.info(`floor ${targetFloorIndex} prepare did not complete (${prepared.reason}) — leaving floor as-is.`);
            return;
          }

          // COMMIT — everything floor N needs is already GPU-resident, so
          // every step below is fast and, per prepareFloor's own analysis, the
          // hide/show swap lands within one synchronous pass with nothing left
          // to await. `activeFloorContext` and `view.floorIndex` move together
          // here, in this order, with no `await` between them — moving
          // `activeFloorContext` any earlier (the ordering this branch used
          // BEFORE this fix) would re-point every per-frame anchor
          // filter (fire/candle/lightning) and door scoping at floor N while
          // floor M's art was still what the user was looking at, for however
          // long prepare took — invisible today only because there was no
          // prepare step to expose the gap.
          updateActiveFloorContext(floorsResult.floors, targetFloorIndex);
          refreshDoors();
          const result = await setVtPanViewerFloor(targetFloorIndex);
          // EFFECT_REAPPLIERS NEVER RAN ON A FLOOR SWITCH BEFORE THIS (its own
          // four triggers were 'ready' / 'scene load' / 'settings change' /
          // 'perf tier report restore') — per-floor correctness rested
          // entirely on each effect's own per-frame memo re-reading
          // `activeFloorContext` by closure. Added here rather than left as a
          // gap: a floor switch is exactly the kind of state change this list
          // exists to react to, and every entry already tolerates being
          // called with nothing to do (reapplyAll's own try/catch-per-entry).
          reapplyAll('floor switch');
          log.info(`real-scene VT viewer synced to floor ${targetFloorIndex} (same scene).`, result);
          syncInterfaceSeam('floor switch');

          // CONTINUOUS PREWARM, RE-SCOPED TO THE NEW FLOOR (2026-08-15). The
          // startup-only ±1 prewarm loop (see startVtPanViewer's own comment)
          // is keyed to whichever floor was active at BOOT — after 0→1, floor
          // 2 was never prewarmed and stayed cold forever. Re-running it here,
          // now scoped to the floor we just committed to, is what keeps
          // "switch to an adjacent floor" fast on the SECOND hop too, not just
          // the first. Fire-and-forget, same posture as the original: a
          // background prewarm succeeding or failing must never affect this
          // (already-completed) switch.
          prewarmVtPanViewerAdjacentFloors(targetFloorIndex).catch((err) =>
            log.warn(`adjacent-floor prewarm from floor ${targetFloorIndex} failed:`, err)
          );
          return;
        }

        // `lastRealSceneId` is NOT set until `startRealSceneViewer` actually
        // succeeds below (2026-08-12 fix) — it used to be set HERE,
        // synchronously, before the `await`. `canvasReady` is a plain
        // `Hooks.on` callback: Foundry does not await it, so a second
        // `canvasReady` firing while this one is still mid-boot (a known
        // quirk on initial load, and whenever another module redraws the
        // canvas) ran with `lastRealSceneId` already pointing at THIS scene
        // while `getVtPanViewerDiagnostics().active` was still false (`
        // _active` is only assigned near the very end of `startVtPanViewer`,
        // after every await — mask-dimension fetches, `ensureItemLoaded`,
        // `scheduleResidencyUpdate`, `renderer.compileAsync` — has already
        // resolved). That combination fails the same-scene branch's `&&
        // active` check, so the second execution fell through to here and
        // called `startRealSceneViewer` a SECOND time concurrently with the
        // first — two overlapping boots racing to allocate/assign the same
        // module-level `_active`, canvas and GPU resources. Gating the
        // assignment on success closes the window: a concurrent second
        // firing now finds `lastRealSceneId` still `null`-or-stale and takes
        // this same "full boot" path too, which is redundant but no longer a
        // race — `startVtPanViewer`'s own resource setup is what would need
        // re-entrancy protection to make even THAT free, a separate, larger
        // change this fix does not attempt.
        /**
         * Hold until the scene is genuinely ready, publishing what it is
         * waiting for as it goes.
         *
         * POLLED, NOT EVENT-DRIVEN, deliberately: the settle sample is taken
         * inside the render loop on its own frame cadence (`time/one-clock` —
         * the loop owns the clock), so there is no event to subscribe to and
         * inventing one would mean a second clock reading outside the loop.
         * 250ms matches `perf-session.js`'s own settle waiter rather than
         * declaring a second interval that means the same thing.
         *
         * Always terminates: `shouldStopWaitingForReady` returns true on the
         * deadline, on the "Show me anyway" button, and immediately when no
         * curtain is up at all.
         */
        async function waitForSceneReady() {
          for (;;) {
            const settle = getVtPanViewerSceneSettle();
            if (settle?.settled === true) return { ready: true, reason: 'settled' };
            // No viewer means nothing to wait FOR — waiting would be a hang with
            // a friendly face. This is unreachable on the path below (we only
            // get here after startRealSceneViewer succeeded) but it is the kind
            // of precondition that stops being true when someone adds a caller.
            if (settle?.skipped) return { ready: false, reason: settle.reason ?? 'viewer not running' };
            const stop = shouldStopWaitingForReady();
            if (stop.stop) return { ready: false, reason: stop.reason, waitingFor: settle?.waitingFor ?? [] };
            reportSceneLoadBlockers(settle?.waitingFor ?? []);
            await new Promise((r) => setTimeout(r, READY_POLL_MS));
          }
        }

        const result = await startRealSceneViewer(targetFloorIndex);
        if (result.ok === false) {
          log.warn(`real-scene VT viewer did not start:`, result.error);
          endSceneLoad({ error: result.error });
          return;
        }
        lastRealSceneId = sceneDoc.id;
        log.info(`real-scene VT viewer active for "${result.sceneName}" at floor ${targetFloorIndex}.`);
        // THE BRUSH→RENDER BRIDGE'S OWN SCENE-LOAD RE-INGEST — deliberately
        // HERE, not inside `hydrateFromScene()` itself (called far above, at
        // the top of this same hook): `startRealSceneViewer` just above is
        // what calls `maskAuthority.reset()` for THIS scene, which wipes
        // `paintedIngests` wholesale. Re-ingesting only now, after reset has
        // definitely already run, is what keeps a previously-saved painted
        // mask visible after a reload instead of silently discarding it the
        // instant reset() ran (see ui/paint-mode.js#hydrateFromScene's own
        // doc for the ordering hazard this avoids).
        ingestPaintedLayers(MapShine.__painter?.getLayers?.());

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

        // ── THE WARM-UP HOLD (2026-08-15) ───────────────────────────────────
        // A painted first frame is where this used to stop, and it was the
        // wrong finish line. Author: *"the loading screen goes away and then
        // it's a good long time — 10 to 20 seconds — before the scene has
        // settled and FPS is safe for playing."* Everything in that gap was
        // real work nobody was waiting for: pipelines compiling lazily on first
        // draw, effects doing their first bake, adjacent-floor art still
        // compressing.
        //
        // So the curtain now stays up through it, and `vt/settle.js` decides
        // when it comes down: no outstanding work, held quiet, frames actually
        // advancing, no new pipeline compiled and no frame over the hitch
        // threshold inside that window. The blockers are published to the
        // curtain every poll, so a load that will not finish says WHICH stage
        // is stuck instead of spinning.
        //
        // Bounded three ways, because a curtain that never lifts is worse than
        // a slow scene: the hard deadline, the "Show me anyway" button, and
        // `shouldStopWaitingForReady` returning true outright when no curtain
        // is up at all (a floor switch must never be made to block here — it
        // has its own hold, with its own UI).
        beginSceneLoadPhase(LOAD_PHASES.WARMING);
        const readyOutcome = await waitForSceneReady();
        const summary = endSceneLoad({ forced: !readyOutcome.ready });
        if (summary) {
          // worstStallMs is surfaced, not swallowed: a load that completes but
          // froze the main thread for seconds is a bug with a receipt. Same for
          // a forced reveal — it is not a successful load and must not read as
          // one in the log any more than it does in the summary.
          log.info(
            `scene load ${summary.forcedReveal ? 'REVEALED UNFINISHED' : 'complete'} in ${summary.totalMs}ms` +
              (summary.worstStallMs > 0 ? ` (worst main-thread stall: ${summary.worstStallMs}ms)` : '') +
              (summary.forcedReveal ? ` — still waiting on: ${summary.unfinished.join(', ') || 'unknown'}` : ''),
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
            // U5's own two a11y settings (theme/reduced-motion) aren't an
            // EFFECT_REAPPLIERS entry — they drive the UI chrome, not the
            // rendered map — so they get their own explicit re-apply here
            // rather than silently riding along inside reapplyAll.
            applyUiPreferences();
            MapShine.__player?.refresh();
          },
        });
        // Apply once immediately too — `init` runs before any settings
        // CHANGE could ever fire, so without this the theme/reduce-motion
        // data attributes would stay at their bare HTML default (unset)
        // until the first edit, ignoring whatever a returning player last
        // chose.
        applyUiPreferences();
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

      // THE ALMANAC (docs/holy/Almanac-Testament.md, stage A1) — installs the
      // active calendar into CONFIG.time so game.time.components is calendar-
      // aware for MSA and every other module in the world alike. Same "same
      // init hook, own try/catch" placement as the two blocks above — a second
      // `Hooks.once('init', ...)` here would be a NEW `foundry/adapter-only`
      // ratchet violation (see this file's own comment on that a few lines up).
      // CONFIG.time.worldCalendarConfig/Class is what GameTime's OWN
      // constructor reads when IT builds itself (inside Foundry's `setup`,
      // after this `init` hook has run) — installActiveCalendar does NOT call
      // game.time.initializeCalendar() itself at this point (game.time does
      // not exist yet); it only sets CONFIG.time here.
      try {
        registerCalendarSetting(MODULE_ID, CALENDAR_IDS, {
          onChange: () => installActiveCalendar({ calendars: CALENDARS, moduleId: MODULE_ID }),
        });
        installActiveCalendar({ calendars: CALENDARS, moduleId: MODULE_ID });
      } catch (err) {
        log.error('calendar installation failed:', err);
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

      // THE ANCHOR VIEW TOGGLE (author request, 2026-08-06) — the second,
      // GM-only tool just below the button above (foundry/scene-controls-
      // button.js#registerAnchorViewModeButton). `enterAnchorViewMode` is
      // defined earlier in this same function, alongside the candle/lightning
      // Workshop panels it lists.
      registerAnchorViewModeButton({
        isActive: () => MapShine.__anchorViewMode.isActive(),
        onToggle: (active) => {
          if (active) enterAnchorViewMode();
          else MapShine.__anchorViewMode.exit();
        },
      });

      // THE STUDIO TOGGLE (U1) — the third tool, side-by-side rollout: opens
      // the new Studio next to the old panel, changes nothing about either
      // existing button (foundry/scene-controls-button.js#registerStudioButton).
      registerStudioButton({
        isActive: () => MapShine.__studio?.isOpen() ?? false,
        onToggle: (active) => {
          if (active) MapShine.__studio?.open();
          else MapShine.__studio?.close();
        },
      });
      MapShine.__studio?.onOpenChange((open) => syncStudioButtonState(open));

      // THE REMOTE TOGGLE (U2) — the fourth tool, side-by-side rollout: opens
      // the new Remote next to the panel/Studio, changes nothing about any
      // existing button (foundry/scene-controls-button.js#registerRemoteButton).
      registerRemoteButton({
        isActive: () => MapShine.__remote?.isOpen() ?? false,
        onToggle: (active) => {
          if (active) MapShine.__remote?.open();
          else MapShine.__remote?.close();
        },
      });
      MapShine.__remote?.onOpenChange((open) => syncRemoteButtonState(open));

      // THE PLAYER TOGGLE (U5) — the fifth tool, visible:true unlike the
      // three GM-only ones above (foundry/scene-controls-button.js#
      // registerPlayerButton's own doc explains why this one differs).
      registerPlayerButton({
        isActive: () => MapShine.__player?.isOpen() ?? false,
        onToggle: (active) => {
          if (active) MapShine.__player?.open();
          else MapShine.__player?.close();
        },
      });
      MapShine.__player?.onOpenChange((open) => syncPlayerButtonState(open));
    });
    Hooks.once('ready', () => {
      // A `ready`-time safety net for the calendar install above: by `ready`,
      // game.time definitely exists AND every other module's `init` (pf2e's
      // included) has definitely already registered its own settings — an
      // ordering guarantee this file cannot make about MSA's OWN `init` firing
      // relative to pf2e's. Idempotent: if the `init`-time install already
      // read pf2e's settings successfully, this repeats the identical result.
      try {
        installActiveCalendar({ calendars: CALENDARS, moduleId: MODULE_ID });
      } catch (err) {
        log.error('calendar installation (ready-time re-check) failed:', err);
      }
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
  // NOW — this is the exact moment foundryArtRenderable can flip. Without
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

    // THE HUD used to live here as its own floating strip — FPS leading, a
    // "More" door for the rest (author, 2026-07-20: "I want access to FPS
    // information" / "lots of information... in a panel"). Folded into the
    // control panel itself 2026-08-05 (author: it belongs "inside the main
    // panel, at the top"; see diag/perf-strip.js, mounted by
    // diag/debug-panel.js's `attachPanel`). This function's job now is just to
    // gather the raw facts — frame gaps, VT diagnostics, VRAM, heap — and hand
    // them to `MapShine.debug.updatePerfStrip`; it owns none of the display.
    host.appendChild(canvas);
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
    // THE DEBUG ROW's own history (2026-08-18 fix) — 24 samples, matching the
    // mock's own FPS_SPARK_N exactly. Real ratio/level per tick, straight off
    // diag/perf-strip.js#buildPerfStripModel (the SAME model the old panel's
    // strip already builds from this identical stats object) — never a second,
    // independently-tuned health computation.
    const fpsSparkHistory = [];
    // All-time MINIMUM frame gap — the standard proxy for the display's own
    // refresh rate (browsers expose no such API). All-time, not rolling, for
    // the same reason `worstGapMs` above is all-time: it only needs to see ONE
    // uncongested frame, ever, and a short rolling window could stay congested
    // longer than its own history. diag/perf-strip.js turns this into "how
    // much of the display's own rate is actually landing" — the FPS health bar.
    let bestGapMs = null;
    let lastTickBucket = -1;
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
        if (gap > 0.5 && (bestGapMs === null || gap < bestGapMs)) bestGapMs = gap;
      }
      lastT = t;

      // Repaint ~4x/sec — often enough to read, rare enough that the monitor
      // never becomes the thing worth monitoring (same rule diag/perf-strip.js
      // and diag/perf-hud.js both cite for their own repaint rates).
      if (gaps.length && Math.floor(t / 250) !== lastTickBucket) {
        lastTickBucket = Math.floor(t / 250);
        const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const fps = avg > 0 ? 1000 / avg : 0;
        const recentWorst = Math.max(...gaps);
        const vt = getVtPanViewerDiagnostics();
        const backend = renderer.backend?.isWebGPUBackend ? 'webgpu' : renderer.backend ? 'webgl2' : 'unknown';
        const heapInfo = performance.memory;

        const stats = {
          fps,
          avgGapMs: avg,
          recentWorstMs: recentWorst,
          allTimeWorstMs: worstGapMs,
          bestGapMs,
          vt,
          // `.wholeImage`, NOT the diagnostics root — see readVram's own note a
          // few hundred lines up: `estTextureVramMB` lives there, and the same
          // measured device-loss wall (~2.5GB, keyhole-device-loss-large-map).
          // `targets` (2026-08-09): same fix as readVram's own call site.
          vram: buildVramInventory({
            targets: getVtPanViewerRenderTargets(),
            vtEstimate: vt?.wholeImage ?? null,
            ceilingMb: 2500,
          }),
          heapUsedBytes: heapInfo?.usedJSHeapSize ?? null,
          heapLimitBytes: heapInfo?.jsHeapSizeLimit ?? null,
          renderInfo: readVtPanViewerRenderInfo(),
          backend,
          version: MapShine.version ?? VERSION,
        };
        MapShine.debug?.updatePerfStrip(stats);

        // THE REMOTE'S DEBUG ROW (2026-08-18 fix) — same `stats`,
        // buildPerfStripModel's own pure reshape (the old panel's strip
        // already builds this identical model from this identical object),
        // never a second computation. fpsSparkHistory is FIFO-capped at 24,
        // matching the mock's own FPS_SPARK_N.
        const model = buildPerfStripModel(stats);
        fpsSparkHistory.push({ ratio: model.fps.ratio, level: model.fps.level });
        if (fpsSparkHistory.length > 24) fpsSparkHistory.shift();
        // PUSHED, not stored — bootHeartbeat() is a standalone top-level
        // function with no lexical access to install()'s own locals (unlike
        // lastNonZeroRateHoursPerMinute, this can't be a shared closure
        // variable), so the fresh snapshot goes straight into
        // updateDebugStrip's own argument, matching remoteAstrolabe.update's
        // own push shape.
        MapShine.__remote?.updateDebugStrip?.({
          fpsText: model.fps.valueText,
          msText: avg.toFixed(1),
          vramText: model.vram.valueText,
          sparkHistory: fpsSparkHistory,
        });
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
