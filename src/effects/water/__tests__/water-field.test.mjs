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
  waterCausticsCpu,
  WATER_TIER2_FLOW_ANGLE_DEG,
  WATER_TIER3_CHOP,
  WATER_BANK_REACH_PX,
  WATER_BANK_INFLUENCE,
  WATER_FLOW_WARP_INFLUENCE,
  WATER_FOAM_SHORE_PX,
  WATER_SHOAL_REACH_PX,
  WATER_SHOAL_STRENGTH,
  WATER_CAUSTICS_MIN_DET,
  WATER_CAUSTICS_MAX,
  WATER_CAUSTICS_DARK_MAX,
  WATER_CAUSTICS_K,
  WATER_CAUSTICS_SHARPNESS,
  WATER_CAUSTICS_SHARPNESS_EXPONENT_MAX,
  WATER_CAUSTICS_SCALE,
  WATER_CAUSTICS_NETTING,
  WATER_CAUSTICS_NET_SCALE_RATIO,
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

  // ══ TIER 4 — CAUSTICS: THE FORMULA, MEASURED IN SHAPE ════════════════════
  // `waterCausticsCpu` is the CPU twin of the shader's own
  // `det(I + k·J)` block — see `water-field.js#WATER_CAUSTICS_K`'s own doc for
  // the REAL GPU sweep this was calibrated against (65,536 live samples of the
  // actual `mx_fractal_noise_vec3` Jacobian). What is pinned HERE is the
  // formula's SHAPE, which holds for any `k` and therefore survives a future
  // re-calibration: identity at rest, correct sign either side of it, both
  // clamps engage, and a `chop` of 0 turns the whole rung off (no wave field,
  // no curvature to have caustics from).
  ok(
    'a flat patch (no curvature at all) contributes exactly ZERO — the identity a caller can trust',
    waterCausticsCpu({ j00: 0, j01: 0, j10: 0, j11: 0 }) === 0
  );
  ok(
    'a CONVERGING patch (negative trace) brightens the bed',
    waterCausticsCpu({ j00: -0.01, j01: 0, j10: 0, j11: -0.01 }) > 0
  );
  ok(
    'a DIVERGING patch (positive trace) darkens it, never brightens',
    waterCausticsCpu({ j00: 0.01, j01: 0, j10: 0, j11: 0.01 }) < 0
  );
  ok(
    'brightening never exceeds the declared ceiling, however extreme the curvature',
    waterCausticsCpu({ j00: -50, j01: 0, j10: 0, j11: -50 }) <= WATER_CAUSTICS_MAX
  );
  ok(
    'darkening never exceeds the declared floor either — no black holes in the bed',
    waterCausticsCpu({ j00: 50, j01: 0, j10: 0, j11: 50 }) >= -WATER_CAUSTICS_DARK_MAX
  );
  ok(
    'the brightening ceiling is meaningfully higher than the darkening floor — real caustics read as bright lines on an unremarkable field, not as symmetric bright/dark pairs',
    WATER_CAUSTICS_MAX > WATER_CAUSTICS_DARK_MAX * 2
  );
  ok(
    'chop=0 (no wave field at all) silences caustics completely, at ANY curvature',
    waterCausticsCpu({ j00: -0.5, j01: 0, j10: 0, j11: -0.5, chop: 0 }) === 0
  );

  // ⚠️ THE REGRESSION GUARD — this shipped live and the author saw it as
  // *"moving patterns across the whole ground floor, indoors and outside...
  // everywhere that isn't water too"* (2026-08-16).
  //
  // The noise this Jacobian differentiates is a WORLD-SPACE function: it is
  // defined and curved on every pixel of the map. `causticBrightness` is
  // consumed as `1 + it` on the ABSORPTION mesh — a `dst · src` multiply whose
  // neutral element is exactly 1 — over a quad spanning the water's whole AABB.
  // So "zero where the surface is flat" was never the promise that mattered;
  // "zero outside the water" is, and only an explicit `insideWater` gate gives
  // it. Asserted at FULL curvature, because the failure was loudest exactly
  // where the term was largest.
  ok(
    'OUTSIDE the water, caustics are EXACTLY zero — not small, zero (the multiply mesh needs a literal 1)',
    waterCausticsCpu({ j00: -0.02, j01: 0.01, j10: 0.01, j11: -0.02, insideWater: 0 }) === 0
  );
  {
    // A genuinely FOCUSING patch — `k·j00 = −1` drives `det` to 0, which is the
    // configuration that pegs the brightening ceiling. (Cranking both diagonals
    // to −50 instead makes `det` enormous, i.e. strongly DIVERGING, and
    // correctly clamps to the dark floor — worth stating because it is the
    // obvious "extreme value" to reach for and it tests the opposite thing.)
    const kEff = WATER_CAUSTICS_K * WATER_TIER3_CHOP;
    const focusing = { j00: -1 / kEff, j01: 0, j10: 0, j11: 0 };
    ok(
      '...even at the curvature that pegs the brightening ceiling inside the water',
      waterCausticsCpu({ ...focusing, insideWater: 0 }) === 0
    );
    ok(
      '...while the SAME curvature inside the water still produces its full effect',
      waterCausticsCpu({ ...focusing, insideWater: 1 }) === WATER_CAUSTICS_MAX
    );
  }
  ok(
    'the antialiased shoreline ramp scales caustics proportionally rather than popping',
    Math.abs(
      waterCausticsCpu({ j00: -0.01, j01: 0, j10: 0, j11: -0.01, insideWater: 0.5 }) -
        waterCausticsCpu({ j00: -0.01, j01: 0, j10: 0, j11: -0.01, insideWater: 1 }) * 0.5
    ) < 1e-12
  );
  {
    // Constructed to drive `det` to EXACTLY 0 via the trace term:
    // `k·j00 = -1` makes `(1 + k·j00) = 0`, so the whole product is 0.
    const kEff = WATER_CAUSTICS_K * WATER_TIER3_CHOP;
    const b = waterCausticsCpu({ j00: -1 / kEff, j01: 0, j10: 0, j11: 0 });
    ok('a determinant driven to exactly 0 (via the trace) is finite, not Infinity/NaN', Number.isFinite(b));
    ok('...and lands exactly at the brightening ceiling, not one unit past it', b === WATER_CAUSTICS_MAX);
  }
  {
    // Constructed to drive `det` to EXACTLY 0 via the CROSS term instead —
    // `j00 = j11 = 0` so the trace half is 1, and `(k·j01)(k·j10) = 1` cancels
    // it. Exercises the OTHER half of the formula the trace-only case above
    // does not reach.
    const kEff = WATER_CAUSTICS_K * WATER_TIER3_CHOP;
    const b = waterCausticsCpu({ j00: 0, j01: 1 / kEff, j10: 1 / kEff, j11: 0 });
    ok(
      'a determinant driven to exactly 0 via the CROSS term is also finite and clamped',
      Number.isFinite(b) && b === WATER_CAUSTICS_MAX
    );
  }
  // MONOTONE THROUGH THE IDENTITY — a brightness curve that oscillated on its
  // way from converging to diverging would read as a bug (a faint DARK ring
  // around every bright caustic line, which real light does not do at this
  // level of approximation). Sweep a small range either side of "flat" —
  // narrow enough to stay on the FIRST branch of `(1+kt)²` each side of its
  // zero, so the only crossing possible is the genuine converging→diverging
  // one — and confirm the sign changes EXACTLY ONCE, not zero times (which
  // would mean the sweep never actually reached both regimes) and not more
  // than once (which would mean it oscillates).
  //
  // ⚠️ THE SWEEP IS DERIVED FROM `kEff`, NOT A FIXED ±0.05 (2026-08-17). It was
  // a hardcoded range, and that quietly encoded an assumption about a DEFAULT:
  // `kEff = WATER_CAUSTICS_K × chop`, so when the author's own tuning raised
  // `chop` 0.4 → 0.86 the same ±0.05 window stopped being "narrow enough to
  // stay on the FIRST branch" — its own stated premise — and the test failed
  // for a reason that had nothing to do with the property it defends. Solving
  // for the branch instead of guessing a number makes it correct at ANY chop:
  // `1 + kEff·t` stays in [0.5, 1.5] across this range by construction, so the
  // determinant cannot change sign and the ONLY crossing available is the real
  // convergent→divergent one at t = 0.
  {
    const kEff = WATER_CAUSTICS_K * WATER_TIER3_CHOP;
    const halfSpan = 0.5 / kEff;
    let signFlips = 0;
    let prevSign = 0;
    for (let t = -halfSpan; t <= halfSpan; t += halfSpan / 10) {
      const b = waterCausticsCpu({ j00: t, j01: 0, j10: 0, j11: t });
      const sign = b > 1e-9 ? 1 : b < -1e-9 ? -1 : 0;
      if (sign !== 0 && prevSign !== 0 && sign !== prevSign) signFlips++;
      if (sign !== 0) prevSign = sign;
    }
    ok(
      'brightness crosses zero EXACTLY ONCE as curvature sweeps convergent→flat→divergent, never oscillating',
      signFlips === 1
    );
  }
  ok(
    'WATER_CAUSTICS_MIN_DET is small — it exists to catch a genuine near-zero determinant, not to suppress ordinary curvature',
    WATER_CAUSTICS_MIN_DET > 0 && WATER_CAUSTICS_MIN_DET < 0.5
  );

  // ══ TIER 4 — CAUSTICS' OWN LOOK CONTROLS (2026-08-27) ════════════════════
  // Live report: the pattern read as blobby soft glows, not the thin filament
  // net real shallow water shows. `sharpness` is the one piece of the new
  // machinery this CPU twin can actually exercise — NETTING and SCALE vary
  // WHICH noise gets sampled, not this det→brightness formula, so they stay
  // GPU/bench-verified only (the same boundary `WATER_SHOAL_STRENGTH`/bank
  // warp already draw in this file — see `waterCausticsCpu`'s own doc).
  ok(
    'sharpness=0 (the CPU-twin default) reproduces the pre-2026-08-27 formula exactly, at rest',
    waterCausticsCpu({ j00: 0, j01: 0, j10: 0, j11: 0, sharpness: 0 }) === 0
  );
  {
    const kEff = WATER_CAUSTICS_K * WATER_TIER3_CHOP;
    const focusing = { j00: -1 / kEff, j01: 0, j10: 0, j11: 0 };
    ok(
      'sharpness=0 still pegs the exact same brightening ceiling as before this round',
      waterCausticsCpu({ ...focusing, sharpness: 0 }) === WATER_CAUSTICS_MAX
    );
    ok(
      'sharpness=1 ALSO pegs the ceiling at the same fully-focused point — sharpening compresses the MIDDLE of the range, not its extreme',
      waterCausticsCpu({ ...focusing, sharpness: 1 }) === WATER_CAUSTICS_MAX
    );
  }
  {
    // A MID-RANGE convergence — bright, but nowhere near the determinant
    // floor — is exactly where sharpening is supposed to bite: real caustics
    // are a small, bright MINORITY of the surface, not a wide "somewhat lit"
    // majority (`WATER_CAUSTICS_K`'s own sweep: 41% soft lift, only 8% "a
    // real caustic").
    const kEff = WATER_CAUSTICS_K * WATER_TIER3_CHOP;
    const midCurvature = { j00: -0.3 / kEff, j01: 0, j10: 0, j11: 0 };
    const unsharpened = waterCausticsCpu({ ...midCurvature, sharpness: 0 });
    const sharpened = waterCausticsCpu({ ...midCurvature, sharpness: 1 });
    ok(
      'a mid-range convergence is genuinely bright before sharpening — the case the blob complaint was actually about',
      unsharpened > 0.05
    );
    ok(
      'sharpening pulls that SAME mid-range convergence toward zero — the soft shoulder collapsing, blob becoming filament',
      sharpened < unsharpened
    );
  }
  ok(
    'sharpness never touches the DARKENING half — that was never the "blobby" complaint',
    waterCausticsCpu({ j00: 0.02, j01: 0, j10: 0, j11: 0.02, sharpness: 0 }) ===
      waterCausticsCpu({ j00: 0.02, j01: 0, j10: 0, j11: 0.02, sharpness: 1 })
  );
  ok(
    'sharpness is monotone: more sharpening never brightens a mid-range patch further',
    (() => {
      const kEff = WATER_CAUSTICS_K * WATER_TIER3_CHOP;
      const midCurvature = { j00: -0.3 / kEff, j01: 0, j10: 0, j11: 0 };
      let prev = waterCausticsCpu({ ...midCurvature, sharpness: 0 });
      for (let s = 0.1; s <= 1; s += 0.1) {
        const cur = waterCausticsCpu({ ...midCurvature, sharpness: s });
        if (cur > prev + 1e-9) return false;
        prev = cur;
      }
      return true;
    })()
  );
  ok(
    'WATER_CAUSTICS_SHARPNESS_EXPONENT_MAX is a genuine curve, not a no-op — greater than 1',
    WATER_CAUSTICS_SHARPNESS_EXPONENT_MAX > 1
  );
  ok(
    'WATER_CAUSTICS_SCALE keeps the caustic net finer than the visible chop by default — the whole point of decoupling the two domains',
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
    'WATER_CAUSTICS_SHARPNESS/_NETTING are valid author-facing 0..1 values, not internal-only leftovers',
    WATER_CAUSTICS_SHARPNESS >= 0 &&
      WATER_CAUSTICS_SHARPNESS <= 1 &&
      WATER_CAUSTICS_NETTING >= 0 &&
      WATER_CAUSTICS_NETTING <= 1
  );
}
