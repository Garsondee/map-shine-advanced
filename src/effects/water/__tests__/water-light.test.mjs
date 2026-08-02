/**
 * water-light.test.mjs — tier 3's arithmetic AND, since 2026-07-29, what it
 * actually puts on the screen.
 *
 * ============================================================================
 * ⚠️ THIS SUITE USED TO PROVE THE WRONG HALF, AND THE RUNG SHIPPED INVISIBLE
 * ============================================================================
 * Until 2026-07-29 everything below the first block did not exist. The suite
 * tested `waterKeyLightDirection` (the sun's DIRECTION) and three constants for
 * being "physically sane" — and every one of those assertions passed, the whole
 * time the rung was contributing a flat, invisible 0.0084 wash to every scene.
 *
 * That is `Specular.md` §10's lesson arriving here on schedule: *"the decode
 * had a CPU twin and 73 assertions; the COMPOSITION — what those numbers
 * actually add to a pixel — had none, so the one question that mattered was the
 * one question nothing could answer."* Water repeated it exactly.
 *
 * So the assertions added here are BRIGHTNESS BANDS, not formula checks
 * (`feedback_measure_the_output_not_the_equation`). Against `buf:scene.color`'s
 * own roughly-0..1 scale, the same bands `Specular.md` §10 calibrated:
 *
 *     < 0.008  invisible  ·  0.05  a sheen  ·  0.3  unmistakable
 *
 * A test that only proves a formula is self-consistent cannot tell a working
 * rung from a dead one. These can.
 */
import {
  waterKeyLightDirection,
  waterTier3Cpu,
  WATER_F0,
  WATER_MIN_ROUGHNESS,
  WATER_TIER3_GLOSSINESS,
} from '../water-light.js';
import { WATER_TIER3_CHOP } from '../water-field.js';
import { WATER_PARAMS } from '../water.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/** A clear day, from `sky-access.js`'s own constants: the key at full strength
 * and the dome at `FILL_SHARE`. Not invented numbers — the values that module
 * actually publishes at `dayFactor01 = 1, cloud01 = 0`. */
const CLEAR_DAY = { keyStrength: 1, fillStrength: 0.42 };
const VIEW_SPAN = 4000;

/** The sun as a unit 3-vector at a given elevation, along +y. */
const sunAt = (elevationDeg) => waterKeyLightDirection({ dirX: 0, dirY: 1, elevationDeg });

/**
 * Sample the rung over a realistic wave-slope distribution and report the
 * statistics a VIEWER responds to: the mean (how bright the water reads
 * overall) and the 99th percentile (the sparkles the eye is actually drawn
 * to). A deterministic lattice, not random — a flaky brightness test is worse
 * than none.
 */
function glitterStats({ elevationDeg, chop = WATER_TIER3_CHOP, glossiness = WATER_TIER3_GLOSSINESS, flat = false }) {
  const keyDir = sunAt(elevationDeg);
  const samples = [];
  const N = 41;
  // The noise channels feeding `slope` are roughly [-1,1]; sweeping that range
  // scaled by `chop` covers the same slopes the shader can produce.
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const nx = (i / (N - 1)) * 2 - 1;
      const ny = (j / (N - 1)) * 2 - 1;
      // Gaussian-ish weighting: fractal noise spends most of its time near 0,
      // so an unweighted sweep would wildly over-count extreme facets.
      const w = Math.exp(-(nx * nx + ny * ny) / 0.5);
      const r = waterTier3Cpu({
        px: 0,
        py: 0,
        viewSpanX: VIEW_SPAN,
        glossiness,
        keyDir,
        ...CLEAR_DAY,
        slope: flat ? null : [nx * chop, ny * chop],
      });
      samples.push({ v: r.total, w });
    }
  }
  const wsum = samples.reduce((a, b) => a + b.w, 0);
  const mean = samples.reduce((a, b) => a + b.v * b.w, 0) / wsum;
  samples.sort((a, b) => a.v - b.v);
  let acc = 0;
  let p99 = samples[samples.length - 1].v;
  for (const s of samples) {
    acc += s.w;
    if (acc >= 0.99 * wsum) {
      p99 = s.v;
      break;
    }
  }
  // HOW MUCH OF THE SURFACE ACTUALLY SPARKLES — and this, not the mean, is the
  // honest measure of "does this glitter". The mean is dominated by outliers
  // exactly when the lobe is too tight: a near-mirror setting measured a
  // HIGHER mean than the calibrated one while sparkling on a fifth as much
  // surface, purely because a handful of facets hit 9x the buffer's range.
  const sheenFrac = samples.filter((s) => s.v >= 0.05).reduce((a, b) => a + b.w, 0) / wsum;
  return { mean, p99, max: samples[samples.length - 1].v, sheenFrac };
}

