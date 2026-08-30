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

/** Clamp to a valid byte, rounding first. */
function clampByte(v) {
  const r = Math.round(v);
  return r < 0 ? 0 : r > 255 ? 255 : r;
}

/**
 * ============================================================================
 * LINEARIZATION (2026-08-30 — [[project_albedo_zoom_out_clarity_audit_2026-08-30]]
 * §2.1) — `halveRGBA` used to filter raw sRGB-encoded BYTES directly, but every
 * mip it produces uploads with `colorSpace = SRGBColorSpace`
 * (`vt-pan-viewer.js`), so the GPU decodes sRGB→linear on sample BEFORE
 * filtering across levels. Two halves of one filter chain disagreeing about
 * which space they operate in: the STORED bytes were a gamma-space average,
 * but every runtime bilinear/trilinear/anisotropic blend between them
 * happens in linear light. Fixed here — decode to linear before the
 * weighted sum, re-encode to sRGB bytes only once, on the way out — so the
 * stored bytes are what a linear-light-correct reduction actually produces,
 * not a decode of a gamma-space average (a measurably different, and
 * measurably WRONG, number: the project's own bench isolated this specific
 * mismatch at -15% RMS contrast vs PIXI).
 *
 * The real IEC 61966-2-1 sRGB transfer function, not a naive gamma 2.2/2.4
 * power-curve approximation — matching what the GPU's OWN hardware sRGB
 * decode actually does on sample, since an approximation here would just
 * reintroduce a smaller version of the mismatch this fix exists to close.
 * ============================================================================
 */
const SRGB_TO_LINEAR = (() => {
  const lut = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return lut;
})();

/** Exact LUT hit — source bytes are always integer 0-255. @param {number} byte @returns {number} linear [0,1] */
export function srgbToLinear(byte) {
  return SRGB_TO_LINEAR[byte];
}

/** Analytic sRGB encode. @param {number} x - linear, clamped to [0,1] internally. @returns {number} sRGB [0,1] */
export function linearToSrgb(x) {
  const c = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * The shared stddev/mean formula both `computeRmsLuminanceContrast` (a full,
 * in-memory buffer) and `bc-compress.worker.js`'s own incremental per-band
 * accumulation (level 0 of a 12000² map can never be fully resident — see
 * this file's header) reduce down to, so the two can never define "RMS
 * contrast" two different ways.
 * @param {number} lumaSum @param {number} lumaSqSum @param {number} n
 * @returns {number} 0 if n is 0 or the mean is 0 (nothing to take a ratio of).
 */
export function rmsContrastFromSums(lumaSum, lumaSqSum, n) {
  if (!(n > 0)) return 0;
  const mean = lumaSum / n;
  if (!(mean > 0)) return 0;
  const variance = Math.max(0, lumaSqSum / n - mean * mean);
  return Math.sqrt(variance) / mean;
}

/**
 * RMS luminance contrast (stddev/mean of Rec.709 luma) over the OPAQUE
 * (alpha>0) texels of a full RGBA8 buffer — the same "opaque-only" framing
 * `dilateTransparentRGB` already gives full-transparent texels its own
 * separate treatment for. Deliberately measured on the RAW sRGB BYTES, not
 * decoded to linear first: "contrast" is a perceptual quantity, the same
 * reasoning this file's own header (§3) already gives for why CAS itself
 * sharpens in gamma-2.0 space rather than linear light.
 * @param {Uint8Array|Uint8ClampedArray} data @param {number} w @param {number} h
 * @returns {number}
 */
export function computeRmsLuminanceContrast(data, w, h) {
  let lumaSum = 0;
  let lumaSqSum = 0;
  let n = 0;
  const count = w * h;
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    if (data[o + 3] <= 0) continue;
    const luma = data[o] * 0.2126 + data[o + 1] * 0.7152 + data[o + 2] * 0.0722;
    lumaSum += luma;
    lumaSqSum += luma * luma;
    n++;
  }
  return rmsContrastFromSums(lumaSum, lumaSqSum, n);
}

/**
 * ============================================================================
 * CONTRAST-PRESERVING MIP CORRECTION (2026-08-30, same audit as above, §2.2)
 * — the direct analogue of Castaño's coverage-preserving alpha mipmaps
 * (NVIDIA, 2010), applied to luminance instead of alpha coverage. Linear-
 * space filtering (the fix just above) is measurably CORRECT but also
 * measurably SOFTER on a high-contrast edge than the gamma-space averaging
 * it replaces — exactly the audit's own live diagnostic result
 * (`setAlbedoClarity({enabled:false})` reads as "mushy," meaning the
 * runtime CAS sharpen was compensating for real upstream softness, not
 * fighting a clean image). This is that repair, moved OFFLINE and upstream
 * of the BC encoder: a single scalar gain per level, computed from and
 * restoring toward level 0's OWN contrast statistic, so it is
 * deterministic, free at runtime, temporally stable (cannot shimmer as the
 * camera moves, unlike a per-frame shader sharpen), and — because it runs
 * before the encoder ever sees the level — it cannot amplify BC block
 * error the way sharpening an already-BLOCK-COMPRESSED level would.
 *
 * `gain` only ever RESTORES contrast toward the reference, never reduces it
 * below what the level already has (`Math.max(1, ...)`) — a level that
 * already matches (or exceeds) the reference is left alone.
 * ============================================================================
 * @param {Uint8Array|Uint8ClampedArray} data - modified IN PLACE.
 * @param {number} w @param {number} h
 * @param {number} refRmsContrast - level 0's own `computeRmsLuminanceContrast`.
 * @param {{gMax?:number}} [opts] - `gMax` caps the correction (default 3.0) —
 *   a numerical backstop matching `sharpenCasCore`'s own `GAIN_CEILING`
 *   reasoning (`vt/albedo-clarity.js`): a near-flat level's own measured
 *   contrast can be arbitrarily close to zero, and dividing by it without a
 *   ceiling risks a runaway correction on exactly the levels doing the least
 *   restoring.
 * @returns {number} the gain actually applied (1 = no-op).
 */
export function contrastPreservingCorrect(data, w, h, refRmsContrast, opts = {}) {
  const gMax = Number.isFinite(opts.gMax) ? opts.gMax : 3.0;
  const count = w * h;
  let lumaSum = 0;
  let lumaSqSum = 0;
  let n = 0;
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    if (data[o + 3] <= 0) continue;
    const luma = data[o] * 0.2126 + data[o + 1] * 0.7152 + data[o + 2] * 0.0722;
    lumaSum += luma;
    lumaSqSum += luma * luma;
    n++;
  }
  if (n === 0) return 1; // nothing opaque to correct
  const mean = lumaSum / n;
  const measured = rmsContrastFromSums(lumaSum, lumaSqSum, n);
  const gain = Math.max(1, Math.min(gMax, refRmsContrast / Math.max(measured, 1e-4)));
  if (gain <= 1.0001) return gain; // no-op — skip the second pass entirely
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    if (data[o + 3] <= 0) continue;
    data[o] = clampByte(mean + (data[o] - mean) * gain);
    data[o + 1] = clampByte(mean + (data[o + 1] - mean) * gain);
    data[o + 2] = clampByte(mean + (data[o + 2] - mean) * gain);
  }
  return gain;
}

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
 *          dilatePasses?:number, linearize?:boolean}} [opts] - `linearize`
 *   (default true) filters in LINEAR light, decoded from and re-encoded to
 *   sRGB — see this file's header §LINEARIZATION. `false` reproduces the
 *   ORIGINAL gamma-space-averaging behaviour byte-for-byte, kept specifically
 *   so the shader-lab bench can A/B the two directly.
 * @returns {{data:Uint8Array, width:number, height:number}}
 */
