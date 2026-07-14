/**
 * @fileoverview Consistent error handling utilities for Map Shine.
 * 
 * Replaces the ad-hoc try/catch patterns throughout the codebase with
 * a categorized severity system:
 * 
 * - **critical**: Rethrows — caller must handle or scene init aborts.
 * - **degraded**: Logs a warning and continues — feature is impaired but app works.
 * - **cosmetic**: Silently swallows — purely visual/optional feature failed.
 * 
 * Usage:
 *   import { safeCall, Severity } from '../core/safe-call.js';
 * 
 *   // Critical: will rethrow if fn throws
 *   await safeCall(() => lightingEffect.initialize(), 'LightingEffect.init', Severity.CRITICAL);
 * 
 *   // Degraded: logs warning, returns undefined
 *   safeCall(() => gridRenderer.updateGrid(), 'GridRenderer.updateGrid', Severity.DEGRADED);
 * 
 *   // Cosmetic: silently swallows
 *   safeCall(() => loadingOverlay.setProgress(0.5), 'overlay.progress', Severity.COSMETIC);
 * 
 * @module core/safe-call
 */

import { createLogger } from './log.js';

const log = createLogger('SafeCall');

/**
 * Error severity categories.
 * @enum {string}
 */
export const Severity = Object.freeze({
  /** Rethrow the error — caller or scene init must handle it. */
  CRITICAL: 'critical',
  /** Log a warning and continue — feature is degraded but app works. */
  DEGRADED: 'degraded',
  /** Silently swallow — purely optional/cosmetic feature. */
  COSMETIC: 'cosmetic',
});

/**
 * Execute a function with categorized error handling.
 * 
 * @param {Function} fn - The function to execute (may be sync or async).
 * @param {string} context - Human-readable label for logging (e.g., 'LightingEffect.init').
 * @param {string} [severity=Severity.DEGRADED] - How to handle errors.
 * @param {Object} [options] - Additional options.
 * @param {*} [options.fallback] - Value to return on error (default: undefined).
 * @param {Function} [options.onError] - Optional callback invoked with the error before handling.
 * @returns {*} The return value of fn, or options.fallback on error.
 */
/**
 * Record a labelled section that blocked the main thread for a long time.
 *
 * Crash reports show multi-second synchronous stalls during `binding_effects`
 * that contain no single slow GL call (Forward+ §13.6) — i.e. the block is
 * CPU-side JS. Because nearly every load step already runs inside a labelled
 * `safeCall`/`safeCallAsync`, timing them attributes the stall to a named
 * section for free. Only the *synchronous* span is measured (async work that
 * yields is not a main-thread block).
 *
 * @param {string} context
 * @param {number} durMs
 */
function _recordSlowSection(context, durMs, kind = 'sync') {
  if (durMs < 250) return;
  try {
    const g = globalThis;
    g.__msaSlowSections = g.__msaSlowSections || [];
    g.__msaSlowSections.push({
      context: String(context ?? 'unknown').slice(0, 80),
      kind,
      durMs: Math.round(durMs),
      atMs: Math.round(performance.now() - durMs),
    });
    if (g.__msaSlowSections.length > 32) g.__msaSlowSections.shift();
  } catch (_) {}
}

// Entry-breadcrumb ring depth. Raised well beyond the count of safeCalls that
// fire in the recovery/teardown burst *after* a stall — otherwise that burst
// flushes the pre-stall breadcrumb (the culprit) before the crash report reads
// the ring. This was the direct cause of A10 staying unattributed on 2026-07-14
// (Forward+ §"Open issues board"): the ring emitted only post-stall labels.
const SECTION_TRAIL_MAX = 512;

// Gap-witness thresholds. A gap between two consecutive section *starts* longer
// than this means the previous section's body held the main thread (or an
// untracked block ran) across that gap. We capture generously (idle awaits also
// produce gaps); the crash-report diagnosis separates real stalls from idle
// awaits by cross-referencing each witness against the `longTasks` ring.
const STALL_WITNESS_MIN_GAP_MS = 700;
const STALL_WITNESS_MAX = 48;

