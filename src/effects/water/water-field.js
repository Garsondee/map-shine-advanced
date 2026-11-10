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

/**
 * ============================================================================
 * THE ONE PLACE THE FLOW SWITCH BECOMES A SPEED (mythica-machina-press#581)
 * ============================================================================
 *
 * `waterFlowVector` above is "the one place a heading becomes a vector", and
 * this is its direct sibling one param over: the one place `flowEnabled` and
 * `flowSpeedPx` collapse into the single number a consumer actually pushes.
 *
 * Author's ask, 2026-09-21: *"a proper switch beside the compass that parks
 * the surface without you having to remember what speed it was at"*. Stilling
 * a river used to mean dragging Flow speed to 0 — which is a real, supported
 * setting (`water.js#flowSpeedPx`'s own help names a pond) but a DESTRUCTIVE
 * one: the authored speed is gone, and putting the river back means
 * remembering it. The switch parks the surface and leaves both `flowSpeedPx`
 * and `flowAngleDeg` exactly where the author left them.
 *
 * ⚠️ SHARED, not duplicated, because `flowSpeedPx` has TWO consumers that
 * would otherwise each carry their own copy of `flowEnabled === false ? 0 :
 * speed` — `water-surface-subsystem.js` (the material's own uniform) and
 * `water-sim-subsystem.js` (the foam-transport step). Two copies of one rule
 * is how the surface ends up parked while the foam keeps drifting.
 *
 * ⚠️ `null` IS A THIRD ANSWER, distinct from `0`, and the two call sites need
 * it to stay distinct. `0` means "the author has switched the current OFF —
 * push a real zero"; `null` means "no authored speed exists at all", which is
 * the pre-resolve window every effect has before its first cascade resolve
 * (`water-registration.js`'s own `params: null`). The surface subsystem's
 * existing `Number.isFinite` guard deliberately makes NO call in that case,
 * leaving the material's own `WATER_TIER2_FLOW_SPEED_PX` default standing;
 * collapsing `null` into `0` here would silently freeze every river for those
 * frames and read as a bug (`feedback_instruments_must_not_lie`).
 *
 * ⚠️ THE FLOW-FIELD BAKE IS DELIBERATELY NOT GATED ON THIS. `water-flow-
 * subsystem.js#maybeBake` reads `flowAngleDeg` and the solve knobs, never the
 * speed — so a parked river keeps its solved field warm and switching the
 * current back on resumes on the very next frame, with no multigrid re-solve
 * and no visible stall. That is the whole behavioural difference between this
 * switch and disabling the Water effect outright.
 *
 * @param {{flowEnabled?: unknown, flowSpeedPx?: unknown}} [params] - a water
 *   render-state params object. Read KEY BY KEY, never spread: in the surface
 *   subsystem this is U6's read-tracking proxy and a spread would mark every
 *   param read on frame one (`water-registration.js#getRenderState`).
 * @returns {number|null} world px per second, `0` when the current is
 *   switched off, or `null` when no authored speed exists yet.
 */
export function waterFlowSpeedPx(params) {
  // `=== false`, not `!params?.flowEnabled` — an UNSET key (an older scene's
  // saved params, written before this switch existed) must read as "flowing",
  // which is what that scene has always looked like. Only an explicit `false`
  // parks the surface.
  if (params?.flowEnabled === false) return 0;
  const speed = params?.flowSpeedPx;
  return Number.isFinite(speed) ? speed : null;
}

/** Tier 2 — how much foam the crests produce, 0..1. */
export const WATER_TIER2_FOAM = 1;

/** Tier 2 — how visibly the wind roughens the surface, 0..2ish (mythica-
 * machina-press#18). Not a physical unit: the wind field's own `.node()`
 * magnitude is a "lean direction × strength" quantity with no fixed scale
 * (`world/wind-access.js`'s own doc), so this is a taste knob over it, the
 * same posture `uChop`/`WATER_TIER3_CHOP` already take over their own raw
 * channel. 1 is a visible-but-not-overpowering starting point. */
export const WATER_TIER2_WIND_RIPPLE = 1;

// ── WEATHER ON THE SURFACE (2026-11-01, water lab) ─────────────────────────
// Author: "Pay special attention to how wind and rain would change the look of
// the waters surface." Until now wind only DARKENED the water (turbidity) and
// rain did nothing at all. Real water answers both through its SHAPE, which is
// what the glint, the sky sheen, refraction and the caustics all read:
//   wind  — short capillary ripples whose crests lie ACROSS the wind, travelling
//           downwind, steeper where the local wind (gusts, shelter) is stronger;
//           the swell itself steepens. Calm water is a mirror; a breeze breaks
//           one broad glint into a field of glitter (cat's paws in the gusts).
//   rain  — every drop throws a ring that expands and dies in about a second,
//           plus a bright impact speck; heavy rain roughens the whole surface,
//           dulls the mirror and breaks up the caustic net.

