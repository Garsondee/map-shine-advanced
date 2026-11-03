/**
 * light-edge.test.mjs — mmp-3kb: a point light must fade into the ambient at its edge, not
 * stop in a ring at ~70% of its dim radius. The shader's output is modelled here in plain JS
 * from the module's own constants and twins (`lightFloorFade01`, `easeAttenuation`), then
 * MAX-blended over an ambient exactly as the illum pass does. Numbers are the light bench's,
 * measured in a real Foundry scene at night: ambient 0.19, dim light 0.39, bright 1.0.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from '../../../vendor/three/three.webgpu.js';
import {
  LIGHT_FLOOR_FADE_WIDTH,
  LIGHT_EXCESS_REACH,
  lightFloorFade01,
  stretchToReach01,
  lightFloorFade,
  shapeIlluminationOutput,
  easeAttenuation,
} from '../point-light-illumination.js';

const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

const AMBIENT = 0.19;
const BRIGHT = 1.0;
const DIM = AMBIENT + (BRIGHT - AMBIENT) * 0.25; // Foundry's dim weight: 0.39, as measured
const RATIO = 0.5;

/** Foundry's illumination for one light (the plain 'foundry' model, Light shape 0). */
function lamp(attenuation) {
  const a = easeAttenuation(attenuation);
  const sw = (d) => {
    const lo = RATIO * (0.99 - a * 0.7);
    const hi = Math.min(1, Math.max(0.0001, RATIO * (1.01 + a * 0.7)));
    return BRIGHT + (DIM - BRIGHT) * smoothstep(lo, hi, d);
  };
  const corona = (d) => smoothstep(1, 1 - Math.max(a, 0.0001), d);
  return { sw, corona };
}

/** The shipped shaping: floor × floorFade + (lit − floor) × corona(stretched d). */
const shaped = (L, floor) => (d) => floor * lightFloorFade01(d) + (L.sw(d) - floor) * L.corona(stretchToReach01(d));
/** Foundry's own, no soft edge at all. */
const foundry = (L, floor) => (d) => floor + (L.sw(d) - floor) * L.corona(d);
/** The 2026-10-27 version this replaced: one 0.45-wide envelope over the whole output. */
const envelopeOld = (d) => {
  const x = Math.min(1, Math.max(0, (1 - d) / 0.45));
  const s = x * x * (3 - 2 * x);
  return s * s;
};
const old = (L, floor) => (d) => (floor + (L.sw(d) - floor) * L.corona(d)) * envelopeOld(d);

const visible = (out, ambient) => (d) => Math.max(ambient, out(d));

/** Where the light stops adding anything (first d past which visible == ambient). */
function reachOf(v, ambient) {
  for (let d = 0; d <= 1; d += 0.001) if (v(d) <= ambient + 1e-6) return d;
  return 1;
}
/** The slope break where the light meets the ambient: |slope just inside| (outside it is 0). */
function edgeKink(v, ambient) {
  const e = reachOf(v, ambient);
  const h = 0.002;
  return Math.abs((v(e) - v(e - h)) / h);
}

const END_STRETCH = (stretchToReach01(LIGHT_EXCESS_REACH) - stretchToReach01(LIGHT_EXCESS_REACH - 1e-6)) / 1e-6;

