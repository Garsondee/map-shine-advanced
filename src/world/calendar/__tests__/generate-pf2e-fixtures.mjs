/**
 * THE FIXTURE GENERATOR — run this, don't hand-edit its output.
 *
 * Produces `fixtures/pf2e-parity-fixtures.mjs` by executing PF2E's own
 * shipped projection independently: `displayed = worldCreatedOn(UTC) +
 * worldTime seconds`, real proleptic-Gregorian arithmetic, via native
 * `Date#setUTCFullYear`/`getUTC*` — confirmed (`core/__tests__/gregorian-
 * math.test.mjs`) to bypass the legacy two-digit-year remap that would
 * otherwise make `Date` unsafe as an oracle for ancient target years.
 *
 * Deliberately does NOT import `core/gregorian-math.js` or call
 * `composeTrueGregorianTime`/`decomposeTrueGregorianTime` — that is the code
 * under test, and the Almanac Testament §5.3 doctrine is explicit: *"expected
 * values never come from the code under test."* It DOES import the theme
 * NAME TABLES from `golarion-parity.js` (a plain data lookup transcribed
 * from PF2E's own source, verified by inspection, not an algorithm this
 * generator would meaningfully re-derive a third time) — reusing them here
 * reduces the chance of typo-drift between two independently-typed copies of
 * the same dictionary, it does not weaken the math check this file exists for.
 *
 * Usage: `node src/world/calendar/__tests__/generate-pf2e-fixtures.mjs`
 * (re-run and diff after touching the probe grid or the theme tables).
 *
 * @module world/calendar/__tests__/generate-pf2e-fixtures
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { GOLARION_MONTH_NAMES, AR_IC_WEEKDAY_NAMES, AG_WEEKDAY_NAMES } from '../calendars/golarion-parity.js';

const THEMES = [
  { id: 'AR', yearOffset: 2700, eraLabel: 'AR', monthNames: GOLARION_MONTH_NAMES, weekdayNames: AR_IC_WEEKDAY_NAMES },
  { id: 'IC', yearOffset: 5200, eraLabel: 'IC', monthNames: GOLARION_MONTH_NAMES, weekdayNames: AR_IC_WEEKDAY_NAMES },
  { id: 'AG', yearOffset: -1700, eraLabel: 'AG', monthNames: GOLARION_MONTH_NAMES, weekdayNames: AG_WEEKDAY_NAMES },
  { id: 'AD', yearOffset: -95, eraLabel: 'AD', monthNames: null, weekdayNames: null },
  { id: 'CE', yearOffset: 0, eraLabel: '', monthNames: null, weekdayNames: null },
];

const MONTH_NAMES_EN = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAY_NAMES_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The independent oracle — see this file's own header. */
function oracleSeconds(year, month1, day, hour = 0, minute = 0, second = 0) {
  const d = new Date(0);
  d.setUTCFullYear(year, month1 - 1, day);
  d.setUTCHours(hour, minute, second, 0);
  return d.valueOf() / 1000;
}
function oracleComponents(seconds) {
  const d = new Date(seconds * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  };
}
function ordinal(n) {
  const r = n % 100;
  if (r >= 11 && r <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`;
}

/** A shared world epoch — deliberately MID-YEAR, per the A1 exit gate's own wording. */
const WORLD_CREATED_ON_ISO = '2024-03-15T08:30:00.000Z';
const EPOCH_OFFSET_SECONDS = Date.parse(WORLD_CREATED_ON_ISO) / 1000; // safe: a real modern year, never 0-99

/**
 * THE PROBE GRID — every case the Testament's §9 A1 bullet names by name,
 * plus the ordinary continuity/negative-time cases §5.3 asks for.
 */
const TARGETS = [
  { label: 'epoch itself (worldTime=0)', y: 2024, m: 3, d: 15, h: 8, mi: 30, s: 0 },
  {
    label: 'a leap Feb 29, ordinary /4 year, BEFORE the epoch (negative worldTime)',
    y: 2024,
    m: 2,
    d: 29,
    h: 12,
    mi: 0,
    s: 0,
  },
  { label: 'a leap Feb 29, ordinary /4 year, after the epoch', y: 2028, m: 2, d: 29, h: 0, mi: 0, s: 0 },
  { label: 'a leap Feb 29, /400 year (2000)', y: 2000, m: 2, d: 29, h: 23, mi: 59, s: 59 },
  { label: 'the LAST second before a century non-leap Mar 1 (2100)', y: 2100, m: 2, d: 28, h: 23, mi: 59, s: 59 },
  {
    label: 'the FIRST second of the century non-leap Mar 1 (2100 — no Feb 29 exists)',
    y: 2100,
    m: 3,
    d: 1,
    h: 0,
    mi: 0,
    s: 0,
  },
  { label: 'the last second of a year (week/year continuity)', y: 2024, m: 12, d: 31, h: 23, mi: 59, s: 59 },
  { label: 'the first second of the next year', y: 2025, m: 1, d: 1, h: 0, mi: 0, s: 0 },
  { label: 'an ordinary present-day date', y: 2026, m: 8, d: 17, h: 14, mi: 30, s: 45 },
  { label: 'deep negative worldTime — year 1, Jan 1', y: 1, m: 1, d: 1, h: 0, mi: 0, s: 0 },
];

const rows = [];
for (const target of TARGETS) {
  const targetAbsSeconds = oracleSeconds(target.y, target.m, target.d, target.h, target.mi, target.s);
  const worldTimeSeconds = Math.round(targetAbsSeconds - EPOCH_OFFSET_SECONDS);
  const oc = oracleComponents(targetAbsSeconds);
  for (const theme of THEMES) {
    const baseMonth = MONTH_NAMES_EN[oc.month - 1];
    const baseWeekday = WEEKDAY_NAMES_EN[oc.weekday];
    const month = theme.monthNames?.[baseMonth] ?? baseMonth;
    const weekday = theme.weekdayNames?.[baseWeekday] ?? baseWeekday;
    const themedYear = oc.year + theme.yearOffset;
    const day = ordinal(oc.day);
    const dateLine = theme.eraLabel
      ? `${weekday}, ${day} of ${month}, ${themedYear} ${theme.eraLabel}`
      : `${weekday}, ${day} of ${month}, ${themedYear}`;
    rows.push({
      label: target.label,
      worldCreatedOnIso: WORLD_CREATED_ON_ISO,
      worldTimeSeconds,
      themeId: theme.id,
      year: oc.year,
      month: oc.month, // 1-indexed
      day: oc.day,
      hour: oc.hour,
      minute: oc.minute,
      second: oc.second,
      weekday: oc.weekday, // 0=Sunday
      themedYear,
      dateLine,
    });
  }
}

const out = `/**
 * PINNED — generated by generate-pf2e-fixtures.mjs. Do not hand-edit.
 * Regenerate: node src/world/calendar/__tests__/generate-pf2e-fixtures.mjs
 *
 * Every row's year/month/day/hour/minute/second/weekday/dateLine was computed
 * by an INDEPENDENT oracle (native Date UTC arithmetic) executing PF2E's own
 * shipped projection formula, never by the engine these fixtures test
 * (Almanac Testament §5.3). \`month\`/\`day\`/\`weekday\` are 1-/1-/0-indexed
 * here (oracle-native); the test file converts to this project's own
 * 0-indexed TimeComponents convention at the point of comparison.
 *
 * @module world/calendar/__tests__/fixtures/pf2e-parity-fixtures
 */
export const PF2E_PARITY_FIXTURES = Object.freeze(${JSON.stringify(rows, null, 2)});
`;

const outPath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pf2e-parity-fixtures.mjs');
writeFileSync(outPath, out);
console.log(
  `wrote ${rows.length} fixture rows (${TARGETS.length} target dates x ${THEMES.length} themes) to ${outPath}`
);
