/**
 * SIREN — Foundry's `siren` animation (docs/reference/foundry-v14-light-
 * animations-audit.md §4 `siren`). CPU driver: `animateTorch` (the flicker
 * primitive, `amplification = uIntensityRaw/5` — same wrapper as `torch`,
 * registry.js's own `flickerAmplification`). Both channels; a rotating
 * beam like `revolving`, but faster (`time*50` vs `revolving`'s bare
 * `time`) and layered with the flicker's `brightnessPulse`.
 *
 * Shares `revolving`'s open `angle`-uniform question (see revolving.js's
 * own header) — same `rot(time*50)` default, no `angle` term, pending a
 * live A/B.
 *
 * GPU-ONLY REWRITE (2026-07-20) — see torch.js's own header for the general
 * reasoning: illumination now rebuilds the switchColor band itself with a
 * GPU-jittered ratio (`buildFlickerRatioNode`) instead of relying on a
 * CPU-pre-jittered `uRatio`.
 *
 * @module effects/lighting/animations/siren
 */

import { rotate2d, pie } from './tsl-noise-toolkit.js';
import { buildFlickerNode, buildFlickerRatioNode } from './light-animation-clock.js';

/**
 * Illumination's beam is HALF-STRENGTH (`mix(1, pie(...), 0.5)` — blends
 * 50/50 with "no beam at all"), always a softer wash than coloration's
 * beam even at identical angular math (verified against source, not a
 * simplification of this port's own).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uRatio - the scaffold's own BASE ratio uniform.
 * @param {*} args.uIntensityRaw
 * @param {*} args.time
 * @param {*} args.dist
 * @param {*} args.computeSwitchColorBand - the scaffold's own band-rebuild closure.
 * @returns {{finalColor: *}}
 */
export function buildSirenIlluminationSeed({ THREE, uRatio, uIntensityRaw, time, dist, computeSwitchColorBand }) {
  const { float, mix, clamp, positionLocal } = THREE.TSL;
  const amplification = uIntensityRaw.div(float(5));
  const { n, brightnessPulse } = buildFlickerNode(THREE.TSL, { time, amplification });
  const jitteredRatio = buildFlickerRatioNode(THREE.TSL, uRatio, n);
  const seed = computeSwitchColorBand(jitteredRatio);

  const ncoord = rotate2d(THREE.TSL, positionLocal.xy, time.mul(float(50)));
  const angularIntensity = mix(float(Math.PI), float(0), uIntensityRaw.mul(float(0.1)));
  const gradientFade = clamp(float(0.45).mul(dist), float(0.05), float(1));
  const angularCorrection = mix(float(1), pie(THREE.TSL, ncoord, angularIntensity, gradientFade, float(1)), float(0.5));

  const finalColor = seed.mul(angularCorrection).mul(brightnessPulse);
  return { finalColor };
}

/**
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uLightColor
 * @param {*} args.uColorationAlpha
 * @param {*} args.uIntensityRaw
 * @param {*} args.time
 * @param {*} args.dist
 * @returns {{finalColor: *}}
 */
export function buildSirenColorationSeed({ THREE, uLightColor, uColorationAlpha, uIntensityRaw, time, dist }) {
  const { float, mix, clamp, positionLocal } = THREE.TSL;
  const amplification = uIntensityRaw.div(float(5));
  const { brightnessPulse } = buildFlickerNode(THREE.TSL, { time, amplification });

  const ncoord = rotate2d(THREE.TSL, positionLocal.xy, time.mul(float(50)));
  const angularIntensity = mix(float(Math.PI), float(0), uIntensityRaw.mul(float(0.1)));
  const gradientFade = clamp(float(0.15).mul(dist), float(0.05), float(1));
  const angularCorrection = pie(THREE.TSL, ncoord, angularIntensity, gradientFade, float(1));

  const finalColor = uLightColor.mul(brightnessPulse).mul(uColorationAlpha).mul(angularCorrection);
  return { finalColor };
}
