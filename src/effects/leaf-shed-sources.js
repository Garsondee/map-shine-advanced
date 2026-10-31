/**
 * LEAF SHED — WHERE LEAVES COME FROM, AND WHAT COLOUR THEY ARE.
 *
 * Pure maths over a small RGBA raster of the painted canopies; no THREE, no GPU,
 * Node-tested. The engine (`effects/particles/leaf-shed-runtime.js`) only moves
 * and draws leaves; every decision about WHERE one is born, WHAT it is and WHAT
 * COLOUR it is lives here, on the CPU, once per birth — a few hundred a second
 * at the very most, against tens of thousands of pixels a frame on the GPU.
 *
 * ============================================================================
 * A CANOPY IS AN EMITTER
 * ============================================================================
 * `buildCanopyEmitters` turns the raster into connected blobs of canopy
 * (alpha ≥ half): one blob per tree, or per clump of touching trees. Each keeps a
 * POOL of sample points spread over its whole footprint, each with the colour
 * painted there. A leaf is born at a pool point, so it is born UNDER the canopy
 * and is drawn below it: what the viewer sees is a leaf sliding out from beneath
 * the painted leaves on the downwind side — the author's "shed off from below the
 * main tree graphic".
 *
 * ============================================================================
 * THE COLOUR — THE ART'S OWN FILL, NOT ITS AVERAGE
 * ============================================================================
 * The raster is coarse (one texel is several art pixels), so a texel's colour is
 * the art's fill MIXED with its dark brushy outline and its interior strokes.
 * Measured on the Wilderness pack (2026-10-31): outline ≈ 0.2–0.33 × the fill,
 * ≈ 4 art px wide, fill runs ≈ 9–33 px. An averaged texel is therefore darker and
 * muddier than any leaf the author painted. So each blob's FILL is the median
 * colour of its mid-to-bright texels (luminance between the 40th and 90th
 * percentile — above the outline-heavy texels, below the specular-ish
 * highlights), and every pool point keeps its own HUE but is lifted to at least
 * the fill's brightness. A yellow-green bush sheds yellow-green leaves, a
 * blue-green one blue-green, and the dark outline is drawn by the shader, as the
 * artist drew it, instead of being smeared into the fill.
 *
 * Branches are the art's pink-brown (~#6a544e); a tree whose raster shows
 * enough brown texels sheds twigs in ITS brown, otherwise the measured default.
 *
 * @module effects/leaf-shed-sources
 */

/** Leaf, clump and twig — the three things a canopy sheds. The order is the shader's. */
export const SHED_KIND = Object.freeze({ leaf: 0, clump: 1, twig: 2 });

/**
 * The author's own wood colours (her wood sheet, 2026-10-31): the BARK of the outside of a branch. Twigs use it
 * on every map — it is the colour her art uses for wood, where the branch pixels the worker measures vary with the
 * canopy's shading. The freshly broken ends are the paler {@link WOOD_CUT_SRGB}.
 */
export const DEFAULT_TWIG_SRGB = Object.freeze([158, 112, 92]);
/** The pale wood of a freshly broken end (her wood sheet). */
export const WOOD_CUT_SRGB = Object.freeze([226, 170, 108]);

/** Alpha (0..255) at or above which a texel is canopy. */
const CANOPY_ALPHA = 128;
/** A blob smaller than this many texels is a stray brush mark, not a plant. */
const MIN_BLOB_TEXELS = 3;
/** Pool points kept per blob (spread evenly through its texels). */
const POOL_MAX = 96;
/** A blob needs this many brown texels before its own brown beats the default. */
const MIN_BRANCH_TEXELS = 4;

/** Leaves a one-grid-square canopy proposes per second at full wind, before `amount`. */
export const BASE_RATE_PER_SQUARE = 4.8;
/** Proposals per real leaf: the GPU refuses births the local air is too slow for (lulls between gusts). */
export const OVER_PROPOSE = 1.6;

const luminance = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

/** sRGB byte → linear 0..1 (the shader works in the lit target's linear space). */
export function srgbByteToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function isBranchBrown(r, g, b) {
  return r > g + 12 && r > b && r > 70 && r < 200;
}

/**
 * @typedef {object} CanopyRaster
 * @property {{x:number, y:number, w:number, h:number, texelW:number, texelH:number}} spec - world placement (row 0 = minY).
 * @property {Uint8Array|Uint8ClampedArray} rgba - w*h*4, straight (not premultiplied) sRGB bytes.
 */

