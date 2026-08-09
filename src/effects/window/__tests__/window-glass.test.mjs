/**
 * window-glass.test.mjs — the refraction model behind the RGB split.
 *
 * ============================================================================
 * WHY THIS SUITE LEANS ON AN ANALYTIC SURFACE INSTEAD OF ON PLAUSIBILITY
 * ============================================================================
 * `feedback_smooth_output_hides_ported_bugs` is the memory that shapes this
 * file. A glass-refraction effect produces a smooth, convincing, entirely
 * plausible picture from a model that is WRONG — including from a model whose
 * lens sign is inverted end to end, which would warp beautifully while
 * lighting up every dimple and shadowing every blob. No amount of "it looks
 * like glass" can catch that.
 *
 * So the finite differences are checked against `h(x,y) = −(x² + y²)`: a
 * paraboloid whose peak sits at the origin, i.e. a single thick blob of glass,
 * whose gradient (`−2x, −2y`) and Laplacian (`−4`) are known in closed form.
 * That gives every assertion below an answer derived independently of the code
 * under test — the CPU-twin-versus-brute-force discipline that memory demands
 * before a shader term is called correct.
 *
 * The single most important assertion in this file is `A THICK BLOB
 * CONVERGES`: it is the one that fails if the lens sign is backwards.
 */
import {
  computeGlassField,
  computeDispersionScales,
  computeChannelOffsetPx,
  computeCausticGain,
  computeSeedOffset,
  GLASS_SAMPLE_EPSILON,
  GLASS_DISPERSION_SPREAD,
  GLASS_SEED_SPAN,
  GLASS_CURVATURE_GAIN,
  GLASS_CAUSTIC_DARK_RATIO,
} from '../window-glass.js';

/** @param {number} a @param {number} b @param {number} [tol] @returns {boolean} */
function near(a, b, tol = 1e-9) {
  return Math.abs(a - b) <= tol;
}

/**
 * THE ANALYTIC GLASS — one thick blob centred on the origin.
 * `h = −(x² + y²)`, so `∇h = (−2x, −2y)` and `∇²h = −4`, everywhere.
 * @param {number} x @param {number} y @returns {number}
 */
function blobHeight(x, y) {
  return -(x * x + y * y);
}

/**
 * Sample `blobHeight` in the exact five-tap pattern `computeGlassField`
 * expects, at the real ε the shader uses.
 * @param {number} x @param {number} y @returns {object}
 */
function sampleBlob(x, y) {
  const e = GLASS_SAMPLE_EPSILON;
  return {
    centre: blobHeight(x, y),
    left: blobHeight(x - e, y),
    right: blobHeight(x + e, y),
    down: blobHeight(x, y - e),
    up: blobHeight(x, y + e),
  };
}

