/**
 * RAINBOWSWIRL — Foundry's `rainbowswirl` (Swirling Rainbow) animation
 * (docs/reference/foundry-v14-light-animations-audit.md §4 `rainbowswirl`).
 * CPU driver: `animateTime`. Coloration-only; `forceDefaultColor = true`.
 * A polar-coordinate rainbow (angle+radius -> hue).
 *
 * **Skips the `colorationAlpha` multiply** — verified against source, one
 * of only two animations (with `radialrainbow`) that do. NOT "fixed" into
 * consistency with the other 21 coloration animations; Foundry itself
 * omits it here, so the LightData `alpha` slider has zero effect on this
 * animation's brightness, matched exactly.
 *
 * GPU-ONLY REWRITE (2026-07-20): `time`/`uIntensityRaw` are now the
 * scaffold-supplied params (no longer self-created uniforms).
 *
 * @module effects/lighting/animations/rainbowswirl
 */

import { hsb2rgb } from './tsl-noise-toolkit.js';

const INV_TWO_PI = 1 / (2 * Math.PI);

/**
 * `puv = (atan(x,y)*INVTWOPI+0.5, length(nuv))`; hue driven by
 * `puv.x + puv.y` (angle AND radius — the "swirl"). No `colorationAlpha`.
 *
 * @param {object} args
 * @param {*} args.THREE @param {*} args.uLightColor @param {*} args.dist @param {*} args.time @param {*} args.uIntensityRaw
 * @returns {{finalColor: *}}
 */
export function buildRainbowswirlColorationSeed({ THREE, uLightColor, dist, time, uIntensityRaw }) {
  const { float, atan, length, mix, smoothstep, positionLocal } = THREE.TSL;

  const nuv = positionLocal.xy;
  const angle = atan(nuv.x, nuv.y).mul(float(INV_TWO_PI)).add(float(0.5));
  const radius = length(nuv);
  const rainbow = hsb2rgb(THREE.TSL, angle.add(radius).sub(time.mul(float(0.2))), float(1), float(1));

  const intens = uIntensityRaw.mul(float(0.1));
  const mixed = mix(uLightColor, rainbow, smoothstep(float(0), float(1.5).sub(intens), dist));
  const finalColor = mixed.mul(float(1).sub(dist.mul(dist).mul(dist)));
  return { finalColor };
}
