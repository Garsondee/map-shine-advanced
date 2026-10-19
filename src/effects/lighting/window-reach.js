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
 *   multiplier is `windowReachFade(d, reach)` = full strength for the first
 *   {@link WINDOW_REACH_HOLD} of the reach, then a smooth fade to 0 at `reach`, times `windowEdgeSoftness(u)`: the beam is full strength through the
 *   middle of the glass and fades over the outer {@link WINDOW_EDGE_SOFT_FRACTION}
 *   of the window at each side, so the beam has SOFT sides instead of the
 *   straight-edged wedge a bare window cut-out gives. Windows in series take the
 *   smallest multiplier.
 * HOW A LIGHT KNOWS ITS WINDOWS: a building can have dozens of windows (the Mad Scientist's Compound has
 * 47), so a short per-light list of the "nearest" ones missed most of the light that really leaves. Instead each
 * light gets a tiny lookup of its own, computed once on the CPU: for each of {@link WINDOW_REACH_BINS} compass
 * directions, the distance at which that ray FIRST crosses a window (or nothing, if a wall or open air comes
 * first), and how far across the glass it went. The shader reads it by angle. Any number of windows, series and
 * walls in the way are all handled by the one ray cast; it is redone only when the light moves or the walls change.
 *
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
export const WINDOW_REACH_DEFAULT_PX = 300;
export const WINDOW_REACH_BINS = 720;
/** The fraction of the reach, just past the glass, over which the light stays at full strength. */
export const WINDOW_REACH_HOLD = 0.3;
/** Over this many px past the glass the soft sides fade in (so there is no step at the glass line). */
export const WINDOW_SOFT_RAMP_PX = 60;
/** Distance written for "no window this way". */
export const WINDOW_NONE = 65535;
/** The beam's soft sides: the fraction of the window's length, at each end, over which the light
 * fades in from nothing (0.3 = the outer 30% of the glass at each side). */
export const WINDOW_EDGE_SOFT_FRACTION = 0.3;
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
 * The fade curve: 1 from the glass out to {@link WINDOW_REACH_HOLD} of the reach (so the window pattern
 * — panes, mullions — shows at full strength just outside the glass), then a smoothstep down to 0 at `reach`
 * and past it. No hard edge: the value and the slope are both 0 at the end. (A first version faded from the
 * glass itself, which hid the pattern entirely.)
 * @param {number} distPastPx - distance beyond the window, px.
 * @param {number} reachPx - the reach setting.
 * @returns {number} 0..1
 */
export function windowReachFade(distPastPx, reachPx) {
  const r = Math.max(reachPx, 1e-6);
  const u = Math.min(Math.max((distPastPx / r - WINDOW_REACH_HOLD) / (1 - WINDOW_REACH_HOLD), 0), 1);
  return 1 - u * u * (3 - 2 * u);
}

/**
 * How much of the beam survives at position `u` across the glass (0 = one end, 1 = the other):
 * a smoothstep up over the outer {@link WINDOW_EDGE_SOFT_FRACTION} of each side, 1 in the middle.
 * @param {number} u
 * @returns {number} 0..1
 */
export function windowEdgeSoftness(u) {
  const s = WINDOW_EDGE_SOFT_FRACTION;
  const ss = (x) => {
    const c = Math.min(Math.max(x / s, 0), 1);
    return c * c * (3 - 2 * c);
  };
  return ss(u) * ss(1 - u);
}

/**
 * Where does the segment from the light L to the point P cross the window AB? The CPU twin of the
 * per-window block in {@link buildWindowReachTerm}. Returns `{d, u}`: the distance past the glass
 * in px and the position across it (0..1, slightly outside near the ends), or `null` when L→P does
 * not cross it.
 * @param {{x:number,y:number}} L @param {{x:number,y:number}} P
 * @param {{ax:number,ay:number,bx:number,by:number}} w
 * @returns {{d:number,u:number}|null}
 */
export function windowCrossing(L, P, w) {
  const rx = P.x - L.x;
  const ry = P.y - L.y;
  const ax = w.ax - L.x;
  const ay = w.ay - L.y;
  const ex = w.bx - w.ax;
  const ey = w.by - w.ay;
  const denom = rx * ey - ry * ex;
  if (Math.abs(denom) < 1e-6) return null;
  const t = (ax * ey - ay * ex) / denom;
  const u = (ax * ry - ay * rx) / denom;
  const slack = WINDOW_END_SLACK_PX / Math.max(Math.hypot(ex, ey), 1);
  if (!(t > 0 && t <= 1 && u >= -slack && u <= 1 + slack)) return null;
  return { d: (1 - t) * Math.hypot(rx, ry), u };
}

