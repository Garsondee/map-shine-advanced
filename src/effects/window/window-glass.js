/**
 * THE GLASS — thick, uneven medieval pane, as refraction. PURE: no THREE, no
 * TSL, no Foundry. `window-render.js` is the TSL transcription of exactly this
 * maths, the same split `window-cookie.js` already uses for the decode.
 *
 * ============================================================================
 * ONE FIELD, THREE CONSEQUENCES — WHY THIS IS A MODEL AND NOT THREE HACKS
 * ============================================================================
 * Author directive (2026-08-05): *"light which has travelled through a thick
 * uneven window pane (medieval blobby glass) and then landed inside the
 * building… distort the light and make a sort of fake caustic highlight and
 * also subtly prism the light in interesting ways."*
 *
 * Three asks — warp, caustic, prism. They are NOT three effects. They are
 * three derivatives of ONE scalar field: the glass's own THICKNESS `h(p)`.
 *
 *   WARP    ← ∇h   (the first derivative)
 *     A wedge of glass deflects a ray toward its THICK side — that is what a
 *     lens is. So the light lands displaced by `refract × ∇h`. Flat glass
 *     (∇h = 0) displaces nothing, which is why every term here vanishes
 *     exactly at `warpPx = 0` rather than merely becoming small.
 *
 *   PRISM   ← ∇h, scaled PER CHANNEL
 *     The refractive index `n` is wavelength-dependent (dispersion): blue
 *     bends more than red. Same gradient, three different magnitudes — so the
 *     split is ALONG the glass's own gradient, not along a fixed screen axis.
 *     That is the whole difference between "this looks like glass" and "this
 *     looks like a chromatic-aberration filter": a CA filter splits radially
 *     from the frame centre and reads as a lens defect; this splits along the
 *     blob structure and reads as material.
 *
 *   CAUSTIC ← ∇²h  (the second derivative)
 *     Where the deflection field CONVERGES, light piles up. Convergence is
 *     the negative divergence of the displacement, and displacement ∝ ∇h, so
 *     convergence ∝ −∇²h. A thick blob is a local maximum (∇²h < 0) and
 *     therefore focuses — a bright knot. A thin dimple defocuses — a dim one.
 *     The caustic is not painted on top; it is the same field read one
 *     derivative further out.
 *
 * That shared origin is load-bearing, not an aesthetic note: the highlight
 * lands exactly where the warp bunches up and the prism fringe wraps it,
 * because all three are reading the same blob. Three independent noise fields
 * tuned to "look related" is the version of this that never quite convinces.
 *
 * ============================================================================
 * WHY THIS IS NOT `aperture-gobo.js`'S GLASS — I LOOKED FIRST
 * ============================================================================
 * `effects/lighting/aperture-gobo.js` ALREADY models medieval glass, and well:
 * `computeApertureGlassWarpOffset` (blob-vs-facet crossfade),
 * `computeApertureFacetWedgeValue` (the cut-glass medallion),
 * `computeApertureGrimeFactor`, `computeAperturePaneIsBroken`. That module was
 * read in full before a line of this one was written — `feedback_negative_
 * grep_became_architecture` is the memory that makes "I searched and found
 * nothing" an unacceptable justification, so this is the positive finding and
 * what came of it.
 *
 * It is a SIBLING, not a shared primitive, for two structural reasons:
 *
 *   1. DIFFERENT PARAMETERIZATION. Aperture-gobo's warp is a ONE-DIMENSIONAL
 *      signed offset along the spoke axis (`sW`), defined against real wall
 *      geometry it has in hand — `wallLen`, `sillPx`, `headPx`, a pane grid.
 *      The window cookie has NO geometry at all (see `window-cookie.js`: the
 *      artist already painted where the light lands). What it needs is a
 *      TWO-DIMENSIONAL displacement VECTOR over an arbitrary painted mask.
 *      A shared helper would have to take the union of both parameter sets
 *      and use half of it — the shape `feedback_mode_forks_silently_drop_
 *      features` warns about, arrived at from the other direction.
 *
 *   2. APERTURE-GOBO HAS NO DISPERSION. Its warp is monochrome — one offset,
 *      applied to all channels alike. The prism is the entire point here, and
 *      it is the term that forces the three-tap structure below. There is no
 *      existing code to reuse for it because it has never existed.
 *
 * The two SHOULD converge later, and the honest place to record that is a
 * deferred rung rather than a premature abstraction over one example.
 *
 * ============================================================================
 * WHY THE NOISE ITSELF IS NOT IN THIS FILE
 * ============================================================================
 * Every function here takes already-SAMPLED field values as plain numbers.
 * That is deliberate and it is `aperture-gobo.js`'s own established shape
 * (`computeApertureGlassWarpOffset({ blobNoise, facetValue, … })`,
 * `computeApertureGrimeFactor({ fbmValue, worleyValue, … })`): the GPU samples
 * the Perlin/fbm field, and the maths that turns those samples into a look is
 * pure, in Node, asserted against named cases.
 *
 * The alternative — porting `mx_noise_float` to JS so the twin could sample
 * its own field — would buy a twin that is only as correct as the port, which
 * is `feedback_smooth_output_hides_ported_bugs` reintroduced at the exact
 * layer the split exists to protect. What matters is that the ARITHMETIC over
 * those samples is right, and that is what `__tests__/window-glass.test.mjs`
 * pins (including against an analytic quadratic, where the true gradient and
 * curvature are known in closed form and the finite differences must agree).
 *
 * @module effects/window/window-glass
 */

