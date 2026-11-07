/**
 * WATER SPRAY — WHERE IT IS THROWN FROM, AND WHEN (2026-11-06, mmp-7kx.1).
 *
 * The author, on the old stateless spray: *"The particles are still spawning in groups, all on the same frame, moving
 * all in the same exact direction, landing at the same exact frame, fading out at the exact same time. We need a LOT
 * more randomness."* A stateless fleck field cannot give that — every fleck of a group had to share one clock and one
 * motion so a pixel could find it. So the spray is now real particles (`effects/particles/water-spray-runtime.js`):
 * each fleck is born on its own frame, at its own spot, with its own throw, air time, arc, size and life.
 *
 * This module is the CPU half, pure JS and Node-tested:
 *
 *  1. {@link extractSprayShore} — once per mask load, from the decoded mask bytes the loader already hands back (no
 *     readback, no second decode): every HARD shore point, i.e. where deep water meets solid ground within a few
 *     texels (a quay wall, a hull, a pier). A soft painted shallows ramp never throws spray. Each point carries the
 *     unit normal pointing from the water INTO the solid face.
 *  2. {@link planSprayBirths} — every frame: how many flecks are thrown this frame (a Poisson draw, so they never come
 *     out in step), from which points (weighted by how squarely the current drives into each face), and each one's
 *     own throw.
 *
 * @module effects/water/water-spray-shore
 */

/** A mask byte at or above this is water; at or below LAND_MAX it is solid ground. */
const WATER_MIN = 160;
const LAND_MAX = 48;
/** Hard edge: deep water this many texels in from the face, solid ground this many out. */
const HARD_REACH_TEXELS = 3;
/** The most shore points kept (a uniform subsample beyond it). */
const MAX_POINTS = 60000;

/** The throw, per fleck — ranges the planner draws from. */
export const SPRAY_THROW = Object.freeze({
  /** World px/s off the face. */
  speedMin: 30,
  speedMax: 175,
  /** ± this many degrees either side of straight back off the face. */
  spreadDeg: 80,
  /** Seconds in the air. */
  airMinSec: 0.28,
  airMaxSec: 1.05,
  /** How high it arcs up the page at the top, world px. */
  apexMinPx: 4,
  apexMaxPx: 30,
  /** Dot radius, world px. */
  sizeMinPx: 0.45,
  sizeMaxPx: 1.35,
});

/**
 * Births per second per world px of face the current drives squarely into, at the default flow speed and spray 1.
 * (A 1,000 px quay wall square to a 70 px/s current throws ~550 flecks a second.)
 */
export const SPRAY_RATE_PER_PX_SEC = 0.55;
/** The flow speed the rate is calibrated at, world px/s (water's default). */
export const SPRAY_REFERENCE_FLOW_PX = 70;

/**
 * The hard shore of a decoded mask.
 * @param {Uint8Array|Uint8ClampedArray} data - the decoded mask (`mask-image.js`'s `data`): 1 byte per texel (R), or 4.
 * @param {number} width @param {number} height
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} rect - the world rect the mask covers.
 * @returns {{points: Float32Array, count: number, spacingPx: number}} points = [x, y, nx, ny] per point, world px, the
 *   normal pointing from the water into the solid face; spacingPx = world px of shore each point stands for.
 */
