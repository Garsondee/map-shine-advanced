/**
 * HOW SHINE ASKS THE MASK AUTHORITY FOR THINGS — the two seams `boot.js`
 * injects into the viewer, in one place. Same shape and same reasoning as
 * `water-seams.js`; `vt/` owns the GPU lifecycle and never reaches the mask
 * authority itself, so these closures are the whole conversation between them.
 *
 * ⚠️ THE TWO ASK DIFFERENT QUESTIONS AT DIFFERENT RESOLUTIONS, and conflating
 * them is the mistake that cost water four rounds of "the shoreline is
 * pixelated" (`feedback_sdf_does_not_draw_the_edge`):
 *
 *   getSpecularMaskRect → the COARSE derivation grid's SPEC, and only its spec.
 *                         The world rect the authored file covers, which is what
 *                         maps `positionWorld` to a mask UV. Resolution is
 *                         irrelevant to a rectangle.
 *   getSpecularMaskUrl  → the AUTHORED FILE, at whatever resolution it was
 *                         painted. The only path to a crisp silhouette and the
 *                         ONLY thing that carries the mask's COLOUR at all —
 *                         the grid above is extracted R-only, and for a colour
 *                         mask R is not presence (a blue-painted steel object
 *                         has r = 0).
 *
 * @module effects/specular/specular-seams
 */

/**
 * @param {object} args
 * @param {object} args.maskAuthority - `scene/mask-authority.js`'s instance.
 * @param {() => Array<{index:number, id:string}>|null} args.getFloors - the
 *   scene's floor list. A GETTER: the list is replaced on every scene load and
 *   floor switch, and capturing the array would pin the first scene's floors
 *   forever.
 * @returns {{getSpecularMaskRect: Function, getSpecularMaskUrl: Function, getSpecularBackgroundItemId: Function}}
 */
export function createSpecularSeams({ maskAuthority, getFloors }) {
  return {
    /**
     * The world rect the authored file covers. `specular` is NOT a `required`
     * kind, so unlike the outdoors seam this cannot throw — a floor with no
     * painted metal simply serves no product and the surface stays hidden.
     */
    getSpecularMaskRect: (floorIndex) => {
      const spec = maskAuthority.getDerived('specular', floorIndex)?.grid?.spec ?? null;
      if (!spec) return null;
      return { minX: spec.x, minY: spec.y, maxX: spec.x + spec.width, maxY: spec.y + spec.height };
    },

    /**
     * The floor's authored `_Specular` file.
     *
     * ⚠️ Resolves the level id from the FLOOR LIST rather than from whatever
     * floor is currently being viewed — the same trap `water-seams.js` names.
     * Only an `authored` status returns a URL: a floor that never painted metal
     * must stay dark rather than inheriting a neighbour's file.
     */
    getSpecularMaskUrl: (floorIndex) => {
      const floors = getFloors() ?? [];
      const floor = floors.find((f) => f.index === floorIndex) ?? floors[floorIndex] ?? null;
      if (!floor?.id) return null;
      const status = maskAuthority.authoredStatus(floor.id, 'specular');
      return status.source === 'authored' ? status.url : null;
    },

    /**
     * STAGE 3 (2026-08-05) — the depth-authority migration's own seam. The
     * REAL drawable id `depthAuthority.rankOf` needs for THIS floor's
     * background item, so the surface subsystem's expected-depth query asks
     * "is anything ranked above MY OWN background" rather than needing any
     * floor-index concept of its own.
     *
     * ⚠️ THE STRING IS NOT INVENTED — `foundry/scene-layers.js#
     * collectLevelTextures` builds every Level background item's id as
     * `` `level:${level.id}:background` `` (its own `consider('background')`
     * closure), and `floor.id` here IS that SAME `level.id` —
     * `getActiveSceneFloors`'s own floor descriptor is built from the
     * identical Level document. One string assembled from a shared, real
     * field is a MIRROR (`specular-seams.test.mjs` cross-checks it against
     * `collectLevelTextures`'s actual output), not a guess at a producer's
     * shape (`feedback_read_the_producer_never_invent_its_shape`) — but it IS
     * a second place that now knows this format, so a future rename of
     * `scene-layers.js`'s own template needs this comment found first.
     *
     * Returns `null` for an unresolved floor — the same "no product, stays
     * hidden" posture `getSpecularMaskUrl` already has, never a fabricated id
     * that would resolve to nothing in the rank table.
     *
     * @param {number} floorIndex
     * @returns {string|null}
     */
    getSpecularBackgroundItemId: (floorIndex) => {
      const floors = getFloors() ?? [];
      const floor = floors.find((f) => f.index === floorIndex) ?? floors[floorIndex] ?? null;
      return floor?.id ? `level:${floor.id}:background` : null;
    },
  };
}
