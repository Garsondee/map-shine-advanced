/**
 * tools/lab/lab-spec.mjs — the MSA Lab, as data (mmp-78u).
 *
 * The lab is a folder of plain grey Foundry scenes, each built to catch one kind of
 * breakage. EVERYTHING about them comes from this file: the floor art and masks the
 * painter (paint.py) draws, and the Foundry documents the builder (build-in-foundry.js)
 * creates. Edit this file and rebuild; never hand-edit a lab scene in Foundry, because
 * the next rebuild replaces it.
 *
 * Pure: plain objects out, no IO, Node-tested (lab-spec.test.mjs).
 *
 * UNITS. Plots are laid out in grid SQUARES of the scene (150 px, like the author's
 * maps). Paint ops are in PIXELS of the floor image, which is exactly the scene's size
 * (a mask is stretched over its art, and the author keeps them the same size). Wall and
 * light coordinates are in SCENE pixels; the builder adds Foundry's padding offset.
 *
 * MIMICRY. Mask conventions copy the author's modern maps (Speakeasy, Docklands,
 * Wizard's Lair, Mad Scientist's Compound, Town River Bridge, Church of the Light),
 * measured 2026-11-08: _Outdoors hard 0-1 px edges (Wizard's Lair 10 px), basements all
 * black, upper-floor masks share the floor's holes, everything lossy WebP at art size.
 *
 * @module tools/lab/lab-spec
 */

export const LAB_VERSION = 1;
export const MODULE_ID = 'map-shine-advanced';
/** Every lab document carries flags[MODULE_ID].lab = <key>; the builder only touches those. */
export const LAB_FLAG = 'lab';

/** The neutral floor: sRGB 128 (linear ~0.216), the same grey as the old test floor. */
export const GREY = 128;
/** Plot labels and glyphs: darker grey, only ever printed in gutters. */
export const INK = 92;

export const GRID = 150;
export const PADDING = 0.25;

/** Plot lattice: a cell is 10 x 10 squares; its outer square is the gutter. */
export const CELL_SQ = 10;
export const GUTTER_SQ = 1;

export const FOLDER_NAME = 'MSA Lab';

/** Fixed 16-character ids so walls/lights can name their Level and rebuilds keep ids. */
export const IDS = Object.freeze({
  effectsScene: 'msaLabEffects000',
  levelBasement: 'msaLabBasement00',
  levelGround: 'msaLabGround0000',
  levelUpper: 'msaLabUpper00000',
});

/**
 * The lab's sky (MSA scene flag `sky`, shape as MSA itself writes it): noon, clear, no rain,
 * no fog, clock stopped (rateHoursPerMinute 0) so pictures taken minutes apart compare.
 */
export const LAB_SKY = Object.freeze({
  mode: 'aesthetic',
  todHour: 12,
  rateHoursPerMinute: 0,
  cloudCover01: 0,
  weatherArchetype: 'custom',
  weatherMode: 'director',
  weatherBiome: 'continental-plains',
  weatherVolatility: 0,
  precip01: 0,
  temperature01: 0.45,
  fogDensity01: 0,
  lightning01: 0,
  precipKindAuthored: 'auto',
  realism01: 1,
  goldenHour01: 1,
  moonlight01: 1,
  gradeEnvStrength: 0,
  latitudeDeg: 30,
});
/** Calm air: wind changes vegetation, smoke, rain angle; the lab sets it per test. */
export const LAB_WIND = Object.freeze({ directionDeg: 90, speed01: 0 });

/** Foundry v14 wall sense values. */
export const SENSE = Object.freeze({ NONE: 0, LIMITED: 10, NORMAL: 20, PROXIMITY: 30, DISTANCE: 40 });
export const DOOR = Object.freeze({ NONE: 0, DOOR: 1, SECRET: 2 });

const sq = (n) => n * GRID;

/** Pixel rectangle of a plot cell, and of its test area (inside the gutter). */
export function cellRect(col, row) {
  const x = sq(col * CELL_SQ);
  const y = sq(row * CELL_SQ);
  const w = sq(CELL_SQ);
  return {
    x,
    y,
    w,
    h: w,
    area: { x: x + sq(GUTTER_SQ), y: y + sq(GUTTER_SQ), w: w - 2 * sq(GUTTER_SQ), h: w - 2 * sq(GUTTER_SQ) },
  };
}

