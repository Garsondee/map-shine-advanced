/**
 * RAIN ON GLASS — THE PANE FIELD, v2: one smooth system over the whole building.
 * Pure math over byte grids; no THREE, no GPU, Node-tested. The shader (`window-rain.js`)
 * reads the two byte textures this packs; it never sees `_Outdoors`.
 *
 * ============================================================================
 * WHAT THE REAL MAPS TAUGHT (16 of the author's maps, 2026-10-19)
 * ============================================================================
 * The first version (`window-rain-flow.js`) decided direction PER CONNECTED POOL of window
 * light. On real maps that fails three ways:
 *   1. SKYLIGHTS. Bright `_Window` pixels in the middle of a building (a grid of square
 *      roof lights, a dome, a ring-shaped oculus, a sunburst) are not panes in a wall, yet a
 *      per-pool rule gave them a direction (or none, by accident of how many walls the
 *      pool's halo happened to touch). Rain on a skylight does not run toward a wall.
 *   2. MERGED POOLS. A soft glow that touches several walls was forced into one or two
 *      facets: hard seams, or "no direction" over a pool that plainly hugs a wall.
 *   3. DIAGONALS. The engine keeps only the coarsest mip of `_Outdoors` (~248 px, area
 *      averaged) and resamples it to the grid, so the mask arrives as band-limited GRAY. A
 *      45 degree chamfer or an octagonal tower's wall is a ramp of gray levels, and
 *      binarising it at 128 (what v1 did) throws away the sub-cell position of the edge: the
 *      outward direction was up to 17 degrees off on a diagonal wall.
 *
 * ============================================================================
 * THE SYSTEM
 * ============================================================================
 * Everything is a smooth field over the WHOLE grid, not per pool:
 *   - SIGNED DISTANCE from the gray mask, initialised at the sub-cell iso-contour and
 *     propagated by fast sweeping (an Eikonal solve), so its gradient is smooth and accurate
 *     for any wall angle (about 1 degree on a diagonal, against 5-9 binary).
 *   - OUTWARD DIRECTION = -grad(distance), unit, then blurred (the corner ease) and
 *     renormalised. Walls at ANY angle, curved walls and rounded corners are all just the
 *     angle of this field; there is no list of cardinal directions anywhere.
 *   - WALL-NESS (`kappa`), smooth in [0, 1]: it fades out toward the middle of a building
 *     (distance to the wall as a fraction of the local half-width, i.e. a skylight), where
 *     the outward field has no coherent direction (a ridge), and outside any building.
 *     Splats do not care; running drops and bead stretch scale with it.
 *   - FACET LEVELS: the field's angle is quantised to the angles THIS MAP's walls actually
 *     use (peaks of an angle histogram over wall-adjacent window cells, refined to the exact
 *     wall angle, with extra levels only where a curved wall needs them). The shader builds
 *     its drops in a rigid frame per level and cross-fades the two levels that bracket a
 *     cell's angle (only near the midpoint between them: elsewhere it is a single frame),
 *     so a lattice is never rotated per pixel (what tore at corners in V1/V2)
 *     and a straight diagonal wall gets its EXACT angle, not the nearest of a fixed set.
 *
 * ============================================================================
 * THE TEXTURES (both RGBA8, LINEAR, row 0 = the grid's minY, like every mask)
 * ============================================================================
 *   dirs: R,G = P, the facet level NEAREST to the cell's angle (a unit vector); B,A = S, the other level of
 *         the bracket; each encoded 0.5 + 0.5 * v. World space, +x east, +y south (screen down).
 *   aux:  R = mix (the share of S, 0 .. 0.5), G = wall-ness kappa, B = pane height, A = GATE:
 *         255 within a few cells of any window light, 0 elsewhere. The shader skips the rain
 *         where the gate is 0, so its cost follows the lit area, not the quad's bounding box.
 *   The field needs the presence grid only; `outdoors` is optional (without it every cell has
 *   kappa 0: splats and sheeting, no running drops, but still a gate).
 *
 * @module effects/window/window-rain-field
 */

import { WINDOW_ALPHA_EPSILON } from './window-cookie.js';

/** Gray at which a cell flips from building (below) to open air (above), in 0..255. */
export const RAIN_FIELD_IRIS = 127.5;

/** Window-light byte at or above which a cell counts as lit. */
export const RAIN_FIELD_PRESENCE_MIN = 24;

/** Default corner ease: how far a 90 degree corner takes to turn the flow, world px. */
export const RAIN_FIELD_DEFAULT_EASE_PX = 200; // 2026-10-19 author's Studio export (was 96)

/** The longest side, in cells, of the grid the field is derived on (see `deriveWindowRainField`). */
export const RAIN_FIELD_MAX_DIM = 256;

/** Cells the gate extends beyond the lit area (covers the lens offset and the bilinear footprint). */
export const RAIN_FIELD_GATE_CELLS = 2;

