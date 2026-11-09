/**
 * tools/lab/wind-spec.mjs — Lab · Wind, as data (mmp-vm1.1, the Wind lab).
 *
 * Every plot exists for claims in tools/lab/claims/wind.md. The wind blows toward +x (MSA 90°, the lab's
 * LAB_WIND direction), so "upwind" is the left of the scene and every obstacle's lee is to its right.
 * The meter (`tools/lab/wind-meter.mjs`) steps the dial calm -> hurricane and reads the BAKED field back
 * (`MapShine.readWindField`), so the plots are geometry only: walls, doors, glass, open sky, plus the effects
 * that should show the wind (her own trees and bushes, two fires, flies, a pond).
 *
 * SCALE. 150 px grid, 5 ft squares (her maps): 98.43 px per metre. The bake grid is one cell per square on the
 * padded canvas (~1.52 m cells).
 *
 * LAYOUT (80 x 56 squares = 12000 x 8400 px = 122 x 85 m). Squares, x right, y down:
 *   WN1  open field (x 1-35, y 1-21): free stream. An along-wind probe line (y 11, every 4 squares = 6.1 m,
 *        for gust travel), an across-wind line (x 19), her tree and two bushes at the bottom.
 *   WN2  building (x 40-48, y 7-15, 12.2 m square, closed): upwind face, flank, corners and a lee transect out to
 *        37 m, with the same tree and bush in its lee as in the open field.
 *   WN3  walled courtyard (x 6-16, y 26-36): walls all round, open sky (white _Outdoors), a bush inside.
 *   WN4  alley ALONG the wind (two roofed blocks x 24-44, gap y 30-31 = 1.5 m).
 *   WN5  alley ACROSS the wind (two roofed blocks y 26-36, gap x 58-59 = 1.5 m).
 *   WN6  room with an open WINDWARD door (x 6-16, y 43-49; door on the west wall, closed window on the south).
 *   WN7  sealed room whose only opening is closed glass (x 22-30, y 43-49): a fire and flies inside.
 *   WN8  room with an open LEE door (x 36-44, y 43-49; door on the east wall).
 *   WN9  mask-only "indoors" (x 50-56, y 43-49): black _Outdoors, no walls.
 *   WN10 open-air fire and flies (x 60-66, y 44-48).
 *   WN11 pond (x 68-78, y 42-52, _Water).
 *
 * Pure. Coordinates: scene pixels (the builder adds Foundry's padding offset).
 *
 * @module tools/lab/wind-spec
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

export const WIND_IDS = Object.freeze({ scene: 'msaLabWind000000', level: 'msaLabWindGrnd00' });

export const WIND_SIZE = Object.freeze({ w: sq(80), h: sq(56) });

/** Her maps' scale: 150 px per 5 ft square. */
export const WIND_PX_PER_METRE = GRID / (5 * 0.3048);

/** Bumped whenever a mask changes, so the files get new names and no browser serves a cached copy. */
export const WIND_IMAGE_REV = 2;

/** The lab's wind blows toward +x; the meter sets the speed. */
export const WIND_LAB_WIND = Object.freeze({ directionDeg: 90, speed01: 0 });

const FLOOR = Object.freeze({ key: 'ground', name: 'Ground', id: WIND_IDS.level, bottom: 0, top: 20 });

const NORMAL = Object.freeze({ move: SENSE.NORMAL, sight: SENSE.NORMAL, light: SENSE.NORMAL, sound: SENSE.NORMAL });
/** Closed glass the way her maps author windows (light/sight PROXIMITY with a threshold, movement blocked). */
const WINDOW = Object.freeze({
  move: SENSE.NORMAL,
  sight: SENSE.PROXIMITY,
  light: SENSE.PROXIMITY,
  sound: SENSE.NORMAL,
  threshold: { light: 10, sight: 10, sound: null, attenuation: true },
});
const OPEN_DOOR = Object.freeze({ ...NORMAL, door: DOOR.DOOR, ds: 1 });
const SHUT_DOOR = Object.freeze({ ...NORMAL, door: DOOR.DOOR, ds: 0 });

const BLACK = [0, 0, 0, 255];
const ROOF = [96, 96, 96, 255];
const WALL_INK = [40, 40, 40, 255];

