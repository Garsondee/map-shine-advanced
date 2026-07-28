/**
 * HOW WINDOW LIGHT ASKS THE MASK AUTHORITY FOR THINGS — the two seams
 * `boot.js` injects into the viewer, in one place. Same shape and same
 * reasoning as `specular-seams.js`; `vt/` owns the GPU lifecycle and never
 * reaches the mask authority itself, so these closures are the whole
 * conversation between them.
 *
 * ⚠️ THE TWO ASK DIFFERENT QUESTIONS AT DIFFERENT RESOLUTIONS — conflating
 * them is the mistake that cost water four rounds of "the shoreline is
 * pixelated" (`feedback_sdf_does_not_draw_the_edge`), and specular repeated
 * the SAME split rather than the same mistake:
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
 * @module effects/window/window-seams
 */

/**
 * @param {object} args
 * @param {object} args.maskAuthority - `scene/mask-authority.js`'s instance.
 * @param {() => Array<{index:number, id:string}>|null} args.getFloors - the
 *   scene's floor list. A GETTER: the list is replaced on every scene load and
 *   floor switch, and capturing the array would pin the first scene's floors
 *   forever.
 * @returns {{getWindowMaskRect: Function, getWindowMaskUrl: Function}}
 */
export function createWindowSeams({ maskAuthority, getFloors }) {
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
  };
}
