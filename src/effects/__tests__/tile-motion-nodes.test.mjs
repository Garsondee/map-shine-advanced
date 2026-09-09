/**
 * tile-motion-nodes.test.mjs — THE TSL GRAPH IS ACTUALLY CONSTRUCTED, IN NODE.
 *
 * Same ceiling `window-render.test.mjs` already established
 * (`keyhole-tsl-constructs-in-node`): `src/vendor/three/three.webgpu.js`
 * imports cleanly under plain Node, so building the graph and wiring it onto
 * a real material/texture sample can and must be proven here. WHAT THIS DOES
 * NOT PROVE: anything about WGSL codegen or a rendered pixel — there is no
 * WebGPU device in Node. The formula's own arithmetic is instead proven by
 * its pure-JS twins (`foundry/tile-motion.js#applyRigidDelta`, already
 * asserted; `#applyTileMotionTextureUv`, asserted alongside it).
 */
import * as THREE from '../../vendor/three/three.webgpu.js';
import { buildTileMotionPositionNode, buildTileMotionMaskUvNode } from '../tile-motion-nodes.js';

/** The SAME shape `buildWholeImageMaterial` (vt-pan-viewer.js) builds for
 * `item.kind === 'tile'` — a fresh uniform bag, identity by default. */
function makeTileMotionBag(TSL) {
  const { uniform, vec2 } = TSL;
  return {
    uMotionPivot: uniform(vec2(0, 0)),
    uMotionRot: uniform(vec2(1, 0)),
    uMotionTranslate: uniform(vec2(0, 0)),
    uTexPivotUV: uniform(vec2(0.5, 0.5)),
    uTexScrollUV: uniform(vec2(0, 0)),
    uTexRotUV: uniform(vec2(1, 0)),
  };
}

/** A 1×1 texture — enough for a node to reference; never sampled here. */
function stubTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

export function run(t) {
  const { ok } = t;
  const TSL = THREE.TSL;
  const tm = makeTileMotionBag(TSL);

  // ── buildTileMotionPositionNode (transform mode) ─────────────────────────
  let posNode = null;
  let posError = null;
  try {
    posNode = buildTileMotionPositionNode(TSL, tm);
  } catch (err) {
    posError = err;
  }
  ok(
    `buildTileMotionPositionNode constructs without throwing (${posError ? posError.message : 'clean'})`,
    posError === null
  );
  ok('it returns a real node object, not null/undefined', posNode !== null && typeof posNode === 'object');

  // Wiring it onto a real NodeMaterial must also survive construction —
  // mirrors buildWholeImageMaterial's own `material.positionNode = Fn(...)`
  // assignment, which this function's formula is byte-for-byte transcribed
  // from.
  let matError = null;
  try {
    const mat = new THREE.NodeMaterial();
    mat.positionNode = posNode;
    mat.colorNode = TSL.vec4(1, 1, 1, 1);
  } catch (err) {
    matError = err;
  }
  ok(
    `assigning it as material.positionNode survives construction (${matError ? matError.message : 'clean'})`,
    matError === null
  );

  // ── buildTileMotionMaskUvNode (texture mode) ─────────────────────────────
  let uvNode = null;
  let uvError = null;
  try {
    uvNode = buildTileMotionMaskUvNode(TSL, tm, TSL.uv());
  } catch (err) {
    uvError = err;
  }
  ok(
    `buildTileMotionMaskUvNode constructs without throwing (${uvError ? uvError.message : 'clean'})`,
    uvError === null
  );
  ok('it returns a real node object, not null/undefined', uvNode !== null && typeof uvNode === 'object');

  // Feeding it into an actual texture() sample — the exact way
  // window-render.js/specular-render.js's own `maskUv` feeds their mask
  // taps — must also survive construction.
  let sampleError = null;
  try {
    const sampled = TSL.texture(stubTexture(), uvNode);
    const mat = new THREE.NodeMaterial();
    mat.colorNode = sampled;
  } catch (err) {
    sampleError = err;
  }
  ok(
    `feeding it into a texture() sample survives construction (${sampleError ? sampleError.message : 'clean'})`,
    sampleError === null
  );

  // ── BOTH BUILDERS TOGETHER, THE SHAPE A REAL PER-TILE SURFACE USES ──────
  // A texture-mode tile wires the position node too (identity — see this
  // module's own header on why both are safe to wire unconditionally); this
  // proves the two compose on one material rather than only in isolation.
  const tm2 = makeTileMotionBag(TSL);
  let comboError = null;
  try {
    const mat = new THREE.NodeMaterial();
    mat.positionNode = buildTileMotionPositionNode(TSL, tm2);
    mat.colorNode = TSL.texture(stubTexture(), buildTileMotionMaskUvNode(TSL, tm2, TSL.uv()));
  } catch (err) {
    comboError = err;
  }
  ok(
    `both builders together on one material survive construction (${comboError ? comboError.message : 'clean'})`,
    comboError === null
  );
}
