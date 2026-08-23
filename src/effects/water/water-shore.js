/**
 * WATER TIER 4 — SHORELINE FOAM (`docs/planning/Water.md` §6 rung 4, and
 * `docs/planning/Water-Foam.md` for the research this is built on).
 *
 * The other two thirds of tier 4 — wave shoaling and caustics — live in
 * `water-field.js`, because both must run INSIDE tier 2's own fetch to reach a
 * value (`field.slope`) that tier 3 has already consumed by the time a separate
 * tier-4 block would run. Shoreline foam has no such dependency: it only ADDS
 * to the finished foam total (Effects.md Law 2), so it gets its own module, the
 * same shape tier 3's `water-light.js` has.
 *
 * ============================================================================
 * ⚠️ THE FIRST VERSION OF THIS FILE SHIPPED INVISIBLE, AND IT WAS MEASURED
 * ============================================================================
 * Author, live, 2026-08-16: *"No sign of additional shoreline foam."*
 *
 * It was there. It was a **41.6% grey wash**. The ridge test was
 * `1 − smoothstep(0, 0.16, |n.x|)` — bright wherever a smooth noise passes near
 * zero — and it was calibrated on the assumption that `mx_fractal_noise_vec3`'s
 * channels are roughly UNIFORM over [−1, 1], which would have made a ±0.16 band
 * about 16% of the field. Measured on this build's own GPU, that noise is not
 * uniform: RMS 0.281, median |x| 0.197. **A ±0.16 band is 41.6% of it.** Two
 * fifths of the shore band lit at once is not filaments, it is haze — and haze
 * sitting on top of tier 2's own foam is indistinguishable from tier 2's own
 * foam. This file's own unit test asserted the band was a "minority of the
 * range" by dividing `2·width / 2` — arithmetic that is only true for the
 * uniform distribution nobody checked. `WATER_TIER3_CHOP`'s docstring, three
 * screens up the sibling file, warns about exactly this: *"CALIBRATED AGAINST
 * AN ASSUMED noise distribution, not derived from the real one."*
 *
 * ⚠️ **AND A RIDGE WAS THE WRONG SHAPE ANYWAY.** `1 − smoothstep(0, w, |noise|)`
 * draws VEINS — bright lines where a smooth field crosses zero. Real foam is a
 * NET WITH HOLES: SideFX's whitewater solver gets its characteristic look from
 * repellant points that push foam apart into *"'bald' patches that form a larger
 * cellular pattern"*, and NOAA's account of why sea foam persists at all
 * (surfactant micelles holding up to 90% air in *"a network of interconnected
 * channels"*) says the same thing from the physics side. A net with holes is
 * cellular noise, which is why this file now reads `mx_worley_noise_float`'s
 * CELL WALLS rather than a fractal noise's zero crossings.
 *
 * ============================================================================
 * THE THREE FOAMS THIS RUNG BUILDS, AND WHY THESE THREE
 * ============================================================================
 * `Water-Foam.md` §1 separates foam into six phenomena with different causes,
 * lifetimes and looks. Three of them are stateless, cheap, and legible from a
 * top-down camera, so they are this rung; the other three each need something
 * this rung does not have (a sim buffer, the particle engine, or refraction) and
 * are deferred BY NAME in that document rather than approximated badly here.
 *
 *   SWASH        Waves running up the beach and draining back. A periodic
 *                function of `(shoreDistance − time)`, so bands TRAVEL toward
 *                the shore instead of pulsing in place.
 *   BREAK        Flow driven INTO a bank. One-sided: the upstream face of every
 *                rock, the outside of every bend, and nothing in the lee.
 *   CELLULAR     The lacy net-with-holes structure that makes any of it read as
 *                foam rather than as paint.
 *
 * ⚠️ **BREAK FOAM IS THE ONE THAT NEEDED NO NEW DATA, AND IT IS THE ONE THE
 * AUTHOR ASKED FOR BY NAME** (*"the shoreline and break near obstacles foam"*).
 * The published techniques reach for a depth-buffer comparison against nearby
 * geometry, or for "vary foam by the surface angle below water". MSA does not
 * need either, because `res:waterBody` already bakes the shore TANGENT — and the
 * shore NORMAL is one rotation away:
 *
 *     outward = ( tangent.y, −tangent.x )      unit, points AWAY from the
 *                                              nearest shore, into the water
 *     break01 = max( −dot(flowDir, outward), 0 )
 *
 * `−dot(flow, outward)` asks *"is the current heading toward my nearest shore?"*
 * — `+1` on the face a rock presents to the stream, `0` in its lee, and it
 * turns correctly around every bend with no special-casing, because `outward` is
 * defined per-pixel from whichever bank happens to be nearest. One dot product,
 * no new fetch, no authoring.
 *
 * ⚠️ It inherits `WATER_BANK_REACH_PX`'s lesson: the tangent is well-conditioned
 * near a bank and MEANINGLESS at the medial axis, where the nearest shore swaps
 * banks. Every term here is shore-tight already, which is the gate.
 *
 * ============================================================================
 * WHY THE DOMAIN IS REUSED AND NOT REBUILT
 * ============================================================================
 * The obvious way to make foam run ALONG a bank is to build a local
 * (along-shore, across-shore) basis from the tangent and stretch the noise in
 * it. Resist it, and the reason is this effect's own most expensive bug.
 *
 * `water-field.js`'s header spends several paragraphs on one failure mode:
 * multiplying a PER-PIXEL-VARYING direction by an UNBOUNDED quantity shreds the
 * noise domain into hard rays wherever that direction fans out — around a dock,
 * a wall, a sharp bend. It frames the unbounded factor as *time*, because that
 * is what the shipped bug used, but the amplifier does not have to be time:
 * **`dot(worldXY, tangentXY)`, the natural way to build an "along-shore"
 * coordinate, is the same shape.** `worldXY` is routinely thousands of px from
 * the origin, and the tangent fans out at exactly the features that make it
 * dangerous. Two adjacent pixels near a corner land tens of thousands of px
 * apart in sampling space — the identical artefact, present at frame one, with
 * no clock needed to grow it.
 *
 * So this module never builds a tangent-space coordinate. It samples the SAME
 * `worldXY + domainOffset` that `buildWaterSurfaceField` already proved safe (a
 * spatially-CONSTANT travel term plus a warp bounded to a fraction of one cell),
 * at its own finer scale, and gets its directionality from the SHORE DISTANCE —
 * a scalar, and therefore incapable of shearing anything.
 *
 * THREE is INJECTED, never imported.
 *
 * @module effects/water/water-shore
 */

import { WATER_FLOW_SPEED01_HEADROOM } from './water-flow.js';

/**
 * How far from the bank shoreline foam reaches, as a FRACTION of the author's
 * own `depthScalePx` ("how far in from the bank the water reaches full depth" —
 * effectively half the width of their widest channel).
 *
 * ⚠️ **A FRACTION, NOT A PIXEL COUNT, AND THAT IS THE WHOLE SCALE STORY**
 * (`Water-Foam.md` §3). The author's stated target range is *"everything from
 * small ponds to rivers, to huge lakes, shorelines and ocean shorelines"*. A
 * foam reach authored in world px is tuned on one of those and wrong on the rest
 * — invisible speckle on a lake, a solid smear on a pond. Tying it to a length
 * the author already sets per scene makes a pond and an ocean both work from one
 * knob they were going to set anyway.
 *
 * ⚠️ **RAISED 0.45 → 0.65, MEASURED, Water-Testament W0 (2026-08-17).** The
 * ORIGINAL 0.45 was never checked against a VIEWING ZOOM — `tools/shader-lab/
 * bench-water.js#gateLadder` proved every term in this rung is structurally
 * live (no dead channel) on a real bend-and-island river, and the shore band
 * reads clearly foamy in a close-up render — but the SAME frame at 4× the
 * camera's world span (a plausible map-overview zoom, still well inside the
 * body) showed the band thin past legibility into a uniform wash, the exact
 * "115px reach vs. viewing zoom mismatch" the Testament named as a candidate
 * cause before this rung had a bench to check it with. 0.65 (reach 166px at
 * the shipped `depthScalePx` default of 256, was 115px) buys real margin
 * before that happens, still clamped by `WATER_FOAM_REACH_MIN/MAX_PX`, and
 * self-limiting in the direction that matters: it mainly widens the band on
 * LARGE bodies (bigger `depthScalePx`), which is exactly where a viewer sits
 * further back and the shrink-to-invisible risk is worst — a small pond's
 * already-small reach barely moves. `BUILT (unverified)`: this is a bench
 * measurement, not the author's own eyes — see the Testament §5/§6 doctrine.
 */
