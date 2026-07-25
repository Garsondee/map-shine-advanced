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
 * are even considered) is UNCHANGED by this rethink: still damped between
 * `WIND_INDOOR_RESIDUAL` and full strength by the `exposure` parameter,
 * exactly as it always was. `exposure` is a SEPARATE input from `openness` —
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

// ── The shared GPU wind — tuned by eye (moved verbatim from candle-flame-render.js) ──
const WIND_SPACE_FREQ = 0.0016; // world-space frequency: a gust spans ~600px (a room)
const WIND_DRIFT = 0.6; // how fast the gust DIRECTION wanders
const WIND_GUST_RATE = 0.35; // the breeze rising and falling
const WIND_FLUTTER_RATE = 4.0; // a fast quick jitter on top of the gust
const WIND_FLUTTER_AMP = 0.28; // flutter strength, relative to the gust
const WIND_INDOOR_RESIDUAL = 0.18; // a sheltered (indoor) candle still moves this much

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
const WIND_TURBULENCE_INDOOR_SPACE_FREQ = 0.008; // eddies ~125px, a corner-of-a-room scale — UNCHANGED from the original single octave
const WIND_TURBULENCE_INDOOR_RATE = 1.8; // was the old shared WIND_TURBULENCE_RATE=0.5 — ~3.6x faster churn, for "more rapid shifting... bigger and more dramatic swings"
const WIND_TURBULENCE_OUTDOOR_SPACE_FREQ = 0.0015; // eddies ~667px — BIGGER than even the base gust envelope's own ~600px span; "much larger scale"
const WIND_TURBULENCE_OUTDOOR_RATE = 0.5; // close to the original shared rate — this ask was about SIZE, not speed
const WIND_TURBULENCE_CURL_EPS = 0.4; // finite-difference step, in the SAME already-scaled noise-space as each octave's own frequency — because eps is applied AFTER the world→noise-space scale, the same relative value samples a proportionally-similar fraction of a "feature" at either octave's own scale, no separate eps needed per octave.
//
// AMPLITUDES — three independent constants (2026-07-23), replacing the old
// single AMP × boost-multiplier scheme now that indoor/outdoor are genuinely
// separate octaves (different frequency/rate), not one shared vector scaled
// differently by region:
const WIND_TURBULENCE_SEALED_AMP = 0.08; // sealed-room floor — "nearly still", never quite zero (same allowance WIND_INDOOR_RESIDUAL already makes for the organic term)
// PEAK, AT THE DOORWAY TRANSITION (author: "a wider range of vectors...
// ideally with some vectors pointing backwards against the wind") —
// DELIBERATELY bigger than the coherent wind's own max possible magnitude
// (speed01=1 → magnitude 1, even after deflectAroundWalls's own energy cap)
// so the SUMMED result can genuinely swing all the way around and point
// back against the prevailing wind right where real air actually does break
// into chaotic eddies, not just wobble around the coherent direction. See
// `sampleWind`'s own turbulence-amplitude block for exactly where this
// peaks (the 3-region mix's own middle ground, not fully sealed or fully
// exterior) and the particle kernel's own ceiling clamp (unaffected by this
// — it only rescales MAGNITUDE, never direction, so a reversal survives the
// clamp intact).
// NOTE (2026-07-23, same day, author follow-up): the PEAK constant above is a
// how-hard-it-CAN-swing amplitude for the raw curl vector, not a guaranteed
// final magnitude — the ENERGY CAP below (see `computeWindTurbulence`'s own
// closing lines) rescales the WHOLE composed vector down to never exceed the
// real outdoor wind speed, so "bigger than the coherent wind's own max" is
// now a claim about DIRECTION freedom (it can still point anywhere, including
// backwards), never about total energy exceeding what is actually blowing
// outside.
const WIND_TURBULENCE_INDOOR_PEAK_AMP = 2.4;
const WIND_TURBULENCE_OUTDOOR_AMP = 0.65; // was the old shared WIND_TURBULENCE_AMP=0.4 — author: "increase the turbulence... outside too"

// How much of a blocked (into-wall) push reappears as extra sideways push
// along the wall, relative to how much tangential lean the flow already had
// (see `deflectAroundWalls`'s own header) — a tune-by-eye starting value,
// same posture as every other look constant in this file. RETUNED 1.5→1.0
// (2026-07-23, same live report as the energy cap just below this constant's
// own consumer — a lower baseline means the pre-clamp overshoot the cap has
// to correct is smaller and less frequent, not just silently corrected
// every time).
const WALL_DEFLECT_REDIRECT_GAIN = 1.0;

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
 * @param {*} [args.chaosAmount] - float node, 0..1 — how strongly to apply
 *   the kick (typically the SAME narrow near-wall proximity already driving
 *   this call, not the wide one — see the momentum-guard call sites).
 * @returns {*} a vec2 node — the deflected vector.
 */
