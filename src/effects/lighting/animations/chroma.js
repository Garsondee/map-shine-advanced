/**
 * CHROMA — Foundry's `chroma` animation (docs/reference/foundry-v14-light-
 * animations-audit.md §4 `chroma`). CPU driver: `animateTime` (the shared
 * base clock — no CPU-side noise/wave math, `cpuDriver: 'time'`).
 * Coloration-only; `forceDefaultColor = true` (this animation invents its
 * own colour, so it must render even on a colourless light — see
 * registry.js's own header for what that flips in vt-pan-viewer.js).
 *
 * Simplest coloration-only animation in the set: a straight linear blend
 * between the light's own colour and a cycling hue, weighted by the
 * intensity slider.
 *
 * @module effects/lighting/animations/chroma
 */

import { hsb2rgb } from './tsl-noise-toolkit.js';

/**
 * `finalColor = mix(color, hsb2rgb(vec3(time*0.25, 1, 1)), intensity*0.1) *
 * colorationAlpha`. At `intensity=0` this is just the light's own colour
 * (technique-1 `reflection` still applies afterward, unconditionally, same
 * as every other animation).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uLightColor
 * @param {*} args.uColorationAlpha
 * @returns {{finalColor: *, uniforms: {uTime: *, uIntensityRaw: *}}}
 */
export function buildChromaColorationSeed({ THREE, uLightColor, uColorationAlpha }) {
  const { uniform, float, mix } = THREE.TSL;
  const uTime = uniform(float(0));
  const uIntensityRaw = uniform(float(5));
  const hue = hsb2rgb(THREE.TSL, uTime.mul(float(0.25)), float(1), float(1));
  const finalColor = mix(uLightColor, hue, uIntensityRaw.mul(float(0.1))).mul(uColorationAlpha);
  return { finalColor, uniforms: { uTime, uIntensityRaw } };
}
