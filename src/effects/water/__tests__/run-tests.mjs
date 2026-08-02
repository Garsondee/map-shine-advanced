/**
 * src/effects/water/ verification — the water declaration, the cross-floor
 * rule, and the body pack's arithmetic.
 *
 * The TSL builders themselves are browser-only and get debug-panel reports
 * instead (CONVENTIONS.md §4). What CAN be tested here is every formula they
 * evaluate, extracted as plain functions and run against brute force — see
 * `water-body.test.mjs`'s own header for why the jump flood in particular
 * cannot be left to a live eyeball.
 *
 * Discovered and run by tools/run-tests.mjs (glob of __tests__/run-tests.mjs);
 * `npm test` / `npm run verify` picks it up for free.
 */
import { run as runWater } from './water.test.mjs';
import { run as runWaterFloor } from './water-floor.test.mjs';
import { run as runWaterBody } from './water-body.test.mjs';
import { run as runWaterLight } from './water-light.test.mjs';
import { run as runWaterRender } from './water-render.test.mjs';

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
        fails.push(name + ' (wrong message: ' + e.message + ')');
      }
    }
  },
};

const suites = [
  ['water', runWater],
  ['water-floor', runWaterFloor],
  ['water-body', runWaterBody],
  ['water-light', runWaterLight],
  // LAST, because it is the only suite that imports the real THREE bundle —
  // keeping it at the end means a failure in the pure-arithmetic suites is
  // reported before the heavyweight one even loads.
  ['water-render', runWaterRender],
];
for (const [name, fn] of suites) {
  const before = failed;
  fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : 'FAILED'}`);
}

console.log(`\nsrc/effects/water verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
