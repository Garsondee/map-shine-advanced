/**
 * THE WIND FIELD — Wind stops being a thing every effect invents for itself
 * and becomes ONE sampled function, owned here, that every consumer calls
 * with the SAME arguments.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS (the bug it fixes)
 * ============================================================================
 *
 * `sampleWind` below is `effects/candle-flame-render.js`'s own `candleWindLean`,
 * moved verbatim — same constants, same formula, same output for the same
 * input. That move is the original fix for a real, live bug: the candle
 * FLAME sampled `candleWindLean` directly, while the candle LIGHT
 * (`effects/lighting/animations/candle-flicker.js`) rolled its OWN, separate
 * lean/gust noise. A single candle's flame and its own light leaned in two
 * different winds. Both are repointed at THIS function (see those files' own
 * headers for the wiring), so a candle's flame and light now read the
 * identical field at the identical position.
 *
 * `world/` already owns the scene's AMBIENT wind scalar (`DEFAULT_WIND` /
 * `buildEnvSnapshot` in `environment.js` — `directionDeg`/`speed01`/
 * `gustiness01`), so this is the natural home for the field every consumer
 * samples, per that file's own door comment ("sun, environment, and
 * (eventually) weather/wind owners").
 *
 * `wind` is an OPTIONAL, backward-compatible argument — a live directional
 * ambient bias. `bakedField` is its geometry-aware companion (below). Neither
 * caller existed at first, so a consumer written before either did still gets
 * byte-identical output when it omits them.
 *
 * `liveField` (D_live, the transient advect/splat/relax/dissipate sim's own
 * output, `world/wind-sim-gpu.js`) is a THIRD, independent optional argument
 * in the same texture-grid shape, sampled and ADDED on top when present — a
 * door-gust rides on top of the ambient, never instead of it. Absent
 * (byte-identical omission) whenever the sim is frozen — "zero per-frame sim
 * cost" is enforced by never even building this branch's texture sample when
 * there is nothing transient to show, not by a uniform gated to zero
 * (`tsl/no-uniform-gates`). UNTOUCHED by the rethink below — Tier 2 is a
 * separate, out-of-scope mechanism this pass does not change.
 *
 * ============================================================================
 * 2026-07-22 — THE RETHINK: `bakedField` NOW CARRIES `openness`, NOT A
 * WALL-RELAXATION DEVIATION (read `docs/planning/Wind-Rethink.md` first)
 * ============================================================================
 * The coherent (directional) term used to be `ambient + D`, where `D` was a
 * potential-flow relaxation's per-cell deviation (`world/wind-bake.js#
 * bakeWindStructure`, now DELETED — see that file's own header for why: ~8
 * consecutive verify-green patches each fixed their target and revealed the
 * next failure, and the author's own decisive experiment — deleting every
 * wall in the scene and finding wind still died at the painted `_Outdoors`
 * mask's boundary — proved presence was being decided by paint, not
 * geometry). The replacement is a single geometry-only scalar, `openness`
 * (`world/wind-enclosure.js#floodFillOpenFromBoundary`): 1 where a cell is
 * connected to the map's open exterior through open space (walls/doors
 * only), 0 where it is sealed off. The coherent term is now simply
 * `ambient × openness` — no relaxation, no separate gate, no painted mask
 * anywhere in this computation. `openness` is packed into `bakedField`'s
 * texture (see the param doc below for which channel and why the other two
 * stay zero, not repurposed).
 *
 * The ORGANIC gust/flutter term (`result` below, before `wind`/`bakedField`
 * are even considered) is UNCHANGED by this rethink, though 2026-09-04's
 * Stage 1 later gated it by wind SPEED and deleted its indoor floor — see its
 * own block below. It is scaled by the `exposure` parameter, a SEPARATE input
 * from `openness` —
 * every existing caller of `sampleWind` already sources it however it always
 * has (candle/light construction-time painted-mask sampling; the particle
 * kernels' own per-cell lookup, itself switched to `openness` — see
 * `effects/particles/particle-runtime.js`'s own header). Leaving candle/
 * light/overlay's organic-term source untouched here is a deliberate,
 * documented scope boundary (`docs/planning/Wind-Rethink.md` §4.1: "a sealed
 * room can keep a tiny always-on residual if desired — that is the ONLY
 * thing the painted mask might still touch, and even that is optional"), NOT
 * an oversight — the coherent term (the actual "does wind get in" question)
 * is 100% geometry-driven for every caller now, which is the property that
 * was actually broken.
 *
 * ⚠ THE INVARIANT THIS CREATES: every caller that passes `wind` SHOULD also
 * pass `bakedField` (or accept an un-gated full-strength ambient blowing
 * indoors regardless of shelter). Every real call site already does this
 * (candle flame, candle light/coloration, the wind overlay, the wind+particle
 * probe), constructed AFTER the startup bake so `bakedField` is always a real
 * object (its VALUES may be zero at calm/no-bake-yet, but the object itself
 * is never null).
 *
 * @module world/wind-field
 */

import { WIND_DIAL_MAX_METRES_PER_SECOND, windStrength01ForSpeed01 } from './wind-scale.js';
import { windFlowVector } from './wind-bake.js';
import { getSafeProfile } from '../core/safe-mode.js';

// ─────────────────────────────────────────────────────────────────────────────
// ⭐ 2026-10-27 — ONE REAL SPEED FOR EVERYTHING THAT MOVES WITH THE WIND
// ─────────────────────────────────────────────────────────────────────────────
// The author, watching the wind overlay: *"Almost nothing seemed to be reacting
// in time with these high red large arrow waves... the rain moves at a
// COMPLETELY different pace entirely"* and *"Overall wave speed seemed extremely
// low. A grid space in Foundry in PF2E is 5ft x 5ft - so you could try and find
// real world values and get the visuals to match them."*
//
// Two different clocks were in play. Turbulence was Taylor-advected at the real
// wind speed, but the gust fronts — the red waves she was watching — travelled
// at a hand-set `900 px/s × mix(0.4, 1, speed)`, a number with no unit behind it
// and no knowledge of the scene's grid. Every consumer then added its own third
// and fourth clocks on top. Now:
//
//   - the dial is linear in m/s (`wind-scale.js`, 70 m/s at full), so a field
//     vector in dial units converts to m/s by ×70 and to world px/s by
//     ×pixelsPerMetre — {@link windFieldPxPerSecPerUnit};
//   - gust fronts AND turbulence are carried downwind at that one real speed
//     (Taylor's frozen-turbulence hypothesis — a gust IS a patch of fast air,
//     so it arrives at the speed the air does);
//   - `pixelsPerMetre` comes from the scene's own grid (`core/scene-scale.js`),
//     carried on the ambient wind object, so a 200 px / 5 ft map gets the same
//     real speed as a 100 px one rather than half of it.

/** The px/m a 100 px / 5 ft square gives — the fallback when a caller has no
 *  scene scale to pass (`core/scene-scale.js` derives the real one). */
export const WIND_DEFAULT_PIXELS_PER_METRE = 65.6;

/**
 * World px/s per unit of field vector — the ONE conversion from what
 * `sampleWind` returns (dial units: `flow × speed01 × gust`) to how fast air
 * at that point really moves on screen. Works on numbers or TSL nodes.
 * @param {number|*} pixelsPerMetre
 * @returns {number|*}
 */
export function windFieldPxPerSecPerUnit(pixelsPerMetre) {
  if (typeof pixelsPerMetre === 'number') return WIND_DIAL_MAX_METRES_PER_SECOND * pixelsPerMetre;
  return pixelsPerMetre.mul(WIND_DIAL_MAX_METRES_PER_SECOND);
}

/**
 * How far along its "gale character" ramp the wind is, 0..1, reached at
 * {@link WIND_GALE_CHARACTER_MPS}. Every speed-keyed SHAPE in this file (how
 * often gusts come, how fine their pattern is, how turbulent open ground gets)
 * ramps on this — in REAL m/s — rather than on the raw dial, so moving the dial's
 * labelling (2026-10-27) changed none of them at a given real speed.
 * @param {*} TSL @param {*} speed01 - float node.
 */
export function windGaleCharacterNode(TSL, speed01) {
  const { float, clamp } = TSL;
  return clamp(speed01.mul(float(WIND_DIAL_MAX_METRES_PER_SECOND / WIND_GALE_CHARACTER_MPS)), float(0), float(1));
}
/**
 * TSL twin of `wind-scale.js#windStrength01ForSpeed01` — Beaufort force ÷ 12
 * from the live dial, for any shader LOOK tuned on the old 0..1 (see that
 * function for why). `B = (v / 0.836)^(2/3)`, capped at 12.
 * @param {*} TSL @param {*} speed01 - float node.
 */
export function windStrength01Node(TSL, speed01) {
  const { float, clamp, pow, max } = TSL;
  const mps = max(speed01, float(0)).mul(float(WIND_DIAL_MAX_METRES_PER_SECOND));
  return clamp(pow(mps.div(float(0.836)), float(2 / 3)).div(float(12)), float(0), float(1));
}
/** Hurricane threshold (Beaufort 12 / Saffir-Simpson Cat 1). Gust and
 *  turbulence character is fully developed here; beyond it the wind only
 *  gets faster, which the real-speed advection already shows. */
export const WIND_GALE_CHARACTER_MPS = 33;

// ── The organic drift/gust/flutter constants that used to live here
// ── (WIND_SPACE_FREQ / WIND_DRIFT / WIND_GUST_RATE / WIND_FLUTTER_RATE /
// ── WIND_FLUTTER_AMP) were DELETED 2026-09-04 with the layer they tuned —
// ── mythica-machina-press#499. They were a hand-rolled stand-in for a
// ── spectrum; `computeWindTurbulence`'s fBm stack is the real thing.
// (`WIND_INDOOR_RESIDUAL`, an always-on 0.18 floor on the organic term, was
// DELETED 2026-09-04 — mythica-machina-press#498. It had no physical cause;
// its job passes to Stage 5's buoyant convection from real heat sources.)

// ── TURBULENCE (2026-07-22, author request: "make the wind more chaotic
// ── both inside and outside") — see this function's own body for the full
// ── reasoning; these are its tuning knobs, same "tuned by eye" posture as
// ── the constants above.
//
// TWO INDEPENDENT OCTAVES (2026-07-23, author: "a wider range of vectors in
// interior turbulent spaces, ideally with some vectors pointing backwards
// against the wind... a more rapid shifting of angle in interior space
// turbulence so that we get bigger and more dramatic swings of angle inside
// buildings... increase the turbulence of the wind in the outside too but
// on a much larger scale") — REPLACES the old single shared curl field
// (one frequency/rate, amplitude-only indoor/outdoor split) with two
// genuinely separate psi fields, decorrelated by phase offset (see
// `computeWindTurbulence`'s own `computeCurlOctave` calls): INDOOR keeps the original
// fine, room-corner spatial scale but churns MUCH faster over time (angle
// swings, not just amplitude); OUTDOOR keeps a churn rate close to the
// original shared value but spans a MUCH larger area (weather-scale eddies,
// not a room corner). Splitting them means cranking indoor drama can never
// accidentally speed up the outdoor gale's own swirl, and vice versa.
// ─────────────────────────────────────────────────────────────────────────────
// ⭐ THE SPECTRUM (2026-09-04, mythica-machina-press#497 Stage 2 / #499) —
// REPLACING THE TWO FIXED OCTAVES ABOVE
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ TWO OCTAVES IS TWO RHYTHMS, AND THAT WAS THE BUG. The author's report was
// *"the distance between gusts is always the same"* and *"the amplitude of
// waves is identical"* — two symptoms, one cause. A field built from exactly
// two spatial scales can only ever produce two gust sizes, and the discrete
// gust envelope's single thresholded frequency saturates every crossing to the
// same peak. Neither is a tuning miss; there was nothing in the model capable
// of producing variety.
//
// Real turbulence is BROADBAND. Kolmogorov's inertial subrange gives an energy
// spectrum `E(k) ∝ k^(−5/3)`, which for velocity means an eddy of scale λ
// carries amplitude ∝ λ^(1/3). So halving the scale each octave multiplies the
// amplitude by `2^(−1/3) ≈ 0.794` — that ONE number is what makes a stack of
// curl octaves read as air rather than as noise, and it is why varied gust
// spacing and varied gust amplitude both fall out for free rather than being
// two features to add. A spectrum IS a distribution of sizes and strengths.
const WIND_TURBULENCE_LACUNARITY = 2; // each octave halves the eddy size
/** The Kolmogorov amplitude ratio, `2^(−1/3)`. NOT a taste constant — deriving
 *  it from the −5/3 slope is the whole point; a "nicer looking" 0.5 (the usual
 *  fBm default) would make the fine detail vanish and take the variety with it. */
const WIND_TURBULENCE_GAIN = Math.pow(2, -1 / 3);
/**
 * The LARGEST eddy in the stack, in real metres.
 *
 * The atmospheric boundary layer's own integral length scale is ~100-300 m near
 * the surface — larger than a typical battle map, which is why the very top of
 * the real spectrum is NOT modelled here: an eddy bigger than the view is
 * indistinguishable from the mean wind changing, and that is exactly what
 * {@link computeGustEnvelope}'s travelling fronts already provide. So the
 * division of labour is physical rather than arbitrary: gust fronts carry the
 * energy-containing range, this stack carries the inertial subrange below it.
 *
 * 32 m spans a good fraction of a scene; four octaves reach 4 m, a
 * corner-of-a-room eddy, covering the same span the old two octaves did (~667px
 * and ~125px) with four rungs and a real falloff instead of two flat amplitudes.
 */
