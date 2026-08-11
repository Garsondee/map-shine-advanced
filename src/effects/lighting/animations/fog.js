/**
 * FOG — Foundry's `fog` animation (docs/reference/foundry-v14-light-
 * animations-audit.md §4 `fog`). CPU driver: `animateTime`. Coloration-
 * only; `forceDefaultColor = true`. Drifting FBM-warped colour-palette fog
 * — the first of several "domain-warp palette" animations in this set
 * (compare `dome`, `vortex` — same structural idea, different constants).
 *
 * NOISE SUBSTITUTION: uses `fbmFloat` in place of Foundry's own bespoke
 * FBM — see flame.js's own header for the reasoning.
 *
 * GPU-ONLY REWRITE (2026-07-20): `time`/`uIntensityRaw` are now the
 * scaffold-supplied params (no longer self-created uniforms).
 *
 * @module effects/lighting/animations/fog
 */

import { fbmFloat } from './tsl-noise-toolkit.js';

/**
 * @param {object} args
 * @param {*} args.THREE @param {*} args.uLightColor @param {*} args.uColorationAlpha @param {*} args.time @param {*} args.uIntensityRaw
 * @returns {{finalColor: *}}
 */
export function buildFogColorationSeed({ THREE, uLightColor, uColorationAlpha, time, uIntensityRaw, localPosition }) {
  const { float, vec2, vec3, mix, clamp } = THREE.TSL;

  const c1 = uLightColor.mul(float(0.6));
  const c2 = uLightColor.mul(float(0.95));
  const c3 = uLightColor.mul(float(0.5));
  const c4 = uLightColor.mul(float(0.75));
  const c5 = vec3(0.3, 0.3, 0.3);
  const c6 = uLightColor;

  // NEVER `positionLocal` directly — see candle-flicker.js's own header.
  const vUvs = localPosition.mul(float(0.5)).add(float(0.5));
  const p = vUvs.mul(float(8));

  const q = fbmFloat(THREE.TSL, p.sub(time.mul(float(0.1))));
  const r = vec2(
    fbmFloat(
      THREE.TSL,
      p
        .add(q)
        .sub(time.mul(float(0.5)))
        .sub(p.x)
        .sub(p.y)
    ),
    fbmFloat(THREE.TSL, p.add(q).sub(time.mul(float(0.3))))
  );
  const c = clamp(
    mix(c1, c2, fbmFloat(THREE.TSL, p.add(r)))
      .add(mix(c3, c4, r.x))
      .sub(mix(c5, c6, r.y)),
    vec3(0, 0, 0),
    vec3(1, 1, 1)
  );

  const intens = uIntensityRaw.mul(float(0.2));
  const finalColor = c.mul(intens).mul(uColorationAlpha);
  return { finalColor };
}
