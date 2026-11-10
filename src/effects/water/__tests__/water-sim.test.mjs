/**
 * water-sim.test.mjs — `water-sim.js`'s ONE material ACTUALLY CONSTRUCTS, IN
 * NODE — same reasoning as `water-flow.test.mjs`'s own header: this file is
 * brand new and has never once been invoked by a test or a live scene. This
 * proves construction survives (no temporal-dead-zone, no renamed TSL
 * export, no bad swizzle, no `mx_fractal_noise_vec3` argument mismatch); it
 * proves NOTHING about the values a real flow/body pack would produce — that
 * needs a GPU and the real map, and belongs to S5's own shader-lab bench
 * task, not to this file.
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import {
  buildWaterSimStepMaterial,
  WATER_SIM_TAU_FOAM_SEC,
  WATER_SIM_DIFFUSE,
  WATER_SIM_CLUMP_LO,
  WATER_SIM_CLUMP_HI,
  WATER_SIM_CLUMP_AA_PX,
  WATER_SIM_SHEAR_GAIN,
  WATER_SIM_NEAR_SOLID_GAIN,
  WATER_SIM_NOISE_CELL_PX,
  WATER_SIM_NOISE_TIME_SCALE,
  WATER_SIM_NOISE_FLOOR,
  WATER_SIM_SPRAY_GAIN,
  waterSimFoamLifeSec,
  waterSimRiffleEmit,
  WATER_SIM_SLOW_LIFE_MUL,
} from '../water-sim.js';

/** A 1×1 texture — enough for a node to reference; never sampled here (no
 * GPU in Node — see this file's own header). */
function stubTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

const SIZES = [
  ['square', 512, 512],
  ['wide', 1024, 476],
  ['tall', 476, 1024],
  ['1x1', 1, 1],
];

