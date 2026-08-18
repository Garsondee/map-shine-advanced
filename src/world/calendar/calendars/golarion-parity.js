/**
 * GOLARION — PF2E PARITY. Matches the PF2E World Clock to the second
 * (Almanac Testament §5.1, §8 Law 5).
 *
 * ============================================================================
 * "GOLARION" IS GREGORIAN WEARING NAMEPLATES — AND SO IS THIS
 * ============================================================================
 *
 * PF2E's own World Clock does not implement a Golarion calendar at all: it
 * takes Luxon's real proleptic-Gregorian arithmetic (leap years, 31/28-29/
 * 31/30/… month lengths) and looks the English month/weekday name up in a
 * dictionary (verified against the shipped `pf2e.mjs`/`lang/en.json`,
 * Almanac Testament §3.2). So THIS calendar's structure is plain true
 * Gregorian too (`engine: 'true-gregorian'`, `core/gregorian-math.js`) — the
 * "Golarion-ness" is entirely in the `themes` table below. Matching PF2E
 * requires reproducing exactly this, not inventing a more "authentic"
 * calendar; a lore-accurate 8-year-leap variant exists SEPARATELY
 * (`golarion-lore-strict.js`) and is labelled as diverging on purpose.
 *
 * ============================================================================
 * THE FIVE THEMES — verbatim from the shipped PF2E source
 * ============================================================================
 *
 * Year offsets (`pf2e.mjs`, `CONFIG.PF2E.worldClock`): AR +2700 · IC +5200 ·
 * AG −1700 · AD −95 · CE 0. Month names (`lang/en.json` `PF2E.WorldClock.AR.
 * Months`) are shared by AR/IC/AG; AR/IC share one weekday table, AG has its
 * own (note "Seconday"/"Thirday" — PF2E's own spelling, kept verbatim: a
 * corrected spelling would MISS parity, not improve it). AD/CE use PF2E's
 * real English names (no month/weekday remap) — see `format.js`'s own header
 * for the one deliberate, documented simplification (CE's exact prose).
 *
 * `epochOffsetSeconds` below is a placeholder (0) — `foundry/calendar-
 * install.js` overwrites it at install time from the live `pf2e.worldClock.
 * worldCreatedOn` setting, per Testament §9 A1's bullet 4: *"under pf2e the
 * epoch/theme are READ from pf2e.worldClock, never duplicated."* This file
 * declares the SHAPE; the adapter supplies the live number.
 *
 * @module world/calendar/calendars/golarion-parity
 */

import { GREGORIAN_MONTHS, GREGORIAN_WEEKDAYS, GREGORIAN_YEARS } from './gregorian-shape.js';

/** Shared by AR, IC, AG (`pf2e.mjs`'s `month` getter: `case"AR":case"IC":case"AG"`). */
const GOLARION_MONTH_NAMES = Object.freeze({
  January: 'Abadius',
  February: 'Calistril',
  March: 'Pharast',
  April: 'Gozran',
  May: 'Desnus',
  June: 'Sarenith',
  July: 'Erastus',
  August: 'Arodus',
  September: 'Rova',
  October: 'Lamashan',
  November: 'Neth',
  December: 'Kuthona',
});

/** Shared by AR and IC (`pf2e.mjs`'s `weekday` getter: `case"AR":case"IC"`). */
const AR_IC_WEEKDAY_NAMES = Object.freeze({
  Monday: 'Moonday',
  Tuesday: 'Toilday',
  Wednesday: 'Wealday',
  Thursday: 'Oathday',
  Friday: 'Fireday',
  Saturday: 'Starday',
  Sunday: 'Sunday',
});

/** AG's own weekday table — spellings verbatim, including PF2E's own. */
const AG_WEEKDAY_NAMES = Object.freeze({
  Monday: 'Firstday',
  Tuesday: 'Seconday',
  Wednesday: 'Thirday',
  Thursday: 'Fourthday',
  Friday: 'Fifthday',
  Saturday: 'Sixthday',
  Sunday: 'Seventhday',
});

export const GOLARION_PARITY_CALENDAR = Object.freeze({
  name: 'Golarion (PF2E parity)',
  description: "Matches the Pathfinder 2E World Clock's projected date/time to the second.",
  engine: 'true-gregorian',
  years: GREGORIAN_YEARS,
  months: GREGORIAN_MONTHS,
  days: GREGORIAN_WEEKDAYS,
  seasons: null,
  epochOffsetSeconds: 0, // placeholder — overwritten from pf2e.worldClock.worldCreatedOn at install
  themes: Object.freeze([
    Object.freeze({
      id: 'AR',
      yearOffset: 2700,
      eraLabel: 'AR',
      monthNames: GOLARION_MONTH_NAMES,
      weekdayNames: AR_IC_WEEKDAY_NAMES,
    }),
    Object.freeze({
      id: 'IC',
      yearOffset: 5200,
      eraLabel: 'IC',
      monthNames: GOLARION_MONTH_NAMES,
      weekdayNames: AR_IC_WEEKDAY_NAMES,
    }),
    Object.freeze({
      id: 'AG',
      yearOffset: -1700,
      eraLabel: 'AG',
      monthNames: GOLARION_MONTH_NAMES,
      weekdayNames: AG_WEEKDAY_NAMES,
    }),
    // AD: real English names (no remap); era is dynamically "AD"/"BC" in
    // Luxon, simplified here to a fixed "AD" — a realistic worldCreatedOn is
    // always a positive modern year, so the displayed (year-95) year stays
    // positive and this simplification is never actually exercised.
    Object.freeze({ id: 'AD', yearOffset: -95, eraLabel: 'AD' }),
    // CE: real English names, no era — see format.js's header for the one
    // documented simplification (PF2E's own CE bypasses this template).
    Object.freeze({ id: 'CE', yearOffset: 0, eraLabel: '' }),
  ]),
});

export { GOLARION_MONTH_NAMES, AR_IC_WEEKDAY_NAMES, AG_WEEKDAY_NAMES };
