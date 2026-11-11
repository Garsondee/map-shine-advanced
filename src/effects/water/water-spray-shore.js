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

// ── WAVES DECIDE WHEN (2026-11-10, mmp-78u.30.7 — Ingram: "The flecks are less convincing because they are generated so
// evenly. What we need to do instead is a 'wave' across every surface with peaks and troughs so that we get the waves
// from the water itself informing the sudden splats of whole bunch of flecks appearing at once.") ──
// A steady Poisson trickle spread over every wall reads as fizz. Now three crest trains roll across the map with the
// surface (the current plus the wind, `WATER_WIND_SURFACE_TRAVEL`'s rate), a few degrees apart so their crests cross
// and break the walls into pieces, grouped into sets by a slow envelope. A stretch of wall throws only while a crest
// is ON it: nothing for seconds, then a splat of dozens at once, sweeping along the face as an oblique crest runs down it.
// The AVERAGE rate is unchanged (normalised by `WAVE_IMPACT_MEAN`), so the Break spray dial still means what it did.

/** World px/s of drive per unit of wind (the swell's own downwind speed: 120 px/s drift × 0.5). */
export const SPRAY_WIND_DRIVE_PX = 60;
/** The crest trains: heading offset (rad), wavelength (world px), height, phase. */
const WAVE_TRAINS = Object.freeze([
  Object.freeze({ ang: 0, len: 340, amp: 1, ph: 0 }),
  Object.freeze({ ang: 0.38, len: 230, amp: 0.7, ph: 2.1 }),
  Object.freeze({ ang: -0.31, len: 520, amp: 0.85, ph: 4.4 }),
]);
/** Wave sets: the length of one group of big waves, world px. */
const WAVE_SET_PX = 2600;
/** How narrow a crest is (exponent on a raised cosine): higher = shorter, sharper splats. */
const WAVE_CREST_POWER = 10;
/** Below this crest height a wave laps without throwing. */
const WAVE_THROW_FLOOR = 0.3;

/**
 * How hard the waves hit this spot now, ≥ 0 (mean {@link WAVE_IMPACT_MEAN} over space and time).
 * @param {number} x @param {number} y - world px.
 * @param {number} t - seconds on the water's clock.
 * @param {number} dx @param {number} dy - unit heading the waves run.
 * @param {number} c - drive speed, world px/s.
 */
export function sprayWaveImpact(x, y, t, dx, dy, c) {
  return sprayWaveAt(sprayWaveFrame(t, dx, dy, c, SCRATCH_WAVE_FRAME), x, y);
}

// PERF (2026-11-11 sweep, mmp-yuu.2): `sprayWaveImpact` ran per in-view shore point per frame and re-derived every
// train's heading, speed and wavelength each time, with `Math.pow(.., 10)`: 2.5 ms of main thread on Flooded River
// Prison. The per-frame part now lives in `sprayWaveFrame` (once per frame); `sprayWaveAt` is three cosines and
// multiplies per point. Same formula, same answers (to float rounding); WAVE_CREST_POWER 10 is unrolled as q^8·q^2.
const TRAIN_CA = WAVE_TRAINS.map((w) => Math.cos(w.ang));
const TRAIN_SA = WAVE_TRAINS.map((w) => Math.sin(w.ang));
const TRAIN_CK = WAVE_TRAINS.map((w) => 0.8 * Math.sqrt(w.len / 340));
const SCRATCH_WAVE_FRAME = { a: new Float64Array(9), s: new Float64Array(3) };

/** The per-frame constants of {@link sprayWaveImpact} (phase = ax·x + ay·y + a0 per train, and the set envelope). */
export function sprayWaveFrame(t, dx, dy, c, out = { a: new Float64Array(9), s: new Float64Array(3) }) {
  const speed = Math.max(20, c);
  for (let k = 0; k < 3; k++) {
    const w = WAVE_TRAINS[k];
    const sc = (2 * Math.PI) / w.len;
    out.a[k * 3] = (dx * TRAIN_CA[k] - dy * TRAIN_SA[k]) * sc;
    out.a[k * 3 + 1] = (dx * TRAIN_SA[k] + dy * TRAIN_CA[k]) * sc;
    out.a[k * 3 + 2] = -speed * TRAIN_CK[k] * t * sc + w.ph;
  }
  const ss = (2 * Math.PI) / WAVE_SET_PX;
  out.s[0] = dx * ss;
  out.s[1] = dy * ss;
  out.s[2] = -0.5 * speed * t * ss + 1.3;
  return out;
}

