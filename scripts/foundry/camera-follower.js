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
import { isV3ViewOnlyFloorsEnabled } from '../compositor-v3/v3-flags.js';
import { scheduleHudAlign } from './hud-align-scheduler.js';
import { moveTrace } from '../core/movement-trace-log.js';
import {
  readV14SceneLevels,
  hasV14NativeLevels,
  getViewedV14Level,
} from './levels-scene-flags.js';
import { elevationInBand } from '../ui/levels-editor/level-boundaries.js';

const log = createLogger('CameraFollower');
const FLOOR_FOLLOW_SUPPRESSION_DEFAULT_MS = 800;

/**
 * Reason tags for which `_setActiveLevelByIndex` must NOT run the
 * level-transition curtain. These are reactive paths — they fire AFTER
 * Foundry has already redrawn the canvas (canvasReady) or in response to
 * scene-config changes (level documents added/removed). Fading-to-black at
 * that point would mean fading out a frame the user has already seen and
 * fading it back in for no benefit.
 * @type {Set<string>}
 */
const SKIP_CURTAIN_REASONS = new Set([
  'canvas-ready',
  'canvas-ready-force-resync',
  'sync-viewed-level',
  'native-level-redraw',
  'edges-initialized',
  'scene-update',
  'refresh-level-bands',
]);

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

    /** @type {object|null} Level context hook payload deferred until scene load completes. */
    this._deferredLevelContextPayload = null;

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

    /** EffectComposer camera pipeline: sync Three after PIXI pan/zoom. */
    this.updatePhase = 'camera';
    this.cameraPipelineOrder = 3;
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

  /**
   * Dispatch an active-level change. For user-initiated visible changes the
   * work is routed through {@link LevelTransitionCurtain#runLevelSwitch} so
   * the screen is fully black before `canvas.scene.view({ level })` triggers
   * Foundry's tear-down + redraw. For reactive / `emit:false` / same-index
   * paths the change is applied directly without a fade.
   *
   * @param {number} index
   * @param {{emit?: boolean, reason?: string}} [options]
   * @returns {object|null} The active level context (optimistic when the
   *   curtain path is taken).
   * @private
   */
  _setActiveLevelByIndex(index, options = {}) {
    const { emit = true, reason = 'set-active-level' } = options;
    if (!this._levels.length) return null;

    const clamped = Math.max(0, Math.min(this._levels.length - 1, Number(index) || 0));
    const level = this._levels[clamped];
    if (!level) return null;

    const isVisibleChange = clamped !== this._activeLevelIndex && this._levels.length > 1;
    const isReactiveReason = SKIP_CURTAIN_REASONS.has(reason);

    // ── V3 floor-resident switch (never runs Foundry's canvas.draw) ──────────
    // Under V3 every floor stays resident in the unified pass: all visible
    // floors' bus backgrounds and effects are loaded at populate, and — once
    // warmed — their masks are on the GPU too. So a floor change is a VIEW
    // change, not a content rebuild.
    //
    // Foundry's canvas.scene.view({level}) forces a full canvas.draw that loads
    // and HOLDS each viewed floor's full-resolution background (~731 MB each on
    // the 144 MP Mansion — see the levelMaskRebuild hook note in
    // canvas-replacement.js). That untracked VRAM/upload spike is what lost the
    // WebGL context on floor changes. We never call it here — the resident bus
    // already holds the art, so we only change which floor is active:
    //
    //   • Warm target (masks resident)      → instant view-only switch.
    //   • Cold target (masks not warm yet)  → compose masks + repopulate effects
    //     BEHIND the curtain, art from the resident bus — still no canvas.draw.
    //
    // Either branch skips canvas.draw, so the full-res background hold that
    // crashed the switch never happens. Native V14 levels only (the legacy path
    // already never calls canvas.scene.view for non-native levels); falls through
    // to the legacy canvas.scene.view path when the flag is off.
    if (emit && isVisibleChange && !isReactiveReason && isV3ViewOnlyFloorsEnabled()
        && level?.source === 'v14-native') {
      if (this._isFloorResidentForViewOnly(level)) {
        return this._applyViewOnlyLevelSwitch(clamped, level, reason);
      }
      return this._applyResidentColdLevelSwitch(clamped, level, reason);
    }

    const curtain = window.MapShine?.levelTransitionCurtain ?? null;
    const curtainAvailable = !!(
      curtain
        && typeof curtain.runLevelSwitch === 'function'
        && (typeof curtain._shouldBypass !== 'function' || !curtain._shouldBypass())
    );
    const useCurtain = emit && isVisibleChange && !isReactiveReason && curtainAvailable;

    if (!useCurtain) {
      // Direct path. For genuine same-scene level changes that aren't
      // already a reaction to Foundry's own redraw, we still need to ask
      // Foundry to view the target level (the old code did this in
      // setActiveLevel / stepLevel themselves — those callers no longer
      // do it).
      if (
        emit
          && isVisibleChange
          && !isReactiveReason
          && level?.source === 'v14-native'
          && canvas?.scene?.view
      ) {
        try {
          canvas.scene.view({ level: level.levelId });
        } catch (err) {
          log.warn('canvas.scene.view failed', err);
        }
      }
      return this._applyActiveLevelByIndex(index, options);
    }

    // Curtain path. Update internal state synchronously so the dropdown UI
    // and any caller inspecting `getActiveLevelContext()` immediately sees
    // the new target. The matching `mapShineLevelContextChanged` hook fires
    // INSIDE the curtain's `perform` callback (after fade-to-black) so all
    // heavy listener work happens while the screen is fully covered.
    const previous = this._activeLevelContext;
    const fromLabel =
      String(previous?.label || '').trim()
        || (Number.isFinite(Number(previous?.index)) ? `Level ${Number(previous.index) + 1}` : 'Current level');
    const toLabel =
      String(level.label || '').trim() || `Level ${clamped + 1}`;

    try {
      curtain.armCoverSync({
        message: 'Changing floor…',
        subtitle: `Changing from ${fromLabel} to ${toLabel}`,
        instant: true,
      });
    } catch (_) {}

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

    const performSwitch = async () => {
      try {
        if (window.MapShine) window.MapShine.__levelTransitionPerformingView = true;
        if (level?.source === 'v14-native' && canvas?.scene?.view) {
          try {
            await canvas.scene.view({ level: level.levelId });
          } catch (err) {
            log.warn('canvas.scene.view failed inside curtain perform', err);
          }
        }
        this._emitLevelContextChanged(reason);
      } finally {
        try {
          if (window.MapShine) window.MapShine.__levelTransitionPerformingView = false;
        } catch (_) {}
      }
    };

    try {
      void curtain.runLevelSwitch({
        targetLevelId: level.levelId,
        fromLabel,
        toLabel,
        reason,
        perform: performSwitch,
      });
    } catch (err) {
      log.warn('curtain.runLevelSwitch threw synchronously; falling back', err);
      try {
        performSwitch();
      } catch (_) {}
    }

    return this._activeLevelContext;
  }

  /**
   * Inner apply-without-curtain. Updates context and (when allowed) fires
   * the `mapShineLevelContextChanged` hook. Used by the dispatcher above
   * and historically by all of CameraFollower's internal callers.
   *
   * @param {number} index
   * @param {{emit?: boolean, reason?: string}} [options]
   * @returns {object|null}
   * @private
   */
  _applyActiveLevelByIndex(index, options = {}) {
    const { emit = true, reason = 'set-active-level', viewOnly = false } = options;
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
      this._emitLevelContextChanged(reason, { viewOnly });
    }

    return this._activeLevelContext;
  }

  /**
   * Whether the target level's masks are resident so a view-only switch will
   * render correctly without a rebuild. Requires the mask compositor to report
   * the band's outdoors stack warm (pre-warmed at load, or a previous visit).
   * @param {object} level - a `_levels[]` entry ({levelId, bottom, top, ...}).
   * @returns {boolean}
   * @private
   */
  _isFloorResidentForViewOnly(level) {
    try {
      if (!level || level.source !== 'v14-native') return false;
      const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor;
      if (!compositor || typeof compositor.isBandWarmForOutdoorsStack !== 'function') return false;
      const bottom = Number(level.bottom);
      const top = Number(level.top);
      if (!Number.isFinite(bottom) || !Number.isFinite(top)) return false;
      return compositor.isBandWarmForOutdoorsStack(`${bottom}:${top}`, canvas?.scene ?? null) === true;
    } catch (_) {
      return false;
    }
  }

  /**
   * V3 floor-resident view-only floor switch: update the viewed-floor state and
   * Foundry's level/perception WITHOUT Foundry's `canvas.scene.view({level})`
   * (which forces a full `canvas.draw()` teardown + redraw). V3 already holds
   * every floor resident and renders the frame itself, so only the *view* must
   * change — no content rebuild, no streaming remount, no mask bake.
   *
   * Foundry-side (best-effort, guarded): set `game.user.viewedLevel` and the
   * scene's `_view`/`_viewPosition.level`, then a perception refresh so vision /
   * occlusion / lighting re-evaluate for the new level. This is the experimental
   * lighter replacement for `canvas.draw`'s level handling; if a consumer needs
   * more of Foundry's per-level draw, it degrades (stale until the next full
   * draw), never crashes.
   *
   * @param {number} clamped - target level index.
   * @param {object} level - the target `_levels[]` entry.
   * @param {string} reason
   * @returns {object|null} the active level context.
   * @private
   */
  _applyViewOnlyLevelSwitch(clamped, level, reason) {
    log.info(`V3 view-only floor switch → ${level.label ?? level.levelId} (resident; no canvas.draw)`);
    try {
      if (window.MapShine) window.MapShine.__v3ViewOnlyFloorSwitchInFlight = true;
    } catch (_) {}

    // 1. MSA state + emit (viewOnly) — drives FloorStack active index, per-floor
    //    visibility, and a view-only levelMaskRebuild that skips composeFloor +
    //    forceRepopulate (masks + effects resident).
    const ctx = this._applyActiveLevelByIndex(clamped, { emit: true, reason, viewOnly: true });

    // 2. Foundry-side viewed-level state + object lifecycle + perception refresh
    //    (no canvas.draw). Async — NOT awaited here so ctx still returns
    //    synchronously (instant switch feel preserved) — see the method doc for
    //    why its internal sequencing (await object draws before perception
    //    refresh) matters.
    void this._applyFoundryViewedLevel(level).catch((err) => {
      log.warn('_applyFoundryViewedLevel failed', err);
    });

    // 3. Request a V3 render of the new view.
    try {
      window.MapShine?.renderLoop?.requestRender?.();
      window.MapShine?.renderLoop?.requestContinuousRender?.(300);
    } catch (_) {}

    try {
      if (window.MapShine) window.MapShine.__v3ViewOnlyFloorSwitchInFlight = false;
    } catch (_) {}
    return ctx;
  }

  /**
   * Cold-target V3 floor switch: the target floor's masks are not warm yet, so
   * compose them (and repopulate effects against them) BEHIND the level-
   * transition curtain, then reveal — all WITHOUT Foundry's
   * canvas.scene.view({level}). The resident bus already holds every visible
   * floor's background art, so no Foundry art swap / full-res background hold is
   * needed; only MSA's own (paced, GPU-budget-bounded) mask compose +
   * forceRepopulate run, which the curtain awaits before lifting. Rapid floor
   * clicks are coalesced by the curtain (control-thrash protection).
   *
   * If the curtain is unavailable it falls back to performing the switch inline
   * (no fade). Either way canvas.draw is never invoked.
   *
   * @param {number} clamped - target level index.
   * @param {object} level - the target `_levels[]` entry.
   * @param {string} reason
   * @returns {object|null} the active level context.
   * @private
   */
  _applyResidentColdLevelSwitch(clamped, level, reason) {
    const curtain = window.MapShine?.levelTransitionCurtain ?? null;
    const curtainAvailable = !!(
      curtain
        && typeof curtain.runLevelSwitch === 'function'
        && (typeof curtain._shouldBypass !== 'function' || !curtain._shouldBypass())
    );

    // Update internal state synchronously so the dropdown UI and any caller
    // inspecting getActiveLevelContext() sees the new target immediately (the
    // matching emit fires inside performSwitch, below).
    const previous = this._activeLevelContext;
    const fromLabel =
      String(previous?.label || '').trim()
        || (Number.isFinite(Number(previous?.index)) ? `Level ${Number(previous.index) + 1}` : 'Current level');
    const toLabel = String(level.label || '').trim() || `Level ${clamped + 1}`;

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

    const performSwitch = async () => {
      log.info(`V3 floor switch (cold; compose behind curtain, no canvas.draw) → ${level.label ?? level.levelId}`);
      try {
        if (window.MapShine) window.MapShine.__v3ViewOnlyFloorSwitchInFlight = true;
      } catch (_) {}
      // Foundry-side viewed-level state first (so downstream reads the new band),
      // awaited so newly-created PlaceableObjects finish drawing (vision sources
      // etc.) before the mask-rebuild emit and the curtain reveal — see
      // _applyFoundryViewedLevel's doc for why. Then emit WITHOUT viewOnly so the
      // mask handler composes the cold band and repopulates effects. Art still
      // comes from the resident bus — the handler skips Foundry's background
      // swap under floor-resident mode.
      await this._applyFoundryViewedLevel(level);
      this._emitLevelContextChanged(reason);
      try {
        if (window.MapShine) window.MapShine.__v3ViewOnlyFloorSwitchInFlight = false;
      } catch (_) {}
    };

    if (!curtainAvailable) {
      performSwitch();
      return this._activeLevelContext;
    }

    try {
      curtain.armCoverSync({
        message: 'Changing floor…',
        subtitle: `Changing from ${fromLabel} to ${toLabel}`,
        instant: true,
      });
    } catch (_) {}

    try {
      void curtain.runLevelSwitch({
        targetLevelId: level.levelId,
        fromLabel,
        toLabel,
        reason,
        perform: performSwitch,
      });
    } catch (err) {
      log.warn('curtain.runLevelSwitch threw synchronously; performing cold switch directly', err);
      try { performSwitch(); } catch (_) {}
    }

    return this._activeLevelContext;
  }

  /**
   * Update Foundry's viewed-level state WITHOUT a canvas.draw: set
   * `game.user.viewedLevel`, the scene's `_view` / `_viewPosition.level` and the
   * pending `canvas._viewOptions.level`, then a perception refresh so vision /
   * occlusion / lighting re-evaluate for the new level. This is the lightweight
   * replacement for the level handling inside canvas.draw; each write is
   * independently guarded so a Foundry API shift degrades (stale until the next
   * full draw) rather than throwing.
   *
   * Foundry-native token select / place / control all read `canvas.level` (the
   * private `#level`, committed only inside canvas.draw). We install a getter
   * override on `canvas.level` (see {@link _ensureCanvasLevelOverride}) so it
   * tracks `scene._view` — which we set below — even though canvas.draw never
   * ran. That is what makes tokens on the switched-to floor selectable/placeable
   * without the full-res background hold that canvas.draw would incur.
   *
   * IMPORTANT — async, and callers should await it before anything that reads
   * Foundry-computed visibility (e.g. relying on `sightRefresh`/
   * VisibilityController). Foundry's own `canvas.draw()` always AWAITS every
   * PlaceableObject's `draw()` (which sets up its vision source, mesh, etc.)
   * before the scene is considered ready. If the perception refresh below ran
   * before a newly-created token's `draw()` finished, its vision source
   * wasn't registered yet — `VisibilityController`'s `sightRefresh` handler
   * (Token#isVisible / canvas.tokens.placeables) then either couldn't find it
   * yet or read stale/uninitialized state, so the token was selectable
   * (creation alone is synchronous) but never rendered visible. See
   * {@link _refreshPlaceablesLayerForResidentSwitch}.
   *
   * @param {object} level - the target `_levels[]` entry.
   * @returns {Promise<void>}
   * @private
   */
  async _applyFoundryViewedLevel(level) {
    const levelId = level?.levelId ?? null;
    // Install the canvas.level override BEFORE writing scene._view so the first
    // read after the switch already resolves to the new level.
    this._ensureCanvasLevelOverride();
    try { if (globalThis.game?.user) game.user.viewedLevel = levelId; } catch (_) {}
    try {
      const scene = canvas?.scene;
      if (scene) {
        scene._view = levelId ?? scene._view;
        if (scene._viewPosition) scene._viewPosition.level = levelId ?? scene._viewPosition.level;
      }
    } catch (_) {}
    // Pending same-scene redraw target Foundry consults during transitions; only
    // written when `_viewOptions` already exists so we never clobber sibling
    // options by creating the object ourselves.
    try {
      if (canvas?._viewOptions && levelId) canvas._viewOptions.level = levelId;
    } catch (_) {}
    // The canvas.level override (above) fixes VALUES consumers read
    // (elevation math, drop position/level tagging, occlusion) — but a
    // PlaceableObject's very existence is gated by a SEPARATE, one-shot lazy
    // getter (`CanvasDocument#object`, checks `.viewed` — itself driven by
    // `scene._view`, not `canvas.level` — but only creates the object the
    // FIRST time it's accessed, then caches it forever). A token whose
    // `.viewed` was false at scene load (e.g. it lives on the OTHER floor)
    // never got its `.object` created, so nothing is selectable on it even
    // once `scene._view` correctly points here. Foundry only re-syncs this via
    // PlaceablesLayer#_draw's create/destroy loop, which runs solely inside
    // canvas.draw. Replicate just that loop, without the surrounding full
    // layer teardown canvas.draw exists to amortize. Awaited — see method doc.
    try {
      await this._refreshPlaceablesLayerForResidentSwitch(canvas?.tokens);
    } catch (_) {}
    // `PerceptionManager#update(flags)` only QUEUES render flags (Foundry
    // source: `this.renderFlags.set(flags)`, nothing else — the second
    // argument we used to pass has no effect, it isn't part of this method's
    // signature) — actual work happens later via applyRenderFlags() on
    // Foundry's own per-frame render-flag tick, not synchronously here. More
    // importantly: `refreshVision`/`refreshLighting`/`refreshSounds` only
    // REFRESH sources that already exist in canvas.effects.visionSources —
    // they do NOT (re)register a brand-new token's vision source in the first
    // place. That needs `initializeVision`/`initializeLighting`/
    // `initializeSounds`, exactly what Foundry's own `PerceptionManager
    // .initialize()` uses (its own doc: "immediate initialization plus
    // incremental refresh" — called after every real canvas.draw). Tokens
    // freshly created by the refresh above never had their vision source
    // initialized, so the refresh-only flags left VisibilityController
    // reading a token with no active vision source — selectable, never
    // visible.
    try {
      canvas?.perception?.update?.({
        initializeVision: true,
        initializeLighting: true,
        initializeSounds: true,
        refreshOcclusion: true,
      });
    } catch (_) {}
  }

  /**
   * Create PlaceableObjects for documents newly `.viewed` on this layer and
   * destroy those for documents no longer viewed — the same per-document
   * create/destroy loop `PlaceablesLayer#_draw`/`#_tearDown` run as part of a
   * full `canvas.draw()`, replicated here WITHOUT the surrounding teardown
   * (quadtree/history/preview untouched) so it stays cheap enough to run on
   * every V3 floor-resident switch.
   *
   * Scoped to `canvas.tokens` for now (the reported case: token select/place
   * on the switched-to floor). Other PlaceablesLayers (tiles, lights, sounds,
   * notes, templates, drawings, regions) share this exact API
   * (`documentCollection`/`viewedDocuments()`/`createObject()`/`objects`) so
   * extending to them is a low-risk follow-up if one is reported broken too —
   * not done pre-emptively to keep this switch's blast radius small.
   *
   * Awaits every newly-created object's `draw()` before returning — mirrors
   * `PlaceablesLayer#_draw`'s own `await Promise.allSettled(promises)`. This
   * matters: `draw()` sets up the object's vision source among other things,
   * and callers here go on to trigger a perception refresh that depends on
   * that being ready (see {@link _applyFoundryViewedLevel}).
   *
   * @param {import('@client/canvas/layers/base/placeables-layer.mjs').default|null|undefined} layer
   * @returns {Promise<void>}
   * @private
   */
  async _refreshPlaceablesLayerForResidentSwitch(layer) {
    if (!layer?.objects || typeof layer.viewedDocuments !== 'function') return;
    const stillViewed = new Set();
    const drawPromises = [];
    try {
      for (const doc of layer.viewedDocuments()) {
        stillViewed.add(doc.id);
        const existing = doc._object;
        if (existing && existing.destroyed !== true) continue;
        try {
          const obj = layer.createObject(doc);
          layer.objects.addChild(obj);
          drawPromises.push(
            Promise.resolve(obj.draw()).catch((err) => {
              log.warn(`Resident switch: draw() failed for ${layer.constructor?.name ?? 'layer'} object ${doc?.id}`, err);
            }),
          );
        } catch (err) {
          log.warn(`Resident switch: failed to create ${layer.constructor?.name ?? 'layer'} object for ${doc?.id}`, err);
        }
      }
    } catch (err) {
      log.warn('Resident switch: viewedDocuments() failed', err);
    }
    try {
      for (const doc of layer.documentCollection ?? []) {
        if (stillViewed.has(doc.id)) continue;
        const obj = doc._object;
        if (!obj || obj.destroyed === true) continue;
        try {
          layer.objects.removeChild(obj);
          obj.destroy({ children: true });
        } catch (err) {
          log.warn(`Resident switch: failed to tear down ${layer.constructor?.name ?? 'layer'} object for ${doc?.id}`, err);
        }
        doc._object = null;
      }
    } catch (err) {
      log.warn('Resident switch: documentCollection sweep failed', err);
    }
    if (drawPromises.length) {
      await Promise.allSettled(drawPromises);
    }
  }

  /**
   * Make `canvas.level` track the viewed level under a V3 floor-resident switch.
   *
   * Foundry's `Canvas#level` is a getter returning the private `#level`, which
   * is assigned ONLY inside `canvas.draw` (board.mjs). We deliberately skip
   * canvas.draw on a floor change (it loads + holds each floor's full-resolution
   * background — the VRAM/upload spike that crashed the switch), but token
   * select / place / control read `canvas.level.id` (token.mjs), so with a stale
   * `#level` the switched-to floor is non-interactive.
   *
   * Override the instance getter to return `scene.levels.get(scene._view)` (which
   * we keep current) whenever it diverges from the drawn `#level`. It falls back
   * to the original `#level` when `scene._view` is unset or already matches — so
   * a real canvas.draw (initial load, scene change) is never interfered with; the
   * override only diverges while a floor-resident switch is ahead of the last
   * draw. Idempotent per canvas instance (survives canvas teardown/recreate by
   * re-installing on the next switch).
   * @private
   */
  _ensureCanvasLevelOverride() {
    try {
      const cv = globalThis.canvas;
      if (!cv || cv.__msaLevelGetterPatched === true) return;

      // Find the original `level` getter on the prototype chain.
      let proto = cv;
      let desc = null;
      while (proto && !desc) {
        desc = Object.getOwnPropertyDescriptor(proto, 'level');
        if (!desc) proto = Object.getPrototypeOf(proto);
      }
      const origGet = desc?.get;
      if (typeof origGet !== 'function') return;

      Object.defineProperty(cv, 'level', {
        configurable: true,
        enumerable: desc.enumerable ?? false,
        get() {
          const orig = origGet.call(this);
          try {
            const viewId = this.scene?._view;
            if (viewId && orig?.id !== viewId) {
              const target = this.scene?.levels?.get?.(viewId);
              if (target) return target;
            }
          } catch (_) {}
          return orig;
        },
      });
      cv.__msaLevelGetterPatched = true;
      log.info('Installed canvas.level override — tracks viewed level for V3 floor-resident switches (token select/place/control)');
    } catch (err) {
      log.debug('canvas.level override install failed', err);
    }
  }

  stepLevel(delta = 1, options = {}) {
    if (!Number.isFinite(delta) || delta === 0) return this.getActiveLevelContext();

    if (this._lockMode === 'follow-controlled-token' && options.keepLockMode !== true) {
      this.setLockMode('manual', { emit: false, reason: 'manual-step' });
    }

    const step = delta > 0 ? 1 : -1;
    const current = Number.isFinite(this._activeLevelIndex) ? this._activeLevelIndex : 0;
    const nextIndex = Math.max(0, Math.min(this._levels.length - 1, current + step));

    // V14: `canvas.scene.view({ level })` is fired by `_setActiveLevelByIndex`
    // (either inline for the direct path or inside the curtain's `perform`
    // for the curtain path) — never here, so the curtain can fade-to-black
    // BEFORE Foundry begins tearing down the canvas.
    return this._setActiveLevelByIndex(nextIndex, {
      emit: options.emit !== false,
      reason: options.reason || 'step-level',
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

    // V14 native view transition is delegated to `_setActiveLevelByIndex` so
    // it lands inside the curtain's `perform` callback (after fade-to-black)
    // and never fires before the screen is covered.
    return this._setActiveLevelByIndex(index, {
      emit: options.emit !== false,
      reason: options.reason || 'set-active-level',
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

  _emitLevelContextChanged(reason = 'unknown', opts = {}) {
    const payload = {
      context: this.getActiveLevelContext(),
      levels: this.getAvailableLevels(),
      diagnostics: this.getLevelDiagnostics(),
      reason,
      lockMode: this._lockMode,
      // V3 floor-resident view-only switch: the mask rebuild handler skips the
      // cold composeFloor + forceRepopulate (masks resident, effects resident)
      // and does only the cheap state/visibility update.
      viewOnly: opts.viewOnly === true,
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

    if (window.MapShine?.__msaSceneLoading === true) {
      this._deferredLevelContextPayload = payload;
      return;
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
   * Emit a level-context hook that was deferred during scene loading.
   * @returns {void}
   */
  flushDeferredLevelContextEmit() {
    const payload = this._deferredLevelContextPayload;
    if (!payload) return;
    this._deferredLevelContextPayload = null;
    try {
      Hooks.callAll('mapShineLevelContextChanged', payload);
    } catch (_) {}
    try {
      const ms = window.MapShine;
      ms?.depthPassManager?.invalidate?.();
      ms?.renderLoop?.requestRender?.();
      ms?.renderLoop?.requestContinuousRender?.(220);
    } catch (_) {}
    log.info('CameraFollower: emitted deferred level context after load');
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
    
    // Coalesce HUD alignment — canvas.pan() and CameraFollower can both request it.
    scheduleHudAlign();
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
