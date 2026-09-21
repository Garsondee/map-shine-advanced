/**
 * image-header-size.test.mjs — mythica-machina-press#590.
 *
 * `vt/mask-image.js` used to decode every mask TWICE: once at native size
 * purely to learn its width and height, then again at the target size.
 * Measured on a real production layer (10,000 x 10,000 WebP, 29.3MB) in a real
 * browser on a real GPU, that first decode cost **2,382ms**; reading the same
 * two integers from the file header cost **2.4ms** and matched exactly.
 *
 * This suite exists because that optimisation is only safe if the parser is
 * EXACT and FAILS OPEN. A wrong size would silently resize every mask to the
 * wrong dimensions — far worse than the slow decode it replaces — so the
 * numbers are pinned against byte layouts built here, and every malformed or
 * unknown input is pinned to `null` (meaning "ask the decoder"), never a guess.
 */
import { readImageHeaderSize } from '../image-header-size.js';

/** RIFF/WEBP container with a given fourcc and payload, sized to fit. */
function webpContainer(fourcc, payload) {
  // RIFF(4) size(4) WEBP(4) fourcc(4) chunkSize(4) then payload at 20.
  // The chunkSize field is easy to forget and shifts every subsequent offset
  // by four — which is exactly the mistake the first draft of this helper made,
  // and it made a correct parser look broken.
  const buf = new Uint8Array(20 + payload.length);
  const dv = new DataView(buf.buffer);
  buf.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
  dv.setUint32(4, buf.length - 8, true);
  buf.set([0x57, 0x45, 0x42, 0x50], 8); // 'WEBP'
  for (let i = 0; i < 4; i++) buf[12 + i] = fourcc.charCodeAt(i);
  dv.setUint32(16, payload.length, true);
  buf.set(payload, 20);
  return buf;
}

function webpVp8x(width, height) {
  // 10 bytes: flags(4) then 24-bit (w-1) and 24-bit (h-1), little-endian.
  const p = new Uint8Array(14);
  const w = width - 1;
  const h = height - 1;
  p[4] = w & 0xff;
  p[5] = (w >> 8) & 0xff;
  p[6] = (w >> 16) & 0xff;
  p[7] = h & 0xff;
  p[8] = (h >> 8) & 0xff;
  p[9] = (h >> 16) & 0xff;
  return webpContainer('VP8X', p);
}

function webpVp8l(width, height) {
  const p = new Uint8Array(14);
  p[0] = 0x2f; // VP8L signature
  const bits = (width - 1) | ((height - 1) << 14);
  p[1] = bits & 0xff;
  p[2] = (bits >>> 8) & 0xff;
  p[3] = (bits >>> 16) & 0xff;
  p[4] = (bits >>> 24) & 0xff;
  return webpContainer('VP8L', p);
}

function webpVp8(width, height) {
  const p = new Uint8Array(20);
  p[3] = 0x9d; // keyframe start code at absolute offset 23
  p[4] = 0x01;
  p[5] = 0x2a;
  p[6] = width & 0xff;
  p[7] = (width >> 8) & 0x3f;
  p[8] = height & 0xff;
  p[9] = (height >> 8) & 0x3f;
  return webpContainer('VP8 ', p);
}

function png(width, height) {
  const buf = new Uint8Array(32);
  const dv = new DataView(buf.buffer);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  dv.setUint32(8, 13, false);
  buf.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  dv.setUint32(16, width, false);
  dv.setUint32(20, height, false);
  return buf;
}

function jpeg(width, height) {
  // SOI, a JFIF APP0 to be walked past, then SOF0 carrying the dimensions.
  const buf = new Uint8Array(2 + 18 + 11);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, 0xffd8, false);
  dv.setUint16(2, 0xffe0, false);
  dv.setUint16(4, 16, false); // APP0 length
  let off = 2 + 2 + 16;
  dv.setUint16(off, 0xffc0, false); // SOF0
  dv.setUint16(off + 2, 11, false);
  buf[off + 4] = 8; // precision
  dv.setUint16(off + 5, height, false);
  dv.setUint16(off + 7, width, false);
  return buf;
}

