/**
 * THE CALENDAR CONTRACT — what a calendar IS, validated at declaration time.
 *
 * Mirrors Foundry v14's own `CalendarData` schema (`client/data/calendar.mjs`,
 * receipted in `docs/holy/Almanac-Testament.md` §3.1) field-for-field, plus
 * the small set of MSA extensions the Almanac actually needs: which ENGINE
 * projects this calendar (`'declarative'` rides Foundry's own native leap
 * arithmetic unmodified; `'true-gregorian'` is the one lawful exception,
 * `core/gregorian-math.js`), an `epochOffsetSeconds` anchor for a mid-year
 * epoch (PF2E's `worldCreatedOn`), and an optional `themes` table for
 * calendars that project several display identities off one structure (the
 * five PF2E date themes off one Gregorian-shaped calendar).
 *
 * Testament §8 Law 8: *"THE CALENDAR IS DATA."* This module is the lock —
 * the same "validation at the write, not a repair shop at the boundary"
 * doctrine `core/params-schema.js` established for effect params, applied to
 * calendar declarations. A malformed calendar fails HERE, at authoring time,
 * never silently at the point some far-away consumer tries to decompose a
 * date and gets `NaN`.
 *
 * @module world/calendar/calendar-schema
 */

/** The two engines a calendar may declare. See this module's header. */
export const CALENDAR_ENGINES = Object.freeze(['declarative', 'true-gregorian']);

/**
 * @typedef {{name: string, abbreviation?: string, ordinal: number, days: number, leapDays?: number}} MonthDef
 * @typedef {{name: string, abbreviation?: string, ordinal: number}} WeekdayDef
 * @typedef {{name: string, abbreviation?: string, monthStart: number|null, monthEnd: number|null, dayStart: number|null, dayEnd: number|null}} SeasonDef
 * @typedef {{id: string, yearOffset: number, eraLabel: string, monthNames?: Record<string,string>, weekdayNames?: Record<string,string>}} CalendarTheme
 */

/**
 * @typedef {object} CalendarConfig
 * @property {string} name
 * @property {string} [description]
 * @property {'declarative'|'true-gregorian'} engine
 * @property {{yearZero: number, firstWeekday: number, leapYear: {leapStart: number, leapInterval: number}|null}} years
 * @property {{values: MonthDef[]}} months
 * @property {{values: WeekdayDef[], daysPerYear: number, hoursPerDay: number, minutesPerHour: number, secondsPerMinute: number}} days
 * @property {{values: SeasonDef[]}|null} [seasons]
 * @property {number} [epochOffsetSeconds] - required when `engine === 'true-gregorian'`;
 *   seconds from THIS calendar's own year-0/day-0/hour-0 to `worldTime === 0`.
 * @property {CalendarTheme[]} [themes] - alternate display identities over
 *   one structure (PF2E's AR/IC/AG/AD/CE off one Gregorian shape).
 * @property {string} [divergesFromPf2e] - present ONLY on a calendar that
 *   deliberately does not match the PF2E World Clock (Testament §5.1's
 *   lore-strict variant); the warning text shown wherever the calendar is
 *   offered as a choice.
 */

