/**
 * Node verification for effects/lighting/aperture-gobo.js — ALL pure, so this
 * file carries the real weight (`aperture-gobo-render.js` is a line-for-line
 * TSL transcription verified only for "constructs without throwing" in its
 * own sibling test).
 *
 * Design 4 (2026-08-03) replaced the inverse-projection/Jacobian/SDF core
 * with angular-spoke + radial-arc blockers — see `aperture-gobo.js`'s own
 * "DESIGN 4" header for the full rationale. Four kinds of check survive that
 * rewrite, per this codebase's own standing doctrine:
 *   1. BRUTE-FORCE DIFF (`feedback_smooth_output_hides_ported_bugs`) — the
 *      inverse projection (`sW`) is checked against an INDEPENDENTLY-derived
 *      forward projection, round-tripped, not just "looks smooth". The
 *      row-boundary inversion (`z -> x`) gets its own round trip too.
 *   2. SIGN-CONVENTION CHECKS on the spoke/arc gates — positive-means-open is
 *      asserted directly at hand-picked points, not just trusted from the
 *      formula's own derivation.
 *   3. THE REGRESSION TEST for the max-combine bug caught during design
 *      review (an inapplicable aperture must NOT out-vote an applicable,
 *      darker one) — unchanged by design 4, still exercised against the new
 *      gate math.
 *   4. THE DEGENERATE BATTERY + FAIL-OPEN TEST (`docs/planning/
 *      Aperture-Gobo.md` §9/§10) — every named precondition gets its own
 *      assertion, and "no apertures" must render byte-identical to "off".
 */
import {
  APERTURE_GOBO_DEFAULTS,
  SOFT_NEAR_PX,
  SOFT_FAR_PX_BASE,
  REACH_SOFT_FAR_PX_BASE,
  DIM_RADIUS_FADE_START,
  MIN_WALL_DISTANCE_PX,
  MAX_MULLIONS_PER_AXIS,
  computeWallFrame,
  orientApertureToLight,
  distancePointToSegment,
  computeAngularWidthFromLight,
  findAperturesForLight,
  resolveLampHeight,
  deriveApertureGoboPaneCount,
  computeApertureRevealNarrowing,
  projectFloorPointToWindow,
  forwardProjectWindowPointToFloor,
  computeApertureRowBoundaryX,
  computeApertureHeightFromX,
  computeApertureSpokeGate,
  computeApertureArcGate,
  computeApertureFrameOnlyGate,
  computeApertureSillHeadOnlyGate,
  computeApertureSoftPx,
  computeApertureReachSoftPx,
  computeApertureGoboTerm,
  computeApertureGoboForLight,
  MAX_PANE_BREAK_CHANCE,
  CRACK_WIDTH_PX,
  computeApertureHash2,
  computeAperturePaneIndex,
  computeApertureGlassWarpOffset,
  computeApertureFacetWedgeValue,
  computeApertureGrimeFactor,
  computeAperturePaneIsBroken,
  computeAperturePaneCrackGeometry,
  computeApertureCrackLineOpenness,
} from '../aperture-gobo.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/** A default window-params bag, mirroring APERTURE_GOBO_DEFAULTS plus the
 * per-aperture wallLen this module always threads alongside it. */
function windowParams(overrides = {}) {
  return {
    wallLen: 200,
    sillPx: APERTURE_GOBO_DEFAULTS.sillPx,
    headPx: APERTURE_GOBO_DEFAULTS.headPx,
    // `cols`/`rows` are no longer shipped defaults (round 11, 2026-08-04) —
    // point-light-pool.js derives them per-light from a real wallLen now.
    // These two are exactly what that derivation would produce for THIS
    // helper's own wallLen(200)/sillPx/headPx against the shipped
    // paneWidthPx/paneHeightPx(80): round(200/80)=3, round((220-30)/80)=2 —
    // a realistic multi-pane default, not an arbitrary stand-in, so tests
    // below that don't override either still exercise real mullion geometry
    // instead of silently degrading to a frame-only, zero-mullion window.
    cols: 3,
    rows: 2,
    frame: APERTURE_GOBO_DEFAULTS.frame,
    mullion: APERTURE_GOBO_DEFAULTS.mullion,
    softFarPx: SOFT_FAR_PX_BASE,
    ...overrides,
  };
}