/** A rectangle in squares, to scene px. */
const R = (x, y, w, h) => ({ x: sq(x), y: sq(y), w: sq(w), h: sq(h) });
/** A probe point in squares. */
const P = (name, x, y, extra = {}) => ({ name, x: Math.round(sq(x)), y: Math.round(sq(y)), ...extra });

/**
 * Four walls round a rect (scene px). `features`: [{side: 'n'|'e'|'s'|'w', from, to (squares along the side's
 * axis, absolute scene squares), seg}] — the side is split normal | feature | normal.
 */
function boxWalls(r, features = []) {
  const sides = {
    n: [r.x, r.y, r.x + r.w, r.y],
    e: [r.x + r.w, r.y, r.x + r.w, r.y + r.h],
    s: [r.x + r.w, r.y + r.h, r.x, r.y + r.h],
    w: [r.x, r.y + r.h, r.x, r.y],
  };
  const out = [];
  for (const [side, [x0, y0, x1, y1]] of Object.entries(sides)) {
    const f = features.find((q) => q.side === side);
    if (!f) {
      out.push({ c: [x0, y0, x1, y1], ...NORMAL });
      continue;
    }
    const horiz = y0 === y1;
    const at = (t) => (horiz ? [t, y0] : [x0, t]);
    const a0 = horiz ? x0 : y0;
    const a1 = horiz ? x1 : y1;
    const lo = sq(Math.min(f.from, f.to));
    const hi = sq(Math.max(f.from, f.to));
    const [p, q] = a0 < a1 ? [lo, hi] : [hi, lo];
    out.push({ c: [...at(a0), ...at(p)], ...NORMAL });
    out.push({ c: [...at(p), ...at(q)], ...f.seg });
    out.push({ c: [...at(q), ...at(a1)], ...NORMAL });
  }
  return out;
}

/** One of her plants (vegetation-spec.mjs PLANTS), centred at (cx, cy) squares. */
function plant(key, id, cx, cy) {
  const p = PLANTS[id];
  const x = Math.round(sq(cx) - p.sw / 2);
  const y = Math.round(sq(cy) - p.sh / 2);
  return { key, id, layer: p.layer, box: { x, y, w: p.sw, h: p.sh }, cx: Math.round(sq(cx)), cy: Math.round(sq(cy)) };
}

/**
 * The plots. `outdoors` = _Outdoors ops (the floor starts white), `art`, `walls`, `regions` (indoor rects),
 * `plants`, `fire` / `flies` / `water` discs and rects, `probes` (named points, scene px).
 */
