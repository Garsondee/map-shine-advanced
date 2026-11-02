/**
 * FOG MEMORY CODEC — the explored coverage (one byte per texel) to a small greyscale WebP data URL and
 * back. Browser-only (OffscreenCanvas, createImageBitmap); the viewer is its only caller, and the
 * Foundry side of saving is `foundry/fog-memory-persistence.js`.
 *
 * Rows are kept in the order the GPU read them back; the viewer's stamp quad reads them in that same
 * order, so a save and a load are exact inverses whatever the API's row convention is.
 *
 * @module vt/fog-memory-codec
 */

/** WebP quality: the coverage is a soft-edged mask, so lossy WebP is invisible here and ~10x smaller. */
const WEBP_QUALITY = 0.9;

/**
 * The R channel of an RGBA readback, as one grey byte per texel.
 * @param {Uint8Array|Uint8ClampedArray} rgba @param {number} w @param {number} h
 */
export function greyFromRgba(rgba, w, h) {
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = rgba[j];
  return out;
}

/** Grey bytes → RGBA (R=G=B=A=grey), the layout a DataTexture upload and the stamp quad expect. */
export function rgbaFromGrey(grey) {
  const out = new Uint8Array(grey.length * 4);
  for (let i = 0, j = 0; i < grey.length; i++, j += 4) {
    out[j] = out[j + 1] = out[j + 2] = out[j + 3] = grey[i];
  }
  return out;
}

/** Is anything recorded at all (a fully black raster is not worth a save). */
export function hasCoverage(grey) {
  for (let i = 0; i < grey.length; i++) if (grey[i] > 2) return true;
  return false;
}

/**
 * Grey bytes → `data:image/webp;base64,…`.
 * @returns {Promise<string>}
 */
export async function encodeCoverage(grey, w, h) {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let i = 0, j = 0; i < grey.length; i++, j += 4) {
    img.data[j] = img.data[j + 1] = img.data[j + 2] = grey[i];
    img.data[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: WEBP_QUALITY });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || 'image/webp'};base64,${btoa(bin)}`;
}

/**
 * A data URL → grey bytes at `w` x `h` (drawn to that size, so a record always comes back at its own size).
 * @returns {Promise<Uint8Array>}
 */
export async function decodeCoverage(dataUrl, w, h) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return greyFromRgba(ctx.getImageData(0, 0, w, h).data, w, h);
}
