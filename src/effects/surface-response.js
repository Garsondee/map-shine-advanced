/**
 * SEAM: `surface.response` — one material term for shine.
 *
 * Five V2 classes (Specular, Iridescence, Prism, Roughness, Normal — each with
 * its own RTs, binding manager and populate pipeline) collapse into ONE node
 * with a tier ladder: the packed specular VT layer × `buf:scene.illum` × weather
 * wetness (`env.weather.wetness01`). Additive into scene colour, after lighting,
 * exactly as the worked declaration in docs/planning/Effects-API.md §5 sketches.
 *
 * The look — the author's tuned shimmer/sparkle/wet-response values and the
 * mask-colour conventions — is harvested from the V2 shaders and the 48
 * authored control schemas (docs/planning/UI.md §1). The machinery is not.
 *
 * @module effects/surface-response
 */

import { NotBuiltError } from '../core/not-built.js';

/**
 * Build the surface-response pass. Once real: reads vt:masks + illum + attr +
 * env, modifies `buf:scene.color`.
 * @param {object} ctx
 * @returns {never}
 * @throws {NotBuiltError}
 */
export function buildSurfaceResponsePass(ctx) {
  void ctx;
  throw new NotBuiltError('surface.response', {
    owns: 'docs/planning/Effects-API.md §5 (the worked SPECULAR declaration) + docs/planning/Effects.md + graph/passes.js',
    gate: 'Stage 6, after water proves the port pattern. Needs lighting live and the specular VT pack format decided at the Stage 4 mask audit.',
    instead:
      'Declaration first: write SPECULAR_PARAMS/TIERS against the Effects-API sketch — it is data, testable today.',
  });
}
