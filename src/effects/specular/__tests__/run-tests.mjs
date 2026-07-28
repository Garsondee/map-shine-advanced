/**
 * src/effects/specular/ verification — the material decode and the effect
 * declaration.
 *
 * The TSL transcription itself is browser-only and gets a debug-panel report
 * instead; what CAN be tested here is every formula it evaluates, extracted as
 * plain functions (`specular-material.js`). See `specular-material.test.mjs`'s
 * own header for why a shine effect in particular must not be left to an
 * eyeball: it renders a plausible highlight from a wrong decode just as
 * happily as from a right one.
 *
 * Discovered and run by tools/run-tests.mjs (glob of __tests__/run-tests.mjs);
 * `npm test` / `npm run verify` picks it up for free.
 */
import { run as runSpecularMaterial } from './specular-material.test.mjs';
import { run as runSpecularPattern } from './specular-pattern.test.mjs';
import { run as runSpecularIslands } from './specular-islands.test.mjs';
import { run as runSpecularRender } from './specular-render.test.mjs';
import { run as runSpecularSubsystem } from './specular-surface-subsystem.test.mjs';
import { run as runSpecular } from './specular.test.mjs';

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
  ['specular-material', runSpecularMaterial],
  ['specular-pattern', runSpecularPattern],
  ['specular-islands', runSpecularIslands],
  ['specular-render', runSpecularRender],
  ['specular-surface-subsystem', runSpecularSubsystem],
  ['specular', runSpecular],
];
// AWAITED, not called-and-dropped: `specular-surface-subsystem.test.mjs` has to
// let the mask load settle (the subsystem's own `.then`) before it can assert
// on visibility, and a dropped promise here would let its assertions run AFTER
// the summary printed — reporting green on a suite that had not finished, which
// is the exact shape of a lying instrument (`feedback_instruments_must_not_lie`).
// Top-level await; sync suites await to `undefined` and are unaffected.
for (const [name, fn] of suites) {
  const before = failed;
  await fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : 'FAILED'}`);
}

console.log(`\nsrc/effects/specular verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
