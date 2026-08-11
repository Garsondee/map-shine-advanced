/**
 * GHOST — Foundry's `ghost` (Ghost Light) animation (docs/reference/
 * foundry-v14-light-animations-audit.md §4 `ghost`). CPU driver:
 * `animateTime`. Both channels. A wandering, fbm-distorted glow — no fixed
 * shape (unlike the angular/hex/dome animations, this one just warps a
 * soft blob). One of the more call-count-heavy animations (7 fbm calls per
 * pixel for coloration, 6 for illumination) — uses `fbmFloat` throughout.
 *
 * GPU-ONLY REWRITE (2026-07-20): `time`/`uIntensityRaw` are now the
 * scaffold-supplied params (no longer self-created uniforms).
 *
 * @module effects/lighting/animations/ghost
 */

import { fbmFloat } from './tsl-noise-toolkit.js';

const INV_THREE = 1 / 3;

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
export function buildGhostIlluminationSeed({ THREE, defaultSeed, time, uIntensityRaw, localPosition }) {
  const { float, vec2, mix } = THREE.TSL;

  // NEVER `positionLocal` directly — see candle-flicker.js's own header.
  const vUvs = localPosition.mul(float(0.5)).add(float(0.5));
  const distortion1 = fbmFloat(
    THREE.TSL,
    vec2(
      fbmFloat(THREE.TSL, vUvs.mul(float(5)).sub(time.mul(float(0.5)))),
      fbmFloat(
        THREE.TSL,
        vUvs
          .negate()
          .sub(vec2(0.01, 0.01))
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
          .mul(float(5))
          .sub(time.mul(float(0.5)))
      ),
      fbmFloat(
        THREE.TSL,
        vUvs
          .negate()
          .add(vec2(0.01, 0.01))
          .mul(float(5))
          .add(time.mul(float(INV_THREE)))
      )
    )
  );

  const tcos = tcosWave(THREE.TSL, time);
  const intensAmp = uIntensityRaw.mul(float(0.2));
  const finalColor = defaultSeed.mul(
    mix(distortion1.mul(float(1.5)).mul(intensAmp), distortion2.mul(float(1.5)).mul(intensAmp), tcos)
  );
  return { finalColor };
}

/**
 * @param {object} args
 * @param {*} args.THREE @param {*} args.uLightColor @param {*} args.uColorationAlpha @param {*} args.dist @param {*} args.time @param {*} args.uIntensityRaw
 * @returns {{finalColor: *}}
 */
export function buildGhostColorationSeed({
  THREE,
  uLightColor,
  uColorationAlpha,
  dist,
  time,
  uIntensityRaw,
  localPosition,
}) {
  const { float, vec2, mix, pow, sin } = THREE.TSL;

  // NEVER `positionLocal` directly — see candle-flicker.js's own header.
  const vUvs = localPosition.mul(float(0.5)).add(float(0.5));
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

  const intensAmp = uIntensityRaw.mul(float(0.2));
  const swirl = mix(
    uv.x.add(distortion1.mul(float(4.5)).mul(intensAmp)),
    uv.y.add(distortion2.mul(float(4.5)).mul(intensAmp)),
    tcos
  );

  const finalColor = distortion1
    .mul(distortion1)
    .mul(distortion2)
    .mul(distortion2)
    .mul(uLightColor)
    .mul(pow(float(1).sub(dist), dist))
    .mul(uColorationAlpha)
    .mul(swirl);
  return { finalColor };
}
