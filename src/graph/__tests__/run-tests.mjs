/**
 * src/graph/ core verification (Keyhole Stage 1).
 *
 * Pure logic — no WebGL, no Foundry — unit-testable under Node. Harvested
 * near-verbatim from legacy/compositor-v3/ (see git history); ThreeAllocatorLaw
 * is new — it verifies the Keyhole law (§4.6) the harvest added to ThreeAllocator.
 *
 * Run: `node src/graph/__tests__/run-tests.mjs` (package.json declares
 * "type": "module" — no bundler needed; see tools/run-tests.mjs's header for
 * why an esbuild step used to be here and no longer is).
 */
import './setup-globals.mjs'; // MUST be first — shims window/etc for import-time global access
import { run as runFrameGraph } from './frame-graph.test.mjs';
import { run as runAllocator } from './three-allocator.test.mjs';
import { run as runAllocatorLaw } from './three-allocator-law.test.mjs';
import { run as runPasses } from './pass-declarations.test.mjs';
import { run as runPassHealth } from './pass-health.test.mjs';
import { run as runPassImpls } from './pass-impls.test.mjs';
import { run as runRunFrame } from './run-frame.test.mjs';

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
  ['pass-declarations', runPasses],
  ['pass-health', runPassHealth],
  ['pass-impls', runPassImpls],
  ['run-frame', runRunFrame],
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
