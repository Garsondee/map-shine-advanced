/**
 * THE SHARED GREGORIAN SHAPE — the months/weekday tables `golarion-parity.js`
 * and `earth.js` both build on. One copy, so a month-length or weekday-order
 * fix never has to land twice (the same "shared field, two registries" drift
 * class this project's memory names in general — here, before it exists).
 *
 * @module world/calendar/calendars/gregorian-shape
 */

/** 31/28(29)/31/30/31/30/31/31/30/31/30/31 — real Gregorian, English names. */
export const GREGORIAN_MONTHS = Object.freeze({
  values: [
    Object.freeze({ name: 'January', ordinal: 1, days: 31 }),
    Object.freeze({ name: 'February', ordinal: 2, days: 28, leapDays: 29 }),
    Object.freeze({ name: 'March', ordinal: 3, days: 31 }),
    Object.freeze({ name: 'April', ordinal: 4, days: 30 }),
    Object.freeze({ name: 'May', ordinal: 5, days: 31 }),
    Object.freeze({ name: 'June', ordinal: 6, days: 30 }),
    Object.freeze({ name: 'July', ordinal: 7, days: 31 }),
    Object.freeze({ name: 'August', ordinal: 8, days: 31 }),
    Object.freeze({ name: 'September', ordinal: 9, days: 30 }),
    Object.freeze({ name: 'October', ordinal: 10, days: 31 }),
    Object.freeze({ name: 'November', ordinal: 11, days: 30 }),
    Object.freeze({ name: 'December', ordinal: 12, days: 31 }),
  ],
});

/**
 * Sunday-first — an internal ordering choice only, not a parity requirement:
 * PF2E parity rides the name DICTIONARIES (`golarion-parity.js`), which are
 * keyed by name, not by this array's position. `firstWeekday: 4` calibrates
 * "day 0" of `core/gregorian-math.js`'s internal (1970-relative) day count to
 * this array's index 4 (Thursday) — proven against the Date oracle in
 * `core/__tests__/gregorian-math.test.mjs`, not asserted here.
 */
export const GREGORIAN_WEEKDAYS = Object.freeze({
  values: [
    Object.freeze({ name: 'Sunday', ordinal: 1 }),
    Object.freeze({ name: 'Monday', ordinal: 2 }),
    Object.freeze({ name: 'Tuesday', ordinal: 3 }),
    Object.freeze({ name: 'Wednesday', ordinal: 4 }),
    Object.freeze({ name: 'Thursday', ordinal: 5 }),
    Object.freeze({ name: 'Friday', ordinal: 6 }),
    Object.freeze({ name: 'Saturday', ordinal: 7 }),
  ],
  daysPerYear: 365,
  hoursPerDay: 24,
  minutesPerHour: 60,
  secondsPerMinute: 60,
});

/** The `years` block every true-Gregorian calendar shares. */
export const GREGORIAN_YEARS = Object.freeze({ yearZero: 0, firstWeekday: 4, leapYear: null });
