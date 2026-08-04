/**
 * @fileoverview scene/depth-authority.js — THE DEPTH AUTHORITY (docs/planning/
 * Depth-Buffer.md), stage 1 of the redesign that replaces `vt/scene-attr.js`'s
 * light-elevation gate (docs/planning/Light-Elevation-Occlusion-Failure.md).
 *
 * ============================================================================
 * THE ONE IDEA
 * ============================================================================
 * A drawable's RANK is its own position in {@link module:scene/layer-order}'s
 * existing total order — the SAME `sortByLayer` every drawable already goes
 * through to decide paint order. Nothing new is being invented here: Foundry's
 * comparator (elevation → sortLayer → sort → zIndex → tiebreak) is ALREADY a
 * total order over "what's on top of what"; this module just makes that order
 * queryable as a number, instead of only usable as a paint sequence.
 *
 * Comparing two ranks answers "is this surface above that one" directly:
 * `rankOf(higherThing) > rankOf(lowerThing)`. No quantization, no per-floor
 * frame of reference, no sentinel for "never configured" — a light that has
 * never had its elevation touched sits at its own real, low, comparable rank,
 * the same as everything else. See the design doc's own audit for the full
 * argument against the model this replaces.
 *
 * ============================================================================
 * WHY A QUERY KEY'S OWN RANK IS THE RANK OF THE LAST REAL ITEM AT-OR-BELOW IT
 * (read this before changing `rankOfKey`'s search direction)
 * ============================================================================
 * {@link rankOfKey} answers "where would this key sit in the order" for a key
 * that does NOT belong to any real drawable (a light's elevation, most of the
 * time — a Foundry light is not itself part of the sorted draw list). The
 * naive approach — "count how many real items sort before it" — is WRONG, and
 * it is wrong in the specific way that would have reintroduced the class of
 * bug this whole module exists to delete.
 *
 * A count-based rank very often lands EXACTLY ON a real item's own rank
 * value. Concretely: three real items at ranks 0, 1, 2; a query key sitting
 * between rank 1 and rank 2 gets `count = 2` — which is the SAME integer as
 * the real item at rank 2. Comparing `receiverRank > queryRank` with
 * `receiverRank = 2` and `queryRank = 2` is `2 > 2 = false` — the genuinely
 * higher item silently fails to read as "above". This is not a rare edge
 * case; it is the ORDINARY case, since a query almost always sits adjacent to
 * some real item.
 *
 * The fix: define a query key's rank as the RANK OF THE LAST REAL ITEM AT OR
 * BEFORE IT (`bisectRank`, below) — a genuine index a real item actually
 * owns, never a synthetic count. Two consequences fall out for free, and both
 * are load-bearing, not incidental:
 *
 *   - **A receiver tied with the query (same elevation) reads as "at", not
 *     "above".** `rankOfElevation` deliberately builds its query key with
 *     `sortLayer/sort/zIndex` all at `+Infinity`, so it sorts AFTER every
 *     real item that shares its elevation — meaning the query's OWN rank
 *     equals that of the LAST same-elevation item, and `receiverRank >
 *     queryRank` for that same item is `false`. A torch standing on its own
 *     floor's ground is not occluded by that ground.
 *   - **The very next real item above the query rank correctly reads as
 *     above.** Its own rank is strictly greater than the last at-or-below
 *     item's rank (ranks are a dense 0..N-1 sequence with no gaps), so
 *     `receiverRank > queryRank` is `true` exactly where it should be.
 *
 * A query key that sorts before every real item (nothing exists at or below
 * it — a light authored beneath the scene's own lowest surface) has no "last
 * item at or before it" to borrow a rank from; {@link BELOW_EVERYTHING} is
 * that case, and it is deliberately a real, comparable ordinal — one rank
 * below the lowest real item (-1) — not an escape-hatch magic number. Every
 * real item's rank (>= 0) reads as strictly above it, which is the correct,
 * if degenerate, physical answer: something below the entire scene is
 * beneath everything in it.
 *
 * @module scene/depth-authority
 */

import { sortByLayer, compareLayerKeys, makeLayerKey } from './layer-order.js';

/**
 * The rank one below the lowest real item — see this module's own header,
 * "WHY A QUERY KEY'S OWN RANK IS..." for why this is a genuine ordinal, not a
 * sentinel to special-case downstream. `receiverRank > BELOW_EVERYTHING` is
 * `true` for every real rank (0, 1, 2, ...), so no caller needs a branch.
 */
export const BELOW_EVERYTHING = -1;

/**
 * Binary-search `sorted` (ascending by `compareLayerKeys`) for the LAST index
 * whose own key compares at-or-before `queryKey`. Pure array/comparator
 * search — no dependency on what the items themselves are.
 *
 * @param {Array<{key: object}>} sorted - ascending by `compareLayerKeys(item.key, ...)`.
 * @param {object} queryKey - a `makeLayerKey`-shaped key (need not belong to any real item).
 * @returns {number} the index of the last item at-or-before `queryKey`, or
 *   {@link BELOW_EVERYTHING} if every item sorts strictly after it.
 */