const WIND_TURBULENCE_BASE_LENGTH_M = 32;
/**
 * ⚠️ A DOCUMENTED ASSUMPTION, not a measurement. Converting the metre-denominated
 * scales above into the world px the shader samples in needs the scene's own
 * pixel scale, and this function is pure TSL with no scene access. 65.6 px/m is
 * the standard 5 ft / 100 px square (`core/scene-scale.js` derives it properly),
 * which is what nearly every map in this catalogue is.
 *
 * Making this live per-scene is real follow-up work (it belongs with #506's
 * real-units pass) — recorded here rather than faked, because a scene at a very
 * different scale currently gets eddies of the wrong physical size, which is a
 * known limitation and not a silent one.
 */
const WIND_TURBULENCE_ASSUMED_PX_PER_M = WIND_DEFAULT_PIXELS_PER_METRE;
/** How many octaves the stack runs. A build-time QUALITY TIER, never a uniform
 *  (`tsl/no-uniform-gates`). Honest cost: `curlNoise2D` is 4 noise evaluations,
 *  so 4 octaves is 16 — against the 13 the old model spent (2 octaves = 8, plus
 *  the 5 the now-deleted organic term used). Dropping to 3 is cheaper than what
 *  this replaces. */
export const WIND_TURBULENCE_OCTAVES_DEFAULT = 4;
/**
 * How fast the LARGEST eddy evolves in place, per second.
 *
 * Deliberately small, because in a Taylor-advected field most of the apparent
 * churn is the pattern SWEEPING PAST rather than changing shape — see
 * {@link computeWindTurbulence}'s advection block. Smaller eddies turn over
 * faster (turnover time ~ λ/u), so each octave's rate is scaled by the
 * lacunarity: octave `i` churns `2^i` times faster than the base. That is a
 * real relation, replacing the old pair of hand-set indoor/outdoor rates.
 */
const WIND_TURBULENCE_BASE_CHURN_RATE = 0.28;
const WIND_TURBULENCE_CURL_EPS = 0.4; // finite-difference step, in the SAME already-scaled noise-space as each octave's own frequency — because eps is applied AFTER the world→noise-space scale, the same relative value samples a proportionally-similar fraction of a "feature" at either octave's own scale, no separate eps needed per octave.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⭐ TURBULENCE INTENSITY, REPLACING THE THREE HAND-SET AMPLITUDES + THE CAP
// ─────────────────────────────────────────────────────────────────────────────
//
// Real turbulence is quoted as an INTENSITY: `I = σ_u / U`, the ratio of the
// fluctuation to the mean. For a given terrain it is roughly CONSTANT with
// speed, so the absolute gustiness `σ_u = I · U` grows with the mean while the
// character stays a property of the ground.
//
// ⚠️ WHY THE OLD ENERGY CAP WAS THE WRONG SHAPE, not just the wrong number. It
// rescaled the composed vector down to never exceed `speed01` — a CLAMP, not a
// proportionality — which is wrong at both ends: at low speed the fixed
// amplitudes were proportionally enormous (a whisper of wind with gale-sized
// swirl on top), and above roughly half dial everything clipped to the same
// ceiling, so the top half of the dial all looked alike. That is a large part
// of *"1 wind doesn't actually look hurricane"*: a real gale is DOMINATED by
// its mean, and the old model kept the noise competing with it at every speed.
// Multiplying instead of clamping also makes `U = 0` produce exactly zero by
// construction, with no cap to rely on.
//
// The values below are real. Open country sits near 0.15-0.20; built-up and
// suburban terrain 0.25-0.35; a separated shear layer at an opening is far
// higher still.
/** Open, exposed ground — real open-country turbulence intensity. */
const WIND_TI_OPEN = 0.16;
/** Built-up / close to geometry — real suburban-to-urban intensity. */
const WIND_TI_ROUGH = 0.3;
/**
 * ⚠️ A LOOK CHOICE ON TOP OF THE PHYSICS (2026-10-27, author: *"Boost the amount
 * of wind turbulence outside so that we get some turbulence appearing at higher
 * wind values."*). At a constant `I` the swirl is always the same FRACTION of the
 * mean, so in a gale every arrow points the same way — honest for a weather mast
 * 10 m up, but a battle map is at ground level among walls, trees and debris,
 * where the gusty, swirling part of a storm is what you actually see. Outdoor
 * intensity is multiplied by `1 + this × galeCharacter`, so it is unchanged in a
 * breeze and rises to ~2.2× (I ≈ 0.35-0.65) at hurricane force.
 */
const WIND_TI_GALE_BOOST = 1.2;
/**
 * THE DOORWAY / SHEAR-LAYER PEAK, and why a number far above the others is
 * physically honest rather than a fudge for drama.
 *
 * The author asked for *"a wider range of vectors in interior turbulent
 * spaces, ideally with some vectors pointing backwards against the wind"*, and
 * a separated shear layer really does behave that way: intensities of 0.4-0.6
 * are ordinary in one. Crucially the ratio is to the FREE-STREAM speed, while
 * the local MEAN at that spot has already been gated toward zero by `openness`
 * — so a fluctuation of 0.55·U against a local mean near 0 still swings the
 * total vector all the way around, exactly as before, without the model having
 * to claim turbulence exceeds the wind that drives it.
 */
const WIND_TI_SHEAR_PEAK = 0.75; // was 0.55 — raised 2026-10-27 with the doorway push, author: "Make the effect stronger which pushes wind AROUND buildings and into open doorways."
/** A sealed room. Not zero — real rooms have residual air motion — but small
 *  enough that it reads as still, and multiplied by `U` it reaches exactly zero
 *  at a dead calm regardless (#498). */
const WIND_TI_SEALED = 0.02;

// How much of a blocked (into-wall) push reappears as extra sideways push
// along the wall, relative to how much tangential lean the flow already had
// (see `deflectAroundWalls`'s own header) — a tune-by-eye starting value,
// same posture as every other look constant in this file. RETUNED 1.5→1.0
// (2026-07-23, same live report as the energy cap just below this constant's
// own consumer — a lower baseline means the pre-clamp overshoot the cap has
// to correct is smaller and less frequent, not just silently corrected
// every time).
const WALL_DEFLECT_REDIRECT_GAIN = 1.8;
// ↑ RAISED 1.0→1.8 (2026-10-27, author: *"Make the effect stronger which pushes
// wind AROUND buildings"*) — together with the corner speed-up below.

/**
 * CORNER SPEED-UP (2026-10-27). Air forced around a building ACCELERATES at its
 * corners and along its flanks — measured speed-ups are 1.2-1.5× the free stream
 * (the reason building corners are the windiest spots in a city). The energy cap
 * in {@link deflectAroundWalls} used to forbid that outright, because particle
 * kernels feed the result back into a stored velocity every frame and any ratio
 * above 1 compounds. So the ratio is now a parameter: 1 (the old hard cap) for
 * the feedback paths, this for the FIELD sample, which is recomputed fresh from
 * the dial every frame and can never compound.
 */
export const WALL_CORNER_SPEEDUP = 1.35;

// How strongly the OPTIONAL chaotic impact kick (see `deflectAroundWalls`'s
// own header) scatters a mote relative to how much speed the impact is
// cancelling — a tune-by-eye starting value, exported so both particle
// kernels share the identical number rather than drifting apart.
export const WALL_IMPACT_CHAOS_GAIN = 0.7;

// THE MOMENTUM GUARD'S OWN, NARROWER threshold (2026-07-23, author, screenshot
// showing particles piling up EVEN FURTHER out after the reach was widened:
// "particles are now deflecting even further from the walls... it's causing
// the particles to immediately veer away causing them to pile up a long way
// away from the wall") — see particle-runtime.js's/gust-runtime.js's own
// momentum-deflection call sites for the full "why a SECOND, narrower
// threshold" reasoning; in short, `WALL_DEFLECT_REACH_CELLS`'s own wide 0..1
// `wallProximity` is remapped through `smoothstep(LOW, HIGH, wallProximity)`
// there so the INSTANT, unrate-limited momentum correction only engages in
// roughly the last ~15% of the approach (right before contact), while the
// wide band keeps doing its job feeding the TARGET velocity, which turns
// GRADUALLY via the kernel's own existing acceleration limit rather than
// snapping. Values are thresholds on the ALREADY-EASED `wallProximity`
// output (not raw distance) — tune-by-eye, like everything else here.
export const WALL_MOMENTUM_GUARD_LOW = 0.75;
export const WALL_MOMENTUM_GUARD_HIGH = 1.0;

// WIND SHADOW DEPTH (2026-08-01) — how much of the coherent wind a FULLY
// occluded cell loses. Deliberately below 1: a leeward wake is slack and
// recirculating, not still, so leaving ~15% of the directional term keeps the
// shadow reading as sheltered air rather than as a hole cut in the field. The
// geometry (`world/wind-enclosure.js#upwindShelter`) bakes a raw 0..1
// occlusion; this is the ONE place its visual strength is decided, so a
// "shadows are too strong/weak" note is a one-number change here, never a
// re-bake of the geometry.
export const WIND_SHADOW_DEPTH = 0.85;

// ─────────────────────────────────────────────────────────────────────────────
// DISCRETE GUSTS (2026-08-15, author: *"It would be nice if the wind model
// could create discreet wind gusts and therefore could be more unpredictable
// in terms of it's pattern."*)
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ WHAT WAS ACTUALLY MISSING, AND WHY THE EXISTING "gust" TERM ISN'T IT.
// `sampleWind` has had a local called `gust` since day one:
//
//     const gust = perlin(vec2(t * WIND_GUST_RATE, 3)) * 0.5 + 0.5
//
// Two things disqualify it from being what was asked for. It is a function of
// TIME ALONE, so it has the same value at every position on the map at a given
// instant — a whole-scene brightness dial on the breeze, never a gust that
// arrives somewhere. And it multiplies only the ORGANIC drift term, never the
// COHERENT ambient — so the prevailing wind, the thing that actually drives
// vegetation sway, particle motion and every downstream consumer, has never
// gusted at all. It is a constant dial with noise painted on one small
// component. That local is left exactly as it is; this is a second, separate
// term layered on the part that was genuinely missing.
//
// ⚠️ `gustiness01` HAS EXISTED IN THE ENVIRONMENT SNAPSHOT THE WHOLE TIME AND
// NOTHING READ IT (`world/environment.js`'s `DEFAULT_WIND` declares it,
// `buildEnvSnapshot` clamps it, and a grep across `src/` finds zero consumers).
// That is [[feedback_unconsumed_api_rots_silently]] verbatim: a well-formed
// value, correctly plumbed to the edge of the system, driving nothing. This is
// the consumer it was declared for.
//
// THREE PROPERTIES, and each is a deliberate answer to a word in the request:
//
//   "DISCREET" — the envelope is a THRESHOLDED noise, not a wobble. Most of the
//     time it sits at `WIND_GUST_LULL`; a gust is a distinct, recognisable
//     event that rises and passes. A smooth sinusoid modulating amplitude would
//     have been much easier and would have read as breathing, not as weather.
//   "UNPREDICTABLE IN ITS PATTERN" — the threshold is crossed by a noise field
//     sampled in SPACE as well as time, so gusts are not scene-wide events on a
//     shared clock. Two points far apart are in different gusts.
//   "WIND MODEL" (not "wind look") — it scales the COHERENT term, so every
//     consumer of the shared field inherits it with no wiring of its own, and
//     the turbulence cap gusts with it (a gusting wind is more turbulent while
//     the gust is passing — see `sampleWind`'s own call).
//
// AND ONE PROPERTY NOBODY ASKED FOR BUT THE GEOMETRY MAKES FREE: the pattern
// TRAVELS DOWNWIND. The along-flow coordinate is advected by
// `WIND_GUST_TRAVEL_PX_PER_SEC`, so a gust front genuinely sweeps across the
// map — distant vegetation moves, then nearer vegetation, then you. That is
// the same "wind arrives rather than exists" the vegetation arrival lag
// (`effects/vegetation.js#VEGETATION_KINDS`) delivers vertically, here
// delivered horizontally, and it costs one subtraction.

// ⚠️ 2026-10-27: THE TRAVEL SPEED IS NO LONGER A CONSTANT. Gust fronts used to
// sweep at `900 px/s × mix(0.4, 1, speed)` — a pace unrelated to the wind they
// were part of and to the scene's grid, which is the "rain moves at a
// COMPLETELY different pace" the author reported. They now ride the real mean
// wind (Taylor advection, exactly as the turbulence stack does), so a gust
// crosses a 5 ft square in `1.52 m ÷ U` seconds — 0.04 s in a 35 m/s hurricane.
//
// The pattern's SIZE is real too, in metres: a gust's along-wind length is the
// distance the air covers in a gust's lifetime (a few seconds), so it grows
// with the wind — `U × WIND_GUST_PERIOD_S`, held between the bounds below so a
// breeze's gusts still fit a room and a hurricane's still fit a battle map.
/** How long a typical gust takes to pass a point, seconds. Real gusts last
 *  ~2-5 s (the WMO gust is a 3 s average); 2.5 keeps several visible on a map. */
export const WIND_GUST_PERIOD_S = 2.5;
/** Bounds on a gust's along-wind length, metres. */
export const WIND_GUST_LENGTH_MIN_M = 9;
export const WIND_GUST_LENGTH_MAX_M = 60;
/** Cross-wind scale, as a FRACTION of the along-wind one. Below 1 so a gust
 *  front is broad and only gently wavy — a front is a line of weather, not a
 *  blob. At 0 fronts would be perfectly straight infinite walls. */
export const WIND_GUST_CROSS_FREQ_RATIO = 0.4;
/** A gust grows and dies while it travels rather than being a frozen stamp —
 *  how many lifetimes per gust period the pattern evolves through. */
