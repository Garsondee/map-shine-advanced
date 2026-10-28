/**
 * THE ROOM MAP — every room on a floor, as Foundry's own walls divide it, filled and numbered.
 *
 * Author, 2026-10-28: *"Think of a Foundry scene as a series of polygons … the rooms of the scene as they are
 * divided up by walls and doors and windows … Take each distinct room, including all outdoors ones, give them each a
 * 'fill' operation and give them an ID."* This is that intermediate, built once per floor on the CPU from the wall
 * segments (`foundry/scene-walls.js#readSceneWallSegments`), and shared through `createRoomMapCache` so any effect
 * can ask "which room is this point in, how far is it from a wall, and which way does the room look out".
 *
 * HOW IT IS BUILT, on a square grid over the scene rect (about eight cells per grid square, never past
 * {@link ROOM_MAP_MAX_DIM} on the long side, so it obeys `LAW_MAX_WORLD_RES_DIM` with room to spare):
 *   1. every wall that divides space — a wall, a door (open OR closed: a room does not merge with the hall because
 *      someone opened the door), a window — is drawn into a barrier grid as a THICK line, so the few-pixel gaps
 *      between hand-placed wall ends do not leak one room into the next ({@link rasterizeRoomBarriers});
 *   2. the open cells are flood-filled, 4-connected, and each connected region gets an id 1..N — wall cells are 0
 *      ({@link labelRooms});
 *   3. each room is called outdoors or indoors — by the floor's `_Outdoors` mask when there is one (majority vote of
 *      its cells), else by whether it touches the scene edge ({@link classifyRoomsOutdoor});
 *   4. the exact Euclidean distance from every cell to the nearest wall (`scene/grid-edt.js`) — the "AO" the window
 *      light fades by near a wall instead of stopping on a hard line;
 *   5. for every indoor room, which compass directions its outside walls and windows face
 *      ({@link collectRoomExposure}, {@link roomSunFacing}) — the room-level answer;
 *   6. for every indoor CELL, which way the window nearest to it looks out ({@link computeRoomOutlook}): spread from
 *      the windows through the room only (never through a wall) and softened across corners, so a pixel lit by a
 *      west window knows it, and one lit by the north window in the same room knows that instead. A room with no
 *      window marked falls back to its outside walls.
 *
 * TWO TEXTURES, one texel per cell, RGBA8:
 *   - IDS ({@link encodeRoomIdsRgba}): R = id low byte, G = id high byte. Wall cells carry the id of the room nearest
 *     them ({@link dilateRoomsIntoWalls}). Read at the texel CENTRE (a linear filter returns that texel exactly there).
 *   - FIELD ({@link encodeRoomFieldRgba}): R = distance to the nearest wall in units of {@link ROOM_DIST_PX_PER_UNIT}
 *     px, G/B = the outlook vector, signed (128 = 0). Read anywhere: it is meant to be linearly filtered, so nothing
 *     read from it ever steps at the cell size.
 *
 * Pure maths over typed arrays: no THREE, no Foundry, Node-tested. The cache takes its GPU texture factory injected.
 *
 * @module scene/room-map
 */

import { squaredDistanceField } from './grid-edt.js';

/** Long side of the grid never exceeds this many cells. */
export const ROOM_MAP_MAX_DIM = 1024;
/** Target cells per Foundry grid square (a 100 px grid → 12.5 px cells). */
export const ROOM_MAP_CELLS_PER_GRID = 8;
/** The B channel stores distance-to-wall / this, so a byte reaches 510 px. */
export const ROOM_DIST_PX_PER_UNIT = 2;
/** Default thickness walls are drawn at, px — wide enough to seal the small gaps between wall ends. */
export const ROOM_WALL_THICKNESS_DEFAULT_PX = 10;
/** Ids above this do not fit the two id bytes; such rooms read as walls (0). */
export const ROOM_ID_MAX = 65535;
/** Compass bins a room's outside walls are sorted into. 16 = 22.5° each. */
export const ROOM_EXPOSURE_BINS = 16;
/** How much a plain outside wall counts toward a room's outlook when the room has no window at all. */
export const ROOM_EXTERIOR_WALL_WEIGHT = 0.25;
/** The outdoors-mask threshold — the same byte midpoint the rain field uses (`window-rain-field.js#RAIN_FIELD_IRIS`). */
export const ROOM_OUTDOORS_IRIS = 127.5;

