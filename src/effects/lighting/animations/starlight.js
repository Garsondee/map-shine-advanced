/**
 * STARLIGHT — Foundry's `starlight` (Star Light) animation (docs/
 * reference/foundry-v14-light-animations-audit.md §4 `starlight`). CPU
 * driver: `animateTime`. Coloration-only; `forceDefaultColor = true`.
 * Rotating "disco" light-ray pattern via `tan(fbm(...))`. Uses `FBM(2)`.
 *
 * `normalize(uv * (uv + t))` — componentwise multiply THEN normalize the
 * resulting vector (the audit's own flagged precedence trap: easy to
 * mis-port as `normalize(uv) * (uv+t)`, a different expression) — kept
 * exactly as parenthesized in source.
 *
 * GPU-ONLY REWRITE (2026-07-20): `time`/`uIntensityRaw` are now the
 * scaffold-supplied params (no longer self-created uniforms).
 *
 * @module effects/lighting/animations/starlight
 */

import { fbmFloat } from './tsl-noise-toolkit.js';

const FBM2 = { octaves: 2 };

/**
 * @param {object} args
 * @param {*} args.THREE @param {*} args.uLightColor @param {*} args.uColorationAlpha @param {*} args.dist @param {*} args.time @param {*} args.uIntensityRaw
 * @returns {{finalColor: *}}
 */
export function buildStarlightColorationSeed({ THREE, uLightColor, uColorationAlpha, dist, time, uIntensityRaw }) {
  const { float, vec2, cos, sin, normalize, tan, clamp, max, pow, positionLocal } = THREE.TSL;

  // transform(): a pure rotation by t=time*0.2, no pivot shift (verified
  // against source — unlike most other transforms in this set).
  const t = time.mul(float(0.2));
  const cost = cos(t);
  const sint = sin(t);
  const uv0 = positionLocal.xy; // (vUvs - 0.5) — already this project's own local space
  const uv = vec2(uv0.x.mul(cost).sub(uv0.y.mul(sint)), uv0.x.mul(sint).add(uv0.y.mul(cost)));

  const rayT = time.mul(float(0.5));
  const uvn = normalize(uv.mul(uv.add(rayT))).mul(float(5).add(uIntensityRaw));
  const rays = max(
    clamp(tan(fbmFloat(THREE.TSL, uvn.sub(rayT), FBM2)).mul(float(0.5)), float(0), float(2.25)),
    clamp(float(3).sub(tan(fbmFloat(THREE.TSL, uvn.add(rayT.mul(float(2))), FBM2))), float(0), float(2.25))
  );

  const starlightVal = pow(float(1).sub(dist), rays).mul(pow(float(1).sub(dist), float(0.25)));
  const finalColor = clamp(uLightColor.mul(starlightVal).mul(uColorationAlpha), float(0), float(1));
  return { finalColor };
}
