/**
 * @fileoverview vt/mip-resample.js — the mip-chain downsampler, replacing the
 * OffscreenCanvas `drawImage` resize the BC encoder used to lean on.
 *
 * TWO AUTHOR-REPORTED DEFECTS, 2026-07-28, both of which live here:
 *
 * 1. "large zoom out makes areas look a bit pixelated" — with the clarity
 *    sharpen restoring contrast (vt-pan-viewer.js's `buildAlbedoClarityNode`),
 *    whatever artefacts the mip levels already carried became visible instead of
 *    hiding inside the blur. `drawImage` + `imageSmoothingQuality:'high'` is an
 *    opaque browser primitive whose kernel is unspecified, varies by Chrome
 *    version, and for large reductions has historically fallen back to
 *    mipmap+bilinear — i.e. exactly the aliasing a sharpen amplifies. It is
 *    replaced here by an explicit **Lanczos-2** reduction: a windowed sinc with
 *    real negative lobes, so it is SHARPER than the box filter PIXI's
 *    `gl.generateMipmap` uses, and — unlike `drawImage` — it is deterministic,
 *    inspectable and Node-testable.
 *
 * 2. "the edges of tiles, where the alpha might be less than 100% are very
 *    degraded when I zoom out" — a genuine, separate, long-standing bug, and
 *    NOT a filtering-quality issue. Two mechanisms, both fixed here:
 *
 *    a. **The canvas round trip destroys transparent RGB.** A 2D canvas stores
 *       premultiplied; `getImageData` un-premultiplies. A fully transparent
 *       texel therefore comes back as RGB **0** whatever the artist painted
 *       there, and a nearly-transparent one comes back quantised to a handful of
 *       levels (at a=8/255 the colour keeps ~5 bits, at a=1 it keeps one).
 *
 *    b. **The GPU filters straight-alpha RGBA.** Bilinear averages the colour
 *       channels WITHOUT weighting them by alpha, so an edge texel
 *       (a=255, rgb=200) blended with its transparent neighbour (a=0, rgb=0 —
 *       see (a)) lands at (a=128, rgb=100) when the correct answer is
 *       (a=128, rgb=200). Every soft edge is dragged toward black. The coarser
 *       the mip the more transparent neighbours are in reach, which is exactly
 *       why it worsens as the author zooms out.
 *
 *    The fix is the standard texture-pipeline pair, and both halves are
 *    required: **filter in premultiplied space** (so a transparent texel's
 *    colour contributes nothing rather than contributing black), then
 *    **dilate** — flood the recovered edge colour outward into the transparent
 *    region so that when the GPU does its own unweighted bilinear at runtime,
 *    there is no black left to average in. Filtering premultiplied alone does
 *    not fix (b): the hardware still interpolates whatever RGB sits in the
 *    transparent texels, so they have to be given sensible colour.
 *
 * MEMORY. Every function here is streaming or bounded. `halveRGBA` pulls source
 * rows through a caller-supplied band reader and keeps only an 8-row ring of
 * horizontally-filtered scanlines (a few hundred KB), so the full source is
 * never resident — the discipline keyhole-device-loss-large-map exists to
 * protect. Its OUTPUT is a full level buffer, which is why the worker cascades
 * (level N from level N-1) instead of re-reducing the source every time: one
 * held level peaks at a quarter of the source, not the whole of it.
 *
 * Pure and dependency-free on purpose — this is the half of the pipeline Node
 * CAN execute, so it is where the tests live.
 *
 * @module vt/mip-resample
 */

/** Lanczos window order. a=2 gives 8 taps at a 2x reduction — two positive
 * lobes and two negative ones, the classic "sharp but not ringy" downsample. */
export const LANCZOS_A = 2;

/**
 * The Lanczos kernel, `L(x) = a·sin(πx)·sin(πx/a) / (π²x²)`, zero outside |x|<a.
 * @param {number} x @param {number} a @returns {number}
 */
export function lanczos(x, a = LANCZOS_A) {
  if (x === 0) return 1;
  const ax = Math.abs(x);
  if (ax >= a) return 0;
  const px = Math.PI * x;
  return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
}

/**
 * Tap table for an exact 2x reduction. Output texel `j` covers source texels
 * [2j, 2j+2), so its centre sits at source coordinate `2j+1`; source texel
 * `2j+t` has centre `2j+t+0.5` and therefore distance `t-0.5`. The kernel is
 * scaled by the reduction ratio (evaluated at `d/2`), which is what makes this a
 * band-limited REDUCTION rather than a 2x-too-narrow interpolation.
 *
 * @param {number} a - Lanczos order.
 * @returns {{offsets:Int32Array, weights:Float64Array}} weights sum to 1.
 */
