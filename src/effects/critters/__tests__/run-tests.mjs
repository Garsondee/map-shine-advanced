/**
 * Critters (flies, maggots, fireflies) — pure-math suite. The GPU kernels and the
 * procedural bodies are verified live and in the shader lab (CONVENTIONS.md §4);
 * everything here is the arithmetic those depend on, proven in Node first.
 */
import { run as runZone } from './critter-zone.test.mjs';
import { run as runActivity } from './critter-activity.test.mjs';
import { run as runWeather } from './critter-weather.test.mjs';
import { run as runDeclarations } from './critter-declarations.test.mjs';
import { run as runSubsystem } from './critter-subsystem.test.mjs';
import { run as runRegistration } from './critter-registration.test.mjs';
import { run as runGeometry } from './critter-geometry.test.mjs';
import { run as runUniforms } from './critter-uniforms.test.mjs';
import { run as runConsumption } from './critter-consumption.test.mjs';

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

runZone(t);
runActivity(t);
runWeather(t);
runDeclarations(t);
runSubsystem(t);
await runRegistration(t);
runGeometry(t);
runUniforms(t);
runConsumption(t);
console.log(`\nsrc/effects/critters verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
