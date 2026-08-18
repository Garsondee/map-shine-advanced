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
export { showPerfProgress, hidePerfProgress, formatPerfProgressText } from './perf-progress-overlay.js';
export {
  beginFloorTransition,
  updateFloorTransitionProgress,
  endFloorTransition,
  formatFloorTransitionHeadline,
  formatFloorTransitionBlockers,
} from './floor-transition.js';

// The LANTERN widget canon (U0, docs/holy/UI-Testament.md §9) — the ONE
// type→widget mapping and its pure category/FOH-ROH/snapshot logic, shared by
// diag/effect-controls.js's OLD card shell and every room the Studio/Remote
// migration adds from here on.
export { installTokens, getThemeTokens, tokensCSS, THEMES } from './tokens.js';
export { installIconSprite, iconMarkup, ICONS } from './widgets/icon-sprite.js';
export {
  styled,
  buildParamControl,
  buildInheritableRangeRow,
  COMPASS_POINTS,
  COMPASS_SNAP_DEG,
  wrapDeg,
  nearestCompassPoint,
} from './widgets/param-control.js';
export {
  CATEGORY_ORDER,
  groupParamsByCategory,
  rohGroups,
  createSectionStore,
  collapsedStatusLine,
  buildSettingsSnapshot,
} from './widgets/param-groups.js';
