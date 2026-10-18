/**
 * RAIN ON GLASS — THE PANE-FLOW FIELD. Pure math over byte grids; no THREE, no
 * GPU, Node-tested. The shader (`window-rain.js`) reads the two byte textures
 * this packs; it never sees `_Outdoors`.
 *
 * ============================================================================
 * THE QUESTION THIS ANSWERS
 * ============================================================================
 * The window mask is the LIGHT on the floor, not the pane (`window-cookie.js`:
 * "no aperture, no wall, no sill"). To make rain run down the pane we have to
 * imagine the pane: the sill is at the wall the window sits in, the top of the
 * pane is the far end of the light pool, and "down" is toward the wall — which
 * is OUTWARD from the building. So the one geometric fact needed is, per window
 * pool, "which way is out?", and the painted `_Outdoors` mask (black blocks =
 * buildings) answers it.
 *
 * ============================================================================
 * WHY THIS IS NOT V2'S (OR V1'S) FIELD
 * ============================================================================
 * Both earlier attempts took a direction per PIXEL and rotated the drop lattice
 * by it. A lattice rotated by a direction that changes pixel to pixel tears
 * wherever the direction bends — exactly the corners the author wanted right.
 * Here:
 *   1. SIGNED DISTANCE to the building edge (exact EDT on both sides), so the
 *      gradient is continuous across the wall line. OUTWARD = -grad. A south
 *      window on the south wall points south whether it sits near the east end
 *      or the middle, and an L-shaped building or a courtyard just works —
 *      no centroid is ever computed, "outward from the virtual centre" falls out
 *      of the geometry.
 *   2. The unit field is BLURRED and renormalised, so across a corner diagonal
 *      (where the raw field flips 90 degrees in one cell) it turns smoothly.
 *   3. Window pools are labelled (connected components of the painted light).
 *      Each pool gets at most TWO FACETS, A and B: constant unit vectors. The
 *      shader builds its sliding drops in each facet's own rigid frame — a
 *      lattice that is rotated ONCE per facet, never per pixel — and cross-fades
 *      A and B with a per-cell weight `w` that is continuous because the blurred
 *      field is. A straight wall is one facet (w = 0); a corner pool is two; a
 *      curved wall is two facets that meet in a narrow band.
 *   4. Per cell it also records the PANE HEIGHT (0 at the sill, 1 at the far end
 *      of the pool) and a CONFIDENCE (0 = "no honest direction here": the pool
 *      sits between two opposing walls, or on the building's medial axis).
 *      Confidence 0 gets splats and no sliders.
 *
 * ============================================================================
 * THE TEXTURES (both RGBA8, LINEAR, row 0 = the grid's minY, like every mask)
 * ============================================================================
 *   dirs: R,G = facet A unit vector, B,A = facet B unit vector, each encoded
 *         0.5 + 0.5 * v. World space, +x east, +y south (screen down).
 *   aux:  R = w (0 = all A, 1 = all B), G = confidence, B = pane height, A = 255.
 * Cells outside every pool (and its 2-cell halo) hold dirs = 0.5 (a zero
 * vector) and confidence 0. The halo is replicated pool data so bilinear
 * filtering at a pool's edge never blends in a zero vector.
 *
 * @module effects/window/window-rain-flow
 */

import { squaredDistanceField } from '../../scene/index.js';
import { labelComponents } from '../fluid/fluid-net.js';
import { dilateLabels } from '../specular/specular-islands.js';
import { WINDOW_ALPHA_EPSILON } from './window-cookie.js';

/** `_Outdoors` byte at or above which a cell is open air. Matches the 0.5 the rest of the codebase thresholds at. */
export const RAIN_FLOW_OUTDOORS_EDGE = 128;

/** Window-light byte (peak RGB through the alpha rule) at or above which a cell is part of a pool. */
export const RAIN_FLOW_PRESENCE_MIN = 24;

/** Default width over which a 90 degree corner turns the flow, world px. `rainCornerEasePx` is the dial. */
export const RAIN_FLOW_DEFAULT_EASE_PX = 48;

/** Cells the pool values are replicated outward so linear filtering at a pool edge stays honest. */
export const RAIN_FLOW_HALO_CELLS = 2;

/** Facets closer together than this (radians, about 2 degrees) are one facet. */
const SINGLE_FACET_SPREAD_RAD = 0.035;

/** Two facets further apart than this start losing confidence (about 100 degrees)... */
const OPPOSED_FACETS_START_RAD = 1.75;
/** ...and have none left at this (about 160 degrees): a pool between opposing walls has no honest "down". */
const OPPOSED_FACETS_END_RAD = 2.8;

/** A pool whose median signed distance is further outside the wall line than this (cells) is not on a pane. */
const OUTSIDE_POOL_SD_CELLS = -1.5;

