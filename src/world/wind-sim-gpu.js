/**
 * THE GPU PORT — Wind.md Tier 2's transient sim, the TSL half. Every material
 * here is a direct, stage-for-stage translation of `world/wind-sim.js`'s
 * Node-verified reference (`advectWindField`/`splatWindField`/
 * `relaxWindField`/`dissipateWindField` — read THAT file's header first; it
 * explains why a CPU reference exists and what each formula below is a port
 * OF). This file cannot be Node-tested (TSL, CONVENTIONS §4) and cannot be
 * print-debugged without a live Foundry session, which this build session
 * does not have — so every non-obvious line below cites the exact reference
 * function/formula it must stay byte-for-byte equivalent to, so a live
 * mismatch is a fast diff, not a re-derivation from scratch.
 *
 * ============================================================================
 * ONLY TWO TEXTURE-SAMPLING CALLS ARE USED, BOTH VERIFIED AGAINST THIS
 * PROJECT'S OWN VENDORED THREE BUILD (no invented chaining API)
 * ============================================================================
 * `texture(textureObject, uvNode)` — explicit UV, confirmed by
 * `world/wind-field.js#sampleWind`'s own `texture(bakedTexture, clampedUv)`.
 * `texture(textureObject)` — implicit, defaults to the mesh's own UV
 * attribute, confirmed by the present pass's own header in vt-pan-viewer.js
 * ("No uv argument: texture() defaults to the mesh's own uv attribute").
 * There is NO confirmed `.uv(...)` chain method on the returned node in this
 * vendored build (checked directly against `src/vendor/three/
 * three.webgpu.js` — grepping for a `uv(` method on `TextureNode` found
 * none); an earlier draft of this file invented one and was rewritten before
 * ever being wired in. Every distinct UV a shader below needs is instead its
 * OWN separate `texture(tex, uvNode)` call — which means a texture that gets
 * ping-ponged (re-pointed at a different render target each tick/iteration)
 * needs EVERY node that samples it re-pointed together. Each builder below
 * returns the full list it created (`prevTexNodes`) for exactly that reason
 * — see each function's own return doc.
 *
 * ADVECT and DISSIPATE are FUSED into one pass here (unlike the reference,
 * which keeps them separate for independent testability) — multiplying the
 * advected sample by the decay factor before writing costs nothing extra and
 * saves a whole render-target round-trip every tick. The transport velocity
 * for advection is `ambient + D_rest` — D_live's OWN self-velocity is
 * DELIBERATELY dropped from the backtrace (unlike the CPU reference, which
 * includes it): Wind.md §3's "disturbances ride the total wind, not D
 * alone" reads as "don't forget the ambient/structure", and a puff's own
 * velocity feeding back into its own transport is a second-order term this
 * session chose not to risk an extra ping-pong-tracked texture sample for.
 * Named here as a real, deliberate simplification, not an oversight.
 *
 * NO renderer-state, RenderTarget, or Texture allocation lives here — those
 * are walled to `vt/`/`graph/` (`renderer-state/graph-only`,
 * `gpu/allocator-only`, `gpu/textures-in-vt-only` in
 * tools/verify-structure.mjs). This file only BUILDS NodeMaterial + QuadMesh
 * objects and hands back the mutable texture/uniform nodes vt-pan-viewer.js
 * needs to drive the ping-pong itself — the same shape
 * `diag/wind-field-overlay.js#buildWindArrowMaterial` already uses (THREE
 * injected, never imported at module scope).
 *
 * @module world/wind-sim-gpu
 */

import { WIND_SIM_SPLAT_FOLLOW_RATE_PER_SECOND } from './wind-sim.js';

// `pow(remainAfter1s, dt)` reproduces `1 - exp(-rate*dt)`'s own remaining
// fraction exactly (`exp(-rate) === remainAfter1s`), computed once in plain
// JS Math so the shader never needs a TSL `exp()` — a second unconfirmed-API
// risk this file avoids entirely (`pow` IS confirmed — see
// `effects/lighting/animations/pulse.js`'s own `const { float, abs, pow } =
// THREE.TSL`). `splatWindField`'s own Node-verified tests assert THIS exact
// curve on the CPU side.
const SPLAT_FOLLOW_REMAIN_PER_SECOND = Math.exp(-WIND_SIM_SPLAT_FOLLOW_RATE_PER_SECOND);

