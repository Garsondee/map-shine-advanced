/**
 * @fileoverview ui/load-progress.js — the loading model: what is happening, how
 * far along, and is the main thread actually alive.
 *
 * Pure. No DOM, no THREE, no Foundry — the overlay that draws this
 * (`ui/loading-screen.js`) is browser-only and separately verified live, but every
 * rule about what may be *claimed* lives here, where it can be tested.
 *
 * ## Honesty is the design constraint, not a nicety
 *
 * Keyhole.md §7 puts *"the 0%/98% two-gate warmup and its 'Ready!' lie"* on the
 * kill list by name. §4.5 specifies the replacement: reveal *"with **honest**
 * progress (pages resident / pages needed)"*. So the rules here are load-bearing:
 *
 * - **An unknown total reports `fraction: null`, never a guess.** Before the scene's
 *   items are enumerated we genuinely do not know how much work there is. A bar
 *   that invents a number for that window is the same lie as the 98% gate, just
 *   better dressed.
 * - **No cross-phase weighting.** Phases have no honest relative cost (reading
 *   documents is instant; streaming art is the entire load), so blending them into
 *   one percentage would be fiction. `fraction` describes the ACTIVE phase only,
 *   and the label always says which phase that is.
 * - **`complete` is only ever set by {@link completeLoad}.** It cannot be inferred
 *   from counters reaching their totals — "all items reported" is not "the first
 *   frame is on screen", and the gap between those two is exactly where the old
 *   "Ready!" lie lived.
 *
 * ## Liveness: why the spinner must be allowed to freeze
 *
 * The author's requirement is that the user must not think Foundry has frozen. The
 * tempting answer — a CSS `@keyframes` spinner — is actively wrong here: CSS
 * animations run on the **compositor thread**, so they keep spinning perfectly
 * smoothly while the main thread is dead. That is the worst possible outcome: a
 * confident animation asserting health precisely when there is none.
 *
 * So liveness is driven by {@link recordTick} from `requestAnimationFrame`, and it
 * stops when the main thread stops. That is honest. The reassurance the author
 * actually wants comes from the other two signals, which a spinner cannot give:
 * real counters advancing, and — after a stall ends — an explicit "that step took
 * Xms" note. During a freeze the browser cannot paint anything anyway, so the only
 * choice available is whether to lie about it beforehand.
 *
 * `worstStallMs` is kept for the same reason the hitch log is: a load that
 * completes but stalled for 2s is a bug with a receipt, not a success.
 *
 * @module ui/load-progress
 */

/**
 * A frame gap above this means the main thread was blocked long enough for a
 * person to think the app has died.
 *
 * **This is NOT the renderer's hitch threshold, and this comment used to claim it
 * was** ("the same threshold the renderer's own hitch log uses, so the two agree
 * about what 'a stall' means"). They never agreed: `vt-pan-viewer.js` and
 * `diag/flight-recorder.js` both use **50ms** ("~3 frames at 60fps" — a visible
 * stutter), and this is **250ms** — five times larger, and a different question.
 * Both numbers are correct for their own job; neither substitutes for the other.
 *
 * Corrected 2026-07-17 rather than "fixed" by dragging one number to the other:
 * a stutter and an is-it-dead freeze are genuinely different measurements, and
 * collapsing them would lose information to make a comment true. What was wrong
 * was the CLAIM, not the value. (memory: `feedback_probed_constants_vs_derived`
 * — a constant voted on independently in two places, with prose asserting they
 * agree, is a fiction with tenure.)
 */
export const STALL_THRESHOLD_MS = 250;

/** @enum {string} The phases of a scene load, in order. */
export const LOAD_PHASES = Object.freeze({
  /** Reading Scene documents into a draw list. Effectively instant. */
  SCENE: 'scene',
  /** Finding which authored mask files exist per floor (foundry/mask-discovery.js).
   * Usually near-instant (one directory listing) — but the probe fallback (listing
   * denied, or an absolute CDN URL FilePicker cannot browse) is a bounded but real
   * sequence of network round trips, added 2026-07-17 specifically so that path
   * never sits silently inside SCENE's phase (exactly the unlabeled-wait shape
   * §7's kill list exists to forbid). */
  MASKS: 'masks',
  /** Streaming each item's coarse pins — the whole world, soft. THE load. */
  ART: 'art',
  /** Waiting for the first real frame to paint. */
  FIRST_FRAME: 'firstFrame',
});

const PHASE_LABELS = Object.freeze({
  [LOAD_PHASES.SCENE]: 'Reading the scene',
  [LOAD_PHASES.MASKS]: 'Finding masks',
  [LOAD_PHASES.ART]: 'Streaming map art',
  [LOAD_PHASES.FIRST_FRAME]: 'Drawing the first frame',
});