/**
 * @typedef {object} CanopyEmitter
 * @property {'tree'|'bush'} kind
 * @property {number} cx @property {number} cy - centroid, world px.
 * @property {number} minX @property {number} minY @property {number} maxX @property {number} maxY - world bounds.
 * @property {number} areaPx2 - painted area, world px².
 * @property {number} poolCount
 * @property {Float32Array} pool - poolCount × 5: x, y, r, g, b (r,g,b = sRGB bytes, already lifted to the fill).
 * @property {number[]} fill - the blob's fill colour, sRGB bytes.
 * @property {number[]} twig - the blob's branch colour, sRGB bytes.
 * @property {number} texelW @property {number} texelH - so a birth can jitter inside its texel.
 */

/**
 * Find the canopies in a raster.
 * @param {CanopyRaster} raster
 * @param {'tree'|'bush'} kind
 * @returns {CanopyEmitter[]}
 */
export function buildCanopyEmitters(raster, kind) {
  const { spec, rgba } = raster ?? {};
  if (!spec || !rgba) return [];
  const { w, h } = spec;
  if (!(w > 0 && h > 0) || rgba.length < w * h * 4) return [];
  const label = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  const out = [];
  for (let start = 0; start < w * h; start++) {
    if (label[start] !== -1 || rgba[start * 4 + 3] < CANOPY_ALPHA) continue;
    // Flood one blob (4-connected), collecting its texel indices.
    const id = out.length;
    const members = [];
    let sp = 0;
    stack[sp++] = start;
    label[start] = id;
    while (sp > 0) {
      const i = stack[--sp];
      members.push(i);
      const x = i % w;
      const y = (i / w) | 0;
      const push = (j) => {
        if (label[j] === -1 && rgba[j * 4 + 3] >= CANOPY_ALPHA) {
          label[j] = id;
          stack[sp++] = j;
        }
      };
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (y > 0) push(i - w);
      if (y < h - 1) push(i + w);
    }
    if (members.length < MIN_BLOB_TEXELS) {
      out.push(null); // keeps ids aligned with `label`; dropped below
      continue;
    }
    out.push(describeBlob(members, spec, rgba, kind));
  }
  return out.filter(Boolean);
}

function describeBlob(members, spec, rgba, kind) {
  const { w, x: ox, y: oy, texelW, texelH } = spec;
  let sx = 0;
  let sy = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const lums = new Float32Array(members.length);
  let br = 0;
  let bg = 0;
  let bb = 0;
  let bn = 0;
  for (let k = 0; k < members.length; k++) {
    const i = members[k];
    const tx = i % w;
    const ty = (i / w) | 0;
    sx += tx;
    sy += ty;
    if (tx < minX) minX = tx;
    if (ty < minY) minY = ty;
    if (tx > maxX) maxX = tx;
    if (ty > maxY) maxY = ty;
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    lums[k] = luminance(r, g, b);
    if (isBranchBrown(r, g, b)) {
      br += r;
      bg += g;
      bb += b;
      bn++;
    }
  }
  const sorted = Float32Array.from(lums).sort();
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
  const lo = pct(0.4);
  const hi = pct(0.9);
  // The fill: per-channel median over the mid-to-bright texels.
  const rs = [];
  const gs = [];
  const bs = [];
  for (let k = 0; k < members.length; k++) {
    if (lums[k] < lo || lums[k] > hi) continue;
    const i = members[k];
    if (isBranchBrown(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2])) continue;
    rs.push(rgba[i * 4]);
    gs.push(rgba[i * 4 + 1]);
    bs.push(rgba[i * 4 + 2]);
  }
  const median = (a) => {
    if (!a.length) return 0;
    a.sort((p, q) => p - q);
    return a[a.length >> 1];
  };
  let fill = rs.length ? [median(rs), median(gs), median(bs)] : null;
  if (!fill) {
    const i = members[0];
    fill = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
  }
  const fillLum = Math.max(1, luminance(fill[0], fill[1], fill[2]));
  const twig = [...DEFAULT_TWIG_SRGB];

  // The pool: evenly strided through the blob's texels (flood order is spatially
  // coherent, so a stride spreads the points over the whole footprint).
  const poolCount = Math.min(POOL_MAX, members.length);
  const pool = new Float32Array(poolCount * 5);
  const stride = members.length / poolCount;
  for (let p = 0; p < poolCount; p++) {
    const i = members[Math.min(members.length - 1, Math.floor(p * stride + stride * 0.5))];
    const tx = i % w;
    const ty = (i / w) | 0;
    let r = rgba[i * 4];
    let g = rgba[i * 4 + 1];
    let b = rgba[i * 4 + 2];
    if (isBranchBrown(r, g, b)) {
      [r, g, b] = fill;
    } else {
      // Keep the texel's hue, never let it fall below the fill's brightness (the
      // outline darkened it, not the leaf), and pull it a third of the way to the
      // fill so one stray stroke cannot make an odd leaf.
      const l = Math.max(1, luminance(r, g, b));
      const lift = Math.max(1, fillLum / l);
      r = Math.min(255, r * lift) * 0.67 + fill[0] * 0.33;
      g = Math.min(255, g * lift) * 0.67 + fill[1] * 0.33;
      b = Math.min(255, b * lift) * 0.67 + fill[2] * 0.33;
    }
    pool[p * 5] = ox + (tx + 0.5) * texelW;
    pool[p * 5 + 1] = oy + (ty + 0.5) * texelH;
    pool[p * 5 + 2] = r;
    pool[p * 5 + 3] = g;
    pool[p * 5 + 4] = b;
  }
  return {
    kind,
    cx: ox + (sx / members.length + 0.5) * texelW,
    cy: oy + (sy / members.length + 0.5) * texelH,
    minX: ox + minX * texelW,
    minY: oy + minY * texelH,
    maxX: ox + (maxX + 1) * texelW,
    maxY: oy + (maxY + 1) * texelH,
    areaPx2: members.length * texelW * texelH,
    poolCount,
    pool,
    fill,
    twig,
    texelW,
    texelH,
  };
}

