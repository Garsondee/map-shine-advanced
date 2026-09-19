/**
 * HOW SHINE ASKS THE MASK AUTHORITY FOR THINGS — the seam `boot.js` injects
 * into the viewer, for Iridescence (mythica-machina-press#136). Same shape
 * and same reasoning as `prism-seams.js` (built the same night for the
 * identical reason) and `specular-seams.js` before it; `vt/` owns the GPU
 * lifecycle and never reaches the mask authority itself, so this closure is
 * the whole conversation between them.
 *
 * ============================================================================
 * TILE-ONLY, DELIBERATELY, MIRRORING PRISM'S OWN SCOPE BOUNDARY
 * ============================================================================
 * `getIridescenceMaskItems` below is a direct mirror of `getPrismMaskItems` —
 * a soap-bubble sheen or a holographic panel is naturally something an author
 * places as a TILE, and building a second, floor-level population before a
 * single tile-based one has ever been seen live is exactly the scope
 * `prism-seams.js`'s own header already declined for the identical reason. A
 * floor-level Iridescence surface is a real, plausible follow-up
 * (mythica-machina-press#136's own tracker), not a gap silently dropped.
 *
 * @module effects/iridescence/iridescence-seams
 */

/**
 * @param {object} args
 * @param {object} args.maskAuthority - `scene/mask-authority.js`'s instance.
 * @param {() => Array<{index:number, id:string}>|null} args.getFloors - the
 *   scene's floor list. A GETTER — same contract `createPrismSeams`'s own
 *   `getFloors` documents.
 * @param {() => Array<object>} [args.getItems] - the scene's current item
 *   list, mirroring `createPrismSeams`'s own `getItems` exactly.
 * @param {(item: object) => Array<{x:number,y:number}>|null} [args.getItemCorners] -
 *   the item's world-space quad corners, same contract as `createPrismSeams`'s own.
 * @param {(item: object) => number|null} [args.getItemRenderOrder] - the
 *   item's CURRENT `renderOrder`, same contract as `createPrismSeams`'s own.
 * @returns {{getIridescenceMaskItems: Function}}
 */
export function createIridescenceSeams({ maskAuthority, getFloors, getItems, getItemCorners, getItemRenderOrder }) {
  return {
    /**
     * TILES with their OWN authored `_Iridescence` file — the whole of
     * Iridescence v1's placement door (this module's own header has the "why
     * tile-only" case).
     *
     * @param {number} floorIndex
     * @returns {Array<{id:string, url:string, corners:Array<{x:number,y:number}>, renderOrder:number|null}>}
     */
    getIridescenceMaskItems: (floorIndex) => {
      const floors = getFloors() ?? [];
      const floor = floors.find((f) => f.index === floorIndex) ?? floors[floorIndex] ?? null;
      if (!floor?.id) return [];
      if (typeof getItems !== 'function' || typeof getItemCorners !== 'function') return [];

      const out = [];
      for (const item of getItems() ?? []) {
        if (item.hidden) continue;
        if (item.kind !== 'tile') continue; // no floor-level door exists yet — see this module's own header
        if (!Array.isArray(item.visibleOnLevelIds) || !item.visibleOnLevelIds.includes(floor.id)) continue;

        const status = maskAuthority.authoredStatusForItem(item.id, 'iridescence');
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
