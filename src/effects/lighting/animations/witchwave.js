/**
 * WITCHWAVE — Foundry's `witchwave` (Bewitching Wave) animation (docs/
 * reference/foundry-v14-light-animations-audit.md §4 `witchwave`). CPU
 * driver: `animateTime`. Both channels. An FBM-distorted version of the
 * plain sine-ring pulse (`wave`'s more elaborate sibling) — same shape
 * function, different coefficients per channel (matching `wave`'s own
 * illumination/coloration split, `0.3` vs `0.55`).
 *
 * GPU-ONLY REWRITE (2026-07-20): `time`/`uIntensityRaw` are now the
 * scaffold-supplied params (no longer self-created uniforms).
 *
 * @module effects/lighting/animations/witchwave
 */

import { fbmFloat, rotate2d } from './tsl-noise-toolkit.js';

/** `bwave(dist, coeff)` — shared shape, channel-specific coefficient. */
function bwave(TSL, dist, time, uIntensityRaw, coeff) {
  const { float, vec2, sin, mix, clamp, positionLocal } = TSL;
  const half = vec2(0.5, 0.5);
  const t = time.mul(float(0.25));
  const rotated = rotate2d(TSL, positionLocal.xy.mul(float(0.5)).add(float(0.5)).sub(half), t);
  const uv = rotated.mul(float(2.5)).add(half);

  const motion = fbmFloat(TSL, uv.add(time.mul(float(0.25))));
  const distortion = mix(float(1), motion, clamp(float(1).sub(dist), float(0), float(1)));
  const sinWave = float(0.5).mul(
    sin(time.mul(float(-6)).add(dist.mul(float(10)).mul(uIntensityRaw).mul(distortion))).add(float(1))
  );
  return sinWave.mul(float(coeff)).add(float(0.8));
}

/**
 * @param {object} args
 * @param {*} args.THREE @param {*} args.dist @param {*} args.defaultSeed @param {*} args.time @param {*} args.uIntensityRaw
 * @returns {{finalColor: *}}
 */
export function buildWitchwaveIlluminationSeed({ THREE, dist, defaultSeed, time, uIntensityRaw }) {
  const finalColor = defaultSeed.mul(bwave(THREE.TSL, dist, time, uIntensityRaw, 0.3));
  return { finalColor };
}

/**
 * @param {object} args
 * @param {*} args.THREE @param {*} args.uLightColor @param {*} args.uColorationAlpha @param {*} args.dist @param {*} args.time @param {*} args.uIntensityRaw
 * @returns {{finalColor: *}}
 */
export function buildWitchwaveColorationSeed({ THREE, uLightColor, uColorationAlpha, dist, time, uIntensityRaw }) {
  const finalColor = uLightColor.mul(bwave(THREE.TSL, dist, time, uIntensityRaw, 0.55)).mul(uColorationAlpha);
  return { finalColor };
}
