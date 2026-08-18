/**
 * EARTH — a genuine 4/100/400 Gregorian calendar (Almanac Testament §5.1).
 *
 * Deliberately NOT Foundry core's own `earthCalendarConfig` — that object is
 * literally the SAME "Simplified Gregorian" as `worldCalendarConfig` (4-year
 * leap only, receipted in the Almanac Testament §3.1), so a century year
 * like 2100 would wrongly grow a Feb 29 under it. This one rides the true-
 * Gregorian engine (`core/gregorian-math.js`) instead, and IS what a
 * calendar named "Earth" should mean.
 *
 * No themes: Earth needs no name remap and no era offset (offset 0, real
 * English names — `world/calendar/format.js` already falls back to a
 * calendar's own base names when no theme is given).
 *
 * @module world/calendar/calendars/earth
 */

import { GREGORIAN_MONTHS, GREGORIAN_WEEKDAYS, GREGORIAN_YEARS } from './gregorian-shape.js';

export const EARTH_CALENDAR = Object.freeze({
  name: 'Earth',
  description: 'A true 4/100/400 Gregorian calendar — real month lengths, real leap years, real weekdays.',
  engine: 'true-gregorian',
  years: GREGORIAN_YEARS,
  months: GREGORIAN_MONTHS,
  days: GREGORIAN_WEEKDAYS,
  seasons: Object.freeze({
    values: [
      Object.freeze({ name: 'Spring', monthStart: 3, monthEnd: 5, dayStart: null, dayEnd: null }),
      Object.freeze({ name: 'Summer', monthStart: 6, monthEnd: 8, dayStart: null, dayEnd: null }),
      Object.freeze({ name: 'Autumn', monthStart: 9, monthEnd: 11, dayStart: null, dayEnd: null }),
      Object.freeze({ name: 'Winter', monthStart: 12, monthEnd: 2, dayStart: null, dayEnd: null }),
    ],
  }),
  // Placeholder — foundry/calendar-install.js sets this to "real now" (in
  // seconds since this calendar's own year-0 epoch) at first install for a
  // world with no calendar setting yet, mirroring PF2E's own worldCreatedOn
  // UX (auto-init to real UTC "now"). A world that already has one keeps it.
  epochOffsetSeconds: 0,
});