export const WATER_FOAM_SHORE_FRACTION = 0.65;

/** Absolute floor/ceiling on that derived reach, world px — a scene with an
 * extreme `depthScalePx` should still get foam of a sane physical size, since
 * foam bubbles do not actually scale with the lake. */
export const WATER_FOAM_REACH_MIN_PX = 24;
export const WATER_FOAM_REACH_MAX_PX = 420;

/**
 * How many swash bands occupy the shore band at once.
 *
 * The technique (Alisavakis; Cyanilux states the same shape differently) is a
 * periodic function of `(shoreDistance01 − time·speed)`: subtracting time is
 * what makes the bands TRAVEL toward the shore rather than pulse in place, and
 * the band count is that periodic function's frequency. Three reads as a beach
 * with a couple of spent waves on it; one reads as a single tide line; eight
 * reads as corduroy.
 */
export const WATER_SWASH_BANDS = 3;

/** How fast the swash bands run shoreward, in band-widths per second. Slow on
 * purpose — real swash is a walking pace, and this is the term most likely to
 * read as "the water is scrolling" if it is hurried. */
export const WATER_SWASH_SPEED = 0.28;

/**
 * How wide a swash band's bright part is, 0..1 of its own cycle. Small values
 * give a thin advancing line, large values a broad wash.
 *
 * ⚠️ CALIBRATED AGAINST THE REAL `sin()` DISTRIBUTION, unlike the constant this
 * file shipped with. `sin` spends most of its time near its extremes, so a
 * threshold at `1 − 2·width` on `sin` covers roughly `(2/π)·asin(...)` of the
 * cycle rather than `width` of it — the reason this is expressed as a threshold
 * on the wave and then measured, not as a nominal "fraction lit".
 */
export const WATER_SWASH_WIDTH = 0.34;

/**
 * The Worley cell scale, as a fraction of the shore reach — so foam cells stay
 * the same size RELATIVE to the foam band whatever the body's scale, which is
 * what keeps a pond's rim and an ocean's swash both looking like foam rather
 * than like two different materials.
 */
export const WATER_FOAM_CELL_FRACTION = 0.55;

/**
 * Where the Worley EDGE field (F2−F1, the gap between the two nearest
 * feature distances — see `buildFoamCellularStructure`'s own header for why
 * this replaced raw F1) is cut into cell WALLS.
 *
 * ⚠️ SUPERSEDES `WATER_FOAM_CELL_EDGE0/1` (retired 2026-08-19) — those
 * thresholded raw F1 near ITS OWN measured upper tail, which reliably lit
 * only the small neighbourhoods around Voronoi VERTICES (F1's local maxima),
 * never the connecting edges between them: a live, zoomed-in GPU render
 * confirmed "disconnected specks," not a net, exactly the failure mode the
 * RETIRED constants' own test comment worried about and could not actually
 * detect (a marginal-distribution check cannot see spatial connectivity).
 * F2−F1 is exactly ZERO on every cell edge by construction, so a threshold
 * near zero traces the full boundary instead.
 *
 * ⚠️ PROVISIONAL, not yet re-measured against this metric's own real
 * distribution the way the retired constants were against F1's (this file's
 * own "MEASURED, NOT ASSUMED" doctrine) — a first GPU pass against the real
 * river is what confirms or corrects this pair. Treat `NEAR`/`FAR` as a
 * starting point, not a settled calibration, until that pass has run.
 *
 * ⚠️ WIDENED 2026-08-19, informed by the first real live look this pair ever
 * got: author, live, zoomed on the actual Underground river: "lots of pixel
 * hard binary edges... need noisy, grainy, evolving, bubbling, turbulent
 * foam." `FAR` was 0.16 — this is still a first-cut author-informed number,
 * not a fresh measurement, but the doubling is a direct response to a real
 * report, not a guess made under time pressure. See `buildFoamCellularStructure`'s
 * own header for the SECOND half of that fix — this constant only controls
 * how WIDE the wall is meant to look; it cannot fix aliasing at close zoom,
 * which is a screen-space problem no world-space constant can solve, and is
 * fixed separately, there, with `fwidth`.
 */
export const WATER_FOAM_EDGE_NEAR = 0;
export const WATER_FOAM_EDGE_FAR = 0.7;

/**
 * The cellular edge's own anti-aliasing width, in SCREEN PIXELS, not world
 * units. `WATER_FOAM_EDGE_FAR` controls how the wall is meant to look at a
 * fixed reference zoom; it cannot, by itself, stop the SAME wall aliasing
 * into a hard-pixel edge at closer zoom, because a fixed WORLD-space band
 * covers fewer and fewer SCREEN pixels the closer the camera gets — exactly
 * the "pixel hard binary edges" the author reported, zoomed in on the real
 * river. `fwidth(edgeDist)` (`buildFoamCellularStructure`) measures how much
 * `edgeDist` itself changes per screen pixel, right there, this frame, at
 * whatever zoom is actually active — multiplying it by this constant gives a
 * transition band that is ALWAYS a few screen pixels wide, never a few world
 * pixels wide. 1.5 is a conventional starting width for this exact technique
 * (signed-distance-style edge AA); not yet swept against this project's own
 * noise statistics.
 */
export const WATER_FOAM_EDGE_AA_PX = 1.5;

/**
 * The "bubbling" perturbation — a SEPARATE, faster, independently
 * time-varying noise added to `edgeDist` before it is thresholded, so the
 * cell walls themselves visibly wobble and reform rather than being a
 * static shape that only ever TRANSLATES (via `drift`). Real foam does not
 * just get carried along; individual bubbles pop, merge and reappear.
 * Author, live: "need noisy, grainy, evolving, bubbling, turbulent foam."
 *
 * ⚠️ RAISED 0.12 → 0.4, SAME DAY, LIVE-REPORTED: "No sign of bubbles or
 * animation from the foam... at all." 0.12 was a genuine first-cut guess,
 * too small to read against `WATER_FOAM_EDGE_FAR` (0.7) once actually
 * watched rather than reasoned about — the exact "assumed, not measured"
 * hazard `WATER_TIER3_CHOP`'s own doc names. Still bounded well under
 * `EDGE_FAR` on purpose (this nudges WHERE the existing net's own walls
 * sit, frame to frame; it must never be large enough to invent walls where
 * the Worley field itself has none, which would stop reading as "this net
 * is alive" and start reading as unrelated noise laid over it) — just no
 * longer small enough to be invisible.
 */
export const WATER_FOAM_BUBBLE_AMOUNT = 0.4;
/** The bubble noise's own spatial frequency, as a multiplier on `cell` — see
 * `WATER_FOAM_FINE_OCTAVE`'s own doc for why one extra octave reads as
 * texture rather than a repeating tile; this is a THIRD, faster one, for
 * the same reason. */
export const WATER_FOAM_BUBBLE_OCTAVE = 5.2;
/** How fast the bubble noise itself evolves, in noise-cycles per second —
 * slow enough not to strobe, fast enough to read as motion within a few
 * seconds of watching, matching the pace `wobble`'s own `0.05` and the base
 * surface's own `0.15` (this file's swash wobble, `water-field.js`'s own
 * fetch) already establish for this effect's other time-varying terms. */
