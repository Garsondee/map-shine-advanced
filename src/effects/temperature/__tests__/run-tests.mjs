/**
 * src/effects/temperature/ verification — the bands and grade delta, the
 * frost's growth, the baked tile, and that the warp layers' TSL graph builds
 * inside the real present material.
 *
 * Discovered and run by tools/run-tests.mjs (glob of __tests__/run-tests.mjs);
 * `npm test` / `npm run verify` picks it up for free.
 */
import { run as runTemperature } from './temperature.test.mjs';
import { run as runTemperatureNoise } from './temperature-noise.test.mjs';
import { run as runTemperatureRender } from './temperature-render.test.mjs';

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
  ['temperature', runTemperature],
  ['temperature-noise', runTemperatureNoise],
  ['temperature-render', runTemperatureRender],
];
for (const [name, fn] of suites) {
  const before = failed;
  await fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : 'FAILED'}`);
}

console.log(`\nsrc/effects/temperature verification: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFailures:\n  - ' + fails.join('\n  - '));
  process.exit(1);
}
