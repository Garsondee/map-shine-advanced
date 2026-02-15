/**
 * @fileoverview Token movement manager.
 *
 * Centralizes movement-style orchestration for token sprite transitions while
 * preserving Foundry's authoritative token document updates.
 *
 * Initial implementation scope:
 * - Style registry and per-token style selection
 * - Custom Pick Up and Drop track animation
 * - Door/fog policy contracts and helper APIs for upcoming phases
 *
 * @module scene/token-movement-manager
 */

import { createLogger } from '../core/log.js';

const log = createLogger('TokenMovementManager');

const MODULE_ID = 'map-shine-advanced';
const DEFAULT_STYLE = 'walk';

const DOOR_TYPES = {
  NONE: 0,
  DOOR: 1,
  SECRET: 2
};

const DOOR_STATES = {
  CLOSED: 0,
  OPEN: 1,
  LOCKED: 2
};

const FOG_PATH_POLICIES = new Set([
  'strictNoFogPath',
  'allowButRedact',
  'gmUnrestricted'
]);

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function shortestAngleDelta(from, to) {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class TokenMovementManager {
  /**
   * @param {object} [deps]
   * @param {import('./token-manager.js').TokenManager|null} [deps.tokenManager]
   * @param {import('./wall-manager.js').WallManager|null} [deps.wallManager]
   */
  constructor({ tokenManager = null, wallManager = null } = {}) {
    this.tokenManager = tokenManager;
    this.wallManager = wallManager;

    this.initialized = false;

    /** @type {Map<string, {id: string, label: string, mode: string}>} */
    this.styles = new Map();
    this._registerDefaultStyles();

    /** @type {Map<string, string>} */
    this.tokenStyleOverrides = new Map();

    /** @type {Map<string, any>} */
    this.activeTracks = new Map();

    /** @type {Array<[string, number]>} */
    this._hookIds = [];

    this._doorStateRevision = 0;
    this._inCombat = false;
    this._pathSearchGeneration = 0;

    this.settings = {
      defaultStyle: DEFAULT_STYLE,
      weightedAStarWeight: 1.15,
      fogPathPolicy: 'strictNoFogPath',
      doorPolicy: {
        autoOpen: true,
        autoClose: 'outOfCombatOnly',
        closeDelayMs: 0,
        playerAutoDoorEnabled: false,
        requireDoorPermission: true
      }
    };
  }

  /**
   * Decide whether a sequenced movement step should include Foundry's movement payload.
   * For path-walk mode, we intentionally suppress payload so Foundry does not render
   * per-step ruler/blue-grid overlays while our own path-walk choreography is running.
   *
   * @param {object} options
   * @param {object} context
   * @returns {boolean}
   */
  _shouldIncludeMovementPayloadForStep(options = {}, context = {}) {
    if (optionsBoolean(options?.suppressFoundryMovementUI, false)) return false;

    const method = String(options?.method || '').toLowerCase();
    if (method === 'path-walk' || method === 'walk') return false;

    // If caller explicitly sets includeMovementPayload, honor that override.
    if (Object.prototype.hasOwnProperty.call(options, 'includeMovementPayload')) {
      return optionsBoolean(options?.includeMovementPayload, false);
    }

    // Default behavior for legacy call sites.
    return optionsBoolean(options?.ignoreWalls, false)
      || optionsBoolean(options?.ignoreCost, false);
  }

  initialize() {
    if (this.initialized) return;

    this._evaluateCombatState();
    this._setupHooks();

    this.initialized = true;
    log.info('TokenMovementManager initialized');
  }

  dispose() {
    for (const [name, id] of this._hookIds) {
      try {
        Hooks.off(name, id);
      } catch (_) {
      }
    }
    this._hookIds.length = 0;

    for (const track of this.activeTracks.values()) {
      this._cancelTrack(track);
    }
    this.activeTracks.clear();

    // Clean up all flying hover states and their Three.js objects
    if (this._flyingTokens) {
      for (const tokenId of [...this._flyingTokens.keys()]) {
        this.clearFlyingState(tokenId);
      }
    }

    this.tokenStyleOverrides.clear();
    this.initialized = false;

    log.info('TokenMovementManager disposed');
  }

  /**
   * @param {object} deps
   * @param {import('./token-manager.js').TokenManager|null} [deps.tokenManager]
   * @param {import('./wall-manager.js').WallManager|null} [deps.wallManager]
   */
  setDependencies({ tokenManager = null, wallManager = null } = {}) {
    if (tokenManager !== null) this.tokenManager = tokenManager;
    if (wallManager !== null) this.wallManager = wallManager;
  }

  _setupHooks() {
    if (this._hookIds.length > 0) return;

    this._hookIds.push(['updateWall', Hooks.on('updateWall', () => {
      this._doorStateRevision += 1;
    })]);

    this._hookIds.push(['createWall', Hooks.on('createWall', () => {
      this._doorStateRevision += 1;
    })]);

    this._hookIds.push(['deleteWall', Hooks.on('deleteWall', () => {
      this._doorStateRevision += 1;
    })]);

    this._hookIds.push(['createCombat', Hooks.on('createCombat', () => {
      this._evaluateCombatState();
    })]);

    this._hookIds.push(['updateCombat', Hooks.on('updateCombat', () => {
      this._evaluateCombatState();
    })]);

    this._hookIds.push(['deleteCombat', Hooks.on('deleteCombat', () => {
      this._evaluateCombatState();
    })]);
  }

  _evaluateCombatState() {
    this._inCombat = !!(game?.combat?.started);
  }

  _registerDefaultStyles() {
    this.styles.set('walk', {
      id: 'walk',
      label: 'Walk',
      mode: 'delegated'
    });

    this.styles.set('pick-up-drop', {
      id: 'pick-up-drop',
      label: 'Pick Up and Drop',
      mode: 'custom'
    });

    this.styles.set('flying-glide', {
      id: 'flying-glide',
      label: 'Flying Glide (Placeholder)',
      mode: 'placeholder'
    });
  }

  /**
   * @param {string} styleId
   * @param {{id: string, label: string, mode?: string}} styleDef
   */
  registerStyle(styleId, styleDef) {
    if (!styleId || !styleDef || typeof styleDef !== 'object') return;
    this.styles.set(styleId, {
      id: styleDef.id || styleId,
      label: styleDef.label || styleId,
      mode: styleDef.mode || 'custom'
    });
  }

  /**
   * @param {string} styleId
   */
  setDefaultStyle(styleId) {
    if (!this.styles.has(styleId)) return;
    this.settings.defaultStyle = styleId;
  }

  /**
   * @param {string} tokenId
   * @param {string|null} styleId
   */
  setTokenStyleOverride(tokenId, styleId) {
    if (!tokenId) return;
    if (!styleId) {
      this.tokenStyleOverrides.delete(tokenId);
      return;
    }
    if (!this.styles.has(styleId)) return;
    this.tokenStyleOverrides.set(tokenId, styleId);
  }

  /**
   * @param {TokenDocument} tokenDoc
   * @param {object} [options]
   * @returns {string}
   */
  getStyleForToken(tokenDoc, options = {}) {
    const explicit = options?.mapShineMovementStyle;
    if (explicit && this.styles.has(explicit)) return explicit;

    const tokenId = tokenDoc?.id;
    if (tokenId && this.tokenStyleOverrides.has(tokenId)) {
      return this.tokenStyleOverrides.get(tokenId);
    }

    try {
      const flagged = tokenDoc?.getFlag?.(MODULE_ID, 'movementStyle');
      if (flagged && this.styles.has(flagged)) return flagged;
    } catch (_) {
    }

    const fallback = this.settings.defaultStyle;
    return this.styles.has(fallback) ? fallback : DEFAULT_STYLE;
  }

  /**
   * Called by TokenManager when an authoritative token transform update arrives.
   *
   * @param {object} payload
   * @param {THREE.Sprite} payload.sprite
   * @param {TokenDocument} payload.tokenDoc
   * @param {object} payload.targetDoc
   * @param {object} [payload.changes]
   * @param {object} [payload.options]
   * @param {boolean} [payload.animate]
   * @param {() => void} payload.fallback
   * @returns {boolean} true if handled (including delegated fallback), false if caller should fallback itself
   */
  handleTokenSpriteUpdate(payload) {
    const {
      sprite,
      tokenDoc,
      targetDoc,
      options = {},
      animate = true,
      fallback
    } = payload || {};

    if (!sprite || !tokenDoc || !targetDoc || typeof fallback !== 'function') return false;

    const styleId = this.getStyleForToken(tokenDoc, options);
    const tokenId = tokenDoc.id;
    let existingTrack = this.activeTracks.get(tokenId);

    // If movement style changed, clear stale track state before applying the
    // next behavior so two animation systems never fight over the same sprite.
    if (existingTrack && existingTrack.styleId !== styleId) {
      this._cancelTrack(existingTrack);
      this.activeTracks.delete(tokenId);
      existingTrack = null;
    }

    // If style changed away from flying, clear any lingering hover state.
    if (styleId !== 'flying-glide' && this.isFlying(tokenId)) {
      this.clearFlyingState(tokenId);
    }

    // Unknown styles keep existing fallback animation behavior for compatibility.
    if (styleId !== 'walk' && styleId !== 'pick-up-drop' && styleId !== 'flying-glide') {
      if (existingTrack) {
        this._cancelTrack(existingTrack);
        this.activeTracks.delete(tokenId);
      }
      fallback();
      return true;
    }

    if (!animate) {
      if (existingTrack) {
        this._cancelTrack(existingTrack);
        this.activeTracks.delete(tokenId);
      }

      if (styleId === 'flying-glide') {
        const target = this._computeTargetTransform(targetDoc);
        if (!target) {
          fallback();
          return true;
        }

        const hoverHeight = asNumber(options?.mapShineHoverHeight, target.gridSize * 0.35);
        const rockAmplitudeDeg = asNumber(options?.mapShineRockAmplitudeDeg, 3);
        const rockSpeedHz = asNumber(options?.mapShineRockSpeedHz, 0.4);

        if (!this.isFlying(tokenId)) {
          this.setFlyingState(tokenId, { hoverHeight, rockAmplitudeDeg, rockSpeedHz });
        }

        const state = this.flyingTokens.get(tokenId);
        if (state) {
          state.hoverHeight = hoverHeight;
          state.baseZ = target.z;
          state.baseRotation = target.rotation;
        }

        sprite.position.set(target.x, target.y, target.z + hoverHeight);
        sprite.scale.set(target.scaleX, target.scaleY, 1);
        if (sprite.material && !state) sprite.material.rotation = target.rotation;
        if (sprite.matrixAutoUpdate === false) sprite.updateMatrix();
        return true;
      }

      if (styleId === 'walk' || styleId === 'pick-up-drop') {
        const target = this._computeTargetTransform(targetDoc);
        if (!target) {
          fallback();
          return true;
        }
        sprite.position.set(target.x, target.y, target.z);
        sprite.scale.set(target.scaleX, target.scaleY, 1);
        if (sprite.material) sprite.material.rotation = target.rotation;
        if (sprite.matrixAutoUpdate === false) sprite.updateMatrix();
        return true;
      }

      fallback();
      return true;
    }

    const target = this._computeTargetTransform(targetDoc);
    if (!target) {
      fallback();
      return true;
    }

    // Keep scale updates immediate to avoid one-frame stretching artifacts.
    sprite.scale.set(target.scaleX, target.scaleY, 1);
    if (sprite.matrixAutoUpdate === false) sprite.updateMatrix();

    if (styleId === 'flying-glide') {
      this._startFlyingGlideTrack({
        tokenId,
        sprite,
        target,
        options
      });
      return true;
    }

    if (styleId === 'walk') {
      this._startWalkTrack({
        tokenId,
        sprite,
        target,
        options
      });
      return true;
    }

    const dx = target.x - sprite.position.x;
    const dy = target.y - sprite.position.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) {
      fallback();
      return true;
    }

    this._startPickUpDropTrack({
      tokenId,
      sprite,
      target,
      options
    });

    return true;
  }

  /**
   * @param {object} input
   * @param {string} input.tokenId
   * @param {THREE.Sprite} input.sprite
   * @param {{x:number,y:number,z:number,scaleX:number,scaleY:number,rotation:number,gridSize:number}} input.target
   * @param {object} [input.options]
   */
  _startPickUpDropTrack({ tokenId, sprite, target, options = {} }) {
    if (!tokenId || !sprite || !target) return;

    const existing = this.activeTracks.get(tokenId);
    if (existing) this._cancelTrack(existing);

    const startX = asNumber(sprite.position.x, target.x);
    const startY = asNumber(sprite.position.y, target.y);
    const startZ = asNumber(sprite.position.z, target.z);
    const startRotation = asNumber(sprite.material?.rotation, target.rotation);

    const distance = Math.hypot(target.x - startX, target.y - startY);
    const gridSize = Math.max(1, asNumber(target.gridSize, 100));

    const durationMs = clamp(
      asNumber(options?.mapShineDurationMs, (distance / gridSize) * 300 + 260),
      250,
      2200
    );

    const arcHeight = clamp(
      asNumber(options?.mapShineArcHeight, Math.max(gridSize * 0.45, distance * 0.22)),
      8,
      gridSize * 4
    );

    try {
      this.tokenManager?.emitTokenMovementStart?.(tokenId);
    } catch (_) {
    }

    try {
      const rl = window.MapShine?.renderLoop;
      if (rl?.requestContinuousRender) rl.requestContinuousRender(durationMs + 80);
      else rl?.requestRender?.();
    } catch (_) {
    }

    this.activeTracks.set(tokenId, {
      tokenId,
      styleId: 'pick-up-drop',
      sprite,
      startX,
      startY,
      startZ,
      startRotation,
      target,
      durationSec: durationMs / 1000,
      elapsedSec: 0,
      arcHeight
    });
  }

  /**
   * @param {object} input
   * @param {string} input.tokenId
   * @param {THREE.Sprite} input.sprite
   * @param {{x:number,y:number,z:number,scaleX:number,scaleY:number,rotation:number,gridSize:number}} input.target
   * @param {object} [input.options]
   */
  _startWalkTrack({ tokenId, sprite, target, options = {} }) {
    if (!tokenId || !sprite || !target) return;

    const existing = this.activeTracks.get(tokenId);
    if (existing) this._cancelTrack(existing);

    const startX = asNumber(sprite.position.x, target.x);
    const startY = asNumber(sprite.position.y, target.y);
    const startZ = asNumber(sprite.position.z, target.z);
    const startRotation = asNumber(sprite.material?.rotation, target.rotation);

    const distance = Math.hypot(target.x - startX, target.y - startY);
    const gridSize = Math.max(1, asNumber(target.gridSize, 100));

    const durationMs = clamp(
      asNumber(options?.mapShineWalkDurationMs, (distance / gridSize) * 290 + 120),
      120,
      1500
    );
    const bobAmplitude = clamp(
      asNumber(options?.mapShineWalkBobAmplitude, Math.max(0.6, gridSize * 0.012)),
      0,
      8
    );
    const bobCycles = clamp(
      asNumber(options?.mapShineWalkBobCycles, Math.max(1, distance / Math.max(1, gridSize))),
      0,
      12
    );

    try {
      this.tokenManager?.emitTokenMovementStart?.(tokenId);
    } catch (_) {
    }

    try {
      const rl = window.MapShine?.renderLoop;
      if (rl?.requestContinuousRender) rl.requestContinuousRender(durationMs + 80);
      else rl?.requestRender?.();
    } catch (_) {
    }

    this.activeTracks.set(tokenId, {
      tokenId,
      styleId: 'walk',
      sprite,
      startX,
      startY,
      startZ,
      startRotation,
      target,
      durationSec: durationMs / 1000,
      elapsedSec: 0,
      bobAmplitude,
      bobCycles
    });
  }

  /**
   * @param {object} input
   * @param {string} input.tokenId
   * @param {THREE.Sprite} input.sprite
   * @param {{x:number,y:number,z:number,scaleX:number,scaleY:number,rotation:number,gridSize:number}} input.target
   * @param {object} [input.options]
   */
  _startFlyingGlideTrack({ tokenId, sprite, target, options = {} }) {
    if (!tokenId || !sprite || !target) return;

    const existing = this.activeTracks.get(tokenId);
    if (existing) this._cancelTrack(existing);

    const fallbackHover = Math.max(10, asNumber(target.gridSize, 100) * 0.35);
    const hoverHeight = asNumber(options?.mapShineHoverHeight, fallbackHover);
    const rockAmplitudeDeg = asNumber(options?.mapShineRockAmplitudeDeg, 3);
    const rockSpeedHz = asNumber(options?.mapShineRockSpeedHz, 0.4);

    if (!this.isFlying(tokenId)) {
      this.setFlyingState(tokenId, { hoverHeight, rockAmplitudeDeg, rockSpeedHz });
    }

    const flyingState = this.flyingTokens.get(tokenId);
    if (flyingState) {
      flyingState.hoverHeight = hoverHeight;
      flyingState.rockAmplitudeRad = (rockAmplitudeDeg * Math.PI) / 180;
      flyingState.rockSpeedHz = rockSpeedHz;
    }

    const startX = asNumber(sprite.position.x, target.x);
    const startY = asNumber(sprite.position.y, target.y);
    const startGroundZ = asNumber(sprite.position.z - hoverHeight, target.z);
    const startRotation = asNumber(flyingState?.baseRotation, asNumber(sprite.material?.rotation, target.rotation));

    const distance = Math.hypot(target.x - startX, target.y - startY);
    const gridSize = Math.max(1, asNumber(target.gridSize, 100));

    const durationMs = clamp(
      asNumber(options?.mapShineDurationMs, (distance / gridSize) * 260 + 220),
      180,
      1800
    );

    try {
      this.tokenManager?.emitTokenMovementStart?.(tokenId);
    } catch (_) {
    }

    try {
      const rl = window.MapShine?.renderLoop;
      if (rl?.requestContinuousRender) rl.requestContinuousRender(durationMs + 60);
      else rl?.requestRender?.();
    } catch (_) {
    }

    this.activeTracks.set(tokenId, {
      tokenId,
      styleId: 'flying-glide',
      sprite,
      startX,
      startY,
      startGroundZ,
      startRotation,
      target,
      hoverHeight,
      durationSec: durationMs / 1000,
      elapsedSec: 0
    });
  }

  /**
   * @param {any} track
   * @param {number} tNorm
   */
  _sampleFlyingGlideTrack(track, tNorm) {
    const sprite = track?.sprite;
    if (!sprite) return;

    const x = track.startX + (track.target.x - track.startX) * tNorm;
    const y = track.startY + (track.target.y - track.startY) * tNorm;
    const baseZ = track.startGroundZ + (track.target.z - track.startGroundZ) * tNorm;

    const rotDelta = shortestAngleDelta(track.startRotation, track.target.rotation);
    const baseRotation = track.startRotation + (rotDelta * tNorm);

    const state = this.flyingTokens.get(track.tokenId);
    if (state) {
      state.baseZ = baseZ;
      state.baseRotation = baseRotation;
      state.hoverHeight = asNumber(track.hoverHeight, state.hoverHeight);
    } else if (sprite.material) {
      // Fallback if hover state was externally cleared mid-track.
      sprite.material.rotation = baseRotation;
    }

    const hoverHeight = asNumber(track.hoverHeight, 0);
    sprite.position.set(x, y, baseZ + hoverHeight);
    if (sprite.matrixAutoUpdate === false) sprite.updateMatrix();
  }

  /**
   * @param {object} timeInfo
   */
  update(timeInfo) {
    const deltaSec = Math.max(0, asNumber(timeInfo?.delta, 0));
    if (deltaSec <= 0) return;

    if (this.activeTracks.size > 0) {
      for (const [tokenId, track] of this.activeTracks) {
        const sprite = track?.sprite;
        if (!sprite || sprite.userData?._removed) {
          this.activeTracks.delete(tokenId);
          continue;
        }

        track.elapsedSec += deltaSec;
        const tNorm = clamp(track.elapsedSec / Math.max(track.durationSec, 0.0001), 0, 1);

        if (track.styleId === 'flying-glide') {
          this._sampleFlyingGlideTrack(track, tNorm);
        } else if (track.styleId === 'walk') {
          const easedT = (tNorm * tNorm) * (3 - (2 * tNorm));
          const x = track.startX + (track.target.x - track.startX) * easedT;
          const y = track.startY + (track.target.y - track.startY) * easedT;
          const z = track.startZ + (track.target.z - track.startZ) * easedT
            + (Math.sin(easedT * Math.PI * 2 * asNumber(track.bobCycles, 0))
              * asNumber(track.bobAmplitude, 0)
              * (1 - tNorm));

          const rotDelta = shortestAngleDelta(track.startRotation, track.target.rotation);
          const rotation = track.startRotation + (rotDelta * easedT);

          sprite.position.set(x, y, z);
          if (sprite.material) sprite.material.rotation = rotation;
          if (sprite.matrixAutoUpdate === false) sprite.updateMatrix();
        } else {
          const x = track.startX + (track.target.x - track.startX) * tNorm;
          const y = track.startY + (track.target.y - track.startY) * tNorm;
          const baseZ = track.startZ + (track.target.z - track.startZ) * tNorm;
          const z = baseZ + (Math.sin(Math.PI * tNorm) * track.arcHeight);

          const rotDelta = shortestAngleDelta(track.startRotation, track.target.rotation);
          const rotation = track.startRotation + (rotDelta * tNorm);

          sprite.position.set(x, y, z);
          if (sprite.material) sprite.material.rotation = rotation;
          if (sprite.matrixAutoUpdate === false) sprite.updateMatrix();
        }

        if (tNorm >= 1) {
          this._finalizeTrack(track);
          this.activeTracks.delete(tokenId);
        }
      }
    }

    // Apply hover rocking after track interpolation so each frame settles to
    // the latest base pose before adding the rocking offset.
    this._updateFlyingTokens(deltaSec);
  }

  /**
   * @param {any} track
   */
  _cancelTrack(track) {
    if (!track?.sprite) return;
    // Intentionally no snap on cancel; next movement update will drive pose.
  }

  /**
   * @param {any} track
   */
  _finalizeTrack(track) {
    const sprite = track?.sprite;
    if (!sprite) return;

    if (track.styleId === 'flying-glide') {
      const hoverHeight = asNumber(track.hoverHeight, 0);
      const baseZ = asNumber(track.target?.z, sprite.position.z - hoverHeight);
      const baseRotation = asNumber(track.target?.rotation, asNumber(sprite.material?.rotation, 0));

      const flyingState = this.flyingTokens.get(track.tokenId);
      if (flyingState) {
        flyingState.baseZ = baseZ;
        flyingState.baseRotation = baseRotation;
        flyingState.hoverHeight = hoverHeight;
      } else if (sprite.material) {
        sprite.material.rotation = baseRotation;
      }

      sprite.position.set(track.target.x, track.target.y, baseZ + hoverHeight);
      sprite.scale.set(track.target.scaleX, track.target.scaleY, 1);
      if (sprite.matrixAutoUpdate === false) sprite.updateMatrix();
      return;
    }

    sprite.position.set(track.target.x, track.target.y, track.target.z);
    sprite.scale.set(track.target.scaleX, track.target.scaleY, 1);
    if (sprite.material) sprite.material.rotation = track.target.rotation;
    if (sprite.matrixAutoUpdate === false) sprite.updateMatrix();
  }

  /**
   * @param {TokenDocument|object} tokenDoc
   * @returns {{x:number,y:number,z:number,scaleX:number,scaleY:number,rotation:number,gridSize:number}|null}
   */
  _computeTargetTransform(tokenDoc) {
    const grid = canvas?.grid;
    const gridSizeX = (grid && typeof grid.sizeX === 'number' && grid.sizeX > 0)
      ? grid.sizeX
      : ((grid && typeof grid.size === 'number' && grid.size > 0) ? grid.size : 100);
    const gridSizeY = (grid && typeof grid.sizeY === 'number' && grid.sizeY > 0)
      ? grid.sizeY
      : ((grid && typeof grid.size === 'number' && grid.size > 0) ? grid.size : 100);
    const gridSize = Math.max(gridSizeX, gridSizeY);

    const width = asNumber(tokenDoc?.width, 1);
    const height = asNumber(tokenDoc?.height, 1);

    const scaleX = asNumber(tokenDoc?.texture?.scaleX, 1);
    const scaleY = asNumber(tokenDoc?.texture?.scaleY, 1);

    const widthPx = width * gridSizeX * scaleX;
    const heightPx = height * gridSizeY * scaleY;

    const rectWidth = width * gridSizeX;
    const rectHeight = height * gridSizeY;

    const x = asNumber(tokenDoc?.x, 0) + rectWidth / 2;
    const sceneHeight = canvas?.dimensions?.height || 10000;
    const y = sceneHeight - (asNumber(tokenDoc?.y, 0) + rectHeight / 2);

    const elevation = asNumber(tokenDoc?.elevation, 0);
    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
    const z = groundZ + 0.06 + elevation;

    const THREE = window.THREE;
    const rotationDeg = asNumber(tokenDoc?.rotation, 0);
    const rotation = THREE ? THREE.MathUtils.degToRad(rotationDeg) : (rotationDeg * (Math.PI / 180));

    return {
      x,
      y,
      z,
      scaleX: widthPx,
      scaleY: heightPx,
      rotation,
      gridSize
    };
  }

  // ── TM-2: Weighted A* Pathfinding Core ───────────────────────────────────

  /**
   * Create a cancellable token for long-running path generation/search.
   *
   * @returns {{cancelled: boolean, cancel: () => void}}
   */
  createPathCancelToken() {
    const token = {
      cancelled: false,
      cancel: () => {
        token.cancelled = true;
      }
    };
    return token;
  }

  /**
   * Invalidate active searches so subsequent cancellation checks abort quickly.
   */
  cancelActivePathSearches() {
    this._pathSearchGeneration += 1;
  }

  /**
   * Build a traversable movement graph for weighted A* search.
   *
   * Coordinate space: Foundry/world (top-left origin, Y-down).
   *
   * @param {object} params
   * @param {{x:number,y:number}} params.start
   * @param {{x:number,y:number}} params.end
   * @param {TokenDocument|object|null} [params.tokenDoc]
   * @param {object} [params.options]
   * @param {{cancelled:boolean}|null} [params.cancelToken]
   * @returns {{ok:boolean, nodes: Map<string, {x:number,y:number,key:string}>, adjacency: Map<string, Array<{toKey:string,cost:number}>>, startKey:string, endKey:string, reason?:string, diagnostics?:object}}
   */
  generateMovementGraph({ start, end, tokenDoc = null, options = {}, cancelToken = null } = {}) {
    const generation = ++this._pathSearchGeneration;
    const context = this._buildPathContext(start, end, tokenDoc, options);
    if (!context) {
      return {
        ok: false,
        nodes: new Map(),
        adjacency: new Map(),
        startKey: '',
        endKey: '',
        reason: 'invalid-input'
      };
    }

    const nodes = new Map();
    const adjacency = new Map();
    const queue = [];

    const startNode = context.startNode;
    const endNode = context.endNode;
    const startKey = startNode.key;
    const endKey = endNode.key;

    nodes.set(startKey, startNode);
    queue.push(startNode);

    const maxNodes = Math.max(128, asNumber(options?.maxGraphNodes, 6000));
    let truncated = false;
    let edgesAccepted = 0;

    for (let i = 0; i < queue.length; i++) {
      if ((i & 31) === 0 && this._isPathSearchCancelled(cancelToken, generation, options?.shouldCancel)) {
        return {
          ok: false,
          nodes,
          adjacency,
          startKey,
          endKey,
          reason: 'cancelled',
          diagnostics: {
            expanded: i,
            nodeCount: nodes.size,
            edgeCount: edgesAccepted
          }
        };
      }

      if (nodes.size >= maxNodes) {
        truncated = true;
        break;
      }

      const node = queue[i];
      const neighbors = this._getCandidateNeighbors(node, context);
      if (!neighbors || neighbors.length === 0) continue;

      let edges = adjacency.get(node.key);
      if (!edges) {
        edges = [];
        adjacency.set(node.key, edges);
      }

      for (const neighbor of neighbors) {
        if (!this._isWithinSearchBounds(neighbor, context.bounds)) continue;
        if (!this._isNodeTraversable(neighbor, context)) continue;

        const collision = this._validatePathSegmentCollision(node, neighbor, context);
        if (!collision.ok) continue;

        const stepCost = this._computeTraversalCost(node, neighbor, context);
        if (!Number.isFinite(stepCost) || stepCost <= 0) continue;

        edges.push({ toKey: neighbor.key, cost: stepCost });
        edgesAccepted += 1;

        if (!nodes.has(neighbor.key)) {
          nodes.set(neighbor.key, neighbor);
          queue.push(neighbor);
        }
      }
    }

    // Ensure end node exists so A* can terminate when discovered by an edge.
    if (!nodes.has(endKey)) {
      nodes.set(endKey, endNode);
    }

    return {
      ok: true,
      nodes,
      adjacency,
      startKey,
      endKey,
      diagnostics: {
        truncated,
        nodeCount: nodes.size,
        edgeCount: edgesAccepted,
        maxNodes
      }
    };
  }

  /**
   * Find a weighted A* path in Foundry coordinate space.
   *
   * @param {object} params
   * @param {{x:number,y:number}} params.start
   * @param {{x:number,y:number}} params.end
   * @param {TokenDocument|object|null} [params.tokenDoc]
   * @param {object} [params.options]
   * @param {{cancelled:boolean}|null} [params.cancelToken]
   * @returns {{ok:boolean, pathNodes:Array<{x:number,y:number}>, reason?:string, diagnostics?:object}}
   */
  findWeightedPath({ start, end, tokenDoc = null, options = {}, cancelToken = null } = {}) {
    const graph = this.generateMovementGraph({
      start,
      end,
      tokenDoc,
      options,
      cancelToken
    });

    if (!graph.ok) {
      return {
        ok: false,
        pathNodes: [],
        reason: graph.reason || 'graph-generation-failed',
        diagnostics: graph.diagnostics
      };
    }

    const weight = clamp(asNumber(options?.weight, this.settings.weightedAStarWeight), 1, 4);
    const maxIterations = Math.max(64, asNumber(options?.maxSearchIterations, 12000));
    const generation = this._pathSearchGeneration;

    const openSet = new Set([graph.startKey]);
    const cameFrom = new Map();
    const gScore = new Map([[graph.startKey, 0]]);
    const fScore = new Map([[graph.startKey, this._heuristicScore(graph.startKey, graph.endKey, graph.nodes, options) * weight]]);

    let iterations = 0;

    while (openSet.size > 0) {
      if ((iterations & 31) === 0 && this._isPathSearchCancelled(cancelToken, generation, options?.shouldCancel)) {
        return {
          ok: false,
          pathNodes: [],
          reason: 'cancelled',
          diagnostics: {
            iterations,
            openSetSize: openSet.size,
            graphDiagnostics: graph.diagnostics
          }
        };
      }

      if (iterations >= maxIterations) {
        return {
          ok: false,
          pathNodes: [],
          reason: 'max-iterations',
          diagnostics: {
            iterations,
            maxIterations,
            openSetSize: openSet.size,
            graphDiagnostics: graph.diagnostics
          }
        };
      }
      iterations += 1;

      const currentKey = this._selectOpenSetBestNode(openSet, fScore);
      if (!currentKey) break;

      if (currentKey === graph.endKey) {
        const pathNodes = this._reconstructPathNodes(cameFrom, currentKey, graph.nodes);
        return {
          ok: true,
          pathNodes,
          diagnostics: {
            iterations,
            weight,
            graphDiagnostics: graph.diagnostics
          }
        };
      }

      openSet.delete(currentKey);
      const neighbors = graph.adjacency.get(currentKey) || [];
      if (neighbors.length === 0) continue;

      const currentG = gScore.get(currentKey) ?? Number.POSITIVE_INFINITY;
      for (const edge of neighbors) {
        const tentativeG = currentG + asNumber(edge.cost, Number.POSITIVE_INFINITY);
        const neighborG = gScore.get(edge.toKey) ?? Number.POSITIVE_INFINITY;
        if (tentativeG >= neighborG) continue;

        cameFrom.set(edge.toKey, currentKey);
        gScore.set(edge.toKey, tentativeG);

        const h = this._heuristicScore(edge.toKey, graph.endKey, graph.nodes, options);
        fScore.set(edge.toKey, tentativeG + (weight * h));
        openSet.add(edge.toKey);
      }
    }

    return {
      ok: false,
      pathNodes: [],
      reason: 'no-path',
      diagnostics: {
        iterations,
        weight,
        graphDiagnostics: graph.diagnostics
      }
    };
  }

  /**
   * @param {{x:number,y:number}} start
   * @param {{x:number,y:number}} end
   * @param {TokenDocument|object|null} tokenDoc
   * @param {object} options
   * @returns {object|null}
   */
  _buildPathContext(start, end, tokenDoc, options) {
    const startX = asNumber(start?.x, NaN);
    const startY = asNumber(start?.y, NaN);
    const endX = asNumber(end?.x, NaN);
    const endY = asNumber(end?.y, NaN);
    if (!Number.isFinite(startX) || !Number.isFinite(startY) || !Number.isFinite(endX) || !Number.isFinite(endY)) {
      return null;
    }

    const grid = canvas?.grid;
    const dimensions = canvas?.dimensions;
    const sceneRect = dimensions?.sceneRect || {
      x: 0,
      y: 0,
      width: asNumber(dimensions?.width, 0),
      height: asNumber(dimensions?.height, 0)
    };

    const gridSize = Math.max(1, asNumber(grid?.size, 100));
    const gridSizeX = Math.max(1, asNumber(grid?.sizeX, gridSize));
    const gridSizeY = Math.max(1, asNumber(grid?.sizeY, gridSize));
    const gridType = asNumber(grid?.type, 1);

    const marginPx = Math.max(gridSize * 3, asNumber(options?.searchMarginPx, 260));
    const bounds = {
      minX: Math.max(sceneRect.x, Math.min(startX, endX) - marginPx),
      maxX: Math.min(sceneRect.x + sceneRect.width, Math.max(startX, endX) + marginPx),
      minY: Math.max(sceneRect.y, Math.min(startY, endY) - marginPx),
      maxY: Math.min(sceneRect.y + sceneRect.height, Math.max(startY, endY) + marginPx)
    };

    const latticeStep = Math.max(8, asNumber(options?.latticeStepPx, Math.max(24, gridSize * 0.5)));

    const snappedStart = this._snapPointToTraversalGrid({ x: startX, y: startY }, { gridType, grid, latticeStep });
    const snappedEnd = this._snapPointToTraversalGrid({ x: endX, y: endY }, { gridType, grid, latticeStep });

    const makeNode = (point) => {
      const x = asNumber(point?.x, 0);
      const y = asNumber(point?.y, 0);
      return {
        x,
        y,
        key: this._pointKey(x, y)
      };
    };

    return {
      tokenDoc,
      options,
      grid,
      gridType,
      gridSize,
      gridSizeX,
      gridSizeY,
      latticeStep,
      bounds,
      sceneRect,
      startNode: makeNode(snappedStart),
      endNode: makeNode(snappedEnd)
    };
  }

  /**
   * @param {number} x
   * @param {number} y
   * @returns {string}
   */
  _pointKey(x, y) {
    return `${Math.round(x)}:${Math.round(y)}`;
  }

  /**
   * @param {{x:number,y:number}} point
   * @param {{gridType:number,grid:any,latticeStep:number}} options
   * @returns {{x:number,y:number}}
   */
  _snapPointToTraversalGrid(point, { gridType, grid, latticeStep }) {
    const p = {
      x: asNumber(point?.x, 0),
      y: asNumber(point?.y, 0)
    };

    const gridTypes = globalThis.CONST?.GRID_TYPES || {};
    const isGridless = gridType === gridTypes.GRIDLESS;
    if (isGridless) {
      return {
        x: Math.round(p.x / latticeStep) * latticeStep,
        y: Math.round(p.y / latticeStep) * latticeStep
      };
    }

    try {
      if (grid && typeof grid.getSnappedPoint === 'function') {
        const snapMode = globalThis.CONST?.GRID_SNAPPING_MODES?.CENTER;
        return grid.getSnappedPoint(p, snapMode !== undefined ? { mode: snapMode } : undefined);
      }
    } catch (_) {
    }

    return {
      x: Math.round(p.x),
      y: Math.round(p.y)
    };
  }

  /**
   * @param {{x:number,y:number,key:string}} node
   * @param {object} context
   * @returns {Array<{x:number,y:number,key:string}>}
   */
  _getCandidateNeighbors(node, context) {
    const gridType = context.gridType;
    const gridTypes = globalThis.CONST?.GRID_TYPES || {};
    const gridless = gridType === gridTypes.GRIDLESS;

    if (gridless) {
      const step = context.latticeStep;
      const offsets = [
        [step, 0],
        [-step, 0],
        [0, step],
        [0, -step],
        [step, step],
        [step, -step],
        [-step, step],
        [-step, -step]
      ];
      return this._buildNeighborNodesFromOffsets(node, offsets, context);
    }

    const isHex = gridType === gridTypes.HEXODDR
      || gridType === gridTypes.HEXEVENR
      || gridType === gridTypes.HEXODDQ
      || gridType === gridTypes.HEXEVENQ;

    if (isHex) {
      const radius = Math.max(context.gridSizeX, context.gridSizeY);
      const dedupe = new Map();
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i;
        const raw = {
          x: node.x + Math.cos(angle) * radius,
          y: node.y + Math.sin(angle) * radius
        };
        const snapped = this._snapPointToTraversalGrid(raw, {
          gridType: context.gridType,
          grid: context.grid,
          latticeStep: context.latticeStep
        });
        const key = this._pointKey(snapped.x, snapped.y);
        if (key === node.key) continue;
        dedupe.set(key, {
          x: snapped.x,
          y: snapped.y,
          key
        });
      }
      return [...dedupe.values()];
    }

    const allowDiagonal = optionsBoolean(context.options?.allowDiagonal, true);
    const sx = context.gridSizeX;
    const sy = context.gridSizeY;
    const offsets = [
      [sx, 0],
      [-sx, 0],
      [0, sy],
      [0, -sy]
    ];
    if (allowDiagonal) {
      offsets.push([sx, sy], [sx, -sy], [-sx, sy], [-sx, -sy]);
    }

    return this._buildNeighborNodesFromOffsets(node, offsets, context);
  }

  /**
   * @param {{x:number,y:number,key:string}} node
   * @param {Array<[number, number]>} offsets
   * @param {object} context
   * @returns {Array<{x:number,y:number,key:string}>}
   */
  _buildNeighborNodesFromOffsets(node, offsets, context) {
    const out = [];
    const seen = new Set();
    for (const [dx, dy] of offsets) {
      const raw = { x: node.x + dx, y: node.y + dy };
      const snapped = this._snapPointToTraversalGrid(raw, {
        gridType: context.gridType,
        grid: context.grid,
        latticeStep: context.latticeStep
      });
      const key = this._pointKey(snapped.x, snapped.y);
      if (key === node.key || seen.has(key)) continue;
      seen.add(key);
      out.push({ x: snapped.x, y: snapped.y, key });
    }
    return out;
  }

  /**
   * @param {{x:number,y:number}} point
   * @param {{minX:number,maxX:number,minY:number,maxY:number}} bounds
   * @returns {boolean}
   */
  _isWithinSearchBounds(point, bounds) {
    const x = asNumber(point?.x, NaN);
    const y = asNumber(point?.y, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
  }

  /**
   * @param {{x:number,y:number,key:string}} node
   * @param {object} context
   * @returns {boolean}
   */
  _isNodeTraversable(node, context) {
    if (!this._isWithinSearchBounds(node, context.bounds)) return false;

    const fogPolicy = context.options?.fogPathPolicy || this.settings.fogPathPolicy;
    if (fogPolicy === 'strictNoFogPath') {
      if (!game?.user?.isGM && !this.isPointVisibleToPlayer(node)) {
        const isStart = node.key === context.startNode.key;
        const isEnd = node.key === context.endNode.key;
        if (!isStart && !isEnd) return false;
      }
    }

    return true;
  }

  /**
   * Validate a movement edge against Foundry collision checks.
   *
   * @param {{x:number,y:number}} from
   * @param {{x:number,y:number}} to
   * @param {object} context
   * @returns {{ok:boolean, reason?:string}}
   */
  _validatePathSegmentCollision(from, to, context) {
    if (optionsBoolean(context.options?.ignoreWalls, false)) return { ok: true };

    const tokenObj = context.tokenDoc?.object || canvas?.tokens?.get?.(context.tokenDoc?.id) || null;
    const polygonBackends = CONFIG?.Canvas?.polygonBackends;
    const rayA = { x: asNumber(from?.x, 0), y: asNumber(from?.y, 0) };
    const rayB = { x: asNumber(to?.x, 0), y: asNumber(to?.y, 0) };

    // Critical: collision must be tested per candidate graph segment (rayA -> rayB).
    // token.checkCollision(target) is origin-implicit (token's live document position),
    // which collapses A* expansion at the first wall and prevents routing around it.
    if (polygonBackends) {
      const backendTypes = ['move', 'sight', 'light'];
      for (const type of backendTypes) {
        const backend = polygonBackends?.[type];
        if (!backend || typeof backend.testCollision !== 'function') continue;
        try {
          const hit = backend.testCollision(rayA, rayB, {
            mode: context.options?.collisionMode || 'closest',
            type,
            source: tokenObj,
            token: tokenObj,
            wallDirectionMode: 'all'
          });
          if (hit) return { ok: false, reason: `collision-${type}` };
        } catch (_) {
        }
        if (type === 'move') break;
      }
      return { ok: true };
    }

    // Fallback only when polygon backends are unavailable.
    const target = { x: rayB.x, y: rayB.y };
    try {
      if (tokenObj && typeof tokenObj.checkCollision === 'function') {
        const mode = context.options?.collisionMode || 'closest';
        const hit = tokenObj.checkCollision(target, {
          mode,
          type: 'move',
          origin: rayA
        });
        if (hit) return { ok: false, reason: 'collision-move' };
      }
    } catch (_) {
    }

    return { ok: true };
  }

  /**
   * @param {{x:number,y:number}} from
   * @param {{x:number,y:number}} to
   * @param {object} context
   * @returns {number}
   */
  _computeTraversalCost(from, to, context) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    if (!Number.isFinite(distance) || distance <= 0) return Number.POSITIVE_INFINITY;

    if (optionsBoolean(context.options?.ignoreCost, false)) {
      return distance;
    }

    let multiplier = 1;

    const terrainCostProvider = context.options?.terrainCostProvider;
    if (typeof terrainCostProvider === 'function') {
      try {
        const terrainMultiplier = asNumber(terrainCostProvider(from, to, context.tokenDoc), 1);
        if (Number.isFinite(terrainMultiplier) && terrainMultiplier > 0) {
          multiplier *= terrainMultiplier;
        }
      } catch (_) {
      }
    }

    let doorPenalty = 0;
    const doorHits = this.findDoorsAlongSegment(from, to);
    for (const hit of doorHits) {
      if (hit.ds === DOOR_STATES.OPEN) continue;

      // Locked door is a hard blocker unless user is GM.
      if (hit.ds === DOOR_STATES.LOCKED && !game?.user?.isGM) {
        return Number.POSITIVE_INFINITY;
      }

      // Closed/secret-but-known doors add a finite interaction penalty.
      doorPenalty += context.gridSize * 0.25;
    }

    const occupancyPenaltyProvider = context.options?.occupancyPenaltyProvider;
    if (typeof occupancyPenaltyProvider === 'function') {
      try {
        const occupancyPenalty = asNumber(occupancyPenaltyProvider(from, to, context.tokenDoc), 0);
        if (Number.isFinite(occupancyPenalty) && occupancyPenalty > 0) {
          doorPenalty += occupancyPenalty;
        }
      } catch (_) {
      }
    }

    return (distance * multiplier) + doorPenalty;
  }

  /**
   * @param {string} fromKey
   * @param {string} toKey
   * @param {Map<string, {x:number,y:number}>} nodes
   * @param {object} options
   * @returns {number}
   */
  _heuristicScore(fromKey, toKey, nodes, options) {
    const a = nodes.get(fromKey);
    const b = nodes.get(toKey);
    if (!a || !b) return Number.POSITIVE_INFINITY;

    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    const allowDiagonal = optionsBoolean(options?.allowDiagonal, true);

    // Octile heuristic for square+diagonal, Manhattan for cardinal-only, and
    // Euclidean fallback for gridless/hex approximations.
    if (allowDiagonal) {
      const minD = Math.min(dx, dy);
      const maxD = Math.max(dx, dy);
      return (Math.SQRT2 * minD) + (maxD - minD);
    }
    return dx + dy;
  }

  /**
   * @param {Set<string>} openSet
   * @param {Map<string, number>} fScore
   * @returns {string}
   */
  _selectOpenSetBestNode(openSet, fScore) {
    let bestKey = '';
    let bestScore = Number.POSITIVE_INFINITY;
    for (const key of openSet) {
      const score = fScore.get(key) ?? Number.POSITIVE_INFINITY;
      if (score < bestScore) {
        bestScore = score;
        bestKey = key;
      }
    }
    return bestKey;
  }

  /**
   * @param {Map<string, string>} cameFrom
   * @param {string} currentKey
   * @param {Map<string, {x:number,y:number}>} nodes
   * @returns {Array<{x:number,y:number}>}
   */
  _reconstructPathNodes(cameFrom, currentKey, nodes) {
    const path = [];
    let key = currentKey;
    while (key) {
      const node = nodes.get(key);
      if (node) {
        path.push({ x: node.x, y: node.y });
      }
      key = cameFrom.get(key) || '';
    }
    path.reverse();
    return path;
  }

  /**
   * @param {{cancelled:boolean}|null} cancelToken
   * @param {number} generation
   * @param {Function|undefined} shouldCancel
   * @returns {boolean}
   */
  _isPathSearchCancelled(cancelToken, generation, shouldCancel) {
    if (cancelToken?.cancelled) return true;
    if (generation !== this._pathSearchGeneration) return true;
    if (typeof shouldCancel === 'function') {
      try {
        return !!shouldCancel();
      } catch (_) {
      }
    }
    return false;
  }

  // ── Flying Placeholder API ──────────────────────────────────────────────────

  /**
   * Map of tokenId → flying state objects. Tracks which tokens are currently
   * in "flying" hover mode with visual indicators.
   * @type {Map<string, FlyingState>}
   */
  get flyingTokens() {
    if (!this._flyingTokens) this._flyingTokens = new Map();
    return this._flyingTokens;
  }

  /**
   * Enter flying hover mode for a token. Creates ground indicator visuals
   * and begins the gentle rock animation in the update loop.
   *
   * @param {string} tokenId
   * @param {object} [opts]
   * @param {number} [opts.hoverHeight] - World-unit height above ground Z (default: ~0.35 grid)
   * @param {number} [opts.rockAmplitudeDeg] - Side-to-side rock in degrees (default: 3)
   * @param {number} [opts.rockSpeedHz] - Rock oscillation speed (default: 0.4)
   * @returns {boolean} true if entered, false if already flying or no sprite
   */
  setFlyingState(tokenId, opts = {}) {
    if (!tokenId) return false;
    if (this.flyingTokens.has(tokenId)) return false;

    const spriteData = this.tokenManager?.tokenSprites?.get(tokenId);
    const sprite = spriteData?.sprite;
    if (!sprite) return false;

    const grid = canvas?.grid;
    const gridSize = (grid?.size > 0) ? grid.size : 100;

    const hoverHeight = asNumber(opts.hoverHeight, gridSize * 0.35);
    const rockAmplitudeDeg = asNumber(opts.rockAmplitudeDeg, 3);
    const rockSpeedHz = asNumber(opts.rockSpeedHz, 0.4);

    // Create ground indicator group (line + circle under the token).
    const THREE = window.THREE;
    let groundGroup = null;
    if (THREE) {
      groundGroup = new THREE.Group();
      groundGroup.name = `FlyingIndicator_${tokenId}`;

      // Shadow circle on ground plane
      const circleRadius = gridSize * 0.35;
      const circleGeo = new THREE.RingGeometry(circleRadius * 0.85, circleRadius, 32);
      const circleMat = new THREE.MeshBasicMaterial({
        color: 0x222222,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      const circle = new THREE.Mesh(circleGeo, circleMat);
      groundGroup.add(circle);

      // Vertical dashed tether line from ground to token
      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, hoverHeight)
      ]);
      const lineMat = new THREE.LineDashedMaterial({
        color: 0x555555,
        transparent: true,
        opacity: 0.35,
        dashSize: 4,
        gapSize: 4,
        depthWrite: false
      });
      const line = new THREE.Line(lineGeo, lineMat);
      line.computeLineDistances();
      groundGroup.add(line);

      // Position at token base. We read the sprite's current XY and place
      // the indicator on the ground Z.
      const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
      groundGroup.position.set(sprite.position.x, sprite.position.y, groundZ + 0.01);
      groundGroup.matrixAutoUpdate = false;
      groundGroup.updateMatrix();

      // Add to scene
      const scene = this.tokenManager?.scene;
      if (scene) scene.add(groundGroup);
    }

    const state = {
      tokenId,
      sprite,
      groundGroup,
      hoverHeight,
      rockAmplitudeRad: (rockAmplitudeDeg * Math.PI) / 180,
      rockSpeedHz,
      baseZ: sprite.position.z,
      baseRotation: asNumber(sprite.material?.rotation, 0),
      elapsedSec: 0,
      active: true
    };

    this.flyingTokens.set(tokenId, state);

    // Offset sprite upward immediately
    sprite.position.z = state.baseZ + hoverHeight;
    if (sprite.matrixAutoUpdate === false) sprite.updateMatrix();

    log.info(`Token ${tokenId} entered flying hover (height=${hoverHeight.toFixed(1)})`);
    return true;
  }

  /**
   * Exit flying hover mode for a token, removing indicators and snapping
   * the sprite back to its ground position.
   *
   * @param {string} tokenId
   * @returns {boolean} true if was flying and now cleared
   */
  clearFlyingState(tokenId) {
    const state = this.flyingTokens.get(tokenId);
    if (!state) return false;

    state.active = false;

    // Remove ground indicator
    if (state.groundGroup) {
      const scene = this.tokenManager?.scene;
      if (scene) scene.remove(state.groundGroup);
      state.groundGroup.traverse(child => {
        child.geometry?.dispose();
        child.material?.dispose();
      });
      state.groundGroup = null;
    }

    // Snap sprite back to base Z and rotation
    if (state.sprite && !state.sprite.userData?._removed) {
      state.sprite.position.z = state.baseZ;
      if (state.sprite.material) {
        state.sprite.material.rotation = state.baseRotation;
      }
      if (state.sprite.matrixAutoUpdate === false) state.sprite.updateMatrix();
    }

    this.flyingTokens.delete(tokenId);
    log.info(`Token ${tokenId} exited flying hover`);
    return true;
  }

  /**
   * Check if a token is currently in flying hover mode.
   * @param {string} tokenId
   * @returns {boolean}
   */
  isFlying(tokenId) {
    return this.flyingTokens.has(tokenId);
  }

  /**
   * Per-frame update for flying tokens: gentle rock animation and
   * ground indicator position sync.
   * @param {number} deltaSec
   * @private
   */
  _updateFlyingTokens(deltaSec) {
    if (this.flyingTokens.size === 0) return;

    for (const [tokenId, state] of this.flyingTokens) {
      if (!state.active) continue;
      const sprite = state.sprite;
      if (!sprite || sprite.userData?._removed) {
        this.clearFlyingState(tokenId);
        continue;
      }

      state.elapsedSec += deltaSec;

      // Gentle side-to-side rock using sine wave
      const rockAngle = Math.sin(state.elapsedSec * state.rockSpeedHz * Math.PI * 2) * state.rockAmplitudeRad;
      if (sprite.material) {
        sprite.material.rotation = state.baseRotation + rockAngle;
      }

      // Sync ground indicator position to follow token XY
      if (state.groundGroup) {
        const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
        state.groundGroup.position.set(sprite.position.x, sprite.position.y, groundZ + 0.01);
        state.groundGroup.updateMatrix();
      }

      if (sprite.matrixAutoUpdate === false) sprite.updateMatrix();
    }
  }

  /**
   * @param {string} wallId
   * @returns {WallDocument|null}
   */
  _resolveWallDocument(wallId) {
    if (!wallId) return null;
    return canvas?.walls?.get?.(wallId)?.document
      ?? canvas?.scene?.walls?.get?.(wallId)
      ?? null;
  }

  /**
   * @param {WallDocument|null} wallDoc
   * @param {number} targetDoorState
   * @returns {boolean}
   */
  _canCurrentUserSetDoorState(wallDoc, targetDoorState) {
    if (!wallDoc) return false;

    const doorType = asNumber(wallDoc.door, DOOR_TYPES.NONE);
    if (doorType <= DOOR_TYPES.NONE) return false;

    if (game?.user?.isGM) return true;

    try {
      if (typeof wallDoc.canUserModify === 'function' && game?.user) {
        return !!wallDoc.canUserModify(game.user, 'update', {
          _id: wallDoc.id,
          ds: targetDoorState
        });
      }
    } catch (_) {
    }

    // Conservative fallback: players may only toggle unlocked normal doors.
    return _canPlayerOpenDoor(asNumber(wallDoc.ds, DOOR_STATES.CLOSED), doorType);
  }

  /**
   * Permission-safe door state update helper for movement choreography.
   *
   * @param {string} wallId
   * @param {number} targetDoorState
   * @param {object} [options]
   * @param {boolean} [options.silent=true]
   * @returns {Promise<{ok: boolean, wallId: string, requestedState: number, currentState: number|null, reason?: string}>}
   */
  async requestDoorStateByWallId(wallId, targetDoorState, { silent = true } = {}) {
    const wallDoc = this._resolveWallDocument(wallId);
    if (!wallDoc) {
      return {
        ok: false,
        wallId,
        requestedState: targetDoorState,
        currentState: null,
        reason: 'missing-door'
      };
    }

    const doorType = asNumber(wallDoc.door, DOOR_TYPES.NONE);
    const currentState = asNumber(wallDoc.ds, DOOR_STATES.CLOSED);

    if (doorType <= DOOR_TYPES.NONE) {
      return {
        ok: false,
        wallId: wallDoc.id,
        requestedState: targetDoorState,
        currentState,
        reason: 'not-a-door'
      };
    }

    if (currentState === targetDoorState) {
      return {
        ok: true,
        wallId: wallDoc.id,
        requestedState: targetDoorState,
        currentState
      };
    }

    if (targetDoorState === DOOR_STATES.OPEN && currentState === DOOR_STATES.LOCKED && !game?.user?.isGM) {
      return {
        ok: false,
        wallId: wallDoc.id,
        requestedState: targetDoorState,
        currentState,
        reason: 'locked'
      };
    }

    if (this.settings.doorPolicy.requireDoorPermission && !this._canCurrentUserSetDoorState(wallDoc, targetDoorState)) {
      return {
        ok: false,
        wallId: wallDoc.id,
        requestedState: targetDoorState,
        currentState,
        reason: 'permission-denied'
      };
    }

    try {
      await wallDoc.update({ ds: targetDoorState });
      return {
        ok: true,
        wallId: wallDoc.id,
        requestedState: targetDoorState,
        currentState: targetDoorState
      };
    } catch (error) {
      if (!silent) {
        log.warn(`Door update failed for wall ${wallDoc.id}`, error);
      }
      return {
        ok: false,
        wallId: wallDoc.id,
        requestedState: targetDoorState,
        currentState,
        reason: 'update-failed'
      };
    }
  }

  /**
   * @param {string} wallId
   * @param {object} [options]
   */
  async requestDoorOpen(wallId, options = {}) {
    return this.requestDoorStateByWallId(wallId, DOOR_STATES.OPEN, options);
  }

  /**
   * @param {string} wallId
   * @param {object} [options]
   */
  async requestDoorClose(wallId, options = {}) {
    return this.requestDoorStateByWallId(wallId, DOOR_STATES.CLOSED, options);
  }

  /**
   * Wait until a wall reaches a target door state, or timeout.
   *
   * @param {string} wallId
   * @param {number} targetDoorState
   * @param {object} [options]
   * @param {number} [options.timeoutMs=1200]
   * @param {number} [options.pollIntervalMs=50]
   */
  async awaitDoorState(wallId, targetDoorState, { timeoutMs = 1200, pollIntervalMs = 50 } = {}) {
    const timeout = Math.max(0, asNumber(timeoutMs, 1200));
    const interval = clamp(asNumber(pollIntervalMs, 50), 10, 250);
    const endAt = Date.now() + timeout;

    while (Date.now() <= endAt) {
      const wallDoc = this._resolveWallDocument(wallId);
      if (!wallDoc) {
        return { ok: false, wallId, currentState: null, reason: 'missing-door' };
      }

      const ds = asNumber(wallDoc.ds, DOOR_STATES.CLOSED);
      if (ds === targetDoorState) {
        return { ok: true, wallId, currentState: ds };
      }

      await _sleep(interval);
    }

    const wallDoc = this._resolveWallDocument(wallId);
    return {
      ok: false,
      wallId,
      currentState: asNumber(wallDoc?.ds, DOOR_STATES.CLOSED),
      reason: 'timeout'
    };
  }

  /**
   * Execute only the OPEN half of a planned door step.
   * The movement sequencer can call this during PRE_DOOR_HOLD / REQUEST_DOOR_OPEN.
   *
   * @param {object} doorStep
   * @param {object} [options]
   * @param {boolean} [options.silent=true]
   * @param {number} [options.waitForOpenMs=1200]
   */
  async executeDoorStepOpen(doorStep, { silent = true, waitForOpenMs = 1200 } = {}) {
    const wallId = doorStep?.wallId;
    if (!wallId) return { ok: false, reason: 'missing-door-step' };
    if (!doorStep?.requiresOpen) return { ok: true, skipped: true, reason: 'no-open-required' };
    if (!this.settings.doorPolicy.autoOpen) return { ok: false, reason: 'auto-open-disabled' };

    const isGM = !!game?.user?.isGM;
    if (!isGM && !this.settings.doorPolicy.playerAutoDoorEnabled) {
      return { ok: false, reason: 'player-auto-door-disabled' };
    }

    if (doorStep?.canOpen === false) {
      return { ok: false, reason: doorStep?.blockedReason || 'permission-denied' };
    }

    const openResult = await this.requestDoorOpen(wallId, { silent });
    if (!openResult.ok) return openResult;

    return this.awaitDoorState(wallId, DOOR_STATES.OPEN, { timeoutMs: waitForOpenMs });
  }

  /**
   * Execute only the CLOSE half of a planned door step.
   * The movement sequencer can call this after CROSS_DOOR when policy allows.
   *
   * @param {object} doorStep
   * @param {object} [options]
   * @param {boolean} [options.silent=true]
   * @param {number} [options.waitForCloseMs=1200]
   */
  async executeDoorStepClose(doorStep, { silent = true, waitForCloseMs = 1200 } = {}) {
    const wallId = doorStep?.wallId;
    if (!wallId) return { ok: false, reason: 'missing-door-step' };
    if (!doorStep?.closeAfterCrossing) return { ok: true, skipped: true, reason: 'close-not-required' };

    const delayMs = Math.max(0, asNumber(this.settings.doorPolicy.closeDelayMs, 0));
    if (delayMs > 0) {
      await _sleep(delayMs);
    }

    const closeResult = await this.requestDoorClose(wallId, { silent });
    if (!closeResult.ok) return closeResult;

    return this.awaitDoorState(wallId, DOOR_STATES.CLOSED, { timeoutMs: waitForCloseMs });
  }

  /**
   * Build a door-aware plan and execute the door choreography runner against it.
   *
   * This is the first wiring contract for movement sequencing: callers provide
   * an optional moveToPoint callback which performs actual token movement to
   * hold/entry points while this manager handles door open/close sequencing.
   *
   * @param {object} params
   * @param {string} params.tokenId
   * @param {Array<{x:number,y:number}>} params.pathNodes
   * @param {(point: {x:number,y:number}, context: object) => Promise<object|boolean>|object|boolean} [params.moveToPoint]
   * @param {object} [params.options]
   * @returns {Promise<{ok: boolean, tokenId: string, transitions: Array<object>, failedStepIndex: number, reason?: string, plan: object}>}
   */
  async runDoorAwareMovementSequence({ tokenId, pathNodes, moveToPoint = null, options = {} } = {}) {
    const plan = this.buildDoorAwarePlan(pathNodes || []);
    const result = await this.runDoorStateMachineForPlan({
      tokenId,
      plan,
      moveToPoint,
      options
    });
    return {
      ...result,
      plan
    };
  }

  /**
   * Execute a full token movement with door choreography and real token-position
   * updates via Foundry document writes.
   *
   * Coordinate contract:
   * - destinationTopLeft is TokenDocument-space top-left x/y.
   * - internal door/path planning runs in Foundry center-point space.
   *
   * @param {object} params
   * @param {TokenDocument|object} params.tokenDoc
   * @param {{x:number,y:number}} params.destinationTopLeft
   * @param {object} [params.options]
   * @param {boolean} [params.options.ignoreWalls=false]
   * @param {boolean} [params.options.ignoreCost=false]
   * @param {string} [params.options.method='dragging']
   * @param {number} [params.options.perStepDelayMs=0]
   * @param {object} [params.options.updateOptions]
   * @returns {Promise<{ok:boolean, tokenId:string, reason?:string, transitions:Array<object>, plan?:object, pathNodes:Array<{x:number,y:number}>}>}
   */
  async executeDoorAwareTokenMove({ tokenDoc, destinationTopLeft, options = {} } = {}) {
    const tokenId = String(tokenDoc?.id || '');
    if (!tokenId) {
      return {
        ok: false,
        tokenId: '',
        reason: 'missing-token-id',
        transitions: [],
        pathNodes: []
      };
    }

    const destX = asNumber(destinationTopLeft?.x, NaN);
    const destY = asNumber(destinationTopLeft?.y, NaN);
    if (!Number.isFinite(destX) || !Number.isFinite(destY)) {
      return {
        ok: false,
        tokenId,
        reason: 'invalid-destination',
        transitions: [],
        pathNodes: []
      };
    }

    const currentDoc = this._resolveTokenDocumentById(tokenId, tokenDoc);
    if (!currentDoc) {
      return {
        ok: false,
        tokenId,
        reason: 'missing-token-doc',
        transitions: [],
        pathNodes: []
      };
    }

    const ignoreWalls = optionsBoolean(options?.ignoreWalls, false);
    const ignoreCost = optionsBoolean(options?.ignoreCost, false);

    const targetTopLeft = this._snapTokenTopLeftToGrid({ x: destX, y: destY }, currentDoc);
    const startCenter = this._tokenTopLeftToCenter({ x: currentDoc.x, y: currentDoc.y }, currentDoc);
    const endCenter = this._tokenTopLeftToCenter(targetTopLeft, currentDoc);

    let pathNodes = [startCenter, endCenter];
    if (!ignoreWalls) {
      const pathResult = this.findWeightedPath({
        start: startCenter,
        end: endCenter,
        tokenDoc: currentDoc,
        options: {
          ignoreWalls,
          ignoreCost,
          fogPathPolicy: this.settings.fogPathPolicy,
          allowDiagonal: optionsBoolean(options?.allowDiagonal, true),
          maxSearchIterations: asNumber(options?.maxSearchIterations, 12000)
        }
      });

      const foundryPathResult = await this._computeFoundryParityPath({
        tokenDoc: currentDoc,
        startTopLeft: { x: currentDoc.x, y: currentDoc.y },
        endTopLeft: targetTopLeft,
        ignoreWalls,
        ignoreCost
      });

      const paritySelection = this._selectPathWithFoundryParity({
        customPathResult: pathResult,
        foundryPathResult,
        startCenter,
        endCenter,
        gridSize: asNumber(canvas?.grid?.size, 100),
        forceFoundryParity: optionsBoolean(options?.forceFoundryParity, false)
      });

      if (!paritySelection?.ok) {
        return {
          ok: false,
          tokenId,
          reason: paritySelection?.reason || 'no-path',
          transitions: [],
          pathNodes: []
        };
      }

      if (Array.isArray(paritySelection.pathNodes) && paritySelection.pathNodes.length >= 2) {
        pathNodes = paritySelection.pathNodes;
      }
    }

    const moveToPoint = async (point, context = {}) => {
      return this._moveTokenToFoundryPoint(tokenId, point, currentDoc, {
        ...options,
        ignoreWalls,
        ignoreCost
      }, context);
    };

    if (ignoreWalls) {
      const direct = await moveToPoint(endCenter, {
        tokenId,
        stepIndex: -1,
        phase: 'DIRECT_MOVE',
        plan: null
      });
      return {
        ok: !!direct?.ok,
        tokenId,
        reason: direct?.reason || null,
        transitions: [],
        plan: {
          pathNodes,
          doorSteps: [],
          doorRevision: this._doorStateRevision,
          inCombat: this._inCombat
        },
        pathNodes
      };
    }

    const sequenceResult = await this.runDoorAwareMovementSequence({
      tokenId,
      pathNodes,
      moveToPoint,
      options
    });

    if (!sequenceResult?.ok) {
      return {
        ok: false,
        tokenId,
        reason: sequenceResult?.reason || 'door-sequence-failed',
        transitions: sequenceResult?.transitions || [],
        plan: sequenceResult?.plan,
        pathNodes
      };
    }

    return {
      ok: true,
      tokenId,
      reason: null,
      transitions: sequenceResult.transitions || [],
      plan: sequenceResult.plan,
      pathNodes
    };
  }

  /**
   * Compute a movement path preview without committing any document updates.
   *
   * @param {object} params
   * @param {TokenDocument|object} params.tokenDoc
   * @param {{x:number,y:number}} params.destinationTopLeft
   * @param {object} [params.options]
   * @param {boolean} [params.options.ignoreWalls=false]
   * @param {boolean} [params.options.ignoreCost=false]
   * @returns {{ok:boolean, tokenId:string, pathNodes:Array<{x:number,y:number}>, distance:number, reason?:string}}
   */
  computeTokenPathPreview({ tokenDoc, destinationTopLeft, options = {} } = {}) {
    const tokenId = String(tokenDoc?.id || '');
    if (!tokenId) {
      return { ok: false, tokenId: '', pathNodes: [], distance: 0, reason: 'missing-token-id' };
    }

    const liveDoc = this._resolveTokenDocumentById(tokenId, tokenDoc);
    if (!liveDoc) {
      return { ok: false, tokenId, pathNodes: [], distance: 0, reason: 'missing-token-doc' };
    }

    const destX = asNumber(destinationTopLeft?.x, NaN);
    const destY = asNumber(destinationTopLeft?.y, NaN);
    if (!Number.isFinite(destX) || !Number.isFinite(destY)) {
      return { ok: false, tokenId, pathNodes: [], distance: 0, reason: 'invalid-destination' };
    }

    const ignoreWalls = optionsBoolean(options?.ignoreWalls, false);
    const ignoreCost = optionsBoolean(options?.ignoreCost, false);

    const startTopLeft = { x: asNumber(liveDoc.x, 0), y: asNumber(liveDoc.y, 0) };
    const targetTopLeft = this._snapTokenTopLeftToGrid({ x: destX, y: destY }, liveDoc);

    const startCenter = this._tokenTopLeftToCenter(startTopLeft, liveDoc);
    const endCenter = this._tokenTopLeftToCenter(targetTopLeft, liveDoc);

    let pathNodes = [startCenter, endCenter];
    if (!ignoreWalls) {
      const pathResult = this.findWeightedPath({
        start: startCenter,
        end: endCenter,
        tokenDoc: liveDoc,
        options: {
          ignoreWalls,
          ignoreCost,
          fogPathPolicy: this.settings.fogPathPolicy,
          allowDiagonal: optionsBoolean(options?.allowDiagonal, true),
          maxSearchIterations: asNumber(options?.maxSearchIterations, 12000)
        }
      });

      if (!pathResult?.ok || !Array.isArray(pathResult.pathNodes) || pathResult.pathNodes.length < 2) {
        return {
          ok: false,
          tokenId,
          pathNodes: [],
          distance: 0,
          reason: pathResult?.reason || 'no-path'
        };
      }

      pathNodes = pathResult.pathNodes.slice();
      pathNodes[0] = startCenter;
      pathNodes[pathNodes.length - 1] = endCenter;
    }

    return {
      ok: true,
      tokenId,
      pathNodes,
      distance: this._measurePathLength(pathNodes)
    };
  }

  /**
   * Execute the planned door choreography state machine for a full path plan,
   * including movement coupling through path nodes and door hold/entry points.
   *
   * @param {object} params
   * @param {string} params.tokenId
   * @param {{doorSteps?: Array<object>, pathNodes?: Array<{x:number,y:number}>, doorRevision?: number, inCombat?: boolean}} params.plan
   * @param {(point: {x:number,y:number}, context: object) => Promise<object|boolean>|object|boolean} [params.moveToPoint]
   * @param {object} [params.options]
   * @param {boolean} [params.options.silent=true]
   * @param {number} [params.options.waitForOpenMs=1200]
   * @param {number} [params.options.waitForCloseMs=1200]
   * @returns {Promise<{ok: boolean, tokenId: string, transitions: Array<object>, failedStepIndex: number, reason?: string}>}
   */
  async runDoorStateMachineForPlan({ tokenId, plan, moveToPoint = null, options = {} } = {}) {
    const transitions = [];
    const doorSteps = Array.isArray(plan?.doorSteps) ? plan.doorSteps.slice() : [];
    const pathNodes = Array.isArray(plan?.pathNodes) ? plan.pathNodes : [];

    if (!tokenId) {
      return {
        ok: false,
        tokenId: '',
        transitions,
        failedStepIndex: -1,
        reason: 'missing-token-id'
      };
    }

    const waitForOpenMs = asNumber(options?.waitForOpenMs, 1200);
    const waitForCloseMs = asNumber(options?.waitForCloseMs, 1200);
    const silent = options?.silent !== false;
    const hasMoveCallback = typeof moveToPoint === 'function';

    // Door-state revision guard: if the wall graph changed since plan build,
    // callers should replan to avoid race-condition desync.
    const plannedRevision = asNumber(plan?.doorRevision, this._doorStateRevision);
    if (plannedRevision !== this._doorStateRevision) {
      return {
        ok: false,
        tokenId,
        transitions,
        failedStepIndex: -1,
        reason: 'door-revision-mismatch'
      };
    }

    const sortedDoorSteps = doorSteps.sort((a, b) => asNumber(a?.segmentIndex, 0) - asNumber(b?.segmentIndex, 0));
    let pathCursorIndex = 0;

    /** @type {(node: {x:number,y:number}, context: object, transitionState: string, stepIndex: number, doorStep?: object) => Promise<{ok:boolean, reason?:string}>} */
    const runMove = async (node, context, transitionState, stepIndex, doorStep = null) => {
      if (!node || !hasMoveCallback) {
        const skipResult = { ok: true, reason: null };
        transitions.push(this._buildDoorTransition(transitionState, stepIndex, doorStep, skipResult));
        return skipResult;
      }

      const result = await this._invokeMoveToPoint(moveToPoint, node, context);
      transitions.push(this._buildDoorTransition(transitionState, stepIndex, doorStep, result));
      return result;
    };

    if (sortedDoorSteps.length === 0) {
      if (pathNodes.length >= 2 && hasMoveCallback) {
        for (let nodeIndex = 1; nodeIndex < pathNodes.length; nodeIndex++) {
          const moveResult = await runMove(pathNodes[nodeIndex], {
            tokenId,
            stepIndex: -1,
            phase: 'PATH_SEGMENT',
            pathNodeIndex: nodeIndex,
            plan
          }, 'MOVE_PATH_NODE', -1, null);

          if (!moveResult.ok) {
            return {
              ok: false,
              tokenId,
              transitions,
              failedStepIndex: -1,
              reason: moveResult.reason || 'path-node-move-failed'
            };
          }
        }
      }

      return {
        ok: true,
        tokenId,
        transitions,
        failedStepIndex: -1
      };
    }

    for (let i = 0; i < sortedDoorSteps.length; i++) {
      const step = sortedDoorSteps[i];

      // Move along regular path nodes up to this door's segment start.
      if (hasMoveCallback && pathNodes.length > 1) {
        const segmentIndex = clamp(
          Math.trunc(asNumber(step?.segmentIndex, pathCursorIndex)),
          0,
          Math.max(0, pathNodes.length - 1)
        );

        for (let nodeIndex = pathCursorIndex + 1; nodeIndex <= segmentIndex && nodeIndex < pathNodes.length; nodeIndex++) {
          const pathMoveResult = await runMove(pathNodes[nodeIndex], {
            tokenId,
            stepIndex: i,
            phase: 'PATH_TO_DOOR',
            pathNodeIndex: nodeIndex,
            doorStep: step,
            plan
          }, 'MOVE_PATH_NODE', i, step);

          if (!pathMoveResult.ok) {
            return {
              ok: false,
              tokenId,
              transitions,
              failedStepIndex: i,
              reason: pathMoveResult.reason || 'path-to-door-move-failed'
            };
          }
        }
      }

      // 1) APPROACH_DOOR / PRE_DOOR_HOLD
      transitions.push(this._buildDoorTransition('APPROACH_DOOR', i, step, { ok: true }));
      if (step?.holdPoint && typeof moveToPoint === 'function') {
        const holdResult = await this._invokeMoveToPoint(moveToPoint, step.holdPoint, {
          tokenId,
          stepIndex: i,
          phase: 'PRE_DOOR_HOLD',
          doorStep: step,
          plan
        });
        transitions.push(this._buildDoorTransition('PRE_DOOR_HOLD', i, step, holdResult));
        if (!holdResult.ok) {
          return {
            ok: false,
            tokenId,
            transitions,
            failedStepIndex: i,
            reason: holdResult.reason || 'pre-door-hold-move-failed'
          };
        }
      } else {
        transitions.push(this._buildDoorTransition('PRE_DOOR_HOLD', i, step, { ok: true }));
      }

      // 2) REQUEST_DOOR_OPEN
      transitions.push(this._buildDoorTransition('REQUEST_DOOR_OPEN', i, step, { ok: true }));
      const openResult = await this.executeDoorStepOpen(step, {
        silent,
        waitForOpenMs
      });
      transitions.push(this._buildDoorTransition('WAIT_FOR_DOOR_OPEN', i, step, openResult));
      if (!openResult?.ok) {
        return {
          ok: false,
          tokenId,
          transitions,
          failedStepIndex: i,
          reason: openResult?.reason || 'door-open-failed'
        };
      }

      // 3) CROSS_DOOR
      if (step?.entryPoint && typeof moveToPoint === 'function') {
        const crossResult = await this._invokeMoveToPoint(moveToPoint, step.entryPoint, {
          tokenId,
          stepIndex: i,
          phase: 'CROSS_DOOR',
          doorStep: step,
          plan
        });
        transitions.push(this._buildDoorTransition('CROSS_DOOR', i, step, crossResult));
        if (!crossResult.ok) {
          return {
            ok: false,
            tokenId,
            transitions,
            failedStepIndex: i,
            reason: crossResult.reason || 'cross-door-move-failed'
          };
        }
      } else {
        transitions.push(this._buildDoorTransition('CROSS_DOOR', i, step, { ok: true }));
      }

      transitions.push(this._buildDoorTransition('POST_DOOR_POLICY_EVAL', i, step, { ok: true }));

      // 4) REQUEST_DOOR_CLOSE (optional by policy)
      const closeResult = await this.executeDoorStepClose(step, {
        silent,
        waitForCloseMs
      });
      transitions.push(this._buildDoorTransition('REQUEST_DOOR_CLOSE', i, step, closeResult));
      if (!closeResult?.ok) {
        return {
          ok: false,
          tokenId,
          transitions,
          failedStepIndex: i,
          reason: closeResult?.reason || 'door-close-failed'
        };
      }

      // Rejoin the original path after crossing this doorway.
      if (hasMoveCallback && pathNodes.length > 1) {
        const rejoinIndex = clamp(
          Math.trunc(asNumber(step?.segmentIndex, pathCursorIndex)) + 1,
          0,
          Math.max(0, pathNodes.length - 1)
        );
        pathCursorIndex = Math.max(pathCursorIndex, rejoinIndex);

        const rejoinNode = pathNodes[rejoinIndex];
        const rejoinResult = await runMove(rejoinNode, {
          tokenId,
          stepIndex: i,
          phase: 'RESUME_PATH',
          pathNodeIndex: rejoinIndex,
          doorStep: step,
          plan
        }, 'RESUME_PATH', i, step);

        if (!rejoinResult.ok) {
          return {
            ok: false,
            tokenId,
            transitions,
            failedStepIndex: i,
            reason: rejoinResult.reason || 'resume-path-move-failed'
          };
        }
      }

      transitions.push(this._buildDoorTransition('RESUME_PATH', i, step, { ok: true }));
    }

    // Finish any remaining non-door path nodes after the last door.
    if (hasMoveCallback && pathNodes.length > 1) {
      for (let nodeIndex = pathCursorIndex + 1; nodeIndex < pathNodes.length; nodeIndex++) {
        const tailMoveResult = await runMove(pathNodes[nodeIndex], {
          tokenId,
          stepIndex: sortedDoorSteps.length - 1,
          phase: 'PATH_SEGMENT',
          pathNodeIndex: nodeIndex,
          plan
        }, 'MOVE_PATH_NODE', sortedDoorSteps.length - 1, null);

        if (!tailMoveResult.ok) {
          return {
            ok: false,
            tokenId,
            transitions,
            failedStepIndex: sortedDoorSteps.length - 1,
            reason: tailMoveResult.reason || 'path-tail-move-failed'
          };
        }
      }
    }

    return {
      ok: true,
      tokenId,
      transitions,
      failedStepIndex: -1
    };
  }

  /**
   * Internal helper to build uniform state-machine transition records.
   *
   * @param {string} state
   * @param {number} stepIndex
   * @param {object} doorStep
   * @param {object} result
   * @returns {{state: string, stepIndex: number, wallId: string, ok: boolean, reason: string|null, timestampMs: number}}
   */
  _buildDoorTransition(state, stepIndex, doorStep, result) {
    return {
      state,
      stepIndex,
      wallId: doorStep?.wallId || '',
      ok: !!result?.ok,
      reason: result?.reason || null,
      timestampMs: Date.now()
    };
  }

  /**
   * Normalize movement-sequencer callback responses into a common shape.
   *
   * @param {Function} moveToPoint
   * @param {{x:number,y:number}} point
   * @param {object} context
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async _invokeMoveToPoint(moveToPoint, point, context) {
    try {
      const raw = await moveToPoint(point, context);
      if (raw === false) return { ok: false, reason: 'move-callback-false' };
      if (!raw || typeof raw !== 'object') return { ok: true };
      return {
        ok: raw.ok !== false,
        reason: raw.reason || null
      };
    } catch (error) {
      log.warn('Door sequencer moveToPoint callback failed', error);
      return { ok: false, reason: 'move-callback-error' };
    }
  }

  /**
   * Resolve a token document from canvas by id with fallback object support.
   * @param {string} tokenId
   * @param {TokenDocument|object|null} fallbackDoc
   * @returns {TokenDocument|object|null}
   */
  _resolveTokenDocumentById(tokenId, fallbackDoc = null) {
    if (!tokenId) return fallbackDoc || null;
    return canvas?.scene?.tokens?.get?.(tokenId)
      || canvas?.tokens?.get?.(tokenId)?.document
      || fallbackDoc
      || null;
  }

  /**
   * @param {{x:number,y:number}} topLeft
   * @param {TokenDocument|object} tokenDoc
   * @returns {{x:number,y:number}}
   */
  _tokenTopLeftToCenter(topLeft, tokenDoc) {
    const size = this._getTokenPixelSize(tokenDoc);
    return {
      x: asNumber(topLeft?.x, 0) + (size.widthPx / 2),
      y: asNumber(topLeft?.y, 0) + (size.heightPx / 2)
    };
  }

  /**
   * @param {{x:number,y:number}} center
   * @param {TokenDocument|object} tokenDoc
   * @returns {{x:number,y:number}}
   */
  _tokenCenterToTopLeft(center, tokenDoc) {
    const size = this._getTokenPixelSize(tokenDoc);
    return {
      x: asNumber(center?.x, 0) - (size.widthPx / 2),
      y: asNumber(center?.y, 0) - (size.heightPx / 2)
    };
  }

  /**
   * @param {TokenDocument|object} tokenDoc
   * @returns {{widthPx:number,heightPx:number}}
   */
  _getTokenPixelSize(tokenDoc) {
    const gridSize = asNumber(canvas?.grid?.size, asNumber(canvas?.dimensions?.size, 100));
    const width = asNumber(tokenDoc?.width, 1);
    const height = asNumber(tokenDoc?.height, 1);
    return {
      widthPx: width * gridSize,
      heightPx: height * gridSize
    };
  }

  /**
   * Snap a token top-left position to the active grid center (when grid is enabled).
   * Keeps movement endpoints stable between preview/path and authoritative updates.
   *
   * @param {{x:number,y:number}} topLeft
   * @param {TokenDocument|object} tokenDoc
   * @returns {{x:number,y:number}}
   */
  _snapTokenTopLeftToGrid(topLeft, tokenDoc) {
    const x = asNumber(topLeft?.x, 0);
    const y = asNumber(topLeft?.y, 0);

    const grid = canvas?.grid;
    const gridless = !!(grid && grid.type === CONST?.GRID_TYPES?.GRIDLESS);
    if (!grid || gridless || typeof grid.getSnappedPoint !== 'function') {
      return { x, y };
    }

    const center = this._tokenTopLeftToCenter({ x, y }, tokenDoc);
    try {
      const snappedCenter = grid.getSnappedPoint(center, { mode: CONST?.GRID_SNAPPING_MODES?.CENTER });
      return this._tokenCenterToTopLeft(snappedCenter, tokenDoc);
    } catch (_) {
      return { x, y };
    }
  }

  /**
   * @param {string} tokenId
   * @param {{x:number,y:number}} point
   * @param {TokenDocument|object} tokenDoc
   * @param {object} options
   * @param {object} context
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async _moveTokenToFoundryPoint(tokenId, point, tokenDoc, options = {}, context = {}) {
    if (!tokenId || !point) return { ok: false, reason: 'missing-move-target' };

    const liveDoc = this._resolveTokenDocumentById(tokenId, tokenDoc);
    if (!liveDoc) return { ok: false, reason: 'missing-token-doc' };

    const targetTopLeftRaw = this._tokenCenterToTopLeft(point, liveDoc);
    const targetTopLeft = this._snapTokenTopLeftToGrid(targetTopLeftRaw, liveDoc);
    const currentX = asNumber(liveDoc?.x, NaN);
    const currentY = asNumber(liveDoc?.y, NaN);

    if (Number.isFinite(currentX) && Number.isFinite(currentY)) {
      const dx = Math.abs(targetTopLeft.x - currentX);
      const dy = Math.abs(targetTopLeft.y - currentY);
      if (dx < 0.5 && dy < 0.5) {
        return { ok: true, reason: 'no-op' };
      }
    }

    const stepDistancePx = (Number.isFinite(currentX) && Number.isFinite(currentY))
      ? Math.hypot(targetTopLeft.x - currentX, targetTopLeft.y - currentY)
      : 0;
    const fallbackDelayMs = this._estimateSequencedStepDelayMs(stepDistancePx, options);

    const update = {
      _id: tokenId,
      x: targetTopLeft.x,
      y: targetTopLeft.y
    };

    const includeMovementPayload = this._shouldIncludeMovementPayloadForStep(options, context);
    const updateOptions = this._buildTokenMoveUpdateOptions(liveDoc, update, {
      ...options,
      includeMovementPayload
    }, context);

    try {
      await canvas.scene.updateEmbeddedDocuments('Token', [update], updateOptions);
      await this._awaitSequencedStepSettle(tokenId, fallbackDelayMs, options);
      return { ok: true };
    } catch (error) {
      log.warn(`Door-aware move update failed for token ${tokenId}`, error);
      return { ok: false, reason: 'token-update-failed' };
    }
  }

  /**
   * Estimate a delay budget for one sequenced movement node when a movement
   * track is unavailable (e.g., non-animated updates).
   *
   * @param {number} stepDistancePx
   * @param {object} options
   * @returns {number}
   */
  _estimateSequencedStepDelayMs(stepDistancePx, options = {}) {
    if (Number.isFinite(Number(options?.perStepDelayMs))) {
      return Math.max(0, asNumber(options?.perStepDelayMs, 0));
    }

    const gridSize = Math.max(1, asNumber(canvas?.grid?.size, asNumber(canvas?.dimensions?.size, 100)));
    const gridSteps = Math.max(0, asNumber(stepDistancePx, 0) / gridSize);
    const estMs = (gridSteps * 290) + 140;
    return clamp(estMs, 90, 1800);
  }

  /**
   * Wait for the token's movement animation track to complete before issuing
   * the next sequenced path node update.
   *
   * @param {string} tokenId
   * @param {number} fallbackDelayMs
   * @param {object} options
   */
  async _awaitSequencedStepSettle(tokenId, fallbackDelayMs, options = {}) {
    const waitForTrackStartMs = clamp(asNumber(options?.waitForTrackStartMs, 220), 0, 2000);
    const waitForTrackFinishMs = clamp(asNumber(options?.waitForTrackFinishMs, 2400), 100, 10000);
    const pollMs = clamp(asNumber(options?.trackPollIntervalMs, 16), 8, 100);

    const hasTrack = () => this.activeTracks?.has?.(tokenId) === true;

    const startDeadline = Date.now() + waitForTrackStartMs;
    let sawTrack = hasTrack();
    while (!sawTrack && Date.now() < startDeadline) {
      await _sleep(pollMs);
      sawTrack = hasTrack();
    }

    if (sawTrack) {
      const finishDeadline = Date.now() + waitForTrackFinishMs;
      while (hasTrack() && Date.now() < finishDeadline) {
        await _sleep(pollMs);
      }
      return;
    }

    if (fallbackDelayMs > 0) {
      await _sleep(fallbackDelayMs);
    }
  }

  /**
   * @param {TokenDocument|object} tokenDoc
   * @param {{_id:string,x:number,y:number}} update
   * @param {object} options
   * @param {object} context
   * @returns {object}
   */
  _buildTokenMoveUpdateOptions(tokenDoc, update, options = {}, context = {}) {
    const updateOptions = (options?.updateOptions && typeof options.updateOptions === 'object')
      ? { ...options.updateOptions }
      : {};

    const includeMovement = optionsBoolean(options?.includeMovementPayload, false)
      || optionsBoolean(options?.ignoreWalls, false)
      || optionsBoolean(options?.ignoreCost, false);
    if (!includeMovement) return updateOptions;

    const waypoint = {
      x: asNumber(update?.x, asNumber(tokenDoc?.x, 0)),
      y: asNumber(update?.y, asNumber(tokenDoc?.y, 0)),
      explicit: true,
      checkpoint: true
    };

    if (typeof tokenDoc?.elevation === 'number') waypoint.elevation = tokenDoc.elevation;
    if (typeof tokenDoc?.width === 'number') waypoint.width = tokenDoc.width;
    if (typeof tokenDoc?.height === 'number') waypoint.height = tokenDoc.height;
    if (tokenDoc?.shape != null) waypoint.shape = tokenDoc.shape;
    if (typeof tokenDoc?.movementAction === 'string') waypoint.action = tokenDoc.movementAction;
    if (typeof context?.phase === 'string') waypoint.phase = context.phase;

    const movementEntry = {
      waypoints: [waypoint],
      method: options?.method || 'dragging'
    };

    const constrainOptions = this._getFoundryConstrainOptions(options);
    if (Object.keys(constrainOptions).length > 0) {
      movementEntry.constrainOptions = constrainOptions;
    }

    const id = String(update?._id || tokenDoc?.id || '');
    if (!id) return updateOptions;

    updateOptions.movement = {
      ...(updateOptions.movement || {}),
      [id]: movementEntry
    };

    return updateOptions;
  }

  /**
   * @param {object} options
   * @returns {{ignoreWalls?:boolean, ignoreCost?:boolean}}
   */
  _getFoundryConstrainOptions(options = {}) {
    /** @type {{ignoreWalls?:boolean, ignoreCost?:boolean}} */
    const constrainOptions = {};
    if (optionsBoolean(options?.ignoreWalls, false)) constrainOptions.ignoreWalls = true;
    if (optionsBoolean(options?.ignoreCost, false)) constrainOptions.ignoreCost = true;
    return constrainOptions;
  }

  /**
   * Ask Foundry for a constrained movement path for parity fallback checks.
   * @param {object} params
   * @param {TokenDocument|object} params.tokenDoc
   * @param {{x:number,y:number}} params.startTopLeft
   * @param {{x:number,y:number}} params.endTopLeft
   * @param {boolean} params.ignoreWalls
   * @param {boolean} params.ignoreCost
   * @returns {Promise<{ok:boolean,pathNodes:Array<{x:number,y:number}>,reason?:string}>}
   */
  async _computeFoundryParityPath({ tokenDoc, startTopLeft, endTopLeft, ignoreWalls, ignoreCost }) {
    const tokenObj = tokenDoc?.object || canvas?.tokens?.get?.(tokenDoc?.id) || null;
    if (!tokenObj || typeof tokenObj.findMovementPath !== 'function') {
      return { ok: false, pathNodes: [], reason: 'no-find-movement-path' };
    }

    const waypoints = [
      {
        x: asNumber(startTopLeft?.x, asNumber(tokenDoc?.x, 0)),
        y: asNumber(startTopLeft?.y, asNumber(tokenDoc?.y, 0)),
        elevation: asNumber(tokenDoc?.elevation, 0),
        width: asNumber(tokenDoc?.width, 1),
        height: asNumber(tokenDoc?.height, 1),
        shape: tokenDoc?.shape,
        action: tokenDoc?.movementAction,
        explicit: true,
        checkpoint: true
      },
      {
        x: asNumber(endTopLeft?.x, asNumber(startTopLeft?.x, 0)),
        y: asNumber(endTopLeft?.y, asNumber(startTopLeft?.y, 0)),
        elevation: asNumber(tokenDoc?.elevation, 0),
        width: asNumber(tokenDoc?.width, 1),
        height: asNumber(tokenDoc?.height, 1),
        shape: tokenDoc?.shape,
        action: tokenDoc?.movementAction,
        explicit: true,
        checkpoint: true
      }
    ];

    const searchOptions = {
      preview: false,
      history: false,
      delay: 0,
      ...this._getFoundryConstrainOptions({ ignoreWalls, ignoreCost })
    };

    try {
      const job = tokenObj.findMovementPath(waypoints, searchOptions);
      let result = Array.isArray(job?.result) ? job.result : [];
      if ((!Array.isArray(result) || result.length === 0) && job?.promise && typeof job.promise.then === 'function') {
        result = await job.promise;
      }
      if (!Array.isArray(result) || result.length < 2) {
        return { ok: false, pathNodes: [], reason: 'empty-foundry-path' };
      }

      const pathNodes = result.map((wp) => this._tokenTopLeftToCenter({ x: wp?.x, y: wp?.y }, {
        ...tokenDoc,
        width: wp?.width ?? tokenDoc?.width,
        height: wp?.height ?? tokenDoc?.height
      }));

      return { ok: true, pathNodes };
    } catch (error) {
      log.warn('Foundry parity path query failed', error);
      return { ok: false, pathNodes: [], reason: 'find-movement-path-error' };
    }
  }

  /**
   * @param {object} params
   * @param {{ok?:boolean,pathNodes?:Array<{x:number,y:number}>}} params.customPathResult
   * @param {{ok?:boolean,pathNodes?:Array<{x:number,y:number}>}} params.foundryPathResult
   * @param {{x:number,y:number}} params.startCenter
   * @param {{x:number,y:number}} params.endCenter
   * @param {number} params.gridSize
   * @param {boolean} params.forceFoundryParity
   * @returns {{ok:boolean,pathNodes:Array<{x:number,y:number}>,reason?:string}}
   */
  _selectPathWithFoundryParity({ customPathResult, foundryPathResult, startCenter, endCenter, gridSize, forceFoundryParity }) {
    const customPath = Array.isArray(customPathResult?.pathNodes) ? customPathResult.pathNodes.slice() : [];
    const foundryPath = Array.isArray(foundryPathResult?.pathNodes) ? foundryPathResult.pathNodes.slice() : [];

    const normalizePath = (nodes) => {
      if (!Array.isArray(nodes) || nodes.length < 2) {
        return [startCenter, endCenter];
      }
      const out = nodes.slice();
      out[0] = startCenter;
      out[out.length - 1] = endCenter;
      return out;
    };

    const normalizedCustom = normalizePath(customPath);
    const normalizedFoundry = normalizePath(foundryPath);

    if (forceFoundryParity && foundryPathResult?.ok) {
      return { ok: true, pathNodes: normalizedFoundry };
    }

    if (!customPathResult?.ok && !foundryPathResult?.ok) {
      return { ok: false, pathNodes: [], reason: 'no-path' };
    }

    if (!customPathResult?.ok && foundryPathResult?.ok) {
      return { ok: true, pathNodes: normalizedFoundry };
    }

    if (!foundryPathResult?.ok) {
      return { ok: true, pathNodes: normalizedCustom };
    }

    const eps = Math.max(1, asNumber(gridSize, 100) * 0.45);
    const customEnd = normalizedCustom[normalizedCustom.length - 1];
    const endDelta = Math.hypot(customEnd.x - endCenter.x, customEnd.y - endCenter.y);
    if (endDelta > eps) {
      return { ok: true, pathNodes: normalizedFoundry };
    }

    const customLen = this._measurePathLength(normalizedCustom);
    const foundryLen = this._measurePathLength(normalizedFoundry);
    const lenDelta = Math.abs(customLen - foundryLen);
    const lenRel = lenDelta / Math.max(1, foundryLen);
    if (lenDelta > (asNumber(gridSize, 100) * 2) && lenRel > 0.35) {
      return { ok: true, pathNodes: normalizedFoundry };
    }

    return { ok: true, pathNodes: normalizedCustom };
  }

  /**
   * @param {Array<{x:number,y:number}>} nodes
   * @returns {number}
   */
  _measurePathLength(nodes) {
    if (!Array.isArray(nodes) || nodes.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < nodes.length; i++) {
      const a = nodes[i - 1];
      const b = nodes[i];
      total += Math.hypot(asNumber(b?.x, 0) - asNumber(a?.x, 0), asNumber(b?.y, 0) - asNumber(a?.y, 0));
    }
    return total;
  }

  // ── Door Detection Helpers ────────────────────────────────────────────────

  /**
   * Scan Foundry walls for door segments that intersect a straight-line
   * path between two Foundry-coordinate points. Returns metadata about
   * each door encountered, ordered by distance from the start point.
   *
   * Uses Foundry-coordinate space (top-left origin, Y-down). Callers must
   * convert to/from Three world coords externally.
   *
   * @param {{x: number, y: number}} start - Foundry-space start point
   * @param {{x: number, y: number}} end - Foundry-space end point
   * @returns {Array<DoorHit>} Sorted by distance from start
   *
   * @typedef {object} DoorHit
   * @property {string} wallId - Foundry wall document ID
   * @property {number} door - CONST.WALL_DOOR_TYPES value (1=DOOR, 2=SECRET)
   * @property {number} ds - CONST.WALL_DOOR_STATES value (0=CLOSED, 1=OPEN, 2=LOCKED)
   * @property {boolean} isOpen
   * @property {boolean} isLocked
   * @property {boolean} isSecret
   * @property {{x: number, y: number}} intersection - Intersection point in Foundry coords
   * @property {{x: number, y: number}} midpoint - Wall midpoint (approx door location)
   * @property {number} distance - Distance from start to intersection
   * @property {boolean} canPlayerOpen - Whether a non-GM player can open this door
   * @property {boolean} canUserOpen - Whether current user can request OPEN on this door
   */
  findDoorsAlongSegment(start, end) {
    const results = [];

    // Access Foundry walls
    const walls = canvas?.walls?.placeables;
    if (!walls || !Array.isArray(walls)) return results;

    const sx = asNumber(start?.x, 0);
    const sy = asNumber(start?.y, 0);
    const ex = asNumber(end?.x, 0);
    const ey = asNumber(end?.y, 0);

    for (const wall of walls) {
      const doc = wall?.document;
      if (!doc) continue;

      // Skip non-door walls
      const doorType = asNumber(doc.door, DOOR_TYPES.NONE);
      if (doorType <= DOOR_TYPES.NONE) continue;

      // Wall segment coordinates [x0, y0, x1, y1]
      const c = doc.c;
      if (!c || c.length < 4) continue;

      // Line-line intersection test
      const hit = _segmentIntersection(
        sx, sy, ex, ey,
        c[0], c[1], c[2], c[3]
      );
      if (!hit) continue;

      const ds = asNumber(doc.ds, DOOR_STATES.CLOSED);
      const canUserOpen = this._canCurrentUserSetDoorState(doc, DOOR_STATES.OPEN);

      results.push({
        wallId: doc.id || doc._id || '',
        door: doorType,
        ds,
        isOpen: ds === DOOR_STATES.OPEN,
        isLocked: ds === DOOR_STATES.LOCKED,
        isSecret: doorType === DOOR_TYPES.SECRET,
        intersection: { x: hit.x, y: hit.y },
        midpoint: { x: (c[0] + c[2]) / 2, y: (c[1] + c[3]) / 2 },
        distance: Math.hypot(hit.x - sx, hit.y - sy),
        canPlayerOpen: _canPlayerOpenDoor(ds, doorType),
        canUserOpen
      });
    }

    // Sort by distance from start
    results.sort((a, b) => a.distance - b.distance);
    return results;
  }

  /**
   * Given a sequence of Foundry-space path nodes, find all doors along the
   * entire path. Each segment between consecutive nodes is tested.
   *
   * @param {Array<{x: number, y: number}>} pathNodes
   * @returns {Array<DoorHit & {segmentIndex: number}>}
   */
  findDoorsAlongPath(pathNodes) {
    if (!Array.isArray(pathNodes) || pathNodes.length < 2) return [];

    const allHits = [];
    for (let i = 0; i < pathNodes.length - 1; i++) {
      const hits = this.findDoorsAlongSegment(pathNodes[i], pathNodes[i + 1]);
      for (const hit of hits) {
        allHits.push({ ...hit, segmentIndex: i });
      }
    }
    return allHits;
  }

  /**
   * Build a door-aware movement plan from a path. Inserts synthetic
   * preDoorHold and postDoorEntry nodes around each closed door.
   *
   * @param {Array<{x: number, y: number}>} pathNodes
   * @returns {{
   *   pathNodes: Array<object>,
   *   doorSteps: Array<DoorStep>,
   *   doorRevision: number,
   *   inCombat: boolean
   * }}
   *
   * @typedef {object} DoorStep
   * @property {string} wallId
   * @property {number} door
   * @property {number} ds
   * @property {boolean} requiresOpen - True if door is closed/locked and must be opened
   * @property {boolean} canOpen - True if current user has permission to open
   * @property {boolean} autoOpen - Policy flag indicating whether automation is enabled
   * @property {string|null} blockedReason - Null when openable, otherwise a non-sensitive block reason
   * @property {{x: number, y: number}} holdPoint - Where token pauses before door
   * @property {{x: number, y: number}} entryPoint - First valid point after crossing
   * @property {boolean} closeAfterCrossing - Policy-derived close recommendation
   * @property {number} segmentIndex
   */
  buildDoorAwarePlan(pathNodes = []) {
    const nodes = Array.isArray(pathNodes) ? pathNodes : [];
    const doorSteps = [];

    if (nodes.length >= 2) {
      const doorHits = this.findDoorsAlongPath(nodes);
      const holdOffset = 8; // pixels before door

      for (const hit of doorHits) {
        const requiresOpen = hit.ds !== DOOR_STATES.OPEN;
        if (!requiresOpen) continue;

        const isGM = !!game?.user?.isGM;
        const autoOpen = !!this.settings.doorPolicy.autoOpen;
        const autoDoorAllowedForUser = isGM || !!this.settings.doorPolicy.playerAutoDoorEnabled;

        const wallDoc = this._resolveWallDocument(hit.wallId);
        const permissionOk = this.settings.doorPolicy.requireDoorPermission
          ? this._canCurrentUserSetDoorState(wallDoc, DOOR_STATES.OPEN)
          : true;

        let blockedReason = null;
        if (!autoOpen) blockedReason = 'auto-open-disabled';
        else if (!autoDoorAllowedForUser) blockedReason = 'player-auto-door-disabled';
        else if (hit.ds === DOOR_STATES.LOCKED && !isGM) blockedReason = 'locked';
        else if (!permissionOk) blockedReason = 'permission-denied';

        const canOpen = blockedReason === null;

        // Compute hold point: offset back from intersection along path direction
        const seg = nodes[hit.segmentIndex];
        const segNext = nodes[hit.segmentIndex + 1];
        if (!seg || !segNext) continue;

        const dx = segNext.x - seg.x;
        const dy = segNext.y - seg.y;
        const segLen = Math.hypot(dx, dy);
        if (segLen < 1) continue;

        const nx = dx / segLen;
        const ny = dy / segLen;

        const holdPoint = {
          x: hit.intersection.x - nx * holdOffset,
          y: hit.intersection.y - ny * holdOffset
        };
        const entryPoint = {
          x: hit.intersection.x + nx * holdOffset,
          y: hit.intersection.y + ny * holdOffset
        };

        // Evaluate close policy
        let closeAfterCrossing = false;
        const policy = this.settings.doorPolicy.autoClose;
        if (policy === 'always') {
          closeAfterCrossing = true;
        } else if (policy === 'outOfCombatOnly') {
          closeAfterCrossing = !this._inCombat;
        } else if (policy === 'combatOnly') {
          closeAfterCrossing = this._inCombat;
        }
        // 'never' → false (default)

        doorSteps.push({
          wallId: hit.wallId,
          door: hit.door,
          ds: hit.ds,
          requiresOpen,
          canOpen,
          autoOpen,
          blockedReason,
          holdPoint,
          entryPoint,
          closeAfterCrossing,
          segmentIndex: hit.segmentIndex
        });
      }
    }

    return {
      pathNodes: nodes,
      doorSteps,
      doorRevision: this._doorStateRevision,
      inCombat: this._inCombat
    };
  }

  // ── Fog-Safe Path Visibility ──────────────────────────────────────────────

  /**
   * Test whether a Foundry-space point is visible or explored for the current
   * player. Uses Foundry's native fog and visibility APIs.
   *
   * @param {{x: number, y: number}} point - Foundry-coordinate point
   * @returns {boolean}
   */
  isPointVisibleToPlayer(point) {
    // GM always sees everything
    if (game?.user?.isGM) return true;

    const px = asNumber(point?.x, 0);
    const py = asNumber(point?.y, 0);

    // Check explored fog first (cheaper)
    try {
      if (canvas?.fog?.isPointExplored?.({ x: px, y: py })) return true;
    } catch (_) {
    }

    // Then check active visibility (token vision LOS)
    try {
      if (canvas?.visibility?.testVisibility?.({ x: px, y: py }, { tolerance: 1 })) return true;
    } catch (_) {
    }

    return false;
  }

  /**
   * Apply fog-safe redaction policy to a path for player-facing preview.
   * When no custom visibility function is provided, uses Foundry's native
   * fog/visibility APIs via isPointVisibleToPlayer().
   *
   * @param {Array<object>} pathNodes - Path nodes with {x, y} in Foundry coords
   * @param {(node: object, index: number) => boolean} [isNodeVisible] - Override visibility test
   * @returns {{visiblePath: Array<object>, hasHiddenTail: boolean, hiddenStartIndex: number}}
   */
  redactPathForPlayer(pathNodes = [], isNodeVisible = null) {
    if (!Array.isArray(pathNodes) || pathNodes.length === 0) {
      return { visiblePath: [], hasHiddenTail: false, hiddenStartIndex: -1 };
    }

    // GM bypass — no redaction needed
    if (this.settings.fogPathPolicy === 'gmUnrestricted' || game?.user?.isGM) {
      return {
        visiblePath: pathNodes.slice(),
        hasHiddenTail: false,
        hiddenStartIndex: -1
      };
    }

    // Use provided visibility function or fall back to native fog/visibility check
    const visibleFn = (typeof isNodeVisible === 'function')
      ? isNodeVisible
      : (node) => this.isPointVisibleToPlayer(node);

    let hiddenStartIndex = -1;
    const visiblePath = [];

    for (let i = 0; i < pathNodes.length; i++) {
      const node = pathNodes[i];
      const visible = !!visibleFn(node, i);
      if (!visible) {
        hiddenStartIndex = i;
        break;
      }
      visiblePath.push(node);
    }

    const hasHiddenTail = hiddenStartIndex >= 0;

    // Both strictNoFogPath and allowButRedact avoid revealing hidden geometry.
    // The difference is in planner search scope (implemented in A* phase later):
    // - strictNoFogPath: planner treats hidden nodes as blocked
    // - allowButRedact: planner may search beyond, but preview is truncated
    return {
      visiblePath,
      hasHiddenTail,
      hiddenStartIndex
    };
  }

  // ── Settings & Policy ─────────────────────────────────────────────────────

  /**
   * Merge partial door policy updates.
   * @param {object} patch
   */
  setDoorPolicy(patch) {
    if (!patch || typeof patch !== 'object') return;
    this.settings.doorPolicy = {
      ...this.settings.doorPolicy,
      ...patch
    };
  }

  /**
   * @param {'strictNoFogPath'|'allowButRedact'|'gmUnrestricted'} policy
   */
  setFogPathPolicy(policy) {
    if (!FOG_PATH_POLICIES.has(policy)) return;
    this.settings.fogPathPolicy = policy;
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────

  /**
   * Snapshot helper for implementation progress diagnostics.
   */
  getImplementationStatus() {
    return {
      initialized: this.initialized,
      styleCount: this.styles.size,
      activeTrackCount: this.activeTracks.size,
      flyingTokenCount: this.flyingTokens.size,
      pathSearchGeneration: this._pathSearchGeneration,
      weightedAStarWeight: this.settings.weightedAStarWeight,
      doorPolicy: { ...this.settings.doorPolicy },
      fogPathPolicy: this.settings.fogPathPolicy,
      inCombat: this._inCombat,
      doorStateRevision: this._doorStateRevision
    };
  }
}

