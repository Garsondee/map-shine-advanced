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
 *
 * ⚠️ A DIFFERENT AABB CAME BACK, ON PURPOSE, mythica-machina-press#546.
 * `worldRectFromCorners` is NOT the crop helper above reincarnated — it feeds
 * a SCREEN-SPACE composite term (the fluid-shadow-tint add in
 * `environmental-light.js`), which has no per-item local `uv()` to fall back
 * on the way this file's own mesh does, so it accepts the same "no rotation"
 * gap that mesh's own header names, rather than reintroducing a crop the mesh
 * itself no longer needs.
 */
import { downsample, worldRectFromCorners } from '../fluid-surface-subsystem.js';

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

  // ── worldRectFromCorners (mythica-machina-press#546) ────────────────────
  {
    // An axis-aligned quad, corners in an arbitrary (non-sorted) order — the
    // function must not assume any particular winding.
    const axisAligned = [
      { x: 100, y: 50 },
      { x: 300, y: 50 },
      { x: 300, y: 200 },
      { x: 100, y: 200 },
    ];
    const r1 = worldRectFromCorners(axisAligned);
    ok(
      'axis-aligned quad: rect is exactly its own corners',
      r1.minX === 100 && r1.minY === 50 && r1.maxX === 300 && r1.maxY === 200
    );

    // A rotated quad's rect must be its BOUNDING box, not its own tight
    // shape — this is the exact, named, accepted gap this helper's own doc
    // states (a rotated fluid tile's tint footprint samples through a
    // skewed mapping, not a wrong one).
    const rotated = [
      { x: 200, y: 0 },
      { x: 300, y: 100 },
      { x: 200, y: 200 },
      { x: 100, y: 100 },
    ];
    const r2 = worldRectFromCorners(rotated);
    ok(
      'rotated quad: rect is the BOUNDING box of all four corners',
      r2.minX === 100 && r2.minY === 0 && r2.maxX === 300 && r2.maxY === 200
    );

    // Corner order must not matter — the same four points, shuffled, give
    // the identical rect.
    const shuffled = [rotated[2], rotated[0], rotated[3], rotated[1]];
    const r3 = worldRectFromCorners(shuffled);
    ok(
      'corner order does not matter — min/max over the SET, not the sequence',
      r3.minX === r2.minX && r3.minY === r2.minY && r3.maxX === r2.maxX && r3.maxY === r2.maxY
    );

    // A degenerate (zero-area) quad is a real value, never NaN/Infinity —
    // `vt-pan-viewer.js`'s own per-frame push relies on being able to test
    // `maxX > minX` against a genuine number to skip it safely.
    const pointLike = [
      { x: 50, y: 50 },
      { x: 50, y: 50 },
      { x: 50, y: 50 },
      { x: 50, y: 50 },
    ];
    const r4 = worldRectFromCorners(pointLike);
    ok(
      'a zero-area quad reports minX === maxX (a real, checkable degenerate rect)',
      r4.minX === 50 && r4.maxX === 50 && r4.minY === 50 && r4.maxY === 50
    );
  }
}
