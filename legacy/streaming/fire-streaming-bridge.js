/**
 * @fileoverview View-projection bridge for Fire/Candle bucket streaming and minimap debug.
 * @module streaming/fire-streaming-bridge
 */

import { resolveStreamingViewRect } from './view-projection-service.js';
import { intersectRects } from './streaming-grid.js';

/** World-unit padding aligned with Fire shape view culling (640). */
export const FIRE_STREAM_VIEW_PADDING = 640;

/**
 * Ground-plane view rect for flame bucket activation (shared with tile streaming).
 *
 * @param {number} [padding=FIRE_STREAM_VIEW_PADDING]
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }|null}
 */
export function resolveFlameStreamingViewRect(padding = FIRE_STREAM_VIEW_PADDING) {
  return resolveStreamingViewRect({ uniform: padding });
}

/**
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }|null}
 */
export function resolveFireStreamingViewRect() {
  return resolveFlameStreamingViewRect(FIRE_STREAM_VIEW_PADDING);
}

/**
 * World AABB for a fire mask bucket from clustering cell keys.
 *
 * @param {Iterable<string>} memberCellKeys
 * @param {number} bucketSizePx
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }}
 */
export function fireBucketWorldBounds(memberCellKeys, bucketSizePx) {
  const cs = Math.max(96, Number(bucketSizePx) || 600);
  let minBx = Infinity;
  let minBy = Infinity;
  let maxBx = -Infinity;
  let maxBy = -Infinity;

  for (const key of memberCellKeys ?? []) {
    const parts = String(key).split(',');
    if (parts.length !== 2) continue;
    const bx = Number(parts[0]);
    const by = Number(parts[1]);
    if (!Number.isFinite(bx) || !Number.isFinite(by)) continue;
    minBx = Math.min(minBx, bx);
    minBy = Math.min(minBy, by);
    maxBx = Math.max(maxBx, bx);
    maxBy = Math.max(maxBy, by);
  }

  if (!Number.isFinite(minBx)) {
    return { minX: 0, minY: 0, maxX: cs, maxY: cs };
  }

  return {
    minX: minBx * cs,
    minY: minBy * cs,
    maxX: (maxBx + 1) * cs,
    maxY: (maxBy + 1) * cs,
  };
}

/**
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }|null} bounds
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }|null} viewRect
 * @returns {boolean}
 */
export function isFireBucketInView(bounds, viewRect) {
  if (!bounds || !viewRect) return true;
  return !!intersectRects(bounds, viewRect);
}

/**
 * Small world bounds around a glow pool centroid for view gating.
 *
 * @param {number} cxWorld
 * @param {number} cyWorld
 * @param {number} [radiusPx=128]
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }}
 */
export function glowCentroidBounds(cxWorld, cyWorld, radiusPx = 128) {
  const cx = Number(cxWorld) || 0;
  const cy = Number(cyWorld) || 0;
  const r = Math.max(48, Number(radiusPx) || 128);
  return {
    minX: cx - r,
    minY: cy - r,
    maxX: cx + r,
    maxY: cy + r,
  };
}

/**
 * Minimap overlay entries from fire bucket registry rows.
 *
 * @param {Iterable<{ floorIndex: number, bucketKey: string, bounds: object, active: boolean, glowOnly?: boolean }>} clusters
 * @returns {Array<{ floorIndex: number, bucketKey: string, bounds: object, state: string }>}
 */
export function buildFireMinimapEntries(clusters) {
  /** @type {Array<{ floorIndex: number, bucketKey: string, bounds: object, state: string }>} */
  const out = [];
  for (const c of clusters ?? []) {
    if (!c?.bounds) continue;
    let state = 'fire-culled';
    if (c.active) {
      state = c.glowOnly ? 'fire-glow-only' : 'fire-active';
    }
    out.push({
      floorIndex: c.floorIndex,
      bucketKey: c.bucketKey,
      bounds: c.bounds,
      state,
    });
  }
  return out;
}

/**
 * Minimap overlay entries from candle cluster registry rows.
 *
 * @param {Iterable<{ clusterKey: string, bounds: object, active: boolean, compact?: boolean }>} clusters
 * @returns {Array<{ clusterKey: string, bounds: object, state: string }>}
 */
export function buildCandleMinimapEntries(clusters) {
  /** @type {Array<{ clusterKey: string, bounds: object, state: string }>} */
  const out = [];
  for (const c of clusters ?? []) {
    if (!c?.bounds) continue;
    let state = 'candle-culled';
    if (c.active) {
      state = c.compact ? 'candle-compact' : 'candle-active';
    }
    out.push({
      clusterKey: c.clusterKey,
      bounds: c.bounds,
      state,
    });
  }
  return out;
}
