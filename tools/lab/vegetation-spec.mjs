/**
 * tools/lab/vegetation-spec.mjs — Lab · Vegetation, as data (mmp-78u.33).
 *
 * Trees and bushes are the AUTHOR'S OWN ART: crops of her Lone Hill `_Tree` / `_Bush` layers
 * (Wilderness Map Pack), pasted onto the grey lab floor by paint.py's `paste` op. Ingram,
 * 2026-11-09: "Ideally you would use the real trees/bushes cropped from my _Bush and _Tree
 * artwork, that way you have a much better reference than fake trees." Her art never enters
 * this public repo: the spec names her file and a rectangle; the painted set is git-ignored.
 *
 * Sizes measured across her packs (2026-11-09, 15 tree / 16 bush layers): tree canopies have a
 * median diameter of 540-600 px (5.5-6 m at ~98 px/m), bushes 120-230 px; alpha edges are hard
 * (1-5% soft pixels) except Japanese Horror House, Wizard's Lair and Docklands bushes (30-43%).
 *
 * Rows (scene squares, 150 px):
 *   A  sizes     six different trees, 414-712 px, each alone in a 7 x 7 cell (one body each)
 *   B  clones    one tree pasted five times, plus the same stamp mirrored + turned: lockstep test
 *   C  bushes    eight bushes, 82-286 px: leafy sprigs, round shrubs, a spiky plant
 *   D  together  D1 tree against a building (walls + black _Outdoors roof)
 *                D2 darkness Region (DARKEN .5) over a tree + block, reference pair beside it
 *                D3 lamp among a tree, bushes and a free-standing wall
 *                D4 overlapping canopies: two trees touching, a bush under a tree's edge
 *
 * Wind is one value for the whole scene (sceneFlags.wind); the checker steps it calm -> gale.
 *
 * Pure. Coordinates: scene pixels (the builder adds Foundry's padding offset).
 *
 * @module tools/lab/vegetation-spec
 */
import {
  GRID,
  GREY,
  LAB_FLAG,
  LAB_SKY,
  LAB_WIND,
  LAB_VERSION,
  MODULE_ID,
  PADDING,
  SENSE,
  paintOps,
} from './lab-spec.mjs';

const { sq, rect, text } = paintOps;

export const VEG_IDS = Object.freeze({ scene: 'msaLabVegetation', level: 'msaLabVegGround0' });

export const VEG_SIZE = Object.freeze({ w: sq(42), h: sq(30) }); // 6300 x 4500

/** Her source layers, relative to the folder holding `maps/` (lab.mjs --art-root). */
const LONE_HILL = 'maps/Mythica Machina - Wilderness Map Pack/mythica-machina-wilderness-map-pack/assets';
export const ART = Object.freeze({
  tree: `${LONE_HILL}/mythica-machina-lone-hill-ground_Tree.webp`,
  bush: `${LONE_HILL}/mythica-machina-lone-hill-ground_Bush.webp`,
});

/**
 * Plants picked from Lone Hill: isolated components (nothing else within 35% of their size),
 * bounding boxes of alpha > 8. `dia` = equal-area diameter in px. `kind` is what the art shows.
 */