export function run(t) {
  const { ok } = t;

  // --- THE REAL ASSET'S OWN NUMBERS ----------------------------------------
  // 10,000 x 10,000 is the actual size of the production layer this was
  // measured against, so it is the case pinned first.
  {
    for (const [name, bytes] of [
      ['VP8X', webpVp8x(10000, 10000)],
      ['PNG', png(10000, 10000)],
    ]) {
      const r = readImageHeaderSize(bytes);
      ok(`${name} reads the real 10,000 x 10,000 production size exactly`, r?.width === 10000 && r?.height === 10000);
    }
    // VP8/VP8L are 14-bit, so 10,000 is representable but 16,384+ is not —
    // worth knowing, since MASK_IMAGE_MAX_DIM is 16,384.
    const l = readImageHeaderSize(webpVp8l(10000, 10000));
    ok('VP8L reads 10,000 x 10,000 exactly', l?.width === 10000 && l?.height === 10000);
  }

  // --- EVERY FORMAT, INCLUDING NON-SQUARE (so w/h cannot be swapped) -------
  {
    const cases = [
      ['webp VP8X', webpVp8x(10650, 4950), 'webp'],
      ['webp VP8L', webpVp8l(1280, 720), 'webp'],
      ['webp VP8 ', webpVp8(1920, 1080), 'webp'],
      ['png', png(10650, 4950), 'png'],
      ['jpeg', jpeg(4096, 2048), 'jpeg'],
    ];
    for (const [name, bytes, format] of cases) {
      const r = readImageHeaderSize(bytes);
      ok(`${name} is recognised`, r !== null && r.format === format);
    }
    // Width and height are NOT interchangeable — a transposed read would give
    // every mask the wrong aspect and is the most likely parser bug.
    const r = readImageHeaderSize(webpVp8x(10650, 4950));
    ok('VP8X does not transpose width and height', r.width === 10650 && r.height === 4950);
    const j = readImageHeaderSize(jpeg(4096, 2048));
    ok('JPEG does not transpose (its header stores height FIRST)', j.width === 4096 && j.height === 2048);
    const p = readImageHeaderSize(png(10650, 4950));
    ok('PNG does not transpose', p.width === 10650 && p.height === 4950);
  }

  // --- FAIL OPEN: null means "ask the decoder", never a guess --------------
  {
    ok('null input is null', readImageHeaderSize(null) === null);
    ok('undefined input is null', readImageHeaderSize(undefined) === null);
    ok('an empty buffer is null', readImageHeaderSize(new ArrayBuffer(0)) === null);
    ok('a tiny buffer is null, not a misread', readImageHeaderSize(new Uint8Array([1, 2, 3])) === null);
    ok('random bytes are null', readImageHeaderSize(new Uint8Array(64).fill(0xab)) === null);

    // A truncated WebP must not be read from whatever happens to be in memory.
    const truncated = webpVp8x(10000, 10000).slice(0, 20);
    ok('a truncated WebP header is null', readImageHeaderSize(truncated) === null);

    // RIFF that is not WEBP (e.g. a WAV) must not be claimed.
    const wav = webpVp8x(100, 100);
    wav[8] = 0x57;
    wav[9] = 0x41;
    wav[10] = 0x56;
    wav[11] = 0x45; // 'WAVE'
    ok('a RIFF container that is not WEBP is null', readImageHeaderSize(wav) === null);

    // PNG whose first chunk is not IHDR is malformed for our purposes.
    const badPng = png(100, 100);
    badPng[12] = 0x62; // corrupt 'IHDR'
    ok('a PNG without IHDR first is null', readImageHeaderSize(badPng) === null);

    // VP8 lossy without its keyframe start code must not be trusted.
    const badVp8 = webpVp8(640, 480);
    badVp8[23] = 0x00;
    ok('a VP8 stream missing its start code is null', readImageHeaderSize(badVp8) === null);

    // A zero dimension is not a valid image.
    ok('a zero-width header is rejected', readImageHeaderSize(png(0, 100)) === null);
  }

  // --- A MALFORMED JPEG MUST TERMINATE, NOT SPIN --------------------------
  {
    // Marker chain that never reaches a SOF: every segment claims a length, so
    // the walk must still end at the buffer's end rather than looping.
    const buf = new Uint8Array(64);
    const dv = new DataView(buf.buffer);
    dv.setUint16(0, 0xffd8, false);
    let off = 2;
    while (off + 4 < buf.length) {
      dv.setUint16(off, 0xffe1, false);
      dv.setUint16(off + 2, 4, false);
      off += 6;
    }
    ok('a JPEG with no frame header returns null and terminates', readImageHeaderSize(buf) === null);

    // A segment claiming length 0 would advance by a negative amount if the
    // guard were missing — the classic infinite-loop shape.
    const zeroLen = new Uint8Array(32);
    const dv2 = new DataView(zeroLen.buffer);
    dv2.setUint16(0, 0xffd8, false);
    dv2.setUint16(2, 0xffe1, false);
    dv2.setUint16(4, 0, false);
    ok('a zero-length JPEG segment is rejected rather than looping', readImageHeaderSize(zeroLen) === null);
  }

  // --- ACCEPTS BOTH ArrayBuffer AND views ---------------------------------
  {
    const view = webpVp8x(800, 600);
    const r1 = readImageHeaderSize(view);
    const r2 = readImageHeaderSize(view.buffer);
    ok('a Uint8Array and its ArrayBuffer read identically', r1?.width === 800 && r2?.width === 800);

    // A view with a non-zero byteOffset must respect that offset, not read
    // from the start of the underlying buffer.
    const padded = new Uint8Array(view.length + 8);
    padded.set(view, 8);
    const sub = padded.subarray(8);
    const r3 = readImageHeaderSize(sub);
    ok('a view at a non-zero byteOffset is read from the right place', r3?.width === 800 && r3?.height === 600);
  }
}