/**
 * The grid over the scene rect: square cells, about {@link ROOM_MAP_CELLS_PER_GRID} per grid square, the long side
 * clamped to `maxDim`.
 * @param {object} args
 * @param {{x:number,y:number,width:number,height:number}} args.sceneRect
 * @param {number} [args.gridSizePixels=100]
 * @param {number} [args.maxDim=ROOM_MAP_MAX_DIM]
 * @returns {{minX:number,minY:number,cols:number,rows:number,cellSize:number}}
 */
export function computeRoomMapGridSpec({ sceneRect, gridSizePixels = 100, maxDim = ROOM_MAP_MAX_DIM }) {
  const w = Number.isFinite(sceneRect?.width) && sceneRect.width > 0 ? sceneRect.width : 4000;
  const h = Number.isFinite(sceneRect?.height) && sceneRect.height > 0 ? sceneRect.height : 3000;
  const grid = Number.isFinite(gridSizePixels) && gridSizePixels > 0 ? gridSizePixels : 100;
  const longSide = Math.max(w, h);
  const cap = Math.max(16, Math.floor(maxDim) || ROOM_MAP_MAX_DIM);
  const cellSize = Math.max(grid / ROOM_MAP_CELLS_PER_GRID, longSide / cap);
  return {
    minX: Number(sceneRect?.x) || 0,
    minY: Number(sceneRect?.y) || 0,
    cols: Math.max(1, Math.min(cap, Math.ceil(w / cellSize))),
    rows: Math.max(1, Math.min(cap, Math.ceil(h / cellSize))),
    cellSize,
  };
}

/**
 * Draw every space-dividing wall into a barrier grid as a thick line: a cell is a barrier when its centre lies within
 * half the thickness of a wall segment. The half-thickness never drops below 0.75 of a cell, which keeps every
 * drawn line 8-connected, so a 4-connected fill can never squeeze diagonally through one.
 *
 * A wall carrying `roomBarrier: false` (it stops nothing — no movement, no light, no sight) is skipped; one without
 * the field counts, so plain `{x1,y1,x2,y2}` fixtures work.
 *
 * @param {Array<{x1:number,y1:number,x2:number,y2:number,roomBarrier?:boolean}>} walls
 * @param {{minX:number,minY:number,cols:number,rows:number,cellSize:number}} spec
 * @param {number} [thicknessPx=ROOM_WALL_THICKNESS_DEFAULT_PX]
 * @returns {Uint8Array} cols*rows, 1 = wall.
 */
export function rasterizeRoomBarriers(walls, spec, thicknessPx = ROOM_WALL_THICKNESS_DEFAULT_PX) {
  const { minX, minY, cols, rows, cellSize } = spec;
  const barrier = new Uint8Array(cols * rows);
  const half = Math.max(
    (Number.isFinite(thicknessPx) ? thicknessPx : ROOM_WALL_THICKNESS_DEFAULT_PX) / 2,
    cellSize * 0.75
  );
  const half2 = half * half;
  for (const w of Array.isArray(walls) ? walls : []) {
    if (!w || w.roomBarrier === false) continue;
    const { x1, y1, x2, y2 } = w;
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    const ex = x2 - x1;
    const ey = y2 - y1;
    const len2 = ex * ex + ey * ey;
    const c0 = Math.max(0, Math.floor((Math.min(x1, x2) - half - minX) / cellSize));
    const c1 = Math.min(cols - 1, Math.floor((Math.max(x1, x2) + half - minX) / cellSize));
    const r0 = Math.max(0, Math.floor((Math.min(y1, y2) - half - minY) / cellSize));
    const r1 = Math.min(rows - 1, Math.floor((Math.max(y1, y2) + half - minY) / cellSize));
    for (let r = r0; r <= r1; r++) {
      const py = minY + (r + 0.5) * cellSize;
      for (let c = c0; c <= c1; c++) {
        const px = minX + (c + 0.5) * cellSize;
        const t = len2 > 0 ? Math.min(Math.max(((px - x1) * ex + (py - y1) * ey) / len2, 0), 1) : 0;
        const dx = px - (x1 + t * ex);
        const dy = py - (y1 + t * ey);
        if (dx * dx + dy * dy <= half2) barrier[r * cols + c] = 1;
      }
    }
  }
  return barrier;
}

