/**
 * THE TEST GATE — every suite in the repo, run by `npm run verify`.
 *
 * ============================================================================
 * WHY THIS FILE WAS REWRITTEN (2026-07-17)
 * ============================================================================
 *
 * It used to run ONE suite: the structure-wall regression proof (94
 * assertions). It printed "ALL GREEN". There were 1,005 assertions.
 *
 * The other 911 — the layering law, the coordinate model, the occlusion model,
 * the params contract, the pass graph, the VT core, the sun — lived in eight
 * `src/<zone>/__tests__/run-tests.mjs` suites that each needed a hand-typed
 * ~100-character esbuild incantation to run:
 *
 *   node ./node_modules/esbuild/bin/esbuild src/graph/__tests__/run-tests.mjs \
 *     --bundle --format=esm --platform=node --outfile=./.t.mjs && node ./.t.mjs
 *
 * That is `EffectComposer` all over again, at the altitude of the tests
 * (memory: v2-postmortem-the-failure-modes). The suites were GOOD. Running
 * them was OPTIONAL, and optional loses — not to carelessness, but because
 * skipping cost nothing and running cost eight commands. Skeleton.md §0 law 2:
 * **the correct path must be the FAST path.** It was the slow one.
 *
 * The friction turned out to be a one-line lie: package.json had no
 * `"type": "module"`, so Node parsed every ES module under src/ as CommonJS
 * and `import { X } from '../thing.js'` threw "Named export not found". esbuild
 * was never doing real work here — no suite imports THREE (the allocator is
 * explicitly mock-driven; the rest is pure logic). It was pure ceremony around
 * a wrong declaration. Declaring the truth deleted the ceremony.
 *
 * And the very first honest run went RED: `pass-health.test.mjs` asserted on
 * `String(evaluatePassHealth)` looking for the word `addEdge` — but esbuild
 * STRIPS COMMENTS, so the assertion had been reading the bundle's text, not the
 * source's, while the real function carried `addEdge` in a comment. A green
 * light with nothing behind it, for exactly as long as nobody ran it properly.
 * (memory: feedback_instruments_must_not_lie)
 *
 * ---------------------------------------------------------------------------
 * THE THREE RULES THIS RUNNER OBEYS
 *
 * 1. DISCOVERY, NEVER A LIST. Suites are globbed off disk. A hand-maintained
 *    import list is the thing that drifts — Keyhole.md's own test tally says
 *    984 because it was written by hand and missed effects/particles' 21. A new
 *    `__tests__/run-tests.mjs` is picked up for free: zero work to comply.
 * 2. SILENCE IS FAILURE. A suite that does not print a parseable
 *    "N passed, M failed" line FAILS, even on exit code 0. "I could not measure
 *    it" must never render as "it passed" (Keyhole.md §0 doctrine 5).
 * 3. ZERO SUITES IS FAILURE. If the glob finds nothing, that is a broken gate,
 *    not a clean repo.
 *
 * Each suite runs in its OWN PROCESS: src/graph's setup-globals.mjs shims
 * `window` at import time, and in a shared process that shim would leak into
 * every later suite — a suite that only passes because another one ran first is
 * the same lie in a new costume.
 *
 * Usage: `npm test` (or `npm run verify`, which includes it)
 *
 * @module tools/run-tests
 */

import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { run as runStructure } from './verify-structure.test.mjs';
import { run as runGateSelfTest } from './run-tests.test.mjs';
import { run as runReachability } from './reachability.test.mjs';
import { run as runTraceAnalyze } from './trace-analyze.test.mjs';
import { run as runChartRoom } from './chart-room/build-chart-room.test.mjs';
import { run as runChartRoomSync } from './chart-room/sync-from-artifact.test.mjs';

// fileURLToPath, not URL.pathname — the repo path contains spaces, which
// pathname percent-encodes into %20 and fs then cannot find.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

/** Vendored third-party code has its own upstream tests; not ours to run. */
const IGNORED = [`${sep}vendor${sep}`];

/**
 * Every suite entry point on disk. Discovery, not a list — see rule 1.
 * @returns {string[]} absolute paths to `__tests__/run-tests.mjs` under src/
 */
export function discoverSuites(dir = SRC, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (IGNORED.some((i) => full.includes(i))) continue;
    if (statSync(full).isDirectory()) discoverSuites(full, out);
    else if (name === 'run-tests.mjs' && full.includes(`${sep}__tests__${sep}`)) out.push(full);
  }
  return out.sort();
}

/**
 * Parse a suite's self-report. Returns null when the suite did not report —
 * which the caller MUST treat as a failure, never as zero (rule 2).
 *
 * @param {string} output - combined stdout+stderr
 * @returns {{passed: number, failed: number}|null}
 */
