/**
 * LOAD A MASK FILE AS A HIGH-RESOLUTION SINGLE-CHANNEL TEXTURE.
 *
 * ============================================================================
 * WHY THIS EXISTS — THE MASK PIPELINE HAD NO HIGH-RES PATH AT ALL
 * ============================================================================
 * Until 2026-07-26 a `_Water`-style mask reached the GPU by exactly two
 * routes, and BOTH are thumbnails:
 *
 *   1. `maskAuthority.getDerived(...)` — the CPU derivation grid, capped at
 *      `MASK_GRID_MAX_DIM` (512) on the long side. On a 10,650px map that is
 *      ~21 world px per texel.
 *   2. The VT layer's coarse pin — a handful of 256px pages (~768px across the
 *      same map, ~14 world px/texel).
 *
 * Both are correct for what they were built for: cheap, coarse, whole-scene
 * COVERAGE questions ("is this point outdoors", "is anything above me"). Both
 * are useless for a SILHOUETTE, because a silhouette is the highest-frequency
 * part of the signal and these throw exactly that away.
 *
 * ============================================================================
 * THE BUG THIS FIXES, AND WHY THREE EARLIER FIXES DID NOT
 * ============================================================================
 * Water's tier-0 shoreline came from thresholding the jump-flood SDF, and the
 * SDF was seeded from route 1. Three successive fixes attacked the wrong
 * layer — LINEAR on the resolved pack, then LINEAR on the mask, then 3×
 * supersampling the flood — and the author's report stayed the same:
 * *"extremely pixelated... the shoreline looks like a square wave."*
 *
 * The reason is worth stating once, properly: **an SDF renders crisply far
 * below its source resolution ONLY because it was BUILT from a high-res
 * source.** That is the whole Valve-SDF-text result — a 64² field renders
 * sharp glyphs at 500px, because each texel stores a continuous distance
 * encoding where the edge sits BETWEEN texels. Seed a flood from a 512
 * point-sampled grid and there is no sub-texel information to preserve; the
 * seeds sit on texel centres and an angled shore bakes in a real staircase.
 * Supersampling the flood over that same grid samples the same thumbnail more
 * densely and finds nothing, which is exactly what was observed.
 *
 * So: **the SDF is not asked for the edge any more.** The edge comes from
 * here — the mask file itself, at real resolution, linearly filtered, exactly
 * as crisp as the map art beside it. The SDF keeps the job it is genuinely
 * good at (distance-derived, inherently low-frequency effects: depth ramp,
 * foam band width, shoaling, flow tangent), where 512 was always plenty.
 *
 * ============================================================================
 * COST, STATED HONESTLY
 * ============================================================================
 * `MASK_IMAGE_SCALE` (1, full native res) of a 10,650 × 4,950 mask is
 * ~52.7 M texels. Uploaded RED/UnsignedByte — ONE byte per texel — that is
 * **~53 MB**, against a scene already holding ~265 MB of texture. Half res
 * (the original default, until the author asked for the one-number raise
 * once the shoreline softness became visible) would have been ~13 MB.
 *
 * RED, not the RGBA every other DataTexture in this renderer uses: those are
 * all ≤512² where the 4× waste is invisible, and their headers cite avoiding a
 * "per-backend format-support question". At 13 M texels that waste is 40 MB,
 * which changes the answer — and `r8unorm` is core in both WebGL2 and WebGPU,
 * so the format question has a known answer here rather than being ducked.
 *
 * The transient cost is one `getImageData` (~53 MB, RGBA) during decode, freed
 * immediately. That is why this module lives in `vt/`: `no-gpu-readback` allows
 * `.getImageData(` only in `vt/` and `diag/`, and `gpu/textures-in-vt-only`
 * allows `new ...Texture(` only in `vt/`. Both are satisfied by being here
 * rather than by a callback dance.
 *
 * @module vt/mask-image
 */

import { createLogger } from '../core/log.js';
import { readImageHeaderSize } from './image-header-size.js';
import { repackMaskPixels } from './mask-repack.js';

const log = createLogger('MaskImage');

/**
 * Fraction of the mask file's NATIVE resolution to upload. Started at half,
 * chosen with the author 2026-07-26 on the explicit understanding that full
 * res was a one-number change if the difference was ever visible — it was,
 * and this is that change, now shipping at native resolution.
 *
 * At half res on a 10,650px-wide map a texel was ~2 world px; at the reported
 * play zoom (~1.7 world px per screen px) that is well under one screen pixel,
 * so in THEORY the shoreline's crispness was bounded by the display, not by
 * this — in practice the author saw it, hence the raise.
 */
export const MASK_IMAGE_SCALE = 1;

