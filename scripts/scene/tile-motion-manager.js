/**
 * @fileoverview Tile motion manager
 *
 * Runtime-only tile animation system that layers visual motion on top of
 * TileManager's base transforms without writing per-frame document updates.
 *
 * @module scene/tile-motion-manager
 */

import { createLogger } from '../core/log.js';

const log = createLogger('TileMotionManager');

const MODULE_ID = 'map-shine-advanced';
const FLAG_KEY = 'tileMotion';
const CURRENT_VERSION = 1;
const MOTION_TYPES = new Set(['rotation', 'orbit', 'pingPong', 'sine']);

function _clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function _sanitizePoint(point, fallbackX = 0, fallbackY = 0) {
  if (Array.isArray(point) && point.length >= 2) {
    return {
      x: _toNumber(point[0], fallbackX),
      y: _toNumber(point[1], fallbackY)
    };
  }

  if (point && typeof point === 'object') {
    return {
      x: _toNumber(point.x, fallbackX),
      y: _toNumber(point.y, fallbackY)
    };
  }

  return { x: fallbackX, y: fallbackY };
}

function _toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function _deepClone(value) {
  const utils = globalThis.foundry?.utils;
  if (typeof utils?.deepClone === 'function') {
    try {
      return utils.deepClone(value);
    } catch (_) {
    }
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return value;
  }
}

function _createDefaultState() {
  return {
    version: CURRENT_VERSION,
    global: {
      playing: false,
      startEpochMs: 0,
      speedPercent: 100,
      // Additional runtime multiplier applied on top of speedPercent.
      // Used by the Control Panel "Time Factor" slider (0–200%).
      timeFactorPercent: 100,
      // If enabled, tile motion will start automatically once the manager is initialized.
      autoPlayEnabled: true
    },
    tiles: {}
  };
}

export class TileMotionManager {
  /**
   * @param {import('./tile-manager.js').TileManager|null} tileManager
   */
  constructor(tileManager = null) {
    /** @type {import('./tile-manager.js').TileManager|null} */
    this.tileManager = tileManager;

    /** @type {boolean} */
    this.initialized = false;

    /** @type {ReturnType<typeof _createDefaultState>} */
    this.state = _createDefaultState();

    /** @type {Array<[string, number]>} */
    this._hookIds = [];

    /** @type {Map<string, {x:number,y:number,z:number,scaleX:number,scaleY:number,rotation:number}>} */
    this._baseCache = new Map();

    /** @type {Map<string, {offsetX:number,offsetY:number,rotation:number,centerX:number,centerY:number,matrixAutoUpdate:boolean}>} */
    this._textureBaseCache = new Map();

    /** @type {Map<string, {x:number,y:number,rotation:number,animDelta:number,frameId:number}>} */
    this._resolvedStates = new Map();

    /** @type {string[]} */
    this._runtimeOrder = [];

    /** @type {Set<string>} */
    this._invalidTiles = new Set();

    /** @type {Set<string>} */
    this._missingParentTiles = new Set();

    /** @type {Set<string>} */
    this._activeTileIds = new Set();

    /** @type {Set<string>} */
    this._frameActiveTileIds = new Set();

    /** @type {boolean} */
    this._graphDirty = true;

    /** @type {boolean} */
    this._suppressFlagReload = false;

    /** @type {number} */
    this._frameStamp = 0;

    /** @type {number} */
    this._fallbackStartEpochMs = 0;

    // Accumulated animation time (seconds) for tile motion.
    // We advance this by scaled frame delta so global pause (time scale = 0)
    // freezes motion instead of snapping back to t=0.
    /** @type {number} */
    this._elapsedAccumSec = 0;

    /** @type {number} */
    this._lastUpdateNowMs = 0;

    /** @type {number} */
    this._lastEffectiveStartMs = 0;

    // Reused per-frame temp objects to avoid allocations in hot paths.
    this._tmpInherited = { inheritedX: 0, inheritedY: 0, inheritedRotation: 0, inheritedAnimDelta: 0 };
    this._tmpWorldVecA = { x: 0, y: 0 };
    this._tmpWorldVecB = { x: 0, y: 0 };
    this._tmpPivotResult = { x: 0, y: 0, rotation: 0 };
  }

  async initialize() {
    if (this.initialized) return;

    this._loadFromSceneFlag();
    this._captureAllBaseTransforms();
    this._setupHooks();

    this.initialized = true;
    log.info('TileMotionManager initialized');

    // Optional auto-play (GM only). Delay slightly so the scene graph has had
    // a chance to settle before we begin applying per-frame transforms.
    try {
      const wantAuto = this.state?.global?.autoPlayEnabled !== false;
      if (wantAuto && this.state?.global?.playing !== true) {
        setTimeout(() => {
          try {
            if (!this.initialized) return;
            if (this.state?.global?.autoPlayEnabled === false) return;
            if (this.state?.global?.playing === true) return;
            if (!this._canEditScene()) return;
            void this.start();
          } catch (_) {
          }
        }, 250);
      }
    } catch (_) {
    }
  }

