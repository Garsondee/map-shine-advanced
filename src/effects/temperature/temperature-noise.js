/**
 * THE TEMPERATURE NOISE TILE — one baked, tileable RGBA8 texture that both warp
 * layers read, instead of procedural noise in the shader.
 *
 * WHY BAKED: `src/GPU-SAFETY.md` — inlined Perlin (`mx_noise_float`) is what
 * pushed a candle pipeline to a 19.7 s synchronous compile. The present draw
 * is the one material every frame needs, so its frost and ripple stay at four
 * texture taps and some arithmetic; all the shape lives here, made once on the
 * CPU the first time it is needed.
 *
 * CHANNELS:
 *   R — frost crystals: feathered fern dendrites (a stem, paired side branches
 *       at ~55°, a second generation of barbs on those), plus fine grain specks
 *       — the look of the author's reference image, frost growing on glass.
 *   G,B — the crystals' surface slope (x, y), 0.5 = flat, from a blurred copy
 *       of R: what the ice refracts the scene by.
 *   A — smooth tileable value-noise fbm (4 octaves): the ragged frost line, and
 *       the heat ripple's shimmer.
 *
 * Every stamp wraps toroidally, so the tile repeats without a seam.
 * Deterministic for a seed. Pure — no THREE (`vt/` turns it into a texture,
 * `gpu/textures-in-vt-only`).
 *
 * @module effects/temperature/temperature-noise
 */

/** Tile edge in texels. 512 keeps crystals near 1:1 at the default scale on a
 * 1080p screen (about two tiles per screen height). */
export const TEMPERATURE_NOISE_SIZE = 512;

/** A small fast seeded PRNG (mulberry32). @param {number} seed @returns {() => number} */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Tileable value-noise fbm, 0..1. Lattice periods divide `size`, so the result
 * wraps exactly.
 * @param {number} size @param {() => number} rand @returns {Float32Array}
 */
