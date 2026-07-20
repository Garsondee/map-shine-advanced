/**
 * FLAME — Foundry's `flame` animation (docs/reference/foundry-v14-light-
 * animations-audit.md §4 `flame`). CPU driver: `animateFlickering` called
 * DIRECTLY (not via `animateTorch`) — its own `flickerAmplification` in
 * registry.js is a FIXED `1`, unlike torch/siren's `intensity/5`; verified
 * against source, not a guess (see light-animation-clock.js#
 * computeFlickerUniforms's own header for the full torch-vs-flame
 * divergence). The richer, harder-to-port sibling of `torch`: same CPU
 * driver family, but illumination ALSO gets a shader-side multiply (torch's
 * illumination needs none at all), and coloration is genuine FBM-driven
 * flame "tongues", not a flat tint.
 *
 * NOISE SUBSTITUTION (documented, not silent — tsl-noise-toolkit.js's own
 * header): Foundry's `fbm(vec2, seed)` is its own bespoke value-noise FBM
 * (`PRNG`+`NOISE`, base-shader-mixin.mjs). This port uses
 * `THREE.TSL.mx_fractal_noise_float` (this project's `fbmFloat` wrapper)
 * instead — a different noise algorithm, same FBM *character* (layered,
 * time-scrolled turbulence), which is what actually reads as "flame" to an
 * eye; Foundry's own two fbm() calls are already decorrelated purely by
 * using different time-scroll rates (8.01/10.72 vs 7.04/9.51), a property
 * this substitution preserves exactly since it uses the SAME two offset
 * sample positions.
 *
 * @module effects/lighting/animations/flame
 */

import { fbmFloat } from './tsl-noise-toolkit.js';

/**
 * `finalColor = defaultSeed * brightnessPulse` — the ONLY animated line in
 * Flame's illumination body (`${this.TRANSITION}; finalColor *=
 * brightnessPulse; ${this.ADJUSTMENTS}; ...` — unlike Pulse, Flame's
 * illumination DOES run ADJUSTMENTS/EXPOSURE normally, no `skipExposure`).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.defaultSeed - the un-animated switchColor(bright,dim,dist) result.
 * @returns {{finalColor: *, uniforms: {uBrightnessPulse: *}}}
 */
export function buildFlameIlluminationSeed({ THREE, defaultSeed }) {
  const { uniform, float } = THREE.TSL;
  const uBrightnessPulse = uniform(float(1));
  const finalColor = defaultSeed.mul(uBrightnessPulse);
  return { finalColor, uniforms: { uBrightnessPulse } };
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
 * `color*8.0` deliberately blows past [0,1] (Foundry's own hot-core choice,
 * audit's own note) — kept as-is; MSA's HDR-capable pipeline can let this
 * feed bloom directly rather than hard-clipping (a Type-B opportunity, not
 * built here — Tier-0 scope is a faithful Type-A port).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uLightColor
 * @param {*} args.uColorationAlpha
 * @param {*} args.dist
 * @returns {{finalColor: *, uniforms: {uBrightnessPulse: *, uRatio: *, uTime: *, uIntensityRaw: *}}}
 */
export function buildFlameColorationSeed({ THREE, uLightColor, uColorationAlpha, dist }) {
  const { uniform, float, vec2, mix, clamp, smoothstep, max, pow, positionLocal } = THREE.TSL;

  const uBrightnessPulse = uniform(float(1));
  const uRatio = uniform(float(0.5));
  const uTime = uniform(float(0));
  const uIntensityRaw = uniform(float(5));

  // Foundry's vUvs (this project's own point-light-illumination.js already
  // establishes this equivalence): positionLocal.xy (unit-radius, centered
  // at the origin) mapped to Foundry's [0,1]-space centered at 0.5 — verified
  // distance(vUvs,0.5)*2 collapses to exactly length(positionLocal.xy), i.e.
  // this project's own `dist` passed in above.
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

  const noiseInner = fbmFloat(THREE.TSL, vec2(uv.x.add(uTime.mul(float(8.01))), uv.y.add(uTime.mul(float(10.72)))));
  const noiseOuter = fbmFloat(THREE.TSL, vec2(uv.x.add(uTime.mul(float(7.04))), uv.y.add(uTime.mul(float(9.51)))));

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
    .mul(uBrightnessPulse)
    .mul(uColorationAlpha);

  return { finalColor, uniforms: { uBrightnessPulse, uRatio, uTime, uIntensityRaw } };
}
