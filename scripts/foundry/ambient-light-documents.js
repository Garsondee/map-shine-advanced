/**
 * @fileoverview Resolve AmbientLight documents the same way Map Shine V2 lighting does:
 * prefer `scene.lights` (all levels), fall back to `canvas.lighting.placeables` when embedded is empty.
 * @returns {object[]}
 */
function _ambientLightPlaceablesFallback() {
  try {
    const placeables = globalThis.canvas?.lighting?.placeables;
    if (placeables && placeables.length > 0) {
      return placeables.map((p) => p.document).filter(Boolean);
    }
  } catch (_) {}
  return [];
}

/**
 * @returns {object[]}
 */
export function getAuthoritativeAmbientLightDocuments() {
  /** @type {object[]} */
  const out = [];
  try {
    const col = globalThis.canvas?.scene?.lights;
    if (!col) return _ambientLightPlaceablesFallback();
    const size = col.size ?? 0;
    if (!(size > 0)) return _ambientLightPlaceablesFallback();
    if (Array.isArray(col.contents)) {
      for (const d of col.contents) {
        if (d) out.push(d);
      }
    } else if (typeof col.forEach === 'function') {
      col.forEach((d) => {
        if (d) out.push(d);
      });
    } else {
      out.push(...Array.from(col.values()));
    }
  } catch (_) {
    return _ambientLightPlaceablesFallback();
  }
  if (out.length === 0) return _ambientLightPlaceablesFallback();
  return out;
}
