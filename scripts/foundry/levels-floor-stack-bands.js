/**
 * @fileoverview FloorStack band list: align with level navigation (CameraFollower)
 * including synthesized scene background / foreground bands.
 * @module foundry/levels-floor-stack-bands
 */

/**
 * Elevation bands for {@link FloorStack#rebuildFloors}.
 * Prefers `window.MapShine.availableLevels` (merged navigation list) so underground
 * scene-background spans match tile levels inCompositor V2 floor indexing.
 *
 * @returns {Array<{bottom:number,top:number,name:string}>|null}
 */
export function getSceneBandsForFloorStack() {
  const nav = window.MapShine?.availableLevels;
  if (Array.isArray(nav) && nav.length > 0) {
    const out = [];
    for (let i = 0; i < nav.length; i += 1) {
      const lvl = nav[i];
      const bottom = Number(lvl?.bottom);
      const top = Number(lvl?.top);
      if (!Number.isFinite(bottom) || !Number.isFinite(top)) continue;
      const label = lvl?.label ?? lvl?.levelId;
      out.push({
        bottom,
        top,
        name: String(label != null && String(label) !== '' ? label : `Level ${i + 1}`),
      });
    }
    if (out.length) return out;
  }
  const snap = window.MapShine?.levelsSnapshot?.sceneLevels ?? null;
  return Array.isArray(snap) && snap.length > 0 ? snap : null;
}

/**
 * Stable signature of current FloorStack bands (mins/maxs only).
 * @param {import('../scene/FloorStack.js').FloorStack|null|undefined} floorStack
 * @returns {string}
 */
export function getFloorStackBandsSignature(floorStack) {
  try {
    const floors = floorStack?.getFloors?.() ?? [];
    return JSON.stringify(floors.map((f) => [f.elevationMin, f.elevationMax]));
  } catch (_) {
    return '';
  }
}
