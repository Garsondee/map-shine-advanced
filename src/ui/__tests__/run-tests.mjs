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
import { run as runAstrolabe } from './astrolabe.test.mjs';
import { run as runLoadProgress } from './load-progress.test.mjs';
import { run as runPerfProgressOverlay } from './perf-progress-overlay.test.mjs';

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
