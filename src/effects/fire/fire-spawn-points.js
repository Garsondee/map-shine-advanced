/**
 * FIRE — THE SPAWN POINTS. The painted `_Fire` region becomes a flat point
 * cloud the particle kernel indexes. Pure math over a `MaskGrid`, no THREE, no
 * GPU, Node-tested.
 *
 * ============================================================================
 * WHY THE CPU DOES THIS, AND WHY THAT IS NOT A COMPROMISE
 * ============================================================================
 *
 * The obvious design is to sample the `_Fire` mask inside the compute shader and
 * spawn where it is painted. **That does not work in this renderer**, and it is
 * not a theory: `particle-runtime.js:749` records a live readback at a real
 * building coming back EXACTLY zero from a compute-stage texture sample while
 * the fragment-shader overlay showed real signal at the same spot. Cells are
 * read from a STORAGE BUFFER for that reason, and so are these.
 *
 * That is also precisely what `SPAWN_KINDS.extracted` was declared for, and the
 * schema's own words are worth keeping in view (`particle-system-schema.js:62`):
 *
 *   "`extracted` is not an optimisation, it is a bug fix." V2 found spawn points
 *   by reading pixels back off the GPU and by full-res `getImageData` scans.
 *   Roof drips went further: they *voted at runtime* between four screen→world
 *   flip combinations.
 *
 * This is that kind's first real implementation — it has been a validated string
 * with nothing behind it since the schema was written.
 *
 * ============================================================================
 * COARSE GRID, CONTINUOUS SPAWN — the jitter radius is load-bearing
 * ============================================================================
 *
 * ⚠️ THE DERIVED GRID IS FAR TOO COARSE TO SPAWN FROM DIRECTLY, AND SILENTLY SO.
 * `MASK_GRID_MAX_DIM` is 512, which over the author's 10,650 px map is ~20 world
 * px per texel — so a real 42-55 px hearth is **two or three texels**. Spawning
 * at texel centres would put every particle of that fire on two or three exact
 * points, and a fire made of three stacked sprite columns reads as broken, not
 * sparse.
 *
 * So each point carries the world radius of the texel it came from, and the
 * kernel jitters uniformly inside it. The distribution is then continuous no
 * matter how coarse the grid is — which is what lets the SILHOUETTE resolution
 * problem (`feedback_sdf_does_not_draw_the_edge`, and the reason the previous
 * volumetric attempt needed the full-res file) simply not apply here. A
 * distribution needs the mask's *density*; only an edge needs its resolution.
 *
 * @module effects/fire/fire-spawn-points
 */

/**
 * Painted-ness above which a texel can spawn fire.
 *
 * ⚠️ LOWER THAN `fire-mask.js`'s. That module answers "is there a FIRE here"
 * for placing lights and must not be fooled by a stray brush tap; this one
 * answers "may a particle be born here", where a faint edge texel legitimately
 * makes a faint particle. V2 ran three separate gates for the same reason
 * (`fireMaskMinAlpha 0.8`, `fireMaskMinBrightness 0.6`, premul > 0.2) — this is
 * their combined effect on an already-premultiplied single-channel grid.
 */
const SPAWN_THRESHOLD = 0.18;

/** Beyond this many points the cloud is SUBSAMPLED, never truncated — see below. */
const MAX_SPAWN_POINTS = 4096;

/** Floats per point in the packed buffer: x, y, brightness, jitterRadiusPx. */
export const SPAWN_POINT_STRIDE = 4;

