/**
 * mask-image.test.mjs — the sizing rule for the high-resolution mask upload.
 *
 * `loadMaskImageTexture` itself is browser-only (fetch, createImageBitmap,
 * OffscreenCanvas, THREE), so it gets a debug-panel readout rather than a Node
 * test (CONVENTIONS §4) — `water-body`'s report prints `uploaded` vs `native`
 * so the scale is verifiable live. `maskImageTargetSize` is pure, and it is
 * where the memory bill is actually decided, so it is pinned here.
 */
import { maskImageTargetSize, MASK_IMAGE_SCALE, MASK_IMAGE_MAX_DIM } from '../mask-image.js';

export async function run(t) {
  // --- the agreed default: half the file's own resolution ------------------
  {
    // The author's real scene: a 10650x4950 map-sized mask.
    const { width, height } = maskImageTargetSize(10650, 4950);
    t.ok('a 10650x4950 mask uploads at half res', width === 5325 && height === 2475);
    // ONE byte per texel (RedFormat) — this is the number quoted to the author
    // when agreeing half res, so it is asserted rather than left to drift.
    t.ok('...which is ~13 MB single-channel, not ~53', Math.round((width * height) / (1024 * 1024)) === 13);
  }
  t.ok('the shipped default is half', MASK_IMAGE_SCALE === 0.5);

  // --- aspect is preserved (a stretched mask would misplace every shore) ----
  {
    const wide = maskImageTargetSize(4000, 1000);
    t.ok('aspect ratio survives scaling', Math.abs(wide.width / wide.height - 4) < 1e-9);
  }

  // --- never upscales past native -----------------------------------------
  {
    const small = maskImageTargetSize(800, 600);
    t.ok('a small mask scales DOWN, never up to the cap', small.width === 400 && small.height === 300);
  }

  // --- the cap is a backstop against a pathological source, not a knob -----
  {
    // 40000px wide: half is 20000, well past any texture limit.
    const huge = maskImageTargetSize(40000, 20000);
    t.ok('the long side is capped', Math.max(huge.width, huge.height) === MASK_IMAGE_MAX_DIM);
    t.ok('...and the cap preserves aspect too', Math.abs(huge.width / huge.height - 2) < 1e-6);
    t.ok('the cap is under a conservative 8192 texture limit', MASK_IMAGE_MAX_DIM <= 8192);
  }

  // --- degenerate inputs never produce a zero-sized texture ----------------
  {
    const tiny = maskImageTargetSize(1, 1);
    t.ok('a 1x1 source stays at least 1x1 (scale 0.5 would floor to 0)', tiny.width === 1 && tiny.height === 1);
    const thin = maskImageTargetSize(3, 1);
    t.ok('an extremely thin source keeps both dimensions >= 1', thin.width >= 1 && thin.height >= 1);
  }

  // --- the full-res escape hatch, and what it ACTUALLY gives ---------------
  // Worth pinning because it is mildly surprising and it is the number to
  // quote if the half-vs-full question ever comes back: on the author's
  // 10,650px map, scale 1 does NOT reach native — the 8192 cap takes it to
  // ~77% of native (1.3 world px/texel, still far beyond what any zoom can
  // resolve). So "full res" is really "capped res", and the honest gap
  // between the shipped half and the maximum is 5,325 → 8,192, not → 10,650.
  {
    const full = maskImageTargetSize(10650, 4950, 1);
    t.ok('scale 1 on an oversized mask is capped, not native', full.width === MASK_IMAGE_MAX_DIM);
    t.ok('...and still preserves aspect', Math.abs(full.width / full.height - 10650 / 4950) < 1e-3);
    const modest = maskImageTargetSize(4000, 2000, 1);
    t.ok('scale 1 under the cap DOES reach native', modest.width === 4000 && modest.height === 2000);
  }
}
