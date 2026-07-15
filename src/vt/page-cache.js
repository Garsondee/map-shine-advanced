/**
 * @fileoverview vt/page-cache.js — the fixed-size physical page cache (Keyhole.md
 * §4.1, §0's "one law").
 *
 * This is bookkeeping only: which logical page key occupies which atlas slot,
 * and the LRU + pin-class accounting that decides what gets evicted under
 * pressure. The actual GPU resource (one `THREE.DataArrayTexture`, allocated
 * once by the caller) and the decode/upload path that fills a slot's pixels are
 * separate — `PageCache` never touches WebGL, so it is fully Node-testable.
 *
 * THE GUARANTEE this class exists to make true: `capacityPages` is fixed at
 * construction and NEVER grows, no matter how many distinct pages are ever
 * requested. A request for a page that cannot be fitted (all slots pinned) is
 * a miss (`{resident:false, slot:null}`), never a throw and never a resize —
 * "not resident" is a valid, expected state the sampler's automatic coarse-mip
 * fallback handles (worst case is blur, never a crash, never loss).
 *
 * Two pin classes are never evicted while pinned:
 *   - 'coarse' — the top mips of every layer of every floor. Guarantees the
 *     whole world always renders, just soft. Set once, effectively permanent.
 *   - 'view'   — the current visible set + guard ring. Re-pinned every frame
 *     by the residency step; pages that fall out of view are unpinned (still
 *     resident, now plain-LRU-evictable) rather than evicted immediately, so a
 *     small pan-and-back doesn't cost a re-decode.
 *
 * @module vt/page-cache
 */

/** @typedef {'coarse'|'view'} PinClass */

export class PageCache {
  /**
   * @param {object} options
   * @param {number} options.budgetBytes - fixed VRAM budget for the whole cache
   *   (Keyhole Q2: 512 MB @ 8 GB tier, scaled per tier — the caller resolves
   *   the tier, this class just enforces whatever fixed budget it's given).
   * @param {number} [options.pageBytes] - bytes per page (Keyhole Q1: 256x256
   *   RGBA8 = 256 KB/page default).
   */
  constructor({ budgetBytes, pageBytes = 256 * 1024 }) {
    if (!(budgetBytes > 0)) throw new Error('PageCache: budgetBytes must be > 0');
    if (!(pageBytes > 0)) throw new Error('PageCache: pageBytes must be > 0');

    /** @readonly */
    this.pageBytes = pageBytes;
    /** @readonly — fixed forever; this is the law made concrete. */
    this.capacityPages = Math.max(1, Math.floor(budgetBytes / pageBytes));

    /** @type {Map<string, number>} page key -> slot index */
    this._keyToSlot = new Map();
    /** @type {Array<string|null>} slot index -> page key (or null if free) */
    this._slotToKey = new Array(this.capacityPages).fill(null);
    /** @type {Array<PinClass|null>} slot index -> pin class (or null if unpinned) */
    this._pin = new Array(this.capacityPages).fill(null);
    /** @type {Array<number>} slot index -> last-used frame number, for LRU */
    this._lastUsed = new Array(this.capacityPages).fill(-1);
    /** @type {number[]} free slot indices, LIFO for O(1) pop */
    this._free = Array.from({ length: this.capacityPages }, (_, i) => this.capacityPages - 1 - i);

    this._frame = 0;
    this._evictions = 0;
    this._misses = 0;
  }

  /** Advance the frame counter the LRU clock reads. Call once per frame. */
  tick() {
    this._frame++;
  }

  /**
   * Request residency for a page. If already resident, refreshes its LRU
   * timestamp and returns its slot. If not, tries to fit it — evicting the
   * least-recently-used unpinned slot if the cache is full. Never throws;
   * never grows past `capacityPages`.
   *
   * @param {string} key - canonical page identity (see page-table.js).
   * @param {object} [opts]
   * @param {PinClass|null} [opts.pin] - pin class to apply if/when resident.
   * @returns {{resident: boolean, slot: number|null, evictedKey: string|null}}
   */
  request(key, opts = {}) {
    const pin = opts.pin ?? null;
    const existing = this._keyToSlot.get(key);
    if (existing !== undefined) {
      this._lastUsed[existing] = this._frame;
      if (pin) this._pin[existing] = pin;
      return { resident: true, slot: existing, evictedKey: null };
    }

    let slot = this._free.pop();
    let evictedKey = null;
    if (slot === undefined) {
      const victim = this._findLRUEvictable();
      if (victim === -1) {
        // Every slot is pinned — a genuine capacity exhaustion. This is a
        // miss, not a crash: the caller keeps sampling whatever coarser mip
        // is already resident (or the coarse pin) until pressure relieves.
        this._misses++;
        return { resident: false, slot: null, evictedKey: null };
      }
      evictedKey = this._slotToKey[victim];
      this._keyToSlot.delete(evictedKey);
      this._evictions++;
      slot = victim;
    }

    this._slotToKey[slot] = key;
    this._pin[slot] = pin;
    this._lastUsed[slot] = this._frame;
    this._keyToSlot.set(key, slot);
    return { resident: true, slot, evictedKey };
  }

  /**
   * Drop a page's pin (does NOT evict it — it stays resident, now plain
   * LRU-evictable, so a brief pan-and-back is free).
   * @param {string} key
   */
  unpin(key) {
    const slot = this._keyToSlot.get(key);
    if (slot !== undefined) this._pin[slot] = null;
  }

  /** @param {string} key @returns {boolean} */
  isResident(key) {
    return this._keyToSlot.has(key);
  }

  /** @param {string} key @returns {number|null} */
  slotOf(key) {
    return this._keyToSlot.has(key) ? this._keyToSlot.get(key) : null;
  }

  /** @returns {number} slot index of the LRU-evictable victim, or -1 if none (all pinned). */
  _findLRUEvictable() {
    let best = -1;
    let bestFrame = Infinity;
    for (let s = 0; s < this.capacityPages; s++) {
      if (this._pin[s]) continue; // pinned classes are never evicted
      const key = this._slotToKey[s];
      if (key === null) continue; // shouldn't happen (would be in _free), defensive
      if (this._lastUsed[s] < bestFrame) {
        bestFrame = this._lastUsed[s];
        best = s;
      }
    }
    return best;
  }

  /** @returns {{capacityPages:number, residentPages:number, pinnedCoarse:number, pinnedView:number, freePages:number, evictions:number, misses:number}} */
  stats() {
    let pinnedCoarse = 0,
      pinnedView = 0,
      resident = 0;
    for (let s = 0; s < this.capacityPages; s++) {
      if (this._slotToKey[s] !== null) resident++;
      if (this._pin[s] === 'coarse') pinnedCoarse++;
      else if (this._pin[s] === 'view') pinnedView++;
    }
    return {
      capacityPages: this.capacityPages,
      residentPages: resident,
      pinnedCoarse,
      pinnedView,
      freePages: this.capacityPages - resident,
      evictions: this._evictions,
      misses: this._misses,
    };
  }
}
