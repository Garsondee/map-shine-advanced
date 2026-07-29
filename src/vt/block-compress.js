/**
 * @fileoverview vt/block-compress.js — pure, GPU-free BLOCK TEXTURE COMPRESSION.
 *
 * WHY THIS EXISTS (2026-07-18, measured): Chrome's WebGPU device loses itself at
 * ~2.5 GB of resident texture on this hardware, where its far-older, hardened
 * WebGL degrades gracefully instead. A 12000² floor is 549 MB as RGBA8; both
 * floors of the mansion exceed the wall (~2.75 GB). GPU-compressed textures are
 * WebGPU's FIRST-CLASS answer (a core feature here, not a WebGL-style extension):
 * BC1 stores the same image at 0.5 byte/px (8× smaller), BC7 at 1 byte/px (4×)
 * with much better quality. Foundry's security model forbids writing generated
 * files back to its data directory, so we encode in the BROWSER (off-thread) and
 * cache the blocks in IndexedDB — nothing ever touches Foundry's filesystem.
 *
 * THIS MODULE IS THE ENCODER CORE: pure arithmetic over Uint8 pixel data,
 * Node-testable without a GPU (see __tests__/block-compress.test.mjs — it
 * round-trips every encoder through its own decoder). BC1 is implemented first
 * because its bit layout is the simplest to get provably correct, which lets us
 * prove the whole encode→cache→CompressedTexture→GPU pipeline at the lowest risk.
 * BC7 (alpha-carrying, mode 6) now lives below, behind the same
 * `encode*(rgba, w, h) → Uint8Array` shape — opaque content goes BC1 (8×), alpha
 * content goes BC7 (4×). The consumer wraps the output in a THREE.CompressedTexture
 * whose `format` matches (RGBA_S3TC_DXT1_Format for BC1, RGBA_BPTC_Format for BC7)
 * and whose single mip is `{ data, width, height }`.
 *
 * BC1 block = 8 bytes for a 4×4 texel group:
 *   bytes 0..1  color0 as RGB565, little-endian uint16
 *   bytes 2..3  color1 as RGB565, little-endian uint16
 *   bytes 4..7  sixteen 2-bit palette indices (texel 0 = bits 0..1 of byte 4)
 * If color0 > color1 (as uint16) the palette is 4 opaque colors
 *   [c0, c1, (2·c0+c1)/3, (c0+2·c1)/3]; otherwise it is 3 opaque colors plus a
 * transparent slot. We keep alpha out of BC1 entirely (opaque backgrounds are
 * BC1's job; alpha layers get BC7) and never emit index 3 in the 3-color case,
 * so no transparency ever leaks.
 */

/** RGB888 → packed RGB565 uint16 (the value the GPU stores and expands). */
function toRgb565(r, g, b) {
  const r5 = (r * 31 + 127) / 255;
  const g6 = (g * 63 + 127) / 255;
  const b5 = (b * 31 + 127) / 255;
  return ((Math.round(r5) & 0x1f) << 11) | ((Math.round(g6) & 0x3f) << 5) | (Math.round(b5) & 0x1f);
}

/** Packed RGB565 uint16 → {r,g,b} expanded to 8-bit EXACTLY as a GPU decodes it
 * (replicate the high bits into the low bits — the canonical 565→888 expand). */
function fromRgb565(v) {
  const r5 = (v >> 11) & 0x1f;
  const g6 = (v >> 5) & 0x3f;
  const b5 = v & 0x1f;
  return {
    r: (r5 << 3) | (r5 >> 2),
    g: (g6 << 2) | (g6 >> 4),
    b: (b5 << 3) | (b5 >> 2),
  };
}

