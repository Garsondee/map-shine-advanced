/**
 * THE SIM PACK — `res:waterSim` (`docs/planning/Water-Simulation-Turn.md` §3
 * Layer C), foam's actual MEMORY. Everything before this file is a snapshot:
 * the body pack is a distance field, the flow pack is a solved-but-static
 * velocity field, and every render-time foam term that read them
 * (`water-shore.js`'s swash/break/tail) was a pure function of (position,
 * clock) — zero state carried between frames. That is exactly why the
 * author's own critique landed the way it did: *"the concentric circles
 * radiating outwards are very predictable and artificial, the same distance
 * between each, they are all soft, the same width, the same rhythm, they
 * aren't noisy, they aren't currently being changed by the surface of the
 * water."* A pure function of (pos, time) cannot fail to be regular — nothing
 * in it can accumulate, drift, or disagree with its own neighbours. S5 is the
 * fix: a ping-ponged RGBA16F buffer this pass reads AND writes, one texel
 * remembering what was there a moment ago and where the current is about to
 * carry it.
 *
 * ONE PASS, PER FRAME (`Water-Simulation-Turn.md` §3 Layer C's own line:
 * "One pass per frame"), unlike the body/flow packs, which bake only when
 * their inputs change. `buildWaterSimStepMaterial` below builds that single
 * pass: ADVECT (semi-Lagrangian, sampling last frame's own buffer at a
 * position traced backward along this frame's velocity) → DECAY (exponential,
 * `WATER_SIM_TAU_FOAM_SEC`) → EMIT (three terms: a rock's upstream face, a
 * shear line beside it, and the shore's own swash rhythm, all gated by real
 * local speed and jittered by noise) → GATHER (blend toward a local blur) —
 * see this file's own header below on why BREAK (the threshold) is deliberately
 * NOT part of this sequence's own stored output.
 *
 * ============================================================================
 * WHY THE FLOW PACK'S VELOCITY IS SCALED HERE, NOT EARLIER
 * ============================================================================
 * `water-flow.js#buildWaterProjectPackMaterial`'s own doc is explicit: the
 * solve has no notion of world px/sec at all, RG is normalised so free-stream
 * speed is 1.0, and "a real-world scale is a CONSUMER-side multiply by the
 * author's own `flowSpeedPx`, applied at read time, never baked in here."
 * This pass is that consumer — `uFlowSpeedPx` (the SAME schema value
 * `water.js#flowSpeedPx` already exposes as "how fast the surface travels
 * downstream, in canvas pixels per second") converts the pack's normalised RG
 * into an actual world-px/s displacement before it ever reaches the advection
 * math below. Get this multiply's position wrong — apply it before the pack
 * bakes, say — and EVERY consumer downstream inherits a value that looks
 * like velocity but is not one; this file is the first thing that actually
 * needs a real distance, so this is where the scale first has to exist.
 *
 * ============================================================================
 * WHY `blur3x3` BLURS THE READ, NOT THE WRITE
 * ============================================================================
 * §3's own pseudocode writes `foam = smoothstep(LO, HI, mix(foam,
 * blur3x3(foam), DIFFUSE))` — `foam` there already includes this frame's own
 * decay and emission. Read literally, `blur3x3(foam)` would need to sample
 * NEIGHBOURING FRAGMENTS' post-emission values, which do not exist yet: a
 * fragment shader invocation cannot see what a different invocation in the
 * SAME draw call is about to compute, only what already exists in a texture
 * from a PRIOR pass. The only single-pass-achievable reading is to blur the
 * SOURCE — last frame's own buffer, sampled at nine offsets around the
 * advected position — and blend that into the diffusion step BEFORE this
 * frame's decay and emission are added, rather than after. That reordering
 * keeps the pseudocode's intent (persisting foam spreads toward its
 * neighbours; fresh emission stays locally sharp; the final threshold turns
 * the blend into clumps and breaks rather than a smooth gradient) while
 * staying inside what one pass can actually compute.
 *
 * ============================================================================
 * WHY THE THRESHOLD ("BREAK") IS NOT APPLIED TO THE STORED STATE — A REAL
 * BUG, CAUGHT BEFORE SHIPPING, VIA THE REAL-MAP BENCH SCENARIO (2026-08-18)
 * ============================================================================
 * §3's own pseudocode writes `foam = smoothstep(LO, HI, mix(foam,
 * blur3x3(foam), DIFFUSE))` and that same `foam` is both the frame's output
 * AND next frame's own input (the ping-pong loop this whole file exists to
 * run). The FIRST version of this file did exactly that — and against the
 * real Tower Bridge map, with a real flow bake and 150 real ticks, the
 * buffer's foam channel measured EXACTLY zero everywhere, always, no matter
 * how long the scenario ran. The cause: `smoothstep(0.15, 0.55, x)` returns
 * EXACTLY 0 for any `x` at or below 0.15, and ONE FRAME's own emission
 * increment (`totalEmit * dtSec`, a few hundredths at this fixture's real
 * flow speeds) can never itself cross a threshold sized for the ACCUMULATED
 * steady state. Once a texel's stored value gets snapped to exactly 0 by its
 * own frame's threshold, next frame decays ~0 to ~0 and adds another tiny
 * increment — never enough to cross 0.15 in a single step — and gets
 * snapped back to 0 again. The state is permanently stuck the instant it is
 * born; accumulation across many frames, the entire mechanism this buffer
 * exists to provide, cannot happen if the threshold is IN the feedback loop.
 *
 * Proof this diagnosis was right, not a guess: with the threshold
 * temporarily removed from the stored output (a bench-only bisection), the
 * SAME 150-tick run measured the raw accumulator reaching 0.805 somewhere on
 * the map by five simulated seconds, and — the actual S5 proof criterion —
 * the foam-weighted centroid's own downstream projection climbed
 * monotonically the whole time (238px → 360px). The emission, advection,
 * decay and diffusion math were never broken; only feeding the THRESHOLD
 * back into the accumulator was.
 *
 * The fix: this file stores the RAW accumulator (post decay, emit, and
 * diffuse-toward-blur — everything except the threshold), clamped to a
 * generous, purely defensive ceiling that normal operation never
 * approaches. `WATER_SIM_CLUMP_LO`/`WATER_SIM_CLUMP_HI` remain exported —
 * they are still the right shape for turning a smooth accumulated field
 * into visual clumps and breaks — but that transform belongs to whichever
 * CONSUMER reads this pack for display (`water-shore.js`/`water-render.js`,
 * S5's own task #36), applied fresh each read, never written back into the
 * memory this file is the sole owner of.
 *
 * ============================================================================
 * WHY `emitSwash` REUSES `water-shore.js`'s PHASE MATH BUT NOT ITS DOMAIN WARP
 * ============================================================================
 * The band/phase/wave shape (`WATER_SWASH_BANDS`/`WATER_SWASH_SPEED`/
 * `WATER_SWASH_WIDTH`, all imported rather than re-declared) is proven and
 * reused as-is. The old `wobble` domain distortion is NOT ported: it existed
 * to make a perfectly stateless, non-advected ring pattern look organic —
 * the ENTIRE problem this file exists to fix. Once emission feeds a buffer
 * that genuinely advects (real flow, this pass's own §1), decays, and gets
 * jittered by its own noise gate before clumping, the source of "the same
 * width, the same rhythm" the author named is gone by construction; adding
 * the old warp back on top would be compensating for a problem that no
 * longer exists.
 *
 * NO RenderTarget, Texture, or renderer-state call lives here — same wall as
 * every other file in this family (`water-flow.js`'s own header). This
 * module only BUILDS a NodeMaterial + QuadMesh and hands back the nodes the
 * caller drives. THREE is INJECTED, never imported.
 *
 * @module effects/water/water-sim
 */

