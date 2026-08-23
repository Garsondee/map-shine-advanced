/**
 * SEAM: `sims.fluids` — `surface.water` flipped to `live` 2026-08-23 (tier 5,
 * refraction — see `graph/passes.js`'s own entry for the full reasoning). Its
 * throwing door used to live here; it is deleted, not left beside the real
 * code, matching every prior seam→live flip in this codebase (`graph/pass-
 * seams.js`'s own header lists the other five). The real producer is
 * `effects/water/water-refraction-subsystem.js` (the per-frame capture) plus
 * the tier-gated shader block in `water-render.js`, driven from a viewer
 * closure in `vt-pan-viewer.js` — see `graph/pass-impls.js` for the pointer.
 *
 * The full audit lives in docs/planning/Water.md: V2's water family was 14,850
 * lines of which the LOOK (the author's 2,835-line shader, 324 uniforms) was
 * 19% — the other 81% was plumbing this architecture derives. The tier ladder
 * runs from "the mask, tinted blue, in the right place" (tier 0 — always
 * affordable, never gated) up through waves, GGX specular, foam (cheap! the
 * shore band is already packed in the mask's G channel), refraction, and
 * finally the fluid sim.
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
