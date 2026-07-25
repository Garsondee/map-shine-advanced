/**
 * TORCH — Foundry's `torch` animation (docs/reference/foundry-v14-light-
 * animations-audit.md §4 `torch`). CPU driver: `animateTorch` → the
 * flicker primitive (`light-animation-clock.js#buildFlickerNode`), with
 * `amplification = uIntensityRaw/5` (this animation's own
 * `flickerAmplification`, wired in registry.js).
 *
 * GPU-ONLY REWRITE (2026-07-20): under the old CPU-driven design, Torch's
 * illumination needed NO shader change at all — the CPU driver wrote the
 * flicker-jittered ratio directly into the SAME `uRatio` uniform the
 * default switchColor band already read, so the scaffold's own default
 * seed was already correct. Now that `time`/flicker-noise are computed
 * ENTIRELY in-shader (the author's own WebGPU-performance direction:
 * "let's not leave any CPU stuff in if we can avoid it"), `uRatio` only
 * ever holds the light's BASE ratio — the jitter has to happen in-shader
 * too, so illumination now has a REAL seed builder that rebuilds the
 * switchColor band itself via `computeSwitchColorBand` (the scaffold's own
 * exposed closure) with a GPU-jittered ratio.
 *
 * Coloration: `finalColor = color * brightnessPulse * colorationAlpha` (the
 * seed — point-light-coloration.js still multiplies by the technique-1
 * `reflection` term afterward, unconditionally, exactly as Foundry's own
 * `${COLORATION_TECHNIQUES}` does for every animation).
 *
 * @module effects/lighting/animations/torch
 */

import { buildFlickerNode, buildFlickerRatioNode } from './light-animation-clock.js';

/**
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uRatio - the scaffold's own BASE ratio uniform.
 * @param {*} args.uIntensityRaw - LightData.animation.intensity (0..10).
 * @param {*} args.time - this light's shared animation-clock node.
 * @param {*} args.computeSwitchColorBand - the scaffold's own band-rebuild closure.
 * @returns {{finalColor: *}}
 */
export function buildTorchIlluminationSeed({ THREE, uRatio, uIntensityRaw, time, computeSwitchColorBand }) {
  const { float } = THREE.TSL;
  const amplification = uIntensityRaw.div(float(5));
  const { n } = buildFlickerNode(THREE.TSL, { time, amplification });
  const jitteredRatio = buildFlickerRatioNode(THREE.TSL, uRatio, n);
  const finalColor = computeSwitchColorBand(jitteredRatio);
  return { finalColor };
}

/**
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uLightColor - the scaffold's own per-light colour uniform.
 * @param {*} args.uColorationAlpha - the scaffold's own colorationAlpha uniform.
 * @param {*} args.uIntensityRaw
 * @param {*} args.time
 * @returns {{finalColor: *}}
 */
export function buildTorchColorationSeed({ THREE, uLightColor, uColorationAlpha, uIntensityRaw, time }) {
  const { float } = THREE.TSL;
  const amplification = uIntensityRaw.div(float(5));
  const { brightnessPulse } = buildFlickerNode(THREE.TSL, { time, amplification });
  const finalColor = uLightColor.mul(brightnessPulse).mul(uColorationAlpha);
  return { finalColor };
}
