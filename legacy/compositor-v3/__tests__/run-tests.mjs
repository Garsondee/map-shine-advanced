/**
 * V3 core verification runner.
 *
 * The compositor-v3 core (FrameGraph, ThreeAllocator, V3Pipeline wiring) is
 * pure logic — no WebGL, no Foundry — so it is unit-testable under Node. This
 * runner is bundled with esbuild (to resolve the ESM `../core/log.js` import)
 * and executed.
 *
 * Run:
 *   node ./node_modules/esbuild/bin/esbuild scripts/compositor-v3/__tests__/run-tests.mjs \
 *     --bundle --format=esm --platform=node --outfile=<tmp>.mjs && node <tmp>.mjs
 *
 * (esbuild + node are already devDependencies; see package.json.)
 */
import './setup-globals.mjs'; // MUST be first — shims window/etc for import-time global access
import { run as runFrameGraph } from './FrameGraph.test.mjs';
import { run as runAllocator } from './ThreeAllocator.test.mjs';
import { run as runPipeline } from './V3Pipeline.test.mjs';
import { run as runPerf } from './v3-perf.test.mjs';
import { run as runCapabilities } from './capabilities.test.mjs';

let passed = 0;
let failed = 0;
const fails = [];

const t = {
  ok(name, cond) {
    if (cond) { passed++; } else { failed++; fails.push(name); console.error('  FAIL:', name); }
  },
  throws(name, fn, matchSubstr) {
    try {
      fn();
      failed++; fails.push(name); console.error('  FAIL (no throw):', name);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (matchSubstr && !msg.includes(matchSubstr)) {
        failed++; fails.push(name); console.error('  FAIL (wrong msg):', name, '->', msg);
      } else { passed++; }
    }
  },
};

const suites = [
  ['FrameGraph', runFrameGraph],
  ['ThreeAllocator', runAllocator],
  ['V3Pipeline', runPipeline],
  ['v3-perf', runPerf],
  ['capabilities', runCapabilities], // async suite (mocks document + awaits retries)
];

// Suites may be sync or async (return a Promise); await each so async
// assertions land before the summary prints.
for (const [name, fn] of suites) {
  const before = failed;
  await fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : `${failed - before} FAILED`}`);
}

console.log(`\nV3 core verification: ${passed} passed, ${failed} failed`);
if (failed) { console.error('Failures:', fails); process.exit(1); }
console.log('ALL GREEN');
