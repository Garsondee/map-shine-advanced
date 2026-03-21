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
import { isWallDoorStateOnlyUpdate } from '../utils/wall-update-classify.js';

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
    /** @type {number} */
    this._liveCaptureThrottleMs = 120;

    /** @type {number} */
    this._zoomSettleDelayMs = 220;

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
    /** @type {string} */
    this._lastStageZoomSig = '';
    /** @type {string} */
    this._pendingStageZoomSig = '';
    /** @type {number} */
    this._lastZoomDirtyMs = 0;
    /** @type {boolean} */
    this._testPatternWasEnabled = false;
    /** @type {number} */
    this._lastDrawingsRecoveryAttemptMs = 0;
    /** @type {number} */
    this._lastTemplatesBootstrapAttemptMs = 0;
    /** @type {number} */
    this._lastTemplateOcclusionHydrationAttemptMs = 0;
    /** @type {number} */
    this._templateOcclusionHydrationAttempts = 0;
    /** @type {boolean} */
    this._pendingTemplateOcclusionHydration = false;
    /** @type {Map<string, Array<{x:number,y:number}>>} */
    this._templateGridCellsCache = new Map();
    /** @type {number} */
    this._worldLogicalWidth = 1;
    /** @type {number} */
    this._worldLogicalHeight = 1;
    /** @type {number} */
    this._worldCaptureScale = 1.0;

    /** @type {number} Grow-only world canvas allocation width to avoid resize oscillation */
    this._worldAllocatedWidth = 1;
    /** @type {number} Grow-only world canvas allocation height to avoid resize oscillation */
    this._worldAllocatedHeight = 1;

    /** @type {string} Content signature from last replay capture — skip GPU upload when unchanged */
    this._lastReplayDocsSig = '';

    /** @type {number} Minimum ms between post-dirty followup captures */
    this._postDirtyThrottleMs = 200;

    /** @type {PIXI.RenderTexture|null} Reused scratch RT to avoid per-frame RT churn */
    this._scratchRenderTexture = null;
    /** @type {number} */
    this._scratchRtWidth = 0;
    /** @type {number} */
    this._scratchRtHeight = 0;

    /** @type {HTMLCanvasElement|null} Cached settled sounds layer for fast preview rendering */
    this._soundsSettledCacheCanvas = null;
    /** @type {number} */
    this._soundsSettledCacheLogicalW = 0;
    /** @type {number} */
    this._soundsSettledCacheLogicalH = 0;

    /** @type {string} Signature of currently interactive sounds preview state */
    this._lastSoundsPreviewSig = '';

    /** @type {string} Signature of currently interactive templates preview state */
    this._lastTemplatesPreviewSig = '';
    /** @type {HTMLCanvasElement|null} Cached settled templates layer for wall-accurate preview rendering */
    this._templatesSettledCacheCanvas = null;
    /** @type {number} */
    this._templatesSettledCacheLogicalW = 0;
    /** @type {number} */
    this._templatesSettledCacheLogicalH = 0;
    /** @type {string} */
    this._templatesSettledCacheSig = '';

    /**
     * After Foundry restart, settled template pixels must be published to the
     * world bridge at least once; otherwise skip:idle freezes before hydration.
     */
    /** @type {boolean} */
    this._templateWorldPublishOk = false;

    /** @type {string} */
    this._textureSamplingStateKey = '';

    /** @type {HTMLImageElement|null} Cached image for CONFIG.controlIcons.template */
    this._templateControlIconImage = null;
    /** @type {string} Last src loaded for template control icon cache invalidation */
    this._templateControlIconSrc = '';

    /** @type {boolean} Whether UI channel currently has non-empty content */
    this._uiHasContent = false;

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
    this._applyTextureSampling(tex);
    tex.needsUpdate = true;
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /**
   * @returns {number}
   * @private
   */
  _resolveBridgeAnisotropy() {
    const renderer = window?.MapShine?.sceneComposer?.renderer ?? window?.MapShine?.effectComposer?.renderer ?? null;
    const maxFn = renderer?.capabilities?.getMaxAnisotropy;
    if (typeof maxFn !== 'function') return 1;
    const value = Number(maxFn.call(renderer.capabilities));
    if (!Number.isFinite(value) || value < 1) return 1;
    return Math.max(1, Math.floor(value));
  }

  /**
   * @param {THREE.Texture|null|undefined} texture
   * @private
   */
  _applyTextureSampling(texture) {
    const THREE = this._THREE;
    if (!THREE || !texture) return;

    // Bridge textures are frequently updated; keep costly mipmap regen opt-in.
    const sharpMipmaps = window?.MapShine?.__pixiBridgeSharpMipmaps === true;
    if (sharpMipmaps) {
      texture.minFilter = THREE.LinearMipmapLinearFilter ?? THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      texture.anisotropy = this._resolveBridgeAnisotropy();
      return;
    }

    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.anisotropy = 1;
  }

  /**
   * @private
   */
  _refreshTextureSamplingIfNeeded() {
    const sharpMipmaps = window?.MapShine?.__pixiBridgeSharpMipmaps === true;
    const anisotropy = sharpMipmaps ? this._resolveBridgeAnisotropy() : 1;
    const stateKey = `${sharpMipmaps ? 'sharp' : 'soft'}:${anisotropy}`;
    if (stateKey === this._textureSamplingStateKey) return;

    this._textureSamplingStateKey = stateKey;
    for (const texture of [this._worldTexture, this._uiTexture]) {
      if (!texture) continue;
      this._applyTextureSampling(texture);
      texture.needsUpdate = true;
    }
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
   * GPU→GPU texture sharing: inject a PIXI RenderTexture's underlying WebGL
   * texture handle directly into the Three.js world texture, completely
   * bypassing gl.readPixels() and any CPU-side pixel transfer.
   *
   * This follows the same pattern used by FoundryFogBridge for vision/exploration
   * texture sharing. WebGL texture handles are only valid within the context that
   * created them; this path succeeds only when PIXI and Three use the same gl
   * (see bootstrap sharedContext / __usePixiSharedWebGLContext).
   *
   * @param {PIXI.RenderTexture} pixiRT - The PIXI RenderTexture containing captured content
   * @param {number} rtWidth - Render texture pixel width
   * @param {number} rtHeight - Render texture pixel height
   * @returns {boolean} true if GPU→GPU injection succeeded
   * @private
   */
  _injectPixiRTToWorldTexture(pixiRT, rtWidth, rtHeight) {
    try {
      const THREE = this._THREE;
      if (!THREE) return false;

      const pixiRenderer = canvas?.app?.renderer;
      if (!pixiRenderer) return false;

      const baseTexture = pixiRT?.baseTexture;
      if (!baseTexture) return false;

      // Force PIXI to bind/upload the RT's texture so its GL handle is current.
      pixiRenderer.texture.bind(baseTexture);

      // Read the underlying WebGLTexture from PIXI's internal texture registry.
      const contextUid = pixiRenderer.texture?.CONTEXT_UID ?? pixiRenderer.CONTEXT_UID;
      const glTexture = baseTexture._glTextures?.[contextUid];
      if (!glTexture?.texture) return false;

      // Resolve the Three.js renderer that owns the world texture.
      const threeRenderer =
        window.MapShine?.sceneComposer?.renderer
        ?? window.MapShine?.effectComposer?.renderer
        ?? window.MapShine?.renderer;
      if (!threeRenderer || typeof threeRenderer.properties?.get !== 'function') return false;

      // WebGL objects are context-owned; GPU-direct injection is only valid if
      // PIXI and Three are operating on the same WebGL context instance.
      const pixiGl = pixiRenderer.gl ?? null;
      const threeGl = typeof threeRenderer.getContext === 'function' ? (threeRenderer.getContext() ?? null) : null;
      const sharedContext = !!pixiGl && !!threeGl && (pixiGl === threeGl);
      if (window?.MapShine) window.MapShine.__pixiBridgeSharedContext = sharedContext;
      if (!sharedContext) return false;

      let worldTexture = this._worldTexture;
      if (!worldTexture) return false;

      // Inject the PIXI GL texture handle into Three.js's property map.
      // Three.js will bind this handle directly during rendering — zero copies.
      const properties = threeRenderer.properties.get(worldTexture);
      properties.__webglTexture = glTexture.texture;
      properties.__webglInit = true;
      // Sync internal version so Three.js won't try to re-upload the canvas.
      properties.__version = worldTexture.version;

      // Update image dimensions for compositor UV mapping.
      worldTexture.image = { width: rtWidth, height: rtHeight };
      // CRITICAL: do NOT set needsUpdate — that would increment version and
      // trigger Three.js to overwrite our injected handle with the canvas data.
      worldTexture.needsUpdate = false;

      return true;
    } catch (e) {
      log.warn('[Bridge] GPU→GPU injection failed, will fall back to CPU readback:', e);
      return false;
    }
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
        // Invalidate replay content signature so the next capture redraws
        // even if doc fields haven't visually changed (e.g., sort reorder).
        this._lastReplayDocsSig = '';
        this._postDirtyCapturesRemaining = Math.max(
          this._postDirtyCapturesRemaining,
          Math.max(0, Math.round(this._toNumber(followupCaptures, 0)))
        );
      };

      this._hookIds.push(['createDrawing', Hooks.on('createDrawing', () => { markDirty(1); })]);
      this._hookIds.push(['updateDrawing', Hooks.on('updateDrawing', () => { markDirty(1); })]);
      this._hookIds.push(['deleteDrawing', Hooks.on('deleteDrawing', () => { markDirty(1); })]);
      this._hookIds.push(['createAmbientSound', Hooks.on('createAmbientSound', () => { markDirty(2); })]);
      this._hookIds.push(['updateAmbientSound', Hooks.on('updateAmbientSound', () => { markDirty(2); })]);
      this._hookIds.push(['deleteAmbientSound', Hooks.on('deleteAmbientSound', () => { markDirty(2); })]);
      this._hookIds.push(['createAmbientLight', Hooks.on('createAmbientLight', () => { markDirty(2); })]);
      this._hookIds.push(['updateAmbientLight', Hooks.on('updateAmbientLight', () => { markDirty(2); })]);
      this._hookIds.push(['deleteAmbientLight', Hooks.on('deleteAmbientLight', () => { markDirty(2); })]);
      this._hookIds.push(['createNote', Hooks.on('createNote', () => { markDirty(2); })]);
      this._hookIds.push(['updateNote', Hooks.on('updateNote', () => { markDirty(2); })]);
      this._hookIds.push(['deleteNote', Hooks.on('deleteNote', () => { markDirty(2); })]);
      // Template creation can be expensive to replay in the bridge. Keep the
      // invalidation immediate, but avoid extra forced follow-up captures.
      this._hookIds.push(['createMeasuredTemplate', Hooks.on('createMeasuredTemplate', () => {
        this._templateGridCellsCache.clear();
        this._pendingTemplateOcclusionHydration = true;
        this._templateOcclusionHydrationAttempts = 0;
        this._invalidateTemplatesSettledCache();
        this._templateWorldPublishOk = false;
        markDirty(0);
      })]);
      this._hookIds.push(['updateMeasuredTemplate', Hooks.on('updateMeasuredTemplate', () => {
        this._templateGridCellsCache.clear();
        this._pendingTemplateOcclusionHydration = true;
        this._templateOcclusionHydrationAttempts = 0;
        this._invalidateTemplatesSettledCache();
        this._templateWorldPublishOk = false;
        markDirty(0);
      })]);
      this._hookIds.push(['deleteMeasuredTemplate', Hooks.on('deleteMeasuredTemplate', () => {
        this._templateGridCellsCache.clear();
        this._pendingTemplateOcclusionHydration = false;
        this._templateOcclusionHydrationAttempts = 0;
        this._invalidateTemplatesSettledCache();
        this._templateWorldPublishOk = false;
        markDirty(0);
      })]);
      this._hookIds.push(['createWall', Hooks.on('createWall', () => {
        if (window.MapShine?.__debugSkipBridgeDirtyOnWall) return;
        this._invalidateTemplatesSettledCache();
        markDirty(0);
      })]);
      this._hookIds.push(['updateWall', Hooks.on('updateWall', (doc, changes) => {
        if (window.MapShine?.__debugSkipBridgeDirtyOnWall) return;
        // Door-only `ds` updates do not move wall segments; full template cache
        // invalidation + capture drives most bridge cost on click (drawImage).
        // Opt back in: MapShine.__pixiBridgeDirtyOnDoorToggle = true
        if (window.MapShine?.__pixiBridgeDirtyOnDoorToggle !== true
          && isWallDoorStateOnlyUpdate(changes)) {
          return;
        }
        this._invalidateTemplatesSettledCache();
        markDirty(0);
      })]);
      this._hookIds.push(['deleteWall', Hooks.on('deleteWall', () => {
        if (window.MapShine?.__debugSkipBridgeDirtyOnWall) return;
        this._invalidateTemplatesSettledCache();
        markDirty(0);
      })]);
      this._hookIds.push(['createRegion', Hooks.on('createRegion', () => { markDirty(2); })]);
      this._hookIds.push(['updateRegion', Hooks.on('updateRegion', () => { markDirty(2); })]);
      this._hookIds.push(['deleteRegion', Hooks.on('deleteRegion', () => { markDirty(2); })]);
      // renderSceneControls fires on every UI re-render (tool switches, etc.)
      // and is redundant with activate*Layer hooks. Removed as dirty trigger
      // to prevent stacking multiple expensive captures per tool switch.
      this._hookIds.push(['canvasReady', Hooks.on('canvasReady', () => {
        this._templateWorldPublishOk = false;
        markDirty(2);
      })]);
    }

    // Compositor render() already calls bridge.update() once per frame.
    // Keep a single driver to avoid out-of-phase capture/composite updates.

    this._lastStageZoomSig = this._getStageZoomSignature();
    this._pendingStageZoomSig = '';
    this._lastZoomDirtyMs = 0;
    this._dirty = true;
    this._getTemplateControlIconImage();
  }

  /**
   * @private
   */
  _invalidateTemplatesSettledCache() {
    this._templatesSettledCacheSig = '';
    this._templatesSettledCacheLogicalW = 0;
    this._templatesSettledCacheLogicalH = 0;
    this._templatesSettledCacheCanvas = null;
  }

  /**
   * Warm template placeables so native wall-occluded highlight cells are
   * available after scene reload before template tool activation.
   * @param {PIXI.TemplateLayer|null} templatesLayer
   * @param {number} now
   * @returns {boolean}
   * @private
   */
  _hydrateTemplateOcclusionReadiness(templatesLayer, now) {
    const placeables = Array.isArray(templatesLayer?.placeables) ? templatesLayer.placeables : [];
    if (placeables.length <= 0) {
      this._pendingTemplateOcclusionHydration = false;
      this._templateOcclusionHydrationAttempts = 0;
      return false;
    }

    let needsHydration = !!this._pendingTemplateOcclusionHydration;
    if (!needsHydration) {
      for (const tpl of placeables) {
        const getterExists = this._hasTemplateGridHighlightGetter(tpl);
        if (!getterExists) continue;
        const cells = this._getTemplateGridHighlightCells(tpl);
        if (cells.length > 0) continue;
        needsHydration = true;
        break;
      }
    }
    if (!needsHydration) {
      this._pendingTemplateOcclusionHydration = false;
      this._templateOcclusionHydrationAttempts = 0;
      return false;
    }

    const cooldownMs = Math.min(4000, 350 * (2 ** Math.max(0, this._templateOcclusionHydrationAttempts)));
    if ((now - this._lastTemplateOcclusionHydrationAttemptMs) < cooldownMs) return false;
    this._lastTemplateOcclusionHydrationAttemptMs = now;
    this._templateOcclusionHydrationAttempts += 1;

    for (const tpl of placeables) {
      if (!tpl) continue;
      try { if (typeof tpl.refresh === 'function') tpl.refresh(); } catch (_) {}
      // Foundry may already have field/highlight display objects; draw() is still
      // required to populate _getGridHighlightPositions after scene load.
      try {
        const shouldDrawNow =
          this._templateOcclusionHydrationAttempts <= 2
          || (this._templateOcclusionHydrationAttempts % 3) === 0;
        if (shouldDrawNow && typeof tpl.draw === 'function') {
          const maybePromise = tpl.draw();
          if (maybePromise?.catch) maybePromise.catch(() => {});
        }
      } catch (_) {}
    }

    this._pendingTemplateOcclusionHydration = true;
    this._dirty = true;
    this._postDirtyCapturesRemaining = Math.max(this._postDirtyCapturesRemaining, 1);
    this._lastUpdateStatus = 'retry:template-occlusion-hydration';
    return true;
  }

  getWorldTexture() {
    return this._ensureChannelTexture('world');
  }

  getUiTexture() {
    return this._ensureChannelTexture('ui');
  }

  /**
   * Whether the bridge UI channel currently contains renderable content.
   * @returns {boolean}
   */
  hasUiContent() {
    return !!this._uiHasContent;
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

  /**
   * Determine whether a template preview is currently active/interactive.
   * @param {any} templatesLayer
   * @returns {boolean}
   * @private
   */
  _isTemplatesPreviewInteractive(templatesLayer) {
    const previewChildren = Array.isArray(templatesLayer?.preview?.children) ? templatesLayer.preview.children : [];
    for (const child of previewChildren) {
      if (!child) continue;
      if (child.visible === false || child.renderable === false) continue;
      const alpha = Number(child.alpha);
      if (Number.isFinite(alpha) && alpha <= 0) continue;
      return true;
    }
    return false;
  }

  /**
   * Build a compact signature for interactive templates preview geometry.
   * Signature changes drive live recapture while template preview is dragged.
   * @param {any} templatesLayer
   * @returns {string}
   * @private
   */
  _getTemplatesPreviewSignature(templatesLayer) {
    if (!this._isTemplatesPreviewInteractive(templatesLayer)) return '';
    const previewChildren = Array.isArray(templatesLayer?.preview?.children) ? templatesLayer.preview.children : [];
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
      const direction = Math.round(this._toNumber(doc.direction ?? doc.ray?.direction, 0) * 100) / 100;
      const distance = Math.round(this._toNumber(doc.distance ?? doc.ray?.distance, 0) * 100) / 100;
      const angle = Math.round(this._toNumber(doc.angle, 0) * 100) / 100;
      const type = this._normalizeMeasuredTemplateShape(doc);
      parts.push(`${id}:${type}:${x},${y},${direction},${distance},${angle}`);
    }

    parts.sort();
    return parts.join('|');
  }

  markDirty() {
    this._dirty = true;
    this._lastReplayDocsSig = '';
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
   * Is the current control/layer context the native drawings workflow?
   * @returns {boolean}
   * @private
   */
  _isDrawingsContextActive() {
    const activeControl = String(ui?.controls?.control?.name ?? ui?.controls?.activeControl ?? '').toLowerCase();
    const activeLayerName = String(canvas?.activeLayer?.options?.name ?? canvas?.activeLayer?.name ?? '').toLowerCase();
    const activeLayerCtor = String(canvas?.activeLayer?.constructor?.name ?? '').toLowerCase();
    const activeControlLayer = String(ui?.controls?.control?.layer ?? '').toLowerCase();
    return !!canvas?.drawings?.active
      || activeControl === 'drawings'
      || activeControl === 'drawing'
      || activeControlLayer === 'drawings'
      || activeControlLayer === 'drawing'
      || activeLayerName === 'drawings'
      || activeLayerName === 'drawing'
      || activeLayerCtor === 'drawingslayer';
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
   * Is the current control/layer context the native notes workflow?
   * @returns {boolean}
   * @private
   */
  _isNotesContextActive() {
    const activeControl = String(ui?.controls?.control?.name ?? ui?.controls?.activeControl ?? '').toLowerCase();
    const activeTool = String(ui?.controls?.tool?.name ?? ui?.controls?.activeTool ?? game?.activeTool ?? '').toLowerCase();
    const activeLayerName = String(canvas?.activeLayer?.options?.name ?? canvas?.activeLayer?.name ?? '').toLowerCase();
    const activeLayerCtor = String(canvas?.activeLayer?.constructor?.name ?? '').toLowerCase();
    const activeControlLayer = String(ui?.controls?.control?.layer ?? '').toLowerCase();
    return !!canvas?.notes?.active
      || activeControl === 'notes'
      || activeControl === 'note'
      || activeTool === 'note'
      || activeControlLayer === 'notes'
      || activeControlLayer === 'note'
      || activeLayerName === 'notes'
      || activeLayerName === 'note'
      || activeLayerCtor === 'noteslayer';
  }

  /**
   * Is the current control/layer context the native templates workflow?
   * @returns {boolean}
   * @private
   */
  _isTemplatesContextActive() {
    const activeControl = String(ui?.controls?.control?.name ?? ui?.controls?.activeControl ?? '').toLowerCase();
    const activeTool = String(ui?.controls?.tool?.name ?? ui?.controls?.activeTool ?? game?.activeTool ?? '').toLowerCase();
    const activeLayerName = String(canvas?.activeLayer?.options?.name ?? canvas?.activeLayer?.name ?? '').toLowerCase();
    const activeLayerCtor = String(canvas?.activeLayer?.constructor?.name ?? '').toLowerCase();
    const activeControlLayer = String(ui?.controls?.control?.layer ?? '').toLowerCase();
    return !!canvas?.templates?.active
      || activeControl === 'templates'
      || activeControl === 'template'
      || activeTool === 'circle'
      || activeTool === 'cone'
      || activeTool === 'rect'
      || activeTool === 'ray'
      || activeControlLayer === 'templates'
      || activeControlLayer === 'template'
      || activeLayerName === 'templates'
      || activeLayerName === 'template'
      || activeLayerCtor === 'templatelayer';
  }

  /**
   * Is the current control/layer context the native regions workflow?
   * @returns {boolean}
   * @private
   */
  _isRegionsContextActive() {
    const activeControl = String(ui?.controls?.control?.name ?? ui?.controls?.activeControl ?? '').toLowerCase();
    const activeLayerName = String(canvas?.activeLayer?.options?.name ?? canvas?.activeLayer?.name ?? '').toLowerCase();
    const activeLayerCtor = String(canvas?.activeLayer?.constructor?.name ?? '').toLowerCase();
    const activeControlLayer = String(ui?.controls?.control?.layer ?? '').toLowerCase();
    return !!canvas?.regions?.active
      || activeControl === 'regions'
      || activeControl === 'region'
      || activeControlLayer === 'regions'
      || activeControlLayer === 'region'
      || activeLayerName === 'regions'
      || activeLayerName === 'region'
      || activeLayerCtor === 'regionlayer';
  }

  /**
   * Is the current control/layer context the native lighting workflow?
   * @returns {boolean}
   * @private
   */
  _isLightingContextActive() {
    const activeControl = String(ui?.controls?.control?.name ?? ui?.controls?.activeControl ?? '').toLowerCase();
    const activeTool = String(ui?.controls?.tool?.name ?? ui?.controls?.activeTool ?? game?.activeTool ?? '').toLowerCase();
    const activeLayerName = String(canvas?.activeLayer?.options?.name ?? canvas?.activeLayer?.name ?? '').toLowerCase();
    const activeLayerCtor = String(canvas?.activeLayer?.constructor?.name ?? '').toLowerCase();
    const activeControlLayer = String(ui?.controls?.control?.layer ?? '').toLowerCase();
    return !!canvas?.lighting?.active
      || activeControl === 'lighting'
      || activeControl === 'light'
      || activeTool === 'light'
      || activeControlLayer === 'lighting'
      || activeControlLayer === 'light'
      || activeLayerName === 'lighting'
      || activeLayerName === 'light'
      || activeLayerCtor === 'lightinglayer';
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
   * - notes-extract
   * - templates-extract
   * - regions-extract
   * - stage-extract
   *
   * If no override is provided, auto-select sounds-extract while actively
   * editing sounds, otherwise use replay-only.
   *
   * @returns {'replay-only'|'replay-shape'|'sounds-extract'|'notes-extract'|'templates-extract'|'regions-extract'|'stage-extract'}
   * @private
   */
  _getCaptureStrategy() {
    const raw = String(window?.MapShine?.__pixiBridgeCaptureStrategy || '').trim().toLowerCase();
    if (raw === 'stage-extract') return 'stage-extract';
    if (raw === 'sounds-extract') return 'sounds-extract';
    if (raw === 'notes-extract') return 'notes-extract';
    if (raw === 'templates-extract') return 'templates-extract';
    if (raw === 'regions-extract') return 'regions-extract';
    if (raw === 'replay-shape') return 'replay-shape';
    if (this._isSoundsContextActive()) return 'sounds-extract';
    if (this._isLightingContextActive()) return 'stage-extract';
    if (this._isRegionsContextActive()) return 'regions-extract';

    const templatesLayer = canvas?.templates ?? canvas?.activeLayer ?? null;
    const hasAnyTemplates =
      ((Number(canvas?.scene?.templates?.size) || 0) > 0)
      || !!templatesLayer?.placeables?.length
      || !!templatesLayer?.objects?.children?.length
      || this._hasActivePreview(templatesLayer);

    // Use template extraction whenever there is an actual live template preview
    // (ruler/grid highlight/icons), even if the active tool isn't the native
    // templates control anymore.
    if (this._isTemplatesPreviewInteractive(templatesLayer)) return 'templates-extract';
    // Settled templates should behave like drawings and be replayed from
    // document data (stable across tool/layer switches). The update() pipeline
    // will merge template doc replay in replay-only mode.
    if (hasAnyTemplates) return 'replay-only';
    if (this._isNotesContextActive()) return 'notes-extract';

    // Keep drawing visibility deterministic across gameplay modes.
    // Non-drawing overlays should only auto-switch extraction strategy while
    // their own editing context is actively selected.
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
    // Adaptive pixel budget: cap total upload pixels to avoid massive texSubImage2D stalls.
    // 4M pixels (~2048x2048) keeps uploads under ~2ms on most GPUs.
    const maxPixelBudget = this._toNumber(window?.MapShine?.__pixiBridgeMaxPixels, 4_000_000);
    const safeByWidth = maxDim / Math.max(1, logicalWidth);
    const safeByHeight = maxDim / Math.max(1, logicalHeight);
    const safeByBudget = Math.sqrt(maxPixelBudget / Math.max(1, logicalWidth * logicalHeight));
    return Math.max(1, Math.min(requested, safeByWidth, safeByHeight, safeByBudget));
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
    const requestedW = Math.max(1, Math.round(Number(width) || 1));
    const requestedH = Math.max(1, Math.round(Number(height) || 1));

    // Grow-only allocation avoids frequent GPU texture destroy/recreate churn
    // when bridge paths alternate between lower and higher capture resolutions.
    this._worldAllocatedWidth = Math.max(this._worldAllocatedWidth, requestedW);
    this._worldAllocatedHeight = Math.max(this._worldAllocatedHeight, requestedH);
    const w = this._worldAllocatedWidth;
    const h = this._worldAllocatedHeight;
    if (this._worldCanvas.width !== w || this._worldCanvas.height !== h) {
      this._worldCanvas.width = w;
      this._worldCanvas.height = h;
      this._recreateTexture('world');
      worldTexture = this._ensureChannelTexture('world');
    }
    return worldTexture;
  }

  /**
   * Reuse a single PIXI render texture across bridge captures to reduce
   * transient GPU/JS allocations and associated GC pressure.
   * @param {number} width
   * @param {number} height
   * @returns {PIXI.RenderTexture|null}
   * @private
   */
  _ensureScratchRenderTexture(width, height) {
    const w = Math.max(1, Math.round(this._toNumber(width, 1)));
    const h = Math.max(1, Math.round(this._toNumber(height, 1)));
    const existing = this._scratchRenderTexture;
    if (existing && this._scratchRtWidth === w && this._scratchRtHeight === h) return existing;

    if (existing) {
      try { existing.destroy(true); } catch (_) {}
      this._scratchRenderTexture = null;
    }

    try {
      this._scratchRenderTexture = PIXI.RenderTexture.create({ width: w, height: h });
      this._scratchRtWidth = w;
      this._scratchRtHeight = h;
      return this._scratchRenderTexture;
    } catch (_) {
      this._scratchRenderTexture = null;
      this._scratchRtWidth = 0;
      this._scratchRtHeight = 0;
      return null;
    }
  }

  /**
   * @private
   */
  _destroyScratchRenderTexture() {
    const rt = this._scratchRenderTexture;
    if (!rt) return;
    try { rt.destroy(true); } catch (_) {}
    this._scratchRenderTexture = null;
    this._scratchRtWidth = 0;
    this._scratchRtHeight = 0;
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
   * Map MeasuredTemplate document type to doc-replay branch keys (circle, cone, rect, ray).
   * @param {any} doc
   * @returns {string}
   * @private
   */
  _normalizeMeasuredTemplateShape(doc) {
    const raw = doc?.t ?? doc?.type;
    const M = globalThis.CONST?.MEASURED_TEMPLATE_TYPES;
    let key = raw;
    if (typeof raw === 'number' && M) {
      for (const name of ['CIRCLE', 'CONE', 'RECTANGLE', 'RAY']) {
        if (M[name] === raw) {
          key = String(name).toLowerCase();
          break;
        }
      }
    }
    let s = String(key ?? '').toLowerCase();
    if (s === 'rectangle') s = 'rect';
    return s;
  }

  /**
   * Lazy-load the Foundry template control icon from CONFIG (async decode).
   * @returns {HTMLImageElement|null} Ready image, or null while loading / unavailable
   * @private
   */
  _getTemplateControlIconImage() {
    const src = String(globalThis.CONFIG?.controlIcons?.template || '').trim();
    if (!src) return null;
    if (!this._templateControlIconImage || this._templateControlIconSrc !== src) {
      this._templateControlIconSrc = src;
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        this.markDirty();
        this._postDirtyCapturesRemaining = Math.max(this._postDirtyCapturesRemaining, 1);
      };
      img.onerror = () => {};
      img.src = src;
      this._templateControlIconImage = img;
      return null;
    }
    const img = this._templateControlIconImage;
    if (!img.complete || !img.naturalWidth || !img.naturalHeight) return null;
    return img;
  }

  /**
   * Draw template control glyphs on the world canvas after GPU settled-cache blit
   * (extract list intentionally omits controlIcon to avoid false geometry hits).
   * @param {CanvasRenderingContext2D} worldCtx
   * @param {PIXI.TemplateLayer|null} templatesLayer
   * @param {number} captureScale
   * @param {number} uiScale
   * @private
   */
  _stampMeasuredTemplateControlIcons(worldCtx, templatesLayer, captureScale, uiScale) {
    if (!worldCtx) return;
    const scale = Math.max(0.0001, this._toNumber(captureScale, 1));
    const ui = Math.max(0.25, this._toNumber(uiScale, 1));
    const docs = [];
    const seen = new Set();
    const add = (d) => {
      if (!d?.id) return;
      const id = String(d.id);
      if (seen.has(id)) return;
      seen.add(id);
      docs.push(d);
    };
    try {
      const coll = canvas?.scene?.templates;
      const arr = Array.isArray(coll?.contents) ? coll.contents : Array.from(coll ?? []);
      for (const e of arr) {
        const d = (e && e.id != null) ? e : (Array.isArray(e) && e[1]?.id ? e[1] : null);
        if (d) add(d);
      }
    } catch (_) {}
    try {
      const placeables = [
        ...(Array.isArray(templatesLayer?.placeables) ? templatesLayer.placeables : []),
        ...(Array.isArray(templatesLayer?.objects?.children) ? templatesLayer.objects.children : []),
      ];
      for (const p of placeables) {
        const d = p?.document ?? p?._original;
        if (d?.id) add(d);
      }
    } catch (_) {}
    if (!docs.length) return;
    worldCtx.save();
    worldCtx.setTransform(scale, 0, 0, scale, 0, 0);
    for (const doc of docs) {
      const x = this._toNumber(doc?.x, 0);
      const y = this._toNumber(doc?.y, 0);
      const bc = this._normalizeHexColor(doc?.borderColor) || '#ff5500';
      this._drawTemplateDocControlIcon(worldCtx, x, y, ui, bc);
    }
    worldCtx.restore();
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
    const w = this._toNumber(doc?.shape?.width ?? doc?.width, 0);
    const h = this._toNumber(doc?.shape?.height ?? doc?.height, 0);
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
    const points = Array.isArray(doc?.shape?.points) ? doc.shape.points : [];
    const types = globalThis.CONST?.DRAWING_TYPES ?? {};
    if (t === types.RECTANGLE || t === 'r' || t === 'rectangle') return 'rectangle';
    if (t === types.ELLIPSE || t === 'e' || t === 'ellipse') return 'ellipse';
    if (t === types.POLYGON || t === 'p' || t === 'polygon') return 'polygon';
    if (t === types.FREEHAND || t === 'f' || t === 'freehand') return 'freehand';
    // Some persisted docs can omit shape.type while still carrying points.
    if (points.length >= 4) return 'polygon';
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
    const w = Math.max(0, this._toNumber(doc?.shape?.width ?? doc?.width, 0));
    const h = Math.max(0, this._toNumber(doc?.shape?.height ?? doc?.height, 0));
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
    if (!text) return false;

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
    const textW = this._toNumber(doc?.shape?.width ?? doc?.width, 0);
    const textH = this._toNumber(doc?.shape?.height ?? doc?.height, 0);
    const world = this._drawingLocalToWorld(doc, textW * 0.5, textH * 0.5);
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
    return true;
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
    const docById = new Map();
    for (const d of drawables) {
      const doc = this._getDrawingDocument(d);
      if (!doc) continue;
      const key = String(doc.id ?? d?.id ?? `${this._toNumber(doc.x, 0)}:${this._toNumber(doc.y, 0)}:${replayDocs.length}`);
      if (seen.has(key)) continue;
      seen.add(key);
      if (doc?.id != null) docById.set(String(doc.id), doc);
      replayDocs.push(doc);
    }

    // Always merge canonical scene docs. On startup/tool switches, placeable docs
    // can be transiently stale/incomplete while scene docs remain authoritative.
    try {
      const sceneDrawings = canvas?.scene?.drawings;
      const docs = Array.isArray(sceneDrawings?.contents)
        ? sceneDrawings.contents
        : Array.from(sceneDrawings ?? []);
      for (const doc of docs) {
        if (!doc) continue;
        const id = doc?.id != null ? String(doc.id) : '';
        if (id) {
          // Canonical scene doc wins over potentially stale placeable doc.
          docById.set(id, doc);
          if (!seen.has(id)) seen.add(id);
          continue;
        }
        const key = String(`${this._toNumber(doc.x, 0)}:${this._toNumber(doc.y, 0)}:${replayDocs.length}`);
        if (seen.has(key)) continue;
        seen.add(key);
        replayDocs.push(doc);
      }
    } catch (_) {}

    if (docById.size > 0) {
      replayDocs.length = 0;
      for (const doc of docById.values()) replayDocs.push(doc);
    }

    const sceneDrawingsPresent = (Number(canvas?.scene?.drawings?.size) || 0) > 0;
    if (replayDocs.length === 0 && sceneDrawingsPresent) {
      // Preserve previous bridge texture when scene docs exist but extraction is
      // transiently empty. Clearing here causes drawings to vanish shortly after
      // creation/tool transitions.
      return { ok: true, count: 0, status: `retry:replay-docs-empty:${renderW}x${renderH}` };
    }

    replayDocs.sort((a, b) => this._toNumber(a?.sort, 0) - this._toNumber(b?.sort, 0));

    // Compute a cheap content signature from doc geometry/style to detect no-ops.
    // When content hasn't changed, skip the canvas redraw and GPU upload entirely.
    const sigParts = [];
    for (const doc of replayDocs) {
      sigParts.push(
        `${this._toNumber(doc?.x, 0)}:${this._toNumber(doc?.y, 0)}:`
        + `${this._toNumber(doc?.shape?.width, 0)}:${this._toNumber(doc?.shape?.height, 0)}:`
        + `${this._toNumber(doc?.rotation, 0)}:`
        + `${this._toNumber(doc?.strokeWidth, 0)}:`
        + `${String(doc?.strokeColor ?? '')}:${String(doc?.fillColor ?? '')}:`
        + `${String(doc?.text ?? '')}:${this._toNumber(doc?.sort, 0)}`
      );
    }
    const contentSig = `${renderW}x${renderH}:${replayDocs.length}:${sigParts.join('|')}`;
    if (contentSig === this._lastReplayDocsSig) {
      // Content unchanged — skip canvas redraw and GPU re-upload.
      return { ok: true, count: replayDocs.length, status: `skip:replay-unchanged:${renderW}x${renderH} docs=${replayDocs.length}` };
    }
    this._lastReplayDocsSig = contentSig;

    const w = this._worldCanvas.width;
    const h = this._worldCanvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(captureScale, 0, 0, captureScale, 0, 0);

    let drawCount = 0;
    for (const doc of replayDocs) {
      const kind = this._resolveDrawingType(doc);
      const pathInfo = this._traceDrawingPath(ctx, doc, kind);
      let rendered = false;
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
        rendered = true;
      }

      const textRendered = this._drawDrawingText(ctx, doc) === true;
      if (rendered || textRendered) drawCount += 1;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    worldTexture.needsUpdate = true;
    if (drawCount <= 0) {
      if (sceneDrawingsPresent) {
        return { ok: true, count: 0, status: `retry:replay-render-empty:${w}x${h}` };
      }
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
   * @returns {string}
   * @private
   */
  _getStageZoomSignature() {
    const t = canvas?.stage?.worldTransform;
    if (!t) return 'none';
    const a = this._toNumber(t.a, 1);
    const b = this._toNumber(t.b, 0);
    const c = this._toNumber(t.c, 0);
    const d = this._toNumber(t.d, 1);
    const scaleX = Math.hypot(a, b);
    const scaleY = Math.hypot(c, d);
    const avgScale = (scaleX + scaleY) * 0.5;
    const q = (n) => Math.round(this._toNumber(n, 0) * 10000) / 10000;
    return `${q(scaleX)}|${q(scaleY)}|${q(avgScale)}`;
  }

  /**
   * Zoom changes do not always require an expensive bridge recapture.
   * Only recapture on zoom while in contexts where controls/overlays are
   * expected to visually respond to zoom in real time.
   * @returns {boolean}
   * @private
   */
  _shouldRecaptureOnZoom() {
    const drawingsLayer = canvas?.drawings;
    const soundsLayer = canvas?.sounds;
    const notesLayer = canvas?.notes;
    const templatesLayer = canvas?.templates;
    const lightingLayer = canvas?.lighting;
    const regionsLayer = canvas?.regions;

    const hasLivePreview =
      (this._isDrawingsContextActive() && this._hasActivePreview(drawingsLayer))
      || this._isSoundsPreviewInteractive(soundsLayer)
      || (this._isNotesContextActive() && this._hasActivePreview(notesLayer))
      || this._isTemplatesPreviewInteractive(templatesLayer)
      || (this._isLightingContextActive() && this._hasActivePreview(lightingLayer))
      || (this._isRegionsContextActive() && this._hasActivePreview(regionsLayer));
    if (hasLivePreview) return true;

    // Template overlays can require a zoom recapture for crisp control visuals,
    // but that is only acceptable on the GPU-direct path. On CPU readback
    // fallback this creates large zoom-settle stalls.
    const sharedContextActive =
      window?.MapShine?.__pixiBridgeSharedContext === true
      || String(window?.MapShine?.rendererType ?? '').includes('shared-context');
    const hasAnyTemplates =
      ((Number(canvas?.scene?.templates?.size) || 0) > 0)
      || !!templatesLayer?.placeables?.length
      || !!templatesLayer?.objects?.children?.length
      || this._hasActivePreview(templatesLayer);
    if (hasAnyTemplates && sharedContextActive) return true;

    // Keep zoom recapture for the control-heavy layers that depend on
    // Foundry/PIXI control visuals while editing.
    return this._isSoundsContextActive()
      || this._isNotesContextActive()
      || this._isLightingContextActive()
      || this._isRegionsContextActive();
  }

  /**
   * Queue throttled bridge recapture when stage zoom changes.
   * @param {number} now
   * @private
   */
  _markDirtyForZoomIfNeeded(now) {
    const zoomSig = this._getStageZoomSignature();
    if (!this._shouldRecaptureOnZoom()) {
      this._lastStageZoomSig = zoomSig;
      this._pendingStageZoomSig = '';
      this._lastZoomDirtyMs = now;
      return;
    }

    const settleDelayMs = Math.max(
      0,
      this._toNumber(window?.MapShine?.__pixiBridgeZoomSettleMs, this._zoomSettleDelayMs)
    );
    if (zoomSig !== this._lastStageZoomSig) {
      this._lastStageZoomSig = zoomSig;
      this._pendingStageZoomSig = zoomSig;
      this._lastZoomDirtyMs = now;
      return;
    }
    if (!this._pendingStageZoomSig) return;

    // Expensive bridge recapture should run when zoom has settled, not during
    // every wheel/pinch step.
    if ((now - this._lastZoomDirtyMs) < settleDelayMs) return;

    this._pendingStageZoomSig = '';
    this._lastZoomDirtyMs = now;
    this._dirty = true;
    this._postDirtyCapturesRemaining = Math.max(this._postDirtyCapturesRemaining, 1);
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
   * Replay journal notes by extracting explicit note visuals from each placeable.
   * @param {PIXI.NotesLayer|null} notesLayer
   * @param {PIXI.Renderer|null} renderer
   * @param {number} width
   * @param {number} height
   * @param {{clear?:boolean}} [options]
   * @returns {{ok:boolean,count:number,status:string}}
   * @private
   */
  _renderFoundryNotesReplay(notesLayer, renderer, width, height, options = {}) {
    const shouldClear = options?.clear !== false;
    const logicalW = Math.max(1, Math.round(this._toNumber(width, 1)));
    const logicalH = Math.max(1, Math.round(this._toNumber(height, 1)));
    const captureScale = this._getWorldCaptureScale(logicalW, logicalH);
    const renderW = Math.max(1, Math.round(logicalW * captureScale));
    const renderH = Math.max(1, Math.round(logicalH * captureScale));
    this._worldLogicalWidth = logicalW;
    this._worldLogicalHeight = logicalH;

    const worldTexture = this._ensureWorldCanvasSize(renderW, renderH);
    if (!worldTexture || !this._worldCanvas || !renderer?.extract) {
      return { ok: false, count: 0, status: 'skip:notes-replay-unavailable' };
    }

    const ctx = this._worldCanvas.getContext('2d');
    if (!ctx) return { ok: false, count: 0, status: 'skip:no-world-context' };

    const notes = [];
    const seen = new Set();
    const collect = (obj) => {
      if (!obj) return;
      const key = String(obj.id ?? obj?.document?.id ?? `${notes.length}`);
      if (seen.has(key)) return;
      seen.add(key);
      notes.push(obj);
    };

    const placeables = Array.isArray(notesLayer?.placeables) ? notesLayer.placeables : [];
    const objectChildren = Array.isArray(notesLayer?.objects?.children) ? notesLayer.objects.children : [];
    const previewChildren = Array.isArray(notesLayer?.preview?.children) ? notesLayer.preview.children : [];
    for (const p of placeables) collect(p);
    for (const p of objectChildren) collect(p);
    for (const p of previewChildren) collect(p);
    if (notesLayer?._configPreview) collect(notesLayer._configPreview);

    notes.sort((a, b) => this._toNumber(a?.document?.sort ?? a?.sort, 0) - this._toNumber(b?.document?.sort ?? b?.sort, 0));

    const w = this._worldCanvas.width;
    const h = this._worldCanvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(captureScale, 0, 0, captureScale, 0, 0);
    ctx.imageSmoothingEnabled = true;

    if (notes.length <= 0) {
      worldTexture.needsUpdate = true;
      return { ok: true, count: 0, status: `captured:notes-replay-empty:${w}x${h}` };
    }

    let drawn = 0;
    const maxWorldW = Math.max(1, logicalW * 1.5);
    const maxWorldH = Math.max(1, logicalH * 1.5);
    for (const note of notes) {
      const targetCandidates = [];
      const pushUniqueTarget = (target) => {
        if (!target) return;
        if (targetCandidates.includes(target)) return;
        targetCandidates.push(target);
      };

      // Prefer controlIcon first; its geometry matches Foundry Note sizing
      // semantics (iconSize plus ControlIcon padding/border).
      pushUniqueTarget(note?.controlIcon);
      pushUniqueTarget(note);
      pushUniqueTarget(note?.icon);
      pushUniqueTarget(note?.tooltip);

      let drewPrimaryTarget = false;
      for (const target of targetCandidates) {
        const savedChainState = [];
        let chainNode = target;
        while (chainNode) {
          savedChainState.push({
            obj: chainNode,
            visible: chainNode.visible,
            renderable: chainNode.renderable,
            alpha: Number(chainNode.alpha),
          });
          chainNode.visible = true;
          chainNode.renderable = true;
          if (!Number.isFinite(chainNode.alpha) || chainNode.alpha <= 0) chainNode.alpha = 1;
          chainNode = chainNode.parent ?? null;
        }
        try {
          let bounds = null;
          try { bounds = target.getBounds?.(false) ?? null; } catch (_) { bounds = null; }
          const bx = Math.floor(this._toNumber(bounds?.x, 0));
          const by = Math.floor(this._toNumber(bounds?.y, 0));
          const bw = Math.ceil(this._toNumber(bounds?.width, 0));
          const bh = Math.ceil(this._toNumber(bounds?.height, 0));
          if (bw <= 0 || bh <= 0) continue;

          const frame = new PIXI.Rectangle(bx, by, bw, bh);
          let targetCanvas = null;
          try {
            targetCanvas = renderer.extract.canvas(target, frame);
          } catch (_) {
            targetCanvas = null;
          }
          if (!targetCanvas || !targetCanvas.width || !targetCanvas.height) continue;

          let drawX = 0;
          let drawY = 0;
          let drawW = 0;
          let drawH = 0;
          const worldRect = this._stageScreenRectToWorldRect(bx, by, bw, bh);
          if (worldRect.w <= 0 || worldRect.h <= 0) continue;
          drawW = worldRect.w;
          drawH = worldRect.h;
          drawX = worldRect.x;
          drawY = worldRect.y;

          const isPrimaryIconTarget = target === note?.controlIcon || target === note;
          if (isPrimaryIconTarget) {
            const uiScale = Math.max(0.25, this._toNumber(canvas?.dimensions?.uiScale, 1));
            const expectedSize = Math.max(8, this._toNumber(note?.document?.iconSize ?? note?.iconSize, 40) + (4 * uiScale));
            const actualSize = Math.max(drawW, drawH);
            if (actualSize > 0) {
              const scaleUp = expectedSize / actualSize;
              if (scaleUp > 1.05) {
                const cx = drawX + (drawW * 0.5);
                const cy = drawY + (drawH * 0.5);
                drawW *= scaleUp;
                drawH *= scaleUp;
                drawX = cx - (drawW * 0.5);
                drawY = cy - (drawH * 0.5);
              }
            }
          }

          if (drawW > maxWorldW || drawH > maxWorldH) continue;
          try {
            ctx.drawImage(targetCanvas, drawX, drawY, drawW, drawH);
            drawn += 1;
            if (target === note?.controlIcon || target === note) {
              drewPrimaryTarget = true;
              break;
            }
          } catch (_) {}
        } finally {
          for (let i = savedChainState.length - 1; i >= 0; i -= 1) {
            const s = savedChainState[i];
            s.obj.visible = s.visible;
            s.obj.renderable = s.renderable;
            s.obj.alpha = s.alpha;
          }
        }
      }

      if (drewPrimaryTarget) continue;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    worldTexture.needsUpdate = true;
    return { ok: true, count: drawn, status: `captured:notes-replay:${w}x${h} logical=${logicalW}x${logicalH} ss=${captureScale.toFixed(2)} shapes=${drawn}` };
  }

  /**
   * Replay measured templates from document data directly into the world canvas.
   * This avoids GPU readback for settled templates.
   * @param {PIXI.TemplateLayer|null} templatesLayer
   * @param {number} width
   * @param {number} height
   * @param {{clear?:boolean,previewOnly?:boolean}} [options]
   * @returns {{ok:boolean,count:number,status:string}}
   * @private
   */
  _renderFoundryTemplatesDocReplay(templatesLayer, width, height, options = {}) {
    const shouldClear = options?.clear === true;
    const previewOnly = options?.previewOnly === true;
    const logicalW = Math.max(1, Math.round(this._toNumber(width, 1)));
    const logicalH = Math.max(1, Math.round(this._toNumber(height, 1)));
    const captureScale = this._getWorldCaptureScale(logicalW, logicalH);
    const renderW = Math.max(1, Math.round(logicalW * captureScale));
    const renderH = Math.max(1, Math.round(logicalH * captureScale));
    this._worldLogicalWidth = logicalW;
    this._worldLogicalHeight = logicalH;

    const worldTexture = this._ensureWorldCanvasSize(renderW, renderH);
    if (!worldTexture || !this._worldCanvas) {
      return { ok: false, count: 0, status: 'skip:templates-doc-replay-unavailable' };
    }

    const ctx = this._worldCanvas.getContext('2d');
    if (!ctx) return { ok: false, count: 0, status: 'skip:no-world-context' };

    const templateDocs = [];
    const seenKeys = new Set();
    const docsById = new Map();
    const collectDoc = (obj) => {
      const doc = obj?.document ?? obj?._original ?? null;
      if (!doc) return;
      const id = doc?.id != null ? String(doc.id) : '';
      if (id) {
        docsById.set(id, doc);
        return;
      }
      const key = `${this._toNumber(doc?.x, 0)}:${this._toNumber(doc?.y, 0)}:${this._toNumber(doc?.distance, 0)}:${this._toNumber(doc?.direction, 0)}:${this._toNumber(doc?.angle, 0)}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      templateDocs.push(doc);
    };

    const previewChildren = Array.isArray(templatesLayer?.preview?.children) ? templatesLayer.preview.children : [];
    if (!previewOnly) {
      const placeables = Array.isArray(templatesLayer?.placeables) ? templatesLayer.placeables : [];
      const objectChildren = Array.isArray(templatesLayer?.objects?.children) ? templatesLayer.objects.children : [];
      for (const t of placeables) collectDoc(t);
      for (const t of objectChildren) collectDoc(t);
    }
    for (const t of previewChildren) collectDoc(t);
    if (templatesLayer?._configPreview) collectDoc(templatesLayer._configPreview);

    try {
      const sceneTemplates = canvas?.scene?.templates;
      const docs = Array.isArray(sceneTemplates?.contents)
        ? sceneTemplates.contents
        : Array.from(sceneTemplates ?? []);
      for (const doc of docs) {
        if (!doc) continue;
        const id = doc?.id != null ? String(doc.id) : '';
        if (id) {
          docsById.set(id, doc);
          continue;
        }
        collectDoc({ document: doc });
      }
    } catch (_) {}

    if (docsById.size > 0) {
      for (const doc of docsById.values()) templateDocs.push(doc);
    }

    const placeablesById = new Map();
    try {
      const placeables = Array.isArray(templatesLayer?.placeables) ? templatesLayer.placeables : [];
      const objectChildren = Array.isArray(templatesLayer?.objects?.children) ? templatesLayer.objects.children : [];
      for (const t of [...placeables, ...objectChildren]) {
        const id = t?.document?.id != null ? String(t.document.id) : '';
        if (!id) continue;
        if (!placeablesById.has(id)) placeablesById.set(id, t);
      }
    } catch (_) {}

    templateDocs.sort((a, b) => this._toNumber(a?.sort, 0) - this._toNumber(b?.sort, 0));

    const w = this._worldCanvas.width;
    const h = this._worldCanvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (shouldClear) ctx.clearRect(0, 0, w, h);
    ctx.setTransform(captureScale, 0, 0, captureScale, 0, 0);

    const dims = canvas?.dimensions ?? null;
    const distancePixels = Math.max(
      1,
      this._toNumber(dims?.distancePixels,
        this._toNumber(dims?.distance, 0) > 0
          ? this._toNumber(dims?.size, 100) / this._toNumber(dims?.distance, 5)
          : 100)
    );
    const uiScale = Math.max(0.25, this._toNumber(dims?.uiScale, 1));

    let drawn = 0;
    let pendingNativeGridHydration = false;
    for (const doc of templateDocs) {
      const type = this._normalizeMeasuredTemplateShape(doc);
      const x = this._toNumber(doc?.x, 0);
      const y = this._toNumber(doc?.y, 0);
      const directionDeg = this._toNumber(doc?.direction, 0);
      const distance = Math.max(0, this._toNumber(doc?.distance, 0));
      const angleDegRaw = this._toNumber(doc?.angle, 0);
      const angleDeg = angleDegRaw > 0 ? angleDegRaw : (type === 'cone' ? 90 : 0);
      const rayWidth = Math.max(0.25, this._toNumber(doc?.width, 1));
      const radiusPx = distance * distancePixels;

      let hasPath = false;
      ctx.beginPath();
      if (type === 'circle') {
        if (radiusPx > 0) {
          ctx.arc(x, y, radiusPx, 0, Math.PI * 2);
          hasPath = true;
        }
      } else if (type === 'cone') {
        if (radiusPx > 0 && angleDeg > 0) {
          if (angleDeg >= 360) {
            ctx.arc(x, y, radiusPx, 0, Math.PI * 2);
          } else {
            const start = ((directionDeg - (angleDeg * 0.5)) * Math.PI) / 180;
            const end = ((directionDeg + (angleDeg * 0.5)) * Math.PI) / 180;
            ctx.moveTo(x, y);
            ctx.arc(x, y, radiusPx, start, end);
            ctx.closePath();
          }
          hasPath = true;
        }
      } else if (type === 'rect') {
        if (radiusPx > 0) {
          const rad = (directionDeg * Math.PI) / 180;
          const ex = x + (Math.cos(rad) * radiusPx);
          const ey = y + (Math.sin(rad) * radiusPx);
          const minX = Math.min(x, ex);
          const minY = Math.min(y, ey);
          const rw = Math.abs(ex - x);
          const rh = Math.abs(ey - y);
          if (rw > 0 && rh > 0) {
            ctx.rect(minX, minY, rw, rh);
            hasPath = true;
          }
        }
      } else if (type === 'ray') {
        const widthPx = rayWidth * distancePixels;
        if (radiusPx > 0 && widthPx > 0) {
          const dirRad = (directionDeg * Math.PI) / 180;
          const dirX = Math.cos(dirRad);
          const dirY = Math.sin(dirRad);
          const perpX = -dirY;
          const perpY = dirX;
          const halfW = widthPx * 0.5;

          const p00x = x + (perpX * halfW);
          const p00y = y + (perpY * halfW);
          const p01x = x - (perpX * halfW);
          const p01y = y - (perpY * halfW);
          const p10x = p00x + (dirX * radiusPx);
          const p10y = p00y + (dirY * radiusPx);
          const p11x = p01x + (dirX * radiusPx);
          const p11y = p01y + (dirY * radiusPx);

          ctx.moveTo(p00x, p00y);
          ctx.lineTo(p10x, p10y);
          ctx.lineTo(p11x, p11y);
          ctx.lineTo(p01x, p01y);
          ctx.closePath();
          hasPath = true;
        }
      }

      if (!hasPath) continue;

      const borderColor = this._normalizeHexColor(doc?.borderColor) || '#ff5500';
      const fillColor = this._normalizeHexColor(doc?.fillColor) || '#ffffff';

      // Persist grid-cell highlights in non-template modes by deriving them
      // directly from template geometry, instead of relying on runtime PIXI
      // highlight objects that Foundry may only expose while template tools are active.
      const grid = canvas?.grid;
      const gridTypes = globalThis.CONST?.GRID_TYPES || {};
      const isGridless = !!(grid && grid.type === gridTypes.GRIDLESS);
      if (!isGridless) {
        const dimsGrid = canvas?.dimensions ?? {};
        const gx = Math.max(1, this._toNumber(grid?.sizeX ?? dimsGrid?.sizeX ?? dimsGrid?.size, 100));
        const gy = Math.max(1, this._toNumber(grid?.sizeY ?? dimsGrid?.sizeY ?? dimsGrid?.size, 100));
        const sceneRect = dimsGrid?.sceneRect ?? { x: 0, y: 0, width: this._worldLogicalWidth, height: this._worldLogicalHeight };
        const docId = doc?.id != null ? String(doc.id) : '';
        const placeable = docId ? (placeablesById.get(docId) ?? null) : null;
        const nativeGridCells = this._getTemplateGridHighlightCells(placeable);
        if (docId && nativeGridCells.length > 0) {
          this._templateGridCellsCache.set(docId, nativeGridCells);
        }
        const cachedGridCells = docId ? (this._templateGridCellsCache.get(docId) ?? []) : [];
        const supportsNativeCells = this._hasTemplateGridHighlightGetter(placeable);
        const hasReliableNativeCells = nativeGridCells.length > 0 || cachedGridCells.length > 0;
        if (hasReliableNativeCells) {
          // Preferred path: use Foundry-computed highlighted cells which already
          // account for wall clipping/occlusion rules.
          const cellsToDraw = nativeGridCells.length > 0 ? nativeGridCells : cachedGridCells;
          ctx.save();
          ctx.fillStyle = this._rgbaFromHex(fillColor, 0.14);
          for (const cell of cellsToDraw) {
            const cellX = sceneRect.x + (Math.floor((cell.x - sceneRect.x) / gx) * gx);
            const cellY = sceneRect.y + (Math.floor((cell.y - sceneRect.y) / gy) * gy);
            ctx.fillRect(cellX, cellY, gx, gy);
          }
          ctx.restore();
        } else if (docId && (!placeable || supportsNativeCells)) {
          // Placeable/grid cells not ready yet (common right after refresh).
          // Never draw wall-blind geometric cells here — wait for native positions.
          pendingNativeGridHydration = true;
        } else if (!supportsNativeCells) {
          // Rare: no _getGridHighlightPositions — geometric approximation only.
          const bounds = this._getTemplateDocBounds(doc, distancePixels);
          const startCol = Math.floor((bounds.minX - sceneRect.x) / gx) - 1;
          const endCol = Math.ceil((bounds.maxX - sceneRect.x) / gx) + 1;
          const startRow = Math.floor((bounds.minY - sceneRect.y) / gy) - 1;
          const endRow = Math.ceil((bounds.maxY - sceneRect.y) / gy) + 1;
          ctx.save();
          ctx.fillStyle = this._rgbaFromHex(fillColor, 0.08);
          for (let row = startRow; row <= endRow; row += 1) {
            for (let col = startCol; col <= endCol; col += 1) {
              const cellX = sceneRect.x + (col * gx);
              const cellY = sceneRect.y + (row * gy);
              const cx = cellX + (gx * 0.5);
              const cy = cellY + (gy * 0.5);
              if (ctx.isPointInPath(cx, cy)) {
                ctx.fillRect(cellX, cellY, gx, gy);
              }
            }
          }
          ctx.restore();
        }
      }
      ctx.fillStyle = this._rgbaFromHex(fillColor, 0.16);
      ctx.strokeStyle = this._rgbaFromHex(borderColor, 0.75);
      ctx.lineWidth = Math.max(1, this._borderThicknessForDocReplay(uiScale));
      ctx.fill();
      ctx.stroke();

      // Keep a persistent icon marker visible for settled templates.
      this._drawTemplateDocControlIcon(ctx, x, y, uiScale, borderColor);

      drawn += 1;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (pendingNativeGridHydration) {
      this._pendingTemplateOcclusionHydration = true;
    }
    worldTexture.needsUpdate = true;
    return {
      ok: true,
      count: drawn,
      status: `captured:templates-doc-replay:${w}x${h} logical=${logicalW}x${logicalH} ss=${captureScale.toFixed(2)} previewOnly=${previewOnly ? 1 : 0} docs=${drawn}`,
    };
  }

  /**
   * Resolve Foundry-native highlighted grid cells for a measured template.
   * These cells include wall occlusion/clipping in systems where Foundry
   * computes blocked geometry.
   * @param {any} placeable
   * @returns {Array<{x:number,y:number}>}
   * @private
   */
  _getTemplateGridHighlightCells(placeable) {
    if (!placeable) return [];
    const getter =
      (typeof placeable._getGridHighlightPositions === 'function' && placeable._getGridHighlightPositions)
      || (typeof placeable.getGridHighlightPositions === 'function' && placeable.getGridHighlightPositions);
    if (typeof getter !== 'function') return [];
    let cells = [];
    try {
      cells = getter.call(placeable) ?? [];
    } catch (_) {
      return [];
    }
    if (!Array.isArray(cells) || cells.length <= 0) return [];

    const out = [];
    for (const cell of cells) {
      if (Array.isArray(cell) && cell.length >= 2) {
        const x = this._toNumber(cell[0], NaN);
        const y = this._toNumber(cell[1], NaN);
        if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y });
        continue;
      }
      const x = this._toNumber(cell?.x, NaN);
      const y = this._toNumber(cell?.y, NaN);
      if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y });
    }
    return out;
  }

  /**
   * @param {any} placeable
   * @returns {boolean}
   * @private
   */
  _hasTemplateGridHighlightGetter(placeable) {
    if (!placeable) return false;
    return typeof placeable._getGridHighlightPositions === 'function'
      || typeof placeable.getGridHighlightPositions === 'function';
  }

  /**
   * @param {number} uiScale
   * @returns {number}
   * @private
   */
  _borderThicknessForDocReplay(uiScale) {
    const borderThickness = this._toNumber(this?._borderThickness, 3);
    return borderThickness * Math.max(0.25, this._toNumber(uiScale, 1));
  }

  /**
   * Estimate world-space bounds for a measured template document.
   * @param {any} doc
   * @param {number} distancePixels
   * @returns {{minX:number,minY:number,maxX:number,maxY:number}}
   * @private
   */
  _getTemplateDocBounds(doc, distancePixels) {
    const type = this._normalizeMeasuredTemplateShape(doc);
    const x = this._toNumber(doc?.x, 0);
    const y = this._toNumber(doc?.y, 0);
    const directionDeg = this._toNumber(doc?.direction, 0);
    const distance = Math.max(0, this._toNumber(doc?.distance, 0));
    const angleDegRaw = this._toNumber(doc?.angle, 0);
    const angleDeg = angleDegRaw > 0 ? angleDegRaw : (type === 'cone' ? 90 : 0);
    const rayWidth = Math.max(0.25, this._toNumber(doc?.width, 1));
    const radiusPx = distance * distancePixels;

    if (type === 'circle' || type === 'cone') {
      return { minX: x - radiusPx, minY: y - radiusPx, maxX: x + radiusPx, maxY: y + radiusPx };
    }
    if (type === 'rect') {
      const rad = (directionDeg * Math.PI) / 180;
      const ex = x + (Math.cos(rad) * radiusPx);
      const ey = y + (Math.sin(rad) * radiusPx);
      return { minX: Math.min(x, ex), minY: Math.min(y, ey), maxX: Math.max(x, ex), maxY: Math.max(y, ey) };
    }
    if (type === 'ray') {
      const widthPx = rayWidth * distancePixels;
      const halfW = widthPx * 0.5;
      const rad = (directionDeg * Math.PI) / 180;
      const ex = x + (Math.cos(rad) * radiusPx);
      const ey = y + (Math.sin(rad) * radiusPx);
      return {
        minX: Math.min(x, ex) - halfW,
        minY: Math.min(y, ey) - halfW,
        maxX: Math.max(x, ex) + halfW,
        maxY: Math.max(y, ey) + halfW
      };
    }
    return { minX: x, minY: y, maxX: x, maxY: y };
  }

  /**
   * Draw a persistent control marker for doc-replayed templates.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} uiScale
   * @param {string} borderColor
   * @private
   */
  _drawTemplateDocControlIcon(ctx, x, y, uiScale, borderColor) {
    const r = Math.max(5, 9 * Math.max(0.25, this._toNumber(uiScale, 1)));
    const templateIcon = this._getTemplateControlIconImage();
    if (templateIcon) {
      const size = Math.max(16, r * 2.4);
      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = 0.95;
      ctx.drawImage(templateIcon, x - (size * 0.5), y - (size * 0.5), size, size);
      ctx.globalAlpha = prevAlpha;
      return;
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.22);
    ctx.strokeStyle = this._rgbaFromHex(borderColor || '#ff5500', 0.95);
    ctx.stroke();

    const c = r * 0.45;
    ctx.beginPath();
    ctx.moveTo(x - c, y);
    ctx.lineTo(x + c, y);
    ctx.moveTo(x, y - c);
    ctx.lineTo(x, y + c);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = Math.max(1, r * 0.16);
    ctx.stroke();
  }

  /**
   * Replay measured templates by extracting native template visuals from each placeable.
   * @param {PIXI.TemplateLayer|null} templatesLayer
   * @param {PIXI.Renderer|null} renderer
   * @param {number} width
   * @param {number} height
   * @param {{previewOnly?:boolean}} [options]
   * @returns {{ok:boolean,count:number,status:string}}
   * @private
   */
  _renderFoundryTemplatesReplay(templatesLayer, renderer, width, height, options = {}) {
    const previewOnly = options?.previewOnly === true;
    const logicalW = Math.max(1, Math.round(this._toNumber(width, 1)));
    const logicalH = Math.max(1, Math.round(this._toNumber(height, 1)));
    const baseCaptureScale = this._getWorldCaptureScale(logicalW, logicalH);
    const captureScale = previewOnly ? Math.min(1.0, baseCaptureScale) : baseCaptureScale;
    const renderW = Math.max(1, Math.round(logicalW * captureScale));
    const renderH = Math.max(1, Math.round(logicalH * captureScale));
    this._worldLogicalWidth = logicalW;
    this._worldLogicalHeight = logicalH;

    const worldTexture = this._ensureWorldCanvasSize(renderW, renderH);
    if (!worldTexture || !this._worldCanvas || !renderer?.extract) {
      return { ok: false, count: 0, status: 'skip:templates-replay-unavailable' };
    }

    const ctx = this._worldCanvas.getContext('2d');
    if (!ctx) return { ok: false, count: 0, status: 'skip:no-world-context' };

    const templates = [];
    const seen = new Set();
    const collect = (obj) => {
      if (!obj) return;
      const key = String(obj.id ?? obj?.document?.id ?? `${templates.length}`);
      if (seen.has(key)) return;
      seen.add(key);
      templates.push(obj);
    };

    const previewChildren = Array.isArray(templatesLayer?.preview?.children) ? templatesLayer.preview.children : [];
    if (!previewOnly) {
      const placeables = Array.isArray(templatesLayer?.placeables) ? templatesLayer.placeables : [];
      const objectChildren = Array.isArray(templatesLayer?.objects?.children) ? templatesLayer.objects.children : [];
      for (const p of placeables) collect(p);
      for (const p of objectChildren) collect(p);
    }
    for (const p of previewChildren) collect(p);
    if (templatesLayer?._configPreview) collect(templatesLayer._configPreview);

    templates.sort((a, b) => this._toNumber(a?.document?.sort ?? a?.sort, 0) - this._toNumber(b?.document?.sort ?? b?.sort, 0));

    const w = this._worldCanvas.width;
    const h = this._worldCanvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.setTransform(captureScale, 0, 0, captureScale, 0, 0);
    ctx.imageSmoothingEnabled = true;

    if (templates.length <= 0) {
      worldTexture.needsUpdate = true;
      return { ok: true, count: 0, status: `captured:templates-replay-empty:${w}x${h}` };
    }

    let drawn = 0;
    const maxWorldW = Math.max(1, logicalW * 1.5);
    const maxWorldH = Math.max(1, logicalH * 1.5);
    for (const template of templates) {
      const targetCandidates = [];
      let rootTarget = null;
      const pushUniqueTarget = (target) => {
        if (!target) return;
        if (targetCandidates.includes(target)) return;
        targetCandidates.push(target);
      };

      // Prefer explicit runtime children first so we preserve wall-occluded field,
      // icon, and ruler text layers across reloads where container composition
      // order can differ. Root container is a fallback only.
      rootTarget = template;
      pushUniqueTarget(template?.field);
      pushUniqueTarget(template?.template);
      pushUniqueTarget(template?.shape);
      pushUniqueTarget(template?.highlight);
      pushUniqueTarget(template?.frame);
      pushUniqueTarget(template?.icon);
      pushUniqueTarget(template?.controlIcon);
      pushUniqueTarget(template?.ruler);
      pushUniqueTarget(template?.rulerText);
      pushUniqueTarget(template?.tooltip);

      let drewAnyCandidate = false;
      for (const target of targetCandidates) {
        const savedChainState = [];
        let chainNode = target;
        while (chainNode) {
          savedChainState.push({
            obj: chainNode,
            visible: chainNode.visible,
            renderable: chainNode.renderable,
            alpha: Number(chainNode.alpha),
          });
          chainNode.visible = true;
          chainNode.renderable = true;
          if (!Number.isFinite(chainNode.alpha) || chainNode.alpha <= 0) chainNode.alpha = 1;
          chainNode = chainNode.parent ?? null;
        }
        try {
          let bounds = null;
          try { bounds = target.getBounds?.(false) ?? null; } catch (_) { bounds = null; }
          const bx = Math.floor(this._toNumber(bounds?.x, 0));
          const by = Math.floor(this._toNumber(bounds?.y, 0));
          const bw = Math.ceil(this._toNumber(bounds?.width, 0));
          const bh = Math.ceil(this._toNumber(bounds?.height, 0));
          if (bw <= 0 || bh <= 0) continue;

          const frame = new PIXI.Rectangle(bx, by, bw, bh);
          let targetCanvas = null;
          try {
            targetCanvas = renderer.extract.canvas(target, frame);
          } catch (_) {
            targetCanvas = null;
          }
          if (!targetCanvas || !targetCanvas.width || !targetCanvas.height) continue;

          const worldRect = this._stageScreenRectToWorldRect(bx, by, bw, bh);
          if (worldRect.w <= 0 || worldRect.h <= 0) continue;
          if (worldRect.w > maxWorldW || worldRect.h > maxWorldH) continue;

          try {
            ctx.drawImage(targetCanvas, worldRect.x, worldRect.y, worldRect.w, worldRect.h);
            drawn += 1;
            drewAnyCandidate = true;
          } catch (_) {
          }
        } finally {
          for (let i = savedChainState.length - 1; i >= 0; i -= 1) {
            const s = savedChainState[i];
            s.obj.visible = s.visible;
            s.obj.renderable = s.renderable;
            s.obj.alpha = s.alpha;
          }
        }
      }

      // Fallback: some systems/modules render template visuals only on the
      // root container. Capture it when no explicit child target drew.
      if (!drewAnyCandidate && rootTarget) {
        const savedChainState = [];
        let chainNode = rootTarget;
        while (chainNode) {
          savedChainState.push({
            obj: chainNode,
            visible: chainNode.visible,
            renderable: chainNode.renderable,
            alpha: Number(chainNode.alpha),
          });
          chainNode.visible = true;
          chainNode.renderable = true;
          if (!Number.isFinite(chainNode.alpha) || chainNode.alpha <= 0) chainNode.alpha = 1;
          chainNode = chainNode.parent ?? null;
        }
        try {
          let bounds = null;
          try { bounds = rootTarget.getBounds?.(false) ?? null; } catch (_) { bounds = null; }
          const bx = Math.floor(this._toNumber(bounds?.x, 0));
          const by = Math.floor(this._toNumber(bounds?.y, 0));
          const bw = Math.ceil(this._toNumber(bounds?.width, 0));
          const bh = Math.ceil(this._toNumber(bounds?.height, 0));
          if (bw > 0 && bh > 0) {
            const frame = new PIXI.Rectangle(bx, by, bw, bh);
            let targetCanvas = null;
            try {
              targetCanvas = renderer.extract.canvas(rootTarget, frame);
            } catch (_) {
              targetCanvas = null;
            }
            if (targetCanvas && targetCanvas.width && targetCanvas.height) {
              const worldRect = this._stageScreenRectToWorldRect(bx, by, bw, bh);
              if (worldRect.w > 0 && worldRect.h > 0 && worldRect.w <= maxWorldW && worldRect.h <= maxWorldH) {
                try {
                  ctx.drawImage(targetCanvas, worldRect.x, worldRect.y, worldRect.w, worldRect.h);
                  drawn += 1;
                } catch (_) {}
              }
            }
          }
        } finally {
          for (let i = savedChainState.length - 1; i >= 0; i -= 1) {
            const s = savedChainState[i];
            s.obj.visible = s.visible;
            s.obj.renderable = s.renderable;
            s.obj.alpha = s.alpha;
          }
        }
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    worldTexture.needsUpdate = true;
    return { ok: true, count: drawn, status: `captured:templates-replay:${w}x${h} logical=${logicalW}x${logicalH} ss=${captureScale.toFixed(2)} previewOnly=${previewOnly ? 1 : 0} shapes=${drawn}` };
  }

  /**
   * Build a compact signature for settled template native capture cache.
   * Includes template and wall doc fields that can affect wall clipping.
   * @returns {string}
   * @private
   */
  _getSettledTemplateCacheSignature() {
    const templateParts = [];
    try {
      const templates = Array.from(canvas?.scene?.templates ?? []);
      for (const doc of templates) {
        if (!doc) continue;
        const id = String(doc.id ?? '');
        const x = Math.round(this._toNumber(doc.x, 0) * 10) / 10;
        const y = Math.round(this._toNumber(doc.y, 0) * 10) / 10;
        const d = Math.round(this._toNumber(doc.distance, 0) * 100) / 100;
        const dir = Math.round(this._toNumber(doc.direction, 0) * 100) / 100;
        const ang = Math.round(this._toNumber(doc.angle, 0) * 100) / 100;
        const t = String(doc.t ?? doc.type ?? '');
        const bc = String(doc.borderColor ?? '');
        const fc = String(doc.fillColor ?? '');
        templateParts.push(`t:${id}:${t}:${x},${y}:${d},${dir},${ang}:${bc}:${fc}`);
      }
    } catch (_) {}
    templateParts.sort();

    const wallParts = [];
    try {
      const walls = Array.from(canvas?.scene?.walls ?? []);
      for (const w of walls) {
        if (!w) continue;
        const id = String(w.id ?? '');
        const c = Array.isArray(w.c) ? w.c : [];
        const c0 = Math.round(this._toNumber(c[0], 0));
        const c1 = Math.round(this._toNumber(c[1], 0));
        const c2 = Math.round(this._toNumber(c[2], 0));
        const c3 = Math.round(this._toNumber(c[3], 0));
        const ds = Math.round(this._toNumber(w.ds, 0));
        const move = Math.round(this._toNumber(w.move, 0));
        const sight = Math.round(this._toNumber(w.sight, 0));
        const light = Math.round(this._toNumber(w.light, 0));
        const sound = Math.round(this._toNumber(w.sound, 0));
        wallParts.push(`w:${id}:${c0},${c1},${c2},${c3}:${ds}:${move}:${sight}:${light}:${sound}`);
      }
    } catch (_) {}
    wallParts.sort();

    return `${templateParts.join('|')}#${wallParts.join('|')}`;
  }

  /**
   * Render settled templates from native Foundry runtime objects into a cached canvas.
   * This preserves wall-clipped highlights exactly as Foundry computes them.
   * @param {PIXI.TemplateLayer|null} templatesLayer
   * @param {PIXI.Renderer|null} renderer
   * @param {number} width
   * @param {number} height
   * @param {{clear?:boolean}} [options]
   * @returns {{ok:boolean,count:number,status:string}}
   * @private
   */
  _renderFoundryTemplatesSettledCache(templatesLayer, renderer, width, height, options = {}) {
    const shouldClear = options?.clear === true;
    const logicalW = Math.max(1, Math.round(this._toNumber(width, 1)));
    const logicalH = Math.max(1, Math.round(this._toNumber(height, 1)));
    const captureScale = this._getWorldCaptureScale(logicalW, logicalH);
    const renderW = Math.max(1, Math.round(logicalW * captureScale));
    const renderH = Math.max(1, Math.round(logicalH * captureScale));
    this._worldLogicalWidth = logicalW;
    this._worldLogicalHeight = logicalH;

    const worldTexture = this._ensureWorldCanvasSize(renderW, renderH);
    if (!worldTexture || !this._worldCanvas || !renderer?.extract) {
      return { ok: false, count: 0, status: 'skip:templates-settled-cache-unavailable' };
    }

    const worldCtx = this._worldCanvas.getContext('2d');
    if (!worldCtx) return { ok: false, count: 0, status: 'skip:no-world-context' };

    let sceneTemplateCount = Number(canvas?.scene?.templates?.size) || 0;
    let sceneWallCount = Number(canvas?.scene?.walls?.size) || 0;
    try {
      if (canvas?.scene?.id && typeof game?.scenes?.get === 'function') {
        const sd = game.scenes.get(canvas.scene.id);
        if (!sceneTemplateCount) sceneTemplateCount = Number(sd?.templates?.size) || 0;
        if (!sceneWallCount) sceneWallCount = Number(sd?.walls?.size) || 0;
      }
    } catch (_) {}
    const runtimeTemplateCount = Array.isArray(templatesLayer?.placeables) ? templatesLayer.placeables.length : 0;
    const runtimeWallCount = Array.isArray(canvas?.walls?.placeables) ? canvas.walls.placeables.length : 0;
    const templatesRuntimeReady = sceneTemplateCount <= 0 || runtimeTemplateCount >= sceneTemplateCount;
    const wallsRuntimeReady = sceneWallCount <= 0 || runtimeWallCount >= sceneWallCount;
    const runtimeReady = templatesRuntimeReady && wallsRuntimeReady;
    if (!runtimeReady) {
      this._pendingTemplateOcclusionHydration = true;
      this._dirty = true;
      this._postDirtyCapturesRemaining = Math.max(this._postDirtyCapturesRemaining, 2);
      this._lastUpdateStatus = `retry:templates-settled-runtime-not-ready tpl=${runtimeTemplateCount}/${sceneTemplateCount} walls=${runtimeWallCount}/${sceneWallCount}`;
      return { ok: false, count: 0, status: this._lastUpdateStatus };
    }

    const cacheSig = `${this._getSettledTemplateCacheSignature()}|runtime:${runtimeTemplateCount}:${runtimeWallCount}`;
    const cacheValid =
      !!this._templatesSettledCacheCanvas
      && cacheSig === this._templatesSettledCacheSig
      && this._templatesSettledCacheLogicalW === logicalW
      && this._templatesSettledCacheLogicalH === logicalH;

    if (!cacheValid) {
      const cacheCanvas = document.createElement('canvas');
      cacheCanvas.width = renderW;
      cacheCanvas.height = renderH;
      const ctx = cacheCanvas.getContext('2d');
      if (!ctx) return { ok: false, count: 0, status: 'skip:no-templates-cache-context' };
      ctx.setTransform(captureScale, 0, 0, captureScale, 0, 0);
      ctx.imageSmoothingEnabled = true;

      const templates = [];
      const seen = new Set();
      const collect = (obj) => {
        if (!obj) return;
        const key = String(obj.id ?? obj?.document?.id ?? templates.length);
        if (seen.has(key)) return;
        seen.add(key);
        templates.push(obj);
      };
      const placeables = Array.isArray(templatesLayer?.placeables) ? templatesLayer.placeables : [];
      const objectChildren = Array.isArray(templatesLayer?.objects?.children) ? templatesLayer.objects.children : [];
      for (const p of placeables) collect(p);
      for (const p of objectChildren) collect(p);
      templates.sort((a, b) => this._toNumber(a?.document?.sort ?? a?.sort, 0) - this._toNumber(b?.document?.sort, 0));

      let drawn = 0;
      let drewTemplateGeometry = false;
      const minPrimaryPaintArea = Math.max(1200, (logicalW * logicalH) * 0.00004);
      const isPrimaryTemplatePaintTarget = (tpl, tgt) => {
        if (!tgt) return false;
        if (tgt === tpl?.field || tgt === tpl?.highlight) return true;
        if (!(tpl?.field || tpl?.highlight) && (tgt === tpl?.template || tgt === tpl?.shape)) return true;
        return false;
      };
      const maxWorldW = Math.max(1, logicalW * 1.5);
      const maxWorldH = Math.max(1, logicalH * 1.5);
      for (const template of templates) {
        const targetCandidates = [];
        const pushUniqueTarget = (target) => {
          if (!target) return;
          if (targetCandidates.includes(target)) return;
          targetCandidates.push(target);
        };
        // Settled native visuals only: field/highlight/shape/template.
        pushUniqueTarget(template?.field);
        pushUniqueTarget(template?.highlight);
        pushUniqueTarget(template?.template);
        pushUniqueTarget(template?.shape);
        const rootTarget = template;

        let drewAny = false;
        for (const target of targetCandidates) {
          const savedChainState = [];
          let chainNode = target;
          while (chainNode) {
            savedChainState.push({
              obj: chainNode,
              visible: chainNode.visible,
              renderable: chainNode.renderable,
              alpha: Number(chainNode.alpha),
            });
            chainNode.visible = true;
            chainNode.renderable = true;
            if (!Number.isFinite(chainNode.alpha) || chainNode.alpha <= 0) chainNode.alpha = 1;
            chainNode = chainNode.parent ?? null;
          }
          try {
            let bounds = null;
            try { bounds = target.getBounds?.(false) ?? null; } catch (_) { bounds = null; }
            const bx = Math.floor(this._toNumber(bounds?.x, 0));
            const by = Math.floor(this._toNumber(bounds?.y, 0));
            const bw = Math.ceil(this._toNumber(bounds?.width, 0));
            const bh = Math.ceil(this._toNumber(bounds?.height, 0));
            if (bw <= 0 || bh <= 0) continue;
            const frame = new PIXI.Rectangle(bx, by, bw, bh);
            let targetCanvas = null;
            try { targetCanvas = renderer.extract.canvas(target, frame); } catch (_) { targetCanvas = null; }
            if (!targetCanvas || !targetCanvas.width || !targetCanvas.height) continue;
            const worldRect = this._stageScreenRectToWorldRect(bx, by, bw, bh);
            if (worldRect.w <= 0 || worldRect.h <= 0) continue;
            if (worldRect.w > maxWorldW || worldRect.h > maxWorldH) continue;
            try {
              ctx.drawImage(targetCanvas, worldRect.x, worldRect.y, worldRect.w, worldRect.h);
              drawn += 1;
              drewAny = true;
              const area = worldRect.w * worldRect.h;
              if (isPrimaryTemplatePaintTarget(template, target) && area >= minPrimaryPaintArea) {
                drewTemplateGeometry = true;
              }
            } catch (_) {}
          } finally {
            for (let i = savedChainState.length - 1; i >= 0; i -= 1) {
              const s = savedChainState[i];
              s.obj.visible = s.visible;
              s.obj.renderable = s.renderable;
              s.obj.alpha = s.alpha;
            }
          }
        }

        if (!drewAny && rootTarget) {
          // Fallback for system-specific runtime composition.
          const savedChainState = [];
          let chainNode = rootTarget;
          while (chainNode) {
            savedChainState.push({
              obj: chainNode,
              visible: chainNode.visible,
              renderable: chainNode.renderable,
              alpha: Number(chainNode.alpha),
            });
            chainNode.visible = true;
            chainNode.renderable = true;
            if (!Number.isFinite(chainNode.alpha) || chainNode.alpha <= 0) chainNode.alpha = 1;
            chainNode = chainNode.parent ?? null;
          }
          try {
            let bounds = null;
            try { bounds = rootTarget.getBounds?.(false) ?? null; } catch (_) { bounds = null; }
            const bx = Math.floor(this._toNumber(bounds?.x, 0));
            const by = Math.floor(this._toNumber(bounds?.y, 0));
            const bw = Math.ceil(this._toNumber(bounds?.width, 0));
            const bh = Math.ceil(this._toNumber(bounds?.height, 0));
            if (bw > 0 && bh > 0) {
              const frame = new PIXI.Rectangle(bx, by, bw, bh);
              let targetCanvas = null;
              try { targetCanvas = renderer.extract.canvas(rootTarget, frame); } catch (_) { targetCanvas = null; }
              if (targetCanvas && targetCanvas.width && targetCanvas.height) {
                const worldRect = this._stageScreenRectToWorldRect(bx, by, bw, bh);
                if (worldRect.w > 0 && worldRect.h > 0 && worldRect.w <= maxWorldW && worldRect.h <= maxWorldH) {
                  try {
                    ctx.drawImage(targetCanvas, worldRect.x, worldRect.y, worldRect.w, worldRect.h);
                    drawn += 1;
                    const area = worldRect.w * worldRect.h;
                    const lacksPaintParts = !(template?.field || template?.highlight);
                    if (lacksPaintParts && area >= minPrimaryPaintArea) {
                      drewTemplateGeometry = true;
                    }
                  } catch (_) {}
                }
              }
            }
          } finally {
            for (let i = savedChainState.length - 1; i >= 0; i -= 1) {
              const s = savedChainState[i];
              s.obj.visible = s.visible;
              s.obj.renderable = s.renderable;
              s.obj.alpha = s.alpha;
            }
          }
        }
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this._templatesSettledCacheCanvas = cacheCanvas;
      this._templatesSettledCacheLogicalW = logicalW;
      this._templatesSettledCacheLogicalH = logicalH;
      this._templatesSettledCacheSig = cacheSig;
      if (drawn <= 0) {
        this._pendingTemplateOcclusionHydration = true;
        this._dirty = true;
        this._postDirtyCapturesRemaining = Math.max(this._postDirtyCapturesRemaining, 1);
        return { ok: false, count: 0, status: 'retry:templates-settled-cache-empty' };
      }
      if (templates.length > 0 && !drewTemplateGeometry) {
        // Extraction produced pixels but none from primary template paint
        // targets (field/highlight/template/shape). Fall back to doc replay
        // this frame to keep templates visible before template-tool activation.
        return { ok: false, count: 0, status: 'skip:templates-settled-cache-no-geometry' };
      }
    }

    const targetW = this._worldCanvas.width;
    const targetH = this._worldCanvas.height;
    worldCtx.setTransform(1, 0, 0, 1, 0, 0);
    if (shouldClear) worldCtx.clearRect(0, 0, targetW, targetH);
    try {
      worldCtx.drawImage(this._templatesSettledCacheCanvas, 0, 0, targetW, targetH);
    } catch (_) {
      return { ok: false, count: 0, status: 'skip:templates-settled-cache-draw-failed' };
    }
    const uiScaleStamp = Math.max(0.25, this._toNumber(canvas?.dimensions?.uiScale, 1));
    this._stampMeasuredTemplateControlIcons(worldCtx, templatesLayer, captureScale, uiScaleStamp);
    worldTexture.needsUpdate = true;
    return {
      ok: true,
      count: 1,
      status: `captured:templates-settled-cache:${targetW}x${targetH} logical=${logicalW}x${logicalH}`,
    };
  }

  /**
   * Collect overlay-level TemplateLayer graphics that are not represented as
   * template placeables. Some runtime visuals (highlight grid/ruler adornments)
   * can be attached directly to the layer.
   * @param {PIXI.TemplateLayer|null} templatesLayer
   * @returns {PIXI.DisplayObject[]}
   * @private
   */
  _getTemplateLayerOverlayTargets(templatesLayer) {
    const overlays = [];
    const children = Array.isArray(templatesLayer?.children) ? templatesLayer.children : [];
    for (const child of children) {
      if (!child) continue;
      if (child === templatesLayer?.objects) continue;
      if (child === templatesLayer?.preview) continue;
      if (child.visible === false || child.renderable === false) continue;
      const ctor = String(child?.constructor?.name || '').toLowerCase();
      const isOverlayLike =
        ctor.includes('graphics')
        || ctor.includes('mesh')
        || ctor.includes('line')
        || ctor.includes('text')
        || ctor.includes('sprite')
        || ctor.includes('controlicon');
      if (!isOverlayLike) continue;
      overlays.push(child);
    }
    return overlays;
  }

  /**
   * Collect overlay-level RegionLayer graphics that are not represented as
   * Region placeables. Foundry stores region draw/create preview and highlight
   * graphics directly on the layer.
   * @param {PIXI.RegionLayer|null} regionsLayer
   * @returns {PIXI.DisplayObject[]}
   * @private
   */
  _getRegionLayerOverlayTargets(regionsLayer) {
    const overlays = [];
    const children = Array.isArray(regionsLayer?.children) ? regionsLayer.children : [];
    for (const child of children) {
      if (!child) continue;
      if (child === regionsLayer?.objects) continue;
      if (child === regionsLayer?.preview) continue;
      if (child.visible === false || child.renderable === false) continue;
      const ctor = String(child?.constructor?.name || '').toLowerCase();
      const isGraphicsLike = ctor.includes('graphics') || ctor.includes('mesh');
      if (!isGraphicsLike) continue;
      overlays.push(child);
    }
    return overlays;
  }

  /**
   * Replay regions by extracting Region placeables and RegionLayer overlay
   * graphics (draw preview/highlight) into the world channel.
   * @param {PIXI.RegionLayer|null} regionsLayer
   * @param {PIXI.Renderer|null} renderer
   * @param {number} width
   * @param {number} height
   * @param {{clear?:boolean}} [options]
   * @returns {{ok:boolean,count:number,status:string}}
   * @private
   */
  _renderFoundryRegionsReplay(regionsLayer, renderer, width, height, options = {}) {
    const shouldClear = options?.clear !== false;
    const logicalW = Math.max(1, Math.round(this._toNumber(width, 1)));
    const logicalH = Math.max(1, Math.round(this._toNumber(height, 1)));
    const baseCaptureScale = this._getWorldCaptureScale(logicalW, logicalH);
    const captureScale = Math.min(1.5, Math.max(1.0, baseCaptureScale));
    const renderW = Math.max(1, Math.round(logicalW * captureScale));
    const renderH = Math.max(1, Math.round(logicalH * captureScale));
    this._worldLogicalWidth = logicalW;
    this._worldLogicalHeight = logicalH;

    const worldTexture = this._ensureWorldCanvasSize(renderW, renderH);
    if (!worldTexture || !this._worldCanvas || !renderer?.extract) {
      return { ok: false, count: 0, status: 'skip:regions-replay-unavailable' };
    }

    const ctx = this._worldCanvas.getContext('2d');
    if (!ctx) return { ok: false, count: 0, status: 'skip:no-world-context' };

    const regions = [];
    const seen = new Set();
    const collect = (obj) => {
      if (!obj) return;
      const key = String(obj.id ?? obj?.document?.id ?? `${regions.length}`);
      if (seen.has(key)) return;
      seen.add(key);
      regions.push(obj);
    };

    const placeables = Array.isArray(regionsLayer?.placeables) ? regionsLayer.placeables : [];
    const objectChildren = Array.isArray(regionsLayer?.objects?.children) ? regionsLayer.objects.children : [];
    const previewChildren = Array.isArray(regionsLayer?.preview?.children) ? regionsLayer.preview.children : [];
    for (const p of placeables) collect(p);
    for (const p of objectChildren) collect(p);
    for (const p of previewChildren) collect(p);
    if (regionsLayer?._configPreview) collect(regionsLayer._configPreview);

    const overlayTargets = this._getRegionLayerOverlayTargets(regionsLayer);
    const w = this._worldCanvas.width;
    const h = this._worldCanvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (shouldClear) ctx.clearRect(0, 0, w, h);
    ctx.setTransform(captureScale, 0, 0, captureScale, 0, 0);
    ctx.imageSmoothingEnabled = true;

    if (regions.length <= 0 && overlayTargets.length <= 0) {
      worldTexture.needsUpdate = true;
      return { ok: true, count: 0, status: `captured:regions-replay-empty:${w}x${h}` };
    }

    let drawn = 0;
    const maxWorldW = Math.max(1, logicalW * 1.5);
    const maxWorldH = Math.max(1, logicalH * 1.5);

    const drawExtractTarget = (target) => {
      if (!target) return false;
      const savedChainState = [];
      let chainNode = target;
      while (chainNode) {
        savedChainState.push({
          obj: chainNode,
          visible: chainNode.visible,
          renderable: chainNode.renderable,
          alpha: Number(chainNode.alpha),
        });
        chainNode.visible = true;
        chainNode.renderable = true;
        if (!Number.isFinite(chainNode.alpha) || chainNode.alpha <= 0) chainNode.alpha = 1;
        chainNode = chainNode.parent ?? null;
      }
      try {
        let bounds = null;
        try { bounds = target.getBounds?.(false) ?? null; } catch (_) { bounds = null; }
        const bx = Math.floor(this._toNumber(bounds?.x, 0));
        const by = Math.floor(this._toNumber(bounds?.y, 0));
        const bw = Math.ceil(this._toNumber(bounds?.width, 0));
        const bh = Math.ceil(this._toNumber(bounds?.height, 0));
        if (bw <= 0 || bh <= 0) return false;

        const frame = new PIXI.Rectangle(bx, by, bw, bh);
        let targetCanvas = null;
        try {
          targetCanvas = renderer.extract.canvas(target, frame);
        } catch (_) {
          targetCanvas = null;
        }
        if (!targetCanvas || !targetCanvas.width || !targetCanvas.height) return false;

        const worldRect = this._stageScreenRectToWorldRect(bx, by, bw, bh);
        if (worldRect.w <= 0 || worldRect.h <= 0) return false;
        if (worldRect.w > maxWorldW || worldRect.h > maxWorldH) return false;

        ctx.drawImage(targetCanvas, worldRect.x, worldRect.y, worldRect.w, worldRect.h);
        return true;
      } catch (_) {
        return false;
      } finally {
        for (let i = savedChainState.length - 1; i >= 0; i -= 1) {
          const s = savedChainState[i];
          s.obj.visible = s.visible;
          s.obj.renderable = s.renderable;
          s.obj.alpha = s.alpha;
        }
      }
    };

    for (const region of regions) {
      if (drawExtractTarget(region)) drawn += 1;
    }
    for (const overlay of overlayTargets) {
      if (drawExtractTarget(overlay)) drawn += 1;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    worldTexture.needsUpdate = true;
    return { ok: true, count: drawn, status: `captured:regions-replay:${w}x${h} logical=${logicalW}x${logicalH} ss=${captureScale.toFixed(2)} shapes=${drawn}` };
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
    const perf = window?.MapShine
      ? (window.MapShine.__pixiBridgePerfStats ||= {
          frames: 0,
          captureAttempts: 0,
          skipIdle: 0,
          skipThrottled: 0,
          skipLiveThrottled: 0,
          skipPostDirtyThrottled: 0,
          skipDuplicateFrame: 0,
          lastStatus: 'init',
        })
      : null;
    if (perf) perf.frames += 1;

    this._refreshTextureSamplingIfNeeded();

    if (!canvas?.ready) {
      this._lastUpdateStatus = 'skip:canvas-not-ready';
      this._clearChannel('world');
      this._clearChannel('ui');
      this._uiHasContent = false;
      return;
    }

    // During active template editing, PIXI overlay is already the visual source
    // of truth (top canvas). Avoid expensive bridge recapture while that editor
    // overlay is visible; keep dirty=true so we refresh once editing ends.
    if (this._isTemplatesContextActive() && window?.MapShine?.__forcePixiEditorOverlay === true) {
      this._lastUpdateStatus = 'skip:templates-editor-overlay-active';
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
    const useNativePersistentPixiOverlays = window?.MapShine?.__useNativePersistentPixiOverlays === true;
    const lightingLayer = canvas?.lighting;
    const regionsLayer = canvas?.regions;
    
    const hasOtherLivePreview =
      (this._isDrawingsContextActive() && this._hasActivePreview(drawingsLayer)) ||
      (this._isNotesContextActive() && this._hasActivePreview(notesLayer)) ||
      (this._isLightingContextActive() && this._hasActivePreview(lightingLayer)) ||
      (this._isRegionsContextActive() && this._hasActivePreview(regionsLayer));

    const soundsPreviewSig = this._getSoundsPreviewSignature(soundsLayer);
    const soundsPreviewChanged = soundsPreviewSig !== this._lastSoundsPreviewSig;
    this._lastSoundsPreviewSig = soundsPreviewSig;

    const templatesPreviewSig = this._getTemplatesPreviewSignature(templatesLayer);
    const templatesPreviewChanged = templatesPreviewSig !== this._lastTemplatesPreviewSig;
    this._lastTemplatesPreviewSig = templatesPreviewSig;

    // For sounds, only treat preview as "live" while geometry is changing.
    // This prevents stale preview objects from forcing perpetual recapture.
    const hasLivePreview = hasOtherLivePreview || soundsPreviewChanged || templatesPreviewChanged;

    if (window?.MapShine) {
      window.MapShine.__pixiBridgeFrameTrigger = {
        dirty: !!this._dirty,
        hasLivePreview,
        soundsPreviewChanged,
        templatesPreviewChanged,
        postDirtyCapturesRemaining: this._postDirtyCapturesRemaining,
        pendingZoomRecapture: !!this._pendingStageZoomSig,
      };
    }
      
    const forceTestPattern = this._isCompositorSanityPatternEnabled();
    this._lastStageTransformSig = this._getStageTransformSignature();
    const now = performance.now();
    this._markDirtyForZoomIfNeeded(now);

    // Safety net: only retry after explicit empty/failure statuses, and at a
    // low frequency. Avoid per-frame pixel probing which can force recapture
    // thrash on large scene canvases.
    const drawingsPresent =
      ((Number(canvas?.scene?.drawings?.size) || 0) > 0)
      || !!drawingsLayer?.placeables?.length
      || this._hasActivePreview(drawingsLayer);
    let sceneTplSize = Number(canvas?.scene?.templates?.size) || 0;
    try {
      if (!sceneTplSize && canvas?.scene?.id && typeof game?.scenes?.get === 'function') {
        const sd = game.scenes.get(canvas.scene.id);
        sceneTplSize = Number(sd?.templates?.size) || 0;
      }
    } catch (_) {}
    const templatesPresent =
      sceneTplSize > 0
      || !!templatesLayer?.placeables?.length
      || !!templatesLayer?.objects?.children?.length
      || this._hasActivePreview(templatesLayer);
    const templatesRuntimeReady =
      !!templatesLayer?.placeables?.length
      || !!templatesLayer?.objects?.children?.length
      || this._getTemplateLayerOverlayTargets(templatesLayer).length > 0
      || this._hasActivePreview(templatesLayer);
    const lastStatus = String(this._lastUpdateStatus || '');
    const needsRecoveryRetry =
      lastStatus.includes('replay-empty')
      || lastStatus.includes('replay-failed')
      || lastStatus.includes('capture-threw')
      || lastStatus.includes('no-ui-shapes')
      || lastStatus.includes('ui-shapes-empty');
    const recoveryCooldownMs = 1200;
    if (!this._dirty && drawingsPresent && needsRecoveryRetry && (now - this._lastDrawingsRecoveryAttemptMs) > recoveryCooldownMs) {
      this._dirty = true;
      this._postDirtyCapturesRemaining = Math.max(this._postDirtyCapturesRemaining, 1);
      this._lastDrawingsRecoveryAttemptMs = now;
      this._lastUpdateStatus = 'retry:drawings-status-recovery';
    }

    // Startup guard: if scene drawings exist but we have not reached a stable
    // capture yet, force an extra recapture window. This prevents the bridge
    // from settling into skip:idle with an empty startup texture.
    const startupStatus = String(this._lastUpdateStatus || '');
    const needsStartupDrawingsBootstrap =
      !this._dirty
      && drawingsPresent
      && (this._lastCaptureMs <= 0)
      && startupStatus === 'init';
    if (needsStartupDrawingsBootstrap) {
      this._dirty = true;
      this._postDirtyCapturesRemaining = Math.max(this._postDirtyCapturesRemaining, 2);
      this._lastUpdateStatus = 'retry:startup-drawings-bootstrap';
    }

    // Template docs can exist before TemplateLayer runtime display objects are
    // hydrated. Entering template tool triggers that hydration, which is why
    // templates "appear" only after the tool swap. Proactively hydrate once
    // during startup/runtime drift so templates are visible in default mode.
    const templatesBootstrapCooldownMs = 900;
    const templatesBootstrapCooldown =
      this._lastTemplatesBootstrapAttemptMs <= 0 ? 0 : templatesBootstrapCooldownMs;
    const needsTemplatesHydration =
      templatesPresent
      && !templatesRuntimeReady
      && (now - this._lastTemplatesBootstrapAttemptMs) > templatesBootstrapCooldown;
    if (needsTemplatesHydration) {
      this._lastTemplatesBootstrapAttemptMs = now;
      try {
        if (typeof templatesLayer?.draw === 'function') {
          const maybePromise = templatesLayer.draw();
          if (maybePromise?.then) {
            maybePromise.then(() => {
              this._dirty = true;
              this._postDirtyCapturesRemaining = Math.max(this._postDirtyCapturesRemaining, 2);
            }).catch(() => {});
          }
        }
      } catch (_) {}
      this._dirty = true;
      this._postDirtyCapturesRemaining = Math.max(this._postDirtyCapturesRemaining, 2);
      this._lastUpdateStatus = 'retry:startup-templates-bootstrap';
    }
    if (templatesPresent) {
      this._hydrateTemplateOcclusionReadiness(templatesLayer, now);
    } else {
      this._pendingTemplateOcclusionHydration = false;
      this._templateOcclusionHydrationAttempts = 0;
      this._templateGridCellsCache.clear();
    }

    if (this._testPatternWasEnabled && !forceTestPattern) {
      this._dirty = true;
    }
    this._testPatternWasEnabled = forceTestPattern;

    const hasFollowupCapture = this._postDirtyCapturesRemaining > 0;

    if (!templatesPresent) {
      this._templateWorldPublishOk = true;
    } else if (!this._templateWorldPublishOk) {
      this._dirty = true;
      this._postDirtyCapturesRemaining = Math.max(this._postDirtyCapturesRemaining, 2);
    }

    // Fullscreen extraction is expensive. Outside of explicit dirty changes,
    // only keep capturing while a drawing preview is actively being edited,
    // or for a short post-mutation followup window.
    if (!this._dirty && !hasLivePreview && !forceTestPattern && !hasFollowupCapture) {
      this._lastUpdateStatus = 'skip:idle';
      if (perf) {
        perf.skipIdle += 1;
        perf.lastStatus = this._lastUpdateStatus;
      }
      return;
    }

    // Throttle post-dirty followup captures to avoid burst uploads after mutations.
    if (!this._dirty && hasFollowupCapture && !hasLivePreview && !forceTestPattern) {
      if ((now - this._lastCaptureMs) < this._postDirtyThrottleMs) {
        this._lastUpdateStatus = 'skip:postdirty-throttled';
        if (perf) {
          perf.skipPostDirtyThrottled += 1;
          perf.lastStatus = this._lastUpdateStatus;
        }
        return;
      }
    }

    const hasFrameId = (arguments.length > 0) && Number.isFinite(frameId);
    if (hasFrameId && frameId === this._lastCaptureFrame && !this._dirty && !forceTestPattern) {
      this._lastUpdateStatus = 'skip:duplicate-frame';
      if (perf) {
        perf.skipDuplicateFrame += 1;
        perf.lastStatus = this._lastUpdateStatus;
      }
      return;
    }

    if (!forceTestPattern && !this._dirty && !hasLivePreview && (now - this._lastCaptureMs) < this._captureThrottleMs) {
      this._lastUpdateStatus = 'skip:throttled';
      if (perf) {
        perf.skipThrottled += 1;
        perf.lastStatus = this._lastUpdateStatus;
      }
      return;
    }

    this._lastCaptureMs = now;
    this._lastCaptureFrame = hasFrameId ? frameId : this._lastCaptureFrame;
    if (perf) {
      perf.captureAttempts += 1;
      perf.lastStatus = this._lastUpdateStatus;
    }
    if (this._postDirtyCapturesRemaining > 0) {
      this._postDirtyCapturesRemaining -= 1;
    }

    const renderer = canvas?.app?.renderer;
    const extract = renderer?.extract;
    if (!renderer || !extract) {
      this._lastUpdateStatus = 'skip:renderer-missing';
      this._clearChannel('world');
      this._clearChannel('ui');
      this._uiHasContent = false;
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

    const expensiveCaptureStrategy = captureStrategy !== 'replay-only';
    const liveThrottleMs = Math.max(
      this._captureThrottleMs,
      this._toNumber(window?.MapShine?.__pixiBridgeLiveThrottleMs, this._liveCaptureThrottleMs)
    );
    if (!forceTestPattern && !this._dirty && hasLivePreview && expensiveCaptureStrategy && (now - this._lastCaptureMs) < liveThrottleMs) {
      this._lastUpdateStatus = 'skip:live-throttled';
      if (perf) {
        perf.skipLiveThrottled += 1;
        perf.lastStatus = this._lastUpdateStatus;
      }
      return;
    }

    const useShapeReplay = (captureStrategy === 'replay-shape') || this._isShapeReplayDebugEnabled();
    const replayResult = useShapeReplay
      ? this._renderFoundryShapeReplay(drawingsLayer, renderer, worldCapture.width, worldCapture.height)
      : this._renderReplayCapture(drawingsLayer, worldCapture.width, worldCapture.height);

    const replayCount = Number(this._toNumber(replayResult?.count, 0));
    const replayEmptyWithDrawingsPresent = replayResult.ok && replayCount <= 0 && drawingsPresent;

    // Compute non-drawing UI content flags BEFORE the replay-only gate so we
    // can fall through to stage isolation when overlays are actively being
    // edited. IMPORTANT: passive scene presence (placeables existing but layer
    // not actively selected) should NOT force expensive stage isolation. Only
    // count a layer as needing isolation when it is actively being edited
    // (layer active + has interactive content/preview).
    const hasSoundsUiContent =
      (!!soundsLayer?.active && !!soundsLayer?.placeables?.length) ||
      this._hasActivePreview(soundsLayer);
    const hasNotesUiContent =
      !useNativePersistentPixiOverlays && (
      (!!notesLayer?.active && (!!notesLayer?.placeables?.length || !!notesLayer?.objects?.children?.length)) ||
      this._hasActivePreview(notesLayer)
      );
    const rawHasTemplatesUiContent =
      ((Number(canvas?.scene?.templates?.size) || 0) > 0) ||
      !!templatesLayer?.placeables?.length ||
      !!templatesLayer?.objects?.children?.length ||
      this._getTemplateLayerOverlayTargets(templatesLayer).length > 0 ||
      this._hasActivePreview(templatesLayer);
    const hasTemplateOverlayContent = (() => {
      const candidates = [];
      if (Array.isArray(templatesLayer?.placeables)) candidates.push(...templatesLayer.placeables);
      if (Array.isArray(templatesLayer?.objects?.children)) candidates.push(...templatesLayer.objects.children);
      if (Array.isArray(templatesLayer?.preview?.children)) candidates.push(...templatesLayer.preview.children);
      if (templatesLayer?._configPreview) candidates.push(templatesLayer._configPreview);
      candidates.push(...this._getTemplateLayerOverlayTargets(templatesLayer));
      for (const t of candidates) {
        if (!t) continue;
        if (t?.controlIcon || t?.ruler || t?.rulerText || t?.highlight || t?.frame || t?.tooltip || t?.field) return true;
        const ctor = String(t?.constructor?.name || '').toLowerCase();
        if (ctor.includes('controlicon') || ctor.includes('text') || ctor.includes('graphics') || ctor.includes('mesh')) return true;
      }
      return false;
    })();
    const templatesPreviewInteractive = this._isTemplatesPreviewInteractive(templatesLayer);
    const templatesEditorContext = templatesPreviewInteractive || this._isTemplatesContextActive();
    const threeTemplatesNative =
      window?.MapShine?.__useThreeTemplateOverlays !== false
      && !!window?.MapShine?.templateManager
      && !templatesEditorContext;
    const hasTemplatesUiContent = threeTemplatesNative ? false : rawHasTemplatesUiContent;
    // Doc replay is the stable baseline for settled template visibility and
    // avoids expensive extraction for non-interactive templates.
    // Allow an explicit runtime opt-out for diagnostics.
    const templateDocReplayEnabled =
      window?.MapShine?.__enableTemplateDocReplay !== false
      && !threeTemplatesNative;
    const canUseTemplateDocReplay =
      templateDocReplayEnabled
      && (captureStrategy === 'replay-only' || captureStrategy === 'replay-shape')
      && hasTemplatesUiContent
      && !templatesPreviewInteractive;
    let templateDocReplayResult = null;
    let templateDocReplayApplied = false;
    if (canUseTemplateDocReplay) {
      // Prefer native settled-template cache to preserve Foundry wall-clipped
      // highlight behavior after refresh. Fall back to doc replay if native
      // runtime objects are not yet available.
      templateDocReplayResult = this._renderFoundryTemplatesSettledCache(
        templatesLayer,
        renderer,
        worldCapture.width,
        worldCapture.height,
        { clear: !replayResult.ok }
      );
      if (!templateDocReplayResult?.ok && !String(templateDocReplayResult?.status || '').includes('runtime-not-ready')) {
        templateDocReplayResult = this._renderFoundryTemplatesDocReplay(
          templatesLayer,
          worldCapture.width,
          worldCapture.height,
          { clear: !replayResult.ok, previewOnly: false }
        );
      }
      templateDocReplayApplied = !!templateDocReplayResult?.ok;
    }
    // Scene templates exist but settled native/doc replay did not publish yet
    // (runtime-not-ready, empty extract, etc.). Must keep capturing until
    // success or skip:idle will freeze the world channel empty after reload.
    if (templateDocReplayApplied) {
      this._templateWorldPublishOk = true;
    } else if (threeTemplatesNative && templatesPresent) {
      // Native Three template overlay owns steady-state rendering.
      this._templateWorldPublishOk = true;
    } else if (
      templatesPresent
      && captureStrategy !== 'replay-only'
      && captureStrategy !== 'replay-shape'
    ) {
      // Non-replay capture path owns template pixels this frame; do not idle-block.
      this._templateWorldPublishOk = true;
    }

    const settledTemplatesStillPending =
      !!canUseTemplateDocReplay && !templateDocReplayApplied;
    const hasTemplatesUiContentForIsolation = hasTemplatesUiContent && !templateDocReplayApplied;
    // Only isolate templates for interactive editor overlays. Settled template
    // radius/area/highlight should come from doc replay in normal play.
    const templatesIsolationNeededForEditor = templatesEditorContext;
    const hasTemplatesNeedingIsolation =
      (hasTemplatesUiContentForIsolation && templatesIsolationNeededForEditor)
      || (templateDocReplayApplied && templatesIsolationNeededForEditor && hasTemplateOverlayContent);
    const hasRegionsUiContent =
      (!!regionsLayer?.active && (!!regionsLayer?.placeables?.length || !!regionsLayer?.objects?.children?.length)) ||
      this._hasActivePreview(regionsLayer) ||
      (!!regionsLayer?.active && this._getRegionLayerOverlayTargets(regionsLayer).length > 0);
    const hasLightingUiContent =
      (!!lightingLayer?.active && (!!lightingLayer?.placeables?.length || !!lightingLayer?.objects?.children?.length)) ||
      this._hasActivePreview(lightingLayer);
    const hasNonDrawingUiContent =
      hasSoundsUiContent || hasNotesUiContent || hasTemplatesNeedingIsolation || hasRegionsUiContent || hasLightingUiContent;
    const shouldCompositeReplayUnderStage =
      (captureStrategy === 'replay-only' || captureStrategy === 'replay-shape')
      && !!replayResult?.ok
      && hasNonDrawingUiContent;

    // Default runtime behavior: drawings-first replay only.
    // Fall through into stage isolation when:
    // (a) replay is empty but drawings are present (transient layer churn), OR
    // (b) non-drawing UI content exists (notes, templates, sounds, regions,
    //     lighting) — replay-only captures ONLY drawings, so the stage
    //     isolation path is required to composite everything together.
    if (captureStrategy === 'replay-only' || captureStrategy === 'replay-shape') {
      if (replayResult.ok) {
        if (replayEmptyWithDrawingsPresent) {
          // Replay returned empty during layer churn — fall through to stage isolation.
          this._lastUpdateStatus = `fallback:replay-empty strategy=${captureStrategy}`;
        } else if (hasNonDrawingUiContent) {
          // Non-drawing overlays present — replay captured drawings but we need
          // stage isolation to also capture notes/templates/sounds/regions/lighting.
          this._lastUpdateStatus = `fallback:non-drawing-content strategy=${captureStrategy}`;
        } else {
          // Pure drawings-only scene — replay is sufficient.
          this._lastUpdateStatus = `${replayResult.status} strategy=${captureStrategy}`;
          if (templateDocReplayApplied && templateDocReplayResult?.status) {
            this._lastUpdateStatus = `${replayResult.status} + ${templateDocReplayResult.status} strategy=${captureStrategy}`;
          }
          if (settledTemplatesStillPending) {
            this._dirty = true;
            this._postDirtyCapturesRemaining = Math.max(this._postDirtyCapturesRemaining, 2);
            this._lastUpdateStatus = `${this._lastUpdateStatus} + pending:settled-templates`;
          } else {
            this._dirty = false;
          }
          return;
        }
      }
      if (!replayResult.ok) {
        this._lastUpdateStatus = `skip:replay-failed strategy=${captureStrategy}`;
        this._clearChannel('world');
        this._clearChannel('ui');
        this._uiHasContent = false;
        this._dirty = false;
        return;
      }
    }

    if (captureStrategy === 'notes-extract') {
      if (replayResult.ok && !hasNotesUiContent) {
        this._lastUpdateStatus = `${replayResult.status} strategy=${captureStrategy}`;
        this._dirty = false;
        return;
      }
      this._lastUpdateStatus = `fallback:notes-stage-isolation strategy=${captureStrategy}`;
    }

    if (captureStrategy === 'sounds-extract') {
      if (replayResult.ok && !hasSoundsUiContent) {
        this._lastUpdateStatus = `${replayResult.status} strategy=${captureStrategy}`;
        this._dirty = false;
        return;
      }
      this._lastUpdateStatus = `fallback:sounds-stage-isolation strategy=${captureStrategy}`;
    }

    if (captureStrategy === 'templates-extract') {
      if (replayResult.ok && !hasTemplatesUiContent && !hasNotesUiContent) {
        this._lastUpdateStatus = `${replayResult.status} strategy=${captureStrategy}`;
        this._dirty = false;
        return;
      }
      this._lastUpdateStatus = `fallback:templates-stage-isolation strategy=${captureStrategy}`;
    }

    if (captureStrategy === 'regions-extract') {
      if (replayResult.ok && !hasRegionsUiContent) {
        this._lastUpdateStatus = `${replayResult.status} strategy=${captureStrategy}`;
        this._dirty = false;
        return;
      }
      this._lastUpdateStatus = `fallback:regions-stage-isolation strategy=${captureStrategy}`;
    }

    if (replayResult.ok && !hasNonDrawingUiContent && !replayEmptyWithDrawingsPresent) {
      if (settledTemplatesStillPending) {
        this._dirty = true;
        this._postDirtyCapturesRemaining = Math.max(this._postDirtyCapturesRemaining, 2);
        this._lastUpdateStatus = `${replayResult.status} + pending:settled-templates`;
        return;
      }
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
    const collectFromLayer = (layer, options = {}) => {
      const includeRootShapes = options?.includeRootShapes !== false;
      try {
        const collectObject = (p) => {
          if (!p) return;
          if (includeRootShapes) {
            uiShapes.add(p);
            if (p?.shape) uiShapes.add(p.shape);
            if (p?.field) uiShapes.add(p.field);
            if (p?.template) uiShapes.add(p.template);
          }
          // Notes/templates commonly expose the persistent map icon on `icon`
          // while `controlIcon` is edit-mode specific.
          if (p?.icon) uiShapes.add(p.icon);
          if (p?.controlIcon) uiShapes.add(p.controlIcon);
          if (p?.tooltip) uiShapes.add(p.tooltip);
          if (p?.highlight) uiShapes.add(p.highlight);
          if (p?.frame) uiShapes.add(p.frame);
          if (p?.ruler) uiShapes.add(p.ruler);
          if (p?.rulerText) uiShapes.add(p.rulerText);
        };

        const placeables = Array.isArray(layer?.placeables) ? layer.placeables : [];
        for (const p of placeables) {
          collectObject(p);
        }

        // Important: some Foundry layers (including templates outside active edit
        // context) keep rendered objects in `objects.children` rather than
        // `placeables`. Include both so overlays persist across tool swaps.
        const objectChildren = Array.isArray(layer?.objects?.children) ? layer.objects.children : [];
        for (const p of objectChildren) {
          collectObject(p);
        }

        const previewChildren = Array.isArray(layer?.preview?.children) ? layer.preview.children : [];
        for (const p of previewChildren) {
          collectObject(p);
        }

        if (layer?._configPreview) collectObject(layer._configPreview);
      } catch (_) {}
    };

    if (captureStrategy === 'sounds-extract') {
      collectFromLayer(drawingsLayer);
      collectFromLayer(soundsLayer);
    } else if (captureStrategy === 'regions-extract') {
      collectFromLayer(drawingsLayer);
      collectFromLayer(regionsLayer);
    } else if (captureStrategy === 'templates-extract') {
      collectFromLayer(drawingsLayer);
      collectFromLayer(templatesLayer);
      collectFromLayer(notesLayer);
    } else if (captureStrategy === 'notes-extract') {
      collectFromLayer(notesLayer);
    } else {
      // When replay capture already produced drawing base pixels and we're
      // compositing non-drawing overlays via stage isolation, avoid collecting
      // drawings here to prevent duplicate/misaligned redraw jitter.
      if (!shouldCompositeReplayUnderStage) {
        collectFromLayer(drawingsLayer);
      }
      collectFromLayer(lightingLayer);
      collectFromLayer(soundsLayer);
      // When doc replay is active, capture template overlay adornments only to
      // avoid double-rendering shape fills/strokes. Otherwise capture full
      // native template placeables (including icon/text descendants).
      collectFromLayer(templatesLayer, { includeRootShapes: !templateDocReplayApplied });
      for (const target of this._getTemplateLayerOverlayTargets(templatesLayer)) {
        if (target) uiShapes.add(target);
      }
      if (!useNativePersistentPixiOverlays) collectFromLayer(notesLayer);
      collectFromLayer(regionsLayer);
    }

    if (uiShapes.size === 0) {
      if (captureStrategy === 'notes-extract' && hasNotesUiContent) {
        // Preserve previously captured frame and retry soon. This avoids a
        // visible notes flicker/disappear when Foundry momentarily reports no
        // extractable note display objects during strategy transitions.
        this._lastUpdateStatus = 'retry:notes-ui-shapes-empty';
        this._dirty = true;
        this._postDirtyCapturesRemaining = Math.max(this._postDirtyCapturesRemaining, 2);
        return;
      }
      if (drawingsPresent) {
        // Foundry can briefly report empty drawings placeables right after
        // layer/tool transitions while scene drawing docs still exist.
        // Preserve the prior bridge texture and retry shortly rather than
        // clearing the channel and making drawings disappear.
        this._lastUpdateStatus = 'retry:drawings-ui-shapes-empty';
        this._dirty = true;
        this._postDirtyCapturesRemaining = Math.max(this._postDirtyCapturesRemaining, 2);
        return;
      }
      if (hasNonDrawingUiContent) {
        // Non-drawing content exists but placeables weren't extractable this
        // frame (layer churn / async draw). Preserve the last valid bridge
        // texture and retry shortly instead of publishing a blank overlay.
        this._lastUpdateStatus = 'retry:non-drawing-ui-shapes-empty';
        this._dirty = true;
        this._postDirtyCapturesRemaining = Math.max(this._postDirtyCapturesRemaining, 2);
        return;
      }
      this._lastUpdateStatus = 'skip:no-ui-shapes';
      this._clearChannel('world');
      this._clearChannel('ui');
      this._uiHasContent = false;
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
        tempRT = this._ensureScratchRenderTexture(uiRtW, uiRtH);
        if (!tempRT) throw new Error('scratch-rt-unavailable');
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
        // Fast path: direct GPU handle injection into the Three texture.
        // We cannot use this when replay pixels must be preserved under the
        // extracted overlay because GPU-direct replaces the whole texture.
        const canInjectGpuDirect = !shouldCompositeReplayUnderStage;
        if (canInjectGpuDirect && this._injectPixiRTToWorldTexture(tempRT, uiRtW, uiRtH)) {
          if (window?.MapShine) window.MapShine.__pixiBridgeGpuDirectActive = true;
          this._uiHasContent = false;
          this._dirty = false;
          this._lastUpdateStatus = `captured:gpu-direct:${uiRtW}x${uiRtH} strategy=${captureStrategy}`;
          return;
        }

        if (window?.MapShine) window.MapShine.__pixiBridgeGpuDirectActive = false;

        // Fallback path (legacy): GPU->CPU readback extraction.
        capturedCanvas = extract.canvas(tempRT, frame);
      } finally {
      }
    } catch (err) {
      log.warn('Drawings capture failed', err);
      this._lastUpdateStatus = 'skip:capture-threw';
      this._dirty = false;
      this._clearChannel('world');
      this._clearChannel('ui');
      this._uiHasContent = false;
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
            tempRT = this._ensureScratchRenderTexture(uiRtW, uiRtH);
            if (!tempRT) throw new Error('scratch-rt-unavailable');
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
      this._uiHasContent = false;
      this._dirty = false;
      return;
    }

    const w = Math.max(1, capturedCanvas.width);
    const h = Math.max(1, capturedCanvas.height);

    const hadFallbackStatus =
      typeof this._lastUpdateStatus === 'string' &&
      (this._lastUpdateStatus.startsWith('captured-fallback:') || this._lastUpdateStatus.startsWith('captured-view-fallback:'));

    const shouldPreserveReplayBase = shouldCompositeReplayUnderStage;
    if (!shouldPreserveReplayBase && (this._worldCanvas.width !== w || this._worldCanvas.height !== h)) {
      this._worldCanvas.width = w;
      this._worldCanvas.height = h;
      this._recreateTexture('world');
      worldTexture = this._ensureChannelTexture('world');
    }

    const worldCtx = this._worldCanvas.getContext('2d');
    if (!worldCtx) return;
    const targetW = this._worldCanvas.width;
    const targetH = this._worldCanvas.height;
    if (!shouldPreserveReplayBase) {
      worldCtx.clearRect(0, 0, targetW, targetH);
    }
    // When replay-only falls through for non-drawing overlays, keep replayed
    // drawings as the base and composite extracted stage overlays on top.
    worldCtx.drawImage(capturedCanvas, 0, 0, targetW, targetH);
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

    // UI channel remains empty by default until dedicated UI ingestion ships.
    this._uiHasContent = false;

    this._dirty = false;
    if (!hadFallbackStatus) {
      const captureMode = shouldPreserveReplayBase ? 'captured:overlay-on-replay' : 'captured';
      this._lastUpdateStatus = `${captureMode}:${targetW}x${targetH} shapes=${uiShapes.size} probe#${this._probeLogCount}`;
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

    this._destroyScratchRenderTexture();
    this._invalidateTemplatesSettledCache();

    try { this._worldTexture?.dispose?.(); } catch (_) {}
    try { this._uiTexture?.dispose?.(); } catch (_) {}

    this._worldTexture = null;
    this._uiTexture = null;
    this._worldCanvas = null;
    this._uiCanvas = null;
  }
}
