/**
 * SEAM: `post.grade` — THE GRADE STACK, nodes in a fixed, labeled order.
 *
 * V2's final image was the product of knobs owned by four systems with no
 * composition order — ToD grade × contextBrightness × weather darkening ×
 * Foundry darkness — "four colorists grading the same shot on separate
 * unlabeled adjustment layers, blend modes undefined, each re-tweaking to undo
 * the others" (docs/planning/Environment.md §0.5). Touching any one re-broke
 * the sum, which is why it FELT like a constant battle.
 *
 * Here the stack is one node chain with a DEFINED order:
 *
 *   base look → ToD grade (the 8-anchor timeline) → weather grade
 *             → context gate (indoor/outdoor, from buf:scene.attr) → manual trim
 *
 * "Overcast noon" works because weather grades the OUTPUT of the ToD stage —
 * flatter, cooler, dimmer — instead of fighting a hardcoded noon anchor inside
 * each effect. Then bloom, atmospheric fog, distortion, and the stylizers
 * (ascii/halftone/sepia — author on/off toggles, compiled out when off).
 *
 * Absorbs THIRTEEN V2 classes (graph/passes.js `post.grade`).
 *
 * @module effects/grade/grade-pass
 */

import { NotBuiltError } from '../../core/not-built.js';

/**
 * Build the grade/post chain. Once real: reads scene color/attr/depth + env,
 * creates `buf:final`.
 * @param {object} ctx
 * @returns {never}
 * @throws {NotBuiltError}
 */
export function buildGradePass(ctx) {
  void ctx;
  throw new NotBuiltError('post.grade', {
    owns: 'docs/planning/Environment.md §2.3 + docs/planning/UI.md (the 48 authored schemas feed these knobs) + graph/passes.js',
    gate: 'needs env (BUILT: world/environment.js) + the frame graph. The stage ORDER above is the design — new stages are inserted, never interleaved ad hoc.',
    instead:
      'Any system that wants to affect the final image contributes a STAGE in the declared order — never a ' +
      'hidden multiplier somewhere else. That rule is what makes weather and time-of-day compliment each ' +
      'other instead of fighting.',
  });
}
