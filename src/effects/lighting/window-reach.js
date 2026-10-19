/**
 * WINDOW REACH — how far an MSA-authored light (a candle, a fire) keeps shining
 * once its light has crossed a window.
 *
 * WHY THIS EXISTS (2026-10-19, author: hard-edged fans of candle light far out
 * of a window). Candles reach 2000 px by default (the wide, bounced-light look,
 * commit 979197b6) and Foundry's own wall sweep lets that light straight through
 * any `light: PROXIMITY` wall (a window). Indoors that wide reach is exactly
 * right; outdoors it threw a straight-edged wedge of light across the whole
 * yard, bright enough that its hard polygon edge showed. Ordinary Foundry
 * lights never did this because their authored radius is small and they fade to
 * nothing before the polygon edge.
 *
 * THE FIX IS A REACH, NOT A WALL: light that crosses a window keeps its colour
 * and brightness right at the glass and then dies away over `outsideReachPx`
 * (the Window light pattern card's "Reach outside a window"). Light that never
 * crosses a window — everything indoors — is multiplied by exactly 1 and is
 * bit-for-bit what it was.
 *
 * THE MATHS, per window segment AB for a light at L and a floor point P:
 *   P is "through" the window iff the segment L→P crosses AB (t in (0,1],
 *   u in [0,1]); the distance past the glass is d = (1 - t) * |P - L|; the
 *   multiplier is `windowReachFade(d, reach)` = (1 - d / reach)^2 clamped to
 *   [0,1]. Windows in series take the smallest multiplier.
 * This file is the CPU spec (and Node-testable); `buildWindowReachTerm` is its
 * line-for-line TSL port, THREE injected like `aperture-gobo-render.js`.
 *
 * Independent of the Window light pattern's own on/off and strength: that
 * effect shapes light inside the window (panes, frames); this one only decides
 * how far it travels afterwards. Needs no mask and no new texture.
 *
 * @module effects/lighting/window-reach
 */

/** Slider range end: at this value the reach is unlimited (term compiled out). */
export const WINDOW_REACH_OFF_PX = 2000;
/** Default reach outside a window, in scene px (about two grid squares). */
export const WINDOW_REACH_DEFAULT_PX = 200;
/** How many windows one light can be curtailed by (a graph-build-time unroll count). */
export const MAX_WINDOWS_PER_LIGHT = 4;
/** Slack at each end of a window, in px, so the fade does not stop a hair short of the glass edge. */
export const WINDOW_END_SLACK_PX = 2;

/**
 * Is a given reach setting an actual limit? Anything non-finite, or at/above
 * {@link WINDOW_REACH_OFF_PX}, means "no limit" — those lights compile no term.
 * @param {number} reachPx
 * @returns {boolean}
 */
export function windowReachLimited(reachPx) {
  return Number.isFinite(reachPx) && reachPx < WINDOW_REACH_OFF_PX;
}

/**
 * The fade curve: 1 at the glass, (1 - d/reach)^2 beyond it, 0 at `reach` and
 * past it. Quadratic on purpose: the light dies fastest right outside the
 * glass (like a real lamp seen from beyond the pane) and has no hard edge,
 * because both the value and the slope end at 0.
 * @param {number} distPastPx - distance beyond the window, px.
 * @param {number} reachPx - the reach setting.
 * @returns {number} 0..1
 */
export function windowReachFade(distPastPx, reachPx) {
  const r = Math.max(reachPx, 1e-6);
  const f = 1 - Math.min(Math.max(distPastPx / r, 0), 1);
  return f * f;
}

/**
 * Does the segment from the light L to the point P cross the window AB, and how
 * far past it is P? The CPU twin of the per-window block in
 * {@link buildWindowReachTerm}.
 * @param {{x:number,y:number}} L @param {{x:number,y:number}} P
 * @param {{ax:number,ay:number,bx:number,by:number}} w
 * @returns {number} distance past the window in px, or -1 when L→P does not cross it.
 */
export function distancePastWindow(L, P, w) {
  const rx = P.x - L.x;
  const ry = P.y - L.y;
  const ax = w.ax - L.x;
  const ay = w.ay - L.y;
  const ex = w.bx - w.ax;
  const ey = w.by - w.ay;
  const denom = rx * ey - ry * ex;
  if (Math.abs(denom) < 1e-6) return -1;
  const t = (ax * ey - ay * ex) / denom;
  const u = (ax * ry - ay * rx) / denom;
  const slack = WINDOW_END_SLACK_PX / Math.max(Math.hypot(ex, ey), 1);
  if (!(t > 0 && t <= 1 && u >= -slack && u <= 1 + slack)) return -1;
  return (1 - t) * Math.hypot(rx, ry);
}

/**
 * The reach multiplier of one light at one point: 1 when L→P crosses no window,
 * otherwise the smallest {@link windowReachFade} over the windows it crosses.
 * @param {{x:number,y:number}} L @param {{x:number,y:number}} P
 * @param {Array<{ax:number,ay:number,bx:number,by:number}>} windows
 * @param {number} reachPx
 * @returns {number} 0..1
 */
export function computeWindowReachMultiplier(L, P, windows, reachPx) {
  let m = 1;
  for (let i = 0; i < windows.length; i++) {
    const d = distancePastWindow(L, P, windows[i]);
    if (d >= 0) m = Math.min(m, windowReachFade(d, reachPx));
  }
  return m;
}

