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

// ─────────────────────────────────────────────────────────────────────────────
// ⭐ 2026-10-27 — THE DIAL IS NOW LINEAR IN METRES PER SECOND, TOPPING OUT AT 70
// ─────────────────────────────────────────────────────────────────────────────
// The author, looking at the wind overlay: *"At 50% it looks visually extremely
// mild compared to what I imagine 50% of the top wind speed recorded on earth
// would look like."* Under the Beaufort curve above, 50% was force 6 — 12 m/s, a
// strong breeze — because `B^1.5` spends the whole bottom half of the dial on
// breezes. She chose the linear reading (asked, answered): dial % is a % of a
// Category 5 hurricane's sustained wind, 70 m/s. 10% = 7 m/s breeze, 25% =
// 17.5 m/s gale, 50% = 35 m/s hurricane, 100% = 70 m/s.
//
// What this buys beyond the reading: `speed01` is now a LINEAR measure of real
// speed, so any field vector carried in dial units (`sampleWind`'s output is
// `flow × speed01 × gust`) converts to m/s by ONE multiply —
// `× WIND_DIAL_MAX_METRES_PER_SECOND` — and to world px/s by one more
// (`× pixelsPerMetre`). That is what lets every consumer (rain, snow,
// vegetation, gust fronts, trails) move at the SAME real speed as the field the
// overlay draws, instead of each carrying its own px/s calibration.
//
// The Beaufort table and its formula stay: they still answer "what force is
// this?" for the probe, now from the real m/s rather than from the dial.
// Saved scenes are converted by {@link speed01FromLegacyBeaufortDial} so a
// scene keeps the real speed it had.

/** The real speed at the top of the dial — a Category 5 hurricane's threshold
 *  (Saffir-Simpson, 1-minute sustained, ≥ 70 m/s). */
export const WIND_DIAL_MAX_METRES_PER_SECOND = 70;

/** Beaufort's own defining coefficient: `v = 0.836 · B^1.5` m/s. */
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
 * ⭐ THE DIAL IN REAL UNITS — linear, `v = 70 · speed01` m/s (see the block at
 * the top of this file). Exactly 0 at a dead calm, by construction — a speed
 * scale with a floor in it would quietly reintroduce the very thing
 * `WIND_INDOOR_RESIDUAL` was deleted for.
 * @param {number} speed01 @returns {number} metres per second
 */
export function metresPerSecondForSpeed01(speed01) {
  return clamp01(speed01) * WIND_DIAL_MAX_METRES_PER_SECOND;
}

/** The inverse. @param {number} metresPerSecond @returns {number} 0..1 */
export function speed01ForMetresPerSecond(metresPerSecond) {
  const v = Number(metresPerSecond);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(1, v / WIND_DIAL_MAX_METRES_PER_SECOND);
}

/** The continuous Beaufort force of a real speed, by Beaufort's own relation
 *  inverted (`B = (v / 0.836)^(2/3)`), capped at 12 — the scale has no 13.
 *  @param {number} metresPerSecond @returns {number} 0..12 */
export function beaufortForMetresPerSecond(metresPerSecond) {
  const v = Number(metresPerSecond);
  if (!Number.isFinite(v) || v <= 0) return 0;
  const b = Math.pow(v / BEAUFORT_COEFFICIENT, 2 / 3);
  // Snap float dust: a legacy dial of 1 round-trips to 11.9999999 and must still read force 12.
  return b >= BEAUFORT_MAX - 1e-6 ? BEAUFORT_MAX : b;
}

/**
 * The dial's own 0..1 as a CONTINUOUS Beaufort force. Not rounded — the
 * in-between values are real, and rounding would quantise the reading to
 * thirteen steps. Reaches 12 at ~50% (35 m/s); the top half of the dial is all
 * force 12, which is why {@link describeWindSpeed01} also reports a hurricane
 * category.
 * @param {number} speed01 @returns {number} 0..12
 */
export function beaufortForSpeed01(speed01) {
  return beaufortForMetresPerSecond(metresPerSecondForSpeed01(speed01));
}

/** The inverse (force → dial). @param {number} beaufort @returns {number} 0..1 */
export function speed01ForBeaufort(beaufort) {
  const b = Number(beaufort);
  if (!Number.isFinite(b) || b <= 0) return 0;
  return speed01ForMetresPerSecond(BEAUFORT_COEFFICIENT * Math.pow(Math.min(BEAUFORT_MAX, b), 1.5));
}

/**
 * ⭐ THE MIGRATION — a dial value saved under the OLD Beaufort curve (`B = 12 ×
 * dial`, `v = 0.836 · B^1.5`), converted to the linear dial that gives the SAME
 * real speed. A scene saved at the old 50% (12.3 m/s) reads 0.176 afterwards: it
 * keeps blowing exactly as hard as it did, it is only the dial's labelling that
 * moved. @param {number} legacySpeed01 @returns {number} 0..1
 */
export function speed01FromLegacyBeaufortDial(legacySpeed01) {
  return speed01ForMetresPerSecond(metresPerSecondForLegacyBeaufortDial(legacySpeed01));
}