  dispose() {
    for (const [hookName, hookId] of this._hookIds) {
      try {
        Hooks.off(hookName, hookId);
      } catch (_) {
      }
    }
    this._hookIds = [];

    this._restoreAllActiveTiles();

    this._baseCache.clear();
    this._textureBaseCache.clear();
    this._resolvedStates.clear();
    this._runtimeOrder.length = 0;
    this._invalidTiles.clear();
    this._missingParentTiles.clear();
    this._graphDirty = true;
    this.initialized = false;
  }

  _setupHooks() {
    if (this._hookIds.length > 0) return;

    this._hookIds.push(['updateScene', Hooks.on('updateScene', (scene, changes) => {
      if (!scene || scene.id !== canvas?.scene?.id) return;
      if (this._suppressFlagReload) return;

      const mod = changes?.flags?.[MODULE_ID];
      if (!mod || !Object.prototype.hasOwnProperty.call(mod, FLAG_KEY)) return;

      this._loadFromSceneFlag();
    })]);

    this._hookIds.push(['deleteTile', Hooks.on('deleteTile', (tileDoc) => {
      this.onTileRemoved(tileDoc?.id);
    })]);
  }

  _loadFromSceneFlag() {
    const wasPlaying = this.state?.global?.playing === true;
    const scene = canvas?.scene;
    const raw = scene?.getFlag?.(MODULE_ID, FLAG_KEY);
    this.state = this._sanitizeState(raw);
    this._graphDirty = true;

    const isPlayingNow = this.state?.global?.playing === true;
    if (!isPlayingNow || !wasPlaying) {
      // Safe to refresh all base transforms while stopped (or at first start).
      this._captureAllBaseTransforms();
    } else {
      // During active playback, only capture missing bases. Existing bases must
      // remain stable so speed/start updates don't bake animated positions.
      this._captureMissingBaseTransforms();
    }

    if (isPlayingNow) {
      this._requestContinuousRender(1000);
    } else if (wasPlaying || this._activeTileIds.size > 0) {
      this._restoreAllActiveTiles();
    }
  }

  _sanitizeState(raw) {
    const out = _createDefaultState();
    if (!raw || typeof raw !== 'object') return out;

    out.version = CURRENT_VERSION;

    const global = raw.global && typeof raw.global === 'object' ? raw.global : {};
    out.state = {
      version: CURRENT_VERSION,
      global: {
        playing: !!global.playing,
        startEpochMs: _toNumber(global.startEpochMs, 0),
        speedPercent: _clamp(_toNumber(global.speedPercent, 100), 0, 400),
        timeFactorPercent: _clamp(_toNumber(global.timeFactorPercent, 100), 0, 200),
        autoPlayEnabled: global.autoPlayEnabled !== false
      },
      tiles: raw.tiles && typeof raw.tiles === 'object' ? raw.tiles : {}
    };

    for (const [tileId, cfg] of Object.entries(out.state.tiles)) {
      if (!tileId || !cfg || typeof cfg !== 'object') continue;
      out.state.tiles[tileId] = this._sanitizeTileConfig(tileId, cfg);
    }

    return out.state;
  }

  _sanitizeTileConfig(tileId, cfg) {
    const mode = cfg.mode === 'texture' ? 'texture' : 'transform';

    const parentId = (typeof cfg.parentId === 'string' && cfg.parentId && cfg.parentId !== tileId)
      ? cfg.parentId
      : null;

    const pivot = cfg.pivot && typeof cfg.pivot === 'object' ? cfg.pivot : {};
    const motion = cfg.motion && typeof cfg.motion === 'object' ? cfg.motion : {};
    const textureMotion = cfg.textureMotion && typeof cfg.textureMotion === 'object' ? cfg.textureMotion : {};
    const motionType = MOTION_TYPES.has(motion.type) ? motion.type : 'rotation';
    const loopMode = motion.loopMode === 'pingPong' ? 'pingPong' : 'loop';
    const pointA = _sanitizePoint(motion.pointA, 0, 0);
    const pointB = _sanitizePoint(motion.pointB, 0, 0);

    return {
      enabled: !!cfg.enabled,
      shadowProjectionEnabled: !!cfg.shadowProjectionEnabled,
      mode,
      parentId,
      pivot: {
        x: _toNumber(pivot.x, 0),
        y: _toNumber(pivot.y, 0),
        snapToGrid: !!pivot.snapToGrid
      },
      motion: {
        type: motionType,
        speed: _toNumber(motion.speed, 0),
        phase: _toNumber(motion.phase, 0),
        loopMode,
        radius: Math.max(0, _toNumber(motion.radius, 0)),
        pointA,
        pointB,
        amplitudeX: _toNumber(motion.amplitudeX, 0),
        amplitudeY: _toNumber(motion.amplitudeY, 0),
        amplitudeRot: _toNumber(motion.amplitudeRot, 0)
      },
      textureMotion: {
        scrollU: _toNumber(textureMotion.scrollU, 0),
        scrollV: _toNumber(textureMotion.scrollV, 0),
        rotateSpeed: _toNumber(textureMotion.rotateSpeed, 0),
        pivotU: _clamp(_toNumber(textureMotion.pivotU, 0.5), 0, 1),
        pivotV: _clamp(_toNumber(textureMotion.pivotV, 0.5), 0, 1)
      }
    };
  }

