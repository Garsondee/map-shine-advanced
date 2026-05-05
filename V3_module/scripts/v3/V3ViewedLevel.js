/**
 * @fileoverview Map Foundry’s **currently viewed** level to `scene.levels.sorted` index
 * (same indexing as `V3LevelTextureCatalog` / mask probing).
 *
 * Prefer `Scene#_view` (level id) when present — that tracks which level the user is on
 * when switching floors (V14 internal, reliable for “upper vs lower”).
 */

/**
 * @param {Scene|null|undefined} scene
 * @returns {number} Index into `scene.levels.sorted`
 */
export function getViewedLevelIndex(scene) {
  if (!scene) return 0;

  const sorted = scene.levels?.sorted;
  if (!Array.isArray(sorted) || !sorted.length) return 0;

  const idOf = (s) => s?.id ?? s?._id ?? s?.document?.id ?? null;

  try {
    const vid = scene._view;
    if (typeof vid === "string" && vid) {
      const idx = sorted.findIndex((s) => idOf(s) === vid);
      if (idx >= 0) return idx;
    }
  } catch (_) {}

  for (let i = 0; i < sorted.length; i++) {
    const L = sorted[i];
    const doc = L?.document ?? L;
    if (L?.isView === true || doc?.isView === true) return i;
  }

  try {
    const fg = scene.foreground;
    if (typeof fg === "string" && fg) {
      const idx = sorted.findIndex((s) => idOf(s) === fg);
      if (idx >= 0) return idx;
    }
  } catch (_) {}

  return 0;
}