// ===========================================================================
// THE SECOND ENDPOINT CANDIDATE — "diagonal parts of the black outline
// disappear/are mushed" (author, 2026-07-28, cutout tile art zoomed out).
//
// MEASURED before touching anything: a 3px-wide black ink ring around a filled
// disc, BC7-encoded with NO mip reduction and NO sharpening involved at all —
// axis-aligned ink texels decoded EXACT (luma 10.0 of a source 10.0); diagonal
// ink texels averaged luma 59.1 (max 78.8) and lost a third of their alpha. The
// mechanism is pure block-endpoint selection, both BC1 and BC7's own encoders:
// the two endpoints are chosen as the texels FARTHEST apart in colour(+alpha)
// space, and every OTHER texel in the block is then index-snapped onto the
// single line between them — a block containing a genuine THIRD cluster (ink
// black, separate from both the interior fill and the transparent hole) has no
// endpoint of its own for it, so it gets crushed toward whichever line was
// actually chosen. In BC7 this is worse than it sounds: alpha's 0..255 swing
// dominates the squared-distance metric so completely that the chosen pair is
// almost always (some opaque texel, the transparent hole) — leaving black ink
// and the coloured interior, both opaque, to fight over ONE shared endpoint.
//
// WHY DIAGONAL SPECIFICALLY: a diagonal silhouette sweeps its alpha cut across
// every row of a 4×4 block (the classic staircase), so a block straddling it is
// far likelier to contain all three clusters — interior, ink, hole — at once.
// The SAME ring crossing a block along a horizontal/vertical run instead
// repeats one row/column identically, so a given block usually holds only two.
//
// THE FIX, kept inside mode 6 / BC1's existing 2-endpoint format (no bitstream
// change): score a SECOND candidate pair — the darkest vs lightest opaque
// texel (`lumaExtremalPair`, below) — against the existing max-distance pair by
// ACTUAL total reconstruction error, and keep whichever is lower. This cannot
// regress a block the old heuristic already got right (the old pair is always
// one of the two options actually scored), and directly recovers the exact
// case above: a genuine second opaque cluster the distance pair swallowed now
// gets a real chance at an endpoint of its own. Cost is ~2× today's per-block
// work (one more quantize + 16-texel index search) — negligible next to the
// existing O(120)-pair distance search, and this runs once per asset, off the
// main thread, cached to IndexedDB.
// ===========================================================================

/**
 * The darkest-vs-lightest texel among those with alpha ≥ 128 ("meaningfully
 * opaque"), by standard luma weighting. Shared by both encoders: for BC1's
 * always-fully-opaque input (BC1 is only ever chosen for a wholly opaque
 * image — see bc-compress.worker.js) the alpha gate is a no-op and every texel
 * qualifies; for BC7 it is what keeps this search from picking a transparent
 * (or dilated, edge-adjacent) texel as a "dark" endpoint by accident. Returns
 * `null` with fewer than 2 qualifying texels — the existing distance pair
 * already handles a block with at most one opaque cluster just fine.
 * @param {number[]} texels flat [r,g,b,a,…] length 64
 * @returns {[number,number]|null} texel indices [darkest, lightest]
 */
function lumaExtremalPair(texels) {
  let lo = -1,
    hi = -1,
    loL = Infinity,
    hiL = -Infinity;
  for (let i = 0; i < 16; i++) {
    if (texels[i * 4 + 3] < 128) continue;
    const l = 0.299 * texels[i * 4] + 0.587 * texels[i * 4 + 1] + 0.114 * texels[i * 4 + 2];
    if (l < loL) {
      loL = l;
      lo = i;
    }
    if (l > hiL) {
      hiL = l;
      hi = i;
    }
  }
  return lo >= 0 && hi >= 0 && lo !== hi ? [lo, hi] : null;
}

/** The 4×4 texels of block (bx,by), edge-clamped so a width/height that is not a
 * multiple of 4 replicates its border rather than reading out of bounds. Returns
 * a flat [r,g,b,a, …] length-64 array. */
function gatherBlock(rgba, width, height, bx, by) {
  const out = new Array(64);
  for (let ty = 0; ty < 4; ty++) {
    const sy = Math.min(by * 4 + ty, height - 1);
    for (let tx = 0; tx < 4; tx++) {
      const sx = Math.min(bx * 4 + tx, width - 1);
      const si = (sy * width + sx) * 4;
      const di = (ty * 4 + tx) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = rgba[si + 3];
    }
  }
  return out;
}

/**
 * Encode RGBA8 pixels (row-major, 4 bytes/texel) to BC1 blocks.
 * @param {Uint8Array|Uint8ClampedArray} rgba length must be width*height*4
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array} blocksX*blocksY*8 bytes, blocks in row-major order
 */
export function encodeBC1(rgba, width, height) {
  if (width <= 0 || height <= 0) throw new Error(`encodeBC1: bad size ${width}x${height}`);
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`encodeBC1: rgba length ${rgba.length} != width*height*4 (${expected})`);
  }
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const out = new Uint8Array(blocksX * blocksY * 8);
  let o = 0;
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      encodeBC1Block(gatherBlock(rgba, width, height, bx, by), out, o);
      o += 8;
    }
  }
  return out;
}

/**
 * Quantize a BC1 candidate endpoint pair (texel indices bi/bj into `texels`),
 * build the palette the GPU will reconstruct, pick every texel's nearest entry,
 * and return the block's total squared RGB error for this pair — the metric
 * used to choose between competing candidates (see this file's "SECOND
 * ENDPOINT CANDIDATE" section header).
 */
