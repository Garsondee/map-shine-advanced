/**
 * tools/lab/air-spec.mjs — Lab · Air, as data (2026-11-09): the 3-D air's experimental scene.
 *
 * Every plot exists for claims in tools/lab/claims/air.md. The wind blows toward +x (MSA 90°), so upwind is the left
 * and every lee is to the right. Plots sit in LANES across the wind, each with its own clear fetch upwind, so one
 * plot's wake never reaches another's.
 *
 * Buildings are sets of squares with a HEIGHT (a map fact: the scene flag `airRoofs`, scene px, read by MSA's air
 * grid); their walls are the outline of the set, doors are unit edges of it left open. A wall with open sky on both
 * sides is a 2 m garden wall.
 *
 * SCALE. 150 px grid, 5-ft squares (her maps): 98.43 px/m. LAYOUT 100 x 88 squares (152 x 134 m):
 *   L1 (y 0-12)   AH1 lone house 8x8 sq (12 m), 6 m tall; transect out to 100 m behind it.
 *   L2 (y 12-24)  AH2 tower 4x4 sq, 16 m tall.
 *   L3 (y 24-36)  AH3 shed 4x4 sq, 3 m tall; AH4 a 2 m garden wall across the wind further down the lane.
 *   L4 (y 36-50)  AH5 funnel: two stepped blocks narrowing a 9 m mouth to a 3 m throat.
 *   L5 (y 50-62)  AH6 windward-door dead-end room; AH7 cross-ventilated room; AH8 lee-door room.
 *   L6 (y 62-75)  AH9 tunnel along the wind; AH10 pavilion (roof on posts); AH11 courtyard (house ring, open middle).
 *   L7 (y 75-88)  AH12 two-room house (windward door, inner door); AH13 street across the wind (W = H = 6 m).
 *
 * Pure. Coordinates: scene pixels (the builder adds Foundry's padding offset).
 *
 * @module tools/lab/air-spec
 */
import {
  GRID,
  GREY,
  INK,
  LAB_FLAG,
  LAB_SKY,
  LAB_VERSION,
  MODULE_ID,
  PADDING,
  SENSE,
  DOOR,
  indoorRegion,
  paintOps,
} from './lab-spec.mjs';
import { ART, PLANTS } from './vegetation-spec.mjs';

const { sq, rect, text } = paintOps;

export const AIR_IDS = Object.freeze({ scene: 'msaLabAir0000000', level: 'msaLabAirGrnd000' });
export const AIR_SIZE = Object.freeze({ w: sq(100), h: sq(109) }); // WebP caps a side at 16383 px
export const AIR_PX_PER_METRE = GRID / (5 * 0.3048);
export const AIR_IMAGE_REV = 1;
export const AIR_LAB_WIND = Object.freeze({ directionDeg: 90, speed01: 0.15 });

const FLOOR = Object.freeze({ key: 'ground', name: 'Ground', id: AIR_IDS.level, bottom: 0, top: 20 });
const NORMAL = Object.freeze({ move: SENSE.NORMAL, sight: SENSE.NORMAL, light: SENSE.NORMAL, sound: SENSE.NORMAL });
const OPEN_DOOR = Object.freeze({ ...NORMAL, door: DOOR.DOOR, ds: 1 });
const SHUT_DOOR = Object.freeze({ ...NORMAL, door: DOOR.DOOR, ds: 0 });
/** Closed glass the way her maps author windows (light/sight PROXIMITY with a threshold, movement blocked). */
const WINDOW = Object.freeze({
  move: SENSE.NORMAL,
  sight: SENSE.PROXIMITY,
  light: SENSE.PROXIMITY,
  sound: SENSE.NORMAL,
  threshold: { light: 10, sight: 10, sound: null, attenuation: true },
});
const KIND_DATA = Object.freeze({ wall: NORMAL, door: OPEN_DOOR, shut: SHUT_DOOR, glass: WINDOW });

