/**
 * THE GATE'S OWN TESTS — because an unverified gate is the thing we just fixed.
 *
 * `tools/run-tests.mjs` is now the only thing standing between a broken sort law
 * and a green checkmark. It spent its whole life until 2026-07-17 running 94 of
 * 1,005 assertions while printing "ALL GREEN", so it does not get to be trusted
 * on its own say-so. These cover the three rules its header states, and the one
 * that actually bit: **silence must be failure.**
 *
 * @module tools/run-tests.test
 */

import { discoverSuites, parseSuiteReport } from './run-tests.mjs';

export function run(t) {
  const { ok } = t;

  // --- rule 2: SILENCE IS FAILURE -------------------------------------------
  // The load-bearing one. `parseSuiteReport` returning null MUST be treated as
  // a failure by the caller, never coerced to {passed:0, failed:0} — that would
  // read as "a suite with nothing to run", i.e. green. This is doctrine 5
  // (Keyhole.md §0) in its most literal form: "I could not measure it" must not
  // land on the same value as "it passed".
  ok('a suite that printed nothing does not report', parseSuiteReport('') === null);
  ok('a suite that crashed does not report', parseSuiteReport('SyntaxError: boom\n  at foo') === null);
  ok('null is distinguishable from a real zero', parseSuiteReport('0 passed, 0 failed') !== null);
  ok('...and a real zero parses as zero', parseSuiteReport('0 passed, 0 failed').passed === 0);

  // A near-miss must NOT parse. If the format drifts, we want a loud "no
  // report" rather than a confident wrong number scraped from adjacent prose.
  ok('partial output does not half-parse', parseSuiteReport('12 passed') === null);
  ok('prose about passing does not parse', parseSuiteReport('everything passed, nothing failed') === null);

  // --- parsing the real thing ------------------------------------------------
  {
    const r = parseSuiteReport('\nsrc/vt verification: 229 passed, 0 failed\nALL GREEN');
    ok('parses a real green suite line', r && r.passed === 229 && r.failed === 0);
  }
  {
    const r = parseSuiteReport('  FAIL: the law\nsrc/scene verification: 147 passed, 1 failed\n');
    ok('parses a real red suite line', r && r.passed === 147 && r.failed === 1);
  }

  // --- rule 1: DISCOVERY, NEVER A LIST --------------------------------------
  // A hand-maintained import list is what drifts: Keyhole.md's own tally said
  // 984 because it was written by hand and missed effects/particles' 21. Globbed
  // discovery means a new suite is picked up for free — zero work to comply,
  // which is Skeleton.md §0 law 2 (the correct path must be the FAST path).
  {
    const suites = discoverSuites();
    const rel = suites.map((s) => s.replace(/\\/g, '/').replace(/^.*\/src\//, 'src/'));
    ok('discovery finds suites at all', suites.length > 0);
    ok('discovery finds every zone that has one', rel.length >= 8);
    ok(
      'discovery reaches a NESTED suite (effects/particles, the one the docs missed)',
      rel.some((r) => r.includes('effects/particles/__tests__/run-tests.mjs'))
    );
    ok(
      'discovery finds the vt suite',
      rel.some((r) => r === 'src/vt/__tests__/run-tests.mjs')
    );
    ok(
      'discovery finds the graph suite',
      rel.some((r) => r === 'src/graph/__tests__/run-tests.mjs')
    );
    ok('discovery is sorted (stable output across machines)', rel.join() === [...rel].sort().join());
    ok(
      'discovery returns ONLY run-tests entry points',
      rel.every((r) => r.endsWith('/__tests__/run-tests.mjs'))
    );
    ok(
      'discovery never returns vendored code',
      rel.every((r) => !r.includes('/vendor/'))
    );
  }
}
