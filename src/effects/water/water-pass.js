/**
 * SEAMS: `surface.water` + `sims.fluids` — the first Stage 6 port, by design.
 *
 * The full audit lives in docs/planning/Water.md: V2's water family was 14,850
 * lines of which the LOOK (the author's 2,835-line shader, 324 uniforms) was
 * 19% — the other 81% was plumbing this architecture derives. The tier ladder
 * runs from "the mask, tinted blue, in the right place" (tier 0 — always
 * affordable, never gated) up through waves, GGX specular, foam (cheap! the
 * shore band is already packed in the mask's G channel), refraction,
 * reflection, and finally the fluid sim.
 *
 * THE CROSS-FLOOR RULE — Keyhole's named risk #4, audited down to fifteen clear
 * lines — rides at TIER 0, because correctness never rides the ladder: a floor
 * with no local water borrows the nearest lower floor's pack; borrowed water is
 * punched out under opaque upper geometry via `buf:scene.attr` (a C3 read — the
 * two bespoke occluder push-doors of V2 dissolve).
 *
 * @module effects/water/water-pass
 */

import { NotBuiltError } from '../../core/not-built.js';

/**
 * Build the water surface pass. Once real: reads vt:masks + illum + attr + env
 * (+ res:fluidSim at top tiers), modifies `buf:scene.color`.
 * @param {object} ctx
 * @returns {never}
 * @throws {NotBuiltError}
 */
export function buildWaterPass(ctx) {
  void ctx;
  throw new NotBuiltError('surface.water', {
    owns: 'docs/planning/Water.md (audit + ladder + declaration sketch) + graph/passes.js',
    gate: 'Stage 6 first port. Needs: lighting live (for tier 3+), the VT water pack format (R=coverage, G=shore band — decided), the tier governor for rungs above 4.',
    instead:
      'Write the declaration against Water.md §6 first. Harvest the look values from water-shader.js; the ' +
      '324 uniforms become the params schema + tier-gated node-graph constants — never 324 live uniforms.',
  });
}

/**
 * Build the fluid/fire sim step. Once real: reads env/view/masks, creates
 * `res:fluidSim`. Sim-res, never world-res; coverage- and zoom-gated (Law 7).
 * @param {object} ctx
 * @returns {never}
 * @throws {NotBuiltError}
 */
export function buildFluidSimPass(ctx) {
  void ctx;
  throw new NotBuiltError('sims.fluids', {
    owns: 'docs/planning/Water.md §5 (tiers 7+) + docs/planning/Effects.md Law 7 + graph/passes.js',
    gate: 'top rungs only — tier 0 water needs NO sim at all. Blocked on the tier governor and TSL compute plumbing (proven available: keyhole-particles-tsl-decision).',
    instead:
      'Do not reach for a sim to make water read as water — tiers 0-3 (tint/depth/waves/specular) carry nearly the whole look for almost nothing.',
  });
}
