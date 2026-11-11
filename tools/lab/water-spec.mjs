/**
 * tools/lab/water-spec.mjs — Lab · Water, as data (mmp-78u water family, 2026-11-09).
 *
 * Ingram, 2026-11-09: "the black edge of the water comes up to the edge of the boats in the
 * Docklands map, but the water gets a transparent transition zone which makes the water look clear
 * in a ring around boats which is nonsense ... we can use the brightness of the _Water mask to
 * understand the approximate depth ... a neutral, good starting point visual approximation of what
 * a body of water from a puddle to a raging deep sea would look like if viewed directly from above."
 *
 * One water look per scene (water params are per scene), so every body here is judged under the
 * SAME shipped defaults; the bodies differ only by what a map author controls: the mask's
 * brightness (depth), its edge (hard hull/quay vs sloping bank), the body's size, and the bed art.
 *
 * Plots (scene squares, 150 px; scene 42 x 34 squares):
 *   A   depth ladder  _Water steps 32..255 over a grey checker + colour swatches, then a 0 -> 255 ramp
 *   B1  hard edges    a uniform-bed dock pool: two hulls, a pier, piles, a straight quay edge
 *   B2  Docklands     two crops of her real Docklands art with the matching crops of her _Water mask
 *   C1  puddles       five soft-edged puddles on cobble-checker ground, peak mask 70..210
 *   C2  pond          a dome-shaped pond with a wide natural bank (mask rises over 55% of the radius)
 *   C3  sea           a beach ramp into open sea to the scene edge, a hard rock island and a jetty
 *
 * Coordinates: scene pixels (the builder adds Foundry's padding offset). Pure.
 *
 * @module tools/lab/water-spec
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
  paintOps,
} from './lab-spec.mjs';

const { sq, rect, text, checker } = paintOps;

export const WATER_IDS = Object.freeze({ scene: 'msaLabWater00000', level: 'msaLabWaterGrnd0' });
export const WATER_SIZE = Object.freeze({ w: sq(42), h: sq(34) }); // 6300 x 5100

/** Her Docklands Warehouse ground art and _Water mask, relative to the folder holding `maps/`. */
const DOCK = 'maps/Mythica Machina - Docklands Warehouse/mythica-machina-docklands-warehouse/assets';
export const DOCK_ART = Object.freeze({
  art: `${DOCK}/mythica-machina-docklands-warehouse-Ground.webp`,
  water: `${DOCK}/mythica-machina-docklands-warehouse-Ground_Water.webp`,
});
/** Two 2400 x 750 strips of her harbour: east (rowing boats, piers) and west (the sailing boat). */
export const DOCK_CROPS = Object.freeze([
  { key: 'east', sx: 3300, sy: 6000, sw: 2400, sh: 750, x: sq(21.5), y: sq(10.5) },
  { key: 'west', sx: 900, sy: 6000, sw: 2400, sh: 750, x: sq(21.5), y: sq(16) },
]);

const BLACK = [0, 0, 0, 255];
const WHITE = [255, 255, 255, 255];
const g = (v) => [v, v, v, 255];

/** Bed colours: a sandy-mud floor, and swatches whose loss under water shows absorption per channel. */
export const BED = Object.freeze({
  mud: [138, 118, 88, 255],
  sand: [196, 172, 124, 255],
  rock: [72, 72, 68, 255],
  checkA: [92, 92, 92, 255],
  checkB: [164, 164, 164, 255],
});
export const SWATCHES = Object.freeze([
  ['red', [176, 64, 52, 255]],
  ['green', [70, 140, 72, 255]],
  ['blue', [58, 92, 170, 255]],
  ['white', [235, 235, 230, 255]],
  ['black', [28, 28, 28, 255]],
  ['sand', [196, 170, 120, 255]],
]);

/** Plot A — mask values of the eight steps. */
export const STEP_VALUES = Object.freeze([32, 64, 96, 128, 160, 192, 224, 255]);
const A = Object.freeze({ x: sq(1.5), w: sq(39), stepY: sq(1.5), stepH: sq(4), rampY: sq(6), rampH: sq(2.5) });
const STEP_W = A.w / STEP_VALUES.length;

