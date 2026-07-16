/**
 * SEAM: `masks.occlusion` — the occlusion-mask PRODUCER (tokens fading roofs).
 *
 * The MODEL is already ported and Node-tested in `scene/occlusion.js` (Foundry's
 * RGBA screen mask: R=Fade G=Radial B=Vision A=Surface, elevation-indexed, MIN
 * blend). What does not exist is the thing that WRITES it — rendering each
 * occludable token's radial disc / vision poly into a screen-space target.
 * Until then the shader consumes an inert 1×1 "nothing occludes anything".
 *
 * @module scene/occlusion-mask
 */

import { NotBuiltError } from '../core/not-built.js';

/**
 * Build the occlusion-mask pass. Once real: reads `res:scene` (token docs) +
 * `res:view`, creates `buf:occlusion`.
 * @param {object} ctx - exactly the pass's declared reads (graph/passes.js).
 * @returns {never}
 * @throws {NotBuiltError}
 */
export function buildOcclusionMaskPass(ctx) {
  void ctx;
  throw new NotBuiltError('masks.occlusion', {
    owns: 'Keyhole.md §"THE REMAINING PIECE" + scene/occlusion.js (model: ported, tested) + graph/passes.js',
    gate: 'frame-graph pass wiring. Tokens render (author-confirmed), so this is UNBLOCKED — the last piece of the original tiles directive.',
    instead:
      'Consume scene/occlusion.js — packOcclusionModes/computeOcclusionState/mapElevation are real and tested. ' +
      'Two known traps recorded in Keyhole.md: maskUV needs SCREEN space (not positionGeometry.xy), and ' +
      'mapElevation returns 1 for every item against the placeholder table.',
  });
}
