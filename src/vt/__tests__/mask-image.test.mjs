/**
 * mask-image.test.mjs — the sizing rule for the high-resolution mask upload.
 *
 * `loadMaskImageTexture` itself is browser-only (fetch, createImageBitmap,
 * OffscreenCanvas, THREE), so it gets a debug-panel readout rather than a Node
 * test (CONVENTIONS §4) — `water-body`'s report prints `uploaded` vs `native`
 * so the scale is verifiable live. `maskImageTargetSize` is pure, and it is
 * where the memory bill is actually decided, so it is pinned here.
 */
import {
  maskImageTargetSize,
  MASK_IMAGE_SCALE,
  MASK_IMAGE_MAX_DIM,
  MASK_IMAGE_MAX_BYTES_DEFAULT,
  getMaskImageMaxBytes,
  setMaskImageMaxBytes,
} from '../mask-image.js';

export async function run(t) {
  // --- the shipped default: FULL native resolution -------------------------
  // Half was tried first (2026-07-26) and the author could still clearly make
  // out pixelation, so this went to 1 — and the cap went to 16384 in the same
  // change, because at scale 1 an 8192 cap would have silently held a 10,650px
  // mask at ~77% of native and quietly re-created the problem.
  {
    // The author's real scene: a 10650x4950 map-sized mask.
    const { width, height } = maskImageTargetSize(10650, 4950);
    t.ok('a 10650x4950 mask uploads at NATIVE resolution', width === 10650 && height === 4950);
    // ONE byte per texel (RedFormat). ~53 MB against a scene already holding
    // ~265 MB of texture — asserted rather than left to drift, because it is
    // the number the resolution decision was made against.
    t.ok('...which is ~50 MB single-channel, not ~200', Math.round((width * height) / (1024 * 1024)) === 50);
  }
  t.ok('the shipped default is full native resolution', MASK_IMAGE_SCALE === 1);

  // --- aspect is preserved (a stretched mask would misplace every shore) ----
  {
    const wide = maskImageTargetSize(4000, 1000);
    t.ok('aspect ratio survives scaling', Math.abs(wide.width / wide.height - 4) < 1e-9);
  }

  // --- never upscales past native -----------------------------------------
  {
    const small = maskImageTargetSize(800, 600, 0.5);
    t.ok('an explicit half scale still scales DOWN, never up to the cap', small.width === 400 && small.height === 300);
    const native = maskImageTargetSize(800, 600);
    t.ok('a small mask at the default scale stays exactly native', native.width === 800 && native.height === 600);
  }

  // --- the cap is a backstop against a pathological source, not a knob -----
  {
    const huge = maskImageTargetSize(40000, 20000);
    t.ok('the long side is capped', Math.max(huge.width, huge.height) === MASK_IMAGE_MAX_DIM);
    t.ok('...and the cap preserves aspect too', Math.abs(huge.width / huge.height - 2) < 1e-6);
    // 16384 is what real hardware here reports as `textureLimit`, and what the
    // whole-image map art already uploads against — a mask is never bigger
    // than the map it masks, so anything that loads as art loads here.
    t.ok('the cap matches the reported hardware texture limit', MASK_IMAGE_MAX_DIM === 16384);
    t.ok(
      'a real map-sized mask is nowhere near the cap — it is a backstop, not a limit in practice',
      10650 < MASK_IMAGE_MAX_DIM
    );
  }

  // --- degenerate inputs never produce a zero-sized texture ----------------
  {
    const tiny = maskImageTargetSize(1, 1, 0.5);
    t.ok('a 1x1 source at half stays at least 1x1 (0.5 would floor to 0)', tiny.width === 1 && tiny.height === 1);
    const thin = maskImageTargetSize(3, 1, 0.5);
    t.ok('an extremely thin source keeps both dimensions >= 1', thin.width >= 1 && thin.height >= 1);
  }

  // --- the half-res escape hatch still works (it was the shipped default) --
  {
    const half = maskImageTargetSize(10650, 4950, 0.5);
    t.ok('an explicit 0.5 still halves', half.width === 5325 && half.height === 2475);
  }

  // --- THE BYTE CEILING (mythica-machina-press#593) ------------------------
  // `MASK_IMAGE_MAX_DIM` caps DIMENSIONS, which cannot express VRAM cost,
  // because bytes are dimensions TIMES CHANNELS. The author's trace showed
  // twelve GPU-process tasks over a second each (16.5s, 12.5s, 10.2s) while
  // the renderer's main thread sat idle — VRAM pressure, not JS. Masks for a
  // 10,000-square map came to 501MB PER FLOOR, against a device this module's
  // own header says dies near 2.5GB uncompressed.
  const MB = 1024 * 1024;
  {
    // No cap => unchanged behaviour, exactly as before this existed.
    const a = maskImageTargetSize(10000, 10000, 0.75, MASK_IMAGE_MAX_DIM, Infinity, 4);
    t.ok('an infinite cap changes nothing', a.width === 7500 && a.height === 7500);
    const b = maskImageTargetSize(10000, 10000, 0.75, MASK_IMAGE_MAX_DIM, 0, 4);
    t.ok('a zero/disabled cap changes nothing either', b.width === 7500 && b.height === 7500);
  }
  {
    // An RGBA mask at 7500² is 215MB — 4x the ~53MB this module documents as
    // acceptable — purely because that note reasoned about a single channel.
    const r = maskImageTargetSize(10000, 10000, 0.75, MASK_IMAGE_MAX_DIM, 128 * MB, 4);
    const bytes = r.width * r.height * 4;
    t.ok('an over-budget RGBA mask is brought under the cap', bytes <= 128 * MB);
    t.ok('...and not crushed far below it (area scales as the SQUARE of the factor)', bytes > 120 * MB);
  }
  {
    // The masks already inside the accepted range must not move at all —
    // this is a ceiling on an outlier, not a quality setting.
    const water = maskImageTargetSize(10000, 10000, 1, MASK_IMAGE_MAX_DIM, 128 * MB, 1);
    t.ok('a 95MB single-channel mask is untouched', water.width === 10000 && water.height === 10000);
    const win = maskImageTargetSize(10000, 10000, 0.5, MASK_IMAGE_MAX_DIM, 128 * MB, 4);
    t.ok('a 95MB RGBA mask is untouched', win.width === 5000 && win.height === 5000);
  }
  {
    // Channels are the whole point: the SAME pixels cost 4x as RGBA, and only
    // the RGBA one may be capped.
    const asR = maskImageTargetSize(10000, 10000, 1, MASK_IMAGE_MAX_DIM, 128 * MB, 1);
    const asRgba = maskImageTargetSize(10000, 10000, 1, MASK_IMAGE_MAX_DIM, 128 * MB, 4);
    t.ok('the same mask is capped as RGBA but not as single-channel', asR.width > asRgba.width);
  }
  {
    // Aspect ratio must survive the cap — a squashed mask would misregister
    // against the art it masks.
    const r = maskImageTargetSize(12000, 6000, 1, MASK_IMAGE_MAX_DIM, 64 * MB, 4);
    t.ok('a non-square mask keeps its aspect through the cap', Math.abs(r.width / r.height - 2) < 0.02);
  }
  {
    // Never below one texel, whatever the cap.
    const r = maskImageTargetSize(10000, 10000, 1, MASK_IMAGE_MAX_DIM, 1, 4);
    t.ok('an absurd cap still yields a usable texture, never 0', r.width >= 1 && r.height >= 1);
  }
  {
    // The live knob.
    const before = getMaskImageMaxBytes();
    t.ok('the default ceiling is the documented one', before === MASK_IMAGE_MAX_BYTES_DEFAULT);
    setMaskImageMaxBytes(64 * MB);
    t.ok('the setter takes', getMaskImageMaxBytes() === 64 * MB);
    setMaskImageMaxBytes(0);
    t.ok('0 disables the ceiling entirely (restores previous behaviour)', getMaskImageMaxBytes() === Infinity);
    setMaskImageMaxBytes(Number.NaN);
    t.ok('a non-finite value also disables rather than corrupting it', getMaskImageMaxBytes() === Infinity);
    setMaskImageMaxBytes(before);
    t.ok('restored for the rest of the run', getMaskImageMaxBytes() === before);
  }
}