import { WATER_SWASH_BANDS, WATER_SWASH_SPEED, WATER_SWASH_WIDTH } from './water-shore.js';

/** Foam's own exponential decay time constant, seconds — how long a texel's
 * foam value takes to fall to `1/e` of itself with no further emission. Sized
 * so foam SURVIVES long enough to visibly ride the current downstream before
 * fading (`Water-Simulation-Turn.md`'s own proof criterion: "foam sheds off
 * the rock and rides the current downstream while fading") rather than
 * vanishing on the same texel it was born on. A starting point for S6's own
 * tuning pass, not a measured constant. */
export const WATER_SIM_TAU_FOAM_SEC = 1.6;

/** Blend weight toward the 3×3 blur of last frame's own buffer, applied
 * BEFORE this frame's decay/emission (see this file's header on why blur
 * targets the read, not the write). 0 = no diffusion, foam stays pixel-sharp
 * forever; 1 = fully replaced by its own neighbourhood average every frame. */
export const WATER_SIM_DIFFUSE = 0.35;

/** The clump/break threshold band — `smoothstep(LO, HI, foam)`. Below LO
 * dies to 0, above HI saturates to 1, a soft ramp between — what turns a
 * smooth accumulated field into clumpy patches rather than a uniform grey
 * wash, the same lesson `feedback_saturated_curve_cannot_transmit_variation`
 * names for a different channel.
 *
 * ⚠️ NOT APPLIED IN THIS FILE — see this file's own header on why writing a
 * threshold back into the ping-pong STATE permanently stalls it at 0 (a
 * real, live-caught bug: measured exactly zero everywhere against the real
 * map until this was fixed). These two constants are exported for the
 * CONSUMER that reads `res:waterSim` for display to apply, once, at read
 * time — never for feeding back into this buffer's own next frame.
 *
 * ⚠️ RECALIBRATED 2026-08-18, SAME DAY, LIVE-REPORTED — the original 0.15/0.55
 * band was measured against a BENCH TEST run at `flowSpeedPx=220`
 * (`real-underground-river-sim`'s own `testFlowSpeedPx`, chosen to finish
 * the scenario's proof quickly, never meant as a realistic default). The
 * author's own live map runs at the schema DEFAULT, `flowSpeedPx=90`
 * (`water.js#flowSpeedPx`), and reported *"There's currently no evidence of
 * the 'sim pack foam'... that shape which works nicely isn't visible"* —
 * the raw accumulator (channel 24) showed real, correctly-shaped signal the
 * whole time; it simply never reached 0.15 at realistic settings, so the
 * display-time `smoothstep` read as a hard, permanent zero. Lowered by ~5×
 * so a modest, realistic accumulation actually crosses into visible range
 * and reaches full saturation well before this project's own measured
 * bench peak (0.245) rather than needing more than double it — a
 * DELIBERATELY generous starting point for S6's own tuning pass on the
 * bench, not a final, measured value; see that phase's own doc. */
