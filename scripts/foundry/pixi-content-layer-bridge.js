/**
 * @fileoverview PIXI Content Layer Bridge
 *
 * Drawings-first bridge that captures selected Foundry PIXI layer output and
 * publishes it as Three.js textures for V2 compositing.
 *
 * Phase 1 scope:
 * - Drawings layer capture only
 * - Dual-channel output contract (world/ui), with drawings routed to world by default
 *
 * @module foundry/pixi-content-layer-bridge
 */

import { createLogger } from '../core/log.js';

const log = createLogger('PixiContentLayerBridge');

export class PixiContentLayerBridge {
  constructor() {
    const THREE = window.THREE;

    /** @type {typeof import('three') | null} */
    this._THREE = THREE ?? null;

    /** @type {THREE.CanvasTexture|null} */
    this._worldTexture = null;
    /** @type {THREE.CanvasTexture|null} */
    this._uiTexture = null;

    /** @type {HTMLCanvasElement|null} */
    this._worldCanvas = null;
    /** @type {HTMLCanvasElement|null} */
    this._uiCanvas = null;

    /** @type {number} */
    this._lastCaptureFrame = -1;
    /** @type {number} */
    this._lastCaptureMs = 0;
    /** @type {number} */
    this._captureThrottleMs = 16;

    /** @type {boolean} */
    this._dirty = true;

    /** @type {Array<[string, number]>} */
    this._hookIds = [];

    /** @type {Function|null} */
    this._tickerUpdateFn = null;
    /** @type {number} */
    this._tickerFrameId = 0;

    if (THREE) {
      this._worldCanvas = document.createElement('canvas');
      this._uiCanvas = document.createElement('canvas');
      this._worldCanvas.width = this._uiCanvas.width = 1;
      this._worldCanvas.height = this._uiCanvas.height = 1;

      this._worldTexture = this._createCanvasTexture(this._worldCanvas);
      this._uiTexture = this._createCanvasTexture(this._uiCanvas);
    }
  }

