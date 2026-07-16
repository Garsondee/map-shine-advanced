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
 * Grab-and-drag panning, native-Foundry style: the world point under the
 * cursor stays under the cursor as the mouse moves. Pure/sync so the DOM
 * orchestration (vt-pan-viewer.js) stays a thin listener over this.
 *
 * The framing is aspect-correct (viewToWorldRect widens X by aspect, so the
 * quad never distorts), which means world-units-per-screen-pixel is ISOTROPIC
 * — identical on both axes and equal to `2*halfSpanPx / canvasHeightPx`. That
 * is why this takes only the canvas HEIGHT, not width or aspect.
 *
 * Both signs are negative: dragging the map right (dxPixels > 0) shows content
 * that was to the LEFT, so the view center moves left; and this viewer maps
 * screen-Y-downward to world-Y-increasing (reframeLayer's v-flip, live-verified
 * 2026-07-15), so dragging down (dyPixels > 0) reveals content ABOVE and the
 * center's world-Y decreases too.
 *
 * @param {ViewState} view
 * @param {number} dxPixels - cursor movement since last event, screen px (right +).
 * @param {number} dyPixels - cursor movement since last event, screen px (down +).
 * @param {number} canvasHeightPx - the drawing-buffer height the view fills.
 * @param {number} worldSizePx - clamps the center to the world bounds.
 * @returns {ViewState} a NEW state (never mutates the input).
 */
export function applyPanByPixels(view, dxPixels, dyPixels, canvasHeightPx, worldSizePx) {
  if (dxPixels === 0 && dyPixels === 0) return view;
  const worldPerPixel = (2 * view.halfSpanPx) / canvasHeightPx;
  const clamp = (v) => Math.max(0, Math.min(worldSizePx, v));
  return {
    ...view,
    centerXPx: clamp(view.centerXPx - dxPixels * worldPerPixel),
    centerYPx: clamp(view.centerYPx - dyPixels * worldPerPixel),
  };
}

/**
 * Cursor-anchored wheel zoom, native-Foundry style: zoom in/out around the
 * point under the cursor rather than around the view center, so the map grows
 * toward wherever you're pointing. Uses the SAME halfSpan clamps as
 * `applyZoomKey` so keyboard and wheel zoom agree on their limits.
 *
 * @param {ViewState} view
 * @param {number} factor - <1 zooms in, >1 zooms out (matches applyZoomKey's factors).
 * @param {number} sx - cursor X in canvas pixels (0 = left edge).
 * @param {number} sy - cursor Y in canvas pixels (0 = top edge).
 * @param {number} canvasWidthPx
 * @param {number} canvasHeightPx
 * @param {number} worldSizePx
 * @returns {ViewState} a NEW state (never mutates the input).
 */
export function applyZoomAtPixel(view, factor, sx, sy, canvasWidthPx, canvasHeightPx, worldSizePx) {
  const aspect = canvasWidthPx / canvasHeightPx;
  const rect = viewToWorldRect(view, aspect);
  // World point currently under the cursor (this is what must stay put).
  const wx = rect.minX + (sx / canvasWidthPx) * (rect.maxX - rect.minX);
  const wy = rect.minY + (sy / canvasHeightPx) * (rect.maxY - rect.minY);

  const maxHalfSpan = worldSizePx * MAX_HALF_SPAN_ZOOM_OUT_FACTOR;
  const halfSpanPx = Math.max(MIN_HALF_SPAN_PX, Math.min(maxHalfSpan, view.halfSpanPx * factor));
  if (halfSpanPx === view.halfSpanPx) return view; // already at a clamp — nothing moves

  // Re-solve the center so (wx,wy) lands back under (sx,sy) at the new zoom.
  const halfX = halfSpanPx * aspect;
  const halfY = halfSpanPx;
  const clamp = (v) => Math.max(0, Math.min(worldSizePx, v));
  return {
    ...view,
    halfSpanPx,
    centerXPx: clamp(wx - (sx / canvasWidthPx - 0.5) * 2 * halfX),
    centerYPx: clamp(wy - (sy / canvasHeightPx - 0.5) * 2 * halfY),
  };
}

