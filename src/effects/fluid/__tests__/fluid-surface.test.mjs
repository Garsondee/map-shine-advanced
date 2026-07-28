/**
 * Node verification for the pure halves of effects/fluid/fluid-surface-subsystem.js.
 *
 * The subsystem itself needs THREE and a browser, so it gets a debug-panel
 * report rather than a mock (CONVENTIONS.md §4). But `downsample` is pure, and
 * it is where a bug would not announce itself: a mean-instead-of-max reduction
 * shows up as a thin tube that simply is not there, and a flipped row order
 * shows up as tubes drawn upside down. Neither throws.
 *
 * ⚠️ The AABB-crop helper this file used to test is GONE, and its absence is
 * the phase's real lesson. The mesh is now the ITEM'S OWN QUAD — because fluid
 * is a per-item effect and the author's tubes live on a tile — so there is no
 * crop to compute and no rect to get wrong. Two bugs (the world-rect mask
 * mapping, and rotation being unrepresentable) were deleted rather than fixed.
 */
import { downsample } from '../fluid-surface-subsystem.js';

export function run(t) {
  const { ok } = t;

  // ── downsample: MAX, not mean — a thin tube must survive ────────────────
  {
    // A 1-px-wide bright line on a 64x32 source, downsampled 4x. Under a MEAN
    // the line would average to ~64/255 within its 4x4 block and, at a lower
    // painted value, could drop under the presence threshold and vanish.
    const srcW = 64;
    const srcH = 32;
    const src = new Uint8Array(srcW * srcH);
    for (let x = 0; x < srcW; x++) src[16 * srcW + x] = 255;

    const g = downsample(src, srcW, srcH, 0.25, 3200, 1600);
    ok('downsample: target size is source x scale', g.spec.w === 16 && g.spec.h === 8);
    ok(
      'downsample: spec carries the ITEM span in WORLD px, so lengths are world px',
      g.spec.width === 3200 && g.spec.height === 1600
    );
    ok('downsample: texel size is world span / texels', Math.abs(g.spec.texelW - 3200 / 16) < 1e-9);

    // Row 16 of 32 at 0.25 lands in destination row 4.
    let bright = 0;
    for (let x = 0; x < 16; x++) if (g.data[4 * 16 + x] === 255) bright++;
    ok('downsample: the 1-px line survives at FULL value across the row (max, not mean)', bright === 16);

    let elsewhere = 0;
    for (let i = 0; i < g.data.length; i++) if (i < 4 * 16 || i >= 5 * 16) elsewhere += g.data[i];
    ok('downsample: nothing bleeds into other rows', elsewhere === 0);
  }

  // ── downsample: never upscales, and row 0 stays row 0 ───────────────────
  {
    const src = new Uint8Array(8 * 4);
    src[0] = 200; // top-left of the SOURCE
    const g = downsample(src, 8, 4, 1, 800, 400);
    ok('downsample: scale 1 is a passthrough size', g.spec.w === 8 && g.spec.h === 4);
    // Row 0 of the destination must be row 0 of the source — the mask texture
    // is uploaded flipY:false, so v=0 is the image's TOP row, and the pack has
    // to agree or every tube renders vertically mirrored
    // (feedback_y_flip_recurring_risk).
    ok('downsample: row 0 is still the source’s row 0 — no vertical flip', g.data[0] === 200);
  }
}