/**
 * How far apart the four neighbour taps sit, in the field's OWN normalized
 * units (i.e. after the sample position has been divided by `glassScale`).
 *
 * ⚠️ This is a FEATURE-SIZE choice, not a precision one, and the instinct to
 * shrink it is wrong. A finite difference at ε→0 measures the noise's finest
 * available wiggle; what the look wants is the slope of the BLOB, which lives
 * at roughly the field's own unit scale. Too small and the gradient reads as
 * grain (the warp shimmers and the caustic turns to salt); too large and the
 * blob structure is averaged away into a flat sheet. 0.35 is a little over a
 * third of a feature and reads as "the slope of this blob" at every
 * `glassScale` — the value being in NORMALIZED units is what makes that true
 * independently of the scale slider, rather than needing to be re-tuned
 * against it.
 */
export const GLASS_SAMPLE_EPSILON = 0.35;

/**
 * The red/blue index spread at `dispersion = 1`, as a fraction of the base
 * deflection: red lands at `1 − k`, blue at `1 + k` of green's displacement.
 *
 * ⚠️ FRANKLY EXAGGERATED, AND THE NUMBER IS THE POINT. Real crown glass has
 * an Abbe number around 59, i.e. `(n_F − n_C) / (n_d − 1) ≈ 1/59 ≈ 1.7%`. At
 * `k = 0.45` this model is roughly TWENTY-SIX TIMES that spread. A physically
 * honest 1.7% would move red and blue apart by well under a pixel at any
 * sane `glassWarpPx` and would be invisible — the effect would ship looking
 * like it does nothing, which is the specific failure `feedback_measure_the_
 * output_not_the_equation` names: a correct formula evaluated in a regime
 * that returns nothing.
 *
 * So this is stage lighting, not an ephemeris — the same explicit trade
 * `world/sun.js` makes for the sun's own arc ("cinematic plausibility over
 * physical simulation"). What is preserved from the physics is the STRUCTURE
 * (blue bends further than red, both along the same gradient, magnitude set
 * by one shared deflection); what is abandoned is the scale factor. The
 * `glassDispersion` slider then spans "invisible" to "unmistakable prism"
 * across its own 0..1 range, which is what makes it a usable control.
 */
export const GLASS_DISPERSION_SPREAD = 0.45;