/**
 * An axis-aligned inner wall (squares) with openings along it: `open` and `shut` door spans [from, to] (squares along
 * the wall's axis). Returns the wall pieces with the doors between them.
 */
function wallLine([x1, y1, x2, y2], { open = [], shut = [] } = {}) {
  const vert = x1 === x2;
  const a0 = vert ? Math.min(y1, y2) : Math.min(x1, x2);
  const a1 = vert ? Math.max(y1, y2) : Math.max(x1, x2);
  const at = (t) => (vert ? [x1, t] : [t, y1]);
  const cuts = [...open.map((s) => ({ s, kind: 'door' })), ...shut.map((s) => ({ s, kind: 'shut' }))].sort(
    (p, q) => p.s[0] - q.s[0]
  );
  const out = [];
  let t = a0;
  for (const {
    s: [f, g],
    kind,
  } of cuts) {
    if (f > t) out.push({ c: [...at(t), ...at(f)].map(sq), ...NORMAL });
    out.push({ c: [...at(f), ...at(g)].map(sq), ...KIND_DATA[kind] });
    t = g;
  }
  if (a1 > t) out.push({ c: [...at(t), ...at(a1)].map(sq), ...NORMAL });
  return out;
}

const BLACK = [0, 0, 0, 255];
const WALL_INK = [40, 40, 40, 255];
const roofShade = (hM) => {
  const g = Math.max(60, Math.min(120, 120 - hM * 4));
  return [g, g, g + 6, 255];
};

/**
 * The outline of a set of squares as unit wall edges (squares), minus the edges listed as doors or open sides.
 * @param {Array<[number,number,number,number]>} rects - [x, y, w, h] squares.
 * @param {Array<[number,number,number,number]>} doors - unit or longer edges [x1,y1,x2,y2] left as open doors.
 * @param {Array<[number,number,number,number]>} gaps - edges with no wall at all (a tunnel mouth).
 */
function outline(rects, doors = [], gaps = [], shut = [], glass = []) {
  const cells = new Set();
  for (const [x, y, w, h] of rects)
    for (let i = x; i < x + w; i++) for (let j = y; j < y + h; j++) cells.add(`${i},${j}`);
  const has = (i, j) => cells.has(`${i},${j}`);
  const onEdge = (list, x1, y1, x2, y2) =>
    list.some(([a, b, c, d]) => {
      if (a === c && x1 === x2 && x1 === a)
        return Math.min(y1, y2) >= Math.min(b, d) && Math.max(y1, y2) <= Math.max(b, d);
      if (b === d && y1 === y2 && y1 === b)
        return Math.min(x1, x2) >= Math.min(a, c) && Math.max(x1, x2) <= Math.max(a, c);
      return false;
    });
  const edges = [];
  for (const key of cells) {
    const [i, j] = key.split(',').map(Number);
    if (!has(i, j - 1)) edges.push([i, j, i + 1, j]);
    if (!has(i, j + 1)) edges.push([i, j + 1, i + 1, j + 1]);
    if (!has(i - 1, j)) edges.push([i, j, i, j + 1]);
    if (!has(i + 1, j)) edges.push([i + 1, j, i + 1, j + 1]);
  }
  const walls = [];
  for (const e of edges) {
    if (onEdge(gaps, ...e)) continue;
    const kind = onEdge(doors, ...e) ? 'door' : onEdge(shut, ...e) ? 'shut' : onEdge(glass, ...e) ? 'glass' : 'wall';
    walls.push({ sq: e, kind });
  }
  // Merge collinear runs of the same kind.
  const key = (w) => `${w.kind}|${w.sq[0] === w.sq[2] ? `v${w.sq[0]}` : `h${w.sq[1]}`}`;
  const groups = new Map();
  for (const w of walls) {
    const k = key(w);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(w);
  }
  const out = [];
  for (const [k, list] of groups) {
    const vert = k.includes('|v');
    list.sort((a, b) => (vert ? a.sq[1] - b.sq[1] : a.sq[0] - b.sq[0]));
    let cur = null;
    for (const w of list) {
      const [x1, y1, x2, y2] = w.sq;
      if (cur && (vert ? cur[3] === y1 : cur[2] === x1)) {
        cur[2] = x2;
        cur[3] = y2;
      } else {
        if (cur) out.push({ sq: cur, kind: w.kind });
        cur = [x1, y1, x2, y2];
      }
    }
    if (cur) out.push({ sq: cur, kind: list[0].kind });
  }
  return out.map((w) => ({ c: w.sq.map(sq), ...KIND_DATA[w.kind] }));
}

