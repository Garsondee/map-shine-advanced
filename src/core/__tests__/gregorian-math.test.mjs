/**
 * The true-Gregorian engine, proven against an INDEPENDENT oracle — never
 * against itself, never against a model's memory of a date. The oracle is
 * `Date#setUTCFullYear`/`getUTC*`, confirmed (2026-08-17, this file's own
 * `oracle year 0 is not remapped to 1900` assertion below) to bypass the
 * legacy two-digit-year special case that `Date.UTC`/`new Date(y,...)` apply
 * — the ONE thing that would have made native `Date` an unsafe oracle here.
 */
import {
  isGregorianLeapYear,
  daysFromCivil,
  civilFromDays,
  decomposeTrueGregorianYear,
  decomposeTrueGregorianTime,
  composeTrueGregorianTime,
} from '../gregorian-math.js';

const GREGORIAN_MONTHS = {
  values: [
    { days: 31 },
    { days: 28, leapDays: 29 },
    { days: 31 },
    { days: 30 },
    { days: 31 },
    { days: 30 },
    { days: 31 },
    { days: 31 },
    { days: 30 },
    { days: 31 },
    { days: 30 },
    { days: 31 },
  ],
};
// firstWeekday (under `years`, matching the real CalendarConfig shape)
// calibrates "day 0" (1970-01-01, since decomposeTrueGregorianTime's totalDays
// is 1970-relative) to a weekday INDEX — 4, because 1970-01-01 was a Thursday
// under the 0=Sunday convention `Date#getUTCDay` also uses. Confirmed against
// the oracle below, not asserted from memory ("Unix epoch is a Thursday" is
// common trivia, but this suite trusts nothing it has not itself checked).
const EARTH_DAY_UNITS = {
  values: [0, 1, 2, 3, 4, 5, 6], // 7 entries — only .length is used (the weekday modulus)
  hoursPerDay: 24,
  minutesPerHour: 60,
  secondsPerMinute: 60,
};
// The exact CalendarConfig shape every other caller in this feature passes —
// months/days/years, no bespoke wrapper (core/gregorian-math.js's own doc).
const EARTH_CALENDAR = { months: GREGORIAN_MONTHS, days: EARTH_DAY_UNITS, years: { firstWeekday: 4 } };

/**
 * The independent oracle. `setUTCFullYear`/`getUTC*` — NOT `Date.UTC`/`new
 * Date(y,...)`, which both apply the legacy 0-99-means-1900+y remap.
 * @param {number} year @param {number} month1 - 1..12 @param {number} day
 * @param {number} [hour] @param {number} [minute] @param {number} [second]
 * @returns {number} seconds since 1970-01-01T00:00:00Z, signed
 */
function oracleSeconds(year, month1, day, hour = 0, minute = 0, second = 0) {
  const d = new Date(0);
  d.setUTCFullYear(year, month1 - 1, day);
  d.setUTCHours(hour, minute, second, 0);
  return d.valueOf() / 1000;
}

/** @param {number} seconds @returns {{year:number,month:number,day:number,hour:number,minute:number,second:number,weekday:number}} */
function oracleComponents(seconds) {
  const d = new Date(seconds * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1, // 1-indexed, matching daysFromCivil's convention
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(), // 0 = Sunday
  };
}