// ---------------------------------------------------------------------------------------
// Paint ops (consumed by paint.py). Colours are [r,g,b] or [r,g,b,a] bytes.
// ---------------------------------------------------------------------------------------
const rect = (r, rgba, feather = 0) => ({ op: 'rect', x: r.x, y: r.y, w: r.w, h: r.h, rgba, feather });
const clear = (r) => ({ op: 'clear', x: r.x, y: r.y, w: r.w, h: r.h });
const text = (x, y, s, size = 64, rgba = [INK, INK, INK]) => ({ op: 'text', x, y, text: s, size, rgba });
const checker = (r, cell, a, b) => ({ op: 'checker', x: r.x, y: r.y, w: r.w, h: r.h, cell, a, b });
/** Paint-op helpers, shared with the other scene specs (walls-spec.mjs). */
export const paintOps = Object.freeze({ sq, rect, clear, text, checker });

/**
 * An "indoors" Region exactly as the author's modern maps make one (Docklands, 2026-11-08):
 * Adjust Darkness Level in OVERRIDE mode at 0.9, plus Suppress Weather. Interiors and
 * basements get one; MSA itself does not darken a black-_Outdoors area at noon (mmp bead).
 */
export function indoorRegion(key, rectPx, floor, name) {
  return {
    name: name ?? `indoor ${key}`,
    color: '#4328cc',
    elevation: { bottom: floor.bottom, top: floor.top, topInclusive: false },
    levels: [floor.id],
    shapes: [{ type: 'rectangle', x: rectPx.x, y: rectPx.y, width: rectPx.w, height: rectPx.h, hole: false }],
    behaviors: [
      { name: 'Adjust Darkness Level', type: 'adjustDarknessLevel', system: { mode: 0, modifier: 0.9 } },
      { name: 'Suppress Weather', type: 'suppressWeather', system: {} },
    ],
    flags: { [MODULE_ID]: { [LAB_FLAG]: `region:${key}` } },
  };
}

/** The floors of Lab · Effects, bottom first (Speakeasy/Church/Big Bank conventions). */
export const EFFECTS_FLOORS = Object.freeze([
  Object.freeze({ key: 'basement', letter: 'B', name: 'Basement', id: IDS.levelBasement, bottom: -20, top: 0 }),
  Object.freeze({ key: 'ground', letter: 'G', name: 'Ground', id: IDS.levelGround, bottom: 0, top: 20 }),
  Object.freeze({ key: 'upper', letter: 'U', name: 'Upper', id: IDS.levelUpper, bottom: 20, top: 40 }),
]);

export const EFFECTS_SIZE = Object.freeze({ w: 9000, h: 6750 }); // 60 x 45 squares

/** Ground-floor stairwell into the basement (Big Bank keeps one hole like this). */
export const STAIRWELL = Object.freeze({ x: sq(2), y: sq(41), w: sq(4), h: sq(2) });

/**
 * The plots. Each says which floor/cell it occupies and what it adds, per floor:
 * art ops, _Outdoors ops, walls. Round 1 = the controls row.
 */
