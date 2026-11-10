/**
 * tools/lab/river-spec.mjs — Lab · River, as data (water flow family, 2026-11-10).
 *
 * Ingram, 2026-11-10: "focus on improving things like flow around obstacles, river bending and things like that ...
 * an oxbow style lake [that] must touch two edges of the scene ... rocks in the water, areas which are more like
 * rapids with lots of rocks blocking the path of the water ... ponds which are not connected to the river ... If a
 * _Water mask is fully white and touches the edge of the scene we consider that the link to a much larger area of
 * water ... If we have a pond cut off from that then we don't want that to flow in the same way the river does."
 *
 * Plots (scene squares, 150 px; scene 42 x 34 squares, 6300 x 5100):
 *   R   the river: enters across the NORTH edge, a wide horseshoe meander (deep core pushed to the outside of every
 *       bend, shallow point bars inside), a mid-river boulder and a long gravel island, then
 *   RR  the rapids: a narrow, shallow run choked with dry rocks and submerged boulders, opening into
 *   S   the sea: open water filling the whole EAST edge behind a beach (the "much larger area of water")
 *   O   an oxbow lake: the cut-off loop of an old meander, NOT connected
 *   P1  a round pond with a rock island, NOT connected;  P2  a small pond inside the meander's loop;  P3 puddles
 *
 * Coordinates: scene pixels (the builder adds Foundry's padding offset). Pure.
 *
 * @module tools/lab/river-spec
 */
import { GRID, INK, LAB_FLAG, LAB_SKY, LAB_WIND, LAB_VERSION, MODULE_ID, PADDING, paintOps } from './lab-spec.mjs';

const { sq, rect, text } = paintOps;

/** Bumped when the painted river changes, so a browser never shows the old art under a rebuilt scene. */
export const RIVER_REV = 2;
export const RIVER_IDS = Object.freeze({ scene: 'msaLabRiver00000', level: 'msaLabRiverGrnd0' });
export const RIVER_SIZE = Object.freeze({ w: sq(42), h: sq(34) }); // 6300 x 5100

const BLACK = [0, 0, 0, 255];
const WHITE = [255, 255, 255, 255];
const g = (v) => [v, v, v, 255];
const P = (pts) => pts.map(([x, y]) => [sq(x), sq(y)]);

export const COLOURS = Object.freeze({
  ground: [104, 116, 92, 255],
  bank: [172, 154, 116, 255],
  bed: [98, 92, 80, 255],
  gravel: [138, 130, 112, 255],
  rock: [112, 110, 104, 255],
  rockRim: [50, 48, 46, 255],
  boulder: [126, 120, 106, 255],
  sand: [196, 172, 124, 255],
  seaBed: [92, 90, 82, 255],
});

/** The river's centre line (squares) and its width at each point (squares): meander, then the narrow rapids. */
export const RIVER = Object.freeze({
  points: [
    [8, -1.5], [8.3, 3.5], [11.5, 7.6], [16.5, 8.4], [19.6, 11.8], [18.2, 16.2], [12.4, 17.2], [7.4, 19.4],
    [6.2, 24], [9.2, 28], [15, 28.6], [20, 26.6], [23.5, 25.6], [27, 25.3], [30, 25.8], [33, 25.4], [35.6, 25.2],
    [37.6, 25.2],
  ],
  width: [4.2, 4.2, 4.2, 4.2, 4.2, 4.2, 4.2, 4.2, 4.2, 4.2, 4.2, 3.6, 2.8, 2.6, 2.6, 2.8, 4.5, 6],
  bank: 1.1,
  peak: 210,
  core: { width: 1.6, peak: 255, outer: 0.75 },
});
/** The rapids' band (squares): rocks are scattered inside it. */
export const RAPIDS = Object.freeze({ x0: 23.6, x1: 33.2, yC: 25.5, half: 1.15 });

/** The oxbow: the cut-off horseshoe of an old meander (squares), its own still body. */
export const OXBOW = Object.freeze({
  points: [[25, 2.6], [24, 6.2], [25.6, 9.6], [29.4, 10.4], [32.4, 8.2], [32.6, 4.6], [30.6, 2.4]],
  width: 2.8,
  bank: 1.0,
  peak: 190,
  core: { width: 1.2, peak: 230, outer: 0.5 },
});

export const SEA = Object.freeze({ x: sq(34.5), beachW: sq(2.5) });
export const POND = Object.freeze({ cx: sq(29), cy: sq(17), rx: 360, ry: 300, peak: 255, shore: 0.5, wobble: 0.1, seed: 23 });
export const POND_ISLAND = Object.freeze({ cx: sq(29.4), cy: sq(16.7), rx: 70, ry: 55 });
export const LOOP_POND = Object.freeze({ cx: sq(13.5), cy: sq(22.8), rx: 230, ry: 170, peak: 200, shore: 0.6, wobble: 0.2, seed: 29 });
export const PUDDLES = Object.freeze([
  { cx: sq(2.6), cy: sq(9.5), rx: 90, ry: 60, peak: 110, shore: 0.6, wobble: 0.2, seed: 31 },
  { cx: sq(3.6), cy: sq(12.4), rx: 140, ry: 90, peak: 140, shore: 0.5, wobble: 0.25, seed: 37 },
]);

