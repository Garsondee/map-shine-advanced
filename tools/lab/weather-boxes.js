/**
 * tools/lab/weather-boxes.js — scene-px boxes to screenshot (device) px, for flicker.py (MSA Lab, weather).
 * cdp `eval --file` script, one `weatherBoxesPage(args)`; args = {boxes: [{name, x, y, w, h}]} in SCENE px
 * (Lab · Weather coordinates).
 * Uses Foundry's own stage transform (MSA follows Foundry's view) and the page's devicePixelRatio, and drops
 * boxes that fall outside the window.
 */
// cdp.mjs appends `return await weatherBoxesPage(args);` (a committed page script has no top-level return: lint).
// eslint-disable-next-line no-unused-vars
async function weatherBoxesPage(args) {
  const a = typeof args === 'object' && args ? args : {};
  const d = canvas.dimensions;
  const T = canvas.stage.worldTransform;
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(innerWidth * dpr);
  const H = Math.round(innerHeight * dpr);
  const out = [];
  for (const b of a.boxes ?? []) {
    const p0 = T.apply({ x: d.sceneX + b.x, y: d.sceneY + b.y });
    const p1 = T.apply({ x: d.sceneX + b.x + b.w, y: d.sceneY + b.y + b.h });
    const box = {
      name: b.name,
      x0: Math.round(p0.x * dpr),
      y0: Math.round(p0.y * dpr),
      x1: Math.round(p1.x * dpr),
      y1: Math.round(p1.y * dpr),
    };
    if (box.x0 >= 0 && box.y0 >= 0 && box.x1 <= W && box.y1 <= H && box.x1 > box.x0 && box.y1 > box.y0) out.push(box);
  }
  return { W, H, boxes: out };
}
