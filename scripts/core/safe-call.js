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
    if (g.__msaSlowSections.length > 24) g.__msaSlowSections.shift();
  } catch (_) {}
}

/**
 * Breadcrumb: remember that a labelled section *started*, even if it never
 * finishes (a context loss mid-block leaves no completion record). The crash
 * report's `sectionTrail` then shows what was running when a stall began.
 * @param {string} context
 */
function _markSectionStart(context) {
  try {
    const g = globalThis;
    g.__msaSectionTrail = g.__msaSectionTrail || [];
    g.__msaSectionTrail.push({
      context: String(context ?? 'unknown').slice(0, 80),
      startMs: Math.round(performance.now()),
    });
    // Deep enough to survive the burst of safeCalls that follows a long stall
    // (a 32-deep ring was fully flushed before the report was taken, §13.8).
    if (g.__msaSectionTrail.length > 160) g.__msaSectionTrail.shift();
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
  try {
    return fn();
  } finally {
    _recordSlowSection(label, performance.now() - t0, 'marked');
  }
}

export function safeCall(fn, context, severity = Severity.DEGRADED, options = {}) {
  const _t0 = performance.now();
  _markSectionStart(context);
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
  _markSectionStart(context);
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
