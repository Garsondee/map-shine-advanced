/**
 * THE DOOR to vt/ — the virtual-texture core: page cache, page table, atlas,
 * decode pool, residency, and the scene renderer that consumes them
 * (`vt-pan-viewer.js` — Keyhole.md's tracked rename target is
 * `scene/scene-renderer.js`; it lives here under its current name until that
 * mechanical move happens). One public API per zone (Skeleton.md §2.1,
 * `zones/one-door`): if it is not exported here, other zones cannot reach it.
 *
 * Internals (`page-cache.js`, `atlas.js`, `decode-pool.js`, `residency.js`,
 * `view-state.js`, `world-quad.js`'s vt-side helpers, etc.) stay unimportable
 * from outside vt/ — they compose freely with each other in here.
 */
export {
  startVtPanViewer,
  stopVtPanViewer,
  getVtPanViewerDiagnostics,
  setVtPanViewerFloor,
  setVtPanViewerDisplayLayer,
  setVtPanViewerIsolateItem,
  getVtPanViewerDrawListIds,
  getVtPanViewerIsolateItemId,
  refreshVtPanViewerItems,
  runOrientationSelfTest,
  runZoomThrashTest,
  soakPanStep,
  soakSwitchFloorStep,
  soakZoomStep,
  setWholeImageMode,
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