const P = (name, x, y, extra = {}) => ({ name, x: Math.round(sq(x)), y: Math.round(sq(y)), ...extra });

/**
 * The plots: `buildings` [{key, rects (squares), heightM, doors, gaps, walls?: false, inner: [[x1,y1,x2,y2,door?]]}],
 * `freeWalls` (squares), `fire` discs, `plants`, `probes` (scene px; `z` m optional).
 */
export function airPlots() {
  const plots = [];
  const lee = (prefix, y, x0, xs) => xs.map((x) => P(`${prefix}${x - x0}`, x, y));

  plots.push({
    code: 'AH1',
    title: 'lone house 12 m, 6 m tall',
    label: { x: sq(2), y: sq(0.3) },
    buildings: [{ key: 'AH1', rects: [[16, 2, 8, 8]], heightM: 6 }],
    fire: [
      { cx: sq(8), cy: sq(6), r: 45, key: 'fireOpen' },
      { cx: sq(30), cy: sq(6), r: 45, key: 'fireLee' },
    ],
    plants: [plant('openTree', 't550', 5, 10.5), plant('leeTree', 't550', 34, 9.5)],
    probes: [
      P('open', 6, 6),
      P('up4', 13.4, 6),
      P('up1', 15.3, 6),
      P('flankN', 20, 1.3),
      P('cornerNW', 15.5, 1.5),
      ...lee('lee', 6, 24, [25, 26, 28, 30, 32, 36, 40, 48, 56, 66, 80, 96]),
    ],
  });

  plots.push({
    code: 'AH2',
    title: 'tower 6 m wide, 16 m tall',
    label: { x: sq(2), y: sq(12.3) },
    buildings: [{ key: 'AH2', rects: [[16, 16, 4, 4]], heightM: 16 }],
    probes: [P('towerOpen', 6, 18), ...lee('tower', 18, 20, [21, 22, 24, 26, 28, 32, 36, 44, 52, 64, 80])],
  });

  plots.push({
    code: 'AH3',
    title: 'shed 6 m wide, 3 m tall; AH4 garden wall 2 m',
    label: { x: sq(2), y: sq(24.3) },
    buildings: [{ key: 'AH3', rects: [[16, 28, 4, 4]], heightM: 3 }],
    freeWalls: [[60, 25, 60, 35]],
    probes: [
      P('shedOpen', 6, 30),
      ...lee('shed', 30, 20, [21, 22, 24, 26, 28, 32, 36, 44]),
      P('wallUp', 58, 30),
      ...lee('wall', 30, 60, [61, 62, 63, 65, 68, 72, 80, 92]),
    ],
  });

  plots.push({
    code: 'AH5',
    title: 'funnel: 9 m mouth to a 3 m throat',
    label: { x: sq(2), y: sq(36.3) },
    buildings: [
      {
        key: 'AH5n',
        rects: [
          [40, 37, 10, 5],
          [36, 37, 4, 4],
          [32, 37, 4, 3],
        ],
        heightM: 6,
      },
      {
        key: 'AH5s',
        rects: [
          [40, 44, 10, 5],
          [36, 45, 4, 4],
          [32, 46, 4, 3],
        ],
        heightM: 6,
      },
    ],
    fire: [{ cx: sq(46), cy: sq(43), r: 35, key: 'fireThroat' }],
    probes: [
      P('funnelOpen', 20, 43),
      P('mouth', 31, 43),
      P('neck', 37, 43),
      P('throat', 42, 43),
      P('throatEnd', 49, 43),
      P('jet', 53, 43),
    ],
  });

  plots.push({
    code: 'AH6',
    title: 'windward door into a dead-end room',
    label: { x: sq(2), y: sq(50.3) },
    buildings: [{ key: 'AH6', rects: [[14, 52, 6, 6]], heightM: 6, doors: [[14, 54, 14, 55]] }],
    fire: [{ cx: sq(17), cy: sq(55.5), r: 40, key: 'fireDeadEnd' }],
    probes: [
      P('deadOut', 12, 54.5),
      P('dead1', 14.6, 54.5),
      P('dead3', 16, 54.5),
      P('deadMid', 17, 55),
      P('deadBack', 19.4, 54.5),
      P('deadCornerN', 19.4, 52.6),
      P('deadCornerS', 19.4, 57.4),
      P('deadSideN', 15, 52.6),
      P('deadSideS', 15, 57.4),
    ],
  });
  plots.push({
    code: 'AH7',
    title: 'cross-ventilated room (west + east doors)',
    label: { x: sq(36), y: sq(50.3) },
    buildings: [
      {
        key: 'AH7',
        rects: [[40, 52, 6, 6]],
        heightM: 6,
        doors: [
          [40, 54, 40, 55],
          [46, 54, 46, 55],
        ],
      },
    ],
    fire: [{ cx: sq(43), cy: sq(56), r: 40, key: 'fireCross' }],
    probes: [P('crossIn', 40.6, 54.5), P('crossMid', 43, 54.5), P('crossOut', 45.4, 54.5), P('crossSide', 43, 57.4)],
  });
  plots.push({
    code: 'AH8',
    title: 'lee door room',
    label: { x: sq(64), y: sq(50.3) },
    buildings: [{ key: 'AH8', rects: [[66, 52, 6, 6]], heightM: 6, doors: [[72, 54, 72, 55]] }],
    fire: [{ cx: sq(69), cy: sq(56), r: 40, key: 'fireLeeDoor' }],
    probes: [P('leeDoorIn', 71.4, 54.5), P('leeDoorMid', 69, 54.5), P('leeDoorBack', 66.6, 54.5)],
  });

  plots.push({
    code: 'AH9',
    title: 'tunnel along the wind; AH10 pavilion; AH11 courtyard',
    label: { x: sq(2), y: sq(62.3) },
    buildings: [
      {
        key: 'AH9',
        rects: [[14, 65, 14, 3]],
        heightM: 4.5,
        gaps: [
          [14, 65, 14, 68],
          [28, 65, 28, 68],
        ],
      },
      { key: 'AH10', rects: [[40, 64, 8, 6]], heightM: 4.5, walls: false },
      {
        key: 'AH11',
        rects: [
          [64, 63, 12, 2],
          [64, 73, 12, 2],
          [64, 65, 2, 8],
          [74, 65, 2, 8],
        ],
        heightM: 6,
      },
    ],
    fire: [
      { cx: sq(23), cy: sq(66.5), r: 35, key: 'fireTunnel' },
      { cx: sq(70), cy: sq(69), r: 40, key: 'fireCourtyard' },
    ],
    probes: [
      P('tunnelOpen', 8, 66.5),
      P('tunnelIn', 15, 66.5),
      P('tunnelMid', 21, 66.5),
      P('tunnelOut', 27, 66.5),
      P('pavRef', 34, 67),
      P('pavMid', 44, 67),
      P('pavBack', 47, 67),
      P('yardRef', 58, 69),
      P('yardC', 70, 69),
      P('yardUp', 67, 69),
      P('yardDown', 73, 69),
    ],
  });

  plots.push({
    code: 'AH12',
    title: 'two rooms: windward door, inner door; AH13 street across the wind',
    label: { x: sq(2), y: sq(75.3) },
    buildings: [
      {
        key: 'AH12',
        rects: [[14, 78, 12, 6]],
        heightM: 6,
        doors: [[14, 80, 14, 81]],
        inner: [
          [20, 78, 20, 80],
          [20, 81, 20, 84],
        ],
        innerDoors: [[20, 80, 20, 81]],
      },
      { key: 'AH13w', rects: [[50, 76, 4, 11]], heightM: 6 },
      { key: 'AH13e', rects: [[58, 76, 4, 11]], heightM: 6 },
    ],
    fire: [
      { cx: sq(23), cy: sq(82.5), r: 40, key: 'fireInnerRoom' },
      { cx: sq(56), cy: sq(83), r: 35, key: 'fireStreet' },
    ],
    probes: [
      P('room1', 17, 80.5),
      P('room1Back', 19.4, 80.5),
      P('room2', 22, 80.5),
      P('room2Back', 25.4, 80.5),
      P('streetRef', 44, 81),
      P('streetMid', 56, 81),
      P('streetW', 54.5, 81),
      P('streetE', 57.5, 81),
    ],
  });

  // AH14 — a manor 45 x 27 m, 8.5 m tall: an east-west corridor from an open front door (windward) to an open back
  // door (lee), a north-south corridor off it, ten rooms, some doors open and some shut, glass on the windward face.
  plots.push({
    code: 'AH14',
    title: 'manor: corridors, ten rooms, open and shut doors, windward glass',
    label: { x: sq(2), y: sq(88.3) },
    buildings: [
      {
        key: 'AH14',
        rects: [[14, 90, 30, 18]],
        heightM: 8.5,
        doors: [
          [14, 98, 14, 100],
          [44, 98, 44, 99],
        ],
        shut: [[28, 108, 29, 108]],
        glass: [
          [14, 92, 14, 94],
          [14, 103, 14, 105],
          [26, 90, 28, 90],
        ],
        lines: [
          // Corridor north wall (rooms N1-N5 open onto it): N1, N2, N4 open, N3, N5 shut.
          {
            c: [14, 98, 44, 98],
            open: [
              [16, 17],
              [23, 24],
              [35, 36],
            ],
            shut: [
              [29, 30],
              [41, 42],
            ],
          },
          // Corridor south wall, with the north-south corridor's mouth (x 28-30) open.
          { c: [14, 100, 28, 100], open: [[17, 18]], shut: [[24, 25]] },
          {
            c: [30, 100, 44, 100],
            open: [
              [33, 34],
              [40, 41],
            ],
          },
          // North room dividers.
          { c: [20, 90, 20, 98] },
          { c: [26, 90, 26, 98] },
          { c: [32, 90, 32, 98] },
          { c: [38, 90, 38, 98] },
          // North-south corridor walls and south room dividers.
          { c: [28, 100, 28, 108] },
          { c: [30, 100, 30, 108] },
          { c: [21, 100, 21, 108] },
          { c: [37, 100, 37, 108] },
        ],
      },
    ],
    fire: [
      { cx: sq(17), cy: sq(94), r: 40, key: 'fireManorN1' },
      { cx: sq(29), cy: sq(94), r: 40, key: 'fireManorShut' },
      { cx: sq(22), cy: sq(99), r: 30, key: 'fireCorridor' },
    ],
    probes: [
      P('manorFront', 12, 99),
      P('corr0', 15, 99),
      P('corr6', 20, 99),
      P('corr12', 26, 99),
      P('corr18', 32, 99),
      P('corr24', 38, 99),
      P('corr29', 43, 99),
      P('manorBack', 46, 99),
      P('N1', 17, 94),
      P('N2', 23, 94),
      P('N3shut', 29, 94),
      P('N4', 35, 94),
      P('N5shut', 41, 94),
      P('S1', 17, 104),
      P('S2shut', 24, 104),
      P('nsCorr', 29, 104),
      P('nsCorrEnd', 29, 107.4),
      P('S3', 33, 104),
      P('S4', 40, 104),
    ],
  });

  return plots;
}

