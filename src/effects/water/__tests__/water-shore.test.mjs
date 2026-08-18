/**
 * water-shore.test.mjs — TIER 4's SHORELINE FOAM.
 *
 * ============================================================================
 * ⚠️ THE VERSION OF THIS FILE THAT SHIPPED WITH THE FIRST FOAM WAS A LYING TEST
 * ============================================================================
 * It asserted the foam ridge covered "a MINORITY of the noise channel's own
 * range" by computing `2·width / 2` — i.e. by assuming `mx_fractal_noise_vec3`
 * is UNIFORM over [−1, 1]. It is not: measured on a real GPU, RMS 0.281 and
 * median |x| 0.197, so the shipped ±0.16 band covered **41.6%** of the field,
 * not 16%. The test passed. The author reported *"no sign of additional
 * shoreline foam"* — because 41.6% of a band lit at once is a grey wash, not
 * filaments, and a wash on top of tier 2's foam is invisible.
 *
 * **The lesson, and it is why this file is now shaped the way it is: a test that
 * derives its expectation from an ASSUMED distribution proves nothing about the
 * real one.** `WATER_TIER3_CHOP`'s own docstring names this exact hazard
 * ("CALIBRATED AGAINST AN ASSUMED noise distribution, not derived from the real
 * one") and this test walked into it three screens away. So the constants below
 * are pinned against **measured** values recorded in `docs/planning/
 * Water-Foam.md` §2.6, and every assertion that could only be checked against a
 * live GPU says so out loud instead of inventing a distribution to check against.
 */
import {
  waterFoamReachPx,
  WATER_FOAM_SHORE_FRACTION,
  WATER_FOAM_REACH_MIN_PX,
  WATER_FOAM_REACH_MAX_PX,
  WATER_FOAM_CELL_FRACTION,
  WATER_FOAM_CELL_EDGE0,
  WATER_FOAM_CELL_EDGE1,
  WATER_FOAM_CELL_BITE,
  WATER_SWASH_BANDS,
  WATER_SWASH_SPEED,
  WATER_SWASH_WIDTH,
  WATER_BREAK_REACH_FRACTION,
} from '../water-shore.js';
import { WATER_TIER1_DEPTH_SCALE_PX } from '../water-render.js';

