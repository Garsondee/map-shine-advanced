/**
 * @fileoverview V3 Minimal Floor Source Resolver.
 *
 * Returns the bottom-most and next-up level background image sources from a
 * Foundry V14 scene, using the native `scene._configureLevelTextures()` path
 * (same call Foundry itself uses when preloading scene textures). No legacy
 * flag readers, no V2 compatibility — V14 only.
 *
 * The resolver is intentionally tiny: it does one thing (surface two srcs in
 * bottom-to-top order) and never mutates scene state.
 */

/**
 * @typedef {object} V3TwoFloorBackgrounds
 * @property {string|null} lowerSrc  Bottom floor background image url (or null)
 * @property {string|null} upperSrc  Floor above lower, if present (or null)
 * @property {number} totalCount     How many visible level backgrounds the scene has
 * @property {string} source         "v14-native" | "fallback" | "none"
 */

/**
 * Read an ordered list of visible level background sources from a scene.
 * Order matches Foundry's native sort: bottom-to-top.
 *
 * @param {Scene|null|undefined} scene
 * @returns {string[]}
 */
/**
 * Read visible per-level **foreground** image sources in bottom-to-top order
 * (same ordering contract as {@link listVisibleLevelBackgroundSrcs}).
 *
 * @param {Scene|null|undefined} scene
 * @returns {string[]}
 */
export function listVisibleLevelForegroundSrcs(scene) {
  if (!scene) return [];
  const out = [];
  const seen = new Set();

  try {
    if (typeof scene._configureLevelTextures === "function") {
      const configured = scene._configureLevelTextures();
      if (Array.isArray(configured)) {
        for (const entry of configured) {
          if (!entry) continue;
          const slotName = String(entry.name || entry.type || "").trim().toLowerCase();
          if (slotName !== "foreground") continue;
          const src = String(entry.src || "").trim();
          if (!src || seen.has(src)) continue;
          seen.add(src);
          out.push(src);
        }
      }
    }
  } catch (_) {}

  if (out.length) return out;

  try {
    const sorted = scene.levels?.sorted;
    if (Array.isArray(sorted)) {
      for (const level of sorted) {
        const src = String(level?.foreground?.src || "").trim();
        if (!src || seen.has(src)) continue;
        seen.add(src);
        out.push(src);
      }
    }
  } catch (_) {}

  return out;
}

export function listVisibleLevelBackgroundSrcs(scene) {
  if (!scene) return [];
  const out = [];
  const seen = new Set();

  try {
    if (typeof scene._configureLevelTextures === "function") {
      const configured = scene._configureLevelTextures();
      if (Array.isArray(configured)) {
        for (const entry of configured) {
          if (!entry) continue;
          const slotName = String(entry.name || entry.type || "").trim().toLowerCase();
          if (slotName !== "background") continue;
          const src = String(entry.src || "").trim();
          if (!src || seen.has(src)) continue;
          seen.add(src);
          out.push(src);
        }
      }
    }
  } catch (_) {}

  if (out.length) return out;

  try {
    const sorted = scene.levels?.sorted;
    if (Array.isArray(sorted)) {
      for (const level of sorted) {
        const src = String(level?.background?.src || "").trim();
        if (!src || seen.has(src)) continue;
        seen.add(src);
        out.push(src);
      }
    }
  } catch (_) {}

  return out;
}

/**
 * Resolve exactly the two backgrounds the V3 sandwich wants: the lowest
 * visible level background (bottom) and the next one above it (upper).
 *
 * - A scene with only one level resolves `upperSrc = null` and the caller
 *   should skip mounting.
 * - A scene with zero visible level backgrounds resolves both to null.
 *
 * @param {Scene|null|undefined} scene
 * @returns {V3TwoFloorBackgrounds}
 */
export function resolveTwoFloorBackgrounds(scene) {
  const all = listVisibleLevelBackgroundSrcs(scene);
  if (!all.length) {
    const fallback = _fallbackSceneBackgroundSrc(scene);
    return {
      lowerSrc: fallback,
      upperSrc: null,
      totalCount: fallback ? 1 : 0,
      source: fallback ? "fallback" : "none",
    };
  }
  return {
    lowerSrc: all[0] ?? null,
    upperSrc: all[1] ?? null,
    totalCount: all.length,
    source: "v14-native",
  };
}

/**
 * Non-authoritative fallback for scenes that have no per-level backgrounds.
 * Purely so the V3 test renderer still shows *something* for scenes without
 * multiple levels configured.
 *
 * @param {Scene|null|undefined} scene
 * @returns {string|null}
 */
function _fallbackSceneBackgroundSrc(scene) {
  try {
    const raw = scene?.background?.src ?? scene?.img;
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  } catch (_) {}
  return null;
}

/**
 * @typedef {object} V3TwoFloorForegrounds
 * @property {string|null} lowerSrc  Bottom visible level foreground (or null)
 * @property {string|null} upperSrc  Next level up (or null)
 * @property {number} totalCount     How many visible level foregrounds were listed
 * @property {string} source         "v14-native" | "none"
 */

/**
 * Resolve the first two visible foreground URLs (same two-floor convention as
 * {@link resolveTwoFloorBackgrounds}). No deprecated scene-level foreground
 * fallback — V14 uses {@link Level#foreground} only.
 *
 * @param {Scene|null|undefined} scene
 * @returns {V3TwoFloorForegrounds}
 */
export function resolveTwoFloorForegrounds(scene) {
  const all = listVisibleLevelForegroundSrcs(scene);
  if (!all.length) {
    return {
      lowerSrc: null,
      upperSrc: null,
      totalCount: 0,
      source: "none",
    };
  }
  return {
    lowerSrc: all[0] ?? null,
    upperSrc: all[1] ?? null,
    totalCount: all.length,
    source: "v14-native",
  };
}
