/**
 * THE TRUE-GREGORIAN ENGINE — the one lawful exception to "calendars are data"
 * (docs/holy/Almanac-Testament.md §5.2).
 *
 * Foundry v14's own `CalendarData` ships a "Simplified Gregorian" calendar
 * whose leap rule is a bare 4-year interval (`years.leapYear.leapInterval`) —
 * NOT the real 4/100/400 rule (verified against `client/data/calendar.mjs` by
 * a vendored-source sweep, 2026-08-17; century years like 2100 would wrongly
 * get a Feb 29 under core's own default). PF2E parity and a genuine Earth
 * calendar both need the real rule, and core's declarative vocabulary
 * (`leapInterval`) cannot express it — so this module exists to be the ONE
 * place that does, matched-pair, round-trip-exact, and independent of any
 * unverified Foundry internals.
 *
 * ============================================================================
 * WHY THIS LIVES IN core/, NOT world/
 * ============================================================================
 *
 * `world/almanac.js` is where the Almanac's calendar DATA and FORMATTING
 * live, and it is pure/Foundry-agnostic like every other world/ module. But
 * the actual `CalendarData` subclass that Foundry installs (`CONFIG.time.
 * worldCalendarClass`) can only be built inside `src/foundry/` — that is
 * where every reference to a Foundry-provided class belongs, and
 * `foundry/index.js`'s own header is explicit: *"foundry/ IS A LEAF. It
 * imports nothing above itself."* (Confirmed empirically the same session:
 * zero existing `src/foundry/**` file imports anything from `src/world/`.)
 * So the subclass's overridden methods need this math reachable from
 * `foundry/` WITHOUT crossing that leaf boundary — and `core/` is the one
 * zone exempted from the door requirement (`zones/one-door`'s own comment:
 * *"core is the standard library — its files are individually public"*).
 * Two copies of this arithmetic (one for the installed calendar, one for
 * MSA's own display/fixture math) would be exactly the "shared field, two
 * registries" drift class this project's memory warns about, so there is
 * only ever ONE copy, living where both `core-exempt` zones can reach it.
 *
 * ============================================================================
 * THE ALGORITHM — Howard Hinnant's civil-calendar arithmetic
 * ============================================================================
 *
 * `daysFromCivil`/`civilFromDays` are the well-known closed-form conversions
 * between a proleptic-Gregorian (y, m, d) and a day count relative to the
 * Unix epoch (1970-01-01) — correct for the ENTIRE representable range,
 * including year 0 and negative (BCE-ish) years, with no iteration and no
 * leap-year table. Public-domain; the same algorithm underlies
 * `std::chrono::year_month_day` in major C++ standard libraries.
 *
 * Every line of it is cross-validated in this module's test file against an
 * INDEPENDENT oracle — `Date#setUTCFullYear`/`getUTCFullYear` (confirmed,
 * 2026-08-17, NOT subject to the legacy two-digit-year remap that
 * `Date.UTC`/`new Date(y,...)` apply, verified live: `setUTCFullYear(0,0,1)`
 * yields real year 0, not 1900) — across hundreds of dates, negative years,
 * and every leap-rule edge (2000 leap, 2100 not, 2024 leap, 1900 not). A
 * formula recalled from memory is a hypothesis, never a fact, until it has
 * been checked against something that was not typed from the same memory.
 *
 * @module core/gregorian-math
 */

/**
 * The real Gregorian leap rule: every 4th year, except centuries, except
 * every 400th. (Core's own "Simplified Gregorian" only has the first clause.)
 * @param {number} year
 * @returns {boolean}
 */
export function isGregorianLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * Proleptic-Gregorian (year, month 1-12, day 1-31) → days since 1970-01-01.
 * Exact for any integer year, including 0 and negative years. Floor-division
 * throughout (`Math.floor`, never `/` alone) — JS's `/` truncates toward
 * zero, which is wrong for the negative operands this algorithm requires.
 *
 * @param {number} year
 * @param {number} month - 1..12
 * @param {number} day - 1..31 (or any day-of-month value; callers that walk
 *   a month table pass values already known valid)
 * @returns {number} integer days, signed
 */
