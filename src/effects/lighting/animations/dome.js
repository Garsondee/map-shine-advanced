/**
 * DOME — Foundry's `dome` (Light Dome) animation (docs/reference/foundry-
 * v14-light-animations-audit.md §4 `dome`). CPU driver: `animateTime`.
 * Coloration-only; `forceDefaultColor = true`. A hemispherized, rotating,
 * FBM-palette ripple pattern — second occurrence of the domain-warp-
 * palette technique (compare `fog`). Uses `FBM(2)` (2 octaves — Foundry's
 * own reduced count for this animation specifically, not the 4-octave
 * default `fog`/others use).
 *
 * GPU-ONLY REWRITE (2026-07-20): `time`/`uIntensityRaw` are now the
 * scaffold-supplied params (no longer self-created uniforms).
 *
 * @module effects/lighting/animations/dome
 */

import { fbmFloat, hspherize, rotate2d } from './tsl-noise-toolkit.js';

const FBM2 = { octaves: 2 };

/**
 * @param {object} args
 * @param {*} args.THREE @param {*} args.uLightColor @param {*} args.uColorationAlpha @param {*} args.dist @param {*} args.time @param {*} args.uIntensityRaw
 * @returns {{finalColor: *}}
 */
export function buildDomeColorationSeed({ THREE, uLightColor, uColorationAlpha, dist, time, uIntensityRaw }) {
  const { float, vec2, vec3, mix, clamp, abs, pow, positionLocal } = THREE.TSL;

  // transform(): hemispherize + rotate(t) + scale(8*intensity) about the
  // 0.5 pivot — rotation and scale commute here (scale is uniform/scalar),
  // so this is expressed as rotate-then-scale rather than composing an
  // explicit mat2*mat2 product.
  const half = vec2(0.5, 0.5);
  const vUvs = positionLocal.xy.mul(float(0.5)).add(float(0.5));
  const f = hspherize(THREE.TSL, dist);
  const t = time.mul(float(0.02));
  const rotated = rotate2d(THREE.TSL, vUvs.sub(half), t);
  const uv = rotated.mul(float(8).mul(uIntensityRaw)).mul(f).add(half);

  const c1 = uLightColor.mul(float(0.55));
  const c2 = uLightColor.mul(float(0.02));
  const c3 = uLightColor.mul(float(0.3));
  const c4 = uLightColor;
  const c5 = uLightColor.mul(float(0.025));
  const c6 = uLightColor.mul(float(0.2));

  const p = uv.add(vec2(5, 5));
  const q = fbmFloat(THREE.TSL, p.add(time.mul(float(0.2))), FBM2).mul(float(2));
  const r = vec2(
    fbmFloat(THREE.TSL, p.add(q).add(time).sub(p.x).sub(p.y), FBM2),
    fbmFloat(THREE.TSL, p.mul(float(2)).add(time), FBM2)
  );
  const ripples = clamp(
    mix(c1, c2, abs(fbmFloat(THREE.TSL, p.add(r), FBM2)))
      .add(mix(c3, c4, abs(r.x.mul(r.x).mul(r.x))))
      .sub(mix(c5, c6, abs(r.y.mul(r.y)))),
    vec3(0, 0, 0),
    vec3(1, 1, 1)
  );

  const finalColor = ripples.mul(pow(float(1).sub(dist), float(0.25))).mul(uColorationAlpha);
  return { finalColor };
}