export const PLANTS = Object.freeze({
  t414: { layer: 'tree', sx: 3038, sy: 8313, sw: 425, sh: 437, dia: 414, kind: 'tree' },
  t453: { layer: 'tree', sx: 1178, sy: 2634, sw: 485, sh: 485, dia: 453, kind: 'tree' },
  t503: { layer: 'tree', sx: 9915, sy: 4874, sw: 547, sh: 578, dia: 503, kind: 'tree' },
  t550: { layer: 'tree', sx: 8887, sy: 5876, sw: 578, sh: 609, dia: 550, kind: 'tree' },
  t577: { layer: 'tree', sx: 9409, sy: 1586, sw: 611, sh: 633, dia: 577, kind: 'tree' },
  t712: { layer: 'tree', sx: 2007, sy: 3267, sw: 724, sh: 776, dia: 712, kind: 'tree' },
  b82: { layer: 'bush', sx: 10556, sy: 4989, sw: 80, sh: 112, dia: 82, kind: 'sprig' },
  b102: { layer: 'bush', sx: 2782, sy: 1600, sw: 130, sh: 112, dia: 102, kind: 'sprig' },
  b134: { layer: 'bush', sx: 9602, sy: 6993, sw: 153, sh: 164, dia: 134, kind: 'rosette' },
  b143: { layer: 'bush', sx: 1196, sy: 7780, sw: 147, sh: 158, dia: 143, kind: 'round' },
  b149: { layer: 'bush', sx: 9308, sy: 480, sw: 165, sh: 168, dia: 149, kind: 'round' },
  b167: { layer: 'bush', sx: 438, sy: 3552, sw: 206, sh: 197, dia: 167, kind: 'spiky' },
  b220: { layer: 'bush', sx: 8462, sy: 2174, sw: 281, sh: 291, dia: 220, kind: 'sprig' },
  b286: { layer: 'bush', sx: 9801, sy: 4704, sw: 291, sh: 315, dia: 286, kind: 'round' },
});

const NORMAL = Object.freeze({ move: SENSE.NORMAL, sight: SENSE.NORMAL, light: SENSE.NORMAL, sound: SENSE.NORMAL });
const BLACK = [0, 0, 0, 255];

/** The lab lamp, a little larger than walls-spec's so a whole tree sits in its reach. */
export const VEG_LAMP = Object.freeze({
  dim: 20,
  bright: 6,
  color: '#ffd9a0',
  alpha: 0.5,
  luminosity: 0.5,
  attenuation: 0.5,
});

/**
 * One placed plant: `key` names it for the checker, (cx, cy) is the centre of its box in scene px.
 * `turn` = { flip, rot } for stamped copies (her maps reuse stamps mirrored and turned).
 */
function place(key, plant, cx, cy, turn = {}) {
  const p = PLANTS[plant];
  const rotated = turn.rot === 90 || turn.rot === 270;
  const w = rotated ? p.sh : p.sw;
  const h = rotated ? p.sw : p.sh;
  return {
    key,
    plant,
    layer: p.layer,
    kind: p.kind,
    dia: p.dia,
    cx: Math.round(cx),
    cy: Math.round(cy),
    box: { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h },
    turn,
  };
}

/** Every plant in the scene, row by row. */
export function vegetationPlants() {
  const out = [];
  // A — sizes: six trees, one per 7 x 7 cell
  ['t414', 't453', 't503', 't550', 't577', 't712'].forEach((t, i) => {
    out.push({ ...place(`A${i + 1}`, t, sq(7 * i + 3.5), sq(4.5)), row: 'A' });
  });
  // B — clones: the same 503 px stamp five times, then mirrored + turned 90
  for (let i = 0; i < 5; i++) out.push({ ...place(`B${i + 1}`, 't503', sq(7 * i + 3.5), sq(11.5)), row: 'B' });
  out.push({ ...place('B6', 't503', sq(7 * 5 + 3.5), sq(11.5), { flip: true, rot: 90 }), row: 'B' });
  // C — bushes, smallest to largest, 5.25-square cells
  ['b82', 'b102', 'b134', 'b143', 'b149', 'b167', 'b220', 'b286'].forEach((b, i) => {
    out.push({ ...place(`C${i + 1}`, b, sq(5.25 * i + 2.625), sq(17.5)), row: 'C' });
  });
  // D1 — building 3 x 3 squares at (1.5, 22.5); a tree east whose canopy reaches 0.4 sq over the roof
  out.push({ ...place('D1.tree', 't550', sq(4.5) + sq(1.5), sq(24)), row: 'D' });
  out.push({ ...place('D1.bush', 'b286', sq(3), sq(26.6)), row: 'D' });
  // D2 — Region over the left half (x 10.5..15.75): tree + 1x1 block inside, the same pair outside
  out.push({ ...place('D2.in', 't453', sq(13.6), sq(25.5)), row: 'D' });
  out.push({ ...place('D2.ref', 't453', sq(18.85), sq(25.5)), row: 'D' });
  // D3 — lamp at (26.25, 25.5): tree NE, round bush W, sprig S behind a free-standing wall
  out.push({ ...place('D3.tree', 't414', sq(28.9), sq(23.6)), row: 'D' });
  out.push({ ...place('D3.bushW', 'b143', sq(24.4), sq(25.5)), row: 'D' });
  out.push({ ...place('D3.bushS', 'b220', sq(26.25), sq(28.0)), row: 'D' });
  // D4 — two trees whose canopies overlap ~25%, a bush half under the big one's edge
  out.push({ ...place('D4.big', 't712', sq(34.6), sq(25.2)), row: 'D' });
  out.push({ ...place('D4.small', 't577', sq(38.3), sq(24.3)), row: 'D' });
  out.push({ ...place('D4.bush', 'b220', sq(34.2), sq(27.7)), row: 'D' });
  return out;
}

