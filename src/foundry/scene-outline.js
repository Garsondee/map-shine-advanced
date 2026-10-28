/**
 * FOUNDRY'S SCENE OUTLINE — the 4 px black line Foundry draws round the map (and a fainter one round the
 * padded canvas) to show "what portion of the canvas is playable space and what is buffer"
 * (v14: `client/canvas/groups/interface.mjs#drawOutline`, a private `PIXI.Graphics` child of
 * `canvas.interface`, drawn on every canvas draw). With the Table on, the brass frame does that job and
 * the line is a hard seam through anything Parallax lifts out over the map's edge (the author,
 * 2026-10-28: *"a distinct and obvious vector line around the outside of the map"*), so it is hidden
 * while the Table is on and shown again when it is off.
 *
 * Foundry keeps no reference to it, so it is FOUND: a Graphics child of the interface group whose every
 * shape is an unfilled stroke of exactly the scene rect or the padded canvas rect. Nothing else Foundry
 * draws there has that shape; if a future Foundry draws it differently, nothing matches and nothing is
 * touched (the result says so).
 *
 * @module foundry/scene-outline
 */

/** @param {*} a @param {*} b */
function sameRect(a, b) {
  if (!a || !b) return false;
  const k = ['x', 'y', 'width', 'height'];
  return k.every((key) => Number.isFinite(a[key]) && Math.abs(a[key] - b[key]) < 0.5);
}

/**
 * Is this display object Foundry's outline?
 * @param {*} child - a child of `canvas.interface`.
 * @param {{rect:*, sceneRect:*}} dimensions - `canvas.dimensions`.
 */
export function isSceneOutline(child, dimensions) {
  const data = child?.geometry?.graphicsData;
  if (!Array.isArray(data) || data.length === 0 || data.length > 2) return false;
  return data.every(
    (d) =>
      d?.lineStyle?.visible !== false &&
      (d?.lineStyle?.width ?? 0) > 0 &&
      d?.fillStyle?.visible !== true &&
      (sameRect(d?.shape, dimensions?.sceneRect) || sameRect(d?.shape, dimensions?.rect))
  );
}

/**
 * Show or hide Foundry's scene outline.
 * @param {*} canvas - Foundry's `canvas`.
 * @param {boolean} visible
 * @returns {{ok:boolean, found:number, reason?:string}}
 */
export function setSceneOutlineVisible(canvas, visible) {
  const group = canvas?.interface;
  const children = group?.children;
  if (!Array.isArray(children)) return { ok: false, found: 0, reason: 'no canvas.interface yet' };
  let found = 0;
  for (const child of children) {
    if (!isSceneOutline(child, canvas.dimensions)) continue;
    child.visible = !!visible;
    found++;
  }
  return found > 0
    ? { ok: true, found }
    : { ok: false, found: 0, reason: 'no outline found on canvas.interface (Foundry may draw it differently)' };
}
