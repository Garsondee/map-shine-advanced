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
  while (coverage * 2 <= texelsPerScreenPx && mip < table.maxMip) {
    coverage *= 2;
    mip++;
  }
  return mip;
}

/**
 * The CONTINUOUS (fractional) analogue of chooseMip() — same texelsPerScreenPx
 * math, but returns `log2(texelsPerScreenPx)` (clamped to `[0, table.maxMip]`)
 * instead of rounding down to an integer. This is what makes smooth mip
 * blending possible (2026-07-16, author-reported: "zooming in and out
 * produces very ugly zoom levels" — the hard integer-mip pop): the shader can
 * sample the two BRACKETING integer mips (`floor`/`ceil` of this value) and
 * cross-fade between them by the fractional part, instead of hard-switching
 * exactly at chooseMip()'s threshold.
 *
 * INVARIANT (verified by this module's own tests): `Math.floor(chooseMipFraction(...))`
 * always equals `chooseMip(...)` for the same inputs — same underlying
 * quantity, just not rounded down early. This is WHY no residency/streaming
 * change was needed to support blending: `planResidency()` already requests
 * mip M (`fine`) AND mip M+1 (`prefetchCoarser`, clamped to maxMip) — exactly
 * the two mips a blend needs, for a reason that had nothing to do with
 * blending (insurance against a fine-mip miss) but happens to supply it for
 * free.
 *
 * @param {import('./page-table.js').PageTable} table
 * @param {WorldRect} worldRect
 * @param {number} viewportPx
 * @returns {number} fractional mip level, in `[0, table.maxMip]`.
 */
export function chooseMipFraction(table, worldRect, viewportPx) {
  const worldSpan = Math.max(1, Math.max(worldRect.maxX - worldRect.minX, worldRect.maxY - worldRect.minY));
  const texelsPerScreenPx = worldSpan / Math.max(1, viewportPx);
  const raw = Math.log2(Math.max(1e-6, texelsPerScreenPx)); // mip 0 == 1 world-texel/screen-px
  return Math.max(0, Math.min(table.maxMip, raw));
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

  const nx = table.pagesX(mip);
  const ny = table.pagesY(mip);
  const out = [];
  for (let py = Math.max(0, py0); py <= Math.min(ny - 1, py1); py++) {
    for (let px = Math.max(0, px0); px <= Math.min(nx - 1, px1); px++) {
      out.push({ mip, px, py, key: table.pageKey(mip, px, py) });
    }
  }
  return out;
}

/**
 * Convenience: the full residency plan for one virtual texture at a given
 * view — the fine mip's visible+guard set (to request/pin as 'view') PLUS
 * BOTH neighboring mips' covering sets (to request/pin as 'view' too, cheap
 * insurance so a mip-level change during a zoom gesture — either direction —
 * still has an immediate, already-warm level to land on instead of a fresh
 * decode).
 *
 * `prefetchFiner` (2026-07-16, author-reported: "zoom in or out can hitch,
 * stops happening if I repeat" — the exact signature of a cold-cache-on-
 * first-visit decode stall) is the FINER counterpart to `prefetchCoarser`,
 * which existed alone until now — a real, asymmetric gap: zooming OUT was
 * already covered (each step's "coarser" prefetch becomes the next step's
 * "fine" set, so a steady zoom-out stays one step ahead), but zooming IN had
 * ZERO equivalent insurance — the finer mip was always a cold decode the
 * first time any given level was visited at a given pan position, exactly
 * matching "stops happening if I repeat" (the second visit finds it already
 * decoded+persisted). `guardPages:0` for the finer set specifically (tighter
 * than `fine`/`prefetchCoarser`'s own margin) — a finer mip has ~4x more
 * pages per unit area than its parent, so this keeps the extra insurance
 * bounded rather than compounding the guard ring's cost too.
 *
 * @param {import('./page-table.js').PageTable} table
 * @param {WorldRect} worldRect
 * @param {number} viewportPx
 * @param {object} [opts] @param {number} [opts.guardPages]
 * @returns {{mip:number, mipFraction:number, fine: Array, prefetchCoarser: Array, prefetchFiner: Array}}
 */
export function planResidency(table, worldRect, viewportPx, opts = {}) {
  const mip = chooseMip(table, worldRect, viewportPx);
  const mipFraction = chooseMipFraction(table, worldRect, viewportPx);
  const fine = computeVisiblePages(table, worldRect, { mip, guardPages: opts.guardPages });
  const coarserMip = Math.min(table.maxMip, mip + 1);
  const prefetchCoarser =
    coarserMip > mip ? computeVisiblePages(table, worldRect, { mip: coarserMip, guardPages: opts.guardPages }) : [];
  const finerMip = Math.max(0, mip - 1);
  const prefetchFiner = finerMip < mip ? computeVisiblePages(table, worldRect, { mip: finerMip, guardPages: 0 }) : [];
  return { mip, mipFraction, fine, prefetchCoarser, prefetchFiner };
}

