/**
 * SEAM: `light.visibility` — the shadow half of the lighting model, where the
 * light/shadow war cannot happen. (`light.accumulate` is no longer a seam: it
 * went live 2026-07-18, AMBIENT/EXTERIOR only — see the note where its door used
 * to be, below, and effects/lighting/environmental-light.js.)
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
    gate:
      'needs env.sun (world/environment.js — BUILT) and the frame-graph wiring. Tier 0 = the authored ' +
      "shadow mask (scene/mask-catalog.js, kind 'shadow') alone modulating the sun: the author's " +
      'proven hand-built fallback.',
    instead:
      'The sun direction comes from env.sun and NOWHERE else (env/one-sun tripwire). Producers combine by ' +
      'min() because they share one semantic — sun visibility — so there are no opacity knobs to fight over.',
  });
}

/*
 * `buildLightAccumulatePass` (the throwing door) is GONE as of 2026-07-18:
 * light.accumulate flipped to 'live' (AMBIENT/EXTERIOR only). Its real producer
 * runs in vt-pan-viewer.js#runLightAccumulatePass; the TSL is in
 * effects/lighting/environmental-light.js. graph/pass-seams.js no longer lists
 * it; graph/pass-impls.js does. Point lights / coloration / darkness sources are
 * later rungs that grow the SAME pass (Light-Parity.md §5), not new seams.
 */