function scoreBC1Pair(texels, bi, bj) {
  let c0 = toRgb565(texels[bi * 4], texels[bi * 4 + 1], texels[bi * 4 + 2]);
  let c1 = toRgb565(texels[bj * 4], texels[bj * 4 + 1], texels[bj * 4 + 2]);
  // 4-colour (fully opaque) mode requires c0 > c1. If they collapsed to equal
  // (a solid block) we fall through to 3-colour mode, which is also opaque as
  // long as we never pick index 3 (the transparent slot) — the nearest search
  // below only ever considers the opaque palette entries, so it never does.
  if (c0 < c1) {
    const t = c0;
    c0 = c1;
    c1 = t;
  }
  const e0 = fromRgb565(c0);
  const e1 = fromRgb565(c1);
  let pal;
  if (c0 > c1) {
    pal = [
      e0,
      e1,
      { r: (2 * e0.r + e1.r) / 3, g: (2 * e0.g + e1.g) / 3, b: (2 * e0.b + e1.b) / 3 },
      { r: (e0.r + 2 * e1.r) / 3, g: (e0.g + 2 * e1.g) / 3, b: (e0.b + 2 * e1.b) / 3 },
    ];
  } else {
    // 3-colour mode: index 3 is transparent black — deliberately excluded below.
    pal = [e0, e1, { r: (e0.r + e1.r) / 2, g: (e0.g + e1.g) / 2, b: (e0.b + e1.b) / 2 }, null];
  }
  const usable = pal[3] === null ? 3 : 4;
  const idx = new Array(16);
  let total = 0;
  for (let i = 0; i < 16; i++) {
    const r = texels[i * 4],
      g = texels[i * 4 + 1],
      b = texels[i * 4 + 2];
    let best = 0;
    let bestD = Infinity;
    for (let p = 0; p < usable; p++) {
      const dr = r - pal[p].r,
        dg = g - pal[p].g,
        db = b - pal[p].b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    idx[i] = best;
    total += bestD;
  }
  return { c0, c1, idx, total };
}

/** Encode one 4×4 block (flat rgba, length 64) into out[off..off+8). */
function encodeBC1Block(texels, out, off) {
  // Endpoints = the two texels FARTHEST apart in RGB space. A bounding box is
  // cheaper, but its corners can be colours present in NEITHER texel (a block of
  // pure red + pure blue has a box corner of magenta) — real quality loss the
  // tests caught. Max-distance lands both endpoints ON the actual colour axis.
  // O(120) pairs/block: fine for a one-time, cached encode; a principal-axis
  // method could speed this up later WITHOUT changing the format.
  let bi = 0,
    bj = 1,
    bd = -1;
  for (let i = 0; i < 16; i++) {
    for (let j = i + 1; j < 16; j++) {
      const dr = texels[i * 4] - texels[j * 4],
        dg = texels[i * 4 + 1] - texels[j * 4 + 1],
        db = texels[i * 4 + 2] - texels[j * 4 + 2];
      const d = dr * dr + dg * dg + db * db;
      if (d > bd) {
        bd = d;
        bi = i;
        bj = j;
      }
    }
  }

  // THE SECOND CANDIDATE (this file's section header) — score it against the
  // distance pair above and keep whichever reconstructs the block more
  // faithfully. Structurally cannot regress: the distance pair is always one
  // of the two options actually evaluated.
  let winner = scoreBC1Pair(texels, bi, bj);
  const lumaPair = lumaExtremalPair(texels);
  if (lumaPair !== null) {
    const candidate = scoreBC1Pair(texels, lumaPair[0], lumaPair[1]);
    if (candidate.total < winner.total) winner = candidate;
  }
  const { c0, c1, idx } = winner;

  // Little-endian: c0 then c1 as uint16.
  out[off] = c0 & 0xff;
  out[off + 1] = (c0 >> 8) & 0xff;
  out[off + 2] = c1 & 0xff;
  out[off + 3] = (c1 >> 8) & 0xff;
  // 16 × 2-bit indices, texel 0 in the low bits of byte 4.
  let idxBits = 0;
  for (let i = 0; i < 16; i++) idxBits |= idx[i] << (i * 2);
  out[off + 4] = idxBits & 0xff;
  out[off + 5] = (idxBits >> 8) & 0xff;
  out[off + 6] = (idxBits >> 16) & 0xff;
  out[off + 7] = (idxBits >> 24) & 0xff;
}

/**
 * Decode BC1 blocks back to RGBA8 — FOR TESTS AND VALIDATION ONLY. This is the
 * reference the GPU's fixed-function decoder matches, so a round-trip through
 * encodeBC1→decodeBC1 that lands close to the input proves the block layout and
 * palette math are correct without needing a GPU in the test runner.
 * @returns {Uint8Array} width*height*4
 */
export function decodeBC1(blocks, width, height) {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const out = new Uint8Array(width * height * 4);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const off = (by * blocksX + bx) * 8;
      const c0 = blocks[off] | (blocks[off + 1] << 8);
      const c1 = blocks[off + 2] | (blocks[off + 3] << 8);
      const e0 = fromRgb565(c0);
      const e1 = fromRgb565(c1);
      const pal =
        c0 > c1
          ? [
              e0,
              e1,
              { r: (2 * e0.r + e1.r) / 3, g: (2 * e0.g + e1.g) / 3, b: (2 * e0.b + e1.b) / 3 },
              { r: (e0.r + 2 * e1.r) / 3, g: (e0.g + 2 * e1.g) / 3, b: (e0.b + 2 * e1.b) / 3 },
            ]
          : [e0, e1, { r: (e0.r + e1.r) / 2, g: (e0.g + e1.g) / 2, b: (e0.b + e1.b) / 2 }, { r: 0, g: 0, b: 0, a: 0 }];
      const idxBits = blocks[off + 4] | (blocks[off + 5] << 8) | (blocks[off + 6] << 16) | (blocks[off + 7] << 24);
      for (let ty = 0; ty < 4; ty++) {
        const y = by * 4 + ty;
        if (y >= height) continue;
        for (let tx = 0; tx < 4; tx++) {
          const x = bx * 4 + tx;
          if (x >= width) continue;
          const i = ty * 4 + tx;
          const p = pal[(idxBits >>> (i * 2)) & 0x3];
          const di = (y * width + x) * 4;
          out[di] = Math.round(p.r) & 0xff;
          out[di + 1] = Math.round(p.g) & 0xff;
          out[di + 2] = Math.round(p.b) & 0xff;
          out[di + 3] = p.a === 0 ? 0 : 255;
        }
      }
    }
  }
  return out;
}

