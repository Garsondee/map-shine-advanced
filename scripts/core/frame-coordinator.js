/**
 * @fileoverview Frame Coordinator - Synchronizes Foundry PIXI and Three.js rendering
 * 
 * This module solves the fundamental problem of having two render systems that need
 * to stay synchronized. Without coordination, Three.js may render a frame using stale
 * Foundry data (vision masks, fog textures, token positions) because PIXI hasn't
 * finished its update pass yet.
 * 
 * Architecture:
 * - Hooks into Foundry's PIXI ticker to run AFTER Foundry's updates complete
 * - Forces PIXI to flush any pending renders before Three.js samples textures
 * - Provides a pre-render sync phase for managers to pull latest Foundry state
 * - Captures camera state at frame start so both systems use identical view bounds
 * 
 * This is Option A from the frame sync design: Intercept Foundry's Render Loop.
 * 
 * @module core/frame-coordinator
 */

import { createLogger } from './log.js';

const log = createLogger('FrameCoordinator');

/**
 * Frame Coordinator - ensures PIXI and Three.js render in sync
 */
export class FrameCoordinator {
  constructor() {
    /** @type {boolean} */
    this._initialized = false;
    
    /** @type {Function|null} */
    this._tickerCallback = null;
    
    /** @type {Set<Function>} - Pre-render sync callbacks */
    this._syncCallbacks = new Set();
    
    /** @type {Set<Function>} - Post-PIXI callbacks (run after Foundry updates) */
    this._postPixiCallbacks = new Set();
    
    /** @type {Object|null} - Captured camera state for this frame */
    this._frameState = null;
    
    /** @type {number} - Frame counter for debugging */
    this._frameCount = 0;
    
    /** @type {boolean} - Whether we're currently in a coordinated frame */
    this._inFrame = false;
    
    /** @type {number} - Timestamp of last coordinated frame */
    this._lastFrameTime = 0;
    
    /** @type {number} - Target frame budget in ms (for performance monitoring) */
    this._frameBudgetMs = 16.67; // 60fps target
    
    /** @type {Object} - Performance metrics */
    this._metrics = {
      pixiSyncTime: 0,
      threeRenderTime: 0,
      totalFrameTime: 0,
      droppedFrames: 0,
      perceptionUpdateCalls: 0,
      perceptionUpdateSkipped: 0,
      perceptionUpdateCallsPerSec: 0
    };

    /**
     * T3-A: Adaptive perception update interval.
     * Fast (50ms) during active camera/token motion, slow (200ms) when idle.
     * Call requestActivePerception() to temporarily switch to the fast rate.
     * @type {number} Current minimum interval between perception updates (ms)
     */
    this._perceptionUpdateMinIntervalMs = 200;
    /** @type {number} Fast interval for active state (ms) */
    this._perceptionActiveIntervalMs = 50;
    /** @type {number} Slow interval for idle state (ms) */
    this._perceptionIdleIntervalMs = 200;
    /** @type {number} Timestamp when active perception was last requested (ms) */
    this._perceptionActiveUntilMs = 0;
    /** @type {number} Duration to stay in active mode after last request (ms) */
    this._perceptionActiveDurationMs = 500;

    this._lastPerceptionUpdateTime = 0;
    this._perceptionUpdateWindowStart = 0;
    this._perceptionUpdateWindowCalls = 0;

    /**
     * T2-C: Sync callback throttle. Sync callbacks pull Foundry state for
     * Three.js rendering — they only need to run at approximately the Three.js
     * render rate, not every PIXI tick. PostPixi callbacks (fog/vision sync)
     * remain ungated since they are critical.
     * @type {number} Max Hz for sync callback execution
     */
    this._syncThrottleHz = 30;
    /** @type {number} Timestamp of last sync callback execution (ms) */
    this._lastSyncRunMs = 0;

    /**
     * Strict sync lockstep tokening.
     * On every PIXI tick we increment `_pendingPixiToken`. When the RenderLoop
     * successfully completes a compositor render for a frame, it calls
     * {@link consumePendingPixiToken} which advances `_consumedPixiToken`.
     * A frame is "pending" iff `_pendingPixiToken > _consumedPixiToken`.
     *
     * Strict sync mode uses this to enforce one compositor render per PIXI frame
     * (no adaptive skipping that can drop required frames).
     */
    this._pendingPixiToken = 0;
    this._consumedPixiToken = 0;
    /** @type {number} Count of PIXI frames produced while strict sync was active */
    this._strictPixiTokensProduced = 0;
    /** @type {number} Count of PIXI frames consumed (one-to-one with compositor renders) */
    this._strictPixiTokensConsumed = 0;
    /** @type {number} Tokens that expired because a newer token overwrote an unconsumed one (strict mode: should be zero) */
    this._strictPixiTokenMissedCount = 0;
  }