  _canEditScene() {
    const scene = canvas?.scene;
    const user = game?.user;
    if (!scene || !user) return false;
    if (user.isGM) return true;
    try {
      if (typeof scene.canUserModify === 'function') {
        return scene.canUserModify(user, 'update');
      }
    } catch (_) {
    }
    return false;
  }

  async _saveStateToScene() {
    const scene = canvas?.scene;
    if (!scene || !this._canEditScene()) return false;

    try {
      this._suppressFlagReload = true;
      await scene.setFlag(MODULE_ID, FLAG_KEY, this.state);
      return true;
    } catch (error) {
      log.warn('Failed to save tile motion state:', error);
      return false;
    } finally {
      this._suppressFlagReload = false;
    }
  }

  getGlobalState() {
    return _deepClone(this.state?.global || _createDefaultState().global);
  }

  async setAutoPlayEnabled(enabled, options = undefined) {
    if (!this._canEditScene()) return false;
    const persist = options?.persist !== false;

    this.state.global.autoPlayEnabled = enabled !== false;
    if (!persist) return true;
    return this._saveStateToScene();
  }

  async setTimeFactorPercent(percent, options = undefined) {
    if (!this._canEditScene()) return false;
    const persist = options?.persist !== false;

    const clamped = _clamp(_toNumber(percent, 100), 0, 200);
    this.state.global.timeFactorPercent = clamped;
    if (this.state.global.playing) this._requestContinuousRender(500);

    if (!persist) return true;
    return this._saveStateToScene();
  }

  getState() {
    return _deepClone(this.state);
  }

  getTileConfig(tileId) {
    if (!tileId) return null;
    const cfg = this.state?.tiles?.[tileId] || this._sanitizeTileConfig(tileId, {});
    return _deepClone(cfg);
  }

  getTileRuntimeStatus(tileId) {
    if (!tileId) return { status: 'unknown', label: 'Unknown' };

    if (this._graphDirty) this._rebuildRuntimeGraph();

    const cfg = this.state?.tiles?.[tileId];
    const hasSprite = !!this._getTileData(tileId)?.sprite;

    if (!cfg?.enabled) return { status: 'disabled', label: 'Disabled' };
    if (!hasSprite) return { status: 'missingTile', label: 'Missing Tile' };
    if (this._invalidTiles.has(tileId)) return { status: 'invalidCycle', label: 'Invalid Cycle' };
    if (this._missingParentTiles.has(tileId)) return { status: 'missingParent', label: 'Missing Parent' };

    const isPlaying = this.state?.global?.playing === true;
    return { status: isPlaying ? 'active' : 'ready', label: isPlaying ? 'Active' : 'Ready' };
  }

  getTileList() {
    const list = [];
    const map = this.tileManager?.tileSprites;
    if (!map || typeof map.values !== 'function') return list;

    for (const data of map.values()) {
      const tileId = data?.tileDoc?.id;
      if (!tileId) continue;

      const src = String(data?.tileDoc?.texture?.src || '');
      const file = src ? src.split('/').pop() || src : '';
      const label = file ? `${tileId} — ${file}` : tileId;
      list.push({ id: tileId, label });
    }

    list.sort((a, b) => String(a.label).localeCompare(String(b.label)));
    return list;
  }

  /**
   * Get tile IDs which are motion-enabled and opted into overhead shadow projection.
   * @returns {string[]}
   */
  getShadowProjectionTileIds() {
    const ids = [];
    for (const [tileId, cfg] of Object.entries(this.state?.tiles || {})) {
      if (!tileId || !cfg?.enabled || !cfg?.shadowProjectionEnabled) continue;
      ids.push(tileId);
    }
    return ids;
  }

  isPlaying() {
    return this.state?.global?.playing === true;
  }

  async start() {
    if (!this._canEditScene()) return false;

    this.state.global.playing = true;
    this.state.global.startEpochMs = this._getNowMs();

    const ok = await this._saveStateToScene();
    if (ok) this._requestContinuousRender(1000);
    return ok;
  }

  async stop() {
    if (!this._canEditScene()) return false;

    this.state.global.playing = false;

    const ok = await this._saveStateToScene();
    this._restoreAllActiveTiles();
    return ok;
  }

  async resetPhase() {
    if (!this._canEditScene()) return false;

    this.state.global.startEpochMs = this._getNowMs();
    this._fallbackStartEpochMs = 0;

    if (this.state.global.playing) this._requestContinuousRender(500);

    return this._saveStateToScene();
  }