/** Plot B1 — the dock pool and what stands in it (mask black, art painted). */
export const B1 = Object.freeze({
  pool: { x: sq(1.5), y: sq(10.5), w: sq(18), h: sq(10) },
  boatH: { cx: sq(5.5), cy: sq(13.5), rx: 260, ry: 95 },
  boatV: { cx: sq(11), cy: sq(16), rx: 80, ry: 230 },
  pier: { x: sq(14), y: sq(10.5), w: sq(1), h: sq(4.5) },
  piles: [16, 17, 18].map((i) => ({ cx: sq(i), cy: sq(18.5), r: 24 })),
});

/** Plot C1 — puddles: {cx, cy, rx, ry, peak, shore, wobble}. */
export const PUDDLES = Object.freeze([
  { key: 'p70', cx: sq(2.5), cy: sq(24.5), rx: 45, ry: 32, peak: 70, shore: 0.6, wobble: 0.15, seed: 3 },
  { key: 'p100', cx: sq(5), cy: sq(24.6), rx: 95, ry: 62, peak: 100, shore: 0.5, wobble: 0.2, seed: 5 },
  { key: 'p130', cx: sq(8.2), cy: sq(25), rx: 165, ry: 112, peak: 130, shore: 0.45, wobble: 0.25, seed: 7 },
  { key: 'p170', cx: sq(3.4), cy: sq(29), rx: 225, ry: 150, peak: 170, shore: 0.4, wobble: 0.3, seed: 11 },
  { key: 'p210', cx: sq(7.6), cy: sq(30), rx: 265, ry: 190, peak: 210, shore: 0.35, wobble: 0.3, seed: 13 },
]);
export const POND = Object.freeze({ cx: sq(16.25), cy: sq(28.5), rx: 640, ry: 560, peak: 255, shore: 0.55 });
export const SEA = Object.freeze({
  x: sq(22),
  y: sq(22.5),
  w: sq(20),
  h: sq(11.5),
  beachW: sq(4.5),
  rock: { cx: sq(33), cy: sq(27.5), rx: 210, ry: 150 },
  jetty: { x: sq(37.5), y: sq(22.5), w: sq(1), h: sq(4) },
});

/** Named probe points, by plot. */
export function waterProbes() {
  const pts = [];
  // A: each step's centre on a light and a dark checker cell, and on each swatch of its row.
  STEP_VALUES.forEach((v, i) => {
    const x0 = A.x + i * STEP_W;
    // 75 px cells from A.x: pick the cell centres nearest the step centre
    const cx = Math.round((x0 + STEP_W / 2 - A.x) / 75) * 75 + A.x + 37;
    pts.push({ plot: 'A', name: `A.s${v}.c1`, x: cx, y: A.stepY + 37 + 75, mask: v });
    pts.push({ plot: 'A', name: `A.s${v}.c2`, x: cx + 75, y: A.stepY + 37 + 75, mask: v });
    // swatch cells run continuously from A.x (0.75 sq each, colours cycling): probe the first cell
    // of each colour lying fully inside this step
    const sw = sq(0.75);
    const seen = new Set();
    for (let k = 0; A.x + (k + 1) * sw <= A.x + A.w; k++) {
      const cxk = A.x + (k + 0.5) * sw;
      if (cxk < x0 + sw / 2 || cxk > x0 + STEP_W - sw / 2) continue;
      const n = SWATCHES[k % SWATCHES.length][0];
      if (seen.has(n)) continue;
      seen.add(n);
      pts.push({ plot: 'A', name: `A.s${v}.${n}`, x: Math.round(cxk), y: sq(5), mask: v });
    }
  });
  // B1: transects from each hard edge out into open water (a clear ring shows as a rise near 0).
  const D = [4, 8, 16, 24, 32, 48, 64, 96, 128, 192, 256];
  const bh = B1.boatH;
  for (const d of D) pts.push({ plot: 'B1', name: `B1.hullE.${d}`, x: bh.cx + bh.rx + d, y: bh.cy, d });
  const bv = B1.boatV;
  for (const d of D) pts.push({ plot: 'B1', name: `B1.hullS.${d}`, x: bv.cx, y: bv.cy + bv.ry + d, d });
  const pr = B1.pier;
  for (const d of D) pts.push({ plot: 'B1', name: `B1.pierE.${d}`, x: pr.x + pr.w + d, y: pr.y + sq(2.5), d });
  const pl = B1.pool;
  for (const d of D) pts.push({ plot: 'B1', name: `B1.quay.${d}`, x: pl.x + sq(2), y: pl.y + d, d });
  pts.push({ plot: 'B1', name: 'B1.open', x: sq(7.5), y: sq(18.5), d: 999 });
  // C1/C2/C3: puddle centres, the pond from bank to middle, the sea from the beach out.
  for (const p of PUDDLES) pts.push({ plot: 'C1', name: `C1.${p.key}`, x: p.cx, y: p.cy, mask: p.peak });
  for (const f of [0.95, 0.8, 0.65, 0.5, 0.3, 0])
    pts.push({ plot: 'C2', name: `C2.r${Math.round(f * 100)}`, x: Math.round(POND.cx + f * POND.rx), y: POND.cy });
  for (const dx of [0.5, 1.5, 2.5, 3.5, 4.5, 6, 9, 12, 16])
    pts.push({ plot: 'C3', name: `C3.x${dx}`, x: SEA.x + sq(dx), y: SEA.y + sq(9.5) });
  const rk = SEA.rock;
  for (const d of D) pts.push({ plot: 'C3', name: `C3.rockE.${d}`, x: rk.cx + rk.rx + d, y: rk.cy, d });
  return pts;
}

