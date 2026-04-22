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
export function safeCall(fn, context, severity = Severity.DEGRADED, options = {}) {
  try {
    const result = fn();

    // Handle async functions: wrap the promise with the same error handling
    if (result && typeof result.then === 'function') {
      return result.catch((error) => _handleError(error, context, severity, options));
    }

    return result;
  } catch (error) {
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
  try {
    return await fn();
  } catch (error) {
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
