/**
 * LAMP REFLECTIONS — where the real lamps are, for the shine (2026-11-04).
 *
 * ============================================================================
 * WHY THE SHINE NEEDS A LIST OF LAMPS
 * ============================================================================
 * The author, live on 2026-11-04: *"A light can be directly above a bit of
 * metal and doesn't seem to brighten it directly downwards. The highlight
 * system might not be considering actual lights as a source of highlights."*
 *
 * She was right. The shine read `buf:scene.illum` — HOW MUCH light lands on
 * each pixel — and nothing else. It never knew WHERE a lamp is, so:
 *
 *   - the shimmer pattern was only scaled by the light, so a lamp brightened
 *     every blob inside its reach evenly, with nothing gathered under it;
 *   - the camera highlight (`specular-render.js`, THE EYE) guessed the lamp's
 *     direction from the light buffer's slope and pinned it at a fixed
 *     elevation (`LAMP_ELEVATION_Z`, ~58° up). Right under a lamp that slope is
 *     zero, so the guess fell back to a fixed top-left key: the one spot where a
 *     real reflection is brightest got ~0.2% of a highlight
 *     (`pow(0.9617, 160)`, measured in the tests below).
 *
 * A reflection is an IMAGE of the light, and an image needs the light's place:
 * flat metal straight below a lamp, seen from a camera above, is exactly the
 * mirror angle (the half vector between "to lamp" and "to eye" points straight
 * up, along the metal's normal). So the light pool now hands the shine a small
 * table of the lamps near the view, and the shader adds one reflection lobe per
 * lamp. HOW BRIGHT the reflection is still comes from the real light buffer —
 * walls, darkness regions, a candle's flicker, a lamp's own colour all reach it
 * that way — the table only says where each reflection sits and how it is
 * shaped.
 *
 * ============================================================================
 * THE TABLE (a 1-row RGBA32F texture, two texels per lamp)
 * ============================================================================
 *   texel 2i     = (x, y, reach, bright)     world px; reach = Foundry's dim radius, bright its bright one
 *   texel 2i + 1 = (height, weight, 0, 0)    lamp height px; weight 0 = empty slot
 *
 * Reach sits in the FIRST texel so the shader can test "does this lamp reach me" with one
 * read and skip the rest of the lamp (2026-11-04 bench: 24 lamps over all-metal 1080p cost
 * 2.1 ms evaluated in full; a pixel is inside only one to three lamps' reach).
 *
 * Every slot is read every time (a fixed-count shader loop — this renderer's
 * proven-safe loop shape, `window-room-light.js`), so an empty slot must
 * contribute exactly nothing: reach 0 makes its falloff 0 and its weight is 0.
 *
 * This module is plain JS, imported by the viewer (packing) and by the tests
 * (the CPU twin of the shader's lobe), never by anything that needs THREE.
 *
 * @module effects/specular/specular-lamps
 */

/** Lamps the shine considers at once. The nearest to the view win. */
export const SPECULAR_LAMP_MAX = 24;
/** Texels per lamp in the table. */
export const SPECULAR_LAMP_TEXELS = 2;
/** Width of the lamp table texture (it is one row tall). */
export const SPECULAR_LAMP_TABLE_WIDTH = SPECULAR_LAMP_MAX * SPECULAR_LAMP_TEXELS;
/**
 * How high a lamp hangs above its floor, in grid squares. Foundry stores no
 * mounting height for a light (its `elevation` is the floor band it belongs
 * to), so every lamp is treated as a sconce or hanging lamp about one and a
 * half squares up. The height sets how far from the lamp's foot the reflection
 * reaches; `lampSize` (the card dial) scales that, so this is a scale, not a
 * look.
 */
export const SPECULAR_LAMP_HEIGHT_GRID = 1.5;
/** Never lower than this, whatever the grid. */
export const SPECULAR_LAMP_MIN_HEIGHT_PX = 24;
/** A lamp this far outside the view (beyond its own reach) can still light the edge of it. */
export const SPECULAR_LAMP_VIEW_PAD_PX = 64;

/**
 * The lobe exponent that makes flat metal's reflection of an overhead lamp fall
 * to HALF at `size × lampHeight` from the lamp's foot (eye straight overhead).
 * For flat metal the half vector tilts by half the lamp's angle off vertical,
 * so `N·H = cos(atan(d/h) / 2)` and half-power is at `cos(atan(size)/2)^n = ½`.
 * Sizes: 0.25 → n ≈ 92 (a tight, polished spot), 0.5 → n ≈ 25.6 (the
 * default), 1 → n ≈ 8.7 (a broad satin pool).
 * @param {number} size @returns {number}
 */
export function lampLobeExponent(size) {
  const s = Math.max(0.02, Number.isFinite(size) ? size : 0.5);
  const c = Math.cos(Math.atan(s) / 2);
  return Math.log(0.5) / Math.log(c);
}

/**
 * Foundry's reach: full inside the bright radius, fading to nothing at the dim
 * radius. A smoothstep, the same curve the shader evaluates.
 * @param {number} dist @param {number} reach @param {number} bright @returns {number}
 */
export function lampFalloff(dist, reach, bright) {
  if (!(reach > 0)) return 0;
  const e0 = Math.min(Math.max(bright, 0), reach - 1);
  const e1 = Math.max(reach, e0 + 1);
  const t = Math.min(1, Math.max(0, (dist - e0) / (e1 - e0)));
  return 1 - t * t * (3 - 2 * t);
}

/**
 * A fresh table. `data` is what the texture uploads; `count` is how many slots
 * hold a lamp this frame.
 * @returns {{data: Float32Array, count: number}}
 */
