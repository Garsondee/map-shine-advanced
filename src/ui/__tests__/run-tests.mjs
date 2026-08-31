/**
 * src/ui/ verification.
 *
 * Pure logic — no DOM, no Foundry — unit-testable under Node. The overlays
 * themselves are browser-only and verified live via the debug panel; what lives
 * here is every rule about what they are allowed to CLAIM.
 *
 * Run:
 *   node ./node_modules/esbuild/bin/esbuild src/ui/__tests__/run-tests.mjs \
 *     --bundle --format=esm --platform=node --outfile=<tmp>.mjs && node <tmp>.mjs
 */
import { run as runAstrolabe } from './astrolabe-geometry.test.mjs';
import { run as runLoadProgress } from './load-progress.test.mjs';
import { run as runPerfProgressOverlay } from './perf-progress-overlay.test.mjs';
import { run as runFloorTransition } from './floor-transition.test.mjs';
import { run as runTokens } from './tokens.test.mjs';
import { run as runAstrolabeDial } from './astrolabe-dial.test.mjs';
import { run as runPainterDepartment } from './painter-department.test.mjs';
import { run as runPaintMode } from './paint-mode.test.mjs';

let passed = 0;
let failed = 0;
const fails = [];

const t = {
  ok(name, cond) {
    if (cond) {
      passed++;
    } else {
      failed++;
      fails.push(name);
      console.error('  FAIL:', name);
    }
  },
  throws(name, fn, matchSubstr) {
    try {
      fn();
      failed++;
      fails.push(name);
      console.error('  FAIL (no throw):', name);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (matchSubstr && !msg.includes(matchSubstr)) {
        failed++;
        fails.push(name);
        console.error('  FAIL (wrong msg):', name, '->', msg);
      } else {
        passed++;
      }
    }
  },
};

const suites = [
  ['astrolabe', runAstrolabe],
  ['load-progress', runLoadProgress],
  ['perf-progress-overlay', runPerfProgressOverlay],
  ['floor-transition', runFloorTransition],
  ['tokens', runTokens],
  ['astrolabe-dial', runAstrolabeDial],
  ['painter-department', runPainterDepartment],
  // LAST on purpose: paint-mode installs a `document` shim for its toolbar
  // half. It removes it again, but `floor-transition` above asserts the
  // no-DOM path, so ordering it after that suite costs nothing and removes
  // the only way a leak could ever be mistaken for a passing assertion.
  ['paint-mode', runPaintMode],
];

for (const [name, fn] of suites) {
  const before = failed;
  await fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : `${failed - before} FAILED`}`);
}

console.log(`\nsrc/ui verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
