/**
 * @fileoverview Camera Follower
 * 
 * Simple one-way camera sync: Three.js follows PIXI.
 * 
 * Instead of trying to bidirectionally sync two camera systems (which causes
 * race conditions and drift), we let Foundry's PIXI canvas be the single source
 * of truth for camera state. The Three.js camera simply reads from PIXI each
 * frame and matches it.
 * 
 * This eliminates:
 * - Input handlers on Three.js canvas (let PIXI handle all pan/zoom input)
 * - Bidirectional sync logic
 * - Drift detection and correction
 * - Race conditions between systems
 * 
 * @module foundry/camera-follower
 */

import { createLogger } from '../core/log.js';
import { readSceneLevelsFlag } from './levels-scene-flags.js';

const log = createLogger('CameraFollower');

function isEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], .tox, .editor')) {
    return true;
  }
  return false;
}

/**
 * Simple camera follower - Three.js follows PIXI
 */
export class CameraFollower {
  /**
   * @param {object} options
   * @param {import('../scene/composer.js').SceneComposer} options.sceneComposer
   */
  constructor(options = {}) {
    /** @type {import('../scene/composer.js').SceneComposer|null} */
    this.sceneComposer = options.sceneComposer || null;
    
    /** @type {boolean} */
    this.enabled = true;
    
    /** @type {boolean} */
    this._initialized = false;

    /** @type {Array<{levelId:string,label:string,bottom:number,top:number,center:number,source:'sceneLevels'|'inferred'}>} */
    this._levels = [];

    /** @type {number} */
    this._activeLevelIndex = -1;

    /** @type {{levelId:string,label:string,bottom:number,top:number,center:number,source:'sceneLevels'|'inferred',lockMode:'manual'|'follow-controlled-token',transitionMs:number,index:number,count:number}|null} */
    this._activeLevelContext = null;

    /** @type {'manual'|'follow-controlled-token'} */
    this._lockMode = 'manual';

    /** @type {boolean} */
    this._keyboardShortcutsEnabled = true;

    /** @type {{source:'sceneLevels'|'inferred', rawCount:number, parsedCount:number, invalidCount:number, swappedCount:number, inferredCenterCount?:number}|null} */
    this._lastLevelBuildDiagnostics = null;

    /** @type {Array<{name:string,id:number}>} */
    this._hookIds = [];

    this._onKeyDown = this._onKeyDown.bind(this);
    
    // Cache last known state to avoid unnecessary updates
    this._lastX = 0;
    this._lastY = 0;
    this._lastZoom = 1;
  }
  
  /**
   * Initialize the camera follower
   * @returns {boolean} Success
   */
  initialize() {
    if (!this.sceneComposer?.camera) {
      log.error('Cannot initialize: SceneComposer or camera not available');
      return false;
    }
    
    // Force initial sync (bypass threshold check)
    this.forceSync();

    // Build initial level context from scene flags/imported data.
    this.refreshLevelBands({ emit: false, reason: 'initialize' });
    this._registerHooks();
    this._attachDomListeners();
    this._emitLevelContextChanged('initialize');
    
    this._initialized = true;
    log.info('Camera follower initialized - Three.js will follow PIXI');
    
    return true;
  }
  
  /**
   * Per-frame update - read PIXI state and apply to Three.js
   * Called from render loop via effectComposer.addUpdatable()
   */
  update() {
    if (!this.enabled || !this._initialized) return;
    if (!canvas?.ready || !canvas?.stage) return;
    
    this._syncFromPixi();

    if (this._shouldAutoFollowControlledToken()) {
      this._syncToControlledTokenLevel({ emit: false, reason: 'follow-update' });
    }
  }

  _shouldAutoFollowControlledToken() {
    return this._lockMode === 'follow-controlled-token';
  }

  _shouldAutoSyncControlledTokenEvents() {
    if (this._lockMode === 'follow-controlled-token') return true;
    // Player UX: when a player controls a token, keep level context synced to
    // that token's elevation when control/elevation events fire.
    // Do NOT force per-frame sync in manual mode, or compact overlay +/- and
    // dropdown selections get immediately overwritten.
    if (game?.user?.isGM === true) return false;
    const controlled = canvas?.tokens?.controlled || [];
    return controlled.length > 0;
  }

