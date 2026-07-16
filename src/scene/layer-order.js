/**
 * @fileoverview scene/layer-order.js — THE LAYERING LAW.
 *
 * One comparator decides the paint order of every drawable in the scene: level
 * background art, level foreground (roof) art, tiles, tokens, drawings,
 * weather, and every MSA effect that will ever exist. There is exactly one
 * ordering rule in this renderer, and it lives here.
 *
 * ## Why this is Foundry's comparator and not our own
 *
 * This is `PrimaryCanvasGroup._compareObjects` (client/canvas/groups/primary.mjs
 * :480 in the vendored v14 source), replicated deliberately rather than
 * approximated:
 *
 *     (elevation) → (sortLayer) → (sort) → (zIndex) → (tiebreak)
 *
 * Adopting it verbatim buys three things that inventing our own does not:
 *
 * 1. **Foundry's documents already carry correct values.** A Tile document has
 *    a real `elevation` and `sort` the author set in the UI. A Level places its
 *    background at `elevation.bottom` and its foreground at `elevation.top`.
 *    We read those numbers; we don't translate them into a private scheme and
 *    hope the translation stays faithful.
 * 2. **"Foreground tiles" cost zero code.** Foundry deleted the `overhead` and
 *    `roof` booleans in v12 (`migrateOverheadTiles`: `if (tile.overhead)
 *    tile.elevation = foregroundElevation` — the flag was converted to a number
 *    and dropped). A tile is "overhead in the Foreground" iff its elevation
 *    reaches the Level's `elevation.top`. Sorting by real elevation reproduces
 *    that automatically:
 *
 *        elev  0 │ Level background   (SCENE=0)
 *        elev  3 │ Tile: rug          (TILES=500)
 *        elev  5 │ Token              (TOKENS=700)
 *        elev 10 │ Level foreground   (SCENE=0)    ← the roof image
 *        elev 10 │ Tile: chimney      (TILES=500)  ← "foreground tile"; SCENE<TILES breaks the tie
 *
 *    The token at 5 is under the roof at 10 because 5 < 10. Nothing is flagged.
 * 3. **Parity is checkable.** When MSA's stack disagrees with Foundry's, the
 *    diff is in the key we computed, not in a bespoke policy nobody can compare
 *    against a reference.
 *
 * ## Why this replaces legacy's banded renderOrder
 *
 * `legacy/compositor-v2/LayerOrderPolicy.js` packed (floor, role, intra-role)
 * into a single number: `floorIndex * 10000 + ROLE_OFFSETS[role] + intra`, with
 * 2400 slots per role band. That scheme has three structural problems this one
 * doesn't:
 *
 * - **Fixed capacity.** 2400 intra-role slots and 5 hardcoded roles. The author's
 *   stated trajectory is "a huge number of effects on lots of floors"; a scheme
 *   with a hard slot count per role is a ceiling waiting to be hit, and its
 *   failure mode is silent (band bleed = an effect paints in the wrong role).
 * - **Floor index is not elevation.** Bands key off a 0..N floor ordinal, so
 *   there is no place to express "this roof sits at elevation 10" or "this tile
 *   is 3 units above the floor". Foundry's own data is elevation-based; the
 *   band scheme cannot represent it without a lossy mapping.
 * - **New role = new enum entry + a band reshuffle.** Here, a new effect picks
 *   an (elevation, sortLayer, sort) and is done.
 *
 * ## No arithmetic packing — sort the list, then number it
 *
 * We do NOT encode the key into a single scalar. We sort the draw list with the
 * comparator and assign `renderOrder = index` (Three.js paints ascending
 * renderOrder; with `depthTest:false` + `transparent:true` that IS the painter's
 * algorithm). This is exactly Foundry's own mechanism — `sortChildren()` sorts,
 * PIXI paints in child order. There is no band to overflow because there are no
 * bands: N drawables produce renderOrders 0..N-1, whatever N is.
 *
 * @module scene/layer-order
 */

/**
 * Coarse role bands that break ties WITHIN one elevation.
 *
 * The first five are Foundry's own `PrimaryCanvasGroup.SORT_LAYERS` values,
 * copied verbatim (primary.mjs:41) — they must stay numerically identical or
 * MSA's stack silently diverges from the reference renderer.
 *
 * The gaps between them are Foundry's to leave and ours to use: MSA effects
 * claim the space between two Foundry layers so an effect can be ordered
 * relative to the content it decorates without disturbing anything Foundry
 * places. The convention for a new effect is to pick the band it belongs
 * *above*, never to renumber an existing entry.
 *
 * @enum {number}
 */
export const SORT_LAYERS = Object.freeze({
  /** Foundry: Level background and foreground (roof) full-canvas art. */
  SCENE: 0,
  /** MSA: effects painted on the scene art but beneath tiles (e.g. ground decals). */
  SCENE_EFFECTS: 250,
  /** Foundry: Tile documents. */
  TILES: 500,
  /** MSA: per-tile overlays that must sit directly on their tile (specular, iridescence). */
  TILE_EFFECTS: 550,
  /** Foundry: Drawing documents. */
  DRAWINGS: 600,
  /** Foundry: Token documents. */
  TOKENS: 700,
  /** MSA: effects above tokens but below weather (canopies, token-anchored FX). */
  TOKEN_EFFECTS: 750,
  /** Foundry: weather particles. */
  WEATHER: 1000,
});

