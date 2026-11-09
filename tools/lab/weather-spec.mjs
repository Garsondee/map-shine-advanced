/**
 * tools/lab/weather-spec.mjs — Lab · Weather, as data (mmp-78u.34, the Weather & particles lab).
 *
 * Every plot exists for claims in tools/lab/claims/weather.md. The scene copies how the author's
 * modern maps build weather's boundaries (measured 2026-11-08 for the interiors lab): interiors are
 * black `_Outdoors` with hard 0-1 px edges plus an "indoor" Region (Adjust Darkness Level OVERRIDE
 * 0.9 + Suppress Weather), and a building's roof is the UPPER floor's opaque footprint, which is what
 * MSA's `coverAbove` (sky reach, roofline drips) is derived from. A single-floor scene has no
 * roofline at all (coverAbove = 0), so this scene has two floors, like hers.
 *
 * SCALE. 150 px grid, 5 ft squares (her maps): 30 px per foot, 98.43 px per metre. The checker reads
 * MSA's own px/m (`core/scene-scale.js`) and refuses to judge speeds if it is not 98.43.
 *
 * LAYOUT (60 x 45 squares, the lab lattice of lab-spec.mjs#cellRect: 10 x 10-square cells, 1-square
 * gutter). Open-ground probe points sit >= 150 px from any black area or roof (the building-shadow blur
 * spreads 60-75 px at noon, mmp-78u.11), and Region probe points >= 60 px inside an edge (MSA's soft
 * Region edge is a 30 px ramp).
 *
 *   W1  open field (cols 0-1, rows 0-1): the stage for falling-particle measurement, cloud shadows,
 *       wind. Left half plain grey; right half carries a 1-square ruler (2 px ink lines).
 *   W2  closed room with a south window and an east door (cols 2-3, row 0): black _Outdoors, the
 *       author's indoor Region, a roof slab on Upper (eaves for drips), a _Windows pool inside.
 *   W3  Suppress Weather Region over OPEN ground (col 4, row 0): mmp-78u.25's case.
 *   W4  mask-only indoors (col 5, row 0): a hard black block, no Region, no roof, no walls.
 *   W5  awning (col 2, row 1): a roof slab on Upper over WHITE ground, no walls (a market canopy).
 *   W6  soft mask edge (col 3, row 1): a 10 px feathered black block (Wizard's Lair style).
 *   W7  authored drips (col 4, row 1): `_Drip` mask dots over open ground (a leaking pipe).
 *   W8  alley (col 5, row 1): two roofed blocks with a 1-square open gap between them.
 *   W9  darkness Region without Suppress Weather over open ground (col 0, row 2): weather still falls.
 *   W10 scene corner (col 5, rows 2-3 to the scene's bottom-right edge): weather at the scene edge.
 *
 * Pure. Coordinates: scene pixels (the builder adds Foundry's padding offset).
 *
 * @module tools/lab/weather-spec
 */
import {
  GRID,
  GREY,
  INK,
  LAB_FLAG,
  LAB_SKY,
  LAB_WIND,
  LAB_VERSION,
  MODULE_ID,
  PADDING,
  SENSE,
  DOOR,
  cellRect,
  indoorRegion,
  paintOps,
} from './lab-spec.mjs';

const { sq, rect, text } = paintOps;

export const WEATHER_IDS = Object.freeze({
  scene: 'msaLabWeather000',
  ground: 'msaLabWeathGrnd0',
  upper: 'msaLabWeathUppr0',
});

export const WEATHER_SIZE = Object.freeze({ w: sq(60), h: sq(45) });

/** Her maps' scale: 150 px per 5 ft square. */
export const WEATHER_PX_PER_METRE = GRID / (5 * 0.3048);

export const WEATHER_FLOORS = Object.freeze([
  Object.freeze({ key: 'ground', letter: 'G', name: 'Ground', id: WEATHER_IDS.ground, bottom: 0, top: 20 }),
  Object.freeze({ key: 'upper', letter: 'U', name: 'Upper', id: WEATHER_IDS.upper, bottom: 20, top: 40 }),
]);

const NORMAL = Object.freeze({ move: SENSE.NORMAL, sight: SENSE.NORMAL, light: SENSE.NORMAL, sound: SENSE.NORMAL });
const WINDOW_PRESET = Object.freeze({
  move: SENSE.NORMAL,
  sight: SENSE.PROXIMITY,
  light: SENSE.PROXIMITY,
  sound: SENSE.NORMAL,
  threshold: { light: 10, sight: 10, sound: null, attenuation: true },
});

/** A rectangle in squares, to scene px. */
const R = (x, y, w, h) => ({ x: sq(x), y: sq(y), w: sq(w), h: sq(h) });

