/**
 * tools/lab/interiors-spec.mjs — Lab · Interiors & Regions, as data (mmp-78u, family 1).
 *
 * Built from the "plots needed" section of tools/lab/claims/interiors-regions.md: every claim there
 * names a plot, and every plot here exists for some claim. The author's interiors are black
 * `_Outdoors` (hard 0-1 px edges) plus an "indoor" Region (Adjust Darkness Level OVERRIDE 0.9 +
 * Suppress Weather, Docklands 2026-11-08); this scene puts that template next to every other Region
 * case MSA has to get right: the three modes, edges, overlaps, seams, holes, two behaviours on one
 * Region, a disabled behaviour, Regions over OPEN ground with a building, a tree and a bush inside
 * them, Level scoping, lamps in and beside dark Regions, and the scene-wide darkness / Global
 * Illumination variants (set per run by the checker, not stored here).
 *
 * LAYOUT. Real-map size (60 x 45 squares, 150 px grid, 0.25 padding), three floors like Lab ·
 * Effects (Basement all black under one whole-floor Region, Ground, a transparent Upper with one
 * slab). Plots sit on the 10 x 10-square lattice of lab-spec.mjs (cellRect); two-cell plots span
 * two lattice columns. Rules the coordinates obey (FRICTION #19 and the C5 finding mmp-78u.11):
 *   - open-ground probe points are >= 150 px from any black area (the building-shadow blur spreads
 *     60-75 px on all sides at noon) and every shadow-test block has clear ground NORTH of it
 *     (noon sun is due south, so shadows fall north);
 *   - points read at golden hour (17:45, sun due west, shadows run ~1000 px EAST) have nothing black
 *     to their west in their own band: R3's first group and the OPEN plot sit on the scene's west edge;
 *   - Region probe points are >= 30 px inside an edge (MSA's soft edge is a 30 px Gaussian ramp)
 *     except the deliberate edge profiles;
 *   - rooms where room logic matters are CLOSED (walls form a loop; the only gap is a closed door).
 *
 * Pure. Coordinates: scene pixels (the builder adds Foundry's padding offset).
 *
 * @module tools/lab/interiors-spec
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
  paintOps,
} from './lab-spec.mjs';

const { sq, rect, clear, text } = paintOps;

export const INTERIORS_IDS = Object.freeze({
  scene: 'msaLabInterior00',
  levelBasement: 'msaLabIntBasemnt',
  levelGround: 'msaLabIntGround0',
  levelUpper: 'msaLabIntUpper00',
});

/** Floors, bottom first (the Lab · Effects / Big Bank convention). */
export const INTERIORS_FLOORS = Object.freeze([
  Object.freeze({
    key: 'basement',
    letter: 'B',
    name: 'Basement',
    id: INTERIORS_IDS.levelBasement,
    bottom: -20,
    top: 0,
  }),
  Object.freeze({ key: 'ground', letter: 'G', name: 'Ground', id: INTERIORS_IDS.levelGround, bottom: 0, top: 20 }),
  Object.freeze({ key: 'upper', letter: 'U', name: 'Upper', id: INTERIORS_IDS.levelUpper, bottom: 20, top: 40 }),
]);
const FLOOR = Object.fromEntries(INTERIORS_FLOORS.map((f) => [f.key, f]));

export const INTERIORS_SIZE = Object.freeze({ w: 9000, h: 6750 }); // 60 x 45 squares

/** Region modes (Foundry AdjustDarknessLevelRegionBehaviorType.MODES). */
export const MODE = Object.freeze({ OVERRIDE: 0, BRIGHTEN: 1, DARKEN: 2 });

/** The lab lamp (walls-spec LAMP): bright 4 ft = 120 px, dim 12 ft = 360 px. */
export const LAMP = Object.freeze({
  dim: 12,
  bright: 4,
  color: '#ffd9a0',
  alpha: 0.5,
  luminosity: 0.5,
  attenuation: 0.5,
});

/** Canopy colours: grey-green, like the author's _Tree (58,96,62) / _Bush (94,98,61) but nearer the floor grey. */
const TREE_RGB = [100, 124, 96];
const BUSH_RGB = [112, 126, 100];

const NORMAL = Object.freeze({ move: SENSE.NORMAL, sight: SENSE.NORMAL, light: SENSE.NORMAL, sound: SENSE.NORMAL });

// ------------------------------------------------------------------------------------------- builders
const darkness = (mode, modifier, extra = {}) => ({
  name: 'Adjust Darkness Level',
  type: 'adjustDarknessLevel',
  system: { mode, modifier },
  ...extra,
});
const SUPPRESS = Object.freeze({ name: 'Suppress Weather', type: 'suppressWeather', system: {} });
const box = (x, y, w, h, hole = false) => ({ type: 'rectangle', x, y, width: w, height: h, hole });
const GROUND_ELEV = Object.freeze({ bottom: 0, top: 20, topInclusive: false });
const ANY_ELEV = Object.freeze({ bottom: null, top: null, topInclusive: false });

/**
 * One Region. Defaults follow the author's interiors: Ground only (levels [Ground]) and the Ground
 * band [0, 20). `key` lands in the lab flag so the checker can find a Region by name.
 */
