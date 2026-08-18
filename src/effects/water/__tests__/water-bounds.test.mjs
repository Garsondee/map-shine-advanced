/**
 * water-bounds.test.mjs — WATER STOPS AT THE EDGE OF THE MAP.
 *
 * Author, live, 2026-08-16, with an arrow drawn at a band of water sitting in
 * the black ABOVE the map art: *"I also noticed that water can appear outside
 * the bounds of the actual map."*
 *
 * The cause was a soft pad meeting a hard boundary. `WATER_BOUNDS_PAD_PX` grows
 * the measured water AABB by 64 px so the mesh never clips its own antialiased
 * shoreline — correct for an interior shore, and wrong at the map's own edge,
 * where those 64 px land in the void beyond the background art. The surface
 * shader then samples its mask through a UV CLAMP, and a clamp does not stop at
 * a boundary, it extrudes the edge row: a river running off the top of the map
 * had its topmost row of water texels smeared upward across the full width.
 *
 * Worth noting for whoever meets the next one of these: **every status field
 * water reports looked healthy**. `getStatus().bounds` printed the escaped rect
 * and there is nothing about it that reads as wrong unless you happen to also
 * know the mask rect — which is exactly why the fix is a pure function with a
 * test rather than a wider pad and a hope (`feedback_instruments_must_not_lie`).
 */
import { clipRectToMask } from '../water-body-subsystem.js';

/** The author's own scene, measured live and recorded in
 * `water-surface-subsystem.js`: mask and level background both read
 * 2700,1350 → 13350,6300. Using the real numbers rather than a tidy 0..1 box
 * keeps the test honest about the sign conventions of a real Foundry rect. */
const MASK = { minX: 2700, minY: 1350, maxX: 13350, maxY: 6300 };

export function run(t) {
  const { ok } = t;

  // ── THE REPORTED BUG ───────────────────────────────────────────────────
  // A river that touches the top edge of the map: the measured AABB is flush
  // with the mask's own minY, and the 64 px pad pushes it above the map.
  const escaped = { minX: 4000, minY: MASK.minY - 64, maxX: 9000, maxY: 4000 };
  const clipped = clipRectToMask(escaped, MASK);
  ok('a pad that escapes the top of the map is pulled back to it', clipped.minY === MASK.minY);
  ok(
    'and the three sides that never escaped are left exactly alone',
    clipped.minX === 4000 && clipped.maxX === 9000 && clipped.maxY === 4000
  );

  // ── EVERY SIDE, NOT JUST THE ONE THAT WAS REPORTED ─────────────────────
  // The author saw the top edge. A river can leave by any of the four, and a
  // fix that only handles the reported side is how the same bug gets reported
  // twice.
  const allSides = clipRectToMask(
    { minX: MASK.minX - 64, minY: MASK.minY - 64, maxX: MASK.maxX + 64, maxY: MASK.maxY + 64 },
    MASK
  );
  ok(
    'water painted to all four edges is clipped on all four',
    allSides.minX === MASK.minX &&
      allSides.minY === MASK.minY &&
      allSides.maxX === MASK.maxX &&
      allSides.maxY === MASK.maxY
  );

  // ── THE PAD STILL DOES ITS OWN JOB ─────────────────────────────────────
  // The clip must not become a reason the interior shoreline clips its own
  // antialiased edge — that is the bug the pad exists to prevent, and trading
  // one for the other is not a fix.
  const interior = { minX: 5000, minY: 2000, maxX: 6000, maxY: 3000 };
  const untouched = clipRectToMask(interior, MASK);
  ok(
    'a pond in the middle of the map keeps its full padded bounds',
    untouched.minX === 5000 && untouched.minY === 2000 && untouched.maxX === 6000 && untouched.maxY === 3000
  );

  // ── THE DEGENERATE CASES ───────────────────────────────────────────────
  // An empty intersection must be `null`, the same "no bounds" the caller
  // already handles for a floor with no water — NEVER an inverted rect, which
  // `buildQuadPositions` would happily turn into a backwards quad that renders
  // as a stripe or as nothing depending on winding.
  ok(
    'a rect entirely outside the mask yields null, never an inverted rect',
    clipRectToMask({ minX: 100, minY: 100, maxX: 200, maxY: 200 }, MASK) === null
  );
  ok(
    'a rect touching the mask edge-on (zero area) also yields null',
    clipRectToMask({ minX: MASK.minX - 50, minY: 2000, maxX: MASK.minX, maxY: 3000 }, MASK) === null
  );

  // A missing mask rect must not silently erase the bounds: an unwired caller
  // gets the unclipped rect (today's behaviour) rather than `null`, which would
  // hide the water entirely and look like the effect is broken.
  const noMask = clipRectToMask(interior, null);
  ok('with no mask rect at all the bounds pass through unchanged, never null', noMask && noMask.minX === 5000);
  ok('and a null rect stays null', clipRectToMask(null, MASK) === null);
}