/** Presence is pooled from the full-resolution mask with at most this many samples per cell per axis. */
const PRESENCE_SAMPLES_PER_AXIS = 8;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

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

/**
 * One running-sum box blur along an axis, clamp-to-edge. In place via `tmp`.
 * O(cells) regardless of radius.
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
    for (let k = -r; k <= r; k++) {
      const idx = k < 0 ? 0 : k > len - 1 ? len - 1 : k;
      sum += a[base + idx * step];
    }
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

/**
 * Three box passes per axis approximate a Gaussian of sigma = `easeCells`.
 * @param {Float32Array} a @param {number} W @param {number} H @param {number} easeCells
 */
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
 * @typedef {object} RainFlowComponent
 * @property {number} label - 1-based pool id.
 * @property {number} cells - painted cells in the pool.
 * @property {{x:number,y:number}} facetA @property {{x:number,y:number}} facetB - unit vectors (+y = south).
 * @property {number} spreadRad - angle between the facets (0 for a single facet).
 * @property {number} confidence - 0..1, the pool-level part of the confidence.
 * @property {number} sdLo @property {number} sdHi - the pool's signed-distance range, cells.
 */

/**
 * @typedef {object} RainFlowField
 * @property {{x:number,y:number,width:number,height:number,w:number,h:number}} spec
 * @property {Uint8Array} dirs - `w*h*4`, see the module header.
 * @property {Uint8Array} aux - `w*h*4`, see the module header.
 * @property {RainFlowComponent[]} components
 * @property {{poolCells:number, components:number, twoFacet:number}} stats
 */

/**
 * Derive the flow field.
 *
 * @param {object} args
 * @param {{spec:object, data:Uint8Array}} args.outdoors - the floor's `_Outdoors` grid (255 = open air).
 * @param {Uint8Array} args.presence - window light bytes on the SAME grid (`buildWindowPresenceGrid`).
 * @param {number} [args.easePx] - corner ease, world px.
 * @param {number} [args.presenceMin]
 * @returns {RainFlowField|null} null when there is nothing honest to derive: no pool, or no building edge at all.
 */