function region(key, shapes, behaviors, { levels, elevation, name, color } = {}) {
  return {
    name: name ?? `lab ${key}`,
    color: color ?? '#4328cc',
    elevation: elevation ?? GROUND_ELEV,
    levels: levels ?? [FLOOR.ground.id],
    shapes,
    behaviors,
    flags: { [MODULE_ID]: { [LAB_FLAG]: `region:${key}` } },
  };
}
/** The author's indoor template (Docklands): OVERRIDE 0.9 + Suppress Weather. */
const indoor = (key, r, opts = {}) =>
  region(key, [box(r.x, r.y, r.w, r.h)], [darkness(MODE.OVERRIDE, 0.9), SUPPRESS], opts);

/** Four normal walls round `r` with a closed door (1 square) in the middle of the south wall. */
function closedRoomWalls(r) {
  const midX = r.x + r.w / 2;
  const half = GRID / 2;
  return [
    { c: [r.x, r.y, r.x + r.w, r.y], ...NORMAL },
    { c: [r.x + r.w, r.y, r.x + r.w, r.y + r.h], ...NORMAL },
    { c: [r.x, r.y + r.h, r.x, r.y], ...NORMAL },
    { c: [r.x + r.w, r.y + r.h, midX + half, r.y + r.h], ...NORMAL },
    { c: [midX - half, r.y + r.h, r.x, r.y + r.h], ...NORMAL },
    { c: [midX + half, r.y + r.h, midX - half, r.y + r.h], ...NORMAL, door: DOOR.DOOR, ds: 0 },
  ];
}

const BLACK = [0, 0, 0];
const label = (x, y, s, size = 40) => text(x, y, s, size);
/** Canopy disc for _Tree/_Bush (paint.py `ellipse`: hard ~1 px anti-aliased alpha edge, the author's convention). */
const canopy = (cx, cy, r, rgb) => ({ op: 'ellipse', cx, cy, rx: r, ry: r, rgba: [...rgb, 255] });

/** Lattice origin of a plot cell (lab-spec cellRect geometry: 10 x 10 squares, 1-square gutter). */
const cellOrigin = (col, row) => ({ x: sq(col * 10), y: sq(row * 10) });
/** Test area of a plot spanning `cols` lattice columns. */
function plotArea(col, row, cols = 1) {
  const o = cellOrigin(col, row);
  return { x: o.x + GRID, y: o.y + GRID, w: sq(cols * 10) - 2 * GRID, h: sq(10) - 2 * GRID, ox: o.x, oy: o.y };
}

// ------------------------------------------------------------------------------------------- plots
/**
 * Every plot: its lattice place, what it paints per floor, its documents, and its named probe GROUPS
 * (a group = one camera position: centre, scale, level and the points read there in ONE probe call).
 * Points are scene px. `art`/`outdoors`/`tree`/`bush` ops are Ground unless a plot says otherwise.
 */
