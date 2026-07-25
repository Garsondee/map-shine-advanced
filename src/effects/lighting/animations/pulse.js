/**
 * PULSE — Foundry's `pulse` animation (docs/reference/foundry-v14-light-
 * animations-audit.md §4 `pulse`). CPU driver: `animatePulse`
 * (`light-animation-clock.js#buildPulseNode`, a pure cosine wave, computed
 * entirely in-shader — see this module's own GPU-ONLY note below).
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
 * switchColor/TRANSITION step rather than after. This module's illumination
 * builder returns `skipExposure: true` for exactly this reason — see
 * point-light-illumination.js's own header for how that flag is honoured.
 *
 * GPU-ONLY REWRITE (2026-07-20): under the old CPU-driven design, the pulse-
 * jittered `ratio` was written straight into the shared `uRatio` uniform, so
 * the scaffold's own default switchColor seed was already correct. Now
 * `uRatio` only ever holds the BASE ratio — illumination rebuilds the band
 * itself via `computeSwitchColorBand` with the in-shader-jittered ratio
 * (`buildPulseNode`'s own `ratio` field), and the `fading` term uses that
 * SAME jittered ratio, exactly matching the old CPU-jittered-uRatio behavior.
 *
 * @module effects/lighting/animations/pulse
 */

import { buildPulseNode } from './light-animation-clock.js';

/**
 * `fading = pow(abs(1 - dist²), 1.01 - ratio)`, `ratio` = this light's
 * pulse-jittered ratio (`buildPulseNode`'s own `ratio` field) — then the
 * switchColor band, rebuilt with that SAME jittered ratio, is multiplied by
 * it.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uRatio - the scaffold's own BASE ratio uniform.
 * @param {*} args.uIntensityRaw
 * @param {*} args.time
 * @param {*} args.dist - the scaffold's own normalized radial distance.
 * @param {*} args.computeSwitchColorBand - the scaffold's own band-rebuild closure.
 * @returns {{finalColor: *, skipExposure: true}}
 */
export function buildPulseIlluminationSeed({ THREE, uRatio, uIntensityRaw, time, dist, computeSwitchColorBand }) {
  const { float, abs, pow } = THREE.TSL;
  const { ratio: jitteredRatio } = buildPulseNode(THREE.TSL, { time, uIntensityRaw, baseRatio: uRatio });
  const seed = computeSwitchColorBand(jitteredRatio);
  const fading = pow(abs(float(1).sub(dist.mul(dist))), float(1.01).sub(jitteredRatio));
  const finalColor = seed.mul(fading);
  return { finalColor, skipExposure: true };
}

/**
 * `pfade(dist,pulse) = 1 - smoothstep(pulse*0.5, 1.0, dist)`;
 * `finalColor = color * pfade * colorationAlpha`. `pulse` (`buildPulseNode`'s
 * own `pulse` field) doesn't depend on ratio at all — `baseRatio` is passed
 * as a harmless placeholder (buildPulseNode always computes both fields; only
 * `pulse` is read here).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uLightColor
 * @param {*} args.uColorationAlpha
 * @param {*} args.uIntensityRaw
 * @param {*} args.time
 * @param {*} args.dist
 * @returns {{finalColor: *}}
 */
export function buildPulseColorationSeed({ THREE, uLightColor, uColorationAlpha, uIntensityRaw, time, dist }) {
  const { float, smoothstep } = THREE.TSL;
  const { pulse } = buildPulseNode(THREE.TSL, { time, uIntensityRaw, baseRatio: float(0) });
  const pfade = float(1).sub(smoothstep(pulse.mul(float(0.5)), float(1), dist));
  const finalColor = uLightColor.mul(pfade).mul(uColorationAlpha);
  return { finalColor };
}
