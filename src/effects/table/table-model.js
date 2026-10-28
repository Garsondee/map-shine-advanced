/**
 * TABLE — the pure half: the pretend eye, the per-pixel ray model the shader
 * mirrors, and the per-frame uniform values. No THREE, no Foundry — every
 * function here is Node-tested. The off-board privacy rule is gameplay, so it
 * lives in the Foundry adapter (`foundry/off-board-privacy.js`).
 *
 * @module effects/table/table-model
 */

import { TABLE_PARAMS } from './table.js';
import { sceneEyeHeight } from '../../scene/index.js';

const DEF = Object.fromEntries(Object.entries(TABLE_PARAMS).map(([k, d]) => [k, d.default]));

/**
 * The height of the pretend pinhole eye over the view centre, in world px:
 * the height at which a camera with this vertical field of view frames the
 * view's `halfSpanPx` (half the world HEIGHT on screen). Zooming in lowers the
 * eye, so the same recess shows more wall up close — as a real one would.
 * @param {number} halfSpanPx
 * @param {number} fovDeg
 */
export function tableEyeHeight(halfSpanPx, fovDeg) {
  // The Table's eye IS the scene eye (scene/scene-eye.js): every depth effect in the module shares it.
  return sceneEyeHeight(halfSpanPx, fovDeg);
}

/**
 * Signed Chebyshev distance from a rect: negative inside, 0 on the edge,
 * positive outside (the larger of the two axis overhangs).
 * @param {number} x @param {number} y
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} r
 */
export function rectDistance(x, y, r) {
  const dx = Math.max(r.minX - x, x - r.maxX);
  const dy = Math.max(r.minY - y, y - r.maxY);
  return Math.max(dx, dy);
}

/**
 * Trace one pixel. `p` is where the orthographic viewer puts the pixel ON THE
 * BOARD (z = 0); the ray runs from the eye at (`eye`, `eyeH`) through p.
 *
 *  - It meets the table top (z = `depth`) at q = eye + (p − eye)·(eyeH − depth)/eyeH.
 *    If q is outside the board rect, the pixel is table top: rim within `rimW`
 *    of the rect, velvet beyond.
 *  - Otherwise the ray drops into the recess. If p is on the board, it is board.
 *  - Otherwise it leaves the rect on the way down: it hits the inner wall the
 *    ray crosses first, at height z = depth·(1 − s).
 *
 * The shader (`table-render.js#buildTableNodes`) is this function, node for node.
 *
 * @param {{x:number,y:number}} p
 * @param {{x:number,y:number}} eye
 * @param {number} eyeH
 * @param {number} depth
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} rect
 * @param {number} rimW
 * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} [outer] - the table's outer edge (the padded canvas).
 * @param {number} [edgeW] - width of the finished edge band, world px.
 * @param {number} [floorDepth] - how far BELOW the board plane the recess floor sits (the parallax
 *   stack's lowest floor), px. The recess then runs from the table top down to there: the pixel is
 *   board wherever the ray reaches that floor inside the rect, and the wall otherwise. 0 = the
 *   board is the floor (the original model).
 * @returns {{kind:'board'|'wall'|'rim'|'velvet'|'edge'|'void', q:{x:number,y:number}, rimT?:number, wallZ01?:number, wallAxis?:'x'|'y'}}
 */
export function traceTablePixel(p, eye, eyeH, depth, rect, rimW, outer = null, edgeW = 0, floorDepth = 0) {
  const k = eyeH > depth ? (eyeH - depth) / eyeH : 0;
  const q = { x: eye.x + (p.x - eye.x) * k, y: eye.y + (p.y - eye.y) * k };
  const dq = rectDistance(q.x, q.y, rect);
  if (dq > 0 && outer) {
    // Past the table's outer edge: the finished edge band, then the void.
    const dOut = rectDistance(q.x, q.y, outer);
    if (dOut >= edgeW) return { kind: 'void', q };
    if (dOut > 0) return { kind: 'edge', q, edgeT: dOut / edgeW };
  }
  if (dq > 0) return dq < rimW ? { kind: 'rim', q, rimT: dq / rimW } : { kind: 'velvet', q };
  // Where the ray meets the recess floor: the board plane's own point when the floor IS the board.
  const w = floorDepth > 0 ? floorPoint(p, eye, eyeH, floorDepth) : p;
  if (rectDistance(w.x, w.y, rect) <= 0) return { kind: 'board', q };
  // Fraction of the way from q (table height) down to w (the floor) where each
  // overhanging axis crosses its wall; the smaller is the wall actually hit.
  const sAxis = (qv, pv, lo, hi) => {
    if (pv > hi) return (hi - qv) / (pv - qv);
    if (pv < lo) return (lo - qv) / (pv - qv);
    return Infinity;
  };
  const sx = sAxis(q.x, w.x, rect.minX, rect.maxX);
  const sy = sAxis(q.y, w.y, rect.minY, rect.maxY);
  const s = Math.min(sx, sy);
  return { kind: 'wall', q, wallZ01: 1 - s, wallAxis: sx <= sy ? 'x' : 'y' };
}

/**
 * Where the ray through screen pixel `p` (the board plane's own point) meets a plane `below` px
 * under the board: further along the same ray, so further from the eye's axis.
 * @param {{x:number,y:number}} p @param {{x:number,y:number}} eye @param {number} eyeH @param {number} below
 */
export function floorPoint(p, eye, eyeH, below) {
  const k = eyeH > 0 ? (eyeH + below) / eyeH : 1;
  return { x: eye.x + (p.x - eye.x) * k, y: eye.y + (p.y - eye.y) * k };
}