  _registerHooks() {
    const updateSceneId = Hooks.on('updateScene', (scene, changes) => {
      if (!scene || scene.id !== canvas.scene?.id) return;
      const levelFlagsChanged = changes?.flags?.levels !== undefined;
      const dimensionsChanged = ('grid' in (changes || {})) || ('width' in (changes || {})) || ('height' in (changes || {}));
      if (!levelFlagsChanged && !dimensionsChanged) return;
      this.refreshLevelBands({ emit: true, reason: 'scene-update' });
    });
    this._hookIds.push({ name: 'updateScene', id: updateSceneId });

    // Selecting a token is an explicit user action — always switch to that
    // token's level regardless of lock mode or GM status. This gives
    // immediate floor-navigation feedback when clicking a token.
    const controlTokenId = Hooks.on('controlToken', (_token, controlled) => {
      if (!controlled) return;
      this._syncToControlledTokenLevel({ emit: true, reason: 'control-token' });
    });
    this._hookIds.push({ name: 'controlToken', id: controlTokenId });

    // When a controlled token's elevation changes, ALWAYS switch the active
    // level to the band containing the new elevation — regardless of lock mode
    // or GM status. This is distinct from the controlToken hook (which respects
    // manual mode) because an elevation change is an explicit signal that the
    // view should follow the token to its new floor.
    const updateTokenId = Hooks.on('updateToken', (tokenDoc, changes) => {
      if (!('elevation' in (changes || {}))) return;
      const controlled = canvas?.tokens?.controlled || [];
      if (!controlled.some((t) => t?.document?.id === tokenDoc?.id)) return;
      this._syncToControlledTokenLevel({ emit: true, reason: 'token-elevation-update' });
    });
    this._hookIds.push({ name: 'updateToken', id: updateTokenId });
  }

  _unregisterHooks() {
    for (const { name, id } of this._hookIds) {
      try {
        Hooks.off(name, id);
      } catch (_) {
      }
    }
    this._hookIds = [];
  }

  _attachDomListeners() {
    window.addEventListener('keydown', this._onKeyDown, true);
  }

  _detachDomListeners() {
    window.removeEventListener('keydown', this._onKeyDown, true);
  }

  _onKeyDown(event) {
    if (!this.enabled || !this._initialized || !this._keyboardShortcutsEnabled) return;
    // Foundry keybindings (registered at init) are the primary level-step path.
    // Keep this listener as a legacy fallback only for environments without the
    // keybindings API.
    if (game?.keybindings?.register) return;
    if (event.defaultPrevented) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isEditableTarget(event.target)) return;

