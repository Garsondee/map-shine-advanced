/**
 * THE BODY PACK — `res:waterBody`, water's geometric description of itself
 * (`docs/planning/Water.md` §5.1), as three TSL fragment passes.
 *
 * Baked ON MASK VERSION CHANGE, never per frame. What comes out is one
 * RGBA16F world-aligned target:
 *
 *   R  signed distance to shore, WORLD PX, negative inside water
 *   G  depth01, straight from the mask's own R channel
 *   BA the unit SHORE TANGENT — the direction the bank runs at this texel
 *
 * ============================================================================
 * WHY A DISTANCE FIELD AND NOT V2's BLURRED GRADIENT
 * ============================================================================
 * V2 had a bake-time `shoreWidthPx`: the shore band's width was decided before
 * anyone saw it, and changing it meant re-deriving the mask. A true SDF stores
 * DISTANCE, so every consumer picks its own width at read time for free — and
 * because the field is SIGNED, the wet band of ground OUTSIDE the water (which
 * V2 never had at all) is the same fetch with the sign flipped. One field
 * replaces V2's shore band, depth ramp, foam placement, and wet-ground band.
 *
 * ============================================================================
 * WHY JUMP FLOOD, AND WHY IT IS CHEAP HERE
 * ============================================================================
 * Jump flooding (Rong & Tan) computes a Voronoi/distance field in
 * O(log n) fullscreen passes instead of a search: seed the texels that sit on
 * the water/land boundary, then for log2(dim) rounds each texel asks the eight
 * neighbours at a HALVING stride "do you know a closer seed than mine?". Ten
 * passes over a ≤512px grid, once per mask change. It is not on the frame
 * budget at all.
 *
 * THE SIGN IS NOT COMPUTED BY THE FLOOD. A textbook signed JFA runs the flood
 * twice (inside-seeded and outside-seeded) and subtracts. That is pointless
 * here: the mask already says which side of the boundary a texel is on, so ONE
 * unsigned flood plus a free lookup gives the same answer for half the work.
 *
 * ============================================================================
 * THE GRADIENT IS ANALYTIC — NO FINITE DIFFERENCES ANYWHERE
 * ============================================================================
 * The shore tangent needs ∇SDF. Sampling the SDF four times and differencing
 * would be the obvious route and it is strictly worse: four dependent fetches,
 * quantisation noise on a half-float field, and a wrong answer exactly at the
 * medial axis where the field creases. The flood already stores the offset to
 * the nearest shore point, and the gradient of "distance to that point" IS
 * that offset, normalised. Exact, one fetch, no derivatives — which also keeps
 * water clear of the `dFdx`/`dFdy`-in-divergent-flow undefined behaviour V2's
 * caustics were built on (Water.md §2.9, §3).
 *
 * ============================================================================
 * WHAT THIS PASS DELIBERATELY DOES **NOT** BAKE: THE CURRENT
 * ============================================================================
 * Water.md §5.1 described BA as "SDF gradient rotated to the channel tangent +
 * authored flow + a global current param". Building it exposed that as two
 * different lifetimes glued together, and only one of them belongs in a bake:
 *
 *   the TANGENT is geometry  — it changes when the author repaints the mask
 *   the CURRENT is a param   — it changes when a slider moves
 *
 * Baking the current in would mean re-running the whole flood on every drag of
 * a speed slider, which is the "bake count tracks frame count" failure this
 * phase's own exit criterion exists to catch. So BA stores the bare geometric
 * tangent, and a consumer applies the current at read time for the price of
 * one dot product:
 *
 *   bankInfluence = 1 − smoothstep(0, bankReachPx, abs(sdf))
 *   alongBank     = tangent * dot(current, tangent)
 *   flow          = mix(current, alongBank, bankInfluence)
 *
 * That projection — rather than a rotation or a `sign()` — is chosen because
 * it is CONTINUOUS ACROSS THE MEDIAL AXIS. The stored tangent necessarily
 * flips sign down the centreline of a river (the nearest bank switches sides),
 * and `t * dot(c, t)` is invariant under `t → −t`, so the flip cancels
 * exactly and both halves of the river flow the same way. Anything built on
 * `sign(dot(...))` would put a seam down the middle of every river. **The sign
 * flip in BA is correct — do not "fix" it.**
 *
 * The behaviour that falls out is the headline win over V2, whose ONE global
 * advection vector is why its rivers read as ponds with a drift: near a bank
 * the current is projected along the bank (water follows the channel and
 * cannot flow into land); far from any bank it passes through unchanged; and
 * where a shore faces straight into the current the projection goes to zero,
 * which is what water actually does when it meets a wall.
 *
 * NO RenderTarget, Texture, or renderer-state call lives here — those are
 * walled to `graph/`/`vt/` (`gpu/allocator-only`, `gpu/textures-in-vt-only`,
 * `renderer-state/graph-only`). This module only BUILDS NodeMaterial + QuadMesh
 * objects and hands back the mutable texture/uniform nodes the caller drives,
 * exactly like `world/wind-sim-gpu.js` and `effects/lighting/sun-shadow.js`.
 * THREE is INJECTED, never imported (the bloom split's rule).
 *
 * @module effects/water/water-body
 */

