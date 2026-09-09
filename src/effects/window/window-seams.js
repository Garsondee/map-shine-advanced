/**
 * HOW WINDOW LIGHT ASKS THE MASK AUTHORITY FOR THINGS — the seams `boot.js`
 * injects into the viewer, in one place. Same shape and same reasoning as
 * `specular-seams.js`; `vt/` owns the GPU lifecycle and never reaches the
 * mask authority itself, so these closures are the whole conversation
 * between them.
 *
 * ⚠️ THE FIRST TWO ASK DIFFERENT QUESTIONS AT DIFFERENT RESOLUTIONS —
 * conflating them is the mistake that cost water four rounds of "the
 * shoreline is pixelated" (`feedback_sdf_does_not_draw_the_edge`), and
 * specular repeated the SAME split rather than the same mistake:
 *
 *   getWindowMaskRect → the COARSE derivation grid's SPEC, and only its spec.
 *                        The world rect the authored file covers, which is
 *                        what maps `positionWorld` to a mask UV. Resolution
 *                        is irrelevant to a rectangle.
 *   getWindowMaskUrl  → the AUTHORED FILE, at whatever resolution it was
 *                        painted. The only path to a crisp cookie silhouette
 *                        and the ONLY thing that carries the mask's COLOUR at
 *                        all — the grid above is extracted R-only, and for a
 *                        colour mask R is not the whole story (a blue-painted
 *                        light source has r = 0).
 *
 * `getWindowMaskItems` (mythica-machina-press#538/#539) is a THIRD, LATER
 * seam answering a different question entirely — "which TILES have their
 * OWN authored `_Window` file" — see its own header for why it exists
 * alongside, not instead of, the two above.
 *
 * @module effects/window/window-seams
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
 *   for the same reason `getFloors` is one. Only `getWindowMaskItems` reads
 *   this; omit it and that one function simply returns `[]` every time,
 *   which is the correct "no tiles wired yet" answer rather than a throw.
 * @param {(item: object) => Array<{x:number,y:number}>|null} [args.getItemCorners] -
 *   the item's world-space quad corners, same contract as `createFluidSeams`'s
 *   own parameter of the same name (resolved by the viewer, which owns the
 *   texture sizes a placement needs; null defers the item to a later frame).
 * @param {(item: object) => number|null} [args.getItemRenderOrder] - the
 *   item's CURRENT `renderOrder`, same contract as `createFluidSeams`'s own.
 * @returns {{getWindowMaskRect: Function, getWindowMaskUrl: Function, getWindowBackgroundItemId: Function, getWindowMaskItems: Function}}
 */