export const WATER_SIM_CLUMP_LO = 0.03;
export const WATER_SIM_CLUMP_HI = 0.15;

/**
 * The clump/break threshold's own anti-aliasing width, in SCREEN PIXELS —
 * `water-shore.js#WATER_FOAM_EDGE_AA_PX`'s exact sibling, same technique,
 * same live-reported symptom ("pixel hard binary edges"), same reason: a
 * FIXED value-space band (`CLUMP_LO`/`CLUMP_HI`) covers fewer screen pixels
 * the more sharply `waterSimTexNode.r` changes per pixel, which a world/
 * value-space constant alone cannot prevent. Applied in `water-render.js`
 * as a floor under `(CLUMP_HI − CLUMP_LO)`, centred on the same midpoint —
 * never narrower than either.
 */
export const WATER_SIM_CLUMP_AA_PX = 1.5;

/** A generous, purely defensive ceiling on the STORED accumulator (applied
 * instead of the clump threshold — see this file's own header). Normal
 * operation reaches a natural steady state well under this from decay alone
 * (`WATER_SIM_TAU_FOAM_SEC` bounds it long before emission could run away);
 * this exists only so a pathological input (an extreme author-authored
 * `flowSpeedPx`, say) cannot grow the stored value without bound across many
 * frames — RGBA16F itself would not overflow, but an unbounded "foam" value
 * is not a value a future consumer could safely assume is display-ready. */
export const WATER_SIM_STORAGE_CEIL = 3;

