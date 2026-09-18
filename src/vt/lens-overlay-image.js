/**
 * LENS OVERLAY IMAGE — fetch, downscale and upload ONE bundled grime/dust/
 * light-leak catalog image as a plain 2D texture (mythica-machina-press#57's
 * basic v1 — `effects/lens.js#LENS_OVERLAY_CATALOG` names the 13 files).
 *
 * ============================================================================
 * WHY THIS IS NOT mask-image.js, AND NOT foundry/mask-discovery.js
 * ============================================================================
 * `foundry/mask-discovery.js` exists to find files an AUTHOR painted for
 * their OWN map — unknown in advance, discovered via `FilePicker.browse()` or
 * bounded probing. That whole apparatus solves "what files exist that we
 * cannot know about until we look." It is the wrong tool here: this module's
 * 13 files SHIP WITH map-shine-advanced — fixed, known, version-controlled —
 * so `LENS_OVERLAY_CATALOG`'s own hardcoded list already answers the question
 * mask-discovery exists to ask. Running a `FilePicker` scan over a folder
 * whose contents this codebase already knows would be discovery theatre, not
 * a real safeguard.
 *
 * `vt/mask-image.js` is the closer relative — it too fetches an image and
 * uploads it as a texture at a computed (not native) resolution — but it
 * solves a DIFFERENT problem: an author's mask file, arbitrary size, decoded
 * at up to NATIVE resolution because a shoreline silhouette needs every real
 * pixel of edge frequency it can get, with a CPU-side content-bounds scan
 * downstream consumers rely on. None of that applies to a bundled decorative
 * texture with no silhouette to preserve and nothing to crop — so rather than
 * bend that file's mask-shaped contract to fit, this reuses its one genuinely
 * generic, already-tested piece (`maskImageTargetSize` — scale + cap + never
 * upscale past native) and implements its own much smaller upload path.
 *
 * ============================================================================
 * WHY 4K SOURCE ART GETS DOWNSCALED HARD (`LENS_OVERLAY_MAX_DIM`)
 * ============================================================================
 * Every bundled catalog image ships at 3840×2160 — ~8.3 MP, ~33 MB resident
 * as a plain RGBA8 2D texture. That is real money against Keyhole's own law
 * ("nothing is ever allocated at world resolution") for a texture whose
 * entire job is to look like a SOFT, low-frequency smear of dust/grime
 * drifting almost imperceptibly across the frame — the opposite case from
 * `mask-image.js`'s shoreline silhouette, which needs every real pixel of
 * edge frequency it can get. Capped at 1024px on the long side (~1024×576,
 * ~2.3 MB resident once uploaded — RGBA8, no CPU-side copy retained) is a
 * >90% saving with no expected visible loss for content this soft. "Expected"
 * is the honest word: there is no live Foundry instance to look at from here
 * (this project's own standing rule — a visual effect needs the author's own
 * live look before it counts as confirmed, not just a passing test suite).
 *
 * ============================================================================
 * WHY THIS IS UNTESTED IN NODE (CONVENTIONS.md §4)
 * ============================================================================
 * `loadLensOverlayTexture` is browser-only — `fetch`, `createImageBitmap`,
 * `OffscreenCanvas`, `THREE` — exactly `mask-image.js`'s own reason for
 * leaving `loadMaskImageTexture` untested while its pure sizing helper is
 * pinned in Node. This module has no pure logic of its own to pin (it
 * reuses `maskImageTargetSize`, already tested at its own declaration), so
 * there is nothing here a synthetic DOM/WebGL mock would honestly verify
 * beyond what a live look already must confirm.
 *
 * @module vt/lens-overlay-image
 */
import { createLogger } from '../core/log.js';
import { maskImageTargetSize } from './mask-image.js';

const log = createLogger('LensOverlayImage');

/**
 * Long-side cap for an uploaded overlay texture — see this module's own
 * header for why a grime/dust texture wants far less resolution than
 * `mask-image.js`'s shoreline mask. `scale: 1` (native) is always passed to
 * `maskImageTargetSize`, so this is the one number that ever needs retuning.
 */
