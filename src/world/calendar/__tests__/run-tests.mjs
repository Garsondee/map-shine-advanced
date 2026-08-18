/** src/world/calendar/ verification — the schema, moon, and format layers. */
import { run as runSchema } from './calendar-schema.test.mjs';
import { run as runMoon } from './moon.test.mjs';
import { run as runFormat } from './format.test.mjs';
import { run as runPf2eParity } from './pf2e-parity.test.mjs';

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
  ['calendar-schema', runSchema],
  ['moon', runMoon],
  ['format', runFormat],
  ['pf2e-parity', runPf2eParity],
];
for (const [name, fn] of suites) {
  const before = failed;
  fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : 'FAILED'}`);
}

console.log(`\nsrc/world/calendar verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
