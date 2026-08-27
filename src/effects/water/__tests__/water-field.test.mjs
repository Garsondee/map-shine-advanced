/**
 * water-field.test.mjs — THE COMPASS, PINNED TO ALL EIGHT CARDINALS.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================
 * `feedback_y_flip_recurring_risk` has been paid FIVE times in this project,
 * and the precipitation wind compass most recently — where the correction
 * turned out to be a ROTATION, not the sign flip it first looked like. Water's
 * flow direction had BOTH available bugs at once and shipped with both:
 *
 *   1. the heading ran from +x with degrees increasing CLOCKWISE on screen
 *      (world Y is DOWN here), while its own help text said "0 being to the
 *      right of the screen" — half-true, and the half that is wrong is the
 *      half nobody checks;
 *   2. the travel was ADDED to the noise domain, and a pattern moves OPPOSITE
 *      to its domain, so every river ran backwards.
 *
 * Neither is visible by looking at water: a moving surface looks like a moving
 * surface. They only become visible when a control claims a DIRECTION, which is
 * exactly what the author asked for. So the direction gets a test, not an
 * eyeball — and the test names the screen direction in words, because "world
 * (0,−1)" is not a claim anybody can check by reading it.
 */
import {
  waterFlowVector,
  WATER_TIER2_FLOW_ANGLE_DEG,
  WATER_BANK_REACH_PX,
  WATER_BANK_INFLUENCE,
  WATER_FLOW_WARP_INFLUENCE,
  WATER_FOAM_SHORE_PX,
  WATER_SHOAL_REACH_PX,
  WATER_SHOAL_STRENGTH,
  WATER_CAUSTICS_MAX,
  WATER_CAUSTICS_SHARPNESS,
  WATER_CAUSTICS_EDGE_FAR_MIN,
  WATER_CAUSTICS_EDGE_FAR_MAX,
  WATER_CAUSTICS_EDGE_AA_PX,
  WATER_CAUSTICS_SCALE,
  WATER_CAUSTICS_NETTING,
  WATER_CAUSTICS_NET_SCALE_RATIO,
  WATER_CAUSTICS_WAVE_WARP_STRENGTH,
  WATER_CAUSTICS_WAVE_WARP_CELLS,
  WATER_CAUSTICS_GROWTH_FREQ,
  WATER_CAUSTICS_GROWTH_EPS,
  WATER_CAUSTICS_GROWTH_STRENGTH,
  WATER_CAUSTICS_GROWTH_CELLS,
  WATER_CAUSTICS_GROWTH_TIME_SCALE,
  WATER_CAUSTICS_EVOLVE_SPEED,
  WATER_CAUSTICS_NET_TIME_PHASE,
  WATER_CAUSTICS_JUNCTION_FRACTION,
  WATER_CAUSTICS_LINE_FLOOR,
} from '../water-field.js';

/** The renderer's world space is Y-DOWN (`vt-pan-viewer.js#updateCamera`: the
 * frustum's `top = minY`, so the SMALLEST world Y is the TOP of the screen).
 * Naming that here, once, is what lets every assertion below be written in the
 * language the author uses — "south is down the screen" — instead of in a
 * convention a reader has to re-derive. */
const SCREEN = {
  up: [0, -1],
  down: [0, 1],
  right: [1, 0],
  left: [-1, 0],
};

