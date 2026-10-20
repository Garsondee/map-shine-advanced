/**
 * FIRE — THE BILLOW ENGINE (2026-10-20). The per-frame orchestrator between the world (fires, painted spawn points,
 * wind, rain, the fire's slow life) and the billow model/renderer. THREE injected, no renderer-state calls: the splat
 * is returned as a job list for the viewer to run (see `fire-billow-render.js`).
 *
 * Each frame, for every fire:
 *   1. WEATHER AT THE FIRE — the wind bake's openness and sky at its own position (`windHandle.cpuAt`), the ambient
 *      wind's speed and direction, the scene's rain, folded into the numbers the model wants (local wind push, the one
 *      stress number, rain reaching it) with the SAME functions the light and the embers use, so they cannot disagree.
 *   2. ITS LIFE — `fire-billow-state.js` steps the fire's wetness, vitality and coals (rain puts it out, the coals
 *      smoulder, the ash goes cold, a long dry spell relights it).
 *   3. ITS BILLOWS — `emitFireLobes` writes the fire's lobes into the renderer's two buffers.
 * Then the contour boxes are fitted round the lobes and the field jobs are prepared.
 *
 * ⚠️ A BIG PAINTED REGION IS MANY FLAMES, NOT ONE HUGE ONE. A flame does not grow past a bonfire's however wide the
 * fuel is: `planClusters` splits a fire wider than `MAX_CLUSTER_RADIUS_M` into sub-fires spread over its painted
 * spawn points (greedy farthest-point, stable), each its own flame sharing the parent's life. That is the road to a
 * burning building: paint the roof, get a roof of flames.
 *
 * @module effects/fire/fire-billow-engine
 */
import { createBillowRenderer, billowSmokeScale } from './fire-billow-render.js';
import {
  emitFireLobes,
  emitMassSmoke,
  hash01,
  LOBE_STRIDE,
  maxLobesPerFire,
  MASS_SMOKE_MAX,
} from './fire-billow-geometry.js';
import { createFireLifeBook } from './fire-billow-state.js';
import { billowRuntimeFromParams } from './fire-billow-params.js';
import { bloomCounterParams, bloomCounterUniforms, regionFill } from './fire-billow-bloom.js';
import { fireScaleChain, fireWindMotion01, FIRE_FUELS, deriveFireSeed } from './fire-geometry.js';
import { SPAWN_POINT_STRIDE, labelAtWorldPoint } from './fire-spawn-points.js';
import { buildDepthHeightGateNode } from '../lighting/point-light-illumination.js';
import { windFlowVector } from '../../world/index.js';

/** The widest a single flame gets, in metres of fuel: past this a painted region is split into several flames. */
export const MAX_CLUSTER_RADIUS_M = 0.9;
/** The most spawn points one cluster keeps (an even subsample): the model only needs a footprint, not every texel. */
const MAX_POINTS_PER_CLUSTER = 96;
/** Beyond this many sub-flames per fire the extras are dropped (a whole city block is not one fire). */
const MAX_CLUSTERS_PER_FIRE = 96;
/** A fire up to this many maxR wide stays ONE (big) flame: a painted bonfire a little over the cap is not two candles side by side. */
const SINGLE_FLAME_REACH = 1.7;
/** Past this many maxR wide a fire is a building: its flames stand at their closest. Between, they stand `MODEST_SPACING` apart. */
const MASS_FROM = 3;
/** Flames of a split fire stand this close (in maxR) at their closest: close enough that neighbours overlap into one mass. */
const CLUSTER_SPACING = 0.85;
/** A mass's flame centres are knocked off the sampling lattice by up to this many maxR (a roof is not a grid). */
const CLUSTER_JITTER = 0.45;
/** ...and this far apart (in maxR) when the fire has only just outgrown one flame. */
const MODEST_SPACING = 1.4;
/**
 * Most lobes written per frame before every flame is thinned out: the emitter costs ~0.7 us a lobe (measured, Node, warm), so
 * this is ~3 ms a frame. A lone campfire is ~90 lobes (0.06 ms); a whole building would otherwise be ~6000 (4.5 ms).
 */
const CPU_LOBE_BUDGET = 7600;
/** A burning mass's equivalent flame radius, as a fraction of its box's mean side (fitted to a single flame: 0.19). */
const MASS_FILL_PER_SIDE = 0.19;
/** A group of flames too scattered to be one contour box is covered by at most this many grid tiles. */
const MAX_TILES_PER_GROUP = 16;
/** A fire split into more flames than this is a MASS (a roof, a building): its smoke is one column, not a wisp per flame. */
const MASS_FROM_SIBLINGS = 6;
/** ...and by this many flames the column is all the smoke there is: a lone puff off a roof reads as a grey ball, not smoke. */
const MASS_WISPS_END = 14;
/** With no label field to say which blob a painted point is part of: farther than this many radii from every fire, it is part of none. */
const OWN_REACH = 3;

/**
 * A big fire's flames stand taller: a burning roof is not a field of campfires. 1 for a single flame, rising with how much
 * wider the whole painted fire is than one flame can be (each doubling adds 30%), to at most 1.7x.
 *
 * @param {number} parentRadius the whole fire's radius (px) @param {number} maxRadius one flame's widest (px)
 */
export function infernoHeightGain(parentRadius, maxRadius) {
  const ratio = Math.max(1, (parentRadius || 0) / Math.max(1e-3, maxRadius || 1));
  return clamp(1 + 0.3 * Math.log2(ratio), 1, 1.7);
}

/**
 * How much simpler each flame of a big fire may be: in a mass of flames each one is mostly hidden by its neighbours, and the
 * lobe emitter is the effect's whole CPU cost (~0.7 us per lobe: a lone campfire 0.06 ms, a roof of thirty flames 1.8 ms at full
 * quality). 1 for a flame on its own or among a few, easing down to half for a mass of forty or more.
 *
 * @param {number} siblings how many flames the whole fire was split into
 */
export function massQuality(siblings) {
  return clamp(1 - 0.0125 * (Math.max(1, siblings || 1) - 4), 0.5, 1);
}