/** Buildings (black _Outdoors + four walls each). Scene px. */
export const VEG_BLOCKS = Object.freeze([
  { key: 'D1.house', x: sq(1.5), y: sq(22.5), w: sq(3), h: sq(3) },
  { key: 'D2.blockIn', x: sq(11.2), y: sq(22.6), w: sq(1), h: sq(1) },
  { key: 'D2.blockRef', x: sq(16.45), y: sq(22.6), w: sq(1), h: sq(1) },
]);

/** The D2 darkness Region rectangle. */
export const VEG_REGION = Object.freeze({ x: sq(10.5), y: sq(21.5), w: sq(5.25), h: sq(8) });
/** The D3 lamp and its free-standing wall (between the lamp and the south sprig). */
export const VEG_LAMP_AT = Object.freeze({ x: sq(26.25), y: sq(25.5) });
export const VEG_FREE_WALL = Object.freeze({ c: [sq(25.2), sq(26.9), sq(27.3), sq(26.9)] });

function blockWalls(b) {
  return [
    { c: [b.x, b.y, b.x + b.w, b.y], ...NORMAL },
    { c: [b.x + b.w, b.y, b.x + b.w, b.y + b.h], ...NORMAL },
    { c: [b.x + b.w, b.y + b.h, b.x, b.y + b.h], ...NORMAL },
    { c: [b.x, b.y + b.h, b.x, b.y], ...NORMAL },
  ];
}

/**
 * Named probe points per plant: its centre, and ground points 30 px beyond its edge in the four
 * compass directions (where its shadow or its sway can reach). r = half the equal-area diameter.
 */
export function vegetationProbes(plant) {
  const r = plant.dia / 2;
  return [
    { name: `${plant.key}.c`, x: plant.cx, y: plant.cy },
    { name: `${plant.key}.n`, x: plant.cx, y: Math.round(plant.cy - r - 30) },
    { name: `${plant.key}.s`, x: plant.cx, y: Math.round(plant.cy + r + 30) },
    { name: `${plant.key}.e`, x: Math.round(plant.cx + r + 30), y: plant.cy },
    { name: `${plant.key}.w`, x: Math.round(plant.cx - r - 30), y: plant.cy },
  ];
}

const ROW_LABELS = Object.freeze([
  { y: sq(1) - 90, s: 'A sizes: her trees 414 - 712 px, one per cell' },
  { y: sq(8) - 10, s: 'B clones: one stamp x5, then mirrored + turned' },
  { y: sq(15) - 10, s: 'C bushes 82 - 286 px: sprig, rosette, round, spiky' },
  { y: sq(21) - 10, s: 'D1 house   D2 darkness Region | ref   D3 lamp + wall   D4 overlaps' },
]);

