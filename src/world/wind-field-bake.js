/**
 * world/wind-field-bake.js — THE WIND FIELD, BAKED ONCE PER FRAME (2026-10-27, epic mmp-fpu).
 *
 * ============================================================================
 * WHY THIS EXISTS — A MEASUREMENT, NOT A THEORY
 * ============================================================================
 * `sampleWind` is ~18 Perlin evaluations (a 4-octave curl-noise turbulence stack
 * plus the gust envelope) and the wall/openness/shelter terms around them. Every
 * shader that wanted the wind inlined all of it. Measured on the author's RDNA2
 * card, through Chrome's real WebGPU compiler (`tools/shader-lab/cost-probe.js`),
 * the shipped candle flame compiled in **19.7 s** — one pipeline. With the wind
 * sampling and the candle memory taken out it compiled in 0.85 s. About 7 s of
 * that was the field sample alone, paid again by EVERY candle bucket, every light
 * bucket, every vegetation material and every fire sprite.
 *
 * A synchronous compile that long blocks Chrome's GPU process past its watchdog
 * and takes down every context on the page ("A valid external Instance reference
 * no longer exists") — the cold-load crash. Shrinking one shader at a time is the
 * wrong shape of fix, because the next effect that wants the wind pays the same
 * ~7 s. The wind is a FIELD: a pure function of (position, time). So evaluate it
 * once, in one small shader, into a texture on the wind grid every frame, and let
 * every consumer READ it.
 *
 * ## What is baked
 *
 * `sampleWind` itself — the SAME function, with the same inputs the analytic path
 * passes (`world/wind-access.js#node`): the live ambient, the openness / wall /
 * live-sim textures. Nothing is re-modelled here, so there is no second answer to
 * keep in step with the first. The texel at (col, row) holds the field at
 * `origin + (col + ½, row + ½) · cellSize`, exactly where the openness texture
 * keeps its own cell — which is also why a baked read through a bilinear sampler
 * agrees with the analytic value to well under the field's own noise (see
 * `__tests__/wind-field-bake.test.mjs`, and the real-GPU comparison in
 * `tools/shader-lab/cost-probe.js#fidelity`).
 *
 * ## Two slices
 *
 * `now` — the field at the frame's clock; `lag` — the field `groundLagSec` ago.
 * Vegetation's bushes read the wind a moment late (`vegetation.js`,
 * `windLagFraction`), so a bush asks for the lagged slice. Only the two fractions
 * trees (0) and bushes (1) exist; anything else falls back to the analytic path.
 *
 * ## What is NOT baked
 *
 * Compute kernels (particles, fire embers) read the storage-buffer path. They are
 * few, compile once, and are the wrong shape for a texture.
 *
 * TSL is passed IN (never imported) so this module stays importable from Node.
 *
 * @module world/wind-field-bake
 */

import { sampleWind } from './wind-field.js';

/**
 * @typedef {object} WindGrid
 * @property {number} originX - world x of cell (0,0)'s corner.
 * @property {number} originY - world y of cell (0,0)'s corner.
 * @property {number} cellSize - world px per cell.
 * @property {number} cols
 * @property {number} rows
 */

/**
 * The uv, in a texture laid over the wind grid, of a world position — the one
 * mapping `bakedField`, `wallAvoidField`, `liveField` and the baked field share.
 * Clamped, so a position outside the mapped area reads its nearest edge cell.
 * @param {*} TSL @param {WindGrid} grid @param {*} centerXY - vec2 node, world px.
 * @returns {*} vec2 node in [0,1]².
 */
export function windGridUvNode(TSL, grid, centerXY) {
  const { float, vec2, clamp } = TSL;
  return clamp(
    vec2(
      centerXY.x.sub(float(grid.originX)).div(float(grid.cellSize * grid.cols)),
      centerXY.y.sub(float(grid.originY)).div(float(grid.cellSize * grid.rows))
    ),
    vec2(0, 0),
    vec2(1, 1)
  );
}

/**
 * Read the baked field at a world position.
 *
 * ⚠️ `level(0)` EXPLICITLY. Consumers sample inside `If()` blocks and in the
 * vertex stage; an explicit level is legal in both and never asks the GPU for
 * implicit derivatives. It is still a filtered (bilinear) read.
 *
 * @param {*} TSL
 * @param {{texture: *, grid: WindGrid, centerXY: *}} args
 * @returns {*} vec2 node — the raw field, in `sampleWind`'s units.
 */
export function sampleBakedWindField(TSL, { texture: fieldTexture, grid, centerXY }) {
  const { texture, float } = TSL;
  return texture(fieldTexture, windGridUvNode(TSL, grid, centerXY)).level(float(0)).xy;
}

/**
 * The bake pass's material: a full-grid quad whose fragment is `sampleWind` at
 * the texel's world position, written as `(fieldX, fieldY, 0, 1)`.
 *
 * One material serves both slices — `uBakeTimeMs` is the only thing that differs
 * between the `now` and the `lag` pass.
 *
 * ## Orientation
 * The quad is `THREE.QuadMesh` (the vendor owns the Y convention — structure rule
 * `gpu/no-handrolled-fullscreen-quad`). Its `uv()` runs v=0 at the TOP row of the
 * render target, which is also row 0 of every texture on this grid and `origin.y`
 * in the world, so `world = origin + uv · span` needs no flip. The real-GPU
 * fidelity check pins it: a flipped bake would disagree with the analytic field
 * everywhere that the field is not symmetric.
 *
 * @param {*} THREE
 * @param {object} args
 * @param {{directionDeg: *, speed01: *, gustiness01?: *, pixelsPerMetre?: *, advection?: *}} args.ambient
 * @param {{texture: *, originX: number, originY: number, cellSize: number, cols: number, rows: number}} [args.bakedField]
 * @param {{texture: *, originX: number, originY: number, cellSize: number, cols: number, rows: number}} [args.wallAvoidField]
 * @param {{texture: *, originX: number, originY: number, cellSize: number, cols: number, rows: number}} [args.liveField]
 * @param {WindGrid} args.grid
 * @returns {{material: *, uBakeTimeMs: *}}
 */
export function buildWindFieldBakeMaterial(THREE, { ambient, bakedField, wallAvoidField, liveField, grid }) {
  const TSL = THREE.TSL;
  const { uniform, float, vec2, vec4, uv } = TSL;
  const uBakeTimeMs = uniform(float(0));
  const frame = uv();
  const worldXY = vec2(
    frame.x.mul(float(grid.cellSize * grid.cols)).add(float(grid.originX)),
    frame.y.mul(float(grid.cellSize * grid.rows)).add(float(grid.originY))
  );
  const field = sampleWind(TSL, {
    centerXY: worldXY,
    time: uBakeTimeMs,
    wind: ambient,
    bakedField,
    wallAvoidField,
    liveField,
  });
  const material = new THREE.NodeMaterial();
  material.name = 'wind.field.bake';
  material.fragmentNode = vec4(field.x, field.y, float(0), float(1));
  material.depthTest = false;
  material.depthWrite = false;
  material.transparent = false;
  material.blending = THREE.NoBlending;
  return { material, uBakeTimeMs };
}

/**
 * Which slice does a consumer's request map to?
 * @param {'now'|'lagged'|undefined} baked
 * @returns {'now'|'lag'|null} null → the consumer did not ask for the baked field.
 */
export function bakedSliceFor(baked) {
  if (baked === 'now') return 'now';
  if (baked === 'lagged') return 'lag';
  return null;
}