/** Views worth a high-resolution look: centre (scene px) and Foundry zoom. */
export const WATER_VIEWS = Object.freeze({
  overview: { cx: sq(21), cy: sq(17), scale: 0.2 },
  A: { cx: sq(21), cy: sq(5), scale: 0.36 },
  Aleft: { cx: sq(9), cy: sq(5), scale: 0.75 },
  Aright: { cx: sq(32), cy: sq(5), scale: 0.75 },
  B1: { cx: sq(10.5), cy: sq(15.5), scale: 0.62 },
  B1hull: { cx: sq(6.5), cy: sq(14), scale: 1.6 },
  // corners (Ingram 2026-11-09: "look at the inner and outer corners"): the pool's top-left inner corner, the pier's
  // nose (two outer corners) and the pier root (two inner corners against the quay)
  B1cornerIn: { cx: sq(2.6), cy: sq(11.6), scale: 2.4 },
  B1pierNose: { cx: sq(14.5), cy: sq(15.4), scale: 2.4 },
  B1pierRoot: { cx: sq(14.5), cy: sq(11.4), scale: 2.4 },
  B2west: { cx: sq(29), cy: sq(18.3), scale: 1.25 },
  B2: { cx: sq(29.5), cy: sq(15.8), scale: 0.62 },
  B2east: { cx: sq(30.5), cy: sq(13), scale: 1.25 },
  B2boats: { cx: sq(34.2), cy: sq(13.2), scale: 2.2 },
  C1: { cx: sq(5.5), cy: sq(27.5), scale: 0.85 },
  C2: { cx: sq(16.25), cy: sq(28.3), scale: 0.85 },
  C3: { cx: sq(32), cy: sq(28), scale: 0.45 },
  C3beach: { cx: sq(25.5), cy: sq(28), scale: 1.0 },
});