  /**
   * Initialize the frame coordinator
   * Must be called after Foundry's canvas is ready
   * @returns {boolean} Success
   */
  initialize() {
    if (this._initialized) {
      log.warn('FrameCoordinator already initialized');
      return true;
    }

    if (!canvas?.app?.ticker) {
      log.error('Cannot initialize: Foundry ticker not available');
      return false;
    }

    // Hook into Foundry's PIXI ticker
    // We add our callback at a lower priority (higher number) so it runs AFTER
    // Foundry's internal updates (vision, lighting, fog) have completed
    this._tickerCallback = this._onPixiTick.bind(this);
    
    // PIXI.UPDATE_PRIORITY.LOW = -1, we use an even lower priority
    // to ensure we run after all Foundry updates
    canvas.app.ticker.add(this._tickerCallback, null, -50);
    
    this._initialized = true;
    this._lastFrameTime = performance.now();
    
    log.info('FrameCoordinator initialized - hooked into Foundry ticker');
    return true;
  }

  /**
   * Register a callback to run during the pre-render sync phase
   * Use this for managers that need to pull latest Foundry state before Three.js renders
   * 
   * @param {Function} callback - Function to call during sync phase
   * @returns {Function} Unsubscribe function
   */
  onSync(callback) {
    if (typeof callback !== 'function') {
      log.error('onSync requires a function callback');
      return () => {};
    }
    
    this._syncCallbacks.add(callback);
    return () => this._syncCallbacks.delete(callback);
  }

  /**
   * Register a callback to run after PIXI updates but before Three.js render
   * Use this for texture extraction or state synchronization
   * 
   * @param {Function} callback - Function to call after PIXI tick
   * @returns {Function} Unsubscribe function
   */
  onPostPixi(callback) {
    if (typeof callback !== 'function') {
      log.error('onPostPixi requires a function callback');
      return () => {};
    }
    
    this._postPixiCallbacks.add(callback);
    return () => this._postPixiCallbacks.delete(callback);
  }

  /**
   * Get the captured frame state (camera position, zoom, etc.)
   * This ensures all systems use the same camera state for a given frame
   * 
   * @returns {Object|null} Frame state or null if not in a coordinated frame
   */
  getFrameState() {
    return this._frameState;
  }

  /**
   * Force PIXI to flush any pending renders
   * Call this before sampling PIXI textures in Three.js
   */
  flushPixi() {
    if (!canvas?.app?.renderer) return;

    // Defense-in-depth: When MapShine's V2 compositor is active, we must not
    // force PIXI to render the full canvas stage. V2 does not sample PIXI fog/
    // vision textures, and the forced render can leave a camera-locked overlay
    // in the browser compositor even if the #board canvas is hidden.
    try {
      if (window?.MapShine?.__v2Active === true) return;
    } catch (_) {}
    
    try {
      // Force PIXI to render its current state
      // This ensures textures like vision masks are up-to-date
      canvas.app.renderer.render(canvas.stage);
    } catch (e) {
      log.warn('Failed to flush PIXI render:', e);
    }
  }

  /**
   * Force Foundry's perception system to update
   * Call this when camera moves significantly to ensure vision is current
   */
  /**
   * T3-A: Signal that perception updates should use the fast interval.
   * Call this during camera pan, token drag, or other active interactions.
   * The fast rate auto-decays after _perceptionActiveDurationMs.
   */
  requestActivePerception() {
    this._perceptionActiveUntilMs = performance.now() + this._perceptionActiveDurationMs;
  }

