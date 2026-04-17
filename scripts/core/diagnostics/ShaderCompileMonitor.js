/**
 * @fileoverview ShaderCompileMonitor - Centralized shader compilation tracking.
 *
 * Tracks shader compilation times, detects hangs/failures, and provides
 * graceful timeout-based fallback for all effects.
 *
 * Key features:
 * - Per-effect compile timing with automatic recording
 * - Configurable timeout (default 5s) with forced fallback
 * - Integration with HealthEvaluatorService for diagnostic reporting
 * - Compile failure tracking with error details
 * - Loading completion guarantee - never blocks scene load
 *
 * @module core/diagnostics/ShaderCompileMonitor
 */

import { createLogger } from '../log.js';

const log = createLogger('ShaderCompile');

/**
 * Single shader compile attempt record.
 * @typedef {Object} CompileRecord
 * @property {string} effectId - Effect identifier (e.g., 'WaterEffectV2')
 * @property {string} shaderType - 'vertex' | 'fragment' | 'program'
 * @property {number} startTimeMs - When compile started
 * @property {number|null} endTimeMs - When compile finished (null if pending)
 * @property {number|null} durationMs - Compile duration (null if pending)
 * @property {'success'|'timeout'|'error'|'pending'} status - Compile status
 * @property {Error|null} error - Error object if failed
 * @property {string|null} errorMessage - Human-readable error
 * @property {number} shaderLines - Approximate shader line count (for complexity tracking)
 * @property {boolean} usedFallback - Whether fallback shader was used
 */

/**
 * Centralized monitor for shader compilation across all effects.
 */
export class ShaderCompileMonitor {
  constructor() {
    /** @type {Map<string, CompileRecord>} */
    this._activeCompiles = new Map();
    /** @type {CompileRecord[]} */
    this._history = [];
    /** @type {number} Default timeout in ms */
    this.defaultTimeoutMs = 5000;
    /** @type {number} Maximum shader lines before warning */
    this.complexityWarningLines = 500;
    /** @type {Function|null} Callback for HealthEvaluatorService integration */
    this._healthCallback = null;
    /** @type {boolean} */
    this._initialized = false;
  }

  initialize() {
    if (this._initialized) return;
    this._initialized = true;
    log.info('ShaderCompileMonitor initialized');
  }

  dispose() {
    // Clear all pending timeouts
    for (const [key, record] of this._activeCompiles) {
      if (record._timeoutId) {
        clearTimeout(record._timeoutId);
      }
    }
    this._activeCompiles.clear();
    this._history = [];
    this._healthCallback = null;
    this._initialized = false;
  }

  /**
   * Register a callback for health reporting integration.
   * @param {Function} callback - Called with (effectId, record) on compile completion
   */
  setHealthCallback(callback) {
    this._healthCallback = callback;
  }

  /**
   * Begin tracking a shader compilation.
   * @param {string} effectId - Effect identifier
   * @param {string} shaderType - 'vertex', 'fragment', or 'program'
   * @param {string} shaderSource - Source code (for line count)
   * @param {Object} options
   * @param {number} [options.timeoutMs] - Custom timeout
   * @returns {string} compileKey - Use this to end tracking
   */
  beginCompile(effectId, shaderType, shaderSource, options = {}) {
    const key = `${effectId}|${shaderType}|${Date.now()}`;
    const lineCount = shaderSource ? shaderSource.split('\n').length : 0;

    /** @type {CompileRecord} */
    const record = {
      effectId,
      shaderType,
      startTimeMs: performance?.now?.() ?? Date.now(),
      endTimeMs: null,
      durationMs: null,
      status: 'pending',
      error: null,
      errorMessage: null,
      shaderLines: lineCount,
      usedFallback: false,
      _timeoutId: null,
    };

    // Warn about complex shaders
    if (lineCount > this.complexityWarningLines) {
      log.warn(`[${effectId}] Complex ${shaderType} shader: ${lineCount} lines (may cause compile hangs)`);
    }

    // Set timeout for forced fallback
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    record._timeoutId = setTimeout(() => {
      this._handleTimeout(key);
    }, timeoutMs);

    this._activeCompiles.set(key, record);
    log.debug(`[${effectId}] ${shaderType} compile started (${lineCount} lines, ${timeoutMs}ms timeout)`);

    return key;
  }

  /**
   * Mark a compilation as successful.
   * @param {string} key - From beginCompile()
   * @returns {CompileRecord|null}
   */
  endCompileSuccess(key) {
    const record = this._activeCompiles.get(key);
    if (!record) return null;

    // Clear timeout
    if (record._timeoutId) {
      clearTimeout(record._timeoutId);
      record._timeoutId = null;
    }

    const endTime = performance?.now?.() ?? Date.now();
    record.endTimeMs = endTime;
    record.durationMs = endTime - record.startTimeMs;
    record.status = 'success';

    this._activeCompiles.delete(key);
    this._history.push(record);

    log.info(`[${record.effectId}] ${record.shaderType} compiled in ${record.durationMs.toFixed(1)}ms (${record.shaderLines} lines)`);

    this._notifyHealth(record);
    return record;
  }

