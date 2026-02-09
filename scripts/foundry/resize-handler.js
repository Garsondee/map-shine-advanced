/**
 * @fileoverview Resize handling for the Map Shine Three.js canvas.
 * 
 * Extracted from canvas-replacement.js to isolate resize observer setup,
 * debouncing, and render resolution application into a focused module.
 * 
 * @module foundry/resize-handler
 */

import { createLogger } from '../core/log.js';

const log = createLogger('ResizeHandler');

/**
 * Manages resize observation and debounced resize propagation for the
 * Three.js canvas, scene composer, and effect composer.
 */
export class ResizeHandler {
  /**
   * @param {Object} deps - Dependencies injected from the scene lifecycle.
   * @param {HTMLCanvasElement} deps.canvas - The Three.js canvas element.
   * @param {THREE.WebGLRenderer} deps.renderer - The Three.js renderer.
   * @param {import('../scene/composer.js').SceneComposer} deps.sceneComposer
   * @param {import('../effects/EffectComposer.js').EffectComposer} deps.effectComposer
   * @param {import('../ui/graphics-settings-manager.js').GraphicsSettingsManager|null} [deps.graphicsSettings]
   */
  constructor(deps) {
    this._canvas = deps.canvas;
    this._renderer = deps.renderer;
    this._sceneComposer = deps.sceneComposer;
    this._effectComposer = deps.effectComposer;
    this._graphicsSettings = deps.graphicsSettings ?? null;

    /** @type {ResizeObserver|null} */
    this._resizeObserver = null;

    /** @type {Function|null} */
    this._windowResizeHandler = null;

    /** @type {number|null} */
    this._debounceTimer = null;

    /** @type {number|null} */
    this._collapseSidebarHookId = null;

    this._disposed = false;
  }

  /**
   * Update the graphics settings reference (may be created after resize handler).
   * @param {import('../ui/graphics-settings-manager.js').GraphicsSettingsManager|null} gs
   */
  setGraphicsSettings(gs) {
    this._graphicsSettings = gs;
  }

