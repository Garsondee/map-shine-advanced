/**
 * THE CROSS-FLOOR RULE — `resolveWaterFloor`, V2's fifteen good lines
 * (`docs/planning/Water.md` §4), as a pure function with its own Node test.
 *
 * V2's hardest plumbing (Keyhole §9 risk 4) turned out to be a small, sound
 * rule buried under bespoke occluder textures and push-door setters. The
 * rule survives unchanged; only the machinery around it dissolves:
 *
 * 1. A floor with no local water borrows the nearest LOWER floor's water
 *    (never a higher one — you see water below you through a hole, never
 *    water above you through a solid ceiling).
 * 2. Borrowed water is punched out wherever upper geometry is opaque — that
 *    is a SEPARATE, later concern (a `buf:scene.attr` screen-space read at
 *    render time, Water.md §4), not this function's job. This function only
 *    decides WHICH floor's water pack to bind; visibility is the renderer's.
 * 3. A per-level override can pin a specific floor's pack outright, bypassing
 *    the resolve entirely — an input the caller supplies, never mutable
 *    state this module owns.
 *
 * This rides TIER 0 (Water.md §6): correctness never rides the ladder.
 *
 * @module effects/water/water-floor
 */

/**
 * @param {object} args
 * @param {number} args.viewedFloor - the currently viewed floor index.
 * @param {number[]} args.floorsWithWater - floor indices that have their OWN
 *   authored water mask (any order; not assumed pre-sorted).
 * @param {number|null} [args.perLevelOverride] - pins a specific floor's
 *   water pack outright, bypassing the resolve. `null`/`undefined` means "no
 *   override" — the normal viewed-floor / borrow-from-below resolve runs.
 * @returns {{floorIndex: number|null, borrowed: boolean, reason: string}}
 *   `floorIndex: null` means no water pack exists to bind at all (nothing in
 *   the scene has a water mask) — never a fabricated floor 0.
 */
export function resolveWaterFloor({ viewedFloor, floorsWithWater, perLevelOverride = null }) {
  if (perLevelOverride != null) {
    return {
      floorIndex: perLevelOverride,
      borrowed: perLevelOverride !== viewedFloor,
      reason: `per-level override pinned to floor ${perLevelOverride}`,
    };
  }

  if (!Array.isArray(floorsWithWater) || floorsWithWater.length === 0) {
    return { floorIndex: null, borrowed: false, reason: 'no floor in this scene has an authored water mask' };
  }

  if (floorsWithWater.includes(viewedFloor)) {
    return { floorIndex: viewedFloor, borrowed: false, reason: 'the viewed floor has its own water' };
  }

  const lowerFloorsWithWater = floorsWithWater.filter((f) => f < viewedFloor);
  if (lowerFloorsWithWater.length > 0) {
    const nearest = Math.max(...lowerFloorsWithWater);
    return {
      floorIndex: nearest,
      borrowed: true,
      reason: `borrowed floor ${nearest} (nearest lower floor with water)`,
    };
  }

  return {
    floorIndex: null,
    borrowed: false,
    reason: 'the viewed floor has no water, and no lower floor has water either',
  };
}
