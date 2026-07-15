/**
 * @fileoverview LoadSession — centralized staleness + abort management for scene loads.
 *
 * Replaces the ad-hoc `isStale()` closure pattern with a proper session object that:
 * - Wraps a generation counter for staleness checks
 * - Provides an AbortController/AbortSignal for cancelling in-flight async work
 * - Exposes diagnostics (scene name, start time, duration)
 * - Automatically aborts the previous session when a new one starts
 *
 * Usage in canvas-replacement.js:
 *   const session = LoadSession.start(scene);
 *   if (session.aborted) return;           // guard check
 *   await fetch(url, { signal: session.signal }); // cancellable fetch
 *   session.finish();                       // mark complete
 *
 * @module core/load-session
 */

import { createLogger } from './log.js';

const log = createLogger('LoadSession');

/** @type {number} Monotonically increasing generation counter */
let _generation = 0;

/** @type {LoadSession|null} The currently active session */
let _current = null;

export class LoadSession {
  /**
   * @param {object} scene - Foundry scene document
   * @param {number} generation - Internal generation counter value
   */
  constructor(scene, generation) {
    /** @type {number} */
    this.generation = generation;

    /** @type {string} */
    this.sceneId = scene?.id ?? 'unknown';

    /** @type {string} */
    this.sceneName = scene?.name ?? 'unknown';

    /** @type {number} */
    this.startTime = performance.now();

    /** @type {number|null} */
    this.endTime = null;

    /** @type {AbortController} */
    this._abortController = new AbortController();

    /** @type {boolean} */
    this._finished = false;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * The AbortSignal for this session. Pass to fetch(), texture loaders, etc.
   * Automatically aborted when a newer session starts or when abort() is called.
   * @returns {AbortSignal}
   */
  get signal() {
    return this._abortController.signal;
  }

  /**
   * Whether this session has been superseded by a newer one or explicitly aborted.
   * @returns {boolean}
   */
  get aborted() {
    return this._abortController.signal.aborted || this.generation !== _generation;
  }

  /**
   * Convenience guard — returns true if the session is still valid (not stale).
   * Equivalent to `!session.aborted`.
   * @returns {boolean}
   */
  get active() {
    return !this.aborted;
  }

  /**
   * Elapsed time in milliseconds since the session started.
   * @returns {number}
   */
  get elapsedMs() {
    const end = this.endTime ?? performance.now();
    return end - this.startTime;
  }

  /**
   * Explicitly abort this session. Signals all listeners on `this.signal`.
   */
  abort() {
    if (!this._abortController.signal.aborted) {
      this._abortController.abort();
    }
  }

  /**
   * Mark this session as finished (successful completion).
   * Records the end time for diagnostics.
   */
  finish() {
    this._finished = true;
    this.endTime = performance.now();
    log.info(`Load session finished: "${this.sceneName}" in ${this.elapsedMs.toFixed(0)}ms`);
  }

  /**
   * Check if this session is stale. If stale, logs a debug message.
   * This is the direct replacement for the old `isStale()` closure.
   * @returns {boolean} true if stale (caller should bail out)
   */
  isStale() {
    if (this.aborted) {
      log.debug(`Session stale: gen=${this.generation}, current=${_generation}, scene="${this.sceneName}"`);
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Static factory
  // ---------------------------------------------------------------------------

  /**
   * Start a new load session for the given scene.
   * Automatically aborts any previous active session.
   *
   * @param {object} scene - Foundry scene document
   * @returns {LoadSession} The new active session
   */
  static start(scene) {
    // Abort previous session if one exists
    if (_current && !_current._abortController.signal.aborted) {
      log.info(`Aborting previous session (gen=${_current.generation}, scene="${_current.sceneName}") for new scene "${scene?.name}"`);
      _current.abort();
    }

    _generation++;
    const session = new LoadSession(scene, _generation);
    _current = session;

    log.info(`Load session started: gen=${session.generation}, scene="${session.sceneName}"`);
    return session;
  }

  /**
   * Get the currently active session, or null if none.
   * @returns {LoadSession|null}
   */
  static current() {
    return _current;
  }
}