/** Wind ripple wavelength, as a fraction of `waveScalePx` (88 px → ~23 px). */
export const WATER_WIND_RIPPLE_SCALE = 0.26;
/** Ripple slope (rise/run) at a local wind strength of 1. */
export const WATER_WIND_RIPPLE_SLOPE = 0.5;
/** How much the swell steepens at a local wind strength of 1 (×(1 + gain)). */
export const WATER_WIND_CHOP_GAIN = 0.9;
/** Rain-ring lattices (world px). Three staggered, SIMILAR cell sizes so no grid reads
 * while every ring stays raindrop-sized: at ~1.5 cm per world px (5 ft grid of
 * 100 px) a drop's ring spreads 10-20 cm, i.e. a largest radius of ~8-12 px. */
export const WATER_RAIN_RING_CELLS_PX = Object.freeze([17, 21, 26]);
/** Ring front speed as a fraction of its cell per second. */
export const WATER_RAIN_RING_SPEED = 0.55;
/** Ring crest half-width (world px) — wide enough not to alias at play zoom. */
export const WATER_RAIN_RING_WIDTH_PX = 1.7;
/** Ring slope at full rain, before the age decay. */
export const WATER_RAIN_RING_SLOPE = 0.75;
/** Fraction of lattice cells that drop in one cycle at full rain. */
export const WATER_RAIN_RING_DENSITY = 0.55;

/**
 * Rain rings — stateless expanding ripples, one drop per lattice cell per cycle
 * (a hash decides whether this cycle's drop falls, so density follows `rain01`
 * live). Each ring is a travelling wave packet `exp(−x²)·sin(πkx)` around the
 * front; the returned slope is its analytic radial derivative, so it lights
 * exactly like the swell does. Rings fade before the cell edge, so one cell
 * lookup per lattice is enough.
 *
 * @param {*} TSL
 * @param {{worldXY: *, tSec: *, rain01: *}} args
 * @returns {{slope: *, splash: *}} slope vec2 (rise/run); splash 0..1 impact specks.
 */
export function buildRainRings(TSL, { worldXY, tSec, rain01 }) {
  const { vec2, vec3, float, floor, fract, dot, exp, length, max, smoothstep, sin, cos, step } = TSL;
  const hash = (p, salt) => {
    // Hoskins' hash12 — no large-argument sin, stable in fp32 across the map.
    let p3 = fract(vec3(p.x, p.y, p.x).mul(float(0.1031)).add(float(salt)));
    p3 = p3.add(dot(p3, vec3(p3.y, p3.z, p3.x).add(float(33.33))));
    return fract(p3.x.add(p3.y).mul(p3.z));
  };
  const k = float(Math.PI * 1.25);
  let slope = vec2(0, 0);
  let splash = float(0);
  WATER_RAIN_RING_CELLS_PX.forEach((cellPx, i) => {
    const p = worldXY.div(float(cellPx)).add(vec2(i * 0.37, i * 0.61));
    const id = floor(p);
    const f = fract(p);
    const h1 = hash(id, 0.11 + i);
    const h2 = hash(id, 0.53 + i);
    const h3 = hash(id, 0.97 + i);
    const period = float(1.15).add(h3.mul(float(1.3)));
    const cyc = tSec.div(period).add(h1);
    const age = fract(cyc).mul(period);
    const hOn = hash(id.add(vec2(floor(cyc), floor(cyc).mul(float(1.7)))), 0.29 + i);
    const on = step(hOn, rain01.mul(float(WATER_RAIN_RING_DENSITY)));
    const centre = vec2(0.5, 0.5).add(vec2(h1, h2).sub(float(0.5)).mul(float(0.16)));
    const d = f.sub(centre).mul(float(cellPx));
    const r0 = max(length(d), float(1e-3));
    // Never a perfect circle: a real ring is dented by the drop's own wobble and
    // the surface it lands on — a per-drop squash plus a low lobe wobble.
    const ang = TSL.atan(d.y, d.x);
    const ph = h2.mul(float(6.2832));
    const r = r0.mul(
      float(1)
        .add(sin(ang.mul(float(2)).add(ph)).mul(float(0.09)))
        .add(sin(ang.mul(float(3)).add(ph.mul(float(1.7)))).mul(float(0.06)))
    );
    const front = age.mul(float(cellPx * WATER_RAIN_RING_SPEED));
    const x = r.sub(front).div(float(WATER_RAIN_RING_WIDTH_PX));
    // Drop size varies: a ring's strength is random per drop (0.35..1).
    const dropAmp = float(0.7).add(
      hash(id.add(vec2(floor(cyc).mul(float(2.3)), floor(cyc))), 0.71 + i).mul(float(0.3))
    );
    const env = exp(x.mul(x).negate())
      .mul(dropAmp)
      .mul(exp(age.mul(float(-2.4))))
      .mul(float(1).sub(smoothstep(float(cellPx * 0.3), float(cellPx * 0.46), r)));
    const dg = cos(k.mul(x))
      .mul(k)
      .sub(x.mul(float(2)).mul(sin(k.mul(x))));
    slope = slope.add(
      d.div(r).mul(
        env
          .mul(dg)
          .mul(on)
          .mul(float(WATER_RAIN_RING_SLOPE / WATER_RAIN_RING_WIDTH_PX))
      )
    );
    splash = max(
      splash,
      on
        .mul(float(1).sub(smoothstep(float(0.04), float(0.2), age)))
        .mul(float(1).sub(smoothstep(float(1.2), float(3.2), r)))
    );
  });
  return { slope, splash };
}

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