export const LENS_OVERLAY_MAX_DIM = 1024;

/**
 * Fetch, downscale and upload one bundled overlay image as a plain
 * `THREE.DataTexture`. Resolves `null` — never throws — on any failure (404,
 * decode error, a browser without `createImageBitmap` resize support): the
 * caller (`vt-pan-viewer.js`) treats `null` exactly like `loadMaskImageTexture`'s
 * own `null` — a degraded look (no overlay change this cycle, whatever was
 * already bound stays bound), never a broken frame.
 *
 * Pixels are read back once via `OffscreenCanvas`/`getImageData` (allowed in
 * `vt/` — `no-gpu-readback`'s own exemption) into a plain `Uint8Array` and the
 * texture is built FROM THAT ARRAY, never from the `ImageBitmap` directly —
 * deliberately, so `bitmap.close()` below can run unconditionally the moment
 * decoding is done rather than needing to outlive an eventual, hard-to-time
 * GPU upload (an `ImageBitmap`-backed `THREE.Texture` would otherwise need
 * the bitmap kept alive until the renderer actually uploads it, which does
 * not happen at a moment this function can observe).
 *
 * @param {object} args
 * @param {string} args.url - root-absolute, already percent-encoded.
 * @param {*} args.THREE - injected, never imported (this codebase's own
 *   convention — see `mask-image.js`'s identical signature).
 * @returns {Promise<{texture: *, width: number, height: number,
 *   nativeWidth: number, nativeHeight: number}|null>}
 */
export async function loadLensOverlayTexture({ url, THREE }) {
  if (!url) return null;
  let bitmap = null;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      log.error(`lens overlay image fetch failed (${response.status}) for ${url}`);
      return null;
    }
    const blob = await response.blob();
    // Decode once at native size only to learn the dimensions, then
    // re-decode at the target — the identical two-step `mask-image.js`
    // already uses, for the identical reason: `createImageBitmap`'s own
    // resize is a GPU-accelerated, properly filtered downscale, cheaper and
    // better than drawing a full-size bitmap into a smaller canvas by hand.
    const probe = await createImageBitmap(blob);
    const nativeWidth = probe.width;
    const nativeHeight = probe.height;
    const { width, height } = maskImageTargetSize(nativeWidth, nativeHeight, 1, LENS_OVERLAY_MAX_DIM);
    probe.close();
    bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.drawImage(bitmap, 0, 0);
    // A straight RGBA copy — no channel fork, no content-bounds scan
    // (`mask-image.js` needs both; a decorative overlay with nothing to
    // crop needs neither). `Uint8Array` from a `Uint8ClampedArray` copies
    // element VALUES (both are 0..255 already), the same as any other
    // typed-array-from-typed-array construction.
    const data = new Uint8Array(ctx.getImageData(0, 0, width, height).data);

    const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    // ClampToEdge, never Repeat — these are single "poster" images (a
    // grime pattern authored to cover one full frame), never meant to
    // tile, and the composite shader's own drift is bounded specifically
    // so a clamped edge is never what the player actually sees
    // (`effects/lens-render.js`'s own overlay block).
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    // flipY:false — v=0 is the image's TOP row, the screen-space convention
    // this renderer's post chain already samples with (see `mask-image.js`'s
    // own identical note). Y-flips are this project's oldest recurring bug
    // class (memory: feedback_y_flip_recurring_risk).
    texture.flipY = false;
    // Real photographed/authored art, not a data buffer — decode as sRGB
    // (matches every other colour texture in this renderer's own post
    // chain, e.g. `vt-pan-viewer.js`'s tile/floor art and video textures).
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;

    return { texture, width, height, nativeWidth, nativeHeight };
  } catch (err) {
    log.error(`lens overlay image load failed for ${url} —`, err);
    return null;
  } finally {
    bitmap?.close?.();
  }
}
