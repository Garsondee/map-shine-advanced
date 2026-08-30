/**
 * src/vt/ core verification (Keyhole Stage 1 — "the law, running").
 *
 * Pure logic — no WebGL, no Foundry — unit-testable under Node.
 *
 * Run:
 *   node ./node_modules/esbuild/bin/esbuild src/vt/__tests__/run-tests.mjs \
 *     --bundle --format=esm --platform=node --outfile=<tmp>.mjs && node <tmp>.mjs
 */
import { run as runVtCore } from './vt-core.test.mjs';
import { run as runDecodePrimitives } from './decode-primitives.test.mjs';
import { run as runViewState } from './view-state.test.mjs';
import { run as runTextureLimits } from './texture-limits.test.mjs';
import { run as runBlockCompress } from './block-compress.test.mjs';
import { run as runCoarseAlpha } from './coarse-alpha.test.mjs';
import { run as runMipResample } from './mip-resample.test.mjs';
import { run as runSceneAttr } from './scene-attr.test.mjs';
import { run as runMaskImage } from './mask-image.test.mjs';
import { run as runPackedTrioAlpha } from './packed-trio-alpha.test.mjs';
import { run as runVtPanViewerDiagnostics } from './vt-pan-viewer-diagnostics.test.mjs';
import { run as runSceneDepth } from './scene-depth.test.mjs';
import { run as runCoverageMesh } from './coverage-mesh.test.mjs';
import { run as runRenderScalePolicy } from './render-scale-policy.test.mjs';
import { run as runSettle } from './settle.test.mjs';
import { run as runCompressedTextures } from './compressed-textures.test.mjs';
import { run as runDepthProxyMaterialPool } from './depth-proxy-material-pool.test.mjs';
import { run as runAlbedoClarity } from './albedo-clarity.test.mjs';
import { run as runTaaResolve } from './taa-resolve.test.mjs';

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
  ['vt-core', runVtCore],
  ['decode-primitives', runDecodePrimitives],
  ['view-state', runViewState],
  ['texture-limits', runTextureLimits],
  ['block-compress', runBlockCompress],
  ['coarse-alpha', runCoarseAlpha],
  ['mip-resample', runMipResample],
  ['scene-attr', runSceneAttr],
  ['mask-image', runMaskImage],
  ['packed-trio-alpha', runPackedTrioAlpha],
  ['vt-pan-viewer-diagnostics', runVtPanViewerDiagnostics],
  ['scene-depth', runSceneDepth],
  ['coverage-mesh', runCoverageMesh],
  ['render-scale-policy', runRenderScalePolicy],
  ['settle', runSettle],
  ['compressed-textures', runCompressedTextures],
  ['depth-proxy-material-pool', runDepthProxyMaterialPool],
  ['albedo-clarity', runAlbedoClarity],
  ['taa-resolve', runTaaResolve],
];

for (const [name, fn] of suites) {
  const before = failed;
  await fn(t);
  console.log(`  ${name}: ${failed === before ? 'ok' : `${failed - before} FAILED`}`);
}

console.log(`\nsrc/vt verification: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Failures:', fails);
  process.exit(1);
}
console.log('ALL GREEN');