/** Four walls round a rect (scene px), with optional feature segments: [{side, from, to, seg}] in px. */
function roomWalls(r, features = []) {
  const sides = {
    n: [r.x, r.y, r.x + r.w, r.y],
    e: [r.x + r.w, r.y, r.x + r.w, r.y + r.h],
    s: [r.x + r.w, r.y + r.h, r.x, r.y + r.h],
    w: [r.x, r.y + r.h, r.x, r.y],
  };
  const out = [];
  for (const [side, [x0, y0, x1, y1]] of Object.entries(sides)) {
    const f = features.filter((q) => q.side === side);
    if (!f.length) {
      out.push({ c: [x0, y0, x1, y1], ...NORMAL });
      continue;
    }
    // A side with one feature: normal | feature | normal, the author's way.
    const { from, to, seg } = f[0];
    const horiz = y0 === y1;
    const at = (t) => (horiz ? [t, y0] : [x0, t]);
    const a0 = horiz ? x0 : y0;
    const a1 = horiz ? x1 : y1;
    const [lo, hi] = a0 < a1 ? [from, to] : [to, from];
    out.push({ c: [...at(a0), ...at(lo)], ...NORMAL });
    out.push({ c: [...at(lo), ...at(hi)], ...seg });
    out.push({ c: [...at(hi), ...at(a1)], ...NORMAL });
  }
  return out;
}

/**
 * The plots. `outdoors` = ground _Outdoors ops (the floor starts white), `roof` = Upper slabs,
 * `windows` = ground _Windows ops, `drip` = ground _Drip ops, `walls`, `regions` (full docs),
 * `probes` (named points, scene px; `open` true = open sky, false = covered).
 */
