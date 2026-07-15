/**
 * @fileoverview LoadCoordinator — V14-aligned single-authority load state machine.
 *
 * Replaces the implicit lifecycle previously spread across canvas-replacement.js,
 * module.js, and ad-hoc bootstrap polling. Every scene load/teardown now passes
 * through a single, auditable state machine with hard invariant gates.
 *
 * State machine:
 *   idle → awaiting_canvas_ready → preparing_context → initializing_compositor
 *     → populating_floors → binding_effects → compiling_warmup → activating
 *     → running
 *
 * Failure exits:
 *   Any state → degraded (recoverable) or failed (terminal for this session)
 *
 * Cancellation:
 *   canvasTearDown or new scene → aborts current session via LoadSession.
 *
 * @module core/LoadCoordinator
 */

import { createLogger } from './log.js';

const log = createLogger('LoadCoordinator');

/**
 * All valid coordinator states.
 * @readonly
 * @enum {string}
 */
export const CoordinatorState = Object.freeze({
  IDLE:                       'idle',
  AWAITING_CANVAS_READY:      'awaiting_canvas_ready',
  PREPARING_CONTEXT:          'preparing_context',
  INITIALIZING_COMPOSITOR:    'initializing_compositor',
  POPULATING_FLOORS:          'populating_floors',
  BINDING_EFFECTS:            'binding_effects',
  COMPILING_WARMUP:           'compiling_warmup',
  ACTIVATING:                 'activating',
  RUNNING:                    'running',
  DEGRADED:                   'degraded',
  FAILED:                     'failed',
});

const VALID_TRANSITIONS = new Map([
  [CoordinatorState.IDLE,                     [CoordinatorState.AWAITING_CANVAS_READY]],
  [CoordinatorState.AWAITING_CANVAS_READY,    [CoordinatorState.PREPARING_CONTEXT, CoordinatorState.DEGRADED, CoordinatorState.FAILED, CoordinatorState.IDLE]],
  [CoordinatorState.PREPARING_CONTEXT,        [CoordinatorState.INITIALIZING_COMPOSITOR, CoordinatorState.DEGRADED, CoordinatorState.FAILED, CoordinatorState.IDLE]],
  [CoordinatorState.INITIALIZING_COMPOSITOR,  [CoordinatorState.POPULATING_FLOORS, CoordinatorState.DEGRADED, CoordinatorState.FAILED, CoordinatorState.IDLE]],
  [CoordinatorState.POPULATING_FLOORS,        [CoordinatorState.BINDING_EFFECTS, CoordinatorState.DEGRADED, CoordinatorState.FAILED, CoordinatorState.IDLE]],
  [CoordinatorState.BINDING_EFFECTS,          [CoordinatorState.COMPILING_WARMUP, CoordinatorState.DEGRADED, CoordinatorState.FAILED, CoordinatorState.IDLE]],
  [CoordinatorState.COMPILING_WARMUP,         [CoordinatorState.ACTIVATING, CoordinatorState.DEGRADED, CoordinatorState.FAILED, CoordinatorState.IDLE]],
  [CoordinatorState.ACTIVATING,               [CoordinatorState.RUNNING, CoordinatorState.DEGRADED, CoordinatorState.FAILED, CoordinatorState.IDLE]],
  [CoordinatorState.RUNNING,                  [CoordinatorState.IDLE, CoordinatorState.DEGRADED]],
  [CoordinatorState.DEGRADED,                 [CoordinatorState.IDLE, CoordinatorState.RUNNING, CoordinatorState.FAILED]],
  [CoordinatorState.FAILED,                   [CoordinatorState.IDLE]],
]);

/**
 * @typedef {Object} TransitionRecord
 * @property {string} from
 * @property {string} to
 * @property {number} timestamp
 * @property {string|null} reason
 */

/**
 * @typedef {Object} InvariantResult
 * @property {boolean} ok
 * @property {string[]} failures - Human-readable descriptions of what failed.
 */

export class LoadCoordinator {
  constructor() {
    /** @type {string} */
    this._state = CoordinatorState.IDLE;

    /** @type {TransitionRecord[]} */
    this._transitionLog = [];

    /** @type {number} */
    this._transitionLogMax = 200;

    /** @type {string|null} Current scene ID being loaded/running */
    this._sceneId = null;

    /** @type {string|null} */
    this._sceneName = null;

    /** @type {number} */
    this._stateEnteredAt = performance.now();

    /** @type {Function[]} */
    this._listeners = [];
  }

  // ---------------------------------------------------------------------------
  // Public read API
  // ---------------------------------------------------------------------------

  /** @returns {string} Current state */
  get state() { return this._state; }

  /** @returns {boolean} */
  get isRunning() { return this._state === CoordinatorState.RUNNING; }

  /** @returns {boolean} */
  get isDegraded() { return this._state === CoordinatorState.DEGRADED; }

  /** @returns {boolean} */
  get isFailed() { return this._state === CoordinatorState.FAILED; }

  /** @returns {boolean} True if the coordinator is actively loading (not idle/running/failed). */
  get isLoading() {
    return this._state !== CoordinatorState.IDLE
      && this._state !== CoordinatorState.RUNNING
      && this._state !== CoordinatorState.FAILED
      && this._state !== CoordinatorState.DEGRADED;
  }

  /** @returns {string|null} */
  get sceneId() { return this._sceneId; }

  /** @returns {number} ms since entering current state */
  get stateAge() { return performance.now() - this._stateEnteredAt; }

