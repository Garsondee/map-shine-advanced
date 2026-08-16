/**
 * src/effects/precipitation/ verification — the species table's response model
 * (docs/planning/Precipitation.md §2), proven in Node before a pixel is drawn.
 *
 * The FALL runtime's TSL is browser-only and gets the shader lab's
 * `bench-precip` instead (CONVENTIONS.md §4) — but every FORMULA that runtime
 * evaluates on the CPU to set its uniforms lives in `precip-species.js` and is
 * tested here. That split is deliberate: §11's "CPU twins first" rule means the
 * response curves must be right in Node before the kernel is asked to render
 * them, so a wrong picture in the lab is a shader bug and never an arithmetic
 * one.
 *
 * Discovered and run by tools/run-tests.mjs (glob of __tests__/run-tests.mjs);
 * `npm test` / `npm run verify` picks it up for free.
 */
import { run as runSpecies } from './precip-species.test.mjs';
import { run as runMantle } from './mantle-model.test.mjs';
import { run as runSquall } from './squall-field.test.mjs';

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
  ['precip-species', runSpecies],
  ['mantle-model', runMantle],
  ['squall-field', runSquall],
];
for (const [name, fn] of suites) {
  const before = failed;
  fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : 'FAILED'}`);
}

console.log(`\nsrc/effects/precipitation verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