/**
 * @typedef {object} LoadState
 * @property {string} sceneId
 * @property {string} sceneName
 * @property {number} startedAtMs
 * @property {string|null} phase - the ACTIVE phase, or null before/after the load.
 * @property {number} done - the active phase's completed units.
 * @property {number|null} total - the active phase's total, or null if not yet known.
 * @property {string|null} detail - a short human note about the current unit.
 * @property {boolean} complete
 * @property {string|null} error - set iff the load failed.
 * @property {number|null} finishedAtMs
 * @property {number|null} lastTickMs - last liveness tick.
 * @property {number} worstStallMs - the longest gap between ticks this load.
 * @property {number} lastStallMs - the most recent stall, for the "that took Xms" note.
 * @property {PhaseSpan[]} phases - every phase entered, with its duration. See
 *   {@link beginPhase}.
 */

/**
 * One phase's stopwatch reading.
 *
 * **Why this lives in the pure model rather than in the flight recorder.** The
 * author's ask was *"how long different parts of loading took"*. The recorder
 * could have opened a span at each of `boot.js`'s three `beginSceneLoadPhase`
 * call sites — but that is a hand-kept list, and a fourth phase added later
 * would silently go unmeasured while the report still looked complete. The phase
 * transitions are already modelled HERE, and this module already receives the
 * clock as an input, so timing them here means a new phase is measured by
 * construction. It also rides into the export for free: `getLoadingScreenState()`
 * is already a registered read-only report, so the bundle picks this up with no
 * new wiring and no new coupling between `ui/` and `diag/`.
 *
 * @typedef {object} PhaseSpan
 * @property {string} phase
 * @property {number|null} startMs - relative to the load's start.
 * @property {number|null} endMs - null while the phase is still running.
 * @property {number|null} durMs - null if still running, or if no clock was given.
 * @property {string} [note] - set only when something is worth saying out loud.
 */

/**
 * @param {{sceneId:string, sceneName:string, nowMs:number}} args
 * @returns {LoadState}
 */
export function createLoadState({ sceneId, sceneName, nowMs }) {
  return {
    sceneId,
    sceneName,
    startedAtMs: nowMs,
    phase: null,
    done: 0,
    total: null,
    detail: null,
    complete: false,
    error: null,
    finishedAtMs: null,
    lastTickMs: null,
    worstStallMs: 0,
    lastStallMs: 0,
    phases: [],
  };
}

/**
 * Close whichever phase span is still open. Idempotent: with nothing open, or no
 * clock, it does nothing rather than inventing a number.
 * @param {LoadState} state @param {number|undefined} nowMs
 */
function closeOpenPhase(state, nowMs) {
  const open = state.phases.find((p) => p.endMs === null);
  if (!open) return;
  if (!Number.isFinite(nowMs)) {
    open.note = 'duration not measured — no clock was supplied to the call that ended this phase';
    return;
  }
  open.endMs = round2(nowMs - state.startedAtMs);
  open.durMs = open.startMs === null ? null : round2(open.endMs - open.startMs);
}

/**
 * Enter a phase. `total` is optional precisely because it is often genuinely
 * unknown at entry — pass it when it becomes known via {@link reportProgress}.
 *
 * Pass `nowMs` to get a phase duration out the other end. It is not defaulted to
 * a private clock reading because this module is pure by law (`time/one-clock`):
 * time is an INPUT here, handed in, never sampled. Omitting it still transitions
 * correctly — the span just says its duration is unmeasured rather than
 * reporting a confident NaN.
 *
 * @param {LoadState} state @param {string} phaseId
 * @param {{total?:number|null, detail?:string|null, nowMs?:number}} [opts]
 * @returns {LoadState} the same object (mutated — this is polled per frame).
 */
export function beginPhase(state, phaseId, { total = null, detail = null, nowMs } = {}) {
  closeOpenPhase(state, nowMs);
  state.phase = phaseId;
  state.done = 0;
  state.total = total;
  state.detail = detail;
  state.phases.push({
    phase: phaseId,
    startMs: Number.isFinite(nowMs) ? round2(nowMs - state.startedAtMs) : null,
    endMs: null,
    durMs: null,
    ...(Number.isFinite(nowMs) ? {} : { note: 'start not measured — no clock was supplied to beginPhase' }),
  });
  return state;
}

/**
 * Report progress within the active phase.
 * @param {LoadState} state @param {string} phaseId
 * @param {{done?:number, total?:number|null, detail?:string|null, nowMs?:number}} opts
 * @returns {LoadState}
 */
export function reportProgress(state, phaseId, { done, total, detail, nowMs } = {}) {
  // A progress report for a phase we are not in IS a phase transition — and it
  // must be timed like one, or a phase entered only this way would be the one
  // phase with no duration.
  if (state.phase !== phaseId) beginPhase(state, phaseId, { nowMs });
  if (typeof done === 'number') state.done = done;
  if (total !== undefined) state.total = total;
  if (detail !== undefined) state.detail = detail;
  return state;
}

/**
 * The load succeeded. THE ONLY way `complete` becomes true — see this module's
 * header on why it must never be inferred from counters.
 * @param {LoadState} state @param {number} nowMs @returns {LoadState}
 */
export function completeLoad(state, nowMs) {
  closeOpenPhase(state, nowMs);
  state.complete = true;
  state.phase = null;
  state.detail = null;
  state.finishedAtMs = nowMs;
  return state;
}