export const WIND_GUST_EVOLVE_PER_PERIOD = 0.35;
/** World→noise scale ALONG the wind at the DEFAULT scene scale and a gust of
 *  {@link WIND_GUST_LENGTH_MIN_M} — kept for the probe and tests; the live
 *  value is computed per speed and per scene in {@link computeGustEnvelope}. */
export const WIND_GUST_SPACE_FREQ = 1 / (WIND_GUST_LENGTH_MIN_M * WIND_DEFAULT_PIXELS_PER_METRE);
// ─────────────────────────────────────────────────────────────────────────────
// GUST RATE FOLLOWS WIND SPEED (2026-08-15, author, after the first cut shipped
// with gustiness as an independent dial): *"I think linking gustiness to overall
// wind speed makes the most sense. At low wind values the gusts are extremely
// few and far between but as wind speed increases the gap between wind blasts
// gets shorter until at full wind speed you get a malestrom of strong wind
// gusts all the time."*
//
// TWO LEVERS MOVE WITH SPEED, AND ONE DELIBERATELY DOES NOT.
//
//   1. THE THRESHOLD FALLS — from `..._CALM` (crossed rarely: isolated blasts
//      with long quiet between) toward `..._GALE`. This is literally "the gap
//      between wind blasts gets shorter".
//   2. THE PATTERN GETS FINER — `..._SPACE_FREQ` is scaled up by
//      `..._FREQ_GALE_SCALE`, so more gust fronts occupy the same stretch of
//      map and they arrive in quicker succession. Travel speed rises too
//      (`..._TRAVEL_CALM_SCALE`), because a gale's gusts genuinely move faster.
//
//   3. THE THRESHOLD DOES **NOT** GO TO ZERO AT FULL WIND, and that restraint
//      is the whole difference between "a maelstrom of gusts" and "no gusts at
//      all". Driving it to 0 would make `gustShape` saturate at 1 everywhere —
//      a uniformly 2× wind with the variation flattened out of it, which is
//      exactly what the author is NOT asking for. `..._GALE` sits near the
//      noise's own median so blasts and brief lulls alternate rapidly. A gale
//      is violent AND uneven; a constant is neither.
// ⚠️ 2026-10-27 RETUNE — "single waves alone in a sea of inactivity". The
// thresholds used to be compared against `n·0.5+0.5`, but MaterialX Perlin's
// spread is only ~±0.25 around its median, so the 0.25-wide smoothstep band
// above a 0.62 threshold was almost never climbed to the top: most of the map
// sat at the 0.55 lull and the occasional crest barely reached peak. The
// thresholds now act on a STANDARDISED noise (`z`, roughly unit spread — see
// {@link WIND_GUST_NOISE_SPREAD}), the lull is shallower, and a second, finer
// octave gives gusts of more than one size.
/** Divides the summed noise into a roughly unit-spread `z`. */
export const WIND_GUST_NOISE_SPREAD = 0.3;
/** The threshold (in `z`) at a dead calm — high, so a gust is an event. */
export const WIND_GUST_THRESHOLD_CALM = 0.9;
/** The threshold at a fully developed gale — below the median, so more than
 *  half the map is inside a gust at any moment while lulls still cross it.
 *  See point 3 above for why this is never -∞. */
export const WIND_GUST_THRESHOLD_GALE = -0.35;
/** Width (in `z`) of the band over which a gust rises to its peak. */
export const WIND_GUST_SHARPNESS = 0.7;
/** The envelope between gusts, at FULL gustiness. Below 1 (a lull is half of
 *  what makes a gust read as one) but no longer a dead sea: real lulls sit at
 *  ~0.6-0.8 of the mean. */
export const WIND_GUST_LULL = 0.7;
/** The envelope AT a gust's crest, at full gustiness. Real peak gust factors are
 *  1.4-1.7 over open ground and ~2 among buildings; the finer octave adds its
 *  own ±{@link WIND_GUST_RIPPLE} on top, so crests vary. */
export const WIND_GUST_PEAK = 1.75;
/** Gust-to-gust variety: the finer octave modulates the envelope by ±this. */
export const WIND_GUST_RIPPLE = 0.18;
/**
 * THE SHIPPED DEFAULT gustiness — now FULL, and the reason it moved.
 *
 * ⚠️ THIS PARAMETER CHANGED MEANING ON 2026-08-15 and the default had to follow.
 * It shipped that morning as the only thing controlling gusts at all, so 0.45
 * was a sensible "some gusting, not the full swing". Then the author's own
 * correction — *"linking gustiness to overall wind speed makes the most
 * sense"* — moved HOW OFTEN gusts arrive onto `speed01`, leaving this to mean
 * only HOW PRONOUNCED a gust is when one does arrive.
 *
 * Under the new meaning 0.45 would be a permanent half-strength damper on a
 * mechanism the wind dial is now supposed to govern end to end — quietly
 * fighting the author's own steering. 1 is the neutral value for a
 * pronouncedness dial: the gusts are as deep as the constants above describe,
 * and how often they come is the wind's business.
 *
 * Lives HERE, beside the constants that shape the envelope, so the uniform's
 * initial value and the debug select's own default read the same number
 * instead of two hand-kept copies drifting apart.
 */
export const WIND_DEFAULT_GUSTINESS01 = 1;

/**
 * ⭐ THE TSL TWIN of `world/wind-bake.js#windFlowVector` — the ONE
 * angle→vector conversion, for every shader-side consumer. Read that
 * function's header for the convention itself (compass bearing, 0° = north,
 * clockwise, naming the direction the wind blows TOWARD) and for the account
 * of the three disagreeing readings this replaced.
 *
 * The two implementations are pinned against each other by a Node assertion
 * in `world/__tests__/wind-bake.test.mjs` — the same discipline
 * `effects/precipitation/precip-species.js` already used for its own CPU/GPU
 * twin, and for the same reason: a compass error in TSL is invisible in code
 * review and glaring on a live map.
 *
 * @param {*} TSL - THREE.TSL (needs `float, vec2, cos, sin`).
 * @param {*} directionDeg - float node, compass bearing in degrees.
 * @returns {*} a vec2 node — a UNIT vector in raw world space.
 */
export function windFlowVectorNode(TSL, directionDeg) {
  const { float, vec2, cos, sin } = TSL;
  const rad = directionDeg.mul(float(Math.PI / 180));
  return vec2(sin(rad), cos(rad).negate());
}

/**
 * THE GUST ENVELOPE — a 0..N multiplier on the COHERENT wind, travelling
 * downwind. See the constants above for the full "what was missing" account.
 *
 * ⚠️ EXACTLY 1 WHEN `gustiness01` IS 0 OR ABSENT, by construction, not by a
 * small-constant hope: the final `mix(1, shaped, gustiness01)` collapses to
 * literally `float(1)` at 0, and the whole function is skipped at JS time when
 * the argument is absent. A scene that never touches gustiness produces
 * byte-identical output to before this existed — the same omission guarantee
 * every other optional input in this file keeps (`tsl/no-uniform-gates`: the
 * ABSENT case is a JS branch, not a uniform multiplied by zero).
 *
 * @param {*} TSL - THREE.TSL (needs `float, vec2, mx_noise_float, clamp, mix, smoothstep, cos, sin`).
 * @param {object} args
 * @param {*} args.centerXY - vec2 node, the WORLD position being sampled.
 * @param {*} args.time - the shared clock (uGlobalTimeMs, ms).
 * @param {*} args.directionDeg - float node, a COMPASS BEARING (0° = north,
 *   clockwise, naming the direction the wind blows TOWARD) — resolved through
 *   the SAME {@link windFlowVectorNode} helper `sampleWind` uses. Gusts travel
 *   WITH the flow, so this reads the identical vector the flow does; getting
 *   it backwards would send fronts marching upwind, which is this project's
 *   own recurring frame-of-reference bug class ([[feedback_y_flip_recurring_risk]]).
 * @param {*} args.gustiness01 - float node, 0..1.
 * @param {{clockMs:*, gustPhase:*}} [args.advection] - the ambient's INTEGRATED
 *   advection uniforms ({@link createWindAdvectionUniforms}). Every live caller
 *   passes it: the fronts are then placed by how far they have travelled, so a
 *   wind fade changes their pace and never teleports them. Omitted → the old
 *   `speed × t` placement, exact only while the speed holds still (tests and
 *   probes that pin a constant wind).
 * @returns {*} a float node — 1 at gustiness 0, ranging between
 *   `WIND_GUST_LULL` and `WIND_GUST_PEAK` at gustiness 1.
 */
export function computeGustEnvelope(
  TSL,
  { centerXY, time, directionDeg, gustiness01, speed01, pixelsPerMetre, advection }
) {
  return createGustEnvelopeSampler(TSL, { centerXY, directionDeg, gustiness01, speed01, pixelsPerMetre, advection })(
    time
  );
}

/**
 * ⭐ THE GUST ENVELOPE AT ONE PLACE, AT ANY NUMBER OF MOMENTS (2026-10-27) —
 * {@link computeGustEnvelope} split in two: everything that depends only on the
 * place and the wind (direction, gust length, the along/across coordinates, the
 * threshold) is built ONCE here; the returned function adds only what moves
 * with time (the phase, the evolve term, the two noises and the shaping).
 *
 * ⚠️ WHY IT EXISTS: SHADER SIZE IS A CRASH, NOT A COST. A candle remembers ~8 s
 * of wind by sampling this at 14 past moments (`effects/candle-wind-state.js`),
 * unrolled into the vertex stage of the flame and of every candle LIGHT shader.
 * Calling `computeGustEnvelope` per moment rebuilt all of the place-only maths
 * 14 times over. On Windows, Chrome compiles WGSL inside its GPU process, and a
 * cold load compiling a burst of shaders that large stalled that process past
 * its watchdog: `RESULT_CODE_HUNG`, then "A valid external Instance reference no
 * longer exists" and every context on the page lost at once. The look-back now
 * pays only the time-dependent half per moment — byte-identical output.
 *
 * @param {*} TSL
 * @param {object} args - {@link computeGustEnvelope}'s arguments, minus `time`.
 * @returns {(time: *) => *} ms node → the envelope, a float node.
 */
export function createGustEnvelopeSampler(
  TSL,
  { centerXY, directionDeg, gustiness01, speed01, pixelsPerMetre, advection }
) {
  const { float, vec2, mx_noise_float: perlin, clamp, mix, smoothstep, max, min } = TSL;
  // THE SPEED LINK — see the "GUST RATE FOLLOWS WIND SPEED" block above. Absent
  // `speed01` ⇒ `float(0)`, i.e. the CALM end of every ramp: rare, slow, coarse
  // gusts. That is the honest default for a caller with no wind-speed concept
  // (it cannot claim a gale), and it keeps this function total rather than
  // requiring a fourth mandatory argument every existing call site would have
  // to grow.
  const speed = speed01 !== undefined ? clamp(speed01, float(0), float(1)) : float(0);
  // The SHAPE ramps on real m/s (fully developed at hurricane force) — see
  // {@link windGaleCharacterNode}.
  const s = windGaleCharacterNode(TSL, speed);
  const ppm = pixelsPerMetre !== undefined ? float(pixelsPerMetre) : float(WIND_DEFAULT_PIXELS_PER_METRE);
  // THE FLOW direction, and its perpendicular. Through the ONE shared helper
  // ({@link windFlowVectorNode}) that `sampleWind`'s own coherent term also
  // uses — they MUST stay the same: a gust front travelling at an angle to
  // the wind it is modulating would read as two unrelated weather systems.
  const flow = windFlowVectorNode(TSL, directionDeg);
  const perp = vec2(flow.y.negate(), flow.x);
  // ⭐ THE REAL SPEED (2026-10-27). Fronts ride the mean wind — the SAME px/s
  // the turbulence stack is advected at and every consumer moves at
  // ({@link windFieldPxPerSecPerUnit}). Subtracting the travel term means a
  // point reads the pattern value that started upwind of it, i.e. the gust
  // ARRIVES.
  const travelPxPerSec = speed.mul(windFieldPxPerSecPerUnit(ppm));
  // A gust's along-wind length is the distance the air covers in a gust's
  // lifetime — longer in a gale, bounded so it stays a feature of the map.
  const metresPerSecond = speed.mul(float(WIND_DIAL_MAX_METRES_PER_SECOND));
  const gustLengthM = clamp(
    metresPerSecond.mul(float(WIND_GUST_PERIOD_S)),
    float(WIND_GUST_LENGTH_MIN_M),
    float(WIND_GUST_LENGTH_MAX_M)
  );
  const spaceFreq = float(1).div(gustLengthM.mul(ppm));
  const along = centerXY.x.mul(flow.x).add(centerXY.y.mul(flow.y));
  const across = centerXY.x.mul(perp.x).add(centerXY.y.mul(perp.y));
  const fineFreq = spaceFreq.mul(float(2.3));
  // The place-only halves of both noise coordinates, built once.
  const alongCoarse = along.mul(spaceFreq);
  const acrossCoarse = across.mul(spaceFreq).mul(float(WIND_GUST_CROSS_FREQ_RATIO));
  const alongFine = along.mul(fineFreq).add(float(41.7));
  const acrossFine = across.mul(fineFreq).mul(float(0.6)).add(float(19.3));
  // How fast the coarse octave slides, noise units per second (the integrated
  // phase's own rate — see `windGustPhaseRate`).
  const phaseRate = metresPerSecond.div(gustLengthM);
  // THE DISCRETENESS. Below the threshold the coarse shape is flat — a genuine
  // lull — and it climbs to the crest across the sharpness band. The threshold
  // FALLS with wind speed (lever 1): rare blasts in a breeze, more than half the
  // map gusting in a hurricane — never everywhere (lever 3).
  const threshold = mix(float(WIND_GUST_THRESHOLD_CALM), float(WIND_GUST_THRESHOLD_GALE), s);
  const thresholdTop = threshold.add(float(WIND_GUST_SHARPNESS));
  const gust01 = clamp(gustiness01, float(0), float(1));

  return (time) => {
    const t = time.mul(float(0.001)); // ms → seconds, same conversion every other term here uses
    // A gust grows and dies as it travels: the coarse octave rides exactly at U,
    // the finer one slightly faster and drifting across-wind, so the composite
    // keeps re-forming instead of sliding past as one frozen stamp.
    //
    // `phase` is how many noise units the coarse octave has slid — `travel ×
    // spaceFreq`. INTEGRATED when the caller has the ambient's advection (see the
    // "INTEGRATED ADVECTION" block above `createWindAdvectionState`): the speed and
    // the gust length both move during a wind fade, and their product times `t`
    // is what turned the fronts into white noise.
    const phase = advection
      ? advection.gustPhase.add(phaseRate.mul(windAdvectionDtSecNode(TSL, time, advection)))
      : t.mul(travelPxPerSec).mul(spaceFreq);
    const evolve = t.mul(float(WIND_GUST_EVOLVE_PER_PERIOD / WIND_GUST_PERIOD_S));
    const coarse = perlin(vec2(alongCoarse.sub(phase), acrossCoarse.add(evolve)));
    const fine = perlin(vec2(alongFine.sub(phase.mul(float(1.18 * 2.3))), acrossFine.sub(evolve.mul(float(1.7)))));
    const z = coarse.add(fine.mul(float(0.45))).div(float(WIND_GUST_NOISE_SPREAD));
    const gustShape = smoothstep(threshold, thresholdTop, z);
    const ripple = float(1).add(
      clamp(fine.div(float(WIND_GUST_NOISE_SPREAD)), float(-1), float(1)).mul(float(WIND_GUST_RIPPLE))
    );
    const shaped = mix(float(WIND_GUST_LULL), float(WIND_GUST_PEAK), gustShape).mul(ripple);
    const bounded = min(max(shaped, float(0.4)), float(2.2));
    return mix(float(1), bounded, gust01);
  };
}

