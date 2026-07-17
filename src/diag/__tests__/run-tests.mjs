/**
 * src/diag/ verification. Pure logic only — the probe's DIAGNOSIS is testable
 * under Node even though the render it diagnoses is not.
 *
 * Run: `node src/diag/__tests__/run-tests.mjs`
 */
import { run as runOrientationProbe } from './orientation-probe.test.mjs';

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

const suites = [['orientation-probe', runOrientationProbe]];

for (const [name, fn] of suites) {
  const before = failed;
  await fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : `${failed - before} FAILED`}`);
}

console.log(`\nsrc/diag verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
