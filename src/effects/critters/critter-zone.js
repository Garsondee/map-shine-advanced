/**
 * CRITTER ZONES — a painted region, turned into something an agent can PERCEIVE.
 *
 * Pure math over a `MaskGrid`; no THREE, no GPU, Node-tested. The flies, maggots
 * and fireflies are GPU agents (`effects/particles/critter-runtime.js`) and a GPU
 * agent has no "mind" in the JavaScript sense — its whole world is whatever we
 * hand its compute kernel as numbers. This module builds that world.
 *
 * ============================================================================
 * THE PERCEPTION FIELD — four numbers per cell
 * ============================================================================
 *
 * V2 kept each swarm's area as a polygon and asked, per particle, per frame,
 * "is this point inside the polygon?" (a ray cast over every vertex, on the CPU,
 * in JavaScript, for every fly). That is O(flies × vertices) of branchy code and
 * it only ever answers yes or no. A fly that only knows "inside / outside" can
 * only bump into the edge. A fly that knows HOW FAR it is from the edge and WHICH
 * WAY is in can steer — turn back before it arrives, hug the rim, retreat to the
 * middle. So each cell of the field stores
 *
 *   x = coverage   the paint value, 0..1
 *   y = distance   SIGNED distance to the zone's edge in world px: > 0 inside,
 *                  < 0 outside, 0 exactly on the rim (a signed distance field)
 *   z, w = gradient   the unit vector pointing INTO the zone (∇distance)
 *
 * The kernel does one bilinear lookup and gets the whole local geography. The
 * distance is an EXACT Euclidean transform (Felzenszwalb–Huttenlocher, two 1D
 * passes), not a chamfer approximation: a chamfer's diagonal error is visible as
 * flies that "prefer" 45° headings along a rim.
 *
 * ⚠️ IT IS READ FROM A STORAGE BUFFER, NOT A TEXTURE. `fire-spawn-points.js`
 * records why: a texture sampled from inside a compute kernel read back EXACTLY
 * zero in this renderer while the fragment-stage overlay showed real signal at
 * the same spot. The field is therefore flat `vec4`s in one storage buffer, with
 * the per-slot "home" points appended after the cells (one buffer, two sections —
 * the arena already spends seven of the eight bindings WebGPU guarantees).
 *
 * ============================================================================
 * ZONES, POPULATIONS, HOMES
 * ============================================================================
 *
 * Painted blobs are separate ZONES (connected components). Population is per zone,
 * not per map: V2's `maxParticles` was per map-point group, so a puddle of blood
 * and a battlefield each got ten flies. `areaScaling` blends between that (0) and
 * "bigger zone, bigger swarm" (1). Slots are dealt round-robin across zones, so
 * showing the first N slots shows N / total of EVERY zone's flies — which is what
 * makes the twilight and weather fades thin all swarms evenly instead of
 * switching the last zone off first.
 *
 * Each slot gets a HOME: a point inside its zone, picked evenly along the zone's
 * Z-order curve so the homes are spatially spread without a rejection loop. V2's
 * "home" was the spawn point and its tether pulled flies back to it; here the home
 * is both where a slot (re)spawns and the centre its swarm orbits.
 *
 * @module effects/critters/critter-zone
 */

/** Floats per field cell: coverage01, signedDistancePx, gradX, gradY. */
export const ZONE_CELL_STRIDE = 4;

/** Floats per slot home: x, y, zoneIndex, zoneAreaPx2. */
export const ZONE_HOME_STRIDE = 4;

/**
 * A stand-in for "no source" in the distance transform. Finite on purpose: with
 * Infinity the parabola intersection `(f[q]+q²) − (f[p]+p²)` becomes ∞−∞ = NaN.
 * 1e12 is large against any grid (a 512-cell side squares to 2.6e5) yet small
 * enough that float64 still resolves the q² terms exactly.
 */
const EDT_INF = 1e12;