/** Depth (as a fraction of the local half-width) where a window starts, and finishes, being a skylight. */
export const RAIN_FIELD_SKY_LO = 0.55;
export const RAIN_FIELD_SKY_HI = 0.9;

/**
 * ...and the same in absolute terms, in GRID SQUARES from the nearest wall. In a hall 300 cells across the
 * relative rule alone would call a square roof light 1,000 px from any wall "near the wall". A real window's
 * light reaches a few hundred px into the room at most (the deepest on the author's maps is ~700 px), so a
 * pool further than ~6 squares from every wall is a roof light whatever the room's size.
 */
export const RAIN_FIELD_SKY_ABS_LO_SQUARES = 3;
export const RAIN_FIELD_SKY_ABS_HI_SQUARES = 6;
/** World px per grid square when the caller does not know (the author's maps are all 150). */
export const RAIN_FIELD_DEFAULT_GRID_PX = 150;

/** How far a cell that does not trust its own direction looks for reliable light to borrow from, world px. */
export const RAIN_FIELD_REACH_PX = 450;
/** The longest inward walk that measures a cell's local half-width, grid cells (a thicker mass is a skylight anyway). */
export const RAIN_FIELD_RIDGE_MAX_STEPS = 220;
/** The inward walk ends when the distance has fallen this many cells below the highest value it met. */
export const RAIN_FIELD_RIDGE_DROP = 1.5;
/** A cell stops trusting its own nearest-wall direction as its depth (fraction of the local half-width) passes these. */
export const RAIN_FIELD_RIDGE_LO = 0.35;
export const RAIN_FIELD_RIDGE_HI = 0.75;

/** The pane height reaches 1 at this distance from the wall, world px. */
export const RAIN_FIELD_PANE_HEIGHT_PX = 320;

/** Facet levels: closest allowed, widest allowed gap before filling, and the most levels kept (degrees / count). */
const LEVEL_MERGE_DEG = 10;
const LEVEL_MAX_GAP_DEG = 36;
const LEVEL_FILL_DEG = 30;
const LEVEL_MAX_COUNT = 16;
const LEVEL_PEAK_MIN_FRACTION = 0.03;
/** The A/B cross-fade spans this many degrees around the midpoint between two levels. */
const FACET_BLEND_DEG = 22;

/** Presence is pooled from the full-resolution mask with at most this many samples per cell per axis. */
const PRESENCE_SAMPLES_PER_AXIS = 8;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const RAD = Math.PI / 180;

/**
 * Signed distance from the gray mask's iso-contour, in CELLS: positive inside a building (gray below the
 * iris), negative in open air. Cells next to the contour are initialised from the gray value and the local
 * gradient (first-order sub-cell position of the edge); everything else is propagated by fast sweeping, each
 * side of the contour independently.
 *
 * @param {Uint8Array} G - `W*H` gray, 0 = building, 255 = open air.
 * @param {number} W @param {number} H
 * @returns {Float32Array}
 */
export function signedDistanceFromGray(G, W, H) {
  const N = W * H;
  const INF = 1e9;
  const d = new Float32Array(N).fill(INF);
  const inside = new Uint8Array(N);
  for (let i = 0; i < N; i++) inside[i] = G[i] < RAIN_FIELD_IRIS ? 1 : 0;
  const at = (x, y) => G[(y < 0 ? 0 : y > H - 1 ? H - 1 : y) * W + (x < 0 ? 0 : x > W - 1 ? W - 1 : x)];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const c = inside[i];
      if (
        !(
          (x > 0 && inside[i - 1] !== c) ||
          (x < W - 1 && inside[i + 1] !== c) ||
          (y > 0 && inside[i - W] !== c) ||
          (y < H - 1 && inside[i + W] !== c)
        )
      )
        continue;
      const gx = (at(x + 1, y) - at(x - 1, y)) / 2;
      const gy = (at(x, y + 1) - at(x, y - 1)) / 2;
      const gm = Math.max(1, Math.hypot(gx, gy));
      d[i] = Math.min(1, Math.abs(G[i] - RAIN_FIELD_IRIS) / gm);
    }
  }
  const sweep = (xs, xe, xd, ys, ye, yd) => {
    for (let y = ys; y !== ye; y += yd) {
      for (let x = xs; x !== xe; x += xd) {
        const i = y * W + x;
        const c = inside[i];
        let a = INF;
        let b = INF;
        if (x > 0 && inside[i - 1] === c && d[i - 1] < a) a = d[i - 1];
        if (x < W - 1 && inside[i + 1] === c && d[i + 1] < a) a = d[i + 1];
        if (y > 0 && inside[i - W] === c && d[i - W] < b) b = d[i - W];
        if (y < H - 1 && inside[i + W] === c && d[i + W] < b) b = d[i + W];
        if (a >= INF && b >= INF) continue;
        const cand = Math.abs(a - b) >= 1 ? Math.min(a, b) + 1 : (a + b + Math.sqrt(2 - (a - b) * (a - b))) / 2;
        if (cand < d[i]) d[i] = cand;
      }
    }
  };
  for (let it = 0; it < 4; it++) {
    sweep(0, W, 1, 0, H, 1);
    sweep(W - 1, -1, -1, 0, H, 1);
    sweep(W - 1, -1, -1, H - 1, -1, -1);
    sweep(0, W, 1, H - 1, -1, -1);
  }
  const sd = new Float32Array(N);
  for (let i = 0; i < N; i++) sd[i] = inside[i] ? d[i] : -d[i];
  return sd;
}