export function windPlots() {
  const plots = [];

  // WN1 — the open field.
  {
    const probes = [];
    for (const x of [3, 7, 11, 15, 19, 23, 27, 31]) probes.push(P(`f${String(x).padStart(2, '0')}`, x, 11));
    for (const y of [3, 7, 15, 19]) probes.push(P(`fy${String(y).padStart(2, '0')}`, 19, y));
    plots.push({
      code: 'WN1',
      title: 'open field (wind blows left to right)',
      label: { x: sq(1), y: sq(0.3) },
      art: [rect({ x: sq(1), y: sq(10.95), w: sq(31), h: 6 }, [INK, INK, INK, 255])],
      fire: [{ cx: sq(12), cy: sq(6), r: 45, key: 'fireField' }],
      plants: [
        plant('openTree', 't550', 9, 17),
        plant('openBush', 'b220', 14, 18.2),
        plant('openBushS', 'b143', 4.5, 17.5),
      ],
      probes,
    });
  }

  // WN2 — a closed building and its lee.
  {
    const b = R(40, 7, 8, 8);
    plots.push({
      code: 'WN2',
      title: 'building 12 m, lee to the right',
      label: { x: sq(40), y: sq(5.2) },
      outdoors: [rect(b, BLACK)],
      art: [rect(b, ROOF)],
      walls: boxWalls(b),
      regions: [{ key: 'WN2', rect: b }],
      plants: [plant('leeTree', 't550', 52.5, 13.2), plant('leeBush', 'b220', 50.2, 9)],
      fire: [{ cx: sq(51.5), cy: sq(10.6), r: 45, key: 'fireLee' }],
      probes: [
        P('up6m', 36, 11),
        P('up3m', 38, 11),
        P('up1m', 39.4, 11),
        P('flankN1', 44, 6.4),
        P('flankN3', 44, 5),
        P('cornerNW', 39.6, 6.6),
        P('cornerNE', 48.4, 6.6),
        P('lee1m', 48.5, 11),
        P('lee2m', 49.5, 11),
        P('lee5m', 51, 11),
        P('lee8m', 53, 11),
        P('lee12m', 56, 11),
        P('lee18m', 60, 11),
        P('lee27m', 66, 11),
        P('lee37m', 72, 11),
      ],
    });
  }

  // WN3 — walled courtyard, open sky.
  {
    const c = R(6, 26, 10, 10);
    plots.push({
      code: 'WN3',
      title: 'walled courtyard, open sky',
      label: { x: sq(6), y: sq(24.2) },
      art: wallInk(c),
      walls: boxWalls(c),
      plants: [plant('yardBush', 'b143', 11, 33.5)],
      fire: [{ cx: sq(11), cy: sq(29), r: 45, key: 'fireYard' }],
      probes: [
        P('yardRef', 3, 31),
        P('yardUp', 7.5, 31),
        P('yardC', 11, 31),
        P('yardDown', 14.5, 31),
        P('yardN', 11, 27.5),
        P('yardS', 11, 34.5),
      ],
    });
  }

  // WN4 — alley along the wind.
  {
    const n = R(24, 26, 20, 4);
    const s = R(24, 31, 20, 4);
    plots.push({
      code: 'WN4',
      title: 'alley along the wind (1.5 m)',
      label: { x: sq(24), y: sq(24.2) },
      outdoors: [rect(n, BLACK), rect(s, BLACK)],
      art: [rect(n, ROOF), rect(s, ROOF)],
      walls: [...boxWalls(n), ...boxWalls(s)],
      regions: [
        { key: 'WN4n', rect: n },
        { key: 'WN4s', rect: s },
      ],
      fire: [{ cx: sq(38), cy: sq(30.5), r: 35, key: 'fireAlley' }],
      probes: [P('alleyRef', 21, 30.5), P('alleyIn', 25, 30.5), P('alleyMid', 34, 30.5), P('alleyOut', 43, 30.5)],
    });
  }

  // WN5 — alley across the wind.
  {
    const w = R(52, 26, 6, 10);
    const e = R(59, 26, 6, 10);
    plots.push({
      code: 'WN5',
      title: 'alley across the wind (1.5 m)',
      label: { x: sq(52), y: sq(24.2) },
      outdoors: [rect(w, BLACK), rect(e, BLACK)],
      art: [rect(w, ROOF), rect(e, ROOF)],
      walls: [...boxWalls(w), ...boxWalls(e)],
      regions: [
        { key: 'WN5w', rect: w },
        { key: 'WN5e', rect: e },
      ],
      probes: [P('gapRef', 49, 31), P('gapN', 58.5, 27.5), P('gapMid', 58.5, 31), P('gapS', 58.5, 34.5)],
    });
  }

  // WN6 — room with an open windward door (west wall) and a closed window (south wall).
  {
    const r = R(6, 43, 10, 6);
    plots.push({
      code: 'WN6',
      title: 'open windward door',
      label: { x: sq(6), y: sq(41.2) },
      outdoors: [rect(r, BLACK)],
      art: wallInk(r),
      walls: boxWalls(r, [
        { side: 'w', from: 45.5, to: 46.5, seg: OPEN_DOOR },
        { side: 's', from: 10, to: 12, seg: WINDOW },
      ]),
      regions: [{ key: 'WN6', rect: r }],
      fire: [{ cx: sq(9), cy: sq(47.2), r: 45, key: 'fireDoorRoom' }],
      probes: [
        P('doorOut', 4, 46),
        P('door0', 6.35, 46),
        P('door1', 7, 46),
        P('door3', 8, 46),
        P('door6', 10, 46),
        P('door12', 14, 46),
        P('doorCorner', 14.5, 48.3),
      ],
    });
  }

  // WN7 — sealed room, closed glass on the windward wall, a fire and flies inside.
  {
    const r = R(22, 43, 8, 6);
    plots.push({
      code: 'WN7',
      title: 'sealed room: closed glass, fire, flies',
      label: { x: sq(22), y: sq(41.2) },
      outdoors: [rect(r, BLACK)],
      art: wallInk(r),
      walls: boxWalls(r, [
        { side: 'w', from: 45, to: 47, seg: WINDOW },
        { side: 's', from: 25, to: 26, seg: SHUT_DOOR },
      ]),
      regions: [{ key: 'WN7', rect: r }],
      fire: [{ cx: sq(26.5), cy: sq(46), r: 45, key: 'fireSealed' }],
      flies: [{ cx: sq(24), cy: sq(47.6), r: 70 }],
      probes: [P('sealedWin', 22.5, 46), P('sealedMid', 26.5, 45.5), P('sealedFlies', 24, 47.6)],
    });
  }

  // WN8 — room with an open lee door (east wall).
  {
    const r = R(36, 43, 8, 6);
    plots.push({
      code: 'WN8',
      title: 'open lee door',
      label: { x: sq(36), y: sq(41.2) },
      outdoors: [rect(r, BLACK)],
      art: wallInk(r),
      walls: boxWalls(r, [{ side: 'e', from: 45.5, to: 46.5, seg: OPEN_DOOR }]),
      regions: [{ key: 'WN8', rect: r }],
      fire: [{ cx: sq(40), cy: sq(47.2), r: 45, key: 'fireLeeDoorRoom' }],
      probes: [P('leeDoorOut', 46, 46), P('leeDoorIn', 43.5, 46), P('leeDoorMid', 40, 46), P('leeDoorBack', 37, 46)],
    });
  }

  // WN9 — black _Outdoors, no walls.
  {
    const r = R(50, 43, 6, 6);
    plots.push({
      code: 'WN9',
      title: 'mask-only indoors (no walls)',
      label: { x: sq(50), y: sq(41.2) },
      outdoors: [rect(r, BLACK)],
      art: [rect(r, [110, 110, 110, 255])],
      probes: [P('maskOnly', 53, 46), P('maskOnlyRef', 48, 46)],
    });
  }

  // WN10 — open-air fire and flies.
  plots.push({
    code: 'WN10',
    title: 'open-air fire and flies',
    label: { x: sq(60), y: sq(42.2) },
    fire: [{ cx: sq(62), cy: sq(46), r: 45, key: 'fireOpen' }],
    flies: [{ cx: sq(65.5), cy: sq(47), r: 70 }],
    probes: [P('fireOpen', 62, 46), P('fliesOpen', 65.5, 47)],
  });

  // WN11 — pond.
  {
    const w = R(68, 42, 10, 10);
    plots.push({
      code: 'WN11',
      title: 'pond',
      label: { x: sq(68), y: sq(40.4) },
      water: [w],
      probes: [P('pond', 73, 47), P('pondEdge', 77.5, 47)],
    });
  }

  return plots;
}