/**
 * Extract spawn points from a painted `_Fire` grid.
 *
 * ⚠️ SUBSAMPLED EVENLY WHEN OVER CAP, NOT TRUNCATED — AND V2 GOT THIS WRONG.
 * Its scanner did `if (coords.length >= maxPoints * 3) break outer;`
 * (`fire-behaviors.js:2016`), which stops scanning mid-raster: on any map with
 * more painted texels than the cap, every fire below the cut-off row gets **no
 * spawn points at all** and simply does not burn. Nothing reports it. Taking
 * every n-th painted texel instead keeps the distribution over the whole map and
 * only thins it.
 *
 * ⚠️ THE KERNEL'S DEFAULT PICK IS UNIFORM, AND THAT IS STILL THE POINT. Brightness
 * scales the particle's life, size and heat once a point is chosen (V2's split,
 * `fire-behaviors.js:827/896`) — by default it does NOT decide which point gets
 * chosen, so spawn density follows painted AREA and intensity follows painted
 * VALUE. A brightness-weighted pick concentrates particles into the brightest
 * pixels for a hotter, tighter, visibly different fire — exactly what the author
 * asked for on 2026-08-09 as an opt-in LOOK control, not a correctness fix, which
 * is why it stays off (uniform) unless `fire-particle-runtime.js`'s `spawnBias`
 * is pushed away from zero.
 *
 * ⚠️ THAT CONTROL IS WHY THIS FUNCTION SORTS ITS OUTPUT ASCENDING BY BRIGHTNESS.
 * The kernel cannot afford a weighted-alias table (a second buffer, rebuilt every
 * mask edit); instead it warps the UNIFORM index pick with a power curve
 * (`spawnAt` in the runtime) and relies on the point list already being ordered
 * dark→bright, so "prefer high indices" and "prefer bright points" are the same
 * thing. The set of points and their positions is unchanged — only their order
 * in the buffer moves, which is why no existing test above cared.
 *
 * @param {{spec: object, data: Uint8Array}} grid - from `maskAuthority.getDerived('fire', floorIndex)`.
 * @param {object} [opts]
 * @param {number} [opts.maxPoints=MAX_SPAWN_POINTS]
 * @param {number} [opts.threshold=SPAWN_THRESHOLD] - 0..1 paint value.
 * @returns {{points: Float32Array, count: number, paintedTexels: number}}
 *   `points` is `count * SPAWN_POINT_STRIDE` long: (worldX, worldY, brightness01, jitterRadiusPx).
 */