/**
 * One running-sum box blur along an axis, clamp-to-edge. In place via `tmp`. O(cells) whatever the radius.
 * @param {Float32Array} a @param {Float32Array} tmp @param {number} W @param {number} H
 * @param {number} r @param {boolean} horizontal
 */
function boxBlurAxis(a, tmp, W, H, r, horizontal) {
  const len = horizontal ? W : H;
  const lines = horizontal ? H : W;
  const step = horizontal ? 1 : W;
  const lineStride = horizontal ? W : 1;
  const inv = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const base = l * lineStride;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += a[base + (k < 0 ? 0 : k > len - 1 ? len - 1 : k) * step];
    tmp[base] = sum * inv;
    for (let i = 1; i < len; i++) {
      const add = i + r > len - 1 ? len - 1 : i + r;
      const sub = i - r - 1 < 0 ? 0 : i - r - 1;
      sum += a[base + add * step] - a[base + sub * step];
      tmp[base + i * step] = sum * inv;
    }
  }
  a.set(tmp);
}

/** Three box passes per axis approximate a Gaussian of sigma = `easeCells`. */
function blurField(a, W, H, easeCells) {
  if (!(easeCells > 0.4)) return;
  const box = Math.sqrt(4 * easeCells * easeCells + 1);
  const r = Math.min(24, Math.max(1, Math.round((box - 1) / 2)));
  const tmp = new Float32Array(a.length);
  for (let pass = 0; pass < 3; pass++) {
    boxBlurAxis(a, tmp, W, H, r, true);
    boxBlurAxis(a, tmp, W, H, r, false);
  }
}

/**
 * The height of the ridge a cell would reach: walk straight away from the cell's nearest wall (its inward
 * direction) and take the highest distance-to-wall met before it starts falling again. It is the local HALF-WIDTH
 * of the building along that line: half the room's short side in a rectangle, the gap to the courtyard in a ring,
 * the radius in a round tower. Depth as a fraction of it is 0 at a wall and 1 on the ridge, whatever the room's
 * size - and the SAME from both sides of a room, which a flood of "the highest peak reachable uphill" is not (it
 * leaks along the ridge to wherever the building is deepest). Only the gated cells are measured.
 *
 * @param {Float32Array} sd @param {Float32Array} ox @param {Float32Array} oy @param {Uint8Array} gate
 * @param {number} W @param {number} H
 * @returns {Float32Array}
 */
function inwardRidge(sd, ox, oy, gate, W, H) {
  const N = W * H;
  const rh = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const s0 = sd[i];
    if (!gate[i] || !(s0 > 0)) continue;
    const x0 = i % W;
    const y0 = (i - x0) / W;
    const dx = -ox[i];
    const dy = -oy[i];
    let px = x0;
    let py = y0;
    let peak = s0;
    for (let k = 0; k < RAIN_FIELD_RIDGE_MAX_STEPS; k++) {
      px += dx;
      py += dy;
      if (px < 0 || py < 0 || px > W - 1 || py > H - 1) break;
      const ix = Math.min(W - 2, Math.floor(px));
      const iy = Math.min(H - 2, Math.floor(py));
      const fx = px - ix;
      const fy = py - iy;
      const j = iy * W + ix;
      const s = (sd[j] * (1 - fx) + sd[j + 1] * fx) * (1 - fy) + (sd[j + W] * (1 - fx) + sd[j + W + 1] * fx) * fy;
      if (s > peak) peak = s;
      else if (s <= 0 || s < peak - RAIN_FIELD_RIDGE_DROP) break;
    }
    rh[i] = peak;
  }
  return rh;
}

/**
 * The facet levels: the angles (degrees, ascending in [0, 360)) the shader's rigid frames are built at.
 * Peaks of a circular angle histogram weighted by (window light x wall-ness), each refined to the weighted
 * circular mean of the cells around it, then widened only where a curved wall leaves a gap.
 *
 * @param {Float32Array} theta - per-cell angle, radians.
 * @param {Float32Array} weight - per-cell weight, 0 = ignore.
 * @returns {number[]}
 */
