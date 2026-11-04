/**
 * auto-exposure-render.test.mjs — the meter's TSL builder CONSTRUCTS in Node, with and without the
 * padding rects (`keyhole-tsl-constructs-in-node`: a builder nothing calls can ship a startup crash
 * behind green tests). Same shape as bloom-dof-render.test.mjs.
 */
import * as THREE from '../../vendor/three/three.webgpu.js';
import { buildBloomMaterials } from '../bloom-render.js';
import { buildExposureMeterMaterial } from '../auto-exposure-render.js';

function stubTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

export function run(t) {
  const bloom = buildBloomMaterials({
    THREE,
    litTexture: stubTexture(),
    coreTexture: stubTexture(),
    atmoTexture: stubTexture(),
  });
  const rect = () => THREE.TSL.uniform(new THREE.Vector4(0, 0, 1, 1));
  for (const [label, extra] of [
    ['without the padding rects', {}],
    ['with the padding rects', { uViewRect: rect(), uSceneRect: rect() }],
  ]) {
    let built = null;
    let err = null;
    try {
      built = buildExposureMeterMaterial({
        THREE,
        litTexture: stubTexture(),
        coreTexture: stubTexture(),
        atmoTexture: stubTexture(),
        bloomUniforms: bloom.uniforms,
        ...extra,
      });
    } catch (e) {
      err = e;
    }
    t.ok(`the meter material constructs ${label} (${err ? err.message : 'clean'})`, err === null);
    t.ok(
      `…and returns its material, atmosphere seam and bloom switch ${label}`,
      !!(built?.material?.isNodeMaterial && built.atmoTexNode && built.uBloomOn)
    );
  }
}