/**
 * The load failed. Kept distinct from completion so a failed load can never be
 * mistaken for a finished one by anything reading this state.
 * @param {LoadState} state @param {string} error @param {number} nowMs @returns {LoadState}
 */
export function failLoad(state, error, nowMs) {
  // The phase that was running when it broke is the most interesting span in the
  // whole load — closing it here is what makes "it died 8s into streaming art"
  // readable instead of leaving the span dangling.
  closeOpenPhase(state, nowMs);
  state.error = error;
  state.complete = false;
  state.finishedAtMs = nowMs;
  return state;
}

/**
 * One liveness tick, from `requestAnimationFrame`. Returns the gap since the last
 * tick so the caller can react; also accumulates the stall statistics.
 *
 * A "stall" here is simply a long gap between ticks — which is the only thing that
 * can be observed, because during the stall nothing runs at all. See this module's
 * header for why that honesty is the point rather than a limitation.
 *
 * @param {LoadState} state @param {number} nowMs @returns {number} gap since the previous tick (0 on the first).
 */
export function recordTick(state, nowMs) {
  const gap = state.lastTickMs === null ? 0 : nowMs - state.lastTickMs;
  state.lastTickMs = nowMs;
  if (gap >= STALL_THRESHOLD_MS) {
    state.lastStallMs = gap;
    if (gap > state.worstStallMs) state.worstStallMs = gap;
  }
  return gap;
}

/**
 * @typedef {object} LoadDescription
 * @property {string} title - the headline ("Streaming map art").
 * @property {string|null} detail - the sub-line ("3 of 7 · Ground Floor").
 * @property {number|null} fraction - 0..1 for the ACTIVE phase, or null when the
 *   total is unknown. Never a guess, never > 1.
 * @property {number} elapsedMs
 * @property {string|null} stallNote - set only AFTER a stall ends.
 * @property {boolean} complete
 * @property {string|null} error
 */

/**
 * Render the state into something displayable. Pure — the overlay does no thinking.
 *
 * @param {LoadState} state @param {number} nowMs @returns {LoadDescription}
 */
export function describeLoad(state, nowMs) {
  const elapsedMs = Math.max(0, (state.finishedAtMs ?? nowMs) - state.startedAtMs);

  if (state.error) {
    return {
      title: 'Map Shine Advanced could not load this scene',
      detail: state.error,
      fraction: null,
      elapsedMs,
      stallNote: null,
      complete: false,
      error: state.error,
    };
  }
  if (state.complete) {
    return { title: 'Ready', detail: null, fraction: 1, elapsedMs, stallNote: null, complete: true, error: null };
  }

  const title = PHASE_LABELS[state.phase] ?? 'Preparing';

  // fraction: honest or absent. An unknown total yields null — see the header.
  let fraction = null;
  if (typeof state.total === 'number' && state.total > 0) {
    fraction = Math.max(0, Math.min(1, state.done / state.total));
  }

  const parts = [];
  if (typeof state.total === 'number' && state.total > 0) parts.push(`${state.done} of ${state.total}`);
  if (state.detail) parts.push(state.detail);

  // The stall note exists to answer "is it dead?" AFTER the fact — the only time
  // it can be answered, since nothing runs during the stall itself.
  const stallNote =
    state.lastStallMs >= STALL_THRESHOLD_MS
      ? `still working — the last step took ${(state.lastStallMs / 1000).toFixed(1)}s`
      : null;

  return {
    title,
    detail: parts.length ? parts.join(' · ') : null,
    fraction,
    elapsedMs,
    stallNote,
    complete: false,
    error: null,
  };
}

/**
 * Should a scene load show a curtain at all?
 *
 * **THE FLOOR-SWITCH GUARANTEE**, and the reason it is a pure function with its own
 * tests rather than a condition buried in a hook: Keyhole.md §4.5 promises *"floor
 * changes without loading screens"*, and §7 puts the level-transition curtain on
 * the kill list. But Foundry gives us no help — `Scene#view` (scene.mjs:280) calls
 * `canvas.draw()` on `sceneChanged || levelChanged`, and `draw()` fires BOTH
 * `canvasInit` and `canvasReady`. **A floor switch is indistinguishable from a
 * scene change by hook alone.** The id comparison is the only thing standing
 * between the author's headline promise and a curtain flashing on every floor
 * change.
 *
 * Compares against the last STARTED load, not the last completed one: a load that
 * fails or is interrupted must still suppress the curtain for subsequent floor
 * switches within that same scene, or a failed load would leave every later floor
 * change flashing a curtain.
 *
 * @param {string|null} lastSceneId - the scene whose load was last STARTED.
 * @param {string|null} nextSceneId - the scene `canvasInit` is now drawing.
 * @returns {{show:boolean, reason:string}}
 */
export function shouldShowForScene(lastSceneId, nextSceneId) {
  if (!nextSceneId) return { show: false, reason: 'no scene' };
  if (lastSceneId === nextSceneId) {
    return { show: false, reason: 'same scene — this is a floor switch or a redraw, not a scene load' };
  }
  return { show: true, reason: lastSceneId ? 'scene changed' : 'cold load' };
}

/** @param {number} v @returns {number} */
function round2(v) {
  return Math.round(v * 100) / 100;
}