export function deriveFacetLevels(theta, weight) {
  const BINS = 360;
  const hist = new Float64Array(BINS);
  let total = 0;
  for (let i = 0; i < weight.length; i++) {
    const w = weight[i];
    if (!(w > 0)) continue;
    let a = theta[i] / RAD;
    a = ((a % 360) + 360) % 360;
    hist[Math.min(BINS - 1, Math.floor(a))] += w;
    total += w;
  }
  if (!(total > 0)) return [];

  // circular Gaussian smoothing, sigma 3 degrees
  const sm = new Float64Array(BINS);
  const kr = 9;
  const kern = [];
  for (let k = -kr; k <= kr; k++) kern.push(Math.exp(-(k * k) / 18));
  for (let b = 0; b < BINS; b++) {
    let s = 0;
    for (let k = -kr; k <= kr; k++) s += hist[(b + k + BINS) % BINS] * kern[k + kr];
    sm[b] = s;
  }
  const windowMass = (b) => {
    let m = 0;
    for (let k = -8; k <= 8; k++) m += hist[(b + k + BINS) % BINS];
    return m;
  };
  let peaks = [];
  for (let b = 0; b < BINS; b++) {
    const l = sm[(b + BINS - 1) % BINS];
    const r = sm[(b + 1) % BINS];
    if (sm[b] > 0 && sm[b] >= l && sm[b] > r && windowMass(b) >= LEVEL_PEAK_MIN_FRACTION * total)
      peaks.push({ deg: b + 0.5, mass: windowMass(b) });
  }
  // merge peaks closer than LEVEL_MERGE_DEG (keep the heavier)
  peaks.sort((p, q) => q.mass - p.mass);
  const kept = [];
  for (const p of peaks) {
    if (kept.every((k) => Math.abs(((((p.deg - k.deg) % 360) + 540) % 360) - 180) >= LEVEL_MERGE_DEG)) kept.push(p);
  }
  peaks = kept;

  // refine each peak to the weighted circular mean of the cells within 12 degrees of it
  const sx = new Float64Array(peaks.length);
  const sy = new Float64Array(peaks.length);
  for (let i = 0; i < weight.length; i++) {
    const w = weight[i];
    if (!(w > 0)) continue;
    const a = (((theta[i] / RAD) % 360) + 360) % 360;
    let bi = -1;
    let bd = 12;
    for (let k = 0; k < peaks.length; k++) {
      const dd = Math.abs(((((a - peaks[k].deg) % 360) + 540) % 360) - 180);
      if (dd < bd) {
        bd = dd;
        bi = k;
      }
    }
    if (bi >= 0) {
      sx[bi] += w * Math.cos(a * RAD);
      sy[bi] += w * Math.sin(a * RAD);
    }
  }
  let levels = peaks.map((p, k) => (sx[k] || sy[k] ? (Math.atan2(sy[k], sx[k]) / RAD + 360) % 360 : p.deg));
  levels.sort((a, b) => a - b);

  // no peaks at all (an evenly spread, curved set of walls): a regular set
  if (levels.length === 0) {
    for (let a = 0; a < 360; a += LEVEL_FILL_DEG) levels.push(a);
  } else {
    // widen only where a gap is wide AND there is real mass in it
    const filled = [...levels];
    for (let k = 0; k < levels.length; k++) {
      const a0 = levels[k];
      const a1 = k + 1 < levels.length ? levels[k + 1] : levels[0] + 360;
      const gap = a1 - a0;
      if (gap <= LEVEL_MAX_GAP_DEG) continue;
      let mass = 0;
      for (let b = Math.ceil(a0 + 1); b < a1 - 1; b++) mass += hist[((b % BINS) + BINS) % BINS];
      if (mass < 0.04 * total) continue;
      const n = Math.ceil(gap / LEVEL_FILL_DEG) - 1;
      for (let j = 1; j <= n; j++) filled.push((((a0 + (gap * j) / (n + 1)) % 360) + 360) % 360);
    }
    levels = filled.sort((a, b) => a - b);
  }
  if (levels.length > LEVEL_MAX_COUNT) {
    // keep the ones with the most mass around them
    const scored = levels
      .map((a) => ({ a, m: windowMass(Math.floor(a) % BINS) }))
      .sort((p, q) => q.m - p.m)
      .slice(0, LEVEL_MAX_COUNT);
    levels = scored.map((s) => s.a).sort((a, b) => a - b);
  }
  return levels;
}

/**
 * Block-reduce a byte grid by an integer factor: `max` keeps a thin sliver of light alive, `mean` is for the gray
 * mask. Blocks at the right/bottom edge are clipped, not padded.
 * @returns {{data:Uint8Array, w:number, h:number}}
 */
function reduceGrid(src, W, H, f, mode) {
  const w = Math.ceil(W / f);
  const h = Math.ceil(H / f);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y1 = Math.min(H, (y + 1) * f);
    for (let x = 0; x < w; x++) {
      const x1 = Math.min(W, (x + 1) * f);
      let acc = 0;
      let n = 0;
      for (let yy = y * f; yy < y1; yy++) {
        for (let xx = x * f; xx < x1; xx++) {
          const v = src[yy * W + xx];
          if (mode === 'max') {
            if (v > acc) acc = v;
          } else {
            acc += v;
          }
          n++;
        }
      }
      out[y * w + x] = mode === 'max' ? acc : Math.round(acc / n);
    }
  }
  return { data: out, w, h };
}

