/**
 * @fileoverview GpuPassTimer — per-pass GPU timings for the V3 frame graph via
 * `EXT_disjoint_timer_query_webgl2` (Forward+ §16.3 P1; promised by B0-2 §2
 * rule 3: "EXT_disjoint_timer_query_webgl2 GPU timings when available").
 *
 * Injected into {@link FrameGraph} like the allocator, so the graph core stays
 * THREE-free and Node-testable — the graph only calls the small interface
 * `{ frameBegin(), begin(name), end(), getResults() }`, and tests inject a fake.
 *
 * ## Design constraints
 * - **One `TIME_ELAPSED_EXT` query may be active at a time** (WebGL2 spec).
 *   Passes are timed sequentially (begin → pass GL work → end), which is legal.
 *   `PerformanceRecorder` (diagnostics) uses the same extension for whole-frame
 *   timing; to avoid corrupting each other, {@link GpuPassTimer#begin} checks
 *   `gl.getQuery(TIME_ELAPSED_EXT, gl.CURRENT_QUERY)` and *skips* the pass when
 *   any other query is already active. Skipping loses one datapoint; ending
 *   someone else's query would corrupt both. Never nest, never steal.
 * - **Results are asynchronous** (typically available 1–3 frames later).
 *   Pending queries are polled at `frameBegin()`; resolved values land in a
 *   name → ms map that always holds the *latest completed* measurement per pass.
 *   Consumers must treat the values as "recent", not "this frame".
 * - **Disjoint events invalidate in-flight queries.** Reading
 *   `gl.getParameter(ext.GPU_DISJOINT_EXT)` at poll time both checks and resets
 *   the flag; when set, every pending query is dropped unread (per spec their
 *   results are unreliable).
 * - **Fail quiet, fail once.** The extension is unavailable on some
 *   browsers/drivers (e.g. Firefox removed it). When absent — or after repeated
 *   GL errors (context loss) — the timer disables itself and every method is a
 *   cheap no-op. GPU timing is a diagnostic luxury, never a crash source.
 *
 * @module compositor-v3/GpuPassTimer
 */

import { createLogger } from '../core/log.js';

const log = createLogger('V3GpuPassTimer');

/** Upper bound on in-flight queries; beyond it new begins are skipped. */
const MAX_PENDING = 32;
/** Consecutive begin/poll failures before the timer self-disables. */
const MAX_ERRORS = 8;

export class GpuPassTimer {
  /**
   * @param {object} options
   * @param {WebGL2RenderingContext} options.gl - The live GL context (from
   *   `renderer.getContext()`).
   */
  constructor(options = {}) {
    /** @type {WebGL2RenderingContext|null} */
    this._gl = options.gl ?? null;
    /** @type {any|null} EXT_disjoint_timer_query_webgl2, or null when absent. */
    this._ext = null;
    /** @type {boolean} */
    this._supported = false;
    /** @type {boolean} Set true after repeated errors; everything no-ops. */
    this._dead = false;
    this._errorCount = 0;

    /** @type {Array<{query: WebGLQuery, name: string}>} FIFO of unresolved queries. */
    this._pending = [];
    /** @type {WebGLQuery[]} Recycled query objects. */
    this._free = [];
    /** @type {Map<string, number>} pass name → latest completed GPU ms. */
    this._results = new Map();
    /** @type {{query: WebGLQuery, name: string}|null} The currently open query. */
    this._active = null;

    try {
      if (this._gl && typeof this._gl.getExtension === 'function') {
        this._ext = this._gl.getExtension('EXT_disjoint_timer_query_webgl2');
        this._supported = !!this._ext;
      }
    } catch (_) {
      this._supported = false;
    }
    if (this._supported) {
      log.info('GPU per-pass timing available (EXT_disjoint_timer_query_webgl2)');
    } else {
      log.debug('EXT_disjoint_timer_query_webgl2 unavailable — GPU pass timings disabled (CPU timings remain)');
    }
  }

  /** @returns {boolean} whether GPU timings can ever be produced. */
  isSupported() { return this._supported && !this._dead; }

  /**
   * Poll pending queries and fold completed results into the results map.
   * Call once per frame, before the first {@link GpuPassTimer#begin}.
   */
  frameBegin() {
    if (!this.isSupported() || !this._pending.length) return;
    const gl = this._gl;
    const ext = this._ext;
    try {
      // Reading GPU_DISJOINT_EXT both checks and resets it. A disjoint event
      // (power change, driver hiccup) makes in-flight results meaningless.
      if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        for (const p of this._pending) this._free.push(p.query);
        this._pending.length = 0;
        return;
      }
      // Resolve in submission order; stop at the first unavailable (later ones
      // can't be available before earlier ones on the same timeline).
      while (this._pending.length) {
        const head = this._pending[0];
        const available = gl.getQueryParameter(head.query, gl.QUERY_RESULT_AVAILABLE);
        if (!available) break;
        const ns = gl.getQueryParameter(head.query, gl.QUERY_RESULT);
        this._results.set(head.name, Number(ns) / 1e6);
        this._free.push(head.query);
        this._pending.shift();
      }
      this._errorCount = 0;
    } catch (err) {
      this._noteError('poll', err);
    }
  }

  /**
   * Open a TIME_ELAPSED query for the named pass. Skips (returns false) when a
   * query is already active — ours or anyone else's (see class docs).
   * @param {string} name
   * @returns {boolean} whether a query was actually opened
   */
  begin(name) {
    if (!this.isSupported() || this._active || this._pending.length >= MAX_PENDING) return false;
    const gl = this._gl;
    const ext = this._ext;
    try {
      // Someone else (PerformanceRecorder's frame query) may own the target.
      if (gl.getQuery(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) return false;
      const query = this._free.pop() ?? gl.createQuery();
      if (!query) return false;
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      this._active = { query, name };
      return true;
    } catch (err) {
      this._noteError('begin', err);
      return false;
    }
  }

  /** Close the query opened by the matching {@link GpuPassTimer#begin}. */
  end() {
    if (!this._active) return;
    const gl = this._gl;
    const ext = this._ext;
    const active = this._active;
    this._active = null;
    try {
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      this._pending.push(active);
    } catch (err) {
      this._free.push(active.query);
      this._noteError('end', err);
    }
  }

  /** @returns {Map<string, number>} pass name → latest completed GPU ms (live map, do not mutate). */
  getResults() { return this._results; }

  /**
   * @param {string} where
   * @param {any} err
   * @private
   */
  _noteError(where, err) {
    this._errorCount += 1;
    if (this._errorCount >= MAX_ERRORS && !this._dead) {
      this._dead = true;
      log.warn(`GPU pass timing self-disabled after repeated ${where} errors (context loss?)`, err);
    }
  }

  /** Delete every query object. Call on pipeline teardown. */
  dispose() {
    const gl = this._gl;
    try {
      if (this._active) { this._free.push(this._active.query); this._active = null; }
      for (const p of this._pending) this._free.push(p.query);
      this._pending.length = 0;
      if (gl && typeof gl.deleteQuery === 'function') {
        for (const q of this._free) { try { gl.deleteQuery(q); } catch (_) {} }
      }
    } catch (_) {}
    this._free.length = 0;
    this._results.clear();
  }
}