// ── Module-level helpers (not exported) ───────────────────────────────────────

/**
 * Segment-segment intersection test. Returns intersection point or null.
 * Segments are (ax,ay)→(bx,by) and (cx,cy)→(dx,dy).
 * @returns {{x: number, y: number, t: number, u: number}|null}
 */
function _segmentIntersection(ax, ay, bx, by, cx, cy, dx, dy) {
  const denom = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (Math.abs(denom) < 1e-10) return null; // Parallel or collinear

  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / denom;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / denom;

  if (t < 0 || t > 1 || u < 0 || u > 1) return null; // No intersection within segments

  return {
    x: ax + t * (bx - ax),
    y: ay + t * (by - ay),
    t,
    u
  };
}

/**
 * Determine if a non-GM player can open a door based on its current state
 * and type. Mirrors Foundry's BaseWall.#canUpdate permission logic.
 *
 * @param {number} ds - Current door state (CONST.WALL_DOOR_STATES)
 * @param {number} doorType - Door type (CONST.WALL_DOOR_TYPES)
 * @returns {boolean}
 */
function _canPlayerOpenDoor(ds, doorType) {
  // Secret doors are invisible to players (no door control shown)
  if (doorType === DOOR_TYPES.SECRET) return false;

  // Locked doors cannot be opened by players
  if (ds === DOOR_STATES.LOCKED) return false;

  // Players can toggle between CLOSED and OPEN for normal unlocked doors
  return true;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, asNumber(ms, 0))));
}

/**
 * @param {any} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function optionsBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  return fallback;
}