/**
 * Flood-fill the open cells into rooms, 4-connected. Wall cells stay 0; rooms are numbered 1..count in scan order.
 * Iterative (an explicit stack) — a recursive fill would overflow on the first big courtyard.
 * @param {Uint8Array} barrier @param {number} cols @param {number} rows
 * @returns {{labels: Int32Array, count: number, cellCount: Int32Array, touchesBorder: Uint8Array}}
 *   `cellCount`/`touchesBorder` are indexed by room id (index 0 unused).
 */
export function labelRooms(barrier, cols, rows) {
  const n = cols * rows;
  const labels = new Int32Array(n);
  const counts = [0];
  const border = [0];
  const stack = new Int32Array(n);
  let count = 0;
  for (let start = 0; start < n; start++) {
    if (barrier[start] || labels[start]) continue;
    count++;
    let top = 0;
    stack[top++] = start;
    labels[start] = count;
    let cells = 0;
    let touches = 0;
    while (top > 0) {
      const i = stack[--top];
      cells++;
      const c = i % cols;
      const r = (i - c) / cols;
      if (c === 0 || r === 0 || c === cols - 1 || r === rows - 1) touches = 1;
      if (c > 0 && !barrier[i - 1] && !labels[i - 1]) {
        labels[i - 1] = count;
        stack[top++] = i - 1;
      }
      if (c < cols - 1 && !barrier[i + 1] && !labels[i + 1]) {
        labels[i + 1] = count;
        stack[top++] = i + 1;
      }
      if (r > 0 && !barrier[i - cols] && !labels[i - cols]) {
        labels[i - cols] = count;
        stack[top++] = i - cols;
      }
      if (r < rows - 1 && !barrier[i + cols] && !labels[i + cols]) {
        labels[i + cols] = count;
        stack[top++] = i + cols;
      }
    }
    counts.push(cells);
    border.push(touches);
  }
  return { labels, count, cellCount: Int32Array.from(counts), touchesBorder: Uint8Array.from(border) };
}

/**
 * Indoors or outdoors, per room. With the floor's `_Outdoors` grid: the majority of the room's cells (sampled at
 * their centres) decides. Without it: a room that reaches the edge of the scene is outdoors, an enclosed one indoors.
 * @param {Int32Array} labels @param {number} count
 * @param {{minX:number,minY:number,cols:number,rows:number,cellSize:number}} spec
 * @param {Uint8Array} touchesBorder - from {@link labelRooms}.
 * @param {{spec:{x:number,y:number,width:number,height:number,w:number,h:number}, data:Uint8Array}|null} [outdoors]
 * @returns {Uint8Array} indexed by room id, 1 = outdoors.
 */
export function classifyRoomsOutdoor(labels, count, spec, touchesBorder, outdoors = null) {
  const out = new Uint8Array(count + 1);
  const os = outdoors?.spec;
  const valid = os && outdoors.data && outdoors.data.length === os.w * os.h && os.width > 0 && os.height > 0;
  if (!valid) {
    for (let id = 1; id <= count; id++) out[id] = touchesBorder[id] ? 1 : 0;
    return out;
  }
  const open = new Float64Array(count + 1);
  const total = new Float64Array(count + 1);
  const { minX, minY, cols, rows, cellSize } = spec;
  for (let r = 0; r < rows; r++) {
    const wy = minY + (r + 0.5) * cellSize;
    const oy = Math.min(os.h - 1, Math.max(0, Math.floor(((wy - os.y) / os.height) * os.h)));
    for (let c = 0; c < cols; c++) {
      const id = labels[r * cols + c];
      if (!id) continue;
      const wx = minX + (c + 0.5) * cellSize;
      const ox = Math.min(os.w - 1, Math.max(0, Math.floor(((wx - os.x) / os.width) * os.w)));
      total[id] += 1;
      if (outdoors.data[oy * os.w + ox] >= ROOM_OUTDOORS_IRIS) open[id] += 1;
    }
  }
  for (let id = 1; id <= count; id++) out[id] = total[id] > 0 && open[id] / total[id] >= 0.5 ? 1 : 0;
  return out;
}

/**
 * Distance from every cell centre to the nearest wall cell, in world px.
 * @param {Uint8Array} barrier @param {number} cols @param {number} rows @param {number} cellSize
 * @returns {Float32Array}
 */
export function roomWallDistancePx(barrier, cols, rows, cellSize) {
  const sq = squaredDistanceField(barrier, cols, rows);
  const out = new Float32Array(cols * rows);
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(Math.min(sq[i], 1e8)) * cellSize;
  return out;
}