/** BYTES a BC1 encoding of width×height occupies (blocks × 8). Callers size the
 * IndexedDB cache and the GPU upload from this without running the encoder. */
export function bc1ByteLength(width, height) {
  return Math.ceil(width / 4) * Math.ceil(height / 4) * 8;
}

// ===========================================================================
// BC7 (mode 6) — the ALPHA-carrying compressor. BC1 has no alpha, so the
// multifloor overhead/roof overlays (which see the floor below through their
// alpha holes) stayed raw at 549 MB each and still lost the device on a floor
// switch. BC7 fixes that: 16 bytes/block (1 byte/px, 4× smaller than raw) WITH
// full alpha. Opaque content keeps using BC1 (8×, half of BC7's size); BC7 is
// specifically for the alpha layers.
//
// We implement ONE mode — mode 6 — deliberately, exactly as BC1 shipped one
// bit-layout first: mode 6 is the simplest BC7 block and can represent ANY
// content (1 subset, 2 endpoints, no partitions/rotation), so it is the mode
// whose bitstream is easiest to get provably correct. Crucially it gives FULL
// 8-bit RGBA endpoints (7 explicit bits + 1 shared p-bit per endpoint = 8) and
// 4-bit (16-level) indices — so a single-line block reconstructs to 8-bit
// precision, better than BC1's 565 endpoints, and alpha rides along for free.
// Higher-quality modes (partitions, per-channel alpha) can land later behind
// this same `encodeBC7(rgba,w,h) → Uint8Array` shape; the GPU decodes whatever
// mode each 16-byte block declares, so mixing modes in later is non-breaking.
//
// Mode 6 block = 128 bits, LSB-first:
//   bits 0..6    mode marker: six 0s then a 1 (value 0b1000000)
//   bits 7..62   R0 R1 G0 G1 B0 B1 A0 A1, 7 bits each (per-channel, both endpoints)
//   bit  63      P0   endpoint-0 shared p-bit (LSB below all four 7-bit channels)
//   bit  64      P1   endpoint-1 shared p-bit
//   bits 65..127 indices: texel 0 = 3 bits (anchor, MSB implied 0), texels 1..15
//                = 4 bits each, raster order. 3 + 15·4 = 63.
// Endpoint channel value the GPU reconstructs = (sevenBits << 1) | pbit  (8-bit).
// ===========================================================================

