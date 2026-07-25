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
import { run as runCameraPath } from './camera-path.test.mjs';
import { run as runCanvasCompositing } from './canvas-compositing.test.mjs';
import { run as runCanvasLifecycle } from './canvas-lifecycle.test.mjs';
import { run as runDrawListDocuments } from './draw-list-documents.test.mjs';
import { run as runMaskDiscovery } from './mask-discovery.test.mjs';
import { run as runPixiProxyTextures } from './pixi-proxy-textures.test.mjs';
import { run as runGameTime } from './game-time.test.mjs';
import { run as runSceneEnvironment } from './scene-environment.test.mjs';
import { run as runSceneLights } from './scene-lights.test.mjs';
import { run as runSceneWallClip } from './scene-wall-clip.test.mjs';
import { run as runSceneWalls } from './scene-walls.test.mjs';
import { run as runSceneDoors } from './scene-doors.test.mjs';
import { run as runSceneRegions } from './scene-regions.test.mjs';
import { run as runSceneOcclusionSources } from './scene-occlusion-sources.test.mjs';
import { run as runSceneGeometry } from './scene-geometry.test.mjs';
import { run as runSceneLayers } from './scene-layers.test.mjs';
import { run as runSceneTokens } from './scene-tokens.test.mjs';
import { run as runV2AnchorImport } from './v2-anchor-import.test.mjs';

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
  ['camera-path', runCameraPath],
  ['canvas-compositing', runCanvasCompositing],
  ['canvas-lifecycle', runCanvasLifecycle],
  ['draw-list-documents', runDrawListDocuments],
  ['mask-discovery', runMaskDiscovery],
  ['pixi-proxy-textures', runPixiProxyTextures],
  ['game-time', runGameTime],
  ['scene-environment', runSceneEnvironment],
  ['scene-lights', runSceneLights],
  ['scene-wall-clip', runSceneWallClip],
  ['scene-walls', runSceneWalls],
  ['scene-doors', runSceneDoors],
  ['scene-regions', runSceneRegions],
  ['scene-occlusion-sources', runSceneOcclusionSources],
  ['scene-geometry', runSceneGeometry],
  ['scene-layers', runSceneLayers],
  ['scene-tokens', runSceneTokens],
  ['v2-anchor-import', runV2AnchorImport],
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
