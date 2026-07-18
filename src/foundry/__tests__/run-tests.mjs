/**
 * src/foundry/ core verification (Keyhole Stage 2B — the ONE Foundry adapter).
 *
 * Pure logic — no `canvas`/`Hooks`/DOM — unit-testable under Node.
 *
 * Run:
 *   node ./node_modules/esbuild/bin/esbuild src/foundry/__tests__/run-tests.mjs \
 *     --bundle --format=esm --platform=node --outfile=<tmp>.mjs && node <tmp>.mjs
 */
import { run as runActiveSceneSource } from './active-scene-source.test.mjs';
import { run as runCanvasCompositing } from './canvas-compositing.test.mjs';
import { run as runCanvasLifecycle } from './canvas-lifecycle.test.mjs';
import { run as runDrawListDocuments } from './draw-list-documents.test.mjs';
import { run as runMaskDiscovery } from './mask-discovery.test.mjs';
import { run as runPixiProxyTextures } from './pixi-proxy-textures.test.mjs';
import { run as runSceneGeometry } from './scene-geometry.test.mjs';
import { run as runSceneLayers } from './scene-layers.test.mjs';
import { run as runSceneTokens } from './scene-tokens.test.mjs';

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
  ['active-scene-source', runActiveSceneSource],
  ['canvas-compositing', runCanvasCompositing],
  ['canvas-lifecycle', runCanvasLifecycle],
  ['draw-list-documents', runDrawListDocuments],
  ['mask-discovery', runMaskDiscovery],
  ['pixi-proxy-textures', runPixiProxyTextures],
  ['scene-geometry', runSceneGeometry],
  ['scene-layers', runSceneLayers],
  ['scene-tokens', runSceneTokens],
];

for (const [name, fn] of suites) {
  const before = failed;
  await fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : `${failed - before} FAILED`}`);
}

console.log(`\nsrc/foundry verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
