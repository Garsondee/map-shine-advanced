/**
 * @fileoverview FloorStack band list: V14-native authority.
 *
 * Reads directly from Foundry's `scene.levels` embedded collection.
 * Legacy fallback paths (availableLevels, levelsSnapshot) removed — V14 only.
 *
 * @module foundry/levels-floor-stack-bands
 */

import { readV14SceneLevels, hasV14NativeLevels } from './levels-scene-flags.js';

/**
 * Elevation bands for {@link FloorStack#rebuildFloors}.
 * V14-only: reads from scene.levels. Returns null for scenes without levels.
 *
 * @returns {Array<{bottom:number,top:number,name:string,levelId:string}>|null}
 */
export function getSceneBandsForFloorStack() {
  const scene = globalThis.canvas?.scene;
  if (!hasV14NativeLevels(scene)) return null;

  const native = readV14SceneLevels(scene);
  if (!native.length) return null;

  return native.map((lvl) => {
    const bottom = Number.isFinite(lvl.bottom) ? lvl.bottom : 0;
    const top = Number.isFinite(lvl.top) ? lvl.top : bottom;
    return { bottom, top, name: lvl.label || lvl.levelId, levelId: lvl.levelId };
  });
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
