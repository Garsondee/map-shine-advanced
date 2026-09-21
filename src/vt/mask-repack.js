/**
 * THE MASK PIXEL PASS — repack to the requested layout and measure the painted
 * AABB, in one walk over the texels.
 *
 * ============================================================================
 * WHY THIS IS ITS OWN MODULE (mythica-machina-press#591)
 * ============================================================================
 * It was inline in `vt/mask-image.js`, which was fine while it ran in exactly
 * one place. It now runs in TWO — inside `mask-decode.worker.js`, and on the
 * main thread when that worker is unavailable — and those two must produce
 * byte-identical output forever. A mask that packs differently depending on
 * whether a worker happened to start is the worst kind of bug: correct on the
 * developer's machine, subtly wrong on someone else's, and invisible until an
 * effect's silhouette is off.
 *
 * One function, two callers. It cannot drift, and being pure it is Node-tested
 * without a canvas.
 *
 * ============================================================================
 * WHAT IT COSTS, MEASURED
 * ============================================================================
 * On a real 10,000 x 10,000 production layer (100M texels), in a real browser:
 *
 *   drawImage ........... 5 ms
 *   getImageData ........ 1,694 ms   <- synchronous, main thread
 *   THIS LOOP ........... 1,267 ms   <- synchronous, main thread
 *
 * ~3 seconds of hard main-thread freeze per full-resolution mask, and a scene
 * loads several. That measurement is the entire reason the worker exists; this
 * function is unchanged by it, and deliberately so — the work is not wasteful,
 * it is just in the wrong thread.
 *
 * @module vt/mask-repack
 */

/**
 * Byte value at or below which a texel counts as EMPTY when measuring content
 * bounds. Passed in rather than imported so this module stays free of
 * `mask-image.js` (which imports THREE) and can run inside a worker.
 *
 * See `mask-image.js#MASK_CONTENT_EMPTY_BYTE` for why it is 1 and not 0.
 */
export const DEFAULT_MASK_CONTENT_EMPTY_BYTE = 1;

/**
 * @typedef {object} MaskRepackResult
 * @property {Uint8Array} data - RGBA when `rgbMode`, single-channel R otherwise.
 * @property {{minU:number,minV:number,maxU:number,maxV:number}|null} contentBounds -
 *   null when nothing above `emptyByte` was painted anywhere.
 */

/**
 * One pass over the decoded pixels: repack to the requested layout AND measure
 * the painted AABB. Splitting them would walk the texels twice for no gain —
 * the bounds are free here because the loop already has each texel in a
 * register.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba - `getImageData(...).data`.
 * @param {number} width @param {number} height
 * @param {{rgbMode?: boolean, emptyByte?: number}} [opts]
 * @returns {MaskRepackResult}
 */
export function repackMaskPixels(rgba, width, height, { rgbMode = false, emptyByte } = {}) {
  const empty = Number.isFinite(emptyByte) ? emptyByte : DEFAULT_MASK_CONTENT_EMPTY_BYTE;
  const texelCount = width * height;
  const data = rgbMode ? new Uint8Array(texelCount * 4) : new Uint8Array(texelCount);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const s = i * 4;
      const r = rgba[s];
      let present = r;
      if (rgbMode) {
        const g = rgba[s + 1];
        const b = rgba[s + 2];
        data[s] = r;
        data[s + 1] = g;
        data[s + 2] = b;
        data[s + 3] = rgba[s + 3];
        // MAX of the three, not the red channel and not a luminance: the
        // material decode's own presence axis is HSV *value*, and a mask
        // painted pure blue has r = 0. Measuring bounds by red would crop a
        // blue-steel object out of the geometry entirely.
        present = g > present ? g : present;
        present = b > present ? b : present;
      } else {
        // R only — the water mask carries depth AND presence there. One byte
        // per texel instead of four.
        data[i] = r;
      }
      if (present > empty) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  // Bounds cover the FULL EXTENT of the outermost painted texels — `+1` on the
  // max side, since texel `maxX` spans u ∈ [maxX/width, (maxX+1)/width] and
  // cropping to its left edge would shave the last column of metal off.
  const contentBounds =
    maxX < 0
      ? null
      : {
          minU: minX / width,
          minV: minY / height,
          maxU: (maxX + 1) / width,
          maxV: (maxY + 1) / height,
        };
  return { data, contentBounds };
}