/**
 * Hard ceiling on the uploaded long side, INDEPENDENT of the scale above — a
 * backstop against a pathologically large source file, not a tuning knob.
 *
 * 16,384 matches what real hardware reports here (`textureLimit` in the
 * viewer's own diagnostics) and what the whole-image map art already uploads
 * against — a mask is never larger than the map it masks, so a source that
 * loads as art loads here too. Raised from 8,192 alongside the scale, since at
 * scale 1 that cap would have silently held a 10,650px mask at ~77% of native
 * and quietly re-created the problem the scale change exists to fix.
 */
export const MASK_IMAGE_MAX_DIM = 16384;

/**
 * The uploaded dimensions for a source of this size: scaled, capped, and never
 * upscaled past native (a 2,000px mask stays 1,000px, it does not become 8,192).
 * Pure, so the sizing rule is Node-testable without a browser.
 *
 * @param {number} nativeW @param {number} nativeH
 * @param {number} [scale] @param {number} [maxDim]
 * @returns {{width: number, height: number}}
 */
export function maskImageTargetSize(nativeW, nativeH, scale = MASK_IMAGE_SCALE, maxDim = MASK_IMAGE_MAX_DIM) {
  const w0 = Math.max(1, Math.floor(nativeW * scale));
  const h0 = Math.max(1, Math.floor(nativeH * scale));
  const longest = Math.max(w0, h0);
  if (longest <= maxDim) return { width: w0, height: h0 };
  const k = maxDim / longest;
  return { width: Math.max(1, Math.floor(w0 * k)), height: Math.max(1, Math.floor(h0 * k)) };
}

/**
 * Byte value at or below which a texel counts as EMPTY when measuring content
 * bounds. 1, not 0: a lossy encode (WebP/JPEG) leaves a scatter of 1s across
 * regions the author painted pure black, and a single stray texel in a far
 * corner would inflate the returned AABB to the whole map — silently undoing
 * the Law 6 crop it exists to provide. High enough to reject encoder noise,
 * far below any presence threshold a consumer actually thresholds at.
 */
export const MASK_CONTENT_EMPTY_BYTE = 1;

/**
 * Build the mask DataTexture from packed bytes — ONE definition, used by both
 * the worker path and the main-thread fallback (mythica-machina-press#591).
 *
 * Extracted the moment there were two callers, and not a moment later: the
 * first draft of the worker path hand-rolled these same assignments and left
 * out `flipY = false`, which would have flipped EVERY mask vertically. This
 * repo already names that as a recurring bug class
 * ([[feedback_y_flip_recurring_risk]]), and two copies of a texture setup is
 * precisely how it recurs. Now it cannot: there is one copy.
 */