/** Default paint value (0..1) counted as "in the zone". Matches fire's spawn gate. */
export const DEFAULT_ZONE_THRESHOLD = 0.18;

/**
 * Cheap content hash of a grid (FNV-1a over every byte plus the geometry), so a
 * change of paint, of rect or of resolution all read as a different zone. The
 * caller gates this behind the mask authority's own version counter; a full
 * pass over 512² bytes is well under a millisecond.
 *
 * @param {{spec?: object, data?: Uint8Array}|null} grid
 * @returns {number} 0 for "no grid", otherwise a non-zero uint32.
 */
export function zoneGridSignature(grid) {
  const spec = grid?.spec;
  const data = grid?.data;
  if (!spec || !data) return 0;
  let h = 2166136261 >>> 0;
  const mix = (v) => {
    h ^= v | 0;
    h = Math.imul(h, 16777619) >>> 0;
  };
  mix(spec.w);
  mix(spec.h);
  mix(Math.round((spec.x ?? 0) * 8));
  mix(Math.round((spec.y ?? 0) * 8));
  mix(Math.round((spec.width ?? 0) * 8));
  mix(Math.round((spec.height ?? 0) * 8));
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h === 0 ? 1 : h;
}

/**
 * One 1D pass of the exact squared-distance transform (Felzenszwalb &
 * Huttenlocher 2012, "Distance Transforms of Sampled Functions", fig. 1).
 * `f` holds 0 at sources and EDT_INF elsewhere (later passes feed it partial
 * results); `out` receives the squared distance to the nearest source along the
 * line. `v`/`z` are caller-owned scratch so the 2D driver allocates once.
 *
 * @param {Float64Array} f @param {number} n @param {Float64Array} out
 * @param {Int32Array} v @param {Float64Array} z
 */
function distance1d(f, n, out, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -EDT_INF;
  z[1] = EDT_INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = EDT_INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const d = q - v[k];
    out[q] = d * d + f[v[k]];
  }
}

/**
 * Squared Euclidean distance (in CELLS) from every cell to the nearest cell whose
 * `isSource` flag is 1. Two separable passes, O(cells).
 *
 * @param {Uint8Array} isSource - cols*rows, 1 = distance 0.
 * @param {number} cols @param {number} rows
 * @returns {Float64Array} cols*rows squared distances (≥ EDT_INF/2 means "no source anywhere").
 */
function squaredDistanceField(isSource, cols, rows) {
  const out = new Float64Array(cols * rows);
  const maxSide = Math.max(cols, rows);
  const f = new Float64Array(maxSide);
  const d = new Float64Array(maxSide);
  const v = new Int32Array(maxSide);
  const z = new Float64Array(maxSide + 1);
  // Columns first: vertical distance to the nearest source in the same column.
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) f[y] = isSource[y * cols + x] ? 0 : EDT_INF;
    distance1d(f, rows, d, v, z);
    for (let y = 0; y < rows; y++) out[y * cols + x] = d[y];
  }
  // Then rows, feeding the vertical result in as the sampled function.
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) f[x] = out[y * cols + x];
    distance1d(f, cols, d, v, z);
    for (let x = 0; x < cols; x++) out[y * cols + x] = d[x];
  }
  return out;
}

/** Interleave the low 16 bits of x and y into a Z-order (Morton) key. */
function morton(x, y) {
  let m = 0;
  for (let b = 0; b < 16; b++) {
    m |= ((x >> b) & 1) << (2 * b);
    m |= ((y >> b) & 1) << (2 * b + 1);
  }
  return m >>> 0;
}

/**
 * Cell indices sorted along the Z-order curve. A 4-pass LSD radix sort, O(n):
 * a zone can be the whole 512² grid (262,144 cells) and a comparator sort of that
 * is a visible hitch on the frame a GM finishes painting.
 *
 * @param {number[]} members - field-local cell indices.
 * @param {number} cols
 * @returns {Int32Array}
 */
