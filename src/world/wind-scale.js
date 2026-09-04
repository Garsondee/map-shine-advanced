/**
 * WHAT THE WIND DIAL ACTUALLY MEANS — the Beaufort scale, as the one place
 * `speed01` is given a real-world reading.
 *
 * ============================================================================
 * ⚠️ THE PROBLEM THIS SOLVES (mythica-machina-press#497 §3.2, Stage 1 / #498)
 * ============================================================================
 * `speed01` is a unitless 0..1 with no anchor, so nothing in the engine knew
 * what a hurricane WAS. Full dial could only ever mean "the same field, at
 * 1.0", which is why the author's report was *"1 wind doesn't actually look
 * hurricane"* — not a tuning miss, an absent definition. Real wind spans
 * 0 → ~35 m/s across Beaufort 0-12 and changes CHARACTER along the way, not
 * just magnitude.
 *
 * THE MAPPING, and every part of it is a real standard rather than a choice:
 *
 *   dial 0..100  →  speed01 0..1  →  Beaufort 0..12  →  metres per second
 *
 * `speed01` maps LINEARLY onto the Beaufort force number (`B = 12 × speed01`),
 * and force converts to speed by Beaufort's own defining relation:
 *
 * ```
 *   v = 0.836 · B^1.5   m/s
 * ```
 *
 * That formula lands on the MIDPOINT of each force's real speed band — B4 →
 * 6.7 m/s inside the 5.5-7.9 band, B6 → 12.3 inside 10.8-13.8, B12 → 34.8
 * above the 32.7 hurricane threshold — so the dial reads as the force it
 * claims at every stop, not just at the ends. `BEAUFORT_SCALE` below carries
 * the real band edges and the real land-observation criteria alongside, which
 * is what lets an effect (or a person) answer "should dust be lifting yet?"
 * from the number instead of by eye.
 *
 * ⚠️ THIS DOES NOT CHANGE THE FIELD'S OWN MAGNITUDE, DELIBERATELY. The wind
 * field still carries a normalised `speed01`, and every consumer keeps its own
 * existing px/s calibration — converting the field's output to real m/s would
 * rescale every tuned effect by ~35× in one commit, which is the same class of
 * silent, wide-blast-radius change the direction unification (#497 Stage 0)
 * had to be careful about. What lands here is the MEANING: the scale is now
 * defined, testable, and reportable, so Stage 2's `σ = I·U` and Taylor
 * advection have a real quantity to be built against rather than a vibe.
 *
 * PURE — no THREE, no Foundry, no TSL. Node-tested.
 *
 * @module world/wind-scale
 */

/** Beaufort's own defining coefficient: `v = 0.836 · B^1.5` m/s. Exported so
 *  `world/wind-field.js`'s Taylor advection converts the dial to a real px/sec
 *  through THIS relation rather than carrying a second copy of it. */
export const BEAUFORT_COEFFICIENT = 0.836;
/** The top of the scale. Force 12 is the last one; there is no 13. */
export const BEAUFORT_MAX = 12;

/**
 * The real scale — band edges in m/s (at the standard 10 m above open ground)
 * and the actual Beaufort land-observation criteria, which are what make the
 * numbers checkable against a scene rather than merely orderable.
 *
 * `minMetresPerSecond` is the LOWER edge of each force's band; force 0 starts
 * at 0 and force 12 has no upper edge.
 */