export function extractSprayShore(data, width, height, rect) {
  const empty = { points: new Float32Array(0), count: 0, spacingPx: 1 };
  if (!data || !(width > 0) || !(height > 0) || !rect) return empty;
  const bpp = Math.max(1, Math.round(data.length / (width * height)));
  const at = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return 0;
    return data[(y * width + x) * bpp];
  };
  const step = Math.max(2, Math.round(Math.max(width, height) / 2000));
  const wPerTx = (rect.maxX - rect.minX) / width;
  const hPerTx = (rect.maxY - rect.minY) / height;
  const out = [];
  const R = HARD_REACH_TEXELS;
  const ring = [];
  for (let k = 0; k < 8; k++) ring.push([Math.cos((k * Math.PI) / 4), Math.sin((k * Math.PI) / 4)]);
  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      if (at(x, y) < WATER_MIN) continue;
      // on the waterline: solid ground within `step` texels
      if (
        at(x + step, y) > LAND_MAX &&
        at(x - step, y) > LAND_MAX &&
        at(x, y + step) > LAND_MAX &&
        at(x, y - step) > LAND_MAX
      )
        continue;
      // which way the solid face lies: the ring of taps, weighted by how dry each is
      let gx = 0;
      let gy = 0;
      for (const [cx, cy] of ring) {
        const dry = 1 - at(Math.round(x + cx * R), Math.round(y + cy * R)) / 255;
        gx += cx * dry;
        gy += cy * dry;
      }
      const gl = Math.hypot(gx, gy);
      if (gl < 0.2) continue;
      const nx = gx / gl;
      const ny = gy / gl;
      // HARD: deep water just behind, solid ground just ahead (a soft ramp fails one or the other)
      const behind = at(Math.round(x - nx * R), Math.round(y - ny * R));
      const ahead = at(Math.round(x + nx * (R + step)), Math.round(y + ny * (R + step)));
      if (behind < 200 || ahead > LAND_MAX) continue;
      // world: the normal is scaled by the texel's aspect so a non-square mask still points the right way
      const wnx = nx * wPerTx;
      const wny = ny * hPerTx;
      const wl = Math.hypot(wnx, wny) || 1;
      out.push(rect.minX + (x + 0.5) * wPerTx, rect.minY + (y + 0.5) * hPerTx, wnx / wl, wny / wl);
    }
  }
  let count = out.length / 4;
  let keepEvery = 1;
  if (count > MAX_POINTS) keepEvery = Math.ceil(count / MAX_POINTS);
  const kept = new Float32Array(Math.ceil(count / keepEvery) * 4);
  let n = 0;
  for (let i = 0; i < count; i += keepEvery) {
    kept.set(out.slice(i * 4, i * 4 + 4), n * 4);
    n++;
  }
  count = n;
  return { points: kept, count, spacingPx: step * Math.max(wPerTx, hPerTx) * keepEvery };
}

/** Off-screen points this far outside the view still throw (a fleck flies in). */
const VIEW_MARGIN_PX = 220;

/**
 * THE IN-VIEW CANDIDATES, CACHED PER SHORE (2026-11-07). Built fresh every frame they were up to 60,000 `push`es
 * into two new arrays plus a `Math.pow` per point: ~1 MB of garbage a frame on a big harbour and a garbage-collector
 * pause every few dozen frames (the author: performance "tanked" the day the spray became real particles). Now the
 * weights are worked out only when the current's direction changes, and the weighted list only when the view
 * moves, into typed arrays the shore keeps. A still camera plans in O(births).
 * @type {WeakMap<object, {fx:number, fy:number, view:number[]|null, w:Float32Array, idx:Int32Array, cum:Float64Array, len:number, total:number}>}
 */
const candidateCache = new WeakMap();

/**
 * @param {{points: Float32Array, count: number}} shore @param {number} fx @param {number} fy
 * @param {{minX:number,minY:number,maxX:number,maxY:number}|null|undefined} v
 * @returns {{idx: Int32Array, cum: Float64Array, len: number, total: number}}
 */
function candidatesFor(shore, fx, fy, v) {
  const n = shore.count;
  let c = candidateCache.get(shore);
  if (!c || c.w.length !== n) {
    c = {
      fx: NaN,
      fy: NaN,
      view: null,
      w: new Float32Array(n),
      idx: new Int32Array(n),
      cum: new Float64Array(n),
      len: 0,
      total: 0,
    };
    candidateCache.set(shore, c);
  }
  const pts = shore.points;
  let dirty = false;
  if (c.fx !== fx || c.fy !== fy) {
    for (let i = 0; i < n; i++) {
      const into = fx * pts[i * 4 + 2] + fy * pts[i * 4 + 3];
      c.w[i] = into <= 0.05 ? 0 : Math.pow(into, 0.8);
    }
    c.fx = fx;
    c.fy = fy;
    dirty = true;
  }
  const same =
    v && c.view
      ? c.view[0] === v.minX && c.view[1] === v.minY && c.view[2] === v.maxX && c.view[3] === v.maxY
      : !v && !c.view;
  if (dirty || !same) {
    const m = VIEW_MARGIN_PX;
    let len = 0;
    let total = 0;
    for (let i = 0; i < n; i++) {
      const wi = c.w[i];
      if (wi === 0) continue;
      if (v) {
        const x = pts[i * 4];
        const y = pts[i * 4 + 1];
        if (x < v.minX - m || x > v.maxX + m || y < v.minY - m || y > v.maxY + m) continue;
      }
      total += wi;
      c.idx[len] = i;
      c.cum[len] = total;
      len++;
    }
    c.len = len;
    c.total = total;
    c.view = v ? [v.minX, v.minY, v.maxX, v.maxY] : null;
  }
  return c;
}

