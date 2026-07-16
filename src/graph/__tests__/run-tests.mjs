/**
 * src/graph/ core verification (Keyhole Stage 1).
 *
 * Pure logic — no WebGL, no Foundry — unit-testable under Node. Harvested
 * near-verbatim from legacy/compositor-v3/ (see git history); ThreeAllocatorLaw
 * is new — it verifies the Keyhole law (§4.6) the harvest added to ThreeAllocator.
 *
 * Run:
 *   node ./node_modules/esbuild/bin/esbuild src/graph/__tests__/run-tests.mjs \
 *     --bundle --format=esm --platform=node --outfile=<tmp>.mjs && node <tmp>.mjs
 */
import './setup-globals.mjs'; // MUST be first — shims window/etc for import-time global access
import { run as runFrameGraph } from './frame-graph.test.mjs';
import { run as runAllocator } from './three-allocator.test.mjs';
import { run as runAllocatorLaw } from './three-allocator-law.test.mjs';
import { run as runPerf } from './v3-perf.test.mjs';
import { run as runPasses } from './pass-declarations.test.mjs';

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
  throws(name, fn, matchSubstr) {
    try {
      fn();
      failed++;
      fails.push(name);
      console.error('  FAIL (no throw):', name);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (matchSubstr && !msg.includes(matchSubstr)) {
        failed++;
        fails.push(name);
        console.error('  FAIL (wrong msg):', name, '->', msg);
      } else {
        passed++;
      }
    }
  },
};

const suites = [
  ['FrameGraph', runFrameGraph],
  ['ThreeAllocator', runAllocator],
  ['ThreeAllocatorLaw', runAllocatorLaw],
  ['v3-perf', runPerf],
  ['pass-declarations', runPasses],
];

for (const [name, fn] of suites) {
  const before = failed;
  await fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : `${failed - before} FAILED`}`);
}

console.log(`\nsrc/graph verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