function sortAlongZOrder(members, cols) {
  const n = members.length;
  let a = Int32Array.from(members);
  let ka = new Uint32Array(n);
  for (let i = 0; i < n; i++) ka[i] = morton(a[i] % cols, (a[i] / cols) | 0);
  let b = new Int32Array(n);
  let kb = new Uint32Array(n);
  const bucket = new Uint32Array(256);
  for (let pass = 0; pass < 4; pass++) {
    const shift = pass * 8;
    bucket.fill(0);
    for (let i = 0; i < n; i++) bucket[(ka[i] >>> shift) & 255]++;
    let sum = 0;
    for (let c = 0; c < 256; c++) {
      const t = bucket[c];
      bucket[c] = sum;
      sum += t;
    }
    for (let i = 0; i < n; i++) {
      const d = bucket[(ka[i] >>> shift) & 255]++;
      b[d] = a[i];
      kb[d] = ka[i];
    }
    [a, b] = [b, a];
    [ka, kb] = [kb, ka];
  }
  return a;
}

/**
 * @typedef {object} ZoneInfo
 * @property {number} index - position in `field.zones`.
 * @property {number} cellCount - painted cells in this zone.
 * @property {number} areaPx2 - cellCount × cell area, world px².
 * @property {{x:number,y:number}} centroid - world px.
 * @property {{minX:number,minY:number,maxX:number,maxY:number}} bounds - world px.
 * @property {number} maxDepthPx - deepest signed distance inside the zone (≈ its half-width).
 * @property {Int32Array} cells - painted cell indices (field-local), sorted along the Z-order curve.
 */

/**
 * @typedef {object} ZoneField
 * @property {number} cols @property {number} rows - field size in cells.
 * @property {number} cellW @property {number} cellH - world px per cell.
 * @property {number} originX @property {number} originY - world px of the field's top-left corner.
 * @property {Float32Array} cells - cols*rows*{@link ZONE_CELL_STRIDE}.
 * @property {ZoneInfo[]} zones
 * @property {number} paintedCells
 * @property {number} marginPx - how far beyond the painted bounds the field extends.
 * @property {number} signature - `zoneGridSignature` of the source grid mixed with the build options.
 */

/**
 * Build the perception field for a painted grid.
 *
 * The field is CROPPED to the painted bounds plus `marginPx`, so a puddle of
 * blood on a 10,000 px map costs a few hundred cells, not the whole 512².
 *
 * @param {{spec: object, data: Uint8Array}|null} grid - `maskAuthority.getDerived(kind, floor).grid`.
 * @param {object} [opts]
 * @param {number} [opts.threshold=DEFAULT_ZONE_THRESHOLD] - paint value 0..1 that counts as zone.
 * @param {number} [opts.marginPx=256] - how far beyond the paint agents may wander (field extent only).
 * @returns {ZoneField|null} null when nothing is painted.
 */