export function weatherPlots() {
  const plots = [];

  // W1 — the open field.
  {
    const a = { x: sq(1), y: sq(1), w: sq(18), h: sq(18) };
    const art = [];
    // ruler on the right half: 2 px ink lines every square, plus a metre bar
    for (let i = 0; i <= 9; i++) {
      art.push(rect({ x: a.x + sq(9) + sq(i) - 1, y: a.y, w: 2, h: a.h }, [INK, INK, INK]));
      art.push(rect({ x: a.x + sq(9), y: a.y + sq(i * 2) - 1, w: sq(9), h: 2 }, [INK, INK, INK]));
    }
    art.push(text(a.x + sq(9) + 20, a.y + sq(17) + 40, '1 sq = 5 ft = 1.524 m = 150 px', 44));
    art.push(
      rect({ x: a.x + sq(9) + 20, y: a.y + sq(16) + 60, w: Math.round(WEATHER_PX_PER_METRE * 5), h: 12 }, [
        INK,
        INK,
        INK,
      ])
    );
    art.push(text(a.x + sq(9) + 20, a.y + sq(16), '5 m', 44));
    plots.push({
      code: 'W1',
      title: 'open field',
      label: { x: sq(0) + 170, y: 30 },
      art,
      probes: [
        { name: 'field', x: a.x + sq(4.5), y: a.y + sq(9), open: true },
        { name: 'fieldNW', x: a.x + sq(2), y: a.y + sq(2), open: true },
        { name: 'fieldS', x: a.x + sq(4.5), y: a.y + sq(16), open: true },
        { name: 'ruler', x: a.x + sq(13.5), y: a.y + sq(9) + 75, open: true },
      ],
    });
  }

  // W2 — closed room, south window, east door, roof, window pool.
  {
    const room = R(24, 2, 10, 6);
    const win = { side: 's', from: sq(28), to: sq(30), seg: WINDOW_PRESET };
    const door = { side: 'e', from: sq(4), to: sq(5), seg: { ...NORMAL, door: DOOR.DOOR, ds: 0 } };
    plots.push({
      code: 'W2',
      title: 'room, window, roof',
      label: { x: sq(20) + 170, y: 30 },
      outdoors: [rect(room, [0, 0, 0])],
      roof: [room],
      windows: [rect(R(27.5, 6, 3, 2), [220, 220, 220, 255], 60)],
      walls: roomWalls(room, [win, door]),
      regions: [{ key: 'W2', rect: room, kind: 'indoor' }],
      probes: [
        { name: 'roomMid', x: sq(26), y: sq(4), open: false },
        { name: 'windowPool', x: sq(29), y: sq(7.4), open: false },
        { name: 'outsideWindow', x: sq(29), y: sq(9.5), open: true },
        { name: 'eaveSouth', x: sq(31.5), y: sq(8) + 30, open: true },
        { name: 'yardWest', x: sq(22), y: sq(5), open: true },
      ],
    });
  }

  // W3 — Suppress Weather over open ground.
  {
    const reg = R(42, 2, 6, 6);
    plots.push({
      code: 'W3',
      title: 'Suppress Weather, open',
      label: { x: sq(40) + 170, y: 30 },
      regions: [
        {
          key: 'W3',
          rect: reg,
          kind: 'doc',
          doc: {
            name: 'suppress weather (open ground)',
            color: '#2aa198',
            behaviors: [{ name: 'Suppress Weather', type: 'suppressWeather', system: {} }],
          },
        },
      ],
      probes: [
        { name: 'swInside', x: sq(45), y: sq(5), open: true, suppressed: true },
        { name: 'swOutside', x: sq(45), y: sq(9.3), open: true },
      ],
    });
  }

  // W4 — mask-only indoors: hard black block, nothing else.
  {
    const blk = R(52, 2, 5, 5);
    plots.push({
      code: 'W4',
      title: 'mask-only black',
      label: { x: sq(50) + 170, y: 30 },
      outdoors: [rect(blk, [0, 0, 0])],
      probes: [
        { name: 'maskIn', x: sq(54.5), y: sq(4.5), open: false },
        { name: 'maskOut', x: sq(54.5), y: sq(8.5), open: true },
      ],
    });
  }

  // W5 — awning: roof over white ground, no walls.
  {
    const aw = R(23, 13, 6, 3);
    plots.push({
      code: 'W5',
      title: 'awning (roof, white ground)',
      label: { x: sq(20) + 170, y: sq(10) + 30 },
      roof: [aw],
      probes: [
        { name: 'underAwning', x: sq(26), y: sq(14.5), open: false },
        { name: 'besideAwning', x: sq(26), y: sq(17.5), open: true },
      ],
    });
  }

  // W6 — soft (10 px feather) black block.
  {
    const blk = R(33, 13, 4, 4);
    plots.push({
      code: 'W6',
      title: 'soft 10px mask edge',
      label: { x: sq(30) + 170, y: sq(10) + 30 },
      outdoors: [rect(blk, [0, 0, 0], 10)],
      probes: [
        { name: 'softIn', x: sq(35), y: sq(15), open: false },
        { name: 'softOut', x: sq(35), y: sq(18.3), open: true },
      ],
    });
  }

  // W7 — authored drips: five _Drip dots over open ground.
  {
    const dots = [
      [43, 13],
      [45, 13],
      [47, 13],
      [44, 16],
      [46, 16],
    ].map(([x, y]) => ({ op: 'ellipse', cx: sq(x), cy: sq(y), rx: 12, ry: 12, rgba: [255, 255, 255, 255] }));
    plots.push({
      code: 'W7',
      title: 'authored _Drip dots',
      label: { x: sq(40) + 170, y: sq(10) + 30 },
      drip: dots,
      probes: [
        { name: 'dripDot', x: sq(45), y: sq(13) + 40, open: true },
        { name: 'dripClear', x: sq(45), y: sq(18.3), open: true },
      ],
    });
  }

  // W8 — alley: two roofed blocks, a one-square open gap.
  {
    const left = R(52, 12, 3, 6);
    const right = R(56, 12, 3, 6);
    plots.push({
      code: 'W8',
      title: 'alley (1 sq gap)',
      label: { x: sq(50) + 170, y: sq(10) + 30 },
      outdoors: [rect(left, [0, 0, 0]), rect(right, [0, 0, 0])],
      roof: [left, right],
      walls: [...roomWalls(left), ...roomWalls(right)],
      regions: [
        { key: 'W8a', rect: left, kind: 'indoor' },
        { key: 'W8b', rect: right, kind: 'indoor' },
      ],
      probes: [
        { name: 'alleyMid', x: sq(55.5), y: sq(15), open: true },
        { name: 'alleyRoof', x: sq(53.5), y: sq(15), open: false },
      ],
    });
  }

  // W9 — darkness Region (no Suppress Weather) over open ground: weather still falls, darker.
  {
    const reg = R(2, 22, 6, 6);
    plots.push({
      code: 'W9',
      title: 'darkness Region, open',
      label: { x: sq(0) + 170, y: sq(20) + 30 },
      regions: [
        {
          key: 'W9',
          rect: reg,
          kind: 'doc',
          doc: {
            name: 'darkness 0.9 (no suppress)',
            color: '#6c71c4',
            behaviors: [
              { name: 'Adjust Darkness Level', type: 'adjustDarknessLevel', system: { mode: 0, modifier: 0.9 } },
            ],
          },
        },
      ],
      probes: [
        { name: 'darkInside', x: sq(5), y: sq(25), open: true },
        { name: 'darkOutside', x: sq(5), y: sq(29.3), open: true },
      ],
    });
  }

  // W10 — scene corner: open ground to the scene's bottom-right edge.
  plots.push({
    code: 'W10',
    title: 'scene corner',
    label: { x: sq(50) + 170, y: sq(20) + 30 },
    probes: [
      { name: 'cornerIn', x: sq(57), y: sq(42), open: true },
      { name: 'cornerEdge', x: sq(60) - 40, y: sq(45) - 40, open: true },
    ],
  });

  return plots;
}