/**
 * Mask R above this counts as water. The mask carries DEPTH in R and depth
 * doubles as presence (see `water`'s own `meaning` in scene/mask-catalog.js),
 * so the test is "any depth at all" — half a byte, not a mid-grey threshold. A
 * shore painted at 4/255 is genuinely shallow water and must not read as land.
 *
 * ⚠️ Because the mask is now sampled LINEAR at a resolution ABOVE its own
 * (`WATER_BODY_SUPERSAMPLE`), a texel adjacent to the true painted edge reads
 * a small nonzero BLEND, not a clean 0 — and this near-zero epsilon crosses
 * that blend almost as soon as it is nonzero, close to the LAND side of the
 * source texel rather than at its geometric midpoint. Named, not fixed: the
 * bias is bounded by one SOURCE mask texel (get finer with a wider
 * `WATER_BODY_SUPERSAMPLE`, never by moving this constant), tier 0 does not
 * promise sub-texel shore placement, and a binarised-presence-channel fix (see
 * `WATER_BODY_SUPERSAMPLE`'s own doc) is a recorded, not urgent, deferred rung.
 */
export const WATER_PRESENCE_EPS = 1 / 510;

/**
 * How many FLOOD texels the seed/JFA/resolve passes run per MASK texel, in
 * each dimension.
 *
 * **BACK TO 1 (2026-07-26), and the round trip is the lesson.** This was
 * briefly 3, as an attempt to fix a blocky shoreline by flooding the coarse
 * derivation grid more densely. It did not work, and could not have: the grid
 * is POINT-sampled, so there is no sub-texel coverage between its texels to
 * find, however finely you sample it.
 *
 * The real fix was to stop asking the SDF for the shoreline at all — tier 0's
 * edge now comes from the mask file at its authored resolution
 * (`vt/mask-image.js`), and the SDF keeps only the DISTANCE-derived work it
 * was always good at: the depth ramp (tier 1), foam band width and shoaling
 * (tiers 2/4), the flow tangent. Every one of those is inherently
 * low-frequency, so the mask grid's own resolution is genuinely sufficient and
 * the supersample buys nothing but VRAM (3× is 9× the texels — ~25 MB against
 * ~3 MB) and bake time.
 *
 * Kept as a named constant rather than deleted: if a future rung ever wants a
 * finer distance field, this is the one number, and its own history is the
 * warning that a finer field will NOT sharpen an edge.
 *
 * ⚠️ SUPERSEDED AS THE GRID-SIZING MECHANISM (2026-08-19) — `WATER_BODY_
 * GRID_MAX_DIM` below now sizes the flood directly from the water body's own
 * WORLD RECT, the same way `water-flow.js#WATER_FLOW_GRID_MAX_DIM` already
 * does, rather than as a multiplier on the coarse cross-effect derivation
 * grid (`scene/mask-derive.js#MASK_GRID_MAX_DIM`, 512, shared with fire/
 * specular/wind). This constant stays frozen at 1 and this doc's own history
 * stays true to what it tested — but read its "the mask grid's own
 * resolution is genuinely sufficient" line narrowly: that conclusion was
 * measured by supersampling an already-coarse, then-POINT-sampled derived
 * grid more densely, which cannot manufacture data that was never captured.
 * It predates two later fixes that changed what the flood's SEED actually
 * sees — the seed pass's own 4×4 area-averaged read of the FULL-RESOLUTION
 * mask (2026-08-18, this file's `buildWaterSeedMaterial`) and now a genuinely
 * finer OUTPUT grid (2026-08-19) — neither of which this constant's own
 * experiment exercised. A small obstacle's boundary can now be correctly
 * DETECTED at 512 texels; it still only gets ONE seed position to represent
 * it in the tangent field at that resolution, however accurately that one
 * position was measured — which is the real, distinct reason the tangent
 * (bank-bend/flow-bend direction near small or closely-packed obstacles,
 * live-reported as flow not visibly routing around a splitter) benefits from
 * more OUTPUT texels, independent of whether the crease-interpolation
 * problem `water-sampling.js` already fixed is present.
 */