export function halveRGBA(readRows, srcW, srcH, opts = {}) {
  if (!(srcW > 0) || !(srcH > 0)) throw new Error(`halveRGBA: bad source size ${srcW}x${srcH}`);
  const { width: dstW, height: dstH } = halvedSize(srcW, srcH);
  const taps = opts.taps || buildHalveTaps();
  const bandRows = Math.max(1, opts.bandRows || 256);
  const nTaps = taps.offsets.length;
  const linearize = opts.linearize !== false;
  const decode = linearize ? (byte) => SRGB_TO_LINEAR[byte] : (byte) => byte;

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
        // Decoded to LINEAR first (header §LINEARIZATION) when `linearize` is
        // on — `ar`/`ag`/`ab` then accumulate in linear-times-alpha-fraction
        // scale rather than gamma-byte-times-alpha-fraction scale; the
        // unpremultiply math below is scale-agnostic either way (see its own
        // comment), only the FINAL byte write needs to know which mode ran.
        const al = band[i + 3];
        const pm = (al * w) / 255;
        ar += decode(band[i]) * pm;
        ag += decode(band[i + 1]) * pm;
        ab += decode(band[i + 2]) * pm;
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
        // Scale-agnostic unpremultiply (see `horizontalInto`'s own comment):
        // `r`/`g`/`b` land in LINEAR [0,1] when `linearize` is on, or the
        // ORIGINAL byte [0,255] scale when it's off — only the byte write
        // below needs to know which.
        if (linearize) {
          out[o] = clampByte(linearToSrgb(r < 0 ? 0 : r > 1 ? 1 : r) * 255);
          out[o + 1] = clampByte(linearToSrgb(g < 0 ? 0 : g > 1 ? 1 : g) * 255);
          out[o + 2] = clampByte(linearToSrgb(b < 0 ? 0 : b > 1 ? 1 : b) * 255);
        } else {
          out[o] = r < 0 ? 0 : r > 255 ? 255 : r;
          out[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
          out[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
        }
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
