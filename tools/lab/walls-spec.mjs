/**
 * tools/lab/walls-spec.mjs — Lab · Walls & Windows, as data (mmp-78u.2).
 *
 * Walls break lights more often than anything else (Ingram, 2026-11-08: "Windows, walls,
 * transparent walls, proximity walls — all of these things interact badly with lights and
 * break from time to time"). This scene is a dense grid: one COLUMN per wall type, one ROW
 * per kind of light, so any combination is one cell you can look at.
 *
 * Each wall is built the way the author's maps build one: a normal wall with a two-square
 * FEATURE SEGMENT in the middle (the window, the door, the special type). Window settings
 * are the ones measured in her packs (2026-11-08): the Window preset (move 20, sight/light 30,
 * thresholds 10, attenuation), the 30/30/30 threshold-5 variant, and Mad Scientist's sight-only
 * window (light None).
 *
 * Rows 1-4 sit inside the author's indoor Region (darkness override 0.9 + suppress weather),
 * so the lights read clearly. Rows 5-6 are open (left) | indoors (right) for sunlight and a
 * _Windows pool painted against the wall (soft grey pool, ~60 px edges, like her maps).
 *
 * Pure. Coordinates: scene pixels (the builder adds Foundry's padding offset).
 *
 * @module tools/lab/walls-spec
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

const { sq, rect, text } = paintOps;

export const WALLS_IDS = Object.freeze({ scene: 'msaLabWalls00000', level: 'msaLabWallsGrnd0' });

/** Cell size and label bands, in squares. */
const CELL = 6;
const LABEL_LEFT = 2;
const LABEL_TOP = 1;

const NORMAL = Object.freeze({ move: SENSE.NORMAL, sight: SENSE.NORMAL, light: SENSE.NORMAL, sound: SENSE.NORMAL });
const WINDOW_PRESET = Object.freeze({
  move: SENSE.NORMAL,
  sight: SENSE.PROXIMITY,
  light: SENSE.PROXIMITY,
  sound: SENSE.NORMAL,
  threshold: { light: 10, sight: 10, sound: null, attenuation: true },
});

/** One column per wall type: the middle feature segment's settings (ends are always normal). */
export const WALL_TYPES = Object.freeze([
  { key: 'normal', label: 'normal', seg: NORMAL },
  { key: 'window', label: 'Window preset', seg: WINDOW_PRESET },
  {
    key: 'window5',
    label: 'window 30/30/30 t5',
    seg: {
      move: SENSE.NORMAL,
      sight: SENSE.PROXIMITY,
      light: SENSE.PROXIMITY,
      sound: SENSE.PROXIMITY,
      threshold: { light: 5, sight: 5, sound: 5, attenuation: true },
    },
  },
  {
    key: 'sightOnly',
    label: 'sight Prox, light None',
    seg: { move: SENSE.NORMAL, sight: SENSE.PROXIMITY, light: SENSE.NONE, sound: SENSE.NORMAL },
  },
  { key: 'pattern', label: 'MSA window pattern', seg: WINDOW_PRESET, flags: { windowPattern: true } },
  {
    key: 'invisible',
    label: 'invisible (move only)',
    seg: { move: SENSE.NORMAL, sight: SENSE.NONE, light: SENSE.NONE, sound: SENSE.NONE },
  },
  {
    key: 'terrain',
    label: 'terrain (Limited)',
    seg: { move: SENSE.NORMAL, sight: SENSE.LIMITED, light: SENSE.LIMITED, sound: SENSE.LIMITED },
  },
  {
    key: 'distance',
    label: 'Distance',
    seg: { move: SENSE.NORMAL, sight: SENSE.DISTANCE, light: SENSE.DISTANCE, sound: SENSE.DISTANCE },
  },
  { key: 'oneway', label: 'one-way', seg: { ...NORMAL, dir: 1 } },
  { key: 'doorClosed', label: 'door closed', seg: { ...NORMAL, door: DOOR.DOOR, ds: 0 } },
  { key: 'doorOpen', label: 'door open', seg: { ...NORMAL, door: DOOR.DOOR, ds: 1 } },
  { key: 'secret', label: 'secret door', seg: { ...NORMAL, door: DOOR.SECRET, ds: 0 } },
  {
    key: 'seeDoor',
    label: 'see-through door',
    seg: { move: SENSE.NORMAL, sight: SENSE.NONE, light: SENSE.NONE, sound: SENSE.NORMAL, door: DOOR.DOOR, ds: 0 },
  },
  { key: 'joins', label: 'T-join + pillar', seg: NORMAL, joins: true },
]);

/** One row per kind of light. `indoor` rows sit in the darkness Region; split rows are open | indoor. */
export const LIGHT_KINDS = Object.freeze([
  { key: 'lampNear', label: 'lamp near', layout: 'indoor' },
  { key: 'lampEnd', label: 'lamp at wall end', layout: 'indoor' },
  { key: 'candle', label: 'candle (flame)', layout: 'indoor' },
  { key: 'torch', label: 'token torch', layout: 'indoor' },
  { key: 'pool', label: '_Windows pool, noon', layout: 'split' },
  { key: 'sun', label: 'sun only, noon', layout: 'split' },
]);

