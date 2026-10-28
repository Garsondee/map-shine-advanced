/**
 * world/wind-gust-history.js — THE WIND'S RECENT PAST, KEPT AS A TEXTURE (2026-10-27, epic mmp-fpu).
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * A candle that remembers being blown out (`effects/candle-wind-state.js`) needs
 * the wind at its own wick at ~14 past moments. The first version computed them:
 * 14 evaluations of the gust envelope, unrolled into the vertex stage of the
 * flame and of every candle-light shader. Measured through Chrome's real WebGPU
 * compiler (`tools/shader-lab/cost-probe.js`) that ladder alone cost ~5.5 s of
 * compile per pipeline, on top of a field sample worth ~7 s — the shaders that
 * took the GPU process past its watchdog and lost the device on a cold load.
 *
 * The past does not change. So record it once, as it happens, and READ it:
 *
 *   - every `GUST_HISTORY_STEP_S` (0.6 s) of sim time, ONE small pass writes the
 *     gust magnitude over the whole wind grid for that moment (the SAME function
 *     the ladder evaluated per candle: `world/wind-access.js#gustMagnitudeAt`);
 *   - the passes land in a ring of 16 tiles in one atlas (4 × 4 grids), because a
 *     shader may bind at most 16 textures and a tap per texture would spend them;
 *   - a candle reads 14 taps from the atlas — texture fetches, no noise.
 *
 * Recording the REAL past is also more honest than the old maths, which evaluated
 * "ten seconds ago" with today's wind speed: during a wind fade a candle would
 * have been blown out retroactively by gusts that had not happened yet.
 *
 * ## Time is a uniform, not a recomputation
 *
 * The shader never derives "which moment is the latest" from its own float clock.
 * The baker owns that decision (in doubles, on the CPU) and publishes it as a
 * uniform (`gridIndex`); the taps are `gridIndex − k`. A shader that recomputed
 * `floor(t / step)` in float32 could disagree with the baker by one moment for a
 * frame at a boundary and read a slot that has not been written yet.
 *
 * TSL is passed IN so this module stays importable from Node.
 *
 * @module world/wind-gust-history
 */

import { windGridUvNode } from './wind-field-bake.js';

/** Seconds between recorded moments. The candle ladder's own step (`CANDLE_HISTORY_STEP_S`). */
export const GUST_HISTORY_STEP_S = 0.6;
/** Moments a consumer may look back over (the candle ladder's own tap count). */
export const GUST_HISTORY_TAPS = 14;
/** The atlas is `TILES × TILES` grids. */
export const GUST_HISTORY_TILES = 4;
/** Ring size: more than the taps, so a moment is never overwritten while a consumer can still read it. */
export const GUST_HISTORY_SLOTS = GUST_HISTORY_TILES * GUST_HISTORY_TILES;

/**
 * The ring slot a moment lives in. Total on negative moments (a world younger than the look-back).
 * @param {number} momentIndex @returns {number} 0..SLOTS-1
 */
export function gustHistorySlotFor(momentIndex) {
  const m = Math.floor(Number.isFinite(momentIndex) ? momentIndex : 0);
  return ((m % GUST_HISTORY_SLOTS) + GUST_HISTORY_SLOTS) % GUST_HISTORY_SLOTS;
}

/** @param {number} slot @returns {{tx: number, ty: number}} the tile column / row of a slot. */
export function gustHistoryTileOf(slot) {
  const s = ((Math.floor(slot) % GUST_HISTORY_SLOTS) + GUST_HISTORY_SLOTS) % GUST_HISTORY_SLOTS;
  return { tx: s % GUST_HISTORY_TILES, ty: Math.floor(s / GUST_HISTORY_TILES) };
}

/** The atlas's pixel size for a wind grid — kept under the allocator's 2048 px cap by the grid's own 512-cell cap. */
export function gustHistoryAtlasSize(cols, rows) {
  return { width: cols * GUST_HISTORY_TILES, height: rows * GUST_HISTORY_TILES };
}

/**
 * The index of the latest moment at a sim clock. Doubles, on the CPU — the one place this is decided.
 * @param {number} tMs @returns {number}
 */
export function gustHistoryMomentAt(tMs) {
  return Math.floor((Number.isFinite(tMs) ? tMs : 0) / (GUST_HISTORY_STEP_S * 1000));
}

/**
 * Which moments must be recorded now? Pure.
 *
 * A first call, or a clock that jumped back (a scene reload, a time set), records the whole look-back
 * so a consumer never reads a slot that was never written. A normal frame records zero or one moment; a
 * long stall records at most the look-back (older moments could not be read anyway).
 *
 * @param {{lastMoment: number|null}} state
 * @param {number} tMs
 * @returns {{state: {lastMoment: number}, moment: number, bakes: Array<{moment: number, slot: number, timeMs: number}>}}
 */
export function planGustHistoryBakes(state, tMs) {
  const moment = gustHistoryMomentAt(tMs);
  const last = state?.lastMoment;
  const fresh = last === null || last === undefined || moment < last;
  const from = fresh ? moment - (GUST_HISTORY_TAPS - 1) : Math.max(last + 1, moment - (GUST_HISTORY_TAPS - 1));
  const bakes = [];
  for (let m = from; m <= moment; m++) {
    if (!fresh && m <= last) continue;
    bakes.push({ moment: m, slot: gustHistorySlotFor(m), timeMs: m * GUST_HISTORY_STEP_S * 1000 });
  }
  return { state: { lastMoment: moment }, moment, bakes };
}

/**
 * Read one tap of the history: the gust magnitude at a world position, `momentIndex` being an absolute
 * moment (`gridIndex − k`), as a float node.
 *
 * The within-tile coordinate is inset by half a texel, so a bilinear read at a tile's edge cannot bleed
 * into its neighbour in the atlas — the only seam a tiled atlas has.
 *
 * @param {*} TSL
 * @param {{texture: *, grid: {originX:number, originY:number, cellSize:number, cols:number, rows:number},
 *   centerXY: *, momentIndex: *}} args
 * @returns {*} float node.
 */
export function sampleGustHistoryTap(TSL, { texture: atlas, grid, centerXY, momentIndex }) {
  const { float, vec2, clamp, mod, floor, texture } = TSL;
  const within = clamp(
    windGridUvNode(TSL, grid, centerXY),
    vec2(0.5 / grid.cols, 0.5 / grid.rows),
    vec2(1 - 0.5 / grid.cols, 1 - 0.5 / grid.rows)
  );
  // +16000 (a multiple of the ring) keeps `mod` away from negative operands in a world younger than the look-back.
  const slot = mod(momentIndex.add(float(GUST_HISTORY_SLOTS * 1000)), float(GUST_HISTORY_SLOTS));
  const tx = mod(slot, float(GUST_HISTORY_TILES));
  const ty = floor(slot.div(float(GUST_HISTORY_TILES)));
  const uv = vec2(tx.add(within.x).div(float(GUST_HISTORY_TILES)), ty.add(within.y).div(float(GUST_HISTORY_TILES)));
  return texture(atlas, uv).level(float(0)).x;
}