/** Gain on the shear emission term (`length` of the flow field's own local
 * gradient) — a heuristic strength, not a physical unit, tuned on the bench. */
export const WATER_SIM_SHEAR_GAIN = 3.0;

/** How fast `nearSolid` (the gate on `emitFront`) saturates to 1 as the flow
 * pack's own solidity gradient steepens. Large on purpose: solidity rises
 * from 0 to 1 over roughly one texel at a hard edge, so even a full step
 * produces a modest raw central-difference magnitude — this gain is what
 * turns "any real edge at all" into "fully gated open" rather than requiring
 * an unrealistically sharp transition to ever reach 1. */
export const WATER_SIM_NEAR_SOLID_GAIN = 8.0;

/** World-px cell size the noise gate's domain is scaled by — small relative
 * to a typical river so it reads as texture, not another large soft band. */
export const WATER_SIM_NOISE_CELL_PX = 40;

/** How fast the noise gate's own domain drifts through its third (time)
 * axis — slow enough to read as a shifting texture, not a flicker. */
export const WATER_SIM_NOISE_TIME_SCALE = 0.15;

/** Floor the noise gate is clamped to. Never exactly 0: a hard zero would let
 * pure noise coincidence silence emission completely on some texels every
 * frame, which reads as flicker (on/off) rather than texture (strong/weak). */
export const WATER_SIM_NOISE_FLOOR = 0.15;

/**
 * A single clamped-UV sample — the SAME "clamp then measure the clamp's own
 * delta" idea `water-flow.js#neighborForAxisGradient` documents is already
 * this codebase's proven-safe way to keep an off-grid tap from wrapping or
 * reading garbage, simplified here because nothing downstream needs the
 * distance-aware ghost-cell handling that function's own PRESSURE SOLVE
 * callers do — every use in this file is a read-only heuristic over an
 * already-finished field, not a boundary condition inside an iterative solve.
 * @param {object} TSL @param {*} tex @param {*} centerUv
 * @param {number} dx @param {number} dy @param {number} texelU @param {number} texelV
 * @returns {*} the raw `texture()` node — both the value to read channels off
 *   AND the thing to collect for re-pointing (the same node, one name).
 */
function clampedNeighborSample(TSL, tex, centerUv, dx, dy, texelU, texelV) {
  const { texture, vec2, clamp } = TSL;
  const rawUv = centerUv.add(vec2(dx * texelU, dy * texelV));
  const clampedUv = clamp(rawUv, vec2(0, 0), vec2(1, 1));
  return texture(tex, clampedUv);
}

