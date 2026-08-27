/**
 * WATER TIER 2 — THE SURFACE FIELD (`docs/planning/Water.md` §6, rung 2).
 *
 * Tier 1 makes water the right COLOUR at the right DEPTH, and that is where
 * the author stopped and said, correctly and three times, *"it looks like
 * paint / mist, not water."* The diagnosis at that point was a composite bug
 * (real, fixed) and then a missing depth ramp (real, fixed) — and after both,
 * a still top-down view of tinted absorption over a riverbed is STILL a sheet
 * of coloured glass, because nothing in tiers 0–1 describes a SURFACE. There
 * is no structure on it, so there is nothing for the eye to read as liquid.
 * `Water.md` says exactly this about rung 2 in four words: *"It stops being a
 * decal."*
 *
 * ============================================================================
 * WHY THIS RUNG IS FOAM AND TURBIDITY, NOT SLOPE-SHADING
 * ============================================================================
 * The obvious move is "make a normal map and light it". Resist it here: from
 * directly above, a surface slope is **invisible on its own**. Slope becomes
 * visible only through refraction (it shifts where the bed appears — rung 5,
 * needs a dependent read of `buf:scene.color`) or through specular (it catches
 * a highlight — rung 3, needs the real sun and sky handles). Adding a fixed
 * fake light here to "see the ripples" would be inventing a light source the
 * scene does not have, and would then FIGHT the real one when rung 3 lands.
 *
 * So this rung ships the two consequences of a moving surface that ARE visible
 * with no lighting model at all:
 *
 *   FOAM       where the field crests. White, opaque, and — via the body
 *              pack's distance — concentrated toward the bank, which is where
 *              real water actually foams (shoaling). This is the single most
 *              legible "that is a liquid" cue available without lighting.
 *   TURBIDITY  the same field modulating OPTICAL DEPTH, so the absorption
 *              tier 1 computes varies across the surface instead of being one
 *              flat number. This is what breaks up the sheet-of-glass look:
 *              it is structure in a quantity that is already visible, rather
 *              than a new quantity that needs a light to be seen.
 *
 * Both ride ONE noise fetch.
 *
 * ⚠️ **THE SLOPE ARRIVED 2026-07-29, THREE DAYS LATE, AND ITS ABSENCE WAS A
 * MEASURED BUG.** This header used to end: *"The slope itself is deliberately
 * not computed — it would be a uniform nothing reads... It arrives in rung 3
 * with the shading that makes it mean something."* Rung 3 then shipped
 * **without it**, hardcoding a flat `N = (0,0,1)` (`water-light.js`'s `.z`
 * swizzles), and nothing noticed because nobody ever measured what tier 3 put
 * on screen — only that its sun-direction trig was right.
 *
 * A CPU twin finally measured it: the sun term came out at **1e-6 … 1e-3**
 * against an invisible-threshold of 0.008, and the sky term at a **spatially
 * CONSTANT 0.0084**. The rung was a flat, invisible wash. The cause is that a
 * flat normal and a near-mirror lobe are two DIFFERENT models bolted together
 * — a BRDF's roughness IS a surface's statistical slope distribution, so
 * claiming both "polished mirror" and "no slope" leaves the sun's mirror locus
 * off-screen at every realistic elevation (measured: 1.7 to 11.2 screen
 * half-widths away). See `water-light.js`'s own header for the numbers.
 *
 * So this rung now also returns `slope`, and it is FREE: the same
 * `mx_fractal_noise_vec3` fetch already in flight returns three channels and
 * only two were being read. `n.z` was dead. No extra sample, no extra pass.
 *
 * ============================================================================
 * FLOW: TRAVEL IS GLOBAL, THE BANK ONLY WARPS — AND THAT SPLIT IS LOAD-BEARING
 * ============================================================================
 * The surface TRAVELS by one global vector, identical for every pixel, and the
 * shore tangent only WARPS the noise domain by a bounded fraction of a cell.
 * Two separate roles, and only the bounded one is allowed to vary per pixel.
 *
 * This is not the obvious design and it replaced the obvious one, which shipped
 * broken: scrolling along a per-pixel flow direction (`drift = flowDir·speed·t`)
 * tears the surface into hard rays radiating from every dock and wall, worse
 * the longer the scene runs, because an unbounded amplifier turns a fractional
 * difference in direction into thousands of pixels of separation in the noise
 * domain. The full mechanism is written out at the flow block below — read it
 * before "fixing" this back into a single advection term.
 *
 * Correction #4 of this effect's design still governs the warp: use the
 * PROJECTION `t·dot(current, t)`, never the bare tangent. The tangent's sign
 * flips across a river's medial axis, and the projection is invariant under
 * `t → −t`, so the flip cancels instead of seaming the river down the middle.
 *
 * THREE is INJECTED, never imported.
 *
 * @module effects/water/water-field
 */

/** Tier 2 — world px per noise cell, i.e. how big the surface structure is.
 * ~220 reads as river chop at typical battlemap scale; much smaller looks like
 * noise, much larger like slowly-moving stains. */
export const WATER_TIER2_WAVE_SCALE_PX = 152;

/** Tier 2 — how fast the field travels, world px per second. */
export const WATER_TIER2_FLOW_SPEED_PX = 90;

/** Tier 2 — the global current's heading as a COMPASS BEARING in degrees: 0 =
 * north (up the screen), 90 = east, 180 = south, 270 = west, and the value names
 * the direction the water travels **toward**. A pond wants speed 0 and ignores
 * this; a river wants it pointed downstream. See {@link waterFlowVector}. */
export const WATER_TIER2_FLOW_ANGLE_DEG = 180;

/**
 * ============================================================================
 * THE ONE PLACE A HEADING BECOMES A VECTOR — and it fixes two live bugs
 * ============================================================================
 *
 * Author, 2026-08-16: *"I have a map with a river and I need to be able to set
 * the direction the water is travelling in... we need to make this direction
 * control a compass control so that the user can easily select 'south'."*
 *
 * Getting that right meant confronting what the old code actually did, which
 * was neither what its own help text claimed nor what an author would want:
 *
 * **BUG 1 — THE HEADING WAS NOT A COMPASS AND ITS OWN DOC WAS WRONG ABOUT THE
 * AXIS.** The old form was `current = (cos θ, sin θ)`, documented as *"0 being
 * to the right of the screen"*. The first half is true; the second is where it
 * goes wrong, because **this renderer's world space is Y-DOWN**
 * (`vt-pan-viewer.js#updateCamera`: "computeCameraFrustum returns `top = minY`
 * ... so Three maps the smallest world Y to NDC +1 = the top of the screen").
 * So θ = 90° is `(0, +1)`, which is world +Y, which is the BOTTOM of the screen
 * — a heading that increases CLOCKWISE on screen while every mental model of
 * "degrees" outside a compass runs anticlockwise. Half-right conventions are
 * this project's most expensive recurring bug (`feedback_y_flip_recurring_risk`,
 * paid five times; the precipitation wind compass was a ROTATION error, not the
 * sign error it first looked like).
 *
 * **BUG 2 — THE WATER TRAVELLED BACKWARDS, AND THE FIX IS NOT IN THIS
 * FUNCTION.** The old code advected by ADDING the travel to the sample
 * coordinate: `cell = worldXY + current·speed·t`. Sampling noise at `x + d`
 * shows you the noise that lives at `x + d`, so the FEATURE that was at `p`
 * appears where `x + d = p` — at `x = p − d`. **A pattern moves opposite to the
 * offset added to its domain.** Setting "flow east" made the surface crawl west,
 * forever, and nothing caught it because a moving surface looks like a moving
 * surface until you compare it against something that names a direction. See
 * {@link buildWaterSurfaceField}'s own travel block for the corrected sign.
 *
 * Both bugs are invisible in isolation and cancel in exactly one case (a pond,
 * speed 0), which is most of why they survived.
 *
 * THE CONVENTION, stated once and tested against all eight cardinals:
 *
 *   bearing 0   → NORTH → screen UP    → world (0, −1)
 *   bearing 90  → EAST  → screen RIGHT → world (+1, 0)
 *   bearing 180 → SOUTH → screen DOWN  → world (0, +1)
 *   bearing 270 → WEST  → screen LEFT  → world (−1, 0)
 *
 * i.e. `(sin b, −cos b)` — the SAME two lines `diag/effect-controls.js`'s
 * compass dial uses to place its needle, deliberately, so the widget and the
 * water cannot disagree about which way south is.
 *
 * ⚠️ KINEMATIC, NOT METEOROLOGICAL. `world/wind-field.js`'s `directionDeg` is
 * the direction wind blows **FROM** (the weather-report convention), and its
 * consumers negate it. Water's is the direction the current travels **TO**,
 * because that is what an author means by "this river flows south" — a river
 * that "flows from the south" is the opposite river. Two effects, two genuinely
 * different questions, so they must not share one helper; naming the difference
 * here is what stops a future session "unifying" them into a 180° bug.
 *
 * @param {number} bearingDeg - compass degrees, any value; wrapped internally.
 * @returns {[number, number]} a unit world-space vector pointing the way the
 *   water travels.
 */
