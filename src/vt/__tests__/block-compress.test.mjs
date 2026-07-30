/**
 * Node verification for vt/block-compress.js — the pure BC block encoder behind
 * the WebGPU-memory-ceiling fix (compress floors so both fit under Chrome's
 * ~2.5 GB WebGPU wall; see block-compress.js's header). No GPU needed: every
 * case ENCODES then DECODES with this module's own reference decoder, so a
 * round-trip that lands close to the input proves the BC1 block layout, palette
 * math, mode selection, and block ordering are correct — the exact thing the
 * GPU's fixed-function decoder will do.
 */
import {
  encodeBC1,
  decodeBC1,
  bc1ByteLength,
  encodeBC7,
  decodeBC7,
  bc7ByteLength,
  encodeStriped,
  computeMipChainDims,
  mipChainByteLength,
} from '../block-compress.js';

/** Build a width×height RGBA8 image from a per-pixel fn(x,y) → [r,g,b,a]. */
function makeImage(width, height, fn) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fn(x, y);
      const i = (y * width + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = a ?? 255;
    }
  }
  return rgba;
}

/** Max absolute per-channel (RGB) error between two same-size RGBA images. */
function maxRgbError(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i += 4) {
    m = Math.max(m, Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
  }
  return m;
}

/** Max absolute per-channel error INCLUDING alpha (the channel BC7 must carry). */
function maxRgbaError(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

/** Round-trip an image and return {out, err}. */
function roundTrip(rgba, w, h) {
  const blocks = encodeBC1(rgba, w, h);
  const out = decodeBC1(blocks, w, h);
  return { blocks, out, err: maxRgbError(rgba, out) };
}

export function run(t) {
  const { ok, throws } = t;

  // ---- Sizing -------------------------------------------------------------
  ok('bc1ByteLength: 8×8 → 4 blocks × 8B = 32', bc1ByteLength(8, 8) === 32);
  ok('bc1ByteLength rounds partial blocks up: 6×5 → 2×2 blocks = 32', bc1ByteLength(6, 5) === 32);
  ok('bc1ByteLength: 12000² → the mansion floor bill', bc1ByteLength(12000, 12000) === 3000 * 3000 * 8);
  ok(
    'encodeBC1 output length == bc1ByteLength (8×8)',
    encodeBC1(
      makeImage(8, 8, () => [10, 20, 30, 255]),
      8,
      8
    ).length === bc1ByteLength(8, 8)
  );

  // ---- Exactly-representable cases must round-trip PERFECTLY ---------------
  // Black & white are exact in RGB565, and a 2-colour block picks them as the
  // endpoints (c0=white>c1=black ⇒ opaque 4-colour mode), so err must be 0.
  {
    const img = makeImage(4, 4, (x, y) => ((x + y) & 1 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const { err } = roundTrip(img, 4, 4);
    ok('black/white checkerboard round-trips exactly (err 0)', err === 0);
  }
  {
    // A 4-wide black→white ramp lands on exactly the 4 BC1 palette levels
    // (0, 85, 170, 255), so it too is exact — validates all four index values.
    const ramp = [0, 85, 170, 255];
    const img = makeImage(4, 4, (x) => [ramp[x], ramp[x], ramp[x], 255]);
    const { err } = roundTrip(img, 4, 4);
    ok('4-level gray ramp hits the palette exactly (err 0)', err === 0);
  }

  // ---- Quantization-limited cases: recovered within one 565 step ----------
  // ⚠️ THESE BARS ARE DELIBERATELY TIGHT (2026-07-29, halved from ≤ 8 by the
  // toRgb565 endpoint-bias fix — see that function's own doc). A bar set at
  // twice the real error cannot fail, so it is not an instrument; these sit at
  // the measured value so the bias CANNOT silently come back. If one of these
  // starts failing, the endpoint quantizer moved — check its rounding before
  // anything else.
  {
    const img = makeImage(4, 4, () => [130, 96, 200, 255]); // solid mid colour
    const { err } = roundTrip(img, 4, 4);
    ok('solid colour recovers within 565 quantization (≤ 2)', err <= 2);
  }
  {
    // Two arbitrary opaque colours, both present in the block.
    const A = [200, 40, 40];
    const B = [30, 60, 210];
    const img = makeImage(4, 4, (x) => [...(x < 2 ? A : B), 255]);
    const { err } = roundTrip(img, 4, 4);
    ok('two-colour block recovers within 565 quantization (≤ 4)', err <= 4);
  }
  {
    // THE BIAS ITSELF, asserted directly rather than only via the bars above:
    // the old quantizer's error was ONE-DIRECTIONAL (every channel decoded
    // brighter than authored, +4.08/255 mean over all inputs), which is what
    // made it uncancellable downstream. A mid-grey ramp is the cleanest probe —
    // its mean SIGNED error must now straddle zero, not sit above it.
    const img = makeImage(16, 16, (x, y) => {
      const v = 40 + ((x * 13 + y * 7) % 176);
      return [v, v, v, 255];
    });
    const out = decodeBC1(encodeBC1(img, 16, 16), 16, 16);
    let signed = 0;
    let n = 0;
    for (let i = 0; i < img.length; i += 4)
      for (let c = 0; c < 3; c++) {
        signed += out[i + c] - img[i + c];
        n++;
      }
    ok('BC1 endpoints carry no systematic brightening bias (|mean signed| ≤ 1)', Math.abs(signed / n) <= 1);
  }

  // ---- Block ordering + gather coords across multiple blocks --------------
  {
    // 8×4 = two horizontally-adjacent blocks: left red, right blue. Correct
    // row-major block order + edge-clamped gather ⇒ each half comes back right.
    const img = makeImage(8, 4, (x) => (x < 4 ? [230, 0, 0, 255] : [0, 0, 230, 255]));
    const { out } = roundTrip(img, 8, 4);
    const px = (x, y) => out[(y * 8 + x) * 4 + (x < 4 ? 0 : 2)]; // red chan left, blue chan right
    ok('multi-block: left block stays red, right stays blue', px(1, 1) > 200 && px(6, 2) > 200);
  }

  // ---- Non-multiple-of-4 dimensions: edge replication, no OOB -------------
  {
    const w = 6,
      h = 5;
    // 1-D horizontal grey ramp: BC1's palette is a 1-D line, so this is content
    // it CAN represent — the case tests edge-block replication + byte count, not
    // BC1's (real, fundamental) inability to fit a 2-D colour spread in a block.
    const img = makeImage(w, h, (x) => {
      const v = (x * 40) & 255;
      return [v, v, v, 255];
    });
    const blocks = encodeBC1(img, w, h);
    ok('6×5 encodes to the padded-block byte count', blocks.length === bc1ByteLength(w, h));
    const out = decodeBC1(blocks, w, h);
    ok('6×5 decodes back to exactly w*h*4 bytes', out.length === w * h * 4);
    // ≤ 40 was a placeholder bar an order of magnitude above the real error and
    // could not have failed; the measured value is 4. See the tightening note
    // on the quantization-limited cases above.
    ok('6×5 (1-D ramp) content is recovered (bounded error)', maxRgbError(img, out) <= 4);
  }

  // ---- Determinism + input validation ------------------------------------
  {
    const img = makeImage(4, 4, (x, y) => [(x * 17 + y * 9) & 255, (y * 23) & 255, 100, 255]);
    const a = encodeBC1(img, 4, 4);
    const b = encodeBC1(img, 4, 4);
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
    ok('encoding is deterministic', same);
  }
  throws('encodeBC1 rejects wrong-length input', () => encodeBC1(new Uint8Array(10), 4, 4), 'length');
  throws('encodeBC1 rejects a non-positive size', () => encodeBC1(new Uint8Array(0), 0, 0), 'size');

  // ======================================================================
  // BC7 (mode 6) — the ALPHA-carrying compressor. Same round-trip proof: the
  // reference decoder matches the GPU's fixed-function mode-6 decode, so a
  // close encode→decode proves the bit layout, p-bit sharing, anchor rule, and
  // block ordering. The cases alpha-vary DELIBERATELY — that is exactly what
  // BC1 could not do and what this format exists for.
  // ======================================================================

  // ---- Sizing: 16 bytes/block --------------------------------------------
  ok('bc7ByteLength: 8×8 → 4 blocks × 16B = 64', bc7ByteLength(8, 8) === 64);
  ok('bc7ByteLength rounds partial blocks up: 6×5 → 2×2 blocks × 16 = 64', bc7ByteLength(6, 5) === 64);
  ok('bc7ByteLength: 12000² floor bill (1 B/px)', bc7ByteLength(12000, 12000) === 3000 * 3000 * 16);
  ok(
    'encodeBC7 output length == bc7ByteLength (8×8)',
    encodeBC7(
      makeImage(8, 8, () => [10, 20, 30, 128]),
      8,
      8
    ).length === bc7ByteLength(8, 8)
  );

  // ---- Solid opaque colour: 8-bit endpoints recover near-exactly ---------
  {
    const img = makeImage(4, 4, () => [130, 96, 200, 255]);
    const out = decodeBC7(encodeBC7(img, 4, 4), 4, 4);
    // 8-bit endpoints + one shared p-bit ⇒ at most ~1 per channel, unlike BC1's 565.
    ok('BC7 solid colour recovers to 8-bit precision (≤ 2)', maxRgbaError(img, out) <= 2);
  }

  // ---- Solid semi-transparent: ALPHA must survive (BC1 cannot do this) ----
  {
    const img = makeImage(4, 4, () => [200, 50, 50, 128]);
    const out = decodeBC7(encodeBC7(img, 4, 4), 4, 4);
    ok('BC7 carries a constant alpha (a≈128, ≤ 2)', Math.abs(out[3] - 128) <= 2);
    ok('BC7 solid+alpha recovers all channels (≤ 2)', maxRgbaError(img, out) <= 2);
  }

  // ---- Alpha GRADIENT across the block: the multifloor overlay case -------
  {
    // RGB constant, alpha ramps 0→255 across x on the 4 BC7 index levels that a
    // 4-wide block lands on. Proves alpha is interpolated per-texel, not flattened.
    const aRamp = [0, 85, 170, 255];
    const img = makeImage(4, 4, (x) => [180, 180, 180, aRamp[x]]);
    const out = decodeBC7(encodeBC7(img, 4, 4), 4, 4);
    const alphaAt = (x) => out[(0 * 4 + x) * 4 + 3];
    ok('BC7 alpha gradient stays monotonic across x', alphaAt(0) < alphaAt(1) && alphaAt(1) < alphaAt(3));
    ok('BC7 alpha gradient endpoints land near 0 and 255', alphaAt(0) <= 8 && alphaAt(3) >= 247);
    ok('BC7 alpha gradient recovers within index quantization (≤ 24)', maxRgbaError(img, out) <= 24);
  }

  // ---- Colour + alpha together, both varying -----------------------------
  {
    const img = makeImage(4, 4, (x) => (x < 2 ? [220, 30, 30, 60] : [30, 40, 220, 240]));
    const out = decodeBC7(encodeBC7(img, 4, 4), 4, 4);
    ok('BC7 two-colour+alpha block recovers (≤ 6)', maxRgbaError(img, out) <= 6);
  }

  // ---- Non-multiple-of-4 dims: edge replication, exact byte count ---------
  {
    const w = 6,
      h = 5;
    const img = makeImage(w, h, (x) => {
      const v = (x * 40) & 255;
      return [v, v, v, (x * 50) & 255];
    });
    const blocks = encodeBC7(img, w, h);
    ok('BC7 6×5 encodes to the padded-block byte count', blocks.length === bc7ByteLength(w, h));
    const out = decodeBC7(blocks, w, h);
    ok('BC7 6×5 decodes back to exactly w*h*4 bytes', out.length === w * h * 4);
    ok('BC7 6×5 (1-D colour+alpha ramp) recovered (bounded)', maxRgbaError(img, out) <= 40);
  }

  // ---- Multi-block ordering ----------------------------------------------
  {
    const img = makeImage(8, 4, (x) => (x < 4 ? [230, 0, 0, 200] : [0, 0, 230, 80]));
    const out = decodeBC7(encodeBC7(img, 8, 4), 8, 4);
    const red = out[(1 * 8 + 1) * 4]; // left block, red channel
    const blue = out[(2 * 8 + 6) * 4 + 2]; // right block, blue channel
    ok('BC7 multi-block: left stays red, right stays blue', red > 200 && blue > 200);
    ok('BC7 multi-block: left alpha ≈200, right ≈80', Math.abs(out[(1 * 8 + 1) * 4 + 3] - 200) <= 8);
  }

  // ---- Determinism + input validation ------------------------------------
  {
    const img = makeImage(4, 4, (x, y) => [(x * 17 + y * 9) & 255, (y * 23) & 255, 100, (x * 31 + y * 7) & 255]);
    const a = encodeBC7(img, 4, 4);
    const b = encodeBC7(img, 4, 4);
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
    ok('BC7 encoding is deterministic', same);
  }
  throws('encodeBC7 rejects wrong-length input', () => encodeBC7(new Uint8Array(10), 4, 4), 'length');
  throws('encodeBC7 rejects a non-positive size', () => encodeBC7(new Uint8Array(0), 0, 0), 'size');

  // ======================================================================
  // STRIP DRIVER — the worker-OOM fix. encodeStriped pulls the image in
  // 4-row-aligned bands and encodes each independently. The LOAD-BEARING claim
  // is that this is BIT-IDENTICAL to a whole-image encode (so it changes memory,
  // never pixels). We prove it by exact byte equality against encodeBC1/encodeBC7
  // for the cases that could break it: multiple bands, a final partial band, a
  // strip height that isn't a multiple of 4, and dims that aren't multiples of 4.
  // ======================================================================

  /** A band reader over an in-memory image — the pure analogue of the worker's
   * canvas readback. subarray is a view, no copy. */
  const stripsOf = (rgba, w) => (y, h) => rgba.subarray(y * w * 4, (y + h) * w * 4);
  const bytesEqual = (a, b) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };

  {
    // A colour+alpha gradient so every block differs — a constant image would
    // pass even a broken stitch. 16 wide, 40 tall, bands of 8 → 5 equal bands.
    const w = 16,
      h = 40;
    const img = makeImage(w, h, (x, y) => [(x * 13) & 255, (y * 7) & 255, (x * y) & 255, (x * 11 + y * 5) & 255]);
    ok(
      'encodeStriped(bc7) == whole encodeBC7 (16×40, 5 bands of 8)',
      bytesEqual(encodeStriped(stripsOf(img, w), w, h, 'bc7', 8), encodeBC7(img, w, h))
    );
    ok(
      'encodeStriped(bc1) == whole encodeBC1 (16×40, 5 bands of 8)',
      bytesEqual(encodeStriped(stripsOf(img, w), w, h, 'bc1', 8), encodeBC1(img, w, h))
    );
    ok(
      'encodeStriped in ONE band (stripRows ≥ height) == whole',
      bytesEqual(encodeStriped(stripsOf(img, w), w, h, 'bc7', 4096), encodeBC7(img, w, h))
    );
  }

  {
    // Height NOT a multiple of the band step: a final partial band whose bottom
    // rows edge-clamp exactly as the whole-image encode's last block-row does.
    const w = 16,
      h = 43; // 43 % 8 ≠ 0 and 43 % 4 ≠ 0 → remainder band AND a clamped block-row
    const img = makeImage(w, h, (x, y) => [(x * 9 + y) & 255, (y * 3) & 255, 77, (y * 6) & 255]);
    ok(
      'encodeStriped(bc7) == whole for a final partial band (16×43, step 8)',
      bytesEqual(encodeStriped(stripsOf(img, w), w, h, 'bc7', 8), encodeBC7(img, w, h))
    );
  }

  {
    // stripRows NOT a multiple of 4 must be rounded DOWN to 4 internally and still
    // match; and non-multiple-of-4 WIDTH must right-edge-clamp identically.
    const w = 18,
      h = 41; // both non-multiples of 4
    const img = makeImage(w, h, (x, y) => [(x * x) & 255, (y * y) & 255, (x + y) & 255, (x * 4 + y * 2) & 255]);
    ok(
      'encodeStriped(bc7) == whole with stripRows=10 (aligned to 8), 18×41',
      bytesEqual(encodeStriped(stripsOf(img, w), w, h, 'bc7', 10), encodeBC7(img, w, h))
    );
    ok(
      'encodeStriped(bc1) == whole with stripRows=6 (aligned to 4), 18×41',
      bytesEqual(encodeStriped(stripsOf(img, w), w, h, 'bc1', 6), encodeBC1(img, w, h))
    );
  }

  // ---- Strip driver: input validation ------------------------------------
  throws(
    'encodeStriped rejects an unknown format',
    () => encodeStriped(() => new Uint8Array(0), 4, 4, 'bc9', 4),
    'format'
  );
  throws(
    'encodeStriped rejects a non-positive size',
    () => encodeStriped(() => new Uint8Array(0), 0, 0, 'bc1', 4),
    'size'
  );
  throws(
    'encodeStriped rejects a readStrip that returns the wrong length',
    () => encodeStriped(() => new Uint8Array(3), 4, 4, 'bc1', 4),
    'readStrip'
  );

  // ======================================================================
  // MIP CHAIN DIMENSIONS — the "MSA noisier than PIXI when zoomed out" fix.
  // computeMipChainDims is the pure geometry a real GPU mip chain must match;
  // these prove the level sizes AND the load-bearing claim that iterating
  // "halve the previous level" lands on exactly `base >> i` at every step
  // (verified independently below, not just asserted by the implementation).
  // ======================================================================

  {
    const levels = computeMipChainDims(8, 8);
    ok('8x8 chain has 4 levels (8,4,2,1)', levels.length === 4);
    ok('8x8 level0 is the base, unpadded change', levels[0].width === 8 && levels[0].height === 8);
    ok('8x8 level1 logical 4x4, padded 4x4', levels[1].logicalWidth === 4 && levels[1].width === 4);
    ok('8x8 level2 logical 2x2, padded UP to 4x4', levels[2].logicalWidth === 2 && levels[2].width === 4);
    ok('8x8 level3 (last) logical 1x1, padded 4x4', levels[3].logicalWidth === 1 && levels[3].width === 4);
  }

  {
    // A base size that is NOT a clean power of 2 (the realistic case: level 0
    // is padded UP to a multiple of 4, not to a power of 2). 1056 = 4 * 264.
    const levels = computeMipChainDims(1056, 1056);
    const logicalWidths = levels.map((l) => l.logicalWidth);
    ok(
      '1056 chain: logical widths halve exactly to 1',
      logicalWidths.join(',') === [1056, 528, 264, 132, 66, 33, 16, 8, 4, 2, 1].join(',')
    );
    // The load-bearing claim: iterating "halve the previous logical size" must
    // equal computing `padW0 >> i` directly (what a GPU implicitly allocates
    // per level) — proven here independently of computeMipChainDims' own loop.
    let allMatchDirectShift = true;
    for (let i = 0; i < levels.length; i++) {
      if (levels[i].logicalWidth !== Math.max(1, 1056 >> i)) allMatchDirectShift = false;
    }
    ok('1056 chain: every level equals base >> i directly (composed right-shift)', allMatchDirectShift);
    // Level 4 (logical 66) is NOT a multiple of 4, so its padded size must
    // round UP, not just copy the logical value — the exact case that would
    // silently under-allocate a GPU upload if padding were skipped.
    ok(
      '1056 level4: logical 66 pads up to 68 (not left at 66)',
      levels[4].logicalWidth === 66 && levels[4].width === 68
    );
  }

  {
    // Extreme aspect ratio: one axis reaches 1 long before the other. The loop
    // must keep halving the LIVE axis while holding the settled one at 1, not
    // stop early (which would leave the wide axis without a full chain).
    const levels = computeMipChainDims(1024, 4);
    const last = levels[levels.length - 1];
    ok('1024x4 chain ends at logical 1x1', last.logicalWidth === 1 && last.logicalHeight === 1);
    ok(
      '1024x4 chain: height clamps to 1 and stays (never 0)',
      levels.every((l) => l.logicalHeight >= 1)
    );
    ok(
      '1024x4 chain: width strictly decreases until 1',
      levels[1].logicalWidth === 512 && levels[2].logicalWidth === 256
    );
  }

  throws('computeMipChainDims rejects a zero size', () => computeMipChainDims(0, 8), 'size');
  throws('computeMipChainDims rejects a negative size', () => computeMipChainDims(8, -4), 'size');

  // ---- mipChainByteLength: the honest whole-chain VRAM number --------------
  {
    // 8x8 BC1: level0 (8x8→2x2 blocks×8B=32) + level1 (4x4→1 block×8=8) +
    // level2 (2x2 padded to 4x4→1 block×8=8) + level3 (1x1 padded to 4x4→8).
    const total = mipChainByteLength('bc1', 8, 8);
    ok('mipChainByteLength(bc1,8,8) sums every level, not just level 0', total === 32 + 8 + 8 + 8);
    ok('mipChainByteLength(bc1,8,8) exceeds the level-0-only size', total > bc1ByteLength(8, 8));
  }
  {
    // Same shape, BC7 (16B/block instead of 8) — format must change per-level size.
    const total = mipChainByteLength('bc7', 8, 8);
    ok('mipChainByteLength(bc7,8,8) uses 16B blocks at every level', total === 64 + 16 + 16 + 16);
  }
  {
    // A non-power-of-2, non-multiple-of-4 base (the realistic case) must still
    // sum to strictly more than the level-0-only figure, by roughly the
    // chain's 4/3 geometric-series overhead (loosely, since padding rounds
    // each small level up).
    const w = 1050,
      h = 1050;
    const total = mipChainByteLength('bc1', w, h);
    const level0Only = bc1ByteLength(w, h);
    ok('mipChainByteLength(1050x1050) > level-0-only', total > level0Only);
    ok('mipChainByteLength(1050x1050) stays within the ~4/3 chain-overhead ballpark', total < level0Only * 1.5);
  }

  // ══ THE SECOND ENDPOINT CANDIDATE (author, 2026-07-28) ══════════════════
  // "every object in the overhead layer has a thick black outline... when I
  // zoom out the diagonal parts of the black outline disappear/are mushed...
  // it's happening in the outline of the tile graphics not preserving the
  // black outline of the edge. This is where the alpha goes from 100% to 0%."
  //
  // MEASURED before the fix (Node scratchpad, no mip reduction, no sharpen
  // involved — this is the RAW encoder alone): a 3px black ink ring around a
  // filled disc. Axis-aligned ink texels decoded EXACT (luma 10.0 of a source
  // 10.0). Diagonal ink texels averaged luma 59.1 (max 78.8) and lost a third
  // of their alpha. Root cause: BC7 mode 6 (and BC1) choose their two block
  // endpoints as the texels FARTHEST apart, and alpha's 0..255 swing dominates
  // that distance so completely that the pair is almost always (some opaque
  // texel, the transparent hole) — leaving black ink competing with the
  // coloured interior, both opaque, for ONE shared endpoint. A diagonal
  // silhouette sweeps its alpha cut across every row of a 4×4 block, so it is
  // far likelier than an axis-aligned edge to pack all three clusters
  // (interior, ink, hole) into one block.
  const INK_INTERIOR = [200, 140, 60, 255];
  const INK_BLACK = [10, 10, 10, 255];
  const INK_HOLE = [0, 0, 0, 0];
  const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

  /** A filled disc with an ink ring [rInner,rOuter) around it, hard-edged (no
   * AA — isolates the block-endpoint mechanism from any filtering question). */
  function inkRing(N, rInner, rOuter) {
    return makeImage(N, N, (x, y) => {
      const d = Math.hypot(x - N / 2 + 0.5, y - N / 2 + 0.5);
      return d < rInner ? INK_INTERIOR : d < rOuter ? INK_BLACK : INK_HOLE;
    });
  }

  /** Ink-ring texels bucketed by whether they sit near an axis-aligned angle
   * (0/90/180/270°) or a diagonal one (45/135/225/315°), each within ±12°. */
  function bucketRingTexels(N, rInner, rOuter, decoded) {
    const axis = [];
    const diagonal = [];
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const dx = x - N / 2 + 0.5,
          dy = y - N / 2 + 0.5;
        const d = Math.hypot(dx, dy);
        if (d < rInner || d >= rOuter) continue;
        let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
        if (ang < 0) ang += 360;
        const distToAxis = Math.min(...[0, 90, 180, 270, 360].map((a) => Math.abs(ang - a)));
        const distToDiag = Math.min(...[45, 135, 225, 315].map((a) => Math.abs(ang - a)));
        const i = (y * N + x) * 4;
        const entry = { l: luma(decoded[i], decoded[i + 1], decoded[i + 2]), a: decoded[i + 3] };
        if (distToAxis < 12) axis.push(entry);
        else if (distToDiag < 12) diagonal.push(entry);
      }
    }
    return { axis, diagonal };
  }

  {
    const N = 32;
    const rInner = 10,
      rOuter = 13; // ~3px ring — the "thick outline" the author described
    const src = inkRing(N, rInner, rOuter);
    const dec = decodeBC7(encodeBC7(src, N, N), N, N);
    const { axis, diagonal } = bucketRingTexels(N, rInner, rOuter, dec);
    ok('ink-ring fixture actually sampled both bucket kinds', axis.length > 0 && diagonal.length > 0);

    const maxLuma = (arr) => Math.max(...arr.map((v) => v.l));
    const minAlpha = (arr) => Math.min(...arr.map((v) => v.a));
    ok('axis-aligned ink stays near-black (BC7)', maxLuma(axis) < 20);
    // THE REGRESSION THIS FIX CLOSES: before it, diagonal ink averaged luma
    // 59.1 (max 78.8) against a source of 10 — nowhere near this bar.
    ok('diagonal ink ALSO stays near-black (BC7) — the fixed case', maxLuma(diagonal) < 20);
    ok('axis-aligned ink keeps its coverage (BC7)', minAlpha(axis) > 235);
    ok('diagonal ink ALSO keeps its coverage (BC7) — the fixed case', minAlpha(diagonal) > 235);
  }

  {
    // The same shape, opaque (BC1's own domain — a floor's painted ink
    // linework, no alpha channel at all). Interior/ink/background are all
    // fully opaque, so BC1's identical 2-endpoint mechanism is exercised
    // purely on RGB clustering rather than alpha dominance.
    const N = 32;
    const rInner = 10,
      rOuter = 13;
    const BG = [230, 230, 220, 255]; // opaque "paper", not a transparent hole
    const src = makeImage(N, N, (x, y) => {
      const d = Math.hypot(x - N / 2 + 0.5, y - N / 2 + 0.5);
      return d < rInner ? INK_INTERIOR : d < rOuter ? INK_BLACK : BG;
    });
    const dec = decodeBC1(encodeBC1(src, N, N), N, N);
    const { axis, diagonal } = bucketRingTexels(N, rInner, rOuter, dec);
    ok('ink-ring fixture (BC1) actually sampled both bucket kinds', axis.length > 0 && diagonal.length > 0);
    const maxLuma = (arr) => Math.max(...arr.map((v) => v.l));
    ok('axis-aligned ink stays near-black (BC1)', maxLuma(axis) < 20);
    ok('diagonal ink ALSO stays near-black (BC1) — the fixed case', maxLuma(diagonal) < 20);
  }

  {
    // A block with only ONE cluster (uniform colour) must be untouched by the
    // second-candidate machinery — lumaExtremalPair legitimately finding a
    // pair changes nothing when every texel already sits on one point.
    const N = 8;
    const src = makeImage(N, N, () => [77, 133, 201, 255]);
    const dec = decodeBC7(encodeBC7(src, N, N), N, N);
    ok('a flat block round-trips exactly regardless of the 2nd candidate', maxRgbaError(src, dec) === 0);
  }

  {
    // A block with exactly two clusters (the common, non-edge-case majority of
    // real content) must still round-trip at BC7's usual high fidelity — the
    // extra candidate must never make an already-easy block WORSE.
    const N = 8;
    const src = makeImage(N, N, (x) => (x < N / 2 ? [40, 40, 40, 255] : [210, 90, 30, 180]));
    const dec = decodeBC7(encodeBC7(src, N, N), N, N);
    ok('a clean two-cluster block stays high fidelity', maxRgbaError(src, dec) <= 4);
  }

  // ══ SHARED SCRATCH BUFFERS MUST NOT LEAK BETWEEN CALLS ══════════════════
  // (2026-07-29, the allocation-free pass — see block-compress.js's
  // "ALLOCATION-FREE INSIDE THE BLOCK LOOP" header.) The encoders now reuse
  // module-level texel/palette/candidate buffers instead of allocating per
  // block, which buys ~1.6× on BC7 and removes ~10⁸ short-lived objects per
  // 12000² layer — and introduces exactly ONE new way to be wrong: state
  // surviving from one block (or one CALL) into the next. A leak would not
  // throw; it would quietly corrupt whichever image encoded second, which is
  // the silent-drift class memory:feedback_instruments_must_not_lie exists for.
  // So: encode A, encode a DIFFERENT image B in between, encode A again — the
  // two A encodes must be byte-identical, and each must match a single-shot
  // encode of A alone.
  {
    const N = 16;
    const imgA = makeImage(N, N, (x, y) => {
      const d = Math.hypot(x - N / 2, y - N / 2);
      return d < 5 ? [200, 140, 60, 255] : d < 7 ? [10, 10, 10, 255] : [0, 0, 0, 0];
    });
    const imgB = makeImage(N, N, (x, y) => [(x * 17) & 255, (y * 29) & 255, (x * y) & 255, (x + y) & 255]);
    for (const [label, enc] of [
      ['bc1', encodeBC1],
      ['bc7', encodeBC7],
    ]) {
      const a1 = enc(imgA, N, N);
      enc(imgB, N, N); // a completely different image between the two A encodes
      const a2 = enc(imgA, N, N);
      ok(`${label}: interleaving another image leaves the encode unchanged`, bytesEqual(a1, a2));
    }
    // The same guarantee WITHIN one call: a single multi-block image whose
    // blocks differ from each other reuses the scratch block-to-block, so a
    // leak there shows up as the second half decoding like the first.
    const wide = makeImage(32, 8, (x) => (x < 16 ? [240, 20, 20, 255] : [20, 20, 240, 255]));
    const decWide = decodeBC1(encodeBC1(wide, 32, 8), 32, 8);
    ok(
      'bc1: block-to-block scratch reuse keeps each block its own colour',
      decWide[(4 * 32 + 2) * 4] > 200 && decWide[(4 * 32 + 29) * 4 + 2] > 200
    );
  }

  // ══ THE ENCODER-OUTPUT PIN ══════════════════════════════════════════════
  // These bytes are cached in IndexedDB under bc-compress.worker.js's
  // CACHE_VERSION, so an encoder change that alters output and does NOT bump
  // that constant serves every existing user a stale texture forever — the
  // exact failure memory:feedback_url_keyed_cache_needs_a_content_validator
  // records, one layer up. Nothing else in this suite would notice: every
  // other assertion here is a tolerance band, and a changed-but-still-good
  // encode sails through all of them.
  //
  // So this pins the actual BYTES of a fixture holding all three clusters
  // (interior / ink / transparent hole) plus a gradient — enough to exercise
  // both candidate pairs, both BC1 palette modes and BC7's anchor swap.
  //
  // ⚠️ IF THIS FAILS: that is not automatically a bug. It means the encoder's
  // output moved. Decide which happened, then do the matching thing:
  //   • intentional quality change → update the hash below AND bump
  //     CACHE_VERSION in bc-compress.worker.js (never one without the other);
  //   • unintentional → you have a real regression; the round-trip bars above
  //     will tell you whether quality went with it.
  {
    /** FNV-1a 32-bit — a stable, dependency-free fingerprint of the blocks. */
    const fnv1a = (bytes) => {
      let h = 0x811c9dc5;
      for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i];
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return h.toString(16).padStart(8, '0');
    };
    const N = 16;
    const fixture = makeImage(N, N, (x, y) => {
      const d = Math.hypot(x - N / 2 + 0.5, y - N / 2 + 0.5);
      if (d < 4) return [200 + x, 140, 60 + y, 255];
      if (d < 6) return [10, 10, 10, 255];
      return [(x * 16) & 255, (y * 16) & 255, 128, d < 7 ? 128 : 0];
    });
    ok('BC1 encoder output is byte-stable (CACHE_VERSION 8)', fnv1a(encodeBC1(fixture, N, N)) === '94b1e28e');
    // NOTE the BC7 hash did NOT move across the v7→v8 toRgb565 fix, and must
    // not have: that function is BC1-only (BC7 mode 6 carries full 8-bit
    // endpoints and never quantizes to 565). This pin is what PROVED that
    // rather than assuming it — an unchanged hash here is the evidence the
    // fix stayed in its own format.
    ok('BC7 encoder output is byte-stable (CACHE_VERSION 8)', fnv1a(encodeBC7(fixture, N, N)) === 'f3ce221c');
  }
}