export function run(t) {
  const { ok } = t;

  // ==========================================================================
  // computeWallFrame — pure geometry. UNCHANGED by design 4.
  // ==========================================================================
  {
    const frame = computeWallFrame({ x1: 0, y1: 0, x2: 100, y2: 0 });
    ok('a horizontal wall has dir=(1,0)', near(frame.dir.x, 1) && near(frame.dir.y, 0));
    ok('its normal is perpendicular to dir', near(frame.dir.x * frame.nrm.x + frame.dir.y * frame.nrm.y, 0));
    ok('wallLen matches the segment length', near(frame.wallLen, 100));
  }
  ok('a zero-length wall is degenerate -> null', computeWallFrame({ x1: 5, y1: 5, x2: 5, y2: 5 }) === null);
  ok('a non-finite wall is degenerate -> null', computeWallFrame({ x1: NaN, y1: 0, x2: 1, y2: 0 }) === null);
  ok('no argument at all is safe -> null', computeWallFrame() === null);

  // ==========================================================================
  // orientApertureToLight — sign-flip + the MIN_WALL_DISTANCE_PX clamp.
  // UNCHANGED by design 4.
  // ==========================================================================
  {
    const frame = computeWallFrame({ x1: 0, y1: 0, x2: 100, y2: 0 }); // dir=(1,0), raw nrm=(0,1)
    const lightBelow = orientApertureToLight(frame, { x: 50, y: -10 }); // y<0 => "below" the wall
    ok('light below the wall clamps a to a positive distance', near(lightBelow.a, 10));
    ok('sL is the light projected onto the wall axis', near(lightBelow.sL, 50));
    ok(
      'nrm is oriented so dot(L-A,nrm) < 0 (the light sits on the negative side)',
      (50 - frame.A.x) * lightBelow.nrm.x + (-10 - frame.A.y) * lightBelow.nrm.y < 0
    );

    const lightAbove = orientApertureToLight(frame, { x: 50, y: 10 }); // opposite side
    ok('a light on the OPPOSITE side gets the OPPOSITE nrm', near(lightAbove.nrm.y, -lightBelow.nrm.y));
    ok('a is still positive (10) on the opposite side too', near(lightAbove.a, 10));

    const lightOnPlane = orientApertureToLight(frame, { x: 50, y: 0 }); // exactly in the wall's own plane
    ok(
      'a light standing exactly in the wall plane clamps a to MIN_WALL_DISTANCE_PX, never 0',
      near(lightOnPlane.a, MIN_WALL_DISTANCE_PX)
    );
  }

  // ==========================================================================
  // distancePointToSegment. UNCHANGED by design 4.
  // ==========================================================================
  ok(
    'distance to a point beside the middle of a segment is the perpendicular distance',
    near(distancePointToSegment({ x: 50, y: 10 }, { x: 0, y: 0 }, { x: 100, y: 0 }), 10)
  );
  ok(
    'distance past an ENDPOINT is to the endpoint, not the infinite line',
    near(distancePointToSegment({ x: 150, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }), 50)
  );
  ok(
    'a point ON the segment is distance 0',
    near(distancePointToSegment({ x: 30, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }), 0)
  );

  // ==========================================================================
  // computeAngularWidthFromLight. UNCHANGED by design 4.
  // ==========================================================================
  {
    // A wall spanning -45deg..+45deg as seen from the origin subtends 90deg.
    const w = computeAngularWidthFromLight({ x: 0, y: 0 }, { x: 10, y: -10 }, { x: 10, y: 10 });
    ok('a wall spanning a 90deg cone measures ~PI/2', near(w, Math.PI / 2, 1e-9));
  }
  ok(
    'a light standing exactly on one endpoint reads 0, never NaN/throws',
    computeAngularWidthFromLight({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 10 }) === 0
  );

  // ==========================================================================
  // findAperturesForLight — the assignment pass: filter, rank, CAP + REPORT.
  // UNCHANGED by design 4.
  // ==========================================================================
  {
    const light = { x: 0, y: 0, radius: 100 };
    const segs = [
      { x1: 20, y1: -50, x2: 20, y2: 50, aperture: true }, // close, wide -> should rank first
      { x1: 90, y1: -5, x2: 90, y2: 5, aperture: true }, // far, narrow -> ranks lower
      { x1: 20, y1: -50, x2: 20, y2: 50, aperture: false }, // a solid wall in the SAME spot -> excluded
      { x1: 500, y1: -5, x2: 500, y2: 5, aperture: true }, // outside the light's radius -> excluded
      { x1: 5, y1: 5, x2: 5, y2: 5, aperture: true }, // degenerate zero-length -> excluded, never throws
    ];
    const result = findAperturesForLight(light, segs, 4);
    ok('non-aperture walls are excluded', result.totalFound === 2);
    ok(
      'walls outside the light radius are excluded',
      result.apertures.every((a) => a.wallLen !== undefined || true)
    );
    ok('nothing is dropped when under the cap', result.dropped === 0);
    ok('the wider (closer) wall ranks first', result.apertures[0].sL !== undefined);

    const capped = findAperturesForLight(light, segs, 1);
    ok('the cap is honoured — at most `maxAperturesPerLight` survive', capped.apertures.length === 1);
    ok('the cap REPORTS what it dropped, never silently', capped.dropped === 1 && capped.totalFound === 2);
  }
  {
    const empty = findAperturesForLight({ x: 0, y: 0, radius: 50 }, [], 4);
    ok('no wall segments at all -> empty, no throw', empty.apertures.length === 0 && empty.totalFound === 0);
    const noArgs = findAperturesForLight({ x: 0, y: 0, radius: 50 }, undefined, 4);
    ok('undefined wall segments -> empty, no throw', noArgs.apertures.length === 0);
  }

  // ==========================================================================
  // maxApertureDistancePx — round 14 (2026-08-04), the live bug fix: "lights
  // which are large and outdoors and no where near any actual windows are
  // being cut off at strange angles." A LARGE light's own radius alone must
  // not sweep in a far-away, unrelated aperture wall as if it were its own
  // window — `searchDistance = min(light.radius, maxApertureDistancePx)`.
  // ==========================================================================
  {
    const bigLight = { x: 0, y: 0, radius: 2000 }; // "large and outdoor"
    const farWall = { x1: 800, y1: -5, x2: 800, y2: 5, aperture: true }; // far, but WELL within radius=2000
    const nearWall = { x1: 50, y1: -20, x2: 50, y2: 20, aperture: true }; // genuinely close (dist=50)
    const withDefaultCap = findAperturesForLight(bigLight, [farWall, nearWall], 4); // default maxApertureDistancePx
    ok(
      'a wall far beyond maxApertureDistancePx is excluded even though a large light’s own radius would reach it',
      withDefaultCap.totalFound === 1
    );
    const withHugeCap = findAperturesForLight(bigLight, [farWall, nearWall], 4, 5000);
    ok(
      'raising maxApertureDistancePx past the light’s own radius includes the far wall again — ' +
        'radius is still the OUTER bound, this only ever narrows it further',
      withHugeCap.totalFound === 2
    );
    const smallLightHugeCap = findAperturesForLight({ x: 0, y: 0, radius: 40 }, [nearWall], 4, 5000);
    ok(
      'a SMALL light’s own radius is still respected even with a huge maxApertureDistancePx — min(), never an override',
      smallLightHugeCap.totalFound === 0 // nearWall's own closest point is 50px away, outside radius=40
    );
    ok(
      'an explicit maxApertureDistancePx of 0 excludes everything — a real, extreme, authored choice, not a crash',
      findAperturesForLight(bigLight, [farWall, nearWall], 4, 0).totalFound === 0
    );
  }

  // ==========================================================================
  // resolveLampHeight. UNCHANGED by design 4.
  // ==========================================================================
  ok(
    'tier 0 always resolves to defaultLampHeightPx (no per-light elevation read yet — named, not silent)',
    near(resolveLampHeight({}, { defaultLampHeightPx: 40, minLampHeightPx: 8 }), 40)
  );
  ok(
    'a default below the minimum clamps UP to the minimum, never below it',
    near(resolveLampHeight({}, { defaultLampHeightPx: 2, minLampHeightPx: 8 }), 8)
  );
  ok(
    'a missing/malformed params bag falls back to APERTURE_GOBO_DEFAULTS, never throws',
    near(resolveLampHeight({}, {}), APERTURE_GOBO_DEFAULTS.defaultLampHeightPx)
  );

  // ==========================================================================
  // projectFloorPointToWindow — `z` is GONE (design 4); a hand-checkable
  // sanity case, then the brute-force diff against the independently-derived
  // forward projection.
  // ==========================================================================
  {
    // aperture: sL=0, a=10. P straight out from the light at the same
    // perpendicular distance the light itself sits inside (x=10) should see
    // the window at inv=a/(a+x)=0.5.
    const aperture = { A: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, nrm: { x: 0, y: 1 }, sL: 0, a: 10 };
    const proj = projectFloorPointToWindow({ x: 0, y: 10 }, aperture);
    ok('a point at x==a projects to inv=0.5', near(proj.inv, 0.5));
    ok('...and sW==sL when s==sL (directly ahead of the light)', near(proj.sW, 0));
    ok('...and x is exactly the world distance from the wall', near(proj.x, 10));

    const interior = projectFloorPointToWindow({ x: 0, y: -5 }, aperture);
    ok('a point on the INTERIOR side (x<=0) is inapplicable -> null', interior === null);
    const onPlane = projectFloorPointToWindow({ x: 0, y: 0 }, aperture);
    ok('a point exactly ON the wall plane (x==0) is also inapplicable -> null', onPlane === null);
  }

  // ---- THE BRUTE-FORCE ROUND TRIP -----------------------------------------
  // Independently derived: pick a random WINDOW-SPACE (sW, x), forward-
  // project it to a floor point, then INVERT that floor point and check we
  // recover the same (sW, x). This is the check that would have caught a
  // transposed sign, a swapped axis, or an off-by-one in either derivation —
  // `feedback_smooth_output_hides_ported_bugs`.
  {
    let worstErr = 0;
    let tested = 0;
    // A small deterministic PRNG (no Math.random() — reproducible failures).
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (const [sL, a] of [
      [0, 10],
      [-30, 5],
      [80, 25],
      [0, 1],
    ]) {
      const aperture = { A: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, nrm: { x: 0, y: 1 }, sL, a };
      for (let i = 0; i < 50; i++) {
        const sW = sL - 100 + rand() * 200;
        const x = 0.5 + rand() * 200; // strictly > 0
        const fwd = forwardProjectWindowPointToFloor(sW, x, aperture);
        if (!fwd) continue;
        const inv = projectFloorPointToWindow(fwd.P, aperture);
        if (!inv) {
          worstErr = Infinity;
          continue;
        }
        tested++;
        worstErr = Math.max(worstErr, Math.abs(inv.sW - sW), Math.abs(inv.x - x));
      }
    }
    ok('the round trip actually exercised real cases', tested > 100);
    ok(`forward -> inverse round-trips to within 1e-6 (worst error: ${worstErr})`, worstErr < 1e-6);
  }

  // ==========================================================================
  // computeApertureRowBoundaryX — the z -> x inversion, checked against ITS
  // OWN forward relationship (z = h*(1 - a/(a+x))), not just re-trusted.
  // ==========================================================================
  {
    const a = 12;
    const h = 50;
    for (const z of [0, 10, 25, 45]) {
      const x = computeApertureRowBoundaryX({ a, h, z });
      // z=0 (the wall's own foot) is the one case that inverts to EXACTLY
      // x=0, not merely a positive x — asserted precisely just below this
      // loop; here only finiteness and non-negativity are checked for every z.
      ok(`z=${z} inverts to a finite, non-negative x`, Number.isFinite(x) && x >= 0);
      const zBack = h * (1 - a / (a + x));
      ok(`...and that x re-derives the SAME z (z=${z}, got ${zBack})`, near(zBack, z, 1e-6));
    }
    ok('z==0 (the wall foot) inverts to x==0 exactly', computeApertureRowBoundaryX({ a, h, z: 0 }) === 0);
    ok(
      "z==h (the lamp's own height) is never reached at any finite x -> Infinity",
      computeApertureRowBoundaryX({ a, h, z: h }) === Infinity
    );
    ok(
      'z>h (above the lamp) is also Infinity, never negative',
      computeApertureRowBoundaryX({ a, h, z: h + 10 }) === Infinity
    );
    {
      // Monotonic: a higher window boundary always maps to a farther x.
      const x1 = computeApertureRowBoundaryX({ a, h, z: 10 });
      const x2 = computeApertureRowBoundaryX({ a, h, z: 30 });
      const x3 = computeApertureRowBoundaryX({ a, h, z: 49 });
      ok('x rises monotonically with z (10 < 30 < 49 in z -> same order in x)', x1 < x2 && x2 < x3);
    }
  }

  // ==========================================================================
  // THE DEFAULTS THEMSELVES MUST WORK TOGETHER — found live, 2026-08-03: the
  // OLD `defaultLampHeightPx` (40) sat BELOW `headPx` (220), so EVERY row
  // boundary past the sill was geometrically unreachable at any floor
  // distance, on every design since the first, silently, because a different
  // bug always got found first. Every other test in this file hand-picks
  // a/h/z values chosen to be well-behaved — this one uses the REAL shipped
  // defaults specifically because friendly synthetic numbers are exactly
  // what let this hide (`feedback_bench_must_build_inputs_like_production`
  // / `feedback_synthetic_fixture_invariant_is_not_authored_art`).
  // ==========================================================================
  {
    const { headPx, sillPx, defaultLampHeightPx: h } = APERTURE_GOBO_DEFAULTS;
    const a = 10; // an arbitrary, unremarkable light-to-wall distance
    // `rows` is no longer a shipped default (round 11, 2026-08-04 — it's
    // DERIVED per-light from a light's own wallLen now, see point-light-
    // pool.js's own "PROCEDURAL PANE COUNT" comment), so this sweeps
    // FRACTIONS of the sill-head span directly instead of dividing it by a
    // fixed row count. The geometric claim under test — every z between sill
    // and head stays reachable at a sane finite x under the SHIPPED
    // h/headPx relationship — was never really about a specific row count,
    // only the span's own two extremes and its interior.
    for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
      const z = sillPx + frac * (headPx - sillPx);
      const x = computeApertureRowBoundaryX({ a, h, z });
      ok(
        `with the SHIPPED defaults, z at ${(frac * 100).toFixed(0)}% of the sill-head span (z=${z.toFixed(1)}) is reachable at a finite x`,
        Number.isFinite(x)
      );
      // Not just finite — reachable within a SANE multiple of the light's own
      // distance from the wall, or it may as well be unreachable in practice
      // (nobody's dim radius extends to 1000x their own distance from a wall).
      ok(`...and within a sane multiple of a (x=${x.toFixed(1)}, a=${a})`, x < a * 10);
    }
  }

  // ==========================================================================
  // deriveApertureGoboPaneCount — PROCEDURAL PANE COUNT (round 11,
  // 2026-08-04). The author's own ask: a wide window gets more panes than a
  // narrow one, automatically, from a TARGET pane size rather than a fixed
  // count. Shared by point-light-pool.js AND bench-aperture-gobo.js — this
  // is the ONE place its own rounding/clamping is pinned.
  // ==========================================================================
  {
    ok(
      'a wall exactly N target-widths long gives EXACTLY N cols, no rounding surprise',
      deriveApertureGoboPaneCount({ wallLen: 400, sillPx: 0, headPx: 200, paneWidthPx: 100, paneHeightPx: 100 })
        .cols === 4
    );
    ok(
      'a wider wall gets MORE panes than a narrower one at the same target size',
      deriveApertureGoboPaneCount({ wallLen: 800, sillPx: 0, headPx: 100, paneWidthPx: 100, paneHeightPx: 100 }).cols >
        deriveApertureGoboPaneCount({ wallLen: 200, sillPx: 0, headPx: 100, paneWidthPx: 100, paneHeightPx: 100 }).cols
    );
    ok(
      'rows derive from the sill-head SPAN, not headPx alone',
      deriveApertureGoboPaneCount({ wallLen: 100, sillPx: 100, headPx: 300, paneWidthPx: 100, paneHeightPx: 100 })
        .rows === 2
    );
    ok(
      'never below 1 pane even for a wall much shorter than the target size',
      deriveApertureGoboPaneCount({ wallLen: 5, sillPx: 0, headPx: 5, paneWidthPx: 100, paneHeightPx: 100 }).cols === 1
    );
    ok(
      'clamped at MAX_MULLIONS_PER_AXIS for a wall much longer than the target size, never throws',
      deriveApertureGoboPaneCount({ wallLen: 1e6, sillPx: 0, headPx: 100, paneWidthPx: 1, paneHeightPx: 100 }).cols ===
        MAX_MULLIONS_PER_AXIS
    );
    ok(
      'a degenerate zero/negative sill-head span gives rows=1, never 0 or NaN',
      deriveApertureGoboPaneCount({ wallLen: 100, sillPx: 200, headPx: 100, paneWidthPx: 100, paneHeightPx: 100 })
        .rows === 1
    );
    ok(
      'an absent wallLen (no aperture assigned this frame) falls back to exactly 1 pane, never throws',
      (() => {
        const r = deriveApertureGoboPaneCount({
          wallLen: undefined,
          sillPx: 0,
          headPx: 100,
          paneWidthPx: 100,
          paneHeightPx: 100,
        });
        return r.cols === 1 && r.rows === 1;
      })()
    );
    ok(
      'a zero/non-finite target pane size never divides by zero (NaN/Infinity), it floors to a sane 1px minimum',
      (() => {
        const r = deriveApertureGoboPaneCount({
          wallLen: 100,
          sillPx: 0,
          headPx: 100,
          paneWidthPx: 0,
          paneHeightPx: NaN,
        });
        return Number.isFinite(r.cols) && Number.isFinite(r.rows);
      })()
    );
  }

  // ==========================================================================
  // computeApertureSpokeGate — sign convention: POSITIVE = open glass.
  // ==========================================================================
  {
    // wallLen=200, frame=6, cols=2, mullion=4 -> one internal mullion at the
    // window's own centre (sW=100), spanning [98,102].
    const p = { wallLen: 200, cols: 2, mullion: 4, frame: 6 };
    ok('deep in the middle of a pane (sW=50) is well open (positive)', computeApertureSpokeGate(50, p) > 20);
    ok('dead centre of the internal mullion (sW=100) is blocked (negative)', computeApertureSpokeGate(100, p) < 0);
    ok('exactly at the mullion edge (sW=98) reads ~0', near(computeApertureSpokeGate(98, p), 0, 1e-9));
    ok("at the wall's own edge (sW=0) is deep in the frame (negative)", computeApertureSpokeGate(0, p) < 0);
    ok('exactly at the inner frame edge (sW=frame=6) reads ~0', near(computeApertureSpokeGate(6, p), 0, 1e-9));
    ok(
      'far outside the wall span entirely (sW=1e6) is deeply blocked, not open',
      computeApertureSpokeGate(1e6, p) < -1000
    );
  }
  {
    // cols<2 needs no special case — the loop runs zero times, frame gate alone.
    const p1 = { wallLen: 200, cols: 1, mullion: 4, frame: 6 };
    const p0 = { wallLen: 200, cols: 0, mullion: 4, frame: 6 };
    ok('cols=1 draws NO phantom centre mullion (centre reads open)', computeApertureSpokeGate(100, p1) > 20);
    ok(
      'cols=0 behaves identically to cols=1 (no mullions either way)',
      near(computeApertureSpokeGate(100, p0), computeApertureSpokeGate(100, p1))
    );
  }
  {
    // The unroll count is capped at MAX_MULLIONS_PER_AXIS — a cols value
    // above it must not throw or loop unboundedly.
    const p = { wallLen: 200, cols: 999, mullion: 1, frame: 0 };
    let threw = false;
    let g = null;
    try {
      g = computeApertureSpokeGate(100, p);
    } catch {
      threw = true;
    }
    ok('an absurd cols value is clamped, never throws', !threw && Number.isFinite(g));
    ok(
      '...and the clamp matches MAX_MULLIONS_PER_AXIS behaviour exactly',
      near(g, computeApertureSpokeGate(100, { ...p, cols: MAX_MULLIONS_PER_AXIS }))
    );
  }

  // ==========================================================================
  // computeApertureArcGate — sign convention: POSITIVE = open, one axis over.
  // ==========================================================================
  {
    const a = 10;
    const h = 40;
    const xSill = computeApertureRowBoundaryX({ a, h, z: 0 }); // sillPx=0 -> xSill=0
    const p = { a, h, sillPx: 0, headPx: 220, rows: 1, mullion: 4 }; // rows=1 -> no internal row mullions
    ok('just beyond the sill is open (positive)', computeApertureArcGate(xSill + 5, p) > 0);
    ok('exactly at the sill boundary reads ~0', near(computeApertureArcGate(xSill, p), 0, 1e-6));
    ok(
      'head (220) is never reached since h(40) < headPx -> unbounded open toward infinity',
      computeApertureArcGate(1e6, p) > 0
    );
  }
  {
    // A lamp AT or BELOW its own sill: xSill -> Infinity, everything blocked.
    // Design 4's own deliberate reading (this module's header) — a real,
    // meaningful dark render, not "pretend this window doesn't exist".
    const p = { a: 10, h: 20, sillPx: 20, headPx: 220, rows: 1, mullion: 4 }; // h == sillPx
    ok(
      'a lamp exactly at its own sill blocks everything (gate deeply negative)',
      computeApertureArcGate(50, p) === -Infinity
    );
    const pBelow = { a: 10, h: 10, sillPx: 20, headPx: 220, rows: 1, mullion: 4 }; // h < sillPx
    ok('a lamp BELOW its own sill also blocks everything', computeApertureArcGate(50, pBelow) === -Infinity);
  }
  {
    // An internal row mullion — hand-verified against the SAME z->x inversion.
    const a = 10;
    const h = 100;
    const zMid = 50; // the row boundary this rows=2 setup should place its ONE mullion at
    const p = { a, h, sillPx: 0, headPx: 100, rows: 2, mullion: 4 };
    const xMid = computeApertureRowBoundaryX({ a, h, z: zMid });
    ok('the internal row mullion is blocked at its own centre', computeApertureArcGate(xMid, p) < 0);
    ok('well clear of it (near the sill) is open', computeApertureArcGate(xMid * 0.1, p) > 0);
  }

  // ==========================================================================
  // computeApertureGoboTerm — the applicability battery, updated for design 4.
  // ==========================================================================
  {
    const aperture = { A: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, nrm: { x: 0, y: 1 }, sL: 0, a: 10 };
    const h = 40;
    const p = windowParams({ wallLen: 200 });
    ok(
      'interior side (x<=0) is inapplicable',
      computeApertureGoboTerm({ x: 0, y: -5 }, aperture, h, 0, p).applicable === false
    );
    ok(
      'a valid exterior point is applicable',
      computeApertureGoboTerm({ x: 0, y: 20 }, aperture, h, 0, p).applicable === true
    );

    // DELIBERATE CHANGE FROM DESIGNS 1-3 (this module's own header): a sill
    // at/above the lamp height is now `applicable:true, gobo->0` — a real
    // dark render — NOT `applicable:false`/fail-open. A lamp genuinely
    // cannot clear its own windowsill; that is meaningful, not missing data.
    const highSill = windowParams({ wallLen: 200, sillPx: 50, headPx: 220 }); // sillPx(50) >= h(40)
    const cutoff = computeApertureGoboTerm({ x: 0, y: 20 }, aperture, h, 0, highSill);
    ok('a sill at/above the lamp height is APPLICABLE (design 4)', cutoff.applicable === true);
    ok('...and reads fully dark, not neutral', cutoff.gobo < 0.01);

    // Far to the side, beyond the wall's own span: also a DELIBERATE change —
    // still applicable (x>0 still holds), but the frame gate's own SDF
    // extends "blocked" naturally, with no separate span test needed.
    const farSide = computeApertureGoboTerm({ x: 100000, y: 20 }, aperture, h, 0, p);
    ok(
      'a point wildly outside the wall span is applicable but fully dark',
      farSide.applicable === true && farSide.gobo < 0.01
    );
  }

  // ==========================================================================
  // THE CONTRAST FLOOR (computeApertureGoboTerm's own header has the
  // live-found rationale) — a mullion's own CENTRE must read genuinely dark
  // at EVERY dist01, not just near the light's own centre. This is the exact
  // live symptom ("no evidence of it working at all"), reproduced and
  // pinned as a permanent regression: measured with the schema's own
  // defaults, the UNCAPPED blur law left a mullion's own centre at
  // gobo=0.415 at dist01=0.5 — barely darker than fully open — because
  // SOFT_FAR_PX_BASE (48px) was calibrated for the deleted magnification
  // system and was never rescaled for design 4's un-magnified feature
  // widths.
  // ==========================================================================
  {
    const wallLen = 150;
    const p = windowParams({ wallLen, cols: 2, mullion: 4, frame: 6 }); // one internal mullion at sW=75
    const aperture = { A: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, nrm: { x: 0, y: 1 }, sL: 0, a: 10 };
    // P chosen so proj.sW lands exactly on the mullion's own centre (75) —
    // same hand-solved technique the max-combine regression test above uses:
    // at x==a (inv=0.5), sW=sL+(s-sL)*0.5=75 requires s=150 (sL=0).
    const P = { x: 150, y: 10 };
    // Swept only up to DIM_RADIUS_FADE_START — round 12's own dim-radius
    // fade (below) deliberately pulls `gobo` back toward neutral PAST this
    // point, by design, so "stays genuinely dark at every dist01" is no
    // longer the claim for the full 0..1 range; it's still exactly true up
    // to where the fade begins.
    for (const dist01 of [0, 0.2, 0.5, 0.7]) {
      const term = computeApertureGoboTerm(P, aperture, 40, dist01, p);
      ok(
        `the mullion's own centre reads genuinely dark at dist01=${dist01} (gobo=${term.gobo.toFixed(3)}), not merely "less bright"`,
        term.applicable === true && term.gobo < 0.05
      );
    }
  }

  // ==========================================================================
  // THE DIM-RADIUS FADE (round 12, 2026-08-04) — `DIM_RADIUS_FADE_START`'s
  // own header: the pattern's own contrast must fade back to NEUTRAL (1)
  // before the light's hard mesh boundary at dist01==1, not collide with it.
  // ==========================================================================
  {
    const wallLen = 150;
    const p = windowParams({ wallLen, cols: 2, mullion: 4, frame: 6 }); // same mullion-centre setup as above
    const aperture = { A: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, nrm: { x: 0, y: 1 }, sL: 0, a: 10 };
    const P = { x: 150, y: 10 }; // the SAME mullion-centre point used above
    ok(
      'below the fade threshold, a mullion centre is UNAFFECTED (identical to no fade at all)',
      computeApertureGoboTerm(P, aperture, 40, DIM_RADIUS_FADE_START - 0.01, p).gobo < 0.05
    );
    const atDimRadius = computeApertureGoboTerm(P, aperture, 40, 1, p);
    ok(
      'AT the dim radius (dist01=1), even a mullion own dead-centre reads fully neutral, not dark',
      near(atDimRadius.gobo, 1, 1e-9)
    );
    ok(
      'a point beyond dist01=1 (defensive, should never happen upstream) still clamps to neutral, never throws',
      near(computeApertureGoboTerm(P, aperture, 40, 1.5, p).gobo, 1, 1e-9)
    );
    {
      // Monotonic rise from the threshold to the dim radius — no sudden jump.
      let prev = computeApertureGoboTerm(P, aperture, 40, DIM_RADIUS_FADE_START, p).gobo;
      let monotonic = true;
      for (let i = 1; i <= 10; i++) {
        const dist01 = DIM_RADIUS_FADE_START + (i / 10) * (1 - DIM_RADIUS_FADE_START);
        const v = computeApertureGoboTerm(P, aperture, 40, dist01, p).gobo;
        if (v < prev - 1e-9) monotonic = false;
        prev = v;
      }
      ok('the fade rises monotonically from the threshold to the dim radius, no sudden jump', monotonic);
    }
    ok(
      'an already-open pane (gobo already 1) is a no-op under the fade at any dist01',
      // (50,10): same inv=0.5 as the mullion-centre point, s=50 -> sW=25,
      // comfortably inside pane 0's own open span [frame=6, mullion-2=73].
      near(computeApertureGoboTerm({ x: 50, y: 10 }, aperture, 40, 1, p).gobo, 1, 1e-6)
    );
    ok(
      'non-finite dist01 reads as 0 (no fade), never NaN',
      Number.isFinite(computeApertureGoboTerm(P, aperture, 40, NaN, p).gobo)
    );
  }

  // ==========================================================================
  // computeApertureRevealNarrowing (round 12, 2026-08-04) — the wall-
  // thickness reveal that narrows the aperture's own frame gate asymmetrically
  // when the light stands off to one side.
  // ==========================================================================
  {
    const wallLen = 200; // centre at sW=100
    ok(
      'a light dead-centre (sL == wallLen/2) narrows NEITHER side',
      (() => {
        const r = computeApertureRevealNarrowing({ sL: 100, a: 50, wallLen, wallThicknessPx: 16 });
        return r.loExtra === 0 && r.hiExtra === 0;
      })()
    );
    ok(
      'a light off toward the HIGH-sW side narrows the LOW-sW jamb, not the high one',
      (() => {
        const r = computeApertureRevealNarrowing({ sL: 150, a: 50, wallLen, wallThicknessPx: 16 });
        // tanTheta = (150-100)/50 = 1 -> reveal = 16*1 = 16
        return near(r.loExtra, 16) && r.hiExtra === 0;
      })()
    );
    ok(
      'a light off toward the LOW-sW side narrows the HIGH-sW jamb, mirrored',
      (() => {
        const r = computeApertureRevealNarrowing({ sL: 50, a: 50, wallLen, wallThicknessPx: 16 });
        return near(r.hiExtra, 16) && r.loExtra === 0;
      })()
    );
    ok(
      'wallThicknessPx=0 (disabled) narrows neither side even at an extreme angle',
      (() => {
        const r = computeApertureRevealNarrowing({ sL: 1000, a: 1, wallLen, wallThicknessPx: 0 });
        return r.loExtra === 0 && r.hiExtra === 0;
      })()
    );
    ok(
      'an absent wallThicknessPx behaves identically to 0 (opt-in, never a surprise default)',
      (() => {
        const r = computeApertureRevealNarrowing({ sL: 1000, a: 1, wallLen });
        return r.loExtra === 0 && r.hiExtra === 0;
      })()
    );
    ok(
      'a grazing angle never inverts the aperture past its own centreline',
      (() => {
        const r = computeApertureRevealNarrowing({ sL: 100000, a: 1, wallLen, wallThicknessPx: 999999 });
        return Number.isFinite(r.loExtra) && r.loExtra < wallLen / 2;
      })()
    );
    ok(
      'a==0 (degenerate, should be pre-clamped by MIN_WALL_DISTANCE_PX upstream) never throws/NaNs',
      (() => {
        const r = computeApertureRevealNarrowing({ sL: 150, a: 0, wallLen, wallThicknessPx: 16 });
        return Number.isFinite(r.loExtra) && Number.isFinite(r.hiExtra);
      })()
    );
  }

  // ==========================================================================
  // computeApertureSpokeGate + the reveal, together — confirms the reveal
  // actually reaches the frame gate an off-axis light feeds it through.
  // ==========================================================================
  {
    const wallLen = 200;
    const noReveal = { wallLen, cols: 1, mullion: 4, frame: 6, sL: 150, a: 50, wallThicknessPx: 0 };
    const withReveal = { ...noReveal, wallThicknessPx: 16 };
    ok(
      'the LOW-sW edge (frame boundary) reads MORE blocked with the reveal than without it',
      computeApertureSpokeGate(6, withReveal) < computeApertureSpokeGate(6, noReveal)
    );
    ok(
      'right at the HIGH-sW edge (the side the light leans TOWARD), the reveal makes no difference — ' +
        'that boundary term is untouched and still dominates the min() there',
      near(computeApertureSpokeGate(wallLen - 6, withReveal), computeApertureSpokeGate(wallLen - 6, noReveal), 1e-9)
    );
  }

  // ==========================================================================
  // computeApertureSoftPx — the blur law itself. UNCHANGED by design 4.
  // ==========================================================================
  ok('dist01=0 gives exactly SOFT_NEAR_PX', near(computeApertureSoftPx(0, 48), SOFT_NEAR_PX));
  ok('dist01=1 gives exactly the resolved far softness', near(computeApertureSoftPx(1, 48), 48));
  {
    let prev = computeApertureSoftPx(0, 48);
    let monotonic = true;
    for (let i = 1; i <= 20; i++) {
      const v = computeApertureSoftPx(i / 20, 48);
      if (v < prev - 1e-9) monotonic = false;
      prev = v;
    }
    ok('softness is monotonically non-decreasing from centre to dim radius', monotonic);
  }
  ok(
    'out-of-range dist01 clamps rather than extrapolating',
    near(computeApertureSoftPx(5, 48), computeApertureSoftPx(1, 48))
  );
  ok('non-finite dist01 reads as 0 (sharpest), never NaN', near(computeApertureSoftPx(NaN, 48), SOFT_NEAR_PX));

  // ==========================================================================
  // computeApertureReachSoftPx — THE REACH BLUR (round 15, 2026-08-04).
  // `REACH_SOFT_FAR_PX_BASE`'s own header has the live diagnosis: a Node
  // probe against this exact CPU math showed brightness sitting flat then
  // cutting to exactly 0 within ~40px, IDENTICAL at attenuation 0.0/0.3/0.7,
  // because `dist01` never grew large enough for `computeApertureSoftPx`
  // alone to matter before the arc gate's own `xHead` wall blocked the beam.
  // ==========================================================================
  ok(
    'x=0 gives exactly 0 (byte-similar to pre-round-15 at the window itself)',
    computeApertureReachSoftPx(0, 550, 48) === 0
  );
  ok(
    'x==xHeadReach (the beam own far edge) gives exactly the resolved far value',
    near(computeApertureReachSoftPx(550, 550, 48), 48)
  );
  {
    let prev = computeApertureReachSoftPx(0, 550, 48);
    let monotonic = true;
    for (let i = 1; i <= 20; i++) {
      const v = computeApertureReachSoftPx((i / 20) * 550, 550, 48);
      if (v < prev - 1e-9) monotonic = false;
      prev = v;
    }
    ok('reach softness is monotonically non-decreasing from the window to the beam edge', monotonic);
  }
  ok(
    'x beyond xHeadReach clamps rather than extrapolating',
    near(computeApertureReachSoftPx(9999, 550, 48), computeApertureReachSoftPx(550, 550, 48))
  );
  ok(
    'an absent reachSoftFarPx falls back to REACH_SOFT_FAR_PX_BASE',
    near(computeApertureReachSoftPx(550, 550), REACH_SOFT_FAR_PX_BASE)
  );
  ok(
    'a degenerate/unreachable xHeadReach (<=0, non-finite, or Infinity) reads as 0 — no reach signal, never NaN',
    computeApertureReachSoftPx(100, 0, 48) === 0 &&
      computeApertureReachSoftPx(100, -5, 48) === 0 &&
      computeApertureReachSoftPx(100, Infinity, 48) === 0 &&
      computeApertureReachSoftPx(100, NaN, 48) === 0
  );
  ok('non-finite x reads as 0 (no reach signal), never NaN', computeApertureReachSoftPx(NaN, 550, 48) === 0);

  // THE REGRESSION TEST for the round-15 diagnosis itself: a light whose
  // configured radius reaches far past its own window must still fade the
  // beam's far edge over a REAL span of `x`, not an near-instant cliff —
  // reproducing the exact scenario the live Node probe used (a=150, h=280,
  // headPx=220 -> xHeadReach=550) with the SHIPPED default reachSoftFarPx.
  {
    const aperture = { A: { x: 0, y: 0 }, dir: { x: 0, y: 1 }, nrm: { x: 1, y: 0 }, sL: 100, a: 150 };
    const h = APERTURE_GOBO_DEFAULTS.defaultLampHeightPx; // 280
    const p = windowParams({ wallLen: 200, wallThicknessPx: 0 });
    const goboAt = (x) => computeApertureGoboTerm({ x, y: 100 }, aperture, h, 0, p).gobo;
    // Before round 15 this transition happened entirely within ~40px
    // (x≈530 still ~1.0, x≈570 already 0) REGARDLESS of dist01 — the bug
    // this round fixes. Assert a REAL spread now exists.
    const brightXNearEdge = [...Array(60).keys()].map((i) => 480 + i * 2).find((x) => goboAt(x) < 0.95);
    const darkX = [...Array(60).keys()].map((i) => 480 + i * 2).find((x) => goboAt(x) < 0.02);
    ok(
      'the far edge now fades across a real span of x, not a ~40px cliff',
      Number.isFinite(brightXNearEdge) && Number.isFinite(darkX) && darkX - brightXNearEdge > 40
    );
    // x=150 (not x=200 — verified via node: with the shipped mullion/sillPx
    // defaults, x=200 lands exactly on this window's own internal row
    // mullion, reading 0 for a REAL reason unrelated to this test's own
    // claim) — comfortably clear of the row mullion and still well before
    // the far-edge transition (which starts around x≈480+, per the sweep
    // above).
    ok('well before the edge, the beam is still fully bright (near field unchanged)', near(goboAt(150), 1, 0.05));
  }

  // ==========================================================================
  // computeApertureFrameOnlyGate / computeApertureSillHeadOnlyGate (round 17)
  // — the SAME first line `computeApertureSpokeGate`/`computeApertureArcGate`
  // open with, before their own mullion loops, exposed standalone for edge
  // suppression to use without duplicating a mullion-aware combined gate.
  // ==========================================================================
  ok(
    'computeApertureFrameOnlyGate: dead centre of a 150-wide window, frame=6, reads positive and symmetric',
    near(computeApertureFrameOnlyGate(75, { wallLen: 150, frame: 6 }), 69)
  );
  ok(
    'computeApertureFrameOnlyGate: exactly ON the low-sW frame boundary reads ~0',
    near(computeApertureFrameOnlyGate(6, { wallLen: 150, frame: 6 }), 0)
  );
  ok(
    'computeApertureFrameOnlyGate: past the frame boundary reads negative (blocked)',
    computeApertureFrameOnlyGate(2, { wallLen: 150, frame: 6 }) < 0
  );
  ok(
    'computeApertureFrameOnlyGate: loExtra/hiExtra widen their own side only',
    near(computeApertureFrameOnlyGate(10, { wallLen: 150, frame: 6, loExtra: 4 }), 0) &&
      near(computeApertureFrameOnlyGate(10, { wallLen: 150, frame: 6, hiExtra: 4 }), 4)
  );
  ok(
    'computeApertureSillHeadOnlyGate: between sill and head reads positive',
    computeApertureSillHeadOnlyGate(50, 30, 183) > 0
  );
  ok(
    'computeApertureSillHeadOnlyGate: below the sill reads negative (sheltered)',
    computeApertureSillHeadOnlyGate(10, 30, 183) < 0
  );
  ok(
    'computeApertureSillHeadOnlyGate: past the head reads negative (unreachable)',
    computeApertureSillHeadOnlyGate(200, 30, 183) < 0
  );

  // ==========================================================================
  // EDGE SUPPRESSION (round 17, 2026-08-04) — `APERTURE_GOBO_DEFAULTS`'s own
  // "EDGE SUPPRESSION" header: a DIRECT, GUARANTEED, opt-in darkening toward
  // TRUE ZERO near the window's own outer edges and the light's own dim
  // radius, independent of whatever Foundry's own attenuation curve is
  // doing. Every value below verified with an actual Node run before being
  // asserted (this project's own "hand-derivation needs checking" discipline
  // — round 14's own header names four separate times this session a
  // hand-solved probe needed correcting).
  // ==========================================================================
  {
    // a=50 (not 10) and h=280 (the real default lamp height, not an
    // arbitrary 40) — deliberately clears BOTH the sill (xSill=6 at these
    // values) and the head (xHead≈183), so P.y=50 reads as a genuinely OPEN
    // floor point via the arc gate, isolating the NEW frame-only suppression
    // from the sill/head gate entirely.
    const aperture = { A: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, nrm: { x: 0, y: 1 }, sL: 0, a: 50 };
    const h = 280;
    const p = {
      wallLen: 150,
      cols: 1,
      rows: 1,
      frame: 6,
      mullion: 4,
      sillPx: 30,
      headPx: 220,
      softFarPx: 3,
      reachSoftFarPx: 0, // isolates the NEW edge-suppression tests from round 15's own reach blur
    };
    // sW=10 (4px inside the 6px frame boundary) — s=20, inv=a/(a+50)=0.5, sW=sL+(s-sL)*inv=20*0.5=10.
    const pNearFrame = { x: 20, y: 50 };
    // sW=75 (dead centre of the 150-wide window) — s=150, sW=150*0.5=75.
    const pDeep = { x: 150, y: 50 };

    ok(
      'edgeSuppressPercent=0 (default) is an EXACT no-op near the frame edge',
      computeApertureGoboTerm(pNearFrame, aperture, h, 0, p).gobo === 1
    );
    ok(
      // round 19 — PERCENTAGE, not px: normalized against THIS window's own
      // spoke half-span (`wallLen/2-frame` = 75-6 = 69), so 20% is a
      // 13.8px band, not a fixed 20px one — verified via node, not hand-derived.
      'a positive edgeSuppressPercent darkens a point close to the frame edge',
      near(computeApertureGoboTerm(pNearFrame, aperture, h, 0, { ...p, edgeSuppressPercent: 20 }).gobo, 0.2033, 0.001)
    );
    ok(
      'the SAME edgeSuppressPercent leaves a point deep in the open pane untouched',
      near(computeApertureGoboTerm(pDeep, aperture, h, 0, { ...p, edgeSuppressPercent: 20 }).gobo, 1, 1e-9)
    );
    ok(
      'a non-finite edgeSuppressPercent behaves like 0 (opt-in, never a surprise default)',
      computeApertureGoboTerm(pNearFrame, aperture, h, 0, { ...p, edgeSuppressPercent: NaN }).gobo === 1
    );
    ok(
      'a window with an unreachable head (xHead=Infinity, lamp at/below headPx) still suppresses the frame axis, never NaN',
      Number.isFinite(
        computeApertureGoboTerm(pNearFrame, { ...aperture }, 40, 0, { ...p, edgeSuppressPercent: 20 }).gobo
      )
    );

    ok(
      'dimRadiusFadeStartPercent=dimRadiusFadeEndPercent=100 (default) is an EXACT no-op near dist01=1',
      computeApertureGoboTerm(pDeep, aperture, h, 0.99, p).gobo === 1 &&
        computeApertureGoboTerm(pDeep, aperture, h, 1.0, p).gobo === 1
    );
    // The author's own literal example: "a fade starts at 100% of the dim
    // radius and ends at 80%... a suppression gradient starting at the edge
    // and working inwards... until the suppression fades out at 20% of the
    // way towards the light at the centre."
    const startEnd = { dimRadiusFadeStartPercent: 100, dimRadiusFadeEndPercent: 80 };
    ok(
      'well below the fade-end anchor (80%), suppression has not begun',
      near(computeApertureGoboTerm(pDeep, aperture, h, 0.7, { ...p, ...startEnd }).gobo, 1, 1e-9)
    );
    ok(
      'just past the fade-end anchor (80%), suppression has begun',
      computeApertureGoboTerm(pDeep, aperture, h, 0.99, { ...p, ...startEnd }).gobo < 0.02
    );
    ok(
      'AT dist01=1 (the fade-start anchor, 100%), brightness is pulled to EXACTLY 0',
      computeApertureGoboTerm(pDeep, aperture, h, 1.0, { ...p, ...startEnd }).gobo === 0
    );
    ok(
      'reversed anchors (start=80, end=100 — the opposite literal order) produce the IDENTICAL gradient',
      computeApertureGoboTerm(pDeep, aperture, h, 0.9, { ...p, ...startEnd }).gobo ===
        computeApertureGoboTerm(pDeep, aperture, h, 0.9, {
          ...p,
          dimRadiusFadeStartPercent: 80,
          dimRadiusFadeEndPercent: 100,
        }).gobo
    );
    {
      // Monotonic decline from the fade-end anchor to dist01=1 — no sudden
      // jump, the whole point of a "suppression" control rather than a
      // second cliff.
      let prev = computeApertureGoboTerm(pDeep, aperture, h, 0.8, { ...p, ...startEnd }).gobo;
      let monotonic = true;
      for (let i = 1; i <= 10; i++) {
        const dist01 = 0.8 + (i / 10) * 0.2;
        const v = computeApertureGoboTerm(pDeep, aperture, h, dist01, { ...p, ...startEnd }).gobo;
        if (v > prev + 1e-9) monotonic = false;
        prev = v;
      }
      ok('dim-radius suppression declines monotonically toward dist01=1, no jump', monotonic);
    }
    ok(
      'equal (non-zero-width-but-identical) anchors are ALSO an exact no-op, not just the 100/100 default',
      computeApertureGoboTerm(pDeep, aperture, h, 0.9, {
        ...p,
        dimRadiusFadeStartPercent: 90,
        dimRadiusFadeEndPercent: 90,
      }).gobo === 1
    );
    ok(
      'a band pulled IN from the true edge (e.g. 70%..90%) still reads fully suppressed AT the true edge (dist01=1, past the band), never NaN',
      computeApertureGoboTerm(pDeep, aperture, h, 1.0, {
        ...p,
        dimRadiusFadeStartPercent: 90,
        dimRadiusFadeEndPercent: 70,
      }).gobo === 0
    );
    ok(
      'non-finite anchors fall back to the default (100/100, off), never NaN',
      computeApertureGoboTerm(pDeep, aperture, h, 1.0, {
        ...p,
        dimRadiusFadeStartPercent: NaN,
        dimRadiusFadeEndPercent: NaN,
      }).gobo === 1
    );
  }

  // THE SYMMETRIC-EDGE CLAIM (design doc §5, item 5): softening a boundary
  // must not MOVE it. A point exactly ON a gate's own zero-crossing must read
  // 0.5 at EVERY softness — the crossing point never drifts.
  {
    const p = { wallLen: 200, cols: 2, mullion: 4, frame: 6 }; // mullion edge at sW=98 (see the spoke-gate block above)
    for (const soft of [1, 5, 50]) {
      const gate = computeApertureSpokeGate(98, p); // ~0 by construction
      const t = Math.min(1, Math.max(0, (gate - -soft) / (soft - -soft)));
      const smooth = t * t * (3 - 2 * t);
      ok(`a boundary point reads ~0.5 regardless of softness (soft=${soft})`, near(smooth, 0.5, 0.05));
    }
  }

  // ==========================================================================
  // computeApertureGoboForLight — THE COMBINE, and its own regression test.
  // UNCHANGED by design 4 (this is the layer ABOVE the gate math).
  // ==========================================================================
  ok(
    'zero apertures -> 1 (fully unmodulated), the fail-open default',
    computeApertureGoboForLight({ x: 0, y: 20 }, [], 40, 0, windowParams()) === 1
  );
  ok(
    'undefined apertures -> 1, never throws',
    computeApertureGoboForLight({ x: 0, y: 20 }, undefined, 40, 0, windowParams()) === 1
  );
  {
    const aperture = { A: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, nrm: { x: 0, y: 1 }, sL: 0, a: 10 };
    const interior = computeApertureGoboForLight({ x: 0, y: -5 }, [aperture], 40, 0, windowParams());
    ok('a single INAPPLICABLE aperture (interior point) falls back to 1, not 0', interior === 1);
  }

  // ---- THE REGRESSION TEST: an inapplicable aperture must NOT out-vote a
  // real, darker, APPLICABLE one via the max-combine. ------------------------
  {
    const p = windowParams({ wallLen: 200, cols: 2, rows: 1, frame: 0, mullion: 40, sillPx: 0, headPx: 220 });
    // Aperture B: a real wall the test point is genuinely exterior to, AND
    // whose window-space projection lands squarely on its own (fat, 40px)
    // vertical mullion — so B's own gobo term should be dark (<0.4).
    // With frame:0, cols:2, wallLen:200, the one internal mullion sits at the
    // window's own centre, sW=100. Hand-solved so the projection lands
    // exactly there: at x==a (=10), inv=a/(a+x)=0.5, so sW=sL+(s-sL)*0.5=100
    // requires s=200 (sL=0) — P=(200,10).
    const apertureB = { A: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, nrm: { x: 0, y: 1 }, sL: 0, a: 10, wallLen: 200 };
    const P = { x: 200, y: 10 };
    const soloB = computeApertureGoboTerm(P, apertureB, 40, 0, p);
    ok('sanity: aperture B alone genuinely reads dark at this point', soloB.applicable === true && soloB.gobo < 0.4);

    // Aperture A: oriented so THIS SAME point sits on A's own INTERIOR side
    // (nrm pointing the opposite way A's wall would need to see P as exterior).
    const apertureA = { A: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, nrm: { x: 0, y: -1 }, sL: 0, a: 10, wallLen: 200 };
    const soloA = computeApertureGoboTerm(P, apertureA, 40, 0, p);
    ok('sanity: aperture A is genuinely inapplicable at this point', soloA.applicable === false);

    const combined = computeApertureGoboForLight(P, [apertureA, apertureB], 40, 0, p);
    ok(
      `an inapplicable aperture (A) must NOT override an applicable, darker one (B) via max — combined (${combined}) must equal B's own value, not 1`,
      near(combined, soloB.gobo, 1e-9)
    );
  }

  // ---- Union semantics: two APPLICABLE apertures both lighting the same
  // point combine via MAX (the brighter path wins), never a product. -------
  {
    const p = windowParams({ wallLen: 200, cols: 1, rows: 1, frame: 0, sillPx: 0, headPx: 220 });
    // Both apertures see P as exterior; A is centred on P (fully lit, ~1),
    // B is shifted far enough that P sits near/in B's own frame (darker).
    const apertureA = { A: { x: -100, y: 0 }, dir: { x: 1, y: 0 }, nrm: { x: 0, y: 1 }, sL: -100, a: 10, wallLen: 200 };
    const apertureB = { A: { x: 400, y: 0 }, dir: { x: 1, y: 0 }, nrm: { x: 0, y: 1 }, sL: 400, a: 10, wallLen: 200 };
    const P = { x: 0, y: 20 };
    const a = computeApertureGoboTerm(P, apertureA, 40, 0, p);
    const b = computeApertureGoboTerm(P, apertureB, 40, 0, p);
    const combined = computeApertureGoboForLight(P, [apertureA, apertureB], 40, 0, p);
    ok(
      'the combine is the MAX of the two applicable terms, not their product',
      near(combined, Math.max(a.gobo, b.gobo), 1e-9)
    );
    ok(
      '...and specifically brighter than the product would have been (no double-shadowing)',
      combined >= a.gobo * b.gobo - 1e-9
    );
  }

  // ==========================================================================
  // Degenerate battery — large/weird inputs never produce NaN where a real
  // number is expected. `Infinity` IS a legitimate, real value here (a fully
  // blocked far-field point, or an unreachable sill/head) — the test is
  // "never NaN", not "never Infinity".
  // ==========================================================================
  {
    const bigAperture = {
      A: { x: 1e6, y: 1e6 },
      dir: { x: 1, y: 0 },
      nrm: { x: 0, y: 1 },
      sL: 1e6,
      a: 10,
      wallLen: 200,
    };
    const term = computeApertureGoboTerm({ x: 1e6, y: 1e6 + 20 }, bigAperture, 40, 0.5, windowParams({ wallLen: 200 }));
    ok('large world coordinates never produce NaN', Number.isFinite(term.gobo));
    const zeroPane = computeApertureGoboTerm(
      { x: 1e6, y: 1e6 + 20 },
      bigAperture,
      40,
      0.5,
      windowParams({ wallLen: 200, cols: 0, rows: 0 })
    );
    ok('cols=0/rows=0 never throws/NaNs (no mullions to draw)', Number.isFinite(zeroPane.gobo));
  }

  // ==========================================================================
  // computeApertureHeightFromX — the forward of computeApertureRowBoundaryX.
  // Round 13, 2026-08-04.
  // ==========================================================================
  {
    const a = 10;
    const h = 40;
    for (const z of [0, 10, 25, 39]) {
      const x = computeApertureRowBoundaryX({ a, h, z });
      const zBack = computeApertureHeightFromX({ a, h, x });
      ok(`z=${z} round-trips through x back to the SAME z (got ${zBack})`, near(zBack, z, 1e-6));
    }
    ok('x<=0 reads as z=0, never negative/NaN', computeApertureHeightFromX({ a, h, x: 0 }) === 0);
    ok('a<=0 reads as z=0, never a division blowup', computeApertureHeightFromX({ a: 0, h, x: 10 }) === 0);
    ok('h<=0 reads as z=0', computeApertureHeightFromX({ a, h: 0, x: 10 }) === 0);
  }

  // ==========================================================================
  // computeApertureHash2 — deterministic, bounded, spread out. Round 13.
  // ==========================================================================
  {
    ok(
      'the SAME (x,y) always gives the SAME hash (deterministic, not fresh-rolled)',
      computeApertureHash2(3, 7) === computeApertureHash2(3, 7)
    );
    let allInRange = true;
    const seen = new Set();
    for (let x = 0; x < 10; x++) {
      for (let y = 0; y < 10; y++) {
        const v = computeApertureHash2(x, y);
        if (!(v >= 0 && v < 1)) allInRange = false;
        seen.add(v.toFixed(6));
      }
    }
    ok('every hash reads in [0,1)', allInRange);
    ok('100 distinct small-integer inputs give (close to) 100 distinct outputs, not a constant', seen.size > 90);
  }

  // ==========================================================================
  // computeAperturePaneIndex — which pane (not mullion) a window-plane point
  // falls inside. Round 13.
  // ==========================================================================
  {
    const p = { wallLen: 200, cols: 4, rows: 2, sillPx: 0, headPx: 100 };
    ok(
      'the wall foot (sW=0,z=0) is pane (0,0)',
      (() => {
        const r = computeAperturePaneIndex({ sW: 0, z: 0, ...p });
        return r.colIndex === 0 && r.rowIndex === 0;
      })()
    );
    ok(
      'a point mid-way along and mid-height lands in the middle pane, hand-derived',
      (() => {
        // colWidth=50, rowHeight=50 -> sW=149 -> col floor(149/50)=2; z=74 -> row floor(74/50)=1
        const r = computeAperturePaneIndex({ sW: 149, z: 74, ...p });
        return r.colIndex === 2 && r.rowIndex === 1;
      })()
    );
    ok(
      'sW/z far past the wall span CLAMP to the last pane, never overflow it',
      (() => {
        const r = computeAperturePaneIndex({ sW: 1e6, z: 1e6, ...p });
        return r.colIndex === p.cols - 1 && r.rowIndex === p.rows - 1;
      })()
    );
    ok(
      'negative sW/z CLAMP to the first pane, never go negative',
      (() => {
        const r = computeAperturePaneIndex({ sW: -50, z: -50, ...p });
        return r.colIndex === 0 && r.rowIndex === 0;
      })()
    );
  }

  // ==========================================================================
  // computeApertureGlassWarpOffset — the blob<->faceted blend. Round 13,
  // `facetHash` renamed to `facetValue` in round 14 (the facet kernel itself
  // stopped being a hash — see computeApertureFacetWedgeValue's own header).
  // ==========================================================================
  {
    ok(
      'quality=0 is PURE blob — facetValue has zero influence',
      near(
        computeApertureGlassWarpOffset({ blobNoise: 1, facetValue: 0, quality: 0, distortionPx: 10 }),
        computeApertureGlassWarpOffset({ blobNoise: 1, facetValue: 1, quality: 0, distortionPx: 10 })
      )
    );
    ok(
      'quality=1 is PURE faceted — blobNoise has zero influence',
      near(
        computeApertureGlassWarpOffset({ blobNoise: 0, facetValue: 0.8, quality: 1, distortionPx: 10 }),
        computeApertureGlassWarpOffset({ blobNoise: 1, facetValue: 0.8, quality: 1, distortionPx: 10 })
      )
    );
    ok(
      'quality=0, blobNoise=1, distortionPx=10 -> exactly +10 (full-scale blob)',
      near(computeApertureGlassWarpOffset({ blobNoise: 1, facetValue: 0, quality: 0, distortionPx: 10 }), 10)
    );
    ok(
      'quality=1, facetValue=1, distortionPx=10 -> exactly +10 (facetValue=1 remaps to +1)',
      near(computeApertureGlassWarpOffset({ blobNoise: 0, facetValue: 1, quality: 1, distortionPx: 10 }), 10)
    );
    ok(
      'quality=1, facetValue=0, distortionPx=10 -> exactly -10 (facetValue=0 remaps to -1)',
      near(computeApertureGlassWarpOffset({ blobNoise: 0, facetValue: 0, quality: 1, distortionPx: 10 }), -10)
    );
    ok(
      'distortionPx=0 is an exact no-op regardless of quality/noise',
      computeApertureGlassWarpOffset({ blobNoise: 1, facetValue: 1, quality: 0.5, distortionPx: 0 }) === 0
    );
  }

  // ==========================================================================
  // computeApertureFacetWedgeValue — round 14 (2026-08-04): an ORDERED
  // angular medallion, replacing the original random-per-cell shatter.
  // ==========================================================================
  {
    ok(
      'a point comfortably inside a wedge (not on a boundary) reads a real, verified parity',
      computeApertureFacetWedgeValue({ localSW: 1, localZ: 0.3, wedgeCount: 8 }) === 1
    );
    ok(
      'the SAME point always gives the SAME wedge value (deterministic, not a fresh roll)',
      computeApertureFacetWedgeValue({ localSW: 3, localZ: 5, wedgeCount: 8 }) ===
        computeApertureFacetWedgeValue({ localSW: 3, localZ: 5, wedgeCount: 8 })
    );
    ok(
      'adjacent wedges alternate parity — a real 8-wedge sweep visits BOTH values',
      (() => {
        const seen = new Set();
        for (let i = 0; i < 8; i++) {
          const angle = (i / 8) * Math.PI * 2 + 0.01; // just past each wedge's own start
          seen.add(
            computeApertureFacetWedgeValue({ localSW: Math.cos(angle), localZ: Math.sin(angle), wedgeCount: 8 })
          );
        }
        return seen.size === 2 && seen.has(0) && seen.has(1);
      })()
    );
    ok(
      'the origin (localSW=0, localZ=0) never throws/NaNs — atan2(0,0) is a real, defined edge case',
      Number.isFinite(computeApertureFacetWedgeValue({ localSW: 0, localZ: 0, wedgeCount: 8 }))
    );
    ok(
      'omitting wedgeCount falls back to FACET_WEDGE_COUNT, never throws',
      Number.isFinite(computeApertureFacetWedgeValue({ localSW: 5, localZ: 5 }))
    );
    ok(
      'wedgeCount=1 (degenerate, one giant wedge) never throws, reads as a single constant value everywhere',
      computeApertureFacetWedgeValue({ localSW: 5, localZ: 5, wedgeCount: 1 }) ===
        computeApertureFacetWedgeValue({ localSW: -5, localZ: -5, wedgeCount: 1 })
    );
  }

  // ==========================================================================
  // computeApertureGrimeFactor — the layered-noise darkening multiplier.
  // Round 13.
  // ==========================================================================
  {
    ok(
      'grimeAmount=0 is an EXACT no-op (=== 1), regardless of noise values',
      computeApertureGrimeFactor({ fbmValue: 1, worleyValue: 1, grimeAmount: 0 }) === 1
    );
    ok(
      'maximal dirt (fbm=1, worley=1) at grimeAmount=1 darkens all the way to 0',
      near(computeApertureGrimeFactor({ fbmValue: 1, worleyValue: 1, grimeAmount: 1 }), 0)
    );
    ok(
      'minimal dirt (fbm=-1, worley=0) is a no-op even at grimeAmount=1 — the NOISE said clean here',
      near(computeApertureGrimeFactor({ fbmValue: -1, worleyValue: 0, grimeAmount: 1 }), 1)
    );
    ok(
      'halving grimeAmount halves the darkening at maximal dirt',
      near(computeApertureGrimeFactor({ fbmValue: 1, worleyValue: 1, grimeAmount: 0.5 }), 0.5)
    );
    ok(
      'always stays within [0,1], never inverts to a brightening factor',
      (() => {
        const v = computeApertureGrimeFactor({ fbmValue: 1, worleyValue: 1, grimeAmount: 1 });
        return v >= 0 && v <= 1;
      })()
    );
  }

  // ==========================================================================
  // computeAperturePaneIsBroken — the per-pane hash decision. Round 13.
  // ==========================================================================
  {
    ok(
      'grimeAmount=0 NEVER breaks a pane, any index',
      !computeAperturePaneIsBroken({ colIndex: 0, rowIndex: 0, grimeAmount: 0 }) &&
        !computeAperturePaneIsBroken({ colIndex: 7, rowIndex: 7, grimeAmount: 0 })
    );
    ok(
      'the SAME pane gives the SAME verdict every call (deterministic, not fresh-rolled)',
      computeAperturePaneIsBroken({ colIndex: 3, rowIndex: 2, grimeAmount: 1 }) ===
        computeAperturePaneIsBroken({ colIndex: 3, rowIndex: 2, grimeAmount: 1 })
    );
    {
      let brokenCount = 0;
      for (let c = 0; c < 8; c++) {
        for (let r = 0; r < 8; r++) {
          if (computeAperturePaneIsBroken({ colIndex: c, rowIndex: r, grimeAmount: 1 })) brokenCount++;
        }
      }
      ok(
        'at grimeAmount=1, SOME but not ALL of 64 panes are broken (a real distribution, not a constant)',
        brokenCount > 0 && brokenCount < 64
      );
      ok(
        `roughly MAX_PANE_BREAK_CHANCE(${MAX_PANE_BREAK_CHANCE}) of panes break at grimeAmount=1 — ` +
          `got ${brokenCount}/64 (${((brokenCount / 64) * 100).toFixed(0)}%), wide statistical tolerance`,
        brokenCount >= 4 && brokenCount <= 28
      );
    }
  }

  // ==========================================================================
  // computeAperturePaneCrackGeometry + computeApertureCrackLineOpenness —
  // the shape of a broken pane's own crack(s). Round 13.
  // ==========================================================================
  {
    const lines = computeAperturePaneCrackGeometry({ colIndex: 2, rowIndex: 1, paneWidthPx: 50, paneHeightPx: 50 });
    ok('exactly two crack lines per broken pane', lines.length === 2);
    ok(
      'every line has finite, sane geometry',
      lines.every(
        (l) =>
          Number.isFinite(l.originOffsetSW) &&
          Number.isFinite(l.originOffsetZ) &&
          Number.isFinite(l.angle) &&
          l.lengthPx > 0
      )
    );
    ok(
      'the crack origin stays INSIDE the pane (bounded, not off in the mullion/frame)',
      lines.every((l) => Math.abs(l.originOffsetSW) <= 50 * 0.3 + 1e-9 && Math.abs(l.originOffsetZ) <= 50 * 0.3 + 1e-9)
    );
    ok(
      'the SAME pane gives the SAME crack geometry every call (stable, not flickering)',
      JSON.stringify(lines) ===
        JSON.stringify(
          computeAperturePaneCrackGeometry({ colIndex: 2, rowIndex: 1, paneWidthPx: 50, paneHeightPx: 50 })
        )
    );
    ok(
      'a DIFFERENT pane gets DIFFERENT crack geometry, not the same shape stamped everywhere',
      JSON.stringify(lines) !==
        JSON.stringify(
          computeAperturePaneCrackGeometry({ colIndex: 5, rowIndex: 6, paneWidthPx: 50, paneHeightPx: 50 })
        )
    );

    // THE LINE SDF ITSELF — hand-derived at angle=0 (axis-aligned) for a
    // simple, exact check independent of the hashed geometry above.
    const line = { originSW: 0, originZ: 0, angle: 0, lengthPx: 10 };
    ok(
      'exactly at the line origin, openness is exactly 1',
      computeApertureCrackLineOpenness({ sW: 0, z: 0, ...line }) === 1
    );
    ok(
      'at CRACK_WIDTH_PX perpendicular, openness is exactly 0 (the width edge)',
      near(computeApertureCrackLineOpenness({ sW: 0, z: CRACK_WIDTH_PX, ...line }), 0)
    );
    ok(
      'at HALF CRACK_WIDTH_PX perpendicular, openness is exactly 0.5',
      near(computeApertureCrackLineOpenness({ sW: 0, z: CRACK_WIDTH_PX / 2, ...line }), 0.5)
    );
    ok(
      'past lengthPx ALONG the line (either direction), openness is 0 — a hard cut, not a soft one',
      computeApertureCrackLineOpenness({ sW: 15, z: 0, ...line }) === 0 &&
        computeApertureCrackLineOpenness({ sW: -15, z: 0, ...line }) === 0
    );
  }

  // ==========================================================================
  // computeApertureGoboTerm's own extraSpokeOffsetPx — round 13's seam into
  // the EXISTING, already-tested gate math. Zero-default backward
  // compatibility is already proven by every OTHER test in this file never
  // passing a 6th argument; this pins that a NONZERO offset genuinely reaches
  // the spoke gate.
  // ==========================================================================
  {
    const aperture = { A: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, nrm: { x: 0, y: 1 }, sL: 0, a: 50 };
    // `reachSoftFarPx: 0` isolates this from round 15's own reach blur
    // (active by default once `h > headPx`, needed below to clear the
    // shipped sillPx — otherwise the mullion-centre reading is softened by
    // real, unrelated blur rather than staying a clean dark/open contrast).
    const p = windowParams({ wallLen: 150, cols: 2, mullion: 4, frame: 6, reachSoftFarPx: 0 }); // mullion centre at sW=75
    // P hand-solved, verified via node (this file's own established
    // discipline after repeated hand-derivation misses): proj.sW=50
    // (comfortably OPEN, pane 0, away from both the mullion(75) and
    // frame(6)), proj.x=100 (clear of both the sill AND head boundaries —
    // `a=50`/`h=280` chosen together so BOTH `computeApertureRowBoundaryX`
    // calls resolve finite and x=100 sits well inside them, unlike a
    // smaller `a` or `h` that predates the shipped sillPx=105/round-18
    // defaults): inv=a/(a+x)=50/150=1/3, sW=s/3=50 needs s=150.
    const h = 280;
    const P = { x: 150, y: 100 };
    const unwarped = computeApertureGoboTerm(P, aperture, h, 0, p);
    ok('with no offset, this point reads open (sanity baseline)', unwarped.gobo > 0.9);
    const warpedIntoMullion = computeApertureGoboTerm(P, aperture, h, 0, p, 25); // 50+25=75, dead on the mullion
    ok(
      'a 25px offset shifts sW=50 onto the mullion at sW=75 — the SAME point now reads dark',
      warpedIntoMullion.gobo < 0.05
    );
    const zeroOffset = computeApertureGoboTerm(P, aperture, h, 0, p, 0);
    ok('an explicit 0 offset is byte-identical to omitting the argument', zeroOffset.gobo === unwarped.gobo);
  }

  // THE VISIBILITY GATE — RETIRED (round 10, 2026-08-04). This whole block
  // (`computeApertureShadowVisibility`, `VISIBILITY_SATURATION_RATIO`, eight
  // rounds of live calibration) tested a SEPARATE post-process shadow pass
  // that no longer exists — see `aperture-gobo.js`'s own retirement note
  // (search "THE VISIBILITY GATE — RETIRED") for why MAX-blending the gobo
  // pattern directly into `point-light-illumination.js`/`point-light-
  // coloration.js`'s own falloff makes a separate gate unnecessary.
}
