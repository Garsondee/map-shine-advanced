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
 */
export const WATER_TIER3_CHOP = 0.86;

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
 */
export const WATER_FLOW_WARP_INFLUENCE = 1.0;

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
 * TIER 4 — CAUSTICS' FINITE-DIFFERENCE STEP, as a FRACTION of the wave scale.
 * The Jacobian below needs "how does slope change a little way from here",
 * and "a little way" has to mean a little way relative to the noise's OWN
 * feature size, or the estimate measures noise from an unrelated neighbouring
 * feature instead of local curvature. A fraction (not a fixed px count) keeps
 * that true whether the author's `waveScalePx` is a tight 40px chop or an 800px
 * swell.
 */
export const WATER_CAUSTICS_EPS_FRACTION = 0.06;

/**
 * TIER 4 — THE CAUSTICS FOCAL CONSTANT, `k` in `det(I + k·J)` below.
 *
 * ⚠️ MEASURED AGAINST THE REAL SHADER ON A REAL GPU, THE SAME DISCIPLINE
 * `WATER_TIER3_CHOP` USED — NOT DERIVED FROM A REAL OPTICAL DEPTH, AND NOT
 * GUESSED FROM THE FORMULA ALONE. This renderer has no literal Z depth for a
 * water bed (an orthographic mask-alpha ramp, not a measured distance), so
 * there is no honest "how many world px below the surface" to plug into a
 * refraction formula — but the Jacobian's own MAGNITUDE, for the actual
 * `mx_fractal_noise_vec3` this file calls, is a measurable fact, not a guess.
 *
 * A first estimate of 6 — reasoned from the formula alone, before measuring
 * anything — turned out to be roughly 10× too small: swept against 65,536 real
 * GPU samples of `|J|` at the default `waveScalePx`/chop (a WebGPU render of
 * the exact centre+2-tap construction below, read back and histogrammed),
 * `k·J` never exceeded ~0.05 at that value — `det` barely moved off 1 even at
 * the noise's own local maximum. **The same shape as tier 3's first ship**: a
 * correct formula, in the regime where it is invisible. Caught before shipping
 * this time by measuring first, not after a live report.
 *
 * The real sweep (`WATER_CAUSTICS_MIN_DET`/`_MAX`/`_DARK_MAX` already applied):
 *
 * | K   | surface >0.05 excess | surface >0.3 (a real caustic) | pegged at the ceiling |
 * | --- | --- | --- | --- |
 * | 16  | 17%  | 0%    | 0%    |
 * | 50  | 40%  | 6.0%  | 0%    |
 * | 55  | 41%  | 8.0%  | 0%    |
 * | 75  | 44%  | 16.4% | 0.06% |
 * | 220 | 53%  | 42.6% | 20.4% |
 *
 * **55** is chosen off that table for the same reason tier 3's chop landed at
 * its own optimum rather than its extreme: real caustics are a MINORITY of a
 * calm bed lit up by a shifting net of bright lines, not a wash. 8% of the
 * surface crossing into "a real caustic", 41% carrying a soft, barely-visible
 * lift, and effectively 0% pegged at the brightness ceiling (no blown-out
 * plateaus) is that description in numbers. Re-sweep this if
 * `WATER_CAUSTICS_EPS_FRACTION` or the noise call's own octave count ever
 * changes — the calibration is against THIS Jacobian, not a platonic one.
 */
export const WATER_CAUSTICS_K = 55;

/** TIER 4 — the determinant floor. Without it, a genuinely converging patch
 * (`det → 0`) divides toward infinity — a single-pixel-wide, arbitrarily bright
 * spike that reads as a rendering error, not a caustic. Real caustic focal
 * lines have a finite width for the same reason a camera's circle of confusion
 * does: nothing in a real optical system is a literal point source. */
export const WATER_CAUSTICS_MIN_DET = 0.12;

/** TIER 4 — the brightest a caustic focal line may push the bed, as a
 * multiplier's ADDITIVE excess (so `1 + this` is the ceiling). */
export const WATER_CAUSTICS_MAX = 1.6;

/** TIER 4 — the most a DIVERGING patch may darken the bed. Real caustics read
 * as bright lines on an unremarkable field, not as bright lines on a field with
 * matching dark holes punched in it — energy that leaves one patch mostly does
 * not come from its immediate neighbour in this approximation, so the dimming
 * half is deliberately capped far short of the brightening half. */