export function effectsPlots() {
  const plots = [];

  // C1 — calibration wedge: 9 grey steps and 6 colour chips, everything else floor grey.
  {
    const c = cellRect(0, 0);
    const steps = [0, 32, 64, 96, 128, 160, 192, 224, 255];
    const sw = Math.floor(c.area.w / steps.length);
    const art = steps.map((v, i) => rect({ x: c.area.x + i * sw, y: c.area.y + sq(1), w: sw, h: sq(2) }, [v, v, v]));
    const chips = [
      [200, 40, 40],
      [40, 180, 60],
      [40, 70, 200],
      [40, 190, 200],
      [200, 50, 190],
      [230, 210, 50],
    ];
    const cw = Math.floor(c.area.w / chips.length);
    chips.forEach((rgb, i) => art.push(rect({ x: c.area.x + i * cw, y: c.area.y + sq(5), w: cw, h: sq(2) }, rgb)));
    plots.push({ code: 'C1', title: 'calibration', floor: 'ground', col: 0, row: 0, art, outdoors: [] });
  }

  // C2 — empty open plot: nothing at all. Any change here is a global effect leaking.
  plots.push({ code: 'C2', title: 'empty open', floor: 'ground', col: 1, row: 0, art: [], outdoors: [] });

  // C3 — empty room: black _Outdoors, four normal walls with a closed door; a slab on the
  // upper floor sits above it, the way a real upstairs room covers a downstairs one.
  {
    const c = cellRect(2, 0);
    const a = c.area;
    const doorW = sq(1);
    const midX = a.x + a.w / 2;
    const normal = { move: SENSE.NORMAL, sight: SENSE.NORMAL, light: SENSE.NORMAL, sound: SENSE.NORMAL };
    const walls = [
      { c: [a.x, a.y, a.x + a.w, a.y], ...normal },
      { c: [a.x + a.w, a.y, a.x + a.w, a.y + a.h], ...normal },
      { c: [a.x, a.y + a.h, a.x, a.y], ...normal },
      { c: [a.x + a.w, a.y + a.h, midX + doorW / 2, a.y + a.h], ...normal },
      { c: [midX - doorW / 2, a.y + a.h, a.x, a.y + a.h], ...normal },
      { c: [midX + doorW / 2, a.y + a.h, midX - doorW / 2, a.y + a.h], ...normal, door: DOOR.DOOR, ds: 0 },
    ];
    plots.push({
      code: 'C3',
      title: 'empty room',
      floor: 'ground',
      col: 2,
      row: 0,
      art: [],
      outdoors: [rect(a, [0, 0, 0])],
      walls,
      upperSlab: { x: c.x, y: c.y, w: c.w, h: c.h },
      regions: [{ key: 'C3', rect: a }],
    });
  }

  // C4 — distortion witness: a 118/138 checker (averages 128) and a 1 px line ladder.
  {
    const c = cellRect(3, 0);
    const a = c.area;
    const art = [checker({ x: a.x + sq(1), y: a.y + sq(1), w: sq(4), h: sq(4) }, 15, [118, 118, 118], [138, 138, 138])];
    for (let i = 0; i < 8; i++) {
      const w = 1 + i; // 1..8 px lines
      art.push(rect({ x: a.x + sq(6) + i * 24, y: a.y + sq(1), w, h: sq(4) }, [64, 64, 64]));
    }
    plots.push({ code: 'C4', title: 'distortion witness', floor: 'ground', col: 3, row: 0, art, outdoors: [] });
  }

  // C5 — indoor/outdoor edges: left half hard black (0 px, Speakeasy/Church), a 10 px soft
  // building on the right (Wizard's Lair). The art stays grey: only the mask changes.
  {
    const c = cellRect(4, 0);
    const a = c.area;
    plots.push({
      code: 'C5',
      title: 'outdoor edges',
      floor: 'ground',
      col: 4,
      row: 0,
      art: [],
      outdoors: [
        rect({ x: a.x, y: a.y, w: a.w / 2, h: a.h }, [0, 0, 0]),
        rect({ x: a.x + a.w / 2 + sq(1), y: a.y + sq(2), w: sq(2), h: sq(4) }, [0, 0, 0], 10),
      ],
    });
  }

  // C6 — scene corner: an empty plot whose top and right edges are the scene's edges
  // (0.25 padding beyond). Edge bugs (clipping, table, bands) show here first.
  plots.push({ code: 'C6', title: 'scene corner', floor: 'ground', col: 5, row: 0, art: [], outdoors: [] });

  return plots;
}

/**
 * Named probe points for a plot, in SCENE pixels. Every plot gets `centre` (middle of its test
 * area) and `ring` (its untouched grey gutter, mid left side); some add their own.
 * `expectArt` is the floor-art value painted at that point (what the albedo buffer should read).
 */