export function run(t) {
  const { ok } = t;

  // ══ THE SCALE RULE — "ponds through ocean shorelines" ═══════════════════
  // The author's stated target range is *"everything from small ponds to
  // rivers, to huge lakes, shorelines and ocean shorelines"*. A foam reach
  // authored in bare world px is tuned on exactly one of those. This is the
  // whole mechanism that makes one setting work across all of them, so it is
  // tested as behaviour rather than trusted as a docstring.
  ok(
    'foam reach is a strict fraction of the body scale, never the whole of it',
    WATER_FOAM_SHORE_FRACTION > 0 && WATER_FOAM_SHORE_FRACTION < 1
  );
  ok(
    'a bigger body gets a proportionally bigger foam band',
    waterFoamReachPx(400) > waterFoamReachPx(200) && waterFoamReachPx(200) > waterFoamReachPx(100)
  );
  ok(
    'the default depthScalePx lands inside the clamped band, not on a rail — the shipped scene gets the real formula',
    waterFoamReachPx(WATER_TIER1_DEPTH_SCALE_PX) > WATER_FOAM_REACH_MIN_PX &&
      waterFoamReachPx(WATER_TIER1_DEPTH_SCALE_PX) < WATER_FOAM_REACH_MAX_PX
  );
  // The clamps exist because foam BUBBLES do not scale with the lake — a 4000px
  // ocean should not get a 1800px band of foam, and a tiny pond should still get
  // a visible rim rather than a 3px hairline.
  ok('a vast body is clamped to a physically sane maximum', waterFoamReachPx(100000) === WATER_FOAM_REACH_MAX_PX);
  ok('a tiny body still gets a visible rim', waterFoamReachPx(1) === WATER_FOAM_REACH_MIN_PX);
  ok(
    'and the min is genuinely below the max (an inverted clamp would pin every body to one size)',
    WATER_FOAM_REACH_MIN_PX < WATER_FOAM_REACH_MAX_PX
  );
  // Degenerate inputs must not produce a zero-width band (foam vanishing
  // entirely) or a NaN reach (which would poison every `d01` downstream).
  ok('a zero body scale still yields the minimum, not zero', waterFoamReachPx(0) === WATER_FOAM_REACH_MIN_PX);
  ok(
    'a non-finite body scale does the same rather than producing NaN',
    waterFoamReachPx(NaN) === WATER_FOAM_REACH_MIN_PX
  );
  ok('a negative body scale cannot invert the band', waterFoamReachPx(-500) === WATER_FOAM_REACH_MIN_PX);

  // ══ THE CELL CUT — pinned to a MEASURED distribution ════════════════════
  // `mx_worley_noise_float(p, 1)` measured on this build's GPU (Water-Foam.md
  // §2.6): p10 0.097, p50 0.298, p90 0.590, max ~1.18. The cut has to sit in the
  // UPPER TAIL to light cell WALLS and leave cell interiors dark — that is the
  // net-with-holes structure real foam has. A cut near the median would light
  // half the field and reproduce the wash this rung already shipped once.
  const WORLEY_MEASURED = { p10: 0.097, p50: 0.298, p90: 0.59, max: 1.18 };
  ok('the cell cut is a real band, not a step', WATER_FOAM_CELL_EDGE0 < WATER_FOAM_CELL_EDGE1);
  ok(
    'the cut sits ABOVE the measured median — cell walls, not half the field',
    WATER_FOAM_CELL_EDGE0 > WORLEY_MEASURED.p50
  );
  ok(
    '...and below the measured p90, so the walls are not so rare the net breaks into disconnected specks',
    WATER_FOAM_CELL_EDGE0 < WORLEY_MEASURED.p90
  );
  ok(
    'the upper edge stays inside the field range, so the brightest walls actually reach full strength',
    WATER_FOAM_CELL_EDGE1 < WORLEY_MEASURED.max
  );
  // THE BITE. At 1 the cell interiors punch clean through to zero and the foam
  // reads as a stencil laid over water; foam should be thick in the walls and
  // THIN — not absent — in the middles.
  ok(
    'the cellular bite never fully erases the foam between cells',
    WATER_FOAM_CELL_BITE > 0 && WATER_FOAM_CELL_BITE < 1
  );
  {
    // Reproduce `lace = (1 − bite) + walls·bite` at both extremes.
    const lace = (walls) => 1 - WATER_FOAM_CELL_BITE + walls * WATER_FOAM_CELL_BITE;
    ok('a full cell wall passes foam at full strength', Math.abs(lace(1) - 1) < 1e-12);
    ok('a cell interior thins the foam but keeps some', lace(0) > 0 && lace(0) < 1);
  }
  ok(
    'foam cells are smaller than the band that contains them — several cells across a band, not one',
    WATER_FOAM_CELL_FRACTION > 0 && WATER_FOAM_CELL_FRACTION < 1
  );

  // ══ SWASH — bands that TRAVEL, and stay bands ═══════════════════════════
  ok('there is more than one swash band, so the shore reads as a sequence of spent waves', WATER_SWASH_BANDS >= 2);
  ok('...but few enough not to read as corduroy', WATER_SWASH_BANDS <= 6);
  ok('the swash travels at a walking pace, not a scroll', WATER_SWASH_SPEED > 0 && WATER_SWASH_SPEED < 1);

  // THE THRESHOLD IS ON `sin`, AND `sin` IS NOT UNIFORM — the same class of
  // mistake this file was built to stop repeating. `sin` spends most of its time
  // near its extremes, so the lit fraction of a cycle is NOT the nominal width;
  // it is `acos(cut)/π` for a cut at `1 − 2·width`. Compute it rather than
  // assuming, and assert the band is genuinely a MINORITY of each cycle.
  {
    const cut = 1 - 2 * WATER_SWASH_WIDTH;
    const litFraction = Math.acos(cut) / Math.PI;
    ok(`the swash cut leaves a real band lit (${(100 * litFraction).toFixed(1)}% of each cycle)`, litFraction > 0.05);
    ok('...and the band is a MINORITY of its cycle — travelling lines, not a filled wash', litFraction < 0.5);
    ok("the cut sits inside sin's own range, so the band can never be empty or always-on", cut > -1 && cut < 1);
  }

  // ══ BREAK FOAM — one-sided by construction ═════════════════════════════
  // The whole point (the author's *"break near obstacles"*) is that foam sits on
  // the face an obstacle presents to the stream and NOT in its lee. The shader
  // computes `max(−dot(flowDir, outward), 0)` then squares it; reproduce that in
  // plain JS and prove the sidedness, because "it is one-sided" is the claim
  // that would be silently wrong if the normal were rotated the wrong way.
  {
    // `outward` points AWAY from the nearest shore, into the water. So a bank on
    // the EAST side of the water has outward = west = (−1, 0) at points near it.
    const breakAt = (flow, outward) => {
      const d = -(flow[0] * outward[0] + flow[1] * outward[1]);
      const facing = Math.max(d, 0);
      return facing * facing;
    };
    const eastFlow = [1, 0];
    const bankToTheEast = [-1, 0]; // outward points west, back into the water
    const bankToTheWest = [1, 0]; // outward points east, back into the water
    ok(
      'a river flowing EAST foams on the bank it is running INTO (the east one)',
      breakAt(eastFlow, bankToTheEast) > 0.9
    );
    ok('...and leaves the bank behind it (the west one) completely clear', breakAt(eastFlow, bankToTheWest) === 0);
    ok(
      'a bank the flow runs parallel to gets no break foam',
      breakAt(eastFlow, [0, 1]) === 0 && breakAt(eastFlow, [0, -1]) === 0
    );
    // The squaring is what tightens foam onto the face genuinely presented to
    // the stream rather than smearing it round the whole obstacle.
    const oblique = breakAt(eastFlow, [-Math.SQRT1_2, Math.SQRT1_2]); // 45° to the flow
    ok('an obliquely-facing bank foams, but distinctly less than a head-on one', oblique > 0 && oblique < 0.6);
    // A still pond has no current, so nothing can be running into anything.
    ok('a still pond (no flow) has no break foam anywhere', breakAt([0, 0], bankToTheEast) === 0);
  }
  ok(
    'break foam hugs the bank tighter than the swash reaches — a collar, not a band',
    WATER_BREAK_REACH_FRACTION > 0 && WATER_BREAK_REACH_FRACTION < 1
  );
}
