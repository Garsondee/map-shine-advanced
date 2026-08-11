/**
 * ENERGY FIELD — Foundry's `energy` animation (docs/reference/foundry-v14-
 * light-animations-audit.md §4 `energy`). CPU driver: `animateTime`.
 * Coloration-only; `forceDefaultColor = true`.
 *
 * NOISE SUBSTITUTION (documented, not silent — tsl-noise-toolkit.js's own
 * header, and this is the animation that most needs the caveat stated
 * plainly): Foundry hand-rolls its own classic 3x3x3 (27-iteration) 3D
 * Worley/cellular search here (`energy-field.mjs`'s own `voronoi3d`, built
 * on a bespoke `PRNG3D` hash). This port uses `voronoiVec3`
 * (`THREE.TSL.mx_worley_noise_vec3`, a well-tested built-in) for the same
 * cellular/Worley noise FAMILY, at lower risk and less code.
 *
 * GPU-ONLY REWRITE (2026-07-20): `time`/`uIntensityRaw` are now the
 * scaffold-supplied params (no longer self-created uniforms).
 *
 * @module effects/lighting/animations/energy
 */

import { voronoiVec3 } from './tsl-noise-toolkit.js';

/**
 * Translated term-for-term from `effects/energy-field.mjs:6-81` (audit §4
 * `energy`), substituting `voronoiVec3` for the hand-rolled cell search:
 * ```
 * f = (1 - sqrt(1-dist)) / dist                          // radial warp
 * uv = (vUvs - 0.5) * f*4*intensity + 0.5
 * t = time*0.4
 * uvx=cos(uv.x-t); uvxt=cos(uv.x+sin(t)); uvyt=sin(uv.y+cos(t))
 * c = voronoi3d(vec3(uv.x-uvx+uvyt, mix(uv.x,uv.y,0.5)+uvxt-uvyt+uvx, uv.y+uvxt-uvx))
 * finalColor = c.x^3 * color * colorationAlpha
 * ```
 * (`uvy` is computed in Foundry's own source but never actually used in the
 * final expression — kept out entirely here rather than ported as dead
 * code.)
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uLightColor
 * @param {*} args.uColorationAlpha
 * @param {*} args.dist
 * @param {*} args.time
 * @param {*} args.uIntensityRaw
 * @returns {{finalColor: *}}
 */
export function buildEnergyColorationSeed({
  THREE,
  uLightColor,
  uColorationAlpha,
  dist,
  time,
  uIntensityRaw,
  localPosition,
}) {
  const { float, vec2, vec3, cos, sin, sqrt, mix } = THREE.TSL;

  // Foundry's vUvs — see flame.js's own header for the derivation this
  // project already establishes (unit-radius/origin-centered local space,
  // mapped to Foundry's [0,1]/0.5-centered uv space). NEVER `positionLocal`
  // directly — see candle-flicker.js's own header (`localPosition` is the
  // shading core's injected equivalent, safe under batching).
  const vUvs = localPosition.mul(float(0.5)).add(float(0.5));

  // f = (1-sqrt(1-dist))/dist. At dist=0 (the light's exact center) this is
  // a genuine 0/0 in Foundry's own literal formula too, not guarded there
  // either — matched, not "fixed".
  const f = float(1)
    .sub(sqrt(float(1).sub(dist)))
    .div(dist);

  const half = vec2(0.5, 0.5);
  const uv = vUvs
    .sub(half)
    .mul(f.mul(float(4)).mul(uIntensityRaw))
    .add(half);

  const t = time.mul(float(0.4));
  const uvx = cos(uv.x.sub(t));
  const uvxt = cos(uv.x.add(sin(t)));
  const uvyt = sin(uv.y.add(cos(t)));

  const samplePos = vec3(
    uv.x.sub(uvx).add(uvyt),
    mix(uv.x, uv.y, float(0.5)).add(uvxt).sub(uvyt).add(uvx),
    uv.y.add(uvxt).sub(uvx)
  );

  const cell = voronoiVec3(THREE.TSL, samplePos);
  const c = cell.x;
  const energyGlow = c.mul(c).mul(c);

  const finalColor = energyGlow.mul(uLightColor).mul(uColorationAlpha);
  return { finalColor };
}