export function buildZoneField(grid, { threshold = DEFAULT_ZONE_THRESHOLD, marginPx = 256 } = {}) {
  const spec = grid?.spec ?? null;
  const data = grid?.data ?? null;
  if (!spec || !data) return null;
  const gw = spec.w | 0;
  const gh = spec.h | 0;
  if (gw <= 0 || gh <= 0 || data.length < gw * gh) return null;
  const texelW = Number.isFinite(spec.texelW) && spec.texelW > 0 ? spec.texelW : spec.width / gw;
  const texelH = Number.isFinite(spec.texelH) && spec.texelH > 0 ? spec.texelH : spec.height / gh;
  if (!(texelW > 0) || !(texelH > 0)) return null;

  const cut = Math.max(1, Math.round(Math.min(1, Math.max(0, threshold)) * 255));

  // Painted bounds, in grid cells.
  let minX = gw;
  let minY = gh;
  let maxX = -1;
  let maxY = -1;
  let painted = 0;
  for (let y = 0; y < gh; y++) {
    const row = y * gw;
    for (let x = 0; x < gw; x++) {
      if (data[row + x] >= cut) {
        painted++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (painted === 0) return null;

  // Crop = painted bounds + margin, clamped to the grid. Two extra cells always
  // survive so the distance transform has "outside" on every side to measure from.
  const padX = Math.ceil(marginPx / texelW) + 2;
  const padY = Math.ceil(marginPx / texelH) + 2;
  const x0 = Math.max(0, minX - padX);
  const y0 = Math.max(0, minY - padY);
  const x1 = Math.min(gw - 1, maxX + padX);
  const y1 = Math.min(gh - 1, maxY + padY);
  const cols = x1 - x0 + 1;
  const rows = y1 - y0 + 1;
  const n = cols * rows;

  const inside = new Uint8Array(n);
  const outside = new Uint8Array(n);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const on = data[(y0 + y) * gw + (x0 + x)] >= cut ? 1 : 0;
      inside[y * cols + x] = on;
      outside[y * cols + x] = on ? 0 : 1;
    }
  }

  // Two transforms, one per side of the rim, then merged into one SIGNED field.
  // dIn: for an inside cell, cells to the nearest OUTSIDE cell. dOut: the mirror.
  const dIn = squaredDistanceField(outside, cols, rows);
  const dOut = squaredDistanceField(inside, cols, rows);
  const cellPx = (texelW + texelH) * 0.5;
  const capCells = (marginPx * 2) / cellPx + 4;
  const sdfCells = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (inside[i]) {
      const d = dIn[i] >= EDT_INF * 0.5 ? capCells * 4 : Math.sqrt(dIn[i]);
      sdfCells[i] = d - 0.5;
    } else {
      const d = dOut[i] >= EDT_INF * 0.5 ? capCells : Math.sqrt(dOut[i]);
      sdfCells[i] = -Math.min(capCells, d - 0.5);
    }
  }

  // Gradient by central differences on the signed distance, then normalised. At
  // the medial axis (the ridge down the middle of a blob) the two sides disagree
  // and the gradient flips — correct: that is where "which way is in" has no answer.
  const out = new Float32Array(n * ZONE_CELL_STRIDE);
  for (let y = 0; y < rows; y++) {
    const ym = y > 0 ? y - 1 : y;
    const yp = y < rows - 1 ? y + 1 : y;
    for (let x = 0; x < cols; x++) {
      const xm = x > 0 ? x - 1 : x;
      const xp = x < cols - 1 ? x + 1 : x;
      const gx = (sdfCells[y * cols + xp] - sdfCells[y * cols + xm]) / Math.max(1, xp - xm);
      const gy = (sdfCells[yp * cols + x] - sdfCells[ym * cols + x]) / Math.max(1, yp - ym);
      const len = Math.hypot(gx, gy);
      const o = (y * cols + x) * ZONE_CELL_STRIDE;
      out[o] = data[(y0 + y) * gw + (x0 + x)] / 255;
      out[o + 1] = sdfCells[y * cols + x] * cellPx;
      out[o + 2] = len > 1e-6 ? gx / len : 0;
      out[o + 3] = len > 1e-6 ? gy / len : 0;
    }
  }

  const originX = spec.x + x0 * texelW;
  const originY = spec.y + y0 * texelH;

  // Zones = 4-connected components of the painted cells.
  const label = new Int32Array(n).fill(-1);
  const zones = [];
  const stack = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (!inside[start] || label[start] !== -1) continue;
    const zi = zones.length;
    const members = [];
    let sp = 0;
    stack[sp++] = start;
    label[start] = zi;
    let sumX = 0;
    let sumY = 0;
    let zMinX = cols;
    let zMinY = rows;
    let zMaxX = -1;
    let zMaxY = -1;
    let maxDepth = 0;
    while (sp > 0) {
      const idx = stack[--sp];
      const cx = idx % cols;
      const cy = (idx / cols) | 0;
      members.push(idx);
      sumX += cx;
      sumY += cy;
      if (cx < zMinX) zMinX = cx;
      if (cx > zMaxX) zMaxX = cx;
      if (cy < zMinY) zMinY = cy;
      if (cy > zMaxY) zMaxY = cy;
      const depth = out[idx * ZONE_CELL_STRIDE + 1];
      if (depth > maxDepth) maxDepth = depth;
      if (cx > 0 && inside[idx - 1] && label[idx - 1] === -1) {
        label[idx - 1] = zi;
        stack[sp++] = idx - 1;
      }
      if (cx < cols - 1 && inside[idx + 1] && label[idx + 1] === -1) {
        label[idx + 1] = zi;
        stack[sp++] = idx + 1;
      }
      if (cy > 0 && inside[idx - cols] && label[idx - cols] === -1) {
        label[idx - cols] = zi;
        stack[sp++] = idx - cols;
      }
      if (cy < rows - 1 && inside[idx + cols] && label[idx + cols] === -1) {
        label[idx + cols] = zi;
        stack[sp++] = idx + cols;
      }
    }
    // Sorted along the Z-order curve: picking evenly spaced entries of this list
    // later gives evenly spread homes with no rejection sampling.
    const cells = sortAlongZOrder(members, cols);
    zones.push({
      index: zi,
      cellCount: cells.length,
      areaPx2: cells.length * texelW * texelH,
      centroid: {
        x: originX + (sumX / cells.length + 0.5) * texelW,
        y: originY + (sumY / cells.length + 0.5) * texelH,
      },
      bounds: {
        minX: originX + zMinX * texelW,
        minY: originY + zMinY * texelH,
        maxX: originX + (zMaxX + 1) * texelW,
        maxY: originY + (zMaxY + 1) * texelH,
      },
      maxDepthPx: maxDepth,
      cells,
    });
  }

  // The signature covers everything that changes the field: the paint, the rect
  // and the options. Two builds of the same grid with different margins are not
  // the same field and must not share a cache slot.
  let sig = zoneGridSignature(grid);
  sig = (Math.imul(sig ^ cut, 16777619) ^ Math.round(marginPx)) >>> 0;
  if (sig === 0) sig = 1;

  return {
    cols,
    rows,
    cellW: texelW,
    cellH: texelH,
    originX,
    originY,
    cells: out,
    zones,
    paintedCells: painted,
    marginPx,
    signature: sig,
  };
}