export const WATER_BODY_SUPERSAMPLE = 1;

/**
 * The flood's own long-side resolution cap, WATER-OWNED — sized from the
 * water body's own world rect (`water-body-subsystem.js#sizeBodyGrid`), the
 * exact technique `water-flow.js#WATER_FLOW_GRID_MAX_DIM`/`sizeFlowGrid`
 * already uses, and for the same reason: the shared cross-effect derivation
 * grid (`scene/mask-derive.js#MASK_GRID_MAX_DIM`, 512) is sized for every
 * mask consumer at once (fire, specular, wind, water's own coarse AABB scan),
 * never for water's own tangent-field needs specifically. 1,536 matches the
 * flow pack's own cap exactly (2026-08-19, `docs/planning/Water-Simulation-
 * Turn.md`'s own note on the two grids drifting apart) and sits comfortably
 * under the Keyhole allocator's 2,048px cap with no exception needed — the
 * same headroom `WATER_FLOW_GRID_MAX_DIM`'s own doc already spends.
 */
export const WATER_BODY_GRID_MAX_DIM = 1536;

/**
 * The mask texture's filter, stated here because the seed pass's correctness
 * depends on it and the caller is what actually uploads the texture.
 *
 * ⚠️ LINEAR — CHANGED 2026-07-26, and the reasoning this replaces is worth
 * keeping precisely because it was wrong in a specific, instructive way. The
 * original argument for NEAREST was real: sampled AT THE MASK's OWN
 * resolution, LINEAR would smear the interface into a one-texel ramp with an
 * arbitrary threshold. That argument assumed the flood runs 1:1 with the mask
 * — which Phase 2 chose ("the pack is the size of its input") and which
 * turned out to look like a low-resolution mask baked in, because that is
 * exactly what it was: a jump flood is provably EXACT at whatever resolution
 * it runs at (Node-tested against brute force), but its SEEDS only exist at
 * texel centres, so a shoreline crossing the grid at an angle gets a
 * staircase of seed positions — no downstream filtering of the RESULT fixes
 * data that was never captured. Live-reported 2026-07-26: "an extremely
 * pixelated mask which has been blurred... the shoreline looks like a square
 * wave in places" — textbook coarse-seed staircase, and correctly not fixed
 * by the earlier NEAREST→LINEAR fix on the RESOLVED pack alone.
 *
 * The actual fix is `WATER_BODY_SUPERSAMPLE`: run the flood at a resolution
 * ABOVE the mask's own, so LINEAR sampling of the (still coarse) mask
 * reconstructs a continuous water-fraction estimate at each of the FLOOD's
 * finer texels, and the seed test operates on that finer, smoother signal —
 * the same technique real-time SDF-from-low-res-coverage-mask generation
 * always uses (the coarse source is genuinely all the information there is;
 * supersampling with linear reconstruction is how you get the best available
 * estimate of what happens BETWEEN its texels, not an invention of new data).
 *
 * Named, not solved: the presence test (`WATER_PRESENCE_EPS`, a near-zero
 * threshold against a value that ramps from the painted depth down to 0) puts
 * the reconstructed interface slightly toward the LAND side of the source
 * texel rather than exactly at its midpoint — a binarised presence channel
 * (threshold the SOURCE at 0/255 before upload, so the ramp is symmetric and a
 * 0.5 threshold is unbiased) would remove this, and is a clean, contained,
 * deferred improvement, not required for tier 0.
 */
export const WATER_MASK_FILTER = 'linear';

/** Sentinel distance (texel units) for "this texel knows no seed". Larger than
 * any real offset on a grid this size, and far under half-float's ~65504 max
 * so no arithmetic below can reach infinity. */
const NO_SEED_DIST = 8192;

/** Guards the normalise at a seed texel, where the offset is exactly (0,0). */
const NORMALIZE_EPS = 1e-6;

/**
 * How many jump-flood rounds a grid of this size needs: strides
 * dim/2, dim/4, … 1, so ceil(log2(longest side)). Exported because the
 * subsystem drives the loop and the debug report states the count.
 * @param {number} width @param {number} height @returns {number}
 */