/**
 * How deep the DIVERGING side of a caustic goes, relative to how high the
 * converging side rises. Light that concentrates into a bright knot came from
 * somewhere, so the dark band between knots is real and must not be zero —
 * but at 1:1 the pattern reads as harsh noise rather than as light through
 * glass, because a real diverging region still receives plenty of light from
 * every OTHER part of the pane. Half-depth keeps the darks present and the
 * bright knots dominant.
 *
 * ⚠️ THIS IS THE *ONLY* SOURCE OF BRIGHT/DARK ASYMMETRY, deliberately — see
 * `computeCausticGain`, which shapes the two sides identically so that
 * `sharpness` cannot smuggle in a second, hidden asymmetry of its own.
 *
 * A look constant, not a slider: it trades against `glassCausticStrength`
 * almost exactly, and two knobs that cancel each other is how a panel becomes
 * untunable.
 */
export const GLASS_CAUSTIC_DARK_RATIO = 0.5;

/**
 * ============================================================================
 * THE CURVATURE NORMALISATION — MEASURED, AND THE MEASUREMENT IS THE POINT
 * ============================================================================
 * `computeGlassField` returns curvature in a form bounded by [−2, 2], and the
 * first version of `computeCausticGain` treated that bound as its working
 * range. It is not. On the real two-octave Perlin field this effect actually
 * samples, the curvature is dominated by values FAR smaller: probed on a real
 * WebGPU device through the shader lab's own caustic channel
 * (`tools/shader-lab/bench-window-glass.js`, 28,340 samples, 2026-08-05), the
 * distribution came back
 *
 *     mean ≈ −0.003   modal bins ≈ −0.01 … −0.085   extremes ≈ [−0.93, +0.54]
 *
 * i.e. a TYPICAL magnitude near 0.05, two orders below the theoretical bound.
 * Raising 0.05 to a sharpness power of 2–3 returns ~1e-4 — the bright side was
 * annihilated while the linear dark side kept its full 0.05, so turning the
 * caustic UP made the whole cookie DIMMER. The lab caught it as a failing
 * check (`caustics-raise-the-spread`) on the first run.
 *
 * That is `feedback_measure_the_output_not_the_equation` in its purest form: a
 * formula that is algebraically right, evaluated in a regime where it returns
 * nothing. Both halves of the fix follow from the measurement — this gain, and
 * the symmetric shaping in `computeCausticGain`.
 *
 * ⚠️ WHY NOT THE FIRST-PRINCIPLES VALUE. Undoing the ε²/4 that
 * `computeGlassField` folds away would give `4/ε² ≈ 32.7`, recovering the true
 * ∇²h. That is the mathematically honest constant and it is the WRONG one
 * here: the measured distribution is heavy-TAILED (a typical texel near 0.05,
 * extremes eighteen times that), so a gain sized for the typical value sends
 * the tail far past any bound. 12 puts the typical texel near 0.6 and the
 * strong features near 7 — which only works because they are then compressed
 * rather than clipped, see `softSaturate`.
 */
export const GLASS_CURVATURE_GAIN = 12;

/**
 * A SMOOTH SATURATION, `x / (1 + |x|)` — monotonic, odd, and asymptotic to ±1
 * without ever reaching it.
 *
 * ⚠️ THIS REPLACED A HARD `clamp(x, −1, 1)`, AND THE PICTURE IS WHY. Rendered
 * on the lab with the clamp, the caustic channel came back very nearly BINARY
 * — solid white knots against solid black, with a thin ramp between and no
 * structure inside either. That is the heavy tail described above meeting a
 * hard bound: everything past |x| = 1 flattens onto the same value, and since
 * most of the interesting field IS past 1 after the gain, most of the field
 * became two flat tones. Real light through old glass has a continuous
 * gradient with tight bright filaments, not a stencil.
 *
 * A compressor keeps the ordering everywhere: 0.6 → 0.38, 7 → 0.88. The tail
 * still separates, so bright filaments stay distinct from merely-bright
 * regions, and nothing is ever flat.
 *
 * This is the same shape — and the same reasoning — as
 * `window-cookie.js#softShoulder`, which exists because an unbounded cookie
 * clipped to a flat, textureless white disc over bright art. One effect, two
 * places where a hard bound destroyed the detail it was protecting.
 *
 * @param {number} x @returns {number} in (−1, 1).
 */
