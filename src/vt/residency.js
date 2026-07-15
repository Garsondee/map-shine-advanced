/**
 * @fileoverview vt/residency.js — analytic visible-page computation (Keyhole.md
 * §4.1).
 *
 * No GPU feedback pass. MSA's camera is top-down, so the visible world rect
 * (from `scene/view-projection-service.getVisibleWorldRect()`) plus zoom gives
 * exactly the needed page range and mip, on the CPU, in microseconds — the
 * simplification that makes this "less exotic than it sounds" versus
 * id-Tech-style SVT feedback rendering.
 *
 * Pure functions only: given a world rect and a `PageTable`, return the exact
 * set of page coordinates that must be resident to cover it, plus a guard
 * ring (so a one-page pan doesn't cause a miss) and the next-coarser mip (for
 * prefetch / instant fallback while the fine mip streams in).
 *
 * @module vt/residency
 */

/**
 * @typedef {object} WorldRect
 * @property {number} minX @property {number} minY
 * @property {number} maxX @property {number} maxY
 */

/**
 * Choose the finest mip whose page-texel footprint still resolves at least
 * one texel per screen pixel for the given rect/viewport — i.e. don't stream
 * mip 0 detail for a rect that's zoomed out to a handful of screen pixels.
 * Pure arithmetic; no GPU query.
 *
 * @param {import('./page-table.js').PageTable} table
 * @param {WorldRect} worldRect
 * @param {number} viewportPx - the screen-space dimension (width or height,
 *   whichever axis the caller is resolving against; callers typically use the
 *   larger of the two for a conservative — sharper — choice).
 * @returns {number} mip level
 */
export function chooseMip(table, worldRect, viewportPx) {
  const worldSpan = Math.max(1, Math.max(worldRect.maxX - worldRect.minX, worldRect.maxY - worldRect.minY));
  const texelsPerScreenPx = worldSpan / Math.max(1, viewportPx);
  // mip 0 covers `payloadPx` world-texels per page-texel == 1:1 at native res.
  // Each mip up halves resolution (2x world-texels per page-texel), so the
  // right mip is the one whose per-texel world coverage first exceeds what a
  // screen pixel actually needs.
  let mip = 0;
  let coverage = 1; // world-texels per page-texel at mip 0
  while (coverage * 2 <= texelsPerScreenPx && mip < table.maxMip) { coverage *= 2; mip++; }
  return mip;
}

/**
 * The core residency query: every page (plus guard ring) needed to cover
 * `worldRect` at `mip` for one virtual texture.
 *
 * @param {import('./page-table.js').PageTable} table
 * @param {WorldRect} worldRect
 * @param {object} [opts]
 * @param {number} [opts.mip] - defaults to 0 (finest) if not given by the caller.
 * @param {number} [opts.guardPages] - extra pages of margin on every side
 *   (default 1 — "active-view ring: current visible set + 1-page guard ring").
 * @returns {Array<{mip:number, px:number, py:number, key:string}>}
 */
export function computeVisiblePages(table, worldRect, opts = {}) {
  const mip = opts.mip ?? 0;
  const guard = opts.guardPages ?? 1;
  const pageWorldSpan = table.payloadPx * (1 << mip);

  const px0 = Math.floor(worldRect.minX / pageWorldSpan) - guard;
  const py0 = Math.floor(worldRect.minY / pageWorldSpan) - guard;
  const px1 = Math.floor(worldRect.maxX / pageWorldSpan) + guard;
  const py1 = Math.floor(worldRect.maxY / pageWorldSpan) + guard;

  const n = table.pagesPerAxis(mip);
  const out = [];
  for (let py = Math.max(0, py0); py <= Math.min(n - 1, py1); py++) {
    for (let px = Math.max(0, px0); px <= Math.min(n - 1, px1); px++) {
      out.push({ mip, px, py, key: table.pageKey(mip, px, py) });
    }
  }
  return out;
}

/**
 * Convenience: the full residency plan for one virtual texture at a given
 * view — the fine mip's visible+guard set (to request/pin as 'view') PLUS the
 * next-coarser mip's covering set (to request/pin as 'view' too, cheap
 * insurance so a fine-mip miss still has an immediate, correct fallback one
 * step up rather than falling all the way to the coarse world-pin).
 *
 * @param {import('./page-table.js').PageTable} table
 * @param {WorldRect} worldRect
 * @param {number} viewportPx
 * @param {object} [opts] @param {number} [opts.guardPages]
 * @returns {{mip:number, fine: Array, prefetchCoarser: Array}}
 */
export function planResidency(table, worldRect, viewportPx, opts = {}) {
  const mip = chooseMip(table, worldRect, viewportPx);
  const fine = computeVisiblePages(table, worldRect, { mip, guardPages: opts.guardPages });
  const coarserMip = Math.min(table.maxMip, mip + 1);
  const prefetchCoarser = coarserMip > mip
    ? computeVisiblePages(table, worldRect, { mip: coarserMip, guardPages: opts.guardPages })
    : [];
  return { mip, fine, prefetchCoarser };
}

/**
 * Every page of the top mip (mip === table.maxMip) — the "coarse pin" set for
 * one virtual texture (Keyhole.md §4.1: "tens of pages total" across the
 * whole world). Callers pin these once at load and never evict them.
 * @param {import('./page-table.js').PageTable} table
 * @returns {Array<{mip:number, px:number, py:number, key:string}>}
 */
export function coarsePinSet(table) {
  const mip = table.maxMip;
  const n = table.pagesPerAxis(mip);
  const out = [];
  for (let py = 0; py < n; py++)
    for (let px = 0; px < n; px++)
      out.push({ mip, px, py, key: table.pageKey(mip, px, py) });
  return out;
}
