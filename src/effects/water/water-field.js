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
 * Both ride ONE noise fetch. The slope itself is deliberately not computed —
 * it would be a uniform nothing reads, which is the exact disease
 * `params/no-dead-controls` exists to stop (V2 shipped `microChop*` fully
 * exposed and fully dead). It arrives in rung 3 with the shading that makes it
 * mean something.
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
export const WATER_TIER2_WAVE_SCALE_PX = 220;

/** Tier 2 — how fast the field travels, world px per second. */
export const WATER_TIER2_FLOW_SPEED_PX = 60;

/** Tier 2 — the global current's heading in degrees (0 = +x, screen right). A
 * pond wants speed 0 and ignores this; a river wants it pointed downstream. */
export const WATER_TIER2_FLOW_ANGLE_DEG = 0;

/** Tier 2 — how much foam the crests produce, 0..1. */
export const WATER_TIER2_FOAM = 0.35;

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

/** How far from the bank foam has fully died away, world px. Foam is a
 * shoaling phenomenon — it breaks where the water shallows — so it is strongest
 * at the waterline and gone in the deep channel. */
export const WATER_FOAM_SHORE_PX = 140;

/**
 * Build tier 2's surface field. One fractal-noise fetch, two readings of it.
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
 * @param {*} args.uFlowAngleRad - float uniform node.
 * @param {*} args.uFoam - float uniform node.
 * @returns {{foam: *, turbidity: *}} `foam` 0..1 (white surface coverage),
 *   `turbidity` roughly −1..1 (a MULTIPLIER offset on optical depth).
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
  uFlowAngleRad,
  uFoam,
}) {
  const { vec2, vec3, float, max, min, dot, cos, sin, smoothstep, mx_fractal_noise_vec3 } = TSL;

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
  const current = vec2(cos(uFlowAngleRad), sin(uFlowAngleRad));
  const drift = current.mul(uFlowSpeedPx.mul(tSec));
  // Correction #4's PROJECTION is still what shapes the warp — invariant under
  // `t → −t`, so the tangent's sign flip at the river's medial axis cancels
  // rather than seaming the two halves against each other.
  const alongBank = tangentXY.mul(dot(current, tangentXY));
  const bankWarp = alongBank.mul(uWaveScalePx.mul(float(WATER_BANK_INFLUENCE)));

  // ONE fetch. `mx_fractal_noise_vec3` is three's own MaterialX fractal noise —
  // vendored, backend-neutral, and identical on WebGPU and WebGL2, which is why
  // it is used instead of a hand-rolled hash (Law 8: no hand-written twin).
  const cell = worldXY
    .add(drift)
    .add(bankWarp)
    .div(max(uWaveScalePx, float(1)));
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
  const crest = smoothstep(float(0.18), float(0.55), n.y);
  const shoreGate = float(1).sub(smoothstep(float(0), float(WATER_FOAM_SHORE_PX), shoreDist));
  const foam = min(crest.mul(shoreGate).mul(insideWater).mul(uFoam), float(1));

  return { foam, turbidity };
}
