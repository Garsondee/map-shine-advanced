/**
 * THE DOOR to vt/ — the whole-image scene renderer (`vt-pan-viewer.js` —
 * Keyhole.md's tracked rename target is `scene/scene-renderer.js`; it lives
 * here under its current name until that mechanical move happens) plus the
 * small decode/page-cache machinery masks still load through. One public API
 * per zone (Skeleton.md §2.1, `zones/one-door`): if it is not exported here,
 * other zones cannot reach it.
 *
 * Internals (`page-cache.js`, `decode-pool.js`, `residency.js`,
 * `view-state.js`, `world-quad.js`'s vt-side helpers, etc.) stay unimportable
 * from outside vt/ — they compose freely with each other in here. The
 * streaming/virtual-texture atlas engine (`atlas.js`, `vt-sample.tsl.js`) was
 * removed 2026-07-22 — see feedback_mode_forks_silently_drop_features.
 */
export {
  startVtPanViewer,
  stopVtPanViewer,
  getVtPanViewerDiagnostics,
  getVtPanViewerRenderTargets,
  setVtPanViewerFloor,
  // FLOOR PREPARE/COMMIT (2026-08-15) — prepareVtPanViewerFloor front-loads a
  // floor switch's art before setVtPanViewerFloor above does the actual
  // (now-instant) commit; cancelVtPanViewerFloorPrepare abandons one in
  // flight. See prepareFloor's own doc in vt-pan-viewer.js.
  prepareVtPanViewerFloor,
  cancelVtPanViewerFloorPrepare,
  prewarmVtPanViewerAdjacentFloors,
  setVtPanViewerGpuProbe,
  // PER-PASS GPU TIMING (docs/planning/Performance.md). Distinct from the probe
  // above: that one measures the WHOLE frame and must throttle the loop to do
  // it; this one reads the GPU's own timestamps per render pass and does not.
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
  rebakeVtPanViewerWindField,
  triggerVtPanViewerWindDoorImpulse,
  setVtPanViewerWindForceThaw,
  getVtPanViewerWindSimStatus,
  resetVtPanViewerFrameStats,
  setVtPanViewerDisplayLayer,
  setVtPanViewerIsolateItem,
  getVtPanViewerDrawListIds,
  getVtPanViewerGeometryComposition,
  getVtPanViewerIsolateItemId,
  sampleVtPanViewerIllumPixel,
  probeVtPanViewerPixels,
  runInteractiveVtPanViewerPixelProbe,
  probeVtPanViewerWindAndParticles,
  runInteractiveVtPanViewerWindProbe,
  // V4-Testament Stage 0 measurement-only debug flags — see each one's own
  // doc comment in vt-pan-viewer.js (next to runSceneDepthPass).
  setVtPanViewerDebugFirstRenderProbe,
  setVtPanViewerDebugForceMaskNodeOff,
  setVtPanViewerDebugForceOpaqueBlendOff,
  // SHADER-REBUILD PROBE (diag/shader-rebuild-probe.js) — which material
  // re-runs three's TSL node-graph build, and why.
  setVtPanViewerShaderRebuildProbe,
  getVtPanViewerShaderRebuilds,
  // PIPELINE-REBUILD PROBE (diag/pipeline-rebuild-probe.js) — one cache layer
  // downstream: did a render object force a brand-new GPU pipeline compile.
  setVtPanViewerPipelineRebuildProbe,
  getVtPanViewerPipelineRebuilds,
  // CACHE HEALTH (perf-instrumentation-audit-2026-08-12) — the caches this
  // file can see hits/misses (or a bake-count tally) for that have no probe
  // of their own.
  getVtPanViewerVegetationProxyCacheStats,
  getVtPanViewerPointLightWallClipCacheStats,
  getVtPanViewerPointLightMeshPoolStats,
  getVtPanViewerPoolStats,
  getVtPanViewerDoorPoolStats,
  getVtPanViewerWindBakeStats,
  // STAGE 1's revert flag (docs/planning/Stage-1-Shade-Once.md).
  // Fire's own per-frame counts — wired 2026-08-15 to answer "are fire LIGHTS
  // even being built on this floor" (see getFireStatus's own doc).
  getVtPanViewerFireStatus,
  setVtPanViewerEarlyZComposition,
  getVtPanViewerEarlyZComposition,
  // ⚖️ RECKONING CENSUS (TEMPORARY — docs/holy/V4-Reckoning.md; remove with
  // the Reckoning Report button when the campaign's R4 gates close).
  getVtPanViewerReckoningCensus,
  // STAGE 2's revert flag — point-light batching (docs/planning/Point-Light-Batching-Design.md).
  setVtPanViewerPointLightBatching,
  getVtPanViewerPointLightBatching,
  // S2.15's revert flag — point-light illum/coloration MRT merge (Performance-Audit-2026-08.md §3.1).
  setVtPanViewerPointLightMrtMerge,
  getVtPanViewerPointLightMrtMerge,
  // SCENE SETTLE — the real "everything is on screen now" signal (vt/settle.js).
  getVtPanViewerSceneSettle,
  drawVtPanViewerWorldMarkers,
  startVtPanViewerLiveMarkers,
  stopVtPanViewerLiveMarkers,
  refreshVtPanViewerItems,
  runOrientationSelfTest,
  runSceneDepthSelfTest,
  getParticleReadback,
  runZoomThrashTest,
  soakPanStep,
  soakSwitchFloorStep,
  soakZoomStep,
  setDarknessRealism,
  getDarknessRealism,
  // ALBEDO CLARITY structural fork — the diagnostic-only override the
  // sharpening structural A/B uses to get a real measured GPU-ms delta
  // between the two compiled shader graphs. See shouldUseFullAlbedoClarity's
  // own doc in vt-pan-viewer.js. NOT the live-tuning API (that's below, from
  // albedo-clarity.js) — this one needs a viewer restart to take effect.
  setVtPanViewerAlbedoClarityForce,
  getVtPanViewerAlbedoClarityForce,
  setUiShadow,
  getUiShadow,
} from './vt-pan-viewer.js';
// ALBEDO CLARITY — the zoom-out sharpness repair (see this module's own
// header for the full design account). Split out of vt-pan-viewer.js
// 2026-08-15 so the shader lab can import the real node-building functions
// directly, without pulling in vt-pan-viewer.js's Foundry-coupled transitive
// imports. Exposed here so the look is tunable live rather than only at a
// rebuild.
export { setAlbedoClarity, getAlbedoClarity, resetAlbedoClarity, ALBEDO_CLARITY_PARAMS } from './albedo-clarity.js';
export { runVtLiveDecodeTest } from './vt-live-decode-report.js';
// readPageBitmapPixels: the mask authority's injected page-pixel reader —
// per-page CPU extraction is decode machinery, so it lives with the decoder.
export { getSourceBitmap, releaseSourceBitmap, readPageBitmapPixels } from './decode-pool.js';
// CACHE HEALTH (cache-completeness pass, 2026-08-12) — the IndexedDB
// page-blob persistence layer decode-pool.js reads/writes through. Module-
// level state, not viewer-dependent (works before/after the WebGPU viewer
// starts), so this is imported directly rather than through _active.
export { getPyramidStoreStats } from './pyramid-store.js';
// ⚖️ RECKONING (TEMPORARY): the compression worker's request/hit/fail tallies,
// module-level like the pyramid store above — the Reckoning Report reads them
// to tell "warm v10 cache" from "silent quota failure re-encoding every session".
export { getCompressedTextureStats } from './compressed-textures.js';
// resolveRendererRequiredLimits: the boot heartbeat renderer (boot.js) needs
// the SAME raised WebGPU texture cap as the VT viewer, or the flight recorder
// (which reads the heartbeat's device) misreports the limit. Cross-zone, so it
// goes through this door.
export { resolveRendererRequiredLimits } from './texture-limits.js';
