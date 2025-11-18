/**
 * @fileoverview Centralized time management for Map Shine Advanced
 * 
 * **CRITICAL: ALL EFFECTS MUST USE THIS TIME SYSTEM**
 * 
 * This is the single source of truth for time in the module.
 * Never use performance.now() or Date.now() directly in effects.
 * 
 * Benefits:
 * - Synchronized animations across all effects
 * - Global pause/resume capability
 * - Time scaling (slow-mo, fast-forward, debugging)
 * - Foundry game time integration (future: day/night cycles)
 * - Predictable behavior for testing
 * 
 * @module core/time
 */

import { createLogger } from './log.js';

const log = createLogger('TimeManager');

/**
 * Time manager - centralized time control for all effects
 * 
 * Usage in effects:
 * ```javascript
 * update(timeInfo) {
 *   // Use timeInfo.elapsed for absolute time-based animations
 *   const phase = Math.sin(timeInfo.elapsed * 2.0);
 *   
 *   // Use timeInfo.delta for frame-rate independent updates
 *   this.position += this.velocity * timeInfo.delta;
 * }
 * ```
 */
export class TimeManager {
  constructor() {
    /** @type {number} - Total elapsed time in seconds (affected by scaling and pausing) */
    this.elapsed = 0.0;
    
    /** @type {number} - Time since last frame in seconds */
    this.delta = 0.0;
    
    /** @type {number} - Real-world time of last update (performance.now()) */
    this.lastUpdate = performance.now();
    
    /** @type {number} - Time scale multiplier (1.0 = normal, 0.5 = half speed, 2.0 = double speed) */
    this.scale = 1.0;
    
    /** @type {boolean} - Whether time is paused */
    this.paused = false;
    
    /** @type {number} - Frame counter */
    this.frameCount = 0;
    
    /** @type {number} - Frames per second (updated periodically) */
    this.fps = 0;
    
    /** @type {number} - Internal FPS tracking */
    this._fpsFrameCount = 0;
    
    /** @type {number} - Last FPS update time */
    this._lastFpsUpdate = performance.now();
    
    /** @type {number} - FPS update interval in ms */
    this._fpsUpdateInterval = 1000;
    
    log.info('TimeManager initialized');
  }

  /**
   * Update time state (called once per frame by EffectComposer)
   * @returns {TimeInfo} Current time information
   */
  update() {
    const now = performance.now();
    const realDelta = (now - this.lastUpdate) / 1000; // Convert ms to seconds
    this.lastUpdate = now;

    // Apply pause and scaling
    if (!this.paused) {
      this.delta = realDelta * this.scale;
      this.elapsed += this.delta;
      this.frameCount++;
    } else {
      this.delta = 0.0;
    }

    // Update FPS counter
    this._fpsFrameCount++;
    if (now - this._lastFpsUpdate >= this._fpsUpdateInterval) {
      this.fps = Math.round(this._fpsFrameCount / ((now - this._lastFpsUpdate) / 1000));
      this._fpsFrameCount = 0;
      this._lastFpsUpdate = now;
    }

    return this.getTimeInfo();
  }

  /**
   * Get current time information for effects
   * @returns {TimeInfo} Time info object
   */
  getTimeInfo() {
    return {
      elapsed: this.elapsed,
      delta: this.delta,
      frameCount: this.frameCount,
      fps: this.fps,
      scale: this.scale,
      paused: this.paused
    };
  }

  /**
   * Pause time progression
   */
  pause() {
    if (this.paused) return;
    this.paused = true;
    log.info('Time paused');
  }

  /**
   * Resume time progression
   */
  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.lastUpdate = performance.now(); // Reset to avoid large delta
    log.info('Time resumed');
  }

  /**
   * Toggle pause state
   */
  togglePause() {
    if (this.paused) {
      this.resume();
    } else {
      this.pause();
    }
  }

  /**
   * Set time scale
   * @param {number} scale - Time scale multiplier (1.0 = normal, 0.5 = half speed, etc.)
   */
  setScale(scale) {
    if (scale < 0) {
      log.warn('Time scale cannot be negative, clamping to 0');
      scale = 0;
    }
    this.scale = scale;
    log.info(`Time scale set to ${scale.toFixed(2)}x`);
  }

  /**
   * Reset time to zero
   */
  reset() {
    this.elapsed = 0.0;
    this.delta = 0.0;
    this.frameCount = 0;
    this.lastUpdate = performance.now();
    this._lastFpsUpdate = performance.now();
    this._fpsFrameCount = 0;
    log.info('Time reset');
  }

  /**
   * Get current FPS
   * @returns {number} Frames per second
   */
  getFPS() {
    return this.fps;
  }

  /**
   * Get frame count
   * @returns {number} Total frames rendered
   */
  getFrameCount() {
    return this.frameCount;
  }
}

/**
 * @typedef {Object} TimeInfo
 * @property {number} elapsed - Total elapsed time in seconds
 * @property {number} delta - Time since last frame in seconds
 * @property {number} frameCount - Current frame number
 * @property {number} fps - Current frames per second
 * @property {number} scale - Current time scale multiplier
 * @property {boolean} paused - Whether time is paused
 */
