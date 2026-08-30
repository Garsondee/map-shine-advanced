/**
 * Node verification for vt/taa-resolve.js — the pure Halton-jitter and
 * closed-form camera-reprojection math. TSL/GPU node-builders in that file
 * are bench-only verified (same convention albedo-clarity.js's own
 * shader-glue functions already use) — nothing GPU-dependent is imported
 * here.
 */
import {
  haltonSequence,
  buildHaltonJitterSequence,
  computeJitterOffsetWorld,
  computeReprojectTransform,
  isCutDetected,
} from '../taa-resolve.js';

export function run(t) {
  const { ok } = t;

  // ── Halton radical inverse — known reference values ──────────────────────
  {
    ok('base-2 index 1 = 0.5', haltonSequence(1, 2) === 0.5);
    ok('base-2 index 2 = 0.25', haltonSequence(2, 2) === 0.25);
    ok('base-2 index 3 = 0.75', haltonSequence(3, 2) === 0.75);
    ok('base-2 index 4 = 0.125', haltonSequence(4, 2) === 0.125);
    ok('base-3 index 1 = 1/3', Math.abs(haltonSequence(1, 3) - 1 / 3) < 1e-12);
    ok('base-3 index 2 = 2/3', Math.abs(haltonSequence(2, 3) - 2 / 3) < 1e-12);
    ok('base-3 index 3 = 1/9', Math.abs(haltonSequence(3, 3) - 1 / 9) < 1e-12);
    ok('index 0 degenerates to exactly 0 in any base (why the jitter sequence skips it)', haltonSequence(0, 2) === 0);
    let allInRange = true;
    for (let i = 1; i <= 50; i++) {
      const v2 = haltonSequence(i, 2);
      const v3 = haltonSequence(i, 3);
      if (v2 < 0 || v2 >= 1 || v3 < 0 || v3 >= 1) allInRange = false;
    }
    ok('every value stays in [0,1) across many indices/bases', allInRange);
  }

  // ── the jitter sequence ────────────────────────────────────────────────
  {
    const seq = buildHaltonJitterSequence(8);
    ok('returns exactly the requested count', seq.length === 8);
    ok(
      'every sample is within [-0.5, 0.5) on both axes',
      seq.every((s) => s.x >= -0.5 && s.x < 0.5 && s.y >= -0.5 && s.y < 0.5)
    );
    ok(
      'deterministic — same call, same sequence',
      JSON.stringify(buildHaltonJitterSequence(8)) === JSON.stringify(seq)
    );
    ok('the first sample is not the degenerate (0,0) — index starts at 1, not 0', seq[0].x !== 0 || seq[0].y !== 0);
    ok('default count is 8', buildHaltonJitterSequence().length === 8);
    ok(
      'a non-positive/garbage count falls back to 8',
      buildHaltonJitterSequence(0).length === 8 && buildHaltonJitterSequence(NaN).length === 8
    );
  }

  // ── jitter offset, world space ────────────────────────────────────────
  {
    const f = { left: -10, right: 10, top: 5, bottom: -5 }; // 20 wide, 10 tall
    const { dx, dy } = computeJitterOffsetWorld(f, 100, 50, { x: 0.5, y: -0.5 });
    ok('dx = sample.x * frustum width / internal width', Math.abs(dx - 0.1) < 1e-12);
    ok('dy = sample.y * frustum height / internal height', Math.abs(dy - -0.1) < 1e-12);
    const zero = computeJitterOffsetWorld(f, 100, 50, { x: 0, y: 0 });
    ok('a zero sample produces a zero offset', zero.dx === 0 && zero.dy === 0);
    const garbage = computeJitterOffsetWorld(f, 0, -5, { x: 0.5, y: 0.5 });
    ok(
      'a bad internal size falls back to 1, not NaN/Infinity',
      Number.isFinite(garbage.dx) && Number.isFinite(garbage.dy)
    );
  }

  // ── reprojection transform — the closed-form affine ───────────────────
  {
    const f0 = { left: 0, right: 10, top: 5, bottom: -5 };
    const identity = computeReprojectTransform(f0, f0);
    ok(
      'identical frustums give the exact identity transform (nothing moved)',
      identity.scaleX === 1 && identity.offsetX === 0 && identity.scaleY === 1 && identity.offsetY === 0
    );

    // Pure pan right by 2 world units, same span, same vertical framing.
    const panned = { left: 2, right: 12, top: 5, bottom: -5 };
    const panTransform = computeReprojectTransform(panned, f0);
    ok('a pure pan keeps scale at 1', panTransform.scaleX === 1 && panTransform.scaleY === 1);
    ok('a pure pan right by 2/10 of the span gives offsetX = 0.2', Math.abs(panTransform.offsetX - 0.2) < 1e-12);
    ok('a purely horizontal pan leaves offsetY at 0', panTransform.offsetY === 0);

    // Pure zoom-in (half the span), same centre.
    const zoomed = { left: 2.5, right: 7.5, top: 2.5, bottom: -2.5 };
    const zoomTransform = computeReprojectTransform(zoomed, f0);
    ok('a zoom to half the span gives scaleX = 0.5', Math.abs(zoomTransform.scaleX - 0.5) < 1e-12);
    ok(
      'a centred zoom gives offsetX = 0.25 (span/2 quarter-in on each side)',
      Math.abs(zoomTransform.offsetX - 0.25) < 1e-12
    );

    // Degenerate previous frustum (zero span) never divides by zero.
    const degenerate = { left: 5, right: 5, top: 0, bottom: 0 };
    const degTransform = computeReprojectTransform(f0, degenerate);
    ok(
      'a degenerate (zero-span) previous frustum falls back to identity-safe values, not NaN',
      Number.isFinite(degTransform.scaleX) &&
        Number.isFinite(degTransform.offsetX) &&
        Number.isFinite(degTransform.scaleY) &&
        Number.isFinite(degTransform.offsetY)
    );
  }

  // ── cut detection ──────────────────────────────────────────────────────
  {
    ok(
      'the identity transform is never a cut',
      isCutDetected({ scaleX: 1, offsetX: 0, scaleY: 1, offsetY: 0 }) === false
    );
    ok(
      'a small ordinary pan/zoom step is not a cut',
      isCutDetected({ scaleX: 1.01, offsetX: 0.02, scaleY: 1.01, offsetY: -0.01 }) === false
    );
    ok(
      'a large offset (quarter-span jump) IS a cut',
      isCutDetected({ scaleX: 1, offsetX: 0.5, scaleY: 1, offsetY: 0 }) === true
    );
    ok(
      'a large scale change (e.g. a scripted zoom snap) IS a cut',
      isCutDetected({ scaleX: 2, offsetX: 0, scaleY: 2, offsetY: 0 }) === true
    );
    ok(
      'thresholds are tunable via opts',
      isCutDetected({ scaleX: 1, offsetX: 0.1, scaleY: 1, offsetY: 0 }, { offsetThreshold: 0.05 }) === true &&
        isCutDetected({ scaleX: 1, offsetX: 0.1, scaleY: 1, offsetY: 0 }, { offsetThreshold: 0.5 }) === false
    );
  }
}