export const WATER_FOAM_BUBBLE_TIME_SCALE = 0.35;

/**
 * THE GRAIN — a SEPARATE mechanism from the bubble nudge above, added the
 * same day for the same report: "I asked for gritty, grainy, bubbly,
 * evolving foam." The bubble nudges WHERE an edge falls; it cannot, on its
 * own, make a already-lit wall look TEXTURED rather than a flat white
 * shape, because nudging a boundary's position says nothing about what is
 * happening well inside it. Grain instead MULTIPLIES the final structure
 * brightness by a fast, fine, independently time-varying noise — visible
 * everywhere structure is non-zero, not just at its edges, and the most
 * direct read of "gritty" there is: a flat white shape versus one with
 * real internal variation. How much of the wall's own brightness this
 * noise is allowed to take away, at most (multiplies into `[1-AMOUNT, 1]`)
 * — deliberately less than `WATER_FOAM_CELL_BITE` (0.75): grain textures a
 * wall that is still recognisably solid, it does not perforate it (that is
 * what the cellular structure's own holes are already for).
 */
export const WATER_FOAM_GRAIN_AMOUNT = 0.45;
/** The grain's own spatial frequency, as a multiplier on `cell` — faster
 * than the bubble octave, matching real foam's own finest visible detail
 * (individual bubble-scale, not cell-scale). */
export const WATER_FOAM_GRAIN_OCTAVE = 11;
/** How fast the grain noise itself evolves, in noise-cycles per second —
 * faster than the bubble's own `WATER_FOAM_BUBBLE_TIME_SCALE`: grain is
 * meant to read as fine, fast churn (individual bubbles turning over),
 * while the bubble nudge reads as the net's own slower reformation. */
export const WATER_FOAM_GRAIN_TIME_SCALE = 0.9;

/** How much of the foam's brightness the cellular structure is allowed to take
 * away. Below 1 on purpose: at 1 the holes punch clean through and the foam
 * reads as a stencil, when what it should read as is thick in the walls and thin
 * — not absent — in the middles. */
export const WATER_FOAM_CELL_BITE = 0.75;

/**
 * How sharply break foam falls off as the flow turns away from the bank.
 * `max(−dot,0)` alone is a cosine, which spreads foam most of the way round an
 * obstacle; raising it to a power tightens it onto the face genuinely presented
 * to the stream. 2 is a gentle tightening — the difference between "this rock is
 * in the water" and "this rock is in a CURRENT".
 */
export const WATER_BREAK_SHARPNESS = 2;

/** How far break foam reaches out from the bank, as a fraction of the shore
 * reach. Tighter than the swash: water piles up against an obstacle in a narrow
 * collar, it does not wash a wide band the way a beach does. */
export const WATER_BREAK_REACH_FRACTION = 0.5;

/**
 * How much finer the SECOND cellular octave is than the first.
 *
 * ⚠️ **ONE OCTAVE IS WHY FOAM READ AS A PATTERN** (author, 2026-08-17: *"I can
 * see it, but it's currently very primitive"*). A single Worley at one scale
 * produces cells of one size, evenly distributed — and the eye is extremely
 * good at reading that as a repeating TEXTURE laid over the water rather than
 * as a substance. Real foam is scale-free over the range you can see: big
 * ragged clumps, and each clump is itself made of much smaller bubbles.
 *
 * 2.7 rather than a round 2 or 3 on purpose — an integer ratio makes the two
 * octaves' cell boundaries coincide periodically, which reinstates exactly the
 * regularity the second octave was added to break. An irrational-ish ratio
 * keeps them sliding past each other everywhere.
 */
export const WATER_FOAM_FINE_OCTAVE = 2.7;

/**
 * How much of the fine octave BITES INTO the coarse one, 0..1.
 *
 * The two are not averaged — the fine octave multiplies the coarse walls, so
 * bubbles appear ON clumps and never in the open water between them. Averaging
 * would spray fine detail across the holes as well and dissolve the clump
 * structure back into an even mist, which is the same "haze, not filaments"
 * failure the ridge-based first version of this file shipped as.
 */
export const WATER_FOAM_FINE_SHARE = 0.55;

/**
 * How many UPSTREAM taps the downstream break tail takes.
 *
 * ⚠️ **THIS IS THE ONE TERM THAT FAKES MEMORY, AND MEMORY IS THE HEADLINE
 * FINDING.** `docs/holy/Water-Testament.md` §2.4: *"foam is a substance with
 * memory — created, advected by the flow, decaying over seconds — and every
 * top-shelf implementation models that... Our foam is a pure function of
 * (position, time), the reason it reads as texture."* The real fix is a
 * feedback buffer (W7, tier 6, C7). This is W4's sanctioned stateless stand-in:
 * *"downstream break tails (fixed small taps of `breakOnly` along −flow —
 * bounded, global direction)"*.
 *
 * Each tap asks "was break foam being GENERATED this far upstream?" and, if so,
 * deposits a decayed share of it here. Foam therefore appears to stream off the
 * upstream face of every obstacle and trail away downstream — which is the
 * single most recognisable thing a river's foam does, and the thing a
 * position-only function can never produce.
 *
 * ⚠️ THE DIRECTION IS `flowDir`, A GLOBAL UNIFORM — never a per-pixel tangent.
 * That distinction is this effect's most expensive bug (`water-field.js`'s
 * header, and this file's own "WHY THE DOMAIN IS REUSED" section): a per-pixel
 * direction multiplied by an unbounded distance shears the sampling domain into
 * hard rays wherever that direction fans out. A global direction cannot fan out,
 * so marching along it is safe at any distance.
 *
 * FOUR taps, and the count is a real cost decision: each one is an extra
 * body-pack fetch (four dependent-free but genuinely additional texture reads at
 * tier 4). Fewer than three reads as detached blobs rather than a trail; more
 * buys smoothness that the lace texture hides anyway.
 */
export const WATER_TAIL_TAPS = 4;

/**
 * How far the tail reaches downstream, as a multiple of the shore reach.
 *
 * A multiple of a body-scale length rather than world px, for the same reason
 * every other length here is (`WATER_FOAM_SHORE_FRACTION`): a tail tuned in
 * pixels on a river is a smear on a pond and invisible on a lake.
 */
export const WATER_TAIL_REACH_MULT = 1.2;

/**
 * How far the foam texture is STRETCHED along the flow, as a multiple of its
 * across-flow scale.
 *
 * ⚠️ SAFE ANISOTROPY, and the qualifier is the whole point. This file's own
 * "WHY THE DOMAIN IS REUSED" section forbids building a tangent-space
 * coordinate, because a PER-PIXEL direction times an unbounded world
 * coordinate shears the domain into rays wherever that direction fans out.
 * `flowDir` is a GLOBAL uniform — one vector for the entire surface — so
 * rotating into it cannot fan out anywhere, which is exactly the distinction
 * `Water-Testament.md` W4 draws when it sanctions *"noise stretched along
 * GLOBAL wind dir — safe anisotropy"*.
 *
 * It earns its place twice over: real foam IS drawn into streaks by the current
 * (windrows, and the striations trailing any obstacle), and the elongated
 * high-frequency texture also masks the seams between the tail's discrete taps
 * far better than any extra tap would — the cheapest possible fix for the
 * combing those taps would otherwise show, at zero additional fetches.
 */
export const WATER_FOAM_STREAK = 3.4;

