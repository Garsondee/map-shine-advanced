/**
 * THE PARITY PROOF — Almanac Testament §8 Law 5: *"Under pf2e, MSA's
 * displayed date/time equals the PF2E World Clock's to the second."*
 *
 * Feeds every pinned fixture row (`fixtures/pf2e-parity-fixtures.mjs`,
 * generated independently — see that generator's own header) through the
 * REAL production path: `GOLARION_PARITY_CALENDAR` with a live-style
 * `epochOffsetSeconds`, `core/gregorian-math.js#decomposeTrueGregorianTime`,
 * `world/calendar/format.js#formatThemedDate`. If this suite is green, the
 * engine this project ships reproduces PF2E's own math and name tables
 * exactly, on every probed case — epoch edges, ordinary and /400 leap Feb
 * 29s, the 2100 century non-leap rollover, year-boundary continuity,
 * negative worldTime, and all five date themes including AG's own spellings.
 */
import { decomposeTrueGregorianTime, composeTrueGregorianTime } from '../../../core/gregorian-math.js';
import { formatThemedDate } from '../format.js';
import { GOLARION_PARITY_CALENDAR } from '../calendars/golarion-parity.js';
import { PF2E_PARITY_FIXTURES } from './fixtures/pf2e-parity-fixtures.mjs';

export function run(t) {
  t.ok(
    'the fixture file is non-empty (a silently-empty fixture would pass everything vacuously)',
    PF2E_PARITY_FIXTURES.length >= 40
  );

  let dateLineFailures = 0;
  let componentFailures = 0;
  const failureDetails = [];

  for (const row of PF2E_PARITY_FIXTURES) {
    const epochOffsetSeconds = Date.parse(row.worldCreatedOnIso) / 1000;
    const calendarConfig = { ...GOLARION_PARITY_CALENDAR, epochOffsetSeconds };
    const absoluteSeconds = row.worldTimeSeconds + epochOffsetSeconds;
    const components = decomposeTrueGregorianTime(absoluteSeconds, calendarConfig);
    const theme = calendarConfig.themes.find((th) => th.id === row.themeId);
    const dateLine = formatThemedDate(components, calendarConfig, theme);

    if (dateLine !== row.dateLine) {
      dateLineFailures++;
      failureDetails.push(`  [${row.label} / ${row.themeId}] dateLine: got "${dateLine}", expected "${row.dateLine}"`);
    }

    const componentsMatch =
      components.year === row.year &&
      components.month === row.month - 1 && // fixture is 1-indexed, ours is 0-indexed
      components.dayOfMonth === row.day - 1 &&
      components.hour === row.hour &&
      components.minute === row.minute &&
      components.second === row.second &&
      components.dayOfWeek === row.weekday;
    if (!componentsMatch) {
      componentFailures++;
      failureDetails.push(
        `  [${row.label} / ${row.themeId}] components: got ${JSON.stringify(components)}, fixture year/month/day/h/m/s/weekday = ${row.year}/${row.month}/${row.day}/${row.hour}/${row.minute}/${row.second}/${row.weekday}`
      );
    }
  }

  for (const line of failureDetails.slice(0, 20)) console.error(line);
  t.ok(
    `all ${PF2E_PARITY_FIXTURES.length} fixture rows produce the exact themed date line PF2E would show`,
    dateLineFailures === 0
  );
  t.ok(
    `all ${PF2E_PARITY_FIXTURES.length} fixture rows produce the exact underlying components`,
    componentFailures === 0
  );

  // ---- the explicit Calistril-29 case (Testament §9 A1 bullet 3) ---------
  {
    const row = PF2E_PARITY_FIXTURES.find((r) => r.themeId === 'AR' && r.month === 2 && r.day === 29);
    t.ok('the fixture set genuinely includes a Calistril-29 (AR leap-day) case', !!row);
    t.ok('and it renders as "...29th of Calistril..."', row?.dateLine.includes('29th of Calistril'));
  }

  // ---- the explicit century-non-leap case (Testament §9 A1 bullet 3) -----
  {
    const before = PF2E_PARITY_FIXTURES.find((r) => r.themeId === 'CE' && r.year === 2100 && r.month === 2);
    const after = PF2E_PARITY_FIXTURES.find(
      (r) => r.themeId === 'CE' && r.year === 2100 && r.month === 3 && r.day === 1
    );
    t.ok('2100-02-28 is the last day of February (no Feb 29 — the century non-leap case)', before?.day === 28);
    t.ok('the very next second is March 1st, not February 29th', after?.day === 1);
  }

  // ---- round-trip: composing the fixture's own components lands on the ---
  // ---- SAME worldTimeSeconds the fixture was generated from --------------
  {
    let ok = true;
    for (const row of PF2E_PARITY_FIXTURES) {
      const epochOffsetSeconds = Date.parse(row.worldCreatedOnIso) / 1000;
      const calendarConfig = { ...GOLARION_PARITY_CALENDAR, epochOffsetSeconds };
      const composed = composeTrueGregorianTime(
        {
          year: row.year,
          month: row.month - 1,
          dayOfMonth: row.day - 1,
          hour: row.hour,
          minute: row.minute,
          second: row.second,
        },
        calendarConfig
      );
      const recoveredWorldTime = composed - epochOffsetSeconds;
      if (recoveredWorldTime !== row.worldTimeSeconds) {
        ok = false;
        console.error(
          `  round-trip mismatch [${row.label}]: composed worldTime ${recoveredWorldTime}, fixture says ${row.worldTimeSeconds}`
        );
      }
    }
    t.ok("composing every fixture row's own components recovers its exact worldTimeSeconds", ok);
  }
}