/**
 * This frame's births.
 * @param {{points: Float32Array, count: number, spacingPx: number}} shore - from {@link extractSprayShore}.
 * @param {object} o
 * @param {number} o.dtSec
 * @param {number[]} o.flowDir - unit [x, y], the way the current runs (`water-field.js#waterFlowVector`).
 * @param {number} o.flowSpeedPx - world px/s; 0 = still water, which throws nothing.
 * @param {number} o.spray - the author's Break spray dial (0 off, 1 default, 2 double).
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} o.view - only points near the view throw (the rest would
 *   only spend the particle budget off screen).
 * @param {number} o.maxBirths - this frame's ceiling.
 * @param {() => number} [o.random] - 0..1 (Math.random by default; a seeded one in tests).
 * @param {Array<object>} [o.out] - a list to REUSE (2026-11-07): its birth objects are overwritten in place and its
 *   length set, so a frame allocates nothing. The live caller passes one; its contents are valid until the next call.
 * @returns {Array<{x:number,y:number,vx:number,vy:number,airSec:number,apexPx:number,sizePx:number}>}
 */
export function planSprayBirths(shore, o) {
  const births = o.out ?? [];
  const pool = o.out ? (births.pooled?.length ?? 0) : 0;
  births.length = 0;
  const random = o.random ?? Math.random;
  if (!shore?.count || !(o.dtSec > 0) || !(o.spray > 0) || !(o.flowSpeedPx > 0) || !(o.maxBirths > 0)) return births;
  const fx = o.flowDir?.[0] ?? 0;
  const fy = o.flowDir?.[1] ?? 0;
  const speedK = Math.min(2.5, o.flowSpeedPx / SPRAY_REFERENCE_FLOW_PX);
  const pts = shore.points;
  // candidates in view, weighted by how squarely the current drives into the face (cached, see `candidatesFor`)
  const { idx, cum, len, total } = candidatesFor(shore, fx, fy, o.view);
  if (total <= 0 || len === 0) return births;
  const expected = total * shore.spacingPx * SPRAY_RATE_PER_PX_SEC * o.spray * speedK * o.dtSec;
  // Poisson-ish: the whole part plus a coin for the fraction, so a frame never carries a fixed batch
  let n = Math.floor(expected);
  if (random() < expected - n) n++;
  n = Math.min(n, o.maxBirths);
  const T = SPRAY_THROW;
  const spread = (T.spreadDeg * Math.PI) / 180;
  for (let b = 0; b < n; b++) {
    // pick a point by weight (binary search on the running total)
    const r = random() * total;
    let lo = 0;
    let hi = len - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const i = idx[lo];
    const px = pts[i * 4];
    const py = pts[i * 4 + 1];
    const nx = pts[i * 4 + 2];
    const ny = pts[i * 4 + 3];
    // anywhere along this point's stretch of shore, a little back on the water
    const along = (random() - 0.5) * shore.spacingPx;
    const back = random() * 5;
    const x = px - ny * along - nx * back;
    const y = py + nx * along - ny * back;
    // thrown back off the face, anywhere in a wide fan, a fast few further than most
    const a = Math.atan2(-ny, -nx) + (random() * 2 - 1) * spread;
    const u = random();
    const speed = (T.speedMin + (T.speedMax - T.speedMin) * u * u) * (0.75 + 0.25 * Math.min(speedK, 1.5));
    const airSec = T.airMinSec + (T.airMaxSec - T.airMinSec) * Math.pow(random(), 0.8);
    const apexPx = T.apexMinPx + (T.apexMaxPx - T.apexMinPx) * random() * (0.5 + 0.5 * u);
    const sizePx = T.sizeMinPx + (T.sizeMaxPx - T.sizeMinPx) * Math.pow(random(), 1.6);
    const vx = Math.cos(a) * speed;
    const vy = Math.sin(a) * speed;
    if (b < pool && births.pooled?.[b]) {
      const r = births.pooled[b];
      r.x = x;
      r.y = y;
      r.vx = vx;
      r.vy = vy;
      r.airSec = airSec;
      r.apexPx = apexPx;
      r.sizePx = sizePx;
      births.push(r);
    } else {
      const r = { x, y, vx, vy, airSec, apexPx, sizePx };
      if (o.out) (births.pooled ??= [])[b] = r;
      births.push(r);
    }
  }
  return births;
}
