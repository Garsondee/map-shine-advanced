/**
 * src/effects/vision/ verification — the reveal RULE and the mesh-pool
 * reconciliation for "MSA owns vision/fog" (Testament Pillar 11).
 *
 * ⚠️ These are player-safety tests, not arithmetic tests. Law 7 makes vision
 * gating sacred, so `decideRevealed` is written as the CPU TWIN of the shader
 * that will rasterise it — a shader change that diverges from the intended
 * rule must fail HERE rather than silently show a player something they
 * should not see.
 *
 * Discovered and run by tools/run-tests.mjs (glob of __tests__/run-tests.mjs);
 * `npm test` / `npm run verify` picks it up for free — no dispatch list to
 * forget this directory (`feedback_test_dispatch_list_forgets_new_files`).
 */
import { run as runVisionMask } from './vision-mask.test.mjs';

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

const suites = [['vision-mask', runVisionMask]];
for (const [name, fn] of suites) {
  const before = failed;
  fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : 'FAILED'}`);
}

console.log(`\nsrc/effects/vision verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
