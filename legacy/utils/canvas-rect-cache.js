/**
 * @fileoverview Layout-safe canvas bounding-rect cache.
 *
 * Keeps canvas client bounds fresh via ResizeObserver + scroll listeners and
 * exposes read-only `get()` for hot paths (render loop, overlay projection).
 * DOM layout reads happen only in observer callbacks / explicit refreshSync(),
 * never from per-frame updatables.
 *
 * @module utils/canvas-rect-cache
 */

/**
 * @typedef {{left:number, top:number, width:number, height:number}} CanvasRect
 */

export class CanvasRectCache {
  constructor() {
    /** @type {CanvasRect} */
    this._rect = { left: 0, top: 0, width: 0, height: 0 };

    /** @type {HTMLElement|null} */
    this._canvas = null;

    /** @type {ResizeObserver|null} */
    this._resizeObserver = null;

    /** @type {(() => void)|null} */
    this._scrollHandler = null;

    /** @type {(() => void)|null} */
    this._windowResizeHandler = null;

    /** @type {number|null} */
    this._rafId = null;

    /** @type {number|null} */
    this._collapseSidebarHookId = null;

    /** @type {(() => void)|null} */
    this._visualViewportHandler = null;

    this._disposed = false;
  }

  /**
   * Attach to a canvas element and begin observing layout changes.
   * Safe to call repeatedly when the canvas reference changes.
   * @param {HTMLElement|null|undefined} canvasElement
   */
  attach(canvasElement) {
    this.detach();
    this._canvas = canvasElement || null;
    if (!this._canvas) return;

    this._refreshSync();

    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this.scheduleRefresh());
      this._resizeObserver.observe(this._canvas);
      const parent = this._canvas.parentElement;
      if (parent) this._resizeObserver.observe(parent);
    }

    this._scrollHandler = () => this.scheduleRefresh();
    window.addEventListener('scroll', this._scrollHandler, { capture: true, passive: true });

    this._windowResizeHandler = () => this.scheduleRefresh();
    window.addEventListener('resize', this._windowResizeHandler, { passive: true });

    const vv = window.visualViewport;
    if (vv) {
      this._visualViewportHandler = () => this.scheduleRefresh();
      vv.addEventListener('resize', this._visualViewportHandler, { passive: true });
      vv.addEventListener('scroll', this._visualViewportHandler, { passive: true });
    }

    if (typeof Hooks !== 'undefined') {
      this._collapseSidebarHookId = Hooks.on('collapseSidebar', () => {
        setTimeout(() => this.scheduleRefresh(), 50);
      });
    }
  }

  /**
   * Coalesce multiple invalidations into a single rAF-time layout read.
   */
  scheduleRefresh() {
    if (this._disposed || this._rafId !== null) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      if (!this._disposed) this._refreshSync();
    });
  }

  /**
   * Read cached bounds. Never triggers layout.
   * @returns {CanvasRect}
   */
  get() {
    return this._rect;
  }

  /**
   * Force a synchronous layout read. Use only outside render hot paths
   * (canvas swap, one-time setup).
   * @returns {CanvasRect}
   */
  refreshSync() {
    return this._refreshSync();
  }

  detach() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    if (this._resizeObserver) {
      try { this._resizeObserver.disconnect(); } catch (_) {}
      this._resizeObserver = null;
    }

    if (this._scrollHandler) {
      try { window.removeEventListener('scroll', this._scrollHandler, { capture: true }); } catch (_) {}
      this._scrollHandler = null;
    }

    if (this._windowResizeHandler) {
      try { window.removeEventListener('resize', this._windowResizeHandler); } catch (_) {}
      this._windowResizeHandler = null;
    }

    if (this._visualViewportHandler) {
      const vv = window.visualViewport;
      try {
        vv?.removeEventListener('resize', this._visualViewportHandler);
        vv?.removeEventListener('scroll', this._visualViewportHandler);
      } catch (_) {}
      this._visualViewportHandler = null;
    }

    if (this._collapseSidebarHookId !== null) {
      try { Hooks.off('collapseSidebar', this._collapseSidebarHookId); } catch (_) {}
      this._collapseSidebarHookId = null;
    }

    this._canvas = null;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.detach();
  }

  /** @private @returns {CanvasRect} */
  _refreshSync() {
    const el = this._canvas;
    if (!el) return this._rect;

    let rect = null;
    try {
      rect = el.getBoundingClientRect();
    } catch (_) {
      rect = null;
    }

    if (rect) {
      this._rect.left = rect.left;
      this._rect.top = rect.top;
      this._rect.width = rect.width;
      this._rect.height = rect.height;
    }

    if (!this._rect.width || !this._rect.height) {
      this._rect.left = 0;
      this._rect.top = 0;
      this._rect.width = window.innerWidth;
      this._rect.height = window.innerHeight;
    }

    return this._rect;
  }
}
