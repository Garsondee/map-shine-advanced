/**
 * THE ALMANAC — the public face of `world/calendar/`, per Almanac Testament
 * §4/§9 A1: *"pure, Node-tested projection between `worldTime` and calendar
 * components; formats dates; owns moon phase math."*
 *
 * This file is the ONE thing other MSA code (and `world/index.js`'s door)
 * needs to know about the calendar subsystem — it re-exports the schema
 * validator, the moon projection, the date formatter, and the shipped
 * calendar registry, and adds `projectWorldTime`: the single convenience
 * every future consumer (fixture tests today; the Remote's date line at
 * stage A4) will actually call.
 *
 * Pure throughout. No Foundry import, no global read — the installed
 * `CalendarData` subclass (`foundry/calendar-install.js`, behind the
 * adapter-only wall) is a THIN SHELL over exactly the functions this module
 * re-exports, never a second copy of them (this module's own header on
 * `core/gregorian-math.js` explains why the engine itself lives in `core/`
 * rather than here: `foundry/` cannot import `world/`, and `core/` is the
 * one zone exempt from the door requirement).
 *
 * @module world/almanac
 */
import { decomposeTrueGregorianTime, composeTrueGregorianTime } from '../core/gregorian-math.js';
import { validateCalendarConfig, CALENDAR_ENGINES } from './calendar/calendar-schema.js';
import { moonPhaseAt, PHASE_NAMES } from './calendar/moon.js';
import { formatThemedDate, formatThemedTime, ordinalString } from './calendar/format.js';
import {
  CALENDARS,
  CALENDAR_IDS,
  getCalendar,
  GOLARION_PARITY_CALENDAR,
  EARTH_CALENDAR,
  GOLARION_LORE_STRICT_CALENDAR,
} from './calendar/calendars/index.js';

/**
 * Project a `worldTime` through a calendar into a themed date line — the
 * convenience every consumer above this module actually wants, instead of
 * hand-wiring `decomposeTrueGregorianTime` + `formatThemedDate` themselves.
 *
 * Scoped to `'true-gregorian'` calendars: a `'declarative'` calendar (the
 * lore-strict variant, or a GM's custom one) rides FOUNDRY'S OWN native
 * `CalendarData` engine once installed — this module deliberately does not
 * reimplement that engine a second time (Testament Law 8: the calendar is
 * data; declarative calendars have no engine of MSA's own to call). For
 * those, the live `game.time.components` (via `foundry/game-time.js`, once
 * `foundry/calendar-install.js` has installed the calendar) is the source of
 * truth, not this function. Never throws — an unsupported engine is reported
 * as a reason, not silently mis-projected (`feedback_instruments_must_not_lie`).
 *
 * @param {number} worldTimeSeconds
 * @param {import('./calendar/calendar-schema.js').CalendarConfig} calendarConfig
 * @param {string} [themeId] - a `calendarConfig.themes[].id`; omitted for the
 *   calendar's own base names (Earth's only mode).
 * @returns {{ok: true, components: object, dateLine: string}|{ok: false, reason: string}}
 */
export function projectWorldTime(worldTimeSeconds, calendarConfig, themeId) {
  if (calendarConfig.engine !== 'true-gregorian') {
    return {
      ok: false,
      reason: `projectWorldTime only projects 'true-gregorian' calendars directly; '${calendarConfig.engine}' calendars are decomposed by Foundry's own installed CalendarData (read game.time.components once foundry/calendar-install.js has installed it)`,
    };
  }
  const absoluteSeconds = worldTimeSeconds + (calendarConfig.epochOffsetSeconds ?? 0);
  const components = decomposeTrueGregorianTime(absoluteSeconds, calendarConfig);
  const theme = themeId ? (calendarConfig.themes?.find((th) => th.id === themeId) ?? null) : undefined;
  if (themeId && !theme) {
    return { ok: false, reason: `calendar '${calendarConfig.name}' has no theme '${themeId}'` };
  }
  const dateLine = formatThemedDate(components, calendarConfig, theme);
  return { ok: true, components, dateLine };
}

/**
 * The inverse of {@link projectWorldTime}'s decompose step: full calendar
 * components (as returned by `projectWorldTime(...).components`, or hand-
 * authored for a jump target) → `worldTime` seconds. Scoped identically.
 *
 * @param {object} components
 * @param {import('./calendar/calendar-schema.js').CalendarConfig} calendarConfig
 * @returns {{ok: true, worldTimeSeconds: number}|{ok: false, reason: string}}
 */
export function composeWorldTime(components, calendarConfig) {
  if (calendarConfig.engine !== 'true-gregorian') {
    return {
      ok: false,
      reason: `composeWorldTime only composes 'true-gregorian' calendars directly; '${calendarConfig.engine}' calendars ride Foundry's own installed CalendarData`,
    };
  }
  const absoluteSeconds = composeTrueGregorianTime(components, calendarConfig);
  return { ok: true, worldTimeSeconds: absoluteSeconds - (calendarConfig.epochOffsetSeconds ?? 0) };
}

export {
  validateCalendarConfig,
  CALENDAR_ENGINES,
  moonPhaseAt,
  PHASE_NAMES,
  formatThemedDate,
  formatThemedTime,
  ordinalString,
  CALENDARS,
  CALENDAR_IDS,
  getCalendar,
  GOLARION_PARITY_CALENDAR,
  EARTH_CALENDAR,
  GOLARION_LORE_STRICT_CALENDAR,
};