export function interiorsPlots() {
  const plots = [];

  // OPEN — nothing at all: the reference for open ground (noon, golden, clouds, moon, GI).
  {
    const a = plotArea(0, 0);
    const pts = [];
    for (const [i, dy] of [-300, 0, 300].entries()) {
      for (const [j, dx] of [-300, 0, 300].entries()) {
        pts.push({ name: `o${i}${j}`, x: a.x + a.w / 2 + dx, y: a.y + a.h / 2 + dy });
      }
    }
    pts.push({ name: 'open', x: a.x + a.w / 2, y: a.y + a.h / 2 });
    plots.push({
      code: 'OPEN',
      title: 'open sky',
      col: 0,
      row: 0,
      groups: [{ key: 'OPEN', level: 'ground', cx: a.x + a.w / 2, cy: a.y + a.h / 2, scale: 0.7, pts }],
    });
  }

  // R1 — the three modes: a 13 x 7-square black band, six 2 x 2 Regions (darkness behaviour only),
  // 2-square black gaps between them, 1.5 squares of black outside region a's west edge (the fade
  // profile reads black-without-Region on both sides of the edge).
  {
    const a = plotArea(1, 0, 2);
    const band = { x: 2025, y: 225, w: sq(13), h: sq(7) };
    const R = {
      a: { x: 2250, y: 375, mode: MODE.OVERRIDE, m: 0.9, txt: 'a OVERRIDE .9' },
      b: { x: 2850, y: 375, mode: MODE.OVERRIDE, m: 0.5, txt: 'b OVERRIDE .5' },
      c: { x: 3450, y: 375, mode: MODE.OVERRIDE, m: 0.0, txt: 'c OVERRIDE 0' },
      d: { x: 2250, y: 825, mode: MODE.BRIGHTEN, m: 0.5, txt: 'd BRIGHTEN .5' },
      e: { x: 2850, y: 825, mode: MODE.DARKEN, m: 0.5, txt: 'e DARKEN .5' },
      f: { x: 3450, y: 825, mode: MODE.DARKEN, m: 1.0, txt: 'f DARKEN 1' },
    };
    const S = 300;
    const regions = Object.entries(R).map(([k, r]) =>
      region(`R1.${k}`, [box(r.x, r.y, S, S)], [darkness(r.mode, r.m)])
    );
    const centres = Object.entries(R).map(([k, r]) => ({ name: k, x: r.x + S / 2, y: r.y + S / 2 }));
    const edgeY = R.a.y + S / 2;
    const profile = [-30, -20, -10, -5, 0, 5, 10, 20, 30].map((d) => ({
      name: `e${d < 0 ? 'm' : 'p'}${Math.abs(d)}`,
      x: R.a.x + d,
      y: edgeY,
    }));
    plots.push({
      code: 'R1',
      title: 'region modes',
      col: 1,
      row: 0,
      cols: 2,
      outdoors: [rect(band, BLACK)],
      art: Object.values(R).map((r) => label(r.x + 40, r.y - 62, r.txt)),
      regions,
      groups: [
        {
          key: 'R1',
          level: 'ground',
          cx: a.x + a.w / 2,
          cy: a.y + a.h / 2,
          scale: 0.62,
          pts: [
            ...centres,
            { name: 'gap', x: 2700, y: 525 },
            { name: 'gap2', x: 2700, y: 975 },
            { name: 'open', x: 1837, y: 750 },
          ],
        },
        {
          // the fade across region a's west edge, zoomed so 1 world px is 2 screen px
          key: 'R1.edge',
          level: 'ground',
          cx: R.a.x + 60,
          cy: edgeY - 60,
          scale: 2,
          pts: [
            ...profile,
            { name: 'a', x: R.a.x + S / 2 - 40, y: edgeY },
            { name: 'gapW', x: R.a.x - 110, y: edgeY },
            { name: 'corner', x: R.a.x, y: R.a.y },
            { name: 'cornerOut', x: R.a.x - 60, y: R.a.y - 60 },
            // the NORTH edge at mid-width: the corner should read the product of the two edges' coverage
            { name: 'n0', x: R.a.x + 110, y: R.a.y },
            { name: 'nOut', x: R.a.x + 110, y: R.a.y - 100 },
          ],
        },
      ],
    });
  }

  // R2 — overlaps and seams on an all-black 18 x 8-square area.
  {
    const a = plotArea(3, 0, 2);
    const S = 300;
    const regions = [
      // overlap pair 1: the 0.3 Region is created FIRST
      region('R2.ov1.3', [box(4800, 300, S, S)], [darkness(MODE.OVERRIDE, 0.3)]),
      region('R2.ov1.9', [box(4950, 300, S, S)], [darkness(MODE.OVERRIDE, 0.9)]),
      // overlap pair 2: the same geometry, the 0.9 Region created FIRST
      region('R2.ov2.9', [box(4950, 750, S, S)], [darkness(MODE.OVERRIDE, 0.9)]),
      region('R2.ov2.3', [box(4800, 750, S, S)], [darkness(MODE.OVERRIDE, 0.3)]),
      // one Region, two shapes sharing an edge
      region('R2.seam', [box(5550, 300, S, S), box(5850, 300, S, S)], [darkness(MODE.OVERRIDE, 0.9)]),
      // two separate Regions of equal darkness that touch
      region('R2.touchL', [box(5550, 750, S, S)], [darkness(MODE.OVERRIDE, 0.9)]),
      region('R2.touchR', [box(5850, 750, S, S)], [darkness(MODE.OVERRIDE, 0.9)]),
      // a 3 x 3 Region with a 1 x 1 hole
      region('R2.hole', [box(6450, 300, 450, 450), box(6600, 450, 150, 150, true)], [darkness(MODE.OVERRIDE, 0.9)]),
      // touching 0.9 | 0.5
      region('R2.step9', [box(6450, 900, S, S)], [darkness(MODE.OVERRIDE, 0.9)]),
      region('R2.step5', [box(6750, 900, S, S)], [darkness(MODE.OVERRIDE, 0.5)]),
    ];
    const stepPts = [-20, -10, -5, 0, 5, 10, 20].map((d) => ({
      name: `step${d < 0 ? 'm' : 'p'}${Math.abs(d)}`,
      x: 6750 + d,
      y: 1050,
    }));
    plots.push({
      code: 'R2',
      title: 'overlaps and seams',
      col: 3,
      row: 0,
      cols: 2,
      outdoors: [rect(a, BLACK)],
      art: [
        label(4840, 238, 'overlap: .3 made first | .9'),
        label(4840, 688, 'overlap: .9 made first | .3'),
        label(5590, 238, 'one Region, two shapes'),
        label(5590, 688, 'two touching Regions'),
        label(6490, 238, 'hole'),
        label(6490, 838, '.9 | .5 touching'),
      ],
      regions,
      groups: [
        {
          key: 'R2',
          level: 'ground',
          cx: a.x + a.w / 2,
          cy: a.y + a.h / 2,
          scale: 0.62,
          pts: [
            { name: 'ov', x: 5025, y: 450 },
            { name: 'only3', x: 4875, y: 450 },
            { name: 'only9', x: 5175, y: 450 },
            { name: 'ovB', x: 5025, y: 900 },
            { name: 'only3B', x: 4875, y: 900 },
            { name: 'only9B', x: 5175, y: 900 },
            { name: 'seam', x: 5850, y: 450 },
            { name: 'seamP40', x: 5890, y: 450 },
            { name: 'seamL', x: 5700, y: 450 },
            { name: 'seamR', x: 6000, y: 450 },
            { name: 'touch', x: 5850, y: 900 },
            { name: 'touchL', x: 5700, y: 900 },
            { name: 'touchR', x: 6000, y: 900 },
            { name: 'hole', x: 6675, y: 525 },
            { name: 'holeRing', x: 6525, y: 525 },
            { name: 'plat9', x: 6600, y: 1050 },
            { name: 'plat5', x: 6900, y: 1050 },
            { name: 'gap', x: 5400, y: 450 },
          ],
        },
        {
          key: 'R2.zoom',
          level: 'ground',
          cx: 6150,
          cy: 675,
          scale: 1.05,
          pts: [
            ...stepPts,
            { name: 'plat9', x: 6600, y: 1050 },
            { name: 'plat5', x: 6900, y: 1050 },
            { name: 'corner', x: 5550, y: 300 },
            { name: 'seam', x: 5850, y: 450 },
            { name: 'seamL', x: 5700, y: 450 },
            { name: 'seamM10', x: 5840, y: 450 },
            { name: 'seamP10', x: 5860, y: 450 },
            { name: 'touch', x: 5850, y: 900 },
            { name: 'touchM10', x: 5840, y: 900 },
            { name: 'touchP10', x: 5860, y: 900 },
            { name: 'gap', x: 5400, y: 450 },
          ],
        },
      ],
    });
  }

  // EDGE — a Region straddling the scene's north edge, over open ground (IR-61).
  {
    plots.push({
      code: 'EDGE',
      title: 'region off the scene edge',
      col: 5,
      row: 0,
      art: [label(7820, 560, 'Region from y -300 to +300 (half off the scene)', 40)],
      regions: [region('EDGE', [box(7800, -300, 600, 600)], [darkness(MODE.OVERRIDE, 0.9)])],
      groups: [
        {
          key: 'EDGE',
          level: 'ground',
          cx: 8250,
          cy: 300,
          scale: 0.9,
          pts: [
            { name: 'in', x: 8100, y: 150 },
            { name: 's20', x: 8100, y: 320 },
            { name: 's40', x: 8100, y: 340 },
            { name: 's100', x: 8100, y: 400 },
            { name: 'w20', x: 7780, y: 150 },
            { name: 'e20', x: 8420, y: 150 },
            { name: 'ctrl', x: 8700, y: 400 },
            { name: 'ctrlN', x: 8700, y: 150 },
          ],
        },
      ],
    });
  }

  // R3 — Regions over OPEN ground (IR-27/28/35-38): four 4 x 6-square groups side by side, each with a
  // 1 x 1 black building, a tree canopy east of it and a bush south of it, clear ground north of all
  // three. br BRIGHTEN 0.5 | dk DARKEN 0.5 | sw Suppress Weather only | ref no Region.
  {
    const a = plotArea(0, 1, 2);
    const GX = [180, 855, 1530, 2205];
    const KEYS = ['br', 'dk', 'sw', 'ref'];
    const TXT = { br: 'br BRIGHTEN .5', dk: 'dk DARKEN .5', sw: 'sw Suppress Weather', ref: 'ref (no Region)' };
    const Y0 = 1800;
    const outdoors = [];
    const tree = [];
    const bush = [];
    const art = [];
    const regions = [];
    const pts = [];
    GX.forEach((x0, i) => {
      const k = KEYS[i];
      outdoors.push(rect({ x: x0 + 100, y: Y0 + 500, w: 150, h: 150 }, BLACK));
      tree.push(canopy(x0 + 430, Y0 + 575, 90, TREE_RGB));
      bush.push(canopy(x0 + 175, Y0 + 790, 50, BUSH_RGB));
      art.push(label(x0 + 20, Y0 - 70, TXT[k]));
      if (k === 'br') regions.push(region('R3.br', [box(x0, Y0, 600, 900)], [darkness(MODE.BRIGHTEN, 0.5)]));
      if (k === 'dk') regions.push(region('R3.dk', [box(x0, Y0, 600, 900)], [darkness(MODE.DARKEN, 0.5)]));
      if (k === 'sw') regions.push(region('R3.sw', [box(x0, Y0, 600, 900)], [SUPPRESS]));
      pts.push(
        { name: `${k}.open`, x: x0 + 300, y: Y0 + 200 },
        { name: `${k}.north`, x: x0 + 175, y: Y0 + 460 },
        { name: `${k}.north20`, x: x0 + 175, y: Y0 + 480 },
        { name: `${k}.south`, x: x0 + 175, y: Y0 + 690 },
        { name: `${k}.treeN5`, x: x0 + 430, y: Y0 + 480 },
        { name: `${k}.treeN15`, x: x0 + 430, y: Y0 + 470 },
        { name: `${k}.treeN30`, x: x0 + 430, y: Y0 + 455 },
        { name: `${k}.treeN60`, x: x0 + 430, y: Y0 + 425 },
        { name: `${k}.bushN5`, x: x0 + 175, y: Y0 + 735 },
        // 110 px NORTH of the Region, same open ground: the local control for clouds, moon and tint
        { name: `${k}.outN`, x: x0 + 300, y: Y0 - 110 }
      );
      // a 3 x 3 patch (40 px apart) round the open point of sw and ref: rain flicker is read as a patch
      // mean, because one pixel's 30-frame flicker depends on whether a streak happened to cross it
      if (k === 'sw' || k === 'ref') {
        for (const [i, [dx, dy]] of [-40, 0, 40].flatMap((oy) => [-40, 0, 40].map((ox) => [ox, oy])).entries()) {
          pts.push({ name: `${k}.r${i}`, x: x0 + 300 + dx, y: Y0 + 200 + dy });
        }
      }
    });
    plots.push({
      code: 'R3',
      title: 'regions over open ground',
      col: 0,
      row: 1,
      cols: 2,
      outdoors,
      tree,
      bush,
      art,
      regions,
      groups: [{ key: 'R3', level: 'ground', cx: a.x + a.w / 2, cy: Y0 + 450, scale: 0.62, pts }],
    });
  }

  // R5 — lamps in and beside dark Regions (IR-50..55): a closed 6 x 6-square room (normal walls, a
  // closed door) under the indoor template, a black band with the template over its EAST part only
  // and no walls, and open ground.
  {
    const a = plotArea(2, 1, 2);
    const room = { x: 3300, y: 1800, w: 900, h: 900 };
    const band = { x: 4500, y: 1800, w: 1200, h: 450 };
    const bandRegion = { x: 4920, y: 1800, w: 780, h: 450 };
    const lights = [
      { key: 'L1', x: 3525, y: 2250, config: LAMP },
      { key: 'L2', x: 3975, y: 2250, config: { ...LAMP, darkness: { min: 0.5, max: 1 } } },
      { key: 'L3', x: 4700, y: 2600, config: LAMP },
      { key: 'L4', x: 4900, y: 2025, config: LAMP },
    ];
    plots.push({
      code: 'R5',
      title: 'lamps and dark regions',
      col: 2,
      row: 1,
      cols: 2,
      outdoors: [rect(room, BLACK), rect(band, BLACK)],
      art: [
        label(3320, 1735, 'closed room: indoor Region; L1 | L2 night-only'),
        label(4520, 1735, 'band: Region over the east part, no walls; L4'),
        label(4560, 2760, 'L3 open ground'),
      ],
      walls: closedRoomWalls(room),
      lights,
      regions: [indoor('R5.room', room), indoor('R5.band', bandRegion)],
      groups: [
        {
          key: 'R5',
          level: 'ground',
          cx: a.x + a.w / 2,
          cy: a.y + a.h / 2,
          scale: 0.62,
          pts: [
            { name: 'L1b', x: 3525, y: 2210 },
            { name: 'L1d', x: 3525, y: 2010 },
            { name: 'L2b', x: 3975, y: 2210 },
            { name: 'ref', x: 3360, y: 1860 },
            { name: 'L3b', x: 4740, y: 2600 },
            { name: 'L3d', x: 4940, y: 2600 },
            { name: 'L3ref', x: 5300, y: 2600 },
            { name: 'L4in', x: 5140, y: 2025 },
            { name: 'L4ref', x: 5500, y: 2025 },
            { name: 'L4out', x: 4660, y: 2025 },
          ],
        },
      ],
    });
  }

  // D1 — scene-wide darkness and Global Illumination variants (the checker sets them per run): a
  // copy of R1.a on black, a 2 x 2 building on open ground with clear ground north, and an
  // OVERRIDE 0.1 Region on open ground (IR-49).
  {
    const a = plotArea(4, 1);
    plots.push({
      code: 'D1',
      title: 'scene darkness and GI',
      col: 4,
      row: 1,
      outdoors: [rect({ x: 6250, y: 1750, w: 600, h: 600 }, BLACK), rect({ x: 6950, y: 2450, w: 300, h: 300 }, BLACK)],
      art: [label(6290, 1705, 'OVERRIDE .9 on black'), label(6270, 2785, 'OVERRIDE .1'), label(6960, 2785, 'building')],
      regions: [
        region('D1.room', [box(6400, 1900, 300, 300)], [darkness(MODE.OVERRIDE, 0.9)]),
        region('D1.ov01', [box(6250, 2450, 300, 300)], [darkness(MODE.OVERRIDE, 0.1)]),
      ],
      groups: [
        {
          key: 'D1',
          level: 'ground',
          cx: a.x + a.w / 2,
          cy: a.y + a.h / 2,
          scale: 0.7,
          pts: [
            { name: 'room', x: 6550, y: 2050 },
            { name: 'north', x: 7100, y: 2410 },
            { name: 'north20', x: 7100, y: 2430 },
            { name: 'open', x: 6750, y: 2650 },
            { name: 'ov01', x: 6400, y: 2600 },
          ],
        },
      ],
    });
  }

  // I1 — the author's interior, exactly (lab-spec C3): black room, four normal walls with a closed
  // door, the indoor template, and an Upper slab over it.
  {
    const a = plotArea(5, 1);
    const o = cellOrigin(5, 1);
    plots.push({
      code: 'I1',
      title: 'interior room (indoor Region)',
      col: 5,
      row: 1,
      outdoors: [rect(a, BLACK)],
      walls: closedRoomWalls(a),
      regions: [indoor('I1', a)],
      upperSlab: { x: o.x, y: o.y, w: sq(10), h: sq(10) },
      groups: [
        {
          key: 'I1',
          level: 'ground',
          cx: a.x + a.w / 2,
          cy: a.y + a.h / 2,
          scale: 0.7,
          pts: [
            { name: 'centre', x: 8250, y: 2250 },
            { name: 'nw', x: 7800, y: 1800 },
            { name: 'se', x: 8700, y: 2700 },
            { name: 'ring', x: 7575, y: 2250 },
            // the interior's rain-flicker patch (see R3's sw/ref patches)
            ...[-40, 0, 40]
              .flatMap((oy) => [-40, 0, 40].map((ox) => [ox, oy]))
              .map(([dx, dy], i) => ({
                name: `c.r${i}`,
                x: 8250 + dx,
                y: 2250 + dy,
              })),
          ],
        },
        {
          key: 'I1.edge',
          level: 'ground',
          cx: 7700,
          cy: 2200,
          scale: 2,
          pts: [-30, -20, -10, -5, 0, 5, 10, 20, 30]
            .map((d) => ({ name: `e${d < 0 ? 'm' : 'p'}${Math.abs(d)}`, x: 7650 + d, y: 2250 }))
            .concat([
              { name: 'in', x: 7780, y: 2250 },
              { name: 'out', x: 7520, y: 2250 },
            ]),
        },
      ],
    });
  }

  // BLK — black _Outdoors with NO Region (C5's hard half), plus a 2 x 1 block 45 px south of it whose
  // noon shadow would fall into the big block if the indoor receiver gate failed (IR-30).
  {
    const a = plotArea(0, 2);
    plots.push({
      code: 'BLK',
      title: 'black, no region',
      col: 0,
      row: 2,
      outdoors: [rect({ x: 300, y: 3300, w: 900, h: 450 }, BLACK), rect({ x: 600, y: 3795, w: 300, h: 150 }, BLACK)],
      art: [label(320, 3240, 'black _Outdoors, no Region')],
      groups: [
        {
          key: 'BLK',
          level: 'ground',
          cx: a.x + a.w / 2,
          cy: a.y + a.h / 2,
          scale: 0.7,
          pts: [
            { name: 'centre', x: 750, y: 3525 },
            { name: 'in15', x: 750, y: 3735 },
            { name: 'in40', x: 750, y: 3710 },
            { name: 'gap', x: 750, y: 3772 },
            { name: 'open', x: 750, y: 4200 },
            { name: 'west', x: 360, y: 3525 },
          ],
        },
      ],
    });
  }

  // R4 — Level scoping (IR-21..24): four 2 x 2 black blocks on Ground under transparent Upper art.
  // A: OVERRIDE .5, levels [Ground], elevation open. B: OVERRIDE .5, levels [], elevation [0,20).
  // C: no Region. D: OVERRIDE .5, levels [], elevation open (every floor).
  {
    const a = plotArea(1, 2, 2);
    const X = { A: 1800, B: 2475, C: 3150, D: 3825 };
    const Y = 3600;
    const S = 300;
    const pts = Object.entries(X).map(([k, x]) => ({ name: k, x: x + S / 2, y: Y + S / 2 }));
    pts.push({ name: 'open', x: 2800, y: 4200 });
    const lvl = (k) => `R4.${k}`;
    plots.push({
      code: 'R4',
      title: 'level scoping',
      col: 1,
      row: 2,
      cols: 2,
      outdoors: Object.values(X).map((x) => rect({ x, y: Y, w: S, h: S }, BLACK)),
      art: [
        label(1800, 3480, 'A lv[G] el any'),
        label(2475, 3480, 'B lv[] el 0-20'),
        label(3150, 3480, 'C none'),
        label(3825, 3480, 'D lv[] el any'),
      ],
      regions: [
        region(lvl('A'), [box(X.A, Y, S, S)], [darkness(MODE.OVERRIDE, 0.5)], {
          levels: [FLOOR.ground.id],
          elevation: ANY_ELEV,
        }),
        region(lvl('B'), [box(X.B, Y, S, S)], [darkness(MODE.OVERRIDE, 0.5)], { levels: [], elevation: GROUND_ELEV }),
        region(lvl('D'), [box(X.D, Y, S, S)], [darkness(MODE.OVERRIDE, 0.5)], { levels: [], elevation: ANY_ELEV }),
      ],
      groups: [
        { key: 'R4', level: 'ground', cx: a.x + a.w / 2, cy: a.y + a.h / 2, scale: 0.62, pts },
        { key: 'R4@upper', level: 'upper', cx: a.x + a.w / 2, cy: a.y + a.h / 2, scale: 0.62, pts },
        { key: 'R4@basement', level: 'basement', cx: a.x + a.w / 2, cy: a.y + a.h / 2, scale: 0.62, pts },
      ],
    });
  }

  // STAIR — a 4 x 2-square hole in Ground onto the basement, and a second basement Region scoped by
  // ELEVATION only (levels [], [-20, 0)), which Foundry's depth test applies when looking down (IR-58).
  {
    const a = plotArea(3, 2);
    const hole = { x: 4950, y: 3450, w: 600, h: 300 };
    plots.push({
      code: 'STAIR',
      title: 'stairwell',
      col: 3,
      row: 2,
      holes: [hole],
      art: [label(4970, 3380, 'stairwell (hole)')],
      regions: [
        indoor(
          'STAIR.below',
          { x: 4800, y: 3300, w: 900, h: 600 },
          {
            levels: [],
            elevation: { bottom: -20, top: 0, topInclusive: false },
            name: 'lab STAIR.below (levels [], elevation -20..0)',
          }
        ),
      ],
      groups: [
        {
          key: 'STAIR',
          level: 'ground',
          cx: a.x + a.w / 2,
          cy: a.y + a.h / 2,
          scale: 0.7,
          pts: [
            { name: 'hole', x: 5250, y: 3600 },
            { name: 'holeW', x: 5050, y: 3600 },
            { name: 'rim', x: 5250, y: 3330 },
            { name: 'open', x: 5250, y: 4150 },
          ],
        },
      ],
    });
  }

  // R2b — two behaviours on one Region (both orders), a disabled behaviour, and a DARKEN .5 /
  // BRIGHTEN .5 overlap that tells "independent, then minimum" from "chained" (IR-12, IR-25, IR-26).
  {
    const a = plotArea(4, 2, 2);
    const S = 300;
    plots.push({
      code: 'R2b',
      title: 'behaviours',
      col: 4,
      row: 2,
      cols: 2,
      outdoors: [rect(a, BLACK)],
      art: [
        label(6320, 3238, 'two: .9 then .4'),
        label(6320, 3688, 'two: .4 then .9'),
        label(6920, 3238, 'disabled .9'),
        label(7520, 3238, 'DARKEN .5 | BRIGHTEN .5 overlap'),
      ],
      regions: [
        region('R2b.dual', [box(6300, 3300, S, S)], [darkness(MODE.OVERRIDE, 0.9), darkness(MODE.OVERRIDE, 0.4)]),
        region('R2b.dual2', [box(6300, 3750, S, S)], [darkness(MODE.OVERRIDE, 0.4), darkness(MODE.OVERRIDE, 0.9)]),
        region('R2b.off', [box(6900, 3300, S, S)], [darkness(MODE.OVERRIDE, 0.9, { disabled: true })]),
        region('R2b.chainDk', [box(7500, 3300, 450, S)], [darkness(MODE.DARKEN, 0.5)]),
        region('R2b.chainBr', [box(7800, 3300, 450, S)], [darkness(MODE.BRIGHTEN, 0.5)]),
      ],
      groups: [
        {
          key: 'R2b',
          level: 'ground',
          cx: a.x + a.w / 2,
          cy: a.y + a.h / 2,
          scale: 0.62,
          pts: [
            { name: 'dual', x: 6450, y: 3450 },
            { name: 'dual2', x: 6450, y: 3900 },
            { name: 'off', x: 7050, y: 3450 },
            { name: 'chainOv', x: 7875, y: 3450 },
            { name: 'chainDk', x: 7650, y: 3450 },
            { name: 'chainBr', x: 8100, y: 3450 },
            { name: 'gap', x: 6750, y: 3450 },
          ],
        },
      ],
    });
  }

  // Probe groups on the other floors (no painting of their own here).
  plots.push({
    code: 'UP',
    title: 'seen from Upper',
    groups: [
      {
        key: 'U.slab',
        level: 'upper',
        cx: 8250,
        cy: 2250,
        scale: 0.7,
        pts: [
          { name: 'slab', x: 8250, y: 2250 },
          { name: 'slabNW', x: 7700, y: 1700 },
        ],
      },
      { key: 'U.open', level: 'upper', cx: 750, cy: 750, scale: 0.7, pts: [{ name: 'open', x: 750, y: 750 }] },
    ],
  });
  plots.push({
    code: 'BSMT',
    title: 'basement',
    groups: [
      {
        key: 'B.west',
        level: 'basement',
        cx: 1500,
        cy: 2200,
        scale: 0.26,
        pts: [
          { name: 'p1', x: 750, y: 750 },
          { name: 'p3', x: 750, y: 3525 },
          // clear of R4's blocks: R4.A's leak onto the basement is IR-22's, not a basement-uniformity fact
          { name: 'p4', x: 2400, y: 3300 },
          { name: 'p7', x: 2400, y: 525 },
        ],
      },
      {
        key: 'B.east',
        level: 'basement',
        cx: 6600,
        cy: 2200,
        scale: 0.26,
        pts: [
          { name: 'p2', x: 6000, y: 750 },
          { name: 'p5', x: 5250, y: 3600 },
          { name: 'p6', x: 8250, y: 2250 },
        ],
      },
    ],
  });
  return plots;
}