export function buildHalveTaps(a = LANCZOS_A) {
  const offsets = [];
  const raw = [];
  // |d/2| < a  =>  |t - 0.5| < 2a
  const tMin = Math.ceil(0.5 - 2 * a);
  const tMax = Math.floor(0.5 + 2 * a);
  for (let t = tMin; t <= tMax; t++) {
    const d = t - 0.5;
    const wgt = lanczos(d / 2, a);
    if (wgt === 0) continue;
    offsets.push(t);
    raw.push(wgt);
  }
  const sum = raw.reduce((s, v) => s + v, 0);
  if (!(Math.abs(sum) > 1e-9)) throw new Error('buildHalveTaps: degenerate kernel');
  return { offsets: Int32Array.from(offsets), weights: Float64Array.from(raw.map((v) => v / sum)) };
}

/** The dimensions `halveRGBA` will produce — the standard GPU rule. */
export function halvedSize(srcW, srcH) {
  return { width: Math.max(1, srcW >> 1), height: Math.max(1, srcH >> 1) };
}

/**
 * Reduce an RGBA image by exactly 2 in each axis, filtering in PREMULTIPLIED
 * space and returning straight (un-premultiplied) RGBA with transparent regions
 * dilated. See this file's header for why each of those clauses is load-bearing.
 *
 * @param {(y0:number, count:number)=>Uint8Array|Uint8ClampedArray} readRows -
 *   returns source rows [y0, y0+count) as tightly-packed straight-alpha RGBA.
 *   Called with strictly non-decreasing `y0` — the row window only ever moves
 *   forward — so a caller may stream rather than seek.
 * @param {number} srcW @param {number} srcH
 * @param {{bandRows?:number, taps?:{offsets:Int32Array,weights:Float64Array},
 *          dilatePasses?:number}} [opts]
 * @returns {{data:Uint8Array, width:number, height:number}}
 */
