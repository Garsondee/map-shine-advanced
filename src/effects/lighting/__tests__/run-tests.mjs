/**
 * src/effects/lighting/ verification — the pure ambient-ladder math of the
 * environmental-light pass and the point-light illumination math (attenuation
 * easing, fan triangulation). Most TSL material builds are evaluated only in
 * spirit here; `sun-occlusion-render.test.mjs` is the exception — it actually
 * CONSTRUCTS its graph in Node (`keyhole-tsl-constructs-in-node`), the same
 * doctrine `specular/__tests__/specular-render.test.mjs` established.
 *
 * Discovered and run by tools/run-tests.mjs (glob of __tests__/run-tests.mjs);
 * `npm test` / `npm run verify` picks it up for free.
 */
import { run as runEnvironmentalLight } from './environmental-light.test.mjs';
import { run as runPointLightIllumination } from './point-light-illumination.test.mjs';
import { run as runPointLightColoration } from './point-light-coloration.test.mjs';
import { run as runPointLightPool } from './point-light-pool.test.mjs';
import { run as runRegionGeometry } from './region-geometry.test.mjs';
import { run as runLightVisibility } from './light-visibility.test.mjs';
import { run as runSunOcclusion } from './sun-occlusion.test.mjs';
import { run as runSunOcclusionRender } from './sun-occlusion-render.test.mjs';
import { run as runCasterPack } from './caster-pack.test.mjs';
import { run as runSunShadowDebug } from './sun-shadow-debug.test.mjs';
import { run as runSunShadowBlur } from './sun-shadow-blur.test.mjs';
import { run as runSunShadowMultiFloor } from './sun-shadow-multi-floor.test.mjs';
import { run as runShadowBands } from './shadow-bands.test.mjs';
import { run as runLayerSmear } from './layer-smear.test.mjs';
import { run as runLayerSmearRender } from './layer-smear-render.test.mjs';
import { run as runApertureGobo } from './aperture-gobo.test.mjs';
import { run as runApertureGoboRender } from './aperture-gobo-render.test.mjs';

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
  ['point-light-pool', runPointLightPool],
  ['region-geometry', runRegionGeometry],
  ['light-visibility', runLightVisibility],
  ['sun-occlusion', runSunOcclusion],
  ['sun-occlusion-render', runSunOcclusionRender],
  ['caster-pack', runCasterPack],
  ['sun-shadow-debug', runSunShadowDebug],
  ['sun-shadow-blur', runSunShadowBlur],
  ['sun-shadow-multi-floor', runSunShadowMultiFloor],
  ['shadow-bands', runShadowBands],
  ['layer-smear', runLayerSmear],
  ['layer-smear-render', runLayerSmearRender],
  ['aperture-gobo', runApertureGobo],
  ['aperture-gobo-render', runApertureGoboRender],
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
