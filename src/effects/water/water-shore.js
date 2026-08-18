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
 * Where the Worley field is cut into cell WALLS.
 *
 * ⚠️ MEASURED, NOT ASSUMED — the mistake this file exists to not repeat.
 * `mx_worley_noise_float(p, 1)` on this build returns distance-to-nearest-
 * feature: measured p10 0.097, p50 0.298, p90 0.590, max ~1.18, with **9.3% of
 * the field above 0.6**. Cutting at 0.42→0.72 lights the walls between cells and
 * leaves the cell interiors dark, which is the net-with-holes structure real
 * foam has (SideFX's "bald patches"; NOAA's "network of interconnected
 * channels"). Cutting near the median instead would light half the field and
 * reproduce the wash this file shipped as.
 *
 * ⚠️ **THE VENDORED WRAPPER TAKES `(texcoord, jitter)` ONLY.** MaterialX's own
 * `mx_worley_noise_float` has a third distance-metric argument; three.webgpu.js
 * hardcodes it to `1` and silently ignores a third argument (verified on-device:
 * passing 0, 1 and 2 returned byte-identical statistics). Do not add one back
 * expecting a different metric.
 */
export const WATER_FOAM_CELL_EDGE0 = 0.42;
export const WATER_FOAM_CELL_EDGE1 = 0.72;

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
 *   water travels toward (`uFlowDir`, from `waterFlowVector`).
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
  shoreDist,
  insideWater,
  uReachPx,
  uSwash,
  uBreak,
  uTrail,
  sampleBodyAt = null,
}) {
  const {
    vec2,
    vec3,
    float,
    max,
    min,
    dot,
    sin,
    step,
    clamp,
    smoothstep,
    mx_worley_noise_float,
    mx_fractal_noise_vec3,
  } = TSL;

  const tSec = timeMsNode.mul(float(1 / 1000));
  const reach = max(uReachPx, float(1));

  // 0 AT THE WATERLINE, 1 AT THE EDGE OF THE FOAM BAND. Every term below is a
  // function of this scalar, which is what makes them all incapable of shearing
  // the domain — see the header on why a tangent-space coordinate is not used.
  const d01 = clamp(shoreDist.div(reach), 0, 1);

  // ── THE DOMAIN, REUSED ──────────────────────────────────────────────────
  // The SAME safe `worldXY + domainOffset` tier 2's own fetch travels on, at a
  // finer scale tied to the band (so cells stay proportional to the foam at
  // every body size — `Water-Foam.md` §3).
  const cellPx = max(reach.mul(float(WATER_FOAM_CELL_FRACTION)), float(4));
  const cell = worldXY.add(domainOffset).div(cellPx);

  // ── 1. THE CELLULAR STRUCTURE — a net with holes, not veins ─────────────
  // Cell WALLS, cut at the measured distribution's upper tail (see
  // WATER_FOAM_CELL_EDGE0/1). This is the term that makes everything below read
  // as foam rather than as a smooth gradient.
  // ── STRETCHED ALONG THE CURRENT — see `WATER_FOAM_STREAK` ────────────────
  // Rotate the cell domain into (along-flow, across-flow) and lengthen the
  // along axis. `flowDir` is GLOBAL, so this rotation is the same everywhere
  // and cannot shear; the result is foam drawn out into streaks pointing the
  // way the water is going, which is both what real foam does and what hides
  // the seams between the tail's discrete taps below.
  const alongFlow = cell.x.mul(flowDir.x).add(cell.y.mul(flowDir.y));
  const acrossFlow = cell.x.mul(flowDir.y.negate()).add(cell.y.mul(flowDir.x));
  const streakCell = vec2(alongFlow.div(float(WATER_FOAM_STREAK)), acrossFlow);
  const worley = mx_worley_noise_float(vec2(streakCell.x, streakCell.y), float(1));
  const cellWalls = smoothstep(float(WATER_FOAM_CELL_EDGE0), float(WATER_FOAM_CELL_EDGE1), worley);
  // ── A SECOND, FINER OCTAVE — bubbles ON the clumps ──────────────────────
  // See `WATER_FOAM_FINE_OCTAVE`: one octave gives cells of a single size, and
  // the eye reads that as a repeating texture rather than as a substance. The
  // fine octave MULTIPLIES the coarse walls rather than averaging with them, so
  // detail appears only where there is foam to be detailed and the holes stay
  // genuinely open.
  const fineCell = streakCell.mul(float(WATER_FOAM_FINE_OCTAVE));
  const worleyFine = mx_worley_noise_float(vec2(fineCell.x, fineCell.y), float(1));
  const fineWalls = smoothstep(float(WATER_FOAM_CELL_EDGE0), float(WATER_FOAM_CELL_EDGE1), worleyFine);
  const structure = cellWalls.mul(float(1 - WATER_FOAM_FINE_SHARE).add(fineWalls.mul(float(WATER_FOAM_FINE_SHARE))));
  // `1 − bite·(1 − walls)`: full brightness on a wall, thinned (never erased) in
  // a cell's middle. A clean multiply by `structure` would stencil holes right
  // through the foam, which reads as a pattern laid over water rather than as
  // foam of varying thickness.
  const lace = float(1)
    .sub(float(WATER_FOAM_CELL_BITE))
    .add(structure.mul(float(WATER_FOAM_CELL_BITE)));

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
  const phase = d01.add(wobble.x.mul(float(0.09))).sub(tSec.mul(float(WATER_SWASH_SPEED)));
  const wave = sin(phase.mul(float(WATER_SWASH_BANDS * 2 * Math.PI)));
  // Threshold the wave into a band. `1 − 2·width` puts the cut near the top of
  // the sine's range, so only the crest of each cycle lights — a travelling
  // line, not a sine-shaded gradient.
  const band = smoothstep(float(1 - 2 * WATER_SWASH_WIDTH), float(1), wave);
  // Fade the swash out with distance so it lives at the waterline and does not
  // stripe the open channel — the `(1 − d01)` every published version applies for
  // the same reason.
  const swash = band.mul(float(1).sub(d01)).mul(uSwash);

  // ── 3. BREAK FOAM — the flow running INTO a bank ────────────────────────
  // See the header for the derivation. `outward` is the shore normal pointing
  // away from the nearest bank; the current heading against it is a break.
  const outward = vec2(tangentXY.y, tangentXY.x.negate());
  const facing = max(dot(flowDir, outward).negate(), float(0));
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
