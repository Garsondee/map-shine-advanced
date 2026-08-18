/**
 * THE MOON — a pure projection of `worldTime`, per Almanac Testament §5.4.
 *
 * The astrolabe's mock moon (UM.2) accumulated its phase INCREMENTALLY from
 * signed hour-motion deltas — a second clock, of exactly the shape Law 1
 * forbids ("worldTime is the ONLY clock... no parallel accumulation"). This
 * module is its replacement: `phase = f(worldTime)`, so every client derives
 * the identical phase from the identical number, stable across a reload with
 * no state to resume.
 *
 * Config-driven and calendar-agnostic on purpose — this module names no
 * moon. Golarion's own moon is left for stage A4, deliberately: the
 * Testament is explicit that its NAME is "not a thing any model asserts from
 * memory," and a synodic period tuned to unverified lore would be the exact
 * same mistake one field over. Earth's Luna (real astronomy, not homebrew
 * lore) is safe to ship as the one concrete config, and lives beside the
 * calendar data in `world/calendar/calendars/`.
 *
 * @module world/calendar/moon
 */

/** Standard eight-phase nomenclature, in order starting from New. */
const PHASE_NAMES = Object.freeze([
  'New Moon',
  'Waxing Crescent',
  'First Quarter',
  'Waxing Gibbous',
  'Full Moon',
  'Waning Gibbous',
  'Last Quarter',
  'Waning Crescent',
]);

/**
 * @typedef {{synodicDays: number, phaseAnchorSeconds: number}} MoonConfig
 *   `phaseAnchorSeconds` is a `worldTime` value at which the moon is exactly
 *   new (`phase01 === 0`) — any anchor works; the projection is periodic.
 */

/**
 * @param {number} worldTimeSeconds
 * @param {MoonConfig} moon
 * @returns {{phase01: number, phaseName: string, ageDays: number}} `phase01`
 *   in [0, 1): 0 = new, 0.5 = full. `ageDays` in [0, synodicDays): days since
 *   the most recent new moon.
 */
export function moonPhaseAt(worldTimeSeconds, moon) {
  const synodicSeconds = moon.synodicDays * 86400;
  const elapsed = worldTimeSeconds - moon.phaseAnchorSeconds;
  // Wrap into [0, synodicSeconds) — JS `%` keeps the dividend's sign, so a
  // negative `elapsed` (worldTime before the anchor) needs the usual
  // "add the modulus, mod again" idiom to land positive.
  const wrapped = ((elapsed % synodicSeconds) + synodicSeconds) % synodicSeconds;
  const phase01 = wrapped / synodicSeconds;
  const ageDays = wrapped / 86400;
  const bucket = Math.floor(phase01 * 8 + 0.5) % 8;
  return { phase01, phaseName: PHASE_NAMES[bucket], ageDays };
}

export { PHASE_NAMES };