/** Every probe group of the scene, by key. */
export function interiorsGroups() {
  const out = {};
  for (const p of interiorsPlots()) for (const g of p.groups ?? []) out[g.key] = { ...g, plot: p.code };
  return out;
}

// ------------------------------------------------------------------------------------------- images
/** Corner glyph squares: each floor prints its letter in all four scene corners. */
function floorGlyphs(floor, size) {
  const s = sq(1);
  return [
    [0, 0],
    [size.w - s, 0],
    [0, size.h - s],
    [size.w - s, size.h - s],
  ].flatMap(([x, y]) => [
    rect({ x, y, w: s, h: s }, [INK, INK, INK, 255]),
    text(x + 40, y + 22, floor.letter, 96, [GREY, GREY, GREY, 255]),
  ]);
}

export function interiorsImages(version = LAB_VERSION) {
  const size = INTERIORS_SIZE;
  const plots = interiorsPlots().filter((p) => Number.isFinite(p.col));
  const base = `msa-lab-v${version}-interiors`;
  const images = [];
  const holes = plots.flatMap((p) => p.holes ?? []);
  const labels = (letter) =>
    plots.map((p) => {
      const o = cellOrigin(p.col, p.row);
      return text(o.x + 170, o.y + 30, `${letter} ${p.code} ${p.title}`, 64);
    });
  const img = (floor, suffix, mode, ops) => ({
    name: `${base}-${floor.name}${suffix}.webp`,
    role: suffix || 'art',
    floor: floor.key,
    w: size.w,
    h: size.h,
    mode,
    ops,
  });
  for (const floor of INTERIORS_FLOORS) {
    if (floor.key === 'ground') {
      const art = [
        { op: 'fill', rgba: [GREY, GREY, GREY, 255] },
        ...plots.flatMap((p) => p.art ?? []),
        ...labels(floor.letter),
        ...holes.map(clear),
        ...floorGlyphs(floor, size),
      ];
      const outdoors = [
        { op: 'fill', rgba: [255, 255, 255, 255] },
        ...plots.flatMap((p) => p.outdoors ?? []),
        ...holes.map(clear),
      ];
      images.push(img(floor, '', 'RGBA', art), img(floor, '_Outdoors', 'RGBA', outdoors));
      const empty = { op: 'fill', rgba: [0, 0, 0, 0] };
      images.push(img(floor, '_Tree', 'RGBA', [empty, ...plots.flatMap((p) => p.tree ?? [])]));
      images.push(img(floor, '_Bush', 'RGBA', [empty, ...plots.flatMap((p) => p.bush ?? [])]));
    } else if (floor.key === 'basement') {
      // a real cellar: grey floor, all-black _Outdoors (the author's underground rule)
      images.push(
        img(floor, '', 'RGB', [
          { op: 'fill', rgba: [GREY, GREY, GREY, 255] },
          ...labels(floor.letter),
          ...floorGlyphs(floor, size),
        ]),
        img(floor, '_Outdoors', 'RGB', [{ op: 'fill', rgba: [0, 0, 0, 255] }])
      );
    } else {
      // Upper: transparent except the slab over I1; the mask shares the holes
      const slabs = plots.filter((p) => p.upperSlab).map((p) => p.upperSlab);
      const art = [{ op: 'fill', rgba: [0, 0, 0, 0] }];
      const outdoors = [{ op: 'fill', rgba: [0, 0, 0, 0] }];
      for (const s of slabs) {
        art.push(rect(s, [GREY, GREY, GREY, 255]), text(s.x + 170, s.y + 30, 'U slab', 64, [INK, INK, INK, 255]));
        outdoors.push(rect(s, [0, 0, 0, 255]));
      }
      const glyphs = floorGlyphs(floor, size);
      art.push(...glyphs);
      for (const g of glyphs) if (g.op === 'rect') outdoors.push({ ...g, rgba: [0, 0, 0, 255] });
      images.push(img(floor, '', 'RGBA', art), img(floor, '_Outdoors', 'RGBA', outdoors));
    }
  }
  return images;
}