  async setSpeedPercent(percent, options = undefined) {
    if (!this._canEditScene()) return false;

    const persist = options?.persist !== false;
    const next = _clamp(_toNumber(percent, 100), 0, 400);
    this.state.global.speedPercent = next;

    if (this.state.global.playing) this._requestContinuousRender(500);

    if (!persist) return true;

    const ok = await this._saveStateToScene();
    return ok;
  }

  async setTileEnabled(tileId, enabled) {
    if (!tileId || !this._canEditScene()) return false;

    const cur = this.state.tiles[tileId] || this._sanitizeTileConfig(tileId, {});
    cur.enabled = !!enabled;
    this.state.tiles[tileId] = this._sanitizeTileConfig(tileId, cur);
    this._graphDirty = true;

    return this._saveStateToScene();
  }

  async setTileConfig(tileId, patch, options = undefined) {
    if (!tileId || !patch || typeof patch !== 'object' || !this._canEditScene()) return false;

    const persist = options?.persist !== false;

    const current = this.state.tiles[tileId] || this._sanitizeTileConfig(tileId, {});
    const merged = {
      ...current,
      ...patch,
      pivot: { ...(current.pivot || {}), ...(patch.pivot || {}) },
      motion: { ...(current.motion || {}), ...(patch.motion || {}) },
      textureMotion: { ...(current.textureMotion || {}), ...(patch.textureMotion || {}) }
    };

    this.state.tiles[tileId] = this._sanitizeTileConfig(tileId, merged);
    this._graphDirty = true;

    if (this.state.global.playing) this._requestContinuousRender(500);

    if (!persist) return true;

    return this._saveStateToScene();
  }

  _getNowMs() {
    const serverMs = _toNumber(game?.time?.serverTime, NaN);
    if (Number.isFinite(serverMs) && serverMs > 0) return serverMs;
    return Date.now();
  }

  captureBaseTransform(tileId, sprite) {
    if (!tileId || !sprite) return;

    const base = this._baseCache.get(tileId) || {
      x: 0,
      y: 0,
      z: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0
    };

    base.x = _toNumber(sprite.position?.x, 0);
    base.y = _toNumber(sprite.position?.y, 0);
    base.z = _toNumber(sprite.position?.z, 0);
    base.scaleX = _toNumber(sprite.scale?.x, 1);
    base.scaleY = _toNumber(sprite.scale?.y, 1);
    base.rotation = _toNumber(sprite.material?.rotation, 0);

    this._baseCache.set(tileId, base);

    const isPlaying = this.state?.global?.playing === true;
    const cfg = this.state?.tiles?.[tileId];
    const isTextureTile = cfg?.enabled && cfg?.mode === 'texture';
    const preserveTextureBase = isPlaying && isTextureTile && this._textureBaseCache.has(tileId);
    if (!preserveTextureBase) {
      this._captureBaseTextureTransform(tileId, sprite);
    }
  }

  _captureBaseTextureTransform(tileId, sprite) {
    const map = sprite?.material?.map;
    if (!map) {
      this._textureBaseCache.delete(tileId);
      return;
    }

    const THREE = window.THREE;
    this._textureBaseCache.set(tileId, {
      offsetX: _toNumber(map.offset?.x, 0),
      offsetY: _toNumber(map.offset?.y, 0),
      rotation: _toNumber(map.rotation, 0),
      centerX: _toNumber(map.center?.x, 0.5),
      centerY: _toNumber(map.center?.y, 0.5),
      matrixAutoUpdate: map.matrixAutoUpdate !== false,
      wrapS: map.wrapS ?? (THREE ? THREE.ClampToEdgeWrapping : 1001),
      wrapT: map.wrapT ?? (THREE ? THREE.ClampToEdgeWrapping : 1001)
    });
  }

  _captureAllBaseTransforms() {
    const sprites = this.tileManager?.tileSprites;
    if (!sprites || typeof sprites.values !== 'function') return;

    for (const data of sprites.values()) {
      const tileId = data?.tileDoc?.id;
      const sprite = data?.sprite;
      if (!tileId || !sprite) continue;
      this.captureBaseTransform(tileId, sprite);
    }
  }

  _captureMissingBaseTransforms() {
    const sprites = this.tileManager?.tileSprites;
    if (!sprites || typeof sprites.values !== 'function') return;

    for (const data of sprites.values()) {
      const tileId = data?.tileDoc?.id;
      const sprite = data?.sprite;
      if (!tileId || !sprite) continue;
      if (this._baseCache.has(tileId)) continue;
      this.captureBaseTransform(tileId, sprite);
    }
  }

  onTileRemoved(tileId) {
    if (!tileId) return;

    this._baseCache.delete(tileId);
    this._textureBaseCache.delete(tileId);
    this._resolvedStates.delete(tileId);
    this._activeTileIds.delete(tileId);
    this._frameActiveTileIds.delete(tileId);

    if (this.state?.tiles && this.state.tiles[tileId]) {
      this._graphDirty = true;
    }
  }

