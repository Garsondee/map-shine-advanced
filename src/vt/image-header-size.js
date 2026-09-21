/**
 * IMAGE DIMENSIONS FROM THE FILE HEADER — without decoding the image.
 *
 * ============================================================================
 * THE MEASUREMENT THIS EXISTS FOR (mythica-machina-press#590)
 * ============================================================================
 * `vt/mask-image.js#loadMaskImage` needs a mask's NATIVE size before it can
 * choose a resize target, and it got it the obvious way: decode the whole image
 * once (`const probe = await createImageBitmap(blob)`), read `.width`/`.height`,
 * then throw that bitmap away and decode a second time at the target size.
 *
 * Measured on a real production layer — `mythica-machina-mansion_ground_
 * notwrecked.webp`, 10,000 x 10,000, 29.3MB — in a real browser on a real
 * WebGPU-class GPU (NVIDIA Ampere):
 *
 *   probe decode, purely to learn two integers ..... 2,382 ms
 *   header parse, same two integers ................ 2.4 ms   (exact match)
 *
 * A thousandfold, for an answer that is not an approximation: the header IS the
 * authoritative size the decoder itself would report. A scene loading eight
 * such masks was spending roughly nineteen seconds decoding images it
 * immediately discarded.
 *
 * ============================================================================
 * WHY A HEADER PARSER RATHER THAN A CHEAPER DECODE
 * ============================================================================
 * There is no cheaper decode. `createImageBitmap(blob, { resizeWidth: 1 })`
 * still decodes fully before resizing, and an `<img>`'s `naturalWidth` is only
 * populated after its own decode. Every route to "how big is this?" through the
 * image pipeline pays for the pixels. The bytes at the front of the file do not.
 *
 * ============================================================================
 * FAIL-OPEN, ALWAYS
 * ============================================================================
 * Every function here returns `null` for anything it does not positively
 * recognise — a truncated buffer, an unknown format, a malformed chunk. `null`
 * means "ask the decoder", never "the image is broken", so an unrecognised file
 * costs exactly what it costs today and nothing regresses. This parser is an
 * optimisation with a fallback, not a gate: it is never the reason an image
 * fails to load.
 *
 * Pure and Node-testable: takes bytes, returns numbers, touches no DOM and no
 * network. The formats are the ones Foundry actually serves for map art and
 * masks (WebP by far the most common, then PNG, then JPEG).
 *
 * @module vt/image-header-size
 */

/** @typedef {{width: number, height: number, format: 'webp'|'png'|'jpeg'}} ImageHeaderSize */

/** Both dimensions must be real, positive integers or the read is not trusted. */
function ok(width, height, format) {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height, format };
}

/**
 * PNG — `IHDR` is mandatory and must be the FIRST chunk, so width/height sit at
 * fixed offsets 16 and 20, big-endian. No scanning required.
 * @param {DataView} dv @returns {ImageHeaderSize|null}
 */
function pngSize(dv) {
  if (dv.byteLength < 24) return null;
  // \x89 P N G \r \n \x1a \n
  if (dv.getUint32(0, false) !== 0x89504e47 || dv.getUint32(4, false) !== 0x0d0a1a0a) return null;
  if (dv.getUint32(12, false) !== 0x49484452) return null; // 'IHDR'
  return ok(dv.getUint32(16, false), dv.getUint32(20, false), 'png');
}

/**
 * WebP — a RIFF container whose first chunk names the coding format, and all
 * three carry their size differently:
 *
 *   VP8X  extended (the one that carries alpha/animation flags): 24-bit
 *         canvas width-1 / height-1, little-endian, at 24 and 27.
 *   VP8L  lossless: 14 bits each of (width-1, height-1) packed into a 32-bit
 *         little-endian word after the 1-byte signature.
 *   'VP8 ' lossy: a 3-byte start code, then 16-bit width/height whose top two
 *         bits are scaling hints and must be masked off.
 *
 * All three are handled because MSA's own art pipeline emits whichever the
 * encoder chose, and a mask with alpha is routinely VP8X.
 * @param {DataView} dv @returns {ImageHeaderSize|null}
 */
function webpSize(dv) {
  if (dv.byteLength < 30) return null;
  if (dv.getUint32(0, false) !== 0x52494646) return null; // 'RIFF'
  if (dv.getUint32(8, false) !== 0x57454250) return null; // 'WEBP'
  const fourcc = dv.getUint32(12, false);
  if (fourcc === 0x56503858) {
    // 'VP8X' — 24-bit little-endian, stored as (dimension - 1)
    const w = (dv.getUint8(24) | (dv.getUint8(25) << 8) | (dv.getUint8(26) << 16)) + 1;
    const h = (dv.getUint8(27) | (dv.getUint8(28) << 8) | (dv.getUint8(29) << 16)) + 1;
    return ok(w, h, 'webp');
  }
  if (fourcc === 0x5650384c) {
    // 'VP8L' — signature byte at 20 must be 0x2f, then 14+14 bits packed
    if (dv.getUint8(20) !== 0x2f) return null;
    const bits = dv.getUint32(21, true);
    return ok((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, 'webp');
  }
  if (fourcc === 0x56503820) {
    // 'VP8 ' (lossy). The keyframe start code 0x9d012a precedes the dimensions;
    // checking it is what stops a non-keyframe stream being misread as a size.
    if (dv.getUint8(23) !== 0x9d || dv.getUint8(24) !== 0x01 || dv.getUint8(25) !== 0x2a) return null;
    return ok(dv.getUint16(26, true) & 0x3fff, dv.getUint16(28, true) & 0x3fff, 'webp');
  }
  return null;
}

/**
 * JPEG — no fixed offset: walk the marker chain to the frame header (SOF0-SOF15,
 * excluding the four that are not frame headers) and read its height/width.
 *
 * Bounded by construction: every step advances by at least one segment, and the
 * loop stops at the buffer's end, so a malformed file cannot spin here.
 * @param {DataView} dv @returns {ImageHeaderSize|null}
 */
function jpegSize(dv) {
  if (dv.byteLength < 4) return null;
  if (dv.getUint16(0, false) !== 0xffd8) return null; // SOI
  let off = 2;
  while (off + 9 < dv.byteLength) {
    if (dv.getUint8(off) !== 0xff) return null; // lost the marker chain
    const marker = dv.getUint8(off + 1);
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    const len = dv.getUint16(off + 2, false);
    if (len < 2) return null;
    // SOF0..SOFF are frame headers EXCEPT C4 (DHT), C8 (JPG) and CC (DAC).
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (off + 9 >= dv.byteLength) return null;
      return ok(dv.getUint16(off + 7, false), dv.getUint16(off + 5, false), 'jpeg');
    }
    off += 2 + len;
  }
  return null;
}

/**
 * Read an image's pixel dimensions straight from its header bytes.
 *
 * @param {ArrayBuffer|ArrayBufferView} bytes - the START of the file is enough;
 *   a few hundred bytes covers PNG and WebP, and JPEG needs only as far as its
 *   frame header.
 * @returns {ImageHeaderSize|null} `null` whenever the format is not positively
 *   recognised — the caller must fall back to decoding. See this module's
 *   FAIL-OPEN note.
 */
export function readImageHeaderSize(bytes) {
  if (!bytes) return null;
  let dv;
  try {
    dv = ArrayBuffer.isView(bytes)
      ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new DataView(bytes);
  } catch {
    return null;
  }
  if (dv.byteLength < 4) return null;
  // Ordered by how often MSA actually meets them, not alphabetically.
  return webpSize(dv) ?? pngSize(dv) ?? jpegSize(dv);
}