/** Obstacles in the open river: one boulder mid-stream and a long gravel island in the bend. */
export const BOULDER = Object.freeze({ cx: sq(18.9), cy: sq(13.6), rx: 95, ry: 80 });
export const ISLAND = Object.freeze({ cx: sq(10.2), cy: sq(17.7), rx: 210, ry: 70, wobble: 0.12, seed: 41 });

/** Rocks in the rapids: dry rocks (mask 0, hard-ish) and submerged boulders (a soft shallow). Deterministic. */
export function rapidsRocks() {
  let s = 12345;
  const r = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  const dry = [];
  const wet = [];
  for (let i = 0; i < 17; i++) {
    const x = sq(RAPIDS.x0 + (RAPIDS.x1 - RAPIDS.x0) * ((i + r()) / 17));
    const y = sq(RAPIDS.yC + (r() * 2 - 1) * RAPIDS.half);
    const rr = 26 + r() * 46;
    dry.push({ cx: Math.round(x), cy: Math.round(y), rx: Math.round(rr), ry: Math.round(rr * (0.7 + r() * 0.4)), seed: 100 + i });
  }
  for (let i = 0; i < 16; i++) {
    const x = sq(RAPIDS.x0 + (RAPIDS.x1 - RAPIDS.x0) * r());
    const y = sq(RAPIDS.yC + (r() * 2 - 1) * RAPIDS.half * 0.9);
    const rr = 50 + r() * 70;
    wet.push({ cx: Math.round(x), cy: Math.round(y), rx: Math.round(rr), ry: Math.round(rr * 0.8), seed: 200 + i });
  }
  return { dry, wet };
}

/** Views worth a high-resolution look: centre (scene px) and Foundry zoom. */
export const RIVER_VIEWS = Object.freeze({
  overview: { cx: sq(21), cy: sq(17), scale: 0.2 },
  inlet: { cx: sq(9), cy: sq(4), scale: 0.8 },
  bendTop: { cx: sq(16), cy: sq(10), scale: 0.6 },
  boulder: { cx: sq(19), cy: sq(13.6), scale: 1.2 },
  island: { cx: sq(10.5), cy: sq(18), scale: 0.9 },
  loop: { cx: sq(10), cy: sq(23), scale: 0.5 },
  rapids: { cx: sq(28.4), cy: sq(25.5), scale: 0.75 },
  rapidsClose: { cx: sq(27), cy: sq(25.5), scale: 1.5 },
  mouth: { cx: sq(35.5), cy: sq(25.2), scale: 0.8 },
  sea: { cx: sq(38), cy: sq(15), scale: 0.6 },
  oxbow: { cx: sq(28.3), cy: sq(6.4), scale: 0.6 },
  pond: { cx: sq(29), cy: sq(17), scale: 0.9 },
  loopPond: { cx: sq(13.5), cy: sq(22.8), scale: 1.2 },
});