/**
 * How fast the mean wind carries things across the map, world px/s — the speed
 * gust fronts travel at, and the one every consumer moving WITH the wind should
 * use. Plain-JS twin of the TSL travel term above.
 * @param {number} speed01 @param {number} [pixelsPerMetre]
 */
export function windTravelPxPerSec(speed01, pixelsPerMetre = WIND_DEFAULT_PIXELS_PER_METRE) {
  const s = Number.isFinite(speed01) ? Math.min(1, Math.max(0, speed01)) : 0;
  const ppm = Number.isFinite(pixelsPerMetre) && pixelsPerMetre > 0 ? pixelsPerMetre : WIND_DEFAULT_PIXELS_PER_METRE;
  return s * windFieldPxPerSecPerUnit(ppm);
}

// ─────────────────────────────────────────────────────────────────────────────
// ⭐ INTEGRATED ADVECTION (2026-10-27) — a pattern carried by the wind is placed
// by HOW FAR THE AIR HAS TRAVELLED, never by `speed × t`.
// ─────────────────────────────────────────────────────────────────────────────
// Author, fading 0 → 100% wind and rain over Fade Time 1m: *"wind thrashes
// vegetation to insane amounts very quickly, the rain darkening of the window
// effect goes berserk, it becomes a strobing nightmare."*
//
// ⚠️ THE BUG CLASS. Every travelling pattern here was placed at `x − U·t`, with
// `t` the seconds since the world loaded. That is exact while `U` holds still
// and wrong the moment it moves: the pattern's speed is `d(U·t)/dt = U + t·dU/dt`,
// and `t` is in the THOUSANDS. A 0 → 100% ramp over 60 s an hour into a session
// slid the turbulence by ~4,600 px/s × 3,600 s ÷ 60 s ≈ 280,000 px/s and the gust
// fronts across hundreds of noise cells per second — white noise, which every
// consumer then read as a gust: bushes thrashing, rain lashing sideways, the
// window's storm waves strobing. An instant change only ever made ONE jump,
// which is why nobody saw it until fades existed. (`computeWindTurbulence`'s own
// 2026-10-27 note found the SAME shape for a gust envelope varying in SPACE;
// this is its twin in TIME.)
//
// THE FIX is what the torrent layer already did (`stepTorrentState`) and what
// the cloud deck does: integrate on the CPU, once per frame, `∫ U dt`, and hand
// the shaders the DISTANCE. A speed change then changes how fast the pattern
// moves from now on, and never where it already is.
//
// Consumers ask for the field at their OWN time (a bush lags the tree by its
// arrival delay, a candle remembers ~8 s of wind). Those are a step back from
// `clockMs` at today's rate — {@link windAdvectionDtSecNode} — clamped, so a
// consumer on a different clock (the critters run on wall time) can be at most
// a bounded constant off, which is smooth, rather than `t` off, which is not.

/** How far behind `clockMs` a consumer may ask (the candle history is ~8.4 s). */
export const WIND_ADVECTION_LOOKBACK_MAX_S = 30;
/** How far ahead — one frame's worth of clock skew, no more. */
export const WIND_ADVECTION_LEAD_MAX_S = 1;
/** The longest single integration step — a stalled tab must not leap the pattern. */
export const WIND_ADVECTION_STEP_MAX_S = 0.25;

/**
 * How fast the gust pattern's coarse octave slides, in NOISE units per second.
 * Plain-JS twin of `computeGustEnvelope`'s own `travel × spaceFreq` — the px/m
 * cancels (both the travel and the gust's length are in real metres), so this
 * is scene-scale-free.
 * @param {number} speed01 @returns {number}
 */
export function windGustPhaseRate(speed01) {
  const s = Number.isFinite(speed01) ? Math.min(1, Math.max(0, speed01)) : 0;
  const mps = s * WIND_DIAL_MAX_METRES_PER_SECOND;
  const lengthM = Math.min(WIND_GUST_LENGTH_MAX_M, Math.max(WIND_GUST_LENGTH_MIN_M, mps * WIND_GUST_PERIOD_S));
  return mps / lengthM;
}

/**
 * @typedef {object} WindAdvectionState - every integral a wind-carried pattern
 *   needs, in seconds of the clock `clockMs` is on.
 * @property {number} clockMs - the clock value the integrals are current at.
 * @property {number[]} speedFlowSec - `∫ flow · speed01 dt` (vec2). × `windFieldPxPerSecPerUnit(ppm)` = world px.
 * @property {number[]} strengthFlowSec - `∫ flow · strength01 dt` (vec2), strength = Beaufort ÷ 12.
 * @property {number[]} flowSec - `∫ flow dt` (vec2) — a constant-speed drift that still turns with the wind.
 * @property {number} strengthSec - `∫ strength01 dt`.
 * @property {number} gustPhase - `∫ windGustPhaseRate(speed01) dt`, noise units.
 */

/** @returns {WindAdvectionState} */
export function createWindAdvectionState() {
  return { clockMs: 0, speedFlowSec: [0, 0], strengthFlowSec: [0, 0], flowSec: [0, 0], strengthSec: 0, gustPhase: 0 };
}

/**
 * Advance the integrals one frame. Pure: returns a new state. `dtSec` is the
 * delta of the SAME clock `tMs` is on, clamped to `[0, WIND_ADVECTION_STEP_MAX_S]`.
 * @param {WindAdvectionState|null} state
 * @param {{tMs: number, dtSec: number, speed01: number, directionDeg: number}} frame
 * @returns {WindAdvectionState}
 */
export function stepWindAdvection(state, { tMs, dtSec, speed01, directionDeg }) {
  const prev = state ?? createWindAdvectionState();
  const dt = Number.isFinite(dtSec) && dtSec > 0 ? Math.min(dtSec, WIND_ADVECTION_STEP_MAX_S) : 0;
  const s = Number.isFinite(speed01) ? Math.min(1, Math.max(0, speed01)) : 0;
  const strength = windStrength01ForSpeed01(s);
  const f = windFlowVector(Number.isFinite(directionDeg) ? directionDeg : 0);
  return {
    clockMs: Number.isFinite(tMs) ? tMs : prev.clockMs,
    speedFlowSec: [prev.speedFlowSec[0] + f.x * s * dt, prev.speedFlowSec[1] + f.y * s * dt],
    strengthFlowSec: [prev.strengthFlowSec[0] + f.x * strength * dt, prev.strengthFlowSec[1] + f.y * strength * dt],
    flowSec: [prev.flowSec[0] + f.x * dt, prev.flowSec[1] + f.y * dt],
    strengthSec: prev.strengthSec + strength * dt,
    gustPhase: prev.gustPhase + windGustPhaseRate(s) * dt,
  };
}

/**
 * The uniform bag the shaders read — one per owner (the viewer's ambient wind),
 * plus one per consumer that copies the ambient into its own uniforms rather
 * than binding it (the precipitation renderers, which re-read the handle every
 * frame because the handle is reassigned on a bake).
 * @param {*} TSL - needs `uniform, float, vec2`.
 * @returns {{clockMs:*, speedFlowSec:*, strengthFlowSec:*, flowSec:*, strengthSec:*, gustPhase:*}}
 */
export function createWindAdvectionUniforms(TSL) {
  const { uniform, float, vec2 } = TSL;
  return {
    clockMs: uniform(float(0)),
    speedFlowSec: uniform(vec2(0, 0)),
    strengthFlowSec: uniform(vec2(0, 0)),
    flowSec: uniform(vec2(0, 0)),
    strengthSec: uniform(float(0)),
    gustPhase: uniform(float(0)),
  };
}

/**
 * Write a {@link WindAdvectionState} — or another uniform bag's current values —
 * into a uniform bag. Never throws; a missing source leaves the bag as it was.
 * @param {ReturnType<typeof createWindAdvectionUniforms>|null} dst
 * @param {WindAdvectionState|ReturnType<typeof createWindAdvectionUniforms>|null|undefined} src
 */
export function writeWindAdvectionUniforms(dst, src) {
  if (!dst || !src) return;
  const num = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
  const vec = (v) => {
    const raw = num(v);
    if (Array.isArray(raw)) return raw;
    return raw && Number.isFinite(raw.x) ? [raw.x, raw.y] : null;
  };
  const setF = (u, v) => {
    const n = num(v);
    if (Number.isFinite(n)) u.value = n;
  };
  const setV = (u, v) => {
    const a = vec(v);
    if (a && Number.isFinite(a[0]) && Number.isFinite(a[1])) u.value.set(a[0], a[1]);
  };
  setF(dst.clockMs, src.clockMs);
  setV(dst.speedFlowSec, src.speedFlowSec);
  setV(dst.strengthFlowSec, src.strengthFlowSec);
  setV(dst.flowSec, src.flowSec);
  setF(dst.strengthSec, src.strengthSec);
  setF(dst.gustPhase, src.gustPhase);
}

/**
 * Seconds from the integrals' clock to the time a consumer asked for — 0 for a
 * consumer on the same clock at "now", negative for a look-back — clamped (see
 * the block header for why the clamp is what keeps a foreign clock smooth).
 * @param {*} TSL @param {*} time - ms node. @param {{clockMs:*}} advection
 * @returns {*} float node, seconds.
 */
export function windAdvectionDtSecNode(TSL, time, advection) {
  const { float, clamp } = TSL;
  return clamp(
    time.sub(advection.clockMs).mul(float(0.001)),
    float(-WIND_ADVECTION_LOOKBACK_MAX_S),
    float(WIND_ADVECTION_LEAD_MAX_S)
  );
}

