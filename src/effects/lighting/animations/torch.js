/**
 * TORCH — Foundry's `torch` animation (docs/reference/foundry-v14-light-
 * animations-audit.md §4 `torch`). CPU driver: `animateTorch` → the
 * flicker primitive (`light-animation-clock.js#computeFlickerUniforms`),
 * with `amplification = intensityRaw/5` (this animation's own
 * `flickerAmplification`, wired in registry.js).
 *
 * ILLUMINATION NEEDS NO SHADER CHANGE AT ALL — verified against source, not
 * an oversight: Torch's illumination fragment body is textually the
 * unmodified default scaffold (audit's own `torch` entry: "zero lines
 * added"). The flicker still visibly animates illumination because the CPU
 * driver jitters the SHARED `ratio` uniform that the switchColor band
 * already reads every frame — vt-pan-viewer.js's per-frame driver loop
 * writes the jittered ratio into the SAME `uRatio` a non-animated light
 * already uses, no shader-graph change needed. So this module exports only
 * a coloration seed builder; the registry entry leaves
 * `buildIlluminationSeed: null`.
 *
 * Coloration DOES change: `finalColor = color * brightnessPulse *
 * colorationAlpha` (the seed — point-light-coloration.js still multiplies
 * by the technique-1 `reflection` term afterward, unconditionally, exactly
 * as Foundry's own `${COLORATION_TECHNIQUES}` does for every animation).
 *
 * @module effects/lighting/animations/torch
 */

/**
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uLightColor - the scaffold's own per-light colour uniform.
 * @param {*} args.uColorationAlpha - the scaffold's own colorationAlpha uniform.
 * @returns {{finalColor: *, uniforms: {uBrightnessPulse: *}}}
 */
export function buildTorchColorationSeed({ THREE, uLightColor, uColorationAlpha }) {
  const { uniform, float } = THREE.TSL;
  const uBrightnessPulse = uniform(float(1));
  const finalColor = uLightColor.mul(uBrightnessPulse).mul(uColorationAlpha);
  return { finalColor, uniforms: { uBrightnessPulse } };
}
