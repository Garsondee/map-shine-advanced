/**
 * @fileoverview vt/page-table.js — per-virtual-texture page indirection
 * (Keyhole.md §4.1).
 *
 * A "virtual texture" here is one streamable image: a floor's albedo, one of its
 * masks, a Level's foreground (roof) art, or a single Tile's texture. `PageTable`
 * computes the page grid for a given image size and page payload, builds the
 * canonical page key `PageCache` uses for identity, and holds the indirection
 * itself (mip/px/py -> atlas slot) once `PageCache` has assigned one.
 *
 * In the shipped renderer this indirection becomes a tiny RGBA8 texture sampled
 * by `vtSample()` (§4.1's shared GLSL include); this module is the CPU-side
 * source of truth it's built from, and is fully Node-testable on its own (no GPU
 * touched here).
 *
 * ## Rectangular, as of 2026-07-16 — and why that was overdue
 *
 * This took a single `worldSizePx` and assumed a SQUARE page grid. Callers had
 * to reject non-square art with a loud throw (`vt-pan-viewer`'s own guard),
 * which meant, in practice:
 *
 * - **Most real Foundry scenes could not render at all.** Square scene art is
 *   the exception, not the rule. The author's 12000x12000 mansion is square,
 *   which is the only reason this never surfaced — a latent blocker sitting one
 *   scene away the entire time.
 * - **Tiles were impossible.** A tile's texture is essentially never square, so
 *   the square constraint blocked the entire tile feature, not an edge case of it.
 *
 * The axes are now independent throughout: `worldWidthPx`/`worldHeightPx`,
 * `pagesX(mip)`/`pagesY(mip)`. Note this is genuinely *cheap* — a mip halves
 * both axes together, so the page **payload stays square** (248x248) and every
 * downstream consumer (atlas, cache, decode, upload) is completely unaffected: a
 * page is still just a 256x256 RGBA page. Only the *grid* is rectangular.
 *
 * There is deliberately no `worldSizePx` alias for the square case — one path per
 * behavior (Keyhole.md §0 doctrine #1). A square image is a rectangle whose sides
 * happen to match.
 *
 * @module vt/page-table
 */

/** Default page payload in texels (256px page - 4px border on each side = 248). */
export const DEFAULT_PAGE_PAYLOAD_PX = 248;

export class PageTable {
  /**
   * @param {object} options
   * @param {string} options.id - stable identity for this virtual texture,
   *   e.g. `"floor1:surfaceResponse"` or `"tile:abc123"`. Used as the page-key prefix.
   * @param {number} options.worldWidthPx - this image's width at its finest mip,
   *   in texels (e.g. 12000 for the torture scene's albedo, 1024 for a tile).
   * @param {number} options.worldHeightPx - ditto, height. May differ from width.
   * @param {number} [options.payloadPx] - page payload size (default 248,
   *   i.e. Keyhole Q1's 256px page minus 4px borders on each side). SQUARE by
   *   construction — a mip halves both axes together, so there is no reason for
   *   a rectangular payload, and keeping it square is what leaves the atlas and
   *   cache untouched by rectangular support.
   * @param {number} [options.maxMip] - highest mip level to track (each mip
   *   halves the page grid on BOTH axes; default computed so the top mip is a
   *   single page).
   */
  constructor({ id, worldWidthPx, worldHeightPx, payloadPx = DEFAULT_PAGE_PAYLOAD_PX, maxMip }) {
    if (!id) throw new Error('PageTable: id is required');
    if (!(worldWidthPx > 0)) throw new Error('PageTable: worldWidthPx must be > 0');
    if (!(worldHeightPx > 0)) throw new Error('PageTable: worldHeightPx must be > 0');

    this.id = id;
    this.worldWidthPx = worldWidthPx;
    this.worldHeightPx = worldHeightPx;
    this.payloadPx = payloadPx;

    // pagesX(mip 0) = ceil(worldWidthPx / payloadPx); each mip halves it
    // (rounding up — an image that doesn't evenly divide still gets full
    // coverage at every mip, never a truncated edge).
    //
    // Halving the PAGE COUNT iteratively is equivalent to recomputing from the
    // halved world size, because ceil(ceil(a/b)/2) === ceil(a/2b) for positive
    // integers. Worth stating: it's why the pre-rectangular code was correct and
    // why per-axis iteration stays correct here.
    //
    // The loop runs until BOTH axes reach a single page, so a very oblong image
    // (say 8000x256 -> 33x2 pages) keeps halving the long axis after the short
    // one has bottomed out at 1. Each mip still halves world RESOLUTION on both
    // axes; an axis already at one page simply stays there.
    const px0 = Math.ceil(worldWidthPx / payloadPx);
    const py0 = Math.ceil(worldHeightPx / payloadPx);
    this._pagesXByMip = [px0];
    this._pagesYByMip = [py0];
    let nx = px0;
    let ny = py0;
    while (nx > 1 || ny > 1) {
      nx = Math.ceil(nx / 2);
      ny = Math.ceil(ny / 2);
      this._pagesXByMip.push(nx);
      this._pagesYByMip.push(ny);
    }
    this.maxMip = maxMip ?? this._pagesXByMip.length - 1;

    /** @type {Map<string, {slot: number|null}>} "mip:px:py" -> entry */
    this._entries = new Map();
  }

