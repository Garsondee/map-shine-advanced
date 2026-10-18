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
    'a soft ramp gives a metric distance: 0.1 of value at 0.005/px is 20 px',
    Math.abs(maskShoreDistance(0.3, 0.005, 0.2) - 20) < 1e-9
  );
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
    Math.abs(maskShoreDistance(0.5, 0.05, 0.2, 0, 4) - 6) < 1e-9
  );
  ok(
    'on dry land the SDF can never pull the distance back up to the water side',
    maskShoreDistance(0.05, 0.01, 0.2, 0, 4) < 0
  );

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
  ok('breakSpray default matches WATER_BREAK_SPRAY', WATER_PARAMS.breakSpray.default === WATER_BREAK_SPRAY);
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
}