/** Dark lines along a walled rect so the walls read on the art (walls themselves are invisible in Foundry). */
function wallInk(r) {
  const t = 10;
  return [
    rect({ x: r.x - t / 2, y: r.y - t / 2, w: r.w + t, h: t }, WALL_INK),
    rect({ x: r.x - t / 2, y: r.y + r.h - t / 2, w: r.w + t, h: t }, WALL_INK),
    rect({ x: r.x - t / 2, y: r.y - t / 2, w: t, h: r.h + t }, WALL_INK),
    rect({ x: r.x + r.w - t / 2, y: r.y - t / 2, w: t, h: r.h + t }, WALL_INK),
  ];
}

/** Every named probe point, flat, with its plot code. */
export function windProbes() {
  return windPlots().flatMap((p) => (p.probes ?? []).map((q) => ({ plot: p.code, ...q })));
}

/** Every painted fire, flat: key and centre (scene px) — the fire meter names each plume by it. */
export function windFires() {
  return windPlots().flatMap((p) =>
    (p.fire ?? []).map((f) => ({ plot: p.code, key: f.key, x: f.cx, y: f.cy, r: f.r }))
  );
}

/** Every plant, flat. */
export function windPlants() {
  return windPlots().flatMap((p) => p.plants ?? []);
}