/**
 * Move emitters built in an image's own UV space (a raster whose spec is
 * `{x:0, y:0, texelW:1/w, texelH:1/h}`) onto the world, through the quad the
 * item is actually drawn on — `computeQuadCorners`' four corners in (u,v) order
 * TL, TR, BR, BL. The quad is a parallelogram (a rotated, scaled rectangle), so
 * `TL + u·(TR−TL) + v·(BL−TL)` is exact.
 *
 * @param {CanopyEmitter[]} emitters - UV-space emitters (not mutated).
 * @param {Array<{x:number, y:number}>} corners
 * @returns {CanopyEmitter[]}
 */
export function placeEmitters(emitters, corners) {
  if (!Array.isArray(corners) || corners.length < 4) return [];
  const [tl, tr, , bl] = corners;
  const ux = tr.x - tl.x;
  const uy = tr.y - tl.y;
  const vx = bl.x - tl.x;
  const vy = bl.y - tl.y;
  const at = (u, v) => [tl.x + u * ux + v * vx, tl.y + u * uy + v * vy];
  const areaScale = Math.abs(ux * vy - uy * vx);
  const uLen = Math.hypot(ux, uy);
  const vLen = Math.hypot(vx, vy);
  return emitters.map((e) => {
    const pool = new Float32Array(e.pool);
    for (let p = 0; p < e.poolCount; p++) {
      const [x, y] = at(e.pool[p * 5], e.pool[p * 5 + 1]);
      pool[p * 5] = x;
      pool[p * 5 + 1] = y;
    }
    const [cx, cy] = at(e.cx, e.cy);
    const box = [at(e.minX, e.minY), at(e.maxX, e.minY), at(e.maxX, e.maxY), at(e.minX, e.maxY)];
    return {
      ...e,
      pool,
      cx,
      cy,
      minX: Math.min(...box.map((b) => b[0])),
      minY: Math.min(...box.map((b) => b[1])),
      maxX: Math.max(...box.map((b) => b[0])),
      maxY: Math.max(...box.map((b) => b[1])),
      areaPx2: e.areaPx2 * areaScale,
      texelW: e.texelW * uLen,
      texelH: e.texelH * vLen,
    };
  });
}