/**
 * ADVECT+DISSIPATE — one fused pass. Port of `advectWindField` (Wind.md §3
 * step 1: `D*(x) = D(x - W(x)*dt)`) with `dissipateWindField`'s decay
 * multiplied onto the result before writing. See this file's own header for
 * why W here is `ambient + D_rest` only (D_live's self-term dropped, a named
 * simplification) and for the ping-pong tracking scheme.
 *
 * @param {object} args
 * @param {*} THREE
 * @param {*} prevFieldTexture - D_live, the ping-pong source to read this tick.
 * @param {*} restFieldTexture - D_rest (Tier 1's baked DataTexture, RG = dvx/dvy).
 * @param {*} solidMaskTexture - R channel, 1=solid. A solid cell is forced to
 *   exactly (0,0) here directly (not left to the relax pass's own zeroing
 *   alone) — see `advectWindField`'s own header for the exact gap this
 *   closes: at `relaxIterations:0` (a legitimate, documented rung) nothing
 *   downstream would otherwise zero it.
 * @param {{directionDeg:*, speed01:*}} ambientWind - the SAME live uniforms
 *   Tier 0/1 already thread through `sampleWind` (see that fn's own doc for
 *   the angle convention this MUST match — `ambientVectorFromWind`'s FROM→
 *   flow negation, reproduced verbatim below).
 * @param {number} cols @param {number} rows @param {number} cellSize -
 *   graph-build-time constants (a rebake/regrid rebuilds this material, same
 *   discipline `sampleWind`'s own `bakedField` shape already uses).
 * @param {number} [decayPerSecond]
 * @returns {{material:*, quad:*, prevTexNodes:Array<*>, uDtSec:*, uDecayPerSecond:*}} -
 *   `prevTexNodes` has exactly ONE entry (the backtrace sample) — re-point
 *   its `.value` to the current ping-pong source before rendering this pass.
 */
export function buildWindAdvectDissipateMaterial({
  THREE,
  prevFieldTexture,
  restFieldTexture,
  solidMaskTexture,
  ambientWind,
  cols,
  rows,
  cellSize,
  decayPerSecond = 0.35,
}) {
  const { texture, uv, vec2, vec4, float, uniform, cos, sin, clamp, pow, max } = THREE.TSL;

  const uv0 = uv();
  const restD = texture(restFieldTexture, uv0).xy;
  const selfSolid = texture(solidMaskTexture, uv0).x;
  const uDtSec = uniform(float(0));
  const uDecayPerSecond = uniform(float(decayPerSecond));

  // The FROM->flow ambient vector — byte-identical formula to
  // `world/wind-field.js#sampleWind`'s own `if (wind)` branch and
  // `world/wind-bake.js#ambientVectorFromWind`; those two already have to
  // agree with each other (documented in both files), and this is a THIRD
  // site that must not drift from either.
  const rad = ambientWind.directionDeg.mul(float(Math.PI / 180));
  const ambientVec = vec2(cos(rad), sin(rad)).negate().mul(ambientWind.speed01);

  const totalW = ambientVec.add(restD);
  // World px -> UV: divide by the grid's own world extent (same conversion
  // `sampleWind`'s bakedField branch already performs, in the other direction).
  const worldExtentX = Math.max(1e-6, cellSize * cols);
  const worldExtentY = Math.max(1e-6, cellSize * rows);
  const uvPerWorldPx = vec2(float(1 / worldExtentX), float(1 / worldExtentY));
  const backtraceUv = uv0.sub(totalW.mul(uDtSec).mul(uvPerWorldPx));
  const clampedBacktraceUv = clamp(backtraceUv, vec2(0, 0), vec2(1, 1));
  const backtraceNode = texture(prevFieldTexture, clampedBacktraceUv);
  const sampled = backtraceNode.xy;

  const decayFactor = pow(clamp(uDecayPerSecond, float(0), float(1)), max(uDtSec, float(0)));
  const result = sampled.mul(decayFactor).mul(float(1).sub(selfSolid));

  const material = new THREE.NodeMaterial();
  material.fragmentNode = vec4(result, 0, 1);
  const quad = new THREE.QuadMesh(material);
  return { material, quad, prevTexNodes: [backtraceNode], uDtSec, uDecayPerSecond };
}

