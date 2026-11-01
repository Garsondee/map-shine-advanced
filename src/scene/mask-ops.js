/**
 * MASK OPS — the painter's edit history, kept as WORLD-SPACE operations so a
 * painted mask can be drawn again at ANY resolution.
 *
 * Why this exists (author, 2026-11-01: "allow the user to save a full
 * resolution version of the mask to their own computer ... so that everything
 * lines up automatically"). The live painter edits a grid capped at
 * `PAINT_GRID_MAX_DIM` (4096) — a quarter of a 16K map's pixels. Scaling that
 * grid up to the map's size would give every edge a 4-pixel staircase. So the
 * painter ALSO records what it did — a brush stroke's input points, a
 * polygon's vertices, a room's coverage — and the exporter replays that record
 * onto a grid the size of the map art. Shapes come out pixel-sharp; the brush
 * comes out exactly as soft as it was painted, because the same falloff runs
 * at the finer resolution.
 *
 * THE INVARIANT the Node suite holds this module to: replaying a layer's ops
 * onto the painter's own grid spec gives the SAME bytes the painter's live
 * edits produced. Every op below calls the same rasterizer the painter calls
 * (`paint-mask.js`), with the same arguments, in world units — so the history
 * and the grid can never be two different pictures.
 *
 * OPS (all coordinates world = Foundry canvas space, +Y down):
 *   { t: 'fill',   v }                                   every texel = v
 *   { t: 'stroke', pts:[x,y,…], r, v, h, m }             a brush stroke ({@link stampStroke})
 *   { t: 'poly',   pts:[x,y,…], v, m }                   a filled polygon (rect + grid cells too)
 *   { t: 'line',   pts:[x,y,…], w, v, h, m }             a stroked polyline
 *   { t: 'cover',  rect, w, h, rle, v, m }               raster COVERAGE (room fills): where the
 *                                                         coverage reads ≥ ½, apply v with mode m
 *   { t: 'seed',   rect, w, h, rle, over?, url? }        raster CONTENT: the layer becomes this
 *                                                         picture (over:true = only where it is > 0).
 *                                                         `url` names the full-size file it came
 *                                                         from, so an exporter can read that instead.
 * `m` is the brush mode: 'paint' (max), 'add' (build up), 'erase' (subtract).
 *
 * Raster ops are sampled BILINEARLY when the target is finer than their own
 * grid; a coverage op then thresholds at ½, which is what turns a blocky room
 * fill into a smooth edge at full size instead of an enlarged staircase.
 *
 * Pure: no DOM, no Foundry. Node-tested (`__tests__/mask-ops.test.mjs`).
 *
 * @module scene/mask-ops
 */

import { stampBrushWorld, rasterizePolygon, rasterizeStrokedLine, encodePaintLayer } from './paint-mask.js';
import { computeRoomMapGridSpec, rasterizeRoomBarriers, labelRooms } from './room-map.js';

/** Byte budget for one layer's op list in the scene flag. Over it, the history
 * is flattened into one `seed` of the current grid (see {@link compactOps}). */
export const OPS_EMBED_BYTE_BUDGET = 256 * 1024;

/** Cells per grid square for wall-derived room coverage — finer than the room
 * map's own 8 so the indoor edge lands closer to the wall line. */
export const ROOM_COVER_CELLS_PER_GRID = 12;
/** Long-side cap for room coverage grids. */
export const ROOM_COVER_MAX_DIM = 2048;

/** Brush dab spacing along a stroke, as a fraction of the radius — the
 * painter's own spacing, shared so live painting and replay agree. */
export const STROKE_SPACING_FRACTION = 0.25;

function applyValue(data, i, v, m) {
  if (m === 'erase') data[i] = Math.max(0, data[i] - v);
  else if (m === 'add') data[i] = Math.min(255, data[i] + v);
  else data[i] = Math.max(data[i], v);
}

/**
 * Stamp a whole brush stroke the way the painter does live: the first point is
 * one dab, then each later point is reached in dabs spaced a quarter of the
 * radius apart (in WORLD units, so the spacing is the same at any resolution).
 * @param {{spec:object, data:Uint8Array}} layer
 * @param {number[]} pts - flat [x0,y0,x1,y1,…].
 * @param {number} radius - world units.
 * @param {{value?:number, hardness?:number, mode?:string}} opts
 */
