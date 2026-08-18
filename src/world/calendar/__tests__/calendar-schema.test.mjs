import { validateCalendarConfig, CALENDAR_ENGINES } from '../calendar-schema.js';

/** A minimal, valid true-gregorian calendar — the baseline every test mutates. */
function validConfig() {
  return {
    name: 'Test Calendar',
    engine: 'true-gregorian',
    years: { yearZero: 0, firstWeekday: 4, leapYear: null },
    months: {
      values: [
        { name: 'January', ordinal: 1, days: 31 },
        { name: 'February', ordinal: 2, days: 28, leapDays: 29 },
      ],
    },
    days: {
      values: [
        { name: 'Sunday', ordinal: 1 },
        { name: 'Monday', ordinal: 2 },
      ],
      daysPerYear: 365,
      hoursPerDay: 24,
      minutesPerHour: 60,
      secondsPerMinute: 60,
    },
    epochOffsetSeconds: 0,
  };
}

export function run(t) {
  t.ok(
    'CALENDAR_ENGINES is frozen and has exactly the two named engines',
    Object.isFrozen(CALENDAR_ENGINES) && CALENDAR_ENGINES.length === 2
  );

  {
    const r = validateCalendarConfig(validConfig());
    t.ok(`a minimal valid true-gregorian config validates (${r.errors.join(' | ') || 'clean'})`, r.ok);
  }

  {
    const r = validateCalendarConfig(null);
    t.ok('null is rejected, not thrown', r.ok === false && r.errors.length === 1);
  }

  {
    const c = validConfig();
    c.engine = 'yearly';
    const r = validateCalendarConfig(c);
    t.ok('an unknown engine is rejected', !r.ok && r.errors.some((e) => e.includes('engine')));
  }

  {
    const c = validConfig();
    delete c.name;
    const r = validateCalendarConfig(c);
    t.ok('a missing name is rejected', !r.ok && r.errors.some((e) => e.includes('name')));
  }

  {
    const c = validConfig();
    c.months.values[1].leapDays = 0;
    const r = validateCalendarConfig(c);
    t.ok('leapDays must be positive when present (0 is rejected)', !r.ok);
  }

  {
    // THE DEAD-CONTROL CASE: a declared leap rule the true-gregorian engine
    // would silently ignore (it hardcodes real 4/100/400) must be rejected,
    // not accepted-and-forgotten.
    const c = validConfig();
    c.years.leapYear = { leapStart: 8, leapInterval: 8 };
    const r = validateCalendarConfig(c);
    t.ok(
      'true-gregorian + a declared years.leapYear is rejected (it would be dead data)',
      !r.ok && r.errors.some((e) => e.includes('leapYear'))
    );
  }

  {
    // The declarative engine's whole POINT is that years.leapYear works —
    // must NOT be rejected there.
    const c = validConfig();
    c.engine = 'declarative';
    c.years.leapYear = { leapStart: 8, leapInterval: 8 };
    delete c.epochOffsetSeconds; // not required for declarative
    const r = validateCalendarConfig(c);
    t.ok(`declarative + years.leapYear validates (${r.errors.join(' | ') || 'clean'})`, r.ok);
  }

  {
    const c = validConfig();
    delete c.epochOffsetSeconds;
    const r = validateCalendarConfig(c);
    t.ok(
      'true-gregorian without epochOffsetSeconds is rejected',
      !r.ok && r.errors.some((e) => e.includes('epochOffsetSeconds'))
    );
  }

  {
    const c = validConfig();
    c.themes = [
      { id: 'AR', yearOffset: 2700, eraLabel: 'AR' },
      { id: 'AR', yearOffset: 5200, eraLabel: 'IC' },
    ];
    const r = validateCalendarConfig(c);
    t.ok('duplicate theme ids are rejected', !r.ok && r.errors.some((e) => e.includes('duplicate')));
  }

  {
    const c = validConfig();
    c.divergesFromPf2e = '';
    const r = validateCalendarConfig(c);
    t.ok('a blank divergesFromPf2e warning is rejected (must actually say something)', !r.ok);
  }

  {
    // Every reported problem in ONE pass, not one-fix-per-run.
    const c = { engine: 'nope' };
    const r = validateCalendarConfig(c);
    t.ok('a badly malformed config reports MULTIPLE distinct errors at once', r.errors.length >= 4);
  }
}