/** BC7 4-bit index interpolation weights (over 64). Symmetric: W[15−i] = 64−W[i],
 * which is why inverting an index is identical to swapping the two endpoints —
 * the trick the anchor fix below relies on. */
const BC7_WEIGHTS4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];

/** Quantize an 8-bit RGBA endpoint to mode 6's 7-bits-plus-shared-p-bit form.
 * The single p-bit is shared by all four channels, so we try p=0 and p=1 and
 * keep whichever reconstructs the four channels with least total error. Returns
 * the per-channel 7-bit values `q`, the chosen `p`, and the 8-bit `rec`onstructed
 * endpoint the GPU (and our index search, and our decoder) will actually use. */
function quantizeBC7Endpoint(e) {
  let best = null;
  for (let p = 0; p <= 1; p++) {
    const q = new Array(4);
    const rec = new Array(4);
    let err = 0;
    for (let c = 0; c < 4; c++) {
      let qc = Math.round((e[c] - p) / 2);
      if (qc < 0) qc = 0;
      if (qc > 127) qc = 127;
      const r = (qc << 1) | p;
      q[c] = qc;
      rec[c] = r;
      err += (e[c] - r) * (e[c] - r);
    }
    if (best === null || err < best.err) best = { q, p, rec, err };
  }
  return best;
}

/**
 * Quantize a BC7 candidate endpoint pair (texel indices bi/bj into `texels`),
 * pick every texel's nearest index against the RECONSTRUCTED endpoints (what
 * the GPU will actually interpolate — so the decode matches bit-for-bit), and
 * return the block's total squared RGBA error for this pair — the metric used
 * to choose between competing candidates (see this file's "SECOND ENDPOINT
 * CANDIDATE" section header).
 */
function scoreBC7Pair(texels, bi, bj) {
  const q0 = quantizeBC7Endpoint([texels[bi * 4], texels[bi * 4 + 1], texels[bi * 4 + 2], texels[bi * 4 + 3]]);
  const q1 = quantizeBC7Endpoint([texels[bj * 4], texels[bj * 4 + 1], texels[bj * 4 + 2], texels[bj * 4 + 3]]);
  const idx = new Array(16);
  let total = 0;
  for (let i = 0; i < 16; i++) {
    const r = texels[i * 4],
      g = texels[i * 4 + 1],
      b = texels[i * 4 + 2],
      a = texels[i * 4 + 3];
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < 16; k++) {
      const w = BC7_WEIGHTS4[k];
      const cr = (q0.rec[0] * (64 - w) + q1.rec[0] * w + 32) >> 6;
      const cg = (q0.rec[1] * (64 - w) + q1.rec[1] * w + 32) >> 6;
      const cb = (q0.rec[2] * (64 - w) + q1.rec[2] * w + 32) >> 6;
      const ca = (q0.rec[3] * (64 - w) + q1.rec[3] * w + 32) >> 6;
      const dr = r - cr,
        dg = g - cg,
        db = b - cb,
        da = a - ca;
      const d = dr * dr + dg * dg + db * db + da * da;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    idx[i] = best;
    total += bestD;
  }
  return { q0, q1, idx, total };
}