export function stampStroke(layer, pts, radius, opts) {
  if (!Array.isArray(pts) || pts.length < 2) return layer;
  let px = pts[0];
  let py = pts[1];
  stampBrushWorld(layer, px, py, radius, opts);
  for (let k = 2; k + 1 < pts.length; k += 2) {
    const x = pts[k];
    const y = pts[k + 1];
    const dx = x - px;
    const dy = y - py;
    const spacing = Math.max(1, radius * STROKE_SPACING_FRACTION);
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / spacing));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      stampBrushWorld(layer, px + dx * t, py + dy * t, radius, opts);
    }
    px = x;
    py = y;
  }
  return layer;
}

/** [x,y,…] → [{x,y},…] */
function toPoints(flat) {
  const out = [];
  for (let k = 0; k + 1 < flat.length; k += 2) out.push({ x: flat[k], y: flat[k + 1] });
  return out;
}

/** Decoded raster content of a `cover`/`seed` op, memoised per op object. */
const decoded = new WeakMap();
function rasterOf(op) {
  let d = decoded.get(op);
  if (d) return d;
  const data = new Uint8Array(op.w * op.h);
  let di = 0;
  const rle = op.rle ?? [];
  for (let i = 0; i + 1 < rle.length; i += 2) {
    const v = rle[i];
    const run = rle[i + 1];
    for (let k = 0; k < run && di < data.length; k++) data[di++] = v;
  }
  d = data;
  decoded.set(op, d);
  return d;
}

/**
 * Bilinear read of a raster op at a world point (texel centres at +½), edge-
 * clamped. Returns 0 outside the op's rect.
 */