/**
 * How much of its own smoke each flame of a MASS keeps: a roof of fifty flames each puffing its own plume was a field of white dots
 * (and a lone puff off a roof reads as a grey ball, not smoke); the mass as a whole makes one column (`emitMassSmoke`). 1 up to a
 * few flames, falling in a straight line to none by `MASS_WISPS_END` flames.
 *
 * @param {number} siblings how many flames the whole fire was split into
 */
export function massSmokeKeep(siblings) {
  const n = Math.max(1, siblings || 1);
  return n <= MASS_FROM_SIBLINGS ? 1 : clamp((MASS_WISPS_END - n) / (MASS_WISPS_END - MASS_FROM_SIBLINGS), 0, 1);
}

/**
 * A building's flames are bigger than a bonfire's (and a roof of fifty candles is not a roaring fire): once a painted fire is
 * wider than one flame can be, each doubling of its width adds 45% to the widest flame it may be split into, to at most 2x.
 * 1 for anything up to a bonfire or two.
 *
 * @param {number} ratio the painted fire's radius over one bonfire's (`MAX_CLUSTER_RADIUS_M` in px)
 */
export function massFlameGrowth(ratio) {
  return clamp(1 + 0.45 * Math.log2(Math.max(1, ratio || 1) / SINGLE_FLAME_REACH), 1, 2);
}

