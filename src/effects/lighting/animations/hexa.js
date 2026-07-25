/**
 * HEXA — Foundry's `hexa` (Hexa Dome) animation (docs/reference/foundry-
 * v14-light-animations-audit.md §4 `hexa`). CPU driver: `animateTime`.
 * Coloration-only; `forceDefaultColor = true`. A hex-grid tiling pattern
 * (classic hex-distance-field algorithm), hemispherized/rotated like
 * `dome`. Purely analytic — no fbm/noise/prng.
 *
 * GPU-ONLY REWRITE (2026-07-20): `time`/`uIntensityRaw` are now the
 * scaffold-supplied params (no longer self-created uniforms).
 *
 * @module effects/lighting/animations/hexa
 */

import { hspherize } from './tsl-noise-toolkit.js';

/** `transform()` — hemispherize + rotate(-time*0.2) + scale(10/(11-intensity)) about the 0.5 pivot. */
function transform(TSL, uv, dist, time, uIntensityRaw) {
  const { float, cos, sin, vec2 } = TSL;
  const f = hspherize(TSL, dist);
  const t = time.mul(float(-0.2));
  const scale = float(10).div(float(11).sub(uIntensityRaw));
  const cost = cos(t);
  const sint = sin(t);
  const half = vec2(0.5, 0.5);
  const centered = uv.sub(half);
  // rotmat * scalemat * f, applied to `centered` — Foundry's own column-
  // major mat2 composition collapses (for this diagonal scalemat) to a
  // plain rotate-then-uniform-scale, done directly rather than building
  // an actual mat2 node (no TSL mat2-multiply primitive needed for this).
  const rotated = vec2(centered.x.mul(cost).sub(centered.y.mul(sint)), centered.x.mul(sint).add(centered.y.mul(cost)));
  return rotated.mul(scale).mul(f).add(half);
}

/** `hexDist(p) = max(dot(abs(p), normalize(1,1.73)), abs(p).x)`. */
function hexDist(TSL, p) {
  const { abs, dot, normalize, vec2, max } = TSL;
  const ap = abs(p);
  const c = dot(ap, normalize(vec2(1, 1.73)));
  return max(c, ap.x);
}

/** `hexUvs(uv).y` only (the only component `hexa()` actually reads) — `0.55 - hexDist(gv)`, `gv` the nearer of two hex-lattice offsets. */
function hexUvsY(TSL, uv) {
  const { vec2, mod, dot, select } = TSL;
  const r = vec2(1, 1.73);
  const h = r.mul(0.5);
  const a = mod(uv, r).sub(h);
  const b = mod(uv.sub(h), r).sub(h);
  const gv = select(dot(a, a).lessThan(dot(b, b)), a, b);
  return hexDist(TSL, gv).negate().add(0.55);
}

/**
 * `hexa(uv)` — hex tiling + a `cos(time)`-modulated threshold ring.
 * `hexUvs(uv2*10).y` is the only component of Foundry's own `vec4`-returning
 * `hexUvs()` this animation reads (`x`/`id` are computed by Foundry but
 * never used downstream — dropped here rather than ported as dead work).
 */
function hexaPattern(TSL, uv, time, uLightColor) {
  const { float, vec2, sin, smoothstep, mix, min, fract } = TSL;
  const uv1 = uv.add(vec2(0, sin(uv.y).mul(float(0.25))));
  const uv2 = uv1
    .mul(float(0.5))
    .add(uv.mul(float(0.5)))
    .add(vec2(0.55, 0));
  // Foundry's own mat2(0.5,1,-1,0.5)-style rotation on uv2 (c=0.5, s=-1):
  const c = float(0.5);
  const s = float(-1);
  const uv2Rotated = vec2(uv2.x.mul(c).sub(uv2.y.mul(s)), uv2.x.mul(s).add(uv2.y.mul(c)));

  const hexy = hexUvsY(TSL, uv2Rotated.mul(float(10)));
  const hexaVal = smoothstep(sin(time).mul(float(3)).add(float(4.5)), float(12), hexy.mul(float(20))).mul(float(3));

  let col = uLightColor.mul(mix(hexaVal, float(1).sub(hexaVal), min(hexy, float(1).sub(hexy))));
  col = col.add(uLightColor.mul(fract(smoothstep(float(1), float(2), hexy.mul(float(20))))).mul(float(0.65)));
  return col;
}

/**
 * @param {object} args
 * @param {*} args.THREE @param {*} args.uLightColor @param {*} args.uColorationAlpha @param {*} args.dist @param {*} args.time @param {*} args.uIntensityRaw
 * @returns {{finalColor: *}}
 */
export function buildHexaColorationSeed({ THREE, uLightColor, uColorationAlpha, dist, time, uIntensityRaw }) {
  const { float, pow, positionLocal } = THREE.TSL;

  const uv = transform(THREE.TSL, positionLocal.xy.mul(float(0.5)).add(float(0.5)), dist, time, uIntensityRaw);
  const finalColor = hexaPattern(THREE.TSL, uv, time, uLightColor)
    .mul(pow(float(1).sub(dist), float(0.18)))
    .mul(uColorationAlpha);
  return { finalColor };
}