export function daysFromCivil(year, month, day) {
  const y = year - (month <= 2 ? 1 : 0);
  // ⚠️ Hinnant's published C++ writes this era step as
  // `(y >= 0 ? y : y - 399) / 400` — a manual compensation for C++'s
  // TRUNCATING `/` operator. `Math.floor` already performs true floor
  // division on its own; layering that same compensation on TOP of a real
  // floor double-corrects the sign and silently mis-eras every negative
  // year (caught live, 2026-08-17, by this file's own oracle cross-check —
  // `daysFromCivil(-1,1,1)` was off by exactly one day before this fix).
  // Do not "restore" the C++ idiom here; `Math.floor(y / 400)` IS the floor.
  const era = Math.floor(y / 400);
  const yoe = y - era * 400; // [0, 399]
  const mp = month + (month > 2 ? -3 : 9); // [0, 11], March-based
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // [0, 146096]
  return era * 146097 + doe - 719468;
}

/**
 * The inverse of {@link daysFromCivil}: days since 1970-01-01 → proleptic
 * Gregorian (year, month, day).
 * @param {number} totalDays - integer, signed
 * @returns {{year: number, month: number, day: number}} month 1..12, day 1..31
 */
export function civilFromDays(totalDays) {
  const z = totalDays + 719468;
  // Same correction as daysFromCivil's era — see its comment. Plain floor,
  // no truncating-division compensation layered on top.
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097; // [0, 146096]
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365); // [0, 399]
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)); // [0, 365]
  const mp = Math.floor((5 * doy + 2) / 153); // [0, 11]
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1; // [1, 31]
  const month = mp + (mp < 10 ? 3 : -9); // [1, 12]
  return { year: y + (month <= 2 ? 1 : 0), month, day };
}

/**
 * @typedef {{hoursPerDay: number, minutesPerHour: number, secondsPerMinute: number, values?: unknown[]}} DayUnits
 *   `values`, when present, is the weekday-name cycle — only its LENGTH is
 *   used here (for the weekday modulus); names are `world/calendar/format.js`'s concern.
 * @typedef {{values: Array<{days: number, leapDays?: number}>}} MonthsConfig - 12 entries, Jan first
 */

/** @param {DayUnits} u @returns {number} */
function secondsPerDayOf(u) {
  return u.hoursPerDay * u.minutesPerHour * u.secondsPerMinute;
}

/**
 * THE NARROW CONTRACT — mirrors Foundry's own `CalendarData#_decomposeTimeYears`
 * exactly: absolute seconds → the completed-years split, `@protected` in core
 * precisely so a calendar needing a different leap rule can override it
 * (`client/data/calendar.mjs`, receipted in the Almanac Testament §3.1). This
 * is the ONLY piece a `CalendarData` subclass strictly needs from this module
 * for the read direction — everything else (month/day/weekday) is Foundry's
 * own generic walk, unchanged, consuming this result exactly as it consumes
 * core's own simplified engine's.
 *
 * @param {number} absoluteSeconds - seconds since THIS calendar's own epoch
 *   (year 0, day 0, hour 0) — never Foundry's raw `worldTime` directly; the
 *   caller applies its `epochOffsetSeconds` shift first.
 * @param {DayUnits} dayUnits
 * @returns {{year: number, second: number, leapYear: boolean}} `second` is
 *   the remainder within `year`, in [0, yearLengthSeconds).
 */
export function decomposeTrueGregorianYear(absoluteSeconds, dayUnits) {
  const secondsPerDay = secondsPerDayOf(dayUnits);
  const totalDays = Math.floor(absoluteSeconds / secondsPerDay);
  const daySeconds = absoluteSeconds - totalDays * secondsPerDay;
  const { year } = civilFromDays(totalDays);
  const startOfYearDays = daysFromCivil(year, 1, 1);
  const secondsIntoYear = (totalDays - startOfYearDays) * secondsPerDay + daySeconds;
  return { year, second: secondsIntoYear, leapYear: isGregorianLeapYear(year) };
}