/**
 * SPLAT — port of `splatWindField`'s bounded exponential follow (see that
 * function's own header for why a bounded follow, never an unbounded `+=`).
 * A FIXED number of unrolled slots (JS `for`, graph-build time — the
 * `tsl/no-uniform-gates` shape: an inactive slot is `uGain=0`, a genuine
 * per-slot value read every pixel, not a compiled-away branch; the shader is
 * the same size whether 0 or all slots are active, which is honest for a
 * feature that is ACTIVE data-dependently, unlike a whole-tier on/off switch).
 *
 * @param {object} args
 * @param {*} THREE
 * @param {*} prevFieldTexture
 * @param {*} solidMaskTexture - R channel, 1=solid (NEAREST filtered — see
 *   the caller's own upload code for why linear filtering would corrupt this).
 * @param {number} cols @param {number} rows @param {number} cellSize
 * @param {number} originX @param {number} originY
 * @param {number} [maxSlots]
 * @returns {{material:*, quad:*, prevTexNodes:Array<*>, uDtSec:*, slots: Array<{uPos:*, uVec:*, uRadius:*, uGain:*}>}} -
 *   `prevTexNodes` has exactly ONE entry (the self sample).
 */
export function buildWindSplatMaterial({
  THREE,
  prevFieldTexture,
  solidMaskTexture,
  cols,
  rows,
  cellSize,
  originX,
  originY,
  maxSlots = 4,
}) {
  const { texture, uv, vec2, vec4, float, uniform, length, clamp, max, pow } = THREE.TSL;

  const uv0 = uv();
  const prevNode = texture(prevFieldTexture, uv0);
  const prevD = prevNode.xy;
  const selfSolid = texture(solidMaskTexture, uv0).x;
  const uDtSec = uniform(float(0));

  // This fragment's own WORLD position (inverse of the world->UV map used
  // elsewhere in this file) — needed because slot position/radius arrive in
  // world px (the same units wall segments and WindContributors already use).
  const worldX = uv0.x.mul(float(cellSize * cols)).add(float(originX));
  const worldY = uv0.y.mul(float(cellSize * rows)).add(float(originY));
  const worldPos = vec2(worldX, worldY);

  const slots = [];
  let targetSum = vec2(0, 0);
  let reachSum = float(0);
  for (let i = 0; i < maxSlots; i++) {
    const uPos = uniform(vec2(0, 0));
    const uVec = uniform(vec2(0, 0));
    const uRadius = uniform(float(1));
    const uGain = uniform(float(0)); // 0 = inactive; fully inert (see this fn's own doc)
    slots.push({ uPos, uVec, uRadius, uGain });

    const dist = length(worldPos.sub(uPos));
    const rSafe = max(uRadius, float(1e-3));
    const w = clamp(float(1).sub(dist.div(rSafe)), float(0), float(1));
    const falloff = w.mul(w).mul(float(3).sub(w.mul(float(2)))); // smoothstep shape, matches splatWindField's own
    // Gain gates BOTH the target contribution and the reach mask, so an
    // expired (gain=0) slot's leftover position can never keep damping a
    // cell toward a stale target — see this fn's own doc.
    const contribution = falloff.mul(uGain);
    targetSum = targetSum.add(uVec.mul(contribution));
    reachSum = reachSum.add(contribution);
  }
  const reachMask = clamp(reachSum, float(0), float(1));
  // The same closed-form curve `splatWindField`'s own `1 - Math.exp(-rate*dt)`
  // uses, reparameterised for `pow` — see this file's own header for why
  // `SPLAT_FOLLOW_REMAIN_PER_SECOND` is the exact (not approximate) `pow`
  // equivalent of that `exp` formula.
  const remain = pow(float(SPLAT_FOLLOW_REMAIN_PER_SECOND), max(uDtSec, float(0)));
  const blend = float(1).sub(remain).mul(reachMask);

  const followed = prevD.add(targetSum.sub(prevD).mul(blend));
  const result = followed.mul(float(1).sub(selfSolid));

  const material = new THREE.NodeMaterial();
  material.fragmentNode = vec4(result, 0, 1);
  const quad = new THREE.QuadMesh(material);
  return { material, quad, prevTexNodes: [prevNode], uDtSec, slots };
}

