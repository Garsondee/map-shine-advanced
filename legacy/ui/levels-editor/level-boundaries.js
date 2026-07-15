/**
 * @fileoverview Shared half-open level boundary helpers.
 * @module ui/levels-editor/level-boundaries
 */

function _n(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Half-open floor containment: [min, max), except final floor may include max.
 * @param {number} elevation
 * @param {number} min
 * @param {number} max
 * @param {boolean} includeUpperBound
 * @returns {boolean}
 */
export function elevationInBand(elevation, min, max, includeUpperBound = false) {
  const e = _n(elevation);
  const lo = _n(min);
  const hi = _n(max);
  if (!Number.isFinite(e) || !Number.isFinite(lo) || !Number.isFinite(hi)) return false;
  if (includeUpperBound) return e >= lo && e <= hi;
  return e >= lo && e < hi;
}

/**
 * Determine whether [aMin, aMax] intersects [bMin, bMax] as a closed overlap.
 * Used for thick tiles that can span floors.
 * @param {number} aMin
 * @param {number} aMax
 * @param {number} bMin
 * @param {number} bMax
 * @returns {boolean}
 */
export function rangesOverlap(aMin, aMax, bMin, bMax) {
  const am = _n(aMin);
  const ax = _n(aMax);
  const bm = _n(bMin);
  const bx = _n(bMax);
  if (!Number.isFinite(am) || !Number.isFinite(ax) || !Number.isFinite(bm) || !Number.isFinite(bx)) return false;
  const alo = Math.min(am, ax);
  const ahi = Math.max(am, ax);
  const blo = Math.min(bm, bx);
  const bhi = Math.max(bm, bx);
  return alo <= bhi && blo <= ahi;
}

/**
 * Resolve floor index by elevation with consistent shared-boundary behavior.
 * Prefers [min,max) for all but final floor where [min,max] is accepted.
 * @param {number} elevation
 * @param {Array<{elevationMin:number,elevationMax:number}>} floors
 * @returns {number}
 */
export function resolveFloorIndexForElevation(elevation, floors) {
  if (!Array.isArray(floors) || floors.length === 0) return -1;
  for (let i = 0; i < floors.length; i += 1) {
    const f = floors[i];
    const includeUpperBound = i === (floors.length - 1);
    if (elevationInBand(elevation, f.elevationMin, f.elevationMax, includeUpperBound)) {
      return i;
    }
  }
  return -1;
}