export function softSaturate(x) {
  const n = finite(x);
  return n / (1 + Math.abs(n));
}

/** @param {number} x @param {number} lo @param {number} hi @returns {number} */
function clamp(x, lo, hi) {
  const n = Number(x);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** @param {number} x @param {number} [fallback] @returns {number} */
function finite(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * THE FIELD, DIFFERENCED — gradient and curvature from five samples of the
 * glass thickness, taken at the centre and at ±`GLASS_SAMPLE_EPSILON` on each
 * axis.
 *
 * ============================================================================
 * WHY BOTH DERIVATIVES COME OUT OF THE SAME FIVE TAPS
 * ============================================================================
 * The gradient needs the four neighbours; the discrete Laplacian needs the
 * four neighbours AND the centre. So the second derivative — the whole
 * caustic — is very nearly FREE once the first has been paid for. The naive
 * structure (sample the gradient at four offset points to difference IT
 * again) costs sixteen evaluations for the same answer. Five, not sixteen, is
 * what makes the caustic affordable enough to ship on by default.
 *
 * ============================================================================
 * ⚠️ NEITHER OUTPUT IS DIVIDED BY ε — THAT IS DELIBERATE, AND IT IS WHY THE
 * SLIDERS HAVE HONEST UNITS
 * ============================================================================
 * The textbook forms are `(hR − hL) / 2ε` and `(hR + hL + hU + hD − 4hC) / ε²`.
 * Both are correct and both are the wrong shape for a control surface: at
 * ε = 0.35 the ε² divisor alone multiplies the curvature by over EIGHT, so
 * the caustic slider's useful range would sit in a thin sliver near zero and
 * would move if ε were ever retuned.
 *
 * These return the ε-free forms instead — a central difference over 2, and a
 * neighbour-MEAN minus the centre. They are the true derivatives up to a
 * constant factor that depends only on ε, and dropping that factor buys two
 * things that matter more than matching a textbook:
 *
 *   - BOUNDED RANGE. For `h ∈ [−1, 1]` (which is what the Perlin field
 *     delivers) `gradX`/`gradY` land in [−1, 1] and `curvature` in [−2, 2],
 *     by construction rather than by hope.
 *   - AN HONEST SLIDER. Because the gradient is bounded by 1, `glassWarpPx`
 *     multiplies it directly and the number on the slider IS the maximum
 *     displacement in world pixels. "10" means "at most ten pixels", which is
 *     a thing an author can reason about without a calibration pass
 *     (`feedback_probed_constants_vs_derived`: the constant is derived once,
 *     here, not discovered by moving a slider until it looks right).
 *
 * @param {object} samples
 * @param {number} samples.centre - `h` at the sample point.
 * @param {number} samples.left @param {number} samples.right - `h` at ∓ε on X.
 * @param {number} samples.down @param {number} samples.up - `h` at ∓ε on Y.
 * @returns {{gradX: number, gradY: number, curvature: number}}
 */
export function computeGlassField({ centre, left, right, down, up }) {
  const hC = finite(centre);
  const hL = finite(left);
  const hR = finite(right);
  const hD = finite(down);
  const hU = finite(up);
  return {
    gradX: (hR - hL) / 2,
    gradY: (hU - hD) / 2,
    // The neighbour MEAN minus the centre: positive where the point sits in a
    // dip (neighbours higher), negative on a bump. See the header on why this
    // is not divided by ε².
    curvature: (hR + hL + hU + hD) / 4 - hC,
  };
}

/**
 * THE PRISM — the per-channel multipliers on one shared deflection.
 *
 * Red bends LEAST, blue MOST, green sits exactly on the base deflection and
 * is therefore the channel the un-dispersed cookie still lands on. That last
 * detail matters for tuning: turning `glassDispersion` up splits red and blue
 * APART AROUND the green, rather than dragging the whole cookie sideways, so
 * dispersion and warp stay visually independent even though they multiply the
 * same gradient.
 *
 * @param {number} dispersion - `[0,1]`. 0 returns `[1,1,1]` EXACTLY — all
 *   three channels then sample the identical displaced point, which is a pure
 *   warp with no colour separation at all, not merely a small one.
 * @returns {number[]} `[scaleR, scaleG, scaleB]`.
 */
export function computeDispersionScales(dispersion) {
  const d = clamp(dispersion, 0, 1);
  const k = d * GLASS_DISPERSION_SPREAD;
  return [1 - k, 1, 1 + k];
}

/**
 * ONE channel's own displacement, in world pixels — `warpPx × channelScale ×
 * ∇h`, the deflection toward the glass's thick side.
 *
 * ⚠️ THE SIGN IS THE LENS, AND IT IS EASY TO GET BACKWARDS. Deflection is
 * along +∇h, i.e. TOWARD increasing thickness. Check it against the object
 * everyone already knows: a convex lens is thick in the middle and it
 * CONVERGES — rays bend toward the thick centre. Take the sign the other way
 * and every blob becomes a diverging lens, which still produces a plausible
 * wobbly picture (the warp looks fine!) while the caustic term derived from
 * the same field now brightens the DIMPLES and darkens the blobs. That is the
 * `feedback_smooth_output_hides_ported_bugs` shape exactly: a smooth,
 * convincing output from an inverted model. `__tests__/window-glass.test.mjs`
 * pins it against an analytic bump rather than against how it looks.
 *
 * @param {object} args
 * @param {number} args.gradX @param {number} args.gradY - from `computeGlassField`.
 * @param {number} args.warpPx - `glassWarpPx`; 0 is an exact no-op.
 * @param {number} args.channelScale - from `computeDispersionScales`.
 * @returns {{dx: number, dy: number}} world-pixel offset for this channel.
 */
export function computeChannelOffsetPx({ gradX, gradY, warpPx, channelScale }) {
  const w = Math.max(0, finite(warpPx));
  const s = finite(channelScale, 1);
  return { dx: finite(gradX) * w * s, dy: finite(gradY) * w * s };
}

/**
 * THE FAKE CAUSTIC — a brightness gain from the field's own convergence.
 *
 * `curvature` is negative on a thick blob (a converging lens) and positive in
 * a thin dimple, so convergence is its NEGATION — scaled by
 * `GLASS_CURVATURE_GAIN` into the range where shaping actually does something
 * (read that constant's header; it is the fix for a real measured bug).
 *
 * ============================================================================
 * ⚠️ THE POWER SHAPES THE MAGNITUDE AND THE SIGN IS REATTACHED — BOTH SIDES
 * ALIKE. AN EARLIER VERSION SHAPED ONLY THE BRIGHT SIDE AND IT WAS A BUG.
 * ============================================================================
 * The reasoning for shaping only the highlight sounded good: "a sharpness
 * slider that silently deepened the shadows as it tightened the highlights
 * cannot be tuned." What it actually produced was worse than the thing it was
 * avoiding. Because convergence is almost always well BELOW 1, `pow(x, p>1)`
 * SHRINKS it — so a power on the bright side alone made highlights collapse
 * faster than the untouched linear shadows, and raising `sharpness` dimmed the
 * whole cookie. The slider moved two things at once anyway; it just moved them
 * in the least useful direction.
 *
 * Shaping `|convergence|` and reattaching the sign makes `sharpness` mean
 * exactly one thing — how tightly the pattern concentrates, bright and dark
 * together — and leaves `GLASS_CAUSTIC_DARK_RATIO` as the single, named,
 * deliberate source of bright/dark asymmetry.
 *
 * Returns a multiplier ≥ 0 — never negative, so it cannot flip a light into a
 * black hole in the additive buffer (`window-cookie.js`'s own NaN note names
 * that same failure mode one term upstream).
 *
 * @param {object} args
 * @param {number} args.curvature - from `computeGlassField`.
 * @param {number} args.strength - `glassCausticStrength`; 0 returns EXACTLY 1.
 * @param {number} args.sharpness - `glassCausticSharpness`, ≥ 0.5.
 * @returns {number} a gain to multiply the cookie by.
 */
export function computeCausticGain({ curvature, strength, sharpness }) {
  const s = Math.max(0, finite(strength));
  // An exact identity at 0, not an approximate one: "off costs nothing and
  // looks like nothing" is the same discipline computeApertureGrimeFactor
  // states for its own zero.
  if (s <= 0) return 1;
  const p = Math.max(0.5, finite(sharpness, 1));
  const convergence = softSaturate(-finite(curvature) * GLASS_CURVATURE_GAIN);
  // ONE power, on the magnitude; the sign carries the direction back.
  const shaped = Math.pow(Math.abs(convergence), p) * Math.sign(convergence);
  const gain = 1 + s * Math.max(shaped, 0) - s * GLASS_CAUSTIC_DARK_RATIO * Math.max(-shaped, 0);
  // The ceiling is `1 + s` by construction (|shaped| ≤ 1); the floor is the
  // one that needs stating, because `s > 2` would otherwise drive the dark
  // side negative.
  return Math.max(0, gain);
}

/**
 * How far apart two seeds can push the sample point. Large enough that two
 * windows land on genuinely unrelated parts of the field, small enough to sit
 * well inside the precision where the lattice hash still behaves — see
 * `computeSeedOffset`'s own header for why a bound exists at all.
 */
export const GLASS_SEED_SPAN = 512;

/**
 * A bounded 2D offset into the noise field, so two windows on one map do not
 * show the identical blob pattern.
 *
 * ============================================================================
 * ⚠️ THE SEED IS HASHED, NEVER FED IN RAW — THIS IS A NAMED PAST BUG
 * ============================================================================
 * `feedback_raw_seed_into_noise_coordinate`: a raw seed used directly as a
 * noise COORDINATE returns NaN. A seed is an identifier — arbitrary
 * magnitude, arbitrary sign, and in a settings file it can be anything a user
 * typed. Perlin implementations lattice-hash their input, and a coordinate
 * far outside the float precision the lattice arithmetic assumes stops
 * producing a field at all. One NaN then propagates through an ADDITIVE blend
 * into a permanent black hole on the map.
 *
 * So the seed goes through a hash into `[0, GLASS_SEED_SPAN)` first. The two
 * axes use different multipliers so seed 1 does not merely walk the field
 * diagonally (which would make seeds 1, 2, 3 visibly related along one line).
 * Non-finite input lands on 0 rather than propagating, and the test asserts
 * exactly that for NaN, ±Infinity and absurd magnitudes.
 *
 * @param {number} seed
 * @returns {{ox: number, oy: number}} both finite, both in `[0, GLASS_SEED_SPAN)`.
 */
export function computeSeedOffset(seed) {
  const s = finite(seed);
  // `sin`-hash, the standard shader idiom, done HERE in bounded JS-safe form:
  // sin is bounded by construction whatever `s` is, so the only way out of
  // range is a non-finite `s`, which `finite()` already removed.
  const hx = Math.abs(Math.sin(s * 12.9898) * 43758.5453);
  const hy = Math.abs(Math.sin(s * 78.233) * 24634.6345);
  return {
    ox: (hx - Math.floor(hx)) * GLASS_SEED_SPAN,
    oy: (hy - Math.floor(hy)) * GLASS_SEED_SPAN,
  };
}
