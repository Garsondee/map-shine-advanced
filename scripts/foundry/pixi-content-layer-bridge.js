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
    this._captureThrottleMs = 66;

    /** @type {boolean} */
    this._dirty = true;

    /** @type {string} */
    this._lastUpdateStatus = 'init';

    /** @type {Array<[string, number]>} */
    this._hookIds = [];

    /** @type {Function|null} */
    this._tickerUpdateFn = null;
    /** @type {number} */
    this._tickerFrameId = 0;

    /** @type {number} Counts diagnostic pixel probe logs to avoid console spam */
    this._probeLogCount = 0;

    /** @type {string} */
    this._lastStageTransformSig = '';
    /** @type {boolean} */
    this._testPatternWasEnabled = false;

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

  /**
   * Toggleable debug mode that bypasses capture and writes a deterministic
   * test pattern into the world bridge texture. Useful to prove compositor
   * sampling is wired correctly before debugging capture logic.
   * @returns {boolean}
   * @private
   */
  _isCompositorSanityPatternEnabled() {
    return !!window?.MapShine?.__pixiBridgeForceTestPattern;
  }

  /**
   * Debug mode: use per-shape PIXI extraction replay instead of doc replay.
   * This is expensive and can be runtime-fragile on some Foundry/PIXI paths,
   * so keep it opt-in.
   * @returns {boolean}
   * @private
   */
  _isShapeReplayDebugEnabled() {
    return !!window?.MapShine?.__pixiBridgeUseShapeReplay;
  }

  /**
   * @param {PIXI.Renderer|null} renderer
   * @returns {{width:number,height:number}}
   * @private
   */
  _getViewportSize(renderer) {
    const screen = renderer?.screen;
    const width = Math.max(1, Math.round(Number(screen?.width) || Number(canvas?.app?.view?.width) || 1));
    const height = Math.max(1, Math.round(Number(screen?.height) || Number(canvas?.app?.view?.height) || 1));
    return { width, height };
  }

  /**
   * @param {number} width
   * @param {number} height
   * @returns {THREE.CanvasTexture|null}
   * @private
   */
  _ensureWorldCanvasSize(width, height) {
    let worldTexture = this._ensureChannelTexture('world');
    if (!worldTexture || !this._worldCanvas) return worldTexture;
    const w = Math.max(1, Math.round(Number(width) || 1));
    const h = Math.max(1, Math.round(Number(height) || 1));
    if (this._worldCanvas.width !== w || this._worldCanvas.height !== h) {
      this._worldCanvas.width = w;
      this._worldCanvas.height = h;
      this._recreateTexture('world');
      worldTexture = this._ensureChannelTexture('world');
    }
    return worldTexture;
  }

  /**
   * @param {number} width
   * @param {number} height
   * @returns {boolean}
   * @private
   */
  _renderCompositorSanityPattern(width, height) {
    const worldTexture = this._ensureWorldCanvasSize(width, height);
    if (!worldTexture || !this._worldCanvas) return false;
    const w = this._worldCanvas.width;
    const h = this._worldCanvas.height;
    const ctx = this._worldCanvas.getContext('2d');
    if (!ctx) return false;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255, 0, 255, 0.85)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255, 255, 255, 1.0)';
    ctx.lineWidth = Math.max(2, Math.round(Math.min(w, h) * 0.008));
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(w, h);
    ctx.moveTo(w, 0);
    ctx.lineTo(0, h);
    ctx.stroke();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.font = `${Math.max(14, Math.round(h * 0.03))}px sans-serif`;
    ctx.fillText('PIXI BRIDGE TEST PATTERN', Math.round(w * 0.05), Math.round(h * 0.1));

    worldTexture.needsUpdate = true;
    this._lastUpdateStatus = `captured:test-pattern:${w}x${h}`;
    this._dirty = false;
    return true;
  }

  /**
   * @param {any} drawingLike
   * @returns {any|null}
   * @private
   */
  _getDrawingDocument(drawingLike) {
    return drawingLike?.document ?? drawingLike?._original ?? null;
  }

  /**
   * @param {any} value
   * @param {number} fallback
   * @returns {number}
   * @private
   */
  _toNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  /**
   * @param {any} value
   * @param {boolean} fallback
   * @returns {boolean}
   * @private
   */
  _toBool(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === '1' || value === 'true') return true;
    if (value === 0 || value === '0' || value === 'false') return false;
    return fallback;
  }

  /**
   * @param {any} value
   * @returns {string|null}
   * @private
   */
  _normalizeHexColor(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const v = Math.max(0, Math.min(0xFFFFFF, Math.trunc(value)));
      return `#${v.toString(16).padStart(6, '0')}`;
    }
    if (value && typeof value === 'object') {
      const css = typeof value.css === 'string' ? value.css : null;
      if (css) return this._normalizeHexColor(css);
      const asNumber = Number(value.valueOf?.());
      if (Number.isFinite(asNumber)) return this._normalizeHexColor(asNumber);
      const asString = typeof value.toString === 'function' ? value.toString() : '';
      if (asString && asString !== '[object Object]') return this._normalizeHexColor(asString);
      return null;
    }
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    if (!raw) return null;
    if (raw.startsWith('#')) {
      if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
      if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
        const c = raw.slice(1);
        return `#${c[0]}${c[0]}${c[1]}${c[1]}${c[2]}${c[2]}`;
      }
      return null;
    }
    if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw}`;
    return null;
  }

  /**
   * @param {string|null} hex
   * @param {number} alpha
   * @returns {string}
   * @private
   */
  _rgbaFromHex(hex, alpha) {
    const safeHex = this._normalizeHexColor(hex) || '#ffffff';
    const a = Math.max(0, Math.min(1, this._toNumber(alpha, 1)));
    const r = Number.parseInt(safeHex.slice(1, 3), 16);
    const g = Number.parseInt(safeHex.slice(3, 5), 16);
    const b = Number.parseInt(safeHex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @returns {{x:number,y:number}}
   * @private
   */
  _worldToScreen(x, y) {
    const t = canvas?.stage?.worldTransform;
    if (!t) return { x, y };
    return {
      x: (t.a * x) + (t.c * y) + t.tx,
      y: (t.b * x) + (t.d * y) + t.ty,
    };
  }

  /**
   * @param {any} doc
   * @param {number} lx
   * @param {number} ly
   * @returns {{x:number,y:number}}
   * @private
   */
  _drawingLocalToWorld(doc, lx, ly) {
    const x = this._toNumber(doc?.x, 0);
    const y = this._toNumber(doc?.y, 0);
    const w = this._toNumber(doc?.shape?.width, 0);
    const h = this._toNumber(doc?.shape?.height, 0);
    const rotDeg = this._toNumber(doc?.rotation, 0);
    if (Math.abs(rotDeg) < 0.0001) return { x: x + lx, y: y + ly };

    const cx = w * 0.5;
    const cy = h * 0.5;
    const rad = (rotDeg * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const dx = lx - cx;
    const dy = ly - cy;
    return {
      x: x + cx + ((dx * c) - (dy * s)),
      y: y + cy + ((dx * s) + (dy * c)),
    };
  }

  /**
   * @param {any} doc
   * @returns {string}
   * @private
   */
  _resolveDrawingType(doc) {
    const t = doc?.shape?.type;
    const types = globalThis.CONST?.DRAWING_TYPES ?? {};
    if (t === types.RECTANGLE || t === 'r' || t === 'rectangle') return 'rectangle';
    if (t === types.ELLIPSE || t === 'e' || t === 'ellipse') return 'ellipse';
    if (t === types.POLYGON || t === 'p' || t === 'polygon') return 'polygon';
    if (t === types.FREEHAND || t === 'f' || t === 'freehand') return 'freehand';
    return 'rectangle';
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {any} doc
   * @param {string} kind
   * @returns {boolean}
   * @private
   */
  _traceDrawingPath(ctx, doc, kind) {
    const w = Math.max(0, this._toNumber(doc?.shape?.width, 0));
    const h = Math.max(0, this._toNumber(doc?.shape?.height, 0));
    const points = Array.isArray(doc?.shape?.points) ? doc.shape.points : [];

    if (kind === 'rectangle') {
      if (w <= 0 || h <= 0) return false;
      const corners = [
        this._drawingLocalToWorld(doc, 0, 0),
        this._drawingLocalToWorld(doc, w, 0),
        this._drawingLocalToWorld(doc, w, h),
        this._drawingLocalToWorld(doc, 0, h),
      ];
      const s0 = this._worldToScreen(corners[0].x, corners[0].y);
      ctx.beginPath();
      ctx.moveTo(s0.x, s0.y);
      for (let i = 1; i < corners.length; i += 1) {
        const s = this._worldToScreen(corners[i].x, corners[i].y);
        ctx.lineTo(s.x, s.y);
      }
      ctx.closePath();
      return true;
    }

    if (kind === 'ellipse') {
      if (w <= 0 || h <= 0) return false;
      const cx = w * 0.5;
      const cy = h * 0.5;
      const rx = w * 0.5;
      const ry = h * 0.5;
      ctx.beginPath();
      const steps = 48;
      for (let i = 0; i <= steps; i += 1) {
        const a = (i / steps) * Math.PI * 2;
        const lx = cx + Math.cos(a) * rx;
        const ly = cy + Math.sin(a) * ry;
        const world = this._drawingLocalToWorld(doc, lx, ly);
        const s = this._worldToScreen(world.x, world.y);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      }
      ctx.closePath();
      return true;
    }

    if (points.length >= 4) {
      ctx.beginPath();
      const start = this._drawingLocalToWorld(doc, this._toNumber(points[0], 0), this._toNumber(points[1], 0));
      const s0 = this._worldToScreen(start.x, start.y);
      ctx.moveTo(s0.x, s0.y);
      for (let i = 2; i + 1 < points.length; i += 2) {
        const world = this._drawingLocalToWorld(doc, this._toNumber(points[i], 0), this._toNumber(points[i + 1], 0));
        const s = this._worldToScreen(world.x, world.y);
        ctx.lineTo(s.x, s.y);
      }
      const isClosed = this._toBool(doc?.shape?.closed, false);
      const shouldClose = (kind === 'polygon' && isClosed);
      if (shouldClose) ctx.closePath();
      return shouldClose;
    }

    return false;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {any} doc
   * @private
   */
  _drawDrawingText(ctx, doc) {
    const text = String(doc?.text ?? '').trim();
    if (!text) return;

    const baseFontSize = Math.max(8, this._toNumber(doc?.fontSize, 48));
    const zoom = Math.max(0.01, Math.abs(this._toNumber(canvas?.stage?.worldTransform?.a, 1)));
    const fontSize = Math.max(8, baseFontSize * zoom);
    const fontFamily = String(doc?.fontFamily || 'Signika').trim() || 'Signika';
    const textAlpha = Math.max(0, Math.min(1, this._toNumber(doc?.textAlpha, 1)));
    const textColor = this._normalizeHexColor(doc?.textColor) || '#ffffff';
    const world = this._drawingLocalToWorld(doc, this._toNumber(doc?.shape?.width, 0) * 0.5, this._toNumber(doc?.shape?.height, 0) * 0.5);
    const p = this._worldToScreen(world.x, world.y);
    const rad = (this._toNumber(doc?.rotation, 0) * Math.PI) / 180;

    ctx.save();
    ctx.translate(p.x, p.y);
    if (Math.abs(rad) > 0.0001) ctx.rotate(rad);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${fontSize}px ${fontFamily}`;
    ctx.fillStyle = this._rgbaFromHex(textColor, textAlpha);
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  /**
   * Draw drawing docs directly into bridge canvas. This bypasses PIXI stage
   * extraction and gives deterministic bridge pixels.
   * @param {PIXI.DrawingsLayer|null} drawingsLayer
   * @param {number} width
   * @param {number} height
   * @returns {{ok:boolean,count:number,status:string}}
   * @private
   */
  _renderReplayCapture(drawingsLayer, width, height) {
    const worldTexture = this._ensureWorldCanvasSize(width, height);
    if (!worldTexture || !this._worldCanvas) {
      return { ok: false, count: 0, status: 'skip:world-channel-missing' };
    }
    const ctx = this._worldCanvas.getContext('2d');
    if (!ctx) return { ok: false, count: 0, status: 'skip:no-world-context' };

    const drawables = [];
    try {
      if (Array.isArray(drawingsLayer?.placeables)) drawables.push(...drawingsLayer.placeables);
      if (Array.isArray(drawingsLayer?.preview?.children)) drawables.push(...drawingsLayer.preview.children);
      if (drawingsLayer?._configPreview) drawables.push(drawingsLayer._configPreview);
    } catch (_) {}

    const replayDocs = [];
    const seen = new Set();
    for (const d of drawables) {
      const doc = this._getDrawingDocument(d);
      if (!doc) continue;
      const key = String(doc.id ?? d?.id ?? `${this._toNumber(doc.x, 0)}:${this._toNumber(doc.y, 0)}:${replayDocs.length}`);
      if (seen.has(key)) continue;
      seen.add(key);
      replayDocs.push(doc);
    }

    replayDocs.sort((a, b) => this._toNumber(a?.sort, 0) - this._toNumber(b?.sort, 0));

    const w = this._worldCanvas.width;
    const h = this._worldCanvas.height;
    ctx.clearRect(0, 0, w, h);

    let drawCount = 0;
    const zoom = Math.max(0.01, Math.abs(this._toNumber(canvas?.stage?.worldTransform?.a, 1)));
    for (const doc of replayDocs) {
      const kind = this._resolveDrawingType(doc);
      const isClosedPath = this._traceDrawingPath(ctx, doc, kind);
      if (isClosedPath || kind === 'freehand' || kind === 'polygon') {
        const fillAlpha = Math.max(0, Math.min(1, this._toNumber(doc?.fillAlpha, 0)));
        const fillType = this._toNumber(doc?.fillType, 0);
        const strokeAlpha = Math.max(0, Math.min(1, this._toNumber(doc?.strokeAlpha, 1)));
        const strokeWidth = Math.max(0, this._toNumber(doc?.strokeWidth, 8)) * zoom;

        if (isClosedPath && fillAlpha > 0.001 && fillType !== 0) {
          ctx.fillStyle = this._rgbaFromHex(this._normalizeHexColor(doc?.fillColor), fillAlpha);
          ctx.fill();
        }
        if (strokeAlpha > 0.001 && strokeWidth > 0.001) {
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.lineWidth = strokeWidth;
          ctx.strokeStyle = this._rgbaFromHex(this._normalizeHexColor(doc?.strokeColor), strokeAlpha);
          ctx.stroke();
        }
      }

      this._drawDrawingText(ctx, doc);
      drawCount += 1;
    }

    worldTexture.needsUpdate = true;
    if (drawCount <= 0) {
      return { ok: true, count: 0, status: `captured:replay-empty:${w}x${h}` };
    }
    return { ok: true, count: drawCount, status: `captured:replay:${w}x${h} docs=${drawCount}` };
  }

  /**
   * @returns {string}
   * @private
   */
  _getStageTransformSignature() {
    const t = canvas?.stage?.worldTransform;
    if (!t) return 'none';
    const q = (n) => Math.round(this._toNumber(n, 0) * 1000) / 1000;
    return `${q(t.a)}|${q(t.b)}|${q(t.c)}|${q(t.d)}|${q(t.tx)}|${q(t.ty)}`;
  }

  /**
   * @param {PIXI.DrawingsLayer|null} drawingsLayer
   * @returns {PIXI.DisplayObject[]}
   * @private
   */
  _collectDrawingShapeObjects(drawingsLayer) {
    const shapes = [];
    const seen = new Set();
    const collectFrom = (obj) => {
      const shape = obj?.shape ?? null;
      if (!shape) return;
      const id = shape._bridgeId ?? shape?.name ?? shape;
      if (seen.has(id)) return;
      seen.add(id);
      shapes.push(shape);
    };
    try {
      const placeables = Array.isArray(drawingsLayer?.placeables) ? drawingsLayer.placeables : [];
      for (const p of placeables) collectFrom(p);
      const preview = Array.isArray(drawingsLayer?.preview?.children) ? drawingsLayer.preview.children : [];
      for (const p of preview) collectFrom(p);
      if (drawingsLayer?._configPreview) collectFrom(drawingsLayer._configPreview);
    } catch (_) {}
    return shapes;
  }

  /**
   * Replay drawings by extracting each Foundry drawing shape object directly.
   * This keeps Foundry-native geometry, color, and text styling instead of
   * reinterpreting document fields in custom canvas drawing code.
   * @param {PIXI.DrawingsLayer|null} drawingsLayer
   * @param {PIXI.Renderer|null} renderer
   * @param {number} width
   * @param {number} height
   * @returns {{ok:boolean,count:number,status:string}}
   * @private
   */
  _renderFoundryShapeReplay(drawingsLayer, renderer, width, height) {
    const worldTexture = this._ensureWorldCanvasSize(width, height);
    if (!worldTexture || !this._worldCanvas || !renderer?.extract) {
      return { ok: false, count: 0, status: 'skip:shape-replay-unavailable' };
    }
    const ctx = this._worldCanvas.getContext('2d');
    if (!ctx) return { ok: false, count: 0, status: 'skip:no-world-context' };

    const shapes = this._collectDrawingShapeObjects(drawingsLayer);
    const w = this._worldCanvas.width;
    const h = this._worldCanvas.height;
    ctx.clearRect(0, 0, w, h);
    if (shapes.length <= 0) {
      worldTexture.needsUpdate = true;
      return { ok: true, count: 0, status: `captured:shape-replay-empty:${w}x${h}` };
    }

    let drawn = 0;
    for (const shape of shapes) {
      if (!shape) continue;
      let bounds = null;
      try { bounds = shape.getBounds?.(false) ?? null; } catch (_) { bounds = null; }
      const bx = Math.floor(this._toNumber(bounds?.x, 0));
      const by = Math.floor(this._toNumber(bounds?.y, 0));
      const bw = Math.ceil(this._toNumber(bounds?.width, 0));
      const bh = Math.ceil(this._toNumber(bounds?.height, 0));
      if (bw <= 0 || bh <= 0) continue;
      const frame = new PIXI.Rectangle(bx, by, bw, bh);
      let shapeCanvas = null;
      try {
        shapeCanvas = renderer.extract.canvas(shape, frame);
      } catch (_) {
        shapeCanvas = null;
      }
      if (!shapeCanvas || !shapeCanvas.width || !shapeCanvas.height) continue;
      try {
        ctx.drawImage(shapeCanvas, bx, by, bw, bh);
        drawn += 1;
      } catch (_) {}
    }

    worldTexture.needsUpdate = true;
    return { ok: true, count: drawn, status: `captured:shape-replay:${w}x${h} shapes=${drawn}` };
  }

  /**
   * Fast sparse probe for any non-empty pixel content.
   * @param {HTMLCanvasElement|null} source
   * @returns {boolean}
   * @private
   */
  _canvasHasContent(source) {
    if (!source || !source.width || !source.height) return false;
    let ctx = null;
    try { ctx = source.getContext('2d'); } catch (_) { ctx = null; }
    if (!ctx) return false;

    const w = source.width;
    const h = source.height;
    for (let iy = 1; iy <= 5; iy += 1) {
      for (let ix = 1; ix <= 9; ix += 1) {
        const px = Math.min(w - 1, Math.floor((ix / 10) * w));
        const py = Math.min(h - 1, Math.floor((iy / 6) * h));
        let d = null;
        try { d = ctx.getImageData(px, py, 1, 1).data; } catch (_) { d = null; }
        if (!d) continue;
        if (d[3] > 0 || d[0] > 0 || d[1] > 0 || d[2] > 0) return true;
      }
    }
    return false;
  }

  update(frameId) {
    if (!canvas?.ready) {
      this._lastUpdateStatus = 'skip:canvas-not-ready';
      this._clearChannel('world');
      this._clearChannel('ui');
      return;
    }

    let worldTexture = this._ensureChannelTexture('world');
    if (!worldTexture || !this._worldCanvas) {
      this._lastUpdateStatus = 'skip:world-channel-missing';
      return;
    }

    const drawingsLayer = canvas?.drawings;
    const hasLivePreview = !!drawingsLayer?.preview?.children?.length;
    const forceTestPattern = this._isCompositorSanityPatternEnabled();
    const stageSig = this._getStageTransformSignature();

    if (this._lastStageTransformSig && stageSig !== this._lastStageTransformSig) {
      this._dirty = true;
    }
    this._lastStageTransformSig = stageSig;

    if (this._testPatternWasEnabled && !forceTestPattern) {
      this._dirty = true;
    }
    this._testPatternWasEnabled = forceTestPattern;

    // Fullscreen extraction is expensive. Outside of explicit dirty changes,
    // only keep capturing while a drawing preview is actively being edited.
    if (!this._dirty && !hasLivePreview && !forceTestPattern) {
      this._lastUpdateStatus = 'skip:idle';
      return;
    }

    const hasFrameId = (arguments.length > 0) && Number.isFinite(frameId);
    if (hasFrameId && frameId === this._lastCaptureFrame && !this._dirty && !forceTestPattern) {
      this._lastUpdateStatus = 'skip:duplicate-frame';
      return;
    }

    const now = performance.now();
    if (!forceTestPattern && !hasLivePreview && (now - this._lastCaptureMs) < this._captureThrottleMs) {
      this._lastUpdateStatus = 'skip:throttled';
      return;
    }

    this._lastCaptureMs = now;
    this._lastCaptureFrame = hasFrameId ? frameId : this._lastCaptureFrame;

    const renderer = canvas?.app?.renderer;
    const extract = renderer?.extract;
    if (!renderer || !extract) {
      this._lastUpdateStatus = 'skip:renderer-missing';
      this._clearChannel('world');
      this._clearChannel('ui');
      return;
    }

    const viewport = this._getViewportSize(renderer);
    if (this._isCompositorSanityPatternEnabled()) {
      if (this._renderCompositorSanityPattern(viewport.width, viewport.height)) return;
    }

    const useShapeReplay = this._isShapeReplayDebugEnabled();
    const replayResult = useShapeReplay
      ? this._renderFoundryShapeReplay(drawingsLayer, renderer, viewport.width, viewport.height)
      : this._renderReplayCapture(drawingsLayer, viewport.width, viewport.height);
    if (replayResult.ok) {
      this._lastUpdateStatus = replayResult.status;
      this._dirty = false;
      return;
    }

    // -------------------------------------------------------------------------
    // KEY INSIGHT: In Foundry VTT, Drawing._draw() adds the shape graphics to
    // canvas.primary (or canvas.interface) via PrimaryCanvasGroup.addDrawing(),
    // NOT to canvas.drawings. The DrawingsLayer only holds empty frame/handle
    // containers. The actual visual content (shapes, fills, strokes, text) lives
    // as children of canvas.primary or canvas.interface.
    //
    // Strategy: render canvas.stage to an RT, but temporarily hide everything
    // in the stage EXCEPT the drawing shape objects. We identify drawing shapes
    // by collecting placeable.shape references from canvas.drawings.placeables.
    // -------------------------------------------------------------------------

    // Collect all drawing shape objects (they live in canvas.primary/canvas.interface).
    const drawingShapes = new Set();
    try {
      const placeables = Array.isArray(drawingsLayer?.placeables) ? drawingsLayer.placeables : [];
      for (const p of placeables) {
        if (p?.shape) drawingShapes.add(p.shape);
      }
    } catch (_) {}

    if (drawingShapes.size === 0) {
      this._lastUpdateStatus = 'skip:no-drawing-shapes';
      this._clearChannel('world');
      this._clearChannel('ui');
      return;
    }

    const fw = viewport.width;
    const fh = viewport.height;
    const frame = new PIXI.Rectangle(0, 0, fw, fh);

    let capturedCanvas = null;
    // Saved state arrays for restore in finally block.
    /** @type {Array<{obj: PIXI.DisplayObject, visible: boolean, renderable: boolean, alpha: number}>} */
    const savedState = [];
    /** @type {Array<{obj: PIXI.DisplayObject, mask: any, filters: any, filterArea: any, cullable: any}>} */
    const savedCompositing = [];

    try {
      if (window?.MapShine) window.MapShine.__bridgeCaptureActive = true;
      const stageRoot = canvas?.stage;
      if (!stageRoot) {
        this._lastUpdateStatus = 'skip:no-stage';
        this._clearChannel('world');
        return;
      }

      // Force the stage root itself visible/renderable. Some MapShine flows can
      // temporarily hide higher-level containers during mode switches.
      savedState.push({
        obj: stageRoot,
        visible: stageRoot.visible,
        renderable: stageRoot.renderable,
        alpha: Number(stageRoot.alpha),
      });
      stageRoot.visible = true;
      stageRoot.renderable = true;
      if (!Number.isFinite(stageRoot.alpha) || stageRoot.alpha <= 0) stageRoot.alpha = 1;

      // Identify the parent containers that hold drawing shapes.
      // Typically canvas.primary and/or canvas.interface.
      const shapeParents = new Set();
      for (const shape of drawingShapes) {
        if (shape.parent) shapeParents.add(shape.parent);
      }

      // Build ancestor paths from each shape parent up to stage root.
      // We need all ancestors visible and all non-ancestor siblings hidden.
      const ancestorNodes = new Set();
      for (const parent of shapeParents) {
        let node = parent;
        while (node && node !== stageRoot) {
          ancestorNodes.add(node);
          node = node.parent ?? null;
        }
      }

      // Save and force-show all ancestor nodes.
      for (const node of ancestorNodes) {
        savedState.push({
          obj: node,
          visible: node.visible,
          renderable: node.renderable,
          alpha: Number(node.alpha),
        });
        node.visible = true;
        node.renderable = true;
        if (!Number.isFinite(node.alpha) || node.alpha <= 0) node.alpha = 1;
      }

      // Hide all stage direct children except ancestors of drawing shapes.
      if (stageRoot.children) {
        for (const child of stageRoot.children) {
          if (ancestorNodes.has(child)) continue;
          savedState.push({
            obj: child,
            visible: child.visible,
            renderable: child.renderable,
            alpha: Number(child.alpha),
          });
          child.visible = false;
          child.renderable = false;
        }
      }

      // Within each shape parent container, hide all children that are NOT
      // drawing shapes so we only capture drawings, not tiles/tokens/etc.
      for (const parent of shapeParents) {
        if (!parent.children) continue;
        for (const child of parent.children) {
          if (drawingShapes.has(child)) {
            // Force drawing shape visible for capture.
            savedState.push({
              obj: child,
              visible: child.visible,
              renderable: child.renderable,
              alpha: Number(child.alpha),
            });
            child.visible = true;
            child.renderable = true;
            if (!Number.isFinite(child.alpha) || child.alpha <= 0) child.alpha = 1;
          } else {
            // Hide non-drawing siblings.
            savedState.push({
              obj: child,
              visible: child.visible,
              renderable: child.renderable,
              alpha: Number(child.alpha),
            });
            child.visible = false;
            child.renderable = false;
          }
        }
      }

      // Disable masks/filters on ancestor chain + drawing shapes to prevent
      // external mask dependencies from collapsing the output to transparent.
      const compNodes = new Set([stageRoot, ...ancestorNodes, ...drawingShapes]);
      for (const node of compNodes) {
        if (!node) continue;
        savedCompositing.push({
          obj: node,
          mask: node.mask,
          filters: node.filters,
          filterArea: node.filterArea,
          cullable: node.cullable,
        });
        node.mask = null;
        node.filters = null;
        node.filterArea = null;
        if ('cullable' in node) node.cullable = false;
      }

      if (this._probeLogCount === 0) {
        const parentNames = [...shapeParents].map(p => p.constructor?.name || 'unknown').join(',');
        const stageName = stageRoot?.constructor?.name || 'unknown';
        log.info(`[Bridge] Drawing shapes: ${drawingShapes.size} in parents=[${parentNames}], ancestors=${ancestorNodes.size}, stage=${stageName}`);
      }

      // Render canvas.stage (with pan/zoom transform) to an RT, then extract.
      let tempRT = null;
      try {
        tempRT = PIXI.RenderTexture.create({ width: fw, height: fh });
        const pixiVersion = String(PIXI?.VERSION || '');
        const isPixiV7 = /^7\./.test(pixiVersion);
        if (isPixiV7) {
          // PIXI v7 signature: render(displayObject, renderTexture, clear)
          renderer.render(stageRoot, tempRT, true);
        } else {
          // PIXI v8 signature: render(displayObject, {target, clear})
          // Keep a fallback to v7 signature for safety.
          try {
            renderer.render(stageRoot, { target: tempRT, clear: true });
          } catch (_v8Err) {
            renderer.render(stageRoot, tempRT, true);
          }
        }
        capturedCanvas = extract.canvas(tempRT, frame);
      } finally {
        if (tempRT) {
          try { tempRT.destroy(true); } catch (_) {}
        }
      }
    } catch (err) {
      log.warn('Drawings capture failed', err);
      this._lastUpdateStatus = 'skip:capture-threw';
      this._clearChannel('world');
      this._clearChannel('ui');
      return;
    } finally {
      // Restore all saved state in reverse order.
      for (const { obj, mask, filters, filterArea, cullable } of savedCompositing) {
        obj.mask = mask;
        obj.filters = filters;
        obj.filterArea = filterArea;
        if ('cullable' in obj) obj.cullable = cullable;
      }
      for (let i = savedState.length - 1; i >= 0; i -= 1) {
        const s = savedState[i];
        s.obj.visible = s.visible;
        s.obj.renderable = s.renderable;
        s.obj.alpha = s.alpha;
      }
      if (window?.MapShine) window.MapShine.__bridgeCaptureActive = false;
    }

    // Fallback path: if strict isolation produced a fully transparent capture,
    // retry with minimal mutation. Foundry primary rendering can depend on
    // container state that aggressive sibling hiding disrupts.
    if (capturedCanvas && !this._canvasHasContent(capturedCanvas)) {
      const stageRoot = canvas?.stage ?? null;
      const primary = canvas?.primary ?? null;
      const iface = canvas?.interface ?? null;
      if (stageRoot) {
        /** @type {Array<{obj: PIXI.DisplayObject, visible: boolean, renderable: boolean, alpha: number}>} */
        const savedFallbackState = [];
        let fallbackCanvas = null;
        try {
          if (window?.MapShine) window.MapShine.__bridgeCaptureActive = true;
          for (const node of [stageRoot, primary, iface]) {
            if (!node) continue;
            savedFallbackState.push({
              obj: node,
              visible: node.visible,
              renderable: node.renderable,
              alpha: Number(node.alpha)
            });
            node.visible = true;
            node.renderable = true;
            if (!Number.isFinite(node.alpha) || node.alpha <= 0) node.alpha = 1;
          }

          let tempRT = null;
          try {
            tempRT = PIXI.RenderTexture.create({ width: fw, height: fh });
            const pixiVersion = String(PIXI?.VERSION || '');
            const isPixiV7 = /^7\./.test(pixiVersion);
            if (isPixiV7) {
              renderer.render(stageRoot, tempRT, true);
            } else {
              try {
                renderer.render(stageRoot, { target: tempRT, clear: true });
              } catch (_) {
                renderer.render(stageRoot, tempRT, true);
              }
            }
            fallbackCanvas = extract.canvas(tempRT, frame);
          } finally {
            if (tempRT) {
              try { tempRT.destroy(true); } catch (_) {}
            }
          }
        } catch (_) {
        } finally {
          for (let i = savedFallbackState.length - 1; i >= 0; i -= 1) {
            const s = savedFallbackState[i];
            s.obj.visible = s.visible;
            s.obj.renderable = s.renderable;
            s.obj.alpha = s.alpha;
          }
          if (window?.MapShine) window.MapShine.__bridgeCaptureActive = false;
        }

        if (fallbackCanvas && this._canvasHasContent(fallbackCanvas)) {
          capturedCanvas = fallbackCanvas;
          this._lastUpdateStatus = `captured-fallback:${fw}x${fh}`;
          log.warn('[Bridge] Isolated drawings capture was empty; using non-isolated fallback stage capture');
        }
      }
    }

    // Final fallback: PrimaryCanvasGroup can render correctly only in Foundry's
    // normal app render path on some runtimes. If both RT extraction paths are
    // empty, force one app render and copy pixels from canvas.app.view.
    if (capturedCanvas && !this._canvasHasContent(capturedCanvas)) {
      const app = canvas?.app ?? null;
      const view = app?.view ?? null;
      const stageRoot = canvas?.stage ?? null;
      const primary = canvas?.primary ?? null;
      const iface = canvas?.interface ?? null;
      if (app && view && stageRoot) {
        /** @type {Array<{obj: PIXI.DisplayObject, visible: boolean, renderable: boolean, alpha: number}>} */
        const savedViewFallbackState = [];
        try {
          if (window?.MapShine) window.MapShine.__bridgeCaptureActive = true;
          for (const node of [stageRoot, primary, iface, ...drawingShapes]) {
            if (!node) continue;
            savedViewFallbackState.push({
              obj: node,
              visible: node.visible,
              renderable: node.renderable,
              alpha: Number(node.alpha)
            });
            node.visible = true;
            node.renderable = true;
            if (!Number.isFinite(node.alpha) || node.alpha <= 0) node.alpha = 1;
          }

          // Render via Foundry's normal PIXI app path.
          try { app.render?.(); } catch (_) {}

          const vw = Math.max(1, Math.round(Number(view.width) || fw));
          const vh = Math.max(1, Math.round(Number(view.height) || fh));
          const copyCanvas = document.createElement('canvas');
          // Bridge output must stay in screen-space dimensions (fw/fh).
          // app.view can be higher-DPI backing size (vw/vh), which otherwise
          // creates a partial-content square when sampled in compositor UV space.
          copyCanvas.width = fw;
          copyCanvas.height = fh;
          const copyCtx = copyCanvas.getContext('2d');
          if (copyCtx) {
            copyCtx.clearRect(0, 0, fw, fh);
            copyCtx.drawImage(view, 0, 0, vw, vh, 0, 0, fw, fh);
            if (this._canvasHasContent(copyCanvas)) {
              capturedCanvas = copyCanvas;
              this._lastUpdateStatus = `captured-view-fallback:${fw}x${fh}`;
              log.warn('[Bridge] RT extraction empty; using app.view fallback capture');
            }
          }
        } catch (_) {
        } finally {
          for (let i = savedViewFallbackState.length - 1; i >= 0; i -= 1) {
            const s = savedViewFallbackState[i];
            s.obj.visible = s.visible;
            s.obj.renderable = s.renderable;
            s.obj.alpha = s.alpha;
          }
          if (window?.MapShine) window.MapShine.__bridgeCaptureActive = false;
        }
      }
    }

    if (!capturedCanvas || !capturedCanvas.width || !capturedCanvas.height) {
      this._lastUpdateStatus = 'skip:empty-capture';
      this._clearChannel('world');
      this._clearChannel('ui');
      return;
    }

    const w = Math.max(1, capturedCanvas.width);
    const h = Math.max(1, capturedCanvas.height);

    const hadFallbackStatus =
      typeof this._lastUpdateStatus === 'string' &&
      (this._lastUpdateStatus.startsWith('captured-fallback:') || this._lastUpdateStatus.startsWith('captured-view-fallback:'));

    if (this._worldCanvas.width !== w || this._worldCanvas.height !== h) {
      this._worldCanvas.width = w;
      this._worldCanvas.height = h;
      this._recreateTexture('world');
      worldTexture = this._ensureChannelTexture('world');
    }

    const worldCtx = this._worldCanvas.getContext('2d');
    if (!worldCtx) return;
    worldCtx.clearRect(0, 0, w, h);
    worldCtx.drawImage(capturedCanvas, 0, 0, w, h);
    if (worldTexture) worldTexture.needsUpdate = true;

    // Pixel probe: sample a sparse grid to verify captured content contains
    // non-transparent pixels. Log only for the first few captures so it
    // doesn't spam the console at 60fps once confirmed working.
    if (this._probeLogCount < 5) {
      try {
        const probePoints = [];
        for (let iy = 1; iy <= 5; iy += 1) {
          for (let ix = 1; ix <= 9; ix += 1) {
            probePoints.push([
              Math.min(w - 1, Math.floor((ix / 10) * w)),
              Math.min(h - 1, Math.floor((iy / 6) * h)),
            ]);
          }
        }
        let maxAlpha = 0;
        let maxRgb = 0;
        let nonEmptySamples = 0;
        for (const [px, py] of probePoints) {
          const d = worldCtx.getImageData(px, py, 1, 1).data;
          maxAlpha = Math.max(maxAlpha, d[3]);
          maxRgb = Math.max(maxRgb, d[0], d[1], d[2]);
          if (d[3] > 0 || d[0] > 0 || d[1] > 0 || d[2] > 0) nonEmptySamples += 1;
        }
        log.info(`[Bridge probe #${this._probeLogCount + 1}] ${w}x${h} — maxAlpha=${maxAlpha} maxRGB=${maxRgb} nonEmptySamples=${nonEmptySamples}/${probePoints.length} (0=transparent,255=opaque)`);
      } catch (_) {}
      this._probeLogCount++;
    }

    // UI channel reserved for future PIXI UI/HUD ingestion.
    if (this._uiCanvas && this._uiTexture) {
      let uiTexture = this._uiTexture;
      if (this._uiCanvas.width !== w || this._uiCanvas.height !== h) {
        this._uiCanvas.width = w;
        this._uiCanvas.height = h;
        this._recreateTexture('ui');
        uiTexture = this._uiTexture;
      }
      const uiCtx = this._uiCanvas.getContext('2d');
      if (uiCtx) {
        uiCtx.clearRect(0, 0, w, h);
        if (uiTexture) uiTexture.needsUpdate = true;
      }
    }

    this._dirty = false;
    if (!hadFallbackStatus) {
      this._lastUpdateStatus = `captured:${w}x${h} shapes=${drawingShapes.size} probe#${this._probeLogCount}`;
    }
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
