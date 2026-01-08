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
    
    /** @type {number} - Time scale multiplier (effective scale, includes pause transition) */
    this.scale = 1.0;

    this._userScale = 1.0;
    this._pauseFactor = 1.0;
    this._pauseTarget = 1.0;
    this._pauseFrom = 1.0;
    this._pauseT = 1.0;
    this._pauseDuration = 0.0;

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

    // PERFORMANCE: Reuse timeInfo object to avoid per-frame allocations
    this._timeInfo = {
      elapsed: 0,
      delta: 0,
      frameCount: 0,
      fps: 0,
      scale: 1.0,
      paused: false
    };
    
    log.info('TimeManager initialized');
  }

  /**
   * Update time state (called once per frame by EffectComposer)
   * @returns {TimeInfo} Current time information
   */
  update() {
    const now = performance.now();
    let realDelta = (now - this.lastUpdate) / 1000; // Convert ms to seconds
    this.lastUpdate = now;

    // CRITICAL: Clamp delta to prevent animation "catch-up" after alt-tab or debugger pause.
    // When the browser tab loses focus, requestAnimationFrame pauses but performance.now()
    // keeps ticking. Without this clamp, returning to the tab causes a massive delta spike
    // (e.g., 30+ seconds) which makes animations go haywire trying to "catch up".
    // 100ms max ensures smooth recovery from any pause.
    const MAX_DELTA = 0.1; // 100ms max per frame
    if (realDelta > MAX_DELTA) {
      realDelta = MAX_DELTA;
    }

    if (this._pauseT < 1.0) {
      const d = this._pauseDuration > 0 ? this._pauseDuration : 0.0001;
      this._pauseT = Math.min(1.0, this._pauseT + (realDelta / d));
      const eased = 0.5 - 0.5 * Math.cos(Math.PI * this._pauseT);
      this._pauseFactor = this._pauseFrom + (this._pauseTarget - this._pauseFrom) * eased;
    } else {
      this._pauseFactor = this._pauseTarget;
    }

    this.scale = this._userScale * this._pauseFactor;
    this.delta = realDelta * this.scale;
    this.elapsed += this.delta;
    this.frameCount++;
    this.paused = this.scale <= 0.000001;

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
   * PERFORMANCE: Reuses cached object to avoid per-frame allocations
   * @returns {TimeInfo} Time info object
   */
  getTimeInfo() {
    // Update cached object instead of creating new one
    this._timeInfo.elapsed = this.elapsed;
    this._timeInfo.delta = this.delta;
    this._timeInfo.frameCount = this.frameCount;
    this._timeInfo.fps = this.fps;
    this._timeInfo.scale = this.scale;
    this._timeInfo.paused = this.paused;
    return this._timeInfo;
  }

  /**
   * Pause time progression
   */
  pause() {
    if (this._pauseTarget === 0.0 && this._pauseFactor <= 0.000001) return;
    this._pauseTarget = 0.0;
    this._pauseFrom = this._pauseFactor;
    this._pauseT = 1.0;
    this._pauseDuration = 0.0;
    this._pauseFactor = 0.0;
    this.scale = 0.0;
    this.delta = 0.0;
    this.paused = true;
    log.info('Time paused');
  }

  /**
   * Resume time progression
   */
  resume() {
    if (this._pauseTarget === 1.0 && this._pauseFactor >= 0.999999) return;
    this._pauseTarget = 1.0;
    this._pauseFrom = this._pauseFactor;
    this._pauseT = 1.0;
    this._pauseDuration = 0.0;
    this._pauseFactor = 1.0;
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

  setFoundryPaused(paused, durationSeconds = null) {
    const wantPaused = !!paused;
    const target = wantPaused ? 0.0 : 1.0;
    if (target === this._pauseTarget && this._pauseT >= 1.0) return;

    const dur = Number.isFinite(durationSeconds)
      ? Math.max(0, durationSeconds)
      : (wantPaused ? 0.75 : 0.45);

    if (dur <= 0) {
      this._pauseTarget = target;
      this._pauseFrom = target;
      this._pauseT = 1.0;
      this._pauseDuration = 0.0;
      this._pauseFactor = target;
      this.scale = this._userScale * this._pauseFactor;
      this.delta = 0.0;
      this.paused = this.scale <= 0.000001;
      if (!wantPaused) {
        this.lastUpdate = performance.now();
      }
      return;
    }

    this._pauseTarget = target;
    this._pauseFrom = this._pauseFactor;
    this._pauseT = 0.0;
    this._pauseDuration = dur;
    if (!wantPaused) {
      this.lastUpdate = performance.now();
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
    this._userScale = scale;
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
    this._pauseFactor = 1.0;
    this._pauseTarget = 1.0;
    this._pauseFrom = 1.0;
    this._pauseT = 1.0;
    this._pauseDuration = 0.0;
    this.paused = false;
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