/**
 * How far the REAL locally-solved flow direction may nudge the cellular
 * noise's own sample point, as a FRACTION OF ONE CELL — bounded, additive,
 * same law as `WATER_BANK_INFLUENCE`/`WATER_FLOW_WARP_INFLUENCE`
 * (`water-field.js`): a domain offset capped at a fraction of a cell can
 * separate two neighbouring pixels by at most that, whatever the local
 * solve does between them.
 *
 * ⚠️ THIS EXISTS BECAUSE `WATER_FOAM_STREAK` ABOVE WAS FED THE WRONG THING
 * FOR A WHILE (found + fixed 2026-08-19). Its own doc has always said the
 * rotation it drives must use a GLOBAL direction — "rotating into it cannot
 * fan out anywhere" — but S4 (2026-08-18) started passing the REAL,
 * per-pixel `localFlowDir` into that exact rotation instead, to make foam
 * shape respond to real obstacle deflection. Near a small obstacle the real
 * solve's direction genuinely sweeps through a wide angle range, and
 * rotating a Worley field's QUERY by a spatially-varying angle warps its
 * apparent cell layout into a literal spiral regardless of how bounded the
 * rotated vector itself is (a Worley field's visual character depends on
 * the geometry between query and feature points, not just the query
 * vector's own magnitude) — confirmed live, author, zoomed: "26 shows
 * concentric poles of almost magnetic like rings." Two attempts to dampen
 * a DIFFERENT term (`bankWarp`) were tried and reverted as insufficient
 * before this was traced to the actual rotation itself
 * (`docs/planning/Water-Simulation-Turn.md`, S5).
 *
 * The fix restores the ORIGINAL contract (`WATER_FOAM_STREAK` rotates by
 * `flowDir` alone, always global, never spirals) and gets real-obstacle
 * responsiveness back a SAFER way: the real local direction only NUDGES the
 * sample point by a bounded offset before that safe rotation runs, the
 * exact mechanism `WATER_FLOW_WARP_INFLUENCE` already proved out for the
 * base surface. 0.35, matching both siblings — provisional, parity over a
 * derived number, pending a GPU sweep.
 */
export const WATER_FOAM_FLOW_NUDGE = 0.35;

/**
 * ============================================================================
 * S4 (2026-08-18) — LOCAL VELOCITY REACHES SWASH/BREAK/STREAK, THE AUTHOR'S
 * OWN ASK ("continue development... I'd like to actually see some real
 * results"), NOW THAT `res:waterFlow` IS CONFIRMED LIVE.
 * ============================================================================
 * `localFlowDir`/`localSpeed01` below (S3's own baked pack, RG velocity/B
 * speed01) replace `flowDir`/a fixed 1.0 in exactly THREE places — break
 * foam's `facing` dot product, the streak rotation, and swash's amplitude
 * and phase rate — and NOWHERE ELSE. Every other term in this file (the
 * domain offset, the tail's march direction) stays on the GLOBAL `flowDir`
 * on purpose; see each site below for why it is safe there specifically.
 *
 * ⚠️ **WHY THIS DOES NOT REOPEN THE SHEARING BUG THIS FILE'S OWN HEADER
 * WARNS ABOUT.** That bug's shape, generalised (see "WHY THE DOMAIN IS
 * REUSED" above): a PER-PIXEL-VARYING direction multiplied by an UNBOUNDED
 * magnitude (time, or raw `worldXY`) shears neighbouring pixels apart in
 * sampling space. Every use of `localFlowDir` below rotates or dots an
 * ALREADY-BOUNDED quantity — `cell` (already divided by a cell size and
 * built from the safe, capped `domainOffset`), or a unit-length shore
 * normal — never `worldXY` and never a quantity scaled by elapsed time.
 * Rotating or dotting a bounded vector by a per-pixel-varying angle only
 * ever produces ANOTHER bounded vector; two neighbouring pixels' results
 * can differ by at most the input's own bound, however much their local
 * directions differ. That is a fundamentally different risk shape from an
 * amplifier with no ceiling, and it is why this addition does not need
 * (and does not use) any new bounding logic beyond what already exists.
 */

/**
 * The local pack's own "ordinary" reading — `res:waterFlow`'s B channel
 * (speed01) at the free-stream speed the whole solve is normalised to
 * (`water-flow.js#WATER_FLOW_SPEED01_HEADROOM`'s own doc: headroom above a
 * free-stream speed of exactly 1). Every S4 term below scales itself
 * RELATIVE to this baseline, not to an absolute speed01 value, so a scene
 * with a gentle current and one with a torrent both read as "normal" at
 * their own free-stream speed and only DEVIATE (foam up in a constriction,
 * calm in a lee) relative to their own baseline — the same relative-not-
 * absolute framing channel 23's own deviation redesign already uses.
 */
export const WATER_LOCAL_SPEED01_BASELINE = 1 / WATER_FLOW_SPEED01_HEADROOM;

/**
 * How far local speed may push swash amplitude/phase-rate off their
 * authored baseline, as a `[min, max]` multiplier — clamped, not open-ended,
 * so a texel misread as absurdly fast (or a solid-adjacent near-zero) still
 * produces a bounded number rather than a spike or a total flatline. 0.3
 * still shows SOME motion in dead water (real swash does not stop dead the
 * instant current does); 2.0 is a strong but not cartoonish acceleration
 * right beside a constriction.
 */
export const WATER_LOCAL_SPEED_AMP_MIN = 0.3;
export const WATER_LOCAL_SPEED_AMP_MAX = 2.0;

/**
 * THE CELLULAR "NET WITH HOLES" STRUCTURE — extracted (2026-08-19) so a
 * SECOND foam source can read the identical, already-tuned texture instead
 * of growing its own parallel copy of six hard-won constants. Author, live,
 * on S5's sim-driven wake foam BEFORE this existed: *"Real foam is complex
 * stringy mess, it's not a 'glow' effect."* That is exactly the mistake this
 * file's own header already diagnosed once for shore foam (the ridge-vs-net
 * story above) — a smooth accumulator field, however correctly it covers the
 * right AREA, is still a smooth gradient, and a smooth gradient reads as a
 * glow no matter how well-calibrated its brightness is. `water-render.js`'s
 * `waterSimFoam` now multiplies THIS, the same texture shore foam already
 * uses, rather than either inventing a second one
 * (`feedback_shared_field_two_meanings_two_registries`) or shipping the raw
 * accumulator unstructured a second time.
 *
 * `buildWaterShoreFoam` below is now a THIN caller of this, not a second
 * implementation — its own `cell`/`lace` locals are this function's return
 * values, byte-identical to what it computed inline before this split.
 *
 * @param {object} args
 * @param {*} args.TSL
 * @param {*} args.worldXY - vec2 node, this fragment's world position.
 * @param {*} args.domainOffset - vec2 node, the SAME safe domain shift tier
 *   2's own fetch uses — see the file header's "WHY THE DOMAIN IS REUSED".
 *   Every caller reuses ONE registry's worth of this, never re-derives it.
 * @param {*} args.flowDir - vec2 node, the direction cells stretch along.
 *   ⚠️ MUST BE GLOBAL (`uFlowDir`), NEVER a per-pixel direction — see
 *   `WATER_FOAM_FLOW_NUDGE`'s own doc for why a per-pixel direction fed
 *   here specifically (not just "an unbounded distance", the general rule
 *   `WATER_FOAM_STREAK`'s doc states) warped this into a literal spiral
 *   near small obstacles. Real per-pixel responsiveness comes from
 *   `localFlowDir` below instead.
 * @param {*} [args.localFlowDir] - vec2 node, the REAL locally-solved
 *   direction (S4, e.g. `localFlowDirSafe`). Optional — defaults to
 *   `flowDir` itself, which makes the nudge below exactly zero, so an
 *   omitted argument is byte-identical to "no local signal", never a
 *   thrown error. Only ever used as a BOUNDED ADDITIVE offset to the
 *   sample point, never to rotate anything.
 * @param {*} args.uReachPx - float uniform node, the world-px scale cells
 *   are sized relative to (`WATER_FOAM_CELL_FRACTION` of it).
 * @param {*} [args.timeMsNode] - THE SHARED CLOCK (`time/one-clock`), optional
 *   — defaults to `null`, in which case the bubble perturbation below samples
 *   at a fixed `tSec=0` (a static, still-valid offset, just not animated)
 *   rather than throwing. Drives `WATER_FOAM_BUBBLE_*` only — everything
 *   else in this function is time-independent.
 * @returns {{cell: *, lace: *, structure: *, edgeDistRaw: *}} `cell` is the shared domain
 *   coordinate (shore foam's own swash wobble reuses it, exactly as before
 *   this split). `structure` is the raw 0..1 cellular field — CAN hit true
 *   zero, a real hole in the net. `lace` is the same field softened by
 *   `WATER_FOAM_CELL_BITE` so it never fully erases a CONTINUOUS sheet
 *   (shore swash/break's own use, where a stencilled hole reads wrong); a
 *   caller wanting genuine discontinuity — patches that can vanish, which is
 *   what "foam breaks off" needs — reads `structure` directly instead.
 *   `edgeDistRaw` is F2−F1 PLUS the bubble nudge (2026-08-19), BEFORE the
 *   `WATER_FOAM_EDGE_NEAR/FAR` threshold — the field actually fed to that
 *   threshold, not the pre-bubble Worley value alone; unbounded-above
 *   (though small in practice), approximately zero on a cell edge, growing
 *   toward each cell's interior. Exists for the same
 *   "isolate the source from its own gate" reason `simFoamRaw`/`simFoam`
 *   exist as a pair (`water-render.js`) — a future re-calibration of the
 *   threshold constants needs this reading, not just the already-thresholded
 *   `structure`, to know what range it is actually cutting.
 */