export function riverImages(version = LAB_VERSION) {
  const base = `msa-lab-v${version}-river${RIVER_REV}`;
  const W = RIVER_SIZE;
  const C = COLOURS;
  const art = [{ op: 'fill', rgba: C.ground }];
  const mask = [{ op: 'fill', rgba: BLACK }];
  const labels = [];
  const label = (x, y, s, size = 52) => labels.push(text(sq(x), sq(y), s, size, [INK + 120, INK + 120, INK + 110]));
  // the sea FIRST: a beach ramp, then open water to the east edge (top to bottom). Ramps and rects REPLACE what is
  // under them; the channels after MAX-merge, so the river runs on through the beach into the sea at full depth
  art.push({ op: 'ramp', x: SEA.x, y: 0, w: SEA.beachW, h: W.h, a: C.sand, b: C.seaBed, axis: 'x' });
  art.push(rect({ x: SEA.x + SEA.beachW, y: 0, w: W.w - SEA.x - SEA.beachW, h: W.h }, C.seaBed));
  mask.push({ op: 'ramp', x: SEA.x, y: 0, w: SEA.beachW, h: W.h, a: BLACK, b: WHITE, axis: 'x' });
  mask.push(rect({ x: SEA.x + SEA.beachW, y: 0, w: W.w - SEA.x - SEA.beachW, h: W.h }, WHITE));
  const bodies = [
    { spec: RIVER, coreRgba: C.bed },
    { spec: OXBOW, coreRgba: C.bed },
  ];
  for (const { spec, coreRgba } of bodies) {
    const pts = P(spec.points);
    const width = Array.isArray(spec.width) ? spec.width.map(sq) : sq(spec.width);
    const core = { ...spec.core, width: sq(spec.core.width) };
    art.push({ op: 'channel', points: pts, width, bank: sq(spec.bank), core, rgba: C.bank, coreRgba });
    mask.push({ op: 'channel', points: pts, width, bank: sq(spec.bank), peak: spec.peak, core });
  }
  // ponds and puddles
  art.push({ op: 'ellipse', cx: POND.cx, cy: POND.cy, rx: POND.rx, ry: POND.ry, rgba: C.bank });
  art.push({ op: 'ellipse', cx: POND.cx, cy: POND.cy, rx: POND.rx * 0.6, ry: POND.ry * 0.6, rgba: C.bed });
  mask.push({ op: 'blob', ...POND });
  art.push({ op: 'ellipse', cx: LOOP_POND.cx, cy: LOOP_POND.cy, rx: LOOP_POND.rx, ry: LOOP_POND.ry, rgba: C.bank });
  mask.push({ op: 'blob', ...LOOP_POND });
  for (const p of PUDDLES) mask.push({ op: 'blob', ...p });
  // obstacles: dry rock = mask 0 with a 1-2 px soft edge; art a rimmed grey stone
  // lumpy, not round (Ingram: perfect ellipses read cheap): the same wobble seed shapes the rim, the face and the mask
  const stone = (o) => {
    const wob = o.wobble ?? 0.2;
    const seed = o.seed ?? 7;
    art.push({ op: 'dip', cx: o.cx, cy: o.cy, rx: o.rx + 7, ry: o.ry + 7, shore: 0, wobble: wob, seed, rgba: C.rockRim });
    art.push({ op: 'dip', cx: o.cx, cy: o.cy, rx: o.rx, ry: o.ry, shore: 0.25, wobble: wob, seed, rgba: C.rock });
    art.push({ op: 'dip', cx: o.cx - o.rx * 0.18, cy: o.cy - o.ry * 0.2, rx: o.rx * 0.55, ry: o.ry * 0.5, shore: 0.9, wobble: wob, seed: seed + 1, rgba: [138, 136, 128, 255] });
    mask.push({ op: 'dip', cx: o.cx, cy: o.cy, rx: o.rx + 6, ry: o.ry + 6, floor: 0, shore: 0.1, wobble: wob, seed });
  };
  stone({ ...POND_ISLAND, seed: 3 });
  stone({ ...BOULDER, seed: 5 });
  art.push({ op: 'dip', ...ISLAND, rx: ISLAND.rx + 40, ry: ISLAND.ry + 30, floor: 0, shore: 0.5, rgba: C.gravel });
  mask.push({ op: 'dip', ...ISLAND, rx: ISLAND.rx + 40, ry: ISLAND.ry + 30, floor: 0, shore: 0.45 });
  const rocks = rapidsRocks();
  for (const w of rocks.wet) {
    art.push({ op: 'dip', ...w, floor: 0, shore: 0.9, rgba: C.boulder });
    mask.push({ op: 'dip', ...w, floor: 60, shore: 0.8 });
  }
  for (const d of rocks.dry) stone(d);

  label(1, 0.6, 'Lab · River  —  R river (in across the north edge), RR rapids, S sea (whole east edge), O oxbow, P ponds');
  label(10.5, 2.2, 'R  inlet', 44);
  label(20.6, 14.4, 'boulder', 40);
  label(24, 23.3, 'RR  rapids: dry rocks + submerged boulders', 44);
  label(37, 1.2, 'S  open sea', 44);
  label(25.6, 0.8, 'O  oxbow lake (cut off)', 44);
  label(26.4, 19.6, 'P1  pond + rock island', 40);
  label(11.4, 24.6, 'P2  pond in the loop', 40);
  label(1.4, 14.4, 'P3  puddles', 40);
  art.push(...labels);
  const img = (suffix, mode, ops) => ({ name: `${base}-Ground${suffix}.webp`, role: suffix || 'art', floor: 'river', w: W.w, h: W.h, mode, ops });
  return [img('', 'RGB', art), img('_Water', 'RGB', mask), img('_Outdoors', 'RGB', [{ op: 'fill', rgba: WHITE }])];
}

export function riverScene(assetDir, version = LAB_VERSION) {
  const images = riverImages(version);
  const levelId = RIVER_IDS.level;
  return {
    key: 'river',
    id: RIVER_IDS.scene,
    data: {
      _id: RIVER_IDS.scene,
      name: 'Lab · River',
      width: RIVER_SIZE.w,
      height: RIVER_SIZE.h,
      padding: PADDING,
      backgroundColor: '#68745c',
      grid: { size: GRID, type: 1, distance: 5, units: 'ft' },
      initialLevel: levelId,
      levels: [
        {
          _id: levelId,
          name: 'Ground',
          sort: 0,
          elevation: { bottom: 0, top: 20 },
          background: { src: `${assetDir}/${images[0].name}`, color: '#68745c' },
          visibility: { levels: [] },
          flags: { [MODULE_ID]: { [LAB_FLAG]: 'level:river' } },
        },
      ],
      flags: { [MODULE_ID]: { [LAB_FLAG]: 'scene:river', labVersion: version, enabled: true } },
    },
    sceneFlags: { sky: LAB_SKY, wind: LAB_WIND },
  };
}