  /** @param {number} mip @returns {number} pages along X at this mip. */
  pagesX(mip) {
    const clamped = Math.max(0, Math.min(mip, this._pagesXByMip.length - 1));
    return this._pagesXByMip[clamped];
  }

  /** @param {number} mip @returns {number} pages along Y at this mip. */
  pagesY(mip) {
    const clamped = Math.max(0, Math.min(mip, this._pagesYByMip.length - 1));
    return this._pagesYByMip[clamped];
  }

  /**
   * The canonical page key `PageCache` uses for identity. Stable, human-
   * readable (helps debugging a dumped cache state), and collision-free
   * across virtual textures because it's prefixed with `this.id`.
   * @param {number} mip @param {number} px @param {number} py @returns {string}
   */
  pageKey(mip, px, py) {
    return `${this.id}|m${mip}|${px},${py}`;
  }

  /**
   * Clamp a page coordinate into this mip's valid grid range — residency
   * queries near an image edge naturally overshoot before clamping.
   * @param {number} mip @param {number} px @param {number} py
   * @returns {[number, number]}
   */
  clampPage(mip, px, py) {
    const nx = this.pagesX(mip);
    const ny = this.pagesY(mip);
    return [Math.max(0, Math.min(px, nx - 1)), Math.max(0, Math.min(py, ny - 1))];
  }

  /**
   * Record (or clear) which atlas slot backs a page. `PageCache` owns the
   * slot's lifetime; this is just the indirection record.
   * @param {number} mip @param {number} px @param {number} py @param {number|null} slot
   */
  setSlot(mip, px, py, slot) {
    const key = `${mip}:${px}:${py}`;
    if (slot === null) {
      this._entries.delete(key);
      return;
    }
    this._entries.set(key, { slot });
  }

  /** @param {number} mip @param {number} px @param {number} py @returns {number|null} */
  getSlot(mip, px, py) {
    return this._entries.get(`${mip}:${px}:${py}`)?.slot ?? null;
  }

  /**
   * Walk from the requested mip upward until a resident page is found —
   * the automatic coarse-fallback `vtSample()` performs on the GPU (§4.1),
   * mirrored here for CPU-side residency planning/tests.
   * @param {number} mip @param {number} px @param {number} py
   * @returns {{mip:number, px:number, py:number, slot:number}|null}
   */
  finestResident(mip, px, py) {
    for (let m = mip; m <= this.maxMip; m++) {
      const scale = 1 << (m - mip);
      const mpx = Math.floor(px / scale);
      const mpy = Math.floor(py / scale);
      const slot = this.getSlot(m, mpx, mpy);
      if (slot !== null) return { mip: m, px: mpx, py: mpy, slot };
    }
    return null;
  }
}

/**
 * Pure geometry: how to pack EVERY mip level's page grid into ONE small RGBA8
 * indirection texture (the "flattened pyramid" `vtSample()` samples). Mip
 * grids are stacked vertically — mip 0 (the largest) at the top, each coarser
 * mip's grid directly below the previous. Width is mip 0's X page count;
 * height is the sum of all mips' Y page counts.
 *
 * WHY A FLATTENED PYRAMID (not a per-mip sampler array): GLSL ES 3.00 forbids
 * indexing a `sampler2D[]` by anything but a constant/dynamically-uniform
 * expression, and driver support for even the unrolled form is inconsistent on
 * exactly the weak/aging GPU class this project's whole crash campaign was
 * about (vt-sample.glsl.js's own deferred-target note flags this). A single
 * indirection texture indexed by plain `ivec2`/`int` uniform ARRAYS (fully
 * portable, no sampler-array indexing anywhere) sidesteps that entirely — and
 * the whole pyramid is tiny (for the 12000px torture world: 49 wide × 101 tall
 * = ~4949 texels ≈ 20 KB), so packing cost is negligible.
 *
 * The per-mip `{x, y, pagesX, pagesY}` origins go to the shader as uniform arrays
 * so a fragment can address any mip's grid: `texel = origin[m] + (px, py)`.
 *
 * @param {PageTable} table
 * @returns {{width:number, height:number, mipCount:number,
 *   origins: Array<{x:number, y:number, pagesX:number, pagesY:number}>}}
 */
export function computeIndirectionAtlasLayout(table) {
  const width = table.pagesX(0);
  const origins = [];
  let y = 0;
  for (let mip = 0; mip <= table.maxMip; mip++) {
    const pagesX = table.pagesX(mip);
    const pagesY = table.pagesY(mip);
    origins.push({ x: 0, y, pagesX, pagesY });
    y += pagesY;
  }
  return { width, height: y, mipCount: table.maxMip + 1, origins };
}
