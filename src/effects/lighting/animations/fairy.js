/**
 * FAIRY — Foundry's `fairy` (Fairy Light) animation (docs/reference/
 * foundry-v14-light-animations-audit.md §4 `fairy`). CPU driver:
 * `animateTime`. Both channels; `forceDefaultColor = true`. The most
 * visually complex coloration animation in the set — textually
 * `ghost-light`'s coloration body (own distortion constants) PLUS
 * `rainbowswirl`'s rainbow block, fused. Illumination is `ghost-light`'s
 * illumination shape with its own distortion constants (not shared with
 * `ghost`'s).
 *
 * GPU-ONLY REWRITE (2026-07-20): `time`/`uIntensityRaw` are now the
 * scaffold-supplied params (no longer self-created uniforms).
 *
 * @module effects/lighting/animations/fairy
 */

import { fbmFloat, hsb2rgb } from './tsl-noise-toolkit.js';

const INV_THREE = 1 / 3;
const INV_TWO_PI = 1 / (2 * Math.PI);

function tcosWave(TSL, time) {
  const { float, cos } = TSL;
  const t = time.mul(float(0.5));
  return float(0.5)
    .mul(float(0.5).mul(cos(t).add(float(1))))
    .add(float(0.25));
}

/**
 * @param {object} args
 * @param {*} args.THREE @param {*} args.defaultSeed @param {*} args.time @param {*} args.uIntensityRaw
 * @returns {{finalColor: *}}
 */
export function buildFairyIlluminationSeed({ THREE, defaultSeed, time }) {
  const { float, vec2, mix, positionLocal } = THREE.TSL;
  // Illumination's own motionWave doesn't read intensity at all (verified
  // against source) — `uIntensityRaw` isn't needed here.

  const vUvs = positionLocal.xy.mul(float(0.5)).add(float(0.5));
  const one = vec2(1, 1);
  const distortion1 = fbmFloat(
    THREE.TSL,
    vec2(
      fbmFloat(THREE.TSL, vUvs.mul(float(3)).sub(time.mul(float(0.5)))),
      fbmFloat(
        THREE.TSL,
        vUvs
          .negate()
          .add(one)
          .mul(float(5))
          .add(time.mul(float(INV_THREE)))
      )
    )
  );
  const distortion2 = fbmFloat(
    THREE.TSL,
    vec2(
      fbmFloat(
        THREE.TSL,
        vUvs
          .negate()
          .mul(float(3))
          .sub(time.mul(float(0.5)))
      ),
      fbmFloat(
        THREE.TSL,
        vUvs
          .negate()
          .add(one)
          .mul(float(5))
          .sub(time.mul(float(INV_THREE)))
      )
    )
  );
  const motionWave = float(0.5)
    .mul(float(0.5).mul(THREE.TSL.cos(time.mul(float(0.5))).add(float(1))))
    .add(float(0.25));

  const finalColor = defaultSeed.mul(mix(distortion1, distortion2, motionWave));
  return { finalColor };
}

/**
 * @param {object} args
 * @param {*} args.THREE @param {*} args.uLightColor @param {*} args.uColorationAlpha @param {*} args.dist @param {*} args.time @param {*} args.uIntensityRaw
 * @returns {{finalColor: *}}
 */
export function buildFairyColorationSeed({ THREE, uLightColor, uColorationAlpha, dist, time, uIntensityRaw }) {
  const { float, vec2, mix, sin, atan, length, smoothstep, positionLocal } = THREE.TSL;

  const vUvs = positionLocal.xy.mul(float(0.5)).add(float(0.5));
  const one = vec2(1, 1);
  const distortion1 = fbmFloat(
    THREE.TSL,
    vec2(
      fbmFloat(THREE.TSL, vUvs.mul(float(3)).add(time.mul(float(0.5)))),
      fbmFloat(
        THREE.TSL,
        vUvs
          .negate()
          .add(one)
          .mul(float(5))
          .add(time.mul(float(INV_THREE)))
      )
    )
  );
  const distortion2 = fbmFloat(
    THREE.TSL,
    vec2(
      fbmFloat(
        THREE.TSL,
        vUvs
          .negate()
          .mul(float(3))
          .add(time.mul(float(0.5)))
      ),
      fbmFloat(
        THREE.TSL,
        vUvs
          .negate()
          .add(one)
          .mul(float(5))
          .sub(time.mul(float(INV_THREE)))
      )
    )
  );

  const t = time.mul(float(0.5));
  const tcos = tcosWave(THREE.TSL, time);
  const tsin = float(0.5)
    .mul(float(0.5).mul(sin(t).add(float(1))))
    .add(float(0.25));

  const half = vec2(0.5, 0.5);
  let uv = vUvs.sub(half);
  uv = uv.mul(tcos.mul(distortion1));
  uv = uv.mul(tsin.mul(distortion2));
  uv = uv.mul(fbmFloat(THREE.TSL, vec2(time.add(distortion1), time.add(distortion2))));
  uv = uv.add(half);

  const intens = uIntensityRaw.mul(float(0.1));
  const nuv = positionLocal.xy;
  const puvX = atan(nuv.x, nuv.y).mul(float(INV_TWO_PI)).add(float(0.5));
  const puvY = length(nuv);
  const rainbow = hsb2rgb(THREE.TSL, puvX.add(puvY).sub(time.mul(float(0.2))), float(1), float(1));
  const mixedColor = mix(uLightColor, rainbow, smoothstep(float(0), float(1.5).sub(intens), dist));

  const intensAmp = uIntensityRaw.mul(float(0.4));
  const swirl = mix(
    uv.x.add(distortion1.mul(float(4.5)).mul(intensAmp)),
    uv.y.add(distortion2.mul(float(4.5)).mul(intensAmp)),
    tcos
  );

  const finalColor = distortion1
    .mul(distortion1)
    .mul(distortion2)
    .mul(distortion2)
    .mul(mixedColor)
    .mul(uColorationAlpha)
    .mul(float(1).sub(dist.mul(dist).mul(dist)))
    .mul(swirl);
  return { finalColor };
}