function plant(key, id, cx, cy) {
  const p = PLANTS[id];
  const x = Math.round(sq(cx) - p.sw / 2);
  const y = Math.round(sq(cy) - p.sh / 2);
  return { key, id, layer: p.layer, box: { x, y, w: p.sw, h: p.sh }, cx: Math.round(sq(cx)), cy: Math.round(sq(cy)) };
}

/** Every wall of the lab (scene px), Foundry wall data minus ids. */
export function airWalls() {
  const out = [];
  for (const p of airPlots()) {
    for (const b of p.buildings ?? []) {
      if (b.walls === false) continue;
      for (const w of outline(b.rects, b.doors ?? [], b.gaps ?? [], b.shut ?? [], b.glass ?? [])) {
        out.push({ ...w, plot: p.code, building: b.key });
      }
      for (const L of b.lines ?? [])
        for (const w of wallLine(L.c, L)) out.push({ ...w, plot: p.code, building: b.key });
      for (const e of b.inner ?? []) out.push({ c: e.map(sq), ...NORMAL, plot: p.code, building: b.key });
      for (const e of b.innerDoors ?? []) out.push({ c: e.map(sq), ...OPEN_DOOR, plot: p.code, building: b.key });
    }
    for (const e of p.freeWalls ?? []) out.push({ c: e.map(sq), ...NORMAL, plot: p.code, building: 'free' });
  }
  return out;
}

