/**
 * Node verification for effects/lighting/canopy-light.js — foliage passing part of a point light
 * below it (2026-10-28). The CPU twin carries the numbers; the TSL term is checked to construct
 * with the real vendored TSL, inside a real illumination material, beam included.
 */
import {
  resolveCanopyLight,
  computeCanopyLight,
  pushCanopyLightUniforms,
  getCanopyLightUniforms,
  CANOPY_FLAG_IS_VEGETATION_MIRROR,
  CANOPY_FLAG_IS_TREE_MIRROR,
} from '../canopy-light.js';
import { buildPointLightIlluminationMaterial } from '../point-light-illumination.js';
import {
  DEPTH_FLAG_IS_VEGETATION,
  DEPTH_FLAG_IS_TREE,
  DEPTH_FLAG_IS_TILE,
  DEPTH_FLAG_IS_TOKEN,
  DEPTH_FLAG_RESTRICTS_LIGHT,
  computeVegetationDepthFlags,
} from '../../../vt/scene-depth.js';
import { VEGETATION_PARAMS } from '../../vegetation.js';
import * as THREE from '../../../vendor/three/three.webgpu.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

export function run(t) {
  const { ok } = t;

  // The mirrors must match the depth pass's real bits, and the bits must not collide with any
  // other flag a light gate reads.
  ok('vegetation bit mirror matches scene-depth.js', CANOPY_FLAG_IS_VEGETATION_MIRROR === DEPTH_FLAG_IS_VEGETATION);
  ok('tree bit mirror matches scene-depth.js', CANOPY_FLAG_IS_TREE_MIRROR === DEPTH_FLAG_IS_TREE);
  const others = DEPTH_FLAG_IS_TILE | DEPTH_FLAG_IS_TOKEN | DEPTH_FLAG_RESTRICTS_LIGHT | 2 | 4 | 8;
  ok('canopy bits overlap no other flag', ((DEPTH_FLAG_IS_VEGETATION | DEPTH_FLAG_IS_TREE) & others) === 0);
  ok('a tree writes vegetation + tree', computeVegetationDepthFlags('tree') === 160);
  ok('a bush writes vegetation only', computeVegetationDepthFlags('bush') === 128);
  ok('an unknown kind reads as a bush', computeVegetationDepthFlags(undefined) === 128);

  // Shipped defaults are the author's numbers.
  ok('trees block 75% by default', VEGETATION_PARAMS.treeLightBlock.default === 0.75);
  ok('bushes block 50% by default', VEGETATION_PARAMS.bushLightBlock.default === 0.5);

  const resolved = resolveCanopyLight({
    treeBlock: 0.75,
    bushBlock: 0.5,
    treeHeightFt: 25,
    bushHeightFt: 2,
    heightReach: 0.5,
    pxPerUnit: 20, // 100 px grid / 5 ft
  });
  ok('tree transmits 25%', near(resolved.treeTransmit, 0.25));
  ok('bush transmits 50%', near(resolved.bushTransmit, 0.5));
  ok('tree lift = 25 ft x 20 px/ft x 0.5', near(resolved.treeLiftPx, 250));
  ok('bush lift = 2 ft x 20 px/ft x 0.5', near(resolved.bushLiftPx, 20));
  ok(
    'bad inputs fall back, never NaN',
    Object.values(resolveCanopyLight({ treeBlock: NaN, pxPerUnit: -3 })).every(Number.isFinite)
  );
  ok('block is clamped to 0..1', near(resolveCanopyLight({ treeBlock: 4 }).treeTransmit, 0));

  // A tree above a 500 px light, right over it: a quarter of the light, reached 0.5 radii away.
  const tree = computeCanopyLight({ occluded: true, flagsByte: 160, dist: 0, radiusPx: 500, resolved });
  ok('tree above the light is "under"', tree.under === true);
  ok('tree passes its transmission', near(tree.transmit, 0.25));
  ok('tree distance is lifted by its height', near(tree.liftedDist, 0.5));
  // Off to the side the lift adds in quadrature, so the canopy fades sooner than the ground.
  const treeSide = computeCanopyLight({ occluded: true, flagsByte: 160, dist: 0.6, radiusPx: 500, resolved });
  ok('lift adds in quadrature', near(treeSide.liftedDist, Math.hypot(0.6, 0.5)));

  const bush = computeCanopyLight({ occluded: true, flagsByte: 128, dist: 0.3, radiusPx: 500, resolved });
  ok('bush passes half', near(bush.transmit, 0.5));
  ok('a low bush barely lifts', near(bush.liftedDist, Math.hypot(0.3, 20 / 500)) && bush.liftedDist - 0.3 < 0.005);

  const above = computeCanopyLight({ occluded: false, flagsByte: 160, dist: 0.3, radiusPx: 500, resolved });
  ok(
    'a canopy below the light is untouched',
    above.under === false && above.transmit === 0 && above.liftedDist === 0.3
  );
  const roof = computeCanopyLight({
    occluded: true,
    flagsByte: DEPTH_FLAG_IS_TILE,
    dist: 0.3,
    radiusPx: 500,
    resolved,
  });
  ok('a roof above the light still blocks it', roof.under === false && roof.transmit === 0);

  // The push reaches uniforms already built.
  const u = getCanopyLightUniforms(THREE.TSL);
  pushCanopyLightUniforms({
    treeBlock: 0.6,
    bushBlock: 0.2,
    treeHeightFt: 10,
    bushHeightFt: 1,
    heightReach: 1,
    pxPerUnit: 10,
  });
  ok('push writes tree transmission', near(u.uTreeTransmit.value, 0.4));
  ok('push writes bush transmission', near(u.uBushTransmit.value, 0.8));
  ok('push writes tree lift', near(u.uTreeLiftPx.value, 100));
  ok('the same TSL gets the same uniforms', getCanopyLightUniforms(THREE.TSL) === u);

  // The term inside real materials (round and beam), with real depth attachments.
  const { uniform: u3, vec3: v3, texture } = THREE.TSL;
  const depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
  const flagsTexture = new THREE.DataTexture(
    new Uint8Array([0, 0, 160, 255]),
    1,
    1,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  flagsTexture.needsUpdate = true;
  for (const [name, extra] of [
    ['round', {}],
    ['candle', { falloffModel: 'candle' }],
    [
      'beam',
      {
        falloffModel: 'beam',
        beamShape: {
          nearHalfWidth01: 0.05,
          farHalfWidth01: 0.55,
          edgeSoftness01: 0.18,
          lengthFalloffExponent: 1.6,
          coreIntensity: 1.6,
          midIntensity: 1.0,
          rimIntensity: 0.35,
        },
      },
    ],
  ]) {
    let err = null;
    try {
      buildPointLightIlluminationMaterial({
        THREE,
        uBackgroundColor: u3(v3(0.9, 0.9, 0.9)),
        uDimColor: u3(v3(0.9, 0.9, 0.9)),
        uBrightColor: u3(v3(1, 1, 1)),
        depthTexNode: texture(depthTexture),
        depthFlagsTexNode: texture(flagsTexture),
        ...extra,
      });
    } catch (e) {
      err = e;
    }
    ok(`a ${name} light with the canopy term constructs (${err ? err.message : 'clean'})`, err === null);
  }
}