/** Encode one 4×4 RGBA block (flat, length 64) into out[off..off+16) as BC7 mode 6. */
function encodeBC7Block(texels, out, off) {
  // Endpoints = the two texels farthest apart in 4-D RGBA space (same rationale
  // as BC1: a max-distance pair lands both endpoints on the real colour+alpha
  // axis, unlike a bounding box whose corners can be values present in neither).
  let bi = 0,
    bj = 0,
    bd = -1;
  for (let i = 0; i < 16; i++) {
    for (let j = i + 1; j < 16; j++) {
      const dr = texels[i * 4] - texels[j * 4],
        dg = texels[i * 4 + 1] - texels[j * 4 + 1],
        db = texels[i * 4 + 2] - texels[j * 4 + 2],
        da = texels[i * 4 + 3] - texels[j * 4 + 3];
      const d = dr * dr + dg * dg + db * db + da * da;
      if (d > bd) {
        bd = d;
        bi = i;
        bj = j;
      }
    }
  }

  // THE SECOND CANDIDATE (this file's section header) — score it against the
  // distance pair above and keep whichever reconstructs the block more
  // faithfully. Structurally cannot regress: the distance pair is always one
  // of the two options actually evaluated.
  let winner = scoreBC7Pair(texels, bi, bj);
  const lumaPair = lumaExtremalPair(texels);
  if (lumaPair !== null) {
    const candidate = scoreBC7Pair(texels, lumaPair[0], lumaPair[1]);
    if (candidate.total < winner.total) winner = candidate;
  }
  const { idx } = winner;
  let { q0, q1 } = winner;

  // Anchor rule: texel 0's index stores only 3 bits, so its MSB must be 0. If it
  // isn't, swap the endpoints and invert every index (W[15−i] = 64−W[i] makes
  // that an exact equivalent) — after which idx[0] ≤ 7.
  if (idx[0] & 8) {
    for (let i = 0; i < 16; i++) idx[i] = 15 - idx[i];
    const t = q0;
    q0 = q1;
    q1 = t;
  }

  let bit = off * 8;
  const write = (val, n) => {
    for (let k = 0; k < n; k++) {
      if ((val >> k) & 1) out[bit >> 3] |= 1 << (bit & 7);
      bit++;
    }
  };
  write(0b1000000, 7); // mode 6 marker
  write(q0.q[0], 7);
  write(q1.q[0], 7);
  write(q0.q[1], 7);
  write(q1.q[1], 7);
  write(q0.q[2], 7);
  write(q1.q[2], 7);
  write(q0.q[3], 7);
  write(q1.q[3], 7);
  write(q0.p, 1);
  write(q1.p, 1);
  write(idx[0], 3); // anchor texel: 3 bits
  for (let i = 1; i < 16; i++) write(idx[i], 4);
}

/**
 * Encode RGBA8 pixels to BC7 (mode 6) blocks. Same shape as {@link encodeBC1};
 * carries alpha. 16 bytes per 4×4 block.
 * @param {Uint8Array|Uint8ClampedArray} rgba length must be width*height*4
 * @param {number} width @param {number} height
 * @returns {Uint8Array} blocksX*blocksY*16 bytes, row-major
 */
export function encodeBC7(rgba, width, height) {
  if (width <= 0 || height <= 0) throw new Error(`encodeBC7: bad size ${width}x${height}`);
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`encodeBC7: rgba length ${rgba.length} != width*height*4 (${expected})`);
  }
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const out = new Uint8Array(blocksX * blocksY * 16);
  let o = 0;
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      encodeBC7Block(gatherBlock(rgba, width, height, bx, by), out, o);
      o += 16;
    }
  }
  return out;
}

/**
 * Decode BC7 blocks to RGBA8 — FOR TESTS AND VALIDATION ONLY, and only for the
 * mode-6 blocks this module emits (a general BC7 decoder is the GPU's job). It
 * matches the GPU's fixed-function decode, so an encodeBC7→decodeBC7 round-trip
 * proves the mode-6 bit layout without a GPU.
 * @returns {Uint8Array} width*height*4
 */
export function decodeBC7(blocks, width, height) {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const out = new Uint8Array(width * height * 4);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      let bit = (by * blocksX + bx) * 16 * 8;
      const read = (n) => {
        let v = 0;
        for (let k = 0; k < n; k++) {
          if ((blocks[bit >> 3] >> (bit & 7)) & 1) v |= 1 << k;
          bit++;
        }
        return v;
      };
      // Mode = number of leading zero bits before the first 1 (unary).
      let mode = 0;
      while (mode < 8 && read(1) === 0) mode++;
      if (mode !== 6) throw new Error(`decodeBC7: only mode 6 supported (got ${mode})`);
      const r0 = read(7),
        r1 = read(7),
        g0 = read(7),
        g1 = read(7),
        b0 = read(7),
        b1 = read(7),
        a0 = read(7),
        a1 = read(7);
      const p0 = read(1),
        p1 = read(1);
      const e0 = [(r0 << 1) | p0, (g0 << 1) | p0, (b0 << 1) | p0, (a0 << 1) | p0];
      const e1 = [(r1 << 1) | p1, (g1 << 1) | p1, (b1 << 1) | p1, (a1 << 1) | p1];
      const idx = new Array(16);
      idx[0] = read(3);
      for (let i = 1; i < 16; i++) idx[i] = read(4);
      for (let ty = 0; ty < 4; ty++) {
        const y = by * 4 + ty;
        if (y >= height) continue;
        for (let tx = 0; tx < 4; tx++) {
          const x = bx * 4 + tx;
          if (x >= width) continue;
          const w = BC7_WEIGHTS4[idx[ty * 4 + tx]];
          const di = (y * width + x) * 4;
          out[di] = (e0[0] * (64 - w) + e1[0] * w + 32) >> 6;
          out[di + 1] = (e0[1] * (64 - w) + e1[1] * w + 32) >> 6;
          out[di + 2] = (e0[2] * (64 - w) + e1[2] * w + 32) >> 6;
          out[di + 3] = (e0[3] * (64 - w) + e1[3] * w + 32) >> 6;
        }
      }
    }
  }
  return out;
}