export function plotProbes(plot) {
  const c = cellRect(plot.col, plot.row);
  const a = c.area;
  const pts = [
    { name: 'centre', x: a.x + a.w / 2, y: a.y + a.h / 2, expectArt: [GREY, GREY, GREY] },
    { name: 'ring', x: c.x + sq(GUTTER_SQ) / 2, y: c.y + c.h / 2, expectArt: [GREY, GREY, GREY] },
  ];
  if (plot.code === 'C1') {
    const steps = [0, 32, 64, 96, 128, 160, 192, 224, 255];
    const sw = Math.floor(a.w / steps.length);
    steps.forEach((v, i) =>
      pts.push({ name: `step${v}`, x: a.x + i * sw + sw / 2, y: a.y + sq(2), expectArt: [v, v, v] })
    );
  }
  if (plot.code === 'C5') {
    pts.push({ name: 'indoorHard', x: a.x + a.w / 4, y: a.y + a.h / 2, expectArt: [GREY, GREY, GREY] });
    pts.push({ name: 'indoorSoft', x: a.x + a.w / 2 + sq(2), y: a.y + sq(4), expectArt: [GREY, GREY, GREY] });
    pts.push({ name: 'open', x: a.x + a.w - sq(1), y: a.y + a.h - sq(1), expectArt: [GREY, GREY, GREY] });
  }
  return pts;
}

/** Corner glyph squares: each floor prints its letter in all four scene corners. */
function floorGlyphs(floor, size) {
  const s = sq(1);
  const corners = [
    [0, 0],
    [size.w - s, 0],
    [0, size.h - s],
    [size.w - s, size.h - s],
  ];
  return corners.flatMap(([x, y]) => [
    rect({ x, y, w: s, h: s }, [INK, INK, INK, 255]),
    text(x + 40, y + 22, floor.letter, 96, [GREY, GREY, GREY, 255]),
  ]);
}

/**
 * Everything the painter draws for Lab · Effects: one art image and one _Outdoors mask
 * per floor, named <base>-<Floor>.webp / <base>-<Floor>_Outdoors.webp so MSA's discovery
 * finds them beside the art.
 */
export function effectsImages(version = LAB_VERSION) {
  const size = EFFECTS_SIZE;
  const plots = effectsPlots();
  const base = `msa-lab-v${version}-effects`;
  const images = [];
  for (const floor of EFFECTS_FLOORS) {
    const mine = plots.filter((p) => p.floor === floor.key);
    const labels = plots.map((p) => {
      const c = cellRect(p.col, p.row);
      return text(c.x + 170, c.y + 30, `${floor.letter} ${p.code} ${p.title}`, 64);
    });
    let art;
    let outdoors;
    if (floor.key === 'ground') {
      art = [{ op: 'fill', rgba: [GREY, GREY, GREY, 255] }, ...mine.flatMap((p) => p.art), ...labels, clear(STAIRWELL)];
      outdoors = [{ op: 'fill', rgba: [255, 255, 255, 255] }, ...mine.flatMap((p) => p.outdoors), clear(STAIRWELL)];
    } else if (floor.key === 'basement') {
      // A real cellar: grey floor, all-black _Outdoors (the author's underground rule).
      art = [{ op: 'fill', rgba: [GREY, GREY, GREY, 255] }, ...labels];
      outdoors = [{ op: 'fill', rgba: [0, 0, 0, 255] }];
    } else {
      // Upper: transparent except slabs over chosen plots; the mask shares the holes.
      const slabs = plots.filter((p) => p.upperSlab).map((p) => p.upperSlab);
      art = [{ op: 'fill', rgba: [0, 0, 0, 0] }];
      outdoors = [{ op: 'fill', rgba: [0, 0, 0, 0] }];
      for (const s of slabs) {
        art.push(rect(s, [GREY, GREY, GREY, 255]));
        art.push(text(s.x + 170, s.y + 30, 'U slab', 64, [INK, INK, INK, 255]));
        outdoors.push(rect(s, [0, 0, 0, 255]));
      }
    }
    art.push(...floorGlyphs(floor, size));
    if (floor.key === 'upper') {
      // the glyph squares are opaque upper floor too, so their mask must cover them
      for (const g of floorGlyphs(floor, size)) if (g.op === 'rect') outdoors.push({ ...g, rgba: [0, 0, 0, 255] });
    }
    const transparent = floor.key === 'upper' || floor.key === 'ground';
    images.push({
      name: `${base}-${floor.name}.webp`,
      role: 'art',
      floor: floor.key,
      w: size.w,
      h: size.h,
      mode: transparent ? 'RGBA' : 'RGB',
      ops: art,
    });
    images.push({
      name: `${base}-${floor.name}_Outdoors.webp`,
      role: '_Outdoors',
      floor: floor.key,
      w: size.w,
      h: size.h,
      mode: transparent ? 'RGBA' : 'RGB',
      ops: outdoors,
    });
  }
  return images;
}