function tileableFbm(size, rand) {
  const out = new Float32Array(size * size);
  const octaves = [
    [4, 0.5],
    [8, 0.25],
    [16, 0.15],
    [32, 0.1],
  ];
  let total = 0;
  for (const [cells, amp] of octaves) {
    total += amp;
    const lattice = new Float32Array(cells * cells);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
    const cellPx = size / cells;
    for (let y = 0; y < size; y++) {
      const fy = y / cellPx;
      const y0 = Math.floor(fy);
      let ty = fy - y0;
      ty = ty * ty * (3 - 2 * ty);
      const r0 = (y0 % cells) * cells;
      const r1 = ((y0 + 1) % cells) * cells;
      for (let x = 0; x < size; x++) {
        const fx = x / cellPx;
        const x0 = Math.floor(fx);
        let tx = fx - x0;
        tx = tx * tx * (3 - 2 * tx);
        const c0 = x0 % cells;
        const c1 = (x0 + 1) % cells;
        const top = lattice[r0 + c0] + (lattice[r0 + c1] - lattice[r0 + c0]) * tx;
        const bot = lattice[r1 + c0] + (lattice[r1 + c1] - lattice[r1 + c0]) * tx;
        out[y * size + x] += (top + (bot - top) * ty) * amp;
      }
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/**
 * Draw the crystal field: fern dendrites + grain, max-composited, wrapped.
 * @param {number} size @param {() => number} rand @returns {Float32Array}
 */
function crystalField(size, rand) {
  const h = new Float32Array(size * size);
  const wrap = (v) => ((v % size) + size) % size;

  /** One anti-aliased soft disc, max-composited. */
  const stamp = (cx, cy, r, v) => {
    const reach = Math.ceil(r + 1);
    const ix = Math.floor(cx);
    const iy = Math.floor(cy);
    for (let oy = -reach; oy <= reach; oy++) {
      const py = iy + oy;
      const dy = py + 0.5 - cy;
      const row = wrap(py) * size;
      for (let ox = -reach; ox <= reach; ox++) {
        const px = ix + ox;
        const dx = px + 0.5 - cx;
        const cover = r + 0.5 - Math.sqrt(dx * dx + dy * dy);
        if (cover <= 0) continue;
        const val = v * (cover < 1 ? cover : 1);
        const i = row + wrap(px);
        if (val > h[i]) h[i] = val;
      }
    }
  };

  /** A dendrite: a gently bending stem that sprouts paired barbs as it goes. */
  const fern = (x, y, ang, len, width, depth, intensity) => {
    const step = 0.8;
    const steps = Math.ceil(len / step);
    const bend = ((rand() - 0.5) * 0.9) / Math.max(8, len);
    const spacing = Math.max(2.6, len * 0.075);
    let nextBranch = spacing * (0.5 + rand() * 0.5);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const w = Math.max(0.45, width * (1 - 0.7 * t));
      stamp(x, y, w, intensity * (1 - 0.3 * t));
      const dist = s * step;
      if (depth > 0 && dist >= nextBranch && t < 0.92) {
        nextBranch += spacing * (0.7 + 0.6 * rand());
        const barb = len * 0.42 * Math.pow(1 - t, 0.75) * (0.7 + 0.5 * rand());
        if (barb > 2) {
          const spread = 0.96 + (rand() - 0.5) * 0.3;
          fern(x, y, ang + spread, barb, w * 0.72, depth - 1, intensity * 0.85);
          fern(x, y, ang - spread, barb * (0.8 + 0.4 * rand()), w * 0.72, depth - 1, intensity * 0.85);
        }
      }
      x += Math.cos(ang) * step;
      y += Math.sin(ang) * step;
      ang += bend * step;
    }
  };

  const scale = size / 512;
  const ferns = 52;
  for (let i = 0; i < ferns; i++) {
    fern(
      rand() * size,
      rand() * size,
      rand() * Math.PI * 2,
      (55 + rand() * 100) * scale,
      (1.3 + rand() * 0.9) * scale,
      2,
      0.75 + rand() * 0.25
    );
  }
  // Grain: the fine matted frost between the ferns.
  const specks = Math.round(5000 * scale * scale);
  for (let i = 0; i < specks; i++) stamp(rand() * size, rand() * size, 0.4 + rand() * 0.7, 0.2 + rand() * 0.45);
  return h;
}

/** Wrapped 3×3 box blur. @param {Float32Array} src @param {number} size @returns {Float32Array} */
function boxBlur(src, size) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      tmp[row + x] = (src[row + ((x + size - 1) % size)] + src[row + x] + src[row + ((x + 1) % size)]) / 3;
    }
  }
  for (let y = 0; y < size; y++) {
    const up = ((y + size - 1) % size) * size;
    const row = y * size;
    const dn = ((y + 1) % size) * size;
    for (let x = 0; x < size; x++) out[row + x] = (tmp[up + x] + tmp[row + x] + tmp[dn + x]) / 3;
  }
  return out;
}

/**
 * Bake the tile.
 * @param {number} [size] - texels per edge (a power of two keeps mipmaps exact).
 * @param {number} [seed]
 * @returns {{data: Uint8Array, size: number}} RGBA8, row 0 first.
 */
export function buildTemperatureNoiseData(size = TEMPERATURE_NOISE_SIZE, seed = 0x7e3a11) {
  const rand = mulberry32(seed);
  const crystal = crystalField(size, rand);
  const smooth = tileableFbm(size, rand);
  const soft = boxBlur(boxBlur(crystal, size), size);
  const data = new Uint8Array(size * size * 4);
  const slope = 3.4;
  const byte = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));
  for (let y = 0; y < size; y++) {
    const up = ((y + size - 1) % size) * size;
    const row = y * size;
    const dn = ((y + 1) % size) * size;
    for (let x = 0; x < size; x++) {
      const i = row + x;
      const gx = soft[row + ((x + 1) % size)] - soft[row + ((x + size - 1) % size)];
      const gy = soft[dn + x] - soft[up + x];
      const o = i * 4;
      data[o] = byte(crystal[i]);
      data[o + 1] = byte(0.5 + gx * slope);
      data[o + 2] = byte(0.5 + gy * slope);
      data[o + 3] = byte(smooth[i]);
    }
  }
  return { data, size };
}