/**
 * The CPU twin of the kernel's field lookup: bilinear over the four nearest cell
 * CENTRES, edge-clamped. The shader transcribes exactly this; the lab compares
 * the two, and any disagreement is a transcription bug — not a tolerance.
 *
 * Outside the field's rectangle the clamped edge cell stands in, with the distance
 * to the rectangle subtracted from the signed distance so "farther out" still
 * reads as farther out instead of flat-lining at the margin.
 *
 * @param {ZoneField} field @param {number} x @param {number} y world px.
 * @returns {{coverage:number, distance:number, gradX:number, gradY:number}}
 */
export function sampleZoneField(field, x, y) {
  const { cols, rows, cellW, cellH, originX, originY, cells } = field;
  const u = (x - originX) / cellW - 0.5;
  const v = (y - originY) / cellH - 0.5;
  const i0 = Math.floor(u);
  const j0 = Math.floor(v);
  const fu = u - i0;
  const fv = v - j0;
  const at = (i, j, c) => {
    const ci = Math.min(cols - 1, Math.max(0, i));
    const cj = Math.min(rows - 1, Math.max(0, j));
    return cells[(cj * cols + ci) * ZONE_CELL_STRIDE + c];
  };
  const lerp2 = (c) => {
    const a = at(i0, j0, c) * (1 - fu) + at(i0 + 1, j0, c) * fu;
    const b = at(i0, j0 + 1, c) * (1 - fu) + at(i0 + 1, j0 + 1, c) * fu;
    return a * (1 - fv) + b * fv;
  };
  const overX = Math.max(0, originX - x, x - (originX + cols * cellW));
  const overY = Math.max(0, originY - y, y - (originY + rows * cellH));
  return {
    coverage: lerp2(0),
    distance: lerp2(1) - Math.hypot(overX, overY),
    gradX: lerp2(2),
    gradY: lerp2(3),
  };
}

