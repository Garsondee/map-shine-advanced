/**
 * GOLARION — LORE-STRICT. The setting's OWN 8-year leap rule, as pure data
 * riding Foundry's native declarative `CalendarData` engine — no subclass,
 * no `core/gregorian-math.js` (Almanac Testament §5.1, §5.2).
 *
 * ⚠️ THIS CALENDAR DIVERGES FROM THE PF2E WORLD CLOCK BY DESIGN. PF2E's own
 * clock is real Gregorian math wearing Golarion names (`golarion-parity.js`'s
 * header explains why, receipted against the shipped source); THIS calendar
 * is what "Golarion actually has an 8-year leap cycle" would mean if taken
 * literally. The two will show different dates for the same `worldTime` on
 * any year that isn't a multiple of both cycles' anchors. `divergesFromPf2e`
 * below is the warning `calendar-schema.js` requires be shown wherever this
 * calendar is offered as a choice (Testament §8 Law 6's sibling for time:
 * an instrument that quietly disagrees with the platform's own clock is an
 * instrument that lies).
 *
 * `leapStart: 8` is a PLACEHOLDER anchor, not sourced Golarion canon — no
 * memory claim about which specific year the setting's own leap cycle
 * anchors to is asserted here (the same discipline the Almanac Testament
 * applies to the moon's name, §5.4). A GM who knows the real anchor changes
 * one number; nothing else in this file encodes an opinion about it.
 *
 * @module world/calendar/calendars/golarion-lore-strict
 */

import { GOLARION_MONTH_NAMES, AR_IC_WEEKDAY_NAMES } from './golarion-parity.js';

/** Golarion month names, spoken directly — no theme layer (one identity only). */
const LORE_MONTHS = Object.freeze({
  values: [
    Object.freeze({ name: GOLARION_MONTH_NAMES.January, ordinal: 1, days: 31 }),
    Object.freeze({ name: GOLARION_MONTH_NAMES.February, ordinal: 2, days: 28, leapDays: 29 }),
    Object.freeze({ name: GOLARION_MONTH_NAMES.March, ordinal: 3, days: 31 }),
    Object.freeze({ name: GOLARION_MONTH_NAMES.April, ordinal: 4, days: 30 }),
    Object.freeze({ name: GOLARION_MONTH_NAMES.May, ordinal: 5, days: 31 }),
    Object.freeze({ name: GOLARION_MONTH_NAMES.June, ordinal: 6, days: 30 }),
    Object.freeze({ name: GOLARION_MONTH_NAMES.July, ordinal: 7, days: 31 }),
    Object.freeze({ name: GOLARION_MONTH_NAMES.August, ordinal: 8, days: 31 }),
    Object.freeze({ name: GOLARION_MONTH_NAMES.September, ordinal: 9, days: 30 }),
    Object.freeze({ name: GOLARION_MONTH_NAMES.October, ordinal: 10, days: 31 }),
    Object.freeze({ name: GOLARION_MONTH_NAMES.November, ordinal: 11, days: 30 }),
    Object.freeze({ name: GOLARION_MONTH_NAMES.December, ordinal: 12, days: 31 }),
  ],
});

const LORE_WEEKDAYS = Object.freeze({
  values: [
    Object.freeze({ name: AR_IC_WEEKDAY_NAMES.Sunday, ordinal: 1 }),
    Object.freeze({ name: AR_IC_WEEKDAY_NAMES.Monday, ordinal: 2 }),
    Object.freeze({ name: AR_IC_WEEKDAY_NAMES.Tuesday, ordinal: 3 }),
    Object.freeze({ name: AR_IC_WEEKDAY_NAMES.Wednesday, ordinal: 4 }),
    Object.freeze({ name: AR_IC_WEEKDAY_NAMES.Thursday, ordinal: 5 }),
    Object.freeze({ name: AR_IC_WEEKDAY_NAMES.Friday, ordinal: 6 }),
    Object.freeze({ name: AR_IC_WEEKDAY_NAMES.Saturday, ordinal: 7 }),
  ],
  daysPerYear: 365,
  hoursPerDay: 24,
  minutesPerHour: 60,
  secondsPerMinute: 60,
});

export const GOLARION_LORE_STRICT_CALENDAR = Object.freeze({
  name: 'Golarion (lore-strict)',
  description: "The setting's own 8-year leap cycle — diverges from the PF2E World Clock.",
  engine: 'declarative',
  years: Object.freeze({ yearZero: 0, firstWeekday: 1, leapYear: Object.freeze({ leapStart: 8, leapInterval: 8 }) }),
  months: LORE_MONTHS,
  days: LORE_WEEKDAYS,
  seasons: null,
  divergesFromPf2e:
    "Uses the setting's own 8-year leap cycle, not real-Gregorian math — this calendar's date will NOT match the PF2E World Clock except where the two cycles happen to agree.",
});
