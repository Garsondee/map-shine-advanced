/**
 * Node verification for the pure halves of effects/fluid/fluid-surface-subsystem.js.
 *
 * The subsystem itself needs THREE and a browser, so it gets a debug-panel
 * report rather than a mock (CONVENTIONS.md §4). But the two functions that do
 * ARITHMETIC — the mask downsample and the AABB crop — are pure, and they are
 * where the bugs that do not announce themselves live: an off-by-one in the
 * crop shows up as a tube clipped at one edge, and a mean-instead-of-max
 * downsample shows up as a thin tube that simply is not there. Neither throws.
 *
 * Written after a real one got through: the first draft handed `buildQuadPositions`
 * the AABB rect instead of the four corners it takes, which would have thrown on
 * the first scene with a fluid mask and was invisible to every test in the tree
 * because nothing exercised the call.
 */
import { downsample, tubeBounds } from '../fluid-surface-subsystem.js';
import { extractTubeNet } from '../fluid-net.js';

const RECT = { minX: 1000, minY: 2000, maxX: 1000 + 3200, maxY: 2000 + 1600 };

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

    const g = downsample(src, srcW, srcH, 0.25, 3200, 1600, RECT);
    ok('downsample: target size is source x scale', g.spec.w === 16 && g.spec.h === 8);
    ok('downsample: spec carries the WORLD rect, not the pixel one', g.spec.x === 1000 && g.spec.y === 2000);
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
    const g = downsample(src, 8, 4, 1, 800, 400, RECT);
    ok('downsample: scale 1 is a passthrough size', g.spec.w === 8 && g.spec.h === 4);
    // Row 0 of the destination must be row 0 of the source — the mask texture
    // is uploaded flipY:false, so v=0 is the image's TOP row, and the pack has
    // to agree or every tube renders vertically mirrored
    // (feedback_y_flip_recurring_risk).
    ok('downsample: row 0 is still the source’s row 0 — no vertical flip', g.data[0] === 200);
  }

  // ── tubeBounds: the crop that keeps this O(covered), not O(screen) ──────
  {
    // A tube occupying the middle fifth of a 40x20 grid.
    const w = 40;
    const h = 20;
    const data = new Uint8Array(w * h);
    for (let y = 8; y <= 11; y++) for (let x = 16; x <= 23; x++) data[y * w + x] = 255;
    const grid = {
      spec: { x: RECT.minX, y: RECT.minY, width: 3200, height: 1600, w, h, texelW: 80, texelH: 80 },
      data,
    };
    const net = extractTubeNet({ grid, samplesPerTube: 16 });
    ok('bounds fixture: one tube', net.tubeCount === 1);

    const b = tubeBounds(net, RECT, 0);
    // x 16..23 of 40 over a 3200-wide rect starting at 1000.
    ok(`bounds: minX is the tube's left edge (${b.minX})`, Math.abs(b.minX - (1000 + (16 / 40) * 3200)) < 1e-6);
    ok(`bounds: maxX covers the LAST texel's full extent`, Math.abs(b.maxX - (1000 + (24 / 40) * 3200)) < 1e-6);
    ok('bounds: minY likewise', Math.abs(b.minY - (2000 + (8 / 20) * 1600)) < 1e-6);
    ok('bounds: maxY likewise', Math.abs(b.maxY - (2000 + (12 / 20) * 1600)) < 1e-6);

    // The crop must be a genuine saving, or Law 6 is being paid lip service.
    const cropArea = (b.maxX - b.minX) * (b.maxY - b.minY);
    const fullArea = 3200 * 1600;
    ok(
      `bounds: crop is a real saving (${((cropArea / fullArea) * 100).toFixed(0)}% of the rect)`,
      cropArea < fullArea * 0.1
    );

    const padded = tubeBounds(net, RECT, 48);
    ok('bounds: padding widens on every side', padded.minX < b.minX && padded.maxX > b.maxX);
    ok('bounds: padding is exactly the amount asked for', Math.abs(padded.maxY - b.maxY - 48) < 1e-9);
  }

  // ── An empty net has no bounds, and says so with null ───────────────────
  {
    const grid = {
      spec: { x: RECT.minX, y: RECT.minY, width: 3200, height: 1600, w: 16, h: 16, texelW: 200, texelH: 100 },
      data: new Uint8Array(256),
    };
    const net = extractTubeNet({ grid, samplesPerTube: 8 });
    ok(
      'empty net: bounds is null, not a zero-size rect that would draw nothing visibly',
      tubeBounds(net, RECT, 8) === null
    );
  }
}
