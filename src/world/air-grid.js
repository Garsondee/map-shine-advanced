/**
 * world/air-grid.js — THE AIR'S GEOMETRY: a coarse 3-D box of air over the map, with walls that have height, roofs
 * that are lids and doors that are holes in the bottom two metres (2026-11-09, Lab · Air; claims `tools/lab/claims/air.md`).
 *
 * WHY 3-D. A top-down wind has walls of infinite height: air can only go ROUND a building, never over it, a walled yard
 * is a sealed box, and a wake has nothing to refill it from above. Ingram's brief: "surely wind must either go around a
 * building or be pushed upwards to go above it? We're requiring a 3D representation of that energy." So the air is a
 * stack of layers (`AIR_LAYER_BOUNDS_M`, ground to 22 m, finer near the ground where everything we draw lives).
 *
 * A STAGGERED (MAC) GRID WITH FACE APERTURES. Velocities live on cell FACES; each face has an open fraction 0..1. A
 * wall closes the faces it crosses, up to its height; it takes no cells, so a thin Foundry wall stays thin and a
 * one-square door is still a door at one cell per square. Every cell is air; obstacles are only faces:
 *   - a wall bounding a roofed cell stands to that roof's height (a building); a free-standing wall between two
 *     open-sky cells is a garden wall (`gardenWallHeightM`);
 *   - an open door (`solid: false`, `blocksExterior: true`) is open below `doorHeightM` and wall above it;
 *   - a wall that blocks nothing (`blocksExterior: false`: decorative, terrain) is ignored;
 *   - a roofed cell (painted `_Outdoors` dark) has a LID: its vertical face at the roof height is closed. Air above the
 *     lid is outdoor air flowing over the roof; air under it is indoors. A roof with no walls (a pavilion, an arcade)
 *     lets the wind through underneath, as it should.
 * Roof heights snap to the nearest layer boundary (the lid is a face); wall tops between boundaries close a FRACTION of
 * the face they cross.
 *
 * Walls are rasterised onto faces by sampling `AIR_FACE_SAMPLES` flow paths across each face (centre to centre): the
 * fraction of paths a wall cuts is the fraction of the face it closes. A wall along a grid line closes exactly the faces
 * it covers; a diagonal wall closes a staircase.
 *
 * PURE — no THREE, no Foundry (CONVENTIONS §4). Inputs are plain arrays and callbacks; Node-tested.
 *
 * @module world/air-grid
 */

/** Layer boundaries, metres above the ground: door top (2), garden wall (2), shed (3), house (6), tower (12, 16). */
export const AIR_LAYER_BOUNDS_M = Object.freeze([0, 1, 2, 3, 4.5, 6, 8.5, 12, 16, 22]);

export const AIR_GRID_DEFAULTS = Object.freeze({
  /** A roofed cell with no authored height: a two-storey house to the eaves, the common case on her maps. */
  buildingHeightM: 6,
  /** A wall with open sky on both sides: a garden or yard wall. */
  gardenWallHeightM: 2,
  /** An open door is open below this. */
  doorHeightM: 2,
  /** Open cells added round the scene on every side, so the weather can flow in and out. */
  marginCells: 4,
  /** A cell reads as roofed below this `_Outdoors` value (the wind bake's OPEN_SKY_THRESHOLD). */
  skyThreshold: 0.5,
  /** One storey: a building at least this + 1.4 m tall gets a first floor here (0 = none). */
  storeyM: 3,
  /** DRAFTINESS 0..1 (the GM's slider): how much shut doors and closed windows leak. 0 = airtight. */
  draftiness01: 0.35,
  /** The open fraction of a shut door's own height at full draftiness (gaps round a door). */
  shutDoorLeakMax: 0.12,
  /** The open fraction of a pane's height at full draftiness (old frames, rattling casements). */
  glassLeakMax: 0.05,
});

/** Flow paths sampled across each face to measure how much of it a wall closes. */
export const AIR_FACE_SAMPLES = 4;

/** Layer geometry from the bounds: thickness, centre, and the distance between neighbouring centres. */
export function airLayers(bounds = AIR_LAYER_BOUNDS_M) {
  const nz = bounds.length - 1;
  const zb = Float32Array.from(bounds);
  const dz = new Float32Array(nz);
  const zc = new Float32Array(nz);
  for (let k = 0; k < nz; k++) {
    dz[k] = bounds[k + 1] - bounds[k];
    zc[k] = 0.5 * (bounds[k] + bounds[k + 1]);
  }
  return { nz, zb, dz, zc };
}

