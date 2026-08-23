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
import { run as runWaterFlowSolve } from './water-flow-solve.test.mjs';
import { run as runWaterLight } from './water-light.test.mjs';
import { run as runWaterRender } from './water-render.test.mjs';
import { run as runWaterFlow } from './water-flow.test.mjs';
import { run as runWaterBodySubsystem } from './water-body-subsystem.test.mjs';
import { run as runWaterFlowSubsystem } from './water-flow-subsystem.test.mjs';
import { run as runWaterSim } from './water-sim.test.mjs';
import { run as runWaterSimSubsystem } from './water-sim-subsystem.test.mjs';
import { run as runWaterRefractionSubsystem } from './water-refraction-subsystem.test.mjs';
import { run as runWaterField } from './water-field.test.mjs';
import { run as runWaterSampling } from './water-sampling.test.mjs';
import { run as runWaterBounds } from './water-bounds.test.mjs';
import { run as runWaterShore } from './water-shore.test.mjs';
import { run as runWaterRegistration } from './water-registration.test.mjs';

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
  ['water-registration', runWaterRegistration],
  ['water-floor', runWaterFloor],
  ['water-body', runWaterBody],
  ['water-flow-solve', runWaterFlowSolve],
  ['water-bounds', runWaterBounds],
  ['water-field', runWaterField],
  ['water-sampling', runWaterSampling],
  ['water-shore', runWaterShore],
  ['water-light', runWaterLight],
  // LAST, because these are the only suites that import the real THREE
  // bundle — keeping them at the end means a failure in the pure-arithmetic
  // suites is reported before the heavyweight ones even load.
  ['water-render', runWaterRender],
  ['water-flow', runWaterFlow],
  ['water-body-subsystem', runWaterBodySubsystem],
  ['water-flow-subsystem', runWaterFlowSubsystem],
  ['water-sim', runWaterSim],
  ['water-sim-subsystem', runWaterSimSubsystem],
  ['water-refraction-subsystem', runWaterRefractionSubsystem],
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
