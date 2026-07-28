/**
 * src/effects/window/ verification — the cookie decode, the effect
 * declaration, the TSL graph construction, and the surface subsystem.
 *
 * The TSL transcription itself is browser-only and gets a debug-panel report
 * instead; what CAN be tested here is every formula it evaluates, extracted
 * as plain functions (`window-cookie.js`), plus THAT the TSL graph actually
 * constructs in Node (`window-render.test.mjs` — `keyhole-tsl-constructs-
 * in-node`: a green Node suite proved nothing about a live startup crash
 * exactly once already in this codebase, at 4,460 assertions).
 *
 * Discovered and run by tools/run-tests.mjs (glob of __tests__/run-tests.mjs);
 * `npm test` / `npm run verify` picks it up for free.
 */
import { run as runWindowCookie } from './window-cookie.test.mjs';
import { run as runWindow } from './window.test.mjs';
import { run as runWindowRender } from './window-render.test.mjs';
import { run as runWindowSurfaceSubsystem } from './window-surface-subsystem.test.mjs';

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
  ['window-cookie', runWindowCookie],
  ['window', runWindow],
  ['window-render', runWindowRender],
  ['window-surface-subsystem', runWindowSurfaceSubsystem],
];
// AWAITED, not called-and-dropped — the subsystem suite lets a mask load
// settle before asserting on visibility, same reasoning as specular's own
// harness (a dropped promise here would let assertions run AFTER the summary
// printed, reporting green on a suite that had not finished —
// `feedback_instruments_must_not_lie`).
for (const [name, fn] of suites) {
  const before = failed;
  await fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : 'FAILED'}`);
}

console.log(`\nsrc/effects/window verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
