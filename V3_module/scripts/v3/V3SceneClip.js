/**
 * @fileoverview Read Foundry scene padding / background color for V3 clip regions.
 */

/**
 * @param {Scene|null|undefined} scene
 * @returns {[number, number, number]} sRGB 0–1
 */
export function readSceneBackgroundRgb01(scene) {
  try {
    const n = scene?.colors?.background;
    if (typeof n === "number" && Number.isFinite(n)) {
      const r = ((n >> 16) & 255) / 255;
      const g = ((n >> 8) & 255) / 255;
      const b = (n & 255) / 255;
      return [r, g, b];
    }
  } catch (_) {}
  return [0, 0, 0];
}