function buildMaskTexture(THREE, data, width, height, rgbMode) {
  const texture = rgbMode
    ? new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType)
    : new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.UnsignedByteType);
  // LINEAR — the whole point. The file's own antialiased edge becomes a smooth
  // ramp the surface shader can threshold into a crisp, resolution-independent
  // shoreline.
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  // flipY:false — v=0 is the image's TOP row, the world-quad convention every
  // tile in this renderer already uses (see setTileGeometry's own tex setup).
  // Getting this wrong flips the water vertically.
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * THE MASK DECODE WORKER CLIENT (mythica-machina-press#591).
 *
 * One lazily-constructed worker, one in-flight map, and a hard degrade to the
 * main-thread path on ANY failure — the same contract
 * `vt/compressed-textures.js` already uses, and for the same reason: a worker
 * that cannot start must never be why a mask fails to load.
 *
 * Construction form is `new Worker(new URL('./x.worker.js', import.meta.url),
 * { type: 'module' })` because that is the only reference form that both
 * resolves under Foundry's raw module serving and satisfies this repo's
 * reachability wall — copied deliberately from the two workers that already
 * work here rather than invented.
 */
let _maskWorker = null;
let _maskWorkerDead = false;
let _maskJobSeq = 0;
const _maskJobs = new Map();

function ensureMaskWorker() {
  if (_maskWorkerDead) return null;
  if (_maskWorker) return _maskWorker;
  try {
    _maskWorker = new Worker(new URL('./mask-decode.worker.js', import.meta.url), { type: 'module' });
    _maskWorker.onmessage = (e) => {
      const d = e.data || {};
      const job = _maskJobs.get(d.id);
      if (!job) return;
      _maskJobs.delete(d.id);
      job.resolve(d.ok ? d : null);
    };
    _maskWorker.onerror = (err) => {
      // The worker died. Everything waiting on it degrades to the main-thread
      // path rather than hanging, and it is not rebuilt this session: a worker
      // that fails here has failed for an environmental reason (CSP, module
      // resolution) that a retry will not change.
      log.warn('mask decode worker failed - falling back to main-thread decode:', err?.message || err);
      _maskWorkerDead = true;
      _maskWorker = null;
      for (const [, j] of _maskJobs) j.resolve(null);
      _maskJobs.clear();
    };
  } catch (err) {
    log.warn('mask decode worker unavailable - using main-thread decode:', err?.message || err);
    _maskWorkerDead = true;
    _maskWorker = null;
    return null;
  }
  return _maskWorker;
}

/**
 * Ask the worker to decode + read back + repack. Resolves `null` on any
 * failure, which the caller MUST treat as "do it yourself".
 * @returns {Promise<{data:Uint8Array, contentBounds:object|null}|null>}
 */
function decodeMaskInWorker(bytes, width, height, rgbMode) {
  const w = ensureMaskWorker();
  if (!w) return Promise.resolve(null);
  const id = ++_maskJobSeq;
  return new Promise((resolve) => {
    _maskJobs.set(id, { resolve });
    try {
      // Zero-copy both ways: the file bytes are TRANSFERRED in (the caller has
      // already read the header it needs from them) and the packed result is
      // transferred back, so several hundred MB crosses the boundary with no copy.
      w.postMessage({ id, bytes, width, height, rgbMode, emptyByte: MASK_CONTENT_EMPTY_BYTE }, [bytes]);
    } catch (err) {
      _maskJobs.delete(id);
      log.warn('mask decode worker postMessage failed - using main-thread decode:', err?.message || err);
      resolve(null);
    }
  });
}

/**
 * Fetch a mask image and upload it as a texture, plus the AABB of whatever is
 * actually painted in it.
 *
 * ⚠️ **`channels` IS A REAL FORK AND `'r'` IS NOT A DEFAULT TO DRIFT FROM.**
 * The single-channel path exists because `_Water`'s R carries depth AND
 * presence, so one byte per texel is the whole signal (see the `water` kind's
 * own `meaning` in `scene/mask-catalog.js`) and at 13 M texels the 4× waste of
 * RGBA is 40 MB. `_Specular` is the opposite case: it is a COLOUR mask whose
 * three channels decode to three separate material properties
 * (`effects/specular/specular-material.js`), so reading R alone would not
 * merely lose detail — it would report a blue-painted steel object as ABSENT.
 * The fork is per-mask-kind semantics, not a quality setting.
 *
 * `RGBAFormat`, never `RGBFormat`: three removed the latter in r137 and both
 * backends want 4-byte alignment anyway. The alpha byte is genuinely wasted on
 * an RGB mask, which is exactly why an `'rgb'` caller should think about
 * `scale` — see `SPECULAR_MASK_IMAGE_SCALE`.
 *
 * Resolves to `null` — never throws — on any failure (404, decode error, a
 * browser without `createImageBitmap` resize support). The caller treats null
 * as "no high-res mask", which is a degraded look, not a broken frame; the
 * failure is logged loudly rather than swallowed (`no-silent-catch`).
 *
 * @param {object} args
 * @param {string} args.url
 * @param {*} args.THREE
 * @param {number} [args.scale]
 * @param {'r'|'rgb'} [args.channels] - `'r'` (default) uploads the RED channel
 *   as `RedFormat`, one byte per texel. `'rgb'` uploads all four as
 *   `RGBAFormat`.
 * @returns {Promise<{texture: *, width: number, height: number, nativeWidth: number,
 *   nativeHeight: number, bytes: number,
 *   contentBounds: {minU: number, minV: number, maxU: number, maxV: number}|null}|null>}
 *   `contentBounds` is the painted region's AABB in this texture's own UV
 *   space (v=0 is the image's TOP row, matching `flipY: false`), or `null` when
 *   the file is entirely empty. Consumers crop their geometry to it — Effects.md
 *   Law 6, cost scales with COVERED pixels.
 */
export async function loadMaskImageTexture({ url, THREE, scale = MASK_IMAGE_SCALE, channels = 'r' }) {
  if (!url) return null;
  let bitmap = null;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      log.error(`mask image fetch failed (${response.status}) for ${url}`);
      return null;
    }
    // ARRAY BUFFER, NOT BLOB, so the header can be read without a decode. The
    // `new Blob([buf])` costs nothing meaningful — the bytes are in memory
    // either way — and leaves the decode below byte-for-byte what it was.
    const buf = await response.arrayBuffer();
    const blob = new Blob([buf]);

    // NATIVE SIZE FROM THE HEADER, NOT FROM A THROWAWAY DECODE
    // (mythica-machina-press#590). This used to read:
    //
    //     const probe = await createImageBitmap(blob);    // decode #1
    //     ... probe.width / probe.height ... probe.close();
    //     bitmap = await createImageBitmap(blob, {...});  // decode #2
    //
    // — so every mask was decoded TWICE, the first time purely to learn two
    // integers. Measured on a real production layer (`mythica-machina-mansion_
    // ground_notwrecked.webp`, 10,000 x 10,000, 29.3MB) in a real browser on a
    // real GPU: the probe decode cost **2,382ms**; reading the same two
    // integers from the file header cost **2.4ms** and matched exactly. A scene
    // loading eight such masks spent roughly nineteen seconds decoding images
    // it threw away.
    //
    // The old comment justified the double decode by arguing that
    // `createImageBitmap`'s own resize beats drawing a full-size bitmap into a
    // smaller canvas. That argument is still true and still applies — it is why
    // decode #2 keeps its `resizeWidth`/`resizeHeight`. It never justified
    // decode #1, which existed only to size that call.
    //
    // FAIL-OPEN: `readImageHeaderSize` returns null for anything it does not
    // positively recognise, and the probe decode remains for exactly that case,
    // so an unfamiliar format costs precisely what it costs today. An
    // optimisation with a fallback, never a gate.
    const header = readImageHeaderSize(buf);
    let nativeWidth;
    let nativeHeight;
    if (header) {
      nativeWidth = header.width;
      nativeHeight = header.height;
    } else {
      const probe = await createImageBitmap(blob);
      nativeWidth = probe.width;
      nativeHeight = probe.height;
      probe.close();
    }
    const { width, height } = maskImageTargetSize(nativeWidth, nativeHeight, scale);
    // ── OFF THE MAIN THREAD FIRST (mythica-machina-press#591) ──────────────
    // Measured on a real 10,000 x 10,000 production layer in a real browser:
    // getImageData 1,694ms + repack 1,267ms = ~3 SECONDS of hard main-thread
    // freeze, per mask, and a scene loads several. That is what nails the
    // thread shut during a cold load — the curtain's pulse dies, nothing else
    // progresses, and the readiness probes naming these very masks sit
    // outstanding for the whole hold.
    //
    // The worker does the identical work (it imports the SAME
    // `repackMaskPixels`, so the bytes cannot differ) and returns plain data.
    // `null` means it could not — unavailable, dead, or it threw — and the
    // original main-thread path below runs unchanged.
    const rgbModeEarly = channels === 'rgb';
    const workerResult = await decodeMaskInWorker(buf, width, height, rgbModeEarly);
    if (workerResult) {
      const texture = buildMaskTexture(THREE, workerResult.data, width, height, rgbModeEarly);
      return {
        texture,
        width,
        height,
        nativeWidth,
        nativeHeight,
        bytes: workerResult.data.length,
        data: workerResult.data,
        contentBounds: workerResult.contentBounds,
      };
    }

    bitmap = await createImageBitmap(blob, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'high',
    });

    // ONE readback, freed immediately. `willReadFrequently` is deliberately
    // NOT set: this runs once per mask per scene load, and the flag trades GPU
    // acceleration for CPU-side caching that only pays off on repeat reads.
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.drawImage(bitmap, 0, 0);
    const rgba = ctx.getImageData(0, 0, width, height).data;

    // THE SAME pure pass the worker runs (`vt/mask-repack.js`) — one
    // definition, two callers, so the fallback and the worker can never
    // produce different pixels.
    const rgbMode = channels === 'rgb';
    const { data, contentBounds } = repackMaskPixels(rgba, width, height, {
      rgbMode,
      emptyByte: MASK_CONTENT_EMPTY_BYTE,
    });

    const texture = buildMaskTexture(THREE, data, width, height, rgbMode);

    // `data` is returned, not just uploaded. It is the SAME array the texture
    // wraps, so this costs nothing and copies nothing — and a CPU consumer that
    // needs the mask's pixels would otherwise have to fetch, decode and read
    // back a SECOND time, which is a second `getImageData` of the same 13 M
    // texels for bytes that were in hand a moment ago.
    //
    // Its first consumer is fluid's tube-net extractor (`Fluid.md` correction
    // #2): connected components and geodesic arc length are HIGH-frequency
    // questions, so they must run on the file's own pixels rather than on the
    // ≤512 derivation grid, where two tubes a tube's width apart merge into one.
    //
    // ⚠️ Do not mutate it. The texture is backed by this exact buffer, so a
    // consumer writing into it would silently repaint what the GPU samples.
    return { texture, data, width, height, nativeWidth, nativeHeight, bytes: data.length, contentBounds };
  } catch (err) {
    log.error(`mask image load failed for ${url} —`, err);
    return null;
  } finally {
    bitmap?.close?.();
  }
}
