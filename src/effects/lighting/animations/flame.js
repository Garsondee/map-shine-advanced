/**
 * FLAME — Foundry's `flame` animation (docs/reference/foundry-v14-light-
 * animations-audit.md §4 `flame`). CPU driver: `animateFlickering` called
 * DIRECTLY (not via `animateTorch`) — its own `flickerAmplification` in
 * registry.js is a FIXED `1`, unlike torch/siren's `intensity/5`; verified
 * against source, not a guess. The richer, harder-to-port sibling of
 * `torch`: illumination gets a shader-side multiply (no ratio-band rebuild
 * needed — unlike torch, Flame's flicker never touches `ratio`), and
 * coloration is genuine FBM-driven flame "tongues", not a flat tint.
 *
 * NOISE SUBSTITUTION (documented, not silent — tsl-noise-toolkit.js's own
 * header): Foundry's `fbm(vec2, seed)` is its own bespoke value-noise FBM
 * (`PRNG`+`NOISE`, base-shader-mixin.mjs). This port uses
 * `THREE.TSL.mx_fractal_noise_float` (this project's `fbmFloat` wrapper)
 * instead — a different noise algorithm, same FBM *character*.
 *
 * GPU-ONLY REWRITE (2026-07-20): `time`/`uIntensityRaw`/`uRatio` are now
 * the scaffold-supplied params (no longer self-created uniforms) — see
 * point-light-illumination.js / point-light-coloration.js's own headers.
 *
 * @module effects/lighting/animations/flame
 */

import { fbmFloat } from './tsl-noise-toolkit.js';
import { buildFlickerNode } from './light-animation-clock.js';

/**
 * `finalColor = defaultSeed * brightnessPulse` — the ONLY animated line in
 * Flame's illumination body (unlike Pulse, Flame's illumination DOES run
 * ADJUSTMENTS/EXPOSURE normally, no `skipExposure`).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.defaultSeed - the un-animated switchColor(bright,dim,dist) result.
 * @param {*} args.time
 * @returns {{finalColor: *}}
 */
export function buildFlameIlluminationSeed({ THREE, defaultSeed, time }) {
  const { float } = THREE.TSL;
  const { brightnessPulse } = buildFlickerNode(THREE.TSL, { time, amplification: float(1) });
  const finalColor = defaultSeed.mul(brightnessPulse);
  return { finalColor };
}

/**
 * The FBM flame-tongue coloration, translated term-for-term from
 * `effects/flame.mjs:34-93` (audit §4 `flame`):
 * ```
 * uv = scale(vUvs, 10*ratio)                    // (uv-0.5)*s+0.5, a zoom about center
 * intens = pow(0.1*intensity, 2)
 * fratioInner = ratio*(intens*0.5) - 0.005*fbm(uv + time*(8.01,10.72))
 * fratioOuter = ratio - 0.007*fbm(uv + time*(7.04,9.51))
 * fdist = max(dist - fratioInner*intens, 0)
 * flameDist      = smoothstep(clamp(0.97-fratioInner,0,1), clamp(1.03-fratioInner,0,1), 1-fdist)
 * flameDistInner = smoothstep(clamp(0.95-fratioOuter,0,1), clamp(1.05-fratioOuter,0,1), 1-fdist)
 * finalColor = mix(mix(color, color*1.2, flameDistInner), color*8, flameDist) * brightnessPulse * colorationAlpha
 * ```
 * `color*8.0` deliberately blows past [0,1] (Foundry's own hot-core choice)
 * — kept as-is; MSA's HDR-capable pipeline can let this feed bloom directly
 * rather than hard-clipping (a Type-B opportunity, not built here).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uLightColor
 * @param {*} args.uColorationAlpha
 * @param {*} args.dist
 * @param {*} args.time
 * @param {*} args.uIntensityRaw
 * @param {*} args.uRatio - the light's own base ratio uniform.
 * @returns {{finalColor: *}}
 */
export function buildFlameColorationSeed({ THREE, uLightColor, uColorationAlpha, dist, time, uIntensityRaw, uRatio }) {
  const { float, vec2, mix, clamp, smoothstep, max, pow, positionLocal } = THREE.TSL;

  const { brightnessPulse } = buildFlickerNode(THREE.TSL, { time, amplification: float(1) });

  // Foundry's vUvs (this project's own point-light-illumination.js already
  // establishes this equivalence): positionLocal.xy (unit-radius, centered
  // at the origin) mapped to Foundry's [0,1]-space centered at 0.5.
  const vUvs = positionLocal.xy.mul(float(0.5)).add(float(0.5));

  // scale(uv, s) = (uv - 0.5) * s + 0.5 — flame.mjs's own mat2-pivot helper,
  // a uniform zoom about the light's own center.
  const half = vec2(0.5, 0.5);
  const uv = vUvs
    .sub(half)
    .mul(uRatio.mul(float(10)))
    .add(half);

  const intensityScaled = uIntensityRaw.mul(float(0.1));
  const intens = pow(intensityScaled, float(2));

  const noiseInner = fbmFloat(THREE.TSL, vec2(uv.x.add(time.mul(float(8.01))), uv.y.add(time.mul(float(10.72)))));
  const noiseOuter = fbmFloat(THREE.TSL, vec2(uv.x.add(time.mul(float(7.04))), uv.y.add(time.mul(float(9.51)))));

  const fratioInner = uRatio.mul(intens.mul(float(0.5))).sub(noiseInner.mul(float(0.005)));
  const fratioOuter = uRatio.sub(noiseOuter.mul(float(0.007)));

  const fdist = max(dist.sub(fratioInner.mul(intens)), float(0));

  const flameDist = smoothstep(
    clamp(float(0.97).sub(fratioInner), float(0), float(1)),
    clamp(float(1.03).sub(fratioInner), float(0), float(1)),
    float(1).sub(fdist)
  );
  const flameDistInner = smoothstep(
    clamp(float(0.95).sub(fratioOuter), float(0), float(1)),
    clamp(float(1.05).sub(fratioOuter), float(0), float(1)),
    float(1).sub(fdist)
  );

  const flameColor = uLightColor.mul(float(8));
  const flameFlickerColor = uLightColor.mul(float(1.2));

  const finalColor = mix(mix(uLightColor, flameFlickerColor, flameDistInner), flameColor, flameDist)
    .mul(brightnessPulse)
    .mul(uColorationAlpha);

  return { finalColor };
}