/**
 * WALL-AVOIDANCE DEFLECTION (2026-07-23, author: "walls perpendicular to the
 * wind aren't preventing the wind from penetrating... the wind is pushing
 * straight through the side of a building... how can we prevent wind from
 * crossing walls with confidence? How can we divert and diminish its
 * strength so that it breaks around objects instead of just losing all its
 * energy.") — projects a wind vector against the nearest wall:
 *
 *   - THE COMPONENT HEADING INTO THE WALL IS CANCELLED ENTIRELY. This is the
 *     "prevent crossing, with confidence" half — a mathematical projection
 *     (`v - dot(v,n)·n` for the into-wall part only), not a probabilistic
 *     damping that could still leak through at long range or high speed.
 *   - A FRACTION OF WHAT WAS CANCELLED REAPPEARS AS EXTRA PUSH ALONG THE
 *     WALL (the tangent, `n` rotated 90°), scaled by how much tangential
 *     lean the ORIGINAL flow already had. This is the "breaks around
 *     objects instead of losing all its energy" half. A flow with ZERO
 *     tangential component (heading dead-on into a wall with nothing to
 *     redirect into) gets ZERO extra push — never an arbitrary invented
 *     direction; a real gust hitting a wall square-on with no lean either
 *     way genuinely has no "natural" side to slip toward on its own (the
 *     ALREADY-BUILT turbulence sitting on top of this in `sampleWind`
 *     provides the non-uniformity that makes this degenerate case rare in
 *     practice — a purely uniform, zero-tangential-everywhere field only
 *     exists in the CPU-computed geometry, never in what's actually sampled).
 *   - AN UNCONDITIONAL ENERGY CAP (2026-07-23, author: "particles which get
 *     deflected often end up with huge amounts of extra energy so they end
 *     up shooting around the space at very high speed") — a passive wall
 *     can redirect motion, it must never ADD net speed to it. The first cut
 *     had no such guarantee: the tangent-boost term above, evaluated on its
 *     own, CAN legitimately exceed the input vector's own length (e.g. a
 *     flow hitting at a steep angle has both a large `intoWall` and a large
 *     `tangentialLean` at once, and their product isn't naturally bounded by
 *     either). That was invisible for the one-shot field sample this
 *     function was FIRST built for (candle/light/overlay recompute `vector`
 *     FRESH from the live ambient dial every frame, so an occasional
 *     over-strength evaluation never accumulates) — but particle-runtime.js/
 *     gust-runtime.js feed this SAME function's OUTPUT back into a
 *     particle's own STORED velocity every frame it sits near a wall (added
 *     2026-07-23, same day), so an uncapped overshoot compounds: each pass
 *     could hand back a slightly-too-fast result, which the NEXT pass then
 *     treats as its own new `vector` to deflect further. Now: whatever the
 *     redirect math above computes, its own magnitude is rescaled down (never
 *     up) to never exceed the ORIGINAL `vector`'s speed — a hard invariant
 *     that holds regardless of angle, gain tuning, or how many times this
 *     runs on its own prior output, not a hope that the gain constant stays
 *     small enough.
 *   - BLENDED BY `proximity` (0..1): far from any wall this is a no-op,
 *     `vector` passes through completely unchanged.
 *   - AN OPTIONAL CHAOTIC IMPACT KICK (2026-07-23, author: "if wind
 *     particles hit a perpendicular wall to the direction of wind they
 *     tend to hit it, lose their windward energy, but they don't get push
 *     chaotically around when they impact... instead of being chaotically
 *     rediverted" — motes were clumping and sliding along a wall rather
 *     than scattering). `tangentBoost` above is PROPORTIONAL to whatever
 *     tangential lean the incoming flow already had — a purely head-on hit
 *     (EXACTLY the reported "perpendicular wall" case) has none, so it gets
 *     NO redirect at all: the into-wall component cancels to near-zero and
 *     the mote just stalls, drifting on whatever small residual motion is
 *     left. A caller-supplied random direction (`chaosDirX/Y`), scaled by
 *     `chaosAmount` AND by `intoWall` (so a graze barely perturbs anything
 *     while a dead-on stall gets genuinely scattered — proportional to how
 *     much speed THIS impact is actually cancelling, not a flat constant),
 *     is folded in BEFORE the energy cap below — chaos goes through the
 *     SAME "never exceed input speed" guarantee as everything else here,
 *     never a backdoor around it. Omitted (both args undefined, a JS-level
 *     check, not a per-pixel branch) → byte-identical to before this
 *     existed; `sampleWind`'s own two calls (candle/light/overlay) omit it
 *     deliberately — the reported symptom was specifically about particle/
 *     gust MOTION, not the field-sample look, which the author already
 *     confirmed works.
 *
 * SHARED, not duplicated — deliberately breaks from this file's own
 * established "replicate the ambient-bias formula byte-for-byte in each
 * kernel" precedent (see `sampleWind`'s own header, and particle-runtime.js/
 * gust-runtime.js's own copies of it): those are a few lines of arithmetic;
 * this one has real branching/normalization logic worth keeping in exactly
 * ONE place. Imported directly into particle-runtime.js/gust-runtime.js's
 * compute kernels (their own wind sampling reads a storage buffer, never
 * this function's own texture-based `bakedField`/`wallAvoidField` shape, so
 * they call this with the SAME formula but their own already-unpacked
 * dirX/dirY/proximity float nodes).
 *
 * @param {*} TSL - THREE.TSL (needs `vec2, dot, max, min, length, mix, float`).
 * @param {object} args
 * @param {*} args.vector - the wind vector node to deflect (a vec2 node).
 * @param {*} args.awayDirX @param {*} args.awayDirY - float nodes, the
 *   "away from the nearest wall" UNIT vector's components (0,0 where
 *   undefined — see `world/wind-enclosure.js#wallAvoidanceDirectionFromDistance`'s
 *   own doc for when that happens; harmless here since `proximity` also
 *   reads 0 in the same situations).
 * @param {*} args.proximity - float node, 0..1.
 * @param {*} [args.chaosDirX] @param {*} [args.chaosDirY] - float nodes, a
 *   caller-supplied (pseudo-)random UNIT direction — this function has no
 *   position/time/seed of its own to hash from, so generating the
 *   randomness is the caller's job (see particle-runtime.js/gust-runtime.js's
 *   own call sites for the hash used). Both-or-neither with `chaosAmount`.
 * @param {number} [args.maxSpeedRatio=1] - the energy cap: the result's speed
 *   never exceeds `input × this`. 1 for anything that feeds back into a stored
 *   velocity; {@link WALL_CORNER_SPEEDUP} for a fresh field sample.
 * @param {*} [args.chaosAmount] - float node, 0..1 — how strongly to apply
 *   the kick (typically the SAME narrow near-wall proximity already driving
 *   this call, not the wide one — see the momentum-guard call sites).
 * @returns {*} a vec2 node — the deflected vector.
 */
export function deflectAroundWalls(
  TSL,
  { vector, awayDirX, awayDirY, proximity, chaosDirX, chaosDirY, chaosAmount, maxSpeedRatio = 1 }
) {
  const { vec2, dot, max, min, length, mix, float } = TSL;
  const n = vec2(awayDirX, awayDirY);
  const t = vec2(awayDirY.negate(), awayDirX);
  const intoWall = max(dot(vector, n).negate(), float(0)); // >=0; how much heads INTO the wall
  const tangentialLean = dot(vector, t); // signed — which way (if any) the flow already leans along the wall
  const normalCancelled = vector.add(n.mul(intoWall)); // cancels ONLY the into-wall part
  const tangentBoost = t
    .mul(tangentialLean)
    .mul(intoWall)
    .mul(float(WALL_DEFLECT_REDIRECT_GAIN))
    .div(max(length(vector), float(1e-4)));
  let rawDeflected = normalCancelled.add(tangentBoost);
  if (chaosDirX !== undefined && chaosDirY !== undefined && chaosAmount !== undefined) {
    const chaosDir = vec2(chaosDirX, chaosDirY);
    rawDeflected = rawDeflected.add(chaosDir.mul(intoWall).mul(chaosAmount));
  }
  // THE ENERGY CAP — see this function's own header for the full "extra
  // energy... shooting around at very high speed" story. Rescale (never up,
  // `min(1, ...)`) so the result's own speed never exceeds the INPUT
  // vector's speed, regardless of what the redirect math (OR the chaos kick
  // just above) produced.
  const inputSpeed = length(vector);
  const rawSpeed = length(rawDeflected);
  const deflected = rawDeflected.mul(
    min(float(1), inputSpeed.mul(float(maxSpeedRatio)).div(max(rawSpeed, float(1e-4))))
  );
  return mix(vector, deflected, proximity);
}

/**
 * ONE CURL-NOISE OCTAVE — a divergence-free 2D vector field, scale and rate
 * parameterized.
 *
 * Velocity is the ROTATION of a scalar noise potential — `(dPsi/dy, -dPsi/dx)`
 * — never its gradient. That single choice is what makes the field
 * DIVERGENCE-FREE by construction, which has two consequences worth naming
 * because they are why two different systems want this same function:
 *
 *   - AS A FLOW (world/wind-field.js's own turbulence, below): it can only ever
 *     redirect or swirl existing energy, never invent or delete net flow.
 *   - AS A DEFORMATION (vegetation leaf flutter, `vt/vt-pan-viewer.js`):
 *     divergence-free means AREA-PRESERVING, so a UV shuffle driven by it moves
 *     leaves around without the canopy visibly stretching, squashing, or
 *     gaining/losing density. That is exactly the author's "mass preserving
 *     distortions" (2026-07-23) — a property of the maths, not a tuning.
 *
 * EXTRACTED 2026-07-23, from `computeWindTurbulence`'s own private
 * `computeCurlOctave`, when vegetation flutter became the second consumer. The
 * alternative — vegetation rolling its own fine-scale noise — is precisely what
 * `wind/sample-through-the-door` (Wind.md §11) exists to forbid, and is how V2
 * ended up with every effect inventing its own weather. Sharing the TECHNIQUE
 * while each caller picks its own SCALE is the correct seam: a room-sized eddy
 * and a leaf-sized shimmer are the same maths at different frequencies.
 *
 * Behaviour is byte-identical to the code it replaced (asserted by
 * `world/__tests__/`'s existing turbulence suite staying green across the
 * extraction), including the deliberately asymmetric time advection
 * (`+t` on x, `-0.7t` on y) that keeps the field from reading as a simple
 * uniform scroll.
 *
 * @param {*} TSL - THREE.TSL (needs `float, vec2, mx_noise_float`).
 * @param {object} args
 * @param {*} args.p - vec2 node, the position being sampled (world px).
 * @param {*} args.timeSec - float node, time in SECONDS (callers holding a
 *   millisecond clock convert once, outside, rather than this re-dividing per
 *   octave — `computeWindTurbulence` samples two octaves off one conversion).
 * @param {number|*} args.spaceFreq - world→noise-space scale. Smaller = larger
 *   features (0.0015 ≈ 667px weather eddies; 0.05 ≈ 20px leaf chatter). Usually
 *   a plain JS number (every `computeWindTurbulence` octave bakes one in at
 *   graph-build time); a float NODE also works (verified against the vendored
 *   TSL `ConvertType`/`float()` — a node is cast/passed through, never
 *   re-wrapped) for a caller that wants this genuinely LIVE, e.g. vegetation's
 *   flutter, whose "grain size" is an author-tunable uniform, not a constant.
 * @param {number|*} args.rate - how fast the field churns over time. Same
 *   number-or-node flexibility as `spaceFreq` above, same reason.
 * @param {number} [args.phaseX=0] @param {number} [args.phaseY=0] - noise-space
 *   offsets that DECORRELATE octaves, so two calls never read as the same swirl
 *   merely rescaled.
 * @param {number} [args.eps=WIND_TURBULENCE_CURL_EPS] - finite-difference step,
 *   in the ALREADY-SCALED noise space. Because it applies after the world→noise
 *   scale, one relative value samples a proportionally-similar fraction of a
 *   "feature" at ANY octave's scale — which is why no caller needs its own.
 * @returns {*} a vec2 node.
 */
export function curlNoise2D(TSL, { p, timeSec, spaceFreq, rate, phaseX = 0, phaseY = 0, eps: epsIn }) {
  const { float, vec2, mx_noise_float: perlin } = TSL;
  const ox = p.x.mul(float(spaceFreq));
  const oy = p.y.mul(float(spaceFreq));
  const ot = timeSec.mul(float(rate));
  const eps = float(epsIn !== undefined ? epsIn : WIND_TURBULENCE_CURL_EPS);
  const psi = (px, py) => perlin(vec2(px.add(ot), py.sub(ot.mul(float(0.7)))).add(vec2(float(phaseX), float(phaseY))));
  const dPsiDy = psi(ox, oy.add(eps))
    .sub(psi(ox, oy.sub(eps)))
    .div(eps.mul(float(2)));
  const dPsiDx = psi(ox.add(eps), oy)
    .sub(psi(ox.sub(eps), oy))
    .div(eps.mul(float(2)));
  return vec2(dPsiDy, dPsiDx.negate());
}