/** Roofs as scene-px rects with their height (the `airRoofs` scene flag). */
export function airRoofs() {
  return airPlots().flatMap((p) =>
    (p.buildings ?? []).flatMap((b) =>
      b.rects.map(([x, y, w, h]) => ({ x: sq(x), y: sq(y), w: sq(w), h: sq(h), heightM: b.heightM, key: b.key }))
    )
  );
}

export function airProbes() {
  return airPlots().flatMap((p) => (p.probes ?? []).map((q) => ({ plot: p.code, ...q })));
}
export function airFires() {
  return airPlots().flatMap((p) => (p.fire ?? []).map((f) => ({ plot: p.code, key: f.key, x: f.cx, y: f.cy, r: f.r })));
}

/** Plain wall segments the way `foundry/scene-walls.js` hands them to MSA (for the offline bench). */
export function airWallSegments() {
  return airWalls().map((w) => ({
    x1: w.c[0],
    y1: w.c[1],
    x2: w.c[2],
    y2: w.c[3],
    solid: !(w.door === DOOR.DOOR && w.ds === 1),
    blocksExterior: true,
    // What a shut opening is, for the air's draftiness (a shut door or a pane leaks a little; a wall does not).
    door: w.door === DOOR.DOOR,
    window: w.sight === SENSE.PROXIMITY,
  }));
}

