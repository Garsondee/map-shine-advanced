/**
 * @fileoverview scene/weather-restrict.js — a Tile's "Restrict Weather" box,
 * made into a SKY OCCLUDER for the precipitation system.
 *
 * Pure: bytes in, bytes out. No GPU, no Foundry globals, no DOM — Node-testable.
 *
 * ## What the box means here
 *
 * A Tile with `restrictions.weather` set is a SKY OCCLUDER: the weather is drawn ON it (it is the
 * topmost surface) and kept OFF whatever lies under it: rain, snow, splashes and the mantle all sample ONE baked sky-reach
 * texture (`vt/vt-pan-viewer.js#bakePrecipSkyReachTexture`), so occluding the
 * sky is a matter of darkening that texture under the tile's art. Weather
 * "above" the tile — viewed from a floor the tile lies wholly beneath — is
 * untouched: `scene/mask-derive.js`'s weather stage only emits a restrictor for
 * floors the tile does not sit entirely below.
 *
 * ## Why it is composed here, per frame, and not baked into `skyReach`
 *
 * The tile hover-fades (and token-fades) like any overhead art, and the weather
 * must fade IN as the roof fades OUT. A baked grid cannot do that, so the derive
 * stage hands over (a) the sky WITHOUT the restrictors that it counted as cover
 * and (b) each restrictor's own footprint stamp, and this module lays them back
 * over it with the live opacity of each tile:
 *
 *     gate = sky × (1 − footprint_t) + footprint_t × opacity_t   (per tile)
 *
 * Inside a tile's footprint the weather is exactly as visible as the tile is: full
 * on an opaque roof, fading out WITH it on hover — the ground revealed beneath is
 * below the tile, so weather never appears there. Outside it, the open sky.
 *
 * @module scene/weather-restrict
 */

/** Opacity quantum — a fade is re-composed only when some tile moves this far. */
export const OPACITY_STEP = 1 / 32;

/** A tile at or above this opacity still counts as a roof for the DRIPS. */
export const DRIP_OPACITY_THRESHOLD = 0.5;

/** @param {number} v @returns {number} 0..1 */
function clamp01(v) {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

/**
 * Snap an opacity to {@link OPACITY_STEP}, so the per-frame hover easing does not
 * ask for a re-compose and a texture upload every single frame of a fade — only
 * when the visible change is worth one. Ends (0 and 1) are exact.
 * @param {number} opacity
 * @returns {number}
 */
export function quantizeOpacity(opacity) {
  return Math.round(clamp01(opacity) / OPACITY_STEP) * OPACITY_STEP;
}

/**
 * The opacity a tile currently presents to the sky, from the SAME numbers its
 * own paint uses: `mix(1, occludedAlpha, fadeAmount)` (`scene/occlusion.js
 * #computeOcclusionAlpha`, whose `unoccludedAlpha` is the tile's full 1 here).
 *
 * @param {number} fadeAmount - 0 fully shown … 1 fully faded.
 * @param {number} occludedAlpha - the tile's `occlusion.alpha` (Foundry default 0).
 * @returns {number} 0..1
 */
export function tileOpacity(fadeAmount, occludedAlpha) {
  const a = clamp01(fadeAmount);
  const o = clamp01(Number.isFinite(occludedAlpha) ? occludedAlpha : 0);
  return 1 + (o - 1) * a;
}

/**
 * Compose the weather gate: the sky with every restrictor laid back over it.
 *
 * @param {object} args
 * @param {{spec: {w:number,h:number}, data: Uint8Array}} args.sky - the derive
 *   stage's sky WITHOUT restrictors.
 * @param {Array<{id: string, stamp: {gx0:number, gy0:number, w:number, h:number, value: Uint8Array}}>} args.restrictors
 * @param {(id: string) => number} [args.opacityOf] - 0..1 per restrictor; absent = 1.
 * @param {Uint8Array} [args.out] - a w*h*4 RGBA buffer to fill in place (the
 *   gate's own texture data, R replicated like the other mask bakes). Allocated
 *   when omitted.
 * @returns {Uint8Array} the RGBA bytes.
 */
export function composeWeatherGate({ sky, restrictors, opacityOf = () => 1, out = null }) {
  const { w, h } = sky.spec;
  const n = w * h;
  const bytes = out && out.length === n * 4 ? out : new Uint8Array(n * 4);
  // Work in a flat 0..255 plane, then fan it out to RGBA once.
  const plane = sky.data.slice(0, n);
  for (const { id, stamp } of restrictors) {
    const opacity = clamp01(opacityOf(id));
    if (!stamp?.value) continue;
    const { value, gx0, gy0, w: sw, h: sh } = stamp;
    for (let r = 0; r < sh; r++) {
      const gy = gy0 + r;
      if (gy < 0 || gy >= h) continue;
      let d = gy * w + gx0;
      let s = r * sw;
      for (let k = 0; k < sw; k++, s++, d++) {
        const gx = gx0 + k;
        if (gx < 0 || gx >= w) continue;
        const cover = value[s] / 255;
        if (cover <= 0) continue;
        plane[d] = Math.round(plane[d] * (1 - cover) + 255 * opacity * cover);
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const v = plane[i];
    bytes[i * 4] = v;
    bytes[i * 4 + 1] = v;
    bytes[i * 4 + 2] = v;
    bytes[i * 4 + 3] = 255;
  }
  return bytes;
}

/**
 * The cover grid the DRIP roofline is traced from: the floor's cover WITHOUT the
 * restrictors, plus each restrictor that still reads as a roof (opacity at or
 * above {@link DRIP_OPACITY_THRESHOLD}). A faded roof stops dripping; a tile that
 * was never in `coverAbove` (an awning, a rug-height cover) gets its edges for
 * the first time. Restrictors are MAX-merged, so overlapping tiles share edges.
 *
 * @param {object} args
 * @param {{spec: object, data: Uint8Array}} args.cover - `weather.cover`.
 * @param {Array<{id: string, stamp: object}>} args.restrictors
 * @param {(id: string) => number} [args.opacityOf]
 * @returns {{spec: object, data: Uint8Array}} a NEW grid.
 */
export function composeDripCover({ cover, restrictors, opacityOf = () => 1 }) {
  const { w, h } = cover.spec;
  const data = Uint8Array.from(cover.data);
  for (const { id, stamp } of restrictors) {
    if (clamp01(opacityOf(id)) < DRIP_OPACITY_THRESHOLD || !stamp?.value) continue;
    const { value, gx0, gy0, w: sw, h: sh } = stamp;
    for (let r = 0; r < sh; r++) {
      const gy = gy0 + r;
      if (gy < 0 || gy >= h) continue;
      let d = gy * w + gx0;
      let s = r * sw;
      for (let k = 0; k < sw; k++, s++, d++) {
        const gx = gx0 + k;
        if (gx < 0 || gx >= w) continue;
        if (value[s] > data[d]) data[d] = value[s];
      }
    }
  }
  return { spec: cover.spec, data };
}

/**
 * Which restrictors currently count as a roof for the drips, as a string: the
 * caller re-traces the roofline only when this changes (a fade crossing the
 * threshold), not on every frame of the easing.
 * @param {Array<{id: string}>} restrictors
 * @param {(id: string) => number} opacityOf
 * @returns {string}
 */
export function dripRoofKey(restrictors, opacityOf) {
  let key = '';
  for (const { id } of restrictors) key += clamp01(opacityOf(id)) >= DRIP_OPACITY_THRESHOLD ? '1' : '0';
  return key;
}