/**
 * TURBULENCE — the swirling, non-directional component of the wind field.
 * TWO INDEPENDENT curl-noise octaves (2026-07-23, author: "a wider range of
 * vectors in interior turbulent spaces, ideally with some vectors pointing
 * backwards against the wind... a more rapid shifting of angle... bigger and
 * more dramatic swings of angle inside buildings... increase the turbulence
 * of the wind in the outside too but on a much larger scale"): velocity
 * derived from the ROTATION of a scalar noise potential (velocity =
 * (dPsi/dy, -dPsi/dx)), NOT its gradient — divergence-free by construction,
 * so it can only redirect/swirl existing energy, never invent or delete net
 * flow. INDOOR keeps the original fine, room-corner spatial scale
 * (`WIND_TURBULENCE_INDOOR_SPACE_FREQ`, ~125px eddies) but churns MUCH
 * faster over time (`WIND_TURBULENCE_INDOOR_RATE`, ~3.6× the old shared
 * rate) — angle swings, not just amplitude. OUTDOOR keeps a churn rate close
 * to the original shared value but spans a MUCH larger area
 * (`WIND_TURBULENCE_OUTDOOR_SPACE_FREQ`, ~667px — bigger than even the base
 * gust envelope's own ~600px span). The two octaves use decorrelated
 * noise-space phase offsets so they never read as the same swirl merely
 * rescaled.
 *
 * AMPLITUDE blends the two octaves through the SAME three-region shape the
 * door-gating turbulence correction established (sealed floor → doorway-
 * transition peak → outdoor baseline), keyed off `openness`/
 * `exteriorOpenness`: sealed → the indoor octave at `WIND_TURBULENCE_
 * SEALED_AMP` (nearly still); the doorway transition (openness rising,
 * exteriorOpenness still low) → the indoor octave rises toward
 * `WIND_TURBULENCE_INDOOR_PEAK_AMP`, a DIRECTION allowance (it can swing all
 * the way around and point back against the prevailing wind right here, not
 * just wobble around it) rather than an energy guarantee — see the cap below.
 * genuinely exterior (exteriorOpenness→1) → the outdoor octave at
 * `WIND_TURBULENCE_OUTDOOR_AMP`, regardless of `openness`.
 *
 * ⚠ THE ENERGY CAP (2026-07-23, SAME DAY, author follow-up after live-looking
 * at the field: "the energy of turbulent wind inside a house is never higher
 * than the actual wind speed outside... at the moment 'calm' or 'light
 * breeze' leads to higher energy values inside the house than outside which
 * doesn't make sense"). The FIRST cut of the wind-speed link (deleted here)
 * multiplied the whole composed vector by `mix(CALM_FLOOR, 1, windSpeed01)` —
 * a floor that was NEVER quite zero, precisely so indoor turbulence would
 * never fall fully silent. That is exactly the reported bug: a genuinely
 * still exterior (windSpeed01 = 0) still produced real indoor motion,
 * because the floor didn't reference the actual outdoor speed at all, only a
 * fixed fraction of the amplitude constants above. Replaced with a HARD
 * MAGNITUDE CAP — the SAME "never exceed input speed" idiom
 * {@link deflectAroundWalls} already uses for its own wall energy cap:
 * rescale (never up) the WHOLE composed turbulence vector so its length never
 * exceeds `windSpeed01` itself, the real outdoor wind speed in the SAME 0..1
 * units the coherent term's own magnitude uses. Dead calm outside → the cap
 * is 0 → dead calm everywhere, indoors included, by construction — not a
 * hope that a floor constant stays small enough. Direction survives the cap
 * exactly like the wall deflection's own chaos kick does (the cap only
 * rescales magnitude), so the doorway-peak amplitude constant above still
 * does its job of letting the vector point anywhere, including backwards —
 * it can just never be BIGGER than what is actually blowing outside.
 *
 * EXTRACTED as its own function (2026-07-23, author: "add turbulence to the
 * wind gusts/ribbons too") so `sampleWind` (below) and `gust-runtime.js`
 * (which needs turbulence WITHOUT `sampleWind`'s dir/flutter organic
 * gust-lean term bundled in — a separate, slower whole-scene breeze wobble
 * ribbons were never asked to grow) share exactly ONE formula rather than
 * two copies that could drift apart.
 *
 * @param {*} TSL - THREE.TSL (needs `float, vec2, mx_noise_float, clamp, mix, length, min, max`).
 * @param {object} args
 * @param {*} args.centerXY - vec2 node, the WORLD position being sampled.
 * @param {*} args.time - the shared clock (uGlobalTimeMs, ms).
 * @param {*} [args.openness] - float node 0..1. Omitted → 1 (fully open —
 *   the same "no geometry data ⇒ behave like the open outdoors" convention
 *   `sampleWind` itself uses).
 * @param {*} [args.exteriorOpenness] - float node 0..1. Omitted → 1. A
 *   caller with no real exteriorOpenness of its own (no spare storage-buffer
 *   channel to carry a third signal — `particle-runtime.js`/`gust-runtime.js`
 *   are already at or near the WebGPU 8-storage-buffer-per-stage limit) can
 *   deliberately pass its OWN `openness` for BOTH this and `openness` above:
 *   verified algebraically, NOT just asserted — mixing the same value into
 *   both nested `mix()` calls here is NOT a flat ramp, it produces a curve
 *   that is small at 0 (sealed), PEAKS around 0.5-0.7 (the doorway
 *   transition), and settles back down to the plain outdoor baseline at 1
 *   (fully open) — sealed calm, chaotic right at the threshold, steady once
 *   genuinely in the open, with no second real signal needed.
 * @param {*} [args.windSpeed01] - float node 0..1. Omitted → 1 (full
 *   strength, uncapped) — a caller with no wind-speed concept at all still
 *   gets turbulence, with no ceiling to measure it against.
 * @param {{clockMs:*, speedFlowSec:*}} [args.advection] - the ambient's
 *   integrated advection uniforms; see {@link computeGustEnvelope}'s param of
 *   the same name. Omitted → `U·t`, exact only for a constant wind.
 * @returns {*} a vec2 node, its magnitude NEVER exceeding `windSpeed01` (see
 *   the energy cap in this function's own header).
 */
export function computeWindTurbulence(
  TSL,
  {
    centerXY,
    time,
    openness,
    exteriorOpenness,
    windSpeed01,
    directionDeg,
    advectSpeed01,
    pixelsPerMetre,
    advection,
    // The crash ladder's rung 2 builds half the octaves (core/safe-mode.js); rungs 0-1 build the full
    // stack the field was tuned on. Resolved at graph-build time, like every tier choice (Law 4).
    octaves = getSafeProfile().windTurbulenceOctaves,
  }
) {
  const { float, clamp, mix } = TSL;
  const t = time.mul(float(0.001)); // ms → seconds

  // ⚠️ NOT clamped to 1: callers pass the GUSTED speed here (`speed × envelope`),
  // and a gust above the dial's mean is exactly when the swirl should be
  // strongest. Only the negative end is guarded.
  const speed01 = windSpeed01 !== undefined ? clamp(windSpeed01, float(0), float(2.5)) : float(1);
  const ppm = pixelsPerMetre !== undefined ? float(pixelsPerMetre) : float(WIND_TURBULENCE_ASSUMED_PX_PER_M);

  // ── TAYLOR ADVECTION ────────────────────────────────────────────────────
  // Taylor's frozen-turbulence hypothesis: eddies are carried past a point by
  // the mean flow, so the fluctuation you FEEL is the spatial pattern sweeping
  // over you at the wind speed. Sampling the stack at a position offset
  // backwards along the flow by `U·t` is that, exactly.
  //
  // ⚠️ THIS DELETES A MAGIC NUMBER AND FIXES GUST DURATION FOR FREE. The old
  // model advected its gust envelope at a hand-tuned `900 px/s × mix(0.4,1,
  // speed)`. Under Taylor the travel speed simply IS the wind, so a gust's
  // duration is its own size ÷ U with nothing to tune — which is why a breeze
  // and a gale stopped being the same field at two volumes. Absent
  // `directionDeg` ⇒ no advection at all, a JS branch emitting the identical
  // graph as before (`tsl/no-uniform-gates`).
  //
  // ⚠️ ADVECTED AT THE MEAN, NEVER THE GUSTED SPEED (2026-10-27). `x − U·t` with
  // a `U` that varies across the map (a gust envelope multiplied in) stretches
  // the pattern by `∇U·t`, and `t` is seconds since the world loaded — after an
  // hour the swirl had been sheared into noise. `advectSpeed01` is the dial's
  // own mean; the gusted value is only ever the AMPLITUDE (below).
  //
  // ⚠️ AND INTEGRATED, NEVER `U·t`, WHEN THE CALLER HAS THE ADVECTION — the
  // same mistake in time that the note above fixed in space: a mean speed that
  // MOVES (a Remote wind fade) slid the eddies by `t·dU/dt`, hundreds of
  // thousands of px/s an hour in. `speedFlowSec` is `∫ flow·U dt`, so the
  // offset is the distance the air has really travelled; see the "INTEGRATED
  // ADVECTION" block above `createWindAdvectionState`.
  let samplePos = centerXY;
  if (directionDeg !== undefined) {
    const meanSpeed01 =
      advectSpeed01 !== undefined ? clamp(advectSpeed01, float(0), float(1)) : clamp(speed01, float(0), float(1));
    const flow = windFlowVectorNode(TSL, directionDeg);
    const pxPerUnit = windFieldPxPerSecPerUnit(ppm);
    samplePos = advection
      ? centerXY.sub(
          advection.speedFlowSec
            .add(flow.mul(meanSpeed01).mul(windAdvectionDtSecNode(TSL, time, advection)))
            .mul(pxPerUnit)
        )
      : centerXY.sub(flow.mul(meanSpeed01.mul(pxPerUnit)).mul(t));
  }

  // ── THE fBm STACK ───────────────────────────────────────────────────────
  // Lacunarity 2, gain `2^(−1/3)` — the Kolmogorov `−5/3` slope. Smaller
  // eddies also turn over faster (turnover ~ λ/u), so each octave's churn rate
  // rises with the lacunarity rather than being hand-set per octave.
  // The eddy sizes are metres, converted with the scene's own px/m (2026-10-27;
  // was the assumed 65.6 for every map).
  const baseSpaceFreq = float(1 / WIND_TURBULENCE_BASE_LENGTH_M).div(ppm);
  const octaveCount = Math.max(1, Math.floor(octaves));
  let stack = null;
  let amplitudeSum = 0;
  for (let i = 0; i < octaveCount; i++) {
    const scale = Math.pow(WIND_TURBULENCE_LACUNARITY, i);
    const amplitude = Math.pow(WIND_TURBULENCE_GAIN, i);
    // Decorrelated per octave, so the stack never reads as one swirl merely
    // rescaled — the same reason the old two octaves carried phase offsets.
    const vec = curlNoise2D(TSL, {
      p: samplePos,
      timeSec: t,
      spaceFreq: baseSpaceFreq.mul(float(scale)),
      rate: WIND_TURBULENCE_BASE_CHURN_RATE * scale,
      phaseX: 97 + i * 131,
      phaseY: 131 - i * 197,
    });
    const contribution = vec.mul(float(amplitude));
    stack = stack === null ? contribution : stack.add(contribution);
    amplitudeSum += amplitude;
  }
  // Normalised so the stack's own magnitude is ~1 regardless of octave count —
  // otherwise raising the quality tier would silently raise the wind strength,
  // which would make the tier a look control instead of a detail control.
  const unitTurbulence = stack.mul(float(1 / amplitudeSum));

  // ── INTENSITY: σ = I · U ────────────────────────────────────────────────
  // See the WIND_TI_* constants for why these are real numbers and why the
  // shear peak is legitimately far above the others. The three-region shape
  // (sealed → doorway/shear transition → open) is kept from the model this
  // replaces: it encodes author-validated behaviour, and only its OUTPUT
  // changed meaning — an intensity now, rather than an absolute amplitude
  // that then had to be clamped.
  const opennessVal = openness !== undefined ? clamp(openness, float(0), float(1)) : float(1);
  const exteriorOpennessVal = exteriorOpenness !== undefined ? clamp(exteriorOpenness, float(0), float(1)) : float(1);
  const shelteredIntensity = mix(float(WIND_TI_SEALED), float(WIND_TI_SHEAR_PEAK), opennessVal);
  // The gale boost (see WIND_TI_GALE_BOOST) keys on the MEAN wind's character —
  // outdoors only; a doorway's shear peak is already the strongest term here.
  const meanForCharacter =
    advectSpeed01 !== undefined ? clamp(advectSpeed01, float(0), float(1)) : clamp(speed01, float(0), float(1));
  const galeBoost = float(1).add(windGaleCharacterNode(TSL, meanForCharacter).mul(float(WIND_TI_GALE_BOOST)));
  const openIntensity = mix(float(WIND_TI_ROUGH), float(WIND_TI_OPEN), exteriorOpennessVal).mul(galeBoost);
  const intensity = mix(shelteredIntensity, openIntensity, exteriorOpennessVal);

  // Multiplied, never clamped — so `U = 0` is exactly zero by construction and
  // the top of the dial is genuinely dominated by its mean.
  return unitTurbulence.mul(intensity).mul(speed01);
}

