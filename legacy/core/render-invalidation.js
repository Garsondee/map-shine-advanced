/**
 * @fileoverview Render invalidation system for expensive auxiliary passes
 * Prevents redundant rendering of cached targets when inputs haven't changed
 * @module core/render-invalidation.js
 */

import { createLogger } from './log.js';

const log = createLogger('RenderInvalidation');

/**
 * Tracks invalidation state for a cached render target
 * Determines whether a re-render is needed based on input changes
 */
export class RenderInvalidationTracker {
  constructor(id, options = {}) {
    this.id = id;
    
    // Input tracking
    this.inputs = new Map();
    this.lastInputHash = null;
    
    // Time-based invalidation
    this.lastRenderTime = 0;
    this.minRenderIntervalMs = options.minRenderIntervalMs ?? 0;
    
    // Change tracking
    this.changeThreshold = options.changeThreshold ?? 0.01; // 1% change triggers re-render
    this.trackingEnabled = true;
    
    log.debug(`RenderInvalidationTracker created: ${id}`);
  }

  /**
   * Register an input value to track
   * @param {string} key - Input identifier
   * @param {*} value - Current value
   */
  trackInput(key, value) {
    if (!this.trackingEnabled) return;
    
    const normalized = this._normalizeValue(value);
    this.inputs.set(key, normalized);
  }

  /**
   * Check if render target needs to be re-rendered
   * @returns {boolean} Whether re-render is needed
   */
  needsRender() {
    if (!this.trackingEnabled) return true;
    
    const now = Date.now();
    const timeSinceLastRender = now - this.lastRenderTime;
    
    // Check time-based invalidation
    if (timeSinceLastRender < this.minRenderIntervalMs) {
      return false;
    }
    
    // Check input-based invalidation
    const currentHash = this._computeInputHash();
    if (currentHash !== this.lastInputHash) {
      return true;
    }
    
    return false;
  }

  /**
   * Mark that a render has completed
   */
  markRendered() {
    this.lastRenderTime = Date.now();
    this.lastInputHash = this._computeInputHash();
  }

  /**
   * Manually invalidate the cache
   */
  invalidate() {
    this.lastInputHash = null;
    this.lastRenderTime = 0;
  }

  /**
   * Reset all tracking
   */
  reset() {
    this.inputs.clear();
    this.lastInputHash = null;
    this.lastRenderTime = 0;
  }

  /**
   * Disable tracking (always render)
   */
  disable() {
    this.trackingEnabled = false;
  }

  /**
   * Enable tracking
   */
  enable() {
    this.trackingEnabled = true;
  }

  /**
   * Get statistics for debugging
   * @returns {Object} Stats object
   */
  getStats() {
    return {
      id: this.id,
      trackingEnabled: this.trackingEnabled,
      inputCount: this.inputs.size,
      lastRenderTime: this.lastRenderTime,
      minRenderIntervalMs: this.minRenderIntervalMs,
      timeSinceLastRender: Date.now() - this.lastRenderTime
    };
  }

  /**
   * Normalize value for comparison
   * @private
   */
  _normalizeValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Math.round(value * 1000) / 1000; // 3 decimal places
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value;
    if (value.x !== undefined && value.y !== undefined) {
      // Vector-like object
      return {
        x: Math.round(value.x * 1000) / 1000,
        y: Math.round(value.y * 1000) / 1000
      };
    }
    return String(value);
  }

  /**
   * Compute hash of all tracked inputs
   * @private
   */
  _computeInputHash() {
    if (this.inputs.size === 0) return '';
    
    const parts = [];
    for (const [key, value] of this.inputs.entries()) {
      if (typeof value === 'object' && value !== null) {
        parts.push(`${key}:${JSON.stringify(value)}`);
      } else {
        parts.push(`${key}:${value}`);
      }
    }
    
    return parts.join('|');
  }
}

/**
 * Manager for multiple render invalidation trackers
 */
export class RenderInvalidationManager {
  constructor() {
    /** @type {Map<string, RenderInvalidationTracker>} */
    this.trackers = new Map();
    
    log.info('RenderInvalidationManager created');
  }

  /**
   * Create or get a tracker
   * @param {string} id - Tracker ID
   * @param {Object} options - Tracker options
   * @returns {RenderInvalidationTracker} Tracker instance
   */
  getOrCreateTracker(id, options = {}) {
    if (this.trackers.has(id)) {
      return this.trackers.get(id);
    }
    
    const tracker = new RenderInvalidationTracker(id, options);
    this.trackers.set(id, tracker);
    return tracker;
  }

  /**
   * Get existing tracker
   * @param {string} id - Tracker ID
   * @returns {RenderInvalidationTracker|null} Tracker or null
   */
  getTracker(id) {
    return this.trackers.get(id) || null;
  }

  /**
   * Remove a tracker
   * @param {string} id - Tracker ID
   */
  removeTracker(id) {
    this.trackers.delete(id);
  }

  /**
   * Get all trackers
   * @returns {RenderInvalidationTracker[]} Array of trackers
   */
  getAllTrackers() {
    return Array.from(this.trackers.values());
  }

  /**
   * Get statistics for all trackers
   * @returns {Object[]} Array of stats objects
   */
  getAllStats() {
    return Array.from(this.trackers.values()).map(t => t.getStats());
  }

  /**
   * Log statistics for debugging
   */
  logStats() {
    const stats = this.getAllStats();
    log.info('RenderInvalidationManager stats:', stats);
  }

  /**
   * Clear all trackers
   */
  clear() {
    this.trackers.clear();
  }
}

/**
 * Global singleton instance
 * @type {RenderInvalidationManager|null}
 */
let globalManager = null;

/**
 * Get or create the global render invalidation manager
 * @returns {RenderInvalidationManager} Global manager instance
 */
export function getGlobalRenderInvalidationManager() {
  if (!globalManager) {
    globalManager = new RenderInvalidationManager();
  }
  return globalManager;
}

/**
 * Reset the global manager (for testing)
 */
export function resetGlobalRenderInvalidationManager() {
  globalManager = null;
}
