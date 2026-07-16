/**
 * src/world/ + core/frame-clock verification — the env snapshot's pure core.
 *
 * Run:
 *   node ./node_modules/esbuild/bin/esbuild src/world/__tests__/run-tests.mjs \
 *     --bundle --format=esm --platform=node --outfile=<tmp>.mjs && node <tmp>.mjs
 */
import { run as runSun } from './sun.test.mjs';
import { run as runEnvironment } from './environment.test.mjs';
import { run as runFrameClock } from './frame-clock.test.mjs';

let passed = 0;
let failed = 0;
const fails = [];
const t = {
  ok(name, cond) {
    if (cond) passed++;
    else {
      failed++;
      fails.push(name);
      console.error('  FAIL:', name);
    }
  },
  throws(name, fn, sub) {
    try {
      fn();
      failed++;
      fails.push(name + ' (did not throw)');
    } catch (e) {
      if (!sub || String(e.message).includes(sub)) passed++;
      else {
        failed++;
        fails.push(name + ' (wrong message)');
      }
    }
  },
};

const suites = [
  ['sun', runSun],
  ['environment', runEnvironment],
  ['frame-clock', runFrameClock],
];
for (const [name, fn] of suites) {
  const before = failed;
  fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : 'FAILED'}`);
}

console.log(`\nsrc/world verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