let _sectionSeq = 0;

/**
 * Preserve a section that was executing when a long main-thread gap elapsed.
 *
 * This is the load-bearing fix for A10 attribution. Unlike the entry-breadcrumb
 * ring — which the post-stall burst of safeCalls can overwrite — a witness is
 * captured the instant the gap is *detected* (the first section-start after the
 * stall ends), copied into a small dedicated list, and retained by *largest
 * gap* rather than FIFO. So the ~8.8 s TDR stall's witness cannot be evicted by
 * a flood of sub-second entries that follow it.
 * @param {{context: string, startMs: number, kind?: string, seq?: number}} mark
 * @param {number} gapMs
 * @param {number} observedAtMs
 */
function _recordStallWitness(mark, gapMs, observedAtMs) {
  try {
    const g = globalThis;
    g.__msaStallWitnesses = g.__msaStallWitnesses || [];
    g.__msaStallWitnesses.push({
      context: mark.context,
      kind: mark.kind ?? 'sync',
      startMs: Math.round(mark.startMs),
      gapMs: Math.round(gapMs),
      observedAtMs: Math.round(observedAtMs),
      seq: mark.seq ?? null,
    });
    if (g.__msaStallWitnesses.length > STALL_WITNESS_MAX) {
      // Evict the smallest gap so the multi-second stalls always survive.
      let minIdx = 0;
      for (let i = 1; i < g.__msaStallWitnesses.length; i++) {
        if ((g.__msaStallWitnesses[i].gapMs ?? 0) < (g.__msaStallWitnesses[minIdx].gapMs ?? 0)) minIdx = i;
      }
      g.__msaStallWitnesses.splice(minIdx, 1);
    }
  } catch (_) {}
}

/**
 * Breadcrumb: remember that a labelled section *started*, even if it never
 * finishes (a context loss mid-block leaves no completion record). The crash
 * report's `sectionTrail` shows what was running when a stall began, and the
 * gap-witness (below) preserves the specific section a long stall ran inside.
 * @param {string} context
 * @param {string} [kind='sync'] one of sync | async | marked | marked-async
 */
function _markSectionStart(context, kind = 'sync') {
  try {
    const g = globalThis;
    const now = performance.now();
    const ctx = String(context ?? 'unknown').slice(0, 80);
    const seq = ++_sectionSeq;

    // Gap-witness: was the *previous* section still the last thing that started
    // when a long gap elapsed? If so it (very likely) ran across that gap —
    // capture it before the post-stall burst can bury it. Ground-truth "was this
    // a real main-thread block vs an idle await?" is left to the report, which
    // intersects the witness window with the longTasks ring.
    const prev = g.__msaLastSectionMark;
    if (prev) {
      const gapMs = now - prev.startMs;
      if (gapMs >= STALL_WITNESS_MIN_GAP_MS) _recordStallWitness(prev, gapMs, now);
    }
    g.__msaLastSectionMark = { context: ctx, startMs: now, kind, seq };

    g.__msaSectionTrail = g.__msaSectionTrail || [];
    g.__msaSectionTrail.push({ context: ctx, startMs: Math.round(now), kind, seq });
    if (g.__msaSectionTrail.length > SECTION_TRAIL_MAX) g.__msaSectionTrail.shift();
  } catch (_) {}
}

/**
 * Time an arbitrary synchronous block and record it if slow. Use to attribute
 * multi-second stalls that do not sit inside a labelled safeCall (§13.7).
 *
 * @template T
 * @param {string} label
 * @param {() => T} fn
 * @returns {T}
 */
export function markSection(label, fn) {
  const t0 = performance.now();
  _markSectionStart(label, 'marked');
  try {
    return fn();
  } finally {
    _recordSlowSection(label, performance.now() - t0, 'marked');
  }
}

