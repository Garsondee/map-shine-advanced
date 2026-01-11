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

    this._perceptionUpdateMinIntervalMs = 100;
    this._lastPerceptionUpdateTime = 0;
    this._perceptionUpdateWindowStart = 0;
    this._perceptionUpdateWindowCalls = 0;
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
  forcePerceptionUpdate() {
    try {
      const now = performance.now();
      if (this._lastPerceptionUpdateTime && (now - this._lastPerceptionUpdateTime) < this._perceptionUpdateMinIntervalMs) {
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
      
      // Step 2: Run sync callbacks (managers pulling Foundry state)
      const syncStart = performance.now();
      for (const callback of this._syncCallbacks) {
        try {
          callback(this._frameState);
        } catch (e) {
          log.error('Sync callback error:', e);
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
   * Get performance metrics
   * @returns {Object} Metrics object
   */
  getMetrics() {
    return {
      ...this._metrics,
      frameCount: this._frameCount,
      avgFrameTime: this._metrics.totalFrameTime,
      syncCallbacks: this._syncCallbacks.size,
      postPixiCallbacks: this._postPixiCallbacks.size
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