/**
 * Derive the pane field. The field is smooth (one direction per few hundred px), so it is derived on a grid no
 * finer than `maxDim` cells on the long side: the engine's own `_Outdoors` data is ~250 px on its long side
 * resampled to 512, and a 256 grid is 4x less work (~90 ms against ~350 on the author's maps) for the same
 * picture. The result carries its own `spec`, which is the grid the textures must be sized to.
 *
 * @param {object} args
 * @param {{spec:object, data:Uint8Array}|null} args.outdoors - the floor's `_Outdoors` grid (255 = open air), or null.
 * @param {Uint8Array} args.presence - window light bytes on the SAME grid.
 * @param {{spec?:object}} [args.spec] - the grid spec when `outdoors` is null.
 * @param {number} [args.easePx] @param {number} [args.presenceMin] @param {number} [args.gridPx]
 * @param {number} [args.maxDim] - the longest side of the grid the field is derived on, cells.
 * @param {boolean} [args.debug] - also return the intermediate fields, for pictures.
 * @returns {object|null} null when there is no window light at all.
 */
export function deriveWindowRainField(args) {
  const { outdoors, presence, spec = null, maxDim = RAIN_FIELD_MAX_DIM } = args;
  const gridSpec = outdoors?.spec ?? spec;
  if (!gridSpec || !presence) return null;
  const longSide = Math.max(gridSpec.w, gridSpec.h);
  const factor = longSide > maxDim * 1.25 ? Math.ceil(longSide / maxDim) : 1;
  if (factor === 1) return deriveOnGrid(args);
  if (presence.length !== gridSpec.w * gridSpec.h) return null;
  if (outdoors && outdoors.data.length !== gridSpec.w * gridSpec.h) return null;
  const lit = reduceGrid(presence, gridSpec.w, gridSpec.h, factor, 'max');
  const sub = {
    ...gridSpec,
    w: lit.w,
    h: lit.h,
    texelW: gridSpec.width / lit.w,
    texelH: gridSpec.height / lit.h,
  };
  const gray = outdoors ? reduceGrid(outdoors.data, gridSpec.w, gridSpec.h, factor, 'mean') : null;
  return deriveOnGrid({
    ...args,
    outdoors: gray ? { spec: sub, data: gray.data } : null,
    spec: sub,
    presence: lit.data,
  });
}