export function buildFoamCellularStructure({
  TSL,
  worldXY,
  domainOffset,
  flowDir,
  localFlowDir = null,
  uReachPx,
  timeMsNode = null,
  // ROH TUNING (2026-08-19) — every one of these is a bare constant by
  // default (`?? float(CONSTANT)`), so an old caller or a construction-only
  // test is byte-for-byte unaffected; a real uniform here is what makes the
  // schema params below actually reach the shader.
  uFlowNudge = null,
  uEdgeFar = null,
  uEdgeAaPx = null,
  uBubbleAmount = null,
  uBubbleOctave = null,
  uBubbleTimeScale = null,
  uGrainAmount = null,
  uGrainOctave = null,
  uGrainTimeScale = null,
}) {
  const { vec2, vec3, float, max, length, smoothstep, fwidth, mx_worley_noise_vec2, mx_fractal_noise_vec3 } = TSL;
  const reach = max(uReachPx, float(1));
  const tSec = timeMsNode ? timeMsNode.mul(float(1 / 1000)) : float(0);
  const flowNudgeNode = uFlowNudge ?? float(WATER_FOAM_FLOW_NUDGE);
  const edgeFarNode = uEdgeFar ?? float(WATER_FOAM_EDGE_FAR);
  const edgeAaPxNode = uEdgeAaPx ?? float(WATER_FOAM_EDGE_AA_PX);
  const bubbleAmountNode = uBubbleAmount ?? float(WATER_FOAM_BUBBLE_AMOUNT);
  const bubbleOctaveNode = uBubbleOctave ?? float(WATER_FOAM_BUBBLE_OCTAVE);
  const bubbleTimeScaleNode = uBubbleTimeScale ?? float(WATER_FOAM_BUBBLE_TIME_SCALE);
  const grainAmountNode = uGrainAmount ?? float(WATER_FOAM_GRAIN_AMOUNT);
  const grainOctaveNode = uGrainOctave ?? float(WATER_FOAM_GRAIN_OCTAVE);
  const grainTimeScaleNode = uGrainTimeScale ?? float(WATER_FOAM_GRAIN_TIME_SCALE);

  // ── THE DOMAIN ────────────────────────────────────────────────────────
  // The SAME safe `worldXY + domainOffset` tier 2's own fetch travels on, at
  // a finer scale tied to the reach (so cells stay proportional to the foam
  // at every body size — `Water-Foam.md` §3).
  const cellPx = max(reach.mul(float(WATER_FOAM_CELL_FRACTION)), float(4));
  const cell = worldXY.add(domainOffset).div(cellPx);

  // ── THE FLOW NUDGE — bounded, additive, NEVER a rotation ────────────────
  // See `WATER_FOAM_FLOW_NUDGE`'s own doc for the full story. `localFlowDir`
  // defaults to `flowDir` itself, so `deviation` is exactly the zero vector
  // (nudge does nothing) whenever no real local signal was supplied — same
  // null-safe contract `water-field.js#buildWaterSurfaceField`'s `flowWarp`
  // already uses. Magnitude-clamped to at most 1 (two unit vectors differ by
  // at most 2, dead-on opposite) before the small constant scales it, so the
  // nudge is bounded BY CONSTRUCTION, not by hoping the constant is small
  // enough — the same property `flowWarp` already proved out.
  const localDir = localFlowDir ?? flowDir;
  const deviation = localDir.sub(flowDir);
  const deviationSafe = deviation.div(max(length(deviation), float(1)));
  // ⚠️ NEGATED (2026-08-19 fix) — the EXACT same sign law as
  // `water-field.js#WATER_FLOW_WARP_INFLUENCE`'s own doc derives in full:
  // this nudge approximates a differential local-vs-global drift, and every
  // drift in this whole effect is negated ("a pattern moves opposite to its
  // domain"). Un-negated, this shipped the same live-reported "pushed INTO
  // the obstacle instead of around it" symptom `flowWarp` had — same bug,
  // same fix, same file family.
  const nudgedCell = cell.add(deviationSafe.mul(flowNudgeNode).negate());

  // ── 1. THE CELLULAR STRUCTURE — a net with holes, not veins ─────────────
  // ⚠️ F2−F1, NOT RAW F1 (2026-08-19 fix — see this function's own header for
  // the live-reported symptom this replaces). `mx_worley_noise_float` returns
  // F1 alone (distance to the NEAREST feature point), and F1's own local
  // MAXIMA sit only at the isolated points equidistant from three-or-more
  // cells (Voronoi VERTICES) — thresholding near those maxima lights small
  // blobs AT vertices, never the connecting EDGES between them, because F1
  // falls away from its own maximum in every direction around a vertex just
  // as fast as it does anywhere else. That is a "disconnected specks" shape
  // by construction, not a "net with holes" one — no threshold choice fixes
  // it, because the defect is which SCALAR is being thresholded, not where.
  // `mx_worley_noise_vec2` (`three.webgpu.js`, confirmed by reading its own
  // source: `sqdist.x`/`.y` are the two SMALLEST distances found across the
  // same 3×3 feature search F1 already runs) gives F1 AND F2 for the cost of
  // one extra tracked minimum in the same loop. `F2−F1` is exactly zero ON a
  // cell edge (the two nearest features are equidistant there BY
  // DEFINITION) and grows toward every cell's own interior — thresholding
  // it near zero traces the FULL, CONNECTED boundary between every pair of
  // neighbouring cells, the actual "net" shape real foam has.
  // ── STRETCHED ALONG THE CURRENT — see `WATER_FOAM_STREAK` ────────────────
  // Rotate the (already-nudged) cell domain into (along-flow, across-flow)
  // and lengthen the along axis. `flowDir` ONLY, restored to
  // `WATER_FOAM_STREAK`'s own original contract — "rotating into it cannot
  // fan out anywhere" is only true while it stays a GLOBAL uniform; feeding
  // a per-pixel direction here is exactly the bug `WATER_FOAM_FLOW_NUDGE`'s
  // doc explains. Real obstacle responsiveness already happened above, as a
  // bounded SHIFT of the point being rotated — this rotation itself never
  // varies across the surface, so it cannot spiral regardless of how sharply
  // the real local flow bends next door.
  const alongFlow = nudgedCell.x.mul(flowDir.x).add(nudgedCell.y.mul(flowDir.y));
  const acrossFlow = nudgedCell.x.mul(flowDir.y.negate()).add(nudgedCell.y.mul(flowDir.x));
  const streakCell = vec2(alongFlow.div(float(WATER_FOAM_STREAK)), acrossFlow);
  const worleyRanks = mx_worley_noise_vec2(vec2(streakCell.x, streakCell.y), float(1));
  const edgeDistSharp = worleyRanks.y.sub(worleyRanks.x); // F2 − F1, ZERO on a cell edge

  // ── THE BUBBLE — a faster, independent time-varying nudge to WHERE the
  // net's own walls sit (`WATER_FOAM_BUBBLE_*` own doc has the full case).
  // Sampled in `streakCell` (post-stretch), at a higher frequency and its
  // own clock rate, so it reads as texture jittering WITHIN the net rather
  // than a second, competing net of its own.
  const bubbleNoise = mx_fractal_noise_vec3(
    vec3(streakCell.x.mul(bubbleOctaveNode), streakCell.y.mul(bubbleOctaveNode), tSec.mul(bubbleTimeScaleNode)),
    2,
    2.0,
    0.5
  ).x;
  const edgeDist = edgeDistSharp.add(bubbleNoise.mul(bubbleAmountNode));

  // ── THE EDGE, ANTI-ALIASED (2026-08-19) — see `WATER_FOAM_EDGE_AA_PX`'s
  // own doc. `far` is the WIDER of the stylistic minimum
  // (`WATER_FOAM_EDGE_FAR`) and whatever `fwidth` says THIS frame, at
  // whatever zoom is actually active, is needed to keep the transition a
  // few real screen pixels wide — never narrower, whichever term wins.
  // INVERTED vs. the old F1 cut: bright NEAR zero (an edge), dark as the
  // pixel moves toward a cell's own interior — `smoothstep` alone ramps the
  // other way, so this is `1 −` that ramp, not a reversed-argument trick
  // (reversing smoothstep's own edge args is undefined for edge0 > edge1).
  const edgeFarAA = max(edgeFarNode, fwidth(edgeDist).mul(edgeAaPxNode));
  const cellWalls = float(1).sub(smoothstep(float(WATER_FOAM_EDGE_NEAR), edgeFarAA, edgeDist));
  // ── A SECOND, FINER OCTAVE — bubbles ON the clumps ──────────────────────
  // See `WATER_FOAM_FINE_OCTAVE`: one octave gives cells of a single size,
  // and the eye reads that as a repeating texture rather than as a
  // substance. The fine octave MULTIPLIES the coarse walls rather than
  // averaging with them, so detail appears only where there is foam to be
  // detailed and the holes stay genuinely open. Same AA and bubble
  // treatment as the coarse octave immediately above, independently
  // measured against ITS OWN `fwidth` (a finer, higher-frequency field
  // aliases at a different rate than the coarse one, so sharing one AA
  // width between them would under- or over-correct one of the two).
  const fineCell = streakCell.mul(float(WATER_FOAM_FINE_OCTAVE));
  const worleyFineRanks = mx_worley_noise_vec2(vec2(fineCell.x, fineCell.y), float(1));
  const fineEdgeDistSharp = worleyFineRanks.y.sub(worleyFineRanks.x);
  const fineEdgeDist = fineEdgeDistSharp.add(bubbleNoise.mul(bubbleAmountNode));
  const fineFarAA = max(edgeFarNode, fwidth(fineEdgeDist).mul(edgeAaPxNode));
  const fineWalls = float(1).sub(smoothstep(float(WATER_FOAM_EDGE_NEAR), fineFarAA, fineEdgeDist));
  const structureNet = cellWalls.mul(float(1 - WATER_FOAM_FINE_SHARE).add(fineWalls.mul(float(WATER_FOAM_FINE_SHARE))));
  // ── THE GRAIN — see `WATER_FOAM_GRAIN_AMOUNT`'s own doc for the full case
  // (a SEPARATE mechanism from the bubble nudge above: this multiplies the
  // net's own brightness, visible everywhere it is non-zero, not just at
  // its edges). Independent noise fetch from the bubble's own (different
  // frequency AND different clock rate — sharing one would make grain and
  // bubble move in lockstep, reading as one coarser effect instead of two
  // textures at two scales, the actual "gritty AND evolving" look asked
  // for). `.add(0.5)` twice: `mx_fractal_noise` is roughly zero-centred
  // (this file's own header, elsewhere, measures it), remapped to `[0,1]`
  // before it scales the brightness cut.
  const grainNoise = mx_fractal_noise_vec3(
    vec3(streakCell.x.mul(grainOctaveNode), streakCell.y.mul(grainOctaveNode), tSec.mul(grainTimeScaleNode)),
    2,
    2.0,
    0.5
  ).x;
  const grain = float(1)
    .sub(grainAmountNode)
    .add(grainNoise.mul(float(0.5)).add(float(0.5)).mul(grainAmountNode));
  const structure = structureNet.mul(grain);
  // `1 − bite·(1 − walls)`: full brightness on a wall, thinned (never
  // erased) in a cell's middle. A clean multiply by `structure` would
  // stencil holes right through a CONTINUOUS sheet, which reads as a pattern
  // laid over water rather than as foam of varying thickness — the right
  // choice for shore foam, wrong for anything meant to look patchy.
  const lace = float(1)
    .sub(float(WATER_FOAM_CELL_BITE))
    .add(structure.mul(float(WATER_FOAM_CELL_BITE)));

  return { cell, lace, structure, edgeDistRaw: edgeDist };
}