/** The floor images: art, _Outdoors, _Tree, _Fire. */
export function airImages(version = LAB_VERSION) {
  const W = AIR_SIZE;
  const plots = airPlots();
  const base = `msa-lab-v${version}-air${AIR_IMAGE_REV}`;
  const img = (suffix, mode, ops) => ({
    name: `${base}-Ground${suffix}.webp`,
    role: suffix || 'art',
    floor: 'air',
    w: W.w,
    h: W.h,
    mode,
    ops,
  });
  const roofs = airRoofs();
  const walls = airWalls();
  const t = 10;
  const ink = walls.map((w) => {
    const [x1, y1, x2, y2] = w.c;
    const door = w.door === DOOR.DOOR;
    const col = door ? [200, 170, 90, 255] : WALL_INK;
    return rect(
      { x: Math.min(x1, x2) - t / 2, y: Math.min(y1, y2) - t / 2, w: Math.abs(x2 - x1) + t, h: Math.abs(y2 - y1) + t },
      col
    );
  });
  const labels = plots.map((p) => text(p.label.x, p.label.y, `${p.code} ${p.title}`, 48));
  const heightLabels = plots.flatMap((p) =>
    (p.buildings ?? []).map((b) => {
      const [x, y] = b.rects[0];
      return text(sq(x) + 20, sq(y) + 20, `${b.heightM} m`, 40);
    })
  );
  const probeTicks = airProbes().map((q) => rect({ x: q.x - 6, y: q.y - 6, w: 12, h: 12 }, [INK, INK, INK, 255]));
  const plants = plots.flatMap((p) => p.plants ?? []);
  const paste = (pl) => {
    const p = PLANTS[pl.id];
    return { op: 'paste', src: ART[p.layer], sx: p.sx, sy: p.sy, sw: p.sw, sh: p.sh, x: pl.box.x, y: pl.box.y };
  };
  const disc = (d, rgba) => ({ op: 'ellipse', cx: d.cx, cy: d.cy, rx: d.r, ry: d.r, rgba });
  const art = [
    { op: 'fill', rgba: [GREY, GREY, GREY, 255] },
    ...roofs.map((r) => rect(r, roofShade(r.heightM))),
    ...ink,
    ...labels,
    ...heightLabels,
    ...probeTicks,
    text(
      sq(50),
      sq(108.3),
      'Lab · Air — wind toward +x (90°); 1 square = 5 ft = 1.52 m; roofs labelled with their height',
      48
    ),
  ];
  return [
    img('', 'RGB', art),
    img('_Outdoors', 'RGB', [{ op: 'fill', rgba: [255, 255, 255, 255] }, ...roofs.map((r) => rect(r, BLACK))]),
    img('_Tree', 'RGBA', [{ op: 'fill', rgba: [0, 0, 0, 0] }, ...plants.filter((p) => p.layer === 'tree').map(paste)]),
    img('_Fire', 'RGB', [
      { op: 'fill', rgba: [0, 0, 0, 255] },
      ...plots.flatMap((p) => (p.fire ?? []).map((d) => disc(d, [255, 255, 255, 255]))),
    ]),
  ];
}