/**
 * The "coarse pin" set for one virtual texture (Keyhole.md §4.1): every page of
 * the top `topMips` mip levels. Callers pin these once at load and NEVER evict
 * them — this is what guarantees the whole world always renders, just soft
 * (worst case is blur, never black, never a "not resident → crash" state).
 *
 * §4.1 says "the top MIPS" (plural) precisely because pinning only the single
 * 1×1 top page would force every miss to fall all the way to a world-blurred-
 * to-one-page floor. Pinning the top few levels gives a far sharper soft floor
 * for a still-tiny page count. Default `topMips:1` preserves the original
 * single-top-mip behavior; the pan viewer passes the count from
 * `coarseTopMipsForCap()`.
 *
 * @param {import('./page-table.js').PageTable} table
 * @param {object} [opts] @param {number} [opts.topMips] - how many of the
 *   coarsest mip levels to include (default 1 == just the top page).
 * @returns {Array<{mip:number, px:number, py:number, key:string}>}
 */
export function coarsePinSet(table, opts = {}) {
  const topMips = Math.max(1, opts.topMips ?? 1);
  const startMip = Math.max(0, table.maxMip - (topMips - 1));
  const out = [];
  for (let mip = startMip; mip <= table.maxMip; mip++) {
    const nx = table.pagesX(mip);
    const ny = table.pagesY(mip);
    for (let py = 0; py < ny; py++)
      for (let px = 0; px < nx; px++) out.push({ mip, px, py, key: table.pageKey(mip, px, py) });
  }
  return out;
}

/**
 * Choose how many of the coarsest mip levels to pin so the total coarse page
 * count stays within `maxPages` ("tens of pages", §4.1) — walking from the top
 * (1 page) downward, adding each finer level until the next one would overflow
 * the cap. Always returns at least 1 (the top page is non-negotiable — it is
 * the guaranteed floor). A larger cap buys a sharper soft floor at more pinned
 * pages; the default keeps the whole-world floor in the low tens.
 *
 * For the 12000px torture world (mip page counts 1,4,16,49,169,… from the top)
 * the default cap of 96 pins the top 4 mips (1+4+16+49 = 70 pages), giving a
 * ~7×7-page soft floor — recognizable, never black — for ~70 permanently
 * resident pages out of 2048.
 *
 * @param {import('./page-table.js').PageTable} table
 * @param {object} [opts] @param {number} [opts.maxPages] - page-count cap (default 96).
 * @returns {number} number of top mip levels to pin (>= 1).
 */
export function coarseTopMipsForCap(table, opts = {}) {
  const maxPages = opts.maxPages ?? 96;
  let count = 0;
  let total = 0;
  for (let mip = table.maxMip; mip >= 0; mip--) {
    const add = table.pagesX(mip) * table.pagesY(mip);
    if (count >= 1 && total + add > maxPages) break;
    total += add;
    count++;
  }
  return count;
}

/**
 * Diff a previous "currently view-pinned" key set against a freshly computed
 * needed-page list (e.g. from `planResidency().fine`) — the per-frame update
 * a pan/zoom viewer runs. Pages newly needed must be requested (decoded +
 * uploaded if not already resident from a prior visit); pages no longer
 * needed are UNPINNED, never evicted directly here — `PageCache` itself
 * decides eviction via LRU under real pressure, so a brief pan-and-back stays
 * free (Keyhole.md §4.1's "two pin classes" design, `page-cache.js`'s own
 * `unpin()` doc comment).
 *
 * @param {Set<string>} prevKeys - the key set that was pinned 'view' last frame.
 * @param {Array<{key:string}>} nextPages - this frame's needed pages (with duplicates fine).
 * @returns {{toRequest: Array<{key:string}>, toUnpin: string[], nextKeys: Set<string>}}
 */
export function diffResidency(prevKeys, nextPages) {
  const nextKeys = new Set(nextPages.map((p) => p.key));
  const toRequest = [];
  const seen = new Set();
  for (const page of nextPages) {
    if (seen.has(page.key)) continue; // de-dupe (fine+prefetch sets can overlap)
    seen.add(page.key);
    if (!prevKeys.has(page.key)) toRequest.push(page);
  }
  const toUnpin = [];
  for (const key of prevKeys) if (!nextKeys.has(key)) toUnpin.push(key);
  return { toRequest, toUnpin, nextKeys };
}