  /**
   * Set up all resize listeners.
   * Call once after the canvas is attached to the DOM.
   */
  setup() {
    // Clean up any prior listeners (idempotent)
    this.cleanup();

    if (!this._canvas) {
      log.warn('Cannot set up resize handling — no canvas');
      return;
    }

    const container = this._canvas.parentElement;
    if (!container) {
      log.warn('Cannot set up resize handling — no container');
      return;
    }

    // Method 1: ResizeObserver (preferred — handles sidebar, popouts, etc.)
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          this._debouncedResize(width, height);
        }
      });
      this._resizeObserver.observe(container);
      log.debug('ResizeObserver attached to canvas container');
    } else {
      log.warn('ResizeObserver not available — falling back to window resize only');
    }

    // Method 2: Window resize event (fallback and additional coverage)
    this._windowResizeHandler = () => {
      if (!this._canvas) return;
      const rect = this._canvas.getBoundingClientRect();
      this._debouncedResize(rect.width, rect.height);
    };
    window.addEventListener('resize', this._windowResizeHandler);
    log.debug('Window resize listener attached');

    // Method 3: Foundry sidebar collapse/expand changes canvas area
    this._collapseSidebarHookId = Hooks.on('collapseSidebar', () => {
      setTimeout(() => {
        if (this._canvas) {
          const rect = this._canvas.getBoundingClientRect();
          this._debouncedResize(rect.width, rect.height);
        }
      }, 50);
    });

    log.info('Resize handling initialized');
  }

  /**
   * Apply a resize immediately (no debounce). Used by external callers
   * that need an instant resize (e.g., context restore, render resolution change).
   * @param {number} width - CSS pixel width.
   * @param {number} height - CSS pixel height.
   */
  resize(width, height) {
    if (!this._canvas) return;

    log.debug(`Canvas resized: ${width}x${height}`);

    // Update renderer size
    if (this._renderer) {
      this._applyRenderResolution(width, height);

      // Avoid touching element CSS sizing (we control that via style=100%).
      try {
        this._renderer.setSize(width, height, false);
      } catch (_) {
        this._renderer.setSize(width, height);
      }
    }

    // Update scene composer camera
    if (this._sceneComposer) {
      this._sceneComposer.resize(width, height);
    }

    // Update effect composer render targets (expects drawing-buffer pixels)
    if (this._effectComposer) {
      try {
        const THREE = window.THREE;
        const size = (this._renderer && typeof this._renderer.getDrawingBufferSize === 'function' && THREE)
          ? this._renderer.getDrawingBufferSize(new THREE.Vector2())
          : null;
        this._effectComposer.resize(
          size?.width ?? size?.x ?? width,
          size?.height ?? size?.y ?? height
        );
      } catch (_) {
        this._effectComposer.resize(width, height);
      }
    }
  }

  /**
   * Remove all resize listeners and clear timers.
   */
  cleanup() {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
      log.debug('ResizeObserver disconnected');
    }

    if (this._windowResizeHandler) {
      window.removeEventListener('resize', this._windowResizeHandler);
      this._windowResizeHandler = null;
      log.debug('Window resize listener removed');
    }

    if (this._collapseSidebarHookId !== null) {
      try { Hooks.off('collapseSidebar', this._collapseSidebarHookId); } catch (_) {}
      this._collapseSidebarHookId = null;
      log.debug('collapseSidebar hook removed');
    }
  }

  /**
   * Full disposal — cleanup + null all references.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.cleanup();
    this._canvas = null;
    this._renderer = null;
    this._sceneComposer = null;
    this._effectComposer = null;
    this._graphicsSettings = null;
  }

  // ── Private ──────────────────────────────────────────────────────

  /**
   * Debounced resize handler — avoids excessive updates during drag/resize.
   * @param {number} width
   * @param {number} height
   * @private
   */
  _debouncedResize(width, height) {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
    }

    // 16ms ≈ 60fps, prevents excessive updates during drag
    this._debounceTimer = setTimeout(() => {
      if (width <= 0 || height <= 0) {
        log.debug(`Ignoring invalid resize dimensions: ${width}x${height}`);
        return;
      }

      // Check if size actually changed
      let currentWidth = 0;
      let currentHeight = 0;
      try {
        const THREE = window.THREE;
        const size = (this._renderer && typeof this._renderer.getSize === 'function' && THREE)
          ? this._renderer.getSize(new THREE.Vector2())
          : null;
        currentWidth = size?.x || 0;
        currentHeight = size?.y || 0;
      } catch (_) {
        currentWidth = 0;
        currentHeight = 0;
      }

      if (Math.floor(width) === Math.floor(currentWidth) &&
          Math.floor(height) === Math.floor(currentHeight)) {
        log.debug('Resize skipped — dimensions unchanged');
        return;
      }

      const dpr = window.devicePixelRatio || 1;
      log.info(`Handling resize: ${width}x${height} (DPR: ${dpr})`);
      this.resize(width, height);
    }, 16);
  }

  /**
   * Apply effective pixel ratio from Graphics Settings (Render Resolution preset).
   * @param {number} viewportWidthCss
   * @param {number} viewportHeightCss
   * @private
   */
  _applyRenderResolution(viewportWidthCss, viewportHeightCss) {
    if (!this._renderer || typeof this._renderer.setPixelRatio !== 'function') return;

    try {
      const baseDpr = window.devicePixelRatio || 1;
      const effective = this._graphicsSettings?.computeEffectivePixelRatio
        ? this._graphicsSettings.computeEffectivePixelRatio(viewportWidthCss, viewportHeightCss, baseDpr)
        : baseDpr;
      this._renderer.setPixelRatio(effective);
    } catch (e) {
      log.warn('Failed to apply render resolution:', e);
    }
  }
}