export function waterFlowVector(bearingDeg) {
  const b = Number.isFinite(bearingDeg) ? bearingDeg : 0;
  const rad = (b * Math.PI) / 180;
  const x = Math.sin(rad);
  const y = -Math.cos(rad);
  // Snap the ±1e-16 that `sin(Math.PI)` produces to a clean zero. Not cosmetic:
  // this vector is compared against exact cardinals in the Node test, and a
  // stray 1.2e-16 in the "south is straight down" assertion would either fail
  // the test or force it to be written with a tolerance that could hide a real
  // rotation error later.
  const clean = (v) => (Math.abs(v) < 1e-12 ? 0 : v);
  return [clean(x), clean(y)];
}

/** Tier 2 — how much foam the crests produce, 0..1. */
export const WATER_TIER2_FOAM = 1;

/**
 * TIER 3's WAVE STEEPNESS — the scale factor from the raw noise channels to a
 * surface SLOPE (rise over run), and therefore the single control over how
 * hard the water glitters.
 *
 * ⚠️ **THIS IS A PHYSICAL QUANTITY WITH MEASURED REAL-WORLD VALUES, NOT A
 * TASTE KNOB.** Cox & Munk (1954) measured sea-surface slope statistics from
 * sun-glitter photographs and got a result still used today:
 *
 *     sigma^2 = 0.003 + 0.00512 * W        (W = wind speed, m/s)
 *
 * so RMS slope runs ~0.055 (dead calm) to ~0.28 (15 m/s). The default here
 * targets a light breeze, which is what almost every map's water is meant to
 * be. An author who wants a mirror-flat tarn turns it toward 0.
 *
 * ⚠️ **MORE IS NOT BRIGHTER — THIS CONTROL HAS AN OPTIMUM, AND IT WAS MEASURED
 * RATHER THAN ASSUMED.** The first version of this constant was 0.55, picked
 * by reasoning from Cox-Munk alone. A brightness sweep
 * (`__tests__/water-light.test.mjs`) then showed sparkle coverage PEAKS near
 * 0.40 and falls away above it: past that steepness, most facets have tilted
 * so far that they no longer point anywhere near the sun-view bisector at all,
 * so the surface scatters light more widely and glitters LESS. Measured at sun
 * 60°, the fraction of surface reaching the sheen band: 5.2% at chop 0.40,
 * 4.1% at 0.55, 1.2% at 1.20. The slider still runs well past the optimum on
 * purpose — a storm-tossed surface genuinely is duller and more uniform than a
 * breeze-ruffled one, and that is a look an author may want.
 *
 * It is expressed as a multiplier on the noise rather than as an RMS directly,
 * because the noise's own RMS is a property of `mx_fractal_noise_vec3`'s
 * octave sum that this module cannot know in Node — the Shader Lab measures it
 * on the real GPU (`tools/shader-lab/`). ⚠️ **So this number is CALIBRATED
 * AGAINST AN ASSUMED noise distribution, not derived from the real one.** If
 * the lab measures the true RMS and it differs, this is the constant to move —
 * and the optimum's SHAPE (a peak, then decline) is the robust finding, not
 * its exact location.
 *
 * ⚠️ RAISED 0.86→1.26 (2026-08-23, author's own live tuning pass, delivered
 * as a full new-defaults preset after tier 5 refraction went live) — past
 * the measured sparkle optimum on purpose, per this doc's own §193 above: a
 * duller, more storm-tossed surface is a real, deliberately chosen look here,
 * not a value that drifted past the optimum by accident.
 *
 * ⚠️ LOWERED 1.26→0.31 (2026-08-24, next round of the same live tuning
 * pass) — a reversal, not a continuation: this sits MUCH closer to the
 * measured 0.40 sparkle peak than either prior value did, favouring a
 * livelier, glitterier surface over the storm-tossed look the previous
 * round chose. Both are legitimate points on the same documented curve;
 * this file's own measured optimum (§193) still explains why 0.31 reads
 * brighter than 1.26 did, not why it is somehow "more correct".
 */
export const WATER_TIER3_CHOP = 0.31;

/**
 * How far the bank's tangent may warp the noise domain, as a FRACTION OF ONE
 * NOISE CELL. Not a param: it is a statement about how rivers work rather than
 * a look control, and exposing it would mostly offer authors a way to shear
 * their own surface apart.
 *
 * ⚠️ **THE FACT THAT IT IS A FRACTION IS THE WHOLE SAFETY PROPERTY.** A domain
 * offset bounded at a third of a cell can separate two neighbouring pixels by
 * at most that, whatever the tangent does between them and however long the
 * scene has been running. The version of this constant that scaled a per-pixel
 * direction by elapsed TIME had no such bound and shipped radial streaks off
 * every surface — see the flow block below. Keep any future bank influence
 * bounded by the cell size, never by the clock.
 */
export const WATER_BANK_INFLUENCE = 0.35;

/**
 * HOW FAR FROM THE BANK THE TANGENT STILL GETS A VOTE, world px — and its
 * absence was a real, live, author-reported bug (2026-08-16).
 *
 * Author, with the artefact traced in red over a screenshot: *"in the white
 * things on top of water there are some unusual hard edges appearing that don't
 * make sense."* The trace was a stepped, staircase-shaped line running through
 * open water, following no feature the map has.
 *
 * ⚠️ **THE BANK WARP WAS APPLIED AT FULL STRENGTH EVERYWHERE, INCLUDING THE ONE
 * PLACE THE TANGENT IS MEANINGLESS.** The body pack's BA is the direction of the
 * nearest shore point — so at a river's MEDIAL AXIS, where the nearest shore
 * switches from one bank to the other, it jumps to a genuinely DIFFERENT
 * direction. Correction #4's projection (`t·dot(c,t)`, invariant under
 * `t → −t`) cancels the pure SIGN flip and nothing else; two banks that are not
 * parallel do not differ by a sign. Across one body-pack texel (~21 world px on
 * a 10,650 px map at the 512-long grid) the warp can therefore swing by up to
 * `2 × WATER_BANK_INFLUENCE × waveScale` ≈ 154 px of noise domain — most of a
 * cell of completely unrelated noise, in the space of a few screen pixels. Push
 * that through `crest`'s steep smoothstep or tier 3's far steeper GGX lobe and
 * the tear stops being a gradient and becomes an EDGE, jagged in exactly the
 * shape of the coarse grid's own Voronoi boundary.
 *
 * `water-body.js`'s header had the cure written down from the day the pack was
 * designed and this rung never built it:
 *
 *     bankInfluence = 1 − smoothstep(0, bankReachPx, abs(sdf))
 *     flow          = mix(current, alongBank, bankInfluence)
 *
 * A tangent is well conditioned NEAR the bank it describes and undefined far
 * from it, so its influence must die with distance. 180 px is a little past
 * `WATER_FOAM_SHORE_PX`, so the warp is still fully present everywhere foam can
 * appear and gone in the deep channel where the medial axis lives.
 */
export const WATER_BANK_REACH_PX = 180;

/**
 * How far the REAL solved flow's local direction may warp the noise domain
 * away from `bankWarp` above, as a FRACTION OF ONE NOISE CELL — same unit,
 * same law: `WATER_BANK_INFLUENCE`'s own docstring on why a fraction is the
 * whole safety property applies here unchanged.
 *
 * This is `bankWarp`'s sibling, not a replacement — `bankWarp` bends the
 * pattern along the STATIC shoreline shape (the tangent, cheap, always
 * available); this bends it toward what the water is ACTUALLY doing right
 * now (the S3 pressure solve's own local direction), which is the only
 * thing that can make the base surface read as genuinely deflecting around
 * a pier rather than merely hugging a bank. Both terms sum into the same
 * `domainOffset` below.
 *
 * ⚠️ SAFE FOR THE SAME REASON `bankWarp` IS, NOT A NEW ARGUMENT: the input
 * (`localFlowDir − current`, see below) is the difference of two UNIT
 * vectors, magnitude-clamped to at most 1 before it ever reaches this
 * multiply, and this multiply is the only place elapsed time could sneak
 * back in — it never does. A future change that lets this term scale by
 * `tSec` reintroduces the exact barcode bug `WATER_BANK_INFLUENCE`'s own
 * docstring names.
 *
 * ⚠️ RAISED 0.35 → 1.0, 2026-08-19, live-reported: "the wake looks great
 * downstream... but upstream there is no evidence of the water flow going
 * AROUND objects" — a ship-bow-shaped splitter, arrows drawn curving around
 * both sides. Measured root cause, not guessed: this term scales the S3
 * solve's own real deviation, and on the bench's own gentle river bend that
 * deviation is genuinely small (≈2.8° at the sharpest point measured, this
 * file's own SOR account) — amplifying a weak signal only helps so much.
 * But a bend is not a stagnation point: potential flow around an actual
 * splitter/bow genuinely turns MUCH harder right at the point (real flow
 * speed drops toward zero exactly on the splitting streamline and the
 * local direction swings sharply either side of it), so the same solve is
 * expected to already carry a stronger real signal there than the bend
 * this constant was originally calibrated against — this raise is aimed at
 * making THAT signal read clearly, not at inventing motion the solve does
 * not have. Still bounded by construction regardless of the number chosen
 * (the input is magnitude-clamped to at most 1 before this multiplies it),
 * so raising it is a visual-weight decision, not a new safety question —
 * unlike `WATER_BANK_INFLUENCE`/`WATER_FOAM_FLOW_NUDGE`, deliberately left
 * at 0.35: neither one was the thing reported missing.
 *
 * ⚠️ THAT LAST CLAIM STOPPED BEING TRUE THE MOMENT THIS WENT TO 3 (2026-08-23,
 * the author's own tuned preset). "Bounded by construction" was reasoning
 * about the DIRECTION-deviation input alone (correctly capped at length 1) —
 * it says nothing about the OUTPUT's size relative to the noise domain's own
 * cell, which is exactly what governs whether two adjacent pixels can sample
 * unrelated noise (`WATER_TIER2_WAVE_SCALE_PX`'s own file-header warning,
 * this rung's oldest and most-repeated lesson). At influence=1 the output cap
 * (`waveScalePx·influence` = 152px) never exceeds one noise cell — measured
 * against the real Tower Bridge mask, only 2.4% of solid-boundary texels
 * ever cross even 100px, none cross 200px. At influence=3 the SAME real
 * boundary texels: mean shift 67px (3×, as expected), but now 8.6% exceed
 * 200px and 2.4% exceed 300px — up to 456px at the worst point, three full
 * noise cells, right at a real pier. `WATER_FLOW_WARP_CAP_CELLS` below is the
 * fix: a ceiling on the FINAL warp vector's length, independent of how high
 * influence goes, so influence keeps controlling how MANY boundary pixels
 * reach a strong bend (the author's own intent — a wider, more assertive
 * response to real solve signal) without any of them individually shifting
 * far enough to decorrelate from their own neighbours.
 */
