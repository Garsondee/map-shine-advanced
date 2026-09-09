/**
 * HOW SHINE ASKS THE MASK AUTHORITY FOR THINGS — the seams `boot.js` injects
 * into the viewer, in one place. Same shape and same reasoning as
 * `water-seams.js`; `vt/` owns the GPU lifecycle and never reaches the mask
 * authority itself, so these closures are the whole conversation between them.
 *
 * ⚠️ THE FIRST TWO ASK DIFFERENT QUESTIONS AT DIFFERENT RESOLUTIONS, and
 * conflating them is the mistake that cost water four rounds of "the
 * shoreline is pixelated" (`feedback_sdf_does_not_draw_the_edge`):
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
 * `getSpecularMaskItems` (mythica-machina-press#538/#539) is a THIRD, LATER
 * seam answering a different question entirely — "which TILES have their OWN
 * authored `_Specular` file" — see its own header for why it exists
 * alongside, not instead of, the two above.
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
 * @param {() => Array<object>} [args.getItems] - the scene's current item
 *   list, mirroring `createFluidSeams`'s own `getItems` exactly — a GETTER,
 *   for the same reason `getFloors` is one. Only `getSpecularMaskItems` reads
 *   this; omit it and that one function simply returns `[]` every time.
 * @param {(item: object) => Array<{x:number,y:number}>|null} [args.getItemCorners] -
 *   the item's world-space quad corners, same contract as `createFluidSeams`'s
 *   own parameter of the same name.
 * @param {(item: object) => number|null} [args.getItemRenderOrder] - the
 *   item's CURRENT `renderOrder`, same contract as `createFluidSeams`'s own.
 * @returns {{getSpecularMaskRect: Function, getSpecularMaskUrl: Function, getSpecularBackgroundItemId: Function, getSpecularMaskItems: Function}}
 */
export function createSpecularSeams({ maskAuthority, getFloors, getItems, getItemCorners, getItemRenderOrder }) {
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

    /**
     * TILES with their OWN authored `_Specular` file (mythica-machina-press#538)
     * — the door `getSpecularMaskUrl` cannot open, because it only ever
     * resolves a LEVEL's background item.
     *
     * ============================================================================
     * ⚠️ THE SAME BUG FLUID ALREADY FOUND AND FIXED, ONE EFFECT LATER
     * ============================================================================
     * `getSpecularMaskUrl` above is `authoredStatus(levelId, 'specular')` —
     * exactly right for metal painted into a level's own background art, and
     * exactly blind to a tile's own file: see `window-seams.js#
     * getWindowMaskItems`'s own header for the full account (the identical
     * bug, one effect over) — `authoredStatusForItem`, keyed by ITEM id
     * rather than by level id, is the fix, and `fluid-registration.js#
     * createFluidSeams` is the reference implementation this mirrors.
     *
     * ⚠️ TILE-ONLY, UNLIKE FLUID'S OWN VERSION. Specular already has a
     * shipped, working floor-level surface (`specular-surface-subsystem.js`,
     * wired through `getSpecularMaskUrl` above — a SINGLE SHARED instance for
     * the whole scene, reloaded on floor change, unlike Window's one-per-
     * floor) that many maps already rely on. Including a level's background/
     * foreground item here too would sample the SAME file through a SECOND
     * mesh, double-drawing every floor-painted shine the moment a per-tile
     * surface exists to consume this list. Tiles are a NEW population ADDED
     * beside the floor-level one, never a replacement for it —
     * `item.kind === 'tile'` is the whole of that boundary.
     *
     * @param {number} floorIndex
     * @returns {Array<{id:string, url:string, corners:Array<{x:number,y:number}>, renderOrder:number|null}>}
     */
    getSpecularMaskItems: (floorIndex) => {
      const floors = getFloors() ?? [];
      const floor = floors.find((f) => f.index === floorIndex) ?? floors[floorIndex] ?? null;
      if (!floor?.id) return [];
      if (typeof getItems !== 'function' || typeof getItemCorners !== 'function') return [];

      const out = [];
      for (const item of getItems() ?? []) {
        if (item.hidden) continue;
        if (item.kind !== 'tile') continue; // level hosts stay on the floor-level door above
        if (!Array.isArray(item.visibleOnLevelIds) || !item.visibleOnLevelIds.includes(floor.id)) continue;

        const status = maskAuthority.authoredStatusForItem(item.id, 'specular');
        if (status.source !== 'authored') continue;

        const corners = getItemCorners(item);
        if (!corners) continue; // art not resolved yet — try again next frame
        out.push({
          id: item.id,
          url: status.url,
          corners,
          renderOrder: typeof getItemRenderOrder === 'function' ? getItemRenderOrder(item) : null,
        });
      }
      return out;
    },
  };
}
