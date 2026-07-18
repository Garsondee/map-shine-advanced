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
  // Build the palette the GPU will reconstruct.
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
  // Little-endian: c0 then c1 as uint16.
  out[off] = c0 & 0xff;
  out[off + 1] = (c0 >> 8) & 0xff;
  out[off + 2] = c1 & 0xff;
  out[off + 3] = (c1 >> 8) & 0xff;
  // 16 × 2-bit indices, texel 0 in the low bits of byte 4.
  let idxBits = 0;
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
    idxBits |= best << (i * 2);
  }
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

/** Nearest 4-bit index for one RGBA texel along the reconstructed endpoint line. */
function bestBC7Index(r, g, b, a, e0, e1) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < 16; i++) {
    const w = BC7_WEIGHTS4[i];
    const cr = (e0[0] * (64 - w) + e1[0] * w + 32) >> 6;
    const cg = (e0[1] * (64 - w) + e1[1] * w + 32) >> 6;
    const cb = (e0[2] * (64 - w) + e1[2] * w + 32) >> 6;
    const ca = (e0[3] * (64 - w) + e1[3] * w + 32) >> 6;
    const dr = r - cr,
      dg = g - cg,
      db = b - cb,
      da = a - ca;
    const d = dr * dr + dg * dg + db * db + da * da;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
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
  let q0 = quantizeBC7Endpoint([texels[bi * 4], texels[bi * 4 + 1], texels[bi * 4 + 2], texels[bi * 4 + 3]]);
  let q1 = quantizeBC7Endpoint([texels[bj * 4], texels[bj * 4 + 1], texels[bj * 4 + 2], texels[bj * 4 + 3]]);

  // Indices are chosen against the RECONSTRUCTED endpoints (what the GPU
  // interpolates), so the decode matches bit-for-bit.
  const idx = new Array(16);
  for (let i = 0; i < 16; i++) {
    idx[i] = bestBC7Index(texels[i * 4], texels[i * 4 + 1], texels[i * 4 + 2], texels[i * 4 + 3], q0.rec, q1.rec);
  }
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
