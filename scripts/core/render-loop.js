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
    this._activeFps = 60;
    this._continuousFps = 30;

    // PERF: Cache expensive composer continuous-render probes.
    this._cachedEffectWantsContinuous = false;
    this._lastEffectContinuousCheckMs = -Infinity;

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

    // When set, we temporarily bypass idle frame skipping and render every RAF.
    // This is used for time-critical animations (token movement, drags, etc.).
    this._continuousRenderUntilMs = 0;
    
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
    
    // Track first-frame timing to diagnose residual shader compilation
    this._firstFrameLogged = false;

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
    this._firstFrameLogged = false;
    this._lastComposerRenderTime = 0;
    this._lastCamX = null;
    this._lastCamY = null;
    this._lastCamZ = null;
    this._lastCamZoom = null;

    this._lastPixiPivotX = null;
    this._lastPixiPivotY = null;
    this._lastPixiZoom = null;

    this._cachedEffectWantsContinuous = false;
    this._lastEffectContinuousCheckMs = -Infinity;

    this._continuousRenderUntilMs = 0;
    
    // Kick off the loop
    this.animationFrameId = requestAnimationFrame(this.render);
  }

  /**
   * Temporarily bypass idle frame skipping.
   * Useful for smooth movement animations where a low render rate looks "steppy".
   * @param {number} durationMs
   */
  requestContinuousRender(durationMs) {
    const d = Number(durationMs);
    if (!Number.isFinite(d) || d <= 0) {
      this._forceNextRender = true;
      return;
    }

    const until = performance.now() + Math.max(0, d);
    if (!this._continuousRenderUntilMs || until > this._continuousRenderUntilMs) {
      this._continuousRenderUntilMs = until;
    }

    // Ensure the very next frame renders even if we're currently idle-throttled.
    this._forceNextRender = true;
  }

  /**
   * @private
   * @param {*} value
   * @param {number} fallback
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  _clampFps(value, fallback, min = 5, max = 120) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
  }

  /**
   * Query EffectComposer.wantsContinuousRender() with a short cache window.
   * This avoids scanning effects on every RAF when nothing changes.
   *
   * @private
   * @param {number} nowMs
   * @returns {boolean}
   */
  _getEffectWantsContinuous(nowMs) {
    if (!this.effectComposer?.wantsContinuousRender) return false;

    const now = Number.isFinite(nowMs) ? nowMs : performance.now();
    const pollIntervalMs = this._cachedEffectWantsContinuous ? 120 : 33;
    if ((now - this._lastEffectContinuousCheckMs) < pollIntervalMs) {
      return this._cachedEffectWantsContinuous;
    }

    this._lastEffectContinuousCheckMs = now;
    try {
      this._cachedEffectWantsContinuous = !!this.effectComposer.wantsContinuousRender();
    } catch (_) {
    }
    return this._cachedEffectWantsContinuous;
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

    // Skip rendering when the WebGL context is lost.
    // Without this guard, every render call returns GL_INVALID_OPERATION (1282)
    // and fills the console with shader VALIDATE_STATUS errors. The rAF loop
    // itself continues so we resume immediately when the context is restored.
    try {
      if (this.renderer?.getContext?.()?.isContextLost?.()) return;
    } catch (_) {}

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
        const inContinuousWindow = now < (this._continuousRenderUntilMs || 0);

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
        const adaptiveFpsEnabled = ms?.renderAdaptiveFpsEnabled !== false;
        const idleFps = this._clampFps(ms?.renderIdleFps, this._idleFps, 5, 60);
        const activeFps = this._clampFps(ms?.renderActiveFps, this._activeFps, 5, 120);
        const continuousFps = this._clampFps(ms?.renderContinuousFps, this._continuousFps, 5, 120);
        const idleIntervalMs = 1000 / Math.max(1, idleFps);

        // Fast path: when adaptive mode is on, nothing can render faster than the
        // highest configured mode cap. On high-refresh displays this avoids extra
        // per-RAF work (camera checks + effect scans) between allowed render ticks.
        if (adaptiveFpsEnabled) {
          const since = now - (this._lastComposerRenderTime || 0);
          const fastestFps = Math.max(idleFps, activeFps, continuousFps);
          const minIntervalMs = 1000 / Math.max(1, fastestFps);
          if (since < minIntervalMs) return;
        }

        // Effects may request continuous rendering while they are active
        // (e.g. particle systems) so they don't animate at the idle FPS.
        let effectWantsContinuous = inContinuousWindow;
        if (!effectWantsContinuous) {
          effectWantsContinuous = this._getEffectWantsContinuous(now);
        }

        let shouldRender = inContinuousWindow || effectWantsContinuous || this._forceNextRender || cameraChanged;
        if (!shouldRender) {
          const since = now - (this._lastComposerRenderTime || 0);
          if (since >= idleIntervalMs) shouldRender = true;
        }

        // Optional adaptive frame cap for smoother pacing under continuous load.
        // - active: camera/interactions/forced updates
        // - continuous: ongoing animated effects requesting full-rate updates
        // - idle: falls back to the existing idle throttle target
        if (shouldRender && adaptiveFpsEnabled) {
          let targetFps = idleFps;
          if (inContinuousWindow || effectWantsContinuous) targetFps = continuousFps;
          else if (this._forceNextRender || cameraChanged) targetFps = activeFps;

          const minIntervalMs = 1000 / Math.max(1, targetFps);
          const since = now - (this._lastComposerRenderTime || 0);
          if (since < minIntervalMs) shouldRender = false;
        }

        if (shouldRender) {
          // Measure first-frame render time to detect residual shader compilation.
          // If compileAsync() worked, this should be ~10-50ms. If it's hundreds of
          // ms or seconds, shaders are still compiling on the first draw call.
          const _isFirstFrame = !this._firstFrameLogged;
          const _t0 = _isFirstFrame ? performance.now() : 0;

          this.effectComposer.render(deltaTime);
          this._lastComposerRenderTime = now;
          this._forceNextRender = false;

          if (_isFirstFrame) {
            this._firstFrameLogged = true;
            const _renderMs = performance.now() - _t0;
            try {
              const dlp = window.MapShine?.debugLoadingProfiler;
              if (dlp?.event) {
                const calls = this.renderer?.info?.render?.calls ?? '?';
                const tris = this.renderer?.info?.render?.triangles ?? '?';
                const progs = Array.isArray(this.renderer?.info?.programs)
                  ? this.renderer.info.programs.length : '?';
                dlp.event(`renderLoop: FIRST FRAME rendered in ${_renderMs.toFixed(1)}ms ` +
                  `(calls=${calls}, tris=${tris}, programs=${progs})`);
              }
            } catch (_) {}
            if (_renderMs > 100) {
              log.warn(`First frame took ${_renderMs.toFixed(0)}ms — possible residual shader compilation`);
            } else {
              log.info(`First frame rendered in ${_renderMs.toFixed(0)}ms`);
            }
          }

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
    this._cachedEffectWantsContinuous = false;
    this._lastEffectContinuousCheckMs = -Infinity;
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