/** The open cell nearest (x,y) within `reach` cells, as a cell index; -2 off the grid, -1 buried in wall. */
function cellNear(labels, spec, x, y, reach) {
  const { minX, minY, cols, rows, cellSize } = spec;
  const c = Math.floor((x - minX) / cellSize);
  const r = Math.floor((y - minY) / cellSize);
  if (c < 0 || c >= cols || r < 0 || r >= rows) return -2;
  if (labels[r * cols + c]) return r * cols + c;
  for (let k = 1; k <= reach; k++) {
    for (let dr = -k; dr <= k; dr++) {
      for (let dc = -k; dc <= k; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== k) continue;
        const cc = c + dc;
        const rr = r + dr;
        if (cc >= 0 && cc < cols && rr >= 0 && rr < rows && labels[rr * cols + cc]) return rr * cols + cc;
      }
    }
  }
  return -1;
}

/**
 * Walk every wall in short steps; at each step read the cells just beyond the drawn wall on both sides, and where one
 * side is an indoor room and the other is outdoors (or off the scene), report it: `visit(room, cell, ox, oy, isWindow,
 * stepLen)` with the OUTWARD normal (ox, oy) and the room-side cell. A wall between two indoor rooms says nothing.
 */
function walkExteriorSteps(walls, labels, outdoor, spec, thicknessPx, visit) {
  const { cellSize } = spec;
  const half = Math.max(
    (Number.isFinite(thicknessPx) ? thicknessPx : ROOM_WALL_THICKNESS_DEFAULT_PX) / 2,
    cellSize * 0.75
  );
  const probe = half + cellSize;
  for (const w of Array.isArray(walls) ? walls : []) {
    if (!w || w.roomBarrier === false) continue;
    const { x1, y1, x2, y2 } = w;
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 1e-6) continue;
    const nx = -(y2 - y1) / len;
    const ny = (x2 - x1) / len;
    const isWindow = w.reachWindow === true || w.aperture === true;
    const steps = Math.max(1, Math.ceil(len / cellSize));
    const stepLen = len / steps;
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) / steps;
      const mx = x1 + (x2 - x1) * t;
      const my = y1 + (y2 - y1) * t;
      const ca = cellNear(labels, spec, mx + nx * probe, my + ny * probe, 2);
      const cb = cellNear(labels, spec, mx - nx * probe, my - ny * probe, 2);
      const a = ca >= 0 ? labels[ca] : 0;
      const b = cb >= 0 ? labels[cb] : 0;
      // Off the grid counts as outdoors: a wall drawn on the scene edge faces out.
      const aOut = ca === -2 || (a > 0 && outdoor[a] === 1);
      const bOut = cb === -2 || (b > 0 && outdoor[b] === 1);
      if (a > 0 && !aOut && bOut) visit(a, ca, -nx, -ny, isWindow, stepLen);
      else if (b > 0 && !bOut && aOut) visit(b, cb, nx, ny, isWindow, stepLen);
    }
  }
}

/**
 * Which way each indoor room looks out: the length of outside wall facing each compass bin of the OUTWARD normal — in
 * `windowBins` when the wall is a window (`reachWindow` or `aperture`), in `wallBins` otherwise.
 * @param {Array<object>} walls @param {Int32Array} labels @param {number} count
 * @param {Uint8Array} outdoor - from {@link classifyRoomsOutdoor}.
 * @param {{minX:number,minY:number,cols:number,rows:number,cellSize:number}} spec
 * @param {number} [thicknessPx]
 * @returns {{windowBins: Float32Array, wallBins: Float32Array}} count+1 rooms × {@link ROOM_EXPOSURE_BINS}.
 */
export function collectRoomExposure(walls, labels, count, outdoor, spec, thicknessPx = ROOM_WALL_THICKNESS_DEFAULT_PX) {
  const B = ROOM_EXPOSURE_BINS;
  const windowBins = new Float32Array((count + 1) * B);
  const wallBins = new Float32Array((count + 1) * B);
  walkExteriorSteps(walls, labels, outdoor, spec, thicknessPx, (room, _cell, ox, oy, isWindow, stepLen) => {
    const bin = ((Math.round((Math.atan2(oy, ox) / (2 * Math.PI)) * B) % B) + B) % B;
    (isWindow ? windowBins : wallBins)[room * B + bin] += stepLen;
  });
  return { windowBins, wallBins };
}