/** Snap a height to the nearest layer boundary index (≥ 1: a roof is never on the ground). */
export function snapToBoundary(heightM, zb) {
  let best = 1;
  let bestD = Infinity;
  for (let k = 1; k < zb.length; k++) {
    const d = Math.abs(zb[k] - heightM);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

/** How much of layer k lies below height h, 0..1. */
export function layerCover(k, h, zb) {
  const lo = zb[k];
  const hi = zb[k + 1];
  if (h <= lo) return 0;
  if (h >= hi) return 1;
  return (h - lo) / (hi - lo);
}

/** Do segments (ax,ay)-(bx,by) and (cx,cy)-(dx,dy) cross? Proper or touching intersection, with a small tolerance. */
function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const rX = bx - ax;
  const rY = by - ay;
  const sX = dx - cx;
  const sY = dy - cy;
  const den = rX * sY - rY * sX;
  if (Math.abs(den) < 1e-12) return false; // parallel (a wall lying along a flow path never cuts it)
  const qX = cx - ax;
  const qY = cy - ay;
  const t = (qX * sY - qY * sX) / den;
  const u = (qX * rY - qY * rX) / den;
  const e = 1e-9;
  return t >= -e && t <= 1 + e && u >= -e && u <= 1 + e;
}

/**
 * Build the air's grid over a scene rect.
 *
 * @param {object} a
 * @param {Array<{x1:number,y1:number,x2:number,y2:number,solid:boolean,blocksExterior:boolean}>} a.walls - world px
 *   (`foundry/scene-walls.js#readSceneWallSegments`).
 * @param {{x:number,y:number,w:number,h:number}} a.rect - the scene rect, world px.
 * @param {number} a.cellPx - world px per cell (a grid square, or half of one).
 * @param {number} a.pxPerMetre
 * @param {(x:number, y:number) => number} [a.skyAt] - `_Outdoors` 0..1 at a world point (1 = open sky). Absent = all sky.
 * @param {(x:number, y:number) => (number|null)} [a.roofHeightAt] - an authored roof height (m) at a world point, or
 *   null for the default. Map facts (a tower, a shed), never taste.
 * @param {object} [a.opts] - overrides of {@link AIR_GRID_DEFAULTS}.
 * @param {number[]} [a.bounds] - layer bounds (m).
 */
export function buildAirGrid({
  walls,
  rect,
  cellPx,
  pxPerMetre,
  skyAt = null,
  roofHeightAt = null,
  opts = {},
  bounds,
}) {
  const o = { ...AIR_GRID_DEFAULTS, ...opts };
  const { nz, zb, dz, zc } = airLayers(bounds ?? AIR_LAYER_BOUNDS_M);
  const m = Math.max(0, o.marginCells | 0);
  // Align to the cell lattice (Foundry's grid lines are multiples of the grid size from the canvas origin).
  const x0 = Math.floor(rect.x / cellPx) * cellPx - m * cellPx;
  const y0 = Math.floor(rect.y / cellPx) * cellPx - m * cellPx;
  const x1 = Math.ceil((rect.x + rect.w) / cellPx) * cellPx + m * cellPx;
  const y1 = Math.ceil((rect.y + rect.h) / cellPx) * cellPx + m * cellPx;
  const nx = Math.max(1, Math.round((x1 - x0) / cellPx));
  const ny = Math.max(1, Math.round((y1 - y0) / cellPx));
  const h = cellPx / pxPerMetre;
  const inScene = (px, py) => px >= rect.x && px < rect.x + rect.w && py >= rect.y && py < rect.y + rect.h;

  // Roofs: per column, the lid's boundary index (0 = open sky).
  const lid = new Uint8Array(nx * ny);
  const roofH = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const px = x0 + (i + 0.5) * cellPx;
      const py = y0 + (j + 0.5) * cellPx;
      if (!inScene(px, py) || !skyAt) continue;
      const s = skyAt(px, py);
      if (!(s < o.skyThreshold)) continue;
      const authored = roofHeightAt ? roofHeightAt(px, py) : null;
      const hm = Number.isFinite(authored) && authored > 0 ? authored : o.buildingHeightM;
      const kb = snapToBoundary(hm, zb);
      lid[j * nx + i] = kb;
      roofH[j * nx + i] = zb[kb];
    }
  }

  // Wall coverage per horizontal face, by kind: open door 1, glass 2, shut door 3, wall 4 (the most closed wins).
  const S = AIR_FACE_SAMPLES;
  const NFX = (nx + 1) * ny;
  const NFY = nx * (ny + 1);
  const hitX = new Uint8Array(NFX * S);
  const hitY = new Uint8Array(NFY * S);
  const kindOf = (w) => (!w.solid ? 1 : w.window ? 2 : w.door ? 3 : 4);
  for (const w of walls ?? []) {
    if (!w || !w.blocksExterior) continue;
    const kind = kindOf(w);
    const minI = Math.max(0, Math.floor((Math.min(w.x1, w.x2) - x0) / cellPx) - 1);
    const maxI = Math.min(nx, Math.ceil((Math.max(w.x1, w.x2) - x0) / cellPx) + 1);
    const minJ = Math.max(0, Math.floor((Math.min(w.y1, w.y2) - y0) / cellPx) - 1);
    const maxJ = Math.min(ny, Math.ceil((Math.max(w.y1, w.y2) - y0) / cellPx) + 1);
    // x-faces: face (i, j) sits on x = x0 + i·cellPx; its flow paths run from cell i-1's centre to cell i's.
    for (let j = minJ; j < Math.min(ny, maxJ + 1); j++) {
      for (let i = minI; i <= maxI; i++) {
        const fx = x0 + i * cellPx;
        for (let s = 0; s < S; s++) {
          const py = y0 + (j + (s + 0.5) / S) * cellPx;
          if (segmentsCross(fx - 0.5 * cellPx, py, fx + 0.5 * cellPx, py, w.x1, w.y1, w.x2, w.y2)) {
            const q = (j * (nx + 1) + i) * S + s;
            if (kind > hitX[q]) hitX[q] = kind;
          }
        }
      }
    }
    // y-faces: face (i, j) sits on y = y0 + j·cellPx.
    for (let j = minJ; j <= maxJ; j++) {
      for (let i = minI; i < Math.min(nx, maxI + 1); i++) {
        const fy = y0 + j * cellPx;
        for (let s = 0; s < S; s++) {
          const px = x0 + (i + (s + 0.5) / S) * cellPx;
          if (segmentsCross(px, fy - 0.5 * cellPx, px, fy + 0.5 * cellPx, w.x1, w.y1, w.x2, w.y2)) {
            const q = (j * nx + i) * S + s;
            if (kind > hitY[q]) hitY[q] = kind;
          }
        }
      }
    }
  }
  /** Per face: the fraction of its flow paths cut by each kind, [open, glass, shut, wall]. */
  const fractions = (hit, n) => {
    const out = new Float32Array(n * 4);
    for (let f = 0; f < n; f++) {
      for (let s = 0; s < S; s++) {
        const v = hit[f * S + s];
        if (v > 0) out[f * 4 + v - 1] += 1 / S;
      }
    }
    return out;
  };
  const frX = fractions(hitX, NFX);
  const frY = fractions(hitY, NFY);

  // A wall's height: a building's roof if either side is roofed, else a garden wall.
  const wallTop = (ca, cb) => {
    const ha = ca >= 0 ? roofH[ca] : 0;
    const hb = cb >= 0 ? roofH[cb] : 0;
    const hr = Math.max(ha, hb);
    return hr > 0 ? hr : o.gardenWallHeightM;
  };
  // DRAFTINESS (Ingram, 2026-11-09: "windows which are not open will leak a little wind into rooms and doors will allow
  // a bit of pressure past them without being opened"): a shut door stays a little open over its own height, a pane
  // over the bottom 3 m; a wall never leaks.
  const draft = Math.min(1, Math.max(0, o.draftiness01));
  const leakDoor = draft * o.shutDoorLeakMax;
  const leakGlass = draft * o.glassLeakMax;
  const closed = (fr, f, k, top) => {
    const wall = layerCover(k, top, zb);
    const doorPart = layerCover(k, o.doorHeightM, zb);
    const aboveDoor = Math.max(0, wall - doorPart);
    const glassPart = Math.min(wall, layerCover(k, 3, zb));
    return (
      fr[f * 4] * aboveDoor +
      fr[f * 4 + 1] * (wall - leakGlass * glassPart) +
      fr[f * 4 + 2] * (wall - leakDoor * Math.min(wall, doorPart)) +
      fr[f * 4 + 3] * wall
    );
  };
  const any = (fr, f) => fr[f * 4] + fr[f * 4 + 1] + fr[f * 4 + 2] + fr[f * 4 + 3] > 0;

  // Apertures per layer.
  const ax = new Float32Array(NFX * nz).fill(1);
  const ay = new Float32Array(NFY * nz).fill(1);
  const az = new Float32Array(nx * ny * (nz + 1)).fill(1);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const f = j * (nx + 1) + i;
      if (!any(frX, f)) continue;
      const top = wallTop(i > 0 ? j * nx + i - 1 : -1, i < nx ? j * nx + i : -1);
      for (let k = 0; k < nz; k++) ax[(k * ny + j) * (nx + 1) + i] = Math.max(0, 1 - closed(frX, f, k, top));
    }
  }
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i < nx; i++) {
      const f = j * nx + i;
      if (!any(frY, f)) continue;
      const top = wallTop(j > 0 ? (j - 1) * nx + i : -1, j < ny ? j * nx + i : -1);
      for (let k = 0; k < nz; k++) ay[(k * (ny + 1) + j) * nx + i] = Math.max(0, 1 - closed(frY, f, k, top));
    }
  }
  // The ground is closed; the top is open (the sky); a roof is a lid at its boundary. A building taller than a storey
  // has a first floor: the ground-floor rooms are a storey tall, not the whole building (the floor is a closed face;
  // the upper storey, with no door of its own, is still air).
  const storeyK = o.storeyM > 0 ? snapToBoundary(o.storeyM, zb) : 0;
  for (let c = 0; c < nx * ny; c++) {
    az[c] = 0;
    if (lid[c] > 0 && lid[c] < nz) az[lid[c] * nx * ny + c] = 0;
    if (storeyK > 0 && lid[c] > storeyK && roofH[c] >= o.storeyM + 1.4) az[storeyK * nx * ny + c] = 0;
  }
  // Indoor cells: under a lid.
  const indoor = new Uint8Array(nx * ny * nz);
  for (let c = 0; c < nx * ny; c++) {
    for (let k = 0; k < lid[c]; k++) indoor[k * nx * ny + c] = 1;
  }

  return {
    nx,
    ny,
    nz,
    h,
    cellPx,
    pxPerMetre,
    originX: x0,
    originY: y0,
    margin: m,
    zb,
    dz,
    zc,
    ax,
    ay,
    az,
    lid,
    roofH,
    indoor,
    doorHeightM: o.doorHeightM,
    draftiness01: Math.min(1, Math.max(0, o.draftiness01)),
  };
}