export function extractFireSpawnPoints(grid, { maxPoints = MAX_SPAWN_POINTS, threshold = SPAWN_THRESHOLD } = {}) {
  const spec = grid?.spec ?? null;
  const data = grid?.data ?? null;
  const empty = { points: new Float32Array(0), count: 0, paintedTexels: 0 };
  if (!spec || !data) return empty;
  const w = spec.w | 0;
  const h = spec.h | 0;
  if (w <= 0 || h <= 0 || data.length < w * h) return empty;

  const cap = Math.max(1, Math.floor(Number.isFinite(maxPoints) ? maxPoints : MAX_SPAWN_POINTS));
  const cut = Math.max(0, Math.min(1, Number.isFinite(threshold) ? threshold : SPAWN_THRESHOLD)) * 255;

  // Pass 1 — count, so the subsample stride can be chosen before allocating.
  let painted = 0;
  for (let i = 0; i < w * h; i++) if (data[i] >= cut) painted++;
  if (painted === 0) return empty;

  const texelW = Number.isFinite(spec.texelW) && spec.texelW > 0 ? spec.texelW : spec.width / w;
  const texelH = Number.isFinite(spec.texelH) && spec.texelH > 0 ? spec.texelH : spec.height / h;
  if (!(texelW > 0) || !(texelH > 0)) return empty;
  // Half the texel, so a jitter of ±this covers exactly the texel's own area
  // and neighbouring points tile the region without gaps or double-density.
  const jitterRadiusPx = Math.max(texelW, texelH) * 0.5;

  // ⚠️ A FRACTIONAL ACCUMULATOR, NOT AN INTEGER STRIDE (2026-08-13 — the
  // "density cliff" this replaces). `Math.ceil(painted / cap)` jumps by whole
  // integers, so crossing ONE painted texel past a multiple of `cap` could
  // DOUBLE the stride and roughly HALVE the spawned count outright: at
  // cap=4096, painted=4096 kept every texel (stride 1, count 4096); painted=
  // 4097 jumped stride to 2, dropping count to 2049 — a ~50% cliff from one
  // extra painted pixel, and it repeated at every multiple of cap. `keepEvery`
  // below is a FLOAT, so `count` (and therefore the spawned density) rises
  // smoothly with `painted` right up to the cap instead of sawtoothing.
  const count = Math.min(cap, painted);
  const keepEvery = painted / count;
  const points = new Float32Array(count * SPAWN_POINT_STRIDE);

  let seen = 0;
  let nextEmitAt = 0;
  let out = 0;
  for (let y = 0; y < h && out < count; y++) {
    for (let x = 0; x < w && out < count; x++) {
      const v = data[y * w + x];
      if (v < cut) continue;
      // Emit the FIRST eligible texel at or past each `keepEvery`-wide
      // bucket boundary — `count` emissions total, spread evenly across
      // every eligible texel regardless of how close `painted` sits to `cap`.
      if (seen < nextEmitAt) {
        seen++;
        continue;
      }
      nextEmitAt += keepEvery;
      seen++;
      const o = out * SPAWN_POINT_STRIDE;
      // Texel CENTRE → world. Row 0 is minY (MaskGrid's own convention) and
      // world +Y is DOWN, so there is no flip here — the camera owns the one
      // flip this renderer has (`feedback_y_flip_recurring_risk`).
      points[o] = spec.x + (x + 0.5) * texelW;
      points[o + 1] = spec.y + (y + 0.5) * texelH;
      points[o + 2] = v / 255;
      points[o + 3] = jitterRadiusPx;
      out++;
    }
  }

  // Ascending by brightness — see the header. `Array.prototype.sort` is
  // stable (ES2019+), so ties keep their raster-scan order and extraction
  // stays deterministic.
  const order = Array.from({ length: out }, (_, k) => k).sort(
    (a, b) => points[a * SPAWN_POINT_STRIDE + 2] - points[b * SPAWN_POINT_STRIDE + 2]
  );
  const sorted = new Float32Array(out * SPAWN_POINT_STRIDE);
  for (let k = 0; k < out; k++) {
    const src = order[k] * SPAWN_POINT_STRIDE;
    for (let f = 0; f < SPAWN_POINT_STRIDE; f++) sorted[k * SPAWN_POINT_STRIDE + f] = points[src + f];
  }
  return { points: sorted, count: out, paintedTexels: painted };
}

/**
 * Pull every spawn point toward the CENTRE OF MASS of the fire it belongs to —
 * "belongs to" meaning its NEAREST entry in `fires`, not one global average.
 *
 * ⚠️ NEAREST-FIRE, NOT ONE GLOBAL CENTROID, AND THAT DIFFERENCE IS THE WHOLE
 * DESIGN. `fires` already carries one entry per RIDGE PEAK from
 * `extractFiresFromMask` — a round hearth gets one, but a long painted line
 * gets a spaced ROW of them down its spine (`fire-mask.js`'s own ELONGATION
 * handling). Pulling toward the single nearest peak lets a compact hearth
 * collapse toward its own centre while a fire-line stays a line of tightened
 * clusters instead of every point on it collapsing to one spot in the middle.
 *
 * @param {{points: Float32Array, count: number}} cloud - already extracted (and
 *   brightness-sorted; irrelevant here, only x/y move).
 * @param {Array<{x:number,y:number}>} fires - from `extractFiresFromMask`.
 * @param {number} amount - lerp fraction toward the nearest fire's centre. 0 is
 *   a no-op, 1 collapses every point onto its fire's centre exactly, negative
 *   pushes points AWAY from it instead.
 * @returns {{points: Float32Array, count: number, paintedTexels?: number}} a
 *   NEW cloud — the input is never mutated, since callers may share it across
 *   several kinds with different `amount`s.
 */