/**
 * Build tier 4's shoreline foam — a SCALAR ADD-ON to tier 2's own foam total,
 * never a replacement (Effects.md Law 2).
 *
 * @param {object} args
 * @param {*} args.TSL - `THREE.TSL`, injected by the caller that owns THREE.
 * @param {*} args.worldXY - a vec2 node: this fragment's world position.
 * @param {*} args.timeMsNode - THE SHARED CLOCK, handed down — never a private
 *   time node (`time/one-clock`).
 * @param {*} args.domainOffset - a vec2 node: `buildWaterSurfaceField`'s own
 *   `domainOffset` return, REUSED verbatim rather than re-derived — see the
 *   header for why re-deriving it, even correctly, would be a second
 *   independently-drifting copy of a thing this effect has already shipped two
 *   bugs in (`feedback_shared_field_two_meanings_two_registries`).
 * @param {*} args.tangentXY - a vec2 node: the body pack's BA, the bare shore
 *   tangent. Rotated into the shore NORMAL here — see the header.
 * @param {*} args.flowDir - a vec2 node: the unit world-space direction the
 *   water travels toward (`uFlowDir`, from `waterFlowVector`). Still the ONLY
 *   direction the domain offset and the tail's march use — see the S4 header
 *   block above `WATER_LOCAL_SPEED01_BASELINE` for exactly which three terms
 *   read `localFlowDir` instead and why the rest deliberately do not.
 * @param {*|null} [args.localFlowDir] - S4 (2026-08-18): a vec2 node, the
 *   REAL per-pixel solved direction (`res:waterFlow`'s RG, already
 *   normalised, already falling back to `flowDir` wherever the solve has no
 *   local signal — the caller's job, not this function's). `null`/absent
 *   defaults to `flowDir`, reproducing pre-S4 output exactly.
 * @param {*|null} [args.localSpeed01] - S4: a float node, `res:waterFlow`'s B
 *   channel at this pixel. `null`/absent defaults to the free-stream
 *   baseline ({@link WATER_LOCAL_SPEED01_BASELINE}), i.e. "exactly normal",
 *   reproducing pre-S4 output exactly.
 * @param {*} args.shoreDist - a float node: distance INSIDE the water from the
 *   bank, world px.
 * @param {*} args.insideWater - a float node, 1 inside the body and 0 outside.
 *   REQUIRED — see `water-field.js`'s foam block for the live bug its absence
 *   caused, and this rung's own caustics leak for the second one.
 * @param {*} args.uReachPx - a float uniform node: the shore reach in world px,
 *   already derived from `depthScalePx` on the CPU by {@link waterFoamReachPx}.
 * @param {*} args.uSwash - float uniform node: the author's swash amount.
 * @param {*} args.uBreak - float uniform node: the author's break-foam amount.
 * @param {*} args.uTrail - float uniform node: how strongly break foam streams
 *   downstream (`WATER_PARAMS.foamTrail`). Only read when `sampleBodyAt` is
 *   supplied — with no sampler the whole tail is compiled out and this is
 *   never referenced.
 * @param {((offsetXY: *) => *)|null} [args.sampleBodyAt] - THE TAIL'S ONLY
 *   INPUT: given a vec2 WORLD-SPACE OFFSET node, return the body pack sampled
 *   at `thisPixel + offset` as a vec4 node (x = signed distance, z/w = shore
 *   tangent — the same layout `water-body.js` bakes). Injected rather than
 *   rebuilt here because `water-render.js` owns the body-pack UV mapping,
 *   including the smooth C2 reconstruction, and a second derivation of it here
 *   is precisely the duplicated-knowledge shape this effect has already shipped
 *   two bugs in. Absent/null compiles the tail out entirely (Law 4).
 * @returns {{foam: *, breakOnly: *, tailOnly: *, d01: *, lace: *, swashBand: *, breakFacing: *}}
 *   `foam` 0..1, ADDED to tier 2's own at the call site. `breakOnly` is the break
 *   term alone, exposed so a future rung (spray particles at tier 8) can spawn
 *   from the same measure that drew it, rather than re-deriving where obstacles
 *   are. The rest are diagnostic taps — see `water.js#WATER_DEBUG_CHANNELS` —
 *   each one a DIFFERENT stage of the product, so a dead term can be localised
 *   the way `d01/lace/swashBand/breakFacing` each answer a different question
 *   ("am I near the shore at all" / "does the cellular structure exist" / "is
 *   the wave pattern firing" / "is the direction math even right") rather than
 *   four readings of the same number.
 */
