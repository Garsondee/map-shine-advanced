/**
 * @fileoverview Per-frame snapshot of Levels / floor-stack state for lighting and shadows.
 *
 * Centralizes facts that were previously re-read ad hoc inside `LightingEffectV2` and
 * can later be consumed by shadow passes and other effects for consistent
 * multi-floor behavior (see planning doc: lighting/shadow coordination).
 *
 * @module compositor-v2/LightingPerspectiveContext
 */

/**
 * @typedef {Readonly<{
 *   floorCount: number,
 *   topFloorIndex: number,
 *   activeFloorIndex: number,
 *   isMultiFloor: boolean,
 *   isActiveFloorBelowTop: boolean,
 *   activeLevelBottom: number|null,
 *   activeLevelTop: number|null,
 *   activeCompositorKey: string|null,
 *   getRoofScreenOcclusionScale: (restrictOcclusionToTopFloorOnly: boolean) => number,
 *   getRoofScreenOcclusionScaleForFloor: (floorIndex: number, restrictOcclusionToTopFloorOnly: boolean) => number
 * }>} LightingPerspectiveContext
 */

/**
 * Build a frozen context from current `MapShine` globals (floor stack + active level band).
 * Safe to call every frame; has no side effects.
 *
 * `FloorCompositor.render` assigns the result to `_lightingPerspectiveContext` **before**
 * overhead/building shadow passes so any effect in that frame can read the same snapshot
 * as `LightingEffectV2` (via `setLightingPerspectiveContext`).
 *
 * @returns {LightingPerspectiveContext}
 */
export function createLightingPerspectiveContext() {
  const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
  const activeFloor = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
  const floorCount = Array.isArray(floors) ? floors.length : 0;
  const topFloorIndex = Math.max(0, floorCount - 1);

  let activeFloorIndex = 0;
  if (typeof activeFloor?.index === 'number' && Number.isFinite(activeFloor.index)) {
    activeFloorIndex = activeFloor.index;
  }

  const isMultiFloor = floorCount > 1;
  const isActiveFloorBelowTop = isMultiFloor && activeFloorIndex < topFloorIndex;

  const lvl = window.MapShine?.activeLevelContext ?? null;
  const activeLevelBottom = Number(lvl?.bottom);
  const activeLevelTop = Number(lvl?.top);
  const hasBand = Number.isFinite(activeLevelBottom) && Number.isFinite(activeLevelTop);

  const activeCompositorKey = activeFloor?.compositorKey != null
    ? String(activeFloor.compositorKey)
    : null;

  /**
   * When `restrictOcclusionToTopFloorOnly` is true (user default in LightingEffectV2),
   * screen-space roof gating must not apply on lower floors of a multi-floor map —
   * upper-floor roof stamps would incorrectly suppress downstairs lights/shadows.
   * @param {boolean} restrictOcclusionToTopFloorOnly
   * @returns {number} 0 or 1
   */
  /**
   * Screen-space roof / ceiling gating scale for a specific scene floor index.
   * Used by per-level passes (e.g. WindowLightEffectV2) where the slice being lit
   * may differ from the UI active floor.
   * @param {number} floorIndex
   * @param {boolean} restrictOcclusionToTopFloorOnly
   * @returns {number} 0 or 1
   */
  const getRoofScreenOcclusionScaleForFloor = (floorIndex, restrictOcclusionToTopFloorOnly) => {
    const restrict = restrictOcclusionToTopFloorOnly === true;
    const fi = Number(floorIndex);
    const idx = Number.isFinite(fi) ? fi : activeFloorIndex;
    const isFloorBelowTop = isMultiFloor && idx < topFloorIndex;
    if (isFloorBelowTop && restrict) return 0;
    return 1;
  };

  const getRoofScreenOcclusionScale = (restrictOcclusionToTopFloorOnly) =>
    getRoofScreenOcclusionScaleForFloor(activeFloorIndex, restrictOcclusionToTopFloorOnly);

  return Object.freeze({
    floorCount,
    topFloorIndex,
    activeFloorIndex,
    isMultiFloor,
    isActiveFloorBelowTop,
    activeLevelBottom: hasBand ? activeLevelBottom : null,
    activeLevelTop: hasBand ? activeLevelTop : null,
    activeCompositorKey,
    getRoofScreenOcclusionScale,
    getRoofScreenOcclusionScaleForFloor,
  });
}