export const BEAUFORT_SCALE = Object.freeze([
  Object.freeze({ force: 0, minMetresPerSecond: 0, name: 'Calm', land: 'Smoke rises vertically' }),
  Object.freeze({
    force: 1,
    minMetresPerSecond: 0.5,
    name: 'Light air',
    land: 'Smoke drifts, showing wind direction; vanes do not move',
  }),
  Object.freeze({
    force: 2,
    minMetresPerSecond: 1.6,
    name: 'Light breeze',
    land: 'Wind felt on face; leaves rustle; vanes begin to move',
  }),
  Object.freeze({
    force: 3,
    minMetresPerSecond: 3.4,
    name: 'Gentle breeze',
    land: 'Leaves and small twigs in constant motion; light flags extended',
  }),
  Object.freeze({
    force: 4,
    minMetresPerSecond: 5.5,
    name: 'Moderate breeze',
    land: 'Raises dust and loose paper; small branches move',
  }),
  Object.freeze({
    force: 5,
    minMetresPerSecond: 8.0,
    name: 'Fresh breeze',
    land: 'Small trees in leaf begin to sway',
  }),
  Object.freeze({
    force: 6,
    minMetresPerSecond: 10.8,
    name: 'Strong breeze',
    land: 'Large branches in motion; umbrellas used with difficulty',
  }),
  Object.freeze({
    force: 7,
    minMetresPerSecond: 13.9,
    name: 'Near gale',
    land: 'Whole trees in motion; inconvenience walking against the wind',
  }),
  Object.freeze({
    force: 8,
    minMetresPerSecond: 17.2,
    name: 'Gale',
    land: 'Twigs break off trees; walking is seriously impeded',
  }),
  Object.freeze({
    force: 9,
    minMetresPerSecond: 20.8,
    name: 'Strong gale',
    land: 'Slight structural damage; chimney pots and slates removed',
  }),
  Object.freeze({
    force: 10,
    minMetresPerSecond: 24.5,
    name: 'Storm',
    land: 'Trees uprooted; considerable structural damage',
  }),
  Object.freeze({ force: 11, minMetresPerSecond: 28.5, name: 'Violent storm', land: 'Widespread damage' }),
  Object.freeze({ force: 12, minMetresPerSecond: 32.7, name: 'Hurricane', land: 'Devastation' }),
]);

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * The dial's own 0..1 as a CONTINUOUS Beaufort force. Not rounded — the
 * in-between values are real (dial 35 is force 4.2, a moderate breeze leaning
 * toward fresh), and rounding here would quantise the whole wind model to
 * thirteen steps.
 * @param {number} speed01 @returns {number} 0..12
 */
export function beaufortForSpeed01(speed01) {
  return clamp01(speed01) * BEAUFORT_MAX;
}

/** The inverse. @param {number} beaufort @returns {number} 0..1 */
export function speed01ForBeaufort(beaufort) {
  const b = Number(beaufort);
  if (!Number.isFinite(b)) return 0;
  return Math.min(1, Math.max(0, b / BEAUFORT_MAX));
}

/**
 * ⭐ THE DIAL IN REAL UNITS — `v = 0.836 · B^1.5` m/s.
 * Exactly 0 at a dead calm, by construction: `0^1.5 = 0`. That matters beyond
 * tidiness — Stage 1's whole point is that dial 0 is genuinely nothing, and a
 * speed scale with a floor in it would quietly reintroduce the very thing
 * `WIND_INDOOR_RESIDUAL` was deleted for.
 * @param {number} speed01 @returns {number} metres per second
 */
export function metresPerSecondForSpeed01(speed01) {
  return BEAUFORT_COEFFICIENT * Math.pow(beaufortForSpeed01(speed01), 1.5);
}

/** The inverse. @param {number} metresPerSecond @returns {number} 0..1 */
export function speed01ForMetresPerSecond(metresPerSecond) {
  const v = Number(metresPerSecond);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return speed01ForBeaufort(Math.pow(v / BEAUFORT_COEFFICIENT, 2 / 3));
}

/**
 * The Beaufort row a real speed falls in — the band whose lower edge it has
 * reached, so 12.3 m/s reads as force 6 (10.8-13.8) rather than as "about 6".
 * @param {number} metresPerSecond @returns {typeof BEAUFORT_SCALE[number]}
 */
export function beaufortRowForMetresPerSecond(metresPerSecond) {
  const v = Number.isFinite(Number(metresPerSecond)) ? Number(metresPerSecond) : 0;
  let row = BEAUFORT_SCALE[0];
  for (const candidate of BEAUFORT_SCALE) {
    if (v >= candidate.minMetresPerSecond) row = candidate;
    else break;
  }
  return row;
}

/**
 * Everything a human (or a probe line) wants about a dial position at once —
 * the force it really is, the speed in m/s, and the real land criterion that
 * says what should be VISIBLY happening at it. That last field is the one
 * that turns "is the wind doing the right thing at 35?" from a matter of taste
 * into a checkable claim: at force 4 dust and loose paper should be lifting
 * and small branches moving, or the model is wrong.
 *
 * @param {number} speed01
 * @returns {{speed01: number, beaufort: number, force: number,
 *   metresPerSecond: number, name: string, land: string}}
 */
export function describeWindSpeed01(speed01) {
  const s = clamp01(speed01);
  const beaufort = beaufortForSpeed01(s);
  const metresPerSecond = metresPerSecondForSpeed01(s);
  const row = beaufortRowForMetresPerSecond(metresPerSecond);
  return {
    speed01: s,
    beaufort,
    force: row.force,
    metresPerSecond,
    name: row.name,
    land: row.land,
  };
}
