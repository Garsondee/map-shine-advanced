/**
 * MASK DECODE WORKER — takes a mask file's bytes off the main thread entirely.
 *
 * ============================================================================
 * THE MEASUREMENT THIS EXISTS FOR (mythica-machina-press#591)
 * ============================================================================
 * `loadMaskImage` did all of this on the main thread. Measured in a real
 * browser on a real GPU, against the author's own 10,000 x 10,000 production
 * layer (100M texels):
 *
 *   drawImage ........... 5 ms
 *   getImageData ........ 1,694 ms   <- synchronous, blocking
 *   repack + bounds ..... 1,267 ms   <- synchronous, blocking
 *   ------------------------------
 *   per mask ............ ~2,966 ms of hard main-thread freeze
 *
 * A scene loads several masks (specular, window, water, vegetation, per floor),
 * so this is tens of seconds of a cold load spent with the thread nailed shut —
 * which is why the curtain's own liveness pulse dies, why nothing else can make
 * progress, and why the readiness probes that name these very masks sat
 * outstanding for the whole hold.
 *
 * The work itself is not wasteful. It is simply in the wrong thread.
 *
 * ============================================================================
 * WHAT MOVES, AND WHAT CANNOT
 * ============================================================================
 * Decode, canvas readback and the repack pass all move here. Texture creation
 * does NOT and never can — that touches THREE and the GPU, and `gpu/textures-
 * in-vt-only` exists to keep it where it is. The worker returns plain bytes
 * plus the measured bounds; the caller makes the `DataTexture` exactly as
 * before, from exactly the same bytes.
 *
 * `repackMaskPixels` is IMPORTED, not reimplemented, so the worker path and the
 * main-thread fallback cannot produce different pixels. See `vt/mask-repack.js`.
 *
 * ============================================================================
 * DEGRADATION-FIRST
 * ============================================================================
 * Same contract as `bc-compress.worker.js`: any failure posts `{ ok: false }`
 * and the caller runs the original main-thread path. A worker that cannot
 * start, cannot decode, or hits an OffscreenCanvas limit must never be the
 * reason a mask fails to load — it is an optimisation with a fallback
 * ([[feedback_safety_slide_outranks_doctrine]]).
 *
 * Transfers are zero-copy in both directions: the file bytes come in as a
 * transferred ArrayBuffer and the packed result goes back the same way, so
 * moving several hundred MB across the boundary costs no copy.
 *
 * @module vt/mask-decode.worker
 */
import { repackMaskPixels } from './mask-repack.js';

self.onmessage = async (e) => {
  const { id, bytes, width, height, rgbMode, emptyByte } = e.data || {};
  try {
    const blob = new Blob([bytes]);
    // The SAME resize call the main-thread path makes — the browser's own
    // (GPU-accelerated, properly filtered) downscale, which is both faster and
    // better than drawing a full-size bitmap into a smaller canvas ourselves.
    const bitmap = await createImageBitmap(blob, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'high',
    });
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      bitmap.close();
      self.postMessage({ id, ok: false, reason: 'no 2d context in worker' });
      return;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const { data, contentBounds } = repackMaskPixels(rgba, width, height, { rgbMode, emptyByte });
    self.postMessage({ id, ok: true, data, contentBounds, width, height }, [data.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, reason: String(err?.message || err) });
  }
};