/** How black a mass's smoke is: a building is dark, a bonfire pale. 0 up to a few flames, then 0.4 rising to 0.85 by about twenty-two. */
export function massSootiness(siblings) {
  const n = Math.max(1, siblings || 1);
  return n <= MASS_FROM_SIBLINGS ? 0 : clamp(0.4 + (0.45 * (n - MASS_FROM_SIBLINGS)) / 16, 0.4, 0.85);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smooth01 = (x, a, b) => {
  const t = clamp((x - a) / Math.max(1e-6, b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * The virtual camera's height (world px) that the billows' perspective parallax uses, from the visible world rect.
 *
 * ⚠️ IT MUST RISE AS THE VIEW ZOOMS OUT. A real camera with a fixed field of view sits ~3 half-widths above what it sees; a
 * FIXED height (the first cut used 1000 px) made every flame far from the view centre lean radially outward by up to a
 * quarter of its distance from the centre when zoomed out to see a whole map: the real viewer showed a burning roof as a hail
 * of comets all streaking away from the middle of the screen. With the height tied to the view, a flame's lean outward is the
 * same small fraction of its height at every zoom.
 *
 * @param {{minX:number,maxX:number}} rect the visible world rect
 * @returns {number}
 */
export function viewCameraHeight(rect) {
  const halfW = Math.max(1, ((rect?.maxX ?? 0) - (rect?.minX ?? 0)) * 0.5);
  return Math.max(400, halfW * 3);
}

/**
 * Which fire each painted point is part of: `owned[j]` lists the cloud indices of fire `j`'s points. A point can belong to NO
 * fire, and then it is simply not used (it must not be given to whichever fire happens to be nearest).
 *
 * ⚠️ NEVER "THE NEAREST CENTRE". A fire's centre is the middle of its inscribed circle, so on a wide painted region a point on
 * the far side is closer to a small neighbour's centre than to its own. The first cut did exactly that and the real viewer
 * showed it: a bonfire owned two dim points off the bottom edge of the burning roof 330 px north of it, and every flame
 * piece rooted on one of them (a tongue, a billow, a puff of smoke) stood alone in the air above the fire, a detached
 * teardrop of flame. `fire-spawn-points.js#applyCohesion` learned the same lesson for the embers, and the answer is the same:
 * ownership is structural. With the scene's label field (`labelGrid`: which painted blob each texel is part of) a point
 * only ever belongs to a fire of its OWN blob, and a point on no blob, or on one whose fire did not survive, belongs to
 * nothing. Without a label field the best that can be done is distance measured in each fire's OWN radii (a point inside a
 * fire's disc is that fire's), and a point more than `OWN_REACH` radii from every fire is nobody's.
 *
 * @param {Array<{x:number,y:number,diameterPx:number,label?:number}>} list
 * @param {Float32Array|null} pts @param {number} n @param {number} stride
 * @param {{nearestLabel:Int32Array, spec:object}|null} labelGrid
 * @returns {number[][]}
 */
function ownPoints(list, pts, n, stride, labelGrid) {
  const owned = list.map(() => []);
  if (!pts || n <= 0 || !list.length) return owned;
  const radii = list.map((f) => Math.max(4, (Number(f.diameterPx) || 100) / 2));
  const labelled = !!(labelGrid?.nearestLabel && labelGrid?.spec);
  const byLabel = new Map();
  if (labelled) {
    for (let j = 0; j < list.length; j++) {
      const label = list[j].label;
      if (!Number.isInteger(label) || label === -1) continue;
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label).push(j);
    }
  }
  for (let i = 0; i < n; i++) {
    const x = pts[i * stride];
    const y = pts[i * stride + 1];
    let candidates = null;
    if (labelled) {
      const label = labelAtWorldPoint(x, y, labelGrid);
      candidates = label === -1 ? null : (byLabel.get(label) ?? null);
      if (!candidates) continue;
    }
    let best = -1;
    let bd = Infinity;
    const count = candidates ? candidates.length : list.length;
    for (let k = 0; k < count; k++) {
      const j = candidates ? candidates[k] : k;
      const dx = x - list[j].x;
      const dy = y - list[j].y;
      const d = (dx * dx + dy * dy) / (radii[j] * radii[j]);
      if (d < bd) {
        bd = d;
        best = j;
      }
    }
    if (best < 0 || (!candidates && bd > OWN_REACH * OWN_REACH)) continue;
    owned[best].push(i);
  }
  return owned;
}

/**
 * Split the fires into flames. Pure and deterministic (Node-tested).
 *
 * @param {Array<{id?:string,x:number,y:number,diameterPx:number,label?:number}>} fires
 * @param {{points?:Float32Array,count?:number}|null} cloud the painted spawn cloud (x, y, brightness, jitter per point)
 * @param {number} mPerPx world metres per px
 * @param {{nearestLabel:Int32Array, spec:object}|null} [labelGrid] the scene's blob label field (see `ownPoints`)
 * @returns {Array<{fireIndex:number, id:string, x:number, y:number, radius:number, seed:number, points:Float32Array, count:number}>}
 */
export function planClusters(fires, cloud, mPerPx, labelGrid = null) {
  const out = [];
  const list = Array.isArray(fires) ? fires : [];
  const pts = cloud?.points ?? null;
  const n = cloud?.count ?? 0;
  const stride = SPAWN_POINT_STRIDE;
  const maxR = Math.max(24, MAX_CLUSTER_RADIUS_M / Math.max(1e-4, mPerPx));

  // 1. every painted point goes to the fire it is part of
  const owned = ownPoints(list, pts, n, stride, labelGrid);

  const pack = (indices) => {
    const take = Math.min(MAX_POINTS_PER_CLUSTER, indices.length);
    const arr = new Float32Array(take * stride);
    const step = indices.length / Math.max(1, take);
    for (let k = 0; k < take; k++) {
      const i = indices[Math.floor(k * step)];
      for (let c = 0; c < stride; c++) arr[k * stride + c] = pts[i * stride + c];
    }
    return { points: arr, count: take };
  };

  for (let j = 0; j < list.length; j++) {
    const f = list[j];
    const id = String(f.id ?? `fire@${Math.round(f.x)},${Math.round(f.y)}`);
    const R = Math.max(4, (Number(f.diameterPx) || 100) / 2);
    const baseSeed = deriveFireSeed(f.x, f.y) | 0;
    const mine = owned[j];
    if (R <= maxR * SINGLE_FLAME_REACH || mine.length < 6) {
      const { points, count } = pack(mine);
      out.push({
        fireIndex: j,
        id,
        x: f.x,
        y: f.y,
        radius: R,
        parentRadius: R,
        maxRadius: maxR,
        siblings: 1,
        seed: baseSeed,
        spreadT: 0,
        points,
        count,
      });
      continue;
    }
    // a wide fire: greedy farthest-point sampling over its painted points -> centres about one maxR apart, so the flames
    // overlap into ONE burning mass (a roof of flames, not a tray of candles)
    // (a building's flames may be bigger than a bonfire's: fewer of them, each with room to be a flame)
    const maxRm = maxR * massFlameGrowth(R / maxR);
    const want = clamp(Math.ceil((R / maxRm) * (R / maxRm) * 3.4), 2, MAX_CLUSTERS_PER_FIRE);
    const centres = [];
    // a bonfire's worth of paint gets a few big flames; a building's gets a dense mass of them
    const spacing =
      maxRm *
      clamp(
        MODEST_SPACING -
          ((R / maxR - SINGLE_FLAME_REACH) / (MASS_FROM - SINGLE_FLAME_REACH)) * (MODEST_SPACING - CLUSTER_SPACING),
        CLUSTER_SPACING,
        MODEST_SPACING
      );
    // start from the point nearest the fire's own centre, for a stable first pick
    let first = mine[0];
    let fd = Infinity;
    for (const i of mine) {
      const dx = pts[i * stride] - f.x;
      const dy = pts[i * stride + 1] - f.y;
      const d = dx * dx + dy * dy;
      if (d < fd) {
        fd = d;
        first = i;
      }
    }
    centres.push(first);
    const minDist2 = new Float64Array(mine.length).fill(Infinity);
    while (centres.length < want) {
      const last = centres[centres.length - 1];
      let far = -1;
      let farD = -1;
      for (let m = 0; m < mine.length; m++) {
        const i = mine[m];
        const dx = pts[i * stride] - pts[last * stride];
        const dy = pts[i * stride + 1] - pts[last * stride + 1];
        const d = dx * dx + dy * dy;
        if (d < minDist2[m]) minDist2[m] = d;
        if (minDist2[m] > farD) {
          farD = minDist2[m];
          far = i;
        }
      }
      if (far < 0 || farD < spacing * spacing) break;
      centres.push(far);
    }
    const groups = centres.map(() => []);
    for (const i of mine) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const dx = pts[i * stride] - pts[centres[c] * stride];
        const dy = pts[i * stride + 1] - pts[centres[c] * stride + 1];
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      groups[best].push(i);
    }
    for (let c = 0; c < centres.length; c++) {
      const { points, count } = pack(groups[c]);
      // each flame is as wide as its own share of the paint, never wider than a bonfire
      let spread = 0;
      for (const i of groups[c]) {
        const dx = pts[i * stride] - pts[centres[c] * stride];
        const dy = pts[i * stride + 1] - pts[centres[c] * stride + 1];
        spread = Math.max(spread, Math.hypot(dx, dy));
      }
      out.push({
        fireIndex: j,
        id,
        x: pts[centres[c] * stride] + (hash01(baseSeed, c, 11) - 0.5) * maxRm * CLUSTER_JITTER,
        y: pts[centres[c] * stride + 1] + (hash01(baseSeed, c, 12) - 0.5) * maxRm * CLUSTER_JITTER,
        radius: clamp(Math.max(spread * 0.9, maxRm * 0.95), 6, maxRm),
        parentRadius: R,
        maxRadius: maxRm,
        siblings: centres.length,
        seed: (baseSeed + Math.imul(c + 1, 0x9e3779b1)) | 0,
        spreadT: 0,
        points,
        count,
      });
    }
    // WHEN THE FRONT REACHES EACH FLAME (only used when the fire is set to spread). A building catches at a corner, not always
    // in the middle: the ignition flame is the one nearest a point on the painted fire's rim that a hash of the fire picks, and
    // the others are ordered by their distance from it, 0 (where it starts) to 1 (the far end), with a little jitter.
    const mine2 = out.filter((o) => o.fireIndex === j);
    if (mine2.length > 1) {
      const ang = hash01(baseSeed, 7, 3) * Math.PI * 2;
      const px = f.x + Math.cos(ang) * R * 0.6;
      const py = f.y + Math.sin(ang) * R * 0.6;
      let ignite = mine2[0];
      let bd = Infinity;
      for (const o of mine2) {
        const d = (o.x - px) ** 2 + (o.y - py) ** 2;
        if (d < bd) {
          bd = d;
          ignite = o;
        }
      }
      let dmax = 1e-6;
      for (const o of mine2) dmax = Math.max(dmax, Math.hypot(o.x - ignite.x, o.y - ignite.y));
      mine2.forEach((o, k) => {
        const d = Math.hypot(o.x - ignite.x, o.y - ignite.y) / dmax;
        o.spreadT = clamp(d * 0.88 + (hash01(baseSeed, k, 19) - 0.5) * 0.08, 0, 1);
      });
      ignite.spreadT = 0;
    }
  }
  return out;
}

/**
 * Merge overlapping contour boxes into one box per burning mass.
 *
 * The contour pass reads the WHOLE field inside its box, so overlapping boxes would shade the same pixels twice (a doubled
 * edge) and a roof of 80 flames would cost 80 box-fulls of the heaviest shader in the effect. Boxes that overlap are joined
 * (union-find over the pairwise test: O(n^2) on at most `MAX_CLUSTERS_PER_FIRE` boxes, a few thousand comparisons) and a joined
 * group becomes its bounding box only if that box is not much emptier than the boxes it replaces. A diagonal row of separate
 * fires chains into one overlapping group whose bounding box is mostly empty: that group is covered by a TILING instead (grid
 * cells that any member touches), so the pixels are still drawn exactly once. (It used to be left as the overlapping boxes it
 * was, which draws their overlap twice: a doubled edge on a flame, and a visible rectangle of denser smoke on a translucent plume.)
 * Every tile of a group carries the group's fill and looks, so the tiles join without a seam.
 *
 * @param {number[]} boxes `[minX, minY, w, h]` per box
 * @param {number[]} fills one number per box (merged: the largest of the group)
 * @param {number} [maxWaste=1.7] the largest allowed (bounding box area) / (sum of the member boxes' areas)
 * @param {number[]|null} [looks] two numbers per box (the smoke's crescent width and shadow offset): merged = the largest of the group
 * @returns {{boxes:number[], fills:number[], looks:number[], members:number[], sides:number[]}} `members[i]` = how many boxes
 *   the group of box `i` had, `sides[i]` = the mean side of that group's bounding box
 */
export function mergeBoxes(boxes, fills, maxWaste = 1.7, looks = null) {
  const n = Math.floor(boxes.length / 4);
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let a = 0; a < n; a++) {
    const ax0 = boxes[a * 4];
    const ay0 = boxes[a * 4 + 1];
    const ax1 = ax0 + boxes[a * 4 + 2];
    const ay1 = ay0 + boxes[a * 4 + 3];
    for (let b = a + 1; b < n; b++) {
      const bx0 = boxes[b * 4];
      const by0 = boxes[b * 4 + 1];
      if (bx0 >= ax1 || by0 >= ay1 || bx0 + boxes[b * 4 + 2] <= ax0 || by0 + boxes[b * 4 + 3] <= ay0) continue;
      parent[find(b)] = find(a);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  const outBoxes = [];
  const outFills = [];
  const outLooks = [];
  const members = [];
  const sides = [];
  for (const ids of groups.values()) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let area = 0;
    let fill = 0;
    let cres = 0;
    let off = 0;
    for (const i of ids) {
      x0 = Math.min(x0, boxes[i * 4]);
      y0 = Math.min(y0, boxes[i * 4 + 1]);
      x1 = Math.max(x1, boxes[i * 4] + boxes[i * 4 + 2]);
      y1 = Math.max(y1, boxes[i * 4 + 1] + boxes[i * 4 + 3]);
      area += boxes[i * 4 + 2] * boxes[i * 4 + 3];
      fill = Math.max(fill, fills[i] ?? 0);
      cres = Math.max(cres, looks?.[i * 2] ?? 0);
      off = Math.max(off, looks?.[i * 2 + 1] ?? 0);
    }
    const side = 0.5 * (x1 - x0 + (y1 - y0));
    const emit = (bx, by, bw, bh) => {
      outBoxes.push(bx, by, bw, bh);
      outFills.push(fill);
      outLooks.push(cres, off);
      members.push(ids.length);
      sides.push(side);
    };
    if (ids.length === 1 || (x1 - x0) * (y1 - y0) <= maxWaste * area) {
      emit(x0, y0, x1 - x0, y1 - y0);
    } else {
      // too empty to be one box: cover the members with grid tiles (each pixel drawn once, no overlap)
      const sizes = ids.map((i) => 0.5 * (boxes[i * 4 + 2] + boxes[i * 4 + 3])).sort((a, b) => a - b);
      let cell = Math.max(64, Math.min(sizes[sizes.length >> 1] * 1.25, side * 0.25));
      let cells = tileCells(boxes, ids, cell);
      for (let guard = 0; guard < 8 && cells.length > MAX_TILES_PER_GROUP; guard++) {
        cell *= 1.5;
        cells = tileCells(boxes, ids, cell);
      }
      for (const [gx, gy] of cells) emit(gx * cell, gy * cell, cell, cell);
    }
  }
  return { boxes: outBoxes, fills: outFills, looks: outLooks, members, sides };
}

/** The grid cells (size `cell`) that any of the member boxes touches, as `[gx, gy]` pairs in a stable order. */
function tileCells(boxes, ids, cell) {
  const seen = new Map();
  for (const i of ids) {
    const gx0 = Math.floor(boxes[i * 4] / cell);
    const gx1 = Math.floor((boxes[i * 4] + boxes[i * 4 + 2]) / cell);
    const gy0 = Math.floor(boxes[i * 4 + 1] / cell);
    const gy1 = Math.floor((boxes[i * 4 + 1] + boxes[i * 4 + 3]) / cell);
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) seen.set(`${gx},${gy}`, [gx, gy]);
  }
  return [...seen.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

/**
 * @param {object} deps
 * @param {*} deps.THREE
 * @param {(name:string,w:number,h:number)=>*} deps.createTarget the allocator (see `fire-billow-render.js`)
 * @param {(rt:*)=>void} [deps.disposeTarget]
 * @param {() => object|null} [deps.getWindHandle]
 * @param {object} [deps.lighting] `{illumTexNode, colorationTexNode}`
 * @param {*} [deps.depthTexNode] @param {*} [deps.depthFlagsTexNode]
 * @param {number} [deps.flameCapacity] @param {number} [deps.smokeCapacity]
 * @param {typeof createBillowRenderer} [deps.createRenderer] the renderer factory (injected so Node tests can run the whole
 *   CPU side — weather, life, lobes, boxes — against a fake that has no GPU behind it)
 */
export function createBillowEngine({
  THREE,
  createTarget,
  disposeTarget = null,
  getWindHandle = null,
  lighting = null,
  depthTexNode = null,
  depthFlagsTexNode = null,
  flameCapacity,
  smokeCapacity,
  createRenderer = createBillowRenderer,
}) {
  const buildGate = (TSL, { depthTexNode: dTex, depthFlagsTexNode: fTex, expectedDepth }) =>
    buildDepthHeightGateNode(TSL, {
      depthHere: dTex.sample(TSL.screenUV),
      flagsHere: fTex ? fTex.sample(TSL.screenUV) : null,
      uLightExpectedDepth: expectedDepth,
    });
  const renderer = createRenderer({
    THREE,
    createTarget,
    disposeTarget,
    flameCapacity,
    smokeCapacity,
    lighting,
    depth: depthTexNode ? { depthTexNode, depthFlagsTexNode, buildGate } : null,
  });
  const lives = createFireLifeBook();
  /** per big fire: how far its front has run (seconds of burning time; frozen while it is out, restarted on a rekindle) */
  const spread = new Map();
  /** per fire: the weather this frame felt (for `getStatus`: why a fire does or does not react) */
  const weatherDiag = new Map();
  /** @type {{cloud:*, fires:*, mPerPx:number, labelGrid:*, clusters:Array<object>}} */
  let planMemo = { cloud: null, fires: null, mPerPx: -1, labelGrid: null, clusters: [] };
  let jobs = [];
  let status = { fires: 0, clusters: 0, flame: 0, smoke: 0, coal: 0, dropped: 0 };
  let runtimeMemo = { params: null, fuelKey: '', value: null };

  function brFor(params, fuel) {
    const fuelKey = String(fuel);
    if (runtimeMemo.params === params && runtimeMemo.fuelKey === fuelKey) return runtimeMemo.value;
    const f = FIRE_FUELS[fuel] ?? FIRE_FUELS.wood;
    const value = billowRuntimeFromParams(params, {
      sootGain: f.sootGain,
      smokeGain: f.smokeGain,
      heightGain: f.heightGain,
      hueShiftRad: ((f.hueShift ?? 0) + clamp(Number(params?.colorHueShift) || 0, -180, 180) / 360) * Math.PI * 2,
    });
    runtimeMemo = { params, fuelKey, value };
    return value;
  }

  return {
    /** The scene to draw into the frame, with the flame/smoke/coal contour. */
    scene: renderer.scene,
    renderer,
    lives,

    /**
     * One frame of CPU work. Writes the lobes and prepares the field jobs (fetch them with `takeFieldJobs`).
     *
     * @param {object} ctx
     * @param {number} ctx.nowMs @param {number} ctx.dtSec
     * @param {{minX:number,minY:number,maxX:number,maxY:number}} ctx.rect the visible world rect
     * @param {Array<object>} ctx.fires `getFireRenderState().fires` (with geometric `windExposure`)
     * @param {object|null} ctx.cloud the painted spawn cloud
     * @param {{nearestLabel:Int32Array, spec:object}|null} [ctx.labelGrid] which painted blob each texel is part of
     *   (`getFireRenderState().fireLabelGrid`): decides which fire a painted point belongs to (`ownPoints`)
     * @param {object} ctx.params the resolved FIRE_PARAMS values
     * @param {object} ctx.runtime `fireRuntimeFromParams(...)` — for the weather numbers it already folds
     * @param {number} ctx.precip01 the scene's eased precipitation
     * @param {number} ctx.pxPerWorld the drawing buffer's pixel density over the rect
     * @param {{enabled?:boolean, params?:object}|null} [ctx.bloom] the scene's live bloom (`getBloomRenderState()`): the flame
     *   paints the inverse of it so the painted colours survive (fire-billow-bloom.js). Absent = no bloom to counter.
     * @param {number} ctx.mPerPx
     * @param {number} [ctx.quality=1] the tier's lobe budget scale
     * @param {number} [ctx.expectedDepth=0]
     * @returns {{lifeByFire: Map<string,{vitality:number,coal:number,phase:string}>}}
     */
    update(ctx) {
      const { nowMs, dtSec, rect, fires, cloud, params, runtime } = ctx;
      const windHandle = getWindHandle?.() ?? null;
      const mPerPx = ctx.mPerPx > 0 ? ctx.mPerPx : 0.0102;
      const br = brFor(params, params?.fuel ?? 'wood');
      const timeSec = nowMs * 0.001 * br.motionSpeed;
      const pxPerWorld = ctx.pxPerWorld > 0 ? ctx.pxPerWorld : 1;

      // the scene's bloom adds its glow on top of the flame; the flame paints the inverse of it (see fire-billow-bloom.js).
      // Four uniforms, set every frame (the cascade can move the bloom at any time, and a uniform write costs nothing).
      const counter = bloomCounterParams(ctx.bloom);
      renderer.setBloomCounter?.(bloomCounterUniforms(counter, br.bloomMix));

      // the clusters (flames) are replanned only when the paint, the fires or the grid scale change
      const labelGrid = ctx.labelGrid ?? null;
      if (
        planMemo.cloud !== cloud ||
        planMemo.fires !== fires ||
        planMemo.mPerPx !== mPerPx ||
        planMemo.labelGrid !== labelGrid
      ) {
        planMemo = { cloud, fires, mPerPx, labelGrid, clusters: planClusters(fires, cloud, mPerPx, labelGrid) };
      }
      const clusters = planMemo.clusters;

      const ambient = windHandle?.ambient ?? null;
      const windSpeed01 = Number.isFinite(ambient?.speed01?.value) ? ambient.speed01.value : 0;
      const windDirDeg = Number.isFinite(ambient?.directionDeg?.value) ? ambient.directionDeg.value : 0;
      const wdir = windFlowVector(windDirDeg);
      const canAsk = !!(windHandle?.hasBake && typeof windHandle.cpuAt === 'function');
      const snuffable = runtime?.canBeSnuffed !== false;
      const weatherResponse = clamp(Number(runtime?.weatherResponse ?? params?.weatherResponse ?? 1), 0, 1);
      const rainResponse = clamp(Number(runtime?.rainResponse ?? params?.rainResponse ?? 1), 0, 2);
      const stressGain = runtime?.stressGain ?? 1;
      const windGain = clamp(Number(params?.windResponse ?? 1), 0, 2);
      const precip = clamp(Number(ctx.precip01) || 0, 0, 1);
      const life = { ...br.life };
      if (!br.rekindle) life.rekindleDelaySec = 1e9;

      const cx = (rect.minX + rect.maxX) * 0.5;
      const cy = (rect.minY + rect.maxY) * 0.5;
      const env = {
        tSec: timeSec,
        camX: cx,
        camY: cy,
        cameraHeight: viewCameraHeight(rect),
        parallax: br.parallax,
        tilt: br.tilt,
        projection: 'top',
        quality: clamp((ctx.quality ?? 1) * br.quality, 0.2, 1),
      };

      const fCap = renderer.flameCapacity;
      const sCap = renderer.smokeCapacity;
      let nf = 0;
      let ns = 0;
      let dropped = 0;
      let coalTotal = 0;
      const boxes = [];
      /** per box: how much of the bloom a flame this big on screen gets */
      const fills = [];
      /** per box: the smoke crescent width (px) and ground-shadow offset (world px), which follow the size of its billows */
      const looks = [];
      const lifeByFire = new Map();
      const stepped = new Set();
      const advanced = new Set();
      /** per fire: how much of it burns (the spread front), and what its mass smoke column needs */
      const litStats = new Map();
      const masses = new Map();
      const spreadSec = clamp(Number(params?.spreadSec) || 0, 0, 3600);
      const margin = 24;
      const inView = (c) => {
        const reach = c.radius * 7 + margin;
        return !(
          c.x + reach < rect.minX ||
          c.x - reach > rect.maxX ||
          c.y + reach < rect.minY ||
          c.y - reach > rect.maxY
        );
      };

      // THE LOBE BUDGET. In a mass each flame is simpler (`massQuality`), and what the visible flames still want past the buffer
      // is thinned out of ALL of them together (a burning roof of eighty flames is eighty simpler flames, not sixty flames and
      // twenty holes).
      const baseQuality = env.quality;
      let need = 0;
      for (const c of clusters) {
        if (inView(c)) need += maxLobesPerFire(c.radius, br.tune) * baseQuality * massQuality(c.siblings);
      }
      const lobeBudget = Math.min(fCap * 0.9, CPU_LOBE_BUDGET);
      const budgetQuality = need > lobeBudget ? clamp(lobeBudget / need, 0.3, 1) : 1;
      let minQuality = 1;

      for (const c of clusters) {
        const f = fires[c.fireIndex] ?? {};
        const fuel = f.fuel ?? params?.fuel ?? 'wood';
        const chain = fireScaleChain((f.diameterPx ?? c.radius * 2) * 1, mPerPx, { fuel, intensity: f.intensity });
        // the weather AT this fire
        const cell = canAsk ? windHandle.cpuAt(c.x, c.y) : null;
        const openness = clamp(Number.isFinite(cell?.openness) ? cell.openness : 1, 0, 1);
        const sky = clamp(
          Number.isFinite(cell?.sky) ? cell.sky : Number.isFinite(f.outdoors01) ? f.outdoors01 : 1,
          0,
          1
        );
        const outdoor01 = clamp(0.5 * sky + 0.5 * openness, 0, 1);
        const push = fireWindMotion01({
          windSpeed01,
          windExposure01: openness,
          windResponseGain: windGain,
          weatherResponse01: 1,
          snuffWind: chain.snuffWind,
        });
        const gated = fireWindMotion01({
          windSpeed01,
          windExposure01: openness,
          windResponseGain: windGain,
          weatherResponse01: weatherResponse,
          snuffWind: chain.snuffWind,
        });
        const rainHere = precip * sky * weatherResponse;
        const rainFelt = Math.min(1, rainHere * rainResponse);
        // THE FLAME'S WEATHER STRESS (stronger than the sprite era's: a gale really does beat a flame down, rain in a gale most of all)
        const stress01 = clamp(
          (0.75 * Math.pow(gated, 1.4) + 0.55 * rainFelt + 0.5 * gated * rainFelt) * stressGain,
          0,
          1
        );
        // a gale on an exposed fire starts to blow it out (a hurricane does it in about the time rain does); `windSnuff` is the dial
        const wind01 = clamp(((gated - 0.72) / 0.28) * clamp(Number(params?.windSnuff ?? 1), 0, 2), 0, 1);
        weatherDiag.set(c.id, {
          openness: +openness.toFixed(2),
          sky: +sky.toFixed(2),
          wind: +gated.toFixed(2),
          rain: +rainFelt.toFixed(2),
          stress: +stress01.toFixed(2),
        });

        // its life (once per fire, however many flames it is split into)
        let lf = lifeByFire.get(c.id);
        if (!lf) {
          if (!stepped.has(c.id)) {
            stepped.add(c.id);
            lives.step(c.id, dtSec, { rain01: rainHere, wind01, snuffable, rainResponse, seed: c.seed, timeSec }, life);
          }
          const s = lives.get(c.id);
          lf = { vitality: s.vitality, coal: s.coal, phase: s.phase, wet: s.wet };
          lifeByFire.set(c.id, lf);
        }

        // SPREAD: a big painted fire (a building) can catch at one end and burn across over `spreadSec` seconds. The front runs
        // faster downwind, crawls in the rain, stands still while the fire is out, and starts again from the corner when it
        // rekindles. 0 = the whole region at once (the default).
        let ign = 1;
        if (spreadSec > 0 && c.siblings > 1) {
          let st = spread.get(c.id);
          if (!st) {
            st = { age: 0, phase: lf.phase };
            spread.set(c.id, st);
          }
          if (!advanced.has(c.id)) {
            advanced.add(c.id);
            if (lf.phase === 'rekindle' && st.phase !== 'rekindle') st.age = 0;
            st.phase = lf.phase;
            const alive = lf.phase === 'burning' || lf.phase === 'rekindle';
            if (alive) st.age += dtSec * (1 - 0.85 * clamp(lf.wet, 0, 1)) * (1 + 0.8 * push);
          }
          ign = smooth01(st.age / spreadSec, c.spreadT, c.spreadT + 0.14);
        }
        const stat = litStats.get(c.id) ?? { sum: 0, n: 0, wx: 0, wy: 0, w: 0 };
        stat.sum += ign;
        stat.n++;
        stat.wx += c.x * ign;
        stat.wy += c.y * ign;
        stat.w += ign;
        litStats.set(c.id, stat);

        // visible? (the life has been stepped either way, so a fire out of view still goes out in the rain)
        if (!inView(c)) continue;
        env.quality = clamp(baseQuality * massQuality(c.siblings) * budgetQuality, 0.2, 1);
        minQuality = Math.min(minQuality, env.quality);
        const room = Math.ceil(maxLobesPerFire(c.radius, br.tune) * clamp(env.quality, 0.35, 1));
        if (nf + room > fCap || ns + room > sCap) {
          dropped++;
          continue;
        }

        if (c.siblings > MASS_FROM_SIBLINGS && !masses.has(c.id)) {
          masses.set(c.id, {
            id: c.id,
            seed: c.seed,
            parentRadius: c.parentRadius,
            clusterRadius: c.radius,
            // the flames tops: where the column starts
            baseZ:
              c.radius *
              br.tune.bodyHeight *
              (0.7 + 0.75 * outdoor01) *
              br.heightGain *
              infernoHeightGain(c.parentRadius, c.maxRadius) *
              0.8,
            outdoor01,
            stress01,
            rain01: rainHere,
            windMotion01: push,
            sootiness01: massSootiness(c.siblings),
            lf,
          });
        }
        // a flame the front has not reached yet burns nothing, and not even its bed glows
        if (ign < 0.02) continue;

        const desc = {
          x: c.x,
          y: c.y,
          radius: c.radius,
          seed: c.seed,
          intensity: clamp((f.intensity ?? 1) * clamp(Number(params?.intensity ?? 1), 0, 2), 0, 2),
          outdoor01,
          turb01: chain.turb01,
          puffHz: chain.puffHz,
          flickerAmp: chain.flickerAmp,
          heightGain: br.heightGain * infernoHeightGain(c.parentRadius, c.maxRadius),
          windX: wdir.x,
          windY: wdir.y,
          windMotion01: push,
          stress01,
          vitality01: lf.vitality * ign,
          coal01: lf.coal * ign,
          rain01: rainHere,
          // in a mass each flame only wisps; the mass as a whole makes one column (below)
          smokeMul: br.smokeMul * massSmokeKeep(c.siblings),
          sootiness01: massSootiness(c.siblings),
          spitMul: br.spitMul,
          draft: br.drafts,
          spawn: c.points,
          spawnCount: c.count,
          spawnStride: SPAWN_POINT_STRIDE,
        };
        const f0 = nf;
        const s0 = ns;
        const res = emitFireLobes(renderer.flameLobes, nf, desc, env, br.tune, renderer.smokeLobes, ns);
        nf += res.count;
        ns += res.smoke;
        coalTotal += res.coal;

        // the contour box: round every lobe this flame wrote
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        const grow = (buf, from, to) => {
          for (let i = from; i < to; i++) {
            const o = i * LOBE_STRIDE;
            const r = buf[o + 2] * Math.max(buf[o + 5], buf[o + 10], 1);
            if (buf[o] - r < minX) minX = buf[o] - r;
            if (buf[o] + r > maxX) maxX = buf[o] + r;
            if (buf[o + 1] - r < minY) minY = buf[o + 1] - r;
            if (buf[o + 1] + r > maxY) maxY = buf[o + 1] + r;
          }
        };
        grow(renderer.flameLobes, f0, nf);
        grow(renderer.smokeLobes, s0, ns);
        if (maxX > minX) {
          const sc = billowSmokeScale(pxPerWorld, c.radius);
          const bm = margin + sc.shadowOffWorld;
          boxes.push(minX - bm, minY - bm, maxX - minX + bm * 2, maxY - minY + bm * 2);
          fills.push(regionFill(c.radius * pxPerWorld));
          looks.push(sc.crescentPx, sc.shadowOffWorld);
        }
      }

      // THE COLUMN OF A BURNING MASS: one plume for the whole roof, from the middle of what burns, in the same smoke field
      for (const m of masses.values()) {
        const stat = litStats.get(m.id);
        const lit01 = stat && stat.n > 0 ? stat.sum / stat.n : 0;
        if (!stat || lit01 < 0.02 || stat.w < 1e-6 || ns + MASS_SMOKE_MAX > sCap) continue;
        const Rm = m.parentRadius * Math.sqrt(lit01);
        const s0 = ns;
        const res = emitMassSmoke(
          renderer.smokeLobes,
          ns,
          {
            x: stat.wx / stat.w,
            y: stat.wy / stat.w,
            radius: Rm,
            baseZ: m.baseZ,
            seed: m.seed,
            lit01,
            vitality01: m.lf.vitality,
            coal01: m.lf.coal,
            stress01: m.stress01,
            rain01: m.rain01,
            outdoor01: m.outdoor01,
            windX: wdir.x,
            windY: wdir.y,
            windMotion01: m.windMotion01,
            smokeMul: br.smokeMul,
            sootiness01: m.sootiness01,
          },
          env,
          br.tune
        );
        ns += res.count;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (let i = s0; i < ns; i++) {
          const o = i * LOBE_STRIDE;
          const r = renderer.smokeLobes[o + 2];
          minX = Math.min(minX, renderer.smokeLobes[o] - r);
          maxX = Math.max(maxX, renderer.smokeLobes[o] + r);
          minY = Math.min(minY, renderer.smokeLobes[o + 1] - r);
          maxY = Math.max(maxY, renderer.smokeLobes[o + 1] + r);
        }
        if (maxX > minX) {
          const sc = billowSmokeScale(pxPerWorld, Rm * 0.4);
          const bm = margin + sc.shadowOffWorld;
          boxes.push(minX - bm, minY - bm, maxX - minX + bm * 2, maxY - minY + bm * 2);
          fills.push(regionFill(m.clusterRadius * pxPerWorld));
          looks.push(sc.crescentPx, sc.shadowOffWorld);
        }
      }

      // a fire only part lit (a spreading front) lights, and spits embers, only as far as it burns
      for (const [id, stat] of litStats) {
        const lf = lifeByFire.get(id);
        if (lf && stat.n > 0 && stat.sum < stat.n) lf.vitality *= stat.sum / stat.n;
      }

      renderer.setCounts(nf, ns);
      // ONE contour box per burning mass: flames whose boxes overlap are drawn as one (the contour reads the whole field, so
      // overlapping boxes would shade the same pixels twice). A mass covers more of the screen, so the bloom fills it more.
      const merged = mergeBoxes(boxes, fills, 1.7, looks);
      const mBoxes = merged.boxes;
      const mFills = merged.fills;
      const mLooks = merged.looks;
      for (let i = 0; i < mFills.length; i++) {
        // (a group's tiles all carry the group's fill, from the group's whole bounding box, so they join without a seam)
        if (merged.members[i] > 1) {
          mFills[i] = Math.max(mFills[i], regionFill(MASS_FILL_PER_SIDE * merged.sides[i] * pxPerWorld));
        }
      }
      // (past what the renderer holds, the extras are folded into the last box)
      const maxBoxes = 64;
      let nBoxes = mBoxes.length / 4;
      if (nBoxes > maxBoxes) {
        const keep = mBoxes.slice(0, maxBoxes * 4);
        const keepFills = mFills.slice(0, maxBoxes);
        const keepLooks = mLooks.slice(0, maxBoxes * 2);
        for (let b = maxBoxes; b < nBoxes; b++) {
          keepFills[maxBoxes - 1] = Math.max(keepFills[maxBoxes - 1], mFills[b]);
          keepLooks[(maxBoxes - 1) * 2] = Math.max(keepLooks[(maxBoxes - 1) * 2], mLooks[b * 2]);
          keepLooks[(maxBoxes - 1) * 2 + 1] = Math.max(keepLooks[(maxBoxes - 1) * 2 + 1], mLooks[b * 2 + 1]);
          const x0 = mBoxes[b * 4];
          const y0 = mBoxes[b * 4 + 1];
          const x1 = x0 + mBoxes[b * 4 + 2];
          const y1 = y0 + mBoxes[b * 4 + 3];
          const lx0 = keep[(maxBoxes - 1) * 4];
          const ly0 = keep[(maxBoxes - 1) * 4 + 1];
          const lx1 = lx0 + keep[(maxBoxes - 1) * 4 + 2];
          const ly1 = ly0 + keep[(maxBoxes - 1) * 4 + 3];
          keep[(maxBoxes - 1) * 4] = Math.min(x0, lx0);
          keep[(maxBoxes - 1) * 4 + 1] = Math.min(y0, ly0);
          keep[(maxBoxes - 1) * 4 + 2] = Math.max(x1, lx1) - keep[(maxBoxes - 1) * 4];
          keep[(maxBoxes - 1) * 4 + 3] = Math.max(y1, ly1) - keep[(maxBoxes - 1) * 4 + 1];
        }
        renderer.setQuads(keep, maxBoxes, keepFills, keepLooks);
        nBoxes = maxBoxes;
      } else {
        renderer.setQuads(mBoxes, nBoxes, mFills, mLooks);
      }
      renderer.setLook({
        ...br.look,
        hue: br.hueShiftRad,
        tint: br.tint,
        smokeLinePx: billowSmokeScale(pxPerWorld, 50).linePx * (br.smokeLineWidth ?? 1),
      });
      renderer.uniforms.expectedDepth.value = Number.isFinite(ctx.expectedDepth) ? ctx.expectedDepth : 0;
      jobs = nf + ns > 0 ? renderer.prepareField(rect, { pxPerWorld, timeSec }) : [];
      renderer.scene.visible = nf + ns > 0;
      status = {
        fires: fires.length,
        clusters: clusters.length,
        flame: nf,
        smoke: ns,
        coal: coalTotal,
        dropped,
        boxes: nBoxes,
        masses: masses.size,
        quality: +minQuality.toFixed(3),
        bloomCounter: counter ? `K ${counter.K.toFixed(2)} thr ${counter.threshold} mix ${br.bloomMix}` : 'off',
      };
      return { lifeByFire, clusters };
    },

    /** The splat jobs `update` prepared; the viewer's `tickFireField` renders them. Empty when nothing is visible. */
    takeFieldJobs() {
      const j = jobs;
      jobs = [];
      return j;
    },
    getStatus: () => ({
      ...status,
      lives: lives.size(),
      lifeSummary: lives.snapshot(12),
      weather: [...weatherDiag].slice(0, 12).map(([id, v]) => ({ id, ...v })),
    }),
    dispose() {
      renderer.dispose();
    },
  };
}