export const WALLS_SIZE = Object.freeze({
  w: sq(LABEL_LEFT + CELL * WALL_TYPES.length),
  h: sq(LABEL_TOP + CELL * LIGHT_KINDS.length),
});

/** Bestiary token art (Pathfinder Tokens: Bestiaries, on Oracle and the rigs). */
export const TORCH_TOKEN_ART = 'modules/pf2e-tokens-bestiaries/tokens/humanoid/adlet.webp';

/** A cell's origin and its local geometry (scene px). */
export function wallsCell(col, row) {
  const x = sq(LABEL_LEFT + col * CELL);
  const y = sq(LABEL_TOP + row * CELL);
  const s = sq(CELL); // 900
  const wallX = x + s / 2;
  return {
    x,
    y,
    s,
    wallX,
    wallTop: y + sq(1),
    wallBottom: y + s - sq(1),
    segTop: y + sq(2),
    segBottom: y + s - sq(2),
  };
}

function cellWalls(type, c, tag) {
  const flags = (i) => ({ [MODULE_ID]: { [LAB_FLAG]: `wall:${tag}:${i}`, ...(type.flags ?? {}) } });
  const plain = (i) => ({ [MODULE_ID]: { [LAB_FLAG]: `wall:${tag}:${i}` } });
  const walls = [
    { c: [c.wallX, c.wallTop, c.wallX, c.segTop], ...NORMAL, flags: plain(0) },
    { c: [c.wallX, c.segTop, c.wallX, c.segBottom], ...type.seg, flags: flags(1) },
    { c: [c.wallX, c.segBottom, c.wallX, c.wallBottom], ...NORMAL, flags: plain(2) },
  ];
  if (type.joins) {
    // T-junction: a stub leaving the wall's middle to the right; a pillar (4 short walls) up left.
    const mid = (c.segTop + c.segBottom) / 2;
    walls.push({ c: [c.wallX, mid, c.wallX + sq(1.5), mid], ...NORMAL, flags: plain(3) });
    const px = c.x + sq(1);
    const py = c.y + sq(1.2);
    const w = 60;
    walls.push({ c: [px, py, px + w, py], ...NORMAL, flags: plain(4) });
    walls.push({ c: [px + w, py, px + w, py + w], ...NORMAL, flags: plain(5) });
    walls.push({ c: [px + w, py + w, px, py + w], ...NORMAL, flags: plain(6) });
    walls.push({ c: [px, py + w, px, py], ...NORMAL, flags: plain(7) });
  }
  return walls;
}

const LAMP = Object.freeze({ dim: 12, bright: 4, color: '#ffd9a0', alpha: 0.5, luminosity: 0.5, attenuation: 0.5 });

function cellLights(kind, c, tag, levelId) {
  const base = (x, y, config) => ({
    x: Math.round(x),
    y: Math.round(y),
    elevation: 0,
    levels: [levelId],
    walls: true,
    vision: false,
    config,
    flags: { [MODULE_ID]: { [LAB_FLAG]: `light:${tag}` } },
  });
  const mid = (c.segTop + c.segBottom) / 2;
  if (kind.key === 'lampNear') return [base(c.wallX - sq(0.8), mid, LAMP)];
  if (kind.key === 'lampEnd') return [base(c.wallX - sq(0.4), c.wallTop - sq(0.35), LAMP)];
  if (kind.key === 'candle') {
    return [
      base(c.wallX - sq(0.5), mid, {
        dim: 6,
        bright: 1.5,
        color: '#ff9b40',
        alpha: 0.5,
        luminosity: 0.5,
        attenuation: 0.8,
        animation: { type: 'flame', speed: 5, intensity: 5, reverse: false },
      }),
    ];
  }
  return [];
}

function cellTokens(kind, c, tag, levelId) {
  if (kind.key !== 'torch') return [];
  const mid = (c.segTop + c.segBottom) / 2;
  return [
    {
      name: `torch ${tag}`,
      x: Math.round(c.wallX - sq(1.6)),
      y: Math.round(mid - sq(0.5)),
      width: 1,
      height: 1,
      level: levelId,
      texture: { src: TORCH_TOKEN_ART },
      sight: { enabled: false },
      light: {
        dim: 12,
        bright: 6,
        color: '#ff9b40',
        alpha: 0.5,
        luminosity: 0.5,
        attenuation: 0.6,
        animation: { type: 'torch', speed: 5, intensity: 5 },
      },
      flags: { [MODULE_ID]: { [LAB_FLAG]: `token:${tag}` } },
    },
  ];
}