/**
 * Numeric compare that is safe for the ±Infinity elevations Foundry really
 * produces, and equivalent to Foundry's subtraction for every finite case.
 *
 * `Level#prepareBaseData` (client/documents/level.mjs:62) does
 * `elevation.bottom ??= -Infinity; elevation.top ??= Infinity`, so infinite
 * elevations are normal data, not an edge case. Foundry's own comparator writes
 * `(a.elevation || 0) - (b.elevation || 0)`, which yields `NaN` when both sides
 * are `Infinity` — that NaN is falsy, so `||` falls through to the next term and
 * it accidentally behaves correctly. Relying on a NaN-is-falsy accident in the
 * one function that orders every pixel on screen is not a foundation; this is
 * explicit and produces identical results:
 *
 *   - equal (including Infinity === Infinity)  → 0, fall through to next term
 *   - -Infinity vs 5                           → negative, a first
 *   - -Infinity vs Infinity                    → negative, a first
 *
 * @param {number} a
 * @param {number} b
 * @returns {number} negative if a<b, positive if a>b, 0 if equal
 */
function compareNumbers(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * @typedef {object} LayerKey
 * @property {number} elevation - world elevation in scene distance units. THE
 *   primary axis: floors are elevation bands, not indices.
 * @property {number} sortLayer - coarse role band, see {@link SORT_LAYERS}.
 * @property {number} sort - the author-controlled sort value from the document
 *   (Tile#sort, or the Level's index for level art).
 * @property {number} zIndex - fine ordering within one (elevation, sortLayer,
 *   sort). Foundry uses it to put a Level's foreground (1) above its background
 *   (0) when a zero-height Level puts both at the same elevation.
 * @property {number} tiebreak - final, total-order guarantee. Assigned from
 *   registration order by {@link sortByLayer} so the result is deterministic
 *   rather than dependent on sort stability.
 */

/**
 * Normalize a partial key into a complete {@link LayerKey}. Every field is
 * optional except `elevation`; the defaults match what Foundry's `|| 0`
 * coercion produces for an absent field.
 *
 * @param {Partial<LayerKey> & {elevation: number}} key
 * @returns {LayerKey}
 */
export function makeLayerKey({ elevation, sortLayer = 0, sort = 0, zIndex = 0, tiebreak = 0 }) {
  if (typeof elevation !== 'number' || Number.isNaN(elevation)) {
    throw new Error(`layer-order: elevation must be a number (got ${elevation})`);
  }
  return { elevation, sortLayer, sort, zIndex, tiebreak };
}

/**
 * THE LAW. Replicates `PrimaryCanvasGroup._compareObjects` exactly (see this
 * module's header for the source citation and the rationale).
 *
 * @param {LayerKey} a
 * @param {LayerKey} b
 * @returns {number} negative if `a` paints first (below), positive if `b` does.
 */
export function compareLayerKeys(a, b) {
  return (
    compareNumbers(a.elevation, b.elevation) ||
    compareNumbers(a.sortLayer, b.sortLayer) ||
    compareNumbers(a.sort, b.sort) ||
    compareNumbers(a.zIndex, b.zIndex) ||
    compareNumbers(a.tiebreak, b.tiebreak)
  );
}

/**
 * Sort drawables into paint order (first element paints first, i.e. furthest
 * back) and stamp each one's final position.
 *
 * `tiebreak` is assigned from the input array's order BEFORE sorting, which is
 * what makes the result a genuine total order: two drawables that are equal on
 * all four real components still have a defined, stable, reproducible
 * relationship. This matters more than it looks — an unstable z-order between
 * two coincident quads is a flicker bug that only reproduces on some frames, on
 * some machines, and is miserable to diagnose. Foundry does the same thing with
 * `_lastSortedIndex`.
 *
 * Returns a new array; the input is not reordered. Each returned item is the
 * caller's own object (not a copy), with `renderOrder` set to its index — so
 * the caller can do `for (const it of sortByLayer(items)) it.mesh.renderOrder =
 * it.renderOrder`, or just read the array order.
 *
 * @template {{key: LayerKey}} T
 * @param {T[]} items - drawables, each carrying a `key`.
 * @returns {T[]} the same objects, sorted back-to-front, each with `renderOrder`.
 */
export function sortByLayer(items) {
  const decorated = items.map((item, index) => {
    item.key.tiebreak = index;
    return item;
  });
  decorated.sort((a, b) => compareLayerKeys(a.key, b.key));
  for (let i = 0; i < decorated.length; i++) decorated[i].renderOrder = i;
  return decorated;
}

/**
 * True when a drawable at `elevation` sits at or above a Level's Foreground
 * Elevation — i.e. it is what the Foundry UI calls "overhead in the Foreground"
 * (the Tile sheet's Overhead tab wording) and what older Foundry called an
 * overhead/roof tile.
 *
 * This exists to make the *diagnosis* legible ("is this tile a roof?" in a
 * report), NOT because rendering branches on it — {@link compareLayerKeys}
 * already puts such a tile above the roof art with no special case. If you ever
 * find yourself gating render behavior on this, the sort key is wrong instead.
 *
 * @param {number} elevation - the drawable's elevation.
 * @param {{top: number}} levelElevation - the Level's `elevation` (top may be Infinity).
 * @returns {boolean}
 */
export function isInForeground(elevation, levelElevation) {
  return elevation >= levelElevation.top;
}
