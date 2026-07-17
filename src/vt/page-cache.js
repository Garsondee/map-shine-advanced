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
 * ============================================================================
 * `coarseReservePages` — THE RESERVATION HALF OF ITEM 1b (found + fixed
 * 2026-07-17, second cut). The first cut (`residency.js#computeCoarsePinBudget`)
 * capped how many pages EACH pack ASKS for. It did nothing about ROOM: 'coarse'
 * and 'view' competed for the SAME free/evictable slots on equal footing, so a
 * scene whose current viewport genuinely needed a lot of sharp detail could
 * pin `capacityPages` worth of 'view' pages before a background-prewarmed
 * floor's 'coarse' request ever got a turn — measured live: `pinnedCoarse:342
 * + pinnedView:1706 = 2048` (100% pinned), and 3 packs' coarse requests missed
 * outright. `buildPack` asks for its coarse pin EXACTLY ONCE, at pack
 * creation — a transient loss there is a PERMANENT one, for the rest of the
 * session, which is why this needed fixing at the cache's own admission
 * policy rather than left to "try again later" (nothing ever tries again).
 *
 * The fix: 'view' requests may never push the view tier's OWN pinned-page
 * count past `capacityPages - coarseReservePages`. Refused requests are an
 * ordinary soft miss (the sampler's coarse-mip fallback already handles
 * "not resident yet" — this never throws, never evicts something the camera
 * is currently looking at). This guarantees, by construction, that at least
 * `coarseReservePages` slots are ALWAYS either coarse-pinned or genuinely free
 * — so as long as the SUM of every pack's coarse request stays within that
 * reserve (which `computeCoarsePinBudget`'s per-pack cap already ensures by
 * construction), a coarse-pin request can never structurally fail again.
 *
 * Deliberately NOT "let coarse evict an already-pinned view slot" — the
 * alternative design. That would let a background floor's coarse pin bump a
 * page the user is CURRENTLY looking at right now off the screen (a visible,
 * on-screen regression) to benefit a floor nobody is viewing. A reservation
 * that occasionally leaves the view tier a little less sharp under heavy
 * pan/zoom is the correct trade — matching this project's whole
 * predictability-over-peak-fidelity stance, not a compromise from it.
 *
 * Mutable, not constructor-only — `vt-pan-viewer.js` keeps it in lockstep with
 * `computeCoarsePinBudget`'s `totalBudgetPages`, the SAME number the per-pack
 * cap is computed from, so there is one source of truth for "how big is the
 * coarse budget," not two numbers that could drift apart.
 *
 * `coarseReservePages` defaults to 0 (today's exact prior behavior, unchanged)
 * for any caller — tests, the torture-fixture viewer — that never sets it.
 * ============================================================================
 *
 * ============================================================================
 * `onEvict` — THE DANGLING-INDIRECTION FIX (author-reported 2026-07-17: "lots
 * of weird tile artefacts... tiles of textures at the wrong scale and in the
 * wrong place appearing across the scene", under a zoom/floor thrash test).
 *
 * A slot's identity CHANGES the instant it is evicted. Anything still pointing
 * at that slot — specifically `vt-pan-viewer.js`'s per-pack indirection buffer,
 * whose whole job is `(mip, px, py) -> slot` — is now pointing at a DIFFERENT
 * page's pixels: a different mip (wrong scale), a different position (wrong
 * place), or another pack's texture entirely. It does not render as blur or
 * magenta; it renders as confident, plausible garbage.
 *
 * THE RACE THIS CLOSES, precisely (`streamPackResidency`):
 *   1. release: `cache.unpin(key)` for pages the new view no longer wants —
 *      they stay RESIDENT and are now LRU-evictable. **The pack's indirection
 *      still references them at this point.**
 *   2. `await requestDecodeUpload(...)` — yields. The render loop draws frames
 *      across this await, and evictions (this pack's own new requests, or any
 *      other pack's) reassign those very slots.
 *   3. rebuild: the indirection is finally rewritten, correct again.
 * Between 1 and 3, every drawn frame samples through pointers that may already
 * be lying. Under a thrash test — 11,608 evictions in one session — that window
 * is hit constantly.
 *
 * The release-first order is NOT the bug and must not be "fixed" by reverting
 * it: it exists to cap peak pinned pages at max(old,new) rather than old+new,
 * and reverting it reintroduces the 215k-miss bug (see streamPackResidency's
 * own comment). Two individually-correct pieces of reasoning — "unpinning is
 * safe because the page stays resident" (true, about PIN COUNT) and "the
 * indirection is rebuilt fresh every pass" (true, about the END of the pass) —
 * with an unexamined interaction between them. Neither comment was wrong; the
 * gap was that nobody asked what the indirection referenced BETWEEN them.
 *
 * So the invariant is enforced where the slot's identity actually changes,
 * rather than by reasoning about which windows are safe: **no slot is reusable
 * until every texel pointing at it has been cleared.** A cleared texel reads
 * "not resident", which the sampler's coarse-mip fallback already handles
 * correctly — blur, never another page's pixels. That is the §4.1 guarantee
 * ("not loaded yet means SOFT, not WRONG") applied to the one case that was
 * silently violating it.
 *
 * The callback fires from inside `request()`, before the slot is rebound. It
 * MUST NOT re-enter `request()`/`unpin()` — clearing a buffer texel is exactly
 * the shape of work it is for.
 * ============================================================================
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
  constructor({ budgetBytes, pageBytes = 256 * 1024, coarseReservePages = 0, onEvict = null }) {
    if (!(budgetBytes > 0)) throw new Error('PageCache: budgetBytes must be > 0');
    if (!(pageBytes > 0)) throw new Error('PageCache: pageBytes must be > 0');

    /**
     * Called with a page key the instant its slot stops backing that page and
     * becomes reusable — see this module's header (`onEvict`) for why this is a
     * correctness requirement and not a notification convenience.
     * @type {((key: string) => void)|null}
     */
    this._onEvict = onEvict;

    /** @readonly */
    this.pageBytes = pageBytes;
    /** @readonly — fixed forever; this is the law made concrete. */
    this.capacityPages = Math.max(1, Math.floor(budgetBytes / pageBytes));

    /** Backing field for the `coarseReservePages` accessor below. */
    this._coarseReservePages = 0;
    this.coarseReservePages = coarseReservePages; // through the clamping setter

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

    // Maintained incrementally (not re-scanned) so the admission check on
    // every 'view' request stays O(1) — this cache is on the hot streaming
    // path, unlike stats() below, which is diagnostics-only and can afford
    // its existing O(capacityPages) scan.
    this._pinnedViewCount = 0;
    this._pinnedCoarseCount = 0;

    this._frame = 0;
    this._evictions = 0;
    this._misses = 0;
    /** Coarse-pin requests refused by the reserve itself — see stats(). Should
     * stay 0 forever if the reserve is sized correctly; a nonzero value means
     * the reserve itself is undersized, not a normal/expected event. */
    this._coarseReserveMisses = 0;
  }

  /**
   * How many pages 'view' requests may never claim (see this module's header
   * for the full reasoning). Clamped into `[0, capacityPages]` on every
   * write — an external caller (`vt-pan-viewer.js` keeps this in sync with
   * the coarse budget every residency pass) is never trusted raw.
   * @returns {number}
   */
  get coarseReservePages() {
    return this._coarseReservePages;
  }

  /** @param {number} value */
  set coarseReservePages(value) {
    this._coarseReservePages = Math.max(0, Math.min(this.capacityPages, Math.floor(value) || 0));
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
      // Every already-resident page hits THIS branch on its next request —
      // the common case, every frame. If the reserve check below only guarded
      // brand-new slot allocations, nearly all real 'view' traffic would
      // bypass it entirely (`_setPin` still enforces coarse-never-downgrades
      // and the counter bookkeeping here, but does NOT need the reserve check
      // — this page is not consuming any NEW cache room).
      if (pin) this._setPin(existing, pin);
      return { resident: true, slot: existing, evictedKey: null };
    }

    // THE RESERVE (item 1b, reservation half — see this module's header). A
    // brand-new 'view' pin may never push the view tier's OWN pinned count
    // past its cap. A soft miss, exactly like capacity exhaustion below —
    // the sampler's coarse-mip fallback already handles "not resident yet".
    if (pin === 'view' && this._pinnedViewCount >= this.capacityPages - this.coarseReservePages) {
      this._misses++;
      return { resident: false, slot: null, evictedKey: null };
    }

    let slot = this._free.pop();
    let evictedKey = null;
    if (slot === undefined) {
      const victim = this._findLRUEvictable();
      if (victim === -1) {
        // Every slot is pinned. For 'view' this is ordinary pressure — a
        // miss, not a crash. For 'coarse' this should now be STRUCTURALLY
        // IMPOSSIBLE as long as the caller keeps `coarseReservePages` at
        // least as large as the sum of every pack's own coarse-pin cap (which
        // `residency.js#computeCoarsePinBudget` guarantees by construction) —
        // so a coarse miss here means that invariant broke, not routine
        // pressure. Counted separately (`_coarseReserveMisses`) precisely so
        // it stays visible rather than blending into the expected 'view' rate.
        this._misses++;
        if (pin === 'coarse') this._coarseReserveMisses++;
        return { resident: false, slot: null, evictedKey: null };
      }
      evictedKey = this._slotToKey[victim];
      this._keyToSlot.delete(evictedKey);
      this._evictions++;
      slot = victim;
      // THE INVARIANT: this slot's identity is about to change. Nothing may
      // still be pointing at it as `evictedKey`. Fired BEFORE the rebind below,
      // so a callback that reads cache state sees the page as already gone
      // rather than half-reassigned. See this module's header (`onEvict`).
      this._onEvict?.(evictedKey);
    }

    this._slotToKey[slot] = key;
    if (pin) this._setPin(slot, pin);
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
    if (slot === undefined) return;
    const current = this._pin[slot];
    if (current) this._adjustPinCount(current, -1);
    this._pin[slot] = null;
  }

  /**
   * Apply a pin to a slot, maintaining the incremental pin-class counters the
   * reserve admission check reads. NEVER downgrades 'coarse' to 'view' — a
   * page that has already earned coarse's permanent guarantee keeps it; a
   * view-tier request for the SAME page (the current mip happens to coincide
   * with a coarse-pinned one — routine at extreme zoom-out) is satisfied by
   * that residency as-is, not by weakening it. Without this, the two most
   * common request patterns — a steady-state view refresh, and a view
   * request that happens to land on an already-coarse page — would each
   * quietly erode the coarse guarantee this whole mechanism exists to keep.
   * @param {number} slot @param {PinClass} pin
   */
  _setPin(slot, pin) {
    const current = this._pin[slot];
    if (current === pin) return;
    if (current === 'coarse' && pin === 'view') return;
    if (current) this._adjustPinCount(current, -1);
    this._pin[slot] = pin;
    this._adjustPinCount(pin, 1);
  }

  /** @param {PinClass} pinClass @param {number} delta */
  _adjustPinCount(pinClass, delta) {
    if (pinClass === 'view') this._pinnedViewCount += delta;
    else if (pinClass === 'coarse') this._pinnedCoarseCount += delta;
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
    // GROUND TRUTH by full scan, deliberately NOT the incrementally-maintained
    // `_pinnedCoarseCount`/`_pinnedViewCount` counters the hot admission-check
    // path reads — this is a diagnostic, and a diagnostic must stay correct
    // even if the incremental bookkeeping has a bug, not silently inherit one
    // (feedback_instruments_must_not_lie). `vt-core.test.mjs` cross-checks the
    // two agree; if they ever don't, that failure is real signal.
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
      // THE RESERVE (item 1b) — how many pages 'view' may never claim, and how
      // many 'coarse' requests were refused anyway (should be 0 forever; see
      // `_coarseReserveMisses`'s own comment for what a nonzero value means).
      coarseReservePages: this.coarseReservePages,
      coarseReserveMisses: this._coarseReserveMisses,
    };
  }
}