/** @param {*} v @returns {boolean} */
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
/** @param {*} v @returns {boolean} */
function isPositiveNumber(v) {
  return isFiniteNumber(v) && v > 0;
}
/** @param {*} v @returns {boolean} */
function isNonBlankString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Validate a calendar declaration. Never throws — every rejection is a
 * message in `errors`, the same discipline `validateParamsSchema` uses
 * (`core/params-schema.js`), so a caller can report every problem at once
 * rather than fixing one authoring mistake per run.
 *
 * @param {*} config
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateCalendarConfig(config) {
  const errors = [];
  const fail = (msg) => errors.push(msg);

  if (!config || typeof config !== 'object') {
    return { ok: false, errors: ['calendar config must be an object'] };
  }

  if (!isNonBlankString(config.name)) fail("'name' must be a non-blank string");
  if (!CALENDAR_ENGINES.includes(config.engine)) {
    fail(`'engine' must be one of ${CALENDAR_ENGINES.join('/')}, got ${JSON.stringify(config.engine)}`);
  }

  // ---- years --------------------------------------------------------------
  const years = config.years;
  if (!years || typeof years !== 'object') {
    fail("'years' must be an object");
  } else {
    if (!Number.isInteger(years.yearZero)) fail("'years.yearZero' must be an integer");
    if (!Number.isInteger(years.firstWeekday) || years.firstWeekday < 0) {
      fail("'years.firstWeekday' must be a non-negative integer");
    }
    if (years.leapYear !== null) {
      if (!years.leapYear || typeof years.leapYear !== 'object') {
        fail("'years.leapYear' must be null or an object");
      } else {
        if (!Number.isInteger(years.leapYear.leapStart)) fail("'years.leapYear.leapStart' must be an integer");
        if (!Number.isInteger(years.leapYear.leapInterval) || years.leapYear.leapInterval < 2) {
          fail("'years.leapYear.leapInterval' must be an integer >= 2");
        }
      }
    }
  }

  // ---- months ---------------------------------------------------------------
  const months = config.months?.values;
  if (!Array.isArray(months) || months.length === 0) {
    fail("'months.values' must be a non-empty array");
  } else {
    months.forEach((m, i) => {
      if (!isNonBlankString(m?.name)) fail(`months.values[${i}].name must be a non-blank string`);
      if (!Number.isInteger(m?.ordinal) || m.ordinal < 1)
        fail(`months.values[${i}].ordinal must be a positive integer`);
      if (!isPositiveNumber(m?.days) || !Number.isInteger(m.days))
        fail(`months.values[${i}].days must be a positive integer`);
      if (m?.leapDays !== undefined && (!Number.isInteger(m.leapDays) || m.leapDays < 1)) {
        fail(`months.values[${i}].leapDays, if present, must be a positive integer`);
      }
    });
  }

  // ---- days -----------------------------------------------------------------
  const days = config.days;
  if (!days || typeof days !== 'object') {
    fail("'days' must be an object");
  } else {
    const weekdays = days.values;
    if (!Array.isArray(weekdays) || weekdays.length === 0) {
      fail("'days.values' (the weekday cycle) must be a non-empty array");
    } else {
      weekdays.forEach((w, i) => {
        if (!isNonBlankString(w?.name)) fail(`days.values[${i}].name must be a non-blank string`);
        if (!Number.isInteger(w?.ordinal) || w.ordinal < 1)
          fail(`days.values[${i}].ordinal must be a positive integer`);
      });
    }
    for (const field of ['daysPerYear', 'hoursPerDay', 'minutesPerHour', 'secondsPerMinute']) {
      if (!isPositiveNumber(days[field])) fail(`days.${field} must be a positive number`);
    }
  }

  // ---- seasons (optional) -----------------------------------------------
  if (config.seasons !== undefined && config.seasons !== null) {
    const seasons = config.seasons?.values;
    if (!Array.isArray(seasons)) {
      fail("'seasons.values' must be an array when 'seasons' is present");
    } else {
      seasons.forEach((s, i) => {
        if (!isNonBlankString(s?.name)) fail(`seasons.values[${i}].name must be a non-blank string`);
      });
    }
  }

  // ---- engine-specific requirements ---------------------------------------
  if (config.engine === 'true-gregorian') {
    if (!isFiniteNumber(config.epochOffsetSeconds)) {
      fail("'epochOffsetSeconds' is required and must be a finite number when engine === 'true-gregorian'");
    }
    // The true-Gregorian engine hardcodes real 4/100/400 leap arithmetic
    // (core/gregorian-math.js) — a declared `years.leapYear` would be
    // silently ignored, which is exactly the "control that changes nothing"
    // disease `params/no-dead-controls` exists to catch one layer up.
    if (config.years && config.years.leapYear !== null) {
      fail(
        "'years.leapYear' must be null when engine === 'true-gregorian' — the real leap rule is hardcoded, a declared one would be dead data"
      );
    }
  }

  // ---- themes (optional) --------------------------------------------------
  if (config.themes !== undefined) {
    if (!Array.isArray(config.themes) || config.themes.length === 0) {
      fail("'themes', if present, must be a non-empty array");
    } else {
      const seenIds = new Set();
      config.themes.forEach((th, i) => {
        if (!isNonBlankString(th?.id)) fail(`themes[${i}].id must be a non-blank string`);
        else if (seenIds.has(th.id)) fail(`themes[${i}].id '${th.id}' is a duplicate`);
        else seenIds.add(th.id);
        if (!Number.isInteger(th?.yearOffset)) fail(`themes[${i}].yearOffset must be an integer`);
        if (typeof th?.eraLabel !== 'string') fail(`themes[${i}].eraLabel must be a string (may be empty)`);
      });
    }
  }

  if (config.divergesFromPf2e !== undefined && !isNonBlankString(config.divergesFromPf2e)) {
    fail("'divergesFromPf2e', if present, must be a non-blank string (the warning shown to the GM)");
  }

  return { ok: errors.length === 0, errors };
}