function deriveOnGrid({
  outdoors,
  presence,
  spec = null,
  easePx = RAIN_FIELD_DEFAULT_EASE_PX,
  presenceMin = RAIN_FIELD_PRESENCE_MIN,
  gridPx = RAIN_FIELD_DEFAULT_GRID_PX,
  debug = false,
}) {
  const gridSpec = outdoors?.spec ?? spec;
  if (!gridSpec || !presence) return null;
  const W = gridSpec.w;
  const H = gridSpec.h;
  const N = W * H;
  if (!(W > 1) || !(H > 1) || presence.length !== N) return null;
  if (outdoors && outdoors.data.length !== N) return null;
  const cw = gridSpec.texelW ?? gridSpec.width / W;
  const ch = gridSpec.texelH ?? gridSpec.height / H;
  const cellPx = 0.5 * (cw + ch);

  // ── the gate, and whether there is any light at all ──────────────────────
  const lit = new Uint8Array(N);
  let nLit = 0;
  for (let i = 0; i < N; i++) {
    if (presence[i] >= presenceMin) {
      lit[i] = 1;
      nLit++;
    }
  }
  if (nLit === 0) return null;
  const gate = new Uint8Array(N);
  {
    const a = Float32Array.from(lit);
    const tmp = new Float32Array(N);
    // dilate = a box blur of the 0/1 mask, anything > 0 stays on
    boxBlurAxis(a, tmp, W, H, RAIN_FIELD_GATE_CELLS, true);
    boxBlurAxis(a, tmp, W, H, RAIN_FIELD_GATE_CELLS, false);
    for (let i = 0; i < N; i++) gate[i] = a[i] > 1e-6 ? 1 : 0;
  }

  // ── geometry (only if there is a building edge to measure from) ──────────
  let sd = null;
  let ox = null;
  let oy = null;
  let mag = null;
  let depth01 = null;
  let hasGeometry = false;
  if (outdoors) {
    let nIn = 0;
    for (let i = 0; i < N; i++) if (outdoors.data[i] < RAIN_FIELD_IRIS) nIn++;
    hasGeometry = nIn > 0 && nIn < N;
  }
  if (hasGeometry) {
    sd = signedDistanceFromGray(outdoors.data, W, H);
    ox = new Float32Array(N);
    oy = new Float32Array(N);
    for (let y = 0; y < H; y++) {
      const ym = y > 0 ? y - 1 : 0;
      const yp = y < H - 1 ? y + 1 : H - 1;
      for (let x = 0; x < W; x++) {
        const xm = x > 0 ? x - 1 : 0;
        const xp = x < W - 1 ? x + 1 : W - 1;
        const gx = (sd[y * W + xp] - sd[y * W + xm]) / (xp - xm);
        const gy = (sd[yp * W + x] - sd[ym * W + x]) / (yp - ym);
        const len = Math.hypot(gx, gy);
        if (len > 1e-6) {
          ox[y * W + x] = -gx / len;
          oy[y * W + x] = -gy / len;
        }
      }
    }
    const rawX = Float32Array.from(ox);
    const rawY = Float32Array.from(oy);
    const easeCells = Math.max(0, easePx) / (2.56 * cellPx);
    blurField(ox, W, H, easeCells);
    blurField(oy, W, H, easeCells);
    mag = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const m = Math.hypot(ox[i], oy[i]);
      mag[i] = m;
      if (m > 1e-4) {
        ox[i] /= m;
        oy[i] /= m;
      } else {
        const rm = Math.hypot(rawX[i], rawY[i]);
        ox[i] = rm > 1e-6 ? rawX[i] / rm : 0;
        oy[i] = rm > 1e-6 ? rawY[i] / rm : 0;
      }
    }
    const rh = inwardRidge(sd, ox, oy, gate, W, H);
    depth01 = new Float32Array(N);
    for (let i = 0; i < N; i++) depth01[i] = sd[i] > 0 && rh[i] > 1e-3 ? clamp01(sd[i] / rh[i]) : 0;
  }

  // ── wall-ness: who is reliable, who borrows, and the final direction ─────
  // A window's light belongs to the wall it comes from, not to whichever wall is nearest at the far end of the pool:
  // a tall window's light reaches past the room's midline, where the local nearest wall is the OPPOSITE one. So:
  //   - a cell's OWN direction (`ox,oy`: the nearest wall's outward normal) is trusted by `rho` in [0,1]: high near
  //     its wall, low near the ridge, low far from any wall (a skylight), zero outside a building;
  //   - the reliable cells' vectors are carried through the lit region by a normalised convolution (a large blur of
  //     rho*presence*vector over the same of rho*presence and of presence), and an UNRELIABLE cell borrows that;
  //   - the result is one vector per cell whose LENGTH is the wall-ness kappa: 1 where a cell trusts itself, the
  //     share of nearby light that is wall-attached where it borrows, 0 where the borrowed vectors cancel (the
  //     ridge of a narrow tower, with a pane on each side) or there is nothing reliable within reach (a skylight).
  // The reach is a few grid squares, so at a corner a pool hugging the south wall keeps running south: the reach
  // only matters where a cell does NOT trust itself.
  const kappa = new Float32Array(N);
  const theta = new Float32Array(N);
  const weight = new Float32Array(N);
  const vdx = new Float32Array(N);
  const vdy = new Float32Array(N);
  const skyAbsLo = RAIN_FIELD_SKY_ABS_LO_SQUARES * gridPx;
  const skyAbsHi = RAIN_FIELD_SKY_ABS_HI_SQUARES * gridPx;
  const rho = new Float32Array(N);
  if (hasGeometry) {
    const sx = new Float32Array(N);
    const sy = new Float32Array(N);
    const sw = new Float32Array(N);
    const sa = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (!gate[i]) continue;
      const inside = smoothstep(-2, -0.5, sd[i]);
      const coherent = smoothstep(0.08, 0.5, mag[i]);
      const skyAbs = smoothstep(skyAbsLo, skyAbsHi, sd[i] * cellPx);
      const ridge = smoothstep(RAIN_FIELD_RIDGE_LO, RAIN_FIELD_RIDGE_HI, depth01[i]);
      rho[i] = inside * coherent * (1 - skyAbs) * (1 - ridge);
      const p = lit[i] ? presence[i] / 255 : 0;
      sx[i] = rho[i] * p * ox[i];
      sy[i] = rho[i] * p * oy[i];
      sw[i] = rho[i] * p;
      sa[i] = p;
    }
    const reachCells = RAIN_FIELD_REACH_PX / (2 * cellPx);
    blurField(sx, W, H, reachCells);
    blurField(sy, W, H, reachCells);
    blurField(sw, W, H, reachCells);
    blurField(sa, W, H, reachCells);
    for (let i = 0; i < N; i++) {
      if (!gate[i]) continue;
      let px = 0;
      let py = 0;
      if (sw[i] > 1e-5 && sa[i] > 1e-5) {
        const sm = Math.hypot(sx[i], sy[i]);
        if (sm > 1e-6) {
          const attached = Math.min(1, sw[i] / sa[i]);
          const coherent = smoothstep(0.1, 0.5, sm / sw[i]);
          const c = attached * coherent;
          px = (sx[i] / sm) * c;
          py = (sy[i] / sm) * c;
        }
      }
      const vx = rho[i] * ox[i] + (1 - rho[i]) * px;
      const vy = rho[i] * oy[i] + (1 - rho[i]) * py;
      const vl = Math.hypot(vx, vy);
      kappa[i] = Math.min(1, vl);
      if (vl > 1e-4) {
        vdx[i] = vx / vl;
        vdy[i] = vy / vl;
      } else {
        vdx[i] = ox[i];
        vdy[i] = oy[i];
      }
      theta[i] = Math.atan2(vdy[i], vdx[i]);
      // Only COHERENT cells say what angle a wall really is: on a straight or gently curved wall the blurred
      // direction vector keeps length ~1, in a corner's turn it shrinks. Weighting by that keeps the turn's
      // in-between angles out of the histogram (they would each spawn a spurious level).
      if (lit[i] && kappa[i] > 0.5) weight[i] = (presence[i] / 255) * kappa[i] * smoothstep(0.85, 0.98, mag[i]);
    }
  }
  const levels = hasGeometry ? deriveFacetLevels(theta, weight) : [];
  const nLevels = levels.length;

  const dirs = new Uint8Array(N * 4).fill(128);
  const aux = new Uint8Array(N * 4);
  const enc = (v) => Math.round(clamp01(0.5 + 0.5 * v) * 255);
  const levelCos = levels.map((a) => Math.cos(a * RAD));
  const levelSin = levels.map((a) => Math.sin(a * RAD));
  const paneH = new Float32Array(N);
  let kappaCells = 0;
  let skyCells = 0;
  for (let i = 0; i < N; i++) {
    if (!gate[i]) continue;
    const o = i * 4;
    // P = the NEAREST level to this cell's angle, S = the other level of the bracket, mix = S's share (0 .. 0.5).
    // Stored this way, not as "lower level, upper level, weight", because the GPU's LINEAR filter blends neighbouring
    // texels: along a straight wall the cell angle jitters a degree around the level and the lower/upper pair would
    // flip texel to texel, blending two levels 90 degrees apart into a phantom pair of frames. With P = nearest,
    // the level stays put and `mix` stays 0 there; where two cells straddle the midpoint between two levels, both
    // describe the same blend and the filter returns it.
    let mix = 0;
    let px = 0;
    let py = 1;
    let qx = 0;
    let qy = 1;
    if (nLevels > 0) {
      const a = (((theta[i] / RAD) % 360) + 360) % 360;
      // the bracketing pair: the last level at or below `a`, and the next (wrapping)
      let lo = nLevels - 1;
      for (let k = 0; k < nLevels; k++) {
        if (levels[k] <= a) lo = k;
        else break;
      }
      const hi = (lo + 1) % nLevels;
      const aLo = levels[lo];
      let aHi = levels[hi];
      let aa = a;
      if (aHi <= aLo) aHi += 360;
      if (aa < aLo) aa += 360;
      const gap = aHi - aLo;
      let near = lo;
      let far = hi;
      if (nLevels > 1 && gap > 1e-3) {
        const f = (aa - aLo) / gap;
        const bw = Math.min(0.5, Math.max(0.05, FACET_BLEND_DEG / gap));
        const w = smoothstep(0.5 - bw, 0.5 + bw, f);
        if (f < 0.5) {
          mix = w;
        } else {
          near = hi;
          far = lo;
          mix = 1 - w;
        }
      }
      px = levelCos[near];
      py = levelSin[near];
      qx = levelCos[far];
      qy = levelSin[far];
    }
    const h = hasGeometry ? clamp01((sd[i] * cellPx) / RAIN_FIELD_PANE_HEIGHT_PX) : 0.5;
    paneH[i] = h;
    dirs[o] = enc(px);
    dirs[o + 1] = enc(py);
    dirs[o + 2] = enc(qx);
    dirs[o + 3] = enc(qy);
    aux[o] = Math.round(mix * 255);
    aux[o + 1] = Math.round(kappa[i] * 255);
    aux[o + 2] = Math.round(h * 255);
    aux[o + 3] = 255;
    if (lit[i]) {
      if (kappa[i] > 0.5) kappaCells++;
      if (hasGeometry && sd[i] > 0 && (depth01[i] > RAIN_FIELD_SKY_HI || sd[i] * cellPx > skyAbsHi)) skyCells++;
    }
  }

  const field = {
    spec: gridSpec,
    dirs,
    aux,
    levels,
    stats: { litCells: nLit, directionalCells: kappaCells, skylightCells: skyCells, levels: nLevels, hasGeometry },
  };
  if (debug) field.debug = { sd, ox, oy, mag, depth01, kappa, theta, lit, gate, paneH, rho, vdx, vdy };
  return field;
}

