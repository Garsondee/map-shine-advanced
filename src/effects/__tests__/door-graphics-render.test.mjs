/**
 * door-graphics-render.test.mjs — the DoorMesh parity math (pure). Every case
 * is checked against Foundry's own formulas (client/canvas/containers/elements/
 * door-mesh.mjs), using a simple horizontal wall so the numbers are hand-
 * verifiable. The TSL material (`buildDoorMaterial`) is browser-only (it needs a
 * live THREE), same split every render module here uses.
 */
import {
  DOOR_STYLES,
  DOOR_ANIMATION_TYPES,
  clamp01,
  easeInOutCosine,
  doorLeafStyles,
  isMidpointAnimation,
  computeDoorClosedSnapshot,
  applyDoorAnimation,
  doorSnapshotToPlacement,
} from '../door-graphics-render.js';

/** A horizontal single-swing door from (100,100)→(200,100): distance 100, angle 0. */
function swingDoor(overrides = {}) {
  return {
    wallId: 'w1',
    x1: 100,
    y1: 100,
    x2: 200,
    y2: 100,
    doorType: 1,
    ds: 0,
    open: false,
    textureGridSize: 200,
    animation: {
      type: 'swing',
      texture: 'd.webp',
      double: false,
      direction: 1,
      duration: 750,
      flip: false,
      strength: 1,
      ...overrides,
    },
  };
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

export function run(t) {
  const { ok } = t;

  // ── the small pure helpers ────────────────────────────────────────────────
  ok('clamp01 floors a NaN to 0', clamp01('x') === 0 && clamp01(-1) === 0 && clamp01(2) === 1 && clamp01(0.5) === 0.5);
  ok(
    'easeInOutCosine pins 0→0, 1→1, 0.5→0.5',
    near(easeInOutCosine(0), 0) && near(easeInOutCosine(1), 1) && near(easeInOutCosine(0.5), 0.5)
  );
  ok('easeInOutCosine clamps out-of-range time', easeInOutCosine(-5) === 0 && easeInOutCosine(5) === 1);

  ok(
    'a single door is one SINGLE leaf',
    JSON.stringify(doorLeafStyles(false)) === JSON.stringify([DOOR_STYLES.SINGLE])
  );
  ok(
    'a double door is a DOUBLE_LEFT + DOUBLE_RIGHT pair',
    JSON.stringify(doorLeafStyles(true)) === JSON.stringify([DOOR_STYLES.DOUBLE_LEFT, DOOR_STYLES.DOUBLE_RIGHT])
  );

  // Midpoint set is the exact Foundry set (ascend/descend/swivel), edge is swing/slide.
  ok(
    'ascend/descend/swivel pivot at the midpoint',
    isMidpointAnimation('ascend') && isMidpointAnimation('descend') && isMidpointAnimation('swivel')
  );
  ok('swing/slide pivot at the hinge edge', !isMidpointAnimation('swing') && !isMidpointAnimation('slide'));
  ok('an unknown type is not midpoint (falls to edge/swing behaviour)', !isMidpointAnimation('nonsense'));
  ok(
    'DOOR_ANIMATION_TYPES is exactly the 5 Foundry types',
    JSON.stringify(Object.keys(DOOR_ANIMATION_TYPES).sort()) ===
      JSON.stringify(['ascend', 'descend', 'slide', 'swing', 'swivel'])
  );

  // ── computeDoorClosedSnapshot — a single swing door ───────────────────────
  {
    const s = computeDoorClosedSnapshot(swingDoor(), DOOR_STYLES.SINGLE, { gridSize: 100, texWidth: 100 });
    ok('single door pivots at endpoint A', s.x === 100 && s.y === 100);
    ok('closed rotation equals the wall angle (0 for horizontal)', near(s.rotation, 0));
    ok('scaleX fills the wall (distance/textureWidth = 100/100 = 1)', near(s.scaleX, 1));
    ok('scaleY = gridSize/textureGridSize = 100/200 = 0.5', near(s.scaleY, 0.5));
    ok('closed leaf is un-tinted, opaque, edge-anchored', s.alpha === 1 && s.midpoint === false && s.tint[0] === 1);
  }

  // flip inverts scaleY; a coarser textureGridSize shrinks scaleY proportionally.
  {
    const flipped = computeDoorClosedSnapshot(swingDoor({ flip: true }), DOOR_STYLES.SINGLE, {
      gridSize: 100,
      texWidth: 100,
    });
    ok('authored flip negates scaleY', near(flipped.scaleY, -0.5));
    const coarse = computeDoorClosedSnapshot(swingDoor(), DOOR_STYLES.SINGLE, { gridSize: 100, texWidth: 100 });
    ok('default textureGridSize is Foundry’s 200, not 100', near(coarse.scaleY, 0.5));
  }

  // ── double door: two mirrored half-leaves ─────────────────────────────────
  {
    const L = computeDoorClosedSnapshot(swingDoor({ double: true }), DOOR_STYLES.DOUBLE_LEFT, {
      gridSize: 100,
      texWidth: 100,
    });
    const R = computeDoorClosedSnapshot(swingDoor({ double: true }), DOOR_STYLES.DOUBLE_RIGHT, {
      gridSize: 100,
      texWidth: 100,
    });
    ok('left leaf hinges at A (100,100)', L.x === 100 && L.y === 100);
    ok('right leaf hinges at B (200,100)', R.x === 200 && R.y === 100);
    ok('each half-leaf fills half the wall (scaleX 0.5)', near(L.scaleX, 0.5) && near(R.scaleX, 0.5));
    ok(
      'right leaf is mirrored (negative scaleY) and half-turned (rotation −π)',
      near(R.scaleY, -0.5) && near(R.rotation, -Math.PI)
    );
    ok('left leaf is NOT mirrored', near(L.scaleY, 0.5) && near(L.rotation, 0));
  }

  // ── applyDoorAnimation — one case per type, checked against DoorMesh.* ─────
  {
    const closed = computeDoorClosedSnapshot(swingDoor(), DOOR_STYLES.SINGLE, { gridSize: 100, texWidth: 100 });

    // swing: a quarter turn at p=1 (Math.PI/2 * direction * strength).
    const openSwing = applyDoorAnimation(closed, swingDoor(), 1);
    ok('swing opens a quarter turn (rotation +π/2 at p=1)', near(openSwing.rotation, Math.PI / 2));
    const halfSwing = applyDoorAnimation(closed, swingDoor(), 0.5);
    ok('swing is linear in the (eased) progress', near(halfSwing.rotation, Math.PI / 4));
    const closedSwing = applyDoorAnimation(closed, swingDoor(), 0);
    ok('p=0 is exactly the closed pose', near(closedSwing.rotation, 0));

    // reverse direction + partial strength swing.
    const revClosed = computeDoorClosedSnapshot(swingDoor({ direction: -1, strength: 0.5 }), DOOR_STYLES.SINGLE, {
      gridSize: 100,
      texWidth: 100,
    });
    const rev = applyDoorAnimation(revClosed, swingDoor({ direction: -1, strength: 0.5 }), 1);
    ok('direction/strength scale the swing (−π/4 at dir −1, strength 0.5)', near(rev.rotation, -Math.PI / 4));

    // swivel shares swing's motion (only its pivot differs, baked into closed).
    const swivelClosed = computeDoorClosedSnapshot(swingDoor({ type: 'swivel' }), DOOR_STYLES.SINGLE, {
      gridSize: 100,
      texWidth: 100,
    });
    ok('swivel pivots at the door midpoint', swivelClosed.x === 150 && swivelClosed.midpoint === true);
    const swivelOpen = applyDoorAnimation(swivelClosed, swingDoor({ type: 'swivel' }), 1);
    ok('swivel opens a quarter turn like swing', near(swivelOpen.rotation, Math.PI / 2));

    // slide: retract towards A by the full width at p=1.
    const slideClosed = computeDoorClosedSnapshot(swingDoor({ type: 'slide' }), DOOR_STYLES.SINGLE, {
      gridSize: 100,
      texWidth: 100,
    });
    const slideOpen = applyDoorAnimation(slideClosed, swingDoor({ type: 'slide' }), 1);
    ok('slide retracts towards A (x 100→0) and keeps y', near(slideOpen.x, 0) && near(slideOpen.y, 100));

    // ascend: fade + grow + darken toward 0x222222.
    const ascClosed = computeDoorClosedSnapshot(swingDoor({ type: 'ascend' }), DOOR_STYLES.SINGLE, {
      gridSize: 100,
      texWidth: 100,
    });
    const asc = applyDoorAnimation(ascClosed, swingDoor({ type: 'ascend' }), 1);
    ok('ascend fades alpha to 0.75 at p=1', near(asc.alpha, 0.75));
    ok('ascend grows scale by 0.1 (|scaleX| 1→1.1)', near(asc.scaleX, 1.1));
    ok('ascend darkens the tint toward 0x222222', near(asc.tint[0], 0x22 / 255) && near(asc.tint[1], 0x22 / 255));

    // descend: shrink + darken toward 0x666666.
    const descClosed = computeDoorClosedSnapshot(swingDoor({ type: 'descend' }), DOOR_STYLES.SINGLE, {
      gridSize: 100,
      texWidth: 100,
    });
    const desc = applyDoorAnimation(descClosed, swingDoor({ type: 'descend' }), 1);
    ok('descend shrinks scale by 0.05 (|scaleX| 1→0.95)', near(desc.scaleX, 0.95));
    ok('descend darkens the tint toward 0x666666', near(desc.tint[0], 0x66 / 255));
    ok('descend keeps full opacity', desc.alpha === 1);
  }

  // ── THE DOUBLE-DOOR MIRROR FIX (2026-07-24, live-reported: double doors
  // opened to opposite sides of the wall) — both leaves must swing to the
  // SAME side. Checked by projecting each leaf's free end (its local
  // (halfWidth, 0), the point farthest from the hinge) through the OPEN
  // rotation, exactly what computeQuadCorners does — a real geometric check,
  // not just a rotation-number comparison. ─────────────────────────────────
  {
    const doubleDoor = swingDoor({ double: true });
    const halfWidth = 50; // door-graphics-render's own SINGLE-vs-double split: distance/2 = 100/2

    /** Project a leaf's free end (local (halfWidth,0), the hinge is the pivot
     * itself) through its rotation into world space — the same rotate step
     * computeQuadCorners performs. */
    function freeEndWorld(closed, animated) {
      const rad = animated.rotation;
      return { x: closed.x + Math.cos(rad) * halfWidth, y: closed.y + Math.sin(rad) * halfWidth };
    }

    const leftClosed = computeDoorClosedSnapshot(doubleDoor, DOOR_STYLES.DOUBLE_LEFT, { gridSize: 100, texWidth: 100 });
    const rightClosed = computeDoorClosedSnapshot(doubleDoor, DOOR_STYLES.DOUBLE_RIGHT, {
      gridSize: 100,
      texWidth: 100,
    });
    const leftClosedEnd = freeEndWorld(leftClosed, leftClosed);
    const rightClosedEnd = freeEndWorld(rightClosed, rightClosed);
    ok(
      'closed, both free ends meet at the wall midpoint (150,100)',
      near(leftClosedEnd.x, 150) &&
        near(leftClosedEnd.y, 100) &&
        near(rightClosedEnd.x, 150) &&
        near(rightClosedEnd.y, 100)
    );

    const leftOpen = applyDoorAnimation(leftClosed, doubleDoor, 1);
    const rightOpen = applyDoorAnimation(rightClosed, doubleDoor, 1);
    const leftEnd = freeEndWorld(leftClosed, leftOpen);
    const rightEnd = freeEndWorld(rightClosed, rightOpen);
    // THE ACTUAL BUG: compare each leaf's DISPLACEMENT from its own pivot (not
    // absolute position — the two leaves pivot at different points, x=100 vs
    // x=200, so absolute end points necessarily differ in x). Hand-verified:
    // left pivots at (100,100), swings to (100,150) — displacement (0,+50).
    // Right pivots at (200,100); WITHOUT this fix it swings to (200,50) —
    // displacement (0,-50), the OPPOSITE side (this is the exact bug reported
    // live). WITH the fix it swings to (200,150) — displacement (0,+50),
    // identical to the left leaf's: both doors swing straight "down" (the
    // same absolute screen direction), matching real Foundry's own DoorMesh
    // (which flips the right leaf's `direction` for exactly this reason).
    ok(
      'fully open, left leaf displaces (0, +50) from its own pivot',
      near(leftEnd.x - leftClosed.x, 0) && near(leftEnd.y - leftClosed.y, 50)
    );
    ok(
      'fully open, the right leaf displaces the SAME (0, +50) from ITS pivot — not (0, -50), the opposite side',
      near(rightEnd.x - rightClosed.x, 0) && near(rightEnd.y - rightClosed.y, 50)
    );

    // slide shares the same per-leaf direction flip (it also reads `direction`),
    // but for a SLIDING door "the same fix" looks like each leaf retracting
    // OUTWARD past its OWN hinge (a mirrored, symmetric retraction into each
    // side's own wall pocket) — the physically sensible parity look, and what
    // Foundry's own single `direction *= -1` flip (applied once, reused by
    // every animation type that reads `direction`) actually produces. This is
    // NOT "same signed x displacement" (that would be the SWING fix's shape);
    // it is each leaf's displacement pointing AWAY from the door's own centre.
    const slideDouble = swingDoor({ double: true, type: 'slide' });
    const slLeftClosed = computeDoorClosedSnapshot(slideDouble, DOOR_STYLES.DOUBLE_LEFT, {
      gridSize: 100,
      texWidth: 100,
    });
    const slRightClosed = computeDoorClosedSnapshot(slideDouble, DOOR_STYLES.DOUBLE_RIGHT, {
      gridSize: 100,
      texWidth: 100,
    });
    const slLeftOpen = applyDoorAnimation(slLeftClosed, slideDouble, 1);
    const slRightOpen = applyDoorAnimation(slRightClosed, slideDouble, 1);
    // Each half-leaf slides half the WALL length (m = strength*0.5 = 0.5,
    // times the wall's 100px length = 50px), away from the doorway centre.
    ok('sliding double door: left leaf retracts past its own hinge (100 → 50)', near(slLeftOpen.x, 50));
    ok(
      'sliding double door: right leaf retracts past ITS own hinge too (200 → 250), mirrored — not towards the left leaf (200 → 150)',
      near(slRightOpen.x, 250)
    );

    // Un-flipped single doors are untouched by this fix (regression guard).
    const singleClosed = computeDoorClosedSnapshot(swingDoor(), DOOR_STYLES.SINGLE, { gridSize: 100, texWidth: 100 });
    const singleOpen = applyDoorAnimation(singleClosed, swingDoor(), 1);
    ok('a SINGLE door is unaffected by the double-door direction flip', near(singleOpen.rotation, Math.PI / 2));
  }

  // ── doorSnapshotToPlacement — the computeQuadCorners bridge ────────────────
  {
    const closed = computeDoorClosedSnapshot(swingDoor(), DOOR_STYLES.SINGLE, { gridSize: 100, texWidth: 100 });
    const p = doorSnapshotToPlacement(closed, { texWidth: 100, texHeight: 200 });
    ok('placement anchor = the pivot point', p.x === 100 && p.y === 100);
    ok('rendered width = scaleX × texWidth (100)', near(p.width, 100));
    ok('rendered height = scaleY × texHeight (0.5 × 200 = 100)', near(p.height, 100));
    ok(
      'edge anim anchors at the hinge (anchorX 0), vertical centre (anchorY 0.5)',
      p.anchorX === 0 && p.anchorY === 0.5
    );
    ok('rotation is converted radians→degrees (0→0)', near(p.rotation, 0));

    // A 90°-open swing: rotation π/2 rad → 90 deg for computeQuadCorners.
    const open = applyDoorAnimation(closed, swingDoor(), 1);
    const po = doorSnapshotToPlacement(open, { texWidth: 100, texHeight: 200 });
    ok('an opened swing hands computeQuadCorners 90 degrees', near(po.rotation, 90));

    // Midpoint anim → centre anchor.
    const swClosed = computeDoorClosedSnapshot(swingDoor({ type: 'swivel' }), DOOR_STYLES.SINGLE, {
      gridSize: 100,
      texWidth: 100,
    });
    const swp = doorSnapshotToPlacement(swClosed, { texWidth: 100, texHeight: 200 });
    ok('midpoint anim anchors at the centre (anchorX 0.5)', swp.anchorX === 0.5);

    // Negative scaleY (flip / doubleR) survives as a negative height (mirror).
    const flipClosed = computeDoorClosedSnapshot(swingDoor({ flip: true }), DOOR_STYLES.SINGLE, {
      gridSize: 100,
      texWidth: 100,
    });
    const flipP = doorSnapshotToPlacement(flipClosed, { texWidth: 100, texHeight: 200 });
    ok('a flipped leaf has a negative rendered height (mirrors, not vanishes)', flipP.height < 0);
  }

  // Totality: a diagonal wall angle flows straight through (no Y-flip anywhere).
  {
    const diag = { ...swingDoor(), x2: 200, y2: 200 }; // 45° down-right
    const s = computeDoorClosedSnapshot(diag, DOOR_STYLES.SINGLE, { gridSize: 100, texWidth: 100 });
    ok('a 45° wall closes at rotation π/4 (raw atan2, no flip)', near(s.rotation, Math.PI / 4));
    ok('scaleX fills the diagonal length (√2·100 / 100)', near(s.scaleX, Math.SQRT2));
  }
}
