/**
 * HOW SHINE ASKS THE MASK AUTHORITY FOR THINGS — the seam `boot.js` injects
 * into the viewer, for Prism (mythica-machina-press#137). Same shape and same
 * reasoning as `specular-seams.js`/`water-seams.js`; `vt/` owns the GPU
 * lifecycle and never reaches the mask authority itself, so this closure is
 * the whole conversation between them.
 *
 * ============================================================================
 * TILE-ONLY, DELIBERATELY, UNLIKE SPECULAR'S OWN PAIR OF DOORS
 * ============================================================================
 * `specular-seams.js` answers TWO placement questions — a floor's own
 * background art (`getSpecularMaskUrl`/`getSpecularMaskRect`, a single
 * shared per-floor surface) AND a tile's own file (`getSpecularMaskItems`,
 * mythica-machina-press#538/#539, added ONE effect later once the floor-only
 * door proved blind to tile-authored masks). Prism v1 ships with ONLY the
 * tile door — `getPrismMaskItems` below, a direct mirror of
 * `getSpecularMaskItems` — because a gem, a stained-glass window or a
 * crystal formation is naturally something an author places as a TILE, and
 * building a second, floor-level population (a whole floor painted as
 * refractive glass) before a single tile-based one has ever been seen live is
 * exactly the kind of scope this feature's own brief asks NOT to reach for
 * tonight ("ship something coherent... rather than overreaching into
 * something you can't fully verify"). A floor-level Prism surface is a real,
 * plausible follow-up (mythica-machina-press#137's own tracker), not a gap
 * silently dropped — recorded here rather than half-built.
 *
 * @module effects/prism/prism-seams
 */

/**
 * @param {object} args
 * @param {object} args.maskAuthority - `scene/mask-authority.js`'s instance.
 * @param {() => Array<{index:number, id:string}>|null} args.getFloors - the
 *   scene's floor list. A GETTER: the list is replaced on every scene load and
 *   floor switch, and capturing the array would pin the first scene's floors
 *   forever (same contract `createSpecularSeams`'s own `getFloors` documents).
 * @param {() => Array<object>} [args.getItems] - the scene's current item
 *   list, mirroring `createSpecularSeams`'s own `getItems` exactly — a
 *   GETTER, for the same reason `getFloors` is one.
 * @param {(item: object) => Array<{x:number,y:number}>|null} [args.getItemCorners] -
 *   the item's world-space quad corners, same contract as
 *   `createSpecularSeams`'s own parameter of the same name.
 * @param {(item: object) => number|null} [args.getItemRenderOrder] - the
 *   item's CURRENT `renderOrder`, same contract as `createSpecularSeams`'s own.
 * @returns {{getPrismMaskItems: Function}}
 */
export function createPrismSeams({ maskAuthority, getFloors, getItems, getItemCorners, getItemRenderOrder }) {
  return {
    /**
     * TILES with their OWN authored `_Prism` file — the whole of Prism v1's
     * placement door (this module's own header has the "why tile-only" case).
     *
     * @param {number} floorIndex
     * @returns {Array<{id:string, url:string, corners:Array<{x:number,y:number}>, renderOrder:number|null}>}
     */
    getPrismMaskItems: (floorIndex) => {
      const floors = getFloors() ?? [];
      const floor = floors.find((f) => f.index === floorIndex) ?? floors[floorIndex] ?? null;
      if (!floor?.id) return [];
      if (typeof getItems !== 'function' || typeof getItemCorners !== 'function') return [];

      const out = [];
      for (const item of getItems() ?? []) {
        if (item.hidden) continue;
        if (item.kind !== 'tile') continue; // no floor-level door exists yet — see this module's own header
        if (!Array.isArray(item.visibleOnLevelIds) || !item.visibleOnLevelIds.includes(floor.id)) continue;

        const status = maskAuthority.authoredStatusForItem(item.id, 'prism');
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
