/**
 * @fileoverview OverlayUIManager
 * Generic manager for screen-space DOM overlays which can be anchored to Three.js world objects.
 *
 * This is intentionally framework-free and lightweight.
 */

import { createLogger } from '../core/log.js';

const log = createLogger('OverlayUI');

function _clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * @typedef {Object} OverlayHandle
 * @property {string} id
 * @property {HTMLElement} el
 * @property {boolean} visible
 * @property {boolean} clampToScreen
 * @property {{x:number,y:number}} offsetPx
 * @property {number} marginPx
 * @property {THREE.Object3D|null} anchorObject
 * @property {THREE.Vector3|null} anchorWorld
 * @property {boolean} lockedToScreen
 * @property {{x:number,y:number}|null} lockedScreenPos
 */

export class OverlayUIManager {
  /**
   * @param {HTMLElement} canvasElement
   * @param {Object} sceneComposer
   */
  constructor(canvasElement, sceneComposer) {
    this.canvasElement = canvasElement;
    this.sceneComposer = sceneComposer;

    /** @type {HTMLElement|null} */
    this.root = null;

    /** @type {Map<string, OverlayHandle>} */
    this.overlays = new Map();

    // PERF: reuse vectors
    this._tmpWorld = null;
    this._tmpNdc = null;

    // PERF: reuse projected return object (avoid allocating {x,y,behind} per overlay per frame)
    this._tmpProjected = { x: 0, y: 0, behind: false };

    // PERF: cache canvas bounding rect to avoid per-frame DOMRect allocations.
    this._rectCache = { left: 0, top: 0, width: 0, height: 0, ts: 0 };
    this._rectCacheMaxAgeMs = 250;

    this._lastRect = null;
  }

  initialize(parentElement = document.body) {
    if (this.root) return;

    const root = document.createElement('div');
    root.id = 'map-shine-overlay-root';
    root.style.position = 'fixed';
    root.style.left = '0';
    root.style.top = '0';
    root.style.width = '100%';
    root.style.height = '100%';
    root.style.pointerEvents = 'none';
    root.style.zIndex = '10002';

    parentElement.appendChild(root);
    this.root = root;

    log.info('OverlayUIManager initialized');
  }

  /**
   * @param {string} id
   * @param {{capturePointerEvents?: boolean, clampToScreen?: boolean, offsetPx?: {x:number,y:number}, marginPx?: number}} [options]
   */
  createOverlay(id, options = {}) {
    if (!this.root) this.initialize();

    const key = String(id);
    if (this.overlays.has(key)) return this.overlays.get(key);

    const el = document.createElement('div');
    el.dataset.overlayId = key;
    el.style.position = 'fixed';
    el.style.left = '0px';
    el.style.top = '0px';
    el.style.transform = 'translate(-9999px, -9999px)';
    el.style.pointerEvents = options.capturePointerEvents === false ? 'none' : 'auto';

    this.root.appendChild(el);

    /** @type {OverlayHandle} */
    const h = {
      id: key,
      el,
      visible: true,
      clampToScreen: options.clampToScreen !== false,
      offsetPx: options.offsetPx ?? { x: 0, y: 0 },
      marginPx: Number.isFinite(options.marginPx) ? options.marginPx : 12,
      anchorObject: null,
      anchorWorld: null,
      lockedToScreen: false,
      lockedScreenPos: null,
    };

    this.overlays.set(key, h);
    return h;
  }

  removeOverlay(id) {
    const key = String(id);
    const h = this.overlays.get(key);
    if (!h) return;
    try {
      h.el.remove();
    } catch (_) {
    }
    this.overlays.delete(key);
  }