/**
 * RELAX — port of `relaxWindField`'s per-neighbour into-wall cancellation +
 * bounded blend toward the (wall-respecting, off-grid-is-zero) neighbour
 * average. ONE iteration per pass, by construction: a fragment shader cannot
 * read a texture it is currently writing, so N relax iterations means N
 * separate render passes ping-ponging between two targets — see
 * vt-pan-viewer.js's own tick function, which calls this material N times,
 * re-pointing EVERY node in `prevTexNodes` between calls (five: the self
 * sample plus one per neighbour direction — relax is the one pass that
 * genuinely needs that many independent samples of the SAME swapped texture).
 *
 * Uses only `max`/`dot`/`mix`(function form)/`clamp`/`length` — deliberately
 * avoids TSL boolean-comparison operators this session could not confirm are
 * available (`world/wind-sim.js`'s relax header explains the three-way
 * open/solid/off-grid branch this reproduces; the technique for building it
 * from only confirmed-safe primitives is explained inline below).
 *
 * @param {object} args
 * @param {*} THREE
 * @param {*} prevFieldTexture
 * @param {*} solidMaskTexture
 * @param {number} cols @param {number} rows
 * @param {number} [blendAmount]
 * @returns {{material:*, quad:*, prevTexNodes:Array<*>}}
 */
export function buildWindRelaxMaterial({ THREE, prevFieldTexture, solidMaskTexture, cols, rows, blendAmount = 0.25 }) {
  const { texture, uv, vec2, vec4, float, dot, max, clamp, length, mix } = THREE.TSL;

  const uv0 = uv();
  const selfNode = texture(prevFieldTexture, uv0);
  const selfD = selfNode.xy;
  const selfSolid = texture(solidMaskTexture, uv0).x;

  const texelX = 1 / Math.max(1, cols);
  const texelY = 1 / Math.max(1, rows);

  const NEIGHBORS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  const prevTexNodes = [selfNode];
  let v = selfD;
  let sumAccum = vec2(0, 0);
  for (const [dx, dy] of NEIGHBORS) {
    const dirVec = vec2(dx, dy);
    const nUv = uv0.add(vec2(dx * texelX, dy * texelY));
    const clampedNUv = clamp(nUv, vec2(0, 0), vec2(1, 1));
    // A step of EXACTLY one texel either lands the clamp as a no-op (in
    // bounds: distance 0) or pins it to the edge (out of bounds: distance
    // EXACTLY texelX or texelY) — scaling that distance up hugely and
    // clamping to [0,1] turns "was this clamped at all" into a crisp 0/1
    // mask using only length/sub/clamp, no comparison operators needed.
    const clampDist = length(nUv.sub(clampedNUv));
    const outOfBounds = clamp(clampDist.mul(float(1e6)), float(0), float(1));

    const neighborSolidRaw = texture(solidMaskTexture, clampedNUv).x;
    // Off-grid must never be treated as solid, whatever the clamped sample
    // happens to read at the edge — see relaxWindField's own three-way-
    // branch doc.
    const effectiveSolid = neighborSolidRaw.mul(float(1).sub(outOfBounds));

    // Cancel the component of v pointing INTO this neighbour direction,
    // branch-free: `v - max(dot(v,dir),0)*dir` — identical to
    // relaxWindField's `into`/`max(into,0)` step, just without the `if`.
    const into = dot(v, dirVec);
    const cancelled = v.sub(dirVec.mul(max(into, float(0))));
    v = mix(v, cancelled, effectiveSolid);

    const neighborNode = texture(prevFieldTexture, clampedNUv);
    prevTexNodes.push(neighborNode);
    const openValue = neighborNode.xy;
    const combined = mix(openValue, v, effectiveSolid);
    const withOffGrid = mix(combined, vec2(0, 0), outOfBounds);
    sumAccum = sumAccum.add(withOffGrid);
  }
  const avg = sumAccum.div(float(NEIGHBORS.length));
  const blended = v.add(avg.sub(v).mul(float(blendAmount)));
  const result = blended.mul(float(1).sub(selfSolid));

  const material = new THREE.NodeMaterial();
  material.fragmentNode = vec4(result, 0, 1);
  const quad = new THREE.QuadMesh(material);
  return { material, quad, prevTexNodes };
}