function distPointToSegment(px, py, ax, ay, bx, by) {
  const ex = bx - ax;
  const ey = by - ay;
  const len2 = ex * ex + ey * ey;
  const t = len2 > 0 ? Math.min(Math.max(((px - ax) * ex + (py - ay) * ey) / len2, 0), 1) : 0;
  return Math.hypot(px - (ax + t * ex), py - (ay + t * ey));
}

/**
 * The windows that can shape one light's outside reach: every aperture wall
 * within the light's own radius, nearest first, at most
 * {@link MAX_WINDOWS_PER_LIGHT}. Pure; the caller caches the result per light
 * (it only changes when the light moves, its radius changes or the walls do).
 * Reuses `out` so a moving light allocates nothing per frame.
 *
 * @param {{x:number,y:number,radius:number}} light
 * @param {Array<{aperture?:boolean,x1:number,y1:number,x2:number,y2:number}>} apertureSegments
 *   wall segments already filtered to apertures (`point-light-pool.js`'s own
 *   cached list); a non-aperture entry is skipped anyway.
 * @param {Array<{ax:number,ay:number,bx:number,by:number,d:number}>} [out]
 * @returns {Array<{ax:number,ay:number,bx:number,by:number,d:number}>} the nearest windows, nearest first.
 */
export function findWindowsForReach(light, apertureSegments, out = []) {
  out.length = 0;
  if (!apertureSegments || apertureSegments.length === 0) return out;
  const radius = Number.isFinite(light.radius) ? light.radius : 0;
  for (let i = 0; i < apertureSegments.length; i++) {
    const s = apertureSegments[i];
    if (!s?.aperture) continue;
    const d = distPointToSegment(light.x, light.y, s.x1, s.y1, s.x2, s.y2);
    if (d > radius) continue;
    // Insertion into a tiny, distance-sorted list: no sort() call, no array per light.
    let at = out.length;
    while (at > 0 && out[at - 1].d > d) at--;
    if (at >= MAX_WINDOWS_PER_LIGHT) continue;
    const entry = { ax: s.x1, ay: s.y1, bx: s.x2, by: s.y2, d };
    out.splice(at, 0, entry);
    if (out.length > MAX_WINDOWS_PER_LIGHT) out.length = MAX_WINDOWS_PER_LIGHT;
  }
  return out;
}

/**
 * Build ONE light's window-reach TERM — a scalar node, 0..1, 1 = unmodulated.
 * Returns `null` when `windowCount` is 0 (a graph-build-time JS branch, like
 * `buildApertureGoboTerm`'s own): a light with no window in reach compiles none
 * of it. TSL maths is the line-for-line port of {@link distancePastWindow} and
 * {@link windowReachFade}.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.positionWorldXY - `positionWorld.xy`.
 * @param {number} args.windowCount - 0..{@link MAX_WINDOWS_PER_LIGHT}, unrolled at build time.
 * @param {{uWindowReachPx:*}} args.shared - the pool-wide reach uniform.
 * @returns {{node:*, uLight:*, windows:Array<{uSeg:*}>}|null}
 */
export function buildWindowReachTerm({ THREE, positionWorldXY, windowCount, shared }) {
  if (!(windowCount > 0)) return null;
  const count = Math.min(Math.floor(windowCount), MAX_WINDOWS_PER_LIGHT);
  const { uniform, float, vec2, vec4, select, min, max, clamp, abs, length } = THREE.TSL;

  const uLight = uniform(vec2(0, 0));
  const r = positionWorldXY.sub(uLight).toVar('winReachR');
  const rLen = length(r).toVar('winReachRLen');
  const reach = max(shared.uWindowReachPx, float(1e-6));

  const windows = [];
  let term = float(1);
  for (let k = 0; k < count; k++) {
    // Packed (ax, ay, bx, by); parked far away (and degenerate) until the pool writes it.
    const uSeg = uniform(vec4(1e7, 1e7, 1e7, 1e7));
    windows.push({ uSeg });
    const a = uSeg.xy.sub(uLight);
    const e = uSeg.zw.sub(uSeg.xy);
    const denom = r.x.mul(e.y).sub(r.y.mul(e.x)).toVar(`winReachDenom${k}`);
    const ok = abs(denom).greaterThan(float(1e-6));
    const safe = select(ok, denom, float(1e-6));
    const t = a.x.mul(e.y).sub(a.y.mul(e.x)).div(safe).toVar(`winReachT${k}`);
    const u = a.x.mul(r.y).sub(a.y.mul(r.x)).div(safe).toVar(`winReachU${k}`);
    const slack = float(WINDOW_END_SLACK_PX).div(max(length(e), float(1)));
    const hit = ok
      .and(t.greaterThan(float(0)))
      .and(t.lessThanEqual(float(1)))
      .and(u.greaterThanEqual(slack.negate()))
      .and(u.lessThanEqual(float(1).add(slack)));
    const f = float(1).sub(clamp(float(1).sub(t).mul(rLen).div(reach), float(0), float(1)));
    term = min(term, select(hit, f.mul(f), float(1)));
  }
  return { node: term, uLight, windows };
}