export const WATER_CAUSTICS_DARK_MAX = 0.25;

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
 *   skips the two extra taps entirely (Law 4 again — the fetches are never
 *   CONSTRUCTED, not merely multiplied by zero) and `causticBrightness` is a
 *   literal `float(0)`. See the caustics block below for why this reads
 *   `slope` AFTER shoaling has amplified it, not the raw noise.
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
}) {
  const { vec2, vec3, float, max, min, abs, dot, length, clamp, smoothstep, mx_fractal_noise_vec3 } = TSL;
  const bankInfluenceNode = uBankInfluence ?? float(WATER_BANK_INFLUENCE);
  const flowWarpInfluenceNode = uFlowWarpInfluence ?? float(WATER_FLOW_WARP_INFLUENCE);

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
  const flowWarp = flowDeviationSafe.mul(uWaveScalePx.mul(flowWarpInfluenceNode)).negate();

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

  // ⚠️ TIER 4 — CAUSTICS, FROM THE FIELD'S OWN JACOBIAN — TWO EXTRA TAPS OF
  // THE SAME SAFE DOMAIN, NEVER A SCREEN-SPACE DERIVATIVE.
  //
  // Light refracting through a tilted interface concentrates where the surface
  // CURVES (rays converge) and thins where it doesn't (rays diverge) — the
  // shifting bright net every real body of shallow water shows on its bed. The
  // curvature of a slope field IS its Jacobian, and the standard real-time
  // approximation reads brightness off `det(I + k·J)`: near `det → 0`, the
  // mapping from surface to bed is locally many-to-one (converging, bright);
  // `det` growing past 1 is locally expanding (diverging, dim).
  //
  // `Water.md`'s own ladder text says "no derivatives, no divergent-flow UB" —
  // meaning `dFdx`/`dFdy`, the SCREEN-SPACE derivative V2's caustics were built
  // on and which is undefined behaviour the moment it sits inside a branch not
  // every thread in a quad takes (Water.md §2.9). The two builders here are
  // EXPLICIT world-space taps at `worldXY ± eps`, run through the exact same
  // `sampleAt` this fetch already used — a JS-time loop unrolled into three
  // ordinary texture-adjacent noise calls, nothing GPU-derivative about it, and
  // therefore just as legal inside `if (activeTier >= 4)` as everything above.
  //
  // Reads the SHOALED `n.y`/`n.z` (not the raw noise) so a shoaling coastline's
  // caustics genuinely sharpen as the wave field there is really doing —
  // exactly the same physical fact tier 2's foam/slope already share, read a
  // third way.
  let causticBrightness = float(0);
  if (caustics) {
    const epsPx = max(uWaveScalePx.mul(float(WATER_CAUSTICS_EPS_FRACTION)), float(0.5));
    /** One more reading of the SAME safe, already-warped domain this fetch
     * used for its own centre sample — never a fresh unbounded projection (see
     * the header above on why `dot(worldXY, tangentXY)` would NOT be safe
     * here: `domainOffset` is already bounded exactly the way `drift`+
     * `bankWarp` are individually, so reusing it for a tiny `eps`-away tap
     * inherits that safety for free). */
    const sampleShoaledY = (worldXYTap) => {
      const cellTap = worldXYTap.add(domainOffset).div(max(uWaveScalePx, float(1)));
      const nTap = mx_fractal_noise_vec3(vec3(cellTap.x, cellTap.y, tSec.mul(float(0.15))), 3, 2.0, 0.5);
      return { y: nTap.y.mul(float(1).add(shoalGate)), z: nTap.z.mul(float(1).add(shoalGate)) };
    };
    const tapX = sampleShoaledY(worldXY.add(vec2(epsPx, 0)));
    const tapY = sampleShoaledY(worldXY.add(vec2(0, epsPx)));

    // Finite-difference Jacobian of the SHOALED-BUT-NOT-YET-CHOPPED slope
    // field, world-px⁻¹. `uChop` is folded into `k` just below rather than
    // applied to `tapX`/`tapY`/`shoaledY`/`shoaledZ` here — algebraically
    // identical (differentiation is linear, so `chop·J(slope) == J(chop·slope)`
    // for a CONSTANT chop) and cheaper: two fewer multiplies, since it is
    // applied once to `k` instead of four times to the taps.
    const invEps = float(1).div(epsPx);
    const j00 = tapX.y.sub(shoaledY).mul(invEps); // ∂slope.x/∂x
    const j01 = tapY.y.sub(shoaledY).mul(invEps); // ∂slope.x/∂y
    const j10 = tapX.z.sub(shoaledZ).mul(invEps); // ∂slope.y/∂x
    const j11 = tapY.z.sub(shoaledZ).mul(invEps); // ∂slope.y/∂y
    // ⚠️ WHERE chop MAY NOT MOVE TO: past this line. `det()` combines j00/j01/
    // j10/j11 NONLINEARLY (a product and a cross term), so folding chop in
    // AFTER det() — e.g. scaling the finished `causticBrightness` by chop —
    // would NOT be the same number. It has to multiply the Jacobian, which is
    // exactly what happens here, once, via `k`.
    const chopScale = uChop ?? float(0);
    const k = float(WATER_CAUSTICS_K).mul(chopScale);
    const det = float(1)
      .add(k.mul(j00))
      .mul(float(1).add(k.mul(j11)))
      .sub(k.mul(j01).mul(k).mul(j10));
    const focus = float(1).div(max(abs(det), float(WATER_CAUSTICS_MIN_DET)));
    // `focus − 1`: zero on an undisturbed patch (det≈1), so the caller's
    // `1 + causticBrightness` bed multiplier is a provable no-op wherever the
    // surface has no curvature at all — the same "absent → identity" contract
    // every other tier-gated term in this file keeps.
    //
    // ⚠️ **`insideWater` IS LOAD-BEARING HERE AND ITS ABSENCE SHIPPED A LIVE
    // BUG (2026-08-16, author: *"moving patterns across the whole ground floor,
    // indoors and outside... everywhere that isn't water too"*).**
    //
    // "Zero where the surface is flat" is NOT the same promise as "zero outside
    // the water", and only the second one makes this safe. The noise this
    // Jacobian differentiates is a WORLD-SPACE function — it is defined, and
    // curved, on every pixel of the map, water or not. The consumer multiplies
    // `1 + causticBrightness` into the ABSORPTION mesh, whose blend is
    // `dst · src`, so its neutral element is exactly **1** and any deviation
    // repaints whatever is under it. That mesh spans the water's whole AABB —
    // for a river crossing the map, most of the map. So an ungated term did not
    // merely "leak a bit near the shore": it multiplied a slowly-scrolling
    // noise derivative over every floor tile, wall and interior inside the
    // bounding box. Every other term in this file already carries this gate
    // (`foam` explicitly; `turbidity` and `slope` through `depth01`/`inside`
    // downstream) and this one was written as if the flatness test substituted
    // for it. It does not. See `feedback_blend_neutral_element_is_per_blend`
    // and correction #9.
    causticBrightness = clamp(focus.sub(float(1)), float(-WATER_CAUSTICS_DARK_MAX), float(WATER_CAUSTICS_MAX)).mul(
      insideWater
    );
  }

  return { foam, turbidity, slope, domainOffset, causticBrightness, flowWarp };
}