export function createSpecularLampTable() {
  return { data: new Float32Array(SPECULAR_LAMP_TABLE_WIDTH * 4), count: 0 };
}

/**
 * Pick the lamps that can light the view and write them into `table`.
 *
 * A lamp qualifies when its reach overlaps the view (padded). The nearest lamps
 * to the view centre win when there are more than `SPECULAR_LAMP_MAX` — the
 * reflections a player is looking at — measured edge-first (distance minus
 * reach), so a big lamp just off screen beats a small one far across the view.
 *
 * Returns true when the table's contents changed (the caller re-uploads only
 * then).
 *
 * @param {Array<{x:number, y:number, radius:number, ratio?:number, luminosity01?:number}>} lights
 *   the light pool's sources for this frame (already filtered to the shown floor).
 * @param {{minX:number, minY:number, maxX:number, maxY:number}|null} view world rect.
 * @param {{gridSizePx?: number, table: {data: Float32Array, count: number}, scratch?: object[]}} opts
 * @returns {boolean}
 */
export function packSpecularLamps(lights, view, { gridSizePx = 100, table, scratch = [] }) {
  const data = table.data;
  const before = table.count;
  scratch.length = 0;
  if (view && Array.isArray(lights)) {
    const cx = (view.minX + view.maxX) / 2;
    const cy = (view.minY + view.maxY) / 2;
    for (const light of lights) {
      const reach = Number(light?.radius);
      const x = Number(light?.x);
      const y = Number(light?.y);
      if (!(reach > 0) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      const pad = reach + SPECULAR_LAMP_VIEW_PAD_PX;
      if (x < view.minX - pad || x > view.maxX + pad || y < view.minY - pad || y > view.maxY + pad) continue;
      const rank = Math.hypot(x - cx, y - cy) - reach;
      scratch.push({ light, rank });
    }
    scratch.sort((a, b) => a.rank - b.rank);
  }
  const height = Math.max(SPECULAR_LAMP_MIN_HEIGHT_PX, (gridSizePx > 0 ? gridSizePx : 100) * SPECULAR_LAMP_HEIGHT_GRID);
  const n = Math.min(SPECULAR_LAMP_MAX, scratch.length);
  let changed = n !== before;
  const put = (i, v) => {
    if (data[i] !== v) {
      data[i] = v;
      changed = true;
    }
  };
  for (let k = 0; k < SPECULAR_LAMP_MAX; k++) {
    const a = k * 8;
    if (k < n) {
      const l = scratch[k].light;
      const reach = Number(l.radius);
      const ratio = Number.isFinite(l.ratio) ? Math.min(1, Math.max(0, l.ratio)) : 0.5;
      const lum = Number.isFinite(l.luminosity01) ? Math.min(1, Math.max(0, l.luminosity01)) : 0.5;
      put(a, Number(l.x));
      put(a + 1, Number(l.y));
      put(a + 2, reach);
      put(a + 3, reach * ratio);
      put(a + 4, height);
      // How much of the light at a pixel this lamp is, relative to the others
      // overlapping it: a dim lamp beside a bright one shares the reflection.
      put(a + 5, 0.25 + lum);
      put(a + 6, 0);
      put(a + 7, 0);
    } else {
      for (let j = 0; j < 8; j++) put(a + j, 0);
    }
  }
  table.count = n;
  scratch.length = 0;
  return changed;
}

/**
 * CPU twin of the shader's lamp loop: how well-aligned this point's metal is
 * with a reflection of the lamps that reach it, and how much lamp reach covers
 * it at all.
 *
 *   align    = Σ wᵢ·lobeᵢ / Σ wᵢ, with wᵢ = falloffᵢ × weightᵢ
 *   presence = min(Σ falloffᵢ, 1)
 *
 * @param {{x:number, y:number}} p world px (on the floor, z 0).
 * @param {{x:number, y:number, z:number}} normal unit normal ((0,0,1) = flat).
 * @param {{x:number, y:number, z:number}} eye world px.
 * @param {Float32Array} data the table.
 * @param {number} exponent `lampLobeExponent(size)`.
 * @returns {{align: number, presence: number}}
 */
export function lampReflectionAt(p, normal, eye, data, exponent) {
  let vx = eye.x - p.x;
  let vy = eye.y - p.y;
  let vz = eye.z;
  const vl = Math.hypot(vx, vy, vz) || 1;
  vx /= vl;
  vy /= vl;
  vz /= vl;
  let wSum = 0;
  let aSum = 0;
  let fSum = 0;
  for (let k = 0; k < SPECULAR_LAMP_MAX; k++) {
    const a = k * 8;
    const reach = data[a + 2];
    const lx = data[a] - p.x;
    const ly = data[a + 1] - p.y;
    const lz = data[a + 4];
    const f = lampFalloff(Math.hypot(lx, ly), reach, data[a + 3]);
    const ll = Math.hypot(lx, ly, lz) || 1;
    let hx = lx / ll + vx;
    let hy = ly / ll + vy;
    let hz = lz / ll + vz;
    const hl = Math.hypot(hx, hy, hz) || 1;
    hx /= hl;
    hy /= hl;
    hz /= hl;
    const lobe = Math.pow(Math.max(0, normal.x * hx + normal.y * hy + normal.z * hz), exponent);
    const w = f * data[a + 5];
    wSum += w;
    aSum += w * lobe;
    fSum += f;
  }
  return { align: aSum / Math.max(wSum, 1e-4), presence: Math.min(1, fSum) };
}