/**
 * ⭐ THE WIND'S STRENGTH AS A 0..1 — Beaufort force ÷ 12, from the real speed.
 *
 * Many effects scale a LOOK (how far grass leans, how dense a squall reads, how
 * slanted the rain sheets are) on a 0..1 "how windy is it". Those were all
 * tuned against the old dial, whose 0..1 WAS force ÷ 12. This returns exactly
 * that quantity from the new linear dial, so every such look stays tuned to the
 * same real speed: 12.3 m/s still reads 0.5, hurricane force still reads 1.
 * Anything that MOVES with the wind should use the real speed instead
 * (`world/wind-field.js#windFieldPxPerSecPerUnit`) — that is what keeps rising
 * past hurricane force.
 * @param {number} speed01 @returns {number} 0..1
 */
export function windStrength01ForSpeed01(speed01) {
  return beaufortForSpeed01(speed01) / BEAUFORT_MAX;
}

/**
 * ⭐ THE SPACE A WIND FADE TRAVELS IN — `speed01^(2/3)`, Beaufort's own shape
 * without its cap at 12, so it runs the whole dial and inverts exactly.
 *
 * Author, fading 0 → 100% over a minute: *"wind thrashes vegetation to insane
 * amounts very quickly"*. Every LOOK reads {@link windStrength01ForSpeed01},
 * which is steep at the bottom: a fade linear in m/s put the vegetation at ~35%
 * of its look six seconds into a one-minute fade, and at full hurricane look by
 * 28 s. Strength is `∝ speed^(2/3)` below hurricane force, so fading THIS
 * raises the look in a straight line — hurricane at ~60% of the Fade Time (the
 * dial's remaining range is beyond-hurricane, where only the speed still grows).
 * @param {number} speed01 @returns {number} 0..1
 */
export function windPerceived01ForSpeed01(speed01) {
  return Math.pow(clamp01(speed01), 2 / 3);
}

/** The inverse of {@link windPerceived01ForSpeed01}. @param {number} perceived01 @returns {number} 0..1 */
export function speed01ForWindPerceived01(perceived01) {
  return Math.pow(clamp01(perceived01), 1.5);
}

/**
 * The real speed an OLD-curve dial value meant — for an effect whose own Studio
 * parameter was authored as a 0..1 on the old Beaufort dial (cloud drift's
 * floor) and must keep meaning the same real speed.
 * @param {number} legacySpeed01 @returns {number} metres per second
 */
export function metresPerSecondForLegacyBeaufortDial(legacySpeed01) {
  return BEAUFORT_COEFFICIENT * Math.pow(clamp01(legacySpeed01) * BEAUFORT_MAX, 1.5);
}

/**
 * Saffir-Simpson hurricane categories (1-minute sustained, m/s lower edges) —
 * what the top half of the new dial means, since Beaufort stops at 12.
 */
export const SAFFIR_SIMPSON_SCALE = Object.freeze([
  Object.freeze({ category: 1, minMetresPerSecond: 33, land: 'Some damage: roofs, gutters, large branches snap' }),
  Object.freeze({ category: 2, minMetresPerSecond: 43, land: 'Extensive damage: shallow-rooted trees uprooted' }),
  Object.freeze({ category: 3, minMetresPerSecond: 50, land: 'Devastating: many trees snapped or uprooted' }),
  Object.freeze({ category: 4, minMetresPerSecond: 58, land: 'Catastrophic: most trees snapped, roofs lost' }),
  Object.freeze({ category: 5, minMetresPerSecond: 70, land: 'Catastrophic: framed houses destroyed' }),
]);

/** The hurricane category a speed reaches, or 0 below Category 1.
 *  @param {number} metresPerSecond @returns {number} 0..5 */
export function hurricaneCategoryForMetresPerSecond(metresPerSecond) {
  const v = Number.isFinite(Number(metresPerSecond)) ? Number(metresPerSecond) : 0;
  let category = 0;
  for (const row of SAFFIR_SIMPSON_SCALE) if (v >= row.minMetresPerSecond) category = row.category;
  return category;
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
 * Above force 12 the name carries the hurricane category and `land` that
 * category's damage criterion, since Beaufort itself stops describing there.
 *
 * @param {number} speed01
 * @returns {{speed01: number, beaufort: number, force: number, category: number,
 *   metresPerSecond: number, name: string, land: string}}
 */
export function describeWindSpeed01(speed01) {
  const s = clamp01(speed01);
  const beaufort = beaufortForSpeed01(s);
  const metresPerSecond = metresPerSecondForSpeed01(s);
  const row = beaufortRowForMetresPerSecond(metresPerSecond);
  const category = hurricaneCategoryForMetresPerSecond(metresPerSecond);
  const hurricane = category > 0 ? SAFFIR_SIMPSON_SCALE[category - 1] : null;
  return {
    speed01: s,
    beaufort,
    force: row.force,
    category,
    metresPerSecond,
    name: hurricane ? `Hurricane, Category ${category}` : row.name,
    land: hurricane ? hurricane.land : row.land,
  };
}
