/**
 * SMOKEPATCH — Foundry's `smokepatch` (Smoke Patch) animation (docs/
 * reference/foundry-v14-light-animations-audit.md §4 `smokepatch`). CPU
 * driver: `animateTime`. Both channels; the ONE animation in this set
 * whose shape function (`smokefading`/`transform`) is byte-identical
 * between channels — built once here, called from both seed builders.
 * Drifting FBM smoke via a rotate+shear transform (the shear is coupled to
 * screen position, not a pure scale — see `transform()`'s own comment).
 *
 * Reconstructed with a documented simplification (author-authorized, close
 * visual parity over a slavish translation): Foundry's own transform
 * composes `rotmat * scalemat` as a single GLSL mat2 product before
 * applying it to `uv`; this port applies rotation then the position-
 * coupled shear as two sequential steps instead of one fused matrix
 * multiply.
 *
 * GPU-ONLY REWRITE (2026-07-20): `time`/`uIntensityRaw` are now the
 * scaffold-supplied params (no longer self-created uniforms).
 *
 * @module effects/lighting/animations/smokepatch
 */

import { fbmFloat } from './tsl-noise-toolkit.js';

/** `transform(uv)` — rotate(t) then a uv-position-coupled shear+scale, about the 0.5 pivot. */
function transform(TSL, uv, time) {
  const { float, cos, sin, vec2 } = TSL;
  const t = time.mul(float(0.1));
  const cost = cos(t);
  const sint = sin(t);
  const half = vec2(0.5, 0.5);
  const shifted = uv.sub(half);
  const rotated = vec2(shifted.x.mul(cost).sub(shifted.y.mul(sint)), shifted.x.mul(sint).add(shifted.y.mul(cost)));
  // shear/scale from Foundry's own column-major mat2(10, uv.x, uv.y, 10):
  // column0=(10,uv.x), column1=(uv.y,10) — uv.x/uv.y (the ORIGINAL,
  // pre-shift position) land in the off-diagonal slots, a position-coupled
  // shear, not a typo-for-scale (verified against source).
  const sheared = vec2(
    rotated.x.mul(float(10)).add(rotated.y.mul(uv.y)),
    rotated.x.mul(uv.x).add(rotated.y.mul(float(10)))
  );
  return sheared.add(half);
}

/** `smokefading(dist)` — shared verbatim between channels. */
function smokefading(TSL, dist, time, uIntensityRaw) {
  const { float, mix, pow, max, positionLocal } = TSL;
  const vUvs = positionLocal.xy.mul(float(0.5)).add(float(0.5));
  const uv = transform(TSL, vUvs, time);
  const t = time.mul(float(0.4));

  const base = fbmFloat(TSL, uv, { amplitude: float(1).add(uIntensityRaw.mul(float(0.4))) });
  const drift = max(fbmFloat(TSL, uv.add(t)), fbmFloat(TSL, uv.sub(t)));
  const blend = pow(dist, uIntensityRaw.mul(float(0.5)));
  return pow(float(1).sub(dist), mix(base, drift, blend));
}

/**
 * @param {object} args
 * @param {*} args.THREE @param {*} args.dist @param {*} args.defaultSeed @param {*} args.time @param {*} args.uIntensityRaw
 * @returns {{finalColor: *}}
 */
export function buildSmokepatchIlluminationSeed({ THREE, dist, defaultSeed, time, uIntensityRaw }) {
  const finalColor = defaultSeed.mul(smokefading(THREE.TSL, dist, time, uIntensityRaw));
  return { finalColor };
}

/**
 * @param {object} args
 * @param {*} args.THREE @param {*} args.uLightColor @param {*} args.uColorationAlpha @param {*} args.dist @param {*} args.time @param {*} args.uIntensityRaw
 * @returns {{finalColor: *}}
 */
export function buildSmokepatchColorationSeed({ THREE, uLightColor, uColorationAlpha, dist, time, uIntensityRaw }) {
  const finalColor = uLightColor.mul(smokefading(THREE.TSL, dist, time, uIntensityRaw)).mul(uColorationAlpha);
  return { finalColor };
}
