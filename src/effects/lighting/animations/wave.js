/**
 * WAVE — Foundry's `wave` animation (docs/reference/foundry-v14-light-
 * animations-audit.md §4 `wave`). CPU driver: `animateTime`. Both channels,
 * a simple radial sine-ring pulse, no fbm/noise.
 *
 * `wave(dist) = coeff * 0.5*(sin(-time*6 + dist*10*intensity) + 1) + base`
 * — illumination and coloration use DIFFERENT constants (`0.3`/`0.8` vs
 * `0.55`/`0.8`, verified against source, not a shared function with one
 * hardcoded copy).
 *
 * GPU-ONLY REWRITE (2026-07-20): `time`/`uIntensityRaw` are now the
 * scaffold-supplied params (no longer self-created uniforms).
 *
 * @module effects/lighting/animations/wave
 */

function waveTerm(TSL, dist, time, uIntensityRaw, coeff, base) {
  const { float, sin } = TSL;
  const sinWave = float(0.5).mul(sin(time.mul(float(-6)).add(dist.mul(float(10)).mul(uIntensityRaw))).add(float(1)));
  return sinWave.mul(float(coeff)).add(float(base));
}

/**
 * `finalColor = defaultSeed * wave(dist)`, coefficients `0.3`/`0.8` (range `[0.8,1.1]`).
 * @param {object} args
 * @param {*} args.THREE @param {*} args.dist @param {*} args.defaultSeed @param {*} args.time @param {*} args.uIntensityRaw
 * @returns {{finalColor: *}}
 */
export function buildWaveIlluminationSeed({ THREE, dist, defaultSeed, time, uIntensityRaw }) {
  const finalColor = defaultSeed.mul(waveTerm(THREE.TSL, dist, time, uIntensityRaw, 0.3, 0.8));
  return { finalColor };
}

/**
 * `finalColor = color * wave(dist) * colorationAlpha`, coefficients `0.55`/`0.8` (range `[0.8,1.35]`).
 * @param {object} args
 * @param {*} args.THREE @param {*} args.uLightColor @param {*} args.uColorationAlpha @param {*} args.dist @param {*} args.time @param {*} args.uIntensityRaw
 * @returns {{finalColor: *}}
 */
export function buildWaveColorationSeed({ THREE, uLightColor, uColorationAlpha, dist, time, uIntensityRaw }) {
  const finalColor = uLightColor.mul(waveTerm(THREE.TSL, dist, time, uIntensityRaw, 0.55, 0.8)).mul(uColorationAlpha);
  return { finalColor };
}