/** Cell index of world point (px) at layer k, or -1 off the grid. */
export function airCellAt(grid, xPx, yPx, k = 0) {
  const i = Math.floor((xPx - grid.originX) / grid.cellPx);
  const j = Math.floor((yPx - grid.originY) / grid.cellPx);
  if (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny || k < 0 || k >= grid.nz) return -1;
  return (k * grid.ny + j) * grid.nx + i;
}

/**
 * Cells with no open path to the sky or the grid's edge (a sealed room). Their air is held still: interpolation can
 * never seed a swirl there. Flood fill from every edge cell and every cell with an open top.
 * @returns {Uint8Array} 1 = sealed.
 */
export function airSealedCells(grid) {
  const { nx, ny, nz, ax, ay, az } = grid;
  const n = nx * ny * nz;
  const reached = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const push = (c) => {
    if (!reached[c]) {
      reached[c] = 1;
      stack[sp++] = c;
    }
  };
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = (k * ny + j) * nx + i;
        const edge = i === 0 || j === 0 || i === nx - 1 || j === ny - 1;
        const top = k === nz - 1 && az[nz * nx * ny + j * nx + i] > 0;
        if (edge || top) push(c);
      }
    }
  }
  while (sp > 0) {
    const c = stack[--sp];
    const i = c % nx;
    const j = ((c - i) / nx) % ny;
    const k = Math.floor(c / (nx * ny));
    if (i > 0 && ax[(k * ny + j) * (nx + 1) + i] > 0) push(c - 1);
    if (i < nx - 1 && ax[(k * ny + j) * (nx + 1) + i + 1] > 0) push(c + 1);
    if (j > 0 && ay[(k * (ny + 1) + j) * nx + i] > 0) push(c - nx);
    if (j < ny - 1 && ay[(k * (ny + 1) + j + 1) * nx + i] > 0) push(c + nx);
    if (k > 0 && az[k * nx * ny + j * nx + i] > 0) push(c - nx * ny);
    if (k < nz - 1 && az[(k + 1) * nx * ny + j * nx + i] > 0) push(c + nx * ny);
  }
  const sealed = new Uint8Array(n);
  for (let c = 0; c < n; c++) sealed[c] = reached[c] ? 0 : 1;
  return sealed;
}