  /** @returns {ReadonlyArray<TransitionRecord>} */
  get transitionLog() { return this._transitionLog; }

  // ---------------------------------------------------------------------------
  // State transitions
  // ---------------------------------------------------------------------------

  /**
   * Transition to a new state with structured logging and validation.
   * @param {string} nextState - Target CoordinatorState value
   * @param {string} [reason] - Human-readable reason for diagnostics
   * @returns {boolean} True if the transition succeeded
   */
  transition(nextState, reason) {
    const from = this._state;

    if (from === nextState) {
      log.debug(`LoadCoordinator: no-op transition ${from} → ${nextState}`);
      return true;
    }

    const allowed = VALID_TRANSITIONS.get(from);
    if (!allowed || !allowed.includes(nextState)) {
      log.error(`LoadCoordinator: ILLEGAL transition ${from} → ${nextState} (reason: ${reason ?? 'none'})`);
      return false;
    }

    const record = {
      from,
      to: nextState,
      timestamp: performance.now(),
      reason: reason ?? null,
    };

    this._state = nextState;
    this._stateEnteredAt = record.timestamp;

    if (this._transitionLog.length >= this._transitionLogMax) {
      this._transitionLog.shift();
    }
    this._transitionLog.push(record);

    log.info(`LoadCoordinator: ${from} → ${nextState}${reason ? ` (${reason})` : ''}`);

    for (const fn of this._listeners) {
      try { fn(record); } catch (_) { /* listener errors must not break transitions */ }
    }

    return true;
  }

  /**
   * Begin a new scene load. Resets to AWAITING_CANVAS_READY.
   * @param {string} sceneId
   * @param {string} [sceneName]
   */
  beginSceneLoad(sceneId, sceneName) {
    if (this._state !== CoordinatorState.IDLE) {
      this.transition(CoordinatorState.IDLE, `reset for new scene load: ${sceneName ?? sceneId}`);
    }
    this._sceneId = sceneId;
    this._sceneName = sceneName ?? null;
    this.transition(CoordinatorState.AWAITING_CANVAS_READY, `scene: ${sceneName ?? sceneId}`);
  }

  /**
   * Handle canvasTearDown — cancel any in-progress load and return to idle.
   * @param {string} [reason]
   */
  tearDown(reason) {
    if (this._state === CoordinatorState.IDLE) return;
    this.transition(CoordinatorState.IDLE, reason ?? 'canvasTearDown');
    this._sceneId = null;
    this._sceneName = null;
  }

  /**
   * Enter degraded mode with a diagnostic reason.
   * @param {string} reason
   */
  enterDegraded(reason) {
    this.transition(CoordinatorState.DEGRADED, reason);
  }

  /**
   * Enter failed state — terminal for this load session.
   * @param {string} reason
   */
  enterFailed(reason) {
    this.transition(CoordinatorState.FAILED, reason);
  }

  // ---------------------------------------------------------------------------
  // Invariant checks
  // ---------------------------------------------------------------------------

  /**
   * Check hard invariants that must hold before entering RUNNING.
   *
   * @param {Object} ctx
   * @param {string} ctx.foundrySceneId - Current Foundry canvas scene ID
   * @param {boolean} ctx.busPopulated - FloorRenderBus._populateComplete
   * @param {Object} [ctx.effectBindings] - Per-effect binding coherence checks
   * @param {boolean} [ctx.enablementConsensus] - All gates agree on enable state
   * @returns {InvariantResult}
   */
  checkPreRunningInvariants(ctx) {
    const failures = [];

    // A) Context: active Foundry scene ID must match coordinator scene ID
    if (ctx.foundrySceneId !== this._sceneId) {
      failures.push(`Scene ID mismatch: coordinator=${this._sceneId}, foundry=${ctx.foundrySceneId}`);
    }

    // B) Populate: FloorRenderBus must be populated
    if (!ctx.busPopulated) {
      failures.push('FloorRenderBus not yet populated');
    }

    // C) Bindings: if provided, each effect binding must be coherent
    if (ctx.effectBindings) {
      for (const [effectId, binding] of Object.entries(ctx.effectBindings)) {
        if (binding.hasData && !binding.uniformsBound) {
          failures.push(`Effect "${effectId}": data exists but uniforms not bound`);
        }
        if (!binding.enabled && binding.uniformsBound) {
          failures.push(`Effect "${effectId}": disabled but uniforms still bound`);
        }
      }
    }

    // D) Enablement: if provided, all gates must agree
    if (ctx.enablementConsensus === false) {
      failures.push('Enablement consensus failed: UI, scene flags, and runtime disagree');
    }

    return { ok: failures.length === 0, failures };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle helpers
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to state transitions.
   * @param {Function} fn - Called with TransitionRecord on each transition.
   * @returns {Function} Unsubscribe function.
   */
  onTransition(fn) {
    this._listeners.push(fn);
    return () => {
      const idx = this._listeners.indexOf(fn);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  }

  /**
   * Get a diagnostic snapshot of the coordinator state.
   * @returns {Object}
   */
  getDiagnostics() {
    return {
      state: this._state,
      sceneId: this._sceneId,
      sceneName: this._sceneName,
      stateAgeMs: Math.round(this.stateAge),
      recentTransitions: this._transitionLog.slice(-10),
    };
  }
}

/** Singleton coordinator instance. */
export const loadCoordinator = new LoadCoordinator();
