/**
 * @fileoverview vt/scene-prewarm.js — fill the persistent art caches for a scene
 * BEFORE anyone switches to it (loading audit, 2026-10-25, phase 4).
 *
 * ============================================================================
 * WHAT CAN BE WARMED, AND WHY ONLY THIS
 * ============================================================================
 * The biggest single cost in a cold load is whole-image BC compression: the
 * module's own comments record 18-27 s per 12 000² floor and a 166 s cold load of
 * which 128 s was "art" (`vt/block-compress.js`). It runs in ONE worker, keyed
 * only by the source URL, and the worker persists its blocks in IndexedDB
 * (`msa-bc-cache`, `bc-compress.worker.js`). A request made now therefore leaves
 * the answer waiting for the request the real viewer makes later — a cache hit of
 * milliseconds instead of seconds. That makes it the one piece of work that can be
 * done ahead of time, for a scene no viewer exists for yet, with NO new cache.
 *
 * What it deliberately does not do: build a second viewer (that would double the
 * GPU memory), or warm the hi-res effect masks (they have no cache to warm — the
 * audit's L-05).
 *
 * ============================================================================
 * IT RUNS AT THE LOWEST PRIORITY
 * ============================================================================
 * Requests go on the worker's `background` lane, behind anything the current
 * scene is waiting to draw (`vt/compressed-textures.js` — the lanes exist because
 * a player once waited minutes for a floor queued behind priming work). A prewarm
 * can therefore never slow the scene people are playing in.
 *
 * Pure planning + an injectable runner: Node-tested without a worker.
 *
 * @module vt/scene-prewarm
 */

import { requestCompressedTexture, PRIORITY_BACKGROUND } from './compressed-textures.js';

/** The item kinds whose art goes through whole-image BC compression. Tokens do not. */
export const COMPRESSED_ART_KINDS = Object.freeze(['levelBackground', 'levelForeground', 'tile']);

/**
 * The distinct art files worth compressing, in draw-list order.
 * @param {Array<{kind?: string, src?: string|null}>} items - `collectSceneLayers(...).items`
 * @returns {string[]}
 */
export function planArtPrewarm(items) {
  const seen = new Set();
  const out = [];
  for (const item of items ?? []) {
    if (!COMPRESSED_ART_KINDS.includes(item?.kind)) continue;
    const src = item?.src;
    if (typeof src !== 'string' || !src || seen.has(src)) continue;
    seen.add(src);
    out.push(src);
  }
  return out;
}

/**
 * Ask the compression worker for each file, one at a time (the worker is a single
 * FIFO anyway, and one at a time is what makes the progress count true).
 *
 * @param {string[]} srcs
 * @param {object} [opts]
 * @param {(p: {done: number, total: number, src: string|null}) => void} [opts.onProgress]
 * @param {() => boolean} [opts.isCancelled] - checked between files; a file already
 *   queued in the worker finishes (and still warms the cache).
 * @param {(src: string, o: {priority: string}) => Promise<object|null>} [opts.request]
 *   injected for tests; defaults to the real worker client.
 * @returns {Promise<{requested: number, cachedHits: number, fresh: number, unavailable: number, cancelled: boolean}>}
 */
export async function prewarmArtCompression(
  srcs,
  { onProgress, isCancelled, request = requestCompressedTexture } = {}
) {
  const total = srcs.length;
  const result = { requested: 0, cachedHits: 0, fresh: 0, unavailable: 0, cancelled: false };
  onProgress?.({ done: 0, total, src: null });
  for (let i = 0; i < total; i++) {
    if (isCancelled?.()) {
      result.cancelled = true;
      break;
    }
    result.requested++;
    const res = await request(srcs[i], { priority: PRIORITY_BACKGROUND });
    // The blocks themselves are dropped on the floor here ON PURPOSE: the point is the
    // IndexedDB entry the worker wrote, and holding 144 MB per floor in memory
    // for a scene nobody is looking at yet would be the opposite of the goal.
    if (!res) result.unavailable++;
    else if (res.cached) result.cachedHits++;
    else result.fresh++;
    onProgress?.({ done: i + 1, total, src: srcs[i] });
  }
  return result;
}
