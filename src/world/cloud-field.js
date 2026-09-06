/**
 * THE CLOUD FIELD — one analytic function of world position and time that
 * answers "is there cloud here, how thick, and how tall", sampled by every
 * consumer that cares about the sky.
 *
 * ============================================================================
 * WHY THIS IS A `world/` MODULE AND NOT AN EFFECT'S PROPERTY
 * ============================================================================
 *
 * `docs/planning/Clouds.md` §4 (recovered to the author's reference archive —
 * `reference/map-shine-advanced-recovered/Clouds.md` in the Press repo) rules
 * this explicitly, and the reason is the same one `world/wind-field.js` exists
 * for: at least six things want a cloud shadow — the outdoor ambient, window
 * light, specular, water glint, cast shadows and precipitation — and if any
 * ONE of them owned the field, MSA would acquire a second weather system the
 * day the second consumer arrived. That is the `env/one-sun` failure re-run in
 * a new domain, and this codebase has already paid for it twice.
 *
 * So this file is a sibling of `sun.js` and `wind-field.js`: pure, no THREE
 * import (TSL is injected, never imported — Law 8), no Foundry, no clock, no
 * state. `effects/clouds/` owns the manifest, the params and the tier ladder;
 * it reads this.
 *
 * ============================================================================
 * ⭐ THE PHASE IS AN INPUT, NEVER OWNED HERE
 * ============================================================================
 *
 * `driftXY` and `boil` are handed in by whoever owns the frame. That is
 * deliberate and load-bearing: it keeps the multiplayer question ("whose
 * clouds are authoritative?") out of the field entirely. The author's ruling,
 * 2026-09-06: the GM owns the drift, and *"clouds are only ever an effect and
 * never important to gameplay so we don't have to have a perfect sync between
 * clients and GM."* A field that owned its own accumulator would have baked a
 * per-client answer into the one place every consumer reads.
 *
 * ============================================================================
 * ⭐ THE DIORAMA RULE — real RATIOS, never real metres
 * ============================================================================
 *
 * A real fair-weather cumulus is 0.5-2 km across. At a Foundry scene's usual
 * 100 px per 5 ft grid that is 65.6 px/m, so 1 km = 65,600 px — wider than any
 * map this engine will ever draw. A physically-scaled cloud shadow is one flat
 * dimming of the whole map, which is not the effect anybody asked for.
 *
 * So `cloudScalePx` (a weather axis) is the dominant FEATURE WAVELENGTH — cell
 * spacing for cellular types, streak length for cirrus — and every number in a
 * recipe below is a RATIO to it. The ratios are the real ones (cumulus cells
 * are ~1 diameter apart; cirrus streaks run 3-10x longer than they are wide;
 * a mackerel element is a third of a cumulus blob). Absolute metres appear
 * only as a readout, never in the maths. Same doctrine `world/sun.js` states
 * for the sun ("stage lighting for a top-down map, not an ephemeris") and the
 * same shape as `world/wind-scale.js`'s normalised-value-plus-real-units-
 * interpretation split.
 *
 * ============================================================================
 * ⚠️ THE PRECISION TRAP, AND WHY `Clouds.md` §7's OWN FIX CANNOT WORK
 * ============================================================================
 *
 * Clouds.md §7 says to "wrap the drift offset modulo the noise's spatial
 * period". There is no such period. MaterialX's Perlin and Worley are
 * INTEGER-LATTICE HASH functions (`mx_hash_int` over `floor(p)`,
 * `src/vendor/three/three.webgpu.js:53429`) — they are defined on all of R^3
 * and repeat nowhere, so a modulo wrap is a visible jump, not a no-op.
 *
 * What actually degrades is float32 resolution of the sample coordinate at
 * large magnitude. The finest octave sees `p * 2^(octaves-1)`, so the budget
 * is `|drift| / cloudScalePx * 2^(octaves-1) < 2^16` (beyond that the spacing
 * between representable coordinates exceeds ~1/128 of a wavelength and the
 * noise visibly coarsens). At 10 px/s on a 350 px scale with 5 octaves that is
 * about 40 hours of continuous drift; on a 1100 px scale, five days.
 * {@link cloudDriftBudget01} reports where a session currently sits so a
 * diagnostic can say it rather than a comment claiming it, and the honest
 * re-anchor point is `cover01 = 0` — where the field is an exact no-op, so a
 * phase reset is invisible BY CONSTRUCTION rather than by luck.
 *
 * @module world/cloud-field
 */

import { windFlowVectorNode } from './wind-field.js';

// ---------------------------------------------------------------------------
// THE RECIPE — a cloud TYPE is ~14 numbers in SHAPE SPACE, not a noise panel
// ---------------------------------------------------------------------------

