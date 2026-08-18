import {
  projectWorldTime,
  composeWorldTime,
  GOLARION_PARITY_CALENDAR,
  EARTH_CALENDAR,
  GOLARION_LORE_STRICT_CALENDAR,
  getCalendar,
  CALENDAR_IDS,
} from '../almanac.js';

export function run(t) {
  t.ok('the almanac barrel re-exports the 3 shipped calendars', CALENDAR_IDS.length === 3);
  t.ok('getCalendar is reachable through the barrel', getCalendar('golarion-parity') === GOLARION_PARITY_CALENDAR);

  // ---- projectWorldTime, end to end, through the public barrel -----------
  {
    const epochOffsetSeconds = Date.parse('2024-03-15T08:30:00.000Z') / 1000;
    const cal = { ...GOLARION_PARITY_CALENDAR, epochOffsetSeconds };
    const r = projectWorldTime(0, cal, 'AR');
    t.ok(
      `worldTime=0 projects to the epoch date itself under AR (got "${r.dateLine}")`,
      r.ok && r.dateLine === 'Fireday, 15th of Pharast, 4724 AR'
    );
  }

  // ---- projectWorldTime with no theme falls back to base names -----------
  {
    const epochOffsetSeconds = Date.parse('2024-03-15T08:30:00.000Z') / 1000;
    const cal = { ...EARTH_CALENDAR, epochOffsetSeconds };
    const r = projectWorldTime(0, cal);
    t.ok(
      `no theme uses the calendar's own base names (got "${r.dateLine}")`,
      r.ok && r.dateLine === 'Friday, 15th of March, 2024'
    );
  }

  // ---- projectWorldTime refuses (loudly, not silently) an unknown theme --
  {
    const cal = { ...GOLARION_PARITY_CALENDAR, epochOffsetSeconds: 0 };
    const r = projectWorldTime(0, cal, 'NOPE');
    t.ok(
      'an unknown theme id is a reported failure, not a silent fallback',
      r.ok === false && r.reason.includes('NOPE')
    );
  }

  // ---- projectWorldTime/composeWorldTime refuse a declarative calendar ---
  // (Testament: declarative calendars ride Foundry's OWN engine; this module
  // deliberately does not reimplement it — an instrument that pretended to
  // project one would be lying about what it actually computed.)
  {
    const r1 = projectWorldTime(0, GOLARION_LORE_STRICT_CALENDAR);
    const r2 = composeWorldTime({ year: 4700 }, GOLARION_LORE_STRICT_CALENDAR);
    t.ok(
      'projectWorldTime refuses a declarative calendar with a stated reason',
      r1.ok === false && r1.reason.includes('declarative')
    );
    t.ok(
      'composeWorldTime refuses a declarative calendar with a stated reason',
      r2.ok === false && r2.reason.includes('declarative')
    );
  }

  // ---- composeWorldTime is the exact inverse of projectWorldTime's decompose
  {
    const epochOffsetSeconds = Date.parse('2024-03-15T08:30:00.000Z') / 1000;
    const cal = { ...GOLARION_PARITY_CALENDAR, epochOffsetSeconds };
    const target = 123456789; // an arbitrary worldTime
    const projected = projectWorldTime(target, cal, 'IC');
    const composed = composeWorldTime(projected.components, cal);
    t.ok(
      'composeWorldTime(projectWorldTime(t).components) recovers t exactly',
      composed.ok && composed.worldTimeSeconds === target
    );
  }
}
