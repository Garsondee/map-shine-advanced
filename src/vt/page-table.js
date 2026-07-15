/**
 * @fileoverview vt/page-table.js — per-virtual-texture page indirection
 * (Keyhole.md §4.1).
 *
 * A "virtual texture" here is one (floor × layer-pack) combination — e.g.
 * "floor 1, surface-response pack". `PageTable` computes the page grid for a
 * given world size and page payload, builds the canonical page key
 * `PageCache` uses for identity, and holds the indirection itself (mip/px/py
 * -> atlas slot) once `PageCache` has assigned one.
 *
 * In the shipped renderer this indirection becomes a tiny RGBA8 texture
 * sampled by `vtSample()` (§4.1's shared GLSL include); this module is the
 * CPU-side source of truth it's built from, and is fully Node-testable on its
 * own (no GPU touched here).
 *
 * @module vt/page-table
 */

/** Default page payload in texels (256px page - 4px border on each side = 248). */
export const DEFAULT_PAGE_PAYLOAD_PX = 248;

export class PageTable {
  /**
   * @param {object} options
   * @param {string} options.id - stable identity for this virtual texture,
   *   e.g. `"floor1:surfaceResponse"`. Used as the page-key prefix.
   * @param {number} options.worldSizePx - world-space size of this texture's
   *   finest mip, in texels (e.g. 12000 for the torture scene).
   * @param {number} [options.payloadPx] - page payload size (default 248,
   *   i.e. Keyhole Q1's 256px page minus 4px borders on each side).
   * @param {number} [options.maxMip] - highest mip level to track (each mip
   *   halves the page grid on each axis; default computed so the top mip is
   *   a single page).
   */
  constructor({ id, worldSizePx, payloadPx = DEFAULT_PAGE_PAYLOAD_PX, maxMip }) {
    if (!id) throw new Error('PageTable: id is required');
    if (!(worldSizePx > 0)) throw new Error('PageTable: worldSizePx must be > 0');

    this.id = id;
    this.worldSizePx = worldSizePx;
    this.payloadPx = payloadPx;

    // pagesPerAxis(mip 0) = ceil(worldSizePx / payloadPx); each mip halves it
    // (rounding up — a world that doesn't evenly divide still gets full
    // coverage at every mip, never a truncated edge).
    const mip0 = Math.ceil(worldSizePx / payloadPx);
    this._pagesPerAxisByMip = [mip0];
    let n = mip0;
    while (n > 1) {
      n = Math.ceil(n / 2);
      this._pagesPerAxisByMip.push(n);
    }
    this.maxMip = maxMip ?? this._pagesPerAxisByMip.length - 1;

    /** @type {Map<string, {slot: number|null}>} "mip:px:py" -> entry */
    this._entries = new Map();
  }

  /** @param {number} mip @returns {number} pages per axis at this mip (grid is square). */
  pagesPerAxis(mip) {
    const clamped = Math.max(0, Math.min(mip, this._pagesPerAxisByMip.length - 1));
    return this._pagesPerAxisByMip[clamped];
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
   * queries near a world edge naturally overshoot before clamping.
   * @param {number} mip @param {number} px @param {number} py
   * @returns {[number, number]}
   */
  clampPage(mip, px, py) {
    const n = this.pagesPerAxis(mip);
    return [Math.max(0, Math.min(px, n - 1)), Math.max(0, Math.min(py, n - 1))];
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