/**
 * @typedef {object} ZonePopulation
 * @property {number} total - slots in use.
 * @property {Int32Array} counts - per zone.
 * @property {Int32Array} slotZone - zone index per slot, ROUND-ROBIN ordered.
 * @property {Int32Array} slotRank - 0-based rank of the slot within its zone.
 */

/**
 * Decide how many agents each zone gets, and deal them out round-robin.
 *
 * `n(zone) = round(perZone × lerp(1, clamp(area/refArea, 0.25, 6), areaScaling))`,
 * floored at `minPerZone` while `perZone > 0`. When the total would exceed
 * `capacity` the LARGEST zones keep their share and the rest are thinned
 * proportionally — never truncated mid-zone, which would leave one blob empty.
 *
 * @param {ZoneInfo[]} zones
 * @param {object} opts
 * @param {number} opts.perZone - agents for a reference-sized zone (0 = none).
 * @param {number} [opts.areaScaling=0.5] - 0 = every zone the same, 1 = proportional to area.
 * @param {number} [opts.refAreaPx2=40000] - the zone area that gets exactly `perZone`.
 * @param {number} [opts.capacity=1024] - hard slot ceiling.
 * @param {number} [opts.minPerZone=1]
 * @returns {ZonePopulation}
 */
export function allocateZonePopulation(
  zones,
  { perZone, areaScaling = 0.5, refAreaPx2 = 40000, capacity = 1024, minPerZone = 1 } = {}
) {
  const count = zones?.length ?? 0;
  const counts = new Int32Array(count);
  const base = Number.isFinite(perZone) ? Math.max(0, perZone) : 0;
  if (count === 0 || base <= 0 || capacity <= 0) {
    return { total: 0, counts, slotZone: new Int32Array(0), slotRank: new Int32Array(0) };
  }
  const blend = Math.min(1, Math.max(0, Number.isFinite(areaScaling) ? areaScaling : 0));
  const ref = Math.max(1, refAreaPx2);
  let total = 0;
  for (let z = 0; z < count; z++) {
    const ratio = Math.min(6, Math.max(0.25, zones[z].areaPx2 / ref));
    const n = Math.round(base * (1 + (ratio - 1) * blend));
    counts[z] = Math.max(Math.max(0, minPerZone | 0), n);
    total += counts[z];
  }
  if (total > capacity) {
    // Thin proportionally, keeping at least one in every zone that can afford one.
    const scale = capacity / total;
    total = 0;
    for (let z = 0; z < count; z++) {
      counts[z] = Math.max(0, Math.floor(counts[z] * scale));
      total += counts[z];
    }
    // Hand leftover slots to the largest zones first so rounding never wastes them.
    const bySize = [...zones].sort((a, b) => b.areaPx2 - a.areaPx2);
    for (const zone of bySize) {
      if (total >= capacity) break;
      counts[zone.index]++;
      total++;
    }
  }
  const slotZone = new Int32Array(total);
  const slotRank = new Int32Array(total);
  let maxCount = 0;
  for (let z = 0; z < count; z++) maxCount = Math.max(maxCount, counts[z]);
  let s = 0;
  for (let r = 0; r < maxCount; r++) {
    for (let z = 0; z < count; z++) {
      if (counts[z] > r) {
        slotZone[s] = z;
        slotRank[s] = r;
        s++;
      }
    }
  }
  return { total, counts, slotZone, slotRank };
}

/**
 * A deterministic [0,1) value from two integers. Not cryptographic; it only has to
 * decorrelate neighbouring slots, and it is the same on every client so a scene's
 * homes do not shuffle between reloads.
 * @param {number} a @param {number} b
 */
