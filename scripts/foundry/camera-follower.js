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
import { isGmLike } from '../core/gm-parity.js';


import { createLogger } from '../core/log.js';
import { moveTrace } from '../core/movement-trace-log.js';
import {
  readV14SceneLevels,
  hasV14NativeLevels,
  getViewedV14Level,
} from './levels-scene-flags.js';
import { elevationInBand } from '../ui/levels-editor/level-boundaries.js';

const log = createLogger('CameraFollower');
const FLOOR_FOLLOW_SUPPRESSION_DEFAULT_MS = 800;

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

    /** @type {Array<{levelId:string,label:string,bottom:number,top:number,center:number,source:'sceneLevels'|'inferred'|'sceneImage'}>} */
    this._levels = [];

    /** @type {number} */
    this._activeLevelIndex = -1;

    /** @type {{levelId:string,label:string,bottom:number,top:number,center:number,source:'sceneLevels'|'inferred'|'sceneImage',lockMode:'manual'|'follow-controlled-token',transitionMs:number,index:number,count:number}|null} */
    this._activeLevelContext = null;

    /** @type {'manual'|'follow-controlled-token'} */
    this._lockMode = 'manual';

    /** @type {boolean} */
    this._keyboardShortcutsEnabled = true;

    /** @type {{source:'sceneLevels'|'inferred', rawCount:number, parsedCount:number, invalidCount:number, swappedCount:number, inferredCenterCount?:number, sceneImageBands?:number}|null} */
    this._lastLevelBuildDiagnostics = null;

    /** @type {Array<{name:string,id:number}>} */
    this._hookIds = [];

    /** @type {Map<string, {until:number, reason:string}>} */
    this._floorFollowSuppressionByTokenId = new Map();

    this._onKeyDown = this._onKeyDown.bind(this);
    
    // Cache last known state to avoid unnecessary updates
    this._lastX = 0;
    this._lastY = 0;
    this._lastZoom = 1;

    // Floor-follow throttling
    this._lastFloorFollowCheckMs = 0;
    this._floorFollowCheckIntervalMs = 100;
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
    // Initial canvas boot can occur before Scene._view is finalized, but Foundry
    // already exposes the target level via canvas._viewOptions.level/canvas.level.
    // Sync now so first paint uses the same viewed level that manual up/down selects.
    this._syncToViewedLevel({ emit: false, reason: 'initialize-sync-viewed-level' });
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

    if (this._shouldAutoFollowControlledToken() && !this._isControlledTokenFloorFollowSuppressed()) {
      const now = performance.now();
      if (now - this._lastFloorFollowCheckMs >= this._floorFollowCheckIntervalMs) {
        this._lastFloorFollowCheckMs = now;
        this._syncToControlledTokenLevel({ emit: false, reason: 'follow-update' });
      }
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
    if (isGmLike()) return false;
    const controlled = canvas?.tokens?.controlled || [];
    return controlled.length > 0;
  }

  _registerHooks() {
    // V14: scene.levels embedded collection changes (add/remove/update levels)
    // and dimension changes should rebuild our band list.
    const updateSceneId = Hooks.on('updateScene', (scene, changes) => {
      if (!scene || scene.id !== canvas.scene?.id) return;
      const levelsChanged = changes?.levels !== undefined;
      const dimensionsChanged = ('grid' in (changes || {})) || ('width' in (changes || {})) || ('height' in (changes || {}));
      if (!levelsChanged && !dimensionsChanged) return;
      this.refreshLevelBands({ emit: true, reason: 'scene-update' });
    });
    this._hookIds.push({ name: 'updateScene', id: updateSceneId });

    // V14: when Foundry redraws the canvas (including same-scene level
    // switches via scene.view({ level })), sync our active level context
    // to whichever level Foundry is now viewing.
    const canvasReadyId = Hooks.on('canvasReady', () => {
      this._syncToViewedLevel({ emit: true, reason: 'canvas-ready' });
      // Scene transitions can keep the same level-id/index values; force a
      // resync broadcast so render caches are invalidated even when context
      // appears "unchanged" by value comparison.
      this._emitLevelContextChanged('canvas-ready-force-resync');
    });
    this._hookIds.push({ name: 'canvasReady', id: canvasReadyId });

    // V14: when edges are re-initialized (level add/remove), rebuild.
    const initEdgesId = Hooks.on('initializeEdges', (scene) => {
      if (!scene || scene.id !== canvas.scene?.id) return;
      this.refreshLevelBands({ emit: true, reason: 'edges-initialized' });
    });
    this._hookIds.push({ name: 'initializeEdges', id: initEdgesId });

    const controlTokenId = Hooks.on('controlToken', (_token, controlled) => {
      if (!controlled) return;
      if (this._isControlledTokenFloorFollowSuppressed()) return;
      if (!this._shouldAutoSyncControlledTokenEvents()) return;
      this._syncToControlledTokenLevel({ emit: true, reason: 'control-token' });
    });
    this._hookIds.push({ name: 'controlToken', id: controlTokenId });

    // V14: listen for both `elevation` and `level` field changes on tokens.
    const updateTokenId = Hooks.on('updateToken', (tokenDoc, changes) => {
      const elevChanged = 'elevation' in (changes || {});
      const levelChanged = 'level' in (changes || {});
      if (!elevChanged && !levelChanged) return;

      const tid = String(tokenDoc?.id || '');
      const controlled = canvas?.tokens?.controlled || [];
      const isControlled = controlled.some((t) => t?.document?.id === tokenDoc?.id);
      const suppressed = this.isFloorFollowSuppressedForToken(tid);
      const policyOk = this._shouldAutoSyncControlledTokenEvents();
      const willSync = isControlled && !suppressed && policyOk;
      moveTrace('cameraFollower.updateToken', {
        tokenId: tid,
        newElevation: changes?.elevation,
        newLevel: changes?.level,
        isControlled,
        floorFollowSuppressed: suppressed,
        policyAllowsSync: policyOk,
        willSyncToLevel: willSync,
        lockMode: this._lockMode
      });
      if (!isControlled) return;
      if (suppressed) return;
      if (!policyOk) return;

      // V14: if the token's level field changed, prefer syncing by level id.
      // Route through setActiveLevel so both token-driven and UI-driven changes
      // share the same Foundry scene.view({ level }) transition path.
      if (levelChanged && changes.level) {
        const levelCtx = this.setActiveLevel(changes.level, {
          keepLockMode: true,
          emit: true,
          reason: 'token-level-changed',
        });
        if (levelCtx) {
          return;
        }
        const levelIdx = this._levels.findIndex((l) => l.levelId === changes.level);
        if (levelIdx >= 0) {
          this._setActiveLevelByIndex(levelIdx, {
            emit: true,
            reason: 'token-level-changed',
          });
          return;
        }
      }

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
   * Re-read level bands and preserve the closest active band.
   * For V14 native levels the viewed level (`canvas.level`) is preferred
   * as the initial selection so Map Shine stays synchronized with Foundry.
   * @param {{emit?: boolean, reason?: string}} [options]
   */
  refreshLevelBands(options = {}) {
    const { emit = true, reason = 'refresh-level-bands' } = options;
    const nextLevels = this._buildLevelBands();
    if (!nextLevels.length) return;

    let nextIndex = 0;

    // V14 native: prefer the currently viewed level from Foundry
    const viewedLevel = getViewedV14Level(canvas?.scene);
    if (viewedLevel) {
      const viewedIdx = nextLevels.findIndex((l) => l.levelId === viewedLevel.levelId);
      if (viewedIdx >= 0) nextIndex = viewedIdx;
    }

    if (this._lockMode === 'follow-controlled-token') {
      const tokenElevation = this._getControlledTokenElevation();
      if (Number.isFinite(tokenElevation)) {
        nextIndex = this._findBestLevelIndexForElevation(tokenElevation, nextLevels);
      }
    } else if (!viewedLevel && this._activeLevelContext && Number.isFinite(this._activeLevelContext.center)) {
      nextIndex = this._findNearestLevelIndexByCenter(this._activeLevelContext.center, nextLevels);
    }

    this._levels = nextLevels;
    this._setActiveLevelByIndex(nextIndex, { emit, reason });
  }

  /**
   * Build the level band list. V14 native levels are the primary source.
   * Falls back to a single default band when the scene has no native levels.
   * @returns {Array<{levelId:string,label:string,bottom:number,top:number,center:number,source:string}>}
   */
  _buildLevelBands() {
    const scene = canvas?.scene;

    // V14-native path: read directly from scene.levels
    if (hasV14NativeLevels(scene)) {
      const nativeLevels = readV14SceneLevels(scene);
      if (nativeLevels.length) {
        this._lastLevelBuildDiagnostics = {
          source: 'v14-native',
          rawCount: nativeLevels.length,
          parsedCount: nativeLevels.length,
          invalidCount: 0,
          swappedCount: 0,
        };
        return nativeLevels;
      }
    }

    // Fallback: single default floor for scenes without native levels
    const defaultSingleFloor = {
      levelId: 'inferred-default',
      label: 'Ground',
      bottom: 0,
      top: 10,
      center: 5,
      source: 'inferred',
    };
    this._lastLevelBuildDiagnostics = {
      source: 'inferred',
      rawCount: 0,
      parsedCount: 1,
      invalidCount: 0,
      swappedCount: 0,
      inferredCenterCount: 1,
    };
    return [defaultSingleFloor];
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
    let bestIndex = -1;
    let bestSpan = Infinity;

    for (let i = 0; i < levels.length; i += 1) {
      const level = levels[i];
      const includeUpperBound = i === (levels.length - 1);
      if (elevationInBand(elevation, level.bottom, level.top, includeUpperBound)) {
        const span = Math.abs(level.top - level.bottom);
        if (span < bestSpan) {
          bestSpan = span;
          bestIndex = i;
        }
      }
    }

    if (bestIndex >= 0) return bestIndex;

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
    const nextIndex = Math.max(0, Math.min(this._levels.length - 1, current + step));
    const nextLevel = this._levels[nextIndex];

    // V14: delegate to Foundry's native view transition when using native levels
    if (nextLevel?.source === 'v14-native' && canvas?.scene?.view) {
      canvas.scene.view({ level: nextLevel.levelId });
      return this._setActiveLevelByIndex(nextIndex, {
        emit: options.emit !== false,
        reason: options.reason || 'step-level',
      });
    }

    return this._setActiveLevelByIndex(nextIndex, {
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

    const targetLevel = this._levels[index];

    // V14: delegate to Foundry's native view transition
    if (targetLevel?.source === 'v14-native' && canvas?.scene?.view) {
      canvas.scene.view({ level: targetLevel.levelId });
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

  _getControlledTokenId() {
    const controlled = canvas?.tokens?.controlled || [];
    const token = controlled[0] || null;
    const id = String(token?.document?.id || token?.id || '');
    return id || null;
  }

  _cleanupExpiredFloorFollowSuppressions() {
    if (this._floorFollowSuppressionByTokenId.size === 0) return;
    const now = Date.now();
    for (const [tokenId, data] of this._floorFollowSuppressionByTokenId.entries()) {
      const until = Number(data?.until ?? 0);
      if (!Number.isFinite(until) || until <= now) {
        this._floorFollowSuppressionByTokenId.delete(tokenId);
      }
    }
  }

  _isControlledTokenFloorFollowSuppressed() {
    const tokenId = this._getControlledTokenId();
    if (!tokenId) return false;
    return this.isFloorFollowSuppressedForToken(tokenId);
  }

  /**
   * Temporarily suppress auto floor-follow for a token.
   * @param {string} tokenId
   * @param {{durationMs?: number, reason?: string}} [options]
   * @returns {number} Expiry timestamp (ms since epoch), or 0 if not set
   */
  beginFloorFollowSuppression(tokenId, options = {}) {
    const key = String(tokenId || '');
    if (!key) return 0;
    this._cleanupExpiredFloorFollowSuppressions();
    const durationMs = Math.max(0, Number(options?.durationMs ?? FLOOR_FOLLOW_SUPPRESSION_DEFAULT_MS));
    const reason = String(options?.reason || 'floor-follow-suppressed');
    const until = Date.now() + durationMs;
    this._floorFollowSuppressionByTokenId.set(key, { until, reason });
    moveTrace('cameraFollower.floorFollowSuppression.begin', {
      tokenId: key,
      reason,
      until,
      durationMs
    });
    return until;
  }

  /**
   * End auto floor-follow suppression for a token.
   * @param {string} tokenId
   */
  endFloorFollowSuppression(tokenId) {
    const key = String(tokenId || '');
    if (!key) return;
    this._floorFollowSuppressionByTokenId.delete(key);
    moveTrace('cameraFollower.floorFollowSuppression.end', { tokenId: key });
  }

  /**
   * Check whether auto floor-follow is currently suppressed for a token.
   * @param {string} tokenId
   * @returns {boolean}
   */
  isFloorFollowSuppressedForToken(tokenId) {
    const key = String(tokenId || '');
    if (!key) return false;
    this._cleanupExpiredFloorFollowSuppressions();
    return this._floorFollowSuppressionByTokenId.has(key);
  }

  /**
   * Sync Map Shine's active level to the Foundry viewed level (`canvas.level`).
   * Called on `canvasReady` to catch same-scene level redraws.
   * @param {{emit?: boolean, reason?: string}} [options]
   */
  _syncToViewedLevel(options = {}) {
    const scene = canvas?.scene;
    if (!scene) return;
    const viewedLevel = getViewedV14Level(scene);
    if (!viewedLevel) return;

    // Rebuild bands in case levels changed during the redraw
    const nextLevels = this._buildLevelBands();
    if (!nextLevels.length) return;

    const viewedIdx = nextLevels.findIndex((l) => l.levelId === viewedLevel.levelId);
    if (viewedIdx < 0) return;

    // Always replace `_levels` with the freshly built list. Foundry mutates
    // per-LevelDocument flags such as `isView` / `isVisible` when the user
    // changes the viewed level stack without altering level ids or count; if
    // we only swapped `_levels` when ids changed, `getAvailableLevels()` would
    // drift from `readV14SceneLevels()` and diagnostics would show contradictory
    // view flags while `activeLevelContext` still tracked the correct index.
    this._levels = nextLevels;

    this._setActiveLevelByIndex(viewedIdx, {
      emit: options.emit !== false,
      reason: options.reason || 'sync-viewed-level',
    });
  }

  _syncToControlledTokenLevel(options = {}) {
    if (this._isControlledTokenFloorFollowSuppressed()) return false;

    // V14: prefer the token's native level field over elevation-based lookup
    const controlled = canvas?.tokens?.controlled || [];
    const token = controlled[0] || null;
    const tokenLevelId = token?.document?.level;
    if (tokenLevelId) {
      // Early return if already on this level (avoid redundant canvas.scene.view calls)
      if (this._activeLevelContext?.levelId === tokenLevelId) {
        return true;
      }

      const levelCtx = this.setActiveLevel(tokenLevelId, {
        keepLockMode: true,
        emit: options.emit !== false,
        reason: options.reason || 'follow-controlled-token',
      });
      if (levelCtx) {
        return true;
      }

      const levelIdx = this._levels.findIndex((l) => l.levelId === tokenLevelId);
      if (levelIdx >= 0) {
        this._setActiveLevelByIndex(levelIdx, {
          emit: options.emit !== false,
          reason: options.reason || 'follow-controlled-token',
        });
        return true;
      }
    }

    // Fallback: elevation-based matching
    const tokenElevation = this._getControlledTokenElevation();
    if (!Number.isFinite(tokenElevation)) return false;
    const nextIndex = this._findBestLevelIndexForElevation(tokenElevation);

    // Early return if already on this level (avoid redundant work)
    if (nextIndex === this._activeLevelIndex) {
      return true;
    }

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
    // Only update projection matrix when zoom actually changes (pan does not need it)
    const zoomChanged = dz >= 0.0001;
    if (camera.isPerspectiveCamera && this.sceneComposer.baseFovTanHalf !== undefined) {
      const zoom = pixiZoom || 1;

      if (zoomChanged || this.sceneComposer.currentZoom !== zoom) {
        const baseTan = this.sceneComposer.baseFovTanHalf;
        const fovRad = 2 * Math.atan(baseTan / zoom);
        const fovDeg = fovRad * (180 / Math.PI);
        const clamped = Math.max(1, Math.min(170, fovDeg));

        if (Math.abs((camera.fov || 0) - clamped) > 0.001) {
          camera.fov = clamped;
          camera.updateProjectionMatrix();
        }

        this.sceneComposer.currentZoom = zoom;
      }
    } else if (camera.isOrthographicCamera) {
      if (zoomChanged || camera.zoom !== pixiZoom) {
        camera.zoom = pixiZoom;
        camera.updateProjectionMatrix();
      }
    }
    
    // Update HUD alignment to match PIXI stage.
    // Foundry's canvas.pan() normally calls hud.align() after updating the stage,
    // but Map Shine bypasses canvas.pan() by reading stage state directly.
    // We must call align() here to keep the #hud container transform synchronized.
    if (canvas?.hud?.rendered && canvas.hud.align) {
      canvas.hud.align();
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