  forcePerceptionUpdate({ bypassThrottle = false } = {}) {
    try {
      const now = performance.now();

      // T3-A: Adapt interval based on activity state
      this._perceptionUpdateMinIntervalMs = (now < this._perceptionActiveUntilMs)
        ? this._perceptionActiveIntervalMs
        : this._perceptionIdleIntervalMs;

      if (!bypassThrottle && this._lastPerceptionUpdateTime && (now - this._lastPerceptionUpdateTime) < this._perceptionUpdateMinIntervalMs) {
        this._metrics.perceptionUpdateSkipped++;

        if (!this._perceptionUpdateWindowStart) {
          this._perceptionUpdateWindowStart = now;
          this._perceptionUpdateWindowCalls = 0;
        }

        const dt = now - this._perceptionUpdateWindowStart;
        if (dt >= 1000) {
          this._metrics.perceptionUpdateCallsPerSec = this._perceptionUpdateWindowCalls;
          this._perceptionUpdateWindowStart = now;
          this._perceptionUpdateWindowCalls = 0;
        }

        return;
      }

      // canvas.perception.update() forces Foundry to recompute vision/lighting
      if (canvas?.perception?.update) {
        canvas.perception.update({
          refreshVision: true,
          refreshLighting: true
        });

        this._lastPerceptionUpdateTime = now;
        this._metrics.perceptionUpdateCalls++;
        this._perceptionUpdateWindowCalls++;

        if (!this._perceptionUpdateWindowStart) {
          this._perceptionUpdateWindowStart = now;
        }

        const dt = now - this._perceptionUpdateWindowStart;
        if (dt >= 1000) {
          this._metrics.perceptionUpdateCallsPerSec = this._perceptionUpdateWindowCalls;
          this._perceptionUpdateWindowStart = now;
          this._perceptionUpdateWindowCalls = 0;
        }
      }
    } catch (e) {
      log.warn('Failed to force perception update:', e);
    }
  }

  /**
   * PIXI ticker callback - runs after Foundry's internal updates
   * @private
   */
  _onPixiTick(deltaTime) {
    if (!this._initialized) return;
    
    const frameStart = performance.now();
    this._frameCount++;
    this._inFrame = true;
    
    try {
      // Step 1: Capture camera state at frame start
      this._captureFrameState();

      // Step 1b: Produce a lockstep token for strict sync consumers.
      // If the previous token was never consumed, flag it as missed so strict
      // mode can surface the drop in telemetry.
      if (this._pendingPixiToken > this._consumedPixiToken) {
        this._strictPixiTokenMissedCount++;
      }
      this._pendingPixiToken++;
      this._strictPixiTokensProduced++;
      
      // Step 2: Run sync callbacks (managers pulling Foundry state)
      // T2-C: Throttle sync callbacks — they only need to run at ~render rate,
      // not every PIXI tick. PostPixi callbacks remain ungated.
      const syncStart = performance.now();
      const syncInterval = this._syncThrottleHz > 0 ? (1000 / this._syncThrottleHz) : 0;
      const runSync = syncInterval <= 0 || (syncStart - this._lastSyncRunMs) >= syncInterval;
      if (runSync) {
        this._lastSyncRunMs = syncStart;
        for (const callback of this._syncCallbacks) {
          try {
            callback(this._frameState);
          } catch (e) {
            log.error('Sync callback error:', e);
          }
        }
      }
      
      // Step 3: Run post-PIXI callbacks (texture extraction, etc.)
      for (const callback of this._postPixiCallbacks) {
        try {
          callback(this._frameState);
        } catch (e) {
          log.error('Post-PIXI callback error:', e);
        }
      }
      
      this._metrics.pixiSyncTime = performance.now() - syncStart;
      
    } finally {
      this._inFrame = false;
      
      // Track frame timing
      const frameEnd = performance.now();
      this._metrics.totalFrameTime = frameEnd - frameStart;
      
      if (this._metrics.totalFrameTime > this._frameBudgetMs) {
        this._metrics.droppedFrames++;
      }
      
      this._lastFrameTime = frameEnd;
    }
  }

