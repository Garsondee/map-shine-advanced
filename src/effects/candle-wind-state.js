/**
 * CANDLE WIND STATE — a candle that remembers being blown out.
 *
 * The author, 2026-10-27: *"Could you make candle flames more dramatically
 * respond to the speed and direction of wind invading indoor spaces. More
 * guttering before going out, spend longer in the off state if they go out and
 * come back slowly so that they will likely be extinguished again before
 * regrowing fully."*
 *
 * ⚠️ WHAT WAS THERE: snuff was STATELESS — a smooth dim WHILE the local wind was
 * over the threshold, back to full the instant it eased (see
 * `candle-flame-render.js`'s WIND_SNUFF_MAG_* header, which named a real state
 * machine as out of scope). A gust passing an open door made every candle in
 * the room blink, not go out.
 *
 * THE MEMORY, WITHOUT A STATE BUFFER. A shader cannot remember, but the wind
 * field is a pure function of position and time — so the candle can LOOK BACK.
 * It samples the field's travelling gusts at its own wick at a ladder of past moments on a
 * FIXED time grid (`floor(t/Δ)·Δ − kΔ`), so each rung is a fixed absolute moment
 * whose age grows smoothly as time passes — no popping as the ladder slides. For
 * every past moment the wind was strong enough to snuff, the flame is held:
 *
 *   - OUT for {@link CANDLE_DARK_S} after the gust (a smoking wick);
 *   - then REGROWING slowly to full by {@link CANDLE_REGROW_END_S};
 *
 * and the flame is the most-extinguished of those verdicts (`min`). A room with
 * a door open onto a gale therefore sees candles snuffed, dark, creeping back as
 * tiny blue-cored embers — and very often caught by the next gust before they
 * have grown back, exactly as asked.
 *
 * GUTTERING is widened too: it starts at a gentler draught, goes deeper, and
 * carries a fast struggling flicker while the flame fights the wind, and a
 * regrowing flame gutters harder (it is weak).
 *
 * Both the flame sprite (`candle-flame-render.js`) and its cast light
 * (`lighting/animations/candle-flicker.js`) build THIS state from the same
 * field at the same wick, so the light goes out and comes back with its flame.
 * Callers hoist it to the vertex stage — it is constant across a candle.
 *
 * Pure TSL builder; TSL passed in.
 *
 * @module effects/candle-wind-state
 */

import { getSafeProfile } from '../core/safe-mode.js';

/** Field magnitude (strength units — `wind-access.js#strengthNode`) where a
 *  flame starts to gutter, and over which it reaches full gutter. Gentler and
 *  wider than the old 0.14 / 0.09, so there is a long struggle before it goes. */
export const CANDLE_GUTTER_MAG_LOW = 0.08;
export const CANDLE_GUTTER_MAG_RANGE = 0.17;
/** Where a gust starts to snuff, and is certain to. Unchanged real speeds (~4 and ~7 m/s). */
export const CANDLE_SNUFF_MAG_LOW = 0.27;
export const CANDLE_SNUFF_MAG_HIGH = 0.4;
/** How long a snuffed candle stays fully dark, seconds. */
export const CANDLE_DARK_S = 2.2;
/** When the regrowth completes, seconds after the snuffing gust. Must stay
 *  inside the look-back window ({@link CANDLE_HISTORY_STEP_S} × taps). */
export const CANDLE_REGROW_END_S = 7.5;
/** The look-back ladder: one past sample every this many seconds… */
export const CANDLE_HISTORY_STEP_S = 0.6;
/** …this many of them (covers 0 to ~8 s). */
export const CANDLE_HISTORY_TAPS = 14;

/**
 * A recorded history with the candle's own wind response folded into every tap — the response multiplies
 * the magnitude before it is judged against the snuff threshold, exactly as it does for the analytic
 * ladder (`magAt`) and for `magNow`.
 * @param {{tap: (k: number) => *, gridIndex: *, stepSec: number, taps?: number}|null|undefined} history
 * @param {*} response - float node.
 * @returns {{tap: (k: number) => *, gridIndex: *, stepSec: number, taps?: number}|undefined}
 */
export function scaleCandleHistory(history, response) {
  return history ? { ...history, tap: (k) => history.tap(k).mul(response) } : undefined;
}

/**
 * How lit a flame is, `CANDLE_DARK_S`… after a snuff of strength `snuff01`, at
 * age `ageS` — plain JS twin of the shader's per-rung verdict, for the tests.
 * @param {number} snuff01 @param {number} ageS @returns {number} 0..1
 */
export function candleRecoveryAt(snuff01, ageS) {
  const s = Math.min(1, Math.max(0, snuff01));
  const x = Math.min(1, Math.max(0, (ageS - CANDLE_DARK_S) / (CANDLE_REGROW_END_S - CANDLE_DARK_S)));
  const regrow = x * x * (3 - 2 * x);
  return 1 - s * (1 - regrow);
}

