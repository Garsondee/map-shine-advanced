/**
 * src/effects/fluid/ verification — the declaration and the tube-net extractor.
 *
 * The TSL builders (pack bake, sim, surface material) are browser-only and get
 * debug-panel reports instead (CONVENTIONS.md §4). What lives here is the whole
 * of the CPU side, and `fluid-net.test.mjs`'s header explains why that suite is
 * the phase's real deliverable rather than a formality: a wrong arc length
 * produces a smooth, plausible, wrong field with no nameable symptom.
 *
 * Discovered and run by tools/run-tests.mjs (glob of __tests__/run-tests.mjs);
 * `npm test` / `npm run verify` picks it up for free.
 */
import { run as runFluid } from './fluid.test.mjs';
import { run as runFluidNet } from './fluid-net.test.mjs';
import { run as runFluidPack } from './fluid-pack.test.mjs';
import { run as runFluidSurface } from './fluid-surface.test.mjs';

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
  ['fluid', runFluid],
  ['fluid-net', runFluidNet],
  ['fluid-pack', runFluidPack],
  ['fluid-surface', runFluidSurface],
];
for (const [name, fn] of suites) {
  const before = failed;
  fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : 'FAILED'}`);
}

console.log(`\nsrc/effects/fluid verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