/**
 * How squarely a room faces the sun, 0..1, and whether the room says anything at all — the ROOM-level answer (the
 * window light reads the per-cell {@link computeRoomOutlook} instead). Windows decide when the room has any; else its
 * plain outside walls, at {@link ROOM_EXTERIOR_WALL_WEIGHT}. The best-facing opening wins.
 * @param {{windowBins: Float32Array, wallBins: Float32Array}} exposure
 * @param {number} id @param {number} toSunX @param {number} toSunY - unit vector toward the sun, +y down.
 * @returns {{facing: number, known: number}} `known` 0 = an interior or outdoor room.
 */
export function roomSunFacing(exposure, id, toSunX, toSunY) {
  const B = ROOM_EXPOSURE_BINS;
  let best = -1;
  let any = false;
  let bins = exposure.windowBins;
  for (let k = 0; k < B; k++) if (bins[id * B + k] > 0) any = true;
  let weight = 1;
  if (!any) {
    bins = exposure.wallBins;
    weight = ROOM_EXTERIOR_WALL_WEIGHT;
    for (let k = 0; k < B; k++) if (bins[id * B + k] > 0) any = true;
  }
  if (!any) return { facing: 0, known: 0 };
  for (let k = 0; k < B; k++) {
    if (!(bins[id * B + k] > 0)) continue;
    const ang = (k / B) * 2 * Math.PI;
    const d = Math.cos(ang) * toSunX + Math.sin(ang) * toSunY;
    if (d > best) best = d;
  }
  const u = Math.min(Math.max(best, 0), 1);
  return { facing: u * u * (3 - 2 * u), known: weight };
}

/** Cells either side the outlook is softened over, per pass. */
export const ROOM_OUTLOOK_BLUR_CELLS = 8;
/** Separable box passes (three box passes are close to a Gaussian). */
export const ROOM_OUTLOOK_BLUR_PASSES = 3;

/**
 * THE PER-CELL OUTLOOK — for every indoor cell, which way the windows nearest to it look out, as a VECTOR. Each window
 * step seeds its room-side cell with its unit outward normal; a 4-connected breadth-first spread carries each seed
 * outward through its room (the walls stop it by construction — it only steps between cells of the same room); then
 * separable box passes, each confined to the room, AVERAGE the vectors where two windows' regions meet.
 *
 * ⚠️ A VECTOR, NOT AN ANGLE (2026-10-28, the Compound's greenhouse: *"a very hard line in the middle of the
 * greenhouse"*). Its west windows and the east-facing windows of the room it opens into point in opposite directions;
 * averaged as unit directions those cancel and the angle FLIPS 180° on one line, so the light switched from "faces the
 * sun" to "faces away" on a hard seam. The vector is kept unnormalised, so it shrinks to nothing between opposite
 * windows instead — and because "how squarely it faces the sun" is a dot product, linear in the vector, the blend of
 * two windows' facings is exactly the facing of their blended vector. Length 1 = one clear window direction.
 *
 * A room with no window at all is seeded from its plain outside walls. Interior and outdoor rooms get (0, 0).
 *
 * @param {Array<object>} walls @param {Int32Array} labels @param {number} count @param {Uint8Array} outdoor
 * @param {{minX:number,minY:number,cols:number,rows:number,cellSize:number}} spec
 * @param {number} [thicknessPx]
 * @returns {{x: Float32Array, y: Float32Array}} cols*rows, |v| ≤ 1.
 */
