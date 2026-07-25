/**
 * GRID — Foundry's `grid` (Force Grid) animation (docs/reference/foundry-
 * v14-light-animations-audit.md §4 `grid`). CPU driver: `animateTime`.
 * Coloration-only; `forceDefaultColor = true`. A "futuristic" repeating
 * grid-line pattern via a hand-rolled 5-iteration fractal-subdivision
 * fold — no fbm/noise. THE ONE ANIMATION IN THIS SET NEEDING A REAL TSL
 * `Loop` with loop-carried, data-dependent mutation (swaps x/y and
 * conditionally rescales x every iteration) — follows this project's own
 * established precedent for exactly this shape of problem
 * (`point-light-illumination.js#makeSdPolygonEdgeDistance`:
 * `Loop`/`.toVar()`/`.assign()`, plus `select()` here for the conditional).
 *
 * A dead local in Foundry's own source (confirmed by re-reading, not
 * guessed) is NOT ported: `forcegrid()`'s own `cid = cid2.y+cid2.x` is
 * computed but never read afterward.
 *
 * GPU-ONLY REWRITE (2026-07-20): `time`/`uIntensityRaw` are now the
 * scaffold-supplied params (no longer self-created uniforms).
 *
 * @module effects/lighting/animations/grid
 */

import { hspherize } from './tsl-noise-toolkit.js';

const MAX_INTENSITY = 1.2;
const MIN_INTENSITY = 0.8;

function wave(TSL, dist, time, uIntensityRaw) {
  const { float, sin, pow } = TSL;
  const sinWave = float(0.5).mul(
    sin(time.mul(float(6)).add(pow(float(1).sub(dist), float(0.1)).mul(float(35)).mul(uIntensityRaw))).add(float(1))
  );
  return float(MAX_INTENSITY - MIN_INTENSITY)
    .mul(sinWave)
    .add(float(MIN_INTENSITY));
}

function fpert(TSL, d, p, time, uIntensityRaw) {
  const { float, mod, max } = TSL;
  return max(float(0.3).sub(mod(p.add(time).add(d.mul(float(0.3))), float(3.5))), float(0))
    .mul(uIntensityRaw)
    .mul(float(2));
}

function pert(TSL, suv, dScaled, d, w, time, uIntensityRaw) {
  const { float, vec2, min, max } = TSL;
  const uv = suv.sub(vec2(0.5, 0.5));
  const f0 = fpert(TSL, dScaled, min(uv.y, uv.x), time, uIntensityRaw);
  const f1 = fpert(TSL, dScaled, min(uv.y.negate(), uv.x), time, uIntensityRaw);
  const f2 = fpert(TSL, dScaled, min(uv.y.negate(), uv.x.negate()), time, uIntensityRaw);
  const f3 = fpert(TSL, dScaled, min(uv.y, uv.x.negate()), time, uIntensityRaw);
  const f = f0.add(f1).add(f2).add(f3);
  const fSquared = f.mul(f);
  return max(fSquared, float(3).sub(fSquared)).mul(w);
}

/** The 5-iteration fold — the one real TSL `Loop` this animation needs. */
function forcegrid(TSL, suv, dist, time, uIntensityRaw, uLightColor) {
  const { float, vec2, fract, abs, clamp, pow, max, select, Fn, Loop } = TSL;
  return Fn(() => {
    const uv0 = fract(suv.sub(vec2(0.2075, 0.2075)));
    const uvX = uv0.x.toVar();
    const uvY = uv0.y.toVar();
    const r = float(0.3);
    const dVar = float(1).toVar();
    const oneMinusDist = float(1).sub(dist);

    Loop(5, () => {
      const e = uvX.sub(r);
      const c = clamp(float(1).sub(abs(e.mul(float(0.75)))), float(0), float(1));
      dVar.assign(dVar.add(pow(c, float(200)).mul(oneMinusDist)));
      const rescaledX = uvX.sub(r).div(float(2).sub(r));
      const xAfterRescale = select(e.greaterThan(float(0)), rescaledX, uvX);
      // uv = uv.yx — swap, in program order (uvX reads uvY's CURRENT value
      // before uvY is itself overwritten on the next line).
      uvX.assign(uvY);
      uvY.assign(xAfterRescale);
    });

    const w = wave(TSL, dist, time, uIntensityRaw);
    const col0 = max(dVar.sub(float(1)), float(0)).mul(float(1.8));
    const col1 = col0.mul(pert(TSL, suv, dist.mul(uIntensityRaw).mul(float(4)), dVar, w, time, uIntensityRaw));
    const col2 = col1.add(uLightColor.mul(float(0.3)).mul(w));
    return col2.mul(uLightColor);
  })();
}

/**
 * @param {object} args
 * @param {*} args.THREE @param {*} args.uLightColor @param {*} args.uColorationAlpha @param {*} args.dist @param {*} args.time @param {*} args.uIntensityRaw
 * @returns {{finalColor: *}}
 */
export function buildGridColorationSeed({ THREE, uLightColor, uColorationAlpha, dist, time, uIntensityRaw }) {
  const { float, vec2, positionLocal } = THREE.TSL;

  const half = vec2(0.5, 0.5);
  const vUvs = positionLocal.xy.mul(float(0.5)).add(half);
  const uvs = vUvs
    .sub(half)
    .mul(uIntensityRaw.mul(float(0.2)))
    .add(half);
  const f = hspherize(THREE.TSL, dist);
  const suvs = uvs
    .sub(half)
    .mul(f.mul(float(5)))
    .add(half);

  const finalColor = forcegrid(THREE.TSL, suvs, dist, time, uIntensityRaw, uLightColor).mul(uColorationAlpha);
  return { finalColor };
}
