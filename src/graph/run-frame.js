/**
 * THE PASS RUNNER — walks a declared stage range of `graph/passes.js` and
 * calls real implementations, so the render order lives in the data instead
 * of being hand-written at each call site.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * Keyhole.md's own "what actually blocks effects" list names this the #1
 * gate: "`PASSES` is imported by `boot.js` (to validate) and `pass-health.js`
 * — nothing walks it to execute. The render order is hardcoded inside
 * `renderFrame`... if it is hardcoded, `passes.js` becomes a comment."
 *
 * This module is that walk. It does NOT reach into `vt-pan-viewer.js` or know
 * anything about THREE — it is a pure ordering + dispatch utility so it stays
 * Node-testable without a renderer, exactly like `passes.js`/`pass-health.js`
 * before it.
 *
 * ============================================================================
 * WHAT IT DELIBERATELY DOES NOT DO (read before widening scope)
 * ============================================================================
 *
 * - No timing. `tools/verify-structure.mjs`'s `time/one-clock` wall restricts
 *   `performance.now()`/`Date.now()` to `diag/` and `core/frame-clock.js` —
 *   this file samples no clock, and never will. Per-pass timing is a
 *   deliberately separate piece of work (Keyhole.md's infrastructure menu,
 *   Track 2 item 6, "rides the pass runner" — built ON this, not folded in).
 * - No knowledge of `vt.residency` or `frame.snapshot`. Those passes are
 *   'live'/'future' with their OWN drivers (Foundry document hooks; not yet
 *   wired) that are not "once per drawn frame" — a generic stage-range caller
 *   would misrepresent that by invoking them unconditionally every tick. A
 *   caller scopes `fromStage`/`toStage` to the stages it actually owns.
 *
 * @module graph/run-frame
 */

import { STAGES } from './passes.js';

/**
 * Reduce the full pass list to the ordered ids that will actually EXECUTE
 * within a stage range — 'live' passes only; 'seam'/'future' are silently
 * (and safely) absent from the plan, exactly as their status already
 * promises. Array order in `passes` IS frame order (`passes.js`'s own
 * invariant, checked by `validatePassGraph`), so this is a filter, never a
 * sort — the DAG has already been proven acyclic before this ever runs.
 *
 * @param {import('./passes.js').PassDecl[]} passes
 * @param {{fromStage?: string, toStage?: string}} [range]
 * @returns {{ids: string[], skipped: {id: string, status: string}[]}}
 */
export function planFrame(passes, { fromStage = STAGES[0], toStage = STAGES[STAGES.length - 1] } = {}) {
  const fromIdx = STAGES.indexOf(fromStage);
  const toIdx = STAGES.indexOf(toStage);
  if (fromIdx === -1) throw new Error(`planFrame: unknown fromStage '${fromStage}'`);
  if (toIdx === -1) throw new Error(`planFrame: unknown toStage '${toStage}'`);
  if (toIdx < fromIdx) throw new Error(`planFrame: toStage '${toStage}' precedes fromStage '${fromStage}' in STAGES`);

  const ids = [];
  const skipped = [];
  for (const p of passes) {
    const stageIdx = STAGES.indexOf(p.stage);
    if (stageIdx < fromIdx || stageIdx > toIdx) continue;
    if (p.status === 'live') ids.push(p.id);
    else skipped.push({ id: p.id, status: p.status });
  }
  return { ids, skipped };
}

/**
 * Execute a plan's live passes, in order, against real implementations.
 *
 * A plan id with no matching impl is a real bug, not a thing to skip past:
 * `planFrame` only ever plans a pass whose `status` is 'live' — "the code
 * exists and runs today" — so a missing impl means that claim is false THIS
 * frame. Throwing loud beats a silently-dark pass with an unchanged-looking
 * screen (doctrine #5, "instruments must not lie" — a skip here would look
 * identical to a correctly-absent seam).
 *
 * TIMING HOOKS (2026-07-27, docs/planning/Performance.md). `hooks` is the seam
 * this file's own header reserved for per-pass timing — "built ON this, not
 * folded in". It stays a pure callback pair on purpose: `time/one-clock`
 * restricts `performance.now()` to `diag/` and `core/frame-clock.js`, so this
 * file calls a function and the instrument on the other end reads the clock.
 * `graph/` still samples no clock, and never will.
 *
 * The `finally` is load-bearing, not defensive habit: a pass that throws must
 * still close its zone, or the profiler accumulates an unterminated bracket and
 * every subsequent frame's number for that zone is garbage — a wrong number
 * surviving a visible crash, which is the worse of the two failures.
 *
 * @param {string[]} ids - from `planFrame(...).ids`
 * @param {Record<string, (ctx: object) => void>} impls - pass id -> real fn
 * @param {object} [ctx] - passed through to every pass, untouched
 * @param {{onPassBegin?: (id: string) => void, onPassEnd?: (id: string) => void}} [hooks]
 * @returns {string[]} the ids that actually ran, in the order they ran
 */
export function runPassPlan(ids, impls, ctx, hooks) {
  const onBegin = typeof hooks?.onPassBegin === 'function' ? hooks.onPassBegin : null;
  const onEnd = typeof hooks?.onPassEnd === 'function' ? hooks.onPassEnd : null;
  const ran = [];
  for (const id of ids) {
    const fn = impls[id];
    if (typeof fn !== 'function') {
      throw new Error(
        `runPassPlan: '${id}' is planned (status:'live' in graph/passes.js) but no implementation was ` +
          `registered for it. A live pass with no real code is exactly the drift graph/pass-impls.js exists ` +
          `to catch — this is that check running against a live frame instead of the static registry.`
      );
    }
    // The begin hook is deliberately INSIDE the loop and AFTER the impl check:
    // a missing impl throws before any zone is opened, so the error cannot be
    // mistaken for a pass that ran and cost nothing.
    if (onBegin) onBegin(id);
    try {
      fn(ctx);
    } finally {
      if (onEnd) onEnd(id);
    }
    ran.push(id);
  }
  return ran;
}