/** @param {{ok: Function}} t */
export function run(t) {
  const { ok } = t;

  const e = GLASS_SAMPLE_EPSILON;

  // ── THE FIELD: finite differences vs. closed-form derivatives ────────────
  // Both outputs are the true derivative scaled by a constant in ε (see
  // computeGlassField's own header on why they are NOT divided by ε): the
  // gradient by ε, the curvature by ε²/4. Asserting those exact factors is
  // what makes this a comparison against maths rather than against itself.
  const atRight = computeGlassField(sampleBlob(0.5, 0));
  ok('gradX matches the analytic gradient, scaled by ε', near(atRight.gradX, e * -2 * 0.5, 1e-12));
  ok('gradY is zero on the X axis of a radially symmetric blob', near(atRight.gradY, 0, 1e-12));

  const atUp = computeGlassField(sampleBlob(0, 0.75));
  ok('gradY matches the analytic gradient, scaled by ε', near(atUp.gradY, e * -2 * 0.75, 1e-12));
  ok('gradX is zero on the Y axis', near(atUp.gradX, 0, 1e-12));

  const atCentre = computeGlassField(sampleBlob(0, 0));
  ok('the gradient vanishes at the blob apex', near(atCentre.gradX, 0, 1e-12) && near(atCentre.gradY, 0, 1e-12));
  // ∇²h = −4 everywhere on this surface, so curvature must be (ε²/4)·(−4) = −ε².
  ok('curvature matches the analytic Laplacian, scaled by ε²/4', near(atCentre.curvature, -(e * e), 1e-12));
  ok('…and is constant across the surface, as ∇²h is', near(atRight.curvature, atCentre.curvature, 1e-12));

  // ⚠️ THE SIGN TEST — the one that catches an inverted lens. A blob is a
  // local MAXIMUM of thickness, so its curvature is negative and its
  // convergence positive; a dimple is the mirror image.
  ok('A THICK BLOB CONVERGES — curvature is negative at a thickness maximum', atCentre.curvature < 0);
  const dimple = computeGlassField({
    centre: blobHeight(0, 0) * -1, // flip the surface: a dimple, not a blob
    left: blobHeight(-e, 0) * -1,
    right: blobHeight(e, 0) * -1,
    down: blobHeight(0, -e) * -1,
    up: blobHeight(0, e) * -1,
  });
  ok('…and a thin dimple diverges — curvature is positive there', dimple.curvature > 0);

  // A flat pane has no derivatives at all, so every downstream term must die.
  const flat = computeGlassField({ centre: 0.4, left: 0.4, right: 0.4, down: 0.4, up: 0.4 });
  ok(
    'flat glass has zero gradient and zero curvature',
    flat.gradX === 0 && flat.gradY === 0 && near(flat.curvature, 0, 1e-15)
  );

  // Non-finite samples must not propagate — one NaN in an additive light
  // buffer is a permanent black hole (window-cookie.js's own note).
  const nan = computeGlassField({ centre: NaN, left: Infinity, right: undefined, down: null, up: 'x' });
  ok(
    'a non-finite sample never yields a non-finite derivative',
    Number.isFinite(nan.gradX) && Number.isFinite(nan.gradY) && Number.isFinite(nan.curvature)
  );

  // ── THE PRISM: per-channel scales ────────────────────────────────────────
  const noSplit = computeDispersionScales(0);
  ok(
    'dispersion 0 is an EXACT no-op — all three channels identical',
    noSplit[0] === 1 && noSplit[1] === 1 && noSplit[2] === 1
  );

  const split = computeDispersionScales(1);
  ok('red bends least, blue bends most', split[0] < split[1] && split[1] < split[2]);
  ok('green stays exactly on the base deflection at every dispersion', split[1] === 1);
  ok(
    'the spread at full dispersion is GLASS_DISPERSION_SPREAD either side',
    near(split[2] - 1, GLASS_DISPERSION_SPREAD) && near(1 - split[0], GLASS_DISPERSION_SPREAD)
  );
  // Symmetric about green — so turning dispersion up splits the channels
  // APART rather than dragging the whole cookie sideways.
  ok('the split is symmetric about green', near(split[1] - split[0], split[2] - split[1]));
  ok('dispersion clamps above 1', computeDispersionScales(9)[2] === computeDispersionScales(1)[2]);
  ok('a non-finite dispersion falls back to no split', computeDispersionScales(NaN)[2] === 1);

  // ── THE DISPLACEMENT: direction and magnitude ────────────────────────────
  // At x = +0.5 on the blob, ∇h points in −x (back toward the thick centre),
  // so the deflection must too: light bends TOWARD thicker glass.
  const offR = computeChannelOffsetPx({ gradX: atRight.gradX, gradY: atRight.gradY, warpPx: 10, channelScale: 1 });
  ok('light deflects TOWARD the thick centre, not away from it', offR.dx < 0);

  const scales = computeDispersionScales(1);
  const red = computeChannelOffsetPx({ gradX: atRight.gradX, gradY: 0, warpPx: 10, channelScale: scales[0] });
  const blue = computeChannelOffsetPx({ gradX: atRight.gradX, gradY: 0, warpPx: 10, channelScale: scales[2] });
  ok('blue is displaced further than red — the prism', Math.abs(blue.dx) > Math.abs(red.dx));
  ok('…and both in the SAME direction (a split, never a mirror)', Math.sign(blue.dx) === Math.sign(red.dx));

  const off0 = computeChannelOffsetPx({ gradX: 0.9, gradY: -0.4, warpPx: 0, channelScale: 1.45 });
  ok('warpPx 0 is an EXACT no-op — flat glass displaces nothing', off0.dx === 0 && off0.dy === 0);

  // The bounded-gradient claim that makes the slider honest: |grad| ≤ 1 for a
  // field in [−1,1], so displacement never exceeds warpPx × channelScale.
  const extreme = computeChannelOffsetPx({ gradX: 1, gradY: 1, warpPx: 10, channelScale: 1 });
  ok(
    'the slider reads in real pixels — max displacement is warpPx at unit gradient',
    near(extreme.dx, 10) && near(extreme.dy, 10)
  );

  const offNaN = computeChannelOffsetPx({ gradX: NaN, gradY: undefined, warpPx: 10, channelScale: NaN });
  ok('a non-finite input never produces a non-finite offset', Number.isFinite(offNaN.dx) && Number.isFinite(offNaN.dy));

  // ── THE CAUSTIC ──────────────────────────────────────────────────────────
  ok('strength 0 is an EXACT identity', computeCausticGain({ curvature: -0.8, strength: 0, sharpness: 2 }) === 1);
  const blobGain = computeCausticGain({ curvature: atCentre.curvature, strength: 1, sharpness: 1 });
  const dimpleGain = computeCausticGain({ curvature: -atCentre.curvature, strength: 1, sharpness: 1 });
  ok('a converging blob BRIGHTENS', blobGain > 1);
  ok('a diverging dimple DIMS', dimpleGain < 1);
  ok('the dark side is shallower than the bright side is tall', 1 - dimpleGain < blobGain - 1);

  // ⚠️ THE REGRESSION THIS PAIR EXISTS TO PREVENT. Sharpness once shaped ONLY
  // the bright side, on the reasoning that a slider should not deepen shadows
  // as it tightens highlights. Measured on a real GPU, that made turning the
  // caustic UP dim the whole cookie — because convergence is almost always
  // below 1, so the power SHRANK the highlights while the untouched linear
  // shadows kept their full depth. Both sides must now be shaped alike, and
  // the asymmetry must come only from GLASS_CAUSTIC_DARK_RATIO.
  const midConv = -0.5 / GLASS_CURVATURE_GAIN; // a typical, not extreme, texel
  const brightSoft = computeCausticGain({ curvature: midConv, strength: 1, sharpness: 1 });
  const brightSharp = computeCausticGain({ curvature: midConv, strength: 1, sharpness: 4 });
  const darkSoft = computeCausticGain({ curvature: -midConv, strength: 1, sharpness: 1 });
  const darkSharp = computeCausticGain({ curvature: -midConv, strength: 1, sharpness: 4 });
  ok('higher sharpness tightens the highlight toward the surround', brightSharp < brightSoft);
  ok('…and tightens the dark band by the SAME token, rather than leaving it deep', darkSharp > darkSoft);
  ok(
    'sharpness shapes both sides by the same factor — it cannot dim the image on its own',
    near((brightSharp - 1) / (brightSoft - 1), (1 - darkSharp) / (1 - darkSoft), 1e-9)
  );
  // The ONLY asymmetry is the named ratio.
  ok(
    'the dark side is exactly GLASS_CAUSTIC_DARK_RATIO as deep as the bright side is tall',
    near((1 - darkSoft) / (brightSoft - 1), GLASS_CAUSTIC_DARK_RATIO)
  );

  // THE REGIME CHECK (feedback_measure_the_output_not_the_equation): a typical
  // measured curvature must produce a VISIBLE gain, not a rounding error. The
  // lab probe found |curvature| ≈ 0.05 on the real field; at sharpness 2 that
  // has to still move the picture.
  const typical = computeCausticGain({ curvature: -0.05, strength: 1, sharpness: 2 });
  ok('a TYPICAL curvature produces a gain worth seeing, not 1e-4', typical - 1 > 0.05);

  ok(
    'the gain is never negative, even at absurd strength',
    computeCausticGain({ curvature: 2, strength: 50, sharpness: 1 }) >= 0
  );
  ok(
    'a non-finite curvature does not produce a non-finite gain',
    Number.isFinite(computeCausticGain({ curvature: NaN, strength: 1, sharpness: 2 }))
  );
  ok(
    'the ceiling is 1 + strength',
    computeCausticGain({ curvature: -5, strength: 0.6, sharpness: 1 }) <= 1 + 0.6 + 1e-12
  );

  // ── THE SEED (feedback_raw_seed_into_noise_coordinate) ───────────────────
  for (const s of [0, 1, -7, 3.5, 999, 1e9, -1e12, NaN, Infinity, -Infinity, undefined]) {
    const o = computeSeedOffset(s);
    ok(
      `seed ${String(s)} yields a finite, bounded offset`,
      Number.isFinite(o.ox) &&
        Number.isFinite(o.oy) &&
        o.ox >= 0 &&
        o.ox < GLASS_SEED_SPAN &&
        o.oy >= 0 &&
        o.oy < GLASS_SEED_SPAN
    );
  }
  const s1 = computeSeedOffset(1);
  const s2 = computeSeedOffset(2);
  ok('different seeds land on different parts of the field', s1.ox !== s2.ox || s1.oy !== s2.oy);
  // Different multipliers per axis: consecutive seeds must not merely walk the
  // field along one diagonal, which would make seeds 1/2/3 visibly related.
  ok('the two axes are decorrelated, not a shared diagonal', !near(s1.ox - s2.ox, s1.oy - s2.oy, 1e-6));
  ok('the same seed is stable across calls', computeSeedOffset(42).ox === computeSeedOffset(42).ox);
}