/** Named probe points for one cell: lit side, behind the feature segment, behind the normal end. */
export function wallsProbes(col, row) {
  const c = wallsCell(col, row);
  const mid = (c.segTop + c.segBottom) / 2;
  return [
    { name: 'litSide', x: c.wallX - sq(0.3), y: mid, expectArt: [GREY, GREY, GREY] },
    { name: 'behindFeature', x: c.wallX + sq(0.4), y: mid, expectArt: [GREY, GREY, GREY] },
    { name: 'behindEnd', x: c.wallX + sq(0.4), y: (c.wallTop + c.segTop) / 2, expectArt: [GREY, GREY, GREY] },
    { name: 'farSide', x: c.wallX + sq(1.5), y: mid, expectArt: [GREY, GREY, GREY] },
  ];
}

export function wallsImages(version = LAB_VERSION) {
  const base = `msa-lab-v${version}-walls`;
  const W = WALLS_SIZE;
  const art = [{ op: 'fill', rgba: [GREY, GREY, GREY, 255] }];
  const outdoors = [{ op: 'fill', rgba: [0, 0, 0, 255] }];
  const windows = [{ op: 'fill', rgba: [0, 0, 0, 255] }];
  WALL_TYPES.forEach((t, col) => {
    const c = wallsCell(col, 0);
    art.push(text(c.x + 20, 30, t.label, 52));
  });
  LIGHT_KINDS.forEach((k, row) => {
    const c = wallsCell(0, row);
    art.push(text(16, c.y + c.s / 2 - 30, k.label, 44));
    if (k.layout === 'split') {
      // open on the left half of every cell in this row
      WALL_TYPES.forEach((_, col) => {
        const cc = wallsCell(col, row);
        outdoors.push(rect({ x: cc.x, y: cc.y, w: cc.s / 2, h: cc.s }, [255, 255, 255, 255]));
        if (k.key === 'pool') {
          // a soft grey daylight pool on the indoor side, against the feature segment
          windows.push(
            rect({ x: cc.wallX, y: cc.segTop, w: sq(2), h: cc.segBottom - cc.segTop }, [220, 220, 220, 255], 60)
          );
        }
      });
    }
  });
  const img = (suffix, ops) => ({
    name: `${base}-Ground${suffix}.webp`,
    role: suffix || 'art',
    floor: 'walls',
    w: W.w,
    h: W.h,
    mode: 'RGB',
    ops,
  });
  return [img('', art), img('_Outdoors', outdoors), img('_Windows', windows)];
}

export function wallsScene(assetDir, version = LAB_VERSION) {
  const images = wallsImages(version);
  const levelId = WALLS_IDS.level;
  const walls = [];
  const lights = [];
  const tokens = [];
  const indoorRects = [];
  WALL_TYPES.forEach((t, col) => {
    LIGHT_KINDS.forEach((k, row) => {
      const c = wallsCell(col, row);
      const tag = `${t.key}/${k.key}`;
      walls.push(...cellWalls(t, c, tag).map((w) => ({ ...w, levels: [levelId] })));
      lights.push(...cellLights(k, c, tag, levelId));
      tokens.push(...cellTokens(k, c, tag, levelId));
      indoorRects.push(
        k.layout === 'indoor' ? { x: c.x, y: c.y, w: c.s, h: c.s } : { x: c.wallX, y: c.y, w: c.s / 2, h: c.s }
      );
    });
  });
  const region = {
    name: 'indoor (walls lab)',
    color: '#4328cc',
    elevation: { bottom: 0, top: 20, topInclusive: false },
    levels: [levelId],
    shapes: indoorRects.map((r) => ({ type: 'rectangle', x: r.x, y: r.y, width: r.w, height: r.h, hole: false })),
    behaviors: [
      { name: 'Adjust Darkness Level', type: 'adjustDarknessLevel', system: { mode: 0, modifier: 0.9 } },
      { name: 'Suppress Weather', type: 'suppressWeather', system: {} },
    ],
    flags: { [MODULE_ID]: { [LAB_FLAG]: 'region:walls-indoor' } },
  };
  return {
    key: 'walls',
    id: WALLS_IDS.scene,
    data: {
      _id: WALLS_IDS.scene,
      name: 'Lab · Walls & Windows',
      width: WALLS_SIZE.w,
      height: WALLS_SIZE.h,
      padding: PADDING,
      backgroundColor: '#808080',
      grid: { size: GRID, type: 1, distance: 5, units: 'ft' },
      initialLevel: levelId,
      levels: [
        {
          _id: levelId,
          name: 'Ground',
          sort: 0,
          elevation: { bottom: 0, top: 20 },
          background: { src: `${assetDir}/${images[0].name}`, color: '#808080' },
          visibility: { levels: [] },
          flags: { [MODULE_ID]: { [LAB_FLAG]: 'level:walls' } },
        },
      ],
      flags: { [MODULE_ID]: { [LAB_FLAG]: 'scene:walls', labVersion: version, enabled: true } },
    },
    walls,
    lights,
    tokens,
    regions: [region],
    sceneFlags: { sky: LAB_SKY, wind: LAB_WIND },
  };
}