export function applyCohesion(cloud, fires, amount) {
  const count = Math.max(0, Math.floor(cloud?.count ?? 0));
  if (
    !cloud?.points ||
    count === 0 ||
    !Number.isFinite(amount) ||
    amount === 0 ||
    !Array.isArray(fires) ||
    fires.length === 0
  ) {
    return cloud;
  }
  const out = new Float32Array(cloud.points.length);
  out.set(cloud.points);
  for (let i = 0; i < count; i++) {
    const o = i * SPAWN_POINT_STRIDE;
    const px = out[o];
    const py = out[o + 1];
    let bestF = fires[0];
    let bestD2 = Infinity;
    for (const f of fires) {
      const dx = px - f.x;
      const dy = py - f.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestF = f;
      }
    }
    out[o] = px + (bestF.x - px) * amount;
    out[o + 1] = py + (bestF.y - py) * amount;
  }
  return { points: out, count: cloud.count, paintedTexels: cloud.paintedTexels };
}

/**
 * A cheap integer checksum over what {@link extractFireSpawnPoints} reads, so
 * the extraction runs once per mask change rather than once per frame.
 *
 * ⚠️ SAMPLED, SO IT CAN MISS A SMALL EDIT — the same trade `fireMaskSignature`
 * documents, and the same requirement: the consumer must ALSO invalidate on the
 * mask authority's own version counter. This is a cheap "did it obviously
 * change", never a content hash (`feedback_url_keyed_cache_needs_a_content_validator`).
 *
 * @param {{spec: object, data: Uint8Array}} grid @returns {number}
 */
export function fireSpawnSignature(grid) {
  const spec = grid?.spec ?? null;
  const data = grid?.data ?? null;
  if (!spec || !data) return 0;
  let hash = 2166136261 >>> 0;
  const mix = (v) => {
    hash ^= v | 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  };
  mix(spec.w);
  mix(spec.h);
  mix(Math.round(spec.x));
  mix(Math.round(spec.y));
  mix(Math.round(spec.width));
  mix(Math.round(spec.height));
  const step = Math.max(1, Math.floor(data.length / 4096));
  let sum = 0;
  for (let i = 0; i < data.length; i += step) {
    mix(data[i]);
    sum += data[i];
  }
  mix(sum);
  return hash;
}

/**
 * Pack a point cloud into a caller-supplied `Float32Array` (a GPU storage
 * buffer's backing array), padding any unused slots with a brightness of 0.
 *
 * ⚠️ THE PAD IS NOT COSMETIC. The kernel picks an index uniformly across the
 * buffer's FULL capacity — it has no count to compare against without burning a
 * uniform read per particle — so an unwritten slot must be a legal point that
 * simply never burns. Zero brightness gives a particle zero life and zero size,
 * which the draw then skips. Leaving stale data there would spawn fire at
 * whatever the previous scene painted.
 *
 * @param {Float32Array} dest - `capacity * SPAWN_POINT_STRIDE` long.
 * @param {{points: Float32Array, count: number}} cloud
 * @param {number} capacity
 * @returns {number} how many real points were written.
 */
export function packSpawnPoints(dest, cloud, capacity) {
  const cap = Math.max(0, Math.floor(capacity));
  if (!(dest instanceof Float32Array) || dest.length < cap * SPAWN_POINT_STRIDE) return 0;
  const src = cloud?.points ?? null;
  const n = Math.min(cap, Math.max(0, Math.floor(cloud?.count ?? 0)));
  if (src && n > 0) dest.set(src.subarray(0, n * SPAWN_POINT_STRIDE), 0);
  // Everything past the real points reads as "paint of zero brightness here"
  // — through `dest.length`, NOT `cap * SPAWN_POINT_STRIDE`. `dest` is
  // documented as exactly `capacity * SPAWN_POINT_STRIDE` long, but nothing
  // above actually enforces that beyond a minimum-length check, so a caller
  // handing in a genuinely larger (pooled/oversized) buffer would otherwise
  // leave whatever it held past `cap` uncleared — a stale point from a
  // previous scene's paint, sitting past the declared capacity but still
  // inside the real buffer a shader could read.
  dest.fill(0, n * SPAWN_POINT_STRIDE, dest.length);
  return n;
}