/** Every named probe point, flat, with its plot code. */
export function weatherProbes() {
  return weatherPlots().flatMap((p) => (p.probes ?? []).map((q) => ({ plot: p.code, ...q })));
}

/** The floor images: Ground art/_Outdoors/_Windows/_Drip, Upper art/_Outdoors (roof slabs only). */
export function weatherImages(version = LAB_VERSION) {
  const W = WEATHER_SIZE;
  const plots = weatherPlots();
  const base = `msa-lab-v${version}-weather`;
  const labels = plots.map((p) => text(p.label.x, p.label.y, `${p.code} ${p.title}`, 56));
  const roofs = plots.flatMap((p) => p.roof ?? []);
  const img = (floor, suffix, mode, ops) => ({
    name: `${base}-${floor.name}${suffix}.webp`,
    role: suffix || 'art',
    floor: floor.key,
    w: W.w,
    h: W.h,
    mode,
    ops,
  });
  const [g, u] = WEATHER_FLOORS;
  const groundArt = [{ op: 'fill', rgba: [GREY, GREY, GREY, 255] }, ...plots.flatMap((p) => p.art ?? []), ...labels];
  const groundOut = [{ op: 'fill', rgba: [255, 255, 255, 255] }, ...plots.flatMap((p) => p.outdoors ?? [])];
  const groundWin = [{ op: 'fill', rgba: [0, 0, 0, 255] }, ...plots.flatMap((p) => p.windows ?? [])];
  const groundDrip = [{ op: 'fill', rgba: [0, 0, 0, 255] }, ...plots.flatMap((p) => p.drip ?? [])];
  const upperArt = [{ op: 'fill', rgba: [0, 0, 0, 0] }];
  const upperOut = [{ op: 'fill', rgba: [0, 0, 0, 0] }];
  for (const r of roofs) {
    upperArt.push(rect(r, [GREY - 18, GREY - 18, GREY - 18, 255]));
    upperOut.push(rect(r, [0, 0, 0, 255]));
  }
  return [
    img(g, '', 'RGB', groundArt),
    img(g, '_Outdoors', 'RGB', groundOut),
    img(g, '_Windows', 'RGB', groundWin),
    img(g, '_Drip', 'RGB', groundDrip),
    img(u, '', 'RGBA', upperArt),
    img(u, '_Outdoors', 'RGBA', upperOut),
  ];
}

export function weatherScene(assetDir, version = LAB_VERSION) {
  const images = weatherImages(version);
  const artOf = (k) => `${assetDir}/${images.find((i) => i.floor === k && i.role === 'art').name}`;
  const plots = weatherPlots();
  const [g, u] = WEATHER_FLOORS;
  const levels = WEATHER_FLOORS.map((f, i) => ({
    _id: f.id,
    name: f.name,
    sort: i * 100,
    elevation: { bottom: f.bottom, top: f.top },
    background: { src: artOf(f.key), color: '#808080' },
    // Ground sees nothing below it; Upper looks down onto Ground through its holes.
    visibility: { levels: f.key === 'upper' ? [g.id] : [] },
    flags: { [MODULE_ID]: { [LAB_FLAG]: `level:weather-${f.key}` } },
  }));
  const walls = plots.flatMap((p) =>
    (p.walls ?? []).map((w, i) => ({
      ...w,
      levels: [g.id],
      flags: { [MODULE_ID]: { [LAB_FLAG]: `wall:${p.code}:${i}` } },
    }))
  );
  const regions = plots.flatMap((p) =>
    (p.regions ?? []).map((r) => {
      if (r.kind === 'indoor') return indoorRegion(r.key, r.rect, g, `indoor ${r.key}`);
      return {
        ...r.doc,
        elevation: { bottom: g.bottom, top: g.top, topInclusive: false },
        levels: [g.id],
        shapes: [{ type: 'rectangle', x: r.rect.x, y: r.rect.y, width: r.rect.w, height: r.rect.h, hole: false }],
        flags: { [MODULE_ID]: { [LAB_FLAG]: `region:${r.key}` } },
      };
    })
  );
  void u;
  return {
    key: 'weather',
    id: WEATHER_IDS.scene,
    data: {
      _id: WEATHER_IDS.scene,
      name: 'Lab · Weather',
      width: WEATHER_SIZE.w,
      height: WEATHER_SIZE.h,
      padding: PADDING,
      backgroundColor: '#808080',
      grid: { size: GRID, type: 1, distance: 5, units: 'ft' },
      initialLevel: g.id,
      levels,
      flags: { [MODULE_ID]: { [LAB_FLAG]: 'scene:weather', labVersion: version, enabled: true } },
    },
    walls,
    regions,
    sceneFlags: { sky: LAB_SKY, wind: LAB_WIND },
  };
}