export function createWindowSeams({ maskAuthority, getFloors, getItems, getItemCorners, getItemRenderOrder }) {
  return {
    /**
     * The world rect the authored file covers. `window` is NOT a `required`
     * kind, so unlike the outdoors seam this cannot throw — a floor with no
     * painted window light simply serves no product and the surface stays
     * hidden.
     */
    getWindowMaskRect: (floorIndex) => {
      const spec = maskAuthority.getDerived('window', floorIndex)?.grid?.spec ?? null;
      if (!spec) return null;
      return { minX: spec.x, minY: spec.y, maxX: spec.x + spec.width, maxY: spec.y + spec.height };
    },

    /**
     * The floor's authored `_Window` file (`_Windows`/`_Structural` V2
     * aliases resolve to this same kind at discovery — see
     * `scene/mask-catalog.js`).
     *
     * ⚠️ Resolves the level id from the FLOOR LIST rather than from whatever
     * floor is currently being viewed — the same trap `specular-seams.js` and
     * `water-seams.js` both name. Only an `authored` status returns a URL: a
     * floor that never painted window light must stay dark rather than
     * inheriting a neighbour's file.
     */
    getWindowMaskUrl: (floorIndex) => {
      const floors = getFloors() ?? [];
      const floor = floors.find((f) => f.index === floorIndex) ?? floors[floorIndex] ?? null;
      if (!floor?.id) return null;
      const status = maskAuthority.authoredStatus(floor.id, 'window');
      return status.source === 'authored' ? status.url : null;
    },

    /**
     * The depth-authority migration's own seam (2026-08-05), mirroring
     * `specular-seams.js#getSpecularBackgroundItemId` exactly — the REAL
     * drawable id `depthAuthority.rankOf` needs for THIS floor's background
     * item, so the surface subsystem's expected-depth query asks "is
     * anything ranked above MY OWN background" rather than needing any
     * floor-index concept of its own.
     *
     * ⚠️ THE STRING IS NOT INVENTED — `foundry/scene-layers.js#
     * collectLevelTextures` builds every Level background item's id as
     * `` `level:${level.id}:background` `` (its own `consider('background')`
     * closure), and `floor.id` here IS that SAME `level.id` — the identical
     * mirror `getSpecularBackgroundItemId` already relies on. One string
     * assembled from a shared, real field, not a guess at a producer's shape
     * (`feedback_read_the_producer_never_invent_its_shape`).
     *
     * Returns `null` for an unresolved floor — the same "no product, stays
     * hidden" posture `getWindowMaskUrl` already has, never a fabricated id
     * that would resolve to nothing in the rank table.
     *
     * @param {number} floorIndex
     * @returns {string|null}
     */
    getWindowBackgroundItemId: (floorIndex) => {
      const floors = getFloors() ?? [];
      const floor = floors.find((f) => f.index === floorIndex) ?? floors[floorIndex] ?? null;
      return floor?.id ? `level:${floor.id}:background` : null;
    },

    /**
     * TILES with their OWN authored `_Window` file (mythica-machina-press#538)
     * — the door `getWindowMaskUrl` cannot open, because it only ever resolves
     * a LEVEL's background item.
     *
     * ============================================================================
     * ⚠️ THE SAME BUG FLUID ALREADY FOUND AND FIXED, ONE EFFECT LATER
     * ============================================================================
     * `getWindowMaskUrl` above is `authoredStatus(levelId, 'window')` — exactly
     * right for a cookie painted into a level's own background art, and
     * exactly blind to one painted on a Tile: `authoredStatus`'s own doc says
     * it is *"a convenience wrapper for the single most common case, this
     * LEVEL's own BACKGROUND file"*. `keyhole-mask-any-item-decision` already
     * settled this as standing doctrine — *every mask attaches to ANY item —
     * tile, level background, or level foreground, symmetrically, for EVERY
     * effect* — and `fluid-registration.js#createFluidSeams` is the reference
     * fix: the door for "any item" is `authoredStatusForItem`, keyed by ITEM
     * id rather than by level id.
     *
     * ⚠️ TILE-ONLY, UNLIKE FLUID'S OWN VERSION — AND DELIBERATELY SO. Fluid had
     * no pre-existing floor-level population to protect (glass tubes were
     * never a level-background effect), so its own `getFluidMaskItems` walks
     * EVERY host kind — tile, background, foreground — alike. Window already
     * has a shipped, working floor-level surface
     * (`window-surface-subsystem.js`, wired through `getWindowMaskUrl` above)
     * that many maps already rely on; including a level's background/
     * foreground item here too would build a SECOND mesh sampling the SAME
     * file for the SAME level, double-drawing every floor-painted cookie the
     * moment a per-tile surface exists to consume this list. Tiles are a NEW
     * population ADDED beside the floor-level one, never a replacement for
     * it — `item.kind === 'tile'` is the whole of that boundary.
     *
     * @param {number} floorIndex
     * @returns {Array<{id:string, url:string, corners:Array<{x:number,y:number}>, renderOrder:number|null}>}
     */
    getWindowMaskItems: (floorIndex) => {
      const floors = getFloors() ?? [];
      const floor = floors.find((f) => f.index === floorIndex) ?? floors[floorIndex] ?? null;
      if (!floor?.id) return [];
      if (typeof getItems !== 'function' || typeof getItemCorners !== 'function') return [];

      const out = [];
      for (const item of getItems() ?? []) {
        if (item.hidden) continue;
        if (item.kind !== 'tile') continue; // level hosts stay on the floor-level door above
        if (!Array.isArray(item.visibleOnLevelIds) || !item.visibleOnLevelIds.includes(floor.id)) continue;

        const status = maskAuthority.authoredStatusForItem(item.id, 'window');
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