export function buildWaterShoreFoam({
  TSL,
  worldXY,
  timeMsNode,
  domainOffset,
  tangentXY,
  flowDir,
  // S4 (2026-08-18) — see this file's own header block just above
  // `WATER_LOCAL_SPEED01_BASELINE` for why these are safe to use per-pixel
  // where `flowDir` is not. BOTH default to `flowDir`/the free-stream
  // baseline — a caller that does not pass them (the synthetic river bench,
  // any Node test written before S4) gets EXACTLY tier 4's pre-S4 output,
  // bit for bit; this is additive, never a behaviour change for an unwired
  // caller.
  localFlowDir = null,
  localSpeed01 = null,
  shoreDist,
  insideWater,
  uReachPx,
  uSwash,
  uBreak,
  uTrail,
  sampleBodyAt = null,
  // ROH TUNING (2026-08-19) — every `buildFoamCellularStructure` uniform
  // (`uFlowNudge`, `uEdgeFar`, …), bundled so this signature does not grow a
  // 9-argument tail. `null`/omitted spreads to nothing, so an unwired caller
  // gets the exact pre-param defaults.
  foamStructureUniforms = null,
}) {
  const { vec2, vec3, float, max, min, dot, sin, step, clamp, smoothstep, mx_fractal_noise_vec3 } = TSL;

  const effectiveLocalDir = localFlowDir ?? flowDir;
  const effectiveLocalSpeed01 = localSpeed01 ?? float(WATER_LOCAL_SPEED01_BASELINE);
  // Bounded, never open-ended — see WATER_LOCAL_SPEED_AMP_MIN/MAX's own doc.
  const speedAmp = clamp(
    effectiveLocalSpeed01.div(float(WATER_LOCAL_SPEED01_BASELINE)),
    float(WATER_LOCAL_SPEED_AMP_MIN),
    float(WATER_LOCAL_SPEED_AMP_MAX)
  );

  const tSec = timeMsNode.mul(float(1 / 1000));
  const reach = max(uReachPx, float(1));

  // 0 AT THE WATERLINE, 1 AT THE EDGE OF THE FOAM BAND. Every term below is a
  // function of this scalar, which is what makes them all incapable of shearing
  // the domain — see the header on why a tangent-space coordinate is not used.
  const d01 = clamp(shoreDist.div(reach), 0, 1);

  // ── THE CELLULAR STRUCTURE — a net with holes, not veins ─────────────────
  // `cell` is the SAME shared domain coordinate the swash wobble below reuses
  // (S4's own rotate-by-`effectiveLocalDir` safety argument — an already-
  // bounded vector rotated by a per-pixel angle cannot shear — lives in
  // `buildFoamCellularStructure`'s own doc now, not duplicated here).
  // `flowDir` here is `buildWaterShoreFoam`'s OWN param — the global uniform,
  // per this call site's own contract (water-render.js passes `flowDir:
  // uFlowDir` unconditionally) — never `effectiveLocalDir`. `localFlowDir`
  // (possibly null) carries the real per-pixel signal in separately, as the
  // bounded nudge `WATER_FOAM_FLOW_NUDGE` describes, not the rotation.
  const { cell, lace } = buildFoamCellularStructure({
    TSL,
    worldXY,
    domainOffset,
    flowDir,
    localFlowDir,
    uReachPx,
    timeMsNode,
    ...(foamStructureUniforms ?? {}),
  });

  // ── 2. SWASH — bands that TRAVEL shoreward ──────────────────────────────
  // A periodic function of `(d01 − t·speed)`: subtracting time is what makes the
  // bands advance toward the shore rather than pulse in place. Distorted first
  // by a low-frequency noise so the bands wander along the shore instead of
  // running perfectly parallel to it (Cyanilux's step; without it a straight
  // bank gets suspiciously straight foam).
  const wobble = mx_fractal_noise_vec3(
    vec3(cell.x.mul(float(0.35)), cell.y.mul(float(0.35)), tSec.mul(float(0.05))),
    2,
    2.0,
    0.5
  );
  // ⚠️ `speedAmp` DOES NOT MULTIPLY THE RATE HERE — LIVE REGRESSION, FOUND
  // AND FIXED THE SAME DAY IT SHIPPED. The first version of this line read
  // `tSec.mul(float(WATER_SWASH_SPEED)).mul(speedAmp)` — the shearing-vs-
  // time safety argument for that (bounded `sin()` output, no 2-D domain
  // shift) was correct as far as it went, but missed a DIFFERENT consequence
  // specific to this field's own geometry: `d01` is not a simple linear
  // coordinate — it is RADIAL around every small obstacle a pier-sized
  // "shore" produces, so "same `d01`, different ANGLE around the pier" is
  // the common case, not an edge case. Local speed genuinely differs by
  // angle around an obstacle (faster on the flanks, slack in the lee — the
  // whole point of the S3 solve), so a per-pixel RATE multiplying `tSec`
  // gives different angular sectors of the SAME ring a different phase RATE
  // — and animated over time, a phase GRADIENT around a closed ring is
  // exactly what a rotating pattern looks like. Author, live: *"radiating
  // rings which are now just rotating in space... doesn't look like foam at
  // all."* The rendered VALUE was never unbounded (that safety property
  // still holds and is not what was wrong); the SHAPE of the animation was.
  // `speedAmp` still reaches swash — see the FINAL multiply below, a pure
  // brightness/height scale with no phase/rate involved, which cannot
  // produce this artifact because it carries no time dependence of its own.
  const phase = d01.add(wobble.x.mul(float(0.09))).sub(tSec.mul(float(WATER_SWASH_SPEED)));
  const wave = sin(phase.mul(float(WATER_SWASH_BANDS * 2 * Math.PI)));
  // Threshold the wave into a band. `1 − 2·width` puts the cut near the top of
  // the sine's range, so only the crest of each cycle lights — a travelling
  // line, not a sine-shaded gradient.
  const band = smoothstep(float(1 - 2 * WATER_SWASH_WIDTH), float(1), wave);
  // Fade the swash out with distance so it lives at the waterline and does not
  // stripe the open channel — the `(1 − d01)` every published version applies for
  // the same reason. `speedAmp` (S4) scales the swash TALLER where local
  // current runs faster than the river's own free-stream baseline, and
  // shorter in a slack lee — bounded, see WATER_LOCAL_SPEED_AMP_MIN/MAX.
  const swash = band.mul(float(1).sub(d01)).mul(uSwash).mul(speedAmp);

  // ── 3. BREAK FOAM — the flow running INTO a bank ────────────────────────
  // See the header for the derivation. `outward` is the shore normal pointing
  // away from the nearest bank; the current heading against it is a break.
  // S4 (2026-08-18): `effectiveLocalDir`, not the bulk `flowDir` — this was
  // always a per-pixel POINTWISE dot product of two unit vectors (no domain
  // offset, no time), so swapping which direction feeds it changes nothing
  // about the safety shape, only the ACCURACY: the solved field routes
  // around an obstacle's actual footprint (the S3 pressure solve's whole
  // point), where the bulk compass alone cannot know a rock is even there
  // until the current is already hitting it face-on.
  const outward = vec2(tangentXY.y, tangentXY.x.negate());
  const facing = max(dot(effectiveLocalDir, outward).negate(), float(0));
  // Sharpened so foam sits on the face genuinely presented to the stream rather
  // than smeared around the whole obstacle. `x·x` is `pow(x,2)` without a
  // transcendental — WATER_BREAK_SHARPNESS documents the intent; if it ever
  // needs to be authorable this is where a `pow` goes.
  const sharpened = facing.mul(facing);
  // Tighter to the bank than the swash — water piles into a narrow collar
  // against an obstacle, it does not wash a broad band the way a beach does.
  const breakBand = float(1).sub(smoothstep(float(0), float(WATER_BREAK_REACH_FRACTION), d01));
  const breakFoam = sharpened.mul(breakBand).mul(uBreak);

  // ── 4. THE TAIL — foam made UPSTREAM, carried past here ─────────────────
  // See `WATER_TAIL_TAPS` for the full account: this is the one term in the
  // rung that is not a pure function of this pixel's own position, and it is
  // what stops the foam reading as a texture stuck to the map. Each tap
  // re-evaluates the BREAK GENERATION test at a point further upstream and
  // deposits a decayed share of whatever it finds.
  //
  // ⚠️ COMPILED OUT ENTIRELY without a sampler (Effects.md Law 4, a JS-time
  // branch): a caller that cannot offer body-pack taps — the torture fixture,
  // any tier below 4 — pays nothing at all, rather than multiplying four dead
  // fetches by a zero uniform.
  let tailFoam = float(0);
  if (sampleBodyAt) {
    const tailReach = reach.mul(float(WATER_TAIL_REACH_MULT));
    for (let i = 1; i <= WATER_TAIL_TAPS; i++) {
      const t = i / WATER_TAIL_TAPS;
      // UPSTREAM is `−flowDir`: the water here came from there.
      const body = sampleBodyAt(flowDir.mul(tailReach.mul(float(-t))));
      // The SAME generation test as above, at that point — never a cheaper
      // stand-in, or the tail would be a different substance from its source
      // (`feedback_read_the_producer_never_invent_its_shape`).
      // ⚠️ **THE TAP MUST PROVE IT LANDED IN WATER, AND `upShore` CANNOT SAY.**
      // `max(−sdf, 0)` collapses two completely different states onto 0: "at
      // the waterline" (where break foam is at its STRONGEST) and "on dry
      // land" (where there is no water to make foam at all). `upBand` then
      // reads that shared 0 as maximum. Without this gate the tail sprayed
      // full-strength foam out of every headland the march happened to cross —
      // measured on the bench as broad hard-edged wedges lying across the bank,
      // nothing like a wake (`feedback_derived_zero_collides_with_configured_
      // zero`, and the reason the SIGN is what gets tested rather than the
      // clamped magnitude).
      const upInside = step(body.x, float(0)); // sdf is negative INSIDE the water
      const upShore = max(body.x.negate(), float(0));
      const upD01 = clamp(upShore.div(reach), 0, 1);
      const upOutward = vec2(body.z, body.w.negate());
      const upFacing = max(dot(flowDir, upOutward).negate(), float(0));
      const upBand = float(1).sub(smoothstep(float(0), float(WATER_BREAK_REACH_FRACTION), upD01));
      const upBreak = upFacing.mul(upFacing).mul(upBand).mul(upInside);
      // DECAY WITH DISTANCE TRAVELLED — foam is a substance with a lifetime,
      // and a tail that stayed at full strength would read as a painted stripe
      // rather than as something dispersing. Linear in `t` is deliberately
      // gentler than the physical exponential: at this few taps an exponential
      // puts almost everything in the first tap and the trail stops looking
      // like a trail.
      tailFoam = max(tailFoam, upBreak.mul(float(1 - t * 0.75)));
    }
    // ⚠️ A WAKE HUGS THE BANK IT CAME FROM — gate the DEPOSIT by this pixel's
    // own shore distance, not only by the tap's. Without this the tail is
    // free to land anywhere the march happens to find a facing bank upstream,
    // which in a wide pool means the middle of open water: measured on the
    // bench as a regular cross-hatch filling the channel, because every one of
    // the discrete taps deposited its own band out there with nothing to fade
    // it. Real foam carried off an obstacle stays in the slow water near the
    // edge and is dispersed by the time it reaches midstream. The band is the
    // FULL foam reach — twice break's own tight collar, so the tail genuinely
    // outruns its source — but bounded, which is what matters.
    const tailBand = float(1).sub(smoothstep(float(0), float(1), d01));
    tailFoam = tailFoam.mul(tailBand).mul(uBreak).mul(uTrail);
  }

  // ── THE TOTAL ───────────────────────────────────────────────────────────
  // Both foams share the lace, so they read as one material rather than two
  // effects that happen to overlap. `insideWater` is the same non-negotiable
  // gate every term in this effect carries: `shoreDist` is a CLAMPED signed
  // distance, so 0 on dry land is indistinguishable from 0 at the waterline,
  // which is where these terms are strongest (correction #9, and the caustics
  // leak of 2026-08-16 that put a moving pattern across the author's whole
  // ground floor).
  // ⚠️ `max` OF THE THREE, NOT A SUM. They are three views of ONE substance
  // covering this pixel, not three substances stacked: where a swash band runs
  // over an obstacle's tail, the water is not twice as foamy, it is foamy once.
  // Summing would drive every overlap straight to the clamp and erase exactly
  // the structure the lace and the tail exist to provide.
  const foam = min(max(max(swash, breakFoam), tailFoam).mul(lace).mul(insideWater), float(1));

  return {
    foam,
    breakOnly: breakFoam.mul(insideWater),
    tailOnly: tailFoam.mul(insideWater),
    d01,
    lace,
    swashBand: band,
    breakFacing: facing,
  };
}

/**
 * THE SCALE RULE, on the CPU — shore reach in world px from the author's own
 * `depthScalePx`.
 *
 * Pure and exported so `Water-Foam.md` §3's "every foam length is relative to a
 * body-scale quantity, never a bare pixel constant" is a Node-tested fact rather
 * than a docstring. See {@link WATER_FOAM_SHORE_FRACTION} for why this is the
 * whole answer to "ponds through ocean shorelines".
 *
 * @param {number} depthScalePx - WATER_PARAMS `depthScalePx`.
 * @returns {number} world px, clamped to a physically sane band.
 */
export function waterFoamReachPx(depthScalePx) {
  const d = Number.isFinite(depthScalePx) && depthScalePx > 0 ? depthScalePx : 0;
  const raw = d * WATER_FOAM_SHORE_FRACTION;
  return Math.min(WATER_FOAM_REACH_MAX_PX, Math.max(WATER_FOAM_REACH_MIN_PX, raw));
}