export function deflectAroundWalls(TSL, { vector, awayDirX, awayDirY, proximity, chaosDirX, chaosDirY, chaosAmount }) {
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
  const deflected = rawDeflected.mul(min(float(1), inputSpeed.div(max(rawSpeed, float(1e-4)))));
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
 * @returns {*} a vec2 node, its magnitude NEVER exceeding `windSpeed01` (see
 *   the energy cap in this function's own header).
 */
export function computeWindTurbulence(TSL, { centerXY, time, openness, exteriorOpenness, windSpeed01 }) {
  const { float, clamp, mix, length, min, max } = TSL;
  const t = time.mul(float(0.001)); // ms → ~seconds, same conversion sampleWind's own `t` uses
  // Curl octaves via the SHARED {@link curlNoise2D} (extracted 2026-07-23 —
  // this function was its only implementation and is now simply its first
  // caller; behaviour is unchanged, asserted by this file's own existing
  // suite staying green). `t` is pre-converted to seconds above, so these pass
  // `timeSec` directly rather than re-dividing.
  const octave = (spaceFreq, rate, phaseX, phaseY) =>
    curlNoise2D(TSL, { p: centerXY, timeSec: t, spaceFreq, rate, phaseX, phaseY });
  const turbIndoorVec = octave(WIND_TURBULENCE_INDOOR_SPACE_FREQ, WIND_TURBULENCE_INDOOR_RATE, 97, 131);
  const turbOutdoorVec = octave(WIND_TURBULENCE_OUTDOOR_SPACE_FREQ, WIND_TURBULENCE_OUTDOOR_RATE, 401, -227);
  const opennessVal = openness !== undefined ? openness : float(1);
  const exteriorOpennessVal = exteriorOpenness !== undefined ? exteriorOpenness : float(1);
  const indoorTurbulence = turbIndoorVec.mul(
    mix(
      float(WIND_TURBULENCE_SEALED_AMP),
      float(WIND_TURBULENCE_INDOOR_PEAK_AMP),
      clamp(opennessVal, float(0), float(1))
    )
  );
  const outdoorTurbulence = turbOutdoorVec.mul(float(WIND_TURBULENCE_OUTDOOR_AMP));
  let turbulence = mix(indoorTurbulence, outdoorTurbulence, clamp(exteriorOpennessVal, float(0), float(1)));
  // THE ENERGY CAP — see this function's own header, "⚠ THE ENERGY CAP", for
  // the full "calm/light breeze reads as MORE energetic indoors than outside"
  // bug this replaces. Rescale (never up) so the composed vector's own
  // magnitude never exceeds the real outdoor wind speed — the SAME
  // `min(1, inputSpeed/rawSpeed)` idiom `deflectAroundWalls` uses for its own
  // energy cap, just capping against `speed01` here instead of an input
  // vector's own pre-deflection length.
  const speed01 = windSpeed01 !== undefined ? clamp(windSpeed01, float(0), float(1)) : float(1);
  const rawSpeed = length(turbulence);
  turbulence = turbulence.mul(min(float(1), speed01.div(max(rawSpeed, float(1e-4)))));
  return turbulence;
}

/**
 * THE ONE SAMPLE FUNCTION — every consumer (candle flame, candle light, the
 * debug visualiser) calls this with the SAME arguments and gets the SAME
 * answer. Low-frequency in WORLD space, so a gust spans a whole room —
 * positions near each other lean the same way, positions far apart differ (a
 * real draught, not per-caller random noise). A slow gust envelope makes the
 * breeze rise and fall; a fast octave adds flutter. The ORGANIC term (drift +
 * gust + flutter) is scaled by `exposure` (1 = open to the sky/wind, 0 =
 * sheltered indoors) between a small always-on indoor draftiness
 * (`WIND_INDOOR_RESIDUAL`) and full outdoor sway. TURBULENCE (the curl-noise
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
 * @param {{directionDeg: *, speed01: *}} [args.wind] - OPTIONAL (Tier 1): a
 *   live directional ambient bias, layered UNDER the existing organic
 *   drift/gust/flutter (never replacing it) — both float NODES (uniforms),
 *   so a debug lever or a future scene-wind authority can update them every
 *   frame with no material rebuild. Angle convention: METEOROLOGICAL — the
 *   direction the wind blows FROM (matching real-world weather reports and
 *   the debug panel's own compass-labeled dropdown), measured CLOCKWISE from
 *   +X in this engine's own raw world space (+Y down, no camera flip applied
 *   — see `world/wind-bake.js#ambientVectorFromWind`'s identical convention,
 *   documented there in full because a fresh direction↔vector mapping is
 *   this project's own recurring Y-flip bug class). Omitted (every Tier-0
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
    exposure,
    wind,
    bakedField,
    wallAvoidField,
    liveField,
    openness: opennessOverride,
    exteriorOpenness: exteriorOpennessOverride,
    windSpeed01,
  }
) {
  const { float, vec2, mx_noise_float: perlin, clamp, mix, cos, sin, texture } = TSL;
  const t = time.mul(float(0.001)); // ms → ~seconds
  const sx = centerXY.x.mul(float(WIND_SPACE_FREQ));
  const sy = centerXY.y.mul(float(WIND_SPACE_FREQ));
  // Gust DIRECTION — two decorrelated low-frequency world+time noises.
  const dirX = perlin(vec2(sx.add(t.mul(float(WIND_DRIFT))), sy.add(float(11))));
  const dirY = perlin(vec2(sx.sub(float(23)), sy.add(t.mul(float(WIND_DRIFT))).add(float(7))));
  // Gust ENVELOPE — the breeze rising and falling (slow, shared).
  const gust = perlin(vec2(t.mul(float(WIND_GUST_RATE)), float(3)))
    .mul(float(0.5))
    .add(float(0.5)); // [0,1]
  // FLUTTER — a fast, small jitter on top.
  const flutterX = perlin(vec2(sx.add(t.mul(float(WIND_FLUTTER_RATE))), float(41)));
  const flutterY = perlin(vec2(sy.sub(t.mul(float(WIND_FLUTTER_RATE))), float(53)));
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
  }

  // TURBULENCE (2026-07-23 — see `computeWindTurbulence`'s own header for
  // the two-octave/amplitude/wind-speed-link reasoning). `windSpeed01`
  // resolved here, not inside the shared function, because only THIS
  // function knows about the `wind` object's shape — see this function's
  // own `windSpeed01` param doc for why particle/gust callers pass a bare
  // speed value instead of the full `wind` object.
  const turbulence = computeWindTurbulence(TSL, {
    centerXY,
    time,
    openness,
    exteriorOpenness,
    windSpeed01: windSpeed01 !== undefined ? windSpeed01 : wind ? wind.speed01 : undefined,
  });
  // EXPOSURE — indoors keeps a small residual draftiness; outdoors full sway.
  // Governs dir/flutter ONLY — turbulence (above) has its own, door-gated
  // amplitude and is added on top, unscaled by this.
  const amount = mix(float(WIND_INDOOR_RESIDUAL), float(1), clamp(exposure, float(0), float(1)));
  const dir = vec2(dirX, dirY).mul(gust);
  const flutter = vec2(flutterX, flutterY).mul(float(WIND_FLUTTER_AMP));
  let result = dir.add(flutter).mul(amount).add(turbulence);

  // AMBIENT DIRECTIONAL BIAS (optional) — see this function's own param doc
  // for the angle convention. FULL STRENGTH, NOT exposure-scaled: shelter now
  // comes entirely from OPENNESS gating the whole coherent term to zero (see
  // the comment just below), never from damping the ambient itself — damping
  // it here AND gating it again would double-suppress it indoors.
  // NEGATED (author-reported: arrows pointed "into" the wind for every
  // compass setting) — `directionDeg` is METEOROLOGICAL (the direction wind
  // blows FROM, matching the debug dropdown's own compass labels), so the
  // flow vector is the negation of the raw (cos,sin) bearing. MUST match
  // `world/wind-bake.js#ambientVectorFromWind`'s identical correction — this
  // live term and Tier 2's live-sim correction are summed into one field
  // every frame, so they cannot disagree about which way "the ambient" blows.
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
    const rad = wind.directionDeg.mul(float(Math.PI / 180));
    coherent = coherent.add(vec2(cos(rad), sin(rad)).negate().mul(wind.speed01));
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
  });

  // Gate the whole coherent term by openness (sampled earlier, above — see
  // that block's own header for why it moved and why R/G are read by
  // nothing here — Tier 2 still reads them), then fold it into the result.
  result = result.add(coherent.mul(openness));

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
