/**
 * src/effects/prism/ verification — the manifest, the pure facet/glint/
 * dispersion maths, the TSL material graph, mask discovery and the
 * refraction-capture subsystem. Discovered and run by tools/run-tests.mjs
 * (glob of __tests__/run-tests.mjs); `npm test` / `npm run verify` picks it
 * up for free.
 */
import { run as runPrism } from './prism.test.mjs';
import { run as runPrismMotion } from './prism-motion.test.mjs';
import { run as runPrismRender } from './prism-render.test.mjs';
import { run as runPrismSeams } from './prism-seams.test.mjs';
import { run as runPrismRefractionSubsystem } from './prism-refraction-subsystem.test.mjs';
import { run as runPrismSurfaceSubsystem } from './prism-surface-subsystem.test.mjs';

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
  ['prism', runPrism],
  ['prism-motion', runPrismMotion],
  ['prism-render', runPrismRender],
  ['prism-seams', runPrismSeams],
  ['prism-refraction-subsystem', runPrismRefractionSubsystem],
  ['prism-surface-subsystem', runPrismSurfaceSubsystem],
];
// AWAITED, not called-and-dropped — mirrors `effects/specular/__tests__/
// run-tests.mjs`'s own header exactly: `prism-surface-subsystem.test.mjs`
// has to let its mask-load promises settle before asserting on visibility,
// and a dropped promise here would let its assertions run AFTER the summary
// printed (`feedback_instruments_must_not_lie`). Sync suites await to
// `undefined` and are unaffected.
for (const [name, fn] of suites) {
  const before = failed;
  await fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : 'FAILED'}`);
}

console.log(`\nsrc/effects/prism verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