/**
 * @param {*} TSL
 * @param {object} a
 * @param {*} a.magNow - the wick's FULL wind magnitude now (strength units,
 *   × the candle's windResponse) — turbulence and all.
 * @param {(timeMsNode: *) => *} [a.magAt] - the wick's wind magnitude at a PAST
 *   clock value (ms), same units — the CHEAP coherent-only sampler
 *   (`wind-access.js#gustMagnitudeAt`), since it runs once per rung. The ANALYTIC
 *   ladder: 14 evaluations of the gust envelope inside the shader. Used only when
 *   there is no `history`.
 * @param {{tap: (k: number) => *, gridIndex: *, stepSec: number, taps?: number}} [a.history] - THE RECORDED
 *   PAST (`wind-access.js#gustHistory`, `world/wind-gust-history.js`): `tap(k)` reads the magnitude `k`
 *   moments before the latest from a texture the baker fills as the moments happen. Same numbers as the
 *   ladder, no noise in the shader — measured ~5.5 s less compile per pipeline. Preferred whenever given.
 * @param {*} a.timeMs - the shared clock (ms).
 * @param {*} [a.seed] - float node 0..1, a per-candle phase for the struggle flicker.
 * @param {boolean} [a.memory] - build the look-back ladder. Defaults to the crash ladder's current rung.
 * @returns {{alive01: *, gutter01: *, struggle: *}} float nodes. `alive01`: 1 =
 *   fully lit, 0 = out (regrowth rises through it). `gutter01`: how hard the
 *   flame is guttering NOW. `struggle`: a 0..1 multiplier to apply to the
 *   flame's brightness — fast, ragged dips while it fights the wind.
 */
export function buildCandleWindState(
  TSL,
  { magNow, magAt, history, timeMs, seed, memory = getSafeProfile().candleMemory }
) {
  const { float, vec2, smoothstep, clamp, min, max, floor, mx_noise_float: perlin } = TSL;
  const tSec = timeMs.mul(float(0.001));
  const step = float(CANDLE_HISTORY_STEP_S);
  const gridSec = floor(tSec.div(step)).mul(step);

  const snuffOf = (m) => smoothstep(float(CANDLE_SNUFF_MAG_LOW), float(CANDLE_SNUFF_MAG_HIGH), m);
  const recovery = (snuff, ageS) => {
    const regrow = smoothstep(float(CANDLE_DARK_S), float(CANDLE_REGROW_END_S), ageS);
    return float(1).sub(snuff.mul(float(1).sub(regrow)));
  };

  // NOW (age 0), then the fixed-grid ladder into the past. `memory` false (crash-ladder rung 1 and up,
  // core/safe-mode.js) builds NO ladder: the flame still gutters and dims while the wind is over the
  // threshold, it just does not remember a gust once it has passed.
  let alive = recovery(snuffOf(magNow), float(0));
  if (memory && history) {
    // THE RECORDED PAST. The latest moment's index is the baker's decision (a uniform), not a float32
    // `floor(t / step)` that could disagree with it by one moment for a frame at a boundary.
    const latestSec = history.gridIndex.mul(float(history.stepSec));
    const taps = Math.min(CANDLE_HISTORY_TAPS, history.taps ?? CANDLE_HISTORY_TAPS);
    for (let k = 0; k < taps; k++) {
      const age = tSec.sub(latestSec.sub(float(k * history.stepSec)));
      alive = min(alive, recovery(snuffOf(history.tap(k)), age));
    }
  } else if (memory && magAt) {
    // THE ANALYTIC LADDER — no recorded history on this handle (a lab, a test, the first frame).
    for (let k = 0; k < CANDLE_HISTORY_TAPS; k++) {
      const tapSec = gridSec.sub(float(k * CANDLE_HISTORY_STEP_S));
      const age = tSec.sub(tapSec);
      alive = min(alive, recovery(snuffOf(magAt(tapSec.mul(float(1000)))), age));
    }
  }

  // GUTTER — now, and harder while the flame is still weak from regrowing.
  const windGutter = clamp(
    magNow.sub(float(CANDLE_GUTTER_MAG_LOW)).div(float(CANDLE_GUTTER_MAG_RANGE)),
    float(0),
    float(1)
  );
  const gutter01 = clamp(max(windGutter, float(1).sub(alive).mul(float(0.6))), float(0), float(1));

  // THE STRUGGLE — fast ragged dips (two decorrelated octaves, ~5-11 Hz) that
  // only bite while guttering: the flame tearing and recovering in the draught.
  const ph = seed ?? float(0);
  const n = perlin(vec2(tSec.mul(float(5.3)), ph.mul(float(37))))
    .mul(float(0.6))
    .add(perlin(vec2(tSec.mul(float(11.1)), ph.mul(float(53)).add(float(9)))).mul(float(0.4)));
  const dips = smoothstep(float(-0.1), float(0.55), n);
  const struggle = float(1).sub(dips.mul(gutter01).mul(float(0.8)));

  return { alive01: clamp(alive, float(0), float(1)), gutter01, struggle };
}