    if (event.key === '[' || event.key === ']') {
      const delta = event.key === ']' ? 1 : -1;
      if (this._lockMode === 'follow-controlled-token') {
        this.setLockMode('manual', { emit: false, reason: 'shortcut-step' });
      }
      this.stepLevel(delta, { reason: 'shortcut' });
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    }
  }

  /**
   * Re-read level bands from scene flags and preserve the closest active band.
   * @param {{emit?: boolean, reason?: string}} [options]
   */
  refreshLevelBands(options = {}) {
    const { emit = true, reason = 'refresh-level-bands' } = options;
    const nextLevels = this._buildLevelBands();
    if (!nextLevels.length) return;

    let nextIndex = 0;

    if (this._lockMode === 'follow-controlled-token') {
      const tokenElevation = this._getControlledTokenElevation();
      if (Number.isFinite(tokenElevation)) {
        nextIndex = this._findBestLevelIndexForElevation(tokenElevation, nextLevels);
      }
    } else if (this._activeLevelContext && Number.isFinite(this._activeLevelContext.center)) {
      nextIndex = this._findNearestLevelIndexByCenter(this._activeLevelContext.center, nextLevels);
    }

    this._levels = nextLevels;
    this._setActiveLevelByIndex(nextIndex, { emit, reason });
  }

  /**
   * @returns {Array<{levelId:string,label:string,bottom:number,top:number,center:number,source:'sceneLevels'|'inferred'}>}
   */
  _buildLevelBands() {
    const scene = canvas?.scene;
    const rawLevels = readSceneLevelsFlag(scene);
    const parsed = [];
    const diagnostics = {
      source: 'sceneLevels',
      rawCount: Array.isArray(rawLevels) ? rawLevels.length : 0,
      parsedCount: 0,
      invalidCount: 0,
      swappedCount: 0,
    };

    if (Array.isArray(rawLevels)) {
      for (let i = 0; i < rawLevels.length; i += 1) {
        const item = rawLevels[i];
        let bottomRaw;
        let topRaw;
        let labelRaw;

        if (Array.isArray(item)) {
          bottomRaw = item[0];
          topRaw = item[1];
          labelRaw = item[2];
        } else if (item && typeof item === 'object') {
          bottomRaw = item.bottom ?? item.rangeBottom ?? item.min;
          topRaw = item.top ?? item.rangeTop ?? item.max;
          labelRaw = item.name ?? item.label;
        }

        let bottom = Number(bottomRaw);
        let top = Number(topRaw);
        if (!Number.isFinite(bottom) || !Number.isFinite(top)) {
          diagnostics.invalidCount += 1;
          continue;
        }
        if (bottom > top) {
          const t = bottom;
          bottom = top;
          top = t;
          diagnostics.swappedCount += 1;
        }

        parsed.push({
          levelId: `scene-${i}`,
          label: String(labelRaw ?? `Level ${i + 1}`),
          bottom,
          top,
          center: (bottom + top) * 0.5,
          source: 'sceneLevels'
        });
      }
    }

    diagnostics.parsedCount = parsed.length;

    parsed.sort((a, b) => {
      if (a.bottom !== b.bottom) return a.bottom - b.bottom;
      return a.top - b.top;
    });

    if (parsed.length) {
      this._lastLevelBuildDiagnostics = diagnostics;
      return parsed.map((entry, idx) => ({
        ...entry,
        levelId: entry.levelId || `scene-${idx}`,
      }));
    }

    const inferredLevels = this._buildInferredLevelBands(scene);
    this._lastLevelBuildDiagnostics = {
      source: 'inferred',
      rawCount: diagnostics.rawCount,
      parsedCount: inferredLevels.length,
      invalidCount: diagnostics.invalidCount,
      swappedCount: diagnostics.swappedCount,
      inferredCenterCount: inferredLevels.length,
    };
    return inferredLevels;
  }

  /**
   * Build inferred level bands from scene content when explicit sceneLevels are missing.
   * @private
   * @param {Scene|undefined|null} scene
   * @returns {Array<{levelId:string,label:string,bottom:number,top:number,center:number,source:'inferred'}>}
   */
  _buildInferredLevelBands(scene) {
    const elevations = [];
    const pushElevation = (value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return;
      elevations.push(n);
    };

    const pushFromPlaceables = (collection) => {
      const placeables = Array.isArray(collection?.placeables) ? collection.placeables : [];
      for (const placeable of placeables) {
        const doc = placeable?.document;
        if (!doc) continue;
        pushElevation(doc.elevation);
        pushElevation(doc.flags?.levels?.rangeBottom);
        pushElevation(doc.flags?.levels?.rangeTop);
      }
    };

    // Scene defaults and known floor markers.
    pushElevation(scene?.flags?.levels?.backgroundElevation);
    pushElevation(scene?.foregroundElevation);

    // Infer from major placeable layers and relevant range flags.
    pushFromPlaceables(canvas?.tiles);
    pushFromPlaceables(canvas?.tokens);
    pushFromPlaceables(canvas?.drawings);
    pushFromPlaceables(canvas?.templates);
    pushFromPlaceables(canvas?.lighting);
    pushFromPlaceables(canvas?.sounds);
    pushFromPlaceables(canvas?.notes);

    // Wall-height contributes to vertical segmentation in many Levels worlds.
    const walls = Array.isArray(canvas?.walls?.placeables) ? canvas.walls.placeables : [];
    for (const wall of walls) {
      const doc = wall?.document;
      if (!doc) continue;
      pushElevation(doc.flags?.['wall-height']?.bottom);
      pushElevation(doc.flags?.['wall-height']?.top);
    }

    // De-duplicate using a small epsilon to avoid near-identical bands.
    const sorted = elevations
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);

    const centers = [];
    const EPS = 0.01;
    for (const value of sorted) {
      if (!centers.length || Math.abs(value - centers[centers.length - 1]) > EPS) {
        centers.push(value);
      }
    }

    if (!centers.length) {
      const fallback = Number(scene?.flags?.levels?.backgroundElevation ?? 0);
      const center = Number.isFinite(fallback) ? fallback : 0;
      return [{
        levelId: 'inferred-ground',
        label: 'Ground',
        bottom: center,
        top: center,
        center,
        source: 'inferred'
      }];
    }

    if (centers.length === 1) {
      const center = centers[0];
      return [{
        levelId: 'inferred-0',
        label: `Inferred 1 (${center.toFixed(1)})`,
        bottom: center,
        top: center,
        center,
        source: 'inferred'
      }];
    }

    const levels = [];
    for (let i = 0; i < centers.length; i += 1) {
      const center = centers[i];
      const prev = centers[i - 1];
      const next = centers[i + 1];

      let bottom;
      let top;
      if (i === 0) {
        const span = Math.max(1, (next - center) * 0.5);
        bottom = center - span;
      } else {
        bottom = (prev + center) * 0.5;
      }

      if (i === centers.length - 1) {
        const span = Math.max(1, (center - prev) * 0.5);
        top = center + span;
      } else {
        top = (center + next) * 0.5;
      }

      levels.push({
        levelId: `inferred-${i}`,
        label: `Inferred ${i + 1} (${center.toFixed(1)})`,
        bottom,
        top,
        center,
        source: 'inferred'
      });
    }

    return levels;
  }

  _findNearestLevelIndexByCenter(center, levels = this._levels) {
    let bestIndex = 0;
    let bestDelta = Infinity;
    for (let i = 0; i < levels.length; i += 1) {
      const delta = Math.abs((levels[i]?.center ?? 0) - center);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  _findBestLevelIndexForElevation(elevation, levels = this._levels) {
    const containing = [];
    for (let i = 0; i < levels.length; i += 1) {
      const level = levels[i];
      if (elevation >= level.bottom && elevation <= level.top) {
        containing.push({ i, span: Math.abs(level.top - level.bottom) });
      }
    }

    if (containing.length) {
      // Sort by smallest span first (tightest-fitting level wins).
      containing.sort((a, b) => a.span - b.span);

      // Shared-boundary tiebreaker: when multiple levels have the same span
      // and contain the elevation, prefer the level whose bottom matches the
      // elevation. Stairs send tokens to to.bottom, so picking the level that
      // starts at that elevation correctly selects the upper floor.
      // Example: Ground=[0,10], First=[10,20], elevation=10 → pick First.
      if (containing.length > 1 && containing[0].span === containing[1].span) {
        const atBottom = containing.find(
          (c) => levels[c.i].bottom === elevation
        );
        if (atBottom) return atBottom.i;
      }

      return containing[0].i;
    }

    return this._findNearestLevelIndexByCenter(elevation, levels);
  }

  _setActiveLevelByIndex(index, options = {}) {
    const { emit = true, reason = 'set-active-level' } = options;
    if (!this._levels.length) return null;

    const clamped = Math.max(0, Math.min(this._levels.length - 1, Number(index) || 0));
    const level = this._levels[clamped];
    if (!level) return null;

    const previous = this._activeLevelContext;
    this._activeLevelIndex = clamped;
    this._activeLevelContext = {
      levelId: level.levelId,
      label: level.label,
      bottom: level.bottom,
      top: level.top,
      center: level.center,
      source: level.source,
      lockMode: this._lockMode,
      transitionMs: 180,
      index: clamped,
      count: this._levels.length,
    };

    if (!emit) return this._activeLevelContext;

    const changed =
      !previous ||
      previous.levelId !== this._activeLevelContext.levelId ||
      previous.lockMode !== this._activeLevelContext.lockMode ||
      previous.center !== this._activeLevelContext.center;
    if (changed) {
      this._emitLevelContextChanged(reason);
    }

    return this._activeLevelContext;
  }

  stepLevel(delta = 1, options = {}) {
    if (!Number.isFinite(delta) || delta === 0) return this.getActiveLevelContext();

    if (this._lockMode === 'follow-controlled-token' && options.keepLockMode !== true) {
      this.setLockMode('manual', { emit: false, reason: 'manual-step' });
    }

    const step = delta > 0 ? 1 : -1;
    const current = Number.isFinite(this._activeLevelIndex) ? this._activeLevelIndex : 0;
    return this._setActiveLevelByIndex(current + step, {
      emit: options.emit !== false,
      reason: options.reason || 'step-level'
    });
  }

  setActiveLevel(levelRef, options = {}) {
    let index = 0;
    if (typeof levelRef === 'number') {
      index = levelRef;
    } else if (typeof levelRef === 'string') {
      const found = this._levels.findIndex((lvl) => lvl.levelId === levelRef || lvl.label === levelRef);
      if (found >= 0) index = found;
    }

    if (this._lockMode === 'follow-controlled-token' && options.keepLockMode !== true) {
      this.setLockMode('manual', { emit: false, reason: 'manual-select-level' });
    }

    return this._setActiveLevelByIndex(index, {
      emit: options.emit !== false,
      reason: options.reason || 'set-active-level'
    });
  }

  setLockMode(mode, options = {}) {
    const normalized = mode === 'follow-controlled-token' ? 'follow-controlled-token' : 'manual';
    const previous = this._lockMode;
    this._lockMode = normalized;

    if (normalized === 'follow-controlled-token') {
      this._syncToControlledTokenLevel({ emit: false, reason: options.reason || 'set-lock-mode' });
    }

    if (previous !== normalized) {
      this._setActiveLevelByIndex(this._activeLevelIndex >= 0 ? this._activeLevelIndex : 0, {
        emit: options.emit !== false,
        reason: options.reason || 'set-lock-mode'
      });
    }

    return this._lockMode;
  }

  getLockMode() {
    return this._lockMode;
  }

  getAvailableLevels() {
    return this._levels.map((lvl) => ({ ...lvl }));
  }

  getActiveLevelContext() {
    return this._activeLevelContext ? { ...this._activeLevelContext } : null;
  }

  getLevelDiagnostics() {
    const d = this._lastLevelBuildDiagnostics;
    if (!d) {
      return {
        source: 'inferred',
        rawCount: 0,
        parsedCount: this._levels.length,
        invalidCount: 0,
        swappedCount: 0,
        inferredCenterCount: this._levels.length,
      };
    }
    return { ...d };
  }

  _getControlledTokenElevation() {
    const controlled = canvas?.tokens?.controlled || [];
    const token = controlled[0] || null;
    if (!token) return null;
    const elev = Number(token.document?.elevation ?? token.losHeight ?? token.document?.losHeight);
    return Number.isFinite(elev) ? elev : null;
  }

  _syncToControlledTokenLevel(options = {}) {
    const tokenElevation = this._getControlledTokenElevation();
    if (!Number.isFinite(tokenElevation)) return false;
    const nextIndex = this._findBestLevelIndexForElevation(tokenElevation);
    this._setActiveLevelByIndex(nextIndex, {
      emit: options.emit !== false,
      reason: options.reason || 'follow-controlled-token'
    });
    return true;
  }

  _emitLevelContextChanged(reason = 'unknown') {
    const payload = {
      context: this.getActiveLevelContext(),
      levels: this.getAvailableLevels(),
      diagnostics: this.getLevelDiagnostics(),
      reason,
      lockMode: this._lockMode,
    };

    // IMPORTANT: Update globals BEFORE firing the hook so that all hook
    // listeners (tile manager, lighting, fog, etc.) read the new context
    // immediately. Previously these were set AFTER the hook, causing every
    // system to read stale data — which is why the dropdown required two
    // changes before the map visually updated.
    if (window.MapShine) {
      window.MapShine.activeLevelContext = payload.context;
      window.MapShine.availableLevels = payload.levels;
      window.MapShine.levelNavigationDiagnostics = payload.diagnostics;
    }

    try {
      Hooks.callAll('mapShineLevelContextChanged', payload);
    } catch (_) {
    }

    // Major scene-appearance transition (floor/level switch): force a full
    // visual resync pass so cached masks/depth/occluders do not lag behind
    // tile visibility and layering updates.
    try {
      const ms = window.MapShine;
      ms?.depthPassManager?.invalidate?.();
      ms?.renderLoop?.requestRender?.();
      // Short burst ensures multi-pass targets (roof alpha, fog, distortion,
      // water occluder composites) settle coherently after a drastic switch.
      ms?.renderLoop?.requestContinuousRender?.(220);
    } catch (_) {
    }

    log.debug('Level context changed', payload);
  }
  
  /**
   * Read PIXI camera state and apply to Three.js
   * @private
   */
  _syncFromPixi() {
    const stage = canvas?.stage;
    if (!stage) return;
    
    const camera = this.sceneComposer?.camera;
    if (!camera) return;
    
    // Read PIXI state
    const pixiX = stage.pivot.x;
    const pixiY = stage.pivot.y;
    const pixiZoom = stage.scale.x || 1;
    
    // Check if anything changed (avoid unnecessary updates)
    const dx = Math.abs(pixiX - this._lastX);
    const dy = Math.abs(pixiY - this._lastY);
    const dz = Math.abs(pixiZoom - this._lastZoom);
    
    if (dx < 0.1 && dy < 0.1 && dz < 0.0001) {
      return; // No significant change
    }
    
    // Update cache
    this._lastX = pixiX;
    this._lastY = pixiY;
    this._lastZoom = pixiZoom;
    
    // Get world height for Y coordinate conversion
    const worldHeight = this.sceneComposer?.foundrySceneData?.height ||
                        canvas?.dimensions?.height ||
                        1000;
    
    // Apply to Three.js camera
    // Foundry: Y-down, pivot is center of view
    // Three.js: Y-up, position is center of view
    camera.position.x = pixiX;
    camera.position.y = worldHeight - pixiY;
    // Z position stays fixed for FOV-based zoom
    
    // FOV-based zoom: adjust FOV instead of camera Z position
    // This keeps the ground plane at a constant depth in the frustum
    if (camera.isPerspectiveCamera && this.sceneComposer.baseFovTanHalf !== undefined) {
      const baseTan = this.sceneComposer.baseFovTanHalf;
      const zoom = pixiZoom || 1;
      const fovRad = 2 * Math.atan(baseTan / zoom);
      const fovDeg = fovRad * (180 / Math.PI);
      const clamped = Math.max(1, Math.min(170, fovDeg));
      camera.fov = clamped;
      this.sceneComposer.currentZoom = zoom;
      camera.updateProjectionMatrix();
    } else if (camera.isOrthographicCamera) {
      camera.zoom = pixiZoom;
      camera.updateProjectionMatrix();
    }
  }
  
  /**
   * Force an immediate sync (useful after scene changes)
   */
  forceSync() {
    // Reset cache to force sync on next call
    this._lastX = -999999;
    this._lastY = -999999;
    this._lastZoom = -999999;
    
    // Immediately sync
    this._syncFromPixi();
    
    // Log the sync for debugging
    const stage = canvas?.stage;
    const camera = this.sceneComposer?.camera;
    const worldHeight = this.sceneComposer?.foundrySceneData?.height || 0;
    if (stage && camera) {
      log.info(`Force sync: PIXI pivot=(${stage.pivot.x.toFixed(1)}, ${stage.pivot.y.toFixed(1)}), zoom=${stage.scale.x.toFixed(3)}`);
      log.info(`Force sync: Three pos=(${camera.position.x.toFixed(1)}, ${camera.position.y.toFixed(1)}, ${camera.position.z.toFixed(1)}), FOV=${camera.fov?.toFixed(2) || 'N/A'}°`);
      log.info(`Force sync: worldHeight=${worldHeight}, baseFov=${this.sceneComposer?.baseFov?.toFixed(2) || 'N/A'}°, currentZoom=${this.sceneComposer?.currentZoom?.toFixed(3) || 'N/A'}`);
    }
  }
  
  /**
   * Enable the follower
   */
  enable() {
    this.enabled = true;
    this.forceSync();
    log.debug('Camera follower enabled');
  }
  
  /**
   * Disable the follower
   */
  disable() {
    this.enabled = false;
    log.debug('Camera follower disabled');
  }
  
  /**
   * Clean up resources
   */
  dispose() {
    this.enabled = false;
    this._initialized = false;
    this._unregisterHooks();
    this._detachDomListeners();
    log.info('Camera follower disposed');
  }
  
  /**
   * Get current state for debugging
   * @returns {object}
   */
  getState() {
    return {
      enabled: this.enabled,
      initialized: this._initialized,
      lastX: this._lastX,
      lastY: this._lastY,
      lastZoom: this._lastZoom,
      activeLevelContext: this.getActiveLevelContext(),
      lockMode: this._lockMode,
      levelCount: this._levels.length,
    };
  }
}
