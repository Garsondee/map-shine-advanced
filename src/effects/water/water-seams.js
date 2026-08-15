/**
 * HOW WATER ASKS THE MASK AUTHORITY FOR THINGS — the three seams `boot.js`
 * injects into the viewer, in one place.
 *
 * `vt/` owns water's GPU lifecycle (the jump-flood bake, the surface mesh) and
 * never reaches the mask authority itself; these closures are the whole of the
 * conversation between them. Extracted from `boot.js` 2026-07-26 when adding
 * the third one crossed that file's frozen budget — split as prep, never
 * loosen the cap (`feedback_ratchet_proactive_not_reactive`).
 *
 * ⚠️ THE THREE ASK DIFFERENT QUESTIONS AT DIFFERENT RESOLUTIONS, and conflating
 * them is precisely the mistake that cost four rounds of "the shoreline is
 * pixelated":
 *
 *   getWaterMaskGrid  → the COARSE derivation grid (≤512 long side). Correct
 *                       for the jump flood's distance field, which is
 *                       inherently low-frequency.
 *   getWaterMaskUrl   → the AUTHORED FILE, at whatever resolution it was
 *                       painted. The only path to a crisp silhouette; see
 *                       `vt/mask-image.js` and `water-render.js`.
 *   getFloorsWithWater→ provenance only, no pixels — which floors AUTHORED a
 *                       water mask, keyed on 'authored' vs 'default' rather
 *                       than on the grid being non-empty (a floor painted
 *                       entirely black HAS water authoring and must not
 *                       silently borrow the river from below).
 *
 * @module effects/water/water-seams
 */

/**
 * @param {object} args
 * @param {object} args.maskAuthority - `scene/mask-authority.js`'s instance.
 * @param {() => Array<{index:number, id:string}>|null} args.getFloors - the
 *   scene's floor list. A GETTER: the list is replaced on every scene load and
 *   floor switch, and capturing the array would pin the first scene's floors
 *   forever (trap #1 of the extraction plan, in its non-viewer form).
 * @returns {{getWaterMaskGrid: Function, getFloorsWithWater: Function, getWaterMaskUrl: Function, getWaterBackgroundItemId: Function}}
 */
export function createWaterSeams({ maskAuthority, getFloors }) {
  return {
    /** The coarse per-floor grid the body pack floods. `water` is NOT a
     * `required` kind, so unlike the outdoors seam this cannot throw — an
     * unpainted floor serves an absent-filled grid, which floods to "no shore
     * anywhere". */
    getWaterMaskGrid: (floorIndex) => maskAuthority.getDerived('water', floorIndex) ?? null,

    /** The cross-floor rule's input (Water.md §4) — see the header for why
     * this is keyed on provenance rather than on the data. */
    getFloorsWithWater: () => maskAuthority.floorsWithAuthored('water'),

    /**
     * The RESOLVED floor's authored `_Water` file, for the high-resolution
     * shoreline.
     *
     * ⚠️ Resolves the level id from the FLOOR LIST, not from whatever floor is
     * currently being viewed: on a cross-floor borrow the caller asks for a
     * LOWER floor than the viewed one, and reading the active floor's context
     * here would fetch the wrong mask in exactly the case the borrow rule
     * exists for.
     */
    getWaterMaskUrl: (floorIndex) => {
      const floors = getFloors() ?? [];
      const floor = floors.find((f) => f.index === floorIndex) ?? floors[floorIndex] ?? null;
      if (!floor?.id) return null;
      const status = maskAuthority.authoredStatus(floor.id, 'water');
      return status.source === 'authored' ? status.url : null;
    },

    /**
     * THE DEPTH-AUTHORITY MIGRATION's own seam (2026-08-15) — byte-for-byte
     * the same shape as `getSpecularBackgroundItemId`/`getWindowBackgroundItemId`.
     * The REAL drawable id `depthAuthority.rankOf` needs for THIS floor's own
     * background item, so a per-floor water surface's occlusion query asks
     * "is anything ranked above MY OWN floor's background" instead of relying
     * on paint order alone — see `water-render.js`'s own header for why paint
     * order stopped being sufficient the moment water could be borrowed onto
     * (or viewed from) a floor other than the lowest one in the composite.
     *
     * ⚠️ THE STRING IS NOT INVENTED — `foundry/scene-layers.js#
     * collectLevelTextures` builds every Level background item's id as
     * `` `level:${level.id}:background` ``, and `floor.id` here IS that SAME
     * `level.id`. Mirrors the other two background-item seams exactly.
     *
     * @param {number} floorIndex
     * @returns {string|null}
     */
    getWaterBackgroundItemId: (floorIndex) => {
      const floors = getFloors() ?? [];
      const floor = floors.find((f) => f.index === floorIndex) ?? floors[floorIndex] ?? null;
      return floor?.id ? `level:${floor.id}:background` : null;
    },
  };
}