/**
 * B — ONE SIM STEP: advect, decay, emit, clump. The whole per-frame pass in
 * one material — §3's own "one pass per frame" line, and the reason this is
 * a single function rather than the multi-material shape `water-flow.js`
 * needs for its own multi-level cascade (there is exactly one sim grid, and
 * exactly one thing happens to it each frame).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.flowTexture - `res:waterFlow`'s FINEST level pack (RG
 *   velocity normalised, B speed01, A solidity) — the SAME texture object
 *   `water-flow-subsystem.js`'s own `.texture` getter returns.
 * @param {*} args.bodyTexture - `res:waterBody`'s own pack, R = signed
 *   distance to shore in world px, negative inside water
 *   (`water-body.js`'s own header) — read here ONLY for R, at this
 *   fragment's own UV (both packs share the SAME world rect, the same fact
 *   `water-flow.js#buildWaterSoliditySeedMaterial`'s own header already
 *   verified for the mask image, so no rect transform is needed for a plain
 *   `uv()` sample here either — a genuinely different resolution than the
 *   sim grid is fine, `texture()` bilinear-samples across that mismatch for
 *   free, the same "prolongation" reasoning `water-flow.js#runLevel` already
 *   relies on for its own coarse-to-fine multigrid prolongation).
 * @param {*} args.simPrevTexture - THIS pass's own ping-pong SOURCE — the
 *   other target of the pair, from last frame's render.
 * @param {number} args.width @param {number} args.height - the sim grid's
 *   own texel dimensions (matches the flow pack's finest level exactly, the
 *   caller's own responsibility to keep true — see `water-sim-subsystem.js`).
 * @param {number} args.rectWidthPx @param {number} args.rectHeightPx - the
 *   world-space span this grid covers (`waterBody.getRect()`'s own width/
 *   height) — used only to turn a world-px/s velocity into a UV-space
 *   advection offset.
 * @param {*} args.uDtSec - a shared `uniform(float(...))`, THIS frame's own
 *   sim seconds (`core/frame-clock.js`'s own `dtSec`) — the caller writes
 *   `.value` every tick; never computed inside this material.
 * @param {*} args.uFlowSpeedPx - a shared `uniform(float(...))`, the SAME
 *   `water.js#flowSpeedPx` schema value already driving the surface's own
 *   bulk scroll — see this file's header for why the multiply happens here.
 * @param {*} args.uReachPx - a shared `uniform(float(...))`, the SAME
 *   "how wide is the foam band" concept `water-shore.js`'s own `uReachPx`
 *   already is — reused rather than re-invented so the swash emission term
 *   agrees with whatever band width the author already chose.
 * @param {*} args.uFoamAmount - a shared `uniform(float(...))`, the overall
 *   foam-strength gain — the SAME `water.js#foam` schema value already
 *   scales `uSwashFoam`/`uBreakFoam` (`water-render.js`), so the author's
 *   existing "Foam" slider keeps working rather than being silently
 *   orphaned by the new buffer.
 * @param {*|null} [args.timeMsNode] - the viewer's shared clock
 *   (`water-render.js`'s own convention) — `null` reads as a frozen clock
 *   (`float(0)`), matching every other optional-clock consumer in this
 *   family, never a crash.
 * @param {*|null} [args.uTauFoamSec] - a shared `uniform(float(...))` for
 *   `WATER_SIM_TAU_FOAM_SEC` (2026-08-19 ROH control) — `null` falls back to
 *   the constant, same null-safe pattern `water-field.js#buildWaterSurfaceField`
 *   already established. Read every frame, so a change reaches the sim the
 *   very next `tick()` — no rebuild required.
 * @param {*|null} [args.uDiffuse] - same pattern, `WATER_SIM_DIFFUSE`.
 * @param {*|null} [args.uShearGain] - same pattern, `WATER_SIM_SHEAR_GAIN`.
 * @param {*|null} [args.uNearSolidGain] - same pattern, `WATER_SIM_NEAR_SOLID_GAIN`.
 * @returns {{
 *   material: *, quad: *,
 *   flowTexNodes: Array<*>, bodyTexNode: *, simPrevTexNodes: Array<*>,
 * }} Every array MUST be re-pointed together on a regrid/rebuild — this
 *   file's own citation above, and `feedback_texture_nodes_must_be_
 *   repointed_together`'s now-three-times-bitten rule: a texture tap this
 *   function creates that the caller forgets to re-point keeps reading
 *   whatever it was first built against, forever, with no error.
 */
