/**
 * SEAMS: `light.visibility` + `light.accumulate` — the lighting model where the
 * light/shadow war cannot happen.
 *
 * THE ONE SENTENCE (docs/planning/Light-and-Shadow.md): shadow is not a thing —
 * it is the ABSENCE OF A SPECIFIC LIGHT. Every light carries its OWN visibility
 * term; the sun's term min-combines producers that all mean the same thing
 * (authored `_Shadow` — the author's paintbrush, promoted to canon — ∧ building
 * ∧ sky-reach ∧ cloud); a torch's term is Foundry's wall-clipped LOS. Then:
 *
 *   illum = skyAmbient × skyVis + Σ ( light_i × visibility_i )
 *
 * No combined-shadow. No lift. Those words FAIL THE BUILD
 * (`shadow/no-lift-no-combine` in tools/verify-structure.mjs) — they are the
 * fossils of V2's wrong noun: `tCombinedShadow` applied to all lights at once,
 * then an entire module (`DynamicLightShadowLift`) un-darkening shadows near
 * lights by a global hand-tuned 0.7.
 *
 * @module effects/lighting/lighting-pass
 */

import { NotBuiltError } from '../../core/not-built.js';

/**
 * Build the per-light visibility terms. Once real: reads env/scene/masks/attr,
 * creates `res:vis`. NEVER touches scene colour — shadow modulates LIGHT.
 * @param {object} ctx
 * @returns {never}
 * @throws {NotBuiltError}
 */
export function buildLightVisibilityPass(ctx) {
  void ctx;
  throw new NotBuiltError('light.visibility', {
    owns: 'docs/planning/Light-and-Shadow.md §4 + graph/passes.js',
    gate: "needs env.sun (world/environment.js — BUILT) and the frame-graph wiring. Tier 0 = authored _Shadow alone modulating the sun: the author's proven hand-built fallback.",
    instead:
      'The sun direction comes from env.sun and NOWHERE else (env/one-sun tripwire). Producers combine by ' +
      'min() because they share one semantic — sun visibility — so there are no opacity knobs to fight over.',
  });
}

/**
 * Accumulate illumination and composite. Once real: reads res:vis + env + attr,
 * creates `buf:scene.illum`, modifies `buf:scene.color` (the ONE declared
 * modify — see graph/passes.js).
 * @param {object} ctx
 * @returns {never}
 * @throws {NotBuiltError}
 */
export function buildLightAccumulatePass(ctx) {
  void ctx;
  throw new NotBuiltError('light.accumulate', {
    owns: 'docs/planning/Light-and-Shadow.md §1 + Keyhole.md §4.2 (harvested ForwardLightingPass semantics)',
    gate: 'needs light.visibility (res:vis) and the frame graph. Foundry-v14 model: MAX-blend illum + SCREEN coloration, per-light additive.',
    instead:
      'A torch does not "override" a shadow — it is a separate light whose contribution ADDS. If a shadow ' +
      'ever seems to need weakening near a light, the model is being violated, not tuned.',
  });
}