/**
 * The Foundry side of Lab · Effects: the scene, its Levels and its walls. `assetDir` is the
 * folder the images live in, as Foundry sees it (e.g. 'assets/msa-lab/v1').
 */
export function effectsScene(assetDir, version = LAB_VERSION) {
  const images = effectsImages(version);
  const artOf = (floorKey) => `${assetDir}/${images.find((i) => i.floor === floorKey && i.role === 'art').name}`;
  const levels = EFFECTS_FLOORS.map((f, i) => ({
    _id: f.id,
    name: f.name,
    sort: i * 100,
    elevation: { bottom: f.bottom, top: f.top },
    background: { src: artOf(f.key), color: '#808080' },
    // Who you can see through this floor's holes. Ground looks DOWN into the basement through
    // the stairwell; Upper looks down onto Ground through its holes. The basement lists
    // nothing: listing the solid floor ABOVE makes it cover you (Foundry core does the same;
    // the Big Bank trap, memory level-visibility-upper-floor-covers). Church/Speakeasy style.
    visibility: {
      levels: f.key === 'basement' ? [] : f.key === 'ground' ? [IDS.levelBasement] : [IDS.levelGround],
    },
    flags: { [MODULE_ID]: { [LAB_FLAG]: `level:${f.key}` } },
  }));
  const walls = effectsPlots().flatMap((p) =>
    (p.walls ?? []).map((w, i) => ({
      ...w,
      levels: [EFFECTS_FLOORS.find((f) => f.key === p.floor).id],
      flags: { [MODULE_ID]: { [LAB_FLAG]: `wall:${p.code}:${i}` } },
    }))
  );
  const floorOf = (k) => EFFECTS_FLOORS.find((f) => f.key === k);
  const regions = [
    ...effectsPlots().flatMap((p) => (p.regions ?? []).map((r) => indoorRegion(r.key, r.rect, floorOf(p.floor)))),
    indoorRegion(
      'basement',
      { x: 0, y: 0, w: EFFECTS_SIZE.w, h: EFFECTS_SIZE.h },
      floorOf('basement'),
      'indoor basement'
    ),
  ];
  return {
    key: 'effects',
    id: IDS.effectsScene,
    activate: true,
    data: {
      _id: IDS.effectsScene,
      name: 'Lab · Effects',
      width: EFFECTS_SIZE.w,
      height: EFFECTS_SIZE.h,
      padding: PADDING,
      backgroundColor: '#808080',
      grid: { size: GRID, type: 1, distance: 5, units: 'ft' },
      initialLevel: IDS.levelGround,
      levels,
      flags: { [MODULE_ID]: { [LAB_FLAG]: 'scene:effects', labVersion: version, enabled: true } },
    },
    walls,
    regions,
    // The lab's own sky, so every rebuild starts identical: noon, clear, calm, clock stopped.
    sceneFlags: { sky: LAB_SKY, wind: LAB_WIND },
  };
}

/** The whole manifest the builder consumes. */
export function labManifest({ assetDir, version = LAB_VERSION } = {}) {
  if (!assetDir) throw new Error('labManifest needs assetDir');
  return {
    version,
    moduleId: MODULE_ID,
    flag: LAB_FLAG,
    folder: { name: FOLDER_NAME, type: 'Scene', color: '#808080', flags: { [MODULE_ID]: { [LAB_FLAG]: 'folder' } } },
    scenes: [effectsScene(assetDir, version)],
  };
}

/** Everything the painter needs. */
export function labPaintJob(version = LAB_VERSION) {
  return { version, images: effectsImages(version) };
}