/**
 * Bilinear sample of a packed field at a world point, the way the GPU's LINEAR filter reads it.
 * @returns {{px:number,py:number,qx:number,qy:number,mix:number,kappa:number,h:number,gate:number}}
 */
export function sampleWindowRainField(field, wx, wy) {
  const { spec, dirs, aux } = field;
  const W = spec.w;
  const H = spec.h;
  const u = ((wx - spec.x) / spec.width) * W - 0.5;
  const v = ((wy - spec.y) / spec.height) * H - 0.5;
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const out = { px: 0, py: 0, qx: 0, qy: 0, mix: 0, kappa: 0, h: 0, gate: 0 };
  const taps = [
    [x0, y0, (1 - fx) * (1 - fy)],
    [x0 + 1, y0, fx * (1 - fy)],
    [x0, y0 + 1, (1 - fx) * fy],
    [x0 + 1, y0 + 1, fx * fy],
  ];
  for (const [tx, ty, wt] of taps) {
    const cx = tx < 0 ? 0 : tx > W - 1 ? W - 1 : tx;
    const cy = ty < 0 ? 0 : ty > H - 1 ? H - 1 : ty;
    const o = (cy * W + cx) * 4;
    out.px += wt * (dirs[o] / 127.5 - 1);
    out.py += wt * (dirs[o + 1] / 127.5 - 1);
    out.qx += wt * (dirs[o + 2] / 127.5 - 1);
    out.qy += wt * (dirs[o + 3] / 127.5 - 1);
    out.mix += wt * (aux[o] / 255);
    out.kappa += wt * (aux[o + 1] / 255);
    out.h += wt * (aux[o + 2] / 255);
    out.gate += wt * (aux[o + 3] / 255);
  }
  return out;
}

