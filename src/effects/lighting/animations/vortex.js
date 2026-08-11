/**
 * VORTEX — Foundry's `vortex` animation (docs/reference/foundry-v14-light-
 * animations-audit.md §4 `vortex`). CPU driver: `animateTime`. A domain-
 * warp-palette swirl (like `fog`/`dome`) with a genuine pixel-space
 * vortex-twist pre-warp. `forceDefaultColor = true`.
 *
 * **ILLUMINATION IS CONFIRMED DEAD CODE IN FOUNDRY ITSELF** (the audit's
 * own most significant finding, verified against source): `Vortex
 * IlluminationShader.main()` is byte-for-byte the unmodified default
 * scaffold. Per the audit's explicit recommendation, this port implements
 * NOTHING for illumination — no `buildIlluminationSeed` export exists here,
 * matching `torch`'s OLD (pre-GPU-rewrite) `null` pattern — registry.js
 * leaves it `null`, because that's what real, unanimated Foundry parity
 * actually looks like for this one.
 *
 * NOISE SUBSTITUTION: uses `fbmFloat` (this project's `mx_fractal_noise_
 * float` wrapper) in place of Foundry's own bespoke value-noise FBM.
 *
 * Two DEAD LOCAL ASSIGNMENTS in Foundry's own coloration source, NOT
 * ported here (confirmed by re-reading, not guessed): `vortex()`'s own
 * `uv *= rotmat` line computes a value never read afterward; `spice()`'s
 * trailing `uv += PIVOT` is likewise unused after that point.
 *
 * GPU-ONLY REWRITE (2026-07-20): `time`/`uIntensityRaw` are now the
 * scaffold-supplied params (no longer self-created uniforms).
 *
 * @module effects/lighting/animations/vortex
 */

import { fbmFloat, rotate2d } from './tsl-noise-toolkit.js';

/**
 * The vortex-twist pre-warp: inside `dist < 1`, rotate `uv-0.5` by an
 * angle that grows quadratically as `dist` approaches 0 (a swirl tightest
 * at the light's own center); outside, no twist at all.
 */
function vortexTwist(TSL, uv, dist, uIntensityRaw) {
  const { float, sin, cos, dot, vec2, select, lessThan } = TSL;
  const half = vec2(0.5, 0.5);
  const uvs = uv.sub(half);
  const intens = uIntensityRaw.mul(float(0.2));
  const sigma = float(1).sub(dist); // (radius - dist) / radius, radius === 1
  const theta = sigma
    .mul(sigma)
    .mul(float(Math.PI * 2))
    .mul(intens);
  const st = sin(theta);
  const ct = cos(theta);
  const twisted = vec2(dot(uvs, vec2(ct, st.negate())), dot(uvs, vec2(st, ct)));
  const result = select(lessThan(dist, float(1)), twisted, uvs);
  return result.add(half);
}

/**
 * The domain-warp-palette swirl — Foundry's own `spice()`, using this
 * project's fbmFloat. `rotAngle` (`t = time*0.5`) drives ONLY the rotation
 * matrix; `q`/`r`'s own time terms use the raw `time`, exactly as
 * Foundry's source keeps them separate.
 */
function spice(TSL, iuv, rotAngle, time, c1, c2, c3, c4, c5, c6) {
  const { float, mix, vec2 } = TSL;
  const half = vec2(0.5, 0.5);
  // spiceRotMat = 2*rotate(t) — see this module's own header.
  const rotated = rotate2d(TSL, iuv.sub(half), rotAngle).mul(float(2));
  const p = rotated.mul(float(6));

  const q = fbmFloat(TSL, p.add(time));
  const r = vec2(
    fbmFloat(
      TSL,
      p
        .add(q)
        .add(time.mul(float(0.9)))
        .sub(p.x)
        .sub(p.y)
    ),
    fbmFloat(TSL, p.add(q).add(time.mul(float(0.6))))
  );
  return mix(c1, c2, fbmFloat(TSL, p.add(r)))
    .add(mix(c3, c4, r.x))
    .sub(mix(c5, c6, r.y));
}

/**
 * @param {object} args
 * @param {*} args.THREE @param {*} args.uLightColor @param {*} args.uColorationAlpha @param {*} args.dist @param {*} args.time @param {*} args.uIntensityRaw
 * @returns {{finalColor: *}}
 */
export function buildVortexColorationSeed({
  THREE,
  uLightColor,
  uColorationAlpha,
  dist,
  time,
  uIntensityRaw,
  localPosition,
}) {
  const { float } = THREE.TSL;

  // t*0.5 drives both rotations — vortex's own twist uses `intensity` (not
  // time) for its angle, per vortexTwist's own formula; the swirl's OWN
  // rotation below uses `t = time*0.5` as Foundry's source does.
  const t = time.mul(float(0.5));
  // NEVER `positionLocal` directly — see candle-flicker.js's own header.
  const vuv = vortexTwist(THREE.TSL, localPosition.mul(float(0.5)).add(float(0.5)), dist, uIntensityRaw);

  const c1 = uLightColor.mul(float(0.55));
  const c2 = uLightColor.mul(float(0.95));
  const c3 = uLightColor.mul(float(0.45));
  const c4 = uLightColor.mul(float(0.75));
  const c5 = THREE.TSL.vec3(0.2, 0.2, 0.2);
  const c6 = uLightColor.mul(float(1.2));

  const finalColor = spice(THREE.TSL, vuv, t, time, c1, c2, c3, c4, c5, c6).mul(uColorationAlpha);
  return { finalColor };
}
