/**
 * water-shore-mask.test.mjs — the shoreline foam's distance estimate (CPU twin),
 * the schema ↔ constant parity, and that both TSL builders construct in Node.
 *
 * The LOOK is proven in the shader lab, not here (2026-10-17, real Tower Bridge
 * mask, real body/flow/sim bakes, the author's settings): the foam edge's
 * grid-locking to the ~7 px sim texel lattice measured R ≈ 0.88-0.91 before this
 * module (and 0.81-0.91 after the read-side blur that preceded it), and R ≈
 * 0.07-0.15 with it — where 1 is an edge sitting on the grid and 0 is an edge
 * that knows nothing about it.
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import {
  maskShoreDistance,
  buildMaskShoreDensity,
  buildFoamTexture,
  buildBreakSpecks,
  WATER_SHORE_FOAM_VARIATION,
  WATER_BREAK_SPRAY,
  WATER_SHORE_FOAM_AMOUNT,
  WATER_SHORE_FOAM_LEVEL,
  WATER_SHORE_FOAM_WIDTH_PX,
  WATER_SHORE_FOAM_SWASH_PX,
  WATER_SHORE_FOAM_SOFT_PX,
  WATER_FOAM_TEXTURE_PX,
  fleckReachPxNumber,
  FLECK_MOTION,
  shoreFlowPhases,
  SHORE_FLOW_CYCLE_SEC,
  SHORE_SLIDE_MAX_PX,
  rotatedTap,
} from '../water-shore-mask.js';
import { WATER_PARAMS } from '../water.js';

function stubTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

export function run(t) {
  const { ok } = t;

  // ── the distance estimate ───────────────────────────────────────────────
  ok('on the waterline the distance is 0', maskShoreDistance(0.2, 0.01, 0.2) === 0);
  ok('above the level is the water side (positive)', maskShoreDistance(0.3, 0.01, 0.2) > 0);
  ok('below the level is the land side (negative)', maskShoreDistance(0.1, 0.01, 0.2) < 0);
  ok(
    'a soft ramp well above the shelf floor stays metric: 0.1 of value at 0.005/px is 20 px, within 10%',
    Math.abs(maskShoreDistance(0.3, 0.005, 0.2) - 20) < 2
  );
  ok(
    'a hard edge is untouched by the shelf floor (within 0.1%)',
    Math.abs(maskShoreDistance(0.5, 0.05, 0.2) - 6) < 6e-3
  );
  {
    // NO COMBS ON A SHELVING BANK (2026-11-10): a WebP mask's shelf climbs one level per 16 px, and the blurred gradient
    // there flickers between ~0 and twice its true 0.000245/px. The distance read off it must not flicker with it.
    const trueG = 1 / 255 / 16;
    const ds = [0.02, 0.5, 1, 1.5, 2].map((k) => maskShoreDistance(0.12, trueG * k, 0.2));
    const spread = Math.max(...ds) - Math.min(...ds);
    ok(`a shelf's flickering gradient moves the distance less than 2 px (moved ${spread.toFixed(2)} px)`, spread < 2);
    ok(
      'a shelf still reads as the land side of the waterline',
      ds.every((d) => d < 0)
    );
  }
  ok(
    'no gradient (deep water plateau) clamps to a large finite distance, never Infinity/NaN',
    Number.isFinite(maskShoreDistance(1, 0, 0.2)) && maskShoreDistance(1, 0, 0.2) > 1000
  );
  ok(
    'no gradient on dry land clamps to a large NEGATIVE finite distance',
    Number.isFinite(maskShoreDistance(0, 0, 0.2)) && maskShoreDistance(0, 0, 0.2) < -1000
  );
  ok(
    'past a hard edge the SDF wins where the mask estimate overshoots',
    maskShoreDistance(1, 0, 0.2, 25, 4) === 25 + 0.9 * 4
  );
  ok(
    'right at a hard edge the mask estimate wins (the SDF never undercuts the 2σ floor)',
    Math.abs(maskShoreDistance(0.5, 0.05, 0.2, 0, 4) - 6) < 6e-3
  );
  ok(
    'on dry land the SDF can never pull the distance back up to the water side',
    maskShoreDistance(0.05, 0.01, 0.2, 0, 4) < 0
  );

  {
    // THE ROTATED TAP GRID (2026-11-10): same Gaussian, taps spread over a 4 px WebP block's phases.
    const K = [1, 4, 6, 4, 1];
    let sxx = 0,
      syy = 0,
      sxy = 0,
      sx = 0,
      sy = 0;
    const phasesY = new Set();
    const phasesX = new Set();
    for (let iy = -2; iy <= 2; iy++) {
      for (let ix = -2; ix <= 2; ix++) {
        const w = (K[ix + 2] * K[iy + 2]) / 256;
        const [ux, uy] = rotatedTap(ix, iy);
        sxx += w * ux * ux;
        syy += w * uy * uy;
        sxy += w * ux * uy;
        sx += w * ux;
        sy += w * uy;
        phasesX.add(Math.round(((((ux * 4) % 4) + 4) % 4) * 4));
        phasesY.add(Math.round(((((uy * 4) % 4) + 4) % 4) * 4));
      }
    }
    ok('the rotated tap grid is still centred', Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12);
    ok(
      'the rotated tap grid keeps the same Gaussian (second moment = identity)',
      Math.abs(sxx - 1) < 1e-12 && Math.abs(syy - 1) < 1e-12 && Math.abs(sxy) < 1e-12
    );
    ok(
      `at sigma 4 the taps cover many phases of a 4 px block in x (${phasesX.size}) and y (${phasesY.size})`,
      phasesX.size >= 8 && phasesY.size >= 8
    );
  }
  // ── schema ↔ constants ──────────────────────────────────────────────────
  ok('shoreFoam default matches WATER_SHORE_FOAM_AMOUNT', WATER_PARAMS.shoreFoam.default === WATER_SHORE_FOAM_AMOUNT);
  ok(
    'shoreFoamLevel default matches WATER_SHORE_FOAM_LEVEL',
    WATER_PARAMS.shoreFoamLevel.default === WATER_SHORE_FOAM_LEVEL
  );
  ok(
    'shoreFoamWidthPx default matches WATER_SHORE_FOAM_WIDTH_PX',
    WATER_PARAMS.shoreFoamWidthPx.default === WATER_SHORE_FOAM_WIDTH_PX
  );
  ok(
    'shoreFoamSwashPx default matches WATER_SHORE_FOAM_SWASH_PX',
    WATER_PARAMS.shoreFoamSwashPx.default === WATER_SHORE_FOAM_SWASH_PX
  );
  ok(
    'shoreFoamSoftPx default matches WATER_SHORE_FOAM_SOFT_PX',
    WATER_PARAMS.shoreFoamSoftPx.default === WATER_SHORE_FOAM_SOFT_PX
  );
  ok(
    'foamTexturePx default matches WATER_FOAM_TEXTURE_PX',
    WATER_PARAMS.foamTexturePx.default === WATER_FOAM_TEXTURE_PX
  );
  ok('shoreFoam reaches 0 — the shoreline foam can be switched off', WATER_PARAMS.shoreFoam.min === 0);
  ok(
    'shoreFoamVariation default matches WATER_SHORE_FOAM_VARIATION',
    WATER_PARAMS.shoreFoamVariation.default === WATER_SHORE_FOAM_VARIATION
  );
  ok(
    'shoreFoamVariation spans 0..1 — 0 is the even band, so it stays reachable',
    WATER_PARAMS.shoreFoamVariation.min === 0 && WATER_PARAMS.shoreFoamVariation.max === 1
  );
  ok(
    'shoreFoamFlow is ON by default and 0..1 — 0 pins the foam to the bank again',
    WATER_PARAMS.shoreFoamFlow.default === 1 &&
      WATER_PARAMS.shoreFoamFlow.min === 0 &&
      WATER_PARAMS.shoreFoamFlow.max === 1
  );
  ok('breakSpray default matches WATER_BREAK_SPRAY', WATER_PARAMS.breakSpray.default === WATER_BREAK_SPRAY);

  // ── the shore pattern's flow-map phases (CPU twin) ──────────────────────
  {
    let sumsToOne = true;
    let zeroAtReset = true;
    let halfCycleApart = true;
    let normOk = true;
    for (let i = 0; i < 400; i++) {
      const p = shoreFlowPhases(i * 0.137);
      if (Math.abs(p.w0 + p.w1 - 1) > 1e-12) sumsToOne = false;
      if (p.ph0 < 0 || p.ph0 >= 1 || p.ph1 < 0 || p.ph1 >= 1) halfCycleApart = false;
      // the two phases are half a cycle apart
      const d = (((p.ph1 - p.ph0) % 1) + 1) % 1;
      if (Math.abs(d - 0.5) > 1e-9) halfCycleApart = false;
      // a copy is invisible exactly when it wraps (its phase is 0)
      if (p.ph0 < 1e-9 && p.w0 > 1e-6) zeroAtReset = false;
      if (p.norm < 0.7071 - 1e-9 || p.norm > 1 + 1e-9) normOk = false;
    }
    ok('the two flow-map weights always sum to 1', sumsToOne);
    ok('the phases are always half a cycle apart', halfCycleApart);
    ok('a copy has weight 0 at the instant it resets (nothing jumps on screen)', zeroAtReset);
    ok('the variance-preserving divisor stays between 1/sqrt(2) and 1', normOk);
    const mid = shoreFlowPhases(SHORE_FLOW_CYCLE_SEC * 0.25);
    ok('a quarter into the cycle the two copies are equally weighted', Math.abs(mid.w0 - 0.5) < 1e-9);
    ok(
      'the shore pattern never slides faster than a rapid could shear it (60 px/s cap)',
      SHORE_SLIDE_MAX_PX > 0 && SHORE_SLIDE_MAX_PX <= 90 && SHORE_FLOW_CYCLE_SEC >= 2
    );
  }
  ok('breakSpray reaches 0 — the spray can be switched off', WATER_PARAMS.breakSpray.min === 0);

  // ── construction ────────────────────────────────────────────────────────
  {
    const { texture, vec2, float, uniform } = THREE.TSL;
    const base = stubTexture();
    const maskTexNode = texture(base, vec2(0.5, 0.5));
    const worldXY = vec2(100, 200);
    const tSec = uniform(float(0));
    let built = null;
    try {
      built = buildMaskShoreDensity(THREE, {
        maskTexNode,
        maskUvAt: (offset) => vec2(0.5, 0.5).add(offset.mul(float(0.001))),
        worldXY,
        shoreDist: float(10),
        tSec,
        flowDir: vec2(0, 1),
        farOutward: vec2(1, 0),
      });
    } catch (e) {
      built = { error: e };
    }
    ok('buildMaskShoreDensity constructs', !!built && !built.error && !!built.density && !!built.dist);
    ok(
      'it hands back the shore normal and the facing it derived (the caller steers along-bank drift by them)',
      !!built?.outward && !!built?.front
    );
    let bare = null;
    try {
      bare = buildMaskShoreDensity(THREE, {
        maskTexNode,
        maskUvAt: (offset) => vec2(0.5, 0.5).add(offset.mul(float(0.001))),
        worldXY,
        tSec,
      });
    } catch (e) {
      bare = { error: e };
    }
    ok(
      'it still constructs with no flow and no SDF (still water, a tier without the body pack)',
      !!bare && !bare.error
    );
    let riding = null;
    try {
      riding = buildMaskShoreDensity(THREE, {
        maskTexNode,
        maskUvAt: (offset) => vec2(0.5, 0.5).add(offset.mul(float(0.001))),
        worldXY,
        shoreDist: float(10),
        tSec,
        flowDir: vec2(0, 1),
        farOutward: vec2(1, 0),
        slidePx: vec2(0, 40),
      });
    } catch (e) {
      riding = { error: e };
    }
    ok(
      'it constructs with a current to ride (the two-phase flow map on every along-shore noise)',
      !!riding && !riding.error && !!riding.density
    );
    ok('the "rides the current" dial has its setter', typeof riding?.setters?.setShoreFoamFlow === 'function');
    ok('it hands back the texture-size node the foam texture reads', !!built?.uTexturePx);
    ok('it hands back the hardness (the spray gate) and the spray strength node', !!built?.hardness && !!built?.uSpray);
    const names = [
      'setShoreFoam',
      'setShoreFoamLevel',
      'setShoreFoamWidthPx',
      'setShoreFoamSwashPx',
      'setShoreFoamSoftPx',
      'setFoamTexturePx',
      'setShoreFoamVariation',
      'setShoreFoamFlow',
      'setBreakSpray',
    ];
    ok(
      'every shoreline-foam setter exists',
      names.every((n) => typeof built?.setters?.[n] === 'function')
    );
    for (const n of names) built?.setters?.[n]?.(1);
    ok('the setters take a number without throwing', true);

    const other = stubTexture();
    const tapProbe = maskTexNode.sample(vec2(0.1, 0.1));
    maskTexNode.value = other;
    ok(
      'mask taps are .sample() clones: re-pointing the surface mask node re-points them (no extra node to collect)',
      tapProbe.value === other
    );

    let tex = null;
    try {
      tex = buildFoamTexture(THREE, { worldXY, density: float(0.5), tSec, texturePx: float(26) });
    } catch (e) {
      tex = { error: e };
    }
    ok('buildFoamTexture constructs (still water)', !!tex && !tex.error);
    let flowing = null;
    try {
      flowing = buildFoamTexture(THREE, {
        worldXY,
        density: float(0.5),
        tSec,
        texturePx: float(26),
        velocityPx: vec2(0, 70),
      });
    } catch (e) {
      flowing = { error: e };
    }
    ok('buildFoamTexture constructs carried by a current (the two-phase flow map)', !!flowing && !flowing.error);

    let specks = null;
    let sprayCalls = 0;
    let waterCalls = 0;
    try {
      specks = buildBreakSpecks(THREE, {
        worldXY,
        tSec,
        velocityPx: vec2(0, 70),
        insideHere: float(1),
        sprayAt: () => (sprayCalls++, float(1)),
        waterAt: () => (waterCalls++, float(1)),
        uSpray: uniform(float(1)),
      });
    } catch (e) {
      specks = { error: e };
    }
    ok('buildBreakSpecks constructs', !!specks && !specks.error);
    ok(
      'every fleck asks the emitter at its OWN spawn point and the mask at its landing point (one of each per frame)',
      sprayCalls > 1 && sprayCalls === waterCalls
    );
  }

  // ── THE FLECK REACH IS A TRUE BOUND (2026-10-25, W-06) ──────────────────
  // `buildBreakSpecks` skips its loop past `fleckReachPx` of a shore. Brute
  // force every fleck's drawn position (the shader's own motion, transcribed:
  // lead back to the launch, flight, ride, a 2×2 fleck) over its whole life,
  // at several current speeds, and check none lands farther from its launch
  // than the bound allows beyond the emitter band.
  {
    const M = FLECK_MOTION;
    const frac = (x) => x - Math.floor(x);
    let worst = 0;
    let worstBound = Infinity;
    let violations = 0;
    for (const speedPx of [0, 20, 60, 150, 400]) {
      const bound = fleckReachPxNumber({ speedPx, emitterBandPx: 0 });
      for (let g = 0; g < M.GENERATIONS; g++) {
        for (let k = 0; k < M.DIRECTIONS; k++) {
          for (let gen = 0; gen < 40; gen++) {
            const hSpeed = frac(gen * 0.3719 + k * 0.4142 + g * 0.29);
            const hAir = frac(gen * 0.5521 + k * 0.3317 + g * 0.61);
            const speed = M.SPEED_MIN + (M.SPEED_MAX - M.SPEED_MIN) * hSpeed;
            const airSec = M.AIR_MIN + (M.AIR_MAX - M.AIR_MIN) * hAir;
            const apex = M.APEX * (0.4 + 0.3 * hSpeed + 0.3 * hAir);
            for (let step = 0; step <= 90; step++) {
              const tau = (step / 90) * M.LIFE;
              const tAir = Math.min(tau, airSec);
              const airFrac = tAir / airSec;
              const flight = speed * tAir * (1 - airFrac * 0.4);
              const height = tau <= airSec ? 4 * airFrac * (1 - airFrac) : 0;
              const wind = M.WIND * tAir; // full wind, worst case
              const afterAir = Math.max(tau - airSec, 0);
              const scatter = Math.abs(frac(gen * 0.7311 + k * 0.1913 + g * 0.37) - 0.5) * 2 * M.SCATTER;
              const ride = (speedPx + scatter) * afterAir;
              const dot = M.RADIUS_MAX * 1.3 + 1;
              const dist = M.LEAD + flight + apex * height + wind + ride + M.CELL * Math.SQRT2 + dot;
              if (dist > worst) {
                worst = dist;
                worstBound = bound;
              }
              if (dist > bound) violations++;
            }
          }
        }
      }
    }
    ok(
      `fleckReachPx bounds every brute-forced fleck position (worst ${worst.toFixed(1)} px vs bound ${worstBound.toFixed(1)} px)`,
      violations === 0
    );
  }
}