/** BYTES a BC7 encoding of width×height occupies (blocks × 16). */
export function bc7ByteLength(width, height) {
  return Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
}

// ===========================================================================
// MIP CHAIN DIMENSIONS — the "MSA looks noisier than PIXI when zoomed out" fix
// (2026-07-19, author screenshot comparison at matched zoom levels).
//
// THE CAUSE: every whole-image texture (compressed AND raw fallback) was built
// with generateMipmaps:false + LinearFilter. That pairing was copied from
// atlas.js's page atlas, where it is CORRECT (an atlas slot's neighbours are
// arbitrary bookkeeping, so automatic mip selection across a page boundary is
// meaningless — see atlas.js's own header). A whole-image texture is not an
// atlas: it is one ordinary image, and minifying it with no mip chain is
// textbook aliasing — exactly what PIXI's own mipmapped textures don't show.
// The fix restores real prefiltering; it does not touch the atlas or the
// indirection texture, where the no-mipmap rule still applies.
//
// A block-compressed format (BC1/BC7) cannot have its mip chain
// GPU-auto-generated — `generateMipmaps` only drives the WebGPU/WebGL
// backend's own box-filter pass, which does not run on block-compressed data
// (verified: three.webgpu.js's `getMipLevels`/`needsMipmaps` key off
// `texture.mipmaps.length`, not the boolean, for exactly this reason — see
// bc-compress.worker.js's header for the encode-side half of this fix). So a
// REAL chain must be supplied, one BC-encoded level per mip, precomputed here.
//
// THIS FUNCTION is the pure geometry: given a level-0 size already padded to
// the 4×4 block grid, what size is every subsequent level? Verified against
// three.webgpu.js's `_copyCompressedBufferToTexture` (`bytesPerRow`/
// `textureWidth` are derived from `mipmap.width` ALONE, per level — there is
// no cross-level dependency at upload time), so the only thing that must
// match is what `device.createTexture` implicitly allocates per level, which
// is the standard GPU rule `max(1, base >> level)`. Iterating "halve the
// previous level" is PROVABLY identical to computing `base >> i` directly,
// because integer right-shift composes exactly: `(a >> 1) >> 1 === a >> 2`.
// That equivalence is what makes a level-by-level loop (needed anyway, since
// each level is independently re-downsampled from the source — see the
// worker) land on exactly the sizes a real GPU mip chain expects, with no
// separate "recompute from the top" step required.
// ===========================================================================

/**
 * The full GPU mip-chain size sequence for a block-compressed texture whose
 * level 0 is already padded to the 4×4 block grid (`Math.ceil(_/4)*4`). Pure;
 * no encoding happens here — this only says how big each level is.
 *
 * @param {number} padW0 - level 0 width, already a multiple of 4.
 * @param {number} padH0 - level 0 height, already a multiple of 4.
 * @returns {Array<{logicalWidth:number, logicalHeight:number, width:number, height:number}>}
 *   one entry per mip level, level 0 first, ending at a 1×1 (or 1×N/N×1 for an
 *   extreme aspect ratio) level. `logicalWidth/logicalHeight` is the exact
 *   resolution to render/encode this level AT (what the worker downsamples
 *   the source image to); `width/height` is that, re-padded to the block grid
 *   — the value to declare as the mipmap's own width/height (matches level 0's
 *   own convention of storing the padded size directly).
 */
export function computeMipChainDims(padW0, padH0) {
  if (!(padW0 > 0) || !(padH0 > 0)) {
    throw new Error(`computeMipChainDims: bad base size ${padW0}x${padH0}`);
  }
  const levels = [{ logicalWidth: padW0, logicalHeight: padH0, width: padW0, height: padH0 }];
  let w = padW0;
  let h = padH0;
  while (w > 1 || h > 1) {
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
    levels.push({ logicalWidth: w, logicalHeight: h, width: Math.ceil(w / 4) * 4, height: Math.ceil(h / 4) * 4 });
  }
  return levels;
}