function bisectRank(sorted, queryKey) {
  if (sorted.length === 0) return BELOW_EVERYTHING;
  if (compareLayerKeys(sorted[0].key, queryKey) > 0) return BELOW_EVERYTHING;
  let lo = 0;
  let hi = sorted.length - 1;
  // Invariant: sorted[lo].key <= queryKey (already true — checked above for
  // lo=0 and re-established every iteration below).
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (compareLayerKeys(sorted[mid].key, queryKey) <= 0) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Build a query key that sorts AFTER every real item sharing its elevation —
 * see this module's own header for why that is the correct tie polarity for
 * an occlusion question ("is the receiver above the light", never "is it
 * merely level with it"). `sortLayer`/`sort`/`zIndex` at `+Infinity` is valid
 * input to `makeLayerKey`/`compareLayerKeys` (`compareNumbers` handles
 * `Infinity` as an ordinary — if extreme — numeric value; nothing in this
 * codebase's own `sortLayer` enum, capped at `WEATHER = 1000`, could ever tie
 * with it).
 *
 * @param {number} elevation
 * @returns {object} a `LayerKey`.
 */
function maximalKeyAtElevation(elevation) {
  return makeLayerKey({ elevation, sortLayer: Infinity, sort: Infinity, zIndex: Infinity, tiebreak: Infinity });
}

/**
 * Create a depth authority instance. Stateful (the whole point — it is the
 * canonical, rebuildable ranking of "everything currently drawn"), so this is
 * a factory, not a bag of pure functions — the same shape
 * `scene/mask-authority.js#createMaskAuthority` already uses for the sibling
 * "one place every effect asks" pattern (docs/planning/Depth-Buffer.md §6).
 *
 * No injected dependencies: unlike the mask authority (which reads image
 * pages), this module touches nothing outside its own arguments — no Foundry
 * global, no THREE, no GPU. The GPU-facing half lives in `vt/scene-depth.js`.
 *
 * @returns {{
 *   rebuild: (items: Array<{key: object, id?: string, floorIndex?: number}>) => void,
 *   rankOf: (item: object) => number|null,
 *   rankOfKey: (layerKey: object) => number,
 *   rankOfElevation: (elevation: number) => number,
 *   floorOfRank: (rank: number) => number|null,
 *   maxRank: number,
 *   size: number,
 * }}
 */
export function createDepthAuthority() {
  /** @type {Array<{key: object, id?: string, floorIndex?: number, renderOrder: number}>} */
  let sorted = [];
  /** @type {Map<string, number>} */
  let rankById = new Map();
  /** @type {WeakMap<object, number>} */
  let rankByRef = new WeakMap();

  /**
   * Re-sort the current drawable set and publish a fresh rank table. Call
   * this once per frame (or whenever the draw list changes) — cheap even for
   * a large scene, the same cost `sortByLayer` already pays every frame for
   * paint order; this IS that sort, not a second one.
   *
   * **Returns the sorted array — a deliberate drop-in replacement for a bare
   * `sortByLayer(items)` call**, so a real caller (`vt-pan-viewer.js`'s own
   * draw-list build) gets paint order AND a rebuilt rank table from ONE sort,
   * never two. This is also what makes the depth authority genuinely LIVE
   * rather than a second, parallel, unreachable structure
   * (`tools/verify-structure.mjs`'s `graph/reachable-from-boot` ratchet: an
   * authority nothing calls is exactly the "wall built and never wired"
   * failure this repo's own structure gate exists to catch).
   *
   * ⚠️ MUTATES the input items — `sortByLayer`'s own contract, inherited
   * unchanged (it stamps `.renderOrder` and `.key.tiebreak` on the caller's
   * own objects, never copies). Passing the SAME objects vt-pan-viewer's
   * paint order already sorts is the intended use, not a coincidence to
   * guard against — the depth authority and the painter's algorithm agreeing
   * exactly is the entire premise (`docs/planning/Depth-Buffer.md` §1).
   *
   * @param {Array<{key: object, id?: string, floorIndex?: number}>} items
   * @returns {Array<object>} the same items, sorted ascending by rank, each
   *   with `.renderOrder` stamped — identical to `sortByLayer(items)`'s own
   *   return.
   */
  function rebuild(items) {
    const list = Array.isArray(items) ? items.slice() : [];
    // ⚠️ `sortByLayer` returns the SORTED array — it does NOT sort `list` in
    // place (it maps to a new decorated array internally, sorts THAT, and
    // returns it; only the per-item `.renderOrder`/`.key.tiebreak` STAMPS
    // land on the shared item objects, never the array's own order). A first
    // draft called `sortByLayer(list)` and discarded the return value, then
    // used the still-unsorted `list` as `sorted` — every item's OWN
    // `.renderOrder` was still correct (so `rankOf` looked right), but
    // `bisectRank`'s binary search assumes `sorted` is actually ascending,
    // and silently returned garbage for any input not coincidentally already
    // sorted. A hand-written test with 3 pre-sorted items never caught it —
    // only a fuzz test feeding genuinely shuffled input did
    // (`depth-authority.test.mjs`'s own fuzz block).
    sorted = sortByLayer(list);
    rankById = new Map();
    rankByRef = new WeakMap();
    for (const item of sorted) {
      const rank = item.renderOrder;
      if (typeof item?.id === 'string' && item.id.length > 0) rankById.set(item.id, rank);
      rankByRef.set(item, rank);
    }
    return sorted;
  }

  /**
   * A REAL, already-rebuilt drawable's own rank. O(1) — resolved once at
   * {@link rebuild} time, not re-derived here.
   *
   * Looked up by `item.id` first (stable across a residency rebuild that
   * recreates item objects with the same id — the SAME identity convention
   * `onFluidRenderOrderResolver`'s own lookup already relies on), falling
   * back to object identity for an id-less item.
   *
   * @param {object} item
   * @returns {number|null} the rank, or `null` if this exact item (by id or
   *   by reference) was not part of the most recent {@link rebuild} — a
   *   caller bug or a stale reference, never a value to guess at. Fail-open
   *   is the CALLER's decision (matching `computeFloorAttrValues`'s own
   *   established posture), not this function's.
   */
  function rankOf(item) {
    if (!item) return null;
    if (typeof item.id === 'string' && item.id.length > 0) {
      const byId = rankById.get(item.id);
      if (byId !== undefined) return byId;
    }
    const byRef = rankByRef.get(item);
    return byRef === undefined ? null : byRef;
  }

  /**
   * The rank a hypothetical drawable with this exact key would occupy — see
   * this module's own header for the tie-breaking rule this implements.
   *
   * @param {object} layerKey - a `makeLayerKey`-shaped key.
   * @returns {number} a real item's rank, or {@link BELOW_EVERYTHING}.
   */
  function rankOfKey(layerKey) {
    return bisectRank(sorted, layerKey);
  }

  /**
   * THE SENTINEL KILLER (docs/planning/Depth-Buffer.md §6). A light/effect's
   * rank purely from its elevation — no "unconfigured" branch, because there
   * is nothing left to special-case: elevation 0 (Foundry's own schema
   * default, "never touched") is an ordinary, low, real elevation, and it
   * resolves to an ordinary, low, real rank via the exact same path as any
   * other number. A light nobody has ever opened the Advanced tab for is
   * therefore occluded by anything genuinely above it, with zero authoring
   * required — this is the fix for
   * `docs/planning/Light-Elevation-Occlusion-Failure.md`'s symptom 1.
   *
   * @param {number} elevation - raw world-elevation units (a Foundry
   *   document's own field — the same raw number `foundry/scene-lights.js#
   *   deriveLightSnapshot` already reads, never fractionalised beforehand).
   * @returns {number} a real item's rank, or {@link BELOW_EVERYTHING}.
   */
  function rankOfElevation(elevation) {
    return bisectRank(sorted, maximalKeyAtElevation(elevation));
  }

  /**
   * Which floor the item AT this rank belongs to — a pure pass-through of
   * whatever `floorIndex` the caller already attached to that item when it
   * built the list handed to {@link rebuild}. This module does not resolve
   * floor membership itself; `scene/layer-order.js#resolveElevationFloorIndex`
   * / an item's own `levelId` ownership already does that (`vt/scene-attr.js#
   * computeFloorAttrValues`), and re-deriving it here would be a second,
   * divergence-prone floor-index scheme — exactly what this codebase's own
   * `feedback_read_the_producer_never_invent_its_shape` warns against.
   *
   * @param {number} rank
   * @returns {number|null} the floor index, or `null` for an out-of-range
   *   rank (including {@link BELOW_EVERYTHING}) or an item with no
   *   `floorIndex` attached.
   */
  function floorOfRank(rank) {
    if (!Number.isInteger(rank) || rank < 0 || rank >= sorted.length) return null;
    const floorIndex = sorted[rank]?.floorIndex;
    return typeof floorIndex === 'number' ? floorIndex : null;
  }

  return {
    rebuild,
    rankOf,
    rankOfKey,
    rankOfElevation,
    floorOfRank,
    /**
     * The normalisation divisor for writing a rank into a GPU depth
     * attachment as a float in [0,1) — `rank / maxRank`. `Math.max(1, ...)`
     * so an empty scene never divides by zero (the quotient is meaningless
     * then anyway; nothing is drawn to normalise). NOT used for any CPU-side
     * comparison — ranks compare directly as integers there.
     * @returns {number}
     */
    get maxRank() {
      return Math.max(1, sorted.length);
    },
    /** How many real items the last {@link rebuild} published. @returns {number} */
    get size() {
      return sorted.length;
    },
  };
}