/**
 * Just the distance past the window (`-1` when L→P does not cross it) — see {@link windowCrossing}.
 * @param {{x:number,y:number}} L @param {{x:number,y:number}} P
 * @param {{ax:number,ay:number,bx:number,by:number}} w
 * @returns {number}
 */
export function distancePastWindow(L, P, w) {
  const c = windowCrossing(L, P, w);
  return c ? c.d : -1;
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
    const c = windowCrossing(L, P, windows[i]);
    if (c) m = Math.min(m, windowReachFade(c.d, reachPx) * windowEdgeSoftness(c.u));
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
 * The reach multiplier at distance `r` from the light along a direction whose profile is (dWin, soft):
 * 1 before the window, then fading over the reach, with the soft sides eased in over
 * {@link WINDOW_SOFT_RAMP_PX} so there is no step at the glass line.
 * @param {number} r @param {number} dWin @param {number} soft @param {number} reachPx
 * @returns {number} 0..1
 */
export function windowReachAlongRay(r, dWin, soft, reachPx) {
  if (!(r > dWin)) return 1;
  const past = r - dWin;
  const ramp = Math.min(Math.max(past / WINDOW_SOFT_RAMP_PX, 0), 1);
  return windowReachFade(past, reachPx) * (1 - (1 - soft) * ramp);
}

/**
 * Cast {@link WINDOW_REACH_BINS} rays from the light and record, for each, whether the FIRST wall it meets is a
 * window, and if so how far away and how far across the glass. Written into `bytes` as RGBA8 (the shader's
 * lookup texture): R,G = distance as a 16-bit number (65535 = none), B = soft-side factor 0..255, A = 255.
 *
 * @param {{x:number,y:number,radius:number}} light
 * @param {Array<{x1:number,y1:number,x2:number,y2:number,reachWindow?:boolean}>} walls every wall that stops
 *   light PLUS the windows (flagged `reachWindow`): the nearest one along a ray decides.
 * @param {Uint8Array} bytes length `WINDOW_REACH_BINS * 4`, filled in place.
 * @returns {number} how many directions go through a window first (0 = this light has no window to curtail).
 */
export function computeWindowReachProfile(light, walls, bytes) {
  const N = WINDOW_REACH_BINS;
  const radius = Number.isFinite(light.radius) ? light.radius : 0;
  // Only walls that can be reached at all.
  const near = [];
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    if (distPointToSegment(light.x, light.y, w.x1, w.y1, w.x2, w.y2) <= radius) near.push(w);
  }
  let count = 0;
  for (let k = 0; k < N; k++) {
    const ang = ((k + 0.5) / N - 0.5) * 2 * Math.PI;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    let bestT = Infinity;
    let bestWin = false;
    let bestU = 0;
    for (let i = 0; i < near.length; i++) {
      const w = near[i];
      const ex = w.x2 - w.x1;
      const ey = w.y2 - w.y1;
      const denom = dx * ey - dy * ex;
      if (Math.abs(denom) < 1e-9) continue;
      const ax = w.x1 - light.x;
      const ay = w.y1 - light.y;
      const t = (ax * ey - ay * ex) / denom;
      if (!(t > 1e-6 && t < bestT && t <= radius)) continue;
      const u = (ax * dy - ay * dx) / denom;
      if (u < 0 || u > 1) continue;
      bestT = t;
      bestWin = w.reachWindow === true;
      bestU = u;
    }
    const o = k * 4;
    if (bestWin) {
      const d16 = Math.min(Math.round(bestT), WINDOW_NONE - 1);
      bytes[o] = d16 >> 8;
      bytes[o + 1] = d16 & 255;
      bytes[o + 2] = Math.round(windowEdgeSoftness(bestU) * 255);
      count++;
    } else {
      bytes[o] = 255;
      bytes[o + 1] = 255;
      bytes[o + 2] = 255;
    }
    bytes[o + 3] = 255;
  }
  return count;
}

/** One lookup bin: the multiplier it gives at distance `r`, and whether it has no window at all. */
function profileTap(bytes, idx, r, reachPx) {
  const i = ((idx % WINDOW_REACH_BINS) + WINDOW_REACH_BINS) % WINDOW_REACH_BINS;
  const d = bytes[i * 4] * 256 + bytes[i * 4 + 1];
  const soft = bytes[i * 4 + 2] / 255;
  return { value: windowReachAlongRay(r, d, soft, reachPx), none: d >= WINDOW_NONE - 1 };
}

