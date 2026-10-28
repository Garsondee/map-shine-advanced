/**
 * src/effects/table/ verification — the declaration, the ray model, that the
 * surface's TSL graph builds, and the world meshes and fog-gate hook the viewer drives.
 *
 * Discovered and run by tools/run-tests.mjs (glob of __tests__/run-tests.mjs);
 * `npm test` / `npm run verify` picks it up for free.
 */
import { run as runTable } from './table.test.mjs';
import { run as runTableRender } from './table-render.test.mjs';
import { run as runTableSubsystem } from './table-subsystem.test.mjs';

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
  ['table', runTable],
  ['table-render', runTableRender],
  ['table-subsystem', runTableSubsystem],
];
for (const [name, fn] of suites) {
  const before = failed;
  await fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : 'FAILED'}`);
}

console.log(`\nsrc/effects/table verification: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFailures:\n  - ' + fails.join('\n  - '));
  process.exit(1);
}
