/**
 * @fileoverview vt/view-state.js — pure keyboard-driven pan/zoom/floor-switch
 * state (Keyhole Stage 1 part 4b: "Grey→coarse→sharp world; pan/zoom/floor-switch
 * by keyboard").
 *
 * Deliberately pure and Node-testable: given a view state + a key, return the
 * NEXT view state. No DOM, no THREE, no timers. The browser-only orchestration
 * (vt-pan-viewer.js) owns the `keydown` listener and calls these.
 *
 * @module vt/view-state
 */

/** @typedef {{ centerXPx:number, centerYPx:number, halfSpanPx:number, floorIndex:number }} ViewState */

/**
 * @param {object} opts
 * @param {number} opts.worldSizePx
 * @param {number} [opts.floorIndex]
 * @param {number} [opts.halfSpanPx] - half the world-space width/height framed
 *   on screen (default: a few pages' worth — matches the smoke test's proven 3x3 framing).
 * @returns {ViewState}
 */
export function createInitialViewState({ worldSizePx, floorIndex = 0, halfSpanPx }) {
  return {
    centerXPx: worldSizePx / 2,
    centerYPx: worldSizePx / 2,
    halfSpanPx: halfSpanPx ?? worldSizePx * 0.03, // ~3% of the world framed initially
    floorIndex,
  };
}

const PAN_KEYS = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  a: [-1, 0],
  d: [1, 0],
  w: [0, -1],
  s: [0, 1],
};

/**
 * @param {ViewState} view
 * @param {string} key - a KeyboardEvent.key value.
 * @param {number} worldSizePx - clamps pan so the view center can't leave the world.
 * @returns {ViewState} a NEW state (never mutates the input).
 */
export function applyPanKey(view, key, worldSizePx) {
  const dir = PAN_KEYS[key];
  if (!dir) return view;
  const step = view.halfSpanPx * 0.5; // half a screenful per keypress — responsive, not jumpy
  const clamp = (v) => Math.max(0, Math.min(worldSizePx, v));
  return {
    ...view,
    centerXPx: clamp(view.centerXPx + dir[0] * step),
    centerYPx: clamp(view.centerYPx + dir[1] * step),
  };
}

const MIN_HALF_SPAN_PX = 50; // never zoom in past ~a fifth of one page — meaningless below this
const MAX_HALF_SPAN_ZOOM_OUT_FACTOR = 0.5; // never zoom out past half the world on-screen at once

/**
 * @param {ViewState} view @param {string} key @param {number} worldSizePx
 * @returns {ViewState}
 */
export function applyZoomKey(view, key, worldSizePx) {
  let factor = null;
  if (key === '+' || key === '=' || key === 'PageUp') factor = 0.8; // zoom in
  if (key === '-' || key === '_' || key === 'PageDown') factor = 1.25; // zoom out
  if (factor === null) return view;
  const maxHalfSpan = worldSizePx * MAX_HALF_SPAN_ZOOM_OUT_FACTOR;
  const halfSpanPx = Math.max(MIN_HALF_SPAN_PX, Math.min(maxHalfSpan, view.halfSpanPx * factor));
  return { ...view, halfSpanPx };
}

/**
 * @param {ViewState} view @param {string} key @param {number} floorCount
 * @returns {ViewState}
 */
export function applyFloorSwitchKey(view, key, floorCount) {
  const n = Number(key);
  if (Number.isInteger(n) && n >= 0 && n < floorCount) return { ...view, floorIndex: n };
  if (key === 'Tab') return { ...view, floorIndex: (view.floorIndex + 1) % floorCount };
  return view;
}

/**
 * One entry point the viewer calls per keydown — tries pan, then zoom, then
 * floor-switch, returning the first one that actually changed something (or
 * the original view, unchanged, if the key means nothing to this system).
 * @param {ViewState} view @param {string} key
 * @param {{worldSizePx:number, floorCount:number}} ctx
 * @returns {ViewState}
 */
export function applyKey(view, key, ctx) {
  const afterPan = applyPanKey(view, key, ctx.worldSizePx);
  if (afterPan !== view) return afterPan;
  const afterZoom = applyZoomKey(view, key, ctx.worldSizePx);
  if (afterZoom !== view) return afterZoom;
  return applyFloorSwitchKey(view, key, ctx.floorCount);
}

/**
 * @param {ViewState} view
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}} the world rect
 *   this view currently frames (NOT clamped to world bounds — residency.js's
 *   own computeVisiblePages already clamps page coordinates; an unclamped
 *   rect here correctly shrinks the visible page COUNT near an edge instead
 *   of silently re-centering).
 */
export function viewToWorldRect(view) {
  return {
    minX: view.centerXPx - view.halfSpanPx,
    minY: view.centerYPx - view.halfSpanPx,
    maxX: view.centerXPx + view.halfSpanPx,
    maxY: view.centerYPx + view.halfSpanPx,
  };
}