export function jfaStepCount(width, height) {
  const longest = Math.max(1, Math.max(width | 0, height | 0));
  return Math.max(1, Math.ceil(Math.log2(longest)));
}

/**
 * The stride, in texels, for round `i` (0-based) of a `jfaStepCount(...)`-long
 * ladder: the classic halving sequence, largest first.
 * @param {number} i @param {number} steps @returns {number}
 */
export function jfaStrideForStep(i, steps) {
  return Math.pow(2, Math.max(0, steps - 1 - i));
}

/**
 * PASS 1 — SEED. Marks every texel that straddles the water/land interface.
 *
 * BOTH SIDES are seeded (a water texel next to land AND the land texel next to
 * it), which is what makes the resulting field's zero-crossing land ON the
 * interface rather than half a texel inside one side of it.
 *
 * Output, and the encoding the whole flood carries:
 *   RG  offset from THIS texel to its nearest known seed, in TEXEL units
 *   B   1 if this texel knows a seed at all, else 0
 *   A   0 — reserved. Deliberately not filled with something speculative
 *       (the seed's own depth was the candidate); nothing reads it yet, and a
 *       channel written "in case" is how V2 ended up with 46 inert uniforms.
 *
 * Offsets rather than absolute positions, because half-float precision follows
 * magnitude: an offset near the shore — where the field's accuracy actually
 * matters — is small and therefore precise, while an absolute coordinate would
 * spend its precision on the distance from the map's corner.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.maskTexture - the floor's water mask, R = depth (LINEAR —
 *   see `WATER_MASK_FILTER`). Its OWN resolution is the mask grid's; sampled
 *   here via UV, so it is resolution-independent of `width`/`height` below.
 * @param {number} args.width @param {number} args.height - the FLOOD's own
 *   grid, texels — `WATER_BODY_SUPERSAMPLE ×` `maskTexture`'s native size.
 * @returns {{material:*, quad:*, maskTexNode:*, setPresenceThreshold:(v:number)=>void}}
 *   `maskTexNode.value` is re-pointed when the mask rebakes; the material is
 *   NOT rebuilt. `setPresenceThreshold` re-points the LIVE uniform behind the
 *   boundary test below — see its own call site (`water-body-subsystem.js`)
 *   for why this needs a REBAKE (a JFA flood, not a per-frame poke) to take
 *   effect, unlike every other live water uniform.
 */
