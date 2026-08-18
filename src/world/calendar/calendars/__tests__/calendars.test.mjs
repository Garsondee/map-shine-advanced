import { validateCalendarConfig } from '../../calendar-schema.js';
import { decomposeTrueGregorianTime, composeTrueGregorianTime } from '../../../../core/gregorian-math.js';
import { formatThemedDate } from '../../format.js';
import {
  CALENDARS,
  CALENDAR_IDS,
  getCalendar,
  GOLARION_PARITY_CALENDAR,
  EARTH_CALENDAR,
  GOLARION_LORE_STRICT_CALENDAR,
} from '../index.js';
import { GOLARION_MONTH_NAMES, AR_IC_WEEKDAY_NAMES, AG_WEEKDAY_NAMES } from '../golarion-parity.js';

export function run(t) {
  // ---- every shipped calendar validates cleanly --------------------------
  {
    let ok = true;
    for (const id of CALENDAR_IDS) {
      const r = validateCalendarConfig(CALENDARS[id]);
      if (!r.ok) {
        ok = false;
        console.error(`  ${id} failed validation: ${r.errors.join(' | ')}`);
      }
    }
    t.ok(`all ${CALENDAR_IDS.length} shipped calendars pass validateCalendarConfig`, ok);
  }

  t.ok(
    'CALENDAR_IDS includes the 3 shipped calendars',
    CALENDAR_IDS.length === 3 &&
      ['golarion-parity', 'earth', 'golarion-lore-strict'].every((id) => CALENDAR_IDS.includes(id))
  );
  t.ok('getCalendar resolves a known id', getCalendar('earth') === EARTH_CALENDAR);
  t.ok('getCalendar returns null (never throws) for an unknown id', getCalendar('nope') === null);

  // ---- golarion-parity: every theme's name maps resolve, no silent gaps --
  {
    let ok = true;
    for (const theme of GOLARION_PARITY_CALENDAR.themes) {
      if (theme.id === 'AD' || theme.id === 'CE') continue; // real English names by design
      for (const base of Object.keys(GOLARION_MONTH_NAMES)) {
        if (!(base in theme.monthNames)) {
          ok = false;
          console.error(`  theme ${theme.id} has no month mapping for ${base}`);
        }
      }
      const expectedWeekdayBase = theme.id === 'AG' ? AG_WEEKDAY_NAMES : AR_IC_WEEKDAY_NAMES;
      for (const base of Object.keys(expectedWeekdayBase)) {
        if (!(base in theme.weekdayNames)) {
          ok = false;
          console.error(`  theme ${theme.id} has no weekday mapping for ${base}`);
        }
      }
    }
    t.ok('every themed (non-AD/CE) theme maps all 12 months and all 7 weekdays — no gaps', ok);
  }

  t.ok(
    'golarion-parity has exactly the 5 PF2E themes',
    GOLARION_PARITY_CALENDAR.themes.length === 5 &&
      ['AR', 'IC', 'AG', 'AD', 'CE'].every((id) => GOLARION_PARITY_CALENDAR.themes.some((th) => th.id === id))
  );

  // ---- AG's own weekday spellings are exactly what PF2E ships, typos included
  {
    const ag = GOLARION_PARITY_CALENDAR.themes.find((th) => th.id === 'AG');
    t.ok('AG weekday "Seconday" (PF2E\'s own spelling) is preserved verbatim', ag.weekdayNames.Tuesday === 'Seconday');
    t.ok('AG weekday "Thirday" (PF2E\'s own spelling) is preserved verbatim', ag.weekdayNames.Wednesday === 'Thirday');
    t.ok('AG weekday Sunday maps to Seventhday', ag.weekdayNames.Sunday === 'Seventhday');
  }

  // ---- end-to-end: compose→decompose→format a known date through AR -------
  {
    // 2026-08-17 is a Monday (proven against the Date oracle in
    // core/__tests__/gregorian-math.test.mjs). Compose it (0-idx month=7,
    // dayOfMonth=16), decompose it back through the SAME calendar shape, and
    // format it — proving the whole pipe end-to-end, not just its pieces.
    const cal = GOLARION_PARITY_CALENDAR;
    const ar = cal.themes.find((th) => th.id === 'AR');
    const seconds = composeTrueGregorianTime({ year: 2026, month: 7, dayOfMonth: 16 }, cal);
    const components = decomposeTrueGregorianTime(seconds, cal);
    const dateLine = formatThemedDate(components, cal, ar);
    // AR renames the WEEKDAY too (Monday -> Moonday) — that mapping firing is
    // the thing under test, not an unwanted side effect.
    t.ok(
      `AR theme renders 2026-08-17 as "Moonday, 17th of Arodus, 4726 AR" (got "${dateLine}")`,
      dateLine === 'Moonday, 17th of Arodus, 4726 AR'
    );
  }

  // ---- earth: a plain leap-adjacent date reads with no theme --------------
  {
    const cal = EARTH_CALENDAR;
    const seconds = composeTrueGregorianTime({ year: 2000, month: 1, dayOfMonth: 28 }, cal); // Feb 29 2000
    const components = decomposeTrueGregorianTime(seconds, cal);
    const dateLine = formatThemedDate(components, cal);
    t.ok(
      `Earth (no theme) renders the leap day plainly (got "${dateLine}")`,
      dateLine.includes('29th of February, 2000')
    );
  }

  // ---- golarion-lore-strict: carries its divergence warning + 8-year leap -
  {
    const cal = GOLARION_LORE_STRICT_CALENDAR;
    t.ok(
      'lore-strict carries a non-blank divergesFromPf2e warning',
      typeof cal.divergesFromPf2e === 'string' && cal.divergesFromPf2e.length > 0
    );
    t.ok(
      'lore-strict uses the declarative engine (no core/gregorian-math.js involvement)',
      cal.engine === 'declarative'
    );
    t.ok(
      'lore-strict months speak Golarion names directly (no theme layer)',
      cal.months.values[0].name === GOLARION_MONTH_NAMES.January
    );
    t.ok('lore-strict declares an 8-year leap interval', cal.years.leapYear.leapInterval === 8);
  }
}