function hash01(a, b) {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/**
 * Give every slot a home point inside its zone.
 *
 * Slot k of a zone with n slots takes the cell at fraction (k+½)/n along the
 * zone's Z-order list, then jitters inside that cell. Z-order keeps cells that are
 * close on the curve close on the map, so evenly spaced picks are spatially
 * stratified: n homes cover the zone instead of clumping on one end of a raster.
 *
 * @param {ZoneField} field @param {ZonePopulation} population
 * @returns {Float32Array} total * {@link ZONE_HOME_STRIDE}: x, y, zoneIndex, zoneAreaPx2.
 */
export function pickSlotHomes(field, population) {
  const homes = new Float32Array(population.total * ZONE_HOME_STRIDE);
  for (let s = 0; s < population.total; s++) {
    const zone = field.zones[population.slotZone[s]];
    const n = population.counts[zone.index];
    const k = population.slotRank[s];
    const pick = Math.min(zone.cells.length - 1, Math.floor(((k + 0.5) / n) * zone.cells.length));
    const idx = zone.cells[pick];
    const cx = idx % field.cols;
    const cy = (idx / field.cols) | 0;
    const jx = hash01(zone.index * 7919 + k, 1) - 0.5;
    const jy = hash01(zone.index * 7919 + k, 2) - 0.5;
    const o = s * ZONE_HOME_STRIDE;
    homes[o] = field.originX + (cx + 0.5 + jx * 0.9) * field.cellW;
    homes[o + 1] = field.originY + (cy + 0.5 + jy * 0.9) * field.cellH;
    homes[o + 2] = zone.index;
    homes[o + 3] = zone.areaPx2;
  }
  return homes;
}

/**
 * How many `vec4` elements the shared zone buffer needs for a field of at most
 * `maxCells` cells plus the given home sections. The buffer is allocated ONCE at
 * this maximum (a storage buffer cannot be freed or grown — `particle-arena.js`),
 * and every later zone is written into it in place.
 *
 * @param {number} maxCells @param {number[]} homeCapacities
 * @returns {number}
 */
export function zoneBufferElementCount(maxCells, homeCapacities) {
  let n = Math.max(1, maxCells | 0);
  for (const c of homeCapacities) n += Math.max(0, c | 0);
  return n;
}

/**
 * Write a field's cells and a set of home sections into the flat backing array of
 * the zone storage buffer (`vec4` elements, so 4 floats each). Sections past the
 * end of `homeSections` and slots past `population.total` are zeroed, which reads
 * as "no home" (zoneIndex 0, area 0) — the kernel never reads them because those
 * slots are beyond the active count.
 *
 * @param {Float32Array} backing - the storage attribute's own `.array`.
 * @param {ZoneField|null} field - null clears the cells (no zone).
 * @param {number} maxCells - the cell capacity this buffer was allocated with.
 * @param {Array<{offset:number, capacity:number, homes:Float32Array|null}>} homeSections - `offset` in vec4 elements.
 * @returns {{cellsWritten:number, truncated:boolean}}
 */
export function packZoneBuffer(backing, field, maxCells, homeSections) {
  backing.fill(0, 0, maxCells * ZONE_CELL_STRIDE);
  let cellsWritten = 0;
  let truncated = false;
  if (field) {
    const cellCount = field.cols * field.rows;
    if (cellCount > maxCells) {
      truncated = true;
    } else {
      backing.set(field.cells, 0);
      cellsWritten = cellCount;
    }
  }
  for (const section of homeSections) {
    const start = section.offset * ZONE_HOME_STRIDE;
    backing.fill(0, start, start + section.capacity * ZONE_HOME_STRIDE);
    if (section.homes) {
      const floats = Math.min(section.homes.length, section.capacity * ZONE_HOME_STRIDE);
      backing.set(section.homes.subarray(0, floats), start);
    }
  }
  return { cellsWritten, truncated };
}