export function computeRoomOutlook(walls, labels, count, outdoor, spec, thicknessPx = ROOM_WALL_THICKNESS_DEFAULT_PX) {
  const { cols, rows } = spec;
  const n = cols * rows;
  const seeds = [];
  const hasWindow = new Uint8Array(count + 1);
  walkExteriorSteps(walls, labels, outdoor, spec, thicknessPx, (room, cell, ox, oy, isWindow) => {
    seeds.push(cell, ox, oy, isWindow ? 1 : 0);
    if (isWindow) hasWindow[room] = 1;
  });
  let vx = new Float32Array(n);
  let vy = new Float32Array(n);
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let s = 0; s < seeds.length; s += 4) {
    const cell = seeds[s];
    if (hasWindow[labels[cell]] && !seeds[s + 3]) continue; // a glazed room is judged by its windows alone
    vx[cell] += seeds[s + 1];
    vy[cell] += seeds[s + 2];
    if (!seen[cell]) {
      seen[cell] = 1;
      queue[tail++] = cell;
    }
  }
  for (let q = 0; q < tail; q++) {
    const i = queue[q];
    const m = Math.hypot(vx[i], vy[i]);
    if (m > 1e-6) {
      vx[i] /= m;
      vy[i] /= m;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const c = i % cols;
    const id = labels[i];
    const step = (j) => {
      if (seen[j] || labels[j] !== id) return;
      seen[j] = 1;
      vx[j] = vx[i];
      vy[j] = vy[i];
      queue[tail++] = j;
    };
    if (c > 0) step(i - 1);
    if (c < cols - 1) step(i + 1);
    if (i >= cols) step(i - cols);
    if (i < n - cols) step(i + cols);
  }
  // Separable box AVERAGES, confined to the room: a cell only averages neighbours that share its id.
  const R = ROOM_OUTLOOK_BLUR_CELLS;
  let tx = new Float32Array(n);
  let ty = new Float32Array(n);
  for (let pass = 0; pass < ROOM_OUTLOOK_BLUR_PASSES; pass++) {
    for (const horizontal of [true, false]) {
      for (let i = 0; i < n; i++) {
        if (!seen[i]) {
          tx[i] = 0;
          ty[i] = 0;
          continue;
        }
        const id = labels[i];
        const c = i % cols;
        const r = (i - c) / cols;
        let sx = 0;
        let sy = 0;
        let w = 0;
        for (let k = -R; k <= R; k++) {
          const cc = horizontal ? c + k : c;
          const rr = horizontal ? r : r + k;
          if (cc < 0 || cc >= cols || rr < 0 || rr >= rows) continue;
          const j = rr * cols + cc;
          if (!seen[j] || labels[j] !== id) continue;
          sx += vx[j];
          sy += vy[j];
          w++;
        }
        tx[i] = sx / w;
        ty[i] = sy / w;
      }
      [vx, tx] = [tx, vx];
      [vy, ty] = [ty, vy];
    }
  }
  return { x: vx, y: vy };
}

/**
 * Wall cells take the id and outlook of the room cell nearest them (a breadth-first spread into the walls). The room
 * id then only changes in the MIDDLE of a wall, where the distance to the wall is 0 and the window light has already
 * faded to nothing — so the shader's hard "same room" test never shows as a step (it did, cell by cell, along every
 * wall when wall cells were room 0: the Compound's stepped edges, 2026-10-28).
 * @param {Int32Array} labels @param {Float32Array} ox @param {Float32Array} oy @param {number} cols @param {number} rows
 * @returns {{ids: Int32Array, x: Float32Array, y: Float32Array}}
 */
export function dilateRoomsIntoWalls(labels, ox, oy, cols, rows) {
  const n = cols * rows;
  const ids = Int32Array.from(labels);
  const x = Float32Array.from(ox);
  const y = Float32Array.from(oy);
  const queue = new Int32Array(n);
  let tail = 0;
  for (let i = 0; i < n; i++) if (ids[i]) queue[tail++] = i;
  for (let head = 0; head < tail; head++) {
    const i = queue[head];
    const c = i % cols;
    const step = (j) => {
      if (ids[j]) return;
      ids[j] = ids[i];
      x[j] = x[i];
      y[j] = y[i];
      queue[tail++] = j;
    };
    if (c > 0) step(i - 1);
    if (c < cols - 1) step(i + 1);
    if (i >= cols) step(i - cols);
    if (i < n - cols) step(i + cols);
  }
  return { ids, x, y };
}

/** A signed −1..1 component as a byte, and back. */
export const encodeRoomVecByte = (v) => Math.max(0, Math.min(255, Math.round(v * 127.5 + 127.5)));
export const decodeRoomVecByte = (b) => (b - 127.5) / 127.5;

/**
 * THE ID TEXTURE — R = id low byte, G = id high byte (walls carry their nearest room's id). Read at the texel centre.
 * @param {Int32Array} ids @returns {Uint8Array}
 */
export function encodeRoomIdsRgba(ids) {
  const out = new Uint8Array(ids.length * 4);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i] > ROOM_ID_MAX ? 0 : ids[i];
    out[i * 4] = id & 255;
    out[i * 4 + 1] = id >> 8;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/**
 * THE FIELD TEXTURE — R = distance to the nearest wall / {@link ROOM_DIST_PX_PER_UNIT} px, G/B = the outlook vector
 * ({@link encodeRoomVecByte}). Everything here is meant to be linearly filtered.
 * @param {Float32Array} distPx @param {Float32Array} ox @param {Float32Array} oy @returns {Uint8Array}
 */
