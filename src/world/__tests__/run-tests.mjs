/**
 * src/world/ verification — the env snapshot's pure core.
 *
 * (The frame clock's own suite moved to `src/core/__tests__/` in 2026-07-23,
 * where the module actually lives — it was tested from here for historical
 * reasons and had grown a second, duplicate suite.)
 *
 * Run:
 *   node ./node_modules/esbuild/bin/esbuild src/world/__tests__/run-tests.mjs \
 *     --bundle --format=esm --platform=node --outfile=<tmp>.mjs && node <tmp>.mjs
 */
import { run as runSun } from './sun.test.mjs';
import { run as runEnvironment } from './environment.test.mjs';
import { run as runDayClock } from './day-clock.test.mjs';
import { run as runSkySettings } from './sky-settings.test.mjs';
import { run as runWeather } from './weather.test.mjs';
import { run as runWeatherData } from './weather-data.test.mjs';
import { run as runWeatherRng } from './weather-rng.test.mjs';
import { run as runWeatherBiomes } from './weather-biomes.test.mjs';
import { run as runWeatherWalk } from './weather-walk.test.mjs';
import { run as runWeatherEvents } from './weather-events.test.mjs';
import { run as runWeatherEventsIntegration } from './weather-events-integration.test.mjs';
import { run as runWeatherPrecip } from './weather-precip.test.mjs';
import { run as runWindField } from './wind-field.test.mjs';
import { run as runWindBake } from './wind-bake.test.mjs';
import { run as runWindScale } from './wind-scale.test.mjs';
import { run as runWindSim } from './wind-sim.test.mjs';
import { run as runWindEnclosure } from './wind-enclosure.test.mjs';
import { run as runWindAccess } from './wind-access.test.mjs';
import { run as runAlmanac } from './almanac.test.mjs';
import { run as runFadeEngine } from './fade-engine.test.mjs';
import { run as runFadeRegistry } from './fade-registry.test.mjs';

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
  ['sun', runSun],
  ['environment', runEnvironment],
  ['day-clock', runDayClock],
  ['sky-settings', runSkySettings],
  ['weather', runWeather],
  ['weather-data', runWeatherData],
  ['weather-rng', runWeatherRng],
  ['weather-biomes', runWeatherBiomes],
  ['weather-walk', runWeatherWalk],
  ['weather-events', runWeatherEvents],
  ['weather-events-integration', runWeatherEventsIntegration],
  ['weather-precip', runWeatherPrecip],
  ['wind-field', runWindField],
  ['wind-bake', runWindBake],
  ['wind-scale', runWindScale],
  ['wind-sim', runWindSim],
  ['wind-enclosure', runWindEnclosure],
  ['wind-access', runWindAccess],
  ['almanac', runAlmanac],
  ['fade-engine', runFadeEngine],
  ['fade-registry', runFadeRegistry],
];
for (const [name, fn] of suites) {
  const before = failed;
  fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : 'FAILED'}`);
}

console.log(`\nsrc/world verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
