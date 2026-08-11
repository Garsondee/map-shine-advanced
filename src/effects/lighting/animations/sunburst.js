/**
 * SUNBURST — Foundry's `sunburst` animation (docs/reference/foundry-v14-
 * light-animations-audit.md §4 `sunburst`). CPU driver: `animateTime`.
 * Both channels. Angular ray-burst (a `fract(angle*16+time)` beam pattern)
 * plus a central pulsing core.
 *
 * ORDER-OF-OPERATIONS NOTE (the audit's own flagged finding): Foundry's
 * illumination body runs `${ADJUSTMENTS}` (EXPOSURE) BEFORE its animated
 * ray multiply — the one illumination animation in the set that does. This
 * port applies the ray multiply as part of the SEED anyway (the same hook
 * point every other animation uses): EXPOSURE is a pure scalar multiply
 * with no dependency on the colour's own value, and sunburst's ray pattern
 * is ALSO a pure scalar multiply — scalar multiplication commutes, so the
 * two orderings are algebraically IDENTICAL.
 *
 * GPU-ONLY REWRITE (2026-07-20): `time`/`uIntensityRaw` are now the
 * scaffold-supplied params (no longer self-created uniforms).
 *
 * @module effects/lighting/animations/sunburst
 */

import { mirrorTriangle } from './tsl-noise-toolkit.js';

const INV_TWO_PI = 1 / (2 * Math.PI);

function cosTimeWave(TSL, a, b, time) {
  const { float, cos } = TSL;
  return a
    .sub(b)
    .mul(cos(time).add(float(1)).mul(float(0.5)))
    .add(b);
}

/**
 * `pow(max(light, mirrorTriangle(beam)), 3)` — the shared ray-burst pattern,
 * coefficients supplied per channel. `localPosition`: NEVER `positionLocal`
 * directly — see candle-flicker.js's own header.
 */
function sunburstPattern(TSL, dist, time, uIntensityRaw, lpulseHigh, lpulseLow, localPosition) {
  const { float, atan, fract, pow, abs, max } = TSL;
  const intensityMod = float(1).add(uIntensityRaw.mul(float(0.05)));
  const lpulse = cosTimeWave(TSL, lpulseHigh.mul(intensityMod), lpulseLow.mul(intensityMod), time);
  const uv = localPosition;
  const angle = atan(uv.x, uv.y).mul(float(INV_TWO_PI));
  const beam = fract(angle.mul(float(16)).add(time));
  const light = lpulse.mul(pow(abs(float(1).sub(dist)), float(0.65)));
  const sunburstVal = max(light, mirrorTriangle(TSL, beam));
  return pow(sunburstVal, float(3));
}

/**
 * @param {object} args
 * @param {*} args.THREE @param {*} args.dist @param {*} args.defaultSeed @param {*} args.time @param {*} args.uIntensityRaw
 * @returns {{finalColor: *}}
 */
export function buildSunburstIlluminationSeed({ THREE, dist, defaultSeed, time, uIntensityRaw, localPosition }) {
  const { float } = THREE.TSL;
  const pattern = sunburstPattern(THREE.TSL, dist, time, uIntensityRaw, float(1.3), float(0.85), localPosition);
  return { finalColor: defaultSeed.mul(pattern) };
}

/**
 * @param {object} args
 * @param {*} args.THREE @param {*} args.uLightColor @param {*} args.uColorationAlpha @param {*} args.dist @param {*} args.time @param {*} args.uIntensityRaw
 * @returns {{finalColor: *}}
 */
export function buildSunburstColorationSeed({
  THREE,
  uLightColor,
  uColorationAlpha,
  dist,
  time,
  uIntensityRaw,
  localPosition,
}) {
  const { float } = THREE.TSL;
  const pattern = sunburstPattern(THREE.TSL, dist, time, uIntensityRaw, float(1.1), float(0.85), localPosition);
  return { finalColor: uLightColor.mul(pattern).mul(uColorationAlpha) };
}