  _rebuildRuntimeGraph() {
    this._runtimeOrder.length = 0;
    this._invalidTiles.clear();
    this._missingParentTiles.clear();

    const enabledIds = [];
    const enabledSet = new Set();

    for (const [tileId, cfg] of Object.entries(this.state?.tiles || {})) {
      if (!cfg?.enabled) continue;
      enabledIds.push(tileId);
      enabledSet.add(tileId);
    }

    const visitState = new Map(); // 0=unseen, 1=visiting, 2=done
    const stack = [];

    const visit = (tileId) => {
      const state = visitState.get(tileId) || 0;
      if (state === 2) return;

      if (state === 1) {
        const idx = stack.indexOf(tileId);
        if (idx >= 0) {
          for (let i = idx; i < stack.length; i++) this._invalidTiles.add(stack[i]);
        } else {
          this._invalidTiles.add(tileId);
        }
        return;
      }

      visitState.set(tileId, 1);
      stack.push(tileId);

      const cfg = this.state.tiles[tileId];
      const parentId = cfg?.parentId;
      if (parentId) {
        if (enabledSet.has(parentId)) {
          visit(parentId);
        } else {
          this._missingParentTiles.add(tileId);
        }
      }

      stack.pop();
      visitState.set(tileId, 2);

      if (!this._invalidTiles.has(tileId)) {
        this._runtimeOrder.push(tileId);
      }
    };

    for (const tileId of enabledIds) visit(tileId);

    if (this._invalidTiles.size > 0) {
      log.warn(`Tile motion: detected parent cycles for ${this._invalidTiles.size} tile(s).`);
    }

    if (this._missingParentTiles.size > 0) {
      log.warn(`Tile motion: ${this._missingParentTiles.size} tile(s) reference missing/disabled parents.`);
    }

    this._graphDirty = false;
  }

  _requestContinuousRender(durationMs) {
    try {
      window.MapShine?.renderLoop?.requestContinuousRender?.(durationMs);
    } catch (_) {
    }
  }

  _getTileData(tileId) {
    const map = this.tileManager?.tileSprites;
    if (!map || typeof map.get !== 'function') return null;
    return map.get(tileId) || null;
  }

  _getResolvedState(tileId, frameId) {
    let state = this._resolvedStates.get(tileId);
    if (!state) {
      state = { x: 0, y: 0, rotation: 0, animDelta: 0, frameId: -1 };
      this._resolvedStates.set(tileId, state);
    }
    state.frameId = frameId;
    return state;
  }

  _resolveInheritedTransform(tileId, cfg, frameId, tileBase) {
    const out = this._tmpInherited;
    out.inheritedX = tileBase.x;
    out.inheritedY = tileBase.y;
    out.inheritedRotation = tileBase.rotation;
    out.inheritedAnimDelta = 0;

    const parentId = cfg.parentId;
    if (parentId && !this._invalidTiles.has(tileId)) {
      const parentResolved = this._resolvedStates.get(parentId);
      const parentBase = this._baseCache.get(parentId);

      if (parentResolved && parentResolved.frameId === frameId && parentBase) {
        const offX = tileBase.x - parentBase.x;
        const offY = tileBase.y - parentBase.y;

        const pCos = Math.cos(parentResolved.animDelta);
        const pSin = Math.sin(parentResolved.animDelta);

        const rotOffX = offX * pCos - offY * pSin;
        const rotOffY = offX * pSin + offY * pCos;

        out.inheritedX = parentResolved.x + rotOffX;
        out.inheritedY = parentResolved.y + rotOffY;
        out.inheritedRotation = tileBase.rotation + parentResolved.animDelta;
        out.inheritedAnimDelta = parentResolved.animDelta;
      }
    }

    return out;
  }

  _computeRawPhaseDeg(cfg, elapsedSec) {
    const speedDegPerSec = _toNumber(cfg.motion?.speed, 0);
    const phaseDeg = _toNumber(cfg.motion?.phase, 0);
    return phaseDeg + speedDegPerSec * elapsedSec;
  }

  _loop01(rawDeg, loopMode = 'loop') {
    const cycle = ((rawDeg / 360) % 1 + 1) % 1;
    if (loopMode === 'pingPong') {
      return cycle <= 0.5 ? cycle * 2 : (1 - cycle) * 2;
    }
    return cycle;
  }

  _rotateFoundryLocalToWorld(localX, localYFoundry, worldRotationRad, out = undefined) {
    const x = _toNumber(localX, 0);
    const y = -_toNumber(localYFoundry, 0);
    const c = Math.cos(worldRotationRad);
    const s = Math.sin(worldRotationRad);

    const vec = out || this._tmpWorldVecA;
    vec.x = x * c - y * s;
    vec.y = x * s + y * c;
    return vec;
  }