export function halveRGBA(readRows, srcW, srcH, opts = {}) {
  if (!(srcW > 0) || !(srcH > 0)) throw new Error(`halveRGBA: bad source size ${srcW}x${srcH}`);
  const { width: dstW, height: dstH } = halvedSize(srcW, srcH);
  const taps = opts.taps || buildHalveTaps();
  const bandRows = Math.max(1, opts.bandRows || 256);
  const nTaps = taps.offsets.length;

  // ── source band cache. Forward-only, so one band is enough.
  let bandY0 = -1;
  let bandCount = 0;
  /** @type {Uint8Array|Uint8ClampedArray|null} */
  let band = null;
  const srcRowOffset = (y) => {
    const yy = y < 0 ? 0 : y >= srcH ? srcH - 1 : y;
    if (band === null || yy < bandY0 || yy >= bandY0 + bandCount) {
      bandY0 = Math.floor(yy / bandRows) * bandRows;
      bandCount = Math.min(bandRows, srcH - bandY0);
      band = readRows(bandY0, bandCount);
      const need = bandCount * srcW * 4;
      if (!band || band.length < need) {
        throw new Error(`halveRGBA: band reader returned ${band ? band.length : 0} bytes, need ${need}`);
      }
    }
    return (yy - bandY0) * srcW * 4;
  };

  // ── ring of horizontally-reduced scanlines, held PREMULTIPLIED.
  // Exactly nTaps deep: the vertical window spans nTaps consecutive source rows,
  // so `y` and `y + nTaps` are never both live and cannot collide in the ring.
  const ring = new Float32Array(nTaps * dstW * 4);
  const ringY = new Int32Array(nTaps).fill(-1);

  const horizontalInto = (slot, srcOff) => {
    const base = slot * dstW * 4;
    for (let x = 0; x < dstW; x++) {
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let aa = 0;
      for (let k = 0; k < nTaps; k++) {
        let sx = 2 * x + taps.offsets[k];
        if (sx < 0) sx = 0;
        else if (sx >= srcW) sx = srcW - 1;
        const i = srcOff + sx * 4;
        const w = taps.weights[k];
        // Premultiply on the way in: a transparent texel's RGB then contributes
        // literally nothing, which is the whole point (header, mechanism 2a).
        const al = band[i + 3];
        const pm = (al * w) / 255;
        ar += band[i] * pm;
        ag += band[i + 1] * pm;
        ab += band[i + 2] * pm;
        aa += al * w;
      }
      const o = base + x * 4;
      ring[o] = ar;
      ring[o + 1] = ag;
      ring[o + 2] = ab;
      ring[o + 3] = aa;
    }
  };

  const ringSlotFor = (y) => {
    const yy = y < 0 ? 0 : y >= srcH ? srcH - 1 : y;
    const slot = yy % nTaps;
    if (ringY[slot] !== yy) {
      horizontalInto(slot, srcRowOffset(yy));
      ringY[slot] = yy;
    }
    return slot * dstW * 4;
  };

  const out = new Uint8Array(dstW * dstH * 4);
  const slots = new Int32Array(nTaps);

  for (let j = 0; j < dstH; j++) {
    for (let k = 0; k < nTaps; k++) slots[k] = ringSlotFor(2 * j + taps.offsets[k]);
    const rowOut = j * dstW * 4;
    for (let x = 0; x < dstW; x++) {
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let aa = 0;
      for (let k = 0; k < nTaps; k++) {
        const i = slots[k] + x * 4;
        const w = taps.weights[k];
        ar += ring[i] * w;
        ag += ring[i + 1] * w;
        ab += ring[i + 2] * w;
        aa += ring[i + 3] * w;
      }
      // Lanczos' negative lobes can ring past the legal range on a hard edge;
      // clamp rather than wrap. Alpha is clamped FIRST because it is the divisor.
      const a = aa < 0 ? 0 : aa > 255 ? 255 : aa;
      const o = rowOut + x * 4;
      if (a <= 0) {
        // No coverage: leave RGB at 0 and let the dilation pass below supply a
        // colour. Dividing by ~0 here is what produced the black fringes.
        out[o] = 0;
        out[o + 1] = 0;
        out[o + 2] = 0;
        out[o + 3] = 0;
      } else {
        const inv = 255 / a;
        const r = ar * inv;
        const g = ag * inv;
        const b = ab * inv;
        out[o] = r < 0 ? 0 : r > 255 ? 255 : r;
        out[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
        out[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
        out[o + 3] = a;
      }
    }
  }

  dilateTransparentRGB(out, dstW, dstH, opts.dilatePasses);
  return { data: out, width: dstW, height: dstH };
}

/**
 * Flood colour outward into fully-transparent texels, so the GPU's own
 * straight-alpha bilinear has no black to average into a soft edge (header,
 * mechanism 2b). Operates IN PLACE on RGB only — alpha is never touched, so this
 * cannot change a single visible pixel's coverage. It only changes what colour
 * the invisible texels carry, which is precisely what interpolation leaks.
 *
 * Four passes reaches four texels, comfortably beyond what bilinear (1 texel)
 * and trilinear across two levels can pull in.
 *
 * @param {Uint8Array|Uint8ClampedArray} data - RGBA, modified in place.
 * @param {number} w @param {number} h @param {number} [passes]
 * @returns {number} how many texels were given a colour (0 = image had no
 *   transparent texels adjacent to opaque ones, e.g. a fully opaque layer).
 */
export function dilateTransparentRGB(data, w, h, passes = 4) {
  const n = w * h;
  const filled = new Uint8Array(n);
  let anyEmpty = false;
  let anyFilled = false;
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] > 0) {
      filled[i] = 1;
      anyFilled = true;
    } else {
      anyEmpty = true;
    }
  }
  // Fully opaque (every floor background) or fully transparent (an empty layer):
  // either way there is no edge to bleed across. The opaque early-out is what
  // keeps this free on the BC1 path, which is most of the pixels in a scene.
  if (!anyEmpty || !anyFilled) return 0;

  // FRONTIER, not a rescan. A 6750² overlay is 45M texels and is ~97% transparent
  // (the author's glassware layer measures mean alpha 7/255), so re-scanning the
  // whole grid once per pass would cost more than the entire encode. Work is
  // proportional to the texels actually coloured instead.
  let frontier = [];
  const queued = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!filled[i]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const ni = ny * w + nx;
          if (filled[ni] || queued[ni]) continue;
          queued[ni] = 1;
          frontier.push(ni);
        }
      }
    }
  }

  let total = 0;
  for (let p = 0; p < passes && frontier.length > 0; p++) {
    // STAGED: every texel in this pass reads only texels filled BEFORE it, so
    // colour spreads evenly outward from the real edge instead of racing across
    // the image in scan order.
    const colours = new Int32Array(frontier.length * 3);
    let write = 0;
    for (let k = 0; k < frontier.length; k++) {
      const i = frontier[k];
      const x = i % w;
      const y = (i / w) | 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w || (dx === 0 && dy === 0)) continue;
          const ni = ny * w + nx;
          if (!filled[ni]) continue;
          r += data[ni * 4];
          g += data[ni * 4 + 1];
          b += data[ni * 4 + 2];
          c++;
        }
      }
      colours[write++] = c === 0 ? -1 : Math.round(r / c);
      colours[write++] = c === 0 ? 0 : Math.round(g / c);
      colours[write++] = c === 0 ? 0 : Math.round(b / c);
    }

    const next = [];
    for (let k = 0; k < frontier.length; k++) {
      const i = frontier[k];
      if (colours[k * 3] < 0) continue; // no filled neighbour yet — try next pass
      data[i * 4] = colours[k * 3];
      data[i * 4 + 1] = colours[k * 3 + 1];
      data[i * 4 + 2] = colours[k * 3 + 2];
      filled[i] = 1;
      total++;
    }
    if (p + 1 >= passes) break;
    // Grow the frontier one ring outward from what was just filled.
    for (let k = 0; k < frontier.length; k++) {
      const i = frontier[k];
      if (!filled[i]) {
        next.push(i); // still waiting on a neighbour
        continue;
      }
      const x = i % w;
      const y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const ni = ny * w + nx;
          if (filled[ni] || queued[ni]) continue;
          queued[ni] = 1;
          next.push(ni);
        }
      }
    }
    frontier = next;
  }
  return total;
}