export function buildWaterSeedMaterial({ THREE, maskTexture, width, height }) {
  const { texture, uv, vec2, vec4, float, uniform, step, abs, max, clamp } = THREE.TSL;

  const texelX = 1 / Math.max(1, width);
  const texelY = 1 / Math.max(1, height);

  // ⚠️ A LIVE UNIFORM, NOT A BAKED-IN CONSTANT (2026-08-23) — see
  // `WATER_PRESENCE_SOFT_MASK_FLOOR`'s own doc for why this exists and why
  // its DEFAULT still equals `WATER_PRESENCE_EPS` exactly (byte-identical
  // behaviour for a floor that never touches `shorelineDepth`'s upper range).
  const uPresenceThreshold = uniform(float(WATER_PRESENCE_EPS));

  const uv0 = uv();
  const maskTexNode = texture(maskTexture, uv0);
  // Kept as a single point-sample — this is what every OTHER consumer of
  // `maskTexNode` (tier 0's own depth/edge read, elsewhere in the pipeline)
  // already expects a plain texture node to mean. Only the BOUNDARY DECISION
  // below needs area-averaging; the returned node's contract is unchanged.
  const isWaterHere = step(uPresenceThreshold, maskTexNode.r);

  /** ⚠️ EVERY `texture(maskTexture, …)` node this function creates, `maskTexNode`
   * itself first (`feedback_texture_nodes_must_be_repointed_together`) — the
   * exact bug this same session already found and fixed twice elsewhere in
   * this file's own neighbourhood, reproduced a third time by this function's
   * own first draft: `water-body-subsystem.js` re-pointed only `maskTexNode`
   * on a real mask load, so the sub-sample nodes below sampled the 1×1
   * all-land placeholder FOREVER — which, worked through, seeds every single
   * water texel as a false boundary (placeholder reads land at every
   * sub-sample, so `hereFraction` is stuck at 0, and `selfStraddle` fires
   * wherever the REAL point-sample reads water). Caught by the author asking
   * for exactly this file's own re-pointing contract check, not by the
   * synthetic GPU test that first proved the area-averaging logic itself
   * correct — that test built the material with the real texture from
   * construction and never exercised the placeholder-then-swap path at all. */
  const maskTexNodes = [maskTexNode];

  /**
   * ⚠️ AREA-AVERAGED PRESENCE FOR THE BOUNDARY TEST (2026-08-18) — the actual
   * fix for a "big" rock producing NO shore response at all, live-reported
   * AFTER `water-flow.js`'s S2 solidity (area-averaged, 16 sub-samples) had
   * already shipped and was assumed to have covered this class of bug.
   * It had not: `water-flow.js`'s own header names the exact failure mode —
   * "a POINT sample at a texel centre either lands on a small feature or it
   * doesn't, at ANY resolution" — and applied the fix to the FLOW field's
   * solidity only. This SEED pass, which is what `shoreDist`/tangent (and
   * therefore every `shore.foam` term's PRESENCE, not just its direction)
   * actually depends on, was left running the original point-sample test.
   * A rock smaller than roughly one derivation-grid texel (`getWaterMaskGrid`,
   * capped well below the mask's own native resolution) could sit entirely
   * between four texel centres and never register a transition at all — not
   * "faint", not "underrepresented", genuinely invisible to the flood, no
   * matter how large the rock reads in world px.
   *
   * The fix mirrors `water-flow.js#buildWaterSoliditySeedMaterial` exactly: a
   * 4×4 sub-grid across THIS texel's own footprint (matching
   * `WATER_FLOW_SOLIDITY_SUBSAMPLES`'s value, not its symbol — importing it
   * here would reach back into `water-flow.js`, which itself imports FROM
   * this file, `feedback_...` circular-import shape), averaged into a
   * continuous presence FRACTION rather than a single hard sample. A rock
   * covering any part of a texel's footprint moves that fraction off 0/1,
   * which is then thresholded down to a clean seed/no-seed decision
   * (`WATER_SEED_BOUNDARY_EPS`) — so the material's own OUTPUT CONTRACT is
   * unchanged (B is still exactly 0 or 1, never a partial "weak seed" that
   * `buildWaterJfaStepMaterial`'s `mix(..., candValid)` chain would otherwise
   * discount against a stronger, more distant seed); only the INPUT the
   * decision is based on got more honest.
   */
  const SEED_SUBSAMPLES = 4;
  const seedFraction = (centerUv) => {
    let sum = float(0);
    for (let sy = 0; sy < SEED_SUBSAMPLES; sy++) {
      for (let sx = 0; sx < SEED_SUBSAMPLES; sx++) {
        const offsetU = ((sx + 0.5) / SEED_SUBSAMPLES - 0.5) * texelX;
        const offsetV = ((sy + 0.5) / SEED_SUBSAMPLES - 0.5) * texelY;
        const sampleUv = clamp(centerUv.add(vec2(offsetU, offsetV)), vec2(0, 0), vec2(1, 1));
        // ⚠️ PUSHED to `maskTexNodes` before anything else touches it — see
        // that array's own comment, just above. A sub-sample tap added here
        // without this line is the exact regression this comment prevents.
        const tapTexNode = texture(maskTexture, sampleUv);
        maskTexNodes.push(tapTexNode);
        sum = sum.add(step(uPresenceThreshold, tapTexNode.r));
      }
    }
    return sum.div(float(SEED_SUBSAMPLES * SEED_SUBSAMPLES));
  };

  /** Presence-fraction difference a boundary must clear to seed — far below
   * "half the texel", since even a sliver of a small rock overlapping one
   * sub-sample corner is exactly the case this fix exists for. */
  const WATER_SEED_BOUNDARY_EPS = 1 / (SEED_SUBSAMPLES * SEED_SUBSAMPLES * 4);

  const hereFraction = seedFraction(uv0);

  // Four-neighbour interface test. `clamp` pins the sample inside the grid, so
  // a texel on the map edge compares against ITSELF there — i.e. the map
  // border is never itself an interface. That is the honest reading: the map
  // ending is not a shoreline, and seeding it would put a phantom bank (and,
  // at tier 2+, phantom foam) along all four edges of every scene.
  const NEIGHBORS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  let maxDelta = float(0);
  for (const [dx, dy] of NEIGHBORS) {
    const nUv = clamp(uv0.add(vec2(dx * texelX, dy * texelY)), vec2(0, 0), vec2(1, 1));
    const neighborFraction = seedFraction(nUv);
    maxDelta = max(maxDelta, abs(hereFraction.sub(neighborFraction)));
  }
  // Also seed a texel whose OWN footprint straddles the interface even if
  // every neighbour's own averaged fraction looks similar — e.g. a rock
  // small enough to sit fully inside one texel without ever reaching a
  // neighbour's footprint at all. `isWaterHere` is the original point-sample
  // (0 or 1); a fraction that disagrees with it means the texel's interior is
  // mixed.
  const selfStraddle = abs(hereFraction.sub(isWaterHere));
  const boundary = step(float(WATER_SEED_BOUNDARY_EPS), max(maxDelta, selfStraddle));

  const material = new THREE.NodeMaterial();
  // A seed's offset to itself is (0,0) — that is the whole seed condition, and
  // it is why the flood needs no separate "am I a seed" channel.
  material.fragmentNode = vec4(0, 0, boundary, 0);
  const quad = new THREE.QuadMesh(material);
  // `maskTexNode` kept alongside `maskTexNodes` for callers that only ever
  // wanted the single point-sample (none currently do, post-fix, but the
  // shape stays backward-compatible rather than a silent breaking change).
  return {
    material,
    quad,
    maskTexNode,
    maskTexNodes,
    setPresenceThreshold(v) {
      uPresenceThreshold.value = Number.isFinite(v) ? v : WATER_PRESENCE_EPS;
    },
  };
}

