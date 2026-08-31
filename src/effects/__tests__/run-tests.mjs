/**
 * src/effects/ verification — the effect-registration core (params schema,
 * manifest validator, cascade resolver, registry). Pure logic; the Foundry
 * settings adapter and the live render wiring are browser-only.
 *
 * Discovered and run by tools/run-tests.mjs (glob of __tests__/run-tests.mjs);
 * `npm test` / `npm run verify` picks it up for free.
 */
import { run as runEffectRegistration } from './effect-registration.test.mjs';
import { run as runEffectTier } from './effect-tier.test.mjs';
import { run as runEffectTierConsumption } from './effect-tier-consumption.test.mjs';
import { run as runDepthOfFieldBlur } from './depth-of-field-blur.test.mjs';
import { run as runBloomDofRender } from './bloom-dof-render.test.mjs';
import { run as runDebugChannelSelect } from './debug-channel-select.test.mjs';
import { run as runCandleFlame } from './candle-flame.test.mjs';
import { run as runCandleFlameGeometry } from './candle-flame-geometry.test.mjs';
import { run as runCandleIgnite } from './candle-ignite.test.mjs';
import { run as runLightning } from './lightning.test.mjs';
import { run as runLightningGeometry } from './lightning-geometry.test.mjs';
import { run as runLightningSubsystem } from './lightning-subsystem.test.mjs';
import { run as runVegetation } from './vegetation.test.mjs';
import { run as runVegetationRender } from './vegetation-render.test.mjs';
import { run as runVegetationShadow } from './vegetation-shadow-subsystem.test.mjs';
import { run as runShadowAccess } from './shadow-access.test.mjs';
import { run as runSkyAccess } from './sky-access.test.mjs';
import { run as runDoorGraphics } from './door-graphics.test.mjs';
import { run as runDoorGraphicsRender } from './door-graphics-render.test.mjs';
import { run as runApertureGobo } from './aperture-gobo.test.mjs';
import { run as runEffectReadiness } from './effect-readiness.test.mjs';

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
  ['effect-registration', runEffectRegistration],
  ['effect-tier', runEffectTier],
  ['effect-tier-consumption', runEffectTierConsumption],
  ['depth-of-field-blur', runDepthOfFieldBlur],
  ['bloom-dof-render', runBloomDofRender],
  ['debug-channel-select', runDebugChannelSelect],
  ['candle-flame', runCandleFlame],
  ['candle-flame-geometry', runCandleFlameGeometry],
  ['candle-ignite', runCandleIgnite],
  ['lightning', runLightning],
  ['lightning-geometry', runLightningGeometry],
  ['lightning-subsystem', runLightningSubsystem],
  ['vegetation', runVegetation],
  ['vegetation-render', runVegetationRender],
  ['vegetation-shadow-subsystem', runVegetationShadow],
  ['shadow-access', runShadowAccess],
  ['sky-access', runSkyAccess],
  ['door-graphics', runDoorGraphics],
  ['door-graphics-render', runDoorGraphicsRender],
  ['aperture-gobo', runApertureGobo],
  ['effect-readiness', runEffectReadiness],
];
for (const [name, fn] of suites) {
  const before = failed;
  fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : 'FAILED'}`);
}

console.log(`\nsrc/effects verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
