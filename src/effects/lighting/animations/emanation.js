/**
 * EMANATION — Foundry's `emanation` animation (docs/reference/foundry-v14-
 * light-animations-audit.md §4 `emanation`). CPU driver: `animateTime`.
 * Coloration-only; `forceDefaultColor = true`. Radiating angular beams via
 * `atan`+`fract`, no fbm — the simplest of the angular-beam animations.
 *
 * `intensity` here directly sets BEAM COUNT (not a 0-1 blend weight like
 * most animations' use of intensity) — `angle * intensity` packs more beam
 * cycles around the circle as intensity rises.
 *
 * GPU-ONLY REWRITE (2026-07-20): `time`/`uIntensityRaw` are now the
 * scaffold-supplied params (no longer self-created uniforms).
 *
 * @module effects/lighting/animations/emanation
 */

import { mirrorTriangle } from './tsl-noise-toolkit.js';

const INV_TWO_PI = 1 / (2 * Math.PI);

/**
 * `angle = atan(uv.x, uv.y) * INVTWOPI` (Foundry's own x,y argument order —
 * NOT the more common atan(y,x) — verified against source, kept exact
 * since it determines which axis the beam pattern starts from);
 * `beams = mirrorTriangle(fract(angle*intensity + sin(dist*10 - time)))`;
 * `finalColor = smoothstep(0,1, beams*color) * colorationAlpha`.
 *
 * @param {object} args
 * @param {*} args.THREE @param {*} args.uLightColor @param {*} args.uColorationAlpha @param {*} args.dist @param {*} args.time @param {*} args.uIntensityRaw
 * @returns {{finalColor: *}}
 */
export function buildEmanationColorationSeed({
  THREE,
  uLightColor,
  uColorationAlpha,
  dist,
  time,
  uIntensityRaw,
  localPosition,
}) {
  const { float, atan, fract, sin, smoothstep } = THREE.TSL;

  // NEVER `positionLocal` directly — see candle-flicker.js's own header.
  const uv = localPosition;
  const angle = atan(uv.x, uv.y).mul(float(INV_TWO_PI));
  const beamsRaw = fract(angle.mul(uIntensityRaw).add(sin(dist.mul(float(10)).sub(time))));
  const beams = mirrorTriangle(THREE.TSL, beamsRaw);

  const finalColor = smoothstep(float(0), float(1), beams.mul(uLightColor)).mul(uColorationAlpha);
  return { finalColor };
}