export function buildWaterSimStepMaterial({
  THREE,
  flowTexture,
  bodyTexture,
  simPrevTexture,
  width,
  height,
  rectWidthPx,
  rectHeightPx,
  uDtSec,
  uFlowSpeedPx,
  uReachPx,
  uFoamAmount,
  timeMsNode = null,
  uTauFoamSec = null,
  uDiffuse = null,
  uShearGain = null,
  uNearSolidGain = null,
}) {
  const TSL = THREE.TSL;
  const {
    texture,
    uv,
    vec2,
    vec3,
    vec4,
    float,
    mix,
    exp,
    dot,
    max,
    length,
    clamp,
    smoothstep,
    sin,
    mx_fractal_noise_vec3,
  } = TSL;

  const uv0 = uv();
  const texelU = 1 / Math.max(1, width);
  const texelV = 1 / Math.max(1, height);
  const tSec = (timeMsNode ?? float(0)).mul(float(1 / 1000));

  const tauFoamSecNode = uTauFoamSec ?? float(WATER_SIM_TAU_FOAM_SEC);
  const diffuseNode = uDiffuse ?? float(WATER_SIM_DIFFUSE);
  const shearGainNode = uShearGain ?? float(WATER_SIM_SHEAR_GAIN);
  const nearSolidGainNode = uNearSolidGain ?? float(WATER_SIM_NEAR_SOLID_GAIN);

  // ── THE SOLVED FIELD, HERE ────────────────────────────────────────────
  const flowHereNode = texture(flowTexture, uv0);
  const velNorm = flowHereNode.rg;
  const speed01 = flowHereNode.b;
  const solidityHere = flowHereNode.a;
  const velWorld = velNorm.mul(uFlowSpeedPx); // normalised → world px/s, see header
  const velLen = length(velWorld);
  // Safe direction: dividing by a CLAMPED-MINIMUM length instead of calling
  // `normalize()` directly, because zero velocity is not an edge case here —
  // `flowSpeedPx: 0` ("a still pond or lake") is an author-supported setting
  // (`water.js#flowSpeedPx`'s own help text), and `normalize(vec2(0,0))`
  // divides by a true zero. At near-zero speed this direction's exact value
  // is also visually immaterial: everything it feeds (`emitFront`) is itself
  // multiplied by `speed01`, which is ~0 in the same place.
  const velDir = velWorld.div(max(velLen, float(1e-4)));

  // ── 1. ADVECT — semi-Lagrangian: trace THIS texel's velocity backward one
  // frame and sample last frame's own buffer there, rather than forward-
  // scattering (which would need a whole different, atomic-write pass to
  // avoid two source texels racing to write the same destination). Clamped
  // to the grid, not wrapped — foam that would leave the water body's own
  // rect sticks at the edge texel rather than reappearing on the far side.
  const uvPerWorldPx = vec2(1 / Math.max(1, rectWidthPx), 1 / Math.max(1, rectHeightPx));
  const advectedUv = clamp(uv0.sub(velWorld.mul(uDtSec).mul(uvPerWorldPx)), vec2(0, 0), vec2(1, 1));

  const prevSharpNode = texture(simPrevTexture, advectedUv);
  const simPrevTexNodes = [prevSharpNode];
  let blurSum = prevSharpNode.r; // the centre tap, reused rather than re-sampled
  for (const [dx, dy] of [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ]) {
    const node = clampedNeighborSample(TSL, simPrevTexture, advectedUv, dx, dy, texelU, texelV);
    simPrevTexNodes.push(node);
    blurSum = blurSum.add(node.r);
  }
  const blurredR = blurSum.div(float(9));

  // ── 2. DECAY — applied AFTER diffusing toward the local blur (see header:
  // this reordering, not the pseudocode's literal one, is what a single pass
  // can actually compute).
  const diffusedR = mix(prevSharpNode.r, blurredR, diffuseNode);
  const decayedR = diffusedR.mul(exp(uDtSec.negate().div(tauFoamSecNode)));

  // ── 3. EMIT — three independent terms, summed, then gated once by the
  // author's own overall foam amount and by a noise field so identical
  // conditions elsewhere on the map do not emit identically.
  const nL = clampedNeighborSample(TSL, flowTexture, uv0, -1, 0, texelU, texelV);
  const nR = clampedNeighborSample(TSL, flowTexture, uv0, 1, 0, texelU, texelV);
  const nU = clampedNeighborSample(TSL, flowTexture, uv0, 0, -1, texelU, texelV);
  const nD = clampedNeighborSample(TSL, flowTexture, uv0, 0, 1, texelU, texelV);
  const flowTexNodes = [flowHereNode, nL, nR, nU, nD];

  // Points toward INCREASING solidity, i.e. toward whatever obstacle is
  // nearby — standard central-difference sign, unmodified. `emitFront`'s own
  // dot product is what turns that into "is the current heading INTO it".
  const solidGrad = vec2(nR.a.sub(nL.a), nD.a.sub(nU.a)).div(float(2));
  const nearSolid = clamp(length(solidGrad).mul(nearSolidGainNode), float(0), float(1));
  // Flow heading toward increasing solidity (aligned with the gradient) is a
  // texel about to hit a face; heading away (or parallel) contributes
  // nothing — the `max(..., 0)` one-sided gate.
  const emitFront = max(dot(velDir, solidGrad), float(0)).mul(speed01).mul(nearSolid);

  const velGradMag = length(nR.rg.sub(nL.rg))
    .add(length(nD.rg.sub(nU.rg)))
    .div(float(2));
  const emitShear = velGradMag.mul(shearGainNode);

  // `shoreDist`: body-pack R is negative INSIDE water (this file's own
  // header citation) — negate for "distance INTO water", clamp below zero
  // for any texel on the land side, matching `water-shore.js#d01`'s own "0
  // at the waterline" contract exactly, so the imported band constants mean
  // the same thing here that they do there.
  const bodyTexNode = texture(bodyTexture, uv0);
  const shoreDist = max(bodyTexNode.r.negate(), float(0));
  const reach = max(uReachPx, float(1));
  const d01 = clamp(shoreDist.div(reach), float(0), float(1));
  const phase = d01.sub(tSec.mul(float(WATER_SWASH_SPEED)));
  const wave = sin(phase.mul(float(WATER_SWASH_BANDS * 2 * Math.PI)));
  const band = smoothstep(float(1 - 2 * WATER_SWASH_WIDTH), float(1), wave);
  const emitSwash = band.mul(float(1).sub(d01)).mul(speed01);

  // A single low-frequency-ish noise sampled in WORLD space (not grid UV —
  // UV alone would put only a handful of cycles across an entire river) so
  // identical geometry at two different points on the same map does not
  // emit in lockstep. Not statistically uniform over its own range (this
  // codebase's own measured, documented fact about this exact noise call —
  // `water-shore.js`'s header), which does not matter here: this only needs
  // to VARY and stay mostly positive, not hit any particular distribution.
  const worldXY = vec2(uv0.x.mul(float(rectWidthPx)), uv0.y.mul(float(rectHeightPx)));
  const noiseUv = worldXY.div(float(WATER_SIM_NOISE_CELL_PX));
  const noiseRaw = mx_fractal_noise_vec3(
    vec3(noiseUv.x, noiseUv.y, tSec.mul(float(WATER_SIM_NOISE_TIME_SCALE))),
    2,
    2.0,
    0.5
  );
  const noiseGate = clamp(noiseRaw.x.mul(float(0.5)).add(float(0.5)), float(WATER_SIM_NOISE_FLOOR), float(1));

  const totalEmit = emitFront.add(emitShear).add(emitSwash).mul(uFoamAmount);
  const newR = decayedR.add(totalEmit.mul(uDtSec).mul(noiseGate));

  // ── 4. GATHER is already done (the diffuse-toward-blur blend above, §2).
  // BREAK — the clump threshold — is deliberately NOT applied here: see this
  // file's own header for the live-caught bug where thresholding the STORED
  // state stalls the accumulator at 0 forever. What's stored is the raw
  // accumulator, solidity-gated and defensively bounded; a display-time
  // CONSUMER applies `WATER_SIM_CLUMP_LO`/`HI` itself, once, at read time.
  //
  // The solidity gate is unconditional, not a soft fade: never let a solid
  // texel hold foam, regardless of how it got there (advected in, or a
  // stray gradient tap reaching across a boundary) — any leftover value
  // here would itself blur into real water on the NEXT frame's own
  // diffusion step.
  const storedR = clamp(newR, float(0), float(WATER_SIM_STORAGE_CEIL)).mul(float(1).sub(solidityHere));

  const material = new THREE.NodeMaterial();
  // G/B/A: reserved for S7 (sediment) / S8 (turbulence) / spare — carried
  // straight through, unmodified, from this frame's own sharp advected
  // sample, so they are at least spatially coherent with the buffer they
  // will eventually be designed alongside, rather than an arbitrary
  // placeholder value. Neither decayed nor emitted into: inventing decay/
  // emission semantics for a channel nothing reads yet is exactly the
  // speculative design this codebase avoids doing ahead of need.
  material.fragmentNode = vec4(storedR, prevSharpNode.g, prevSharpNode.b, prevSharpNode.a);
  const quad = new THREE.QuadMesh(material);

  return { material, quad, flowTexNodes, bodyTexNode, simPrevTexNodes };
}