/**
 * The five keyframes `cloudType01` sweeps through, in the order a real sky
 * moves through them: **cirrus → altocumulus → cumulus → stratocumulus →
 * stratus**.
 *
 * That order is not arbitrary and it is not just "altitude descending". It is
 * the real morphological continuum, which is what makes a MID-BLEND a real sky
 * rather than a smudge of two unrelated ones:
 *
 *   cirrus → altocumulus     is cirrocumulus
 *   altocumulus → cumulus    is tattered, fast-moving fair-weather cloud
 *   cumulus → stratocumulus  is cumulus flattening under an inversion (the
 *                            transition every meteorology text describes)
 *   stratocumulus → stratus  is a sheet thickening to overcast
 *
 * The `at` positions are chosen so the archetypes ALREADY IN
 * `world/weather-data.js` land on the right look with no edit to that table:
 * `streaks` 0.0 and `high-veil` 0.05 are cirrus; `mackerel` 0.4 and `gale` 0.3
 * sit around altocumulus; `fair-cumulus` 0.5, `ashfall` 0.55 and
 * `thunderstorm` 0.6 are cumulus; `broken` 0.7 and `overcast` 0.9 are
 * stratocumulus; `fog`/`steady-rain`/`hailstorm` at 1.0 are stratus.
 *
 * Every field is a RATIO or a 0..1 amount — see the diorama rule in this
 * module's header. Sources for the morphology behind each number are in
 * `reference/clouds/01-cloud-formation-field.md` §3.
 *
 * @type {ReadonlyArray<Readonly<object>>}
 */
export const CLOUD_KEYFRAMES = Object.freeze([
  Object.freeze({
    at: 0.0,
    name: 'cirrus',
    // Barely cellular: cirrus is fibres, not cells.
    cellWeight: 0.1,
    openCellPeak: 0,
    jitter: 1.0,
    cellScale: 1.0,
    edgeWidth: 0.35, // soft — a cirrus edge is a fade, not a boundary
    erosion: 0.25,
    detailScale: 0.25,
    warp: 0.6, // the streakiness dial; cirrus is heavily domain-warped
    anisotropy: 4.0, // fibres run 4x longer than they are wide
    smear: 0.7,
    gain: 0.62,
    thicknessCap: 0.3, // optical depth 0.03-0.3: the sun stays visible
    reliefGain: 0.1, // nearly flat
    turnover: 5,
    driftMul: 3.0, // jet-level wind
    shearDeg: 15,
    // MEASURED by bisection in the shader lab, not modelled — see COVER_LUT_SAMPLES.
    coverLut: Object.freeze([0.548, 0.503, 0.463, 0.431, 0.399, 0.372, 0.346, 0.32, 0.293, 0.261, 0.217, 0.184, 0.134]),
  }),
  Object.freeze({
    at: 0.35,
    name: 'altocumulus',
    cellWeight: 0.9, // the "mackerel" scales ARE cells
    openCellPeak: 0,
    jitter: 0.45, // LOW jitter = a regular lattice, which is what makes it read as mackerel
    // ⚠️ MULTIPLIES the sample position, so BIGGER means MORE cells and each
    // one SMALLER. Shipped at 0.35 for a day and produced cells 3x too LARGE —
    // the reason altocumulus read as blurry cumulus in the first contact sheet
    // instead of as a mackerel lattice.
    cellScale: 3.0, // many small elements — a third the size of a cumulus blob
    edgeWidth: 0.12,
    erosion: 0.35,
    detailScale: 0.2,
    warp: 0.1,
    anisotropy: 1.6, // rows, from the wave that makes them
    smear: 0.15,
    gain: 0.46,
    thicknessCap: 0.55,
    reliefGain: 0.35,
    turnover: 8,
    driftMul: 2.0,
    shearDeg: 8,
    // MEASURED by bisection in the shader lab, not modelled — see COVER_LUT_SAMPLES.
    coverLut: Object.freeze([
      0.747, 0.714, 0.689, 0.671, 0.654, 0.639, 0.624, 0.609, 0.592, 0.573, 0.548, 0.529, 0.495,
    ]),
  }),
  Object.freeze({
    at: 0.55,
    name: 'cumulus',
    cellWeight: 0.85,
    openCellPeak: 1, // the honeycomb flip lives here and at stratocumulus
    jitter: 1.0, // fully random placement: cumulus is not a lattice
    cellScale: 1.0,
    edgeWidth: 0.1, // crisp
    erosion: 0.55, // the cauliflower
    detailScale: 0.18,
    warp: 0.18,
    anisotropy: 1.15, // slight, from cloud streets
    smear: 0.2,
    gain: 0.42,
    thicknessCap: 1.0, // thick where it is, nothing between
    reliefGain: 1.0, // the towering one
    turnover: 1.5, // 5-40 min lifetime: the fastest-evolving genus
    driftMul: 1.5,
    shearDeg: 3,
    // MEASURED by bisection in the shader lab, not modelled — see COVER_LUT_SAMPLES.
    coverLut: Object.freeze([0.749, 0.723, 0.702, 0.686, 0.658, 0.603, 0.539, 0.572, 0.595, 0.587, 0.567, 0.55, 0.512]),
  }),
  Object.freeze({
    at: 0.8,
    name: 'stratocumulus',
    cellWeight: 0.7,
    openCellPeak: 1,
    jitter: 0.85,
    cellScale: 0.6, // the big mesoscale cells (10-40 km in reality)
    edgeWidth: 0.18,
    erosion: 0.35,
    detailScale: 0.22,
    warp: 0.15,
    anisotropy: 1.1,
    smear: 0.1,
    gain: 0.44,
    thicknessCap: 0.85,
    reliefGain: 0.45,
    turnover: 10, // closed cells stay rigid for >10 h
    driftMul: 1.4,
    shearDeg: 2,
    // MEASURED by bisection in the shader lab, not modelled — see COVER_LUT_SAMPLES.
    coverLut: Object.freeze([0.707, 0.671, 0.642, 0.619, 0.591, 0.541, 0.486, 0.506, 0.52, 0.506, 0.48, 0.46, 0.424]),
  }),
  Object.freeze({
    at: 1.0,
    name: 'stratus',
    cellWeight: 0.15, // a sheet, with only faint mottling
    openCellPeak: 0,
    jitter: 1.0,
    cellScale: 1.0,
    edgeWidth: 0.45, // no edges at all, really
    erosion: 0.15,
    detailScale: 0.3,
    warp: 0.2,
    anisotropy: 1.0,
    smear: 0.05,
    gain: 0.5,
    thicknessCap: 1.0,
    reliefGain: 0.1,
    turnover: 20,
    driftMul: 1.2,
    shearDeg: 0,
    // MEASURED by bisection in the shader lab, not modelled — see COVER_LUT_SAMPLES.
    coverLut: Object.freeze([0.562, 0.501, 0.453, 0.416, 0.379, 0.346, 0.314, 0.282, 0.248, 0.21, 0.16, 0.123, 0.064]),
  }),
]);

