/**
 * dynamic-range-render.test.mjs — the TSL builders CONSTRUCT in Node (`keyhole-tsl-constructs-in-node`):
 * the meter, the shared uniforms, and the transform / brightness nodes the present and bloom passes use.
 */
import * as THREE from '../../vendor/three/three.webgpu.js';
import {
  buildDynamicRangeMeterMaterial,
  createDynamicRangeUniforms,
  writeDynamicRangeUniforms,
  readDynamicRangeUniforms,
  buildDynamicRangeNode,
  buildDynamicRangeBrightnessNode,
} from '../dynamic-range-render.js';
import { buildBloomMaterials } from '../bloom-render.js';

function stubTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}
const tryBuild = (fn) => {
  try {
    return { value: fn(), err: null };
  } catch (e) {
    return { value: null, err: e };
  }
};

export function run(t) {
  const rect = () => THREE.TSL.uniform(new THREE.Vector4(0, 0, 1, 1));
  for (const [label, extra] of [
    ['without the padding rects', {}],
    ['with the padding rects', { uViewRect: rect(), uSceneRect: rect() }],
  ]) {
    const r = tryBuild(() =>
      buildDynamicRangeMeterMaterial({ THREE, litTexture: stubTexture(), illumTexture: stubTexture(), ...extra })
    );
    t.ok(
      `the meter constructs ${label} (${r.err ? r.err.message : 'clean'})`,
      !r.err && r.value.material.isNodeMaterial
    );
  }

  const U = createDynamicRangeUniforms(THREE);
  t.ok('off by default (on = 0)', readDynamicRangeUniforms(U).on === 0);
  writeDynamicRangeUniforms(U, {
    ev: 1.2,
    mid: 0.04,
    drama: 1.3,
    punch: 1.8,
    punchFrom: 1.25,
    shadowDepth: 1,
    colour: 1.2,
    lightRange: 3,
  });
  const read = readDynamicRangeUniforms(U);
  t.ok(
    'a curve written reads back (packed vec4s)',
    read.on === 1 && read.ev === 1.2 && read.lightRange === 3 && read.punch === 1.8
  );
  writeDynamicRangeUniforms(U, null);
  t.ok('null turns it off', readDynamicRangeUniforms(U).on === 0);

  const TSL = THREE.TSL;
  const c = TSL.vec3(0.5, 0.3, 0.1);
  const i = TSL.vec3(0.6, 0.6, 0.6);
  const tn = tryBuild(() => buildDynamicRangeNode(TSL, c, i, U));
  t.ok(`the transform node constructs (${tn.err ? tn.err.message : 'clean'})`, !tn.err && !!tn.value);
  const bn = tryBuild(() => buildDynamicRangeBrightnessNode(TSL, c, i, U));
  t.ok(`the brightness node constructs (${bn.err ? bn.err.message : 'clean'})`, !bn.err && !!bn.value);
  const bl = tryBuild(() =>
    buildBloomMaterials({
      THREE,
      litTexture: stubTexture(),
      coreTexture: stubTexture(),
      atmoTexture: stubTexture(),
      illumTexture: stubTexture(),
      dynamicRangeUniforms: U,
    })
  );
  t.ok(
    `bloom builds with the shared uniforms (${bl.err ? bl.err.message : 'clean'})`,
    !bl.err && bl.value.brightMaterial.isNodeMaterial
  );
}
