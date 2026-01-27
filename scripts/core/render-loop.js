/**
 * @fileoverview Render loop manager for three.js animation
 * Handles requestAnimationFrame loop with delta time tracking
 * @module core/render-loop
 */

import { createLogger } from './log.js';

const log = createLogger('RenderLoop');

/**
 * Render loop manager
 */
export class RenderLoop {
  constructor(renderer, scene, camera, effectComposer = null) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.effectComposer = effectComposer;

    // PERFORMANCE: When the scene is visually static, rendering the full pipeline
    // at 60fps is wasteful. We throttle rendering while idle, but still keep a
    // low-frequency refresh so uniforms/state don't get stuck.
    this._forceNextRender = true;
    this._lastComposerRenderTime = 0;
    this._idleFps = 15;

    // Camera snapshot for cheap motion detection.
    this._lastCamX = null;
    this._lastCamY = null;
    this._lastCamZ = null;
    this._lastCamZoom = null;

    // Foundry/PIXI is the authoritative camera during pan/zoom.
    // Using the Three camera here can introduce a 1-frame delay because the camera
    // is synced from PIXI inside EffectComposer.render() via CameraFollower.
    this._lastPixiPivotX = null;
    this._lastPixiPivotY = null;
    this._lastPixiZoom = null;
    
    /** @type {number|null} */
    this.animationFrameId = null;
    
    /** @type {boolean} */
    this.isRunning = false;
    
    /** @type {number} */
    this.lastFrameTime = performance.now();
    
    /** @type {number} */
    this.frameCount = 0;
    
    /** @type {number} */
    this.fps = 0;
    
    /** @type {number} */
    this.fpsUpdateInterval = 1000; // Update FPS every second
    
    /** @type {number} */
    this.lastFpsUpdate = performance.now();
    
    /** @type {number} */
    this.framesThisSecond = 0;
    