/** The recipe fields that are numbers and therefore blend. Order is the
 * uniform push order too, so the two can never drift apart. */
export const CLOUD_RECIPE_KEYS = Object.freeze([
  'cellWeight',
  'openCellPeak',
  'jitter',
  'cellScale',
  'edgeWidth',
  'erosion',
  'detailScale',
  'warp',
  'anisotropy',
  'smear',
  'gain',
  'thicknessCap',
  'reliefGain',
  'turnover',
  'driftMul',
  'shearDeg',
]);

/** Hermite fade, the same `t*t*(3-2t)` every smoothstep in this codebase uses. */
function smoothFade(t) {
  const s = t < 0 ? 0 : t > 1 ? 1 : t;
  return s * s * (3 - 2 * s);
}

/**
 * Resolve the recipe for a point on the type dial.
 *
 * ⚠️ SMOOTHSTEP BETWEEN KEYFRAMES, NOT A LINEAR LERP. A linear blend has a
 * KINK in its derivative at every keyframe, and the weather manager eases
 * `cloudType01` across 90 seconds — so a kink is a moment where the sky
 * visibly changes its mind about what it is becoming. Costs one multiply on
 * the CPU, once per frame.
 *
 * ⚠️ AND IT BLENDS RECIPES, NEVER EVALUATED FIELDS. Blending two finished
 * cloud fields costs double and reads as two ghosts overlapping; blending the
 * NUMBERS THAT MAKE one costs nothing and produces a single coherent sky. This
 * is the whole reason a recipe exists as a data structure at all.
 *
 * @param {number} cloudType01 - 0 cirrus … 1 stratus.
 * @returns {Record<string, number>} the blended recipe.
 */
export function cloudRecipeFor(cloudType01) {
  const t = Number.isFinite(cloudType01) ? Math.min(1, Math.max(0, cloudType01)) : 0.5;
  let hi = 1;
  while (hi < CLOUD_KEYFRAMES.length - 1 && CLOUD_KEYFRAMES[hi].at < t) hi += 1;
  const a = CLOUD_KEYFRAMES[hi - 1];
  const b = CLOUD_KEYFRAMES[hi];
  const span = b.at - a.at;
  const k = smoothFade(span > 1e-6 ? (t - a.at) / span : 0);
  /** @type {Record<string, number>} */
  const out = {};
  for (const key of CLOUD_RECIPE_KEYS) out[key] = a[key] + (b[key] - a[key]) * k;
  // The calibration table blends with everything else — a sky half-way between
  // two genera needs the threshold half-way between their two measured curves,
  // or its coverage would track whichever keyframe happened to be nearer.
  out.coverLut = a.coverLut.map((v, i) => v + (b.coverLut[i] - v) * k);
  return out;
}

// ---------------------------------------------------------------------------
// COVERAGE — making "cover" actually mean cover
// ---------------------------------------------------------------------------

/**
 * The cover values {@link CLOUD_KEYFRAMES}' `coverLut` entries are measured at.
 *
 * Denser at the ends than a uniform grid would be, because that is where the
 * curve moves fastest and where being wrong is most visible: "a nearly clear
 * sky" and "a nearly total overcast" are both states a GM sets deliberately.
 */
export const COVER_LUT_SAMPLES = Object.freeze([0.01, 0.05, 0.12, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99]);

