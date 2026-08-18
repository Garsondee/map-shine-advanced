/**
 * `toFoundryCalendarConfig` — the one genuinely pure, Node-testable piece of
 * `calendar-install.js` (everything else needs a real `CalendarData`/`game`
 * global). This is a REGRESSION GUARD for a real live crash (2026-08-17,
 * see the function's own header): `seasons: null` reached Foundry's base
 * `CalendarData#timeToComponents`, which dereferences `this.seasons.values`
 * unconditionally, and took the ENTIRE world down inside `GameTime`'s own
 * constructor — before this test existed to catch it in Node, in seconds,
 * for free, forever.
 *
 * Runs against the REAL shipped calendar registry (`world/calendar/
 * calendars/index.js`) — a cross-zone import that is fine HERE specifically
 * because `zones/one-door`'s own scanner exempts `__tests__/` entirely; this
 * is a test asserting on real data, not production code reaching around the
 * foundry/world leaf boundary the rest of this file's own header documents.
 */
import { toFoundryCalendarConfig } from '../calendar-install.js';
import { CALENDARS, CALENDAR_IDS } from '../../world/calendar/calendars/index.js';

export function run(t) {
  // ---- the exact live bug, reproduced and pinned ---------------------------
  {
    const cfg = toFoundryCalendarConfig({ name: 'x', years: {}, months: {}, days: {}, seasons: null });
    t.ok('seasons:null NEVER survives into the Foundry-bound config', cfg.seasons !== null);
    t.ok(
      '...it becomes a valid, empty seasons block instead',
      Array.isArray(cfg.seasons?.values) && cfg.seasons.values.length === 0
    );
  }
  {
    const cfg = toFoundryCalendarConfig({ name: 'x', years: {}, months: {}, days: {} }); // seasons entirely absent
    t.ok(
      'an absent seasons field ALSO never survives as null',
      cfg.seasons !== null && Array.isArray(cfg.seasons?.values)
    );
  }
  {
    const realSeasons = { values: [{ name: 'Spring' }] };
    const cfg = toFoundryCalendarConfig({ name: 'x', years: {}, months: {}, days: {}, seasons: realSeasons });
    t.ok('a calendar that DOES define seasons keeps them verbatim, unmodified', cfg.seasons === realSeasons);
  }

  // ---- every SHIPPED calendar, run through the SAME function the live install path uses
  {
    let anyNullSeasons = false;
    let anyMissingValuesArray = false;
    const details = [];
    for (const id of CALENDAR_IDS) {
      const cfg = toFoundryCalendarConfig(CALENDARS[id]);
      if (cfg.seasons === null) {
        anyNullSeasons = true;
        details.push(`${id}: seasons is null`);
      }
      if (!Array.isArray(cfg.seasons?.values)) {
        anyMissingValuesArray = true;
        details.push(`${id}: seasons.values is not an array`);
      }
    }
    if (details.length) console.error('  ' + details.join('\n  '));
    t.ok(
      `none of the ${CALENDAR_IDS.length} shipped calendars produce seasons:null (the exact live crash)`,
      !anyNullSeasons
    );
    t.ok('every shipped calendar has a real seasons.values array Foundry can iterate', !anyMissingValuesArray);
  }

  // ---- other required fields survive verbatim (this fix must not have broken them)
  {
    for (const id of CALENDAR_IDS) {
      const shape = CALENDARS[id];
      const cfg = toFoundryCalendarConfig(shape);
      t.ok(`${id}: months passes through unmodified`, cfg.months === shape.months);
      t.ok(`${id}: days passes through unmodified`, cfg.days === shape.days);
      t.ok(`${id}: years passes through unmodified`, cfg.years === shape.years);
      t.ok(`${id}: name passes through`, cfg.name === shape.name);
    }
  }
}
