/**
 * PULSE — Foundry's `pulse` animation (docs/reference/foundry-v14-light-
 * animations-audit.md §4 `pulse`). CPU driver: `animatePulse`
 * (`light-animation-clock.js#computePulseUniforms`, a pure cosine wave, no
 * noise object needed).
 *
 * `reactivepulse` (Reactive Pulse) shares these EXACT shader bodies —
 * Foundry reuses the same `PulseIlluminationShader`/`PulseColorationShader`
 * classes, only swapping the CPU driver for an audio-reactive one
 * (`animateSoundPulse`, needs live `game.audio` band data — a genuinely
 * different dependency, deferred per registry.js's `KNOWN_DEFERRED_
 * ANIMATIONS`). When that driver is built, `reactivepulse`'s registry entry
 * can reuse these SAME two functions unchanged.
 *
 * ILLUMINATION IS THE ODD ONE OUT (verified against source): of all 27
 * animations, Pulse's illumination is the ONLY one whose fragment body
 * skips `${ADJUSTMENTS}` (== EXPOSURE for the illumination channel)
 * entirely, AND computes its own multiplier (`fading`) BEFORE the
 * switchColor/TRANSITION step rather than after — the exact scaffold is
 * `FRAGMENT_BEGIN → fading=pow(...) → TRANSITION → finalColor*=fading →
 * FALLOFF → FRAGMENT_END` (no ADJUSTMENTS). This module's illumination
 * builder returns `skipExposure: true` for exactly this reason — see
 * point-light-illumination.js's own header for how that flag is honoured.
 *
 * @module effects/lighting/animations/pulse
 */

/**
 * `fading = pow(abs(1 - dist²), 1.01 - ratio)`, then the switchColor result
 * (`defaultSeed`, already computed by the scaffold BEFORE this builder
 * runs) is multiplied by it — Foundry's own assembly order is "compute
 * fading, run TRANSITION, then multiply," which is behaviourally identical
 * to "run TRANSITION, then multiply by fading" since `fading` doesn't
 * depend on `defaultSeed` — order between independent terms doesn't matter
 * for a plain multiply.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uRatio - the scaffold's own (possibly pulse-jittered, see
 *   light-animation-clock.js#computePulseUniforms) ratio uniform.
 * @param {*} args.dist - the scaffold's own normalized radial distance.
 * @param {*} args.defaultSeed - the un-animated switchColor(bright,dim,dist) result.
 * @returns {{finalColor: *, uniforms: object, skipExposure: true}}
 */
export function buildPulseIlluminationSeed({ THREE, uRatio, dist, defaultSeed }) {
  const { float, abs, pow } = THREE.TSL;
  const fading = pow(abs(float(1).sub(dist.mul(dist))), float(1.01).sub(uRatio));
  const finalColor = defaultSeed.mul(fading);
  return { finalColor, uniforms: {}, skipExposure: true };
}

/**
 * `pfade(dist,pulse) = 1 - smoothstep(pulse*0.5, 1.0, dist)`;
 * `finalColor = color * pfade * colorationAlpha`.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uLightColor
 * @param {*} args.uColorationAlpha
 * @param {*} args.dist
 * @returns {{finalColor: *, uniforms: {uPulse: *}}}
 */
export function buildPulseColorationSeed({ THREE, uLightColor, uColorationAlpha, dist }) {
  const { uniform, float, smoothstep } = THREE.TSL;
  const uPulse = uniform(float(1.2));
  const pfade = float(1).sub(smoothstep(uPulse.mul(float(0.5)), float(1), dist));
  const finalColor = uLightColor.mul(pfade).mul(uColorationAlpha);
  return { finalColor, uniforms: { uPulse } };
}