/**
 * The threshold that makes `mean(coverage)` equal `cover01` for this recipe.
 *
 * ⚠️ MEASURED, NOT MODELLED — and the first attempt WAS modelled, which is why
 * this comment exists. The original cut assumed the base shape was roughly
 * normal with mean 0.5 and inverted a Gaussian CDF. The very first contact
 * sheet the shader lab rendered (2026-09-06) showed cover 0.5 arriving as
 * near-total overcast on three of the five keyframes: Schneider's remap LIFTS
 * the base distribution well above 0.5, by an amount that depends on the cell
 * term, so the model was wrong by a different amount for every cloud type.
 *
 * The tables on each keyframe are the output of
 * `tools/shader-lab/cloud-lab.js#calibrateThresholds`, which bisects the real
 * graph on a real GPU until `mean(cov)` equals the target. Worst error across
 * all 65 measured points: **0.000**.
 *
 * ⭐ WHY THIS MATTERS BEYOND LOOKING RIGHT. `cloudCover01` already means "how
 * much of the sky is covered" to `effects/sky-access.js` (`keyStrength =
 * day * (1 - cover)`), to `effects/shadow-access.js`, and to the environmental
 * grade. If this field disagreed, a SCALAR consumer and a SPATIAL consumer
 * would describe different weather on the same map at the same instant —
 * `feedback_shared_field_two_meanings_two_registries` with pixels.
 *
 * ⚠️ THE CURVE IS NOT MONOTONE for cumulus and stratocumulus, and that is real
 * rather than measurement noise: their cell polarity flips through the middle
 * of the dial (open cells at cover ~0.5), which reshapes the distribution the
 * threshold is cutting. A closed-form fit would have to model that flip; a
 * table simply records it.
 *
 * @param {number} cover01
 * @param {{coverLut: ReadonlyArray<number>}} recipe
 * @returns {number}
 */
export function coverThreshold(cover01, recipe) {
  const c = Number.isFinite(cover01) ? Math.min(1, Math.max(0, cover01)) : 0;
  // EXACTLY zero cover is EXACTLY no cloud — not "very little". The base shape
  // cannot reach this threshold, so `cov` is 0, every transmittance is 1, and a
  // clear-sky frame is bit-identical to one with the feature absent. That is
  // what lets clouds default ON without changing a single existing scene, the
  // same discipline `sky-access.js`'s `realism01 = 0` takes.
  if (c <= 0) return 8;
  if (c >= 1) return -8;
  const lut = recipe.coverLut;
  const xs = COVER_LUT_SAMPLES;
  if (c <= xs[0]) return lut[0];
  if (c >= xs[xs.length - 1]) return lut[lut.length - 1];
  let i = 1;
  while (i < xs.length - 1 && xs[i] < c) i += 1;
  const t = (c - xs[i - 1]) / (xs[i] - xs[i - 1]);
  return lut[i - 1] + (lut[i] - lut[i - 1]) * t;
}

// ---------------------------------------------------------------------------
// DRIFT AND EVOLUTION
// ---------------------------------------------------------------------------

/**
 * How fast the shape changes at a dead calm, in noise units per second. Small
 * but not zero: a sky that is perfectly frozen on a still day reads as a
 * paused video, and clouds do keep boiling with no wind at all.
 */
export const CLOUD_CALM_BOIL_PER_SEC = 3.3e-4;

/**
 * One step of the cloud phase.
 *
 * ⭐ EVOLUTION IS TIED TO DISTANCE DRIFTED, NOT TO WALL TIME. `turnover` is
 * "how many of its own diameters does a cloud travel before it is a different
 * cloud" — 1.5 for cumulus (whose real lifetime is 5-40 minutes), 10 for
 * stratocumulus (whose cells stay rigid for hours), 20 for stratus. Keying it
 * to distance rather than to seconds is what makes a fast-moving sky also a
 * fast-CHANGING sky, automatically, with no second dial to keep in agreement.
 *
 * ⚠️ NO ACCELERATE-FAST/DECELERATE-SLOW ASYMMETRY HERE, deliberately, even
 * though V2's `cloud-wind-advection.js` had one (`driftDecelFactor` 0.14) and
 * it is genuinely part of why V2's clouds felt like weather. The weather
 * manager's own axis eases ALREADY carry that asymmetry
 * (`world/weather.js#WEATHER_AXES`, 45 s up / 60 s down on cover; the wind
 * setpoint likewise). Applying it a second time here would make clouds lag the
 * wind twice — a smooth, plausible-looking wrongness of exactly the kind this
 * codebase keeps a memory about.
 *
 * ⚠️ PREVAILING WIND ONLY. Never `openness`, `wallProximity` or `windShadow`
 * — a cloud at altitude does not care that there is a wall. A cloud that
 * slowed down over a courtyard would be a bug that looked like a feature.
 *
 * @param {object} args
 * @param {number} args.dtSec
 * @param {number} args.windDirX - unit flow vector X (`windFlowVector`).
 * @param {number} args.windDirY
 * @param {number} args.windSpeedPxPerSec - the ambient wind's own speed, in
 *   world px/s, BEFORE this recipe's altitude multiplier.
 * @param {number} args.scalePx - `cloudScalePx`.
 * @param {{driftMul: number, turnover: number}} args.recipe
 * @returns {{dx: number, dy: number, dBoil: number}}
 */