function sampleRaster(op, data, wx, wy) {
  const r = op.rect;
  const u = ((wx - r.x) / r.width) * op.w - 0.5;
  const v = ((wy - r.y) / r.height) * op.h - 0.5;
  if (u < -0.5 || v < -0.5 || u > op.w - 0.5 || v > op.h - 0.5) return 0;
  const x0 = Math.max(0, Math.min(op.w - 1, Math.floor(u)));
  const y0 = Math.max(0, Math.min(op.h - 1, Math.floor(v)));
  const x1 = Math.min(op.w - 1, x0 + 1);
  const y1 = Math.min(op.h - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, u - x0));
  const fy = Math.max(0, Math.min(1, v - y0));
  const a = data[y0 * op.w + x0];
  const b = data[y0 * op.w + x1];
  const c = data[y1 * op.w + x0];
  const d = data[y1 * op.w + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/**
 * Apply a raster op to every texel of `layer` its rect overlaps.
 * @param {{spec:object, data:Uint8Array}} layer
 * @param {object} op - a `cover` or `seed` op.
 * @param {(wx:number, wy:number) => number} [read] - overrides the op's own
 *   raster (an exporter reading the full-size file a `seed` came from).
 */
function applyRaster(layer, op, read) {
  const { spec, data } = layer;
  const r = op.rect;
  const own = read ? null : rasterOf(op);
  const sample = read ?? ((wx, wy) => sampleRaster(op, own, wx, wy));
  const gx0 = Math.max(0, Math.floor((r.x - spec.x) / spec.texelW));
  const gy0 = Math.max(0, Math.floor((r.y - spec.y) / spec.texelH));
  const gx1 = Math.min(spec.w - 1, Math.ceil((r.x + r.width - spec.x) / spec.texelW) - 1);
  const gy1 = Math.min(spec.h - 1, Math.ceil((r.y + r.height - spec.y) / spec.texelH) - 1);
  if (op.t === 'seed' && !op.over) {
    // A plain seed REPLACES the whole layer — outside its rect too.
    data.fill(0);
  }
  for (let gy = gy0; gy <= gy1; gy++) {
    const wy = spec.y + (gy + 0.5) * spec.texelH;
    const row = gy * spec.w;
    for (let gx = gx0; gx <= gx1; gx++) {
      const wx = spec.x + (gx + 0.5) * spec.texelW;
      const s = sample(wx, wy);
      const i = row + gx;
      if (op.t === 'cover') {
        if (s >= 127.5) applyValue(data, i, op.v ?? 255, op.m ?? 'paint');
      } else if (op.over) {
        if (s > 0.5) data[i] = Math.round(s);
      } else {
        data[i] = Math.round(s);
      }
    }
  }
}

/**
 * Apply one op to a layer of ANY resolution.
 * @param {{spec:object, data:Uint8Array}} layer
 * @param {object} op
 * @param {{readSeed?: (op:object) => ((wx:number, wy:number) => number)|null}} [env]
 */
export function applyOp(layer, op, env = {}) {
  if (!op || typeof op !== 'object') return layer;
  switch (op.t) {
    case 'fill':
      layer.data.fill(Math.max(0, Math.min(255, Math.round(op.v ?? 0))));
      return layer;
    case 'stroke':
      return stampStroke(layer, op.pts, op.r, { value: op.v, hardness: op.h, mode: op.m });
    case 'poly':
      return rasterizePolygon(layer, toPoints(op.pts ?? []), { value: op.v, mode: op.m });
    case 'line':
      return rasterizeStrokedLine(layer, toPoints(op.pts ?? []), op.w, { value: op.v, mode: op.m, hardness: op.h });
    case 'cover':
      applyRaster(layer, op);
      return layer;
    case 'seed': {
      const read = env.readSeed?.(op) ?? undefined;
      // A FILE seed carries no raster of its own (see `fileSeed`): without a
      // reader for its file there is nothing to draw, and drawing nothing
      // must not wipe the layer — the painter's grid already holds the file.
      if (!read && !(op.rle?.length > 0)) return layer;
      applyRaster(layer, op, read);
      return layer;
    }
    default:
      return layer; // an op from a newer version: skipped, never thrown on
  }
}

/** Replay a whole op list onto a layer (which should start empty). */
export function replayOps(layer, ops, env) {
  for (const op of ops ?? []) applyOp(layer, op, env);
  return layer;
}

/**
 * A grid spec covering `rect` at exactly `w`×`h` texels — the exporter's
 * target (the map art's own pixel size), or one tile of it.
 */
export function specForRect(rect, w, h) {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    w,
    h,
    texelW: rect.width / w,
    texelH: rect.height / h,
  };
}

/**
 * One horizontal band of a full-size export: rows [row0, row1) of a `w`×`h`
 * picture over `rect`, as its own grid spec. Banding keeps the working buffer
 * small however big the map is.
 */
export function bandSpec(rect, w, h, row0, row1) {
  const texelH = rect.height / h;
  return {
    x: rect.x,
    y: rect.y + row0 * texelH,
    width: rect.width,
    height: (row1 - row0) * texelH,
    w,
    h: row1 - row0,
    texelW: rect.width / w,
    texelH,
  };
}

/** JSON size of an op list, for the embed budget. */
export function opsByteEstimate(ops) {
  return JSON.stringify(ops ?? []).length;
}

/**
 * Keep a layer's history within the embed budget: over it, the history is
 * replaced by one `seed` of the CURRENT grid (the picture is unchanged; only
 * full-size sharpness of the older edits is given up, never content). A
 * leading url-seed survives, so a layer that started from a file keeps reading
 * that file at full size.
 * @param {object[]} ops @param {{spec:object, data:Uint8Array}} layer
 * @returns {{ops: object[], compacted: boolean}}
 */
export function compactOps(ops, layer, budget = OPS_EMBED_BYTE_BUDGET) {
  if (opsByteEstimate(ops) <= budget) return { ops, compacted: false };
  return { ops: [seedFromGrid(layer)], compacted: true };
}

/** Does this history start from a mask file (so a full-size export needs it)? */
export function fileSeedUrlOf(ops) {
  const first = Array.isArray(ops) ? ops.find((op) => op?.t === 'seed' && op.url) : null;
  return first?.url ?? null;
}