export function deriveWindowRainFlow({
  outdoors,
  presence,
  easePx = RAIN_FLOW_DEFAULT_EASE_PX,
  presenceMin = RAIN_FLOW_PRESENCE_MIN,
}) {
  const spec = outdoors?.spec;
  const odata = outdoors?.data;
  if (!spec || !odata || !presence) return null;
  const W = spec.w;
  const H = spec.h;
  const N = W * H;
  if (!(W > 1) || !(H > 1) || odata.length !== N || presence.length !== N) return null;

  // ── 1. open air vs building, and the pools ───────────────────────────────
  const open = new Uint8Array(N);
  const built = new Uint8Array(N);
  let nOpen = 0;
  let nBuilt = 0;
  const present = new Uint8Array(N);
  let poolCells = 0;
  for (let i = 0; i < N; i++) {
    if (odata[i] >= RAIN_FLOW_OUTDOORS_EDGE) {
      open[i] = 1;
      nOpen++;
    } else {
      built[i] = 1;
      nBuilt++;
    }
    if (presence[i] >= presenceMin) {
      present[i] = 1;
      poolCells++;
    }
  }
  if (poolCells === 0 || nOpen === 0 || nBuilt === 0) return null;

  // ── 2. signed distance, in cells: + inside a building, - outside ─────────
  // Half a cell off the centres so the zero crossing sits ON the wall line.
  const dToOpen = squaredDistanceField(open, W, H);
  const dToBuilt = squaredDistanceField(built, W, H);
  const sd = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    sd[i] = built[i] ? Math.sqrt(dToOpen[i]) - 0.5 : -(Math.sqrt(dToBuilt[i]) - 0.5);
  }

  // ── 3. outward = -grad(sd), unit, in world orientation (+x east, +y south) ─
  const cw = spec.texelW ?? spec.width / W;
  const ch = spec.texelH ?? spec.height / H;
  const ox = new Float32Array(N);
  const oy = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    const ym = y > 0 ? y - 1 : 0;
    const yp = y < H - 1 ? y + 1 : H - 1;
    for (let x = 0; x < W; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < W - 1 ? x + 1 : W - 1;
      const gx = (sd[y * W + xp] - sd[y * W + xm]) / ((xp - xm) * cw);
      const gy = (sd[yp * W + x] - sd[ym * W + x]) / ((yp - ym) * ch);
      const len = Math.hypot(gx, gy);
      if (len > 1e-6) {
        ox[y * W + x] = -gx / len;
        oy[y * W + x] = -gy / len;
      }
    }
  }
  const rawX = Float32Array.from(ox);
  const rawY = Float32Array.from(oy);

  // ── 4. ease the corners: blur the unit vectors, renormalise ──────────────
  const meanCellPx = 0.5 * (cw + ch);
  const easeCells = Math.max(0, easePx) / (2.56 * meanCellPx); // the 10-90% width of a Gaussian step is 2.56 sigma
  blurField(ox, W, H, easeCells);
  blurField(oy, W, H, easeCells);
  const mag = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const m = Math.hypot(ox[i], oy[i]);
    mag[i] = m;
    if (m > 1e-4) {
      ox[i] /= m;
      oy[i] /= m;
    } else {
      // The blur cancelled to nothing (a ridge of opposing walls): fall back to the raw direction, mag stays ~0.
      const rm = Math.hypot(rawX[i], rawY[i]);
      ox[i] = rm > 1e-6 ? rawX[i] / rm : 0;
      oy[i] = rm > 1e-6 ? rawY[i] / rm : 0;
    }
  }

  // ── 5. pools, and each pool's facets ─────────────────────────────────────
  const { tubeId: label, sizes } = labelComponents(present, W, H);
  const K = sizes.length;
  const offsets = new Int32Array(K + 1);
  for (let k = 0; k < K; k++) offsets[k + 1] = offsets[k] + sizes[k];
  const fill = new Int32Array(K);
  const members = new Int32Array(offsets[K]);
  for (let i = 0; i < N; i++) {
    const l = label[i];
    if (l > 0) members[offsets[l - 1] + fill[l - 1]++] = i;
  }

  /** @type {Array<object|null>} */
  const params = new Array(K).fill(null);
  /** @type {RainFlowComponent[]} */
  const components = [];
  let twoFacet = 0;
  for (let k = 0; k < K; k++) {
    const from = offsets[k];
    const to = offsets[k + 1];
    const count = to - from;
    // Presence-weighted mean direction, and the heaviest cell as a fallback reference.
    let sumW = 0;
    let sumX = 0;
    let sumY = 0;
    let heavy = members[from];
    for (let j = from; j < to; j++) {
      const i = members[j];
      const p = presence[i] / 255;
      sumW += p;
      sumX += p * ox[i];
      sumY += p * oy[i];
      if (presence[i] > presence[heavy]) heavy = i;
    }
    let refX = sumX;
    let refY = sumY;
    let refLen = Math.hypot(refX, refY);
    if (!(refLen > 0.05 * sumW)) {
      refX = ox[heavy];
      refY = oy[heavy];
      refLen = Math.hypot(refX, refY);
    }
    // No direction anywhere in this pool (it sits entirely on a degenerate ridge): leave it splat-only.
    if (!(refLen > 1e-6)) continue;
    refX /= refLen;
    refY /= refLen;

    // Each cell's signed angle off the reference; then a 1-D weighted 2-means.
    const alpha = new Float32Array(count);
    for (let j = 0; j < count; j++) {
      const i = members[from + j];
      alpha[j] = Math.atan2(refX * oy[i] - refY * ox[i], refX * ox[i] + refY * oy[i]);
    }
    const sorted = Float32Array.from(alpha).sort();
    const pct = (q) => sorted[Math.min(count - 1, Math.max(0, Math.floor(q * (count - 1))))];
    let cA = pct(0.05);
    let cB = pct(0.95);
    let single = !(cB - cA > SINGLE_FACET_SPREAD_RAD);
    if (!single) {
      for (let iter = 0; iter < 10; iter++) {
        let wa = 0;
        let sa = 0;
        let wb = 0;
        let sb = 0;
        const mid = 0.5 * (cA + cB);
        for (let j = 0; j < count; j++) {
          const p = presence[members[from + j]] / 255;
          if (alpha[j] < mid) {
            wa += p;
            sa += p * alpha[j];
          } else {
            wb += p;
            sb += p * alpha[j];
          }
        }
        if (!(wa > 0) || !(wb > 0)) {
          single = true;
          break;
        }
        const nA = sa / wa;
        const nB = sb / wb;
        const moved = Math.abs(nA - cA) + Math.abs(nB - cB);
        cA = nA;
        cB = nB;
        if (moved < 1e-4) break;
      }
      // The 2-means centroids are pulled toward the middle by the cells in the turn itself; the facet
      // is the cluster's dominant direction, so take a quantile of each cluster biased toward its pure
      // end (the 25th / 75th percentile; sorted[] is ascending, so a cluster is a contiguous run).
      if (!single) {
        const mid = 0.5 * (cA + cB);
        let split = 0;
        while (split < count && sorted[split] < mid) split++;
        if (split === 0 || split === count) {
          single = true;
        } else {
          cA = sorted[Math.floor((split - 1) * 0.25)];
          cB = sorted[split + Math.floor((count - split - 1) * 0.75)];
        }
      }
      if (!(cB - cA > SINGLE_FACET_SPREAD_RAD)) single = true;
    }
    const rot = (a) => ({ x: refX * Math.cos(a) - refY * Math.sin(a), y: refX * Math.sin(a) + refY * Math.cos(a) });
    const facetA = single ? { x: refX, y: refY } : rot(cA);
    const facetB = single ? { x: refX, y: refY } : rot(cB);
    const spread = single ? 0 : cB - cA;
    if (!single) twoFacet++;

    // The pane's depth range: signed distance, low = at the sill.
    const sds = new Float32Array(count);
    for (let j = 0; j < count; j++) sds[j] = sd[members[from + j]];
    sds.sort();
    const sdLo = sds[Math.min(count - 1, Math.floor(0.03 * (count - 1)))];
    const sdHi = sds[Math.min(count - 1, Math.floor(0.97 * (count - 1)))];
    const sdMedian = sds[Math.floor(0.5 * (count - 1))];

    // Honest "down" needs a pane: a pool lying out in open air (median signed distance outside the wall
    // line) belongs to no building, and a pool between opposing walls has two answers. Both get none.
    const inBuilding = sdMedian >= OUTSIDE_POOL_SD_CELLS;
    const kappa = !inBuilding
      ? 0
      : single
        ? 1
        : 1 - smoothstep(OPPOSED_FACETS_START_RAD, OPPOSED_FACETS_END_RAD, spread);

    params[k] = { refX, refY, single, cA, cB, facetA, facetB, kappa, sdLo, sdHi };
    components.push({ label: k + 1, cells: count, facetA, facetB, spreadRad: spread, confidence: kappa, sdLo, sdHi });
  }

  // ── 6. per-cell values over the pools and a halo, packed ─────────────────
  const halo = dilateLabels(label, W, H, RAIN_FLOW_HALO_CELLS);
  const dirs = new Uint8Array(N * 4).fill(128);
  const aux = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) aux[i * 4 + 3] = 255;
  const enc = (v) => Math.round(clamp01(0.5 + 0.5 * v) * 255);
  for (let i = 0; i < N; i++) {
    const l = halo[i];
    if (l === 0) continue;
    const c = params[l - 1];
    if (!c) continue;
    let w = 0;
    if (!c.single) {
      const a = Math.atan2(c.refX * oy[i] - c.refY * ox[i], c.refX * ox[i] + c.refY * oy[i]);
      w = smoothstep(0, 1, (a - c.cA) / (c.cB - c.cA));
    }
    const range = c.sdHi - c.sdLo;
    const h = range >= 1 ? clamp01((sd[i] - c.sdLo) / range) : 0.5;
    const kappa = c.kappa * smoothstep(0.08, 0.5, mag[i]);
    const o = i * 4;
    dirs[o] = enc(c.facetA.x);
    dirs[o + 1] = enc(c.facetA.y);
    dirs[o + 2] = enc(c.facetB.x);
    dirs[o + 3] = enc(c.facetB.y);
    aux[o] = Math.round(w * 255);
    aux[o + 1] = Math.round(kappa * 255);
    aux[o + 2] = Math.round(h * 255);
  }

  return { spec, dirs, aux, components, stats: { poolCells, components: components.length, twoFacet } };
}