// ---------------------------------------------------------------------------
// CAMERA SMOOTHING (2026-07-16, author-reported: "camera controls in a very
// jerky way... modern concepts... smooth and cinematic without feeling like
// the user isn't in full control or too dreamy/laggy/drunk").
//
// Root cause of "jerky": keyboard pan/zoom were DISCRETE, one hard jump per
// keydown-repeat event (governed by the OS's key-repeat timing — typically a
// long initial pause then ~20-30Hz — visibly steppy). Mouse-drag panning was
// ALREADY correct (1:1 with the cursor every pointermove, no lag) and is
// deliberately left untouched here — smoothing an ACTIVE drag would detach
// the content from the cursor, which is exactly the "laggy/drunk" feeling the
// author explicitly doesn't want. Direct manipulation stays direct; only
// DISCRETE inputs (held keys, wheel ticks) get eased.
//
// Two different, deliberately different models, because they're different
// KINDS of interaction:
//   PAN (continuous motion while a key is held) -> a VELOCITY that eases
//     toward a target velocity (computeTargetPanVelocity + easeVelocityTowardTarget
//     + integratePan). There's no fixed destination to chase — it's an
//     ongoing walk, with a short ease-in/ease-out ramp for the "cinematic"
//     feel instead of a mechanical instant on/off.
//   ZOOM (a discrete magnitude change per key/wheel input) -> the view's
//     halfSpanPx eases toward a TARGET value each frame (easedZoomFactor),
//     re-solving the cursor anchor fresh every frame via the EXISTING,
//     already-tested applyZoomAtPixel — never a new anchoring formula.
//
// All framerate-independent via `smoothingAlpha` (Freya Holmer's
// "t = 1 - exp(-lambda*dt)" pattern, parameterized by half-life instead of a
// raw lambda — "value closes 50% of the remaining gap every H seconds" is a
// far easier constant to reason about/tune than a decay rate). A fixed
// per-frame multiplier (the classic naive-smoothing mistake) is framerate-
// DEPENDENT — it looks different at 30fps vs 144fps — which this avoids.
// ---------------------------------------------------------------------------

/**
 * Frame-rate-independent exponential smoothing weight for one frame: the
 * fraction of the remaining gap to a target that should close this frame,
 * given `dtSec` elapsed and a `halfLifeSec` (time for the gap to halve).
 * `lerp(current, target, smoothingAlpha(dt, halfLife))` converges to the
 * SAME curve regardless of how dt is chopped up across frames — unlike a
 * fixed per-frame factor, which silently depends on framerate.
 * @param {number} dtSec @param {number} halfLifeSec @returns {number} in [0,1]
 */
export function smoothingAlpha(dtSec, halfLifeSec) {
  if (halfLifeSec <= 0) return 1; // instant (no smoothing)
  if (dtSec <= 0) return 0;
  return 1 - Math.pow(0.5, dtSec / halfLifeSec);
}

const PAN_KEY_TO_AXIS = {
  ArrowLeft: [-1, 0],
  a: [-1, 0],
  A: [-1, 0],
  ArrowRight: [1, 0],
  d: [1, 0],
  D: [1, 0],
  ArrowUp: [0, -1],
  w: [0, -1],
  W: [0, -1],
  ArrowDown: [0, 1],
  s: [0, 1],
  S: [0, 1],
};

/**
 * The target pan velocity (world px/sec, both axes) implied by the currently-
 * held key set — the CONTINUOUS analogue of applyPanKey's discrete per-press
 * step. A diagonal hold (e.g. up+right both held) is normalized to unit
 * length first so diagonal speed never exceeds axis speed.
 * @param {Set<string>} heldKeys - raw KeyboardEvent.key values currently held.
 * @param {number} speedWorldPxPerSec - magnitude when any pan key is held.
 * @returns {{x:number, y:number}}
 */
export function computeTargetPanVelocity(heldKeys, speedWorldPxPerSec) {
  let dx = 0;
  let dy = 0;
  for (const key of heldKeys) {
    const axis = PAN_KEY_TO_AXIS[key];
    if (!axis) continue;
    dx += axis[0];
    dy += axis[1];
  }
  if (dx === 0 && dy === 0) return { x: 0, y: 0 };
  const len = Math.hypot(dx, dy);
  return { x: (dx / len) * speedWorldPxPerSec, y: (dy / len) * speedWorldPxPerSec };
}

/**
 * One frame's worth of velocity easing toward a target — the ease-in/ease-out
 * "ramp" that gives held-key panning a cinematic accel/decel feel instead of
 * an instant on/off, while staying fast enough (a short halfLifeSec, e.g.
 * ~0.08s) to feel responsive, not laggy. Pure, framerate-independent.
 * @param {{x:number,y:number}} current @param {{x:number,y:number}} target
 * @param {number} dtSec @param {number} rampHalfLifeSec
 * @returns {{x:number,y:number}}
 */
export function easeVelocityTowardTarget(current, target, dtSec, rampHalfLifeSec) {
  const a = smoothingAlpha(dtSec, rampHalfLifeSec);
  if (a === 0) return current;
  return { x: current.x + (target.x - current.x) * a, y: current.y + (target.y - current.y) * a };
}