export function airScene(assetDir, version = LAB_VERSION) {
  const images = airImages(version);
  const tag = (k) => ({ [MODULE_ID]: { [LAB_FLAG]: k } });
  const walls = airWalls().map((w, i) => {
    const { plot, building, ...rest } = w;
    return { ...rest, levels: [FLOOR.id], flags: tag(`wall:${plot}:${building}:${i}`) };
  });
  const regions = airPlots().flatMap((p) =>
    (p.buildings ?? [])
      .filter((b) => b.walls !== false)
      .flatMap((b) =>
        b.rects.map(([x, y, w, h], i) =>
          indoorRegion(`${b.key}-${i}`, { x: sq(x), y: sq(y), w: sq(w), h: sq(h) }, FLOOR, `indoor ${b.key}`)
        )
      )
  );
  return {
    key: 'air',
    id: AIR_IDS.scene,
    data: {
      _id: AIR_IDS.scene,
      name: 'Lab · Air',
      width: AIR_SIZE.w,
      height: AIR_SIZE.h,
      padding: PADDING,
      backgroundColor: '#808080',
      grid: { size: GRID, type: 1, distance: 5, units: 'ft' },
      initialLevel: FLOOR.id,
      levels: [
        {
          _id: FLOOR.id,
          name: FLOOR.name,
          sort: 0,
          elevation: { bottom: FLOOR.bottom, top: FLOOR.top },
          background: { src: `${assetDir}/${images[0].name}`, color: '#808080' },
          visibility: { levels: [] },
          flags: tag('level:air'),
        },
      ],
      flags: {
        [MODULE_ID]: {
          [LAB_FLAG]: 'scene:air',
          labVersion: version,
          enabled: true,
          air: true,
          airRoofs: airRoofs().map(({ key, ...r }) => r),
        },
      },
    },
    walls,
    regions,
    sceneFlags: { sky: LAB_SKY, wind: AIR_LAB_WIND },
  };
}