/**
 * THE FULL CONTRACT, READ DIRECTION — a complete, self-contained decompose
 * (year through weekday), used where MSA needs full components without
 * depending on Foundry's own month/day walk being present (Node tests; the
 * Almanac's own formatting/fixture layer). Round-trip-exact with
 * {@link composeTrueGregorianTime} — proven in this module's own tests,
 * never assumed from the narrower contract above.
 *
 * Takes a whole `CalendarConfig`-shaped object (`world/calendar/calendar-
 * schema.js`) — `months`/`days`/`years` — the SAME shape every other caller
 * in this feature already passes around, rather than a bespoke wrapper only
 * this module would understand. One shape, everywhere; no translation layer
 * to let the two drift.
 *
 * @param {number} absoluteSeconds
 * @param {{months: MonthsConfig, days: {values: unknown[]} & DayUnits, years?: {firstWeekday?: number}}} calendarConfig
 * @returns {{year: number, month: number, dayOfMonth: number, dayOfWeek: number,
 *   hour: number, minute: number, second: number, leapYear: boolean}} `month`
 *   and `dayOfMonth` are 0-indexed (Foundry's own `TimeComponents` convention,
 *   receipted in the Almanac Testament §3.1h); `dayOfWeek` is 0-indexed too.
 */
export function decomposeTrueGregorianTime(absoluteSeconds, calendarConfig) {
  const dayUnits = calendarConfig.days;
  const secondsPerDay = secondsPerDayOf(dayUnits);
  const secondsPerHour = dayUnits.minutesPerHour * dayUnits.secondsPerMinute;
  const totalDays = Math.floor(absoluteSeconds / secondsPerDay);
  let daySeconds = absoluteSeconds - totalDays * secondsPerDay;
  const { year } = civilFromDays(totalDays);
  const leapYear = isGregorianLeapYear(year);
  let dayOfYear = totalDays - daysFromCivil(year, 1, 1); // 0-indexed

  const months = calendarConfig.months.values;
  let month = 0;
  for (; month < months.length; month++) {
    const monthDays = leapYear ? (months[month].leapDays ?? months[month].days) : months[month].days;
    if (dayOfYear < monthDays) break;
    dayOfYear -= monthDays;
  }

  const hour = Math.floor(daySeconds / secondsPerHour);
  daySeconds -= hour * secondsPerHour;
  const minute = Math.floor(daySeconds / dayUnits.secondsPerMinute);
  const second = daySeconds - minute * dayUnits.secondsPerMinute;

  const weekCount = Math.max(1, dayUnits.values?.length ?? 7);
  const firstWeekday = calendarConfig.years?.firstWeekday ?? 0;
  const dayOfWeek = (((totalDays + firstWeekday) % weekCount) + weekCount) % weekCount;

  return { year, month, dayOfMonth: dayOfYear, dayOfWeek, hour, minute, second, leapYear };
}

/**
 * THE FULL CONTRACT, WRITE DIRECTION — mirrors Foundry's own
 * `CalendarData#componentsToTime`, fully reimplemented rather than
 * delegating to any unverified base-class internal (the Almanac Testament
 * §3.1 receipt: `componentsToTime` does NOT call `_decomposeTimeYears`, so a
 * subclass that overrides only the read direction silently breaks the
 * inverse). Exact inverse of {@link decomposeTrueGregorianTime} for any
 * components it itself produced — proven by round-trip property tests, not
 * asserted.
 *
 * @param {{year?: number, month?: number, dayOfMonth?: number, hour?: number,
 *   minute?: number, second?: number}} components - `month`/`dayOfMonth`
 *   0-indexed, matching the decompose direction. Missing fields default to 0
 *   (Foundry's own `componentsToTime` contract, receipted §2b).
 * @param {{months: MonthsConfig, days: DayUnits}} calendarConfig - the same
 *   `CalendarConfig` shape {@link decomposeTrueGregorianTime} takes.
 * @returns {number} absolute seconds since this calendar's own epoch.
 */
export function composeTrueGregorianTime(components, calendarConfig) {
  const year = components.year ?? 0;
  const leapYear = isGregorianLeapYear(year);
  const monthIdx = components.month ?? 0;
  const months = calendarConfig.months.values;

  let dayOfYear = 0;
  for (let m = 0; m < monthIdx && m < months.length; m++) {
    dayOfYear += leapYear ? (months[m].leapDays ?? months[m].days) : months[m].days;
  }
  dayOfYear += components.dayOfMonth ?? 0;

  const totalDays = daysFromCivil(year, 1, 1) + dayOfYear;
  const dayUnits = calendarConfig.days;
  const secondsPerDay = secondsPerDayOf(dayUnits);
  const secondsPerHour = dayUnits.minutesPerHour * dayUnits.secondsPerMinute;
  const hourSeconds =
    (components.hour ?? 0) * secondsPerHour +
    (components.minute ?? 0) * dayUnits.secondsPerMinute +
    (components.second ?? 0);

  return totalDays * secondsPerDay + hourSeconds;
}