    // Bind render method to preserve context
    this.render = this.render.bind(this);
  }

  /**
   * Start the render loop
   */
  start() {
    if (this.isRunning) {
      log.warn('Render loop already running');
      return;
    }

    log.info('Starting render loop');
    this.isRunning = true;
    this.lastFrameTime = performance.now();
    this.lastFpsUpdate = this.lastFrameTime;
    this.frameCount = 0;
    this.framesThisSecond = 0;

    this._forceNextRender = true;
    this._lastComposerRenderTime = 0;
    this._lastCamX = null;
    this._lastCamY = null;
    this._lastCamZ = null;
    this._lastCamZoom = null;

    this._lastPixiPivotX = null;
    this._lastPixiPivotY = null;
    this._lastPixiZoom = null;
    
    // Kick off the loop
    this.animationFrameId = requestAnimationFrame(this.render);
  }

  /**
   * Stop the render loop
   */
  stop() {
    if (!this.isRunning) {
      return;
    }

    log.info('Stopping render loop');
    this.isRunning = false;
    
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  /**
   * Main render method (called every frame)
   * @private
   */
  render() {
    if (!this.isRunning) return;

    // Schedule next frame
    this.animationFrameId = requestAnimationFrame(this.render);

    // Calculate delta time
    const now = performance.now();
    const deltaTime = (now - this.lastFrameTime) / 1000; // Convert to seconds
    this.lastFrameTime = now;

    // Update frame counter
    this.frameCount++;
    this.framesThisSecond++;

    // Update FPS counter
    if (now - this.lastFpsUpdate >= this.fpsUpdateInterval) {
      this.fps = this.framesThisSecond;
      this.framesThisSecond = 0;
      this.lastFpsUpdate = now;
    }

    // When an EffectComposer is present, it owns the full render pipeline
    if (this.effectComposer) {
      try {
        // Idle throttling: if camera is not moving, render at a reduced rate.
        // Prefer PIXI camera state (stage pivot/scale) to avoid 1-frame latency.
        const stage = canvas?.stage;
        const pixiPivotX = stage?.pivot?.x;
        const pixiPivotY = stage?.pivot?.y;
        const pixiZoom = stage?.scale?.x;

        let cameraChanged = false;
        if (typeof pixiPivotX === 'number' && typeof pixiPivotY === 'number' && typeof pixiZoom === 'number') {
          cameraChanged = (
            pixiPivotX !== this._lastPixiPivotX ||
            pixiPivotY !== this._lastPixiPivotY ||
            pixiZoom !== this._lastPixiZoom
          );
        } else {
          const cam = this.camera;
          const camX = cam?.position?.x;
          const camY = cam?.position?.y;
          const camZ = cam?.position?.z;
          const camZoom = cam?.zoom;
          cameraChanged = (
            camX !== this._lastCamX ||
            camY !== this._lastCamY ||
            camZ !== this._lastCamZ ||
            camZoom !== this._lastCamZoom
          );
        }

        // Allow runtime tuning (primarily for perf testing).
        // IMPORTANT: keep idle interval <= 100ms, otherwise TimeManager clamps delta
        // and animations will slow down when the user re-enables them.
        const ms = window.MapShine;
        const idleFps = Number.isFinite(ms?.renderIdleFps)
          ? Math.max(5, Math.min(60, Math.floor(ms.renderIdleFps)))
          : this._idleFps;
        const idleIntervalMs = 1000 / Math.max(1, idleFps);

        let shouldRender = this._forceNextRender || cameraChanged;
        if (!shouldRender) {
          const since = now - (this._lastComposerRenderTime || 0);
          if (since >= idleIntervalMs) shouldRender = true;
        }

        if (shouldRender) {
          this.effectComposer.render(deltaTime);
          this._lastComposerRenderTime = now;
          this._forceNextRender = false;

          // Refresh caches after rendering.
          try {
            if (typeof pixiPivotX === 'number') this._lastPixiPivotX = pixiPivotX;
            if (typeof pixiPivotY === 'number') this._lastPixiPivotY = pixiPivotY;
            if (typeof pixiZoom === 'number') this._lastPixiZoom = pixiZoom;
          } catch (_) {
          }

          // Fallback cache for non-Foundry environments.
          try {
            const cam = this.camera;
            this._lastCamX = cam?.position?.x;
            this._lastCamY = cam?.position?.y;
            this._lastCamZ = cam?.position?.z;
            this._lastCamZoom = cam?.zoom;
          } catch (_) {
          }
        }
      } catch (error) {
        log.error('Effect composer render error:', error);
      }
      return;
    }

    // Fallback path: direct scene render with enforced clear color
    try {
      // CRITICAL: Enforce opaque black background every frame
      if (this.renderer.setClearColor) {
        this.renderer.setClearColor(0x000000, 1);
      }
      
      // Ensure autoClear is enabled so the background is actually cleared
      if (this.renderer.autoClear === false) {
        this.renderer.autoClear = true;
      }

      this.renderer.render(this.scene, this.camera);
      
      // Debug: Log first few renders
      if (this.frameCount <= 3) {
        log.debug(`Frame ${this.frameCount} rendered successfully (no composer)`);
      }
    } catch (error) {
      log.error('Renderer error:', error);
      log.error('Renderer state:', {
        renderer: !!this.renderer,
        scene: !!this.scene,
        camera: !!this.camera,
        sceneChildren: this.scene?.children?.length || 0
      });
      // Critical error - stop the loop
      this.stop();
    }
  }

  /**
   * Get current FPS
   * @returns {number} Frames per second
   */
  getFPS() {
    return this.fps;
  }

  /**
   * Get total frame count
   * @returns {number} Total frames rendered
   */
  getFrameCount() {
    return this.frameCount;
  }

  /**
   * Check if loop is running
   * @returns {boolean}
   */
  running() {
    return this.isRunning;
  }

  /**
   * Set effect composer
   * @param {EffectComposer|null} composer
   */
  setEffectComposer(composer) {
    this.effectComposer = composer;
    this._forceNextRender = true;
    log.debug('Effect composer set');
  }

  /**
   * Request a full render on the next animation frame.
   * Use this from interactions/hooks that change visible state.
   */
  requestRender() {
    this._forceNextRender = true;
  }
}
