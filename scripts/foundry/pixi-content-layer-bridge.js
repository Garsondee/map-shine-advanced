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

    /** @type {number} Extra captures to run after state mutations settle async draws */
    this._postDirtyCapturesRemaining = 0;

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
    /** @type {number} */
    this._worldLogicalWidth = 1;
    /** @type {number} */
    this._worldLogicalHeight = 1;
    /** @type {number} */
    this._worldCaptureScale = 2.5;

    /** @type {HTMLCanvasElement|null} Cached settled sounds layer for fast preview rendering */
    this._soundsSettledCacheCanvas = null;
    /** @type {number} */
    this._soundsSettledCacheLogicalW = 0;
    /** @type {number} */
    this._soundsSettledCacheLogicalH = 0;

    /** @type {string} Signature of currently interactive sounds preview state */
    this._lastSoundsPreviewSig = '';

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
    tex.minFilter = THREE.LinearMipmapLinearFilter ?? THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
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
      const markDirty = (followupCaptures = 0) => {
        this._dirty = true;
        this._postDirtyCapturesRemaining = Math.max(
          this._postDirtyCapturesRemaining,
          Math.max(0, Math.round(this._toNumber(followupCaptures, 0)))
        );
      };

      this._hookIds.push(['createDrawing', Hooks.on('createDrawing', () => { markDirty(1); })]);
      this._hookIds.push(['updateDrawing', Hooks.on('updateDrawing', () => { markDirty(1); })]);
      this._hookIds.push(['deleteDrawing', Hooks.on('deleteDrawing', () => { markDirty(1); })]);
      this._hookIds.push(['activateDrawingsLayer', Hooks.on('activateDrawingsLayer', () => { markDirty(1); })]);
      this._hookIds.push(['createAmbientSound', Hooks.on('createAmbientSound', () => { markDirty(2); })]);
      this._hookIds.push(['updateAmbientSound', Hooks.on('updateAmbientSound', () => { markDirty(2); })]);
      this._hookIds.push(['deleteAmbientSound', Hooks.on('deleteAmbientSound', () => { markDirty(2); })]);
      this._hookIds.push(['activateSoundsLayer', Hooks.on('activateSoundsLayer', () => { markDirty(2); })]);
      this._hookIds.push(['renderSceneControls', Hooks.on('renderSceneControls', () => { markDirty(1); })]);
      this._hookIds.push(['canvasReady', Hooks.on('canvasReady', () => { markDirty(1); })]);
    }

    // Compositor render() already calls bridge.update() once per frame.
    // Keep a single driver to avoid out-of-phase capture/composite updates.

    this._dirty = true;
  }

  getWorldTexture() {
    return this._ensureChannelTexture('world');
  }

  getUiTexture() {
    return this._ensureChannelTexture('ui');
  }

  /**
   * Logical world capture dimensions (Foundry world pixels, unscaled).
   * @returns {{width:number,height:number}}
   */
  getWorldLogicalSize() {
    return {
      width: Math.max(1, Math.round(this._toNumber(this._worldLogicalWidth, 1))),
      height: Math.max(1, Math.round(this._toNumber(this._worldLogicalHeight, 1))),
    };
  }

  /**
   * Trace a PIXI shape into canvas path commands.
   * Supports common Foundry polygon/circle/ellipse/rect shapes.
   * @param {CanvasRenderingContext2D} ctx
   * @param {any} shape
   * @returns {boolean}
   * @private
   */
  _tracePixiShapePath(ctx, shape) {
    if (!ctx || !shape) return false;

    const points = Array.isArray(shape?.points) ? shape.points : null;
    if (points && points.length >= 4) {
      ctx.beginPath();
      ctx.moveTo(this._toNumber(points[0], 0), this._toNumber(points[1], 0));
      for (let i = 2; i + 1 < points.length; i += 2) {
        ctx.lineTo(this._toNumber(points[i], 0), this._toNumber(points[i + 1], 0));
      }
      ctx.closePath();
      return true;
    }

    if (Number.isFinite(shape?.radius)) {
      const cx = this._toNumber(shape?.x, 0);
      const cy = this._toNumber(shape?.y, 0);
      const r = Math.max(0, this._toNumber(shape?.radius, 0));
      if (r <= 0) return false;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      return true;
    }

    const ex = this._toNumber(shape?.x, NaN);
    const ey = this._toNumber(shape?.y, NaN);
    const ew = this._toNumber(shape?.width, NaN);
    const eh = this._toNumber(shape?.height, NaN);
    if (Number.isFinite(ex) && Number.isFinite(ey) && Number.isFinite(ew) && Number.isFinite(eh) && ew > 0 && eh > 0) {
      ctx.beginPath();
      ctx.rect(ex, ey, ew, eh);
      return true;
    }

    return false;
  }

  /**
   * Determine whether sounds preview is actively being manipulated.
   * We intentionally exclude config-confirmation mode (_creating), since that
   * state can persist and should not force per-frame recapture.
   * @param {any} soundsLayer
   * @returns {boolean}
   * @private
   */
  _isSoundsPreviewInteractive(soundsLayer) {
    const layerName = String(canvas?.activeLayer?.options?.name ?? '');
    const activeTool = String(game?.activeTool ?? ui?.controls?.activeTool ?? '');
    if (layerName !== 'sounds' || activeTool !== 'sound') return false;

    const preview = soundsLayer?.preview;
    if (!preview || preview?._creating) return false;
    const children = Array.isArray(preview.children) ? preview.children : [];
    for (const child of children) {
      if (!child) continue;
      if (child.visible === false) continue;
      if (child.renderable === false) continue;
      const alpha = Number(child.alpha);
      if (Number.isFinite(alpha) && alpha <= 0) continue;
      return true;
    }
    return false;
  }

  /**
   * Build a compact signature for interactive sounds preview geometry.
   * Signature changes drive live recapture; unchanged preview is treated idle.
   * @param {any} soundsLayer
   * @returns {string}
   * @private
   */
  _getSoundsPreviewSignature(soundsLayer) {
    if (!this._isSoundsPreviewInteractive(soundsLayer)) return '';
    const previewChildren = Array.isArray(soundsLayer?.preview?.children) ? soundsLayer.preview.children : [];
    const parts = [];
    for (const child of previewChildren) {
      if (!child) continue;
      if (child.visible === false || child.renderable === false) continue;
      const alpha = Number(child.alpha);
      if (Number.isFinite(alpha) && alpha <= 0) continue;

      const doc = child.document ?? {};
      const id = String(child.id ?? doc.id ?? parts.length);
      const x = Math.round(this._toNumber(doc.x ?? child.x, 0));
      const y = Math.round(this._toNumber(doc.y ?? child.y, 0));
      const radius = Math.round(this._toNumber(doc.radius, 0) * 100) / 100;
      const elevation = Math.round(this._toNumber(doc.elevation, 0) * 100) / 100;
      parts.push(`${id}:${x},${y},${radius},${elevation}`);
    }

    parts.sort();
    return parts.join('|');
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
   * Is the current control/layer context the native sounds workflow?
   * @returns {boolean}
   * @private
   */
  _isSoundsContextActive() {
    const activeControl = String(ui?.controls?.control?.name ?? ui?.controls?.activeControl ?? '').toLowerCase();
    const activeTool = String(ui?.controls?.tool?.name ?? ui?.controls?.activeTool ?? game?.activeTool ?? '').toLowerCase();
    const activeLayerName = String(canvas?.activeLayer?.options?.name ?? canvas?.activeLayer?.name ?? '').toLowerCase();
    const activeLayerCtor = String(canvas?.activeLayer?.constructor?.name ?? '').toLowerCase();
    const activeControlLayer = String(ui?.controls?.control?.layer ?? '').toLowerCase();
    return !!canvas?.sounds?.active
      || activeControl === 'sounds'
      || activeControl === 'sound'
      || activeTool === 'sound'
      || activeControlLayer === 'sounds'
      || activeControlLayer === 'sound'
      || activeLayerName === 'sounds'
      || activeLayerName === 'sound'
      || activeLayerCtor === 'soundslayer';
  }

  /**
   * Resolve capture strategy for the current frame.
   * Default is a deterministic drawings-only replay path to keep runtime stable.
   * Advanced extraction paths are debug-only and opt-in.
   *
   * Accepted values (debug/override):
   * - replay-only (default)
   * - replay-shape
   * - sounds-extract
   * - stage-extract
   *
   * If no override is provided, auto-select sounds-extract while actively
   * editing sounds, otherwise use replay-only.
   *
   * @returns {'replay-only'|'replay-shape'|'sounds-extract'|'stage-extract'}
   * @private
   */
  _getCaptureStrategy() {
    const raw = String(window?.MapShine?.__pixiBridgeCaptureStrategy || '').trim().toLowerCase();
    if (raw === 'stage-extract') return 'stage-extract';
    if (raw === 'sounds-extract') return 'sounds-extract';
    if (raw === 'replay-shape') return 'replay-shape';
    if (this._isSoundsContextActive()) return 'sounds-extract';
    return 'replay-only';
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
   * Use full padded canvas dimensions for world-space replay so overlay
   * sampling remains stable during pan/zoom and preserves map resolution.
   * @returns {{width:number,height:number}}
   * @private
   */
  _getWorldCaptureSize() {
    const dims = canvas?.dimensions ?? null;
    const width = Math.max(1, Math.round(this._toNumber(dims?.width, 1)));
    const height = Math.max(1, Math.round(this._toNumber(dims?.height, 1)));
    return { width, height };
  }

  /**
   * @param {number} logicalWidth
   * @param {number} logicalHeight
   * @returns {number}
   * @private
   */
  _getWorldCaptureScale(logicalWidth, logicalHeight) {
    const runtimeRequested = this._toNumber(window?.MapShine?.__pixiBridgeCaptureScale, this._worldCaptureScale);
    const requested = Math.max(1, runtimeRequested);
    const maxDim = 8192;
    const safeByWidth = maxDim / Math.max(1, logicalWidth);
    const safeByHeight = maxDim / Math.max(1, logicalHeight);
    return Math.max(1, Math.min(requested, safeByWidth, safeByHeight));
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
    this._worldLogicalWidth = Math.max(1, Math.round(this._toNumber(width, 1)));
    this._worldLogicalHeight = Math.max(1, Math.round(this._toNumber(height, 1)));
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
    return { x, y };
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
   * @returns {{hasPath:boolean,closed:boolean}}
   * @private
   */
  _traceDrawingPath(ctx, doc, kind) {
    const w = Math.max(0, this._toNumber(doc?.shape?.width, 0));
    const h = Math.max(0, this._toNumber(doc?.shape?.height, 0));
    const points = Array.isArray(doc?.shape?.points) ? doc.shape.points : [];

    if (kind === 'rectangle') {
      if (w <= 0 || h <= 0) return { hasPath: false, closed: false };
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
      return { hasPath: true, closed: true };
    }

    if (kind === 'ellipse') {
      if (w <= 0 || h <= 0) return { hasPath: false, closed: false };
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
      return { hasPath: true, closed: true };
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
      return { hasPath: true, closed: shouldClose };
    }

    return { hasPath: false, closed: false };
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {any} doc
   * @private
   */
  _drawDrawingText(ctx, doc) {
    const text = String(doc?.text ?? '').trim();
    if (!text) return;

    const fontSize = Math.max(8, this._toNumber(doc?.fontSize, 48));
    const fontFamily = String(doc?.fontFamily || 'Signika').trim() || 'Signika';
    const textAlpha = Math.max(0, Math.min(1, this._toNumber(doc?.textAlpha, 1)));
    const textColor = this._normalizeHexColor(doc?.textColor) || '#ffffff';
    const r = Number.parseInt(textColor.slice(1, 3), 16);
    const g = Number.parseInt(textColor.slice(3, 5), 16);
    const b = Number.parseInt(textColor.slice(5, 7), 16);
    const luminance = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
    const outlineColor = luminance > 153 ? '#000000' : '#ffffff';
    const outlineWidth = Math.max(1, Math.round(fontSize / 18));
    const world = this._drawingLocalToWorld(doc, this._toNumber(doc?.shape?.width, 0) * 0.5, this._toNumber(doc?.shape?.height, 0) * 0.5);
    const p = world;
    const rad = (this._toNumber(doc?.rotation, 0) * Math.PI) / 180;

    ctx.save();
    ctx.translate(p.x, p.y);
    if (Math.abs(rad) > 0.0001) ctx.rotate(rad);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${fontSize}px ${fontFamily}`;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = outlineWidth;
    ctx.strokeStyle = this._rgbaFromHex(outlineColor, textAlpha * 0.9);
    ctx.fillStyle = this._rgbaFromHex(textColor, textAlpha);
    ctx.strokeText(text, 0, 0);
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
    const logicalW = Math.max(1, Math.round(this._toNumber(width, 1)));
    const logicalH = Math.max(1, Math.round(this._toNumber(height, 1)));
    const captureScale = this._getWorldCaptureScale(logicalW, logicalH);
    const renderW = Math.max(1, Math.round(logicalW * captureScale));
    const renderH = Math.max(1, Math.round(logicalH * captureScale));
    this._worldLogicalWidth = logicalW;
    this._worldLogicalHeight = logicalH;

    const worldTexture = this._ensureWorldCanvasSize(renderW, renderH);
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
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(captureScale, 0, 0, captureScale, 0, 0);

    let drawCount = 0;
    for (const doc of replayDocs) {
      const kind = this._resolveDrawingType(doc);
      const pathInfo = this._traceDrawingPath(ctx, doc, kind);
      if (pathInfo.hasPath) {
        const fillAlpha = Math.max(0, Math.min(1, this._toNumber(doc?.fillAlpha, 0)));
        const fillType = this._toNumber(doc?.fillType, 0);
        const strokeAlpha = Math.max(0, Math.min(1, this._toNumber(doc?.strokeAlpha, 1)));
        const strokeWidth = Math.max(0, this._toNumber(doc?.strokeWidth, 8));

        if (pathInfo.closed && fillAlpha > 0.001 && fillType !== 0) {
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

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    worldTexture.needsUpdate = true;
    if (drawCount <= 0) {
      return { ok: true, count: 0, status: `captured:replay-empty:${w}x${h} logical=${logicalW}x${logicalH} ss=${captureScale.toFixed(2)}` };
    }
    return { ok: true, count: drawCount, status: `captured:replay:${w}x${h} logical=${logicalW}x${logicalH} ss=${captureScale.toFixed(2)} docs=${drawCount}` };
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
   * Convert a screen-space rectangle (stage transformed) into world-space
   * rectangle coordinates used by bridge world-canvas compositing.
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @returns {{x:number,y:number,w:number,h:number}}
   * @private
   */
  _stageScreenRectToWorldRect(x, y, w, h) {
    const t = canvas?.stage?.worldTransform;
    if (!t) return { x, y, w, h };

    const a = this._toNumber(t.a, 1);
    const b = this._toNumber(t.b, 0);
    const c = this._toNumber(t.c, 0);
    const d = this._toNumber(t.d, 1);
    const tx = this._toNumber(t.tx, 0);
    const ty = this._toNumber(t.ty, 0);
    const det = (a * d) - (b * c);
    if (!Number.isFinite(det) || Math.abs(det) < 1e-8) return { x, y, w, h };

    const inv = (sx, sy) => {
      const px = this._toNumber(sx, 0) - tx;
      const py = this._toNumber(sy, 0) - ty;
      return {
        x: ((d * px) - (c * py)) / det,
        y: ((-b * px) + (a * py)) / det,
      };
    };

    const p0 = inv(x, y);
    const p1 = inv(x + w, y);
    const p2 = inv(x + w, y + h);
    const p3 = inv(x, y + h);

    const minX = Math.min(p0.x, p1.x, p2.x, p3.x);
    const maxX = Math.max(p0.x, p1.x, p2.x, p3.x);
    const minY = Math.min(p0.y, p1.y, p2.y, p3.y);
    const maxY = Math.max(p0.y, p1.y, p2.y, p3.y);

    return {
      x: minX,
      y: minY,
      w: Math.max(0, maxX - minX),
      h: Math.max(0, maxY - minY),
    };
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
    this._worldLogicalWidth = Math.max(1, Math.round(this._toNumber(width, 1)));
    this._worldLogicalHeight = Math.max(1, Math.round(this._toNumber(height, 1)));
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
   * Replay ambient sounds by extracting each sound placeable object directly.
   * This avoids high-mutation stage isolation in the sounds editing workflow.
   * @param {PIXI.SoundsLayer|null} soundsLayer
   * @param {PIXI.Renderer|null} renderer
   * @param {number} width
   * @param {number} height
   * @returns {{ok:boolean,count:number,status:string}}
   * @private
   */
  _renderFoundrySoundsReplay(soundsLayer, renderer, width, height) {
    const logicalW = Math.max(1, Math.round(this._toNumber(width, 1)));
    const logicalH = Math.max(1, Math.round(this._toNumber(height, 1)));
    const placeables = Array.isArray(soundsLayer?.placeables) ? soundsLayer.placeables : [];
    const previewChildren = Array.isArray(soundsLayer?.preview?.children) ? soundsLayer.preview.children : [];
    const hasLivePreview = this._isSoundsPreviewInteractive(soundsLayer);

    const baseCaptureScale = this._getWorldCaptureScale(logicalW, logicalH);
    const maxSafeScale = Math.max(1, 8192 / Math.max(logicalW, logicalH));
    const captureScale = Math.min(maxSafeScale, Math.max(baseCaptureScale, hasLivePreview ? 1.0 : 3));
    const renderW = Math.max(1, Math.round(logicalW * captureScale));
    const renderH = Math.max(1, Math.round(logicalH * captureScale));
    this._worldLogicalWidth = logicalW;
    this._worldLogicalHeight = logicalH;
    const worldTexture = this._ensureWorldCanvasSize(renderW, renderH);
    if (!worldTexture || !this._worldCanvas || !renderer?.extract) {
      return { ok: false, count: 0, status: 'skip:sounds-replay-unavailable' };
    }

    const ctx = this._worldCanvas.getContext('2d');
    if (!ctx) return { ok: false, count: 0, status: 'skip:no-world-context' };

    const sounds = [];
    const seen = new Set();
    const collect = (obj) => {
      if (!obj) return;
      const key = String(obj.id ?? obj?.document?.id ?? `${sounds.length}`);
      if (seen.has(key)) return;
      seen.add(key);
      sounds.push(obj);
    };

    const previewSet = new Set(previewChildren);
    if (soundsLayer?._configPreview) previewSet.add(soundsLayer._configPreview);

    // Fast path during drag-preview: render cached settled sounds + current
    // preview only. Avoid reprocessing all placeables every mouse move.
    if (hasLivePreview) {
      for (const p of previewChildren) collect(p);
      if (soundsLayer?._configPreview) collect(soundsLayer._configPreview);
    } else {
      for (const p of placeables) collect(p);
      for (const p of previewChildren) collect(p);
      if (soundsLayer?._configPreview) collect(soundsLayer._configPreview);
    }

    sounds.sort((a, b) => this._toNumber(a?.document?.sort ?? a?.sort, 0) - this._toNumber(b?.document?.sort ?? b?.sort, 0));

    const w = this._worldCanvas.width;
    const h = this._worldCanvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(captureScale, 0, 0, captureScale, 0, 0);
    ctx.imageSmoothingEnabled = true;

    if (hasLivePreview) {
      const cacheCanvas = this._soundsSettledCacheCanvas;
      const cacheW = this._toNumber(this._soundsSettledCacheLogicalW, 0);
      const cacheH = this._toNumber(this._soundsSettledCacheLogicalH, 0);
      if (cacheCanvas && cacheW === logicalW && cacheH === logicalH && cacheCanvas.width > 0 && cacheCanvas.height > 0) {
        try { ctx.drawImage(cacheCanvas, 0, 0, logicalW, logicalH); } catch (_) {}
      }
    }

    if (sounds.length <= 0) {
      worldTexture.needsUpdate = true;
      return { ok: true, count: 0, status: `captured:sounds-replay-empty:${w}x${h}` };
    }

    let drawn = 0;
    const maxWorldW = Math.max(1, logicalW * 1.5);
    const maxWorldH = Math.max(1, logicalH * 1.5);
    const uiScale = Math.max(0.25, this._toNumber(canvas?.dimensions?.uiScale, 1));
    for (const sound of sounds) {
      const isPreviewSound = previewSet.has(sound);
      const shouldDrawField = hasLivePreview ? isPreviewSound : true;
      const sourceShape = sound?.source?.shape ?? null;
      if (shouldDrawField && sourceShape && this._tracePixiShapePath(ctx, sourceShape)) {
        // Mirrors Foundry AmbientSound#_refreshField styling and preserves
        // wall-clipped source geometry from PointSoundSource.
        ctx.fillStyle = 'rgba(170, 221, 255, 0.15)';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = Math.max(0.75, uiScale);
        ctx.fill();
        ctx.stroke();
        drawn += 1;
      }

      // AmbientSound placeable container extraction can include renderer clear
      // artifacts on some runtimes; capture explicit visuals only.
      const drawTargets = hasLivePreview ? [] : [sound?.controlIcon];
      for (const target of drawTargets) {
        if (!target) continue;

        const prevVisible = target.visible;
        const prevRenderable = target.renderable;
        const prevAlpha = Number(target.alpha);
        try {
          target.visible = true;
          target.renderable = true;
          if (!Number.isFinite(prevAlpha) || prevAlpha <= 0) target.alpha = 1;

          let bounds = null;
          try { bounds = target.getBounds?.(false) ?? null; } catch (_) { bounds = null; }
          const bx = Math.floor(this._toNumber(bounds?.x, 0));
          const by = Math.floor(this._toNumber(bounds?.y, 0));
          const bw = Math.ceil(this._toNumber(bounds?.width, 0));
          const bh = Math.ceil(this._toNumber(bounds?.height, 0));
          if (bw <= 0 || bh <= 0) continue;

          const frame = new PIXI.Rectangle(bx, by, bw, bh);
          let shapeCanvas = null;
          try {
            shapeCanvas = renderer.extract.canvas(target, frame);
          } catch (_) {
            shapeCanvas = null;
          }
          if (!shapeCanvas || !shapeCanvas.width || !shapeCanvas.height) continue;

          try {
            const worldRect = this._stageScreenRectToWorldRect(bx, by, bw, bh);
            if (worldRect.w <= 0 || worldRect.h <= 0) continue;
            // Guard against transform/bounds anomalies that would stretch a tiny
            // extracted bitmap into a near-fullscreen opaque rectangle.
            if (worldRect.w > maxWorldW || worldRect.h > maxWorldH) continue;
            ctx.drawImage(shapeCanvas, worldRect.x, worldRect.y, worldRect.w, worldRect.h);
            drawn += 1;
          } catch (_) {}
        } finally {
          target.visible = prevVisible;
          target.renderable = prevRenderable;
          target.alpha = prevAlpha;
        }
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);

    if (!hasLivePreview && w > 0 && h > 0) {
      let cacheCanvas = this._soundsSettledCacheCanvas;
      if (!cacheCanvas) {
        cacheCanvas = document.createElement('canvas');
        this._soundsSettledCacheCanvas = cacheCanvas;
      }
      if (cacheCanvas.width !== w || cacheCanvas.height !== h) {
        cacheCanvas.width = w;
        cacheCanvas.height = h;
      }
      const cacheCtx = cacheCanvas.getContext('2d');
      if (cacheCtx) {
        cacheCtx.setTransform(1, 0, 0, 1, 0, 0);
        cacheCtx.clearRect(0, 0, w, h);
        try { cacheCtx.drawImage(this._worldCanvas, 0, 0); } catch (_) {}
        this._soundsSettledCacheLogicalW = logicalW;
        this._soundsSettledCacheLogicalH = logicalH;
      }
    }

    worldTexture.needsUpdate = true;
    return { ok: true, count: drawn, status: `captured:sounds-replay:${w}x${h} logical=${logicalW}x${logicalH} ss=${captureScale.toFixed(2)} shapes=${drawn}` };
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

  /**
   * Detect whether a layer preview is actively rendering content.
   * SoundsLayer can keep a preview child resident even when not being edited.
   * Treat only renderable/visible preview objects as "live" to avoid forced
   * per-frame bridge recapture and input lag.
   * @param {any} layer
   * @returns {boolean}
   * @private
   */
  _hasActivePreview(layer) {
    const preview = layer?.preview;
    if (!preview) return false;
    if (preview?._creating) return true;
    const children = Array.isArray(preview.children) ? preview.children : [];
    for (const child of children) {
      if (!child) continue;
      if (child.visible === false) continue;
      if (child.renderable === false) continue;
      const alpha = Number(child.alpha);
      if (Number.isFinite(alpha) && alpha <= 0) continue;
      return true;
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
    const soundsLayer = canvas?.sounds;
    const notesLayer = canvas?.notes;
    const templatesLayer = canvas?.templates;
    const lightingLayer = canvas?.lighting;
    const regionsLayer = canvas?.regions;
    
    const hasOtherLivePreview =
      this._hasActivePreview(drawingsLayer) ||
      this._hasActivePreview(notesLayer) ||
      this._hasActivePreview(templatesLayer) ||
      this._hasActivePreview(lightingLayer) ||
      this._hasActivePreview(regionsLayer);

    const soundsPreviewSig = this._getSoundsPreviewSignature(soundsLayer);
    const soundsPreviewChanged = soundsPreviewSig !== this._lastSoundsPreviewSig;
    this._lastSoundsPreviewSig = soundsPreviewSig;

    // For sounds, only treat preview as "live" while geometry is changing.
    // This prevents stale preview objects from forcing perpetual recapture.
    const hasLivePreview = hasOtherLivePreview || soundsPreviewChanged;
      
    const forceTestPattern = this._isCompositorSanityPatternEnabled();
    this._lastStageTransformSig = this._getStageTransformSignature();

    if (this._testPatternWasEnabled && !forceTestPattern) {
      this._dirty = true;
    }
    this._testPatternWasEnabled = forceTestPattern;

    const hasFollowupCapture = this._postDirtyCapturesRemaining > 0;

    // Fullscreen extraction is expensive. Outside of explicit dirty changes,
    // only keep capturing while a drawing preview is actively being edited,
    // or for a short post-mutation followup window.
    if (!this._dirty && !hasLivePreview && !forceTestPattern && !hasFollowupCapture) {
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
    if (this._postDirtyCapturesRemaining > 0) {
      this._postDirtyCapturesRemaining -= 1;
    }

    const renderer = canvas?.app?.renderer;
    const extract = renderer?.extract;
    if (!renderer || !extract) {
      this._lastUpdateStatus = 'skip:renderer-missing';
      this._clearChannel('world');
      this._clearChannel('ui');
      return;
    }

    const worldCapture = this._getWorldCaptureSize();
    const captureLogicalW = Math.max(1, Math.round(this._toNumber(worldCapture.width, 1)));
    const captureLogicalH = Math.max(1, Math.round(this._toNumber(worldCapture.height, 1)));
    const captureScale = this._getWorldCaptureScale(captureLogicalW, captureLogicalH);
    const captureW = Math.max(1, Math.round(captureLogicalW * captureScale));
    const captureH = Math.max(1, Math.round(captureLogicalH * captureScale));
    this._worldLogicalWidth = captureLogicalW;
    this._worldLogicalHeight = captureLogicalH;

    if (this._isCompositorSanityPatternEnabled()) {
      if (this._renderCompositorSanityPattern(captureW, captureH)) return;
    }

    const captureStrategy = this._getCaptureStrategy();
    const useShapeReplay = (captureStrategy === 'replay-shape') || this._isShapeReplayDebugEnabled();
    const replayResult = useShapeReplay
      ? this._renderFoundryShapeReplay(drawingsLayer, renderer, worldCapture.width, worldCapture.height)
      : this._renderReplayCapture(drawingsLayer, worldCapture.width, worldCapture.height);

    // Default runtime behavior: drawings-first replay only.
    // Fall through into extraction only for explicit stage extraction or
    // auto/explicit sounds extraction.
    if (captureStrategy === 'replay-only' || captureStrategy === 'replay-shape') {
      if (replayResult.ok) {
        this._lastUpdateStatus = `${replayResult.status} strategy=${captureStrategy}`;
        this._dirty = false;
        return;
      }
      this._lastUpdateStatus = `skip:replay-failed strategy=${captureStrategy}`;
      this._clearChannel('world');
      this._clearChannel('ui');
      this._dirty = false;
      return;
    }

    const hasNonDrawingUiContent =
      !!soundsLayer?.active ||
      !!soundsLayer?.placeables?.length ||
      this._hasActivePreview(soundsLayer);

    if (captureStrategy === 'sounds-extract') {
      if (replayResult.ok && !hasNonDrawingUiContent) {
        this._lastUpdateStatus = `${replayResult.status} strategy=${captureStrategy}`;
        this._dirty = false;
        return;
      }

      const soundsReplayResult = this._renderFoundrySoundsReplay(soundsLayer, renderer, worldCapture.width, worldCapture.height);
      if (soundsReplayResult.ok) {
        this._lastUpdateStatus = `${soundsReplayResult.status} strategy=${captureStrategy}`;
        this._dirty = false;
        return;
      }

      this._lastUpdateStatus = `skip:sounds-replay-failed strategy=${captureStrategy}`;
      this._clearChannel('world');
      this._clearChannel('ui');
      this._dirty = false;
      return;
    }

    if (replayResult.ok && !hasNonDrawingUiContent) {
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

    // Collect all UI shape objects we want in bridge output.
    const uiShapes = new Set();
    const collectFromLayer = (layer) => {
      try {
        const placeables = Array.isArray(layer?.placeables) ? layer.placeables : [];
        for (const p of placeables) {
          if (p) uiShapes.add(p);
          if (p?.shape) uiShapes.add(p.shape);
          if (p?.controlIcon) uiShapes.add(p.controlIcon);
          if (p?.field) uiShapes.add(p.field);
          if (p?.template) uiShapes.add(p.template);
          if (p?.tooltip) uiShapes.add(p.tooltip);
        }

        const previewChildren = Array.isArray(layer?.preview?.children) ? layer.preview.children : [];
        for (const p of previewChildren) {
          if (p) uiShapes.add(p);
          if (p?.shape) uiShapes.add(p.shape);
          if (p?.controlIcon) uiShapes.add(p.controlIcon);
          if (p?.field) uiShapes.add(p.field);
          if (p?.template) uiShapes.add(p.template);
          if (p?.tooltip) uiShapes.add(p.tooltip);
        }
      } catch (_) {}
    };

    if (captureStrategy === 'sounds-extract') {
      collectFromLayer(soundsLayer);
    } else {
      collectFromLayer(drawingsLayer);
      collectFromLayer(soundsLayer);
    }

    if (uiShapes.size === 0) {
      this._lastUpdateStatus = 'skip:no-ui-shapes';
      this._clearChannel('world');
      this._clearChannel('ui');
      return;
    }

    // For the stage isolation path we cap the RT to a sensible pixel budget.
    // captureLogicalW/H (and therefore uOverlaySize in the compositor) must NOT
    // change — the UV math relies on them matching canvas.dimensions exactly.
    // We only reduce the scale of the actual RenderTexture pixels.
    const MAX_UI_RT_DIM = 1024;
    const uiRenderScale = Math.max(
      0.05,
      Math.min(captureScale, MAX_UI_RT_DIM / Math.max(captureLogicalW, captureLogicalH))
    );
    const uiRtW = Math.max(1, Math.round(captureLogicalW * uiRenderScale));
    const uiRtH = Math.max(1, Math.round(captureLogicalH * uiRenderScale));

    const frame = new PIXI.Rectangle(0, 0, uiRtW, uiRtH);

    let capturedCanvas = null;
    // Saved state arrays for restore in finally block.
    /** @type {Array<{obj: PIXI.DisplayObject, visible: boolean, renderable: boolean, alpha: number}>} */
    const savedState = [];
    /** @type {Array<{obj: PIXI.DisplayObject, mask: any, filters: any, filterArea: any, cullable: any}>} */
    const savedCompositing = [];
    /** @type {{px:number,py:number,sx:number,sy:number,pivx:number,pivy:number,skx:number,sky:number,rot:number}|null} */
    let stageSavedTransform = null;

    try {
      if (window?.MapShine) window.MapShine.__bridgeCaptureActive = true;
      const stageRoot = canvas?.stage;
      if (!stageRoot) {
        this._lastUpdateStatus = 'skip:no-stage';
        this._clearChannel('world');
        return;
      }

      stageSavedTransform = {
        px: Number(stageRoot.position?.x) || 0,
        py: Number(stageRoot.position?.y) || 0,
        sx: Number(stageRoot.scale?.x) || 1,
        sy: Number(stageRoot.scale?.y) || 1,
        pivx: Number(stageRoot.pivot?.x) || 0,
        pivy: Number(stageRoot.pivot?.y) || 0,
        skx: Number(stageRoot.skew?.x) || 0,
        sky: Number(stageRoot.skew?.y) || 0,
        rot: Number(stageRoot.rotation) || 0,
      };

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

      // Render the isolated UI pass in world-space: world (0,0) maps to texture
      // origin. Use uiRenderScale (capped) so the RT stays a reasonable size.
      stageRoot.position?.set?.(0, 0);
      stageRoot.scale?.set?.(uiRenderScale, uiRenderScale);
      stageRoot.pivot?.set?.(0, 0);
      stageRoot.skew?.set?.(0, 0);
      stageRoot.rotation = 0;

      // Identify the parent containers that hold UI shape objects.
      // Typically canvas.primary and/or canvas.interface.
      const shapeParents = new Set();
      for (const shape of uiShapes) {
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

      // Hide all stage direct children except ancestors of UI shapes.
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
      // UI shapes so we only capture editor overlays, not tiles/tokens/etc.
      for (const parent of shapeParents) {
        if (!parent.children) continue;
        for (const child of parent.children) {
          if (uiShapes.has(child)) {
            // Force UI shape visible for capture.
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
            // Hide non-UI siblings.
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

      // Ensure nested targets (e.g., AmbientSound.controlIcon) are explicitly
      // visible even when their own local visibility was toggled by layer state.
      for (const node of uiShapes) {
        if (!node) continue;
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

      // Disable masks/filters on ancestor chain + UI shapes to prevent
      // external mask dependencies from collapsing the output to transparent.
      const compNodes = new Set([stageRoot, ...ancestorNodes, ...uiShapes]);
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
        log.info(`[Bridge] UI shapes: ${uiShapes.size} in parents=[${parentNames}], ancestors=${ancestorNodes.size}, stage=${stageName}`);
      }

      // Render the isolated UI pass to an RT at the capped ui render dimensions.
      let tempRT = null;
      try {
        tempRT = PIXI.RenderTexture.create({ width: uiRtW, height: uiRtH });
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
      this._dirty = false;
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
      try {
        const stageRoot = canvas?.stage;
        if (stageRoot) {
          const s = stageSavedTransform;
          if (s) {
            stageRoot.position?.set?.(s.px, s.py);
            stageRoot.scale?.set?.(s.sx, s.sy);
            stageRoot.pivot?.set?.(s.pivx, s.pivy);
            stageRoot.skew?.set?.(s.skx, s.sky);
            stageRoot.rotation = s.rot;
          }
        }
      } catch (_) {}
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
        const stageSavedFallbackTransform = {
          px: Number(stageRoot.position?.x) || 0,
          py: Number(stageRoot.position?.y) || 0,
          sx: Number(stageRoot.scale?.x) || 1,
          sy: Number(stageRoot.scale?.y) || 1,
          pivx: Number(stageRoot.pivot?.x) || 0,
          pivy: Number(stageRoot.pivot?.y) || 0,
          skx: Number(stageRoot.skew?.x) || 0,
          sky: Number(stageRoot.skew?.y) || 0,
          rot: Number(stageRoot.rotation) || 0,
        };
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

          // Keep fallback in the same coordinate space and dimensions as the
          // primary capture so compositor mapping remains deterministic.
          stageRoot.position?.set?.(0, 0);
          stageRoot.scale?.set?.(uiRenderScale, uiRenderScale);
          stageRoot.pivot?.set?.(0, 0);
          stageRoot.skew?.set?.(0, 0);
          stageRoot.rotation = 0;

          let tempRT = null;
          try {
            tempRT = PIXI.RenderTexture.create({ width: uiRtW, height: uiRtH });
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
          try {
            stageRoot.position?.set?.(stageSavedFallbackTransform.px, stageSavedFallbackTransform.py);
            stageRoot.scale?.set?.(stageSavedFallbackTransform.sx, stageSavedFallbackTransform.sy);
            stageRoot.pivot?.set?.(stageSavedFallbackTransform.pivx, stageSavedFallbackTransform.pivy);
            stageRoot.skew?.set?.(stageSavedFallbackTransform.skx, stageSavedFallbackTransform.sky);
            stageRoot.rotation = stageSavedFallbackTransform.rot;
          } catch (_) {}
          if (window?.MapShine) window.MapShine.__bridgeCaptureActive = false;
        }

        if (fallbackCanvas && this._canvasHasContent(fallbackCanvas)) {
          capturedCanvas = fallbackCanvas;
          this._lastUpdateStatus = `captured-fallback:${uiRtW}x${uiRtH}`;
          log.warn('[Bridge] Isolated drawings capture was empty; using non-isolated fallback stage capture');
        }
      }
    }

    // Final fallback: PrimaryCanvasGroup can render correctly only in Foundry's
    // normal app render path on some runtimes. If both RT extraction paths are
    // empty, force one app render and copy pixels from canvas.app.view.
    if (capturedCanvas && !this._canvasHasContent(capturedCanvas) && !!window?.MapShine?.__pixiBridgeAllowViewFallback) {
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
          for (const node of [stageRoot, primary, iface, ...uiShapes]) {
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

          const vw = Math.max(1, Math.round(Number(view.width) || uiRtW));
          const vh = Math.max(1, Math.round(Number(view.height) || uiRtH));
          const copyCanvas = document.createElement('canvas');
          // Bridge output must stay in the same world-space target dimensions
          // used by the primary capture path.
          copyCanvas.width = uiRtW;
          copyCanvas.height = uiRtH;
          const copyCtx = copyCanvas.getContext('2d');
          if (copyCtx) {
            copyCtx.clearRect(0, 0, uiRtW, uiRtH);
            copyCtx.drawImage(view, 0, 0, vw, vh, 0, 0, uiRtW, uiRtH);
            if (this._canvasHasContent(copyCanvas)) {
              capturedCanvas = copyCanvas;
              this._lastUpdateStatus = `captured-view-fallback:${uiRtW}x${uiRtH}`;
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
      if (soundsLayer?.active) {
        // SoundsLayer controls can render one frame later during tool/layer
        // transitions. Keep last valid texture and request short retries.
        this._dirty = true;
        this._postDirtyCapturesRemaining = Math.max(this._postDirtyCapturesRemaining, 2);
        return;
      }
      this._clearChannel('world');
      this._clearChannel('ui');
      this._dirty = false;
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
      this._lastUpdateStatus = `captured:${w}x${h} shapes=${uiShapes.size} probe#${this._probeLogCount}`;
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
