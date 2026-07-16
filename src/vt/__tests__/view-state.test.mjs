/**
 * Node verification for vt/view-state.js — pure keyboard-driven pan/zoom/
 * floor-switch state. No DOM, no THREE.
 */
import {
  createInitialViewState,
  applyPanKey,
  applyZoomKey,
  applyFloorSwitchKey,
  applyKey,
  applyPanByPixels,
  applyZoomAtPixel,
  viewToWorldRect,
  clampHalfSpan,
  smoothingAlpha,
  computeTargetPanVelocity,
  easeVelocityTowardTarget,
  integratePan,
  easedZoomFactor,
} from '../view-state.js';

export function run(t) {
  const { ok } = t;
  const WORLD = 12000;

  // --- initial state --------------------------------------------------------
  {
    const v = createInitialViewState({ worldSizePx: WORLD });
    ok('initial: centered on the world', v.centerXPx === WORLD / 2 && v.centerYPx === WORLD / 2);
    ok('initial: floor 0 by default', v.floorIndex === 0);
    ok('initial: halfSpanPx is positive and sane', v.halfSpanPx > 0 && v.halfSpanPx < WORLD);
  }

  // --- pan ------------------------------------------------------------------
  {
    const v0 = createInitialViewState({ worldSizePx: WORLD });
    const v1 = applyPanKey(v0, 'ArrowRight', WORLD);
    ok('pan right: centerX increases', v1.centerXPx > v0.centerXPx);
    ok('pan right: centerY unchanged', v1.centerYPx === v0.centerYPx);
    ok('pan: original state never mutated', v0.centerXPx === WORLD / 2);

    const v2 = applyPanKey(v0, 'ArrowDown', WORLD);
    ok('pan down: centerY increases (image-space, Y grows downward)', v2.centerYPx > v0.centerYPx);

    const v3 = applyPanKey(v0, 'q', WORLD); // not a pan key
    ok('pan: unrecognized key returns the SAME reference (no-op, not a new object)', v3 === v0);
  }

  // --- pan clamping at world edges -------------------------------------------
  {
    const edge = { ...createInitialViewState({ worldSizePx: WORLD }), centerXPx: 5 };
    const afterMany = Array.from({ length: 50 }).reduce((v) => applyPanKey(v, 'ArrowLeft', WORLD), edge);
    ok('pan: clamps at 0, never goes negative', afterMany.centerXPx === 0);

    const edgeMax = { ...createInitialViewState({ worldSizePx: WORLD }), centerXPx: WORLD - 5 };
    const afterManyMax = Array.from({ length: 50 }).reduce((v) => applyPanKey(v, 'ArrowRight', WORLD), edgeMax);
    ok('pan: clamps at worldSizePx, never exceeds it', afterManyMax.centerXPx === WORLD);
  }

  // --- zoom -------------------------------------------------------------------
  {
    const v0 = createInitialViewState({ worldSizePx: WORLD });
    const zoomedIn = applyZoomKey(v0, '+', WORLD);
    ok('zoom in: halfSpanPx shrinks', zoomedIn.halfSpanPx < v0.halfSpanPx);
    const zoomedOut = applyZoomKey(v0, '-', WORLD);
    ok('zoom out: halfSpanPx grows', zoomedOut.halfSpanPx > v0.halfSpanPx);
    ok('zoom: unrecognized key is a no-op (same reference)', applyZoomKey(v0, 'x', WORLD) === v0);
  }

  // --- zoom clamping ----------------------------------------------------------
  {
    let v = { ...createInitialViewState({ worldSizePx: WORLD }), halfSpanPx: 60 };
    for (let i = 0; i < 30; i++) v = applyZoomKey(v, '+', WORLD);
    ok('zoom in: never goes below the min half-span', v.halfSpanPx >= 50 && v.halfSpanPx < 60);

    let v2 = { ...createInitialViewState({ worldSizePx: WORLD }), halfSpanPx: 1000 };
    for (let i = 0; i < 30; i++) v2 = applyZoomKey(v2, '-', WORLD);
    ok('zoom out: never exceeds half the world', v2.halfSpanPx <= WORLD * 0.5);
  }

  // --- floor switch ------------------------------------------------------------
  {
    const v0 = createInitialViewState({ worldSizePx: WORLD, floorIndex: 0 });
    ok('floor switch: numeric key selects that floor', applyFloorSwitchKey(v0, '2', 3).floorIndex === 2);
    ok('floor switch: out-of-range numeric key is a no-op', applyFloorSwitchKey(v0, '9', 3) === v0);
    const afterTab = applyFloorSwitchKey(v0, 'Tab', 3);
    ok('floor switch: Tab cycles forward', afterTab.floorIndex === 1);
    ok('floor switch: Tab wraps around', applyFloorSwitchKey({ ...v0, floorIndex: 2 }, 'Tab', 3).floorIndex === 0);
  }

  // --- unified applyKey dispatch ----------------------------------------------
  {
    const v0 = createInitialViewState({ worldSizePx: WORLD, floorIndex: 0 });
    const ctx = { worldSizePx: WORLD, floorCount: 3 };
    ok('applyKey: routes a pan key to pan', applyKey(v0, 'ArrowRight', ctx).centerXPx > v0.centerXPx);
    ok('applyKey: routes a zoom key to zoom', applyKey(v0, '+', ctx).halfSpanPx < v0.halfSpanPx);
    ok('applyKey: routes a floor key to floor switch', applyKey(v0, '1', ctx).floorIndex === 1);
    ok('applyKey: unrecognized key changes nothing', applyKey(v0, 'z', ctx) === v0);
  }

  // --- viewToWorldRect ---------------------------------------------------------
  {
    const v = { centerXPx: 6000, centerYPx: 6000, halfSpanPx: 500, floorIndex: 0 };
    const r = viewToWorldRect(v);
    ok(
      'viewToWorldRect: correct rect from center+halfSpan',
      r.minX === 5500 && r.maxX === 6500 && r.minY === 5500 && r.maxY === 6500
    );
  }

  // --- mouse drag-to-pan (applyPanByPixels) -----------------------------------
  {
    // Aspect-correct framing → world-units-per-pixel is isotropic = 2*halfSpan/H.
    const v0 = { centerXPx: 6000, centerYPx: 6000, halfSpanPx: 600, floorIndex: 0 };
    const worldPerPixel = (2 * 600) / 1000; // 1.2

    const rightDrag = applyPanByPixels(v0, 100, 0, 1000, WORLD);
    ok(
      'drag-pan: dragging map right moves center LEFT (grab-drag)',
      rightDrag.centerXPx === 6000 - 100 * worldPerPixel
    );
    ok('drag-pan: horizontal drag leaves centerY alone', rightDrag.centerYPx === 6000);

    const downDrag = applyPanByPixels(v0, 0, 50, 1000, WORLD);
    ok('drag-pan: dragging map down moves center UP in world-Y', downDrag.centerYPx === 6000 - 50 * worldPerPixel);

    ok('drag-pan: zero movement is a no-op (same reference)', applyPanByPixels(v0, 0, 0, 1000, WORLD) === v0);
    ok('drag-pan: original state never mutated', v0.centerXPx === 6000 && v0.centerYPx === 6000);

    // A huge drag clamps the center to the world, never past it.
    const clamped = applyPanByPixels(v0, 100000, 100000, 1000, WORLD);
    ok('drag-pan: clamps center to [0, worldSizePx]', clamped.centerXPx === 0 && clamped.centerYPx === 0);
  }

  // --- mouse wheel zoom (applyZoomAtPixel) ------------------------------------
  {
    const W = 1600;
    const H = 1000;
    const worldUnderCursor = (v, sx, sy) => {
      const r = viewToWorldRect(v, W / H);
      return { x: r.minX + (sx / W) * (r.maxX - r.minX), y: r.minY + (sy / H) * (r.maxY - r.minY) };
    };

    const v0 = { centerXPx: 6000, centerYPx: 6000, halfSpanPx: 600, floorIndex: 0 };
    const sx = 400; // deliberately off-center so anchoring is actually exercised
    const sy = 250;
    const before = worldUnderCursor(v0, sx, sy);

    const zoomedIn = applyZoomAtPixel(v0, 0.8, sx, sy, W, H, WORLD);
    ok('wheel-zoom: factor < 1 zooms in (halfSpan shrinks)', zoomedIn.halfSpanPx < v0.halfSpanPx);
    const afterIn = worldUnderCursor(zoomedIn, sx, sy);
    ok(
      'wheel-zoom: world point under the cursor is invariant across zoom-in',
      Math.abs(afterIn.x - before.x) < 1e-6 && Math.abs(afterIn.y - before.y) < 1e-6
    );

    const zoomedOut = applyZoomAtPixel(v0, 1.25, sx, sy, W, H, WORLD);
    ok('wheel-zoom: factor > 1 zooms out (halfSpan grows)', zoomedOut.halfSpanPx > v0.halfSpanPx);
    const afterOut = worldUnderCursor(zoomedOut, sx, sy);
    ok(
      'wheel-zoom: world point under the cursor is invariant across zoom-out',
      Math.abs(afterOut.x - before.x) < 1e-6 && Math.abs(afterOut.y - before.y) < 1e-6
    );

    ok('wheel-zoom: original state never mutated', v0.halfSpanPx === 600);

    // At the zoom-out clamp, halfSpan can't grow further → no-op (same reference).
    const atCap = { ...v0, halfSpanPx: WORLD * 0.5 };
    ok('wheel-zoom: no-op at the zoom-out clamp', applyZoomAtPixel(atCap, 1.25, sx, sy, W, H, WORLD) === atCap);
  }

  // --- clampHalfSpan: shared clamp law (extracted 2026-07-16 so keyboard/
  // wheel/eased-zoom can never drift apart) ------------------------------
  {
    ok('clampHalfSpan: never below MIN (50)', clampHalfSpan(1, WORLD) === 50);
    ok('clampHalfSpan: never above half the world', clampHalfSpan(WORLD * 10, WORLD) === WORLD * 0.5);
    ok('clampHalfSpan: passes through an in-range value unchanged', clampHalfSpan(1000, WORLD) === 1000);
  }

  // --- CAMERA SMOOTHING (2026-07-16) --------------------------------------
  // smoothingAlpha: the frame-rate-independent easing primitive everything
  // else here is built on. Its correctness is what makes "not laggy at any
  // framerate" true rather than aspirational.
  {
    ok('smoothingAlpha: halfLife<=0 is instant (alpha=1)', smoothingAlpha(0.016, 0) === 1);
    ok('smoothingAlpha: dt<=0 is a no-op (alpha=0)', smoothingAlpha(0, 0.1) === 0 && smoothingAlpha(-1, 0.1) === 0);
    ok(
      'smoothingAlpha: exactly one half-life elapsed closes exactly 50% of the gap',
      Math.abs(smoothingAlpha(0.1, 0.1) - 0.5) < 1e-9
    );
    ok(
      'smoothingAlpha: two half-lives elapsed closes 75% of the gap (compounding, not linear)',
      Math.abs(smoothingAlpha(0.2, 0.1) - 0.75) < 1e-9
    );
    ok('smoothingAlpha: monotonically increases with dt', smoothingAlpha(0.2, 0.1) > smoothingAlpha(0.1, 0.1));
    // 5 half-lives elapsed: 1 - 0.5^5 = 0.96875 — meaningfully < 1, but close.
    // (NOT testing an extreme dt/halfLife ratio here on purpose: 0.5^100-style
    // values genuinely underflow to exactly 0.0 in IEEE double precision, which
    // makes alpha legitimately equal exactly 1.0 — correct behavior, not a bug.)
    ok(
      'smoothingAlpha: approaches but never reaches 1 for a realistic dt',
      smoothingAlpha(0.5, 0.1) < 1 && smoothingAlpha(0.5, 0.1) > 0.96
    );

    // THE frame-rate-independence property itself: applying the alpha for a
    // SMALL step twice in a row must land at (approximately) the same place
    // as applying the alpha for the combined larger step once. This is the
    // exact property a naive fixed-per-frame-factor approach LACKS (that
    // classic mistake gives a DIFFERENT result at 30fps vs 60fps for the
    // "same" smoothing) — this is the test that would catch it if this
    // implementation regressed to that mistake.
    {
      const halfLife = 0.15;
      const target = 100;
      let twoSteps = 0;
      twoSteps = twoSteps + (target - twoSteps) * smoothingAlpha(0.05, halfLife);
      twoSteps = twoSteps + (target - twoSteps) * smoothingAlpha(0.05, halfLife);
      let oneStep = 0;
      oneStep = oneStep + (target - oneStep) * smoothingAlpha(0.1, halfLife);
      ok(
        'smoothingAlpha: two small dt steps ≈ one combined-dt step (the actual frame-rate-independence property)',
        Math.abs(twoSteps - oneStep) < 1e-9
      );
    }
  }

  // --- computeTargetPanVelocity: held-key set -> target velocity ---------
  {
    ok(
      'panVelocity: no keys held -> zero velocity',
      JSON.stringify(computeTargetPanVelocity(new Set(), 100)) === '{"x":0,"y":0}'
    );
    ok(
      'panVelocity: unrecognized keys ignored -> zero velocity',
      JSON.stringify(computeTargetPanVelocity(new Set(['q', 'Enter']), 100)) === '{"x":0,"y":0}'
    );

    const right = computeTargetPanVelocity(new Set(['ArrowRight']), 100);
    ok('panVelocity: ArrowRight -> +x, zero y, full speed', right.x === 100 && right.y === 0);

    const down = computeTargetPanVelocity(new Set(['s']), 100);
    ok('panVelocity: "s" (WASD) -> +y (image-space, Y grows downward), zero x', down.x === 0 && down.y === 100);

    const opposing = computeTargetPanVelocity(new Set(['ArrowLeft', 'ArrowRight']), 100);
    ok('panVelocity: opposing keys cancel to zero', opposing.x === 0 && opposing.y === 0);

    const diag = computeTargetPanVelocity(new Set(['ArrowRight', 'ArrowDown']), 100);
    const diagMag = Math.hypot(diag.x, diag.y);
    ok(
      'panVelocity: diagonal hold normalized to the SAME magnitude as a single-axis hold (not sqrt(2)x faster)',
      Math.abs(diagMag - 100) < 1e-9
    );
    ok('panVelocity: diagonal splits evenly between axes', Math.abs(diag.x - diag.y) < 1e-9 && diag.x > 0);

    // Speed scales with the caller-supplied magnitude (vt-pan-viewer.js ties
    // this to the CURRENT zoom level so on-screen pan speed feels consistent
    // across zoom, matching the old discrete step's own halfSpanPx*0.5 design).
    const fast = computeTargetPanVelocity(new Set(['w']), 5000);
    ok('panVelocity: speed parameter scales the output magnitude', Math.abs(fast.y) === 5000);
  }

  // --- easeVelocityTowardTarget: the accel/decel ramp ---------------------
  {
    const zero = { x: 0, y: 0 };
    const target = { x: 200, y: -100 };
    const halfLife = 0.08;

    const afterOneFrame = easeVelocityTowardTarget(zero, target, 0.016, halfLife);
    ok(
      'easeVelocity: one frame moves PARTWAY toward target, not all the way (the ramp, not an instant jump)',
      afterOneFrame.x > 0 && afterOneFrame.x < target.x
    );

    // Converge over many frames at a realistic 60fps dt.
    let v = zero;
    for (let i = 0; i < 300; i++) v = easeVelocityTowardTarget(v, target, 1 / 60, halfLife);
    ok(
      'easeVelocity: converges to the target after enough frames',
      Math.abs(v.x - target.x) < 0.01 && Math.abs(v.y - target.y) < 0.01
    );

    ok(
      'easeVelocity: zero dt is a true no-op (same reference)',
      easeVelocityTowardTarget(zero, target, 0, halfLife) === zero
    );

    // Releasing all keys (target back to zero) must decelerate smoothly, not snap.
    let decel = target;
    decel = easeVelocityTowardTarget(decel, zero, 0.016, halfLife);
    ok(
      'easeVelocity: releasing (target=0) decelerates gradually, not an instant stop',
      decel.x > 0 && decel.x < target.x
    );
  }

  // --- integratePan: velocity -> position, clamped, cheap no-op ----------
  {
    const v0 = { centerXPx: 6000, centerYPx: 6000, halfSpanPx: 500, floorIndex: 0 };
    ok(
      'integratePan: zero velocity is a true no-op (same reference)',
      integratePan(v0, { x: 0, y: 0 }, 0.016, WORLD) === v0
    );

    const moved = integratePan(v0, { x: 1000, y: -500 }, 0.1, WORLD);
    ok('integratePan: position moves by velocity * dt', moved.centerXPx === 6100 && moved.centerYPx === 5950);
    ok('integratePan: original state never mutated', v0.centerXPx === 6000);

    // Clamped fully at an edge -> collapses back to a no-op (same reference),
    // so a caller pinned against the world boundary can skip reframe/residency work.
    const atEdge = { ...v0, centerXPx: 0 };
    ok(
      'integratePan: fully clamped at the edge collapses to a no-op (same reference)',
      integratePan(atEdge, { x: -500, y: 0 }, 1, WORLD) === atEdge
    );

    const clampedPartial = integratePan(v0, { x: 100000000, y: 0 }, 1, WORLD);
    ok(
      'integratePan: huge velocity clamps the position to the world bound, never overshoots',
      clampedPartial.centerXPx === WORLD
    );
  }

  // --- easedZoomFactor: the per-frame factor fed into applyZoomAtPixel ----
  {
    ok(
      'easedZoomFactor: within epsilon of target is a no-op (factor 1)',
      easedZoomFactor(500, 500.1, 0.016, 0.12) === 1
    );
    ok('easedZoomFactor: zero dt is a no-op (factor 1)', easedZoomFactor(500, 100, 0, 0.12) === 1);

    const zoomingIn = easedZoomFactor(500, 100, 0.016, 0.12); // target SMALLER than current -> zooming IN
    ok('easedZoomFactor: target < current -> factor < 1 (zooming in)', zoomingIn < 1 && zoomingIn > 0);

    const zoomingOut = easedZoomFactor(500, 2000, 0.016, 0.12); // target LARGER -> zooming OUT
    ok('easedZoomFactor: target > current -> factor > 1 (zooming out)', zoomingOut > 1);

    // Applying the factor repeatedly (as the per-frame render loop does) must
    // actually CONVERGE to the target, never overshoot or oscillate.
    let halfSpan = 500;
    const target = 150;
    for (let i = 0; i < 300; i++) {
      const factor = easedZoomFactor(halfSpan, target, 1 / 60, 0.12);
      halfSpan *= factor;
    }
    ok(
      'easedZoomFactor: repeated application converges to the target, no overshoot/oscillation',
      Math.abs(halfSpan - target) < 0.5
    );

    // Frame-rate independence: two half-steps should land close to one
    // combined step (same property as smoothingAlpha, checked end-to-end
    // through the factor/multiply path this function actually feeds).
    let twoSteps = 500;
    twoSteps *= easedZoomFactor(twoSteps, 100, 0.05, 0.15);
    twoSteps *= easedZoomFactor(twoSteps, 100, 0.05, 0.15);
    let oneStep = 500;
    oneStep *= easedZoomFactor(oneStep, 100, 0.1, 0.15);
    ok('easedZoomFactor: two small dt steps ≈ one combined-dt step', Math.abs(twoSteps - oneStep) < 0.5);
  }
}
