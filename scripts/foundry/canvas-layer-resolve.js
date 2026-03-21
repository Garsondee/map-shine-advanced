/**
 * Foundry V12+ canvas layer resolution.
 *
 * `canvas.grid` is the Scene's BaseGrid (data + snapping API), NOT {@link foundry.canvas.layers.GridLayer}.
 * Layer instances are created under their parent group; `CanvasGroupMixin` only defines
 * `canvas[name]` when `!(name in canvas)`, so `grid` never aliases the layer on `canvas`.
 *
 * @see foundryvttsourcecode/resources/app/client/canvas/board.mjs — `get grid()`
 * @see foundryvttsourcecode/resources/app/client/canvas/groups/canvas-group-mixin.mjs
 * @module foundry/canvas-layer-resolve
 */

/**
 * @param {string} layerKey - Key in CONFIG.Canvas.layers (e.g. 'grid', 'templates', 'tiles')
 * @returns {object|null} CanvasLayer-like instance or null
 */
export function getConfiguredCanvasLayer(layerKey) {
  try {
    const cfg = globalThis.CONFIG?.Canvas?.layers?.[layerKey];
    if (!cfg || !globalThis.canvas) return null;
    const group = globalThis.canvas[cfg.group];
    if (group && group[layerKey] != null) return group[layerKey];
    return globalThis.canvas[layerKey] ?? null;
  } catch (_) {
    return null;
  }
}
