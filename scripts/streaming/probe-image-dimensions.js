/**
 * @fileoverview Read image width/height from blob headers without full raster decode.
 * @module streaming/probe-image-dimensions
 */

/**
 * @param {Blob} blob
 * @returns {Promise<{ width: number, height: number }|null>}
 */
export async function probeImageDimensionsFromBlob(blob) {
  if (!blob || blob.size < 24) return null;

  const headLen = Math.min(blob.size, 256 * 1024);
  const buf = await blob.slice(0, headLen).arrayBuffer();
  const u8 = new Uint8Array(buf);

  const png = _probePng(u8);
  if (png) return png;

  const jpeg = _probeJpeg(u8, blob.size);
  if (jpeg) return jpeg;

  const webp = _probeWebp(u8);
  if (webp) return webp;

  return null;
}

/** @param {Uint8Array} u8 */
function _probePng(u8) {
  if (u8.length < 24) return null;
  if (u8[0] !== 0x89 || u8[1] !== 0x50 || u8[2] !== 0x4e || u8[3] !== 0x47) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const width = dv.getUint32(16, false);
  const height = dv.getUint32(20, false);
  if (!(width > 0 && height > 0 && width <= 65535 && height <= 65535)) return null;
  return { width, height };
}

/**
 * Scan JPEG markers for SOF dimensions.
 * @param {Uint8Array} u8
 * @param {number} blobSize
 */
function _probeJpeg(u8, _blobSize) {
  if (u8.length < 4 || u8[0] !== 0xff || u8[1] !== 0xd8) return null;

  let i = 2;
  while (i + 9 < u8.length) {
    if (u8[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = u8[i + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      i += 2;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (u8[i + 2] << 8) | u8[i + 3];
    if (len < 2) break;

    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && i + 7 < u8.length) {
      const height = (u8[i + 5] << 8) | u8[i + 6];
      const width = (u8[i + 7] << 8) | u8[i + 8];
      if (width > 0 && height > 0) return { width, height };
    }

    i += 2 + len;
  }
  return null;
}

/** @param {Uint8Array} u8 */
function _probeWebp(u8) {
  if (u8.length < 30) return null;
  const sig = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (sig !== 'RIFF') return null;
  const type = String.fromCharCode(u8[8], u8[9], u8[10], u8[11]);
  if (type !== 'WEBP') return null;

  const chunk = String.fromCharCode(u8[12], u8[13], u8[14], u8[15]);
  if (chunk === 'VP8X' && u8.length >= 30) {
    const width = 1 + (u8[24] | (u8[25] << 8) | (u8[26] << 16));
    const height = 1 + (u8[27] | (u8[28] << 8) | (u8[29] << 16));
    if (width > 0 && height > 0) return { width, height };
  }
  if (chunk === 'VP8 ' && u8.length >= 30) {
    const width = u8[26] | ((u8[27] & 0x3f) << 8);
    const height = u8[28] | ((u8[29] & 0x3f) << 8);
    if (width > 0 && height > 0) return { width, height };
  }
  if (chunk === 'VP8L' && u8.length >= 25) {
    const bits = u8[21] | (u8[22] << 8) | (u8[23] << 16) | (u8[24] << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    if (width > 0 && height > 0) return { width, height };
  }
  return null;
}

/**
 * True when a full-image downscale decode would risk OOM.
 * @param {number} width
 * @param {number} height
 * @param {number} [threshold=4096]
 */
export function isHugeImageSource(width, height, threshold = 4096) {
  return Math.max(Number(width) || 0, Number(height) || 0) > threshold;
}