export const WATER_FLOW_WARP_INFLUENCE = 1.0;

/** ⚠️ SEE THE WARNING ABOVE — added 2026-08-23 alongside it, not before.
 * Caps `flowWarp`'s own final length to this many `WATER_TIER2_WAVE_SCALE_PX`
 * cells, no matter how large `WATER_FLOW_WARP_INFLUENCE` is dialled. 1.0 was
 * chosen because it is a no-op against every previously-shipped/verified
 * default (influence=1 already never exceeded one cell — this only starts
 * clamping once influence pushes past it, exactly the regime this doc's own
 * measurement above shows first goes wrong). Bounding by CELLS, not a raw
 * px constant, keeps this correct if `waveScalePx` itself is ever retuned —
 * the safety question is always "relative to the pattern's own scale", never
 * an absolute pixel count. */
export const WATER_FLOW_WARP_CAP_CELLS = 1.0;

/** How far from the bank foam has fully died away, world px. Foam is a
 * shoaling phenomenon — it breaks where the water shallows — so it is strongest
 * at the waterline and gone in the deep channel. */
export const WATER_FOAM_SHORE_PX = 140;

/**
 * TIER 4 — WAVE SHOALING'S OWN REACH, world px. How far from the bank the
 * amplification below still applies. Deliberately identical to
 * {@link WATER_FOAM_SHORE_PX}: shoaling and foam are the SAME physical fact
 * (waves grow steeper, then break, as depth shrinks) read at two different
 * places on the same curve, so their reach must agree — a foam band that
 * outran its own shoaling gate would foam in water that never got steeper.
 */
export const WATER_SHOAL_REACH_PX = WATER_FOAM_SHORE_PX;

/**
 * TIER 4 — HOW MUCH TALLER A WAVE GETS AS IT SHOALS, at the waterline itself
 * (the amplification tapers to 1× — no change — by {@link WATER_SHOAL_REACH_PX}
 * out). Not authored: like `WATER_BANK_INFLUENCE`, this is a statement about
 * how real water behaves near a shore, not a look a player picks.
 *
 * ⚠️ **GROUNDED IN GREEN'S LAW, THE SAME WAY `WATER_TIER3_CHOP` IS GROUNDED IN
 * COX-MUNK — A PHYSICAL RELATIONSHIP, NOT A ROUND NUMBER.** Green's law gives
 * wave height scaling as `depth^(−1/4)` for depth much less than wavelength —
 * at a depth ratio of 4:1 (a reasonable "just before the shore" vs "mid
 * channel" contrast for a typical battlemap river), that predicts roughly a
 * 40% height increase (`4^0.25 ≈ 1.41`). 0.4 targets that, on the same n.y/n.z
 * channels {@link buildWaterSurfaceField} already reads for slope and crest —
 * so shoaling costs ONE extra multiply-add per channel, no new fetch.
 */
export const WATER_SHOAL_STRENGTH = 0.4;

/**
 * ============================================================================
 * TIER 4 — CAUSTICS, A WORLEY F2−F1 CELL-EDGE NET (rebuilt 2026-08-27)
 * ============================================================================
 * ⚠️ SUPERSEDES the original Jacobian-focus version of this rung
 * (`det(I + k·J)` of the fractal-noise slope field) — RETIRED, not tuned
 * further, after a live screenshot at maximum sharpening AND maximum netting
 * was still soft round blobs, not filaments, next to the author's own
 * reference image (an unmistakable Worley/Voronoi cell-edge net). The
 * diagnosis that shipped alongside that version — real caustics are the
 * SINGULARITIES of a ray-mapping Jacobian, a 1-D envelope-curve set, not a
 * filled region — was correct; the mistake was assuming a smooth Perlin/
 * fractal noise field's local extrema could be reshaped into that structure
 * by contrast alone. They cannot: a smooth field's bright "excess" region is
 * topologically a scattered constellation of isolated round blobs around
 * each extremum, however small sharpening shrinks them, and blending a
 * second such field just adds more isolated blobs — never connects them.
 *
 * This is the EXACT SAME failure shape this codebase already diagnosed and
 * fixed once before, for shore foam
 * (`water-shore.js#buildFoamCellularStructure`'s own header, "ridge vs
 * net"): `F1` (nearest-Voronoi-feature distance) alone lights isolated blobs
 * at cell VERTICES; only `F2−F1` (the gap to the SECOND-nearest feature) is
 * exactly zero on a cell EDGE and traces the full connected boundary between
 * neighbouring cells BY CONSTRUCTION — no threshold or contrast choice on
 * `F1` alone can produce that, because the defect is which SCALAR is being
 * thresholded, not where. The build below is that same technique,
 * independently re-derived in this file (not a call into
 * `buildFoamCellularStructure` itself — caustics needs none of that
 * function's foam-specific flow-streak/bubble/grain embellishments, and its
 * `causticScale`/`causticSharpness` sliders map to different, simpler
 * semantics: direct cell size, and edge WIDTH rather than a post-hoc
 * contrast exponent).
 *
 *   SHARPNESS  how WIDE the bright band around each cell edge reads —
 *              directly, not a reshape of some other value's output.
 *   SCALE      the net's own cell size, independent of the visible chop's
 *              `waveScalePx` — a real caustic net's cells are far smaller
 *              than the swell carrying them.
 *   NETTING    a second, finer Worley layer blended in via `max()` — one
 *              cell size alone still reads as A net, but real caustics cross
 *              because real water carries several overlapping ripple scales
 *              at once.
 */

/** TIER 4 — CAUSTICS' SCALE, author-facing: a fraction of `uWaveScalePx` used
 * as the Worley net's own cell size (NOT the visible chop's own domain,
 * which is untouched). The shipped default sits well below 1 because a real
 * caustic net's cells are much smaller than the swell carrying them.
 *
 * ⚠️ MEASURED, NOT GUESSED (2026-08-27, same day as the rebuild) — a first
 * guess of 0.28 was checked against the shader lab (`window.waterBench`,
 * debug channel 16, the isolated net) and read visibly BUSIER/noisier than
 * the author's own reference image: correct topology (a real connected net,
 * not blobs) but too many, too-small cells competing for attention. 0.5,
 * checked the same way, produces cleaner, larger, more distinct cells much
 * closer to the reference. */
export const WATER_CAUSTICS_SCALE = 0.5;

/** TIER 4 — CAUSTICS' SHARPNESS, author-facing, 0..1: how wide the bright
 * band around each Worley cell edge reads, interpolating between
 * `WATER_CAUSTICS_EDGE_FAR_MAX` (0, thick/lacy) and `WATER_CAUSTICS_
 * EDGE_FAR_MIN` (1, hairline-thin — close to the author's own reference
 * image). Free — no extra fetch, just which threshold the already-computed
 * F2−F1 field is cut at. */
export const WATER_CAUSTICS_SHARPNESS = 0.75;

/** TIER 4 — the WIDEST the bright band around a cell edge may read
 * (`causticSharpness = 0`), in F2−F1 units. Roughly matches
 * `WATER_FOAM_EDGE_FAR`'s own lacy-net look — a deliberately different
 * material (this project's own shore foam), landing in a similar range
 * because both are the same underlying technique at a similarly "soft net"
 * setting. */
export const WATER_CAUSTICS_EDGE_FAR_MAX = 0.45;

/** TIER 4 — the NARROWEST the bright band around a cell edge may read
 * (`causticSharpness = 1`) — a genuine hairline, well under shore foam's own
 * thinnest setting, because a caustic filament reads as thinner and crisper
 * than a lace of sea foam even at maximum sharpness on both. */
export const WATER_CAUSTICS_EDGE_FAR_MIN = 0.06;

/** TIER 4 — the cellular edge's own anti-aliasing width, in SCREEN PIXELS,
 * not world units — the exact same role and mechanism as
 * `WATER_FOAM_EDGE_AA_PX` (`water-shore.js`'s own doc has the full case for
 * why a fixed world-space band aliases into a hard pixel edge at closer zoom
 * without this). Matches that constant's own value: unrelated field, same
 * screen-space AA problem, same conventional fix width. */
export const WATER_CAUSTICS_EDGE_AA_PX = 1.5;