/**
 * PASS 2 — ONE JUMP-FLOOD ROUND, run `jfaStepCount()` times with a halving
 * `uStride`. One material, N renders, ping-ponged between two targets: a
 * fragment shader cannot read what it is writing, which is the same constraint
 * `world/wind-sim-gpu.js`'s relax pass documents at length.
 *
 * The stride is a UNIFORM and that is not a `tsl/no-uniform-gates` violation:
 * it does not switch a feature on or off, it is a genuine per-invocation
 * parameter of an algorithm that runs identically every round — the same shape
 * as the wind sim's own `uDtSec`.
 *
 * THE RE-BASING STEP is the one line worth reading twice. A neighbour's stored
 * offset is relative to THAT neighbour, so adopting it means adding the step
 * that got us there: `candidate = neighbourOffset + strideVector`. Getting
 * this wrong produces a field that looks plausible and is wrong by exactly one
 * stride — which is why the Node suite pins the arithmetic separately
 * ({@link rebaseNeighborOffset}).
 *
 * ⚠️ AND THAT IS WHY AN OUT-OF-BOUNDS NEIGHBOUR IS TREATED AS INVALID RATHER
 * THAN CLAMPED. The first draft clamped the sample UV — the reflex everywhere
 * else in this codebase, and correct everywhere else — which quietly broke the
 * re-basing invariant: a clamped neighbour is NOT `strideVector` away, so
 * adding `strideVector` to its offset fabricates a seed at a position where
 * none exists. The field stayed smooth and plausible and was wrong by up to
 * 2√2 texels, and it UNDERSTATED distance near the map border, so the shore
 * band would have crept inward along all four edges of every scene with no
 * symptom anyone could name. The Node suite's brute-force comparison is what
 * caught it (`water-body.test.mjs`); with this fix the flood is EXACT on every
 * fixture there, including the two-disjoint-blobs shape that is jump flood's
 * classic approximation case.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.prevTexture - the ping-pong source for this round.
 * @param {number} args.width @param {number} args.height
 * @returns {{material:*, quad:*, prevTexNodes:Array<*>, uStride:*}}
 *   EVERY node in `prevTexNodes` must be re-pointed together before each
 *   render — there is no confirmed `.uv()` chain method on a TextureNode in
 *   this vendored build, so each distinct UV is its own `texture()` call
 *   (wind-sim-gpu.js's header has the full citation).
 */