export function run(t) {
  const { ok } = t;

  // --- straight overhead: azimuth is irrelevant, the vector is +Z ----------
  {
    const [x, y, z] = waterKeyLightDirection({ dirX: 1, dirY: 0, elevationDeg: 90 });
    ok('sun at zenith points straight up regardless of azimuth', near(x, 0) && near(y, 0) && near(z, 1));
  }

  // --- on the horizon: the vector is purely horizontal, unit length --------
  {
    const [x, y, z] = waterKeyLightDirection({ dirX: 1, dirY: 0, elevationDeg: 0 });
    ok('sun on the horizon has zero Z', near(z, 0));
    ok('...and the horizontal direction is preserved', near(x, 1) && near(y, 0));
  }

  // --- a general case: 45° elevation splits Z and the horizontal equally ---
  {
    const [x, y, z] = waterKeyLightDirection({ dirX: 0, dirY: 1, elevationDeg: 45 });
    ok('45° elevation: Z equals the horizontal component', near(z, x === 0 ? y : x, 1e-5));
    const len = Math.hypot(x, y, z);
    ok('...and the result is always unit length', near(len, 1, 1e-5));
  }

  // --- degenerate input never throws and never returns a non-unit vector ---
  {
    const [x, y, z] = waterKeyLightDirection({});
    ok('a missing key falls back to straight up, not NaN', near(x, 0) && near(y, 0) && near(z, 1));
  }
  {
    const v = waterKeyLightDirection(undefined);
    ok('an undefined key does not throw and returns straight up', v[0] === 0 && v[1] === 0 && v[2] === 1);
  }

  // --- the constants are physically sane, not just present ------------------
  ok(
    "water's own F0 is LOWER than specular's general-dielectric average (0.04) — water 0.02 is the documented value",
    WATER_F0 > 0 && WATER_F0 < 0.04
  );
  ok(
    'the roughness floor matches the SAME fp16 GGX-denominator guard specular uses (0.089), not a different number',
    WATER_MIN_ROUGHNESS === 0.089
  );
  // ⚠️ This assertion used to read "default glossiness is high (near-mirror
  // calm water)" and PASSED at the value that made the rung invisible — a
  // range check wide enough to admit the bug. The band is now the measured
  // one: above a mirror-flat mistake, below the near-mirror value that blew
  // out (see WATER_TIER3_GLOSSINESS's own header for both numbers).
  ok(
    'default glossiness sits in the CAPILLARY-microstructure band, not the near-mirror one',
    WATER_TIER3_GLOSSINESS > 0.5 && WATER_TIER3_GLOSSINESS < 0.85
  );

  // === 🔒 TWO PLACES STORE ONE NUMBER ======================================
  // The code constant and the schema default that a scene actually ships with.
  // Specular shipped exactly this drift once (`SPECULAR_DEFAULT_SHIMMER_GAIN`
  // vs its FOH default) and that is why these pins exist.
  ok(
    'the glossiness code constant IS the schema default — no second authority',
    WATER_PARAMS.glossiness.default === WATER_TIER3_GLOSSINESS
  );
  ok('the chop code constant IS the schema default', WATER_PARAMS.chop.default === WATER_TIER3_CHOP);

  // === 📏 THE BRIGHTNESS BANDS — what this rung PUTS ON THE SCREEN =========
  // Everything above this line passed for three days while the rung was
  // invisible. These are the assertions that can tell the difference.

  // --- 1. THE REGRESSION PIN: the flat normal is measurably dead -----------
  // Kept as a hard number rather than a relative check, because "flat" is the
  // exact configuration that shipped and the exact one a future refactor could
  // silently restore (`dot(N, x)` collapsing back to `x.z`).
  {
    const flat = glitterStats({ elevationDeg: 45, flat: true });
    ok(
      'FLAT NORMAL (the shipped bug) measures INVISIBLE — mean below the 0.008 band',
      flat.mean < 0.011 && flat.p99 < 0.011
    );
    ok(
      '...and it is spatially FLAT: p99 within 1% of the mean, so there is no highlight anywhere',
      flat.p99 / flat.mean < 1.01
    );
  }

  // --- 2. THE FIX: a real wave normal produces real sparkle ---------------
  {
    const lit = glitterStats({ elevationDeg: 60 });
    const flat = glitterStats({ elevationDeg: 60, flat: true });
    ok('a wave normal lifts the p99 into at least the SHEEN band (>= 0.05)', lit.p99 >= 0.05);
    ok('...which is a large multiple of the flat-normal p99 it replaces', lit.p99 / flat.p99 > 5);
    ok(
      '...while the MEAN stays dim — water must read as mostly dark with bright specks, never as a wash',
      lit.mean < 0.06
    );
    ok('...so the sparkle has real contrast against its own surface', lit.p99 / lit.mean > 3);
    ok('...and nothing blows out past the buffer: the brightest facet stays under 1.0', lit.max < 1 && lit.max > 0.05);
  }

  // --- 3. THE SUN ACTUALLY MATTERS NOW ------------------------------------
  // With the flat normal this swept from 0.0084 to 0.0084 — the sun's own
  // elevation, the single largest thing about an outdoor scene, changed the
  // water by nothing at all.
  {
    const low = glitterStats({ elevationDeg: 20 });
    const high = glitterStats({ elevationDeg: 75 });
    ok('a high sun glitters far more than a low one — the rung responds to the day', high.p99 > low.p99 * 3);
    const sweep = [10, 20, 30, 45, 60, 75].map((e) => glitterStats({ elevationDeg: e }).mean);
    ok(
      'and brightness rises MONOTONICALLY with sun elevation (no fold, no discontinuity)',
      sweep.every((v, i) => i === 0 || v >= sweep[i - 1] - 1e-9)
    );
  }

  // --- 4. CHOP IS A REAL CONTROL, AND IT HAS AN OPTIMUM -------------------
  // ⚠️ The first version of this block asserted "more chop → more sparkle" and
  // FAILED, correctly. That was a guess, and the measurement disagreed: past
  // roughly 0.4 the wavelets tilt so far that fewer of them point anywhere near
  // the sun-view bisector, so the surface goes broad and dull again. The peak
  // is the real behaviour and it is what gets pinned — a monotonic assertion
  // here would have been a lie that happened to be green.
  {
    const calm = glitterStats({ elevationDeg: 60, chop: 0 });
    const breeze = glitterStats({ elevationDeg: 60, chop: WATER_TIER3_CHOP });
    const storm = glitterStats({ elevationDeg: 60, chop: 1.2 });
    ok('chop 0 reproduces the mirror-flat surface exactly', near(calm.p99, calm.mean, 1e-9));
    ok('...and mirror-flat means NO surface sparkles at all', calm.sheenFrac === 0);
    ok('...turning chop up makes the water sparkle', breeze.p99 > calm.p99 * 5);
    ok('...and puts a real fraction of the surface into the sheen band', breeze.sheenFrac > 0.02);
    ok(
      '...but PAST the optimum more chop sparkles LESS, not more — the peak is real, not a tuning artefact',
      storm.sheenFrac < breeze.sheenFrac && storm.p99 < breeze.p99
    );
    ok(
      'the shipped default sits at or near that optimum rather than past it',
      breeze.sheenFrac >= glitterStats({ elevationDeg: 60, chop: WATER_TIER3_CHOP * 2 }).sheenFrac
    );
  }

  // --- 5. THE NEAR-MIRROR GLOSSINESS IS PINNED AS A REGRESSION FLOOR ------
  // 0.92 is what shipped. ⚠️ The first version of this block asserted it was
  // "dimmer on average" and FAILED — its mean is actually HIGHER. That is the
  // whole pathology in one number: a lobe that tight concentrates everything
  // into a few facets that blow out to NINE TIMES the buffer's range, dragging
  // the mean up while sparkling on a fifth as much surface. Blown-out specks
  // are what the tonemap crushes and bloom smears, so "brighter mean" here is
  // a defect, not a feature — which is exactly why the assertions below measure
  // COVERAGE and HEADROOM instead.
  {
    const shipped = glitterStats({ elevationDeg: 60, glossiness: 0.92 });
    const fixed = glitterStats({ elevationDeg: 60 });
    ok('the old near-mirror glossiness BLOWS OUT — its brightest facet exceeds the buffer outright', shipped.max > 1);
    ok('...while the calibrated one stays inside it', fixed.max < 1);
    ok(
      '...and the calibrated one sparkles on MORE of the surface, which is what reads as glitter',
      fixed.sheenFrac > shipped.sheenFrac * 2
    );
  }

  // --- 6. INDOORS AND NIGHT STILL CORRECTLY RENDER NOTHING ----------------
  // The rung is outdoors-gated in the shader; this proves the maths itself
  // also goes to zero rather than relying on that gate alone.
  {
    const keyDir = sunAt(45);
    const night = waterTier3Cpu({
      px: 0,
      py: 0,
      viewSpanX: VIEW_SPAN,
      keyDir,
      keyStrength: 0,
      fillStrength: 0,
      slope: [0.3, -0.2],
    });
    ok('no sun and no sky → exactly zero, not a floor', night.total === 0);
  }
}
