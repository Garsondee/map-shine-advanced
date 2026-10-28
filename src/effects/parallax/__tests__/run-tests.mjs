/**
 * src/effects/parallax/ verification — the declaration, the depth maths, and the per-frame
 * transform subsystem the viewer drives.
 *
 * Discovered and run by tools/run-tests.mjs (glob of __tests__/run-tests.mjs);
 * `npm test` / `npm run verify` picks it up for free.
 */
import { run as runParallaxModel } from './parallax-model.test.mjs';
import { run as runParallaxSubsystem } from './parallax-subsystem.test.mjs';

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
  ['parallax-model', runParallaxModel],
  ['parallax-subsystem', runParallaxSubsystem],
];
for (const [name, fn] of suites) {
  const before = failed;
  await fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : 'FAILED'}`);
}

console.log(`\nsrc/effects/parallax verification: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFailures:\n  - ' + fails.join('\n  - '));
  process.exit(1);
}