/**
 * Pool the window mask's RGBA pixels down to a coarse max-presence grid on the
 * flow grid's cells. Decodes each texel the way the shader does (peak of RGB,
 * the alpha-missing fallback) so a blue-only cookie counts: the authority's own
 * derived `window` grid carries the R channel alone and would drop it.
 *
 * @param {object} args
 * @param {Uint8Array} args.data - RGBA, `width * height * 4` (`vt/mask-image.js` `rgb` mode).
 * @param {number} args.width @param {number} args.height - the image's pixel size.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} args.rect - world rect the image covers (row 0 = minY).
 * @param {{x:number,y:number,width:number,height:number,w:number,h:number}} args.spec - target grid.
 * @returns {Uint8Array|null} `spec.w * spec.h` presence bytes, or null on malformed input.
 */
export function buildWindowPresenceGrid({ data, width, height, rect, spec }) {
  if (!data || !rect || !spec) return null;
  if (!(width > 0) || !(height > 0) || data.length < width * height * 4) return null;
  const rectW = rect.maxX - rect.minX;
  const rectH = rect.maxY - rect.minY;
  if (!(rectW > 0) || !(rectH > 0)) return null;
  const gw = spec.w;
  const gh = spec.h;
  const cellW = spec.width / gw;
  const cellH = spec.height / gh;
  const out = new Uint8Array(gw * gh);
  const pxPerWorldX = width / rectW;
  const pxPerWorldY = height / rectH;
  for (let gy = 0; gy < gh; gy++) {
    const y0w = spec.y + gy * cellH;
    const py0 = Math.floor((y0w - rect.minY) * pxPerWorldY);
    const py1 = Math.ceil((y0w + cellH - rect.minY) * pxPerWorldY) - 1;
    if (py1 < 0 || py0 >= height) continue;
    const ya = Math.max(0, py0);
    const yb = Math.min(height - 1, Math.max(py1, ya));
    const sy = Math.max(1, Math.ceil((yb - ya + 1) / PRESENCE_SAMPLES_PER_AXIS));
    for (let gx = 0; gx < gw; gx++) {
      const x0w = spec.x + gx * cellW;
      const px0 = Math.floor((x0w - rect.minX) * pxPerWorldX);
      const px1 = Math.ceil((x0w + cellW - rect.minX) * pxPerWorldX) - 1;
      if (px1 < 0 || px0 >= width) continue;
      const xa = Math.max(0, px0);
      const xb = Math.min(width - 1, Math.max(px1, xa));
      const sx = Math.max(1, Math.ceil((xb - xa + 1) / PRESENCE_SAMPLES_PER_AXIS));
      let best = 0;
      for (let py = ya; py <= yb; py += sy) {
        let s = (py * width + xa) * 4;
        for (let px = xa; px <= xb; px += sx, s += sx * 4) {
          const r = data[s];
          const g = data[s + 1];
          const b = data[s + 2];
          let peak = r > g ? r : g;
          if (b > peak) peak = b;
          const a = data[s + 3] / 255;
          const gated = peak * (a < WINDOW_ALPHA_EPSILON ? 1 : a);
          if (gated > best) best = gated;
        }
      }
      out[gy * gw + gx] = best > 255 ? 255 : Math.round(best);
    }
  }
  return out;
}
