/**
 * src/scene/ verification — the layering law and the scene model built on it.
 *
 * Pure logic — no WebGL, no Foundry — unit-testable under Node.
 *
 * Run:
 *   node ./node_modules/esbuild/bin/esbuild src/scene/__tests__/run-tests.mjs \
 *     --bundle --format=esm --platform=node --outfile=<tmp>.mjs && node <tmp>.mjs
 */
import { run as runLayerOrder } from './layer-order.test.mjs';
import { run as runOcclusion } from './occlusion.test.mjs';
import { run as runWorldQuad } from './world-quad.test.mjs';
import { run as runMaskCatalog } from './mask-catalog.test.mjs';
import { run as runMaskDerive } from './mask-derive.test.mjs';
import { run as runMaskAuthority } from './mask-authority.test.mjs';
import { run as runPaintMask } from './paint-mask.test.mjs';

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
  ['layer-order', runLayerOrder],
  ['occlusion', runOcclusion],
  ['world-quad', runWorldQuad],
  ['mask-catalog', runMaskCatalog],
  ['mask-derive', runMaskDerive],
  ['mask-authority', runMaskAuthority],
  ['paint-mask', runPaintMask],
];

for (const [name, fn] of suites) {
  const before = failed;
  await fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : `${failed - before} FAILED`}`);
}

console.log(`\nsrc/scene verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
