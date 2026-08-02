/**
 * sun-occlusion-render.test.mjs — THE TSL GRAPH IS ACTUALLY CONSTRUCTED, IN NODE.
 *
 * Same doctrine as `specular/__tests__/specular-render.test.mjs`
 * (`keyhole-tsl-constructs-in-node`). This file used to also construct the
 * march and old-smear bake materials; both are retired
 * (`docs/planning/Sun-Shadows-Layer-Smear.md` §8) — that construction
 * coverage now lives in `layer-smear-render.test.mjs`. What's left here is
 * `buildSunVisibilityNode`, the one export `sun-occlusion-render.js` still
 * has: a small, real TSL graph (texture sample + remap) that a typo could
 * still break silently, since every OTHER suite in this effect is pure
 * arithmetic and never calls it.
 *
 * WHAT THIS PROVES: the graph constructs without throwing. WHAT IT DOES NOT
 * PROVE: anything about WGSL codegen or the on-screen look — that is what the
 * author's own live verification is for.
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import { buildSunVisibilityNode } from '../sun-occlusion-render.js';

/** A 1×1 RGBA texture node — enough for the read to reference; never sampled here. */
function stubShadowTexNode() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return THREE.TSL.texture(t);
}

export function run(t) {
  const { ok } = t;
  const { uniform, vec4 } = THREE.TSL;

  let readNode = null;
  let readError = null;
  try {
    readNode = buildSunVisibilityNode(THREE.TSL, {
      uViewRect: uniform(vec4(0, 0, 100, 100)),
      uShadowRect: uniform(vec4(0, 0, 100, 100)),
      shadowTexNode: stubShadowTexNode(),
    });
  } catch (err) {
    readError = err;
  }
  ok(
    `the visibility READ node constructs without throwing (${readError ? readError.message : 'clean'})`,
    readError === null
  );
  ok('it returns a node (not null) when a shadow texture is supplied', !!readNode);
  ok(
    'it returns null (compiled OUT) when no shadow texture is supplied — never a throw, never a bad fetch',
    buildSunVisibilityNode(THREE.TSL, { uViewRect: null, uShadowRect: null, shadowTexNode: null }) === null
  );
}
