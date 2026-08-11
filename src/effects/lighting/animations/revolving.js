/**
 * REVOLVING — Foundry's `revolving` animation (docs/reference/foundry-v14-
 * light-animations-audit.md §4 `revolving`). CPU driver: `animateTime`.
 * Coloration-only; `forceDefaultColor = true`.
 *
 * THE OPEN `angle`-UNIFORM QUESTION (the audit's own flagged finding, not
 * resolved here): Foundry's own shader reads `rot(angle + time)`, but a
 * dedicated source trace found no live assignment of that `angle` uniform
 * from the light's actual placed rotation anywhere in the CPU pipeline —
 * it may simply sit at its `0` default forever. Per the audit's own
 * recommendation, this port uses `rot(time)` alone (no `angle` term) as
 * the defensible default; revisit with a live A/B if Foundry's own beam
 * turns out to track the light's placed facing after all.
 *
 * GPU-ONLY REWRITE (2026-07-20): `time`/`uIntensityRaw` are now the
 * scaffold-supplied params (no longer self-created uniforms).
 *
 * @module effects/lighting/animations/revolving
 */

import { rotate2d, pie } from './tsl-noise-toolkit.js';

/**
 * `ncoord = localPosition` (already Foundry's own `vUvs*2-1` in this
 * project's local-unit-radius space — no separate transform needed; NEVER
 * `positionLocal` directly, see candle-flicker.js's own header).
 * `angularIntensity = mix(PI, PI*0.5, intensity*0.1)` — a WIDE beam at low
 * intensity, narrowing as intensity rises.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uLightColor
 * @param {*} args.uColorationAlpha
 * @param {*} args.time
 * @param {*} args.uIntensityRaw
 * @returns {{finalColor: *}}
 */
export function buildRevolvingColorationSeed({
  THREE,
  uLightColor,
  uColorationAlpha,
  time,
  uIntensityRaw,
  localPosition,
}) {
  const { float, mix } = THREE.TSL;

  // NEVER `positionLocal` directly — see candle-flicker.js's own header.
  const ncoord = rotate2d(THREE.TSL, localPosition, time);
  const angularIntensity = mix(float(Math.PI), float(Math.PI * 0.5), uIntensityRaw.mul(float(0.1)));
  const angularCorrection = pie(THREE.TSL, ncoord, angularIntensity, float(0.15), float(1));

  const finalColor = uLightColor.mul(uColorationAlpha).mul(angularCorrection);
  return { finalColor };
}