/**
 * THE ONE SAMPLE FUNCTION — every consumer (candle flame, candle light, the
 * debug visualiser) calls this with the SAME arguments and gets the SAME
 * answer. Low-frequency in WORLD space, so a gust spans a whole room —
 * positions near each other lean the same way, positions far apart differ (a
 * real draught, not per-caller random noise). A slow gust envelope makes the
 * breeze rise and fall; a fast octave adds flutter. The ORGANIC term (drift +
 * gust + flutter) is scaled by `exposure` (1 = open to the sky/wind, 0 =
 * sheltered indoors) AND by the wind speed itself, so a dead calm is genuinely
 * still — see its own block below for why the old always-on indoor floor was
 * deleted rather than reduced. TURBULENCE (the curl-noise
 * swirl, below — TWO independent octaves as of 2026-07-23, see
 * `WIND_TURBULENCE_INDOOR_*`/`WIND_TURBULENCE_OUTDOOR_*`) is gated by DOOR
 * CONNECTIVITY instead, not exposure — a sealed room stays nearly still, a
 * room newly reached by an open door gets a fast-churning, wide-swinging
 * chaotic gust (wide enough to sometimes point back against the prevailing
 * wind), genuinely outdoor space keeps a larger-scale, steadier swirl on top
 * of its coherent-gale baseline — and the WHOLE turbulence term is additionally
 * HARD-CAPPED to never exceed the actual outdoor wind speed (2026-07-23,
 * `computeWindTurbulence`'s own "⚠ THE ENERGY CAP"): a gale is far more
 * turbulent than calm air, and calm air is genuinely calm everywhere, indoors
 * included. The `wind` AMBIENT BIAS
 * (below) is deliberately NOT exposure-scaled — see this file's own header,
 * "THE INDOOR COUNTER-WIND BUG" — indoor shelter for the ambient comes
 * entirely from `bakedField`'s own cancellation, not from damping it here.
 *
 * @param {*} TSL - THREE.TSL.
 * @param {object} args
 * @param {*} args.centerXY - vec2 node, the WORLD position being sampled.
 * @param {*} args.time - the shared clock (uGlobalTimeMs, ms — the one clock).
 * @param {*} args.exposure - float node 0..1 (sky exposure at this position —
 *   scene/mask-catalog.js's raw `outdoors` value, NOT `skyReach` — that is a
 *   different, rain-occlusion-specific product; see boot.js#getCandleRenderState's
 *   own note — or 1 where no shelter data exists).
 * @param {{directionDeg: *, speed01: *, gustiness01?: *}} [args.wind] - OPTIONAL
 *   (Tier 1). `gustiness01` (2026-08-15) is OPTIONAL WITHIN THE OPTIONAL —
 *   omitting it from an otherwise-present `wind` object is byte-identical to
 *   before it existed, so a caller assembling this by hand (there should be
 *   none left; `world/wind-access.js` owns assembly) cannot accidentally
 *   enable gusts, only fail to. See {@link computeGustEnvelope}. A live
 *   directional ambient bias, layered UNDER the existing organic
 *   drift/gust/flutter (never replacing it) — both float NODES (uniforms),
 *   so a debug lever or a future scene-wind authority can update them every
 *   frame with no material rebuild. Angle convention: a COMPASS BEARING —
 *   0° = north, clockwise, naming the direction the wind blows TOWARD —
 *   resolved through the one shared helper, {@link windFlowVectorNode}. See
 *   `world/wind-bake.js#windFlowVector` for the convention in full, including
 *   the three disagreeing readings it replaced; a fresh direction↔vector
 *   mapping is this project's own recurring bug class, which is exactly why
 *   there is now only one. Omitted (every Tier-0
 *   caller) → byte-identical to before this param existed. ⚠ ADDED AT FULL
 *   STRENGTH, never exposure-scaled (see "THE INDOOR COUNTER-WIND BUG" above)
 *   — a caller supplying `wind` SHOULD also supply `bakedField`, or accept an
 *   uncancelled full-strength ambient blowing indoors unchecked.
 * @param {{texture: *, originX: number, originY: number, cellSize: number,
 *   cols: number, rows: number}} [args.bakedField] - OPTIONAL: `openness`
 *   (`world/wind-enclosure.js#floodFillOpenFromBoundary`, 2026-07-22 THE
 *   RETHINK), uploaded as a small RGBA-half-float DataTexture. Channel
 *   layout: **B carries `openness`** (0..1, the coherent-wind gate this
 *   function reads below) — the SAME channel `windReach` used before the
 *   rethink, kept deliberately so nothing else about the texture's shape
 *   moved. **R/G are always written 0** by the baker (`vt-pan-viewer.js#
 *   bakeWindField`) — they used to carry the now-deleted wall-relaxation
 *   deviation; they are NOT repurposed and must stay well-defined zeros
 *   because `world/wind-sim-gpu.js`'s Tier-2 advect pass independently reads
 *   this SAME texture's `.xy` as a transport velocity (`restD`) — a value
 *   there that wasn't a real velocity would silently corrupt Tier 2's
 *   advection. **A carries `exteriorOpenness`** (2026-07-23 — was "unused,
 *   always 1" before this; Tier 2 never reads `.w`, confirmed by grep before
 *   repurposing it) — 1 where a cell is genuinely outdoors (never behind a
 *   door at all), 0 where it's indoor (whether sealed or reached via an open
 *   door) — the SAME `exteriorOpenness` `bakeWindField` already computes for
 *   the door-distance falloff, just no longer discarded after use. Lets this
 *   function tell "genuinely outdoors" apart from "indoor, near an open
 *   door" even though both can read `openness` near 1 — see the turbulence-
 *   amplitude block below for why that distinction matters. `originX/Y`/
 *   `cellSize`/`cols`/`rows` are PLAIN NUMBERS (graph-build-time constants; a
 *   rebake rebuilds the consuming material), the `texture` itself is the
 *   only thing that changes without a rebuild (`.needsUpdate`). Sampled with
 *   the UV clamped to the mapped area's edge — a position outside what was
 *   baked reads its nearest edge value, never garbage or a wrapped seam.
 *   Omitted → `openness`/`exteriorOpenness` both default to 1 (byte-
 *   identical to "fully connected, genuinely exterior" — with no geometry
 *   data at all there's nothing to justify claiming "indoor near a door"
 *   either, so this defaults to the calmer, ungated reading, never a silent
 *   "everything sealed").
 * @param {{texture: *, originX: number, originY: number, cellSize: number,
 *   cols: number, rows: number}} [args.wallAvoidField] - OPTIONAL
 *   (2026-07-23): a SEPARATE texture (`bakedField`'s own 4 channels are all
 *   spoken for) — R=dirX/G=dirY (the "away from the nearest wall" unit
 *   vector) / B=proximity (0..1) — `world/wind-enclosure.js#
 *   wallAvoidanceDirectionFromDistance`/`wallProximityFromDistance`, built by
 *   `vt-pan-viewer.js#bakeWindField`. Deflects the COHERENT term only (see
 *   {@link deflectAroundWalls}) — cancels the component heading into a
 *   nearby wall and redirects part of it along the wall, so the ambient
 *   compass wind can no longer just blow straight through geometry it is
 *   facing head-on. Omitted → byte-identical to before this param existed
 *   (deflection reads as a no-op with dirX/dirY/proximity all 0).
 * @param {{texture: *, originX: number, originY: number, cellSize: number,
 *   cols: number, rows: number}} [args.liveField] - OPTIONAL: D_live, the
 *   transient sim's own current output (`world/wind-sim-gpu.js`) — IDENTICAL
 *   shape and world→UV convention to `bakedField` (same grid, same
 *   clamp-to-edge sampling), sampled and ADDED on top rather than replacing
 *   it. Present only while the sim is thawed; absent (the common case — see
 *   this file's own header) whenever it is frozen, so a candlelit room with
 *   every door shut costs exactly what it cost before this existed.
 *   UNTOUCHED by the 2026-07-22 rethink.
 * @param {*} [args.openness] - OPTIONAL (2026-07-23): a float node overriding
 *   the turbulence-amplitude gate's own `openness` reading, taking priority
 *   over `bakedField`'s texture sample. For a caller that already has a REAL
 *   per-position openness value on hand from its own source (`particle-
 *   runtime.js`'s per-particle storage-buffer read, not a texture — compute
 *   kernels here are never proven to sample textures, this file's own
 *   header) and has no `bakedField` to offer. Omitted → falls back to
 *   `bakedField`'s sample, or 1 if neither is given (unchanged from before
 *   this param existed).
 * @param {*} [args.exteriorOpenness] - OPTIONAL (2026-07-23): same idea as
 *   `openness` above, for the `exteriorOpenness` channel. A caller with no
 *   real exteriorOpenness of its own (e.g. `particle-runtime.js`, which has
 *   no spare storage-buffer channel to carry a THIRD signal — this and
 *   gust-runtime.js are already at or near the WebGPU 8-storage-buffer-
 *   per-stage limit) can deliberately pass its OWN
 *   `openness` value for BOTH this and `openness` above — this is not a
 *   hack of convenience, it produces a genuinely sensible curve: the 3-region
 *   amplitude mix below then COLLAPSES to a single parameter that is small
 *   at 0 (sealed), PEAKS somewhere in the 0.5-0.8 range (the doorway
 *   transition — verified algebraically, not just asserted: mixing the same
 *   value into both nested `mix()` calls is NOT monotonic), and settles back
 *   down to the plain outdoor baseline at 1 (fully open) — sealed calm,
 *   chaotic right at the threshold, steady once genuinely in the open,
 *   without needing a second real signal at all.
 * @param {*} [args.windSpeed01] - OPTIONAL (2026-07-23, author: "link
 *   turbulence and overall wind speed so that a gale is far more turbulent
 *   than calm wind"): a float node, 0..1, HARD-CAPPING the TURBULENCE term's
 *   own magnitude to never exceed it (`computeWindTurbulence`'s own "⚠ THE
 *   ENERGY CAP"). Separate
 *   from `wind` itself — `particle-runtime.js` needs this WITHOUT the full
 *   `wind` object, because passing `wind` would make this function ALSO
 *   compute and add its own internal coherent term (gated by whatever
 *   `openness` resolves to here, which for that caller has no wall-avoidance
 *   applied) — a SECOND, disagreeing coherent contribution on top of the
 *   kernel's own hand-computed, wall-deflected one. Omitted → falls back to
 *   `wind.speed01` if `wind` was given, else 1 (unchanged from before this
 *   param existed — every pre-existing caller either passes `wind` already
 *   or has no wind-speed concept to link to).
 * @returns {*} a vec2 node — a lean direction × strength (each caller scales
 *   this to its own space: a flame-quad fraction, a light-radius fraction, a
 *   debug arrow's length) — no longer bounded to [-1,1] once `wind`/
 *   `bakedField`/`liveField` contribute a real prevailing speed on top of
 *   the organic term.
 */
