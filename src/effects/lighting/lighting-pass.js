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
 * creates `buf:scene.vis` (a screen buffer — a per-pixel visibility term is an
 * AOV, so this producer graduates `res:vis` to the `buf:` namespace when it
 * lands). NEVER touches scene colour — shadow modulates LIGHT.
 *
 * PURE CORE BUILT + Node-tested (2026-07-20), like `frame.snapshot`'s: the
 * visibility MODEL (min-combine, `_Shadow` semantics, the compose-with-MAX
 * invariant that proves no lift is needed) and the offset-projection geometry
 * for screen-space occluders (the "UI casts a shadow on the world" producer)
 * live in effects/lighting/light-visibility.js. This door stays a SEAM because
 * the GPU producer that fills the buffer, and the frame-loop multiply, must be
 * verified LIVE with the pixel probe — a world→screen mask sample is the Y-flip
 * class (memory: feedback_y_flip_recurring_risk), not a Node-assertable fact.
 *
 * @param {object} ctx
 * @returns {never}
 * @throws {NotBuiltError}
 */
export function buildLightVisibilityPass(ctx) {
  void ctx;
  throw new NotBuiltError('light.visibility', {
    owns: 'docs/planning/Light-and-Shadow.md §4–5 + effects/lighting/light-visibility.js (pure core) + graph/passes.js',
    gate:
      'env.sun (world/environment.js) and the pure core (effects/lighting/light-visibility.js) are BUILT. ' +
      'What remains: the TSL producer that fills buf:scene.vis, the runLightAccumulatePass multiply (ambient ' +
      '× visibility, BEFORE point lights MAX in — vt-pan-viewer.js), and LIVE pixel-probe verification. ' +
      "Tier 0 = the authored shadow mask (scene/mask-catalog.js, kind 'shadow') alone modulating the sun.",
    instead:
      'Import combineVisibility/composeSunTermWithMaxLight/projectOccluderShadow from effects/index.js — the ' +
      'model is decided and tested. The sun direction comes from env.sun and NOWHERE else (env/one-sun). ' +
      'Producers combine by min() (one semantic → no opacity knobs); the UI-shadow is a PRODUCER into ' +
      'visibility, never a darken over composed scene colour (the combined-shadow-for-all-lights fossil the ' +
      'shadow/no-lift-no-combine wall forbids as a live string).',
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