/**
 * Async variant of {@link markSection}. Drops a breadcrumb immediately before
 * the call (so the gap-witness resolves a mid-call TDR stall to THIS label) and
 * times the synchronous prologue (the body up to the first `await`, which is a
 * real main-thread block). A stall in a post-`await` continuation is attributed
 * by the gap-witness, not by prologue timing — do not switch this to total-await
 * timing, which would falsely flag idle I/O awaits as stalls.
 *
 * Use to wrap the heavy, currently-unlabelled load-path init calls
 * (`graphicsSettings.initialize()`, `uiManager.initialize()`, …) so the
 * reload/settings TDR stall (Forward+ A10) names the exact call next time.
 *
 * @template T
 * @param {string} label
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function markSectionAsync(label, fn) {
  const t0 = performance.now();
  _markSectionStart(label, 'marked-async');
  const promise = fn();
  _recordSlowSection(label, performance.now() - t0, 'marked-async-prologue');
  return await promise;
}

export function safeCall(fn, context, severity = Severity.DEGRADED, options = {}) {
  const _t0 = performance.now();
  _markSectionStart(context, 'sync');
  try {
    const result = fn();

    // Handle async functions: wrap the promise with the same error handling
    if (result && typeof result.then === 'function') {
      // Only the synchronous portion counts as a main-thread block.
      _recordSlowSection(context, performance.now() - _t0);
      return result.catch((error) => _handleError(error, context, severity, options));
    }

    _recordSlowSection(context, performance.now() - _t0);
    return result;
  } catch (error) {
    _recordSlowSection(context, performance.now() - _t0);
    return _handleError(error, context, severity, options);
  }
}

/**
 * Async variant of safeCall. Awaits the function and handles errors.
 * Prefer this when the function is known to be async.
 * 
 * @param {Function} fn - Async function to execute.
 * @param {string} context - Human-readable label for logging.
 * @param {string} [severity=Severity.DEGRADED] - How to handle errors.
 * @param {Object} [options] - Additional options.
 * @param {*} [options.fallback] - Value to return on error.
 * @param {Function} [options.onError] - Optional error callback.
 * @returns {Promise<*>} The return value of fn, or options.fallback on error.
 */
export async function safeCallAsync(fn, context, severity = Severity.DEGRADED, options = {}) {
  const _t0 = performance.now();
  _markSectionStart(context, 'async');
  try {
    // Calling fn() runs its body synchronously up to the first `await`. That
    // prologue IS a main-thread block and is exactly what the earlier
    // instrument missed (safeCallAsync was not timed at all, so the 4.6 s
    // stall had no matching slowSections entry — Forward+ §13.7).
    const promise = fn();
    _recordSlowSection(context, performance.now() - _t0, 'sync-prologue');
    return await promise;
  } catch (error) {
    _recordSlowSection(context, performance.now() - _t0, 'sync-prologue');
    return _handleError(error, context, severity, options);
  }
}

/**
 * Internal error handler that dispatches based on severity.
 * @private
 */
function _handleError(error, context, severity, options = {}) {
  // Invoke optional callback before severity dispatch
  if (typeof options.onError === 'function') {
    try {
      options.onError(error);
    } catch (_) {
      // Don't let the error callback itself throw
    }
  }

  switch (severity) {
    case Severity.CRITICAL:
      log.error(`[CRITICAL] ${context}:`, error);
      throw error;

    case Severity.DEGRADED:
      log.warn(`[degraded] ${context}:`, error);
      return options.fallback;

    case Severity.COSMETIC:
      // Silent — only log at debug level for development
      log.debug(`[cosmetic] ${context}:`, error?.message ?? error);
      return options.fallback;

    default:
      log.warn(`[unknown severity: ${severity}] ${context}:`, error);
      return options.fallback;
  }
}

/**
 * Wrap a dispose/cleanup call. Logs a warning on failure but never throws.
 * Shorthand for safeCall(fn, context, Severity.DEGRADED).
 * 
 * @param {Function} fn - Cleanup function.
 * @param {string} context - Label for logging.
 */
export function safeDispose(fn, context) {
  return safeCall(fn, context, Severity.DEGRADED);
}