// ------------------------------------------------------------------------------------------- scene
export function interiorsScene(assetDir, version = LAB_VERSION) {
  const images = interiorsImages(version);
  const plots = interiorsPlots();
  const artOf = (k) => `${assetDir}/${images.find((i) => i.floor === k && i.role === 'art').name}`;
  const levels = INTERIORS_FLOORS.map((f, i) => ({
    _id: f.id,
    name: f.name,
    sort: i * 100,
    elevation: { bottom: f.bottom, top: f.top },
    background: { src: artOf(f.key), color: '#808080' },
    // Ground looks down the stairwell, Upper looks down onto Ground, the basement lists nothing
    // (listing the solid floor above would cover it: the Big Bank trap).
    visibility: {
      levels: f.key === 'basement' ? [] : f.key === 'ground' ? [FLOOR.basement.id] : [FLOOR.ground.id],
    },
    flags: { [MODULE_ID]: { [LAB_FLAG]: `level:interiors-${f.key}` } },
  }));
  const ground = FLOOR.ground.id;
  const walls = plots.flatMap((p) =>
    (p.walls ?? []).map((w, i) => ({
      ...w,
      levels: [ground],
      flags: { [MODULE_ID]: { [LAB_FLAG]: `wall:${p.code}:${i}` } },
    }))
  );
  const lights = plots.flatMap((p) =>
    (p.lights ?? []).map((l) => ({
      x: l.x,
      y: l.y,
      elevation: 0,
      levels: [ground],
      walls: true,
      vision: false,
      config: l.config,
      flags: { [MODULE_ID]: { [LAB_FLAG]: `light:${p.code}.${l.key}` } },
    }))
  );
  const regions = [
    ...plots.flatMap((p) => p.regions ?? []),
    indoor(
      'basement',
      { x: 0, y: 0, w: INTERIORS_SIZE.w, h: INTERIORS_SIZE.h },
      {
        levels: [FLOOR.basement.id],
        elevation: { bottom: -20, top: 0, topInclusive: false },
        name: 'indoor basement',
      }
    ),
  ];
  return {
    key: 'interiors',
    id: INTERIORS_IDS.scene,
    data: {
      _id: INTERIORS_IDS.scene,
      name: 'Lab · Interiors & Regions',
      width: INTERIORS_SIZE.w,
      height: INTERIORS_SIZE.h,
      padding: PADDING,
      backgroundColor: '#808080',
      grid: { size: GRID, type: 1, distance: 5, units: 'ft' },
      initialLevel: ground,
      levels,
      flags: { [MODULE_ID]: { [LAB_FLAG]: 'scene:interiors', labVersion: version, enabled: true } },
    },
    walls,
    lights,
    regions,
    sceneFlags: { sky: LAB_SKY, wind: LAB_WIND },
  };
}