/**
 * TOTAL GPU-resident bytes for a block-compressed texture's FULL mip chain —
 * the honest VRAM number now that whole-image BC1/BC7 textures carry a real
 * chain (see this file's mip-chain header). A single-level `bc1ByteLength`/
 * `bc7ByteLength` call under-reports by ~33% (the chain's own geometric-series
 * overhead, 1 + 1/4 + 1/16 + ... → 4/3) — exactly the class of drift
 * memory:feedback_instruments_must_not_lie exists to catch, so this sums the
 * SAME per-level padded sizes the worker actually encodes and uploads
 * (`computeMipChainDims`), not an approximation of them.
 * @param {'bc1'|'bc7'} format @param {number} width @param {number} height -
 *   the LOGICAL (pre-padding) level-0 size, e.g. a tile's own `sw`/`sh`.
 * @returns {number} total bytes across every level.
 */
export function mipChainByteLength(format, width, height) {
  const perLevel = format === 'bc7' ? bc7ByteLength : bc1ByteLength;
  const padW0 = Math.ceil(width / 4) * 4;
  const padH0 = Math.ceil(height / 4) * 4;
  let total = 0;
  for (const lvl of computeMipChainDims(padW0, padH0)) total += perLevel(lvl.width, lvl.height);
  return total;
}

// ===========================================================================
// STRIP DRIVER — encode without ever holding the whole image in memory.
//
// WHY (2026-07-18, measured): the worker used to `getImageData(0,0,w,h)` the
// entire image — 576 MB for a 12000² floor — then hand that to encodeBC7. On a
// 144-megapixel alpha layer that peak (576 MB readback + the ImageBitmap + the
// block buffer) fell over inside the worker, the BC7 encode never returned, and
// the layer dropped to the raw path and uploaded itself at 549 MB, re-killing the
// device on a floor switch (bc7:0 in the flight recorder was the receipt).
//
// This driver pulls the image in 4-row-aligned BANDS via a caller-supplied
// `readStrip(y, h)` and encodes each band independently, writing its blocks to
// their block-row offset. BC blocks are independent and row-major (see the
// `for (by) for (bx)` in encodeBC1/encodeBC7), and every band starts on a 4-row
// boundary, so a full-height block-row is NEVER split across bands and NO band
// boundary introduces edge-clamping that the whole-image encode wouldn't also do.
// The concatenation is therefore BIT-IDENTICAL to encoding the whole image at
// once — proven in the tests (encodeStriped === encodeBC1/encodeBC7). This is a
// pure memory-bounding transform, not a quality tradeoff.
// ===========================================================================

/**
 * Encode an image to BC1/BC7 blocks band-by-band, never materializing the whole
 * image. `readStrip(y, h)` must return the RGBA8 bytes for rows [y, y+h) as a
 * length-(width*h*4) Uint8Array|Uint8ClampedArray. The caller owns HOW those rows
 * are produced (a worker draws a source band into a small canvas and reads it
 * back; a test slices an in-memory array) — this function only drives the bands
 * and stitches the output.
 * @param {(y:number,h:number)=>Uint8Array|Uint8ClampedArray} readStrip
 * @param {number} width
 * @param {number} height
 * @param {'bc1'|'bc7'} format
 * @param {number} [stripRows=512] requested band height; rounded DOWN to a
 *   multiple of 4 (the block height) so bands align to the block grid.
 * @returns {Uint8Array} identical bytes to encodeBC1/encodeBC7 of the same image.
 */
export function encodeStriped(readStrip, width, height, format, stripRows = 512) {
  if (width <= 0 || height <= 0) throw new Error(`encodeStriped: bad size ${width}x${height}`);
  if (format !== 'bc1' && format !== 'bc7') throw new Error(`encodeStriped: bad format ${format}`);
  const encodeFn = format === 'bc7' ? encodeBC7 : encodeBC1;
  const bytesPerBlock = format === 'bc7' ? 16 : 8;
  const rowStride = Math.ceil(width / 4) * bytesPerBlock; // bytes in one block-row
  const out = new Uint8Array(Math.ceil(height / 4) * rowStride);
  const step = Math.max(4, stripRows - (stripRows % 4)); // align band to the 4-row block grid
  for (let y = 0; y < height; y += step) {
    const h = Math.min(step, height - y);
    const strip = readStrip(y, h);
    if (!strip || strip.length !== width * h * 4) {
      throw new Error(
        `encodeStriped: readStrip(${y},${h}) returned ${strip ? strip.length : 'null'}, expected ${width * h * 4}`
      );
    }
    // y is always a multiple of 4 (starts at 0, step is a multiple of 4), so the
    // destination block-row index y/4 is exact.
    out.set(encodeFn(strip, width, h), (y / 4) * rowStride);
  }
  return out;
}