export function cloudDriftStep({ dtSec, windDirX, windDirY, windSpeedPxPerSec, scalePx, recipe }) {
  const dt = Number.isFinite(dtSec) && dtSec > 0 ? Math.min(dtSec, 0.5) : 0;
  const speed = (Number.isFinite(windSpeedPxPerSec) ? windSpeedPxPerSec : 0) * recipe.driftMul;
  const dx = windDirX * speed * dt;
  const dy = windDirY * speed * dt;
  const scale = Number.isFinite(scalePx) && scalePx > 1 ? scalePx : 1000;
  const travelled = Math.hypot(dx, dy);
  const turnover = Math.max(0.1, recipe.turnover);
  const dBoil = travelled / (scale * turnover) + CLOUD_CALM_BOIL_PER_SEC * dt;
  return { dx, dy, dBoil };
}

/**
 * How much of the float32 coordinate budget the current phase has spent, 0..1.
 * See this module's header for the derivation. A diagnostic prints it; the
 * honest re-anchor moment is `cover01 = 0`.
 *
 * @param {number} driftMagnitudePx
 * @param {number} scalePx
 * @param {number} octaves
 * @returns {number}
 */
export function cloudDriftBudget01(driftMagnitudePx, scalePx, octaves) {
  const scale = Number.isFinite(scalePx) && scalePx > 1 ? scalePx : 1000;
  const finest = Math.pow(2, Math.max(0, (octaves | 0) - 1));
  return Math.min(1, Math.abs(driftMagnitudePx || 0) / scale / 65536) * finest;
}

// ---------------------------------------------------------------------------
// THE TSL GRAPH
// ---------------------------------------------------------------------------

/**
 * The uniform set the field graph reads. Created once per material; the CPU
 * resolves a recipe each frame and pushes it here.
 *
 * ⚠️ THE RECIPE IS UNIFORMS, NOT BUILD-TIME CONSTANTS, and that is not a
 * missed folding opportunity. `cloudType01` is a weather axis the manager
 * EASES over 90 seconds; baking recipe values into the graph would mean
 * recompiling the shader every frame of that ease. The OCTAVE COUNT is the
 * one thing that stays a JS number, because it is the tier (Effects.md Law 4:
 * tier selection is a JS `if` at graph-build time, never a uniform).
 *
 * @param {object} TSL
 * @returns {object}
 */
export function createCloudUniforms(TSL) {
  const { uniform, float, vec2 } = TSL;
  const u = {
    /** World-px drift offset, CPU-integrated. See the header on the phase. */
    drift: uniform(vec2(0, 0)),
    /** The third noise axis. Advanced by {@link cloudDriftStep}. */
    boil: uniform(float(0)),
    /** Unit flow vector, from `windFlowVectorNode` — never hand-rolled trig. */
    windDir: uniform(vec2(0, -1)),
    scalePx: uniform(float(1100)),
    cover: uniform(float(0)),
    threshold: uniform(float(8)),
  };
  for (const key of CLOUD_RECIPE_KEYS) u[key] = uniform(float(0));
  return u;
}

/**
 * Push a resolved frame into the uniform set. One place, so the CPU-side
 * recipe and the GPU-side one can never disagree.
 *
 * @param {object} uniforms - from {@link createCloudUniforms}.
 * @param {object} frame
 * @param {Record<string, number>} frame.recipe
 * @param {number} frame.cover01
 * @param {number} frame.scalePx
 * @param {{x: number, y: number}} frame.drift
 * @param {number} frame.boil
 * @param {{x: number, y: number}} frame.windDir
 */
export function pushCloudUniforms(uniforms, { recipe, cover01, scalePx, drift, boil, windDir }) {
  uniforms.drift.value.set(drift.x, drift.y);
  uniforms.boil.value = boil;
  uniforms.windDir.value.set(windDir.x, windDir.y);
  uniforms.scalePx.value = scalePx;
  uniforms.cover.value = cover01;
  uniforms.threshold.value = coverThreshold(cover01, recipe);
  for (const key of CLOUD_RECIPE_KEYS) uniforms[key].value = recipe[key];
}

/**
 * The sum of `octaves` amplitudes at the given diminish — what
 * `mx_fractal_noise_float` can maximally return, used to normalise its output
 * back into a predictable range. Verified against the vendored implementation
 * (`three.webgpu.js:53739`): it is a `Loop` accumulating
 * `amplitude * mx_perlin_noise_float(p)` with `amplitude *= diminish` and
 * `p *= lacunarity` each step, with no normalisation of its own.
 *
 * @param {number} octaves @param {number} diminish @returns {number}
 */
export function fbmAmplitudeSum(octaves, diminish) {
  const n = Math.max(1, octaves | 0);
  if (Math.abs(diminish - 1) < 1e-6) return n;
  return (1 - Math.pow(diminish, n)) / (1 - diminish);
}

