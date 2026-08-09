/**
 * CANDLE AUTO-IGNITE — the pure day/night dice-roll math behind
 * `effects/candle-flame.js`'s effect-wide `autoIgniteEnabled` /
 * `dayIgniteChancePct` / `nightIgniteChancePct` / `igniteReliabilityPct`
 * params and `scene/anchor-catalog.js`'s per-candle `autoIgnite` opt-out.
 *
 * Author's brief (2026-08-06): candles get a % chance of being lit that
 * depends on whether it is day or night, so "when the actual clock changes
 * in the MSA control panel some candles will turn on and some off
 * automatically, giving the scene a bit of spontaneous life" — optional,
 * default 25% by day / 85% by night. A single "Reliability" slider tames
 * the dice roll, author-chosen model: **Reliability scales the odds down**
 * — at 100% the configured Day/Night chance applies exactly; below that, the
 * chance shrinks toward zero, so 0% Reliability never lights a candle at all,
 * day or night, regardless of the roll.
 *
 * ============================================================================
 * WHY EACH CANDLE GETS ONE STABLE ROLL, SHARED BY BOTH DAY AND NIGHT
 * ============================================================================
 *
 * A candle must not flicker on/off between two checks of an otherwise
 * unchanged scene — only a real dawn/dusk crossing (or a GM retuning the
 * sliders) may change its outcome (boot.js#refreshCandleIgnition is the only
 * caller, and only re-rolls on those triggers). So each candle's "how lucky
 * is it" draw is derived DETERMINISTICALLY from its own anchor id
 * (`stableUnit01`) rather than from `Math.random()` — the same candle always
 * has the same draw, compared fresh against whichever phase's threshold is
 * currently in force. This also means a candle has a consistent "personality"
 * across day and night (a lucky draw tends to stay lit in both phases, an
 * unlucky one in neither) while the AGGREGATE lit fraction across many
 * candles still lands at the configured percentage either phase, since draws
 * are uniformly distributed over the whole candle population.
 *
 * @module effects/candle-ignite
 */

/**
 * A stable pseudo-random value in [0,1) for one candle, derived from its own
 * anchor id. FNV-1a: cheap, well-distributed, no dependency, and — unlike
 * `Math.random()` — deterministic across a save/reload and safe to call every
 * frame without drifting.
 * @param {string} id
 * @returns {number} 0..1
 */
export function stableUnit01(id) {
  const s = String(id ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0xffffffff;
}

/** @param {*} v @returns {number} 0..100, non-finite/out-of-range folds to the nearer bound. */
function clampPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/**
 * Should ONE candle be lit right now, per the day/night auto-ignite dice
 * roll? Pure — the caller supplies the current phase, the configured
 * chances, and the candle's own stable roll (`stableUnit01(anchor.id)`).
 *
 * @param {object} args
 * @param {boolean} args.isDay - `world/sun.js#computeSun(todHour).aboveHorizon`.
 * @param {number} args.dayChancePct - 0..100, the configured day chance.
 * @param {number} args.nightChancePct - 0..100, the configured night chance.
 * @param {number} args.reliabilityPct - 0..100; scales the chosen chance down (100 = no scaling, 0 = always off).
 * @param {number} args.roll01 - this candle's own `stableUnit01(id)`, 0..1.
 * @returns {boolean}
 */
export function shouldAutoIgnite({ isDay, dayChancePct, nightChancePct, reliabilityPct, roll01 }) {
  const basePct = clampPct(isDay ? dayChancePct : nightChancePct);
  const effectivePct = basePct * (clampPct(reliabilityPct) / 100);
  return Number(roll01) < effectivePct / 100;
}