  /**
   * @param {HTMLCanvasElement} source
   * @returns {THREE.CanvasTexture|null}
   * @private
   */
  _createCanvasTexture(source) {
    const THREE = this._THREE;
    if (!THREE || !source) return null;
    const tex = new THREE.CanvasTexture(source);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /**
   * Recreate the backing CanvasTexture when canvas dimensions change.
   * Prevents WebGL texSubImage out-of-bounds uploads.
   * @param {'world'|'ui'} channel
   * @private
   */
  _recreateTexture(channel) {
    if (channel === 'world') {
      try { this._worldTexture?.dispose?.(); } catch (_) {}
      this._worldTexture = this._createCanvasTexture(this._worldCanvas);
      return;
    }
    try { this._uiTexture?.dispose?.(); } catch (_) {}
    this._uiTexture = this._createCanvasTexture(this._uiCanvas);
  }

  /**
   * Ensure a channel has both a backing canvas and CanvasTexture.
   * @param {'world'|'ui'} channel
   * @returns {THREE.CanvasTexture|null}
   * @private
   */
  _ensureChannelTexture(channel) {
    if (!this._THREE) return null;

    if (channel === 'world') {
      if (!this._worldCanvas) {
        this._worldCanvas = document.createElement('canvas');
        this._worldCanvas.width = 1;
        this._worldCanvas.height = 1;
      }
      if (!this._worldTexture) this._worldTexture = this._createCanvasTexture(this._worldCanvas);
      return this._worldTexture;
    }

    if (!this._uiCanvas) {
      this._uiCanvas = document.createElement('canvas');
      this._uiCanvas.width = 1;
      this._uiCanvas.height = 1;
    }
    if (!this._uiTexture) this._uiTexture = this._createCanvasTexture(this._uiCanvas);
    return this._uiTexture;
  }

  /**
   * Clears a channel canvas to transparent and marks its texture dirty.
   * @param {'world'|'ui'} channel
   * @private
   */
  _clearChannel(channel) {
    const texture = this._ensureChannelTexture(channel);
    const targetCanvas = channel === 'world' ? this._worldCanvas : this._uiCanvas;
    if (!texture || !targetCanvas) return;

    const w = Math.max(1, targetCanvas.width || 1);
    const h = Math.max(1, targetCanvas.height || 1);
    const ctx = targetCanvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    texture.needsUpdate = true;
  }

  initialize() {
    if (!this._hookIds.length) {
      this._hookIds.push(['createDrawing', Hooks.on('createDrawing', () => { this._dirty = true; })]);
      this._hookIds.push(['updateDrawing', Hooks.on('updateDrawing', () => { this._dirty = true; })]);
      this._hookIds.push(['deleteDrawing', Hooks.on('deleteDrawing', () => { this._dirty = true; })]);
      this._hookIds.push(['activateDrawingsLayer', Hooks.on('activateDrawingsLayer', () => { this._dirty = true; })]);
      this._hookIds.push(['renderSceneControls', Hooks.on('renderSceneControls', () => { this._dirty = true; })]);
      this._hookIds.push(['canvasPan', Hooks.on('canvasPan', () => { this._dirty = true; })]);
      this._hookIds.push(['canvasReady', Hooks.on('canvasReady', () => { this._dirty = true; })]);
    }

    if (!this._tickerUpdateFn) {
      const ticker = canvas?.app?.ticker;
      if (ticker?.add) {
        this._tickerUpdateFn = () => {
          this._tickerFrameId += 1;
          this.update(this._tickerFrameId);
        };
        try {
          ticker.add(this._tickerUpdateFn);
        } catch (err) {
          this._tickerUpdateFn = null;
          log.warn('Failed to register bridge ticker update', err);
        }
      }
    }

    this._dirty = true;
  }

  getWorldTexture() {
    return this._ensureChannelTexture('world');
  }

  getUiTexture() {
    return this._ensureChannelTexture('ui');
  }

  markDirty() {
    this._dirty = true;
  }

  update(frameId = 0) {
    if (!canvas?.ready) {
      this._clearChannel('world');
      this._clearChannel('ui');
      return;
    }

    const worldTexture = this._ensureChannelTexture('world');
    if (!worldTexture || !this._worldCanvas) return;

    const hasFrameId = Number.isFinite(frameId);
    if (hasFrameId && frameId === this._lastCaptureFrame && !this._dirty) return;

    const now = performance.now();
    if (!this._dirty && (now - this._lastCaptureMs) < this._captureThrottleMs) return;

    this._lastCaptureMs = now;
    this._lastCaptureFrame = hasFrameId ? frameId : this._lastCaptureFrame;

    const renderer = canvas?.app?.renderer;
    const drawingsLayer = canvas?.drawings;
    const extract = renderer?.extract;
    if (!renderer || !drawingsLayer || !extract) {
      this._clearChannel('world');
      this._clearChannel('ui');
      return;
    }

    let capturedCanvas = null;
    try {
      // Capture the objects container instead of the whole DrawingsLayer.
      // Layer-level interaction primitives can include fullscreen selection
      // visuals which should not be composited into the world channel.
      const captureTarget = drawingsLayer?.objects ?? drawingsLayer;
      capturedCanvas = extract.canvas(captureTarget);
    } catch (err) {
      log.warn('Drawings capture failed', err);
      this._clearChannel('world');
      this._clearChannel('ui');
      return;
    }

    if (!capturedCanvas || !capturedCanvas.width || !capturedCanvas.height) {
      this._clearChannel('world');
      this._clearChannel('ui');
      return;
    }

    const w = Math.max(1, capturedCanvas.width);
    const h = Math.max(1, capturedCanvas.height);

    if (this._worldCanvas.width !== w || this._worldCanvas.height !== h) {
      this._worldCanvas.width = w;
      this._worldCanvas.height = h;
      this._recreateTexture('world');
    }

    const worldCtx = this._worldCanvas.getContext('2d');
    if (!worldCtx) return;
    worldCtx.clearRect(0, 0, w, h);
    worldCtx.drawImage(capturedCanvas, 0, 0, w, h);
    worldTexture.needsUpdate = true;

    // UI channel reserved for future PIXI UI/HUD ingestion.
    if (this._uiCanvas && this._uiTexture) {
      if (this._uiCanvas.width !== w || this._uiCanvas.height !== h) {
        this._uiCanvas.width = w;
        this._uiCanvas.height = h;
        this._recreateTexture('ui');
      }
      const uiCtx = this._uiCanvas.getContext('2d');
      if (uiCtx) {
        uiCtx.clearRect(0, 0, w, h);
        if (this._uiTexture) this._uiTexture.needsUpdate = true;
      }
    }

    this._dirty = false;
  }

  dispose() {
    for (const [name, id] of this._hookIds) {
      try { Hooks.off(name, id); } catch (_) {}
    }
    this._hookIds.length = 0;

    if (this._tickerUpdateFn) {
      try {
        canvas?.app?.ticker?.remove?.(this._tickerUpdateFn);
      } catch (_) {}
      this._tickerUpdateFn = null;
    }
    this._tickerFrameId = 0;

    try { this._worldTexture?.dispose?.(); } catch (_) {}
    try { this._uiTexture?.dispose?.(); } catch (_) {}

    this._worldTexture = null;
    this._uiTexture = null;
    this._worldCanvas = null;
    this._uiCanvas = null;
  }
}