/** How far off the wall the bank warp takes to rise to full, world px (2026-11-09, mmp-78u.30.1: a steep rise sheared
 * the crest foam into a column of chevrons along every straight wall). Stays well above the JFA checker zone (48 px). */
export const WATER_BANK_WARP_RISE_PX = 24;

/** Where the combined bank + flow bend flattens out, in wave cells (2026-11-09, mmp-78u.30.1). */
export const WATER_BEND_LIMIT_CELLS = 0.45;

// ── ONE SURFACE, DRIVEN BY THE WIND (2026-11-10, mmp-78u.30.6 — Ingram: "If we derive our caustics from the real
// surface state, the real angle of the sun and the state of clouds then we only have to drive the surface state via the
// wind and everything else comes along with it ... we create a single slider which drives a bunch of effects.") ──
// Before this the swell, its foam crests and the caustic net all travelled with the FLOW only; wind reached nothing but
// a thin ripple layer, so in a lab with wind left-to-right and flow south everything still swam south.
/**
 * How far the swell travels per pixel of the CPU-integrated wind drift (`windDrift`, 120 px/s at wind 1, see
 * `water-surface-subsystem.js`). 0.5 → 60 px/s in a full gale, ~12 px/s in a breeze: wind waves run downwind slower than
 * the short ripples on them, and fast enough to read. The drift is ONE vector for the whole map (never per pixel × time,
 * this file's header), so the surface translates and cannot shear into rays. Every reader of `domainOffset` (swell,
 * crest foam, caustic net, filament foam, silt) inherits it.
 */
export const WATER_WIND_SURFACE_TRAVEL = 0.5;

/** Spacing of the 3x3 taps whose blurred mask gives the bank direction, world px (2026-11-09, mmp-78u.30.1): about a
 * foam's width, so a right-angled corner's two walls blend into one diagonal over ~100 px instead of flipping on a line. */
export const WATER_BANK_BLUR_PX = 48;

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
/**
 * FLOW WARP FADES OUT AT SOLIDS (2026-10-17), world px from the shore (the body
 * SDF's own distance). Author, live, at the rock below Tower Bridge's east bank:
 * *"look at the rock further to the south and you'll see the horribly distorted
 * way that the foam can end up looking."* Measured in the shader lab: inside and
 * beside every SOLID texel of the flow pack the local velocity is zero, so
 * `localFlowDir` degenerates and `flowWarp` jumps to its cap (one whole noise
 * cell, 88 px at the author's settings) across a single ~7 px texel — adjacent
 * pixels then sample unrelated noise and every consumer of `domainOffset` (the
 * crest foam most visibly) tears into stair-stepped shards along the flow grid.
 * Fading the warp in over this distance keeps the deflection in open water,
 * where the solve is meaningful, and removes it exactly where the grid's own
 * edge would show. `bankWarp` still bends the pattern along the bank there.
 */
export const WATER_FLOW_WARP_SOLID_FADE_PX = 48;

export const WATER_FOAM_SHORE_PX = 140;

/** Along-shore scale of the crest foam's reach variation, world px (2026-11-09, mmp-78u.30.1): long enough that one
 * stretch of bank keeps its own reach over several squares, short enough that a pond's rim is never all one width. */