/** TIER 4 — the brightest a caustic edge may push the bed, as a multiplier's
 * ADDITIVE excess (so `1 + this` is the ceiling). */
export const WATER_CAUSTICS_MAX = 1.6;

/** TIER 4 — CAUSTICS' NETTING, author-facing, 0..1: how much a SECOND,
 * finer Worley layer blends into the first via `max()` (not an average —
 * two independent, already-connected nets should ADD coverage where they
 * cross, never dim each other where they don't). 0 is byte-identical to the
 * single-layer net.
 *
 * ⚠️ MEASURED, NOT GUESSED (2026-08-27) — same shader-lab check as
 * `WATER_CAUSTICS_SCALE`'s own doc: a first guess of 0.35, paired with the
 * ORIGINAL (finer) scale guess, compounded into visible busyness rather than
 * richness. Lowered alongside the scale increase — a coarser primary net
 * needs less second-layer contribution to still read as "several ripple
 * scales", not more. */
export const WATER_CAUSTICS_NETTING = 0.15;

/** The second layer's own scale, as a fraction of the FIRST layer's
 * (already-independent) `WATER_CAUSTICS_SCALE` domain — so NETTING always
 * adds a genuinely finer net on top, never a coarser, redundant copy of the
 * same one. 2.6 (not a round 2 or 3): a plain integer ratio risks the two
 * layers' cell boundaries periodically re-aligning into visible beating —
 * the same "non-round ratio" reasoning `WATER_FOAM_FINE_OCTAVE` (2.7) already
 * uses for its own two-octave blend. */
export const WATER_CAUSTICS_NET_SCALE_RATIO = 2.6;

/**
 * ============================================================================
 * WAVE-LINKED DISTORTION (round 3, 2026-08-27) — the net now WARPS with the
 * water's own actual wave state, not just a decoration on top of it
 * ============================================================================
 * Author, live, on the un-warped Worley net: *"they don't animate, they
 * aren't distorted by the refraction (big mistake)... think about how the
 * caustics would mirror the scale and the state of animation of the surface
 * of the water, we need to link the two things together."* Confirmed by
 * research this round started from: the physically-correct real-time
 * technique computes caustics FROM the water's own instantaneous normal
 * field directly (a light-accumulation pass over a normal map baked from the
 * live mesh — out of this architecture's scope), and the standard cheaper
 * real-time approximation "domain-warps" a caustic/Voronoi pattern's sample
 * point by that same normal/height field. Both agree on the same principle
 * this file's own `slope` (tier 2's shoaled, chopped wave vector, already
 * computed, no new fetch) is the honest analytic version of.
 */

/** How strongly `slope` displaces the Worley query point, before the cap
 * below engages — in CELL UNITS per unit of `slope`'s own magnitude.
 *
 * ⚠️ MEASURED, NOT GUESSED (2026-08-27, shader lab, debug channel 16). A
 * first reasoned guess of 4 — meant to read as "roughly half a cell of
 * displacement at typical chop" — turned out to tear the net apart on a
 * real render: thin connected lines dissolved into a thick, blobby mess,
 * and even the shore boundary read as noisy rather than clean, because the
 * Worley query was being pushed well past its own neighbouring cells. 0.6,
 * checked the same way, keeps the net genuinely connected while still
 * visibly rippling its edges — confirmed via a real pixel diff between two
 * renders 4 seconds apart (28% of pixels changed by more than a rounding
 * step, mean delta ~10/255), not just eyeballed. */
export const WATER_CAUSTICS_WAVE_WARP_STRENGTH = 0.6;

/** The hard ceiling on the warp above, in CELL UNITS, however extreme
 * `chop` gets — same "rescale, never per-axis-clamp" safety shape
 * `WATER_FLOW_WARP_CAP_CELLS` already uses. Past a full cell's own width the
 * Worley query would start reading a NEIGHBOURING cell's own feature as if
 * it were local, which reads as the net breaking apart rather than
 * rippling. Lowered alongside `_STRENGTH` above, same shader-lab check —
 * 0.4 keeps even an extreme-chop patch from crossing into a neighbour's own
 * territory. */
export const WATER_CAUSTICS_WAVE_WARP_CELLS = 0.4;

/**
 * ============================================================================
 * ORGANIC SHAPE + GENUINE EVOLUTION (round 4, 2026-08-27) — the net now
 * CURVES independent of the wave field and its own LATTICE changes over
 * time, rather than a fixed 2-D pattern being pushed/scrolled around
 * ============================================================================
 * Author, live, on round 3's wave-warped-but-still-2-D net: *"No evolution
 * happening. It's a distorting scrolling texture currently... The shapes are
 * angular and sharp, not smooth wispy and fluid/liquid... The actual cells
 * don't evolve, they don't shrink and expand, they don't evolve at all."*
 * See the caustics block's own inline header (where these constants are
 * consumed) for the full mechanism each one drives. ⚠️ NOT re-verified via
 * the shader lab this round — the author asked for the tool to be set aside
 * ("I'll examine what you produce when you are finished") — every value
 * below is a reasoned first pass, honestly labelled as such, not a measured
 * one the way `_WAVE_WARP_STRENGTH` above was.
 */

/** How high a spatial frequency the organic warp noise reads at, as a
 * multiplier on the ALREADY cell-normalised coordinate — intentionally
 * higher than 1 (one full primary cell) so the warp's own features are
 * SMALLER than a cell, curving a single edge's length rather than shoving
 * whole cells around the way the (lower-frequency, physically-tied) wave
 * warp does. */
export const WATER_CAUSTICS_ORGANIC_WARP_FREQ = 2.5;

/** How strongly the organic noise displaces the query point, in CELL UNITS,
 * before the cap below engages. Deliberately smaller than
 * `WATER_CAUSTICS_WAVE_WARP_STRENGTH` — this warp's whole job is fine
 * curvature WITHIN an edge, not gross relocation of it. */
export const WATER_CAUSTICS_ORGANIC_WARP_STRENGTH = 0.35;

/** The hard ceiling on the organic warp, in CELL UNITS — same rescale-not-
 * clamp safety shape `_WAVE_WARP_CELLS`/`WATER_FLOW_WARP_CAP_CELLS` already
 * use. Kept under half a cell so curvature cannot by itself push the query
 * into unrelated neighbouring territory. */
export const WATER_CAUSTICS_ORGANIC_WARP_CELLS = 0.3;

/** How fast the organic warp's OWN noise evolves, in noise-cycles per
 * second — slow and gentle on purpose (a "flowing" quality, not a churn);
 * independent of `WATER_CAUSTICS_EVOLVE_SPEED` below, which drives the
 * lattice's own topology change, a different mechanism entirely. */
export const WATER_CAUSTICS_ORGANIC_WARP_TIME_SCALE = 0.08;

/** How fast TIME advances as the Worley lattice's own THIRD AXIS, in
 * lattice-units per second — NOT a scroll speed. One full unit crosses into
 * an entirely new neighbour layer of the 3-D search, so this is "how often
 * the net's own topology meaningfully reshuffles," not "how fast a pattern
 * slides." Slow enough that cells read as smoothly growing/shrinking/
 * merging rather than flickering between unrelated states. */
export const WATER_CAUSTICS_EVOLVE_SPEED = 0.12;

/** The SECOND (netting) layer's own evolution runs at
 * `WATER_CAUSTICS_NET_SCALE_RATIO`× this speed already (finer scale,
 * proportionally faster — the same cascade real turbulence shows), offset
 * by this many lattice-units of fixed TIME PHASE so the two layers never
 * evolve in lockstep. An arbitrary-feeling number on purpose, matching this
 * file's own "non-round ratio avoids periodic re-alignment" reasoning
 * applied to a time axis instead of a spatial one. */
export const WATER_CAUSTICS_NET_TIME_PHASE = 41.7;

/** Where the JUNCTION test (`F3−F2`) is cut into "bright", as a FRACTION of
 * `edgeFarBase` — reusing the sharpness-driven edge threshold rather than an
 * independent constant, so `causticSharpness` sharpens both tests together
 * instead of letting them drift apart at extreme settings. Tighter than 1
 * (the edge test's own implicit ceiling) because a genuine multi-cell
 * junction is a rarer, smaller feature than an ordinary edge crossing. */
export const WATER_CAUSTICS_JUNCTION_FRACTION = 0.55;

/** How dim an ordinary two-cell edge (no nearby junction) reads, relative to
 * a full junction's own brightness of 1. Author, live: "it should be
 * concentrated into the intersections and grow weak in the middle parts of
 * the lines" — 0.3 keeps a plain edge visibly part of the net (not erased)
 * while making a junction read as unmistakably the brighter feature. */
export const WATER_CAUSTICS_LINE_FLOOR = 0.3;