export function run(t) {
  t.ok('the floor fade is 1 everywhere the light still adds', lightFloorFade01(LIGHT_EXCESS_REACH) === 1);
  t.ok('...and exactly 0 at the rim', lightFloorFade01(1) === 0);
  t.ok(
    'the stretch puts the reach at the end of the curve',
    Math.abs(stretchToReach01(LIGHT_EXCESS_REACH) - 1) < 1e-12
  );
  t.ok('...and barely touches the inner half', stretchToReach01(0.5) / 0.5 < 1.015);
  t.ok(`...at the price of a ${END_STRETCH.toFixed(2)}× steeper end`, END_STRETCH < 1.4);
  t.ok('the band is a narrow rim, not half the light', LIGHT_FLOOR_FADE_WIDTH <= 0.08);

  for (const att of [0, 0.25, 0.5, 0.75, 1]) {
    const L = lamp(att);
    const vNew = visible(shaped(L, AMBIENT), AMBIENT);
    const vOld = visible(old(L, AMBIENT), AMBIENT);
    const reachNew = reachOf(vNew, AMBIENT);
    t.ok(
      `att ${att}: the light reaches ${reachNew.toFixed(3)} of its radius (was ${reachOf(vOld, AMBIENT).toFixed(3)})`,
      reachNew >= LIGHT_EXCESS_REACH - 0.01
    );
    // A low attenuation is an AUTHORED crisp corona (0 = Foundry's hard disc); the edge may be
    // as crisp as that, squeezed into the shorter reach, and no crisper.
    const f = foundry(L, AMBIENT);
    const kNew = edgeKink(vNew, AMBIENT);
    const kAuthored = edgeKink(visible(f, AMBIENT), AMBIENT) / LIGHT_EXCESS_REACH;
    t.ok(
      `att ${att}: it meets the ambient no harder than its own corona (|slope| ${kNew.toFixed(3)}, Foundry's ${kAuthored.toFixed(3)})`,
      // A smoothstep's slope a fixed step before its end scales with the SQUARE of the stretch's end slope
      // (stretchToReach01 ends ~1.32× steep), so that is the most a crisp corona may sharpen.
      kNew <= Math.max(0.05, kAuthored * END_STRETCH ** 2 * 1.1)
    );
    // the source itself and the bright core are Foundry's
    t.ok(`att ${att}: identical at the source`, Math.abs(shaped(L, AMBIENT)(0) - f(0)) < 1e-12);
    let worst = 0;
    for (let d = 0; d <= 0.5; d += 0.01)
      worst = Math.max(worst, Math.abs(shaped(L, AMBIENT)(d) - f(d)) / (f(d) - AMBIENT || 1));
    t.ok(`att ${att}: within ${(worst * 100).toFixed(1)}% of Foundry's light over the inner half`, worst < 0.03);
  }

  // the bug, as measured on the bench (attenuation 0.5): the old envelope stopped the lamp
  // at ~0.7 with a hard slope break. Kept as a check that the measure above can see it.
  const bench = lamp(0.5);
  const vOldBench = visible(old(bench, AMBIENT), AMBIENT);
  t.ok(
    'the old envelope really did stop the lamp at ~0.7 of its radius',
    Math.abs(reachOf(vOldBench, AMBIENT) - 0.7) < 0.06
  );
  t.ok('...with a slope break the new edge does not have', edgeKink(vOldBench, AMBIENT) > 0.3);
  t.ok(
    'the bench lamp is still lit at 0.85 of its radius',
    visible(shaped(bench, AMBIENT), AMBIENT)(0.85) > AMBIENT + 0.02
  );

  // a floor brighter than the real ambient (indoor lamp spilling onto golden-hour grass):
  // no pale fan cut off at the polygon — the floor is gone at the rim.
  const darkAmbient = AMBIENT * 0.5;
  const pale = shaped(bench, AMBIENT);
  t.ok('a too-bright floor is gone at the rim', pale(1) === 0 && pale(0.999) <= darkAmbient);
  t.ok('...and eases out (no step at the polygon)', Math.abs(pale(0.995) - pale(1)) < 0.01);

  // The shader graphs cannot be evaluated in Node, so hold both illumination builders to the
  // formula modelled above: the shared shaping, fed the reach-stretched falloff.
  for (const file of ['../point-light-illumination.js', '../point-light-merged.js']) {
    const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    t.ok(
      `${file.slice(3)} shapes its output through shapeIlluminationOutput with the run-out falloff`,
      /illumReach: LIGHT_EXCESS_REACH/.test(src) &&
        /shapeIlluminationOutput\(THREE\.TSL, \{\s*backgroundFloor,\s*litColor: \w+,\s*falloff: illumFalloff\w*,/.test(
          src
        ) &&
        !/softEdgeEnvelope/.test(src)
    );
  }

  let built = false;
  try {
    const { float, vec3 } = THREE.TSL;
    built =
      !!lightFloorFade(THREE.TSL, float(0.95)) &&
      !!shapeIlluminationOutput(THREE.TSL, {
        backgroundFloor: vec3(0.19),
        litColor: vec3(0.39),
        falloff: float(0.5),
        dist: float(0.5),
      });
  } catch (_) {
    built = false;
  }
  t.ok('the TSL nodes construct', built);
}