  /**
   * Mark a compilation as failed.
   * @param {string} key - From beginCompile()
   * @param {Error} error - The compilation error
   * @param {boolean} [usedFallback=false] - Whether fallback was used
   * @returns {CompileRecord|null}
   */
  endCompileError(key, error, usedFallback = false) {
    const record = this._activeCompiles.get(key);
    if (!record) return null;

    // Clear timeout
    if (record._timeoutId) {
      clearTimeout(record._timeoutId);
      record._timeoutId = null;
    }

    const endTime = performance?.now?.() ?? Date.now();
    record.endTimeMs = endTime;
    record.durationMs = endTime - record.startTimeMs;
    record.status = usedFallback ? 'timeout' : 'error';
    record.error = error;
    record.errorMessage = error?.message || String(error);
    record.usedFallback = usedFallback;

    this._activeCompiles.delete(key);
    this._history.push(record);

    const statusLabel = usedFallback ? 'TIMEOUT (fallback used)' : 'ERROR';
    log.error(`[${record.effectId}] ${record.shaderType} ${statusLabel}: ${record.errorMessage}`);

    this._notifyHealth(record);
    return record;
  }

  /**
   * Handle compile timeout - forces fallback.
   * @private
   */
  _handleTimeout(key) {
    const record = this._activeCompiles.get(key);
    if (!record) return;

    record._timeoutId = null;
    const error = new Error(`Shader compile timeout after ${this.defaultTimeoutMs}ms`);
    this.endCompileError(key, error, true);

    // Log critical warning
    log.error(`[CRITICAL] ${record.effectId} shader compile HUNG - forcing fallback to prevent load blockage`);
  }

  /**
   * Notify health callback if registered.
   * @private
   */
  _notifyHealth(record) {
    if (this._healthCallback) {
      try {
        this._healthCallback(record.effectId, record);
      } catch (e) {
        log.warn('Health callback error:', e);
      }
    }
  }

  /**
   * Get compile statistics for all effects.
   * @returns {Object}
   */
  getStats() {
    const stats = {
      totalCompiles: this._history.length,
      activeCompiles: this._activeCompiles.size,
      successes: 0,
      timeouts: 0,
      errors: 0,
      byEffect: new Map(),
      slowestCompile: null,
    };

    for (const rec of this._history) {
      if (rec.status === 'success') stats.successes++;
      if (rec.status === 'timeout') stats.timeouts++;
      if (rec.status === 'error') stats.errors++;

      // Per-effect stats
      if (!stats.byEffect.has(rec.effectId)) {
        stats.byEffect.set(rec.effectId, {
          count: 0,
          totalMs: 0,
          avgMs: 0,
          maxMs: 0,
          timeouts: 0,
          errors: 0,
        });
      }
      const eff = stats.byEffect.get(rec.effectId);
      eff.count++;
      eff.totalMs += rec.durationMs || 0;
      eff.avgMs = eff.totalMs / eff.count;
      eff.maxMs = Math.max(eff.maxMs, rec.durationMs || 0);
      if (rec.status === 'timeout') eff.timeouts++;
      if (rec.status === 'error') eff.errors++;

      // Track slowest
      if (!stats.slowestCompile || (rec.durationMs > stats.slowestCompile.durationMs)) {
        stats.slowestCompile = rec;
      }
    }

    return stats;
  }

  /**
   * Get pending/active compiles.
   * @returns {CompileRecord[]}
   */
  getPendingCompiles() {
    return Array.from(this._activeCompiles.values());
  }

  /**
   * Get compile history (optionally filtered).
   * @param {string} [effectId] - Filter by effect
   * @returns {CompileRecord[]}
   */
  getHistory(effectId = null) {
    if (!effectId) return [...this._history];
    return this._history.filter(r => r.effectId === effectId);
  }

  /**
   * Get diagnostic snapshot for reporting.
   * @returns {Object}
   */
  getDiagnosticSnapshot() {
    const stats = this.getStats();
    return {
      timestamp: new Date().toISOString(),
      summary: {
        totalCompiles: stats.totalCompiles,
        successes: stats.successes,
        timeouts: stats.timeouts,
        errors: stats.errors,
        activeCompiles: stats.activeCompiles,
      },
      slowestCompile: stats.slowestCompile ? {
        effectId: stats.slowestCompile.effectId,
        shaderType: stats.slowestCompile.shaderType,
        durationMs: stats.slowestCompile.durationMs,
        lines: stats.slowestCompile.shaderLines,
      } : null,
      byEffect: Array.from(stats.byEffect.entries()).map(([id, s]) => ({
        effectId: id,
        count: s.count,
        avgMs: Math.round(s.avgMs * 10) / 10,
        maxMs: Math.round(s.maxMs * 10) / 10,
        timeouts: s.timeouts,
        errors: s.errors,
      })),
      pending: stats.activeCompiles > 0 ? this.getPendingCompiles().map(r => ({
        effectId: r.effectId,
        shaderType: r.shaderType,
        elapsedMs: (performance?.now?.() ?? Date.now()) - r.startTimeMs,
        lines: r.shaderLines,
      })) : [],
    };
  }

  /**
   * Force all pending compiles to complete (for shutdown).
   */
  forceCompleteAll() {
    for (const [key, record] of this._activeCompiles) {
      if (record._timeoutId) {
        clearTimeout(record._timeoutId);
        record._timeoutId = null;
      }
      this.endCompileError(key, new Error('Forced completion during shutdown'), true);
    }
  }
}

// Singleton instance
let _instance = null;

/**
 * Get or create the global ShaderCompileMonitor instance.
 * @returns {ShaderCompileMonitor}
 */
export function getShaderCompileMonitor() {
  if (!_instance) {
    _instance = new ShaderCompileMonitor();
  }
  return _instance;
}

/**
 * Reset the global instance (for testing).
 */
export function resetShaderCompileMonitor() {
  if (_instance) {
    _instance.dispose();
    _instance = null;
  }
}
