/**
 * src/effects/fire/ verification — the fire effect's pure math.
 *
 * Everything under test here is a total function over numbers: the scale chain,
 * the puff law, the slice table, the coverage gate, clustering, the light
 * descriptors and the vertex bake. The TSL material and the JFA passes are
 * browser-only and are verified in the Shader Lab (`tools/shader-lab/
 * bench-fire.js`) instead — don't fake a WebGPU mock to force them in here.
 *
 * Discovered and run by tools/run-tests.mjs (glob of __tests__/run-tests.mjs);
 * `npm test` / `npm run verify` picks it up for free.
 */
import { run as runFireGeometry } from './fire-geometry.test.mjs';
import { run as runFire } from './fire.test.mjs';
import { run as runFireMask } from './fire-mask.test.mjs';
import { run as runFireSprite } from './fire-sprite.test.mjs';
import { run as runFireSpawnPoints } from './fire-spawn-points.test.mjs';
import { run as runFireSubsystem } from './fire-subsystem.test.mjs';

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
  ['fire-geometry', runFireGeometry],
  ['fire', runFire],
  ['fire-mask', runFireMask],
  ['fire-sprite', runFireSprite],
  ['fire-spawn-points', runFireSpawnPoints],
  ['fire-subsystem', runFireSubsystem],
];
for (const [name, fn] of suites) {
  const before = failed;
  fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : 'FAILED'}`);
}

console.log(`\nsrc/effects/fire verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