  _applyPivotRotation(baseX, baseY, baseRotation, deltaRotation, pivotXFoundry, pivotYFoundry, out = undefined) {
    const pivotX = _toNumber(pivotXFoundry, 0);
    const pivotY = -_toNumber(pivotYFoundry, 0);

    const finalRot = baseRotation + deltaRotation;

    const iCos = Math.cos(baseRotation);
    const iSin = Math.sin(baseRotation);
    const fCos = Math.cos(finalRot);
    const fSin = Math.sin(finalRot);

    const v0x = pivotX * iCos - pivotY * iSin;
    const v0y = pivotX * iSin + pivotY * iCos;

    const v1x = pivotX * fCos - pivotY * fSin;
    const v1y = pivotX * fSin + pivotY * fCos;

    const res = out || this._tmpPivotResult;
    res.x = baseX + (v0x - v1x);
    res.y = baseY + (v0y - v1y);
    res.rotation = finalRot;
    return res;
  }

  _applyFinalTileState(tileId, frameId, tileBase, sprite, finalX, finalY, finalRot, totalAnimDelta) {
    sprite.position.set(finalX, finalY, tileBase.z);
    sprite.scale.set(tileBase.scaleX, tileBase.scaleY, 1);
    if (sprite.material) sprite.material.rotation = finalRot;
    sprite.updateMatrix();
    this.tileManager?.syncTileAttachedEffects?.(tileId, sprite);

    const resolved = this._getResolvedState(tileId, frameId);
    resolved.x = finalX;
    resolved.y = finalY;
    resolved.rotation = finalRot;
    resolved.animDelta = totalAnimDelta;

    this._frameActiveTileIds.add(tileId);
  }

  _restoreTile(tileId) {
    const data = this._getTileData(tileId);
    const base = this._baseCache.get(tileId);
    const sprite = data?.sprite;

    if (!sprite || !base) return;

    sprite.position.set(base.x, base.y, base.z);
    sprite.scale.set(base.scaleX, base.scaleY, 1);
    if (sprite.material) sprite.material.rotation = base.rotation;

    const textureBase = this._textureBaseCache.get(tileId);
    const map = sprite?.material?.map;
    if (map && textureBase) {
      map.offset.set(textureBase.offsetX, textureBase.offsetY);
      map.center.set(textureBase.centerX, textureBase.centerY);
      map.rotation = textureBase.rotation;
      map.matrixAutoUpdate = textureBase.matrixAutoUpdate;
      if (map.wrapS !== textureBase.wrapS || map.wrapT !== textureBase.wrapT) {
        map.wrapS = textureBase.wrapS;
        map.wrapT = textureBase.wrapT;
        map.needsUpdate = true;
      }
      map.updateMatrix();
    }

    sprite.updateMatrix();
    this.tileManager?.syncTileAttachedEffects?.(tileId, sprite);
  }

  _restoreAllActiveTiles() {
    for (const tileId of this._activeTileIds) {
      this._restoreTile(tileId);
    }

    this._activeTileIds.clear();
    this._frameActiveTileIds.clear();
    this._resolvedStates.clear();
  }

  _applyRotationTile(tileId, cfg, elapsedSec, frameId) {
    const data = this._getTileData(tileId);
    const sprite = data?.sprite;
    if (!sprite) return;

    const base = this._baseCache.get(tileId);
    if (!base) {
      this.captureBaseTransform(tileId, sprite);
    }

    const tileBase = this._baseCache.get(tileId);
    if (!tileBase) return;

    const inherited = this._resolveInheritedTransform(tileId, cfg, frameId, tileBase);
    const ownDelta = (this._computeRawPhaseDeg(cfg, elapsedSec) * Math.PI) / 180;
    const pivoted = this._applyPivotRotation(
      inherited.inheritedX,
      inherited.inheritedY,
      inherited.inheritedRotation,
      ownDelta,
      cfg?.pivot?.x,
      cfg?.pivot?.y,
      this._tmpPivotResult
    );

    this._applyFinalTileState(
      tileId,
      frameId,
      tileBase,
      sprite,
      pivoted.x,
      pivoted.y,
      pivoted.rotation,
      inherited.inheritedAnimDelta + ownDelta
    );
  }

  _applyOrbitTile(tileId, cfg, elapsedSec, frameId) {
    const data = this._getTileData(tileId);
    const sprite = data?.sprite;
    if (!sprite) return;

    const base = this._baseCache.get(tileId);
    if (!base) this.captureBaseTransform(tileId, sprite);
    const tileBase = this._baseCache.get(tileId);
    if (!tileBase) return;

    const inherited = this._resolveInheritedTransform(tileId, cfg, frameId, tileBase);
    const rawDeg = this._computeRawPhaseDeg(cfg, elapsedSec);
    const loopMode = cfg?.motion?.loopMode === 'pingPong' ? 'pingPong' : 'loop';
    const u = this._loop01(rawDeg, loopMode);
    const angle = u * Math.PI * 2;
    const radius = Math.max(0, _toNumber(cfg?.motion?.radius, 0));

    const pivotCenterOff = this._rotateFoundryLocalToWorld(
      cfg?.pivot?.x,
      cfg?.pivot?.y,
      inherited.inheritedRotation,
      this._tmpWorldVecA
    );
    const centerX = inherited.inheritedX + pivotCenterOff.x;
    const centerY = inherited.inheritedY + pivotCenterOff.y;

    const orbitOff = this._rotateFoundryLocalToWorld(
      radius * Math.cos(angle),
      radius * Math.sin(angle),
      inherited.inheritedRotation,
      this._tmpWorldVecB
    );

    const finalX = centerX + orbitOff.x;
    const finalY = centerY + orbitOff.y;

    this._applyFinalTileState(
      tileId,
      frameId,
      tileBase,
      sprite,
      finalX,
      finalY,
      inherited.inheritedRotation,
      inherited.inheritedAnimDelta
    );
  }