/**
 * ============================================================================
 * THE CPU TWIN — the Jacobian-to-brightness FORMULA, measured, not trusted
 * ============================================================================
 *
 * A line-for-line transcription of the caustics block above's arithmetic, in
 * plain JS, taking the Jacobian's four components directly rather than
 * re-deriving them from GPU noise (the same shape `water-light.js#waterTier3Cpu`
 * uses — a shader value cannot be sampled from Node, but the FORMULA it feeds
 * can be, and the formula is where tier 3 shipped invisible once already).
 *
 * `WATER_CAUSTICS_K`'s own doc has the real GPU sweep this formula was
 * calibrated against; the assertions here pin the formula's SHAPE (identity at
 * rest, correct sign, both clamps engage, never divides by exactly zero) —
 * properties that hold for any `k`, so they stay true even if the constant
 * above is retuned later.
 *
 * @param {object} a
 * @param {number} a.j00 @param {number} a.j01 @param {number} a.j10 @param {number} a.j11 -
 *   the finite-difference Jacobian of the (unchopped, un-shoaled) slope field,
 *   world-px⁻¹.
 * @param {number} [a.chop] - `uChop`. 0 reproduces "tier 3 off" — no caustics
 *   without a wave field to have curvature in.
 * @param {number} [a.k] - overrides {@link WATER_CAUSTICS_K}, for sweeping.
 * @param {number} [a.insideWater] - 1 inside the body, 0 outside. Carried by the
 *   twin ON PURPOSE even though it makes the formula less pure: the shader's own
 *   gate lives on this exact multiply, and its ABSENCE is what shipped a live
 *   bug (see the TSL block). A twin that omitted it could never fail the test
 *   that would have caught it — `feedback_smooth_output_hides_ported_bugs` in
 *   its most literal form.
 * @returns {number} the ADDITIVE excess over 1 for the bed multiplier; 0 = no
 *   change, clamped to `[-WATER_CAUSTICS_DARK_MAX, WATER_CAUSTICS_MAX]`, and
 *   exactly 0 wherever `insideWater` is 0.
 */
export function waterCausticsCpu({
  j00,
  j01,
  j10,
  j11,
  chop = WATER_TIER3_CHOP,
  k = WATER_CAUSTICS_K,
  insideWater = 1,
}) {
  const kEff = k * chop;
  const det = (1 + kEff * j00) * (1 + kEff * j11) - kEff * j01 * kEff * j10;
  const focus = 1 / Math.max(Math.abs(det), WATER_CAUSTICS_MIN_DET);
  const excess = Math.max(-WATER_CAUSTICS_DARK_MAX, Math.min(WATER_CAUSTICS_MAX, focus - 1));
  return excess * insideWater;
}