export function run(t) {
  const { ok } = t;
  const { uniform, float } = THREE.TSL;

  // THE SPRAY EMITTER in G (2026-10-17) — `water-shore-mask.js#buildBreakSpecks` reads it
  // at each fleck's spawn point; a non-positive gain would silently mean no spray at all.
  ok(
    'WATER_SIM_SPRAY_GAIN is a positive, finite gain',
    Number.isFinite(WATER_SIM_SPRAY_GAIN) && WATER_SIM_SPRAY_GAIN > 0
  );

  for (const [label, width, height] of SIZES) {
    let result = null;
    let err = null;
    try {
      result = buildWaterSimStepMaterial({
        THREE,
        flowTexture: stubTexture(),
        bodyTexture: stubTexture(),
        simPrevTexture: stubTexture(),
        width,
        height,
        rectWidthPx: width * 10,
        rectHeightPx: height * 10,
        uDtSec: uniform(float(0.016)),
        uFlowSpeedPx: uniform(float(90)),
        uReachPx: uniform(float(64)),
        uFoamAmount: uniform(float(1)),
        timeMsNode: float(1234),
      });
    } catch (e) {
      err = e;
    }
    ok(`sim step ${label}: constructs without throwing (${err?.stack ?? err})`, !err);
    ok(`sim step ${label}: returns a material`, !!result?.material);
    ok(`sim step ${label}: material has a fragmentNode`, !!result?.material?.fragmentNode);
    ok(`sim step ${label}: returns a quad`, !!result?.quad);
    ok(`sim step ${label}: returns a bodyTexNode`, !!result?.bodyTexNode);
    // ⚠️ EVERY `texture(flowTexture, …)` node this material builds MUST land
    // in `flowTexNodes` — the centre read PLUS the 4 gradient neighbours,
    // five total — `feedback_texture_nodes_must_be_repointed_together`'s
    // now-three-times-bitten rule: a tap built and never returned here keeps
    // sampling whatever texture the material was FIRST built against,
    // forever, regardless of how many times the caller re-points the array
    // it DOES have.
    ok(
      `sim step ${label}: flowTexNodes has exactly 5 entries (centre + 4 gradient neighbours)`,
      Array.isArray(result?.flowTexNodes) && result.flowTexNodes.length === 5
    );
    // Same rule for the ping-pong SOURCE: the sharp advected centre tap,
    // reused as one of the blur's own nine samples, plus 8 more neighbours —
    // nine distinct `texture(simPrevTexture, …)` nodes total.
    ok(
      `sim step ${label}: simPrevTexNodes has exactly 9 entries (centre reused + 8 blur neighbours)`,
      Array.isArray(result?.simPrevTexNodes) && result.simPrevTexNodes.length === 9
    );
  }

  // ── `timeMsNode` IS OPTIONAL — a caller that omits it gets a frozen clock,
  // never a crash (this file's own doc on `args.timeMsNode`). ──────────────
  let noClock = null;
  let noClockErr = null;
  try {
    noClock = buildWaterSimStepMaterial({
      THREE,
      flowTexture: stubTexture(),
      bodyTexture: stubTexture(),
      simPrevTexture: stubTexture(),
      width: 512,
      height: 512,
      rectWidthPx: 5000,
      rectHeightPx: 5000,
      uDtSec: uniform(float(0.016)),
      uFlowSpeedPx: uniform(float(90)),
      uReachPx: uniform(float(64)),
      uFoamAmount: uniform(float(1)),
    });
  } catch (e) {
    noClockErr = e;
  }
  ok(`sim step, no timeMsNode: constructs without throwing (${noClockErr?.stack ?? noClockErr})`, !noClockErr);
  ok('sim step, no timeMsNode: returns a material', !!noClock?.material);

  // ── THE CONSTANTS THE DOC COMMENTS CITE BY NUMBER ────────────────────────
  ok('WATER_SIM_TAU_FOAM_SEC is positive (a real decay time, not off or inverted)', WATER_SIM_TAU_FOAM_SEC > 0);
  ok('WATER_SIM_DIFFUSE is a blend weight, within [0, 1]', WATER_SIM_DIFFUSE >= 0 && WATER_SIM_DIFFUSE <= 1);
  ok(
    'WATER_SIM_CLUMP_LO < WATER_SIM_CLUMP_HI (a real band, not inverted or collapsed)',
    WATER_SIM_CLUMP_LO < WATER_SIM_CLUMP_HI
  );
  ok(
    'the clump band sits within [0, 1], where the accumulated foam value actually lives',
    WATER_SIM_CLUMP_LO >= 0 && WATER_SIM_CLUMP_HI <= 1
  );
  ok(
    'WATER_SIM_CLUMP_AA_PX is a real, positive screen-pixel width (2026-08-19 anti-aliasing fix)',
    WATER_SIM_CLUMP_AA_PX > 0
  );
  ok('WATER_SIM_SHEAR_GAIN is positive (a gain, not a silent zero or a sign flip)', WATER_SIM_SHEAR_GAIN > 0);
  ok('WATER_SIM_NEAR_SOLID_GAIN is positive', WATER_SIM_NEAR_SOLID_GAIN > 0);
  ok('WATER_SIM_NOISE_CELL_PX is positive (a divisor — zero would be a NaN trap)', WATER_SIM_NOISE_CELL_PX > 0);
  ok('WATER_SIM_NOISE_TIME_SCALE is positive (noise should evolve forward)', WATER_SIM_NOISE_TIME_SCALE > 0);
  ok(
    'WATER_SIM_NOISE_FLOOR sits strictly between 0 and 1 (never fully silences emission, never fails to gate)',
    WATER_SIM_NOISE_FLOOR > 0 && WATER_SIM_NOISE_FLOOR < 1
  );
  // ── trails and riffles (2026-11-10, mmp-78u.30.11) ──
  ok('fast water keeps the author decay', Math.abs(waterSimFoamLifeSec(1.3, 1) - 1.3) < 1e-9);
  ok('slow water keeps foam SLOW_LIFE_MUL times longer (rafts drift for seconds)', Math.abs(waterSimFoamLifeSec(1.3, 0) - 1.3 * WATER_SIM_SLOW_LIFE_MUL) < 1e-9);
  ok('a river reach (0.33, ~23 px/s) keeps foam ~5 s: trails of 100+ px', waterSimFoamLifeSec(1.3, 0.33) * 0.33 * 70 > 100);
  ok('life never rises with speed', [0, 0.2, 0.4, 0.6, 0.8, 1].every((v, i, a) => i === 0 || waterSimFoamLifeSec(1.3, v) <= waterSimFoamLifeSec(1.3, a[i - 1])));
  ok('deep water never riffles, however fast', waterSimRiffleEmit(1, 0.95, 0) === 0);
  ok('slow water never riffles, however shallow', waterSimRiffleEmit(0.3, 0.1, 0.05) === 0);
  ok('fast shallow water riffles', waterSimRiffleEmit(1.1, 0.2, 0) > 0.4);
  ok('fast water climbing over a submerged rock riffles even where it is deepish', waterSimRiffleEmit(1.1, 0.7, 0.05) > waterSimRiffleEmit(1.1, 0.7, 0));
}
