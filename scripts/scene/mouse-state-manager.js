/**
 * @fileoverview Centralized mouse state and coordinate conversion helper.
 *
 * Keeps one authoritative pointer snapshot (client/NDC/world/foundry) and
 * exposes conversion methods used by interaction subsystems.
 *
 * @module scene/mouse-state-manager
 */

import Coordinates from '../utils/coordinates.js';

export class MouseStateManager {
  /**
   * @param {object} deps
   * @param {HTMLElement} deps.canvasElement
   * @param {object} deps.sceneComposer
   */
  constructor({ canvasElement, sceneComposer }) {
    this.canvasElement = canvasElement;
    this.sceneComposer = sceneComposer;

    this._canvasRectCache = { left: 0, top: 0, width: 0, height: 0, ts: 0 };
    this._canvasRectCacheMaxAgeMs = 250;

    const THREE = window.THREE;
    this._raycaster = THREE ? new THREE.Raycaster() : null;
    this._plane = THREE ? new THREE.Plane(new THREE.Vector3(0, 0, 1), 0) : null;
    this._target = THREE ? new THREE.Vector3() : null;

    this._lastPointer = {
      clientX: null,
      clientY: null,
      insideCanvas: false,
      isFromUI: false,
      worldX: null,
      worldY: null,
      foundryX: null,
      foundryY: null,
      ts: 0,
    };
  }

  /** @param {HTMLElement} canvasElement */
  setCanvasElement(canvasElement) {
    this.canvasElement = canvasElement;
    this.getCanvasRectCached(true);
  }

  /** @param {object} sceneComposer */
  setSceneComposer(sceneComposer) {
    this.sceneComposer = sceneComposer;
  }

  getCanvasRectCached(force = false) {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const cache = this._canvasRectCache;

    if (!force && cache.width > 0 && cache.height > 0 && (now - (cache.ts || 0)) < this._canvasRectCacheMaxAgeMs) {
      return cache;
    }

    const rect = this.canvasElement?.getBoundingClientRect?.() ?? null;
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

  /**
   * @param {number} clientX
   * @param {number} clientY
   * @returns {{x:number,y:number}}
   */
  clientToNdc(clientX, clientY) {
    const rect = this.getCanvasRectCached();
    return {
      x: ((clientX - rect.left) / rect.width) * 2 - 1,
      y: -((clientY - rect.top) / rect.height) * 2 + 1,
    };
  }

  /**
   * @param {number} clientX
   * @param {number} clientY
   * @param {number} targetZ
   * @returns {THREE.Vector3|null}
   */
  viewportToWorld(clientX, clientY, targetZ = 0) {
    if (!this._raycaster || !this._plane || !this._target) return null;
    const camera = this.sceneComposer?.camera;
    if (!camera) return null;

    const ndc = this.clientToNdc(clientX, clientY);
    this._raycaster.setFromCamera(ndc, camera);

    if (this._plane.constant !== -targetZ) {
      this._plane.constant = -targetZ;
    }

    return this._raycaster.ray.intersectPlane(this._plane, this._target) || null;
  }

  /**
   * @param {number} clientX
   * @param {number} clientY
   * @returns {{x:number,y:number}|null}
   */
  screenToWorld(clientX, clientY) {
    // Default to Z=0 when groundZ is not yet available. Using a large fallback
    // Z causes pointer projections (and all proximity-based picking) to miss.
    const groundZ = this.sceneComposer?.groundZ ?? 0;
    const world = this.viewportToWorld(clientX, clientY, groundZ);
    if (!world) return null;
    return { x: world.x, y: world.y };
  }

  /**
   * Update the authoritative pointer snapshot.
   * @param {PointerEvent|MouseEvent} event
   * @param {{isFromUI?:boolean}} [opts]
   * @returns {object}
   */
  updateFromEvent(event, opts = {}) {
    const clientX = Number(event?.clientX);
    const clientY = Number(event?.clientY);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return this._lastPointer;

    const rect = this.getCanvasRectCached();
    const right = rect.left + rect.width;
    const bottom = rect.top + rect.height;
    const inside = clientX >= rect.left && clientX <= right && clientY >= rect.top && clientY <= bottom;

    const isFromUI = !!opts.isFromUI;
    const next = {
      clientX,
      clientY,
      insideCanvas: inside,
      isFromUI,
      worldX: null,
      worldY: null,
      foundryX: null,
      foundryY: null,
      ts: (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(),
    };

    if (inside) {
      const world = this.screenToWorld(clientX, clientY);
      if (world) {
        next.worldX = world.x;
        next.worldY = world.y;
        const fp = Coordinates.toFoundry(world.x, world.y);
        next.foundryX = fp.x;
        next.foundryY = fp.y;
      }
    }

    this._lastPointer = next;
    return next;
  }

  /** @returns {object} */
  getLastPointer() {
    return this._lastPointer;
  }
}