export const WATER_FOAM_REACH_VARIATION_PX = 520;

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
 * CAUSTICS LEFT THIS FILE (2026-11-10, mmp-78u.30.9). The Worley F2−F1 net that lived here (13 author sliders, two 3-D
 * Worley layers, a growth potential, a junction test) drew a convincing sticker, not light: nothing in it came from the
 * waves. Caustics are now the real refraction of the sun through the real wave surface, splatted onto the bed at five
 * depths by `water-waves.js`; this file supplies only the surface's travel, crest foam and murk.
 */

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
 * @param {boolean} [args.caustics] - accepted for old callers; ignored. Caustics are drawn by `water-waves.js` now.
 * @param {*} [args.waveSurface] - vec4 node (height px, slope x, slope y, curvature) from the one wave system; when
 *   given it is the surface's slope and crest foam.
 * @param {object} [args.windHandle] - `world/wind-access.js`'s handle
 *   (mythica-machina-press#18). Omitted → no wind contribution at all, byte-
 *   identical to before this rung existed — see this function's own
 *   "WIND-DRIVEN RIPPLE" section for why it contributes no domain drift.
 * @param {*} [args.uWindRipple] - float uniform, `WATER_PARAMS.windRipple`.
 *   How visibly wind roughens the surface; `null` falls back to
 *   `WATER_TIER2_WIND_RIPPLE`.
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
  sampleSdfAt = null,
  shoreDist,
  insideWater,
  uWaveScalePx,
  uFlowSpeedPx,
  uFlowDir,
  uFoam,
  uChop = null,
  shoaling = false,
  // (2026-11-10) Kept for old callers; the field draws no caustics now (see `water-waves.js`).
  caustics = false,
  causticsInsideGate = false,
  // 2026-10-25 (Water-Performance-Audit W-07) — the caller's "can a caustic be
  // SEEN here" factor: the Caustics dial × the sun-shadow visibility, both of
  // which the finished net is multiplied by downstream anyway. Folded into the
  // `causticsInsideGate` branch's condition, so a shadowed pixel (or a dial at
  // 0) skips the net instead of computing it and multiplying it away. `null`
  // = no extra gate (old callers, construction-only tests).
  causticsVisible = null,
  // THE WIND'S STRENGTH, PRE-SAMPLED (2026-10-25, Water-Performance-Audit W-08)
  // — `{ texture, uRect }`: a small world-space texture whose R is
  // `length(windHandle.strengthNode(...))`, re-rendered once per frame by the viewer
  // over `uRect` (vec4 minX, minY, maxX, maxY). Water only ever needs that
  // LENGTH, and the wind field's finest structure (its smallest turbulence
  // eddy) is ~260 world px, so one bilinear tap of a ~20-30 px grid stands in
  // for the ~13 noise evaluations + field taps the full sampler costs per
  // pixel. `null`: sample the handle per pixel, as before.
  windStrengthField = null,
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
  // WIND-DRIVEN RIPPLE (mythica-machina-press#18) — `null` is the SAME
  // "this consumer does not exist yet" contract every other optional
  // dependency in this function already uses (`localFlowDir`'s own doc):
  // omitting it is byte-for-byte the pre-wind behaviour, never a thrown
  // "undefined is not a node". `world/wind-access.js`'s own handle, never
  // imported directly (`wind/handle-only`) — this function only ever calls
  // its `.node()` method.
  windHandle = null,
  uWindRipple = null,
  // WEATHER ON THE SURFACE (2026-11-01) — see `buildRainRings`'s section.
  // `uWind01` is the scene's ambient wind (used where no wind handle samples a
  // local strength), `uWindDir` the unit direction it blows TOWARD, `uWindDriftPx`
  // a CPU-integrated downwind offset (a uniform direction × unbounded time would
  // jump the whole surface on every wind shift), `uRain01` the eased rain.
  // `uSunCaustic` = (sun azimuth x, y, cos of the refracted sun angle, unused):
  // a low sun's light crosses the water slanted, stretching the net along it.
  // Every one `null` = the pre-weather surface, byte for byte.
  uWind01 = null,
  uWindDir = null,
  uWindDriftPx = null,
  uRain01 = null,
  uSunCaustic = null,
  // THE ONE WAVE SYSTEM (2026-11-10, mmp-78u.30.9) — vec4(height px, slope x, slope y, curvature) at this fragment,
  // from `water-waves.js#createWaterWaveSystem().surfaceAt` (wind spectrum, real wind texture, real time). When given,
  // the surface's slope and its crest foam come from it; the noise fetch below keeps only travel, murk and patterns.
  waveSurface = null,
  // Significant wave height, world px (a uniform the wave system keeps current): what "a crest" means for foam.
  uWaveHsPx = null,
  // (2026-11-10) The sky's share of direct sun (`uSunWater.y` = key / (key + fill)): under cloud the light is no longer
  // one collimated beam, so the caustic lines blur before they fade. `null` = always sharp (the old behaviour).
  uSunWater = null,
  // (2026-11-10) Structural depth 0..~1.6 (mask brightness × the Depth dial), for the sun-angle caustic offset. `null` = 0.
  causticDepth01 = null,
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
    mx_fractal_noise_float,
    mx_worley_noise_vec3,
    Fn,
    If,
  } = TSL;
  const bankInfluenceNode = uBankInfluence ?? float(WATER_BANK_INFLUENCE);
  const flowWarpInfluenceNode = uFlowWarpInfluence ?? float(WATER_FLOW_WARP_INFLUENCE);
  const windRippleNode = uWindRipple ?? float(WATER_TIER2_WIND_RIPPLE);

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
  // TRAVEL = the flow's own heading × speed × t, PLUS the wind's integrated drift (`WATER_WIND_SURFACE_TRAVEL`): both are
  // one vector for the whole map, so the sum is too. Pattern moves opposite to its domain, hence the one `negate`.
  const windTravel = uWindDriftPx ? uWindDriftPx.mul(float(WATER_WIND_SURFACE_TRAVEL)) : vec2(0, 0);
  const drift = current.mul(uFlowSpeedPx.mul(tSec)).add(windTravel).negate();
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
  // THE BANK DIRECTION COMES FROM A WIDE BLUR OF THE MASK, NOT FROM THE FLOOD'S STORED TANGENT (2026-11-09, mmp-78u.30.1 -
  // Ingram: "look at the inner and outer corners, there is extreme and strong, pixel line forming distortion ... in
  // organic maps we end up with a complex but crushed set of competing directions"). The stored tangent is the jump
  // flood's NEAREST-SEED direction: at a right-angled corner it swaps between two perpendiculars across the 45-degree
  // bisector (a straight crease in the wave pattern, Lab / Water B1cornerIn + B1pierRoot), and on organic banks the
  // seeds compete everywhere. Averaging the tangent only made the jump a ramp whose kinks still drew the line. The
  // gradient of the mask blurred over `WATER_BANK_BLUR_PX` has no such jump by construction: it points diagonally at a
  // corner, and its length shrinks to nothing where banks pull against each other, so the warp fades out exactly
  // there. It reaches only about one blur radius off a wall (the bend the old tangent gave out to 360 px was a minor
  // part of the look and is the flow warp's job in open water).
  let alongBank = vec2(0, 0);
  if (sampleSdfAt) {
    // Central differences of the signed distance, 2R apart: the field is continuous everywhere, so the direction can
    // only change smoothly (a 3x3 mask blur jumps whenever a tap crosses a wall, which drew a hard outline 48 px out).
    const S = WATER_BANK_BLUR_PX;
    const gx = sampleSdfAt(float(S), float(0)).sub(sampleSdfAt(float(-S), float(0))).div(float(2 * S));
    const gy = sampleSdfAt(float(0), float(S)).sub(sampleSdfAt(float(0), float(-S))).div(float(2 * S));
    const gLen = length(vec2(gx, gy));
    const nrm = vec2(gx, gy).div(max(gLen, float(1e-5)));
    const t = vec2(nrm.y.negate(), nrm.x);
    // 1 along a straight wall, falling toward 0 where two banks pull against each other (corners, crushed organic bends)
    const strength = smoothstep(float(0.3), float(0.85), gLen);
    alongBank = t.mul(dot(current, t)).mul(strength).mul(bankInfluence);
  } else {
    alongBank = tangentXY.mul(dot(current, tangentXY)).mul(bankInfluence);
  }
  // ⚠️ FADED IN FROM THE SHORE TOO (2026-10-17), over `WATER_FLOW_WARP_SOLID_FADE_PX`.
  // Measured in the shader lab at a Tower Bridge pier nose: `tangentXY` is the jump
  // flood's nearest-seed direction, and within a few texels of a wall it flips between
  // the staircase's orientations texel by texel — shifting the domain by up to a whole
  // wave cell along it tore the crest foam into ~7 px checker squares (bankInfluence 0
  // made them vanish). The bend still runs from there out to `WATER_BANK_REACH_PX`.
  // ⚠️ RISE OVER `WATER_BANK_WARP_RISE_PX`, NOT 48 px (2026-11-09, mmp-78u.30.1). The shift along the bank is a HUMP in
  // distance (rising off the wall, falling by the reach), and the slope of that hump is a shear: 48 px up then 180 px
  // down bent every crest blob into an arrowhead, so a straight wall grew a regular column of chevrons in the foam
  // (Lab · Water B1, channel 8) — a fixed-width band by another route. Spread wide, the peak shear is ~3x smaller and
  // the blobs keep their own shapes; the wall-side texels (the JFA checker of 2026-10-17) still see almost no shift.
  const bankWarp = alongBank
    .mul(uWaveScalePx.mul(bankInfluenceNode))
    .mul(smoothstep(float(0), float(WATER_BANK_WARP_RISE_PX), shoreDist));

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
  // ⚠️ FADED OUT AT SOLIDS — see `WATER_FLOW_WARP_SOLID_FADE_PX` (2026-10-17).
  const flowWarpSolidFade = smoothstep(float(0), float(WATER_FLOW_WARP_SOLID_FADE_PX), shoreDist);
  const flowWarp = flowWarpRaw.mul(flowWarpCapScale).mul(flowWarpSolidFade);

  // THE COMBINED, ALREADY-SAFE DOMAIN SHIFT — travel plus bank warp plus flow warp, together.
  // Returned to the caller (below) so TIER 4's filament foam
  // (`water-shore.js#buildWaterFilamentFoam`) can sample a DIFFERENT frequency
  // of noise through the exact same shift rather than re-deriving it: two
  // independent copies of "travel + bank warp" is exactly the shape that let
  // this file's own drift bug and Y-flip bug ship unnoticed once already
  // (`feedback_shared_field_two_meanings_two_registries`).
  // ⚠️ THE COMBINED BEND IS SOFT-LIMITED TO ~0.45 OF A WAVE CELL (2026-11-09, mmp-78u.30.1 - Ingram: "not clean ... swirls").
  // With the bank and flow bends at their tuned defaults the pattern was pushed up to a whole cell at a wall: smooth, but
  // it read as swirls round every pier and boat (debug channel 32, the distortion grid). `w / (1 + |w| / c)` follows the
  // bend exactly for small shifts and flattens toward `c` for large ones: no clamp, no kink, sliders unchanged.
  const bendSum = bankWarp.add(flowWarp);
  const bendCap = uWaveScalePx.mul(float(WATER_BEND_LIMIT_CELLS));
  const bendLimited = bendSum.div(float(1).add(length(bendSum).div(max(bendCap, float(1)))));
  const domainOffset = drift.add(bendLimited);

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
  // ⚠️ NO FIXED-WIDTH BAND, NO END LINE (2026-11-09, mmp-78u.30.1 — Ingram: "make it so that the edges of the effect
  // don't look so obviously like a single width band of foam area. It's easy on some settings to see the foam end
  // point as a line."). Both the shoal gate and the crest gate below used to be `1 − smoothstep(0, 140 px, shoreDist)`:
  // one width all round every shore, and foam patches straddling 140 px were cut there, so the band ended on a line
  // that copied the shoreline's shape (Lab · Water B1/C2 channel 8). Now (1) the reach varies along the shore with a
  // slow world-anchored noise (0.45x-1.9x, drifting over tens of seconds), and (2) distance never cuts foam: it raises
  // the steepness a crest needs before it breaks, so foam thins into rarer, smaller patches with no boundary at all.
  const reachUv = worldXY.div(float(WATER_FOAM_REACH_VARIATION_PX));
  const reachNoise = mx_fractal_noise_float(vec3(reachUv.x, reachUv.y, tSec.mul(float(0.02))), 2, 2.0, 0.5);
  const reachMul = mix(float(0.45), float(1.9), smoothstep(float(-0.35), float(0.35), reachNoise));
  // 0 at the waterline, 1 at this stretch's own reach; unbounded beyond (no clamp, no kink).
  const shoreT = shoreDist.div(float(WATER_FOAM_SHORE_PX).mul(reachMul));
  const shoalGate = shoaling ? TSL.exp(shoreT.mul(float(-2.2))).mul(float(WATER_SHOAL_STRENGTH)) : float(0);
  // `n.y.mul(1 + shoalGate)`, not `n.y.add(shoalGate)` — this must SCALE the
  // existing steepness, not offset it. An additive shoal would still "shoal" a
  // dead-calm patch of noise (n.y ≈ 0) into a nonzero crest test out of
  // nothing; a multiplicative one shoals what is already there and leaves a
  // momentarily flat patch flat, which is the honest behaviour — shoaling
  // amplifies waves, it does not manufacture them.
  const shoaledY = n.y.mul(float(1).add(shoalGate));
  const shoaledZ = n.z.mul(float(1).add(shoalGate));

  // Distance raises the break threshold instead of gating the result (see the reach note above): at the local reach a
  // crest must be ~0.75 steeper to foam, which the noise almost never reaches, so the patches dissolve.
  const breakRise = TSL.pow(shoreT, float(1.5)).mul(float(0.75));
  // (2026-11-10) With the wave system, a crest is a crest: wave height over half the significant height, raised by
  // shoaling. Without it (headless tests), the old noise channel stands in.
  // A wave sum's heights are Gaussian with σ ≈ Hs/4, so h/Hs has σ ≈ 0.25: a crest that breaks is one above ~2σ
  // (0.5 → 0.8 of Hs, ~2% of the water), raised by shoaling near the bank. (The first cut used ~1σ and foamed a fifth
  // of all open water: grey grain everywhere — caught in Foundry, 2026-11-10.)
  const crest = waveSurface
    ? smoothstep(
        float(0.5).add(breakRise),
        float(0.8).add(breakRise),
        waveSurface.x.div(max(uWaveHsPx ?? float(1), float(0.5))).mul(float(1).add(shoalGate))
      )
    : smoothstep(float(0.18).add(breakRise), float(0.55).add(breakRise), shoaledY);
  const shoreGate = TSL.exp(shoreT.mul(float(-0.7)));
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
  // THE SLOPE IS THE REAL WAVES' (2026-11-10): the wave system's normal, already scaled by the chop dial and the local
  // wind, amplified by shoaling toward the bank exactly as the old noise slope was.
  let slope = waveSurface
    ? vec2(waveSurface.y, waveSurface.z).mul(float(1).add(shoalGate))
    : uChop
      ? vec2(shoaledY, shoaledZ).mul(uChop)
      : vec2(0, 0);

  // ── WIND-DRIVEN RIPPLE (mythica-machina-press#18) ───────────────────────
  // "Gusts sweep visible dark ripple patches across open water; glassy-calm
  // in sheltered spots — using the same wind field vegetation already
  // obeys."
  //
  // ⚠️ WHY THIS DOES NOT ADD ITS OWN DOMAIN DRIFT — the SAME trap this
  // file's own header names for flow direction applies here just as hard.
  // `windHandle.strengthNode()` returns a vector that varies PER PIXEL (openness
  // gating, wall deflection near shelter, organic turbulence) — exactly the
  // "smoothly varying across space" shape that turns into a fan of hard
  // rays the moment it is multiplied by unbounded time (`drift`'s own
  // header, above). `wind/handle-only` (the enforced wall in `world/`) also
  // means this function has no door to reach PAST the handle for a pure,
  // spatially-uniform ambient-only vector the way `current`/`uFlowDir` are
  // authored as. So wind contributes NO drift term: only its MAGNITUDE,
  // used as a bounded, per-pixel, non-time-multiplied scale on a pattern
  // that already exists — the one combination that is always safe
  // regardless of how the input varies across space.
  //
  // The TEXTURE wind reveals is `shoaledY`/`shoaledZ` — tier 2's own
  // crest/slope pair, ALREADY a live, animating, correctly-shoaled read of
  // this same fetch (no new fetch, no new fields to keep in step) — rather
  // than `turbidity` (`n.x`), because wind roughens the surface, it does
  // not make the water murkier; reusing the channel that already means
  // "how much surface structure is here" is the honest choice, not a
  // convenient one. The RESULT rides `turbidity` in the return below
  // because that is the one channel already wired to visible DARKENING
  // (`water-render.js`'s own `turbid` term scales optical depth) — "dark
  // ripple patches" is a statement about depth reading darker, which is
  // exactly what turbidity already does for tier 2's own pattern.
  //
  // Deliberately independent of `uChop`: `slope` above goes to exactly zero
  // at `uChop = 0` (an author choice about specular chop), but wind
  // roughening open water is a different question from how hard the water
  // glitters, so this reads `shoaledY`/`shoaledZ` directly rather than
  // `slope`.
  let windRipple = float(0);
  let windStrength = null;
  if (windHandle && !waveSurface) {
    if (windStrengthField) {
      const r = windStrengthField.uRect;
      const spanX = max(r.z.sub(r.x), float(1));
      const spanY = max(r.w.sub(r.y), float(1));
      const windUv = vec2(
        TSL.clamp(worldXY.x.sub(r.x).div(spanX), 0, 1),
        TSL.clamp(worldXY.y.sub(r.y).div(spanY), 0, 1)
      );
      windStrength = TSL.texture(windStrengthField.texture, windUv).r;
    } else {
      const windVec = windHandle.strengthNode(TSL, { centerXY: worldXY, time: timeMsNode });
      windStrength = length(windVec);
    }
    // Shelter-aware for free: `windStrength` is already near zero in a
    // sheltered spot (the SAME `openness`/wall-deflection every other wind
    // consumer reads through this handle), which is what makes "glassy-calm
    // in sheltered spots" fall out of this multiply rather than needing a
    // second, hand-rolled shelter test.
    const rippleExpr = windStrength.mul(length(vec2(shoaledY, shoaledZ))).mul(windRippleNode);
    // ⚠️ THE WHOLE WIND SAMPLER ONLY WHEN THE DIAL IS UP (2026-10-25, Water-
    // Performance-Audit W-08). `sampleWind` is a turbulence stack plus field
    // taps, and at `windRipple = 0` its result was multiplied by zero. A
    // UNIFORM branch (its texture taps stay legal); the nodes are built
    // eagerly above, outside the `Fn`, so nothing is created at shader-build
    // time.
    windRipple = Fn(() => {
      const out = float(0).toVar('waterWindRipple');
      If(windRippleNode.greaterThan(float(0)), () => {
        out.assign(rippleExpr);
      });
      return out;
    })();
  }

  // ── WEATHER ON THE SURFACE (2026-11-01) — see `buildRainRings`'s section ──
  // Local wind (gusts, shelter) where the handle samples it, else the ambient.
  // Ripples live in the wind's own frame: crests ACROSS the wind (short along
  // it, long across it), carried downwind by the CPU-integrated drift — the
  // ONE drift that is safe here, since it is uniform across space (the header
  // above on why a per-pixel direction × time is not).
  let rainSplash = float(0);
  let rainRough = float(0);
  let rainSlope = null;
  if (uWindDir && uWind01) {
    const windAmt = TSL.clamp(windStrength ?? uWind01, 0, 1.5);
    const along = dot(worldXY, uWindDir);
    const across = dot(worldXY, vec2(uWindDir.y.negate(), uWindDir.x));
    const rippleLen = max(uWaveScalePx.mul(float(WATER_WIND_RIPPLE_SCALE)), float(6));
    const drift = uWindDriftPx ? dot(uWindDriftPx, uWindDir) : float(0);
    const rc = vec2(along.sub(drift).div(rippleLen.mul(float(0.7))), across.div(rippleLen.mul(float(1.7))));
    const rn = mx_fractal_noise_vec3(vec3(rc.x, rc.y, tSec.mul(float(0.9))), 2, 2.0, 0.5);
    const gust = TSL.pow(windAmt, float(1.3)).mul(float(WATER_WIND_RIPPLE_SLOPE)).mul(windRippleNode);
    const rippleSlope = uWindDir.mul(rn.y).add(vec2(uWindDir.y.negate(), uWindDir.x).mul(rn.z.mul(float(0.45))));
    // the wave system already carries the wind (spectrum + the local wind texture); this layer is the fallback only
    if (!waveSurface) {
      slope = slope
        .mul(float(1).add(windAmt.mul(float(WATER_WIND_CHOP_GAIN))))
        .add(rippleSlope.mul(gust).mul(insideWater));
    }
  }
  if (uRain01) {
    const rings = buildRainRings(TSL, { worldXY, tSec, rain01: uRain01 });
    rainSlope = rings.slope.mul(insideWater);
    slope = slope.add(rainSlope);
    rainSplash = rings.splash.mul(insideWater);
    rainRough = uRain01;
  }

  // `windRipple` is exactly `float(0)` (a compile-time literal, not a live
  // zero) whenever `windHandle` is omitted — `.add()` on it is a genuine
  // no-op, so an unwired caller gets byte-identical `turbidity` to before
  // this rung existed.
  return {
    foam,
    turbidity: turbidity.add(windRipple),
    slope,
    domainOffset,
    bankWarp,
    bend: bendLimited,
    flowWarp,
    rainSplash,
    rainRough,
    rainSlope,
  };
}

// waterCausticsCpu (the Jacobian-focus CPU twin) was REMOVED 2026-08-27 along
// with the mechanism it tested — see "TIER 4 — CAUSTICS, A WORLEY F2−F1
// CELL-EDGE NET" above for why. The new mechanism's shape (a spatial Worley
// pattern, not a pure per-pixel formula over four scalars) is not usefully
// CPU-testable the same way; it is GPU/bench-verified instead, the same
// boundary `buildFoamCellularStructure`'s own Worley machinery already draws
// in this file's sibling module (`water-shore.js`).
