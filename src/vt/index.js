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
  setVtPanViewerWindForceThaw,
  getVtPanViewerWindSimStatus,
  resetVtPanViewerFrameStats,
  setVtPanViewerDisplayLayer,
  setVtPanViewerIsolateItem,
  getVtPanViewerDrawListIds,
  getVtPanViewerIsolateItemId,
  sampleVtPanViewerIllumPixel,
  probeVtPanViewerPixels,
  runInteractiveVtPanViewerPixelProbe,
  probeVtPanViewerWindAndParticles,
  runInteractiveVtPanViewerWindProbe,
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
export { getSourceBitmap, readPageBitmapPixels } from './decode-pool.js';
// resolveRendererRequiredLimits: the boot heartbeat renderer (boot.js) needs
// the SAME raised WebGPU texture cap as the VT viewer, or the flight recorder
// (which reads the heartbeat's device) misreports the limit. Cross-zone, so it
// goes through this door.
export { resolveRendererRequiredLimits } from './texture-limits.js';
