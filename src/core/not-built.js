/**
 * `NotBuiltError` — the error a deliberately-unbuilt seam throws.
 *
 * THE IDEA (docs/planning/Skeleton.md §0): a future session — human or LLM —
 * starts cold, confident, and biased toward whatever is locally easy. It has not
 * read the plans. It never will, not before it starts typing. So the plans must
 * come to IT, at the exact moment it does the wrong thing.
 *
 * **Errors are the documentation's front door.** The wrong move triggers the
 * reading. That is why this error carries `owns` (which doc governs this),
 * `gate` (what must be true before it can be built) and `instead` (what to do
 * right now) — rather than the traditional and useless "not implemented".
 *
 * V2's own evidence for why a comment cannot do this job: it had a real design
 * for effect layering, documented, correct — used in ONE place outside its own
 * file. `resolve-effect-enabled.js` says "every render pass gate MUST call this"
 * in its docstring and was bypassed anyway. Prose does not stop anyone. A thrown
 * error does.
 *
 * @module core/not-built
 */

/**
 * Thrown by a seam that exists on purpose but is not implemented yet.
 *
 * @example
 * throw new NotBuiltError('particle-engine.stepParticles', {
 *   owns: 'docs/planning/Particles.md §7',
 *   gate: 'Stage 6 — needs the frame graph first',
 *   instead: 'Write the declaration; do not hand-roll particles elsewhere.',
 * });
 */
export class NotBuiltError extends Error {
  /**
   * @param {string} seam - the thing not built, e.g. `'particle-engine.stepParticles'`.
   * @param {object} info
   * @param {string} info.owns - the doc/memory that governs this seam. **Required** —
   *   an error that cannot point at its own design is just a wall with no sign on it.
   * @param {string} [info.gate] - what must be true before this can be built.
   * @param {string} [info.instead] - what the caller should do right now.
   */
  constructor(seam, { owns, gate, instead } = {}) {
    const lines = [
      `NOT BUILT YET: ${seam}`,
      '',
      'This seam exists on purpose and throws on purpose (docs/planning/Skeleton.md §2.2).',
      `  Design lives in: ${owns ?? '(!!! MISSING — every seam must cite its design !!!)'}`,
    ];
    if (gate) lines.push(`  Blocked on: ${gate}`);
    if (instead) lines.push(`  Do this instead: ${instead}`);
    lines.push(
      '',
      'If you are about to work around this: DO NOT. Read the design above first.',
      'Routing around a wall is the single move that killed the previous module',
      '(memory: v2-postmortem-the-failure-modes). The wall is right until the author says otherwise.'
    );
    super(lines.join('\n'));
    this.name = 'NotBuiltError';
    /** @type {string} */
    this.seam = seam;
    /** @type {string|undefined} */
    this.owns = owns;
    /** @type {string|undefined} */
    this.gate = gate;
    /** @type {string|undefined} */
    this.instead = instead;
  }
}
