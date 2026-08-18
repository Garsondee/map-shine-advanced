/**
 * water-flow.test.mjs — EVERY `water-flow.js` MATERIAL ACTUALLY CONSTRUCTS,
 * IN NODE — S2's solidity seed AND S3's full velocity cascade (seed,
 * divergence, Jacobi step, project+pack), NEVER TESTED BY ANYTHING ELSE
 * UNTIL NOW.
 *
 * Same reasoning as `water-render.test.mjs`'s own header: this file is
 * brand new and had never once been invoked by a test or a live scene when
 * it was written — exactly the "green suite, throws on load" trap
 * `specular-render.test.mjs` named first. This proves construction survives
 * (no temporal-dead-zone, no renamed TSL export, no bad swizzle); it proves
 * NOTHING about the values a real mask/flow would produce — that needs a
 * GPU, and belongs to the debug-panel report once a live scene bakes a real
 * `res:waterFlow` pack, not to this file. `water-flow-solve.js`'s own Node
 * suite is what proves the ALGORITHM correct (against hand-computable
 * fixtures and brute force); this file only proves the PORT of that
 * algorithm survives being built as a shader graph.
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import {
  buildWaterSoliditySeedMaterial,
  buildWaterVelocitySeedMaterial,
  buildWaterDivergenceMaterial,
  buildWaterJacobiStepMaterial,
  buildWaterProjectPackMaterial,
  WATER_FLOW_SOLIDITY_SUBSAMPLES,
  WATER_FLOW_GRID_MAX_DIM,
  WATER_FLOW_SPEED01_HEADROOM,
} from '../water-flow.js';

/** A 1×1 texture — enough for a node to reference; never sampled here (no
 * GPU in Node — see this file's own header). */
function stubTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

const SIZES = [
  ['square', 512, 512],
  ['wide', 1024, 238],
  ['tall', 238, 1024],
  ['1x1', 1, 1],
];

export function run(t) {
  const { ok } = t;

  // ── S2: SOLIDITY SEED CONSTRUCTS AT ALL ───────────────────────────────────
  for (const [label, width, height] of SIZES) {
    let result = null;
    let err = null;
    try {
      result = buildWaterSoliditySeedMaterial({ THREE, maskTexture: stubTexture(), width, height });
    } catch (e) {
      err = e;
    }
    ok(`solidity ${label}: constructs without throwing (${err?.stack ?? err})`, !err);
    ok(`solidity ${label}: returns a material`, !!result?.material);
    ok(`solidity ${label}: material has a fragmentNode`, !!result?.material?.fragmentNode);
    ok(`solidity ${label}: returns a quad`, !!result?.quad);
  }

  // ── S3: THE VELOCITY CASCADE — EVERY MATERIAL, AT EVERY ASPECT RATIO ─────
  const { uniform, vec2 } = THREE.TSL;
  for (const [label, width, height] of SIZES) {
    let seed = null;
    let seedErr = null;
    try {
      const uDir = uniform(vec2(1, 0));
      seed = buildWaterVelocitySeedMaterial({ THREE, solidityTexture: stubTexture(), uDir });
    } catch (e) {
      seedErr = e;
    }
    ok(`velocity seed ${label}: constructs without throwing (${seedErr?.stack ?? seedErr})`, !seedErr);
    ok(
      `velocity seed ${label}: returns a material + quad + solidTexNode`,
      !!seed?.material && !!seed?.quad && !!seed?.solidTexNode
    );

    let divergence = null;
    let divErr = null;
    try {
      divergence = buildWaterDivergenceMaterial({ THREE, velocityTexture: stubTexture(), width, height });
    } catch (e) {
      divErr = e;
    }
    ok(`divergence ${label}: constructs without throwing (${divErr?.stack ?? divErr})`, !divErr);
    ok(`divergence ${label}: returns a material + quad`, !!divergence?.material && !!divergence?.quad);

    let jacobi = null;
    let jacobiErr = null;
    try {
      jacobi = buildWaterJacobiStepMaterial({
        THREE,
        prevPressureTexture: stubTexture(),
        divergenceTexture: stubTexture(),
        solidityTexture: stubTexture(),
        width,
        height,
      });
    } catch (e) {
      jacobiErr = e;
    }
    ok(`jacobi ${label}: constructs without throwing (${jacobiErr?.stack ?? jacobiErr})`, !jacobiErr);
    ok(`jacobi ${label}: returns a material + quad`, !!jacobi?.material && !!jacobi?.quad);
    // ⚠️ EVERY `texture(prevPressureTexture, …)` node this material builds
    // MUST land in `prevTexNodes` — the centre read PLUS all 4 neighbour
    // reads, five total. `feedback_texture_nodes_must_be_repointed_together`
    // is the live incident this pins against: a node built and never
    // returned here samples whatever texture the material was FIRST built
    // against, forever, silently, regardless of how many times the caller
    // re-points the array it DOES have.
    ok(
      `jacobi ${label}: prevTexNodes has exactly 5 entries (centre + 4 neighbours)`,
      Array.isArray(jacobi?.prevTexNodes) && jacobi.prevTexNodes.length === 5
    );

    let pack = null;
    let packErr = null;
    try {
      pack = buildWaterProjectPackMaterial({
        THREE,
        seedVelocityTexture: stubTexture(),
        pressureTexture: stubTexture(),
        solidityTexture: stubTexture(),
        width,
        height,
      });
    } catch (e) {
      packErr = e;
    }
    ok(`pack ${label}: constructs without throwing (${packErr?.stack ?? packErr})`, !packErr);
    ok(`pack ${label}: returns a material + quad`, !!pack?.material && !!pack?.quad);
    // Same "every sample must be re-pointable" rule, for the pack's own
    // ONE-TIME (not ping-ponged) re-point once the Jacobi loop finishes —
    // see `buildWaterProjectPackMaterial`'s own doc for why this is a single
    // re-point rather than a ping-pong.
    ok(
      `pack ${label}: pressureTexNodes has exactly 5 entries (centre + 4 neighbours)`,
      Array.isArray(pack?.pressureTexNodes) && pack.pressureTexNodes.length === 5
    );
  }

  // ── THE CONSTANTS THE DOC COMMENTS CITE BY NUMBER ────────────────────────
  // `water-flow.js`'s own header worked example says "4×4 = 16 total" and
  // `water-flow-subsystem.js`'s header cites "1024 on a 10,650px-wide map is
  // ~10.4 world-px/texel" — both are prose that goes silently wrong if either
  // constant drifts without the comments following, so the values themselves
  // are pinned here rather than trusted to stay whatever the doc claims.
  ok('WATER_FLOW_SOLIDITY_SUBSAMPLES is 4 (4x4 = 16 sub-samples/texel)', WATER_FLOW_SOLIDITY_SUBSAMPLES === 4);
  ok('WATER_FLOW_GRID_MAX_DIM is 1024 (coarser than the 2048 mask/SDF grid)', WATER_FLOW_GRID_MAX_DIM === 1024);
  ok('flow grid is deliberately coarser than the mask/SDF derivation grid', WATER_FLOW_GRID_MAX_DIM < 2048);
  ok(
    'WATER_FLOW_SPEED01_HEADROOM leaves real headroom above the free-stream speed of 1',
    WATER_FLOW_SPEED01_HEADROOM > 1 && WATER_FLOW_SPEED01_HEADROOM === 2.5
  );
}
