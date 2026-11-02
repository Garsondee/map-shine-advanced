/**
 * FOUNDRY'S GRID AND SCENE OUTLINE, HANDED TO MSA — read what Foundry would draw, and hide Foundry's
 * own PIXI copies while MSA draws them (`effects/grid/foundry-grid-render.js` has the why).
 *
 * WHAT IS READ, AND FROM WHERE: the live `GridMesh` (`canvas.interface.grid.mesh`, v14
 * `client/canvas/layers/grid.mjs`) is the source of truth, not the scene document — it is exactly what
 * `GridShader#_preRender` feeds the GPU: `data.{type,size,thickness,color}`, the mesh's alpha, its
 * origin, and the shader's `style` uniform. A module that changes the grid through Foundry's own API
 * (`initializeMesh`) is therefore followed for free.
 *
 * WHAT IS NEVER TAKEN: a grid whose shader is not Foundry's own `GridShader` (a module's custom
 * `CONFIG.Canvas.gridStyles` entry brings its own GLSL MSA cannot know). That grid stays Foundry's,
 * drawn by PIXI exactly as before, and the result says so.
 *
 * HIDING: `visible = false` on the mesh (Foundry's `GridMesh#initialize` drives `renderable`, never
 * `visible`), and the outline through `scene-outline.js`. Foundry recreates both on every canvas draw,
 * so the owner re-asserts each frame; `release` puts both back.
 *
 * @module foundry/scene-grid
 */

import { setSceneOutlineVisible } from './scene-outline.js';

/** @param {*} n @param {number} d */
const num = (n, d) => (Number.isFinite(Number(n)) ? Number(n) : d);

/** @param {*} r */
function rectOf(r) {
  if (!r) return null;
  const x = Number(r.x);
  const y = Number(r.y);
  const width = Number(r.width);
  const height = Number(r.height);
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** `0xRRGGBB` (or a PIXI.Color-like with `toNumber`) → display-space [r, g, b] in 0..1. */
function colorOf(c) {
  const n = typeof c === 'number' ? c : typeof c?.toNumber === 'function' ? c.toNumber() : Number(c);
  const v = Number.isFinite(n) ? Math.max(0, Math.min(0xffffff, Math.round(n))) : 0;
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/**
 * Read the grid and the outline Foundry would draw this frame.
 * @param {*} canvas - Foundry's `canvas`.
 * @param {object} [opts]
 * @param {*} [opts.coreGridShader] - Foundry's own `GridShader` class (defaults to the live global).
 * @returns {{ok:boolean, reason?:string, grid:object|null, gridReason?:string, outline:object|null}}
 *   `grid` null with `gridReason` = MSA must not draw lines (gridless, hidden, or a foreign shader:
 *   `foreignShader` true means leave Foundry's mesh showing). `outline` null = no outline to draw.
 */
export function readFoundryGrid(
  canvas,
  { coreGridShader = globalThis.foundry?.canvas?.rendering?.shaders?.GridShader } = {}
) {
  const dims = canvas?.dimensions;
  const layer = canvas?.interface?.grid;
  if (!dims || !canvas?.interface) return { ok: false, reason: 'no canvas yet', grid: null, outline: null };
  const canvasRect = rectOf(dims.rect) ?? rectOf({ x: 0, y: 0, width: dims.width, height: dims.height });
  const sceneRect = rectOf(dims.sceneRect);

  // THE OUTLINE (`InterfaceCanvasGroup#drawOutline`): 4·uiScale px, black, round the padded canvas at
  // 0.75 when the scene has padding, and round the scene at 0.25 (padded) or 0.75 (not).
  let outline = null;
  if (canvasRect && sceneRect) {
    const padded = num(canvas.scene?.padding, 0) !== 0;
    outline = {
      canvasRect,
      sceneRect,
      widthPx: 4 * num(dims.uiScale, 1),
      canvasAlpha: padded ? 0.75 : 0,
      sceneAlpha: padded ? 0.25 : 0.75,
    };
  }

  const mesh = layer?.mesh;
  // A canvas redraw DESTROYS the old mesh before `_draw` builds the next one; PIXI nulls its transform,
  // so even `mesh.x` throws (live, 2026-11-02, in the frame between the two).
  if (!mesh || mesh.destroyed || !mesh.data) return { ok: true, grid: null, gridReason: 'no grid mesh yet', outline };
  const shader = mesh.shader;
  if (coreGridShader && shader && shader.constructor !== coreGridShader) {
    return { ok: true, grid: null, gridReason: 'the grid style brings its own shader', foreignShader: true, outline };
  }
  const d = mesh.data;
  const style = num(shader?.uniforms?.style, 0);
  const sizePx = num(d.size, 0);
  const thicknessPx = num(d.thickness, 0);
  // `GridShader` takes `mesh.worldAlpha`; while MSA hides the mesh PIXI stops refreshing that, so it is
  // rebuilt from the mesh's own alpha and its (still visible) layer's world alpha.
  const alpha = num(mesh.alpha, 1) * num(layer.worldAlpha, 1);
  const shown = layer.visible !== false && layer.renderable !== false && canvas.interface.visible !== false;
  if (!(sizePx > 0) || !(thicknessPx > 0) || num(d.type, 0) === 0 || mesh.renderable === false) {
    return { ok: true, grid: null, gridReason: 'gridless, or no line thickness', outline };
  }
  if (!shown || !(alpha > 0)) return { ok: true, grid: null, gridReason: 'the grid layer is hidden', outline };
  return {
    ok: true,
    grid: {
      type: num(d.type, 1),
      style,
      sizePx,
      thicknessPx,
      color: colorOf(d.color),
      alpha,
      mesh: {
        x: num(mesh.position?.x, 0),
        y: num(mesh.position?.y, 0),
        width: num(d.width, 0),
        height: num(d.height, 0),
      },
    },
    outline,
  };
}

/**
 * Hide (MSA draws them) or show (Foundry draws them) the PIXI grid mesh and the scene outline.
 * @param {*} canvas
 * @param {object} a
 * @param {boolean} a.grid - MSA draws the grid lines.
 * @param {boolean} a.outline - MSA draws (or, with the Table on, deliberately omits) the outline.
 * @param {boolean} [a.tableOn] - with MSA not drawing the outline, the Table still hides Foundry's.
 * @returns {{grid:boolean, outline:{ok:boolean, found:number, reason?:string}}}
 */
export function setFoundryGridOwnership(canvas, { grid, outline, tableOn = false }) {
  const mesh = canvas?.interface?.grid?.mesh;
  let gridHidden = false;
  if (mesh && !mesh.destroyed) {
    const want = !grid;
    if (mesh.visible !== want) mesh.visible = want;
    gridHidden = !want;
  }
  return { grid: gridHidden, outline: setSceneOutlineVisible(canvas, !outline && !tableOn) };
}