/**
 * Bilinear sample of a packed field at a world point, the way the GPU's LINEAR
 * filter reads it (texel centres at +0.5, clamp to edge). The CPU twin of the
 * shader's flow fetch; tests and the lab compare against it.
 *
 * @param {RainFlowField} field @param {number} wx @param {number} wy
 * @returns {{ax:number,ay:number,bx:number,by:number,w:number,kappa:number,h:number}}
 */
export function sampleWindowRainFlow(field, wx, wy) {
  const { spec, dirs, aux } = field;
  const W = spec.w;
  const H = spec.h;
  const u = ((wx - spec.x) / spec.width) * W - 0.5;
  const v = ((wy - spec.y) / spec.height) * H - 0.5;
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const out = { ax: 0, ay: 0, bx: 0, by: 0, w: 0, kappa: 0, h: 0 };
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
    out.ax += wt * (dirs[o] / 127.5 - 1);
    out.ay += wt * (dirs[o + 1] / 127.5 - 1);
    out.bx += wt * (dirs[o + 2] / 127.5 - 1);
    out.by += wt * (dirs[o + 3] / 127.5 - 1);
    out.w += wt * (aux[o] / 255);
    out.kappa += wt * (aux[o + 1] / 255);
    out.h += wt * (aux[o + 2] / 255);
  }
  return out;
}