/** A `seed` op holding a grid's current content. */
export function seedFromGrid(layer, { over = false, url = null } = {}) {
  const enc = encodePaintLayer(layer);
  const s = layer.spec;
  const op = {
    t: 'seed',
    rect: { x: s.x, y: s.y, width: s.width, height: s.height },
    w: enc.w,
    h: enc.h,
    rle: enc.rle,
  };
  if (over) op.over = true;
  if (url) op.url = url;
  return op;
}

/**
 * A seed that names a mask FILE and stores no copy of it: the history of a
 * layer the painter opened from an existing file. An exporter reads the file
 * itself at full size (`env.readSeed`); the painter's own grid was already
 * loaded from it. Keeping no raster keeps a big Photoshop mask out of the
 * scene flag.
 */
export function fileSeed(url, rect) {
  return {
    t: 'seed',
    url,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    w: 0,
    h: 0,
    rle: [],
  };
}

/** True when an op list is safe to persist (every entry a known shape). */
export function isValidOpList(ops) {
  if (!Array.isArray(ops)) return false;
  const known = new Set(['fill', 'stroke', 'poly', 'line', 'cover', 'seed']);
  return ops.every((op) => op && typeof op === 'object' && known.has(op.t));
}

/** Every grid-cell polygon of `cells` → one `poly` op each. */
export function cellOps(cells, v, m) {
  return cells.filter((pts) => Array.isArray(pts) && pts.length >= 6).map((pts) => ({ t: 'poly', pts, v, m }));
}

/** An axis-aligned rectangle between two world corners, as polygon points. */
export function rectPoints(a, b) {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  return [x0, y0, x1, y0, x1, y1, x0, y1];
}

/** A room whose cells come within this many cells of the scene edge runs ALONG it. */
export const ROOM_EDGE_BAND_CELLS = 3;
/** With a walled-in edge, a room running along at least this share of the edge is outdoors. */
export const ROOM_EDGE_SHARE_OUTDOORS = 0.1;

/**
 * Which rooms are OUTDOORS, for "Start from walls".
 *
 * The obvious rule — a room that reaches the scene edge is outdoors — is the
 * room map's own, and it fails on most real maps: map makers wall the scene's
 * EDGE so tokens cannot walk off it, which makes the yard a closed room too.
 * Measured on the Docklands Warehouse (2026-11-01): 130 walls, every one of its
 * 10 spaces sealed, so "reaches the edge" called the whole map indoors (100%,
 * against the shipped mask's 55.7%). The yard is still unmistakable: it runs
 * along most of the edge (51% of the map), while the rooms of buildings set
 * against the edge touch it only in short stretches — and every one of those
 * was indoors in the shipped mask.
 *
 * So: a room that truly reaches the edge is outdoors (unchanged); and when the
 * edge is walled in, a room running along at least
 * {@link ROOM_EDGE_SHARE_OUTDOORS} of the edge band is outdoors too, as is the
 * one that runs along the most of it. A first guess the GM corrects — a
 * dungeon cut into rock will call the rock "outdoors", which is one click of
 * Fill room to put right.
 * @returns {Uint8Array} indexed by room id, 1 = outdoors.
 */
export function outdoorRooms({ labels, count, cols, rows, touchesBorder }) {
  const out = new Uint8Array(count + 1);
  let anyBorder = false;
  for (let id = 1; id <= count; id++) {
    if (touchesBorder[id]) {
      out[id] = 1;
      anyBorder = true;
    }
  }
  if (anyBorder) return out;
  const band = ROOM_EDGE_BAND_CELLS;
  const along = new Float64Array(count + 1);
  let bandCells = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (Math.min(c, r, cols - 1 - c, rows - 1 - r) >= band) continue;
      bandCells++;
      const id = labels[r * cols + c];
      if (id) along[id]++;
    }
  }
  let best = 0;
  for (let id = 1; id <= count; id++) {
    if (along[id] > along[best]) best = id;
    if (bandCells > 0 && along[id] / bandCells >= ROOM_EDGE_SHARE_OUTDOORS) out[id] = 1;
  }
  if (best > 0) out[best] = 1;
  return out;
}

