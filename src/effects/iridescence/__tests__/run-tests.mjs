/**
 * src/effects/iridescence/ verification — the manifest, the pure mask/noise/
 * phase/palette maths, the TSL material graph, and mask discovery/surface
 * population. Discovered and run by tools/run-tests.mjs (glob of
 * __tests__/run-tests.mjs); `npm test` / `npm run verify` picks it up for
 * free.
 */
import { run as runIridescence } from './iridescence.test.mjs';
import { run as runIridescenceMotion } from './iridescence-motion.test.mjs';
import { run as runIridescenceRender } from './iridescence-render.test.mjs';
import { run as runIridescenceSeams } from './iridescence-seams.test.mjs';
import { run as runIridescenceSurfaceSubsystem } from './iridescence-surface-subsystem.test.mjs';

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
        fails.push(name + ` (wrong message: ${e.message})`);
      }
    }
  },
};

const suites = [
  ['iridescence', runIridescence],
  ['iridescence-motion', runIridescenceMotion],
  ['iridescence-render', runIridescenceRender],
  ['iridescence-seams', runIridescenceSeams],
  ['iridescence-surface-subsystem', runIridescenceSurfaceSubsystem],
];
// AWAITED, not called-and-dropped — mirrors `effects/prism/__tests__/
// run-tests.mjs`'s own header exactly: `iridescence-surface-subsystem.test.mjs`
// has to let its mask-load promises settle before asserting on visibility,
// and a dropped promise here would let its assertions run AFTER the summary
// printed (`feedback_instruments_must_not_lie`). Sync suites await to
// `undefined` and are unaffected.
for (const [name, fn] of suites) {
  const before = failed;
  await fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : 'FAILED'}`);
}

console.log(`\nsrc/effects/iridescence verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