/** {@link sprayWaveImpact} at one point, given this frame's {@link sprayWaveFrame}. */
export function sprayWaveAt(f, x, y) {
  const a = f.a;
  let q = 0.5 + 0.5 * Math.cos(a[0] * x + a[1] * y + a[2]);
  let q2 = q * q;
  let q8 = q2 * q2;
  q8 *= q8;
  let h = WAVE_TRAINS[0].amp * q8 * q2;
  q = 0.5 + 0.5 * Math.cos(a[3] * x + a[4] * y + a[5]);
  q2 = q * q;
  q8 = q2 * q2;
  q8 *= q8;
  h += WAVE_TRAINS[1].amp * q8 * q2;
  q = 0.5 + 0.5 * Math.cos(a[6] * x + a[7] * y + a[8]);
  q2 = q * q;
  q8 = q2 * q2;
  q8 *= q8;
  h += WAVE_TRAINS[2].amp * q8 * q2;
  const e = 0.5 + 0.5 * Math.cos(f.s[0] * x + f.s[1] * y + f.s[2]);
  const over = h * (0.3 + 0.7 * e * e) - WAVE_THROW_FLOOR;
  return over > 0 ? over * over : 0;
}

/** The mean of {@link sprayWaveImpact}, sampled once (deterministic grid over position and time). */
export const WAVE_IMPACT_MEAN = (() => {
  let s = 0;
  let n = 0;
  for (let i = 0; i < 97; i++) {
    for (let j = 0; j < 89; j++) {
      s += sprayWaveImpact(i * 53.3, j * 7.1, j * 0.731 + i * 0.37, 1, 0, 60);
      n++;
    }
  }
  return Math.max(1e-4, s / n);
})();

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
  if (!shore?.count || !(o.dtSec > 0) || !(o.spray > 0) || !(o.maxBirths > 0)) return births;
  // THE DRIVE: the current plus the wind on the surface (2026-11-10) — one vector, as the swell travels.
  const flowPx = Math.max(0, o.flowSpeedPx || 0);
  const windPx = Math.max(0, o.wind01 || 0) * SPRAY_WIND_DRIVE_PX;
  const ddx = (o.flowDir?.[0] ?? 0) * flowPx + (o.windDir?.[0] ?? 0) * windPx;
  const ddy = (o.flowDir?.[1] ?? 0) * flowPx + (o.windDir?.[1] ?? 0) * windPx;
  const drive = Math.hypot(ddx, ddy);
  if (!(drive > 0.5)) return births;
  // quantised to ~1° so a gently easing wind does not rebuild the per-point weights every frame
  const fx = Math.round((ddx / drive) * 64) / 64;
  const fy = Math.round((ddy / drive) * 64) / 64;
  const speedK = Math.min(2.5, drive / SPRAY_REFERENCE_FLOW_PX);
  const pts = shore.points;
  // candidates in view, weighted by how squarely the current drives into the face (cached, see `candidatesFor`)
  const c = candidatesFor(shore, fx, fy, o.view);
  const { idx, len, total } = c;
  if (total <= 0 || len === 0) return births;
  // THE WAVES (see `sprayWaveImpact`): each candidate's weight × how hard a crest is hitting it right now.
  const tSec = Number.isFinite(o.tSec) ? o.tSec : 0;
  if (!c.wave || c.wave.length < len) c.wave = new Float64Array(Math.max(len, 16));
  const cum = c.wave;
  let waveTotal = 0;
  const wf = sprayWaveFrame(
    tSec,
    fx,
    fy,
    drive,
    c.waveFrame ?? (c.waveFrame = { a: new Float64Array(9), s: new Float64Array(3) })
  );
  for (let j = 0; j < len; j++) {
    const i = idx[j];
    const wi = c.w[i] * sprayWaveAt(wf, pts[i * 4], pts[i * 4 + 1]);
    waveTotal += wi;
    cum[j] = waveTotal;
  }
  if (!(waveTotal > 0)) return births;
  const expected =
    (waveTotal / WAVE_IMPACT_MEAN) * shore.spacingPx * SPRAY_RATE_PER_PX_SEC * o.spray * speedK * o.dtSec;
  // Poisson-ish: the whole part plus a coin for the fraction, so a frame never carries a fixed batch
  let n = Math.floor(expected);
  if (random() < expected - n) n++;
  n = Math.min(n, o.maxBirths);
  const T = SPRAY_THROW;
  const spread = (T.spreadDeg * Math.PI) / 180;
  for (let b = 0; b < n; b++) {
    // pick a point by weight × wave impact (binary search on the running total)
    const r = random() * waveTotal;
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

// ── OPEN-WATER WHITECAPS (2026-11-10, mmp-78u.30.7 — Ingram: "Make the foam flecks spawn across the water surface as
// well as along edges.") ──
// The same crest trains as the walls (`sprayWaveImpact`), breaking on open water once the wind is up: a crest that is
// high where a slow patch field is also high throws a SPLAT, a little cluster of flecks at once, carried downwind. Dead
// calm throws none; whitecap cover rises steeply with wind (Monahan: W ∝ U^3.4), so a breeze gives the odd splat and a
// gale a sea full of them. A painted puddle is too small to matter: tries land on water by the mask, so the count
// follows how much water is in view.

/** Whitecaps begin at this wind (0..1); cover grows as ((w − onset) / (1 − onset))^WHITECAP_POWER. */
export const WHITECAP_ONSET = 0.18;
const WHITECAP_POWER = 2.2;
/** Splats per world px² per second at full cover and Break spray 1. */
export const WHITECAP_SPLATS_PER_PX2_SEC = 0.00002;
/** Flecks per splat, and how far they start from its centre, world px. */
const SPLAT_MIN = 3;
const SPLAT_MAX = 14;
const SPLAT_RADIUS_PX = 11;
/** The patch field's cell, world px: whitecaps break in patches, not along whole crest lines. */
const WHITECAP_PATCH_PX = 420;

/** Smooth value noise in 0..1, world-anchored (pure JS twin of a cheap shader noise). */
function patchNoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const h = (i, j) => {
    const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = h(xi, yi) + (h(xi + 1, yi) - h(xi, yi)) * ux;
  const b = h(xi, yi + 1) + (h(xi + 1, yi + 1) - h(xi, yi + 1)) * ux;
  return a + (b - a) * uy;
}

/** How much of the sea breaks white at this wind, 0..1. */
export function whitecapCover(wind01) {
  const t = (Math.max(0, wind01) - WHITECAP_ONSET) / (1 - WHITECAP_ONSET);
  return t <= 0 ? 0 : Math.min(1.4, Math.pow(t, WHITECAP_POWER));
}

/**
 * This frame's open-water births, APPENDED to `o.out` (the shore planner's reused list), same record shape.
 * @param {{data: Uint8Array|Uint8ClampedArray, width: number, height: number}|null} mask - the decoded `_Water` mask.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} rect - the world rect the mask covers.
 * @param {object} o - as {@link planSprayBirths}, plus the same `out`.
 * @returns {Array<object>} `o.out` (or a new list).
 */
export function planWhitecapBirths(mask, rect, o) {
  const births = o.out ?? [];
  const random = o.random ?? Math.random;
  const cover = whitecapCover(o.wind01 || 0);
  if (!mask?.data || !rect || !(cover > 0) || !(o.dtSec > 0) || !(o.spray > 0) || !(o.maxBirths > 0)) return births;
  const v = o.view ?? rect;
  const x0 = Math.max(v.minX, rect.minX);
  const y0 = Math.max(v.minY, rect.minY);
  const x1 = Math.min(v.maxX, rect.maxX);
  const y1 = Math.min(v.maxY, rect.maxY);
  if (!(x1 > x0) || !(y1 > y0)) return births;
  const { data, width, height } = mask;
  const bpp = Math.max(1, Math.round(data.length / (width * height)));
  const sx = width / (rect.maxX - rect.minX);
  const sy = height / (rect.maxY - rect.minY);
  const wet = (x, y) => {
    const tx = Math.floor((x - rect.minX) * sx);
    const ty = Math.floor((y - rect.minY) * sy);
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) return false;
    return data[(ty * width + tx) * bpp] >= WATER_MIN;
  };
  // the drive the crests run with (current + wind, as the walls), and the downwind heading the flecks are thrown along
  const flowPx = Math.max(0, o.flowSpeedPx || 0);
  const windPx = Math.max(0, o.wind01 || 0) * SPRAY_WIND_DRIVE_PX;
  const wdx = o.windDir?.[0] ?? 1;
  const wdy = o.windDir?.[1] ?? 0;
  const ddx = (o.flowDir?.[0] ?? 0) * flowPx + wdx * windPx;
  const ddy = (o.flowDir?.[1] ?? 0) * flowPx + wdy * windPx;
  const drive = Math.hypot(ddx, ddy) || 1;
  const dx = ddx / drive;
  const dy = ddy / drive;
  const t = Number.isFinite(o.tSec) ? o.tSec : 0;
  // patches drift with the surface (half the drive) and slowly re-form
  const pdx = dx * drive * 0.5 * t;
  const pdy = dy * drive * 0.5 * t;
  // Rejection: tries spread over the view; each is kept with probability ∝ crest impact × patch, so splats sit on
  // breaking crests inside patches. `ACCEPT_REF` is a high-ish impact; the try count is scaled so the kept MEAN matches.
  const area = (x1 - x0) * (y1 - y0);
  const splatsWanted = area * WHITECAP_SPLATS_PER_PX2_SEC * cover * o.spray * o.dtSec;
  const ACCEPT_REF = WAVE_IMPACT_MEAN * 6;
  const PATCH_MEAN = 0.18;
  const meanAccept = (WAVE_IMPACT_MEAN / ACCEPT_REF) * PATCH_MEAN;
  let tries = Math.min(6000, splatsWanted / meanAccept);
  let nTries = Math.floor(tries);
  if (random() < tries - nTries) nTries++;
  const spread = (70 * Math.PI) / 180;
  const base = Math.atan2(wdy, wdx);
  let budget = o.maxBirths;
  const pool = births.pooled;
  for (let k = 0; k < nTries && budget > 0; k++) {
    const x = x0 + random() * (x1 - x0);
    const y = y0 + random() * (y1 - y0);
    const pn = patchNoise((x - pdx) / WHITECAP_PATCH_PX, (y - pdy) / WHITECAP_PATCH_PX + t * 0.02);
    const patch = Math.pow(Math.max(0, (pn - 0.45) / 0.55), 2);
    if (patch <= 0) continue;
    const imp = sprayWaveImpact(x, y, t, dx, dy, drive);
    if (random() * ACCEPT_REF >= imp * patch) continue;
    if (!wet(x, y)) continue;
    // A SPLAT: a little cluster at once, each fleck its own throw
    const n = Math.min(budget, SPLAT_MIN + Math.floor(random() * (SPLAT_MAX - SPLAT_MIN + 1)));
    for (let f = 0; f < n; f++) {
      const ra = random() * 2 * Math.PI;
      const rr = SPLAT_RADIUS_PX * Math.sqrt(random());
      const bx = x + Math.cos(ra) * rr;
      const by = y + Math.sin(ra) * rr;
      const a = base + (random() * 2 - 1) * spread;
      const u = random();
      const speed = (15 + 70 * u * u) * (0.7 + 0.6 * Math.min(1.5, o.wind01 || 0));
      const airSec = 0.2 + 0.5 * Math.pow(random(), 0.9);
      const apexPx = 2 + 12 * random() * (0.5 + 0.5 * u);
      const sizePx = 0.4 + 0.75 * Math.pow(random(), 1.6);
      const rec = { x: bx, y: by, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, airSec, apexPx, sizePx };
      const slot = births.length;
      if (pool?.[slot]) Object.assign(pool[slot], rec), births.push(pool[slot]);
      else {
        if (o.out) (births.pooled ??= [])[slot] = rec;
        births.push(rec);
      }
    }
    budget -= n;
  }
  return births;
}