export function encodeRoomFieldRgba(distPx, ox, oy) {
  const out = new Uint8Array(distPx.length * 4);
  for (let i = 0; i < distPx.length; i++) {
    out[i * 4] = Math.min(255, Math.round(distPx[i] / ROOM_DIST_PX_PER_UNIT));
    out[i * 4 + 1] = encodeRoomVecByte(ox[i]);
    out[i * 4 + 2] = encodeRoomVecByte(oy[i]);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/**
 * The whole bake for one floor.
 * @param {object} args
 * @param {Array<object>} args.walls - `readSceneWallSegments(levelId)`.
 * @param {{minX:number,minY:number,cols:number,rows:number,cellSize:number}} args.spec
 * @param {object|null} [args.outdoors] - the floor's `_Outdoors` grid (`{spec, data}`), or null.
 * @param {number} [args.thicknessPx]
 * @returns {object} labels (walls 0), ids (walls dilated), outdoor, distPx, exposure, outlook {x,y} (dilated),
 *   idRgba, fieldRgba, stats.
 */
export function buildRoomMap({ walls, spec, outdoors = null, thicknessPx = ROOM_WALL_THICKNESS_DEFAULT_PX }) {
  const { cols, rows, cellSize } = spec;
  const barrier = rasterizeRoomBarriers(walls, spec, thicknessPx);
  const { labels, count, cellCount, touchesBorder } = labelRooms(barrier, cols, rows);
  const outdoor = classifyRoomsOutdoor(labels, count, spec, touchesBorder, outdoors);
  const distPx = roomWallDistancePx(barrier, cols, rows, cellSize);
  const exposure = collectRoomExposure(walls, labels, count, outdoor, spec, thicknessPx);
  const raw = computeRoomOutlook(walls, labels, count, outdoor, spec, thicknessPx);
  const dil = dilateRoomsIntoWalls(labels, raw.x, raw.y, cols, rows);
  let outdoorRooms = 0;
  let windowRooms = 0;
  for (let id = 1; id <= count; id++) {
    if (outdoor[id]) outdoorRooms++;
    for (let k = 0; k < ROOM_EXPOSURE_BINS; k++) {
      if (exposure.windowBins[id * ROOM_EXPOSURE_BINS + k] > 0) {
        windowRooms++;
        break;
      }
    }
  }
  return {
    spec,
    count,
    labels,
    ids: dil.ids,
    outdoor,
    distPx,
    exposure,
    outlook: { x: dil.x, y: dil.y },
    idRgba: encodeRoomIdsRgba(dil.ids),
    fieldRgba: encodeRoomFieldRgba(distPx, dil.x, dil.y),
    stats: {
      rooms: count,
      outdoorRooms,
      indoorRooms: count - outdoorRooms,
      windowRooms,
      largestRoomCells: cellCount.length > 1 ? Math.max(...cellCount.subarray(1)) : 0,
      grid: `${cols}x${rows}`,
      cellPx: +cellSize.toFixed(2),
    },
  };
}

/**
 * The outlook vector at a world point (nearest cell; walls carry their room's), `{x, y}` with |v| ≤ 1.
 * @param {{spec:object, outlook:{x:Float32Array,y:Float32Array}}} map @param {number} x @param {number} y
 */
export function roomOutlookAt(map, x, y) {
  const { minX, minY, cols, rows, cellSize } = map.spec;
  const c = Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / cellSize)));
  const r = Math.min(rows - 1, Math.max(0, Math.floor((y - minY) / cellSize)));
  return { x: map.outlook.x[r * cols + c], y: map.outlook.y[r * cols + c] };
}

/**
 * The room id at a world point (0 = a wall, or off the grid).
 * @param {{spec:object, labels:Int32Array}} map @param {number} x @param {number} y
 */
export function roomIdAt(map, x, y) {
  const { minX, minY, cols, rows, cellSize } = map.spec;
  const c = Math.floor((x - minX) / cellSize);
  const r = Math.floor((y - minY) / cellSize);
  if (c < 0 || r < 0 || c >= cols || r >= rows) return 0;
  return map.labels[r * cols + c];
}