/** Deterministic LCG — no Math.random(), so a failing seed is reproducible. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function run(t) {
  // ---- 0. the oracle itself is trustworthy -----------------------------
  {
    const d = new Date(0);
    d.setUTCFullYear(0, 0, 1);
    t.ok('oracle: year 0 is NOT remapped to 1900 (the setUTCFullYear escape hatch)', d.getUTCFullYear() === 0);
    t.ok('oracle: 2026-08-17 is a Monday (getUTCDay===1)', oracleComponents(oracleSeconds(2026, 8, 17)).weekday === 1);
    t.ok(
      'oracle: 1970-01-01 (day 0) is a Thursday (getUTCDay===4) — calibrates EARTH_WEEK.firstWeekday below',
      oracleComponents(oracleSeconds(1970, 1, 1)).weekday === 4
    );
  }

  // ---- 1. isGregorianLeapYear against the real rule ---------------------
  {
    t.ok('2000 is leap (/400)', isGregorianLeapYear(2000) === true);
    t.ok('1900 is NOT leap (/100, not /400)', isGregorianLeapYear(1900) === false);
    t.ok('2100 is NOT leap (/100, not /400)', isGregorianLeapYear(2100) === false);
    t.ok('2024 is leap (/4)', isGregorianLeapYear(2024) === true);
    t.ok('2026 is NOT leap', isGregorianLeapYear(2026) === false);
    t.ok('year 0 is leap (0 % 400 === 0, proleptic convention)', isGregorianLeapYear(0) === true);
    t.ok('year -400 is leap', isGregorianLeapYear(-400) === true);
    t.ok('year -100 is NOT leap', isGregorianLeapYear(-100) === false);
  }

  // ---- 2. daysFromCivil / civilFromDays against the oracle, wide sample -
  {
    const probes = [
      [1970, 1, 1],
      [1969, 12, 31],
      [2000, 2, 29],
      [1900, 3, 1],
      [2100, 3, 1],
      [2024, 2, 29],
      [2026, 8, 17],
      [1, 1, 1],
      [0, 1, 1],
      [0, 12, 31],
      [-1, 1, 1],
      [-400, 2, 29],
      [4, 12, 31],
      [9999, 1, 1],
    ];
    let allDaysMatch = true;
    let allRoundTrip = true;
    for (const [y, m, d] of probes) {
      const oracleDays = Math.round(oracleSeconds(y, m, d) / 86400);
      const mine = daysFromCivil(y, m, d);
      if (mine !== oracleDays) {
        allDaysMatch = false;
        console.error(`  daysFromCivil(${y},${m},${d}) = ${mine}, oracle says ${oracleDays}`);
      }
      const back = civilFromDays(mine);
      if (back.year !== y || back.month !== m || back.day !== d) {
        allRoundTrip = false;
        console.error(`  civilFromDays(daysFromCivil(${y},${m},${d})) = ${JSON.stringify(back)}`);
      }
    }
    t.ok(`daysFromCivil matches the Date oracle on ${probes.length} probes incl. negative/century years`, allDaysMatch);
    t.ok('civilFromDays is the exact inverse on every probe', allRoundTrip);
  }

  // ---- 3. daysFromCivil / civilFromDays, randomised wide sweep ----------
  {
    const rng = makeRng(0xc0ffee);
    let ok = true;
    let n = 0;
    for (let i = 0; i < 2000; i++) {
      const year = Math.floor(rng() * 8000) - 2000; // -2000..5999
      const month = 1 + Math.floor(rng() * 12);
      const day = 1 + Math.floor(rng() * 28); // stay in-range for every month, incl. Feb
      const mine = daysFromCivil(year, month, day);
      const back = civilFromDays(mine);
      n++;
      if (back.year !== year || back.month !== month || back.day !== day) {
        ok = false;
        console.error(`  round-trip failed: (${year},${month},${day}) -> ${mine} -> ${JSON.stringify(back)}`);
        break;
      }
    }
    t.ok(`daysFromCivil/civilFromDays round-trip exactly across ${n} random (year,month,day) triples`, ok);
  }

  // ---- 4. decomposeTrueGregorianYear against the oracle ------------------
  {
    const cases = [
      { y: 2026, m: 8, d: 17, h: 12 },
      { y: 2000, m: 2, d: 29, h: 0 },
      { y: 2100, m: 1, d: 1, h: 0 },
      { y: 1, m: 1, d: 1, h: 0 },
      { y: 0, m: 1, d: 1, h: 0 },
      { y: -1, m: 12, d: 31, h: 23 },
    ];
    let ok = true;
    for (const c of cases) {
      const abs = oracleSeconds(c.y, c.m, c.d, c.h);
      const decomposed = decomposeTrueGregorianYear(abs, EARTH_DAY_UNITS);
      const expectedYearStart = oracleSeconds(c.y, 1, 1);
      const expectedSecond = abs - expectedYearStart;
      if (decomposed.year !== c.y || Math.abs(decomposed.second - expectedSecond) > 1e-9) {
        ok = false;
        console.error(
          `  decomposeTrueGregorianYear(${JSON.stringify(c)}) = ${JSON.stringify(decomposed)}, expected year=${c.y} second=${expectedSecond}`
        );
      }
      if (decomposed.leapYear !== isGregorianLeapYear(c.y)) ok = false;
    }
    t.ok('decomposeTrueGregorianYear: year + seconds-into-year match the oracle', ok);
  }

  // ---- 5. decomposeTrueGregorianTime (full) against the oracle -----------
  {
    const probes = [
      [2026, 8, 17, 14, 30, 45],
      [2000, 2, 29, 23, 59, 59],
      [2100, 3, 1, 0, 0, 0],
      [1, 1, 1, 0, 0, 0],
      [0, 1, 1, 0, 0, 1],
      [2026, 12, 31, 23, 59, 59],
      [2026, 1, 1, 0, 0, 0],
    ];
    let ok = true;
    for (const [y, m, d, h, mi, s] of probes) {
      const abs = oracleSeconds(y, m, d, h, mi, s);
      const got = decomposeTrueGregorianTime(abs, EARTH_CALENDAR);
      const oc = oracleComponents(abs);
      const matches =
        got.year === oc.year &&
        got.month === oc.month - 1 && // ours is 0-indexed
        got.dayOfMonth === oc.day - 1 &&
        got.hour === oc.hour &&
        got.minute === oc.minute &&
        got.second === oc.second &&
        got.dayOfWeek === oc.weekday;
      if (!matches) {
        ok = false;
        console.error(
          `  decomposeTrueGregorianTime(${y}-${m}-${d} ${h}:${mi}:${s}) = ${JSON.stringify(got)}, oracle = ${JSON.stringify(oc)}`
        );
      }
    }
    t.ok('decomposeTrueGregorianTime (full: y/m/d/h/m/s/weekday) matches the oracle on every probe', ok);
  }

  // ---- 6. composeTrueGregorianTime is the exact inverse, randomised ------
  {
    const rng = makeRng(0xdeadbeef);
    let ok = true;
    let n = 0;
    for (let i = 0; i < 2000; i++) {
      const seconds = Math.floor((rng() - 0.5) * 2 * 1e11); // wide range incl. negative
      const decomposed = decomposeTrueGregorianTime(seconds, EARTH_CALENDAR);
      const recomposed = composeTrueGregorianTime(decomposed, EARTH_CALENDAR);
      n++;
      if (recomposed !== seconds) {
        ok = false;
        console.error(`  round-trip failed: ${seconds} -> ${JSON.stringify(decomposed)} -> ${recomposed}`);
        break;
      }
    }
    t.ok(`decompose→compose round-trips EXACTLY across ${n} random second values (incl. negative)`, ok);
  }

  // ---- 7. composeTrueGregorianTime against the oracle, forward direction -
  {
    const probes = [
      { year: 2026, month: 7, dayOfMonth: 16, hour: 14, minute: 30, second: 45 }, // Aug 17 0-idx
      { year: 2000, month: 1, dayOfMonth: 28, hour: 23, minute: 59, second: 59 }, // Feb 29 0-idx
      { year: 2100, month: 2, dayOfMonth: 0, hour: 0, minute: 0, second: 0 }, // Mar 1 0-idx
    ];
    let ok = true;
    for (const c of probes) {
      const mine = composeTrueGregorianTime(c, EARTH_CALENDAR);
      const oracle = oracleSeconds(c.year, c.month + 1, c.dayOfMonth + 1, c.hour, c.minute, c.second);
      if (mine !== oracle) {
        ok = false;
        console.error(`  composeTrueGregorianTime(${JSON.stringify(c)}) = ${mine}, oracle = ${oracle}`);
      }
    }
    t.ok('composeTrueGregorianTime matches the oracle on hand-picked leap-adjacent probes', ok);
  }

  // ---- 8. a leap-year month table is consumed correctly ------------------
  {
    // Feb 29 2000 (leap) must exist; Feb 29 2100 (non-leap) must roll to Mar 1.
    const leapFeb29 = composeTrueGregorianTime({ year: 2000, month: 1, dayOfMonth: 28 }, EARTH_CALENDAR);
    const oracleLeap = oracleSeconds(2000, 2, 29);
    t.ok('Feb 29 2000 composes to the real leap day', leapFeb29 === oracleLeap);

    const decomposedLeap = decomposeTrueGregorianTime(oracleLeap, EARTH_CALENDAR);
    t.ok(
      'decomposing Feb 29 2000 reports leapYear=true, month=1(Feb), day=28(29th)',
      decomposedLeap.leapYear === true && decomposedLeap.month === 1 && decomposedLeap.dayOfMonth === 28
    );

    const nonLeapCentury = decomposeTrueGregorianTime(oracleSeconds(2100, 3, 1), EARTH_CALENDAR);
    t.ok(
      '2100-03-01 decomposes to leapYear=false (the century non-leap case)',
      nonLeapCentury.leapYear === false && nonLeapCentury.month === 2 && nonLeapCentury.dayOfMonth === 0
    );
  }
}