/**
 * Build the cloud field as TSL nodes.
 *
 * Returns three 0..1 floats:
 *   `cov`       the silhouette — is there cloud here
 *   `thickness` optical thickness — drives shadow depth and the tops' opacity
 *   `height`    relief — read ONLY by the tops' lighting, never by the shadow
 *
 * Cost class C1 throughout: pure ALU, zero bytes of memory read. No texture,
 * no render target, no storage buffer, no asset. On a bandwidth-bound renderer
 * that is close to free real estate, and it is why this scales to 4K without a
 * resolution scale.
 *
 * @param {object} TSL - `THREE.TSL`, injected.
 * @param {object} args
 * @param {*} args.worldXY - vec2 node, world px.
 * @param {object} args.uniforms - from {@link createCloudUniforms}.
 * @param {number} [args.octaves] - THE TIER. A JS number, folded at build time.
 * @param {boolean} [args.warp] - build the domain-warp stage at all (tier).
 * @param {boolean} [args.erode] - build the erosion stage at all (tier).
 * @param {boolean} [args.cells] - build the Worley stage at all (tier).
 * @returns {{cov: *, thickness: *, height: *, base: *}}
 */
export function buildCloudFieldNode(
  TSL,
  { worldXY, uniforms: u, octaves = 4, warp = true, erode = true, cells = true }
) {
  const { float, vec2, vec3, mix, clamp, smoothstep, pow, exp, dot, mx_fractal_noise_float, mx_worley_noise_float } =
    TSL;

  const inv = float(1).div(u.scalePx.max(float(1)));
  const p0 = worldXY.add(u.drift).mul(inv).toVar('cloudP0');

  // ── 1. ANISOTROPY — stretch ALONG the wind ────────────────────────────────
  // Cirrus fibres and cloud streets both run downwind. ONE stretch, applied
  // before anything reads a position, so every octave and the cell term stay
  // locked to each other — the same discipline `squall-field.js` states as its
  // own trap 2 ("never let per-band UV offsets advect independently").
  //
  // ⚠️ NOT `.normalize()`d here: `pushCloudUniforms` always writes a unit
  // vector (it comes from `windFlowVector`, which is unit by construction), and
  // normalising a (0,0) uniform — the value a not-yet-pushed material holds —
  // produces NaN, which propagates to a black frame with no error anywhere.
  const a = u.windDir.toVar('cloudWindDir');
  const b = vec2(a.y.negate(), a.x).toVar('cloudWindPerp');
  const along = dot(p0, a).div(u.anisotropy.max(float(0.05)));
  const across = dot(p0, b);
  const p1 = a.mul(along).add(b.mul(across)).toVar('cloudP1');

  // ── 2. DOMAIN WARP (Quilez) ───────────────────────────────────────────────
  // Two cheap fBm evaluations at CONSTANT offsets make a 2-D warp out of a
  // scalar noise. The offsets are Quilez's own (5.2,1.3)/(1.7,9.2) — arbitrary
  // but decorrelated, and reusing his keeps them recognisable to anyone who
  // has read the article.
  let pw = p1;
  if (warp) {
    const wx = mx_fractal_noise_float(vec3(p1.x.add(float(5.2)), p1.y.add(float(1.3)), u.boil), 2, 2, 0.5, 1);
    const wy = mx_fractal_noise_float(vec3(p1.x.add(float(1.7)), p1.y.add(float(9.2)), u.boil), 2, 2, 0.5, 1);
    pw = p1.add(vec2(wx, wy).mul(u.warp)).toVar('cloudPw');
  }

  // ── 3. THE BASE SHAPE — Perlin fBm remapped by a Worley cell term ─────────
  // Perlin alone reads as smoke; Worley alone as bubble wrap. The REMAP of one
  // by the other is what reads as cloud — Schneider's Perlin-Worley, GPU Pro 7.
  // ⚠️ `gain` (the fBm's amplitude falloff) IS A UNIFORM, and it was declared
  // on every keyframe but hard-coded to 0.5 in this call for the first day of
  // this file's life — so all five cloud types shared one detail spectrum and
  // looked like five weights of the same smoke. Low gain (0.42, cumulus) puts
  // the energy in the big octaves and gives solid rounded bodies; high gain
  // (0.62, cirrus) spreads it into the fine ones and gives wisps.
  //
  // The normalisation has to track it: `mx_fractal_noise_float` does NOT
  // normalise (verified — `three.webgpu.js:53739` is a bare accumulation
  // loop), so the divisor is the geometric sum of the amplitudes it will
  // actually use. `octaves` is a build-time constant, `gain` is not, so the
  // sum is computed in-shader — three instructions, and it keeps `per01` in
  // 0..1 for every gain the dial can reach.
  const g = u.gain.clamp(0.05, 0.95);
  const ampSum = float(1)
    .sub(pow(g, float(octaves)))
    .div(float(1).sub(g))
    .max(float(1e-3));
  const perRaw = mx_fractal_noise_float(vec3(pw.x, pw.y, u.boil), octaves, 2, g, 1);
  const per01 = clamp(perRaw.div(ampSum).mul(float(0.5)).add(float(0.5)), 0, 1).toVar('cloudPer01');

  let base = per01;
  if (cells) {
    // `mx_worley_noise_float` returns the EUCLIDEAN F1 DISTANCE to the nearest
    // feature point, in cell units (`three.webgpu.js:54013` takes the sqrt) —
    // LOW at a cell's centre, HIGH at its edges.
    //
    // ⚠️ THE POLARITY IS THE OPPOSITE OF WHAT IT LOOKS LIKE, and the design
    // doc had it backwards until the bench rendered it. In the Nubis remap
    // below, a HIGH cell term LOWERS the shape (it lets the Perlin reach zero),
    // and a LOW cell term LIFTS it. So passing `W` straight through lifts the
    // CENTRES of cells → round blobs (cumulus, and closed-cell stratocumulus
    // at high cover). Passing `1 - W` lifts the EDGES → a honeycomb of walls
    // around clear centres, which is open-cell convection.
    const w = clamp(
      mx_worley_noise_float(vec3(pw.mul(u.cellScale.max(float(0.05))), u.boil.mul(float(0.5))), u.jitter),
      0,
      1
    );
    // THE CELL-POLARITY FLIP, as one bell curve on cover (Weather-Manager.md
    // §3.1's capability request). Real skies do this: scattered cumulus are
    // blobs, a half-covered sky organises into open cells with clear centres,
    // and a nearly-full sky closes back into a sheet with holes. Blobs and
    // sheet-with-holes are the SAME basis at different thresholds — cover
    // already moves the threshold — so the only genuine flip is the ring
    // regime in the middle.
    // ⚠️ `x.mul(x)`, NEVER `pow(x, 2)`. GLSL's `pow` is UNDEFINED for a
    // negative base, and `cover - 0.5` is negative for exactly half the dial's
    // range — the half where scattered cumulus live. This compiles, runs, and
    // produces driver-dependent garbage below cover 0.5.
    const ringX = u.cover.sub(float(0.5)).div(float(0.14));
    const ring = u.openCellPeak.mul(exp(ringX.mul(ringX).negate()));
    const cell = mix(w, float(1).sub(w), clamp(ring, 0, 1)).toVar('cloudCell');
    // Nubis's remap: Remap(perlin, -(1 - cell), 1, 0, 1).
    const lo = float(1).sub(cell).negate();
    const remapped = per01.sub(lo).div(float(1).sub(lo).max(float(1e-4)));
    base = mix(per01, clamp(remapped, 0, 1), u.cellWeight).toVar('cloudBase');
  }

  // ── 4. COVERAGE ───────────────────────────────────────────────────────────
  // A calibrated threshold, so `mean(cov)` tracks `cloudCover01` and this
  // field agrees with every SCALAR consumer of the same axis. At cover 0 the
  // threshold is unreachable and this is exactly 0 — a provable no-op.
  let cov = smoothstep(u.threshold, u.threshold.add(u.edgeWidth.max(float(0.01))), base).toVar('cloudCov');

  // ── 5. EROSION — high-frequency detail eats the LOW end ───────────────────
  // Always INSIDE the low-frequency hull, never outside it: that is what keeps
  // detail from inventing cloud where the shape says there is none, and it is
  // the half of Schneider's model that makes edges read as cauliflower rather
  // than as noise laid over a blob.
  if (erode) {
    // High octaves are dragged downwind by `smear`, so fibres TRAIL a body
    // while the body itself stays put — Weather-Manager.md §3.1's "downwind
    // smear warp on high octaves" request, and what makes cirrus read as
    // moving even in a still frame.
    const ph = pw.add(a.mul(u.smear.mul(float(0.5)))).div(u.detailScale.max(float(0.02)));
    // ⚠️ WORLEY, NOT PERLIN, and this is what cauliflower is made of. The
    // first cut eroded with a 2-octave Perlin fBm and the close-up render came
    // back with SMOKY, FEATHERY edges — correct in silhouette, wrong in
    // character, because Perlin's level sets are smooth and smoke-like while a
    // cumulus edge is a pile of rounded lobes. `1 - worley` IS a pile of
    // rounded lobes. Schneider's model uses high-frequency Worley here for
    // exactly this reason; the erosion is where a cloud gets its surface.
    // ⭐ TWO OCTAVES, NOT ONE — a single Worley evaluation is a raw F1
    // distance field, and its cell walls are perfectly sharp, single-frequency
    // valleys: geometric and crystalline rather than organic. Real cauliflower
    // detail is FRACTAL — lobes on lobes — which is exactly what a second,
    // finer, lower-amplitude octave adds. This is also what the design doc
    // (`reference/clouds/01-cloud-formation-field.md` §4.4) always specified
    // ("2 [evals] (erosion)") — the first cut under-built it to one tap, and
    // a close-up render is what exposed the gap between doc and code.
    const hfA = float(1).sub(mx_worley_noise_float(vec3(ph.x, ph.y, u.boil.mul(float(2))), 1));
    const hfB = float(1).sub(
      mx_worley_noise_float(vec3(ph.x.mul(float(2.3)), ph.y.mul(float(2.3)), u.boil.mul(float(2.6))), 1)
    );
    const hf01 = clamp(hfA.mul(float(0.65)).add(hfB.mul(float(0.35))), 0, 1);
    // Wispy where the cloud is thin, billowy where it is thick — Schneider's
    // own `mix(hf, 1 - hf, height)` idea, re-keyed from vertical height (which
    // a 2.5-D field does not have) to COVERAGE, which is the analogous "how
    // deep into the cloud am I" quantity here.
    const hf = mix(hf01, float(1).sub(hf01), smoothstep(float(0.15), float(0.6), cov));
    const lo = hf.mul(u.erosion).mul(float(0.2));
    cov = clamp(cov.sub(lo).div(float(1).sub(lo).max(float(1e-4))), 0, 1).toVar('cloudCovEroded');
  }

  // ── 6. THICKNESS AND RELIEF ───────────────────────────────────────────────
  //
  // ⚠️ THICKNESS IS DRIVEN BY HOW FAR THE BASE CLEARS THE THRESHOLD, NOT BY
  // THE COVERAGE MASK — and the first cut got this wrong in a way that only a
  // close-up render revealed. `cov` is a SMOOTHSTEP, so it SATURATES at 1
  // everywhere the base is more than `edgeWidth` past the threshold, which for
  // cumulus is most of every cloud. Thickness derived from it was therefore a
  // flat 1.0 across each cloud's whole interior: the contact sheet looked fine
  // (the shapes are in `cov`, and at a distance every cloud is mostly edge),
  // and the portrait render at 7000 px across came out as FLAT WHITE CUT-OUTS
  // with no internal structure at all.
  //
  // That is not only ugly, it is structurally fatal to the tops: `height` is
  // derived from thickness, so a flat interior means a flat NORMAL, which means
  // the tops shader would light a billowing cumulus field as a sheet of paper.
  // `Clouds.md` §3.3's own warning — "judge the tops by coverage and headroom,
  // never the mean; a layer whose average brightness is correct can still be a
  // flat wash with no relief anywhere" — is exactly this failure, caught early.
  //
  // `excess` keeps the un-saturated signal: how deep past the threshold this
  // point sits, normalised by the headroom available above it. A small puff
  // that barely clears is thin; the middle of a big mass is thick.
  const headroom = float(1).sub(u.threshold).max(float(0.15));
  const excess = clamp(base.sub(u.threshold).div(headroom), 0, 1).toVar('cloudExcess');
  // The floor keeps a fully-covered sky from going perfectly uniform (real
  // overcast still has structure in it), while the power curve puts most of the
  // variation in the first part of the range, where the eye reads edges.
  const thickness = cov
    .mul(mix(float(0.3), float(1), pow(excess, float(0.75))))
    .mul(u.thicknessCap)
    .toVar('cloudThickness');
  const height = thickness.mul(u.reliefGain).toVar('cloudHeight');

  return { cov, thickness, height, base };
}

