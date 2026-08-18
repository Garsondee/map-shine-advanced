/**
 * THE CALENDAR REGISTRY — the shipped set (Almanac Testament §5.1). A new
 * calendar is a new file here + a registry entry + its own fixtures, per
 * Testament Law 8: *"a new calendar is a config file + pinned fixtures."*
 *
 * @module world/calendar/calendars/index
 */
import { GOLARION_PARITY_CALENDAR } from './golarion-parity.js';
import { EARTH_CALENDAR } from './earth.js';
import { GOLARION_LORE_STRICT_CALENDAR } from './golarion-lore-strict.js';

/** @type {Record<string, import('../calendar-schema.js').CalendarConfig>} */
export const CALENDARS = Object.freeze({
  'golarion-parity': GOLARION_PARITY_CALENDAR,
  earth: EARTH_CALENDAR,
  'golarion-lore-strict': GOLARION_LORE_STRICT_CALENDAR,
});

export const CALENDAR_IDS = Object.freeze(Object.keys(CALENDARS));

/**
 * @param {string} id
 * @returns {import('../calendar-schema.js').CalendarConfig|null} null for an
 *   unknown id — never throws; a caller decides how loudly to fail.
 */
export function getCalendar(id) {
  return CALENDARS[id] ?? null;
}

export { GOLARION_PARITY_CALENDAR, EARTH_CALENDAR, GOLARION_LORE_STRICT_CALENDAR };
