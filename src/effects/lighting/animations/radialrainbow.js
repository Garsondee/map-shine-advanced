/**
 * RADIALRAINBOW — Foundry's `radialrainbow` (Radial Rainbow) animation
 * (docs/reference/foundry-v14-light-animations-audit.md §4 `radialrainbow`).
 * CPU driver: `animateTime`. Coloration-only; `forceDefaultColor = true`.
 * Same polar-rainbow idea as `rainbowswirl`, hue driven by RADIUS ONLY (no
 * angle term) — a plain concentric rainbow-ring pattern. Shares
 * `rainbowswirl`'s `colorationAlpha`-omission (see that module's header).
 *
 * Foundry's own source computes the angle term (`puv.x`) but never reads
 * it in the final `hsb2rgb()` call — confirmed dead by source inspection,
 * dropped here rather than ported as wasted work.
 *
 * GPU-ONLY REWRITE (2026-07-20): `time`/`uIntensityRaw` are now the
 * scaffold-supplied params (no longer self-created uniforms).
 *
 * @module effects/lighting/animations/radialrainbow
 */

import { hsb2rgb } from './tsl-noise-toolkit.js';

/**
 * @param {object} args
 * @param {*} args.THREE @param {*} args.uLightColor @param {*} args.dist @param {*} args.time @param {*} args.uIntensityRaw
 * @returns {{finalColor: *}}
 */
export function buildRadialrainbowColorationSeed({ THREE, uLightColor, dist, time, uIntensityRaw }) {
  const { float, length, mix, smoothstep, positionLocal } = THREE.TSL;

  const radius = length(positionLocal.xy);
  const rainbow = hsb2rgb(THREE.TSL, radius.sub(time.mul(float(0.2))), float(1), float(1));

  const intens = uIntensityRaw.mul(float(0.1));
  const mixed = mix(uLightColor, rainbow, smoothstep(float(0), float(1.5).sub(intens), dist));
  const finalColor = mixed.mul(float(1).sub(dist.mul(dist).mul(dist)));
  return { finalColor };
}
