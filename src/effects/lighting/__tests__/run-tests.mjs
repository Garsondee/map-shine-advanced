/**
 * src/effects/lighting/ verification — the pure ambient-ladder math of the
 * environmental-light pass and the point-light illumination math (attenuation
 * easing, fan triangulation). The TSL material builds are browser-only.
 *
 * Discovered and run by tools/run-tests.mjs (glob of __tests__/run-tests.mjs);
 * `npm test` / `npm run verify` picks it up for free.
 */
import { run as runEnvironmentalLight } from './environmental-light.test.mjs';
import { run as runPointLightIllumination } from './point-light-illumination.test.mjs';
import { run as runPointLightColoration } from './point-light-coloration.test.mjs';
import { run as runRegionGeometry } from './region-geometry.test.mjs';
import { run as runLightVisibility } from './light-visibility.test.mjs';
import { run as runSunOcclusion } from './sun-occlusion.test.mjs';

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
        fails.push(name + ' (wrong message)');
      }
    }
  },
};

const suites = [
  ['environmental-light', runEnvironmentalLight],
  ['point-light-illumination', runPointLightIllumination],
  ['point-light-coloration', runPointLightColoration],
  ['region-geometry', runRegionGeometry],
  ['light-visibility', runLightVisibility],
  ['sun-occlusion', runSunOcclusion],
];
for (const [name, fn] of suites) {
  const before = failed;
  fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : 'FAILED'}`);
}

console.log(`\nsrc/effects/lighting verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
