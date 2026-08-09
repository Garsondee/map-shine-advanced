/**
 * ui/ — the ONE public door for the UI zone (Skeleton.md §2.1, `zones/one-door`).
 * Other zones import UI through here; reaching a ui/ file directly across a zone
 * boundary is a lint error. (Loading overlay + loading screen are still imported
 * directly by boot.js today — a ratcheted debt to route through here later.)
 *
 * Changing these exports is an architectural change — say so in the commit
 * (`[structure-change]`) and update the governing UI docs (docs/planning/UI.md,
 * Effects-UI.md, Authoring-and-Distribution.md).
 */
export { createAstrolabe } from './astrolabe.js';
export { installPainter } from './paint-mode.js';
export { openCameraPathDialog, closeCameraPathDialog } from './camera-path-dialog.js';
export { installAnchorMode } from './anchor-mode.js';
export { installAnchorViewMode } from './anchor-view-mode.js';