  _applyPingPongTile(tileId, cfg, elapsedSec, frameId) {
    const data = this._getTileData(tileId);
    const sprite = data?.sprite;
    if (!sprite) return;

    const base = this._baseCache.get(tileId);
    if (!base) this.captureBaseTransform(tileId, sprite);
    const tileBase = this._baseCache.get(tileId);
    if (!tileBase) return;

    const inherited = this._resolveInheritedTransform(tileId, cfg, frameId, tileBase);
    const rawDeg = this._computeRawPhaseDeg(cfg, elapsedSec);
    const loopMode = cfg?.motion?.loopMode === 'pingPong' ? 'pingPong' : 'loop';
    const u = this._loop01(rawDeg, loopMode);

    const pointA = cfg?.motion?.pointA || {};
    const pointB = cfg?.motion?.pointB || {};
    const ax = _toNumber(pointA.x, 0);
    const ay = _toNumber(pointA.y, 0);
    const bx = _toNumber(pointB.x, 0);
    const by = _toNumber(pointB.y, 0);
    const localX = ax + (bx - ax) * u;
    const localY = ay + (by - ay) * u;

    const off = this._rotateFoundryLocalToWorld(localX, localY, inherited.inheritedRotation, this._tmpWorldVecA);
    const finalX = inherited.inheritedX + off.x;
    const finalY = inherited.inheritedY + off.y;

    this._applyFinalTileState(
      tileId,
      frameId,
      tileBase,
      sprite,
      finalX,
      finalY,
      inherited.inheritedRotation,
      inherited.inheritedAnimDelta
    );
  }

  _applySineTile(tileId, cfg, elapsedSec, frameId) {
    const data = this._getTileData(tileId);
    const sprite = data?.sprite;
    if (!sprite) return;

    const base = this._baseCache.get(tileId);
    if (!base) this.captureBaseTransform(tileId, sprite);
    const tileBase = this._baseCache.get(tileId);
    if (!tileBase) return;

    const inherited = this._resolveInheritedTransform(tileId, cfg, frameId, tileBase);
    const rawDeg = this._computeRawPhaseDeg(cfg, elapsedSec);
    const wave = Math.sin((rawDeg * Math.PI) / 180);

    const ampX = _toNumber(cfg?.motion?.amplitudeX, 0);
    const ampY = _toNumber(cfg?.motion?.amplitudeY, 0);
    const ampRot = _toNumber(cfg?.motion?.amplitudeRot, 0);

    const off = this._rotateFoundryLocalToWorld(ampX * wave, ampY * wave, inherited.inheritedRotation, this._tmpWorldVecA);
    const baseX = inherited.inheritedX + off.x;
    const baseY = inherited.inheritedY + off.y;
    const ownDelta = ((ampRot * wave) * Math.PI) / 180;

    const pivoted = this._applyPivotRotation(
      baseX,
      baseY,
      inherited.inheritedRotation,
      ownDelta,
      cfg?.pivot?.x,
      cfg?.pivot?.y,
      this._tmpPivotResult
    );

    this._applyFinalTileState(
      tileId,
      frameId,
      tileBase,
      sprite,
      pivoted.x,
      pivoted.y,
      pivoted.rotation,
      inherited.inheritedAnimDelta + ownDelta
    );
  }

