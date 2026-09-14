/**
 * A fast, EXACTLY divergence-free 2D curl-noise field — V2's original
 * "fake curl" trick (`fire-behaviors.js:64`), ported verbatim into TSL for
 * fire's embers and now extracted so any second particle system (dust motes
 * — see `particle-runtime.js`'s own header: "real dust motes are a planned,
 * separate future feature reusing this same engine") can reach for the same
 * math instead of re-deriving or copy-pasting it.
 *
 * `vx` depends only on `y` and `vy` only on `x`, so `∂vx/∂x = ∂vy/∂y = 0` by
 * construction — a genuinely incompressible flow, not merely a plausible-
 * looking one. Real simplex curl is also divergence-free but has isotropic-
 * blob character where this has crossed shear bands, so swapping one for the
 * other anywhere is a LOOK change to be A/B'd, not a modernisation
 * (`feedback_port_faithfully_then_modernize_opportunistically`).
 *
 * ⚠️ ADVANCE THE CLOCK ONCE PER FRAME, NEVER PER PARTICLE — a recorded V2 bug
 * fix: per-particle advance multiplies the noise's apparent speed by the
 * particle count. Pass one shared `tSec` node (typically a single uniform
 * read) to every call in a given kernel invocation, exactly as fire already
 * does — never a per-particle-derived time value.
 *
 * @module effects/particles/curl-noise
 */

/**
 * @param {*} TSL - the live TSL namespace (`THREE.TSL`), injected per this
 *   directory's own "never imported at module scope" convention.
 * @param {*} pos - vec2 world-space position node.
 * @param {*} tSec - float seconds node, ONE shared clock per kernel
 *   invocation (see the header — never a per-particle time).
 * @param {{scale:number, strength:number}} k - `scale` is the world-px size
 *   of one noise cell (bigger = broader, lazier swirls); `strength` is the
 *   output velocity magnitude in the caller's own units.
 * @returns {*} vec2 velocity contribution node, already scaled by `strength`.
 */
export function fakeCurl2D(TSL, pos, tSec, { scale, strength }) {
  const { sin, cos, float, vec2 } = TSL;
  const px = pos.x.div(float(scale));
  const py = pos.y.div(float(scale));
  const vx = sin(py.mul(float(2.13)).add(tSec))
    .add(cos(py.mul(float(3.71)).sub(tSec)))
    .mul(float(0.5));
  const vy = cos(px.mul(float(2.27)).add(tSec))
    .add(sin(px.mul(float(3.43)).sub(tSec)))
    .mul(float(0.5));
  return vec2(vx, vy).mul(float(strength));
}