export function run(t) {
  const { ok } = t;
  const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
  const isDir = (v, expected) => near(v[0], expected[0]) && near(v[1], expected[1]);

  // ── THE FOUR CARDINALS, IN SCREEN WORDS ────────────────────────────────
  ok('compass 0° (north) travels UP the screen', isDir(waterFlowVector(0), SCREEN.up));
  ok('compass 90° (east) travels RIGHT', isDir(waterFlowVector(90), SCREEN.right));
  ok('compass 180° (south) travels DOWN the screen', isDir(waterFlowVector(180), SCREEN.down));
  ok('compass 270° (west) travels LEFT', isDir(waterFlowVector(270), SCREEN.left));

  // The author's own worked example, stated as its own assertion because it is
  // the sentence the feature was requested in: *"the user can easily select
  // 'south'"*, on a map whose river runs down the page.
  const south = waterFlowVector(180);
  ok('"south" means the water goes toward the bottom of the screen, not away from it', south[1] > 0);

  // ── THE ORDERING IS CLOCKWISE ON SCREEN ────────────────────────────────
  // A rotation error survives every cardinal test if the four are checked
  // independently; what catches it is the SEQUENCE. North→east→south→west must
  // sweep the same way a clock's hand does over a screen with Y down.
  const ne = waterFlowVector(45);
  ok('45° (north-east) is up AND right — the quadrant between its neighbours', ne[0] > 0 && ne[1] < 0);
  const se = waterFlowVector(135);
  ok('135° (south-east) is down and right', se[0] > 0 && se[1] > 0);
  const sw = waterFlowVector(225);
  ok('225° (south-west) is down and left', sw[0] < 0 && sw[1] > 0);
  const nw = waterFlowVector(315);
  ok('315° (north-west) is up and left', nw[0] < 0 && nw[1] < 0);

  // ── IT IS A UNIT VECTOR AT EVERY HEADING ───────────────────────────────
  // The speed lives in `uFlowSpeedPx`; if this were not unit-length, the river
  // would run faster on the diagonals, which is the kind of thing that reads as
  // "the flow slider is inconsistent" rather than as a bug in a conversion.
  let allUnit = true;
  for (let deg = 0; deg < 360; deg += 7) {
    const v = waterFlowVector(deg);
    if (!near(Math.hypot(v[0], v[1]), 1, 1e-12)) allUnit = false;
  }
  ok('every heading yields a UNIT vector — direction and speed stay separate controls', allUnit);

  // ── IT IS CYCLIC, AND SURVIVES NONSENSE ────────────────────────────────
  ok('370° is the same heading as 10°', isDir(waterFlowVector(370), waterFlowVector(10)));
  ok('−90° is the same heading as 270° (west)', isDir(waterFlowVector(-90), SCREEN.left));
  ok('a non-finite heading falls back to north rather than producing NaN', isDir(waterFlowVector(NaN), SCREEN.up));

  // ── EXACT ZEROS, NOT FLOATING-POINT DUST ───────────────────────────────
  // `Math.sin(Math.PI)` is 1.2e-16, not 0. Left alone it would put a sideways
  // drift of one part in 10^16 into "due south" — harmless numerically and
  // corrosive to a test suite, because every cardinal assertion would then need
  // a tolerance wide enough to also swallow a real small rotation error.
  ok('south has EXACTLY no sideways component', waterFlowVector(180)[0] === 0);
  ok('west has EXACTLY no vertical component', waterFlowVector(270)[1] === 0);

  // ── THE DEFAULT IS A REAL HEADING ──────────────────────────────────────
  ok(
    `the shipped default (${WATER_TIER2_FLOW_ANGLE_DEG}°) is south — water reads as running down the page`,
    isDir(waterFlowVector(WATER_TIER2_FLOW_ANGLE_DEG), SCREEN.down)
  );

  // ── THE BANK WARP'S OWN BOUNDS ─────────────────────────────────────────
  // Both halves of the hard-edge fix are constants, and both have a property
  // worth pinning rather than a value worth remembering.
  ok(
    'the bank warp stays UNDER one noise cell — a bounded domain offset cannot streak (correction #10)',
    WATER_BANK_INFLUENCE > 0 && WATER_BANK_INFLUENCE < 1
  );
  ok(
    'the tangent still has full say everywhere foam can appear — bank reach exceeds the foam band',
    WATER_BANK_REACH_PX > WATER_FOAM_SHORE_PX
  );
  ok(
    'and it dies out well inside a channel, where the medial axis makes the tangent meaningless',
    WATER_BANK_REACH_PX < 1000
  );

  // ── THE FLOW WARP'S OWN BOUNDS — bankWarp's sibling ────────────────────
  // Same law, same reason: a domain offset bounded under one noise cell
  // cannot separate two neighbouring pixels by more than that cap, whatever
  // the real solve does between them and however long the scene runs. This
  // is the constant that would have to grow past 1 (or start scaling by
  // elapsed time) to reopen the exact barcode bug `WATER_BANK_INFLUENCE`
  // already paid for once.
  // ⚠️ NOT `< 1` any more (2026-08-19, raised 0.35→1.0 — see the constant's
  // own doc for the live-reported "no evidence of flow going around
  // objects" this answers). The safety property was never "stays under one
  // cell" specifically — it is "a FIXED constant, never scaled by time or
  // position" (`WATER_BANK_INFLUENCE`'s own docstring). A positive, finite
  // number is the only thing that check can honestly require now that the
  // two sibling terms are no longer required to match.
  ok(
    'the flow warp is a real, finite, positive weight',
    WATER_FLOW_WARP_INFLUENCE > 0 && Number.isFinite(WATER_FLOW_WARP_INFLUENCE)
  );
  ok(
    'the flow warp and bank warp are DELIBERATELY no longer required to match — only flowWarp was reported weak',
    WATER_FLOW_WARP_INFLUENCE >= WATER_BANK_INFLUENCE
  );

  // ══ TIER 4 — WAVE SHOALING'S OWN CONSTANTS ═══════════════════════════════
  // The formula itself (`n.y.mul(1 + shoalGate)`) only exists inside the TSL
  // graph, but the two facts that make it SAFE and PHYSICALLY SENSIBLE are
  // plain numbers, and both were explicit design decisions worth pinning
  // rather than leaving to a docstring nobody re-reads on the next edit.
  ok(
    'shoaling reaches exactly as far as the foam gate — the SAME physical fact, read twice, must agree',
    WATER_SHOAL_REACH_PX === WATER_FOAM_SHORE_PX
  );
  ok(
    "shoaling amplifies by less than double at the waterline — a real 4:1 depth contrast (Green's law) predicts ~41%, not a doubling",
    WATER_SHOAL_STRENGTH > 0 && WATER_SHOAL_STRENGTH < 1
  );

  // ══ TIER 4 — CAUSTICS: A WORLEY F2−F1 CELL-EDGE NET (rebuilt 2026-08-27) ═
  // The original Jacobian-focus mechanism (and its `waterCausticsCpu` CPU
  // twin, tested here through several prior rounds) was REPLACED, not
  // retuned — a live screenshot at maximum sharpening AND maximum netting was
  // still soft round blobs, not filaments, next to the author's own reference
  // image (an unmistakable Worley/Voronoi cell-edge net). See
  // `water-field.js`'s own "CAUSTICS, A WORLEY F2−F1 CELL-EDGE NET" header for
  // the full diagnosis. The new mechanism's SHAPE (a spatial Worley pattern)
  // is not a pure function of a few scalars the way the old Jacobian formula
  // was, so it is not CPU-unit-testable the same way — the same GPU/bench-only
  // boundary `buildFoamCellularStructure`'s own Worley machinery already
  // draws in this file's sibling module. What IS pinned here, in plain Node,
  // is every constant's own SHAPE — the relationships that must hold for the
  // sliders to do what their help text promises, regardless of the exact
  // numbers a future tuning pass picks.
  ok(
    'the sharpest edge setting is genuinely NARROWER than the softest — the slider has real range',
    WATER_CAUSTICS_EDGE_FAR_MIN < WATER_CAUSTICS_EDGE_FAR_MAX
  );
  ok(
    'both edge-width bounds are positive — a zero or negative band width is not a valid threshold',
    WATER_CAUSTICS_EDGE_FAR_MIN > 0 && WATER_CAUSTICS_EDGE_FAR_MAX > 0
  );
  ok(
    'the hairline end is a GENUINE hairline — well under shore foam`s own thinnest lace setting, not just "a bit less"',
    WATER_CAUSTICS_EDGE_FAR_MIN < 0.2
  );
  ok(
    'the screen-space AA width is positive and modest — a few pixels, not a fraction of the screen',
    WATER_CAUSTICS_EDGE_AA_PX > 0 && WATER_CAUSTICS_EDGE_AA_PX < 10
  );
  ok(
    'the brightening ceiling is a real, positive excess — 0 would make caustics permanently invisible',
    WATER_CAUSTICS_MAX > 0
  );
  ok(
    'WATER_CAUSTICS_SCALE keeps the caustic net finer than the visible wave scale by default — the whole point of decoupling the two domains',
    WATER_CAUSTICS_SCALE > 0 && WATER_CAUSTICS_SCALE < 1
  );
  ok(
    'WATER_CAUSTICS_NETTING ships on (not zero) — the second layer is part of the improved default look, not opt-in-only',
    WATER_CAUSTICS_NETTING > 0 && WATER_CAUSTICS_NETTING <= 1
  );
  ok(
    'WATER_CAUSTICS_NET_SCALE_RATIO makes the second layer genuinely FINER, never coarser or identical',
    WATER_CAUSTICS_NET_SCALE_RATIO > 1
  );
  ok(
    'WATER_CAUSTICS_NET_SCALE_RATIO is not a round integer — an integer ratio risks the two layers` cell edges periodically re-aligning',
    !Number.isInteger(WATER_CAUSTICS_NET_SCALE_RATIO)
  );
  // ── WAVE-LINKED DISTORTION (round 3) — ties the net to the water's own
  // actual wave state instead of decorating independently of it. Author,
  // live: "they don't animate, they aren't distorted by the refraction...
  // we need to link the two things together."
  ok(
    'WATER_CAUSTICS_WAVE_WARP_STRENGTH is strictly positive — zero would silently disable the whole wave-link',
    WATER_CAUSTICS_WAVE_WARP_STRENGTH > 0
  );
  ok(
    'WATER_CAUSTICS_WAVE_WARP_CELLS is a real, bounded cap, not zero (no warp) and not unbounded (the domain-shear failure this file has already paid for once)',
    WATER_CAUSTICS_WAVE_WARP_CELLS > 0 && WATER_CAUSTICS_WAVE_WARP_CELLS <= 2
  );
  // ── ORGANIC SHAPE + GENUINE EVOLUTION (round 4) — author, live: "No
  // evolution happening... shapes are angular and sharp, not smooth wispy
  // and fluid... cells don't evolve... it should be concentrated into the
  // intersections and grow weak in the middle parts of the lines."
  // ── GROWTH/PULL WARP (round 5) — replaces round 4's plain organic warp.
  // Author, live: "cells should expand and contract. Cells should pull on
  // the ones around them when they do this."
  ok(
    'WATER_CAUSTICS_GROWTH_FREQ samples COARSER than one whole cell — a peak/trough pair must span several cells for growth to visibly pull a neighbour, not just breathe alone',
    WATER_CAUSTICS_GROWTH_FREQ > 0 && WATER_CAUSTICS_GROWTH_FREQ < 1
  );
  ok(
    'WATER_CAUSTICS_GROWTH_EPS is a real, small, positive finite-difference step — zero would divide-by-zero the gradient, and a large step would sample an unrelated feature',
    WATER_CAUSTICS_GROWTH_EPS > 0 && WATER_CAUSTICS_GROWTH_EPS < 1
  );
  ok(
    'WATER_CAUSTICS_GROWTH_STRENGTH/_CELLS are strictly positive, bounded values — the same rescale-not-clamp safety shape as the wave warp',
    WATER_CAUSTICS_GROWTH_STRENGTH > 0 && WATER_CAUSTICS_GROWTH_CELLS > 0 && WATER_CAUSTICS_GROWTH_CELLS <= 2
  );
  ok(
    'WATER_CAUSTICS_GROWTH_STRENGTH is deliberately conservative — at or under the shader-lab-CONFIRMED-safe WAVE_WARP_STRENGTH, since this round shipped unverified',
    WATER_CAUSTICS_GROWTH_STRENGTH <= WATER_CAUSTICS_WAVE_WARP_STRENGTH
  );
  ok(
    // ⚠️ Widened >1 (round 7) — the author's own live-tuned default (1.2)
    // is genuinely faster than the "gentle rhythm" this bound originally
    // assumed; the schema's own 0..2 range is the real ceiling now, not a
    // guess made before anyone had looked at it moving.
    'WATER_CAUSTICS_GROWTH_TIME_SCALE is a real, positive rate, inside its own schema range',
    WATER_CAUSTICS_GROWTH_TIME_SCALE > 0 && WATER_CAUSTICS_GROWTH_TIME_SCALE <= 2
  );
  ok(
    'WATER_CAUSTICS_EVOLVE_SPEED is strictly positive — zero would silently disable all lattice evolution, the round`s own headline ask',
    WATER_CAUSTICS_EVOLVE_SPEED > 0
  );
  ok(
    'WATER_CAUSTICS_NET_TIME_PHASE is not zero — an un-phased second layer would evolve in lockstep with the first, undoing the point of a fixed offset',
    WATER_CAUSTICS_NET_TIME_PHASE !== 0
  );
  ok(
    'WATER_CAUSTICS_JUNCTION_FRACTION sits strictly inside (0, 1] of the edge threshold — a junction is a TIGHTER feature than a plain edge, never a wider or inverted one',
    WATER_CAUSTICS_JUNCTION_FRACTION > 0 && WATER_CAUSTICS_JUNCTION_FRACTION <= 1
  );
  ok(
    'WATER_CAUSTICS_LINE_FLOOR keeps a plain edge visibly PART of the net (not erased) while staying meaningfully dimmer than a junction`s own ceiling of 1',
    WATER_CAUSTICS_LINE_FLOOR > 0 && WATER_CAUSTICS_LINE_FLOOR < 1
  );
  ok(
    'WATER_CAUSTICS_SHARPNESS/_NETTING are valid author-facing 0..1 values, not internal-only leftovers',
    WATER_CAUSTICS_SHARPNESS >= 0 &&
      WATER_CAUSTICS_SHARPNESS <= 1 &&
      WATER_CAUSTICS_NETTING >= 0 &&
      WATER_CAUSTICS_NETTING <= 1
  );
}