export function buildWaterJfaStepMaterial({ THREE, prevTexture, width, height }) {
  const { texture, uv, vec2, vec4, float, uniform, length, clamp, mix, step } = THREE.TSL;

  const texelX = 1 / Math.max(1, width);
  const texelY = 1 / Math.max(1, height);

  const uv0 = uv();
  const uStride = uniform(float(1));

  const selfNode = texture(prevTexture, uv0);
  const prevTexNodes = [selfNode];

  let bestOffset = selfNode.xy;
  let bestValid = selfNode.z;
  // An unseeded texel starts infinitely far away, so ANY real candidate wins.
  let bestDist = mix(float(NO_SEED_DIST), length(selfNode.xy), selfNode.z);

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue; // that is `selfNode`, already the incumbent
      const strideVec = vec2(float(dx).mul(uStride), float(dy).mul(uStride));
      const nUvRaw = uv0.add(vec2(strideVec.x.mul(float(texelX)), strideVec.y.mul(float(texelY))));
      const nUv = clamp(nUvRaw, vec2(0, 0), vec2(1, 1));
      const nNode = texture(prevTexture, nUv);
      prevTexNodes.push(nNode);

      // "Was that sample clamped at all?" as a crisp 0/1 with no comparison
      // operators — the same construction `world/wind-sim-gpu.js`'s relax pass
      // uses (see its own comment for why length-of-the-clamp-delta scaled hard
      // and clamped is the branch-free form). An out-of-bounds neighbour must
      // be INVALID, not clamped: see this function's own header for the bug
      // that costs.
      const outOfBounds = clamp(length(nUvRaw.sub(nUv)).mul(float(1e6)), float(0), float(1));
      const candValid = nNode.z.mul(float(1).sub(outOfBounds));

      const candOffset = nNode.xy.add(strideVec);
      const candDist = mix(float(NO_SEED_DIST), length(candOffset), candValid);
      // 1 when the candidate is closer-or-equal. Ties adopt the candidate,
      // which is harmless — equidistant seeds give the same distance, and the
      // tangent's own sign is already understood to flip at the medial axis
      // (see this module's header).
      const take = step(candDist, bestDist);

      bestOffset = mix(bestOffset, candOffset, take);
      bestValid = mix(bestValid, candValid, take);
      bestDist = mix(bestDist, candDist, take);
    }
  }

  const material = new THREE.NodeMaterial();
  material.fragmentNode = vec4(bestOffset, bestValid, 0);
  const quad = new THREE.QuadMesh(material);
  return { material, quad, prevTexNodes, uStride };
}

/**
 * PASS 3 — RESOLVE. Turns the flood's offset field into the body pack every
 * consumer actually samples.
 *
 *   R  signed distance to shore, WORLD PX, negative inside water
 *   G  depth01 from the mask
 *   BA the unit shore tangent (see the header for its sign ambiguity, which is
 *      load-bearing rather than a defect)
 *
 * A floor whose mask is entirely land — or entirely water — has NO interface
 * and therefore no seeds anywhere. That is not an error: it stores
 * `±uFarDistance` with the correct sign, so "the nearest shore is further away
 * than this map is wide" reads exactly like what it is, and every distance
 * consumer degrades continuously instead of hitting a special case.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.jfaTexture - the final ping-pong result.
 * @param {*} args.maskTexture - the same mask the seed pass read.
 * @param {number} args.texelWorldW @param {number} args.texelWorldH - world px
 *   per texel. A vec2 rather than a scalar because `computeMaskGridSpec`
 *   ROUNDS both grid dimensions, so the two differ by a fraction of a percent
 *   and there is no reason to inherit that as a distance error.
 * @param {number} args.farDistancePx - what "no shore anywhere" reports.
 * @returns {{material:*, quad:*, jfaTexNode:*, maskTexNode:*, setTexelWorld:(w:number,h:number)=>void,
 *   setFarDistance:(px:number)=>void}}
 */