/**
 * Build tier 2's surface field. One fractal-noise fetch, THREE readings of it.
 *
 * @param {object} args
 * @param {*} args.TSL - `THREE.TSL`, injected by the caller that owns THREE.
 * @param {*} args.worldXY - a vec2 node: this fragment's world position.
 * @param {*} args.timeMsNode - THE SHARED CLOCK (`core/frame-clock.js`, handed
 *   down as the viewer's `uGlobalTimeMs`). Never a private time node — one
 *   clock, and `time/one-clock` names water as the effect that broke it in V2
 *   by sampling eight independent times.
 * @param {*} args.tangentXY - a vec2 node: the body pack's BA, the bare shore
 *   tangent. Bent, not followed — see the header.
 * @param {*} args.shoreDist - a float node: distance INSIDE the water from the
 *   bank, world px (already `max(−sdf, 0)` at the call site).
 * @param {*} args.insideWater - a float node, 1 inside the body and 0 outside.
 *   REQUIRED, not a nicety — see the foam block for the live bug its absence
 *   caused. `shoreDist` alone cannot tell inside from outside, because the
 *   clamp that makes it a distance also erases the sign that carried that fact.
 * @param {*} args.uWaveScalePx - float uniform node.
 * @param {*} args.uFlowSpeedPx - float uniform node.
 * @param {*} args.uFlowDir - vec2 uniform node: the UNIT world-space direction
 *   the water travels toward, already converted from the author's compass
 *   bearing on the CPU by {@link waterFlowVector}. A vec2 rather than the angle
 *   it came from, deliberately: the conversion is where a Y-flip hides, so it
 *   happens ONCE, in plain JS, where a Node test can pin all eight cardinals —
 *   never as a `cos`/`sin` pair inside a shader nothing can assert about.
 * @param {*} args.uFoam - float uniform node.
 * @param {*} [args.uChop] - float uniform node: tier 3's wave steepness
 *   ({@link WATER_TIER3_CHOP}). Absent yields a flat `slope` of exactly zero,
 *   which reproduces the pre-2026-07-29 flat-normal behaviour bit for bit —
 *   so a caller that has not been updated gets the OLD look, not a crash.
 * @param {boolean} [args.shoaling] - TIER 4's wave-shoaling switch
 *   (Effects.md Law 4 — a JS boolean read at graph-BUILD time, never a
 *   uniform). `false`/absent reproduces tier-2/3's own output bit for bit —
 *   see the shoaling block below for why this lives INSIDE tier 2's own fetch
 *   rather than as a separate tier-4 post-process.
 * @param {boolean} [args.caustics] - TIER 4's caustics switch. `false`/absent
 *   skips the Worley cell-edge net entirely (Law 4 again — the fetches are
 *   never CONSTRUCTED, not merely multiplied by zero) and `causticBrightness`
 *   is a literal `float(0)`. See the caustics block below (a Worley F2−F1
 *   cell-edge net, not a Jacobian of the wave field — rebuilt 2026-08-27).
 * @param {*} [args.uCausticSharpness] - float uniform, `WATER_PARAMS.
 *   causticSharpness`. How WIDE the bright band around each cell edge reads;
 *   `null` falls back to `WATER_CAUSTICS_SHARPNESS`.
 * @param {*} [args.uCausticScale] - float uniform, `WATER_PARAMS.
 *   causticScale`. The Worley net's own cell size, as a fraction of
 *   `uWaveScalePx`; `null` falls back to `WATER_CAUSTICS_SCALE`.
 * @param {*} [args.uCausticNetting] - float uniform, `WATER_PARAMS.
 *   causticNetting`. Blend weight for a second, finer Worley layer; `null`
 *   falls back to `WATER_CAUSTICS_NETTING`.
 * @returns {{foam: *, turbidity: *, slope: *, domainOffset: *,
 *   causticBrightness: *}} ⚠️ `foam` and `causticBrightness` are BOTH contracted
 *   to be exactly ZERO OUTSIDE THE WATER — not merely small, zero — because
 *   each is consumed by a blend whose neutral element the caller relies on.
 *   `foam` 0..1 (white surface coverage), `turbidity`
 *   roughly −1..1 (a MULTIPLIER offset on optical depth), `slope` a vec2 of
 *   surface gradient (rise/run) for tier 3's normal, `domainOffset` the
 *   already-safe drift+bank-warp+flow-warp vec2 tier 4's filament foam
 *   reuses so it can never sample a different domain than the surface it is
 *   decorating, `flowWarp` the SAME term ALONE (not summed into anything),
 *   for a debug channel to read directly — `domainOffset` on its own cannot
 *   show it, since `drift` (unbounded, time-growing) dwarfs it instantly,
 *   `causticBrightness` an ADDITIVE excess over 1 (0 = no change) for the bed
 *   multiplier.
 */