/**
 * Integrate a view's center by a velocity over dtSec, clamped to world bounds
 * — the continuous-pan analogue of applyPanByPixels' clamp. No-op (same
 * reference) at zero velocity so a caller can skip downstream reframe/
 * residency work when nothing actually moved.
 * @param {ViewState} view @param {{x:number,y:number}} velocity
 * @param {number} dtSec @param {number} worldSizePx
 * @returns {ViewState}
 */
export function integratePan(view, velocity, dtSec, worldSizePx) {
  if (velocity.x === 0 && velocity.y === 0) return view;
  const clamp = (v) => Math.max(0, Math.min(worldSizePx, v));
  const centerXPx = clamp(view.centerXPx + velocity.x * dtSec);
  const centerYPx = clamp(view.centerYPx + velocity.y * dtSec);
  if (centerXPx === view.centerXPx && centerYPx === view.centerYPx) return view; // fully clamped at an edge — no-op
  return { ...view, centerXPx, centerYPx };
}

/**
 * The per-frame zoom FACTOR that eases `currentHalfSpanPx` a fraction of the
 * way toward `targetHalfSpanPx` this frame — meant to be fed straight into
 * `applyZoomAtPixel` (reusing its already-tested cursor-anchor math untouched,
 * re-solved fresh every frame from the CURRENT view rather than computed once
 * and applied as a single jump). Frame-rate independent; returns 1 (no-op)
 * once within `epsilonPx` of the target, so a caller can stop the per-frame
 * work once a zoom ease settles.
 * @param {number} currentHalfSpanPx @param {number} targetHalfSpanPx
 * @param {number} dtSec @param {number} halfLifeSec @param {number} [epsilonPx]
 * @returns {number} a factor >0; 1 means "no change".
 */
export function easedZoomFactor(currentHalfSpanPx, targetHalfSpanPx, dtSec, halfLifeSec, epsilonPx = 0.25) {
  if (Math.abs(targetHalfSpanPx - currentHalfSpanPx) < epsilonPx) return 1;
  const alpha = smoothingAlpha(dtSec, halfLifeSec);
  if (alpha === 0) return 1;
  const nextHalfSpanPx = currentHalfSpanPx + (targetHalfSpanPx - currentHalfSpanPx) * alpha;
  return nextHalfSpanPx / currentHalfSpanPx;
}

/**
 * The min/max half-span clamp, extracted so both the discrete keyboard/wheel
 * path AND the eased-zoom-target path (2026-07-16, camera smoothing) apply
 * the EXACT same limits — one law, not two copies that could drift apart.
 * @param {number} halfSpanPx @param {number} worldSizePx @returns {number}
 */
export function clampHalfSpan(halfSpanPx, worldSizePx) {
  const maxHalfSpan = worldSizePx * MAX_HALF_SPAN_ZOOM_OUT_FACTOR;
  return Math.max(MIN_HALF_SPAN_PX, Math.min(maxHalfSpan, halfSpanPx));
}

/**
 * @param {ViewState} view @param {string} key @param {number} worldSizePx
 * @returns {ViewState}
 */
export function applyZoomKey(view, key, worldSizePx) {
  let factor = null;
  if (key === '+' || key === '=' || key === 'PageUp') factor = 0.8; // zoom in
  if (key === '-' || key === '_' || key === 'PageDown') factor = 1.25; // zoom out
  if (factor === null) return view;
  const halfSpanPx = clampHalfSpan(view.halfSpanPx * factor, worldSizePx);
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
 * @param {number} [aspect] - viewport width / height. `halfSpanPx` is the
 *   half-VERTICAL span (the canonical zoom); the horizontal span widens by
 *   `aspect` so a non-square viewport frames a rect of the SAME aspect and the
 *   world renders undistorted (the viewer draws a fullscreen quad, so
 *   worldRect-aspect must equal canvas-aspect or the map stretches). Default 1
 *   == square (preserves the original behavior + tests).
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}} the world rect
 *   this view currently frames (NOT clamped to world bounds — residency.js's
 *   own computeVisiblePages already clamps page coordinates; an unclamped
 *   rect here correctly shrinks the visible page COUNT near an edge instead
 *   of silently re-centering).
 */
export function viewToWorldRect(view, aspect = 1) {
  const halfX = view.halfSpanPx * aspect;
  const halfY = view.halfSpanPx;
  return {
    minX: view.centerXPx - halfX,
    minY: view.centerYPx - halfY,
    maxX: view.centerXPx + halfX,
    maxY: view.centerYPx + halfY,
  };
}