export function sampleWind(
  TSL,
  {
    centerXY,
    time,
    wind,
    bakedField,
    wallAvoidField,
    liveField,
    openness: opennessOverride,
    exteriorOpenness: exteriorOpennessOverride,
    windSpeed01,
    directionDeg: directionDegOverride,
    advectSpeed01: advectSpeed01Override,
    pixelsPerMetre: pixelsPerMetreOverride,
    advection: advectionOverride,
  }
) {
  const { float, vec2, clamp, texture } = TSL;
  // The ambient's integrated advection (see `createWindAdvectionState`) — the
  // override exists for the same reason the others do: the kernel's `organic`
  // getter calls this WITHOUT `wind` and must still advect identically.
  const advection = advectionOverride !== undefined ? advectionOverride : wind ? wind.advection : undefined;
  // The scene's real px/m and the dial's MEAN speed — the two things every
  // real-speed term below needs (see this file's 2026-10-27 header block).
  const pixelsPerMetre =
    pixelsPerMetreOverride !== undefined ? pixelsPerMetreOverride : wind ? wind.pixelsPerMetre : undefined;
  const advectSpeed01 = advectSpeed01Override !== undefined ? advectSpeed01Override : wind ? wind.speed01 : undefined;
  // ⭐ THE ORGANIC DRIFT/GUST/FLUTTER LAYER IS GONE (2026-09-04,
  // mythica-machina-press#497 Stage 2 / #499). It was five noise evaluations
  // hand-rolled into a stand-in for a spectrum: one low-frequency wandering
  // direction, one time-ONLY gust scalar (the same value everywhere on the map
  // at a given instant), and a fast flutter. `computeWindTurbulence`'s fBm
  // stack now provides all of it properly, with a real `−5/3` slope, so
  // keeping this would have been two competing answers to one question at
  // double the noise cost. Deleting it also removes the painted `_Outdoors`
  // mask from the wind path ENTIRELY — it was that mask's last consumer here,
  // which finishes the job the 2026-07-22 rethink started ("geometry decides
  // where wind is, not paint").
  // TURBULENCE — see the exported `computeWindTurbulence` further down this
  // file for the full curl-noise/two-octave/amplitude/wind-speed-link
  // reasoning. Computed BELOW, after `openness`/`exteriorOpenness` resolve
  // (it needs both), via that ONE shared function — `gust-runtime.js` calls
  // the SAME function directly (2026-07-23, author: "add turbulence to the
  // ribbons too"), so this and the ribbons' own swirl can never drift apart.

  // OPENNESS + EXTERIORNESS — sampled EARLY (moved up from where this used to
  // read only `openness`, further down) because the turbulence gate just
  // below now needs both. Same texture, same UV math as before; see this
  // function's own `bakedField` param doc for the full channel contract
  // (B = openness, A = exteriorOpenness). Absent `bakedField` → both default
  // to 1 (fully open, genuinely exterior) — the same "no geometry data ⇒
  // behave like the open outdoors" convention `openness` alone already used,
  // extended to cover the new channel: with nothing baked, there's no
  // door-boundary data to justify claiming "indoor near an open door" either.
  //
  // OVERRIDES (2026-07-23 — see this function's own `openness`/
  // `exteriorOpenness` param docs): a caller-supplied value takes priority
  // over the texture sample, and skips it entirely (no point sampling a
  // channel whose result would just be discarded).
  let openness = opennessOverride !== undefined ? opennessOverride : float(1);
  let exteriorOpenness = exteriorOpennessOverride !== undefined ? exteriorOpennessOverride : float(1);
  if (bakedField) {
    const { texture: bakedTexture, originX, originY, cellSize, cols, rows } = bakedField;
    const uv = vec2(
      centerXY.x.sub(float(originX)).div(float(cellSize * cols)),
      centerXY.y.sub(float(originY)).div(float(cellSize * rows))
    );
    const clampedUv = clamp(uv, vec2(0, 0), vec2(1, 1));
    const sample = texture(bakedTexture, clampedUv);
    if (opennessOverride === undefined) openness = sample.z;
    if (exteriorOpennessOverride === undefined) exteriorOpenness = sample.w;
  }

  // WALL-AVOIDANCE FIELD (2026-07-23, optional — see `deflectAroundWalls`'s
  // own header for the full reasoning) — a SEPARATE texture from
  // `bakedField` (that one's own 4 channels are all spoken for), SAME grid/
  // UV convention, so this reuses the identical clamp-to-edge sampling
  // discipline. R=dirX, G=dirY (the "away from the nearest wall" unit
  // vector), B=proximity (0..1, how strongly to deflect). Absent →
  // dirX/dirY/proximity all read (0,0,0), which `deflectAroundWalls` treats
  // as "no wall nearby" — a guaranteed no-op, byte-identical to omitting
  // this parameter entirely.
  let wallAwayDirX = float(0);
  let wallAwayDirY = float(0);
  let wallProximity = float(0);
  // WIND SHADOW (2026-08-01) — the A channel, which was "always 1, unused" until
  // now. See `world/wind-enclosure.js#upwindShelter` for what it measures and
  // why it is emphatically NOT the deleted potential-flow relaxation returning.
  // Absent field ⇒ 0 ⇒ no shelter anywhere, byte-identical to before it existed
  // (the same "no geometry data ⇒ behave like the open outdoors" convention
  // `openness` and the three channels above already use).
  let windShadow = float(0);
  if (wallAvoidField) {
    const { texture: wallAvoidTexture, originX, originY, cellSize, cols, rows } = wallAvoidField;
    const uv = vec2(
      centerXY.x.sub(float(originX)).div(float(cellSize * cols)),
      centerXY.y.sub(float(originY)).div(float(cellSize * rows))
    );
    const clampedUv = clamp(uv, vec2(0, 0), vec2(1, 1));
    const sample = texture(wallAvoidTexture, clampedUv);
    wallAwayDirX = sample.x;
    wallAwayDirY = sample.y;
    wallProximity = sample.z;
    windShadow = sample.w;
  }

  // THE GUST ENVELOPE (2026-08-15 — see `computeGustEnvelope`'s own header and
  // the constant block above it for the full "what was actually missing"
  // account). Resolved HERE, before turbulence, because BOTH the coherent term
  // and the turbulence cap need it: a gust that made the prevailing wind surge
  // while the turbulence ceiling stayed pinned to the un-gusted dial would let
  // a gust arrive as a perfectly smooth push, which is the one thing a gust
  // never is.
  //
  // ABSENT ⇒ `undefined`, and every consumer below branches on that at JS time
  // rather than multiplying by a uniform 1 (`tsl/no-uniform-gates`) — so a
  // caller with no gustiness concept emits the identical graph it always did.
  const gustEnvelope =
    wind && wind.gustiness01 !== undefined
      ? computeGustEnvelope(TSL, {
          centerXY,
          time,
          directionDeg: wind.directionDeg,
          gustiness01: wind.gustiness01,
          // THE SPEED LINK (2026-08-15) — how OFTEN gusts arrive now follows the
          // prevailing wind, so a breeze gets rare isolated blasts and a gale
          // gets blast after blast. See `computeGustEnvelope`'s own "GUST RATE
          // FOLLOWS WIND SPEED" block.
          speed01: wind.speed01,
          pixelsPerMetre,
          advection,
        })
      : undefined;

  // TURBULENCE (2026-07-23 — see `computeWindTurbulence`'s own header for
  // the two-octave/amplitude/wind-speed-link reasoning). `windSpeed01`
  // resolved here, not inside the shared function, because only THIS
  // function knows about the `wind` object's shape — see this function's
  // own `windSpeed01` param doc for why particle/gust callers pass a bare
  // speed value instead of the full `wind` object.
  //
  // THE CAP GUSTS WITH THE WIND. `computeWindTurbulence`'s own "⚠ THE ENERGY
  // CAP" is the invariant "indoor turbulence never exceeds the real outdoor
  // wind speed". Once the wind gusts, "the real outdoor wind speed" is a
  // per-instant, per-position quantity, not the dial — so the cap has to
  // follow it or the invariant quietly becomes "never exceeds the wind's
  // long-run average", which is a different and weaker claim.
  const cappedSpeed01 = windSpeed01 !== undefined ? windSpeed01 : wind ? wind.speed01 : undefined;
  const turbulence = computeWindTurbulence(TSL, {
    centerXY,
    time,
    openness,
    exteriorOpenness,
    // Taylor advection needs to know which way the field is being carried —
    // see `computeWindTurbulence`'s own advection block.
    // EXPLICIT OVERRIDE FIRST. A caller that deliberately omits `wind` (the
    // kernel's own `organic` getter, which wants this function WITHOUT its
    // ambient term) still needs the field advected the same way, or the two
    // paths silently disagree — which is exactly what the node↔kernel parity
    // test caught when this was derived from `wind` alone.
    directionDeg: directionDegOverride !== undefined ? directionDegOverride : wind ? wind.directionDeg : undefined,
    windSpeed01:
      cappedSpeed01 !== undefined && gustEnvelope !== undefined ? cappedSpeed01.mul(gustEnvelope) : cappedSpeed01,
    advectSpeed01,
    pixelsPerMetre,
    advection,
  });
  // The field's non-directional half is now the fBm stack alone. Its own
  // intensity is already `I · U`, so it reaches exactly zero at a dead calm by
  // construction (#498's guarantee, preserved) with no floor and no cap.
  let result = turbulence;

  // AMBIENT DIRECTIONAL BIAS (optional) — the direction resolves through the
  // ONE shared helper, {@link windFlowVectorNode} (see `world/wind-bake.js#
  // windFlowVector` for the convention itself). This live term and Tier 2's
  // live-sim term are summed into one field every frame, so they cannot be
  // allowed to disagree about which way "the ambient" blows — routing both
  // through one function is what makes that structural rather than a promise.
  // FULL STRENGTH, NOT exposure-scaled: shelter comes entirely from OPENNESS
  // gating the whole coherent term to zero (see the comment just below),
  // never from damping the ambient itself — damping it here AND gating it
  // again would double-suppress it indoors.
  // COHERENT (directional) wind — the ambient bias alone (2026-07-22, THE
  // RETHINK — the wall-relaxation deviation this used to also add is
  // DELETED, see this file's own header) — accumulated separately from the
  // organic term above so it can be gated as one unit by OPENNESS
  // (`world/wind-enclosure.js#floodFillOpenFromBoundary`). openness ∈ [0,1]
  // — 1 = connected to the outside through open space with no falloff yet
  // applied (or genuinely outdoors, never behind a door at all), fading
  // toward 0 with distance from the nearest open door for a cell reached
  // ONLY via one (`world/wind-enclosure.js#distanceFromDoorThreshold`, added
  // same-day as the binary-only first cut) — packed into the wind-structure
  // texture's B channel by vt-pan-viewer.js#bakeWindField. Multiplying the
  // coherent term by it means: outdoors (openness 1) the full directional
  // wind shows (the outdoor look, unchanged); a sealed interior (openness 0)
  // gets ZERO coherent wind, always, by construction — not because a solve
  // happened to converge there; an open door joins the room to the connected
  // set and the wind fills it. The ORGANIC flutter term (`result` above) is
  // NOT openness-gated (a sealed room's air still stirs a little; that is
  // exposure's own, separate job — see this file's own header). Absent
  // `bakedField` → openness defaults to 1 (no gating), so a caller passing
  // `wind` alone is byte-identical to before either param existed.
  let coherent = vec2(0, 0);
  if (wind) {
    coherent = coherent.add(windFlowVectorNode(TSL, wind.directionDeg).mul(wind.speed01));
    // THE GUST, applied to the PREVAILING wind itself (2026-08-15) — this is
    // the line that makes gusts reach every consumer of the field rather than
    // being a look on one term. Applied to the RAW vector, BEFORE the wall
    // deflection and the openness/shadow gating below, for the same reason the
    // deflection goes first: a gust is a change in what is BLOWING, and
    // deflection/shelter are what the geometry does to whatever is blowing.
    // Scaling after the gates would let a gust punch through a sealed wall.
    if (gustEnvelope !== undefined) coherent = coherent.mul(gustEnvelope);
  }

  // WALL-AVOIDANCE DEFLECTION (2026-07-23) — applied to the RAW coherent
  // vector, BEFORE openness gates its magnitude (see `deflectAroundWalls`'s
  // own header) — deflection is about DIRECTION near geometry; openness is
  // "how much of it reaches here at all"; keeping them as separate steps, in
  // this order, means the redirect strength (internally normalized by the
  // vector's own length) is independent of how far this cell already is
  // from an open door.
  coherent = deflectAroundWalls(TSL, {
    vector: coherent,
    awayDirX: wallAwayDirX,
    awayDirY: wallAwayDirY,
    proximity: wallProximity,
    maxSpeedRatio: WALL_CORNER_SPEEDUP,
  });

  // Gate the whole coherent term by openness (sampled earlier, above — see
  // that block's own header for why it moved and why R/G are read by
  // nothing here — Tier 2 still reads them), then fold it into the result.
  //
  // TWO GATES, ONE PRODUCT, AND THEY ANSWER DIFFERENT QUESTIONS. `openness` is
  // "does outside air reach here AT ALL" — isotropic connectivity, so a sealed
  // room reads 0 whichever way the wind blows. `windShadow` is "is a building
  // between me and the wind RIGHT NOW" — directional, so it flips to the other
  // side of the same building the moment the author turns the compass.
  // Multiplying is correct precisely BECAUSE they are independent: an outdoor
  // cell behind a barn is openness 1 / shadow ~1, and a sealed cellar is
  // openness 0 no matter where the barn is.
  //
  // SCALED, NOT GATED TO ZERO — a real leeward wake is a slack, recirculating
  // pocket, not dead air, and a hard 0 would read as a suspiciously clean
  // geometric cut-out punched through the wind field. The ORGANIC term
  // (`result` above) is untouched by this for the same reason openness leaves
  // it alone: sheltered air still stirs.
  const shelterFactor = float(1).sub(windShadow.mul(float(WIND_SHADOW_DEPTH)));
  result = result.add(coherent.mul(openness).mul(shelterFactor));

  // TRANSIENT (Tier 2, optional) — D_live, the same world->UV conversion as
  // bakedField (identical grid convention, a DELIBERATELY separate branch
  // rather than a shared block: the two are independent optional inputs,
  // and a future caller passing only one of them must not have to reason
  // about the other's shape). ADDED on top of everything above — a door
  // gust rides the room's already-baked structure, never replaces it
  // (Wind.md §1: `W = A + D_rest + D_live`).
  if (liveField) {
    const { texture: liveTexture, originX, originY, cellSize, cols, rows } = liveField;
    const uv = vec2(
      centerXY.x.sub(float(originX)).div(float(cellSize * cols)),
      centerXY.y.sub(float(originY)).div(float(cellSize * rows))
    );
    const clampedUv = clamp(uv, vec2(0, 0), vec2(1, 1));
    result = result.add(texture(liveTexture, clampedUv).xy);
  }

  return result;
}

/**
 * The declarative contributor vocabulary (Wind.md §5) — how something OTHER
 * than the ambient breeze pushes on the field in a well-organised manner: a
 * contributor is DATA, gathered and composited by the field's one owner,
 * never a direct write. Nothing constructs `res:wind` from these yet (no
 * sim exists — Wind.md Tier 1+); this is the contract, declared first, the
 * same "declaration before consumer" order `core/params-schema.js` and
 * `effects/particles/particle-system-schema.js` already used.
 *
 * @typedef {object} WindContributor
 * @property {string} id - stable identity (pool reuse across frames).
 * @property {'thermal'|'vent'|'impulse'|'wake'|'ambient'} kind
 * @property {'point'|'disc'|'segment'|'region'} shape
 * @property {{x:number,y:number}|*} at - world xy for point/disc/segment; an
 *   opaque region reference for 'region' (regions are not built — Shapes-
 *   and-Regions.md — so this is not deep-validated here).
 * @property {number} radius - world-px falloff (>= 0).
 * @property {{x:number,y:number}} [vector] - a steady push (vent/ambient).
 * @property {{x:number,y:number}} [impulse] - a one-shot kick (impulse kind).
 * @property {number} [updraft] - vertical/temperature add (thermal kind).
 * @property {number} [turbulence] - local gustiness add.
 * @property {number} strength - master gain (>= 0); same code path scales a
 *   candle's thermal and a bonfire's.
 * @property {'steady'|'oneShot'} mode
 * @property {number} [startMs] - oneShot only.
 * @property {number} [lifetimeMs] - oneShot only, > 0.
 * @property {string} [easing] - oneShot only.
 */

const CONTRIBUTOR_KINDS = Object.freeze(['thermal', 'vent', 'impulse', 'wake', 'ambient']);
const CONTRIBUTOR_SHAPES = Object.freeze(['point', 'disc', 'segment', 'region']);
const CONTRIBUTOR_MODES = Object.freeze(['steady', 'oneShot']);

function isFiniteXY(v) {
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.y);
}

/**
 * Validate a {@link WindContributor}. Pure, Node-testable months before any
 * sim reads one — a malformed contributor is a red test, never a value
 * discovered wrong in play (the same posture `validateParamsSchema` and
 * `validateParticleSystem` already take toward their own declarations).
 *
 * @param {WindContributor} c
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateWindContributor(c) {
  const errors = [];
  const fail = (m) => errors.push(m);

  if (!c || typeof c !== 'object') return { ok: false, errors: ['a wind contributor must be an object'] };

  if (typeof c.id !== 'string' || c.id.length === 0) fail('id must be a non-empty string (stable, for pool reuse)');
  if (!CONTRIBUTOR_KINDS.includes(c.kind)) fail(`kind '${c.kind}' is not one of: ${CONTRIBUTOR_KINDS.join(', ')}`);
  if (!CONTRIBUTOR_SHAPES.includes(c.shape)) fail(`shape '${c.shape}' is not one of: ${CONTRIBUTOR_SHAPES.join(', ')}`);

  // 'region' carries an opaque reference (regions aren't built yet); every
  // other shape needs a real world point.
  if (c.shape !== 'region' && !isFiniteXY(c.at)) {
    fail('at must be {x,y} finite numbers for a point/disc/segment contributor');
  } else if (c.shape === 'region' && (c.at === null || c.at === undefined)) {
    fail('at must be a region reference for a region-shaped contributor');
  }

  if (!(Number.isFinite(c.radius) && c.radius >= 0)) fail('radius must be a finite number >= 0');
  if (!(Number.isFinite(c.strength) && c.strength >= 0)) fail('strength must be a finite number >= 0');

  if ('vector' in c && !isFiniteXY(c.vector)) fail('vector, if present, must be {x,y} finite numbers');
  if ('impulse' in c && !isFiniteXY(c.impulse)) fail('impulse, if present, must be {x,y} finite numbers');
  if ('updraft' in c && !Number.isFinite(c.updraft)) fail('updraft, if present, must be a finite number');
  if ('turbulence' in c && !Number.isFinite(c.turbulence)) fail('turbulence, if present, must be a finite number');

  if (!CONTRIBUTOR_MODES.includes(c.mode)) fail(`mode '${c.mode}' is not one of: ${CONTRIBUTOR_MODES.join(', ')}`);
  if (c.mode === 'oneShot') {
    if (!Number.isFinite(c.startMs)) fail('oneShot contributors need a finite startMs');
    if (!(Number.isFinite(c.lifetimeMs) && c.lifetimeMs > 0)) fail('oneShot contributors need a finite lifetimeMs > 0');
  }

  return { ok: errors.length === 0, errors };
}
