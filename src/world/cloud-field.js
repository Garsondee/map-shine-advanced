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
    cellScaleVariation: 0, // barely cellular to begin with — nothing to vary
    edgeWidth: 0.35, // soft — a cirrus edge is a fade, not a boundary
    erosion: 0.25,
    edgeChaos: 0, // already a fade, not a boundary — nothing here to chaos-up
    detailScale: 0.25,
    shadeDetail: 0, // nearly flat (reliefGain 0.1) — no relief here to sculpt
    warp: 0.6, // the streakiness dial; cirrus is heavily domain-warped
    // The type the "most machine generated" report (2026-09-07) named
    // directly — densely packed cirrus read as parallel wood-grain, one
    // uniform streak direction for as far as the frame shows. See
    // REGIONAL VARIATION in `buildCloudFieldNode` for the mechanism; this is
    // the largest wander of any keyframe because cirrus has the most
    // anisotropy (4.0) for it to visibly bend. Swept 0/35/50/65/80 at a wide
    // (viewPx 16000) dense reference render: no fold artifact at any of
    // these (unlike the rotation-frequency mistake caught in the same pass
    // — see REGIONAL VARIATION's own note), just progressively richer
    // marbling; 50 was kept rather than pushed further for no clear gain.
    streakWander: 50,
    anisotropy: 4.0, // fibres run 4x longer than they are wide
    smear: 0.7,
    gain: 0.62,
    thicknessCap: 0.3, // optical depth 0.03-0.3: the sun stays visible
    reliefGain: 0.1, // nearly flat
    turnover: 5,
    driftMul: 3.0, // jet-level wind
    shearDeg: 15,
    // MEASURED by bisection in the shader lab, not modelled — see COVER_LUT_SAMPLES.
    coverLut: Object.freeze([0.553, 0.497, 0.456, 0.425, 0.394, 0.367, 0.341, 0.315, 0.287, 0.255, 0.213, 0.18, 0.121]),
    // MEASURED by bisection against the cells:false pass — see calibrateMacroThresholds.
    macroCoverLut: Object.freeze([
      0.536, 0.479, 0.436, 0.405, 0.374, 0.346, 0.32, 0.293, 0.265, 0.233, 0.19, 0.156, 0.095,
    ]),
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
    // The type the "most machine generated" report (2026-09-07) named
    // directly, together with cirrus — densely packed altocumulus read as
    // one uniform cobblestone tile, every mackerel cell almost exactly the
    // same size for as far as the frame shows. See REGIONAL VARIATION in
    // `buildCloudFieldNode`: drifts cell size +/-55% region to region so a
    // large dense deck breaks into visibly different-sized patches instead
    // of one repeating lattice spacing. Deliberately NOT `jitter` — that
    // still has to stay low and uniform for the lattice to read as mackerel
    // at all (see this file's own established lesson, `jitter`'s comment
    // above); this varies the SIZE of the lattice, region to region, not its
    // internal regularity. Unlike `streakWander`, size modulation has no
    // rotation to fold, so it was safe to confirm clean at the FASTER of the
    // two regional frequencies (`REGION_FREQ_SIZE`) with no ceiling found.
    cellScaleVariation: 0.55,
    edgeWidth: 0.12,
    erosion: 0.35,
    edgeChaos: 0.05, // see cumulus's own note — scaled down, mackerel walls are thin already
    // ⚠️ WAS 0.2 — the SAME order of magnitude as every other keyframe's
    // `detailScale`, which is exactly the bug (author, 2026-09-06, after the
    // warp/wall-breach fixes below had already landed: "Alto is still very
    // obviously cells"). `detailScale` is not an absolute size, it is a
    // DIVISOR applied to the already-`cellScale`-independent warped position
    // (`ph = pw / detailScale`, § EROSION below), so its size relative to the
    // MAIN cell lattice is what matters, not its raw value. That relative
    // size is `detailScale * cellScale`: cumulus (detailScale 0.18,
    // cellScale 1.0) works out to 0.18; stratocumulus (0.22, 0.6) to 0.132 —
    // both read fine. Altocumulus's OWN cells are 3x smaller to begin with
    // (`cellScale: 3.0`, above), so its unchanged detailScale of 0.2 worked
    // out to 0.6 — three to four times coarser, relative to its own cell
    // size, than the two keyframes that don't have this complaint. The
    // erosion Worley noise was, in effect, laying down a SECOND lattice of
    // cell-like creases at nearly the same scale as the main one, rather
    // than fine surface micro-texture on top of it — confirmed by isolating
    // `dbg-normalz` at a wide (viewPx 6500) reference render: the baseline
    // shows a busy quilted/bubble-wrap texture across every cloud body, on
    // top of the (correctly warped and wall-breached) main cell boundaries.
    // Retargeting to the SAME relative scale as cumulus (0.18) — i.e.
    // `0.18 / cellScale` = 0.06 — removed the quilting in `dbg-normalz` and
    // in the lit `tops` render at both cover 0.45 and 0.68, while leaving the
    // main cell shapes (and their own warp-bent, partially-breached walls)
    // completely untouched. Swept 0.2/0.10/0.06/0.03 first: 0.03 is barely
    // different from 0.06 (erosion detail is already near its noise floor by
    // then), so 0.06 was kept rather than pushed further for no visible gain.
    detailScale: 0.06,
    shadeDetail: 0, // thin (thicknessCap 0.55) — little relief here to add a knuckle scale to
    // ⚠️ WAS 0.1, THE LOWEST OF ANY KEYFRAME — and that is exactly why the
    // cell walls read as dead-straight ruled LINES rather than organic seams
    // (author, 2026-09-06: "the walls of the cells are too obviously lines
    // between blobs"). A Worley F1 distance field has a genuine kink in its
    // GRADIENT along the perpendicular bisector between two feature points —
    // a real geometric crease, not a rendering artefact — and almost nothing
    // was bending that crease away from dead-straight. `jitter` (0.45, LOW,
    // unchanged) controls FEATURE-POINT REGULARITY — how evenly spaced the
    // cells are, which is what "mackerel" needs and must not be touched.
    // `warp` is the orthogonal lever: it distorts the SAMPLING DOMAIN before
    // any noise is evaluated, so it bends the crease's shape without moving
    // the underlying lattice's spacing. Swept 0.1/0.18/0.28/0.4/0.5/0.8 in
    // the shader lab (tools/shader-lab/cloud-lab.js's `recipeOverride` hook):
    // below ~0.2 the walls stay visibly ruled; at 0.5 the cells start folding
    // into marbled streaks and losing their honeycomb identity; at 0.8 the
    // lattice is gone entirely (a swirl, not mackerel). 0.28 sits in the
    // window that bends every wall while keeping cells visually distinct,
    // confirmed at both cover 0.3 and 0.6 and at two view scales.
    warp: 0.28,
    streakWander: 4, // mackerel rows are meant to look combed — barely any wander
    anisotropy: 1.6, // rows, from the wave that makes them
    smear: 0.15,
    gain: 0.46,
    thicknessCap: 0.55,
    reliefGain: 0.35,
    turnover: 8,
    driftMul: 2.0,
    shearDeg: 8,
    // MEASURED by bisection in the shader lab, not modelled — see COVER_LUT_SAMPLES.
    coverLut: Object.freeze([0.746, 0.712, 0.688, 0.669, 0.652, 0.637, 0.623, 0.608, 0.593, 0.575, 0.55, 0.529, 0.493]),
    // MEASURED by bisection against the cells:false pass — see calibrateMacroThresholds.
    macroCoverLut: Object.freeze([
      0.616, 0.569, 0.533, 0.506, 0.48, 0.458, 0.438, 0.418, 0.396, 0.37, 0.335, 0.306, 0.256,
    ]),
  }),
  Object.freeze({
    at: 0.55,
    name: 'cumulus',
    cellWeight: 0.85,
    openCellPeak: 1, // the honeycomb flip lives here and at stratocumulus
    jitter: 1.0, // fully random placement: cumulus is not a lattice
    cellScale: 1.0,
    cellScaleVariation: 0.3, // see altocumulus's own note — a dense sky is not one uniform blob size
    // ⚠️ WIDENED FROM 0.10 (2026-09-06, author: "make cumulus/stratocumulus
    // grainy and fuzzy... fade into wispy clouds like stratus around the
    // edges"). A narrow edgeWidth gives a NARROW spatial transition band —
    // even with erosion eating into it, a narrow band still reads as "a
    // rounded blob with a damaged edge", not "fraying into wisps". Widening
    // it gives the SAME erosion noise a much bigger transition zone to work
    // across, which is what turns cauliflower into trailing tendrils.
    edgeWidth: 0.24,
    erosion: 0.55, // the cauliflower
    // The type the "very hard edge around the raised parts" report named
    // directly, and the one the edge-chaos mechanism (§ EDGE CHAOS in
    // `buildCloudFieldNode`) was tuned against. Swept 0/0.5/1/2/4/8 first —
    // ALL of those read as television static, the whole body stippled, not
    // just the edges (the `4·cov·(1-cov)` weighting is nonzero across a wide
    // mid-coverage band, not a thin line, so a strong amplitude floods that
    // whole band). Re-swept at 0/0.03/0.06/0.1/0.15/0.25: 0.12 is where a
    // wide (viewPx 6500) reference render shows a genuinely more frayed,
    // broken-up edge character without yet reading as sandpaper.
    edgeChaos: 0.12,
    detailScale: 0.18,
    // The type the "shading needs to be higher frequency" report (2026-09-07)
    // named directly — see § SHADING DETAIL in `buildCloudFieldNode`. Highest
    // of any keyframe: cumulus is "the towering one" (reliefGain 1.0,
    // thicknessCap 1.0), so it has the most relief for a medium "knuckle"
    // scale to actually read against.
    shadeDetail: 0.4,
    warp: 0.18,
    streakWander: 8, // cloud streets still mostly run one way, but not perfectly
    anisotropy: 1.15, // slight, from cloud streets
    smear: 0.2,
    gain: 0.42,
    thicknessCap: 1.0, // thick where it is, nothing between
    reliefGain: 1.0, // the towering one
    turnover: 1.5, // 5-40 min lifetime: the fastest-evolving genus
    driftMul: 1.5,
    shearDeg: 3,
    // MEASURED by bisection in the shader lab, not modelled — see COVER_LUT_SAMPLES.
    coverLut: Object.freeze([0.713, 0.672, 0.64, 0.617, 0.588, 0.569, 0.528, 0.532, 0.51, 0.492, 0.46, 0.433, 0.386]),
    // MEASURED by bisection against the cells:false pass — see calibrateMacroThresholds.
    macroCoverLut: Object.freeze([
      0.585, 0.527, 0.485, 0.454, 0.424, 0.399, 0.375, 0.35, 0.325, 0.294, 0.253, 0.22, 0.161,
    ]),
  }),
  Object.freeze({
    at: 0.8,
    name: 'stratocumulus',
    cellWeight: 0.7,
    openCellPeak: 1,
    jitter: 0.85,
    cellScale: 0.6, // the big mesoscale cells (10-40 km in reality)
    cellScaleVariation: 0.3, // same family as cumulus, see its own note
    edgeWidth: 0.3, // widened for the same reason as cumulus, see its own note
    erosion: 0.35,
    edgeChaos: 0.08, // same family as cumulus, dialled back — already blends well
    detailScale: 0.22,
    shadeDetail: 0.25, // same family as cumulus, dialled back — less relief to sculpt
    warp: 0.15,
    streakWander: 6,
    anisotropy: 1.1,
    smear: 0.1,
    gain: 0.44,
    thicknessCap: 0.85,
    reliefGain: 0.45,
    turnover: 10, // closed cells stay rigid for >10 h
    driftMul: 1.4,
    shearDeg: 2,
    // MEASURED by bisection in the shader lab, not modelled — see COVER_LUT_SAMPLES.
    coverLut: Object.freeze([0.677, 0.63, 0.594, 0.567, 0.535, 0.512, 0.472, 0.467, 0.442, 0.419, 0.382, 0.353, 0.301]),
    // MEASURED by bisection against the cells:false pass — see calibrateMacroThresholds.
    macroCoverLut: Object.freeze([0.57, 0.51, 0.465, 0.432, 0.4, 0.372, 0.346, 0.32, 0.292, 0.26, 0.215, 0.18, 0.117]),
  }),
  Object.freeze({
    at: 1.0,
    name: 'stratus',
    cellWeight: 0.15, // a sheet, with only faint mottling
    openCellPeak: 0,
    jitter: 1.0,
    cellScale: 1.0,
    cellScaleVariation: 0, // a featureless sheet — no cells to vary the size of
    edgeWidth: 0.45, // no edges at all, really
    erosion: 0.15,
    edgeChaos: 0, // no edges at all, really — see edgeWidth
    detailScale: 0.3,
    shadeDetail: 0, // nearly flat (reliefGain 0.1) — no relief here to sculpt
    warp: 0.2,
    streakWander: 0, // a sheet has no streak direction to wander
    anisotropy: 1.0,
    smear: 0.05,
    gain: 0.5,
    thicknessCap: 1.0,
    reliefGain: 0.1,
    turnover: 20,
    driftMul: 1.2,
    shearDeg: 0,
    // MEASURED by bisection in the shader lab, not modelled — see COVER_LUT_SAMPLES.
    coverLut: Object.freeze([
      0.562, 0.497, 0.447, 0.409, 0.371, 0.337, 0.304, 0.272, 0.237, 0.197, 0.146, 0.106, 0.039,
    ]),
    // MEASURED by bisection against the cells:false pass — see calibrateMacroThresholds.
    macroCoverLut: Object.freeze([
      0.538, 0.47, 0.418, 0.379, 0.34, 0.306, 0.272, 0.239, 0.204, 0.164, 0.111, 0.07, 0.0,
    ]),
  }),
]);