export function waterImages(version = LAB_VERSION) {
  const base = `msa-lab-v${version}-water`;
  const W = WATER_SIZE;
  const art = [{ op: 'fill', rgba: g(GREY) }];
  const mask = [{ op: 'fill', rgba: BLACK }];
  const labels = [];
  const label = (x, y, s, size = 56) => labels.push(text(x, y, s, size, [INK, INK, INK]));

  // ── A: depth ladder ──────────────────────────────────────────────────────────────
  art.push(checker({ x: A.x, y: A.stepY, w: A.w, h: sq(3) }, 75, BED.checkA, BED.checkB));
  art.push(checker({ x: A.x, y: A.rampY, w: A.w, h: sq(1.5) }, 75, BED.checkA, BED.checkB));
  STEP_VALUES.forEach((v, i) => {
    const x0 = A.x + i * STEP_W;
    mask.push(rect({ x: x0, y: A.stepY, w: STEP_W, h: A.stepH }, g(v)));
    label(x0 + 20, A.stepY + A.stepH + 8, `mask ${v}`, 40);
  });
  for (const yRow of [A.stepY + sq(3), A.rampY + sq(1.5)]) {
    const sw = sq(0.75);
    for (let x = A.x, j = 0; x < A.x + A.w - 1; x += sw, j++) {
      art.push(rect({ x, y: yRow, w: Math.min(sw, A.x + A.w - x), h: sq(1) }, SWATCHES[j % SWATCHES.length][1]));
    }
  }
  mask.push({ op: 'ramp', x: A.x, y: A.rampY, w: A.w, h: A.rampH, a: BLACK, b: WHITE, axis: 'x' });
  label(A.x, sq(0.45), 'A  depth ladder: _Water steps 32..255 (top), a 0 -> 255 ramp (bottom); same bed under all');

  // ── B1: hard edges on a uniform bed ──────────────────────────────────────────────
  art.push(rect(B1.pool, BED.mud));
  art.push(
    checker({ x: B1.pool.x, y: B1.pool.y + B1.pool.h - sq(1), w: B1.pool.w, h: sq(1) }, 75, BED.checkA, BED.checkB)
  );
  mask.push(rect(B1.pool, WHITE));
  for (const b of [B1.boatH, B1.boatV]) {
    art.push({ op: 'ellipse', cx: b.cx, cy: b.cy, rx: b.rx + 7, ry: b.ry + 7, rgba: [40, 28, 20, 255] });
    art.push({ op: 'ellipse', cx: b.cx, cy: b.cy, rx: b.rx, ry: b.ry, rgba: [132, 90, 52, 255] });
    mask.push({ op: 'ellipse', cx: b.cx, cy: b.cy, rx: b.rx + 7, ry: b.ry + 7, rgba: BLACK });
  }
  art.push(rect({ x: B1.pier.x - 6, y: B1.pier.y, w: B1.pier.w + 12, h: B1.pier.h + 6 }, [40, 28, 20, 255]));
  art.push(rect(B1.pier, [150, 110, 70, 255]));
  mask.push(rect({ x: B1.pier.x - 6, y: B1.pier.y, w: B1.pier.w + 12, h: B1.pier.h + 6 }, BLACK));
  for (const p of B1.piles) {
    art.push({ op: 'ellipse', cx: p.cx, cy: p.cy, rx: p.r + 5, ry: p.r + 5, rgba: [40, 28, 20, 255] });
    art.push({ op: 'ellipse', cx: p.cx, cy: p.cy, rx: p.r, ry: p.r, rgba: [110, 80, 50, 255] });
    mask.push({ op: 'ellipse', cx: p.cx, cy: p.cy, rx: p.r + 5, ry: p.r + 5, rgba: BLACK });
  }
  label(sq(1.5), sq(9.6), 'B1  hard edges, uniform bed: hulls, pier, piles, quay (mask 255 to the edge)');

  // ── B2: her Docklands, art + mask crops at the same place ────────────────────────
  for (const c of DOCK_CROPS) {
    art.push({ op: 'paste', src: DOCK_ART.art, sx: c.sx, sy: c.sy, sw: c.sw, sh: c.sh, x: c.x, y: c.y });
    mask.push({ op: 'paste', src: DOCK_ART.water, sx: c.sx, sy: c.sy, sw: c.sw, sh: c.sh, x: c.x, y: c.y });
  }
  label(sq(21.5), sq(9.6), 'B2  Docklands Warehouse (her art + her _Water mask, two strips)');

  // ── C1: puddles on cobbles ───────────────────────────────────────────────────────
  art.push(checker({ x: sq(1), y: sq(22.5), w: sq(9.5), h: sq(11) }, 40, g(112), g(134)));
  for (const p of PUDDLES) {
    mask.push({ op: 'blob', ...p });
    label(p.cx - 40, p.cy + p.ry + 16, `${p.peak}`, 36);
  }
  label(sq(1), sq(21.6), 'C1  puddles, peak 70..210');

  // ── C2: a pond with a wide natural bank ──────────────────────────────────────────
  art.push(rect({ x: sq(11), y: sq(22.5), w: sq(10.5), h: sq(11) }, BED.sand));
  art.push(checker({ x: sq(14.5), y: sq(24), w: sq(3.5), h: sq(9) }, 75, [150, 130, 92, 255], [204, 180, 132, 255]));
  mask.push({ op: 'blob', ...POND, wobble: 0.12, seed: 17 });
  label(sq(11), sq(21.6), 'C2  pond, sloping bank');

  // ── C3: beach -> open sea to the scene edge, rock island, jetty ──────────────────
  art.push({ op: 'ramp', x: SEA.x, y: SEA.y, w: sq(12), h: SEA.h, a: BED.sand, b: [104, 98, 84, 255], axis: 'x' });
  art.push({
    op: 'ramp',
    x: SEA.x + sq(12),
    y: SEA.y,
    w: sq(8),
    h: SEA.h,
    a: [104, 98, 84, 255],
    b: BED.rock,
    axis: 'x',
  });
  art.push(checker({ x: SEA.x, y: SEA.y + sq(10), w: SEA.w, h: sq(1.5) }, 75, BED.checkA, BED.checkB));
  mask.push({ op: 'ramp', x: SEA.x, y: SEA.y, w: SEA.beachW, h: SEA.h, a: BLACK, b: WHITE, axis: 'x' });
  mask.push(rect({ x: SEA.x + SEA.beachW, y: SEA.y, w: SEA.w - SEA.beachW, h: SEA.h }, WHITE));
  const rk = SEA.rock;
  art.push({ op: 'ellipse', cx: rk.cx, cy: rk.cy, rx: rk.rx, ry: rk.ry, rgba: [86, 80, 74, 255] });
  mask.push({ op: 'ellipse', cx: rk.cx, cy: rk.cy, rx: rk.rx, ry: rk.ry, rgba: BLACK });
  art.push(rect({ x: SEA.jetty.x - 6, y: SEA.jetty.y, w: SEA.jetty.w + 12, h: SEA.jetty.h + 6 }, [40, 28, 20, 255]));
  art.push(rect(SEA.jetty, [150, 110, 70, 255]));
  mask.push(rect({ x: SEA.jetty.x - 6, y: SEA.jetty.y, w: SEA.jetty.w + 12, h: SEA.jetty.h + 6 }, BLACK));
  label(sq(22), sq(21.6), 'C3  beach ramp into open sea (to the scene edge), rock island, jetty');

  art.push(...labels);
  const img = (suffix, mode, ops) => ({
    name: `${base}-Ground${suffix}.webp`,
    role: suffix || 'art',
    floor: 'water',
    w: W.w,
    h: W.h,
    mode,
    ops,
  });
  return [img('', 'RGB', art), img('_Water', 'RGB', mask), img('_Outdoors', 'RGB', [{ op: 'fill', rgba: WHITE }])];
}

export function waterScene(assetDir, version = LAB_VERSION) {
  const images = waterImages(version);
  const levelId = WATER_IDS.level;
  return {
    key: 'water',
    id: WATER_IDS.scene,
    data: {
      _id: WATER_IDS.scene,
      name: 'Lab · Water',
      width: WATER_SIZE.w,
      height: WATER_SIZE.h,
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
          flags: { [MODULE_ID]: { [LAB_FLAG]: 'level:water' } },
        },
      ],
      flags: { [MODULE_ID]: { [LAB_FLAG]: 'scene:water', labVersion: version, enabled: true } },
    },
    sceneFlags: { sky: LAB_SKY, wind: LAB_WIND },
  };
}