  _applyTextureTile(tileId, cfg, elapsedSec) {
    const data = this._getTileData(tileId);
    const sprite = data?.sprite;
    const map = sprite?.material?.map;
    if (!sprite || !map) return;

    if (!this._textureBaseCache.has(tileId)) {
      this._captureBaseTextureTransform(tileId, sprite);
    }

    const baseTex = this._textureBaseCache.get(tileId);
    if (!baseTex) return;

    const tm = cfg?.textureMotion || {};
    const scrollU = _toNumber(tm.scrollU, 0);
    const scrollV = _toNumber(tm.scrollV, 0);
    const rotateSpeedDeg = _toNumber(tm.rotateSpeed, 0);
    const phaseDeg = _toNumber(cfg?.motion?.phase, 0);
    const pivotU = _clamp(_toNumber(tm.pivotU, 0.5), 0, 1);
    const pivotV = _clamp(_toNumber(tm.pivotV, 0.5), 0, 1);

    // Scrolling requires RepeatWrapping so the texture tiles instead of clamping.
    const THREE = window.THREE;
    if (THREE && (scrollU !== 0 || scrollV !== 0)) {
      if (map.wrapS !== THREE.RepeatWrapping) { map.wrapS = THREE.RepeatWrapping; map.needsUpdate = true; }
      if (map.wrapT !== THREE.RepeatWrapping) { map.wrapT = THREE.RepeatWrapping; map.needsUpdate = true; }
    }

    map.matrixAutoUpdate = true;
    map.center.set(pivotU, pivotV);
    map.offset.set(baseTex.offsetX + scrollU * elapsedSec, baseTex.offsetY + scrollV * elapsedSec);
    map.rotation = baseTex.rotation + ((phaseDeg + rotateSpeedDeg * elapsedSec) * Math.PI / 180);
    map.updateMatrix();

    this._frameActiveTileIds.add(tileId);
  }

  update(timeInfo) {
    if (!this.initialized) return;

    if (!this.state?.global?.playing) {
      this._fallbackStartEpochMs = 0;
      this._elapsedAccumSec = 0;
      this._lastUpdateNowMs = 0;
      this._lastEffectiveStartMs = 0;
      if (this._activeTileIds.size > 0) {
        this._restoreAllActiveTiles();
      }
      return;
    }

    this._requestContinuousRender(250);

    if (this._graphDirty) {
      this._rebuildRuntimeGraph();
    }

    if (this._runtimeOrder.length <= 0) {
      if (this._activeTileIds.size > 0) this._restoreAllActiveTiles();
      return;
    }

    this._frameActiveTileIds.clear();
    this._frameStamp = (this._frameStamp + 1) | 0;
    const frameId = this._frameStamp;

    const globalSpeed = _clamp(_toNumber(this.state?.global?.speedPercent, 100), 0, 400) * 0.01;
    const timeFactor = _clamp(_toNumber(this.state?.global?.timeFactorPercent, 100), 0, 200) * 0.01;
    const startEpochMs = Math.max(0, _toNumber(this.state?.global?.startEpochMs, 0));
    const nowMs = this._getNowMs();
    const effectiveStartMs = startEpochMs > 0
      ? startEpochMs
      : (this._fallbackStartEpochMs > 0 ? this._fallbackStartEpochMs : (this._fallbackStartEpochMs = nowMs));

    // Pause/slow-mo behavior:
    // - timeInfo.delta is already scaled by TimeManager.scale, so when paused it becomes 0.
    // - we advance our internal accumulator by delta (instead of recomputing from epoch),
    //   so pausing freezes the current pose instead of snapping back to t=0.
    // Sync behavior:
    // - we still seed the accumulator from the shared epoch when playback starts or when
    //   the start epoch changes (reset phase).
    if (this._lastEffectiveStartMs !== effectiveStartMs) {
      const scale = _clamp(_toNumber(timeInfo?.scale, 1), 0, 1000);
      this._elapsedAccumSec = Math.max(0, (nowMs - effectiveStartMs) * 0.001) * globalSpeed * timeFactor * scale;
      this._lastEffectiveStartMs = effectiveStartMs;
      this._lastUpdateNowMs = nowMs;
    } else {
      const dtSec = (typeof timeInfo?.delta === 'number')
        ? timeInfo.delta
        : (this._lastUpdateNowMs > 0 ? Math.max(0, (nowMs - this._lastUpdateNowMs) * 0.001) : 0);
      this._elapsedAccumSec += dtSec * globalSpeed * timeFactor;
      this._lastUpdateNowMs = nowMs;
    }

    const elapsedSec = this._elapsedAccumSec;

    for (const tileId of this._runtimeOrder) {
      const cfg = this.state?.tiles?.[tileId];
      if (!cfg?.enabled) continue;
      if (this._invalidTiles.has(tileId)) continue;

      if (cfg.mode === 'texture') {
        this._applyTextureTile(tileId, cfg, elapsedSec);
      } else {
        const motionType = cfg?.motion?.type;
        if (motionType === 'orbit') {
          this._applyOrbitTile(tileId, cfg, elapsedSec, frameId);
        } else if (motionType === 'pingPong') {
          this._applyPingPongTile(tileId, cfg, elapsedSec, frameId);
        } else if (motionType === 'sine') {
          this._applySineTile(tileId, cfg, elapsedSec, frameId);
        } else {
          this._applyRotationTile(tileId, cfg, elapsedSec, frameId);
        }
      }
    }

    for (const tileId of this._activeTileIds) {
      if (!this._frameActiveTileIds.has(tileId)) {
        this._restoreTile(tileId);
      }
    }

    const swap = this._activeTileIds;
    this._activeTileIds = this._frameActiveTileIds;
    this._frameActiveTileIds = swap;
    this._frameActiveTileIds.clear();
  }
}