  setVisible(id, visible) {
    const h = this.overlays.get(String(id));
    if (!h) return;
    h.visible = !!visible;
    h.el.style.display = h.visible ? 'block' : 'none';
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  isVisible(id) {
    const h = this.overlays.get(String(id));
    return !!h?.visible;
  }

  /**
   * @param {string} id
   * @param {THREE.Object3D|null} object3d
   */
  setAnchorObject(id, object3d) {
    const h = this.overlays.get(String(id));
    if (!h) return;
    h.anchorObject = object3d || null;
    h.anchorWorld = null;
  }

  /**
   * @param {string} id
   * @param {THREE.Vector3|null} world
   */
  setAnchorWorld(id, world) {
    const h = this.overlays.get(String(id));
    if (!h) return;
    h.anchorWorld = world || null;
    h.anchorObject = null;
  }

  /**
   * Freeze an overlay at a screen-space coordinate (client space).
   * Useful for UI drags where you don't want the anchor to drift.
   * @param {string} id
   * @param {{x:number,y:number}} screenPos
   */
  lockOverlay(id, screenPos) {
    const h = this.overlays.get(String(id));
    if (!h) return;
    if (!screenPos || !Number.isFinite(screenPos.x) || !Number.isFinite(screenPos.y)) return;
    h.lockedToScreen = true;
    h.lockedScreenPos = { x: screenPos.x, y: screenPos.y };
  }

  /**
   * Release a screen-space lock.
   * @param {string} id
   */
  unlockOverlay(id) {
    const h = this.overlays.get(String(id));
    if (!h) return;
    h.lockedToScreen = false;
    h.lockedScreenPos = null;
  }

  _getCanvasRectCached(force = false) {
    const el = this.canvasElement;
    if (!el) return null;

    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const cache = this._rectCache;
    const maxAge = (typeof this._rectCacheMaxAgeMs === 'number') ? this._rectCacheMaxAgeMs : 250;

    if (!force && cache && cache.width > 0 && cache.height > 0 && (now - (cache.ts || 0)) < maxAge) {
      return cache;
    }

    let rect;
    try {
      rect = el.getBoundingClientRect();
    } catch (_) {
      rect = null;
    }

    if (rect) {
      cache.left = rect.left;
      cache.top = rect.top;
      cache.width = rect.width;
      cache.height = rect.height;
    }

    if (!cache.width || !cache.height) {
      cache.left = 0;
      cache.top = 0;
      cache.width = window.innerWidth;
      cache.height = window.innerHeight;
    }

    cache.ts = now;
    return cache;
  }

  _getCamera() {
    return this.sceneComposer?.camera || window.MapShine?.sceneComposer?.camera;
  }

  /**
   * Convert world position to screen pixel coordinates (client space).
   * @param {THREE.Vector3} world
   * @param {DOMRect} rect
   * @returns {{x:number,y:number,behind:boolean}|null}
   */
  _projectWorldToScreen(world, rect) {
    const THREE = window.THREE;
    if (!THREE) return null;

    const camera = this._getCamera();
    if (!camera) return null;

    // CRITICAL: Ensure camera matrices are current for accurate projection.
    // Without this, overlays can appear to "jump" once when the camera updates
    // in response to document/UI changes.
    try {
      camera.updateMatrixWorld?.();
      camera.updateProjectionMatrix?.();
    } catch (_) {
    }

    if (!this._tmpNdc) this._tmpNdc = new THREE.Vector3();
    const ndc = this._tmpNdc;
    ndc.copy(world);
    ndc.project(camera);

    // In clip space, visible depth is typically [-1, 1].
    // Values outside that range are not visible (including "behind" the camera).
    const behind = (ndc.z < -1) || (ndc.z > 1);

    const out = this._tmpProjected;
    out.x = (ndc.x * 0.5 + 0.5) * rect.width + rect.left;
    out.y = (-ndc.y * 0.5 + 0.5) * rect.height + rect.top;
    out.behind = behind;
    return out;
  }

  update(_timeInfo) {
    if (!this.root) return;

    const THREE = window.THREE;
    if (!THREE) return;

    const rect = this._getCanvasRectCached();
    if (!rect) return;
    this._lastRect = rect;

    if (!this._tmpWorld) this._tmpWorld = new THREE.Vector3();

    for (const h of this.overlays.values()) {
      if (!h.visible) continue;

      const el = h.el;
      if (!el) continue;

      // If locked, stay at a fixed screen-space position.
      if (h.lockedToScreen && h.lockedScreenPos) {
        const leftCss = `${Math.round(h.lockedScreenPos.x)}px`;
        const topCss = `${Math.round(h.lockedScreenPos.y)}px`;

        if (h._lastLeft !== leftCss) {
          el.style.left = leftCss;
          h._lastLeft = leftCss;
        }
        if (h._lastTop !== topCss) {
          el.style.top = topCss;
          h._lastTop = topCss;
        }
        if (h._lastTransform !== 'translate(-50%, -50%)') {
          el.style.transform = 'translate(-50%, -50%)';
          h._lastTransform = 'translate(-50%, -50%)';
        }
        continue;
      }

      let anchorWorld = null;
      if (h.anchorObject) {
        try {
          h.anchorObject.getWorldPosition(this._tmpWorld);
          anchorWorld = this._tmpWorld;
        } catch (_) {
          anchorWorld = null;
        }
      } else if (h.anchorWorld) {
        anchorWorld = this._tmpWorld.copy(h.anchorWorld);
      }

      if (!anchorWorld) {
        if (h._lastTransform !== 'translate(-9999px, -9999px)') {
          el.style.transform = 'translate(-9999px, -9999px)';
          h._lastTransform = 'translate(-9999px, -9999px)';
        }
        continue;
      }

      const projected = this._projectWorldToScreen(anchorWorld, rect);
      if (!projected || projected.behind) {
        if (h._lastTransform !== 'translate(-9999px, -9999px)') {
          el.style.transform = 'translate(-9999px, -9999px)';
          h._lastTransform = 'translate(-9999px, -9999px)';
        }
        continue;
      }

      let x = projected.x + (h.offsetPx?.x ?? 0);
      let y = projected.y + (h.offsetPx?.y ?? 0);

      if (h.clampToScreen) {
        const m = Number.isFinite(h.marginPx) ? h.marginPx : 12;
        x = _clamp(x, m, window.innerWidth - m);
        y = _clamp(y, m, window.innerHeight - m);
      }

      const leftCss = `${Math.round(x)}px`;
      const topCss = `${Math.round(y)}px`;

      if (h._lastLeft !== leftCss) {
        el.style.left = leftCss;
        h._lastLeft = leftCss;
      }
      if (h._lastTop !== topCss) {
        el.style.top = topCss;
        h._lastTop = topCss;
      }

      // Allow overlay content to handle its own centering offsets.
      if (h._lastTransform !== 'translate(-50%, -50%)') {
        el.style.transform = 'translate(-50%, -50%)';
        h._lastTransform = 'translate(-50%, -50%)';
      }
    }
  }

  dispose() {
    for (const id of this.overlays.keys()) {
      this.removeOverlay(id);
    }

    try {
      this.root?.remove();
    } catch (_) {
    }

    this.root = null;
    this.overlays.clear();
  }
}
