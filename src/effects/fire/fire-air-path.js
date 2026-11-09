/**
 * THE AIR'S PATH AT ONE FIRE (2026-11-09, mmp-9un.5 + mmp-vm1.1.6).
 *
 * Smoke is carried by the air it is in. A puff born at fire-clock time `tb` has since been blown `W(t) - W(tb)`, where
 * `W` is the air's running displacement at the fire, so every puff reads the path ITS air took: a gust bends the newest
 * smoke and the column curls, instead of the whole column swinging round its base at once (which is what the closed-form
 * "current wind x age" drift did, and why indoor smoke rushed back and forth when a draft came and went — Ingram,
 * 2026-11-06 and 2026-11-09).
 *
 * Two running sums, both on the fire's own clock (the billows' `t`):
 *   - `W` (wx, wy): metres the air has carried smoke, x right and y down the page, already slowed by `rise`;
 *   - `R`: seconds of RISE time — a plume in a wind climbs slower (Briggs's bent-over plume: its rise in time goes as
 *     U^-1/3), so a puff's height reads R, not its age.
 * Plus, per sample, the air's heading and the flame's lean, for things decided once at a moment (a spit ember's throw).
 *
 * A short history of samples (every `sampleSec`, `historySec` long) answers "where was the sum at time tb" by linear
 * interpolation; before the history it extrapolates with the oldest sample's own rate (steady air), so a fire that
 * just appeared, or a clock that jumped, gives the steady shape rather than a heap at the base.
 *
 * @module effects/fire/fire-air-path
 */

/** Floats per sample: t, wx, wy, R, dirX, dirY, lean01, (spare). */
const S = 8;

/**
 * @typedef {object} AirSample
 * @property {number} t fire-clock seconds
 * @property {number} wx @property {number} wy metres of (rise-slowed) air travel since the path began
 * @property {number} R rise-time seconds since the path began
 * @property {number} dirX @property {number} dirY the air's heading then (unit, or 0,0 in still air)
 * @property {number} lean01 the flame lean then (0..1)
 */

/**
 * @param {{historySec?:number, sampleSec?:number}} [opts]
 * @returns {{advance:Function, at:Function, head:AirSample, reset:Function, readonly length:number}}
 */
