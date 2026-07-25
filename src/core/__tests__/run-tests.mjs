/** src/core/ verification — the shared contracts (params, frame clock, seams). */
import { run as runParams } from './params-schema.test.mjs';
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
};

const suites = [
  ['params-schema', runParams],
  ['frame-clock', runFrameClock],
];
for (const [name, fn] of suites) {
  const before = failed;
  fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : 'FAILED'}`);
}

console.log(`\nsrc/core verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
