/**
 * src/effects/ verification — currently just the params harvest's own health
 * check (effects/index.js exports checkParamsHarvest). particles/ has its own
 * sibling suite (src/effects/particles/__tests__/) since it predates this one.
 *
 * Run: `node src/effects/__tests__/run-tests.mjs`
 */
import { run as runParamsHarvestHealth } from './params-harvest-health.test.mjs';

let passed = 0;
let failed = 0;
const fails = [];

const t = {
  ok(name, cond) {
    if (cond) {
      passed++;
    } else {
      failed++;
      fails.push(name);
      console.error('  FAIL:', name);
    }
  },
};

const suites = [['params-harvest-health', runParamsHarvestHealth]];

for (const [name, fn] of suites) {
  const before = failed;
  await fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : `${failed - before} FAILED`}`);
}

console.log(`\nsrc/effects verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