export function vegetationImages(version = LAB_VERSION) {
  const base = `msa-lab-v${version}-vegetation`;
  const W = VEG_SIZE;
  const plants = vegetationPlants();
  const paste = (pl) => {
    const p = PLANTS[pl.plant];
    return {
      op: 'paste',
      src: ART[p.layer],
      sx: p.sx,
      sy: p.sy,
      sw: p.sw,
      sh: p.sh,
      x: pl.box.x,
      y: pl.box.y,
      flip: !!pl.turn.flip,
      rot: pl.turn.rot ?? 0,
    };
  };
  const art = [{ op: 'fill', rgba: [GREY, GREY, GREY, 255] }, ...ROW_LABELS.map((l) => text(30, l.y, l.s, 56))];
  for (const pl of plants) art.push(text(pl.box.x, pl.box.y + pl.box.h + 8, pl.key, 34));
  const outdoors = [{ op: 'fill', rgba: [255, 255, 255, 255] }, ...VEG_BLOCKS.map((b) => rect(b, BLACK))];
  // the house roof reads as a roof on the art too (dark grey), so the canopy-over-roof edge is visible
  for (const b of VEG_BLOCKS) art.push(rect(b, [70, 70, 70, 255]));
  const empty = { op: 'fill', rgba: [0, 0, 0, 0] };
  const img = (suffix, mode, ops) => ({
    name: `${base}-Ground${suffix}.webp`,
    role: suffix || 'art',
    floor: 'vegetation',
    w: W.w,
    h: W.h,
    mode,
    ops,
  });
  return [
    img('', 'RGB', art),
    img('_Outdoors', 'RGB', outdoors),
    img('_Tree', 'RGBA', [empty, ...plants.filter((p) => p.layer === 'tree').map(paste)]),
    img('_Bush', 'RGBA', [empty, ...plants.filter((p) => p.layer === 'bush').map(paste)]),
  ];
}

export function vegetationScene(assetDir, version = LAB_VERSION) {
  const images = vegetationImages(version);
  const levelId = VEG_IDS.level;
  const tag = (k) => ({ [MODULE_ID]: { [LAB_FLAG]: k } });
  const walls = [
    ...VEG_BLOCKS.flatMap((b) => blockWalls(b).map((w, i) => ({ ...w, flags: tag(`wall:${b.key}:${i}`) }))),
    { ...VEG_FREE_WALL, ...NORMAL, flags: tag('wall:D3.free') },
  ].map((w) => ({ ...w, levels: [levelId] }));
  const lights = [
    {
      x: VEG_LAMP_AT.x,
      y: VEG_LAMP_AT.y,
      elevation: 0,
      levels: [levelId],
      walls: true,
      vision: false,
      config: VEG_LAMP,
      flags: tag('light:D3.lamp'),
    },
  ];
  const regions = [
    {
      name: 'lab D2 darken .5',
      color: '#4328cc',
      elevation: { bottom: 0, top: 20, topInclusive: false },
      levels: [levelId],
      shapes: [
        { type: 'rectangle', x: VEG_REGION.x, y: VEG_REGION.y, width: VEG_REGION.w, height: VEG_REGION.h, hole: false },
      ],
      behaviors: [{ name: 'Adjust Darkness Level', type: 'adjustDarknessLevel', system: { mode: 2, modifier: 0.5 } }],
      flags: tag('region:D2.dk'),
    },
  ];
  return {
    key: 'vegetation',
    id: VEG_IDS.scene,
    data: {
      _id: VEG_IDS.scene,
      name: 'Lab · Vegetation',
      width: VEG_SIZE.w,
      height: VEG_SIZE.h,
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
          flags: tag('level:vegetation'),
        },
      ],
      flags: { [MODULE_ID]: { [LAB_FLAG]: 'scene:vegetation', labVersion: version, enabled: true } },
    },
    walls,
    lights,
    regions,
    sceneFlags: { sky: LAB_SKY, wind: LAB_WIND },
  };
}
