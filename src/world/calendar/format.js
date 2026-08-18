/**
 * THE DATE LINE — turning calendar components into the string a GM reads.
 *
 * Deliberately dumb: every input (`components`, the calendar's month/weekday
 * NAME tables, and a `theme`) already carries the truth; this module only
 * looks values up and glues a template around them. No leap arithmetic, no
 * worldTime — those questions are answered upstream (`core/gregorian-math.js`
 * for the engine, Foundry's own `game.time.components` for the live read),
 * so a formatting bug here can never desync a date, only mis-SPELL one.
 *
 * The template — `"{weekday}, {day} of {month}, {year} {era}"` — is PF2E's
 * own, verbatim (`lang/en.json`, receipted in the Almanac Testament §3.2),
 * because Testament Law 5 demands the parity be exact and a different
 * punctuation choice is still a way to fail a side-by-side screenshot.
 *
 * ⚠️ ONE DELIBERATE SIMPLIFICATION, not a silent gap: PF2E's own "CE"
 * (unthemed) display bypasses this template entirely and uses Luxon's
 * locale-formatted `DATE_HUGE` instead (a different English phrasing, same
 * underlying date). Reproducing that exact phrasing needs a locale-formatting
 * library this project does not otherwise depend on, for a COSMETIC string
 * difference on a calendar whose whole point is "no theme, no era" — the
 * DATE itself (year/month/day, real Gregorian, offset 0) is unaffected.
 * Testament Law 5 is about the projected DATE/TIME being exact, which this
 * keeps; the exact prose of the untethered "CE" label is a §11-fork-adjacent
 * taste question, not a parity bug, and is named here so nobody mistakes the
 * uniform template below for having missed it.
 *
 * @module world/calendar/format
 */

/**
 * English ordinal suffix. The 11th/12th/13th exception is the one rule that
 * trips a naive "check the last digit" implementation.
 * @param {number} n - a positive integer (a day-of-month, 1-indexed)
 * @returns {string} e.g. "1st", "2nd", "3rd", "4th", "11th", "21st"
 */
export function ordinalString(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * @typedef {{year: number, month: number, dayOfMonth: number, dayOfWeek: number, hour: number, minute: number, second: number}} DateComponents
 *   `month`/`dayOfMonth`/`dayOfWeek` are 0-indexed (Foundry's own `TimeComponents` convention).
 */

/**
 * @param {DateComponents} components
 * @param {import('./calendar-schema.js').CalendarConfig} calendarConfig
 * @param {import('./calendar-schema.js').CalendarTheme} [theme] - omit for
 *   the calendar's own base names/offset-0 year (Earth's only mode).
 * @returns {string}
 */
export function formatThemedDate(components, calendarConfig, theme) {
  const monthDef = calendarConfig.months.values[components.month];
  const weekdayDef = calendarConfig.days.values[components.dayOfWeek];
  const baseMonthName = monthDef?.name ?? '';
  const baseWeekdayName = weekdayDef?.name ?? '';
  const month = theme?.monthNames?.[baseMonthName] ?? baseMonthName;
  const weekday = theme?.weekdayNames?.[baseWeekdayName] ?? baseWeekdayName;
  const day = ordinalString(components.dayOfMonth + 1);
  const year = components.year + (theme?.yearOffset ?? 0);
  const era = theme?.eraLabel ?? '';
  return era ? `${weekday}, ${day} of ${month}, ${year} ${era}` : `${weekday}, ${day} of ${month}, ${year}`;
}

/**
 * @param {DateComponents} components
 * @param {{convention?: 12|24}} [options]
 * @returns {string} "14:30:45" (24h) or "2:30:45 PM" (12h)
 */
export function formatThemedTime(components, { convention = 24 } = {}) {
  const pad2 = (n) => String(n).padStart(2, '0');
  const h = components.hour;
  const m = components.minute;
  const s = components.second;
  if (convention === 24) return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  const period = h < 12 ? 'AM' : 'PM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${pad2(m)}:${pad2(s)} ${period}`;
}