export function buildWaterBodyResolveMaterial({
  THREE,
  jfaTexture,
  maskTexture,
  texelWorldW,
  texelWorldH,
  farDistancePx,
}) {
  const { texture, uv, vec2, vec4, float, uniform, length, max, mix, step } = THREE.TSL;

  const uv0 = uv();
  const jfaTexNode = texture(jfaTexture, uv0);
  const maskTexNode = texture(maskTexture, uv0);

  const uTexelWorld = uniform(vec2(texelWorldW, texelWorldH));
  const uFarDistance = uniform(float(farDistancePx));
  // ⚠️ MUST TRACK THE SEED PASS'S OWN THRESHOLD (2026-08-23) — see
  // `buildWaterSeedMaterial`'s own `setPresenceThreshold` doc. A mismatch
  // between the two would seed the flood's zero-distance boundary at one
  // mask value while flipping this SIGN test at another, which desyncs
  // `shoreDist01` from the interface it is supposed to be measured against —
  // the caller is responsible for calling both setters with the same value,
  // every bake (`water-body-subsystem.js#uploadMask` does).
  const uPresenceThreshold = uniform(float(WATER_PRESENCE_EPS));

  const depth01 = maskTexNode.r;
  const isWater = step(uPresenceThreshold, depth01);
  // +1 outside water, −1 inside. Negative-inside is the SDF convention every
  // consumer below assumes, and it is what makes the wet band OUTSIDE the
  // shoreline free: the same field, positive side.
  const insideSign = float(1).sub(isWater.mul(float(2)));

  // Offset (texels) → offset (world px). The flood stored `seed − here`.
  const offsetWorld = jfaTexNode.xy.mul(uTexelWorld);
  const distWorld = length(offsetWorld);
  const seedValid = jfaTexNode.z;
  const signedDistance = mix(uFarDistance, distWorld, seedValid).mul(insideSign);

  // THE ANALYTIC GRADIENT. `−offsetWorld` points from the nearest shore point
  // toward this texel: the direction of increasing distance, i.e. ∇|SDF|. No
  // finite differences, no dependent fetches, exact at every texel including
  // the ones a difference stencil would get wrong.
  const outward = offsetWorld.negate().div(max(distWorld, float(NORMALIZE_EPS)));
  // Rotate 90°: the bank's own direction. Zeroed where no seed was ever found,
  // so an all-land floor stores an honest (0,0) rather than a normalised
  // rounding artefact.
  const tangent = vec2(outward.y.negate(), outward.x).mul(seedValid);

  const material = new THREE.NodeMaterial();
  material.fragmentNode = vec4(signedDistance, depth01, tangent.x, tangent.y);
  const quad = new THREE.QuadMesh(material);
  return {
    material,
    quad,
    jfaTexNode,
    maskTexNode,
    setTexelWorld(w, h) {
      uTexelWorld.value.set(w, h);
    },
    setFarDistance(px) {
      uFarDistance.value = px;
    },
    setPresenceThreshold(v) {
      uPresenceThreshold.value = Number.isFinite(v) ? v : WATER_PRESENCE_EPS;
    },
  };
}

/**
 * The flood's re-basing arithmetic, as plain JS, so the Node suite can pin it
 * without a GPU (CONVENTIONS §4: TSL is not Node-testable, but the ARITHMETIC
 * inside it is, once it is written down once).
 *
 * This is the step that is wrong-by-exactly-one-stride if you forget it, which
 * produces a field that still looks like a distance field. Keeping it here
 * means the shader and the test read the same formula.
 *
 * @param {{x:number, y:number}} neighborOffset - what the neighbour stored.
 * @param {number} dx @param {number} dy - the neighbour's direction, −1..1.
 * @param {number} stride - texels.
 * @returns {{x:number, y:number}} the same seed, relative to THIS texel.
 */
export function rebaseNeighborOffset(neighborOffset, dx, dy, stride) {
  return {
    x: neighborOffset.x + dx * stride,
    y: neighborOffset.y + dy * stride,
  };
}

/**
 * The consumer-side half of the flow model, as plain JS — the formula a tier-2
 * shader will evaluate per texel, written down once so it can be Node-tested
 * and so the shader that eventually implements it has something to be checked
 * against (V2's twelve recorded GLSL desyncs came from exactly this contract
 * being a comment instead of a function).
 *
 * @param {{x:number, y:number}} current - the global current, world px/sec.
 * @param {{x:number, y:number}} tangent - the body pack's BA, unit or zero.
 * @param {number} signedDistancePx - the body pack's R.
 * @param {number} bankReachPx - how far a bank's influence extends.
 * @returns {{x:number, y:number}} flow, world px/sec.
 */
export function flowFromTangent(current, tangent, signedDistancePx, bankReachPx) {
  const reach = Math.max(1e-6, bankReachPx);
  const t = Math.min(1, Math.abs(signedDistancePx) / reach);
  // smoothstep(0,1,t), then inverted: 1 at the bank, 0 beyond its reach.
  const bankInfluence = 1 - t * t * (3 - 2 * t);
  const along = current.x * tangent.x + current.y * tangent.y;
  // `tangent * dot(current, tangent)` — invariant under tangent → −tangent,
  // which is what keeps a river's two halves flowing the same way across the
  // medial axis (see this module's header).
  const alongX = tangent.x * along;
  const alongY = tangent.y * along;
  return {
    x: current.x + (alongX - current.x) * bankInfluence,
    y: current.y + (alongY - current.y) * bankInfluence,
  };
}