/** Hermite ramp, 0 at `a`, 1 at `b`. */
export function rampBetween(a, b, x) {
  if (!(b > a)) return x >= a ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Leaves proposed per second by one canopy.
 * @param {CanopyEmitter} e
 * @param {number} windMps - the prevailing wind at this canopy (dial m/s × its openness).
 * @param {{amount:number, bushShare:number, startsAboveMps:number, fullAtMps:number}} p
 * @param {number} gridPx - world px per grid square.
 */
export function emitterProposalRate(e, windMps, p, gridPx) {
  const ramp = rampBetween(p.startsAboveMps, p.fullAtMps, windMps);
  if (ramp <= 0) return 0;
  const squares = e.areaPx2 / Math.max(1, gridPx * gridPx);
  const share = e.kind === 'bush' ? p.bushShare : 1;
  // Area^0.75: a big tree sheds more than a small one, but a forest-sized merged
  // blob does not drown the screen.
  return BASE_RATE_PER_SQUARE * OVER_PROPOSE * Math.pow(Math.max(0.05, squares), 0.75) * ramp * p.amount * share;
}

/**
 * The plan for one frame: which canopies shed, how many, and every birth's record.
 *
 * @param {object} a
 * @param {CanopyEmitter[]} a.emitters
 * @param {Float64Array|number[]} a.carry - per-emitter fractional births carried between frames (mutated).
 * @param {(e: CanopyEmitter) => number} a.windMpsAt - the prevailing wind at a canopy, m/s.
 * @param {number} a.dtSec
 * @param {object} a.params - resolved LEAF_SHED_PARAMS.
 * @param {number} a.gridPx
 * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} a.viewRect - only canopies near the view shed.
 * @param {number} a.maxBirths - the frame's budget (the ring must not lap live leaves).
 * @param {{tree:number, bush:number}} a.heightPx - canopy height in world px per kind.
 * @param {() => number} [a.random]
 * @returns {Array<{x:number,y:number,kind:number,sizePx:number,heightPx:number,rgb:number[],ramp:number}>}
 */
export function planShedBirths({
  emitters,
  carry,
  windMpsAt,
  dtSec,
  params: p,
  gridPx,
  viewRect,
  maxBirths,
  heightPx,
  random = Math.random,
}) {
  const births = [];
  if (!emitters?.length || !(dtSec > 0) || !(maxBirths > 0)) return births;
  const leafPx = Math.max(4, gridPx * 0.22 * p.leafSize);
  // A canopy this far outside the view can still blow leaves into it.
  const margin = gridPx * 6;
  for (let k = 0; k < emitters.length; k++) {
    const e = emitters[k];
    if (
      viewRect &&
      (e.maxX < viewRect.minX - margin ||
        e.minX > viewRect.maxX + margin ||
        e.maxY < viewRect.minY - margin ||
        e.minY > viewRect.maxY + margin)
    ) {
      carry[k] = 0;
      continue;
    }
    const mps = windMpsAt(e);
    const rate = emitterProposalRate(e, mps, p, gridPx);
    if (rate <= 0) {
      carry[k] = 0;
      continue;
    }
    carry[k] = (carry[k] || 0) + rate * dtSec;
    const ramp = rampBetween(p.startsAboveMps, p.fullAtMps, mps);
    while (carry[k] >= 1) {
      carry[k] -= 1;
      if (births.length >= maxBirths) return births;
      births.push(makeBirth(e, p, leafPx, heightPx, ramp, random));
    }
  }
  return births;
}

function makeBirth(e, p, leafPx, heightPx, ramp, random) {
  const s = Math.floor(random() * e.poolCount) * 5;
  const x = e.pool[s] + (random() - 0.5) * e.texelW;
  const y = e.pool[s + 1] + (random() - 0.5) * e.texelH;
  let kind = SHED_KIND.leaf;
  if (e.kind === 'tree') {
    const roll = random();
    if (roll < p.twigShare) kind = SHED_KIND.twig;
    else if (roll < p.twigShare + p.clumpShare) kind = SHED_KIND.clump;
  }
  let rgb;
  if (kind === SHED_KIND.twig) {
    const v = 1 + (random() - 0.5) * 0.2 * p.colourVariation;
    rgb = e.twig.map((c) => Math.min(255, c * v));
  } else {
    // Brightness and a little hue drift, both scaled by the variation dial.
    const v = 1 + (random() - 0.5) * 0.36 * p.colourVariation;
    const warm = (random() - 0.5) * 18 * p.colourVariation;
    rgb = [
      Math.min(255, Math.max(0, e.pool[s + 2] * v + warm)),
      Math.min(255, Math.max(0, e.pool[s + 3] * v)),
      Math.min(255, Math.max(0, e.pool[s + 4] * v - warm * 0.5)),
    ];
  }
  const kindSize = kind === SHED_KIND.twig ? 2.6 : kind === SHED_KIND.clump ? 1.45 : e.kind === 'bush' ? 0.95 : 1;
  const sizePx = leafPx * kindSize * (0.8 + random() * 0.4);
  // Born in the lower part of the crown — under the painted leaves, not on top of them.
  const crown = e.kind === 'bush' ? heightPx.bush : heightPx.tree;
  const h = crown * (e.kind === 'bush' ? 0.5 + random() * 0.4 : 0.3 + random() * 0.45);
  return { x, y, kind, sizePx, heightPx: h, rgb, ramp };
}