/** The floor images: art, _Outdoors, _Tree, _Bush, _Fire, _Flies, _Water. */
export function windImages(version = LAB_VERSION) {
  const W = WIND_SIZE;
  const plots = windPlots();
  const base = `msa-lab-v${version}-wind${WIND_IMAGE_REV}`;
  const img = (suffix, mode, ops) => ({
    name: `${base}-Ground${suffix}.webp`,
    role: suffix || 'art',
    floor: 'wind',
    w: W.w,
    h: W.h,
    mode,
    ops,
  });
  const labels = plots.map((p) => text(p.label.x, p.label.y, `${p.code} ${p.title}`, 52));
  const probeTicks = plots.flatMap((p) =>
    (p.probes ?? []).map((q) => rect({ x: q.x - 6, y: q.y - 6, w: 12, h: 12 }, [INK, INK, INK, 255]))
  );
  const paste = (pl) => {
    const p = PLANTS[pl.id];
    return { op: 'paste', src: ART[p.layer], sx: p.sx, sy: p.sy, sw: p.sw, sh: p.sh, x: pl.box.x, y: pl.box.y };
  };
  const plants = plots.flatMap((p) => p.plants ?? []);
  const disc = (d, rgba) => ({ op: 'ellipse', cx: d.cx, cy: d.cy, rx: d.r, ry: d.r, rgba });
  const empty = { op: 'fill', rgba: [0, 0, 0, 0] };
  const art = [
    { op: 'fill', rgba: [GREY, GREY, GREY, 255] },
    ...plots.flatMap((p) => p.art ?? []),
    ...labels,
    ...probeTicks,
    text(sq(1), sq(54.6), 'Lab · Wind — wind toward +x (90°); 1 square = 5 ft = 1.52 m', 52),
  ];
  return [
    img('', 'RGB', art),
    img('_Outdoors', 'RGB', [{ op: 'fill', rgba: [255, 255, 255, 255] }, ...plots.flatMap((p) => p.outdoors ?? [])]),
    img('_Tree', 'RGBA', [empty, ...plants.filter((p) => p.layer === 'tree').map(paste)]),
    img('_Bush', 'RGBA', [empty, ...plants.filter((p) => p.layer === 'bush').map(paste)]),
    img('_Fire', 'RGB', [
      { op: 'fill', rgba: [0, 0, 0, 255] },
      ...plots.flatMap((p) => (p.fire ?? []).map((d) => disc(d, [255, 255, 255, 255]))),
    ]),
    img('_Flies', 'RGB', [
      { op: 'fill', rgba: [0, 0, 0, 255] },
      ...plots.flatMap((p) => (p.flies ?? []).map((d) => disc(d, [255, 255, 255, 255]))),
    ]),
    img('_Water', 'RGB', [
      { op: 'fill', rgba: [0, 0, 0, 255] },
      ...plots.flatMap((p) => (p.water ?? []).map((r) => rect(r, [200, 200, 200, 255], 40))),
    ]),
  ];
}

export function windScene(assetDir, version = LAB_VERSION) {
  const images = windImages(version);
  const plots = windPlots();
  const tag = (k) => ({ [MODULE_ID]: { [LAB_FLAG]: k } });
  const walls = plots.flatMap((p) =>
    (p.walls ?? []).map((w, i) => ({ ...w, levels: [FLOOR.id], flags: tag(`wall:${p.code}:${i}`) }))
  );
  const regions = plots.flatMap((p) =>
    (p.regions ?? []).map((r) => indoorRegion(r.key, r.rect, FLOOR, `indoor ${r.key}`))
  );
  return {
    key: 'wind',
    id: WIND_IDS.scene,
    data: {
      _id: WIND_IDS.scene,
      name: 'Lab · Wind',
      width: WIND_SIZE.w,
      height: WIND_SIZE.h,
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
          flags: tag('level:wind'),
        },
      ],
      flags: { [MODULE_ID]: { [LAB_FLAG]: 'scene:wind', labVersion: version, enabled: true } },
    },
    walls,
    regions,
    sceneFlags: { sky: LAB_SKY, wind: WIND_LAB_WIND },
  };
}
