/**
 * src/effects/clouds/ verification — the tops' manifest declaration, the
 * zoom-gate/parallax pure math, and that the tops' TSL graph actually
 * constructs in Node. The FIELD's own tests (`cloudRecipeFor`, `coverThreshold`,
 * `cloudDriftStep`, `buildCloudFieldNode`, ...) live under `src/world/__tests__/`
 * (`world/cloud-field.js`'s own home) — not duplicated here.
 *
 * Discovered and run by tools/run-tests.mjs (glob of __tests__/run-tests.mjs);
 * `npm test` / `npm run verify` picks it up for free.
 */
import { run as runCloudTops } from './cloud-tops.test.mjs';

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
};

const suites = [['cloud-tops', runCloudTops]];
for (const [name, fn] of suites) {
  const before = failed;
  await fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : 'FAILED'}`);
}

console.log(`\nsrc/effects/clouds verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
