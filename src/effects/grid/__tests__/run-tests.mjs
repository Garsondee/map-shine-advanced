/**
 * src/effects/grid/ verification — Foundry's grid and outline, ported to TSL: every type × style
 * constructs, through the real present material, and the uniforms carry what GridShader#_preRender would.
 *
 * Discovered and run by tools/run-tests.mjs (glob of __tests__/run-tests.mjs);
 * `npm test` / `npm run verify` picks it up for free.
 */
import { run as runFoundryGridRender } from './foundry-grid-render.test.mjs';
import { run as runGrid } from './grid.test.mjs';

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
  ['foundry-grid-render', runFoundryGridRender],
  ['grid', runGrid],
];
for (const [name, fn] of suites) {
  const before = failed;
  await fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : 'FAILED'}`);
}

console.log(`\nsrc/effects/grid verification: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFailures:\n  - ' + fails.join('\n  - '));
  process.exit(1);
}