  /**
   * Capture current camera/view state for this frame
   * @private
   */
  _captureFrameState() {
    const stage = canvas?.stage;
    if (!stage) {
      this._frameState = null;
      return;
    }
    
    // Capture PIXI camera state (Foundry coordinates)
    this._frameState = {
      frameNumber: this._frameCount,
      timestamp: performance.now(),
      
      // Camera position (Foundry world coords)
      cameraX: stage.pivot.x,
      cameraY: stage.pivot.y,
      zoom: stage.scale.x || 1,
      
      // Viewport dimensions
      viewportWidth: canvas.app?.view?.width || window.innerWidth,
      viewportHeight: canvas.app?.view?.height || window.innerHeight,
      
      // Scene dimensions
      sceneWidth: canvas.dimensions?.width || 1,
      sceneHeight: canvas.dimensions?.height || 1,
      
      // Scene rect (actual map area)
      sceneRect: canvas.dimensions?.sceneRect ? {
        x: canvas.dimensions.sceneRect.x,
        y: canvas.dimensions.sceneRect.y,
        width: canvas.dimensions.sceneRect.width,
        height: canvas.dimensions.sceneRect.height
      } : null
    };
  }

  /**
   * @returns {number} The current unconsumed PIXI frame token id (0 if none produced).
   */
  getPendingPixiToken() {
    return this._pendingPixiToken;
  }

  /**
   * @returns {number} The most recently consumed PIXI token id.
   */
  getConsumedPixiToken() {
    return this._consumedPixiToken;
  }

  /**
   * @returns {boolean} True if a PIXI tick has occurred that has not yet been
   *   matched by a compositor render consumption.
   */
  hasPendingPixiToken() {
    return this._pendingPixiToken > this._consumedPixiToken;
  }

  /**
   * Mark the current pending PIXI token as consumed. Called by the compositor
   * render path after a successful render completes in strict sync mode.
   *
   * @returns {number} The token id that was consumed (0 if none was pending).
   */
  consumePendingPixiToken() {
    if (this._pendingPixiToken <= this._consumedPixiToken) return 0;
    this._consumedPixiToken = this._pendingPixiToken;
    this._strictPixiTokensConsumed++;
    return this._consumedPixiToken;
  }

  /**
   * Snapshot of strict-sync token counters for diagnostics.
   * @returns {{produced:number, consumed:number, missed:number, pending:number, consumedId:number, pendingId:number}}
   */
  getStrictSyncTokenStats() {
    return {
      produced: this._strictPixiTokensProduced,
      consumed: this._strictPixiTokensConsumed,
      missed: this._strictPixiTokenMissedCount,
      pending: this._pendingPixiToken - this._consumedPixiToken,
      consumedId: this._consumedPixiToken,
      pendingId: this._pendingPixiToken,
    };
  }

  /**
   * Get performance metrics
   * @returns {Object} Metrics object
   */
  getMetrics() {
    return {
      ...this._metrics,
      frameCount: this._frameCount,
      avgFrameTime: this._metrics.totalFrameTime,
      syncCallbacks: this._syncCallbacks.size,
      postPixiCallbacks: this._postPixiCallbacks.size,
      strictSync: this.getStrictSyncTokenStats()
    };
  }

  /**
   * Check if we're currently in a coordinated frame
   * @returns {boolean}
   */
  isInFrame() {
    return this._inFrame;
  }

  /**
   * Whether the coordinator has been successfully initialized and is
   * actively running post-PIXI callbacks on the Foundry ticker.
   * @returns {boolean}
   */
  get initialized() {
    return this._initialized;
  }

  /**
   * Dispose the frame coordinator
   */
  dispose() {
    if (!this._initialized) return;
    
    // Remove ticker callback
    if (this._tickerCallback && canvas?.app?.ticker) {
      canvas.app.ticker.remove(this._tickerCallback);
    }
    
    this._tickerCallback = null;
    this._syncCallbacks.clear();
    this._postPixiCallbacks.clear();
    this._frameState = null;
    this._initialized = false;
    
    log.info('FrameCoordinator disposed');
  }
}

/**
 * Singleton instance for global access
 * @type {FrameCoordinator}
 */
export const frameCoordinator = new FrameCoordinator();