/**
 * PUBLISH — a trivial passthrough (`texture(sourceTex, uv)`, nothing else)
 * that copies whichever ping-pong texture a tick's relax loop finished on
 * into a THIRD, STABLE render target every consumer binds to.
 *
 * WHY THIS EXISTS: every OTHER consumer of `sampleWind`'s `liveField` param
 * (the candle flame, each light's illumination/coloration material, the
 * debug overlay) builds its shader graph ONCE, lazily, the same way it
 * already does for `bakedField` — but unlike `bakedField` (which only
 * changes on a rare rebake, so tearing down and rebuilding every consumer at
 * that moment is cheap and already how Tier 1 works), D_live's ping-pong
 * texture identity flips EVERY TICK while thawed. Baking a specific ping or
 * pong texture object into a dozen consumer shader graphs would mean either
 * rebuilding all of them every tick (expensive, wrong) or them silently
 * reading a stale, non-alternating half of the ping-pong pair (wrong output).
 * Publishing into ONE never-swapped target — the same trick `buf:scene.
 * color`/`buf:scene.illum`/`buf:scene.lit` already use throughout this
 * renderer (a stable target whose CONTENT is refreshed, never whose
 * identity changes) — means `liveField.texture` is a constant reference
 * every consumer can bind ONCE, and it simply shows fresh content each
 * frame with zero consumer-side rebuild logic.
 *
 * @param {object} args
 * @param {*} THREE
 * @param {*} sourceTexture - initial texture (re-pointed via `.value` each
 *   tick to whichever ping-pong RT the relax loop most recently wrote).
 * @returns {{material:*, quad:*, sourceTexNode:*}}
 */
export function buildWindPublishMaterial({ THREE, sourceTexture }) {
  const { texture, uv, vec4 } = THREE.TSL;
  const sourceTexNode = texture(sourceTexture, uv());
  const material = new THREE.NodeMaterial();
  material.fragmentNode = vec4(sourceTexNode.xy, 0, 1);
  const quad = new THREE.QuadMesh(material);
  return { material, quad, sourceTexNode };
}

/**
 * Build all three passes together, sharing the same grid spec — the call
 * vt-pan-viewer.js makes once per rebuild (grid/regrid change, matching the
 * SAME "rebuild consuming materials on rebake" discipline `bakeWindField`
 * already applies to `candleFlameMat`/`windOverlayMat`/etc). The initial
 * `pingTexture`/`pongTexture` values only need to be VALID (non-null) —
 * every render call re-points the relevant `prevTexNodes` to the actual
 * current ping-pong source first, so these starting values are never
 * actually sampled as-is.
 *
 * @param {object} args - the union of every builder's own args above, plus:
 * @param {*} args.pingTexture @param {*} args.pongTexture - the two ping-pong
 *   D_live render-target textures (allocated by the caller through
 *   ThreeAllocator — `gpu/allocator-only` forbids doing that here).
 * @param {*} args.publishTexture - the initial source for the publish pass
 *   (see {@link buildWindPublishMaterial}) — typically `pingTexture` again;
 *   re-pointed via `.value` each tick regardless.
 * @returns {{advectDissipate:object, splat:object, relax:object, publish:object, dispose:()=>void}}
 */
export function buildWindSimMaterials({
  THREE,
  pingTexture,
  pongTexture,
  publishTexture,
  restFieldTexture,
  solidMaskTexture,
  ambientWind,
  cols,
  rows,
  cellSize,
  originX,
  originY,
  decayPerSecond,
  relaxBlend,
  maxImpulseSlots,
}) {
  const advectDissipate = buildWindAdvectDissipateMaterial({
    THREE,
    prevFieldTexture: pingTexture,
    restFieldTexture,
    solidMaskTexture,
    ambientWind,
    cols,
    rows,
    cellSize,
    decayPerSecond,
  });
  const splat = buildWindSplatMaterial({
    THREE,
    prevFieldTexture: pongTexture,
    solidMaskTexture,
    cols,
    rows,
    cellSize,
    originX,
    originY,
    maxSlots: maxImpulseSlots,
  });
  const relax = buildWindRelaxMaterial({
    THREE,
    prevFieldTexture: pingTexture,
    solidMaskTexture,
    cols,
    rows,
    blendAmount: relaxBlend,
  });
  const publish = buildWindPublishMaterial({ THREE, sourceTexture: publishTexture ?? pingTexture });
  return {
    advectDissipate,
    splat,
    relax,
    publish,
    dispose() {
      advectDissipate.material.dispose();
      splat.material.dispose();
      relax.material.dispose();
      publish.material.dispose();
      // NOT the quads' geometry — QuadMesh shares ONE module-level
      // QuadGeometry across every QuadMesh in the process (see
      // vt-pan-viewer.js's own disposeSceneColor comment for the citation).
    },
  };
}