export function createAirPath({ historySec = 40, sampleSec = 0.2 } = {}) {
  const cap = Math.max(4, Math.ceil(historySec / sampleSec) + 2);
  const buf = new Float64Array(cap * S);
  let first = 0; // ring index of the oldest sample
  let count = 0;
  /** The exact current state (between samples). */
  const head = { t: NaN, wx: 0, wy: 0, R: 0, dirX: 0, dirY: 0, lean01: 0 };
  /** Its rates (the last advance), for extrapolation past the newest sample. */
  let vx = 0;
  let vy = 0;
  let vr = 1;

  const idx = (k) => ((first + k) % cap) * S;

  function push() {
    if (count === cap) {
      first = (first + 1) % cap;
      count--;
    }
    const o = idx(count);
    buf[o] = head.t;
    buf[o + 1] = head.wx;
    buf[o + 2] = head.wy;
    buf[o + 3] = head.R;
    buf[o + 4] = head.dirX;
    buf[o + 5] = head.dirY;
    buf[o + 6] = head.lean01;
    count++;
  }

  function reset(t) {
    first = 0;
    count = 0;
    head.t = t;
    head.wx = 0;
    head.wy = 0;
    head.R = 0;
    push();
  }

  /**
   * Carry the path to fire-clock time `t` with the air `(ux, uy)` m/s, the rise rate `rise` (0..1: how fast a plume
   * climbs in this wind, against still air) and the flame lean. A clock that steps back or jumps more than 5 s starts a
   * fresh path (a reload, a seek): the history is only ever what the air did.
   * @param {number} t @param {number} ux @param {number} uy @param {number} [rise=1] @param {number} [lean01=0]
   */
  function advance(t, ux, uy, rise = 1, lean01 = 0) {
    const u = Math.hypot(ux, uy);
    const r = Number.isFinite(rise) ? Math.min(1, Math.max(0, rise)) : 1;
    if (!Number.isFinite(head.t) || !(t >= head.t) || t - head.t > 5) reset(t);
    const dt = t - head.t;
    if (dt > 0) {
      // the rates over this step are the NEW air's (the felt air is already eased upstream)
      head.wx += ux * r * dt;
      head.wy += uy * r * dt;
      head.R += r * dt;
      head.t = t;
    }
    vx = ux * r;
    vy = uy * r;
    vr = r;
    head.dirX = u > 1e-6 ? ux / u : 0;
    head.dirY = u > 1e-6 ? uy / u : 0;
    head.lean01 = Number.isFinite(lean01) ? lean01 : 0;
    const last = idx(count - 1);
    if (count === 0 || t - buf[last] >= sampleSec) push();
    // keep the sums small (a long session at a gale): shift every sample, differences are unchanged
    if (Math.abs(head.wx) > 1e6 || Math.abs(head.wy) > 1e6 || head.R > 1e7) {
      const ox = head.wx;
      const oy = head.wy;
      const oR = head.R;
      for (let k = 0; k < count; k++) {
        const o = idx(k);
        buf[o + 1] -= ox;
        buf[o + 2] -= oy;
        buf[o + 3] -= oR;
      }
      head.wx = 0;
      head.wy = 0;
      head.R = 0;
    }
  }

  /**
   * The path at fire-clock time `tq` (interpolated; before the history, extrapolated at the oldest sample's rate — the
   * steady air a fire that just appeared would have had; past the head, the head).
   * @param {number} tq @param {AirSample} [out]
   * @returns {AirSample}
   */
  function at(tq, out = { t: 0, wx: 0, wy: 0, R: 0, dirX: 0, dirY: 0, lean01: 0 }) {
    out.t = tq;
    if (!Number.isFinite(head.t) || count === 0) {
      out.wx = 0;
      out.wy = 0;
      out.R = 0;
      out.dirX = 0;
      out.dirY = 0;
      out.lean01 = 0;
      return out;
    }
    if (tq >= head.t) {
      out.wx = head.wx;
      out.wy = head.wy;
      out.R = head.R;
      out.dirX = head.dirX;
      out.dirY = head.dirY;
      out.lean01 = head.lean01;
      return out;
    }
    const o0 = idx(0);
    if (tq <= buf[o0]) {
      // before the history: steady air at the oldest known rate (the segment after the oldest sample, or the head's)
      let rx = vx;
      let ry = vy;
      let rr = vr;
      if (count >= 2) {
        const o1 = idx(1);
        const dt = buf[o1] - buf[o0];
        if (dt > 1e-6) {
          rx = (buf[o1 + 1] - buf[o0 + 1]) / dt;
          ry = (buf[o1 + 2] - buf[o0 + 2]) / dt;
          rr = (buf[o1 + 3] - buf[o0 + 3]) / dt;
        }
      }
      const back = tq - buf[o0];
      out.wx = buf[o0 + 1] + rx * back;
      out.wy = buf[o0 + 2] + ry * back;
      out.R = buf[o0 + 3] + rr * back;
      out.dirX = buf[o0 + 4];
      out.dirY = buf[o0 + 5];
      out.lean01 = buf[o0 + 6];
      return out;
    }
    // binary search: the last sample at or before tq (the head closes the newest segment)
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (buf[idx(mid)] <= tq) lo = mid;
      else hi = mid - 1;
    }
    const oa = idx(lo);
    const ta = buf[oa];
    let tb;
    let bx;
    let by;
    let bR;
    if (lo + 1 < count) {
      const ob = idx(lo + 1);
      tb = buf[ob];
      bx = buf[ob + 1];
      by = buf[ob + 2];
      bR = buf[ob + 3];
    } else {
      tb = head.t;
      bx = head.wx;
      by = head.wy;
      bR = head.R;
    }
    const f = tb > ta ? (tq - ta) / (tb - ta) : 0;
    out.wx = buf[oa + 1] + (bx - buf[oa + 1]) * f;
    out.wy = buf[oa + 2] + (by - buf[oa + 2]) * f;
    out.R = buf[oa + 3] + (bR - buf[oa + 3]) * f;
    out.dirX = buf[oa + 4];
    out.dirY = buf[oa + 5];
    out.lean01 = buf[oa + 6];
    return out;
  }

  return {
    advance,
    at,
    head,
    reset,
    get length() {
      return count;
    },
  };
}
