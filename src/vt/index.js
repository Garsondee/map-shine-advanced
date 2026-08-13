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
  setVtPanViewerSunHour,
  sweepVtPanViewerTimeOfDay,
  setVtPanViewerTimeRate,
  setVtPanViewerTimeMode,
  getVtPanViewerTimeDialState,
  getVtPanViewerTodHour,
  setVtPanViewerSkyRealism,
  setVtPanViewerGradeEnvStrength,
  setVtPanViewerCloudCover,
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
  setVtPanViewerEarlyZComposition,
  getVtPanViewerEarlyZComposition,
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
  // ALBEDO CLARITY — the zoom-out sharpness repair (see buildAlbedoClarityNode's
  // section header in vt-pan-viewer.js). Exposed so the look is tunable live
  // rather than only at a rebuild.
  setAlbedoClarity,
  getAlbedoClarity,
  resetAlbedoClarity,
  setUiShadow,
  getUiShadow,
} from './vt-pan-viewer.js';
export { runVtLiveDecodeTest } from './vt-live-decode-report.js';
// readPageBitmapPixels: the mask authority's injected page-pixel reader —
// per-page CPU extraction is decode machinery, so it lives with the decoder.
export { getSourceBitmap, releaseSourceBitmap, readPageBitmapPixels } from './decode-pool.js';
// CACHE HEALTH (cache-completeness pass, 2026-08-12) — the IndexedDB
// page-blob persistence layer decode-pool.js reads/writes through. Module-
// level state, not viewer-dependent (works before/after the WebGPU viewer
// starts), so this is imported directly rather than through _active.
export { getPyramidStoreStats } from './pyramid-store.js';
// resolveRendererRequiredLimits: the boot heartbeat renderer (boot.js) needs
// the SAME raised WebGPU texture cap as the VT viewer, or the flight recorder
// (which reads the heartbeat's device) misreports the limit. Cross-zone, so it
// goes through this door.
export { resolveRendererRequiredLimits } from './texture-limits.js';
