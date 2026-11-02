/**
 * scene-grid.test.mjs — what MSA reads of Foundry's grid is exactly what v14's `GridShader#_preRender`
 * feeds the GPU (the live `GridMesh`'s data, alpha, origin and `style` uniform), a module's own grid
 * shader is never taken, the outline follows `#drawOutline`'s padding rule, and hiding touches only the
 * grid mesh and the outline.
 */
import { readFoundryGrid, setFoundryGridOwnership } from '../scene-grid.js';

class GridShader {
  constructor(style = 0) {
    this.uniforms = { style };
  }
}
class CustomShader extends GridShader {}

function makeCanvas({ padding = 0.25, shader = new GridShader(1), data = {}, layer = {}, mesh = {} } = {}) {
  const outlineStroke = (shape) => ({ shape, lineStyle: { visible: true, width: 4 }, fillStyle: { visible: false } });
  const dimensions = {
    width: 6000,
    height: 4000,
    rect: { x: 0, y: 0, width: 6000, height: 4000 },
    sceneRect: { x: 1000, y: 800, width: 4000, height: 2400 },
    uiScale: 1.5,
  };
  const outline = {
    visible: true,
    geometry: { graphicsData: [outlineStroke(dimensions.rect), outlineStroke(dimensions.sceneRect)] },
  };
  const gridMesh = {
    visible: true,
    renderable: true,
    alpha: 0.8,
    position: { x: 0, y: 0 },
    shader,
    data: { type: 1, width: 6000, height: 4000, size: 100, thickness: 2, color: 0x336699, alpha: 0.8, ...data },
    ...mesh,
  };
  const gridLayer = { visible: true, renderable: true, worldAlpha: 0.5, mesh: gridMesh, ...layer };
  const other = { visible: true };
  return {
    canvas: {
      dimensions,
      scene: { padding },
      interface: { visible: true, grid: gridLayer, children: [other, outline, gridLayer] },
    },
    outline,
    gridMesh,
    other,
  };
}

export function run(t) {
  const { ok } = t;
  const core = { coreGridShader: GridShader };

  const { canvas } = makeCanvas();
  const r = readFoundryGrid(canvas, core);
  ok('reads ok', r.ok === true && !!r.grid);
  ok(
    "⭐ type, size and thickness are the mesh's own data",
    r.grid.type === 1 && r.grid.sizePx === 100 && r.grid.thicknessPx === 2
  );
  ok("the style is the shader's `style` uniform", r.grid.style === 1);
  ok(
    '0x336699 → display-space rgb',
    Math.abs(r.grid.color[0] - 0x33 / 255) < 1e-9 && Math.abs(r.grid.color[2] - 0x99 / 255) < 1e-9
  );
  ok(
    "⭐ alpha = the mesh's alpha × its layer's world alpha (PIXI's worldAlpha, rebuilt while hidden)",
    Math.abs(r.grid.alpha - 0.4) < 1e-9
  );
  ok('the mesh rect is its origin + data size', r.grid.mesh.width === 6000 && r.grid.mesh.x === 0);
  ok(
    '⭐ padded scene: canvas rect at 0.75, scene rect at 0.25, 4 × uiScale wide',
    r.outline.canvasAlpha === 0.75 && r.outline.sceneAlpha === 0.25 && r.outline.widthPx === 6
  );
  const flat = readFoundryGrid(makeCanvas({ padding: 0 }).canvas, core);
  ok(
    'no padding: no canvas stroke, the scene stroke at 0.75',
    flat.outline.canvasAlpha === 0 && flat.outline.sceneAlpha === 0.75
  );

  const foreign = readFoundryGrid(makeCanvas({ shader: new CustomShader(0) }).canvas, core);
  ok("⭐ a module's own grid shader is never taken", foreign.grid === null && foreign.foreignShader === true);
  ok('…and the outline is still read', !!foreign.outline);
  const gridless = readFoundryGrid(makeCanvas({ data: { type: 0 } }).canvas, core);
  ok('gridless: no lines, not foreign', gridless.grid === null && !gridless.foreignShader);
  ok('zero thickness: no lines', readFoundryGrid(makeCanvas({ data: { thickness: 0 } }).canvas, core).grid === null);
  ok(
    'a mesh Foundry marked unrenderable: no lines',
    readFoundryGrid(makeCanvas({ mesh: { renderable: false } }).canvas, core).grid === null
  );
  ok(
    'a hidden grid layer: no lines',
    readFoundryGrid(makeCanvas({ layer: { visible: false } }).canvas, core).grid === null
  );
  ok('no canvas: not ok', readFoundryGrid(null, core).ok === false);
  // A redraw destroys the old mesh first: PIXI nulls its transform, so `mesh.x` would throw.
  const dead = makeCanvas({ mesh: { destroyed: true, position: null } });
  let deadRead = null;
  try {
    deadRead = readFoundryGrid(dead.canvas, core);
  } catch (e) {
    deadRead = { threw: e.message };
  }
  ok(
    '⭐ a destroyed mesh (mid-redraw) reads as no lines, never a throw',
    deadRead?.ok === true && deadRead.grid === null
  );
  setFoundryGridOwnership(dead.canvas, { grid: true, outline: true });
  ok('…and ownership leaves a destroyed mesh alone', dead.gridMesh.visible === true);
  ok(
    'no grid mesh yet: ok, no lines',
    readFoundryGrid({ ...canvas, interface: { ...canvas.interface, grid: {} } }, core).grid === null
  );

  // ── OWNERSHIP ───────────────────────────────────────────────────────────
  const c = makeCanvas();
  setFoundryGridOwnership(c.canvas, { grid: true, outline: true });
  ok(
    "⭐ owned: Foundry's grid mesh and outline are hidden",
    c.gridMesh.visible === false && c.outline.visible === false
  );
  ok('…and nothing else is touched', c.other.visible === true && c.gridMesh.renderable === true);
  setFoundryGridOwnership(c.canvas, { grid: false, outline: false });
  ok('released: both are back', c.gridMesh.visible === true && c.outline.visible === true);
  setFoundryGridOwnership(c.canvas, { grid: false, outline: false, tableOn: true });
  ok('released with the Table on: the outline stays hidden (the brass frames the map)', c.outline.visible === false);
  setFoundryGridOwnership(c.canvas, { grid: true, outline: false });
  ok('grid owned, outline not: only the mesh hides', c.gridMesh.visible === false && c.outline.visible === true);
}