export function parseSuiteReport(output) {
  const m = /(\d+)\s+passed,\s+(\d+)\s+failed/.exec(output);
  if (!m) return null;
  return { passed: Number(m[1]), failed: Number(m[2]) };
}

/**
 * Run an in-process `run(t)` suite (the tools/ ones, which need no isolation —
 * they touch no globals).
 * @param {string} name
 * @param {(t: {ok: (name: string, cond: unknown) => void}) => void} fn
 */
function runInProcess(name, fn) {
  let passed = 0;
  const fails = [];
  fn({
    ok(label, cond) {
      if (cond) passed++;
      else {
        fails.push(label);
        console.error('  FAIL:', label);
      }
    },
  });
  return { name, passed, failed: fails.length, fails };
}

function main() {
  /** @type {{name: string, passed: number, failed: number, fails?: string[], error?: string}[]} */
  // ⚠️ THIS IS A HAND-MAINTAINED DISPATCH LIST — the one thing rule 1 above
  // forbids everywhere else, surviving here only because these `tools/` suites
  // export `run(t)` for in-process execution rather than self-reporting like the
  // globbed `src/**` suites. It has already cost this project once at the layer
  // below (a whole test FILE never ran, 24 assertions silently unexecuted —
  // memory: feedback_test_dispatch_list_forgets_new_files). Adding a
  // `tools/*.test.mjs` means adding it BOTH as an import above AND as a row
  // here; forgetting either leaves the gate green with nothing behind it.
  const results = [
    runInProcess('tools/verify-structure.test.mjs', runStructure),
    runInProcess('tools/run-tests.test.mjs (the gate testing itself)', runGateSelfTest),
    runInProcess('tools/reachability.test.mjs', runReachability),
    runInProcess('tools/trace-analyze.test.mjs', runTraceAnalyze),
    runInProcess('tools/chart-room/build-chart-room.test.mjs', runChartRoom),
    runInProcess('tools/chart-room/sync-from-artifact.test.mjs', runChartRoomSync),
  ];

  const suites = discoverSuites();
  if (suites.length === 0) {
    console.error('\n❌ NO TEST SUITES FOUND under src/**/__tests__/run-tests.mjs.');
    console.error('   An empty gate is a BROKEN gate, not a clean repo (rule 3).');
    process.exit(1);
  }

  for (const suite of suites) {
    const rel = relative(ROOT, suite).split(sep).join('/');
    const proc = spawnSync(process.execPath, [suite], { encoding: 'utf8', cwd: ROOT });
    const output = (proc.stdout ?? '') + (proc.stderr ?? '');
    const report = parseSuiteReport(output);

    if (report === null) {
      // Rule 2: no report is a FAILURE. The suite may have thrown on import, or
      // changed its output format; either way we did not measure it, and an
      // unmeasured suite has not passed.
      results.push({
        name: rel,
        passed: 0,
        failed: 1,
        error: `suite produced no "N passed, M failed" line (exit ${proc.status}). Output:\n${output.trim() || '(empty)'}`,
      });
      continue;
    }
    // Belt and braces: trust the report, but a non-zero exit with a clean report
    // means the suite disagrees with itself. Fail loudly rather than pick one.
    if (proc.status !== 0 && report.failed === 0) {
      results.push({
        name: rel,
        passed: report.passed,
        failed: 1,
        error: `suite reported 0 failures but exited ${proc.status} — the report and the exit code disagree`,
      });
      continue;
    }
    results.push({
      name: rel,
      passed: report.passed,
      failed: report.failed,
      fails: report.failed ? [output] : undefined,
    });
  }

  const totalPassed = results.reduce((n, r) => n + r.passed, 0);
  const totalFailed = results.reduce((n, r) => n + r.failed, 0);

  console.log('');
  for (const r of results) {
    const mark = r.failed ? '❌' : '✅';
    console.log(`${mark} ${String(r.passed).padStart(4)} passed  ${r.failed ? `${r.failed} FAILED  ` : ''}${r.name}`);
  }
  console.log(`\n${results.length} suites · ${totalPassed} passed · ${totalFailed} failed`);

  if (totalFailed) {
    console.error('\n────────────────────────────────────────────────────────────');
    for (const r of results.filter((x) => x.failed)) {
      console.error(`\n❌ ${r.name}`);
      if (r.error) console.error(`   ${r.error}`);
      for (const f of r.fails ?? []) console.error(`   ${String(f).trim().split('\n').slice(-12).join('\n   ')}`);
    }
    console.error('\n────────────────────────────────────────────────────────────');
    process.exit(1);
  }

  console.log('ALL GREEN');
}

// Only run when invoked directly — keeps discoverSuites/parseSuiteReport
// importable by a future test of this runner without triggering a full run.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