/**
 * The CPU twin of the shader: the reach multiplier at point P for a light at L whose profile is `bytes`
 * (two neighbouring directions blended, like the GPU lookup).
 * @param {Uint8Array} bytes @param {{x:number,y:number}} L @param {{x:number,y:number}} P @param {number} reachPx
 * @returns {number} 0..1
 */
export function sampleWindowReachProfile(bytes, L, P, reachPx) {
  const rx = P.x - L.x;
  const ry = P.y - L.y;
  const r = Math.hypot(rx, ry);
  const f = (Math.atan2(ry, rx) / (2 * Math.PI) + 0.5) * WINDOW_REACH_BINS - 0.5;
  const i0 = Math.floor(f);
  const fr = f - i0;
  const ta = profileTap(bytes, i0, r, reachPx);
  const tc = profileTap(bytes, i0 + 1, r, reachPx);
  // NEVER BLEND A "NO WINDOW" DIRECTION INTO A WINDOW ONE. A direction whose first wall is a solid post (or open
  // ground) reads 1 = unmodulated; blending it with a neighbouring window direction that has faded to 0 left a bright
  // rim along the edge of every window beam, right where it meets the shadow of the post. A no-window neighbour
  // instead takes its window neighbour's value (the light there is blocked or open anyway, so nothing else changes).
  const a = ta.none && !tc.none ? tc.value : ta.value;
  const c = tc.none && !ta.none ? ta.value : tc.value;
  return a + (c - a) * fr;
}

/**
 * Build ONE light's window-reach TERM — a scalar node, 0..1, 1 = unmodulated. Returns `null` when
 * `windowCount` is 0 (graph-build-time JS branch): a light with no window in reach compiles none of it.
 * The TSL port of {@link sampleWindowReachProfile}.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.positionWorldXY - `positionWorld.xy`.
 * @param {number} args.windowCount - 0 compiles it out; anything above is on.
 * @param {{uWindowReachPx:*}} args.shared - the pool-wide reach uniform.
 * @param {*} args.profileTexture - the light's RGBA8 lookup (`WINDOW_REACH_BINS` x 1, nearest).
 * @returns {{node:*, uLight:*}|null}
 */
export function buildWindowReachTerm({ THREE, positionWorldXY, windowCount, shared, profileTexture }) {
  if (!(windowCount > 0) || !profileTexture) return null;
  const { uniform, float, vec2, select, max, clamp, length, atan, floor, texture, mix, smoothstep } = THREE.TSL;
  const N = WINDOW_REACH_BINS;

  const uLight = uniform(vec2(0, 0));
  const rel = positionWorldXY.sub(uLight);
  const r = length(rel).toVar('winReachR');
  const reach = max(shared.uWindowReachPx, float(1e-6));
  const f = atan(rel.y, rel.x)
    .div(float(2 * Math.PI))
    .add(float(0.5))
    .mul(float(N))
    .sub(float(0.5))
    .toVar('winReachF');
  const i0 = floor(f);
  const fr = f.sub(i0);

  // Each tap returns its multiplier AND a 0/1 "no window in this direction" flag (see sampleWindowReachProfile for why).
  const tap = (idxNode) => {
    // (idx + N) mod N, without a modulo operator: idx is only ever -1..N.
    const wrapped = select(
      idxNode.lessThan(float(0)),
      idxNode.add(float(N)),
      select(idxNode.greaterThanEqual(float(N)), idxNode.sub(float(N)), idxNode)
    );
    const t = texture(profileTexture).sample(vec2(wrapped.add(float(0.5)).div(float(N)), float(0.5)));
    const d = t.r.mul(float(65280)).add(t.g.mul(float(255)));
    const soft = t.b;
    const past = max(r.sub(d), float(0));
    const fade = float(1).sub(smoothstep(reach.mul(float(WINDOW_REACH_HOLD)), reach, past));
    const ramp = clamp(past.div(float(WINDOW_SOFT_RAMP_PX)), float(0), float(1));
    const value = fade.mul(float(1).sub(float(1).sub(soft).mul(ramp)));
    return {
      value: select(r.greaterThan(d), value, float(1)),
      none: select(d.greaterThan(float(60000)), float(1), float(0)),
    };
  };
  const ta = tap(i0);
  const tc = tap(i0.add(float(1)));
  const a = mix(ta.value, tc.value, ta.none.mul(float(1).sub(tc.none)));
  const c = mix(tc.value, ta.value, tc.none.mul(float(1).sub(ta.none)));
  const node = mix(a, c, fr);
  return { node, uLight };
}