/**
 * THE SHARED CACHE — one room map per floor, rebuilt only when what it was built from changes (the wall-structure
 * version, the `_Outdoors` product version, the scene rect or the wall thickness), and — given a clock — never more
 * often than every `minRebuildMs` while a GM is editing walls (the previous map stays up meanwhile). The clock is
 * injected (`time/one-clock`: scene code never samples time privately); without one there is no throttle and no
 * build timing.
 *
 * @param {object} args
 * @param {(floorIndex:number) => Array<object>} args.readWalls
 * @param {(floorIndex:number) => ({spec:object,data:Uint8Array,version?:number}|null)} [args.getOutdoors]
 * @param {() => {sceneRect:object, gridSizePixels:number}|null} args.getSceneGeometry
 * @param {() => number} [args.getWallVersion]
 * @param {(data:Uint8Array, w:number, h:number) => *} [args.createTexture] - a linear-filtered RGBA8 texture.
 * @param {() => number} [args.now]
 * @param {number} [args.minRebuildMs=250]
 * @param {(msg:string) => void} [args.onBuilt]
 */
export function createRoomMapCache({
  readWalls,
  getOutdoors = () => null,
  getSceneGeometry,
  getWallVersion = () => 0,
  createTexture = null,
  now = null,
  minRebuildMs = 250,
  onBuilt = null,
}) {
  /** @type {Map<number, {key:string, map:object, texture:*, fieldTexture:*, version:number, builtAt:number, buildMs:number}>} */
  const entries = new Map();
  let builds = 0;

  function keyFor(floorIndex, thicknessPx) {
    const geo = getSceneGeometry?.() ?? null;
    if (!geo?.sceneRect) return null;
    let outdoors = null;
    try {
      outdoors = getOutdoors(floorIndex);
    } catch {
      outdoors = null;
    }
    const r = geo.sceneRect;
    const key = [
      getWallVersion(),
      outdoors ? (outdoors.version ?? 0) : -1,
      r.x,
      r.y,
      r.width,
      r.height,
      geo.gridSizePixels,
      thicknessPx,
    ].join('|');
    return { key, geo, outdoors };
  }

  return {
    /**
     * This floor's room map, building or rebuilding it if needed. Returns null when there is no scene geometry yet.
     * @param {number} floorIndex
     * @param {{thicknessPx?: number}} [opts]
     */
    get(floorIndex, { thicknessPx = ROOM_WALL_THICKNESS_DEFAULT_PX } = {}) {
      const k = keyFor(floorIndex, thicknessPx);
      if (!k) return entries.get(floorIndex) ?? null;
      const prev = entries.get(floorIndex);
      if (prev && prev.key === k.key) return prev;
      if (prev && now && now() - prev.builtAt < minRebuildMs) return prev;
      const t0 = now ? now() : 0;
      const spec = computeRoomMapGridSpec({ sceneRect: k.geo.sceneRect, gridSizePixels: k.geo.gridSizePixels });
      const map = buildRoomMap({ walls: readWalls(floorIndex) ?? [], spec, outdoors: k.outdoors, thicknessPx });
      // Rewritten in place when the grid size is unchanged: a new texture object is a new binding (the lesson of the
      // wind bake), and a wall edit should not cost a material its texture nodes.
      const upload = (old, data) => {
        if (!createTexture) return null;
        if (old && old.image?.width === spec.cols && old.image?.height === spec.rows) {
          old.image.data.set(data);
          old.needsUpdate = true;
          return old;
        }
        old?.dispose?.();
        return createTexture(data, spec.cols, spec.rows);
      };
      const texture = upload(prev?.texture ?? null, map.idRgba);
      const fieldTexture = upload(prev?.fieldTexture ?? null, map.fieldRgba);
      builds++;
      const entry = {
        key: k.key,
        map,
        texture,
        fieldTexture,
        version: (prev?.version ?? 0) + 1,
        builtAt: now ? now() : 0,
        buildMs: now ? +(now() - t0).toFixed(1) : null,
      };
      entries.set(floorIndex, entry);
      onBuilt?.(
        `room map floor ${floorIndex}: ${map.stats.rooms} rooms (${map.stats.indoorRooms} indoor, ${map.stats.windowRooms} with windows) on a ${map.stats.grid} grid in ${entry.buildMs} ms`
      );
      return entry;
    },
    /** The last map built for a floor, without building. */
    peek: (floorIndex) => entries.get(floorIndex) ?? null,
    stats: () => ({ builds, floors: [...entries.keys()] }),
    /** Forget a floor (or every floor), disposing its texture. */
    drop(floorIndex = null) {
      for (const [f, e] of [...entries]) {
        if (floorIndex !== null && f !== floorIndex) continue;
        e.texture?.dispose?.();
        e.fieldTexture?.dispose?.();
        entries.delete(f);
      }
    },
  };
}