/**
 * The one node every SHADOW consumer reads: how much of the sun survives the
 * cloud at this world position, 1 = full sun.
 *
 * ⚠️ THE FLOOR IS DERIVED, NOT AUTHORED. Under a broken-cumulus shadow the
 * ground still receives the whole sky dome — measured diffuse fractions put it
 * near 30 % of clear-sky global irradiance — so a cloud shadow can never take
 * the ground to black. `effects/sky-access.js` already splits the outdoor
 * light into a key (the sun disc) and a fill (the dome), so the deepest a
 * cloud shadow can possibly go IS the fill's own share of the total. Passing
 * that share in here means the depth is correct at every hour for free: at
 * dawn the key is weak so cloud shadows are shallow, and at night
 * `key.strength` is 0 so `fillShare` is 1 and there is no cloud shadow at all.
 *
 * Nobody tunes this. The effect card carries a BIAS on it, the same way
 * `sun-shadows.js#softnessBias` biases the shared atmospheric model rather
 * than declaring a second one.
 *
 * @param {object} TSL
 * @param {object} args
 * @param {*} args.thickness - the field's thickness node.
 * @param {*} args.fillShare - float node, `fill/(key+fill)` from the sky handle.
 * @param {*} [args.depthBias] - float node, the card's own bias (1 = neutral).
 * @returns {*} float node, 0..1.
 */
export function buildCloudKeyTransmittanceNode(TSL, { thickness, fillShare, depthBias = null }) {
  const { float, mix, clamp } = TSL;
  const t = depthBias ? clamp(thickness.mul(depthBias), 0, 1) : thickness;
  return mix(float(1), fillShare, t);
}

/**
 * The unit flow vector clouds drift along: the prevailing wind's own bearing
 * plus this deck's shear.
 *
 * Delegates to `world/wind-field.js#windFlowVectorNode` rather than writing
 * `sin`/`cos` of a bearing here — the settled convention (a compass bearing,
 * 0 = north, clockwise, naming where the wind blows TOWARD) has exactly one
 * implementation and three files have already had to be repaired for rolling
 * their own.
 *
 * @param {object} TSL
 * @param {*} directionDeg - the ambient wind bearing node.
 * @param {*} shearDeg - this deck's own offset node.
 * @returns {*} vec2 node.
 */
export function cloudFlowVectorNode(TSL, directionDeg, shearDeg) {
  return windFlowVectorNode(TSL, directionDeg.add(shearDeg));
}