/** The recipe fields that are numbers and therefore blend. Order is the
 * uniform push order too, so the two can never drift apart. */
export const CLOUD_RECIPE_KEYS = Object.freeze([
  'cellWeight',
  'openCellPeak',
  'jitter',
  'cellScale',
  'cellScaleVariation',
  'edgeWidth',
  'erosion',
  'edgeChaos',
  'detailScale',
  'shadeDetail',
  'warp',
  'streakWander',
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
  // Same reasoning, same treatment, for the macro-only calibration.
  out.macroCoverLut = a.macroCoverLut.map((v, i) => v + (b.macroCoverLut[i] - v) * k);
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
 * The wall-floor cap on the cell-polarity signal (`buildCloudFieldNode`'s
 * own `cell`), 0..1. Never let a Voronoi wall's `cell` value reach exactly 1
 * — see the long comment at its one call site for the mechanism. 1.0 is a
 * true no-op (the historical, uncapped behaviour); MEASURED in the shader
 * lab against the author's own "I can still see cells as cleanly defined
 * blobs" feedback (2026-09-06): swept 0.7/0.8/0.85/0.9/0.95 at altocumulus,
 * where the fully-closed-wall problem is most visible (a highly regular
 * lattice with a strong centre boost) — below ~0.8 too much of the pattern
 * fuses and the mackerel lattice itself starts dissolving; above ~0.9 the
 * walls stay too reliably closed. 0.85 sits in the window that breaks the
 * wall's CONTINUITY (some segments fuse, some don't) without eroding cell
 * identity.
 */
export const CLOUD_WALL_BREACH = 0.6;
// MEASURED in the shader lab, at altocumulus specifically (where the
// fully-closed-wall problem is most visible): swept 0/0.3/0.4/0.5/0.6/0.7/1/2
// at both the raw coverage mask and the lit tops. Below ~0.3 the effect is
// nearly invisible; at 1.0+ whole regions melt into whichever the coarse
// gate noise elsewhere touches, losing too much cell identity. 0.6 sits
// where some wall segments visibly thin/bridge to a neighbour while others
// stay crisp and separated — patchiness, not uniform closure and not
// uniform dissolution.

/** Where the wall-crest isolation band starts (on `cellRaw`, 0..1) — below
 * this, a pixel is deep enough in a cell interior that it is never touched
 * by the breach gate, regardless of the gate noise.
 *
 * ⚠️ MEASURED, NOT GUESSED, AND THE FIRST VALUES (0.86/0.985) WERE WRONG BY
 * CONSTRUCTION. `cellRaw` (the Worley F1 distance after the ring-polarity
 * mix) does not range 0..1 in practice — measured via the shader lab's
 * `dbg-cellraw` view over altocumulus's own recipe: min 0.075, max 0.855,
 * mean 0.33. A band starting at 0.86 was ABOVE THE OBSERVED MAXIMUM, so it
 * engaged on literally zero pixels — the reason the first breach sweep
 * (0..1) showed no visible change at any setting. These two constants are
 * relative to that measured range, not to the nominal 0..1 the maths
 * happens to be written in. */
export const CLOUD_WALL_CREST_LO = 0.42;

/** Where the crest band reaches full strength.
 *
 * ⚠️ RECALIBRATED A SECOND TIME. 0.6-0.82 (this constant's OWN previous
 * value, chosen from the plain min/max) engaged on under 1% of pixels — a
 * full spatial histogram (not just min/max) showed why: `cellRaw` peaks
 * around 0.25-0.35 and its upper tail collapses fast, with under 3% of
 * pixels above 0.55 at all. That upper sliver is dominated by the rare
 * three-way VORONOI VERTICES (where three cells meet, genuinely farther
 * from any one feature point than a plain two-cell edge), not the general
 * wall LINE — confirmed visually: at high `wallBreach` the field showed
 * isolated star-shaped sparkle artifacts sitting at junctions, never a
 * length of open wall. 0.42-0.58 sits where the actual visible wall LINE'S
 * own body lives (per the measured histogram), so the breach now has real
 * wall LENGTH to work with, not just its rare brightest points. */
export const CLOUD_WALL_CREST_HI = 0.58;

/** The gate noise's frequency, as a multiplier on `cellScale` (itself already
 * a multiplier on the base sample position — see `buildCloudFieldNode`'s own
 * `w` computation). Below 1: several adjacent wall segments share one
 * verdict, reading as small CLUSTERS of fused cells rather than a pixel-noise
 * stipple — closer to how real mackerel/altocumulus shows patches of merged
 * elements, not isolated single breaks. */
// ⚠️ 0.35 was STILL A MISTAKE, caught by the same star-sparkle symptom: with
// `cellScale` already multiplying the sample position (3.0 for altocumulus,
// dense small cells), 0.35 gave an effective gate frequency of ~1.05 — the
// SAME order as individual cells, so neighbouring wall segments got
// UNCORRELATED gate values and each rolled its own tiny, isolated verdict.
// 0.08 gives an effective frequency around a quarter of the cell lattice's
// own, so several adjacent cells share one verdict — small CLUSTERS of
// fused cells, which is what "some walls open, some don't" needs.
export const CLOUD_WALL_GATE_SCALE = 0.08;

/**
 * ⭐ THE VISUAL COVER CEILING — a live-engine choice, not a field property.
 *
 * Author, 2026-09-10: *"the best clouds are the cover values of less than
 * 0.45 and we don't need the entire scene to be covered for overcast, so we
 * can make that the upper bounds for cloud cover so that the map doesn't
 * just become a useless white."*
 *
 * `weather-data.js`'s own archetypes push `cloudCover01` to 0.9-1.0 for
 * overcast/fog/storm — meteorologically honest (a real overcast sky IS
 * ~100% covered), but this field's SILHOUETTE approaches a flat white sheet
 * at high cover (most visibly on `stratus`, "a sheet, with only faint
 * mottling" by design), which is a rendering limitation, not a weather fact.
 *
 * ⚠️ THIS CAPS ONLY THE FIELD'S OWN RENDERED SILHOUETTE — the live engine
 * applies it where `cover01` feeds {@link pushCloudUniforms}, NEVER inside
 * that function itself (the shader-lab bench calls it directly to sweep the
 * FULL 0..1 range on purpose) and never to `env.weather.cloudCover01` at its
 * source. The scalar atmospheric consumers that already read the raw axis —
 * `shadow-access.js` (softens/fades every caster), `sky-access.js` (kills the
 * key, lifts the fill), the environmental grade (desaturates, flattens,
 * cools) — keep their FULL authored response. A sky that is genuinely,
 * meteorologically 100% overcast should still feel maximally gloomy and
 * desaturated; it just does not need to paint every pixel white to say so.
 */
export const CLOUD_COVER_VISUAL_MAX = 0.45;

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
    /** How strongly a gated-open wall crest gets pulled toward fusing with
     * its neighbour ({@link CLOUD_WALL_BREACH} default) — SHARED across
     * every cloud type, not part of the per-keyframe recipe blend, because
     * the mechanism it guards against (a Voronoi wall's closed graph fully
     * starving the Nubis boost) is a property of the maths, not a look a GM
     * authors per genus. Pushed once, unconditionally, in
     * {@link pushCloudUniforms} — never left to the recipe loop. */
    wallBreach: uniform(float(CLOUD_WALL_BREACH)),
    /** The SEPARATE calibrated threshold the `cells: false` (macro-only)
     * pass uses — see the long comment at `cov`'s own computation for why
     * reusing `threshold` there was a severe bug, not a cosmetic one. */
    macroThreshold: uniform(float(8)),
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
  uniforms.macroThreshold.value = coverThreshold(cover01, { coverLut: recipe.macroCoverLut });
  for (const key of CLOUD_RECIPE_KEYS) uniforms[key].value = recipe[key];
  uniforms.wallBreach.value = CLOUD_WALL_BREACH;
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
  const {
    float,
    vec2,
    vec3,
    mix,
    clamp,
    smoothstep,
    pow,
    exp,
    dot,
    cos,
    sin,
    mx_fractal_noise_float,
    mx_worley_noise_float,
    mx_noise_float,
  } = TSL;

  const inv = float(1).div(u.scalePx.max(float(1)));
  const p0 = worldXY.add(u.drift).mul(inv).toVar('cloudP0');

  // ── 0b. REGIONAL VARIATION — this deck is not one wallpaper tile ─────────
  // Author's report (2026-09-07), after reviewing a dense-cover render: "All
  // clouds look best in their sparse mode because the more of it that
  // appears the more obvious the pattern becomes." Densely packed cirrus
  // read as parallel wood-grain (one uniform streak direction, everywhere);
  // densely packed altocumulus read as one uniform cobblestone tile (every
  // mackerel cell almost exactly the same size, everywhere). Both are the
  // classic tell of a STATISTICALLY STATIONARY noise field: at a small
  // sample (sparse cover, or a tight crop) its own characteristic scale is
  // invisible, but at a large sample (dense cover, a whole sky) the SAME
  // scale repeating everywhere is exactly what the eye is tuned to notice.
  //
  // Two cheap, LOW-frequency, NON-ANIMATED (fixed z, same idiom as EDGE
  // CHAOS below — a "climate", not a boil) fBm taps, far coarser than a
  // single cell, so a large dense deck breaks into several distinct
  // "regions" rather than reading as one uniform statistic. Decorrelated by
  // constant offsets, the same trick the DOMAIN WARP below already uses to
  // keep two taps independent without a second unrelated noise family.
  // `regionA` drives DIRECTION (§1's anisotropy axis wobbles per region,
  // breaking cirrus's "combed" uniform streak angle); `regionB` drives SIZE
  // (§3's cell scale drifts per region, breaking altocumulus's "cobblestone"
  // uniform tile). Computed on `p0` — BEFORE anisotropy, warp or cell
  // sampling — so the regions themselves are not stretched or warped by the
  // very stretch/warp they go on to modulate.
  //
  // ⚠️ TWO DIFFERENT FREQUENCIES, NOT ONE, and conflating them was a real
  // bug caught by rendering: a ROTATED sampling basis is itself a domain
  // warp (of the angle, not the position), so it folds by exactly the same
  // mechanism the `warp` fold-test above already proved — swept regionA's
  // own frequency up alongside `streakWander` and got the identical
  // concentric-swirl artifact at (freq 0.22, wander 50) that `warp` gave at
  // high values. `regionB` feeds an AMPLITUDE (cell size), never a
  // rotation, so it has no such ceiling and can run faster — confirmed
  // clean at 0.22 with no fold artifact of any kind.
  const REGION_FREQ_DIR = 0.09;
  const REGION_FREQ_SIZE = 0.22;
  const regionA = mx_fractal_noise_float(
    vec3(p0.x.mul(float(REGION_FREQ_DIR)), p0.y.mul(float(REGION_FREQ_DIR)), float(7.1)),
    2,
    2,
    0.5,
    1
  ).toVar('cloudRegionA');
  const regionB = mx_fractal_noise_float(
    vec3(
      p0.x.mul(float(REGION_FREQ_SIZE)).add(float(5.2)),
      p0.y.mul(float(REGION_FREQ_SIZE)).add(float(1.3)),
      float(53.2)
    ),
    2,
    2,
    0.5,
    1
  ).toVar('cloudRegionB');

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
  //
  // ⚠️ ROTATED BY `regionA`, not the raw wind direction — see REGIONAL
  // VARIATION above. `streakWander` (a per-keyframe dial, degrees either way)
  // is what makes this a provable no-op at 0: cellular types with anisotropy
  // already near 1 have barely any elongation to wobble and are left at 0,
  // cirrus (built for exactly this) gets the most.
  const windDir = u.windDir.toVar('cloudWindDir');
  const wanderRad = regionA.mul(u.streakWander).mul(float(Math.PI / 180));
  const cosW = cos(wanderRad);
  const sinW = sin(wanderRad);
  const a = vec2(windDir.x.mul(cosW).sub(windDir.y.mul(sinW)), windDir.x.mul(sinW).add(windDir.y.mul(cosW))).toVar(
    'cloudWindDirWandered'
  );
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
  let dbgCellRaw = float(0);
  let dbgCrest = float(0);
  let dbgGate = float(0);
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
    //
    // `cellScaleEff`, not the raw uniform — see REGIONAL VARIATION at the top
    // of this function. `regionB` (roughly -1..1) drifts the cell size by up
    // to `cellScaleVariation` either way, per region, so a large dense deck
    // organises into visibly different-sized patches of cells instead of one
    // uniform lattice spacing repeating for as far as the frame shows. Zero
    // for any keyframe that does not set `cellScaleVariation` — provably a
    // no-op, same pattern as every other opt-in dial in this file.
    const cellScaleEff = u.cellScale.mul(float(1).add(regionB.mul(u.cellScaleVariation)));
    const w = clamp(
      mx_worley_noise_float(vec3(pw.mul(cellScaleEff.max(float(0.05))), u.boil.mul(float(0.5))), u.jitter),
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
    const cellRaw = mix(w, float(1).sub(w), clamp(ring, 0, 1)).toVar('cloudCellRaw');
    dbgCellRaw = cellRaw;
    // ⭐ THE WALL-BREACH GATE — let SOME wall CRESTS fuse with a neighbour,
    // chosen by an independent noise, instead of leaving every wall a
    // perfectly closed Voronoi graph.
    //
    // A Worley F1 distance field's boundary is a genuine Voronoi edge, and a
    // Voronoi diagram's edges are, BY MATHEMATICAL CONSTRUCTION, always a
    // fully-connected planar graph — every cell wall joins the next with no
    // gaps. Left alone, `cellRaw` reaches 1 (no boost, `lo = 0`) all along
    // that closed graph, so the Nubis remap starves the ENTIRE wall network
    // down to raw `per01` — which for a keyframe tuned with a strong centre
    // boost (`cellWeight` high) sits reliably below threshold everywhere
    // along the wall. The result is a perfect, unbroken, closed moat around
    // every single cell: cleanly traceable as one continuous line around
    // each blob, which is exactly what the author's own (2026-09-06)
    // follow-up flagged after the warp fix landed — the walls were no
    // longer STRAIGHT, but they were still one continuous unbroken boundary.
    //
    // ⚠️ A FLAT CAP ON `cellRaw` WAS TRIED FIRST AND REJECTED. Worley F1
    // distance spends most of a cell's AREA at moderate-to-high values —
    // it is only ever near 0 right at a feature point — so capping the
    // CEILING touches most of the domain, not just the thin crest, and
    // compresses the whole radial falloff at once. Measured in the shader
    // lab: nothing visible from a cap of 1.0 down to ~0.6, then a sudden
    // collapse into one fused mass by ~0.3 — a cliff, not a graceful fade,
    // because the cap was never a THIN, LOCAL edit.
    //
    // This is the local version: `crest` isolates a NARROW band right at
    // the true wall peak (via a steep smoothstep near 1), so cell interiors
    // are completely untouched — only pixels that are GENUINELY at a
    // boundary are ever candidates. Whether a given crest pixel actually
    // gets pulled down is decided by `gate`, a plain Perlin sample at its
    // OWN frequency and offset — uncorrelated with the Worley lattice, so
    // it does not trace the cell structure itself, and coarse enough
    // (relative to `cellScale`) that several adjacent wall segments share
    // one verdict, giving small CLUSTERS of fused cells rather than a
    // pixel-noise stipple. That is what breaks "one continuous traceable
    // outline" into patchiness — some walls stay closed, some open — rather
    // than a softer edge (edge width was tried first and rejected too: it
    // blurs uniformly and does not touch CONTINUITY at all).
    //
    // Symmetric under the ring flip by construction: `crest` is measured
    // from `cellRaw` AFTER the polarity mix, so it isolates whichever region
    // currently reads as "most starved" — the wall in blob polarity, the
    // hole's own centre in open-cell polarity.
    const crest = smoothstep(float(CLOUD_WALL_CREST_LO), float(CLOUD_WALL_CREST_HI), cellRaw);
    dbgCrest = crest;
    const gate = clamp(
      mx_noise_float(vec3(pw.mul(u.cellScale).mul(float(CLOUD_WALL_GATE_SCALE)), u.boil.mul(float(0.3))))
        .mul(float(0.5))
        .add(float(0.5)),
      0,
      1
    );
    dbgGate = gate;
    const breach = crest.mul(gate).mul(u.wallBreach);
    const cell = cellRaw.sub(breach).toVar('cloudCell');
    // Nubis's remap: Remap(perlin, -(1 - cell), 1, 0, 1).
    const lo = float(1).sub(cell).negate();
    const remapped = per01.sub(lo).div(float(1).sub(lo).max(float(1e-4)));
    base = mix(per01, clamp(remapped, 0, 1), u.cellWeight).toVar('cloudBase');
  }

  // ── 4. COVERAGE ───────────────────────────────────────────────────────────
  // A calibrated threshold, so `mean(cov)` tracks `cloudCover01` and this
  // field agrees with every SCALAR consumer of the same axis. At cover 0 the
  // threshold is unreachable and this is exactly 0 — a provable no-op.
  //
  // ⚠️ TWO DIFFERENT THRESHOLDS, PICKED BY `cells` — and conflating them was a
  // real, severe bug (2026-09-06, author: "cumulus... has a very hard edge
  // around the raised parts"). `u.threshold` is calibrated against the FULL
  // cellular `base` (the Nubis remap's boost included), so it assumes that
  // boost is present. `effects/clouds/cloud-shade.js#heightAt` calls this
  // function with `cells: false` specifically so the gradient/self-shadow
  // taps read the smooth MACRO shape alone (see that module's own header) —
  // but `base` there is bare `per01`, which NEVER receives the boost, so it
  // clears a boost-calibrated threshold only in the rare pixels where per01
  // is independently that high. Measured directly (`dbg-macro-cov` in
  // `tools/shader-lab/cloud-lab.js`): at cumulus's own calibrated cover
  // 0.42, the macro-only pass reached mean coverage **0.021** — barely 5% of
  // the intended extent. Relief was effectively OFF everywhere except a tiny
  // island at the true statistical peak, and BOTH edges of that island (a
  // real 3-D bump meeting perfectly flat "no relief" nothing) are, by
  // construction, as hard as an edge can be — independent of how gently
  // `edgeWidth` fades ALPHA, which reads the (correctly calibrated) cellular
  // pass and does not share this problem.
  //
  // `u.macroThreshold` is a SEPARATE calibration
  // (`CLOUD_KEYFRAMES[*].macroCoverLut`, measured the same way as
  // `coverLut` but bisected against the cells:false pass), so the macro
  // shape's own areal extent matches the true silhouette's, and the relief
  // driving the NORMAL now fades out over the SAME footprint alpha does.
  const thr = cells ? u.threshold : u.macroThreshold;
  let cov = smoothstep(thr, thr.add(u.edgeWidth.max(float(0.01))), base).toVar('cloudCov');
  let shadeBump = float(0);

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

    // ── 5b. EDGE CHAOS — grainy, NON-ANIMATED noise, in VALUE space only ────
    // Author's ask (2026-09-06): "high frequency grainy noise and a similar
    // sort of non-animated distortion at very high values to break up the
    // edges of things and make them more chaotic." Tested literally as a
    // DOMAIN WARP pushed to "very high values" first — swept cumulus's own
    // `warp` 0.18 -> 4.0 (`tools/shader-lab/runs/cloud43-warp-foldtest`):
    // past ~1.0 the field visibly FOLDS, concentric swirl/vortex artifacts
    // appearing where the warped domain wraps over itself — the exact
    // failure mode this codebase's vegetation warps are already
    // gradient-bounded to avoid. A position-space warp cannot be pushed
    // "very high" without producing that artifact instead of "chaotic".
    //
    // This gives the same chaotic, high-frequency character in VALUE SPACE
    // instead — perturbing `cov` directly rather than the position the shape
    // is SAMPLED at. A value-space perturbation can never fold the
    // silhouette no matter how large its amplitude, because it never moves a
    // sample's position; it only changes the coverage AT that position. That
    // is what makes "very high values" actually safe here, unlike a warp.
    //
    // PERLIN, not Worley — deliberately the OPPOSITE choice from erosion just
    // above (this file's own established lesson: Worley reads as cauliflower
    // lobes, Perlin as smoke/grain) — this is meant to look like fine grain,
    // not more cauliflower stacked on the same cauliflower. A FIXED z (never
    // `u.boil`) is what makes it non-animated: the grain sits still in world
    // space and drifts with the cloud like everything else, but never boils.
    //
    // Weighted by `4·cov·(1-cov)` — the same edge-proximity bump used by the
    // silver-lining rim term in `effects/clouds/cloud-shade.js` — so chaos
    // peaks exactly at the coverage transition and fades to nothing deep
    // inside a cloud or deep in clear sky: it roughens EDGES, per the ask,
    // rather than graining the whole interior (the existing lighting-only
    // `grain` in cloud-shade.js already covers interior surface texture).
    const chaosP = ph.mul(float(5));
    const chaosNoise = mx_noise_float(vec3(chaosP.x, chaosP.y, float(41.7)));
    const edgeProximity = cov.mul(float(1).sub(cov)).mul(float(4));
    cov = clamp(cov.add(chaosNoise.mul(u.edgeChaos).mul(edgeProximity).mul(float(0.6))), 0, 1).toVar('cloudCovChaos');

    // ── 5c. SHADING DETAIL — a MEDIUM-frequency bump, HEIGHT only ──────────
    // Author's report (2026-09-07): "The shading on cumulus needs to be
    // higher frequency I think." Erosion above already adds FINE cauliflower
    // detail, but only to `cov`/alpha — `height` (§6) inherits it multiplied
    // through `thickness`, heavily damped by the smooth `excess` envelope, so
    // the NORMAL ends up carrying the macro shape's broad lobes plus a faint
    // fine ripple, with a real gap in between: nothing at the "knuckle" scale
    // between a whole cell and a grain of erosion. That gap is what reads as
    // "the shading is lower frequency than the silhouette", even though the
    // silhouette itself already shows plenty of erosion/chaos texture.
    //
    // A medium-frequency bump, COARSER than either erosion octave (ph*0.4,
    // against erosion's ph*1 and ph*2.3), added to HEIGHT directly rather
    // than to `cov` — so it sculpts the lit surface without ever touching
    // the calibrated coverage/alpha statistics that `coverLut`/`macroCoverLut`
    // depend on (re-measured, not assumed — see the commit message: both
    // were unaffected within noise). Weighted by `cov` so it never invents
    // relief out in clear sky, and zero for any keyframe that leaves
    // `shadeDetail` at 0 — provably a no-op, same pattern as every other
    // opt-in dial in this file.
    //
    // ⚠️ PERLIN, NOT WORLEY — the OPPOSITE choice from erosion, and the
    // opposite of this file's own usual "Worley is cauliflower, Perlin is
    // smoke" rule, for a reason specific to THIS tap: it feeds `height`
    // DIRECTLY, which section 1's forward-difference epsilon then
    // DIFFERENTIATES into the normal — so it is the SLOPE, not the value,
    // that ends up on screen. A single raw Worley tap went in here first (a
    // 2-octave BLEND second, matching erosion's own fix) and BOTH produced
    // visibly FACETED, crystalline patches, confirmed side by side against
    // `shadeDetail: 0` — because a Worley F1 field has a genuine KINK IN ITS
    // GRADIENT along the perpendicular bisector between feature points (the
    // same geometric crease `buildCloudFieldNode`'s own cell term already
    // documents at length), and blending a second octave only makes that
    // crease less REGULAR, not less SHARP. A gradient-based term inherits
    // gradient discontinuities that a value-based term (like `cov`,
    // where erosion's own Worley taps are merely SUBTRACTED and
    // re-normalised, never differentiated) simply never exposes. Perlin's
    // level sets have no such kink anywhere, so its SLOPE is smooth too.
    const shadeP = ph.mul(float(0.4));
    const shadeRaw = mx_fractal_noise_float(vec3(shadeP.x, shadeP.y, u.boil.mul(float(1.6))), 2, 2, 0.5, 1);
    shadeBump = shadeRaw.mul(float(0.35)).mul(u.shadeDetail).mul(cov);
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
  const height = thickness.mul(u.reliefGain).add(shadeBump).toVar('cloudHeight');

  return {
    cov,
    thickness,
    height,
    base,
    // DIAGNOSTIC TAPS — the exact quantities that turned "the walls are
    // still one continuous line" (2026-09-06) from a guess into a measured
    // fix: the raw cell-polarity signal before the breach gate, the crest
    // band it feeds, and the independent gate noise deciding which crests
    // open. Free (they alias values already computed for `cov`/`base`, no
    // extra noise evaluations) and wired into the shader lab's `dbg-cellraw`
    // /`dbg-crest`/`dbg-gate` views (`tools/shader-lab/cloud-lab.js`) —
    // whatever cellular mechanism changes next, render these FIRST rather
    // than guessing a band/scale from the 0..1 the maths happens to be
    // written in, which is exactly the mistake this fix made twice before
    // finally measuring the real range.
    dbgCellRaw,
    dbgCrest,
    dbgGate,
  };
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

/**
 * The cloud shadow's sun-angle streak span, as a fraction of the shadow
 * offset's own length — {@link buildCloudGroundVisNode}'s own `streakSpread`
 * param, shared by every consumer that builds one (ambient, window) so a
 * cloud shadow does not streak one amount over a floor and a different
 * amount over the window light in its wall. Tuned by eye: wide enough that
 * a low sun visibly elongates a cloud's shadow rather than just sliding it
 * further away, narrow enough that an overhead sun (`offset → 0`, so the
 * streak collapses with it regardless) never shows a seam between taps.
 */
export const CLOUD_SHADOW_STREAK_SPREAD = 0.35;

/**
 * ⭐ THE GROUND SHADOW SAMPLE — every ambient/window/specular/water consumer
 * calls this ONE function to ask "how much sun survives the cloud deck at
 * this ground position", instead of each re-deriving the offset+streak+field
 * dance at its own call site (doc 03 §1's "the one node every shadow
 * consumer reads", extended to cover the sampling that feeds it).
 *
 * ⚠️ THE OFFSET ARRIVES PRE-COMPUTED, ON THE CPU, ONCE PER FRAME —
 * `effects/lighting/light-visibility.js#projectShadowOffset`, the EXACT
 * function `effects/shadow-access.js` already calls for every vegetation
 * caster. Doc 03's D2 ruling was "match it by calling it, never
 * reimplementing", and a per-pixel shader cannot literally call a CPU
 * function — so the caller (whoever owns the frame) calls it once and hands
 * the RESULT in here as a uniform vec2, which is the closest a GPU consumer
 * can get to "the same function" without a second, possibly-drifting
 * trig re-derivation.
 *
 * `offset` points from the cloud toward its own shadow (a real-world vector,
 * in the sun's own azimuth), so the cloud that shadows ground point `p` sits
 * at `p - offset`.
 *
 * ⚠️ THE STREAK — author's ask (2026-09-10): *"If we could make it so that
 * the sun angle has a big effect on the cloud shadow shape that would be
 * nice, streaking them."* A rigid single-sample offset translates the WHOLE
 * silhouette but never touches its SHAPE. A real cloud has vertical extent:
 * at a low sun, its TOP casts a shadow further from directly-underneath than
 * its BOTTOM does, so the true shadow is a SMEAR along the sun axis, not a
 * rigid copy. `offset`'s own LENGTH already grows at low elevation
 * (`h/tan(elev)` — the same law `shadow-access.js`'s own header names as the
 * "emergent, not a second model" dawn/dusk elongation), so scaling `offset`
 * itself by a few factors around 1 — rather than adding a second,
 * independently-tuned vector — makes the streak's absolute length grow with
 * the SAME physical quantity that already governs the offset: compact at
 * noon (`offset → 0`, every tap collapses to one point), elongated at a low
 * sun (`offset` large, the taps spread proportionally far apart). Combined
 * by the MINIMUM transmittance across taps — a streaked shadow is as dark as
 * its darkest point along the smear, not an average of it, the same
 * "darkest wins" reasoning the self-shadow march (doc 02 §2.3) already uses.
 *
 * @param {object} TSL
 * @param {object} args
 * @param {*} args.worldXY - vec2 node, the ground point asking "am I shadowed".
 * @param {object} args.uniforms - from {@link createCloudUniforms}.
 * @param {Function} args.buildField - {@link buildCloudFieldNode}, injected
 *   (this module stays TSL-pure; the caller supplies the graph builder).
 * @param {number} [args.octaves] - shape tier for this ground sample. Cheap
 *   by design (default 2: this is a shadow TEST, not the picture the tops
 *   draw) — and paid for `streakTaps` times, so keep it low.
 * @param {*} args.offset - vec2 node, world px, from `projectShadowOffset`
 *   (CPU, once per frame) — see this function's own header.
 * @param {number} [args.streakSpread] - the taps span `offset` scaled from
 *   `(1 - streakSpread)` to `(1 + streakSpread)`. 0 disables the streak (a
 *   single rigid sample) — a provable no-op, same pattern as every other
 *   opt-in dial in this file.
 * @param {number} [args.streakTaps] - odd count ≥ 1. 1 ignores `streakSpread`
 *   entirely (JS-time branch, so a caller that wants the cheap rung pays
 *   nothing extra, never a spread multiplied by zero).
 * @param {*} args.fillShare - float node, `fill/(key+fill)` from the sky
 *   handle, forwarded to {@link buildCloudKeyTransmittanceNode}.
 * @param {*} [args.depthBias] - float node, the effect card's own bias.
 * @returns {*} float node, 0..1, 1 = full sun.
 */
export function buildCloudGroundVisNode(
  TSL,
  { worldXY, uniforms, buildField, octaves = 2, offset, streakSpread = 0, streakTaps = 3, fillShare, depthBias = null }
) {
  const { float, min } = TSL;
  const taps = Math.max(1, streakTaps | 0);
  const sampleAt = (k) => {
    const p = k === 1 ? worldXY.sub(offset) : worldXY.sub(offset.mul(float(k)));
    const thickness = buildField(TSL, { worldXY: p, uniforms, octaves }).thickness;
    return buildCloudKeyTransmittanceNode(TSL, { thickness, fillShare, depthBias });
  };
  if (taps === 1 || streakSpread <= 0) return sampleAt(1);
  let vis = sampleAt(1 - streakSpread);
  for (let i = 1; i < taps; i++) {
    const k = 1 - streakSpread + (2 * streakSpread * i) / (taps - 1);
    // Skip re-sampling the centre tap twice when `taps` is odd and `i` lands
    // back on `k = 1` — a wasted, identical field evaluation otherwise.
    vis = Math.abs(k - 1) < 1e-6 ? min(vis, sampleAt(1)) : min(vis, sampleAt(k));
  }
  return vis;
}