/**
 * ROOMS FROM WALLS — the coverage behind "Fill room" and "Start from walls".
 *
 * Builds on `room-map.js` (the same barrier rasterizer and 4-connected room
 * labelling the window light uses), on a finer grid. Wall cells are then
 * handed to the room next to them, a few cells deep, so the filled region
 * reaches the wall LINE rather than stopping half a wall's thickness short —
 * the filled edge then sits where the map's walls are drawn.
 *
 * @param {object} args
 * @param {Array<{x1:number,y1:number,x2:number,y2:number,roomBarrier?:boolean}>} args.walls
 * @param {{x:number,y:number,width:number,height:number}} args.sceneRect
 * @param {number} [args.gridSize=100]
 * @param {{x:number,y:number}|null} [args.at] - one room: the one containing this point.
 *   Omitted: every room {@link outdoorRooms} does not call outdoors.
 * @returns {{op: object|null, rooms: number, reason?: string}} a `cover` op (v/m unset — the caller sets them).
 */
export function roomCoverFromWalls({ walls, sceneRect, gridSize = 100, at = null }) {
  const spec = computeRoomMapGridSpec({
    sceneRect,
    gridSizePixels: (gridSize * 8) / ROOM_COVER_CELLS_PER_GRID,
    maxDim: ROOM_COVER_MAX_DIM,
  });
  const { cols, rows, cellSize, minX, minY } = spec;
  const barrier = rasterizeRoomBarriers(walls, spec);
  const { labels, count, touchesBorder } = labelRooms(barrier, cols, rows);
  if (count === 0) return { op: null, rooms: 0, reason: 'no open space between the walls' };

  const chosen = new Uint8Array(count + 1);
  let picked = 0;
  if (at) {
    const c = Math.floor((at.x - minX) / cellSize);
    const r = Math.floor((at.y - minY) / cellSize);
    if (c < 0 || r < 0 || c >= cols || r >= rows)
      return { op: null, rooms: 0, reason: 'that point is outside the scene' };
    const id = labels[r * cols + c];
    if (!id) return { op: null, rooms: 0, reason: 'that point is on a wall — click inside the room' };
    chosen[id] = 1;
    picked = 1;
  } else {
    const outdoor = outdoorRooms({ labels, count, cols, rows, touchesBorder });
    for (let id = 1; id <= count; id++) {
      if (!outdoor[id]) {
        chosen[id] = 1;
        picked++;
      }
    }
    if (picked === 0) return { op: null, rooms: 0, reason: 'no closed rooms — every space reaches the scene edge' };
  }

  // Coverage: chosen rooms 255; then wall cells take a chosen neighbour's
  // coverage, a few passes deep (walls are drawn ~10 px thick, cells ~8 px).
  const cover = new Uint8Array(cols * rows);
  for (let i = 0; i < labels.length; i++) if (chosen[labels[i]]) cover[i] = 255;
  const passes = Math.max(1, Math.ceil(6 / cellSize) + 1);
  for (let p = 0; p < passes; p++) {
    const next = cover.slice();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (!barrier[i] || cover[i]) continue;
        if (
          (c > 0 && cover[i - 1]) ||
          (c < cols - 1 && cover[i + 1]) ||
          (r > 0 && cover[i - cols]) ||
          (r < rows - 1 && cover[i + cols])
        )
          next[i] = 255;
      }
    }
    cover.set(next);
  }
  const enc = encodePaintLayer({ spec: { w: cols, h: rows }, data: cover });
  return {
    op: {
      t: 'cover',
      rect: { x: minX, y: minY, width: cols * cellSize, height: rows * cellSize },
      w: cols,
      h: rows,
      rle: enc.rle,
    },
    rooms: picked,
  };
}

/**
 * The value a mask FILE pixel means, as one painted byte: grey × coverage,
 * with transparency reading as the kind's own absent value (an `_Outdoors`
 * file's transparent pixels mean outdoors; a `_Fire` file's mean no fire).
 * @param {number} grey 0..255 @param {number} alpha 0..255 @param {number} absentValue 0..1
 */
export function fileByteToPainted(grey, alpha, absentValue) {
  const a = alpha / 255;
  return Math.round(grey * a + absentValue * 255 * (1 - a));
}
