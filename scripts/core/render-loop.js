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
        this.effectComposer.render(deltaTime);
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
    log.debug('Effect composer set');
  }
}