/** sRGB hex → linear [r,g,b]. @param {string} hex */
export function srgbHexToLinear(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  const n = m ? parseInt(m[1], 16) : 0x808080;
  const ch = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return [ch((n >> 16) & 255), ch((n >> 8) & 255), ch(n & 255)];
}

/**
 * The table top's own height above the board, world px, before any parallax stack raises it: the
 * card's recess depth, never more than half the eye's height. Parallax fits its tallest layer to
 * exactly this, so it must be the same number `resolveTableFrame` would draw.
 * @param {object|null} params - the card's resolved params (missing keys take defaults).
 * @param {number} boardMinSidePx @param {number} halfSpanPx
 */
export function tableTopHeightPx(params, boardMinSidePx, halfSpanPx) {
  const pick = (k) => {
    const x = params?.[k];
    return x === undefined || x === null ? DEF[k] : x;
  };
  const side = Math.max(1, boardMinSidePx || 1000);
  const eyeH = tableEyeHeight(halfSpanPx, pick('fovDeg'));
  return Math.min((Math.max(0, pick('depthPct')) / 100) * side, eyeH * 0.5);
}

/**
 * THE EFFECTS EXTENT — how far past the board the scene's own effects (fog of war, lighting, cloud
 * and sun shadow, rain) must reach. A layer raised `topPx` above the board (a parallax treetop) is
 * scaled outward about the eye, so at the board's edge it overhangs the recess wall right up to the
 * table top's inner edge. Effects that stopped at the board left that overhang unlit and unfogged
 * (the author, 2026-10-28: *"move the extent of the screen space effects so that it doesn't leave a
 * gap around the edge"*). The extent is the board scaled about the eye by `eyeH/(eyeH − topPx)` —
 * exactly the brass's inner edge on screen — and the board itself when nothing is raised. It never
 * shrinks below the board: with the eye past an edge, the scaled rect pulls that near side in (the
 * lip overhangs the board there), and the board's own pixels under it keep their effects.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} rect - the board.
 * @param {{x:number,y:number}} eye @param {number} eyeH @param {number} topPx
 */
export function tableEffectsRect(rect, eye, eyeH, topPx) {
  if (!(topPx > 0) || !(eyeH > topPx)) return { ...rect };
  const s = eyeH / (eyeH - topPx);
  return {
    minX: Math.min(rect.minX, eye.x + (rect.minX - eye.x) * s),
    minY: Math.min(rect.minY, eye.y + (rect.minY - eye.y) * s),
    maxX: Math.max(rect.maxX, eye.x + (rect.maxX - eye.x) * s),
    maxY: Math.max(rect.maxY, eye.y + (rect.maxY - eye.y) * s),
  };
}

/**
 * The per-frame values the shader reads, from the card's params and the view.
 * The sizes are percentages of the board's shorter side — a table's rim is
 * in proportion to its board, whether that board is 20 squares or 120 — and
 * become world px here so the shader stays unit-free.
 *
 * @param {object} params - the card's resolved params (missing keys take defaults).
 * @param {object} ctx
 * @param {number} ctx.boardMinSidePx - the scene rect's shorter side in world px.
 * @param {number} ctx.halfSpanPx - the view's vertical half-span in world px.
 * @param {{x:number,y:number}} ctx.eye - the view centre in world px.
 * @param {number} [ctx.topHeightPx] - the parallax stack's roof height above the board plane: the
 *   table top never sits lower than this, so the highest floor's top is level with the frame.
 * @param {number} [ctx.floorDepthPx] - how far the lowest floor sits below the board plane: the
 *   recess is dug down to there.
 */
export function resolveTableFrame(params, ctx) {
  const v = (k) => {
    const x = params?.[k];
    return x === undefined || x === null ? DEF[k] : x;
  };
  const side = Math.max(1, ctx.boardMinSidePx || 1000);
  const pct = (k) => (Math.max(0, v(k)) / 100) * side;
  const eyeH = tableEyeHeight(ctx.halfSpanPx, v('fovDeg'));
  const depth = Math.min(Math.max(pct('depthPct'), Math.max(0, ctx.topHeightPx || 0)), eyeH * 0.5);
  const floorDepth = Math.min(Math.max(0, ctx.floorDepthPx || 0), eyeH * 0.5);
  return {
    eye: [ctx.eye.x, ctx.eye.y, eyeH, depth],
    floorDepth,
    rimW: Math.max(1, pct('rimPct')),
    edgeW: Math.max(1, pct('edgePct')),
    shadow: [v('edgeShadow'), Math.max(1, pct('edgeShadowPct'))],
    ao: [Math.min(1, Math.max(0, v('edgeShadowSoft'))), v('velvetAo'), Math.max(1, pct('velvetAoPct')), 0],
    rim: [v('rimRound'), v('rimShine'), v('rimPolish'), v('rimBrushed')],
    rimEngrave: v('rimEngrave'),
    rimColor: srgbHexToLinear(v('rimColor')),
    felt: [v('feltNap'), Math.max(0.5, v('feltNapSize')), v('feltMottle'), v('feltSheen')],
    feltColor: srgbHexToLinear(v('feltColor')),
    seams: [v('seams'), v('stitching')],
    stitch: [
      Math.min(0.95, Math.max(0.05, v('stitchLength'))),
      Math.max(0.1, v('stitchSpacing')),
      Math.max(0.1, v('stitchWidth')),
      v('stitchOutline'),
    ],
    panel: [Math.max(0.1, v('stitchInset')), v('midSeams'), v('panelBump'), Math.max(1, pct('panelBumpPct'))],
    stitchColor: srgbHexToLinear(v('stitchColor')),
    lamp: [v('lampStrength'), v('lampSpread'), v('roomDark'), v('cornerDark')],
    lampColor: srgbHexToLinear(v('lampColor')),
  };
}