export function buildWaterSurfaceField({
  TSL,
  worldXY,
  timeMsNode,
  tangentXY,
  shoreDist,
  insideWater,
  uWaveScalePx,
  uFlowSpeedPx,
  uFlowDir,
  uFoam,
  uChop = null,
  shoaling = false,
  caustics = false,
  // THE REAL SOLVED LOCAL DIRECTION (S3's pressure solve, already
  // dead-zone-guarded by the caller — `water-render.js`'s own
  // `localFlowDirSafe`, the SAME node shore foam's `localFlowDir` reads).
  // Defaults to `null`, in which case `flowWarp` below degrades to exactly
  // zero (see its own comment) — old callers, and any construction-only
  // test that never learned about this argument, get byte-for-byte the old
  // behaviour rather than a thrown "undefined is not a node" error.
  localFlowDir = null,
  // ROH TUNING (2026-08-19) — `bankWarp`/`flowWarp`'s own influence weights,
  // author-adjustable uniforms now. `null` default falls back to the
  // shipped constant, so an omitted argument (an old caller, or a
  // construction-only test) is byte-for-byte the pre-param behaviour.
  uBankInfluence = null,
  uFlowWarpInfluence = null,
  // ROH TUNING (2026-08-27) — caustics' own look controls (`WATER_CAUSTICS_
  // SCALE`/`_SHARPNESS`/`_NETTING`'s own docs have the mechanism each drives).
  // Same "`null` falls back to the shipped constant" contract as
  // `uBankInfluence`/`uFlowWarpInfluence` immediately above, for the same
  // reason: an old construction-only test that never learned about these
  // arguments gets the shipped look, not a thrown "undefined is not a node".
  uCausticSharpness = null,
  uCausticScale = null,
  uCausticNetting = null,
}) {
  const {
    vec2,
    vec3,
    float,
    max,
    min,
    dot,
    length,
    smoothstep,
    mix,
    fwidth,
    mx_fractal_noise_vec3,
    mx_worley_noise_vec3,
  } = TSL;
  const bankInfluenceNode = uBankInfluence ?? float(WATER_BANK_INFLUENCE);
  const flowWarpInfluenceNode = uFlowWarpInfluence ?? float(WATER_FLOW_WARP_INFLUENCE);
  const causticSharpnessNode = uCausticSharpness ?? float(WATER_CAUSTICS_SHARPNESS);
  const causticScaleNode = uCausticScale ?? float(WATER_CAUSTICS_SCALE);
  const causticNettingNode = uCausticNetting ?? float(WATER_CAUSTICS_NETTING);

  const tSec = timeMsNode.mul(float(1 / 1000));

  // ============================================================================
  // ⚠️ NEVER MULTIPLY A PER-PIXEL DIRECTION BY UNBOUNDED TIME
  // ============================================================================
  // The first version computed `drift = flowDir · speed · t` with `flowDir`
  // derived per-pixel from the shore tangent. That ships a fan of hard rays
  // radiating from every dock, pier and wall, growing worse the longer the
  // scene stays open (author, with the streaks traced in red: *"lines which
  // radiate outwards forming very strong and obvious barcodes heading out from
  // all surfaces"* — and their instinct that the SDF was involved was right,
  // just one derivative further along than it looked).
  //
  // The mechanism is worth stating because it will recur anywhere a field is
  // "scrolled along" a spatially varying direction: around a convex feature the
  // tangent FANS OUT, so two adjacent pixels hold flow directions differing by
  // a fraction of a degree. Multiply both by `speed · t` — ~3,600 world px
  // after one minute, unbounded thereafter — and that fraction of a degree
  // becomes a separation of thousands of pixels in the noise domain. Adjacent
  // pixels sample unrelated noise, and unrelated noise along a smoothly
  // rotating direction IS a fan of rays. The bug is not in the tangent, the
  // SDF, or the noise; it is in an amplifier with no upper bound.
  //
  // So the two roles are separated, and only the BOUNDED one is allowed to vary
  // per pixel:
  //   TRAVEL     a single global vector, identical for every pixel, so the
  //              whole surface translates and NO relative shear can exist at
  //              any t. Unbounded in magnitude, which is fine precisely because
  //              it is spatially constant.
  //   BANK WARP  the tangent, as a static domain offset capped at a fraction of
  //              one noise cell. It bends the pattern to run along the bank —
  //              which is what correction #4's projection was reaching for —
  //              but a bounded offset cannot separate neighbours by more than
  //              that cap, so it cannot streak however long the scene runs.
  //
  // ⚠️ **AND THE OFFSET IS NEGATED, BECAUSE A PATTERN MOVES OPPOSITE TO ITS
  // DOMAIN.** This line read `.add(drift)` with `drift = current·speed·t` until
  // 2026-08-16, and it made every river run BACKWARDS: sampling the noise at
  // `x + d` shows what lives at `x + d`, so the feature that was at `p` appears
  // where `x = p − d`. The surface moved by `−drift`. It is invisible on its own
  // (a moving surface looks like a moving surface) and only shows up the moment
  // a control claims a DIRECTION — which is exactly what the author asked for
  // when they asked for a compass. See `waterFlowVector`'s own header.
  const current = uFlowDir;
  const drift = current.mul(uFlowSpeedPx.mul(tSec)).negate();
  // Correction #4's PROJECTION is still what shapes the warp — invariant under
  // `t → −t`, so the tangent's sign flip at the river's medial axis cancels
  // rather than seaming the two halves against each other.
  //
  // ⚠️ FADED WITH DISTANCE FROM THE BANK (2026-08-16) — see
  // WATER_BANK_REACH_PX for the author-reported hard edges this fixes, and for
  // why the projection alone was never enough: it cancels a SIGN flip, and the
  // medial axis of a bend swaps in a tangent that differs by a real ANGLE. This
  // is `water-body.js`'s own prescribed `bankInfluence`, four rungs late.
  //
  // ⚠️ NO `insideWater` GATE HERE, AND THAT IS THE OPPOSITE CALL FROM THE FOAM
  // BLOCK BELOW — deliberately, not by omission. Correction #9 (a consumer of a
  // CLAMPED signed distance needs an explicit inside test) exists because
  // `shoreDist = 0` on land is indistinguishable from "right at the waterline",
  // and for the foam those two must behave completely differently. Here they
  // must behave the SAME: `bankInfluence` is 1 at the waterline, so leaving it
  // at 1 on land makes the warp CONTINUOUS across the shoreline. Multiplying by
  // `insideWater` would drop it to 0 on land and tear the noise domain along the
  // waterline — introducing, at the exact place foam lives, the class of edge
  // this whole change exists to remove. Nothing reads this field on land anyway:
  // every consumer (foam, turbidity via `depth01`, slope via the reflection) is
  // already multiplied by `inside` downstream.
  const bankInfluence = float(1).sub(smoothstep(float(0), float(WATER_BANK_REACH_PX), shoreDist));
  const alongBank = tangentXY.mul(dot(current, tangentXY)).mul(bankInfluence);
  const bankWarp = alongBank.mul(uWaveScalePx.mul(bankInfluenceNode));

  // FLOW WARP — `bankWarp`'s sibling, see `WATER_FLOW_WARP_INFLUENCE`'s own
  // doc for the full safety argument. `localFlowDir` defaults to `null`
  // (no caller yet, or a construction-only test) — `?? current` makes the
  // deviation exactly the zero vector in that case, which is the ONLY
  // reason this default is safe: it is not "point somewhere plausible", it
  // is "contribute nothing", byte-for-byte the pre-flow-warp behaviour.
  //
  // Away from any obstacle the real solve settles toward the SAME free-
  // stream heading `current` already is (both trace back to the author's
  // one compass control), so `flowDeviation` is naturally ~0 there too —
  // this term only wakes up close to something the water is genuinely
  // going around, with no separate distance gate required.
  const flowDir = localFlowDir ?? current;
  const flowDeviation = flowDir.sub(current);
  // Magnitude-clamped to at most 1 (two unit vectors can differ by at most
  // 2, dead-on opposite) — the same "bounded by construction, not by
  // guessing a small enough constant" property `bankWarp`'s own `tangentXY`
  // already has for free by being a unit vector.
  const flowDeviationSafe = flowDeviation.div(max(length(flowDeviation), float(1)));
  // ⚠️ NEGATED (2026-08-19 fix, live-reported: "the flow seems to push the
  // water INTO the stockwork... almost inverted from what it should do").
  // `flowWarp` approximates the DIFFERENCE between what genuinely scrolling
  // by the local direction would do and what `drift` (scrolling by the
  // GLOBAL direction) already does — and `drift` itself is negated for a
  // proven reason stated a few lines above this file's own `drift` line:
  // "A PATTERN MOVES OPPOSITE TO ITS DOMAIN." A true local-direction drift
  // would be `−localDir·speed·t`; the existing global one is `−current·
  // speed·t`; their difference is `−(localDir−current)·(…)` =
  // `−flowDeviation·(…)` — negative, not positive. The un-negated version
  // shipped this same day and read as water being pulled TOWARD an
  // obstacle instead of deflected away from it — this file's own established
  // sign law, not applied consistently the first time. `bankWarp` above is
  // NOT negated and that is correct, not inconsistent: its own job (bend
  // the pattern to run ALONG the tangent) is sign-symmetric — "along +tangent"
  // and "along −tangent" look identical — so it never exposed this bug.
  // `flowWarp`'s job (deflect AWAY from an obstacle, a directional, sign-
  // SENSITIVE claim) does not have that luxury.
  const flowWarpRaw = flowDeviationSafe.mul(uWaveScalePx.mul(flowWarpInfluenceNode)).negate();
  // ⚠️ INDEPENDENT SAFETY CAP (2026-08-23) — see `WATER_FLOW_WARP_CAP_CELLS`'s
  // own doc for the measured numbers this responds to. `flowDeviationSafe`
  // above only bounds the DIRECTION-deviation input to length ≤1; it says
  // nothing about how large the OUTPUT gets once `flowWarpInfluenceNode` is
  // dialled well past 1 — and an output shift approaching or exceeding one
  // noise CELL (`uWaveScalePx`) is exactly the "adjacent pixels sample
  // unrelated noise" failure this file's own header already named once, one
  // level up (the drift/ray-fan bug). Clamped by RESCALING the raw vector
  // (never `min` on a per-axis basis, which would distort direction) so the
  // cap only ever shortens an over-length vector, never touches one already
  // inside it — a no-op at every previously-shipped default, confirmed: at
  // influence=1 this never engages (measured max 152px == exactly the cap).
  const flowWarpCapPx = uWaveScalePx.mul(float(WATER_FLOW_WARP_CAP_CELLS));
  const flowWarpLen = length(flowWarpRaw);
  const flowWarpCapScale = min(float(1), flowWarpCapPx.div(max(flowWarpLen, float(1e-4))));
  const flowWarp = flowWarpRaw.mul(flowWarpCapScale);

  // THE COMBINED, ALREADY-SAFE DOMAIN SHIFT — travel plus bank warp plus flow warp, together.
  // Returned to the caller (below) so TIER 4's filament foam
  // (`water-shore.js#buildWaterFilamentFoam`) can sample a DIFFERENT frequency
  // of noise through the exact same shift rather than re-deriving it: two
  // independent copies of "travel + bank warp" is exactly the shape that let
  // this file's own drift bug and Y-flip bug ship unnoticed once already
  // (`feedback_shared_field_two_meanings_two_registries`).
  const domainOffset = drift.add(bankWarp).add(flowWarp);

  // ONE fetch. `mx_fractal_noise_vec3` is three's own MaterialX fractal noise —
  // vendored, backend-neutral, and identical on WebGPU and WebGL2, which is why
  // it is used instead of a hand-rolled hash (Law 8: no hand-written twin).
  const cell = worldXY.add(domainOffset).div(max(uWaveScalePx, float(1)));
  const n = mx_fractal_noise_vec3(vec3(cell.x, cell.y, tSec.mul(float(0.15))), 3, 2.0, 0.5);

  // TURBIDITY — the field as a modulation of optical depth. Centred on zero so
  // it neither brightens nor darkens the water on average; it only gives the
  // absorption something to vary over.
  const turbidity = n.x;

  // FOAM — the upper tail of a DIFFERENT channel of the same fetch, so the two
  // readings are not the same pattern at two contrasts. Gated toward the bank
  // (shoaling) and scaled by the author's amount.
  //
  // ⚠️ `insideWater` IS NOT OPTIONAL. Without it foam renders at FULL STRENGTH
  // OVER THE ENTIRE MAP and is INVISIBLE ON THE WATER — the exact inverse of
  // what it is for, shipped live 2026-07-26 (author: *"The foam appears
  // everywhere, isn't very visible where the water is"*, with white streaks
  // across sand, tents and rooftops). The cause is worth naming because it is
  // a trap any consumer of a SIGNED field can fall into: outside the water the
  // sdf is POSITIVE, so `shoreDist = max(−sdf, 0)` CLAMPS TO ZERO, and zero
  // distance is indistinguishable from "right at the waterline" — which is
  // precisely where the shore gate is strongest. The gate is not wrong; it is
  // simply undefined outside the body, and the sign test is what defines it.
  //
  // ⚠️ TIER 4 — WAVE SHOALING LIVES *HERE*, NOT IN A SEPARATE TIER-4 BLOCK.
  // Real waves grow taller and steeper as the water shallows beneath them
  // (Green's law — see `WATER_SHOAL_STRENGTH`'s own doc for the derivation),
  // and this codebase already has exactly one quantity that carries
  // "steepness": the raw `n.y`/`n.z` pair that BOTH the crest test just above
  // and `slope` just below read. Amplifying that pair once, before either
  // consumer touches it, makes shoaling a property of the shared input rather
  // than two separate corrections that would have to be kept in step by hand.
  //
  // This is also the ONLY place shoaling *can* live and still reach tier 3 for
  // free: `field.slope` is consumed by `buildWaterSpecular` the moment this
  // function returns, so a tier-4 post-process bolted on afterward — the
  // shape every other tier in this file uses — would be too late to change
  // the normal tier 3 already built its lobe against. Folding it into tier 2's
  // OWN fetch, gated by tier 4's own boolean, means tiers 1-3 are byte-for-byte
  // unchanged when `shoaling` is false and tier 3's specular sees the amplified
  // slope for free when it is true — no second uniform, no new fetch, no
  // ordering hazard.
  //
  // `shoalGate` reuses `WATER_SHOAL_REACH_PX`, deliberately equal to the foam
  // gate's own reach: shoaling and foam are the SAME physical fact (steepening
  // toward the shore, then breaking) read at two points on one curve, so their
  // extents must agree or a wave could be reported as "shoaling" past the
  // point where the very foam that shoaling causes has already died away.
  const shoalGate = shoaling
    ? float(1)
        .sub(smoothstep(float(0), float(WATER_SHOAL_REACH_PX), shoreDist))
        .mul(float(WATER_SHOAL_STRENGTH))
    : float(0);
  // `n.y.mul(1 + shoalGate)`, not `n.y.add(shoalGate)` — this must SCALE the
  // existing steepness, not offset it. An additive shoal would still "shoal" a
  // dead-calm patch of noise (n.y ≈ 0) into a nonzero crest test out of
  // nothing; a multiplicative one shoals what is already there and leaves a
  // momentarily flat patch flat, which is the honest behaviour — shoaling
  // amplifies waves, it does not manufacture them.
  const shoaledY = n.y.mul(float(1).add(shoalGate));
  const shoaledZ = n.z.mul(float(1).add(shoalGate));

  const crest = smoothstep(float(0.18), float(0.55), shoaledY);
  const shoreGate = float(1).sub(smoothstep(float(0), float(WATER_FOAM_SHORE_PX), shoreDist));
  const foam = min(crest.mul(shoreGate).mul(insideWater).mul(uFoam), float(1));

  // SLOPE — the third reading of the same fetch, and the one this rung spent
  // three days owing rung 3 (see the header). `n.z` was previously DEAD: the
  // fetch returns a vec3 and only x and y were ever read.
  //
  // ⚠️ **THIS IS A NORMAL-PERTURBATION FIELD, NOT THE GRADIENT OF `n.y`.** Two
  // independent smooth noise channels read as a 2-vector is exactly how a
  // normal-map texture works, and it is what the shading needs: a smooth,
  // correctly-correlated, zero-mean slope field. Finite-differencing the
  // height would be the other honest option and costs two MORE fetches for a
  // result no more useful here — from a top-down camera nothing reveals which
  // of the two produced the highlight, only that the surface has slope at all.
  //
  // ⚠️ **PAIRED WITH `n.y`, THE FOAM CHANNEL, DELIBERATELY.** Slope and foam
  // sharing a channel means the steepest water is also the foamiest, which is
  // what a real crest does — they break BECAUSE they are steep. Re-rolling
  // this onto an independent channel would decorrelate two things physics
  // couples, for no saving. Shoaling amplifies BOTH `shoaledY`/`shoaledZ`
  // identically, so that pairing survives tier 4 exactly as tier 2 built it.
  const slope = uChop ? vec2(shoaledY, shoaledZ).mul(uChop) : vec2(0, 0);

  // ⚠️ TIER 4 — CAUSTICS, REBUILT 2026-08-27 AS A WORLEY F2−F1 CELL-EDGE NET.
  //
  // ============================================================================
  // WHY THE JACOBIAN-FOCUS VERSION OF THIS BLOCK WAS REPLACED, NOT RETUNED
  // ============================================================================
  // The first version read brightness off `1/det(I + k·J)` of the SAME smooth
  // fractal-noise field tier 2 shades with — mathematically the right IDEA
  // (real caustics are the singularities of the ray-mapping Jacobian, a 1-D
  // envelope-curve set, not a filled region) but the WRONG NOISE BASIS to
  // realise it in practice: a smooth Perlin/fractal field's local extrema are
  // isolated, ROUND, and topologically disconnected from each other, so no
  // amount of contrast-sharpening the response curve (`causticSharpness`, the
  // first version's own fix) can do more than shrink each blob's radius — it
  // cannot connect them into a net, and blending a second such field in
  // (`causticNetting`, same version) just adds MORE isolated blobs. Confirmed
  // live: author screenshotted the result at `causticSharpness=1`,
  // `causticNetting=1` — maximum sharpening, maximum netting — and it was
  // still soft round patches, not filaments, alongside a reference image that
  // is unmistakably a Worley/Voronoi cell-edge net (thin bright lines, large
  // clean dark cell interiors). This is the EXACT SAME failure shape this
  // codebase already diagnosed and fixed once before, for shore foam
  // (`water-shore.js#buildFoamCellularStructure`'s own header, "ridge vs
  // net"): `F1` (nearest-Voronoi-feature distance) alone lights isolated
  // blobs at cell VERTICES; only `F2−F1` (the gap to the SECOND-nearest
  // feature) is exactly zero on a cell EDGE and traces the full connected
  // boundary. The core technique below is that same fix, independently
  // re-derived here (not a call into `buildFoamCellularStructure` itself —
  // caustics needs none of that function's foam-specific flow-streak/bubble/
  // grain embellishments, and its two sliders map to different semantics:
  // `causticScale` is the cell size directly, and `causticSharpness` is edge
  // WIDTH, not a post-hoc contrast exponent).
  let causticBrightness = float(0);
  if (caustics) {
    // THE NET'S OWN DOMAIN — the SAME safe `worldXY + domainOffset` every
    // other term in this fetch travels on (this function's own header on why
    // a fresh, unbounded projection would not be safe here), at its own cell
    // size: `causticScaleNode` is a direct fraction of `uWaveScalePx`, so the
    // net scales with the body the same way tier 2's own chop does, but can
    // be tuned far finer than the visible chop ever needs to be — a real
    // caustic net's cells are much smaller than the swell that makes them.
    const cellPx = max(uWaveScalePx.mul(causticScaleNode), float(4));

    // WAVE-LINKED DISTORTION — ties the net's own local shape to the water's
    // ACTUAL current wave state, not an independent decoration on top of it.
    // Real-time caustics shaders get this by "domain warping": distort the
    // Voronoi/caustic sample point by the surface's own normal/height field,
    // a cheap analytic stand-in for "light bending through the ACTUAL
    // instantaneous surface" (a full light-accumulation pass off a real
    // normal map — the physically-correct version — is out of this
    // architecture's scope; reading the SAME `slope` every other shaded term
    // here already reads is the honest cheap version of the same idea).
    // Author, live, on the un-warped version: *"they don't animate, they
    // aren't distorted by the refraction (big mistake)... think about how
    // the caustics would mirror the scale and the state of animation of the
    // surface of the water."*
    //
    // Reads `slope` (ALREADY COMPUTED just above — tier 2's own shoaled,
    // chopped wave vector) — no new fetch. `slope` is exactly zero at
    // chop=0, so this warp (and the organic distortion/animation it drives)
    // vanishes automatically on dead-calm water, the same "no wave field, no
    // effect" contract `chopGate` below already keeps for brightness.
    // `slope` ALSO already animates in place over time (its own `n.y`/`n.z`
    // read a fractal noise whose third coordinate is `tSec` — see tier 2's
    // fetch above) — this is what actually answers "they don't animate":
    // `domainOffset`'s own `drift` only TRANSLATES the whole net as one
    // rigid sheet, which barely reads as motion; a warp sourced from a
    // field that itself continuously reshapes makes the net's OWN edges
    // visibly ripple and reform.
    //
    // Expressed and capped in CELL UNITS (not world px) so the SAME warp
    // vector, added once here, carries correctly into BOTH layers below:
    // `fineCell` is `netCell` re-expressed at `NET_SCALE_RATIO`× the
    // resolution, so the identical real-world-px displacement this warp
    // represents is automatically `NET_SCALE_RATIO`× LARGER in fine-cell
    // units — exactly the correct geometry (the same physical ripple is a
    // bigger fraction of a smaller cell), not a bug needing a per-layer
    // recompute.
    //
    // Capped the SAME way `flowWarp` above already is (this file's own
    // established law, `WATER_FLOW_WARP_CAP_CELLS`'s own doc): RESCALED
    // (never per-axis-clamped, which would distort direction) so however
    // extreme `chop` gets, this can perturb the query by a bounded number
    // of cells, never shear it unpredictably.
    const waveWarpRaw = slope.mul(float(WATER_CAUSTICS_WAVE_WARP_STRENGTH));
    const waveWarpLen = length(waveWarpRaw);
    const waveWarpCapScale = min(float(1), float(WATER_CAUSTICS_WAVE_WARP_CELLS).div(max(waveWarpLen, float(1e-4))));
    const waveWarp = waveWarpRaw.mul(waveWarpCapScale);

    const netCellPreOrganic = worldXY.add(domainOffset).div(cellPx).add(waveWarp);

    // ============================================================================
    // ROUND 4 (2026-08-27) — ORGANIC SHAPE + GENUINE EVOLUTION, not a
    // scrolling/distorting texture over a fixed lattice
    // ============================================================================
    // Author, live, on round 3's wave-warped-but-still-2-D net: *"No
    // evolution happening. It's a distorting scrolling texture currently...
    // The shapes are angular and sharp, not smooth wispy and fluid/liquid...
    // The actual cells don't evolve, they don't shrink and expand, they
    // don't evolve at all."* Correct on both counts, and they are TWO
    // DIFFERENT problems needing two different fixes:
    //
    //   SHAPE      round 3's `slope`-warp only bends the net as smoothly as
    //              the WAVE FIELD itself does — coarse relative to a
    //              filament's own fine structure, and a straight Voronoi
    //              edge pushed by a smooth field is still a (bent) straight
    //              line, not an organic curve. Fixed below by a SECOND,
    //              independent, higher-frequency domain warp sourced from
    //              noise, not physics — the standard "warp a geometric
    //              pattern by noise" technique for making it read as fluid.
    //   EVOLUTION  no amount of warping the QUERY POINT can make one Voronoi
    //              cell genuinely grow at a neighbour's expense, split, or
    //              merge — the underlying LATTICE (the set of feature
    //              points) never changes; only where you sample it does.
    //              Fixed below by making TIME a genuine THIRD AXIS of the
    //              lattice itself (`mx_worley_noise_vec3`'s own vec3-position
    //              overload — confirmed by reading its source: a real 3×3×3
    //              neighbour search, not a 2-D search with time bolted on),
    //              so animating it is slicing a moving plane through an
    //              actually-3-D cellular structure — the standard real-time
    //              technique for genuinely evolving organic cells.
    //
    // ORGANIC WARP — independent of `slope` on purpose: `slope` ties
    // distortion to the water's PHYSICAL state (round 3's own ask); this
    // ties it to nothing physical at all, deliberately, because real
    // caustic filaments curve at a finer scale than a wave field resolves.
    // Reuses `mx_fractal_noise_vec3`, the SAME primitive tier 2's own fetch
    // already uses (Law 8: no hand-written twin) — two of its three
    // channels read as a 2-vector, exactly like `slope` above does.
    // Capped the SAME rescale-not-clamp way `flowWarp`/`waveWarp` already
    // are — this file's one law against unbounded per-pixel domain shear,
    // applied a third time, not re-invented.
    const organicNoise = mx_fractal_noise_vec3(
      vec3(
        netCellPreOrganic.x.mul(float(WATER_CAUSTICS_ORGANIC_WARP_FREQ)),
        netCellPreOrganic.y.mul(float(WATER_CAUSTICS_ORGANIC_WARP_FREQ)),
        tSec.mul(float(WATER_CAUSTICS_ORGANIC_WARP_TIME_SCALE))
      ),
      2,
      2.0,
      0.5
    );
    const organicWarpRaw = vec2(organicNoise.x, organicNoise.y).mul(float(WATER_CAUSTICS_ORGANIC_WARP_STRENGTH));
    const organicWarpLen = length(organicWarpRaw);
    const organicWarpCapScale = min(
      float(1),
      float(WATER_CAUSTICS_ORGANIC_WARP_CELLS).div(max(organicWarpLen, float(1e-4)))
    );
    const netCell = netCellPreOrganic.add(organicWarpRaw.mul(organicWarpCapScale));

    // EVOLUTION's own clock — Z is a real lattice axis, not "2-D result at
    // time T"; see the header above.
    const zTimePrimary = tSec.mul(float(WATER_CAUSTICS_EVOLVE_SPEED));

    /** F1/F2/F3 for one Worley layer at `(cellCoord, zTime)` — a genuine
     * 3-D lattice sample, sorted nearest-to-farthest. `mx_worley_noise_vec3`'s
     * second arg is jitter (1 = fully randomised feature points), the same
     * value `buildFoamCellularStructure` already uses for its own 2-D call. */
    const worleyAt = (cellCoord, zTime) => mx_worley_noise_vec3(vec3(cellCoord.x, cellCoord.y, zTime), float(1));

    // SHARPNESS — how WIDE the bright band around each edge is allowed to
    // read, NOT a post-hoc contrast curve (that was the FIRST version's
    // mistake — reshaping a blob's OUTPUT can't change its SHAPE). 0 = a
    // thick, lacy net (`WATER_CAUSTICS_EDGE_FAR_MAX`); 1 = a hairline net
    // (`WATER_CAUSTICS_EDGE_FAR_MIN`), close to the author's own reference
    // image. `fwidth`-widened exactly like `buildFoamCellularStructure`'s own
    // proven mechanism, so the same world-space band can never alias into a
    // hard single-pixel edge at closer zoom, whatever `causticSharpness` is
    // set to.
    const edgeFarBase = mix(
      float(WATER_CAUSTICS_EDGE_FAR_MAX),
      float(WATER_CAUSTICS_EDGE_FAR_MIN),
      causticSharpnessNode
    );

    /** One layer's brightness — an EDGE test (`F2−F1`, as before) times a
     * NEW JUNCTION test (`F3−F2`) that concentrates full brightness only
     * where a THIRD feature point is ALSO nearly equidistant (a genuine
     * multi-cell junction) and lets a plain two-cell edge fall to a dim
     * floor. Author, live: *"the effect produces a brightening effect but
     * it's uniform, it should be concentrated into the intersections and
     * grow weak in the middle parts of the lines."* Physically apt, not
     * just aesthetic — real caustic brightness concentrates at
     * higher-order fold intersections (catastrophe theory's cusps), not
     * uniformly along a single fold's own length. Reuses `edgeFarBase` (a
     * FRACTION of it) rather than a new independent threshold, so
     * `causticSharpness` sharpens the junction test in step with the edge
     * test instead of the two drifting apart at extreme settings. */
    const netAt = (cellCoord, zTime) => {
      const ranks = worleyAt(cellCoord, zTime);
      const edgeDist = ranks.y.sub(ranks.x);
      const junctionGap = ranks.z.sub(ranks.y);

      const edgeFarAA = max(edgeFarBase, fwidth(edgeDist).mul(float(WATER_CAUSTICS_EDGE_AA_PX)));
      // Bright NEAR an edge (edgeDist≈0), dark toward a cell's interior —
      // `1 −` the ramp, not a reversed-argument smoothstep (undefined for
      // edge0 > edge1), same construction `buildFoamCellularStructure` uses.
      const edgeMask = float(1).sub(smoothstep(float(0), edgeFarAA, edgeDist));

      const junctionFar = edgeFarBase.mul(float(WATER_CAUSTICS_JUNCTION_FRACTION));
      const junctionFarAA = max(junctionFar, fwidth(junctionGap).mul(float(WATER_CAUSTICS_EDGE_AA_PX)));
      const junctionMask = float(1).sub(smoothstep(float(0), junctionFarAA, junctionGap));

      const lineBrightness = mix(float(WATER_CAUSTICS_LINE_FLOOR), float(1), junctionMask);
      return edgeMask.mul(lineBrightness);
    };

    const primaryNet = netAt(netCell, zTimePrimary);

    // NETTING — a SECOND layer at `WATER_CAUSTICS_NET_SCALE_RATIO`× FINER
    // in SPACE (unchanged from round 2) and now ALSO `NET_SCALE_RATIO`×
    // FASTER in its own evolution — a finer scale evolving proportionally
    // faster is the same cascade real turbulence shows (small structures
    // change faster than large ones), not an arbitrary second choice — plus
    // a fixed TIME PHASE offset so it never evolves in lockstep with the
    // primary layer. Blended via `max()` so two independent, already-
    // connected nets overlay into a visibly richer net — never `average`,
    // which would only dim wherever the two layers' edges do not coincide
    // and undo the point of a second layer entirely.
    const fineCell = netCell.mul(float(WATER_CAUSTICS_NET_SCALE_RATIO));
    const zTimeFine = tSec
      .mul(float(WATER_CAUSTICS_EVOLVE_SPEED).mul(float(WATER_CAUSTICS_NET_SCALE_RATIO)))
      .add(float(WATER_CAUSTICS_NET_TIME_PHASE));
    const fineNet = netAt(fineCell, zTimeFine);
    const combinedNet = mix(primaryNet, max(primaryNet, fineNet), causticNettingNode);

    // PHYSICAL PLAUSIBILITY, CHEAPLY — dead-calm water (`chop=0`) shows no
    // caustics (the same "no wave field, no caustics" contract the Jacobian
    // version kept), and a shoaling coastline's net reads slightly stronger,
    // matching the pre-existing tier-2/4 relationship every other term in
    // this file keeps (`shoalGate`, already computed above for foam/slope).
    // Neither costs an extra fetch — both are already-computed scalars.
    const chopScale = uChop ?? float(0);
    const chopGate = smoothstep(float(0), float(0.15), chopScale);
    const shoalBoost = float(1).add(shoalGate);

    // ⚠️ **`insideWater` IS LOAD-BEARING HERE AND ITS ABSENCE SHIPPED A LIVE
    // BUG (2026-08-16, author: *"moving patterns across the whole ground floor,
    // indoors and outside... everywhere that isn't water too"*).**
    //
    // The Worley net this reads is a WORLD-SPACE function — it is defined
    // everywhere, water or not. The consumer multiplies `1 + causticBrightness`
    // into the ABSORPTION mesh, whose blend is `dst · src`, so its neutral
    // element is exactly **1** and any deviation repaints whatever is under
    // it, over the water's whole AABB. Every other term in this file already
    // carries this gate; caustics cannot be the one exception. See
    // `feedback_blend_neutral_element_is_per_blend` and correction #9.
    causticBrightness = combinedNet.mul(float(WATER_CAUSTICS_MAX)).mul(chopGate).mul(shoalBoost).mul(insideWater);
  }

  return { foam, turbidity, slope, domainOffset, causticBrightness, flowWarp };
}

// waterCausticsCpu (the Jacobian-focus CPU twin) was REMOVED 2026-08-27 along
// with the mechanism it tested — see "TIER 4 — CAUSTICS, A WORLEY F2−F1
// CELL-EDGE NET" above for why. The new mechanism's shape (a spatial Worley
// pattern, not a pure per-pixel formula over four scalars) is not usefully
// CPU-testable the same way; it is GPU/bench-verified instead, the same
// boundary `buildFoamCellularStructure`'s own Worley machinery already draws
// in this file's sibling module (`water-shore.js`).
