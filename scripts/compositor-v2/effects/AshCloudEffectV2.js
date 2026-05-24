/**
 * @fileoverview AshCloudEffectV2 — ground-level ash cloud billboards driven by ash weather.
 *
 * Reuses cloud PNG assets as dark grey, low-opacity puffs that drift across outdoor
 * (_Outdoors) areas. Fast fade-in, slow fade-out; domain warp + large-scale noise reveal.
 *
 * @module compositor-v2/effects/AshCloudEffectV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { loadCloudSpriteTextures } from './cloud-sprites/cloud-asset-loader.js';
import { CloudTexturePicker } from './cloud-sprites/CloudSprite.js';
import { resolveEffectWindWorld } from './resolve-effect-wind.js';
import { GROUND_Z, effectUnderOverheadOrder } from '../LayerOrderPolicy.js';
import {
  AshCloudSprite,
  ASH_FADE_IN_SEC,
  ASH_FADE_OUT_SEC,
} from './ash-cloud-sprites/AshCloudSprite.js';
import { applyAshCloudMaskUniforms } from './ash-cloud-sprites/ash-cloud-shaders.js';
import { getAshCloudControlSchema } from './ash-cloud-sprites/ash-cloud-control-schema.js';
import {
  createSceneViewProjectionCache,
  updateSceneViewProjectionFromCamera,
} from '../scene-view-projection.js';
import {
  worldBoundsToNormUv,
  padNormUvRect,
  scanAshMaskPointsInView,
  pickWeightedAshSpawnPoint,
  isNormUvInView,
} from './ash-cloud-sprites/ash-cloud-spawn-picker.js';

const log = createLogger('AshCloudEffectV2');

const OFF_STAGE_MARGIN = 0.12;
const UPWIND_SPAWN_DEPTH = 0.08;
const SPAWN_ARC_SPRITE_PAD = 0.06;
const MAP_CORE_UV_MIN = 0.08;
const MAP_CORE_UV_MAX = 0.92;
const MIN_IN_VIEW_SPRITES = 2;
const VIEW_UV_PAD = 0.04;
const VIEW_SPAWN_CACHE_MIN_INTERVAL = 0.2;
const MIN_ACTIVE_SPRITES = 2;
const MAX_ACTIVE_SPRITES = 32;
const ASH_STRENGTH_EPSILON = 0.02;
/** Top of FLOOR_EFFECTS band — below overhead roofs, above tokens in the bus stack. */
const FLOOR_EFFECTS_TOP_INTRA = 2350;

export class AshCloudEffectV2 {
  constructor() {
    this.enabled = true;
    this._initialized = false;
    this._assetsLoaded = false;

    this.params = {
      enabled: true,
      spritePoolSize: 24,
      sparseWeight: 0.65,
      spriteScaleMin: 400,
      spriteScaleMax: 1400,
      spriteOpacityMin: 0.35,
      spriteOpacityMax: 0.85,
      ashColor: { r: 0.082, g: 0.078, b: 0.072 },
      opacityCap: 0.68,
      fadeInDuration: ASH_FADE_IN_SEC,
      fadeOutDuration: ASH_FADE_OUT_SEC,
      windInfluence: 1.4,
      driftSpeed: 0.014,
      minDriftSpeed: 0.003,
      driftResponsiveness: 0.45,
      driftMaxSpeed: 0.55,
      driftOrbitStrength: 0.12,
      ashHeightOffset: 0.28,
      domainWarpStrength: 0.03,
      domainWarpSpeed: 1.0,
      revealNoiseScale: 0.00012,
      revealThreshold: 0.55,
      revealSoftness: 0.18,
    };

    this._busScene = null;
    this._mainCamera = null;
    this._ashAnchor = null;
    this._ashSprites = [];
    this._sparseTextures = [];
    this._fullTextures = [];
    this._texturePicker = null;

    this._outdoorsMask = null;
    this._outdoorsMasks = [null, null, null, null];
    this._floorIdTex = null;
    this._fallbackWhite = null;

    this._activeFloorIndex = 0;
    this._lastActiveTotal = -1;
    this._ashStrengthZeroLF = true;
    this._needsSpriteRespread = false;
    this._lastSceneBoundsKey = '';
    this._sceneBoundsValid = false;
    this._sceneGeometry = null;
    this._lastElapsed = 0;

    this._spawnArcWalker = Math.random();
    this._spawnArcClumping = 0.5;

    this._windVelocity = null;
    this._tempVec2A = null;
    this._tempDriftUV = { du: 0, dv: 0, len: 0 };
    this._tempSpawnUV = { u: 0, v: 0 };

    this._viewProjCache = null;
    this._viewProjTemps = null;
    /** @type {{ points: Float32Array|null, viewUv: object|null, pointCount: number, cacheKey: string, lastRefreshAt: number, floorKey: string|null }} */
    this._viewSpawnState = {
      points: null,
      viewUv: null,
      pointCount: 0,
      cacheKey: '',
      lastRefreshAt: 0,
      floorKey: null,
    };
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} busScene
   * @param {THREE.Camera} camera
   */
  initialize(renderer, busScene, camera) {
    const THREE = window.THREE;
    if (!THREE || !busScene) return;

    this._busScene = busScene;
    this._mainCamera = camera;
    this._windVelocity = new THREE.Vector2(0, 0);
    this._tempVec2A = new THREE.Vector2();
    this._viewProjCache = createSceneViewProjectionCache();
    this._viewProjTemps = {
      ndc: new THREE.Vector3(),
      world: new THREE.Vector3(),
      dir: new THREE.Vector3(),
    };

    this._ensureFallbackWhite();
    this._ashAnchor = new THREE.Group();
    this._ashAnchor.name = 'AshCloudAnchor';
    this._ashAnchor.frustumCulled = false;
    this._ashAnchor.userData.type = 'ashCloudEffect';
    this._ashAnchor.userData.preserveOnBusClear = true;
    busScene.add(this._ashAnchor);

    this._initialized = true;
    this._loadTextures().then(() => {
      this._assetsLoaded = true;
      this._buildSpritePool();
      this._syncFloorPlacement();
    }).catch((err) => {
      log.warn('AshCloudEffectV2: texture load failed', err);
    });
  }

  /** @param {string} paramId @param {*} value */
  setParam(paramId, value) {
    if (!paramId || !(paramId in this.params)) return;
    if (paramId === 'ashColor' && value && typeof value === 'object') {
      this.params.ashColor = { ...this.params.ashColor, ...value };
    } else {
      this.params[paramId] = value;
    }
    if (paramId === 'enabled') this.enabled = !!value;
    if (paramId === 'spritePoolSize' && this._assetsLoaded) {
      this._buildSpritePool();
    }
    if (paramId === 'sparseWeight' && this._texturePicker) {
      this._texturePicker = new CloudTexturePicker(this._sparseTextures, this._fullTextures, this.params);
    }
  }

  /** @param {string} paramId @param {*} value */
  applyParamChange(paramId, value) {
    this.setParam(paramId, value);
  }

  setOutdoorsMask(texture) {
    this._outdoorsMask = texture ?? null;
  }

  /** @param {Array<import('three').Texture|null>} textures */
  setOutdoorsMasks(textures) {
    if (!Array.isArray(textures)) return;
    for (let i = 0; i < 4; i++) {
      this._outdoorsMasks[i] = textures[i] ?? null;
    }
  }

  setFloorIdTexture(texture) {
    this._floorIdTex = texture ?? null;
  }

  /** @param {number} maxFloorIndex */
  onFloorChange(maxFloorIndex) {
    this._activeFloorIndex = Number.isFinite(Number(maxFloorIndex))
      ? Math.max(0, Number(maxFloorIndex))
      : 0;
    this._lastSceneBoundsKey = '';
    this._invalidateViewSpawnCache();
    this._syncFloorPlacement();
    if (this._assetsLoaded && this._texturePicker) {
      const ws = this._getAshWeatherState();
      this._resetVisibleSprites(ws.strength);
    } else {
      this._needsSpriteRespread = true;
    }
  }

  /** @param {number} delta */
  advanceWind(delta) {
    if (!this._initialized || this.enabled === false || this.params.enabled === false) return;
    this._ensureWeatherController();
    const ws = this._getAshWeatherState();
    if (!ws.weatherEnabled || this._isStrengthZero(ws.strength)) return;
    this._advanceWindSim(delta, ws.windDirX, ws.windDirY, ws.windSpeed);
  }

  /** @private */
  _ensureBusSceneAttachment() {
    const anchor = this._ashAnchor;
    const scene = this._busScene;
    if (!anchor || !scene) return false;

    if (anchor.parent === scene) return false;

    try {
      anchor.parent?.remove?.(anchor);
      scene.add(anchor);
      log.info('AshCloudEffectV2: reattached AshCloudAnchor to FloorRenderBus scene');
      if (this._assetsLoaded && this._texturePicker) {
        this._updateSceneBounds();
        if (this._sceneBoundsValid) {
          const ws = this._getAshWeatherState();
          if (!this._isStrengthZero(ws.strength)) {
            this._resetVisibleSprites(ws.strength);
          }
        } else {
          this._needsSpriteRespread = true;
        }
      } else {
        this._needsSpriteRespread = true;
      }
      return true;
    } catch (err) {
      log.warn('AshCloudEffectV2: failed to attach anchor to bus scene', err);
      return false;
    }
  }

  /** @param {{ elapsed: number, delta: number }} timeInfo */
  update(timeInfo) {
    if (!this._initialized || this.enabled === false || this.params.enabled === false) return;

    this._ensureBusSceneAttachment();
    this._ensureWeatherController();
    this._lastElapsed = timeInfo?.elapsed ?? 0;
    const delta = Math.max(0, Number(timeInfo?.delta) || 0.016);
    const ws = this._getAshWeatherState();

    if (!ws.weatherEnabled || !this._assetsLoaded) return;

    if (this._isStrengthZero(ws.strength)) {
      this._ashStrengthZeroLF = true;
      for (const sprite of this._ashSprites) {
        if (sprite.mesh.visible && !sprite._pendingDeactivate) {
          sprite.markPendingDeactivate();
        }
      }
      this._simulateSprites(delta, ws);
      this._updateShaderUniforms(ws);
      this._updateMaskUniforms();
      return;
    }

    this._ashStrengthZeroLF = false;
    const sceneBoundsChanged = this._updateSceneBounds();
    this._syncAshAnchor();

    if ((sceneBoundsChanged || this._needsSpriteRespread) && this._texturePicker) {
      this._updateViewAshSpawnCache(timeInfo?.elapsed ?? performance.now());
      this._resetVisibleSprites(ws.strength);
    } else {
      this._applyAllVisibleSpriteLocalPositions();
    }

    this._updateViewAshSpawnCache(timeInfo?.elapsed ?? performance.now());
    this._updateActiveSpriteCount(ws.strength, ws.windSpeed);
    this._simulateSprites(delta, ws);
    this._maintainViewAshCoverage(ws.strength, ws);
    this._updateShaderUniforms(ws);
    this._updateMaskUniforms();
  }

  dispose() {
    for (const sprite of this._ashSprites) {
      try { this._ashAnchor?.remove(sprite.mesh); } catch (_) {}
      sprite.dispose();
    }
    this._ashSprites = [];
    try { this._busScene?.remove(this._ashAnchor); } catch (_) {}
    this._ashAnchor = null;
    this._initialized = false;
    this._assetsLoaded = false;
  }

  static getControlSchema() {
    return getAshCloudControlSchema();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /** @private */
  async _loadTextures() {
    const { sparse, full } = await loadCloudSpriteTextures();
    this._sparseTextures = sparse;
    this._fullTextures = full;
    if (sparse.length + full.length === 0) {
      log.warn('AshCloudEffectV2: no cloud PNG textures loaded — ash clouds will not render');
    }
    this._texturePicker = new CloudTexturePicker(this._sparseTextures, this._fullTextures, this.params);
  }

  /** @private */
  _ensureWeatherController() {
    try {
      if (weatherController?.initialized !== true && typeof weatherController?.initialize === 'function') {
        void weatherController.initialize();
      }
    } catch (_) {}
  }

  /**
   * Read ash channel + wind without requiring global weather to be enabled.
   * V2 Ash UI writes `currentState` / `targetState` directly; `getCurrentState()`
   * returns neutral zeros when global weather is off.
   * @private
   */
  _readAshChannelScalars() {
    let ashIntensity = 0;
    let windSpeed = 0.15;
    let windDirX = 1.0;
    let windDirY = 0.0;

    const applyState = (s) => {
      if (!s || typeof s !== 'object') return;
      const ash = Number(s.ashIntensity);
      if (Number.isFinite(ash)) ashIntensity = Math.max(ashIntensity, ash);
      const wms = Number(s.windSpeedMS);
      const w01 = Number(s.windSpeed);
      if (Number.isFinite(wms)) {
        windSpeed = Math.max(windSpeed, Math.max(0, Math.min(1, wms / 78)));
      } else if (Number.isFinite(w01)) {
        windSpeed = Math.max(windSpeed, Math.max(0, Math.min(1, w01)));
      }
      if (s.windDirection) {
        const wx = Number(s.windDirection.x);
        const wy = Number(s.windDirection.y);
        if (Number.isFinite(wx) && Number.isFinite(wy)) {
          windDirX = wx;
          windDirY = wy;
        }
      }
    };

    try {
      applyState(weatherController?.currentState);
      applyState(weatherController?.targetState);
      const fbAsh = Number(window.MapShine?.__v2AshIntensity);
      if (Number.isFinite(fbAsh)) ashIntensity = Math.max(ashIntensity, fbAsh);

      const externalDrive = this._isEnvironmentExternallyDriven();
      if (externalDrive) {
        applyState(weatherController?.currentState ?? weatherController?.targetState);
      } else if (
        weatherController?.enabled !== false
        || weatherController?.dynamicEnabled === true
      ) {
        applyState(weatherController?.getCurrentState?.());
      }
    } catch (_) {}

    if (Math.hypot(windDirX, windDirY) < 1e-6) {
      const resolved = resolveEffectWindWorld();
      windDirX = resolved.dirX;
      windDirY = resolved.dirY;
      if (windSpeed <= 0.001) windSpeed = resolved.speed01;
    }

    return { ashIntensity, windSpeed, windDirX, windDirY };
  }

  /** @private */
  _ensureFallbackWhite() {
    const THREE = window.THREE;
    if (!THREE || this._fallbackWhite) return;
    const data = new Uint8Array([255, 255, 255, 255]);
    this._fallbackWhite = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    this._fallbackWhite.needsUpdate = true;
    this._fallbackWhite.flipY = false;
    this._fallbackWhite.generateMipmaps = false;
    this._fallbackWhite.minFilter = THREE.NearestFilter;
    this._fallbackWhite.magFilter = THREE.NearestFilter;
  }

  /** @private */
  _buildSpritePool() {
    const THREE = window.THREE;
    if (!THREE || !this._ashAnchor) return;

    for (const sprite of this._ashSprites) {
      try { this._ashAnchor.remove(sprite.mesh); } catch (_) {}
      sprite.dispose();
    }
    this._ashSprites = [];

    const maxPool = Math.max(4, Math.min(48, Math.round(Number(this.params.spritePoolSize) || 24)));
    const renderOrder = effectUnderOverheadOrder(this._activeFloorIndex, FLOOR_EFFECTS_TOP_INTRA);

    for (let i = 0; i < maxPool; i++) {
      const sprite = new AshCloudSprite(THREE, this.params);
      sprite.mesh.renderOrder = renderOrder;
      sprite.mesh.visible = false;
      this._ashAnchor.add(sprite.mesh);
      this._ashSprites.push(sprite);
    }

    this._texturePicker = new CloudTexturePicker(this._sparseTextures, this._fullTextures, this.params);
    this._lastActiveTotal = -1;
    this._invalidateViewSpawnCache();
    this._updateSceneBounds();
    if (this._sceneBoundsValid) {
      this._resetVisibleSprites(this._getAshWeatherState().strength);
    } else {
      this._needsSpriteRespread = true;
    }
  }

  /** @private */
  _syncFloorPlacement() {
    if (!this._ashAnchor) return;
    const fi = this._activeFloorIndex;
    const heightOff = Number(this.params.ashHeightOffset) || 0.28;
    this._ashAnchor.position.z = GROUND_Z + fi + heightOff;
    const renderOrder = effectUnderOverheadOrder(fi, FLOOR_EFFECTS_TOP_INTRA);
    for (const sprite of this._ashSprites) {
      sprite.mesh.renderOrder = renderOrder;
    }
  }

  /** @private @returns {boolean} */
  _updateSceneBounds() {
    const fd = window.MapShine?.sceneComposer?.foundrySceneData ?? null;
    const d = canvas?.dimensions;
    const rect = d?.sceneRect ?? d;
    const sceneX = Number(rect?.x ?? fd?.sceneX ?? d?.sceneX ?? 0);
    const sceneY = Number(rect?.y ?? fd?.sceneY ?? d?.sceneY ?? 0);
    const sceneW = Number(rect?.width ?? fd?.sceneWidth ?? d?.sceneWidth ?? 0);
    const sceneH = Number(rect?.height ?? fd?.sceneHeight ?? d?.sceneHeight ?? 0);
    const worldH = Number(fd?.height ?? d?.height ?? 0);

    if (!(sceneW > 0) || !(sceneH > 0) || !(worldH > 0)) {
      this._sceneGeometry = null;
      this._sceneBoundsValid = false;
      return false;
    }

    const minX = sceneX;
    const maxX = sceneX + sceneW;
    const minY = worldH - (sceneY + sceneH);
    const maxY = worldH - sceneY;
    const key = `${minX}|${minY}|${maxX}|${maxY}`;
    const changed = key !== this._lastSceneBoundsKey;
    this._lastSceneBoundsKey = key;

    this._sceneGeometry = {
      sceneX,
      sceneY,
      sceneW,
      sceneH,
      worldH,
      minX,
      maxX,
      minY,
      maxY,
      centerX: sceneX + sceneW * 0.5,
      centerY: worldH - (sceneY + sceneH * 0.5),
    };
    this._sceneBoundsValid = true;
    return changed;
  }

  /** @private */
  _syncAshAnchor() {
    const geom = this._sceneGeometry;
    if (!geom || !this._ashAnchor) return;
    this._ashAnchor.position.x = geom.centerX;
    this._ashAnchor.position.y = geom.centerY;
  }

  /**
   * @param {AshCloudSprite} sprite
   * @param {NonNullable<AshCloudEffectV2['_sceneGeometry']>} geom
   * @private
   */
  _applySpriteLocalPosition(sprite, geom) {
    sprite.mesh.position.set(
      (sprite.normU - 0.5) * geom.sceneW,
      (0.5 - sprite.normV) * geom.sceneH,
      0,
    );
  }

  /** @private */
  _applyAllVisibleSpriteLocalPositions() {
    const geom = this._sceneGeometry;
    if (!geom) return;
    this._syncAshAnchor();
    for (const sprite of this._ashSprites) {
      if (!sprite.mesh.visible) continue;
      this._applySpriteLocalPosition(sprite, geom);
    }
  }

  /** @private */
  _resolveSpawnDrift(ws) {
    const fromSim = this._windDriftUV(this._windVelocity);
    if (fromSim.len > 1e-4) return fromSim;

    this._tempVec2A.set(ws?.windDirX ?? 0, ws?.windDirY ?? 0);
    if (this._tempVec2A.lengthSq() < 1e-8) {
      const resolved = resolveEffectWindWorld();
      this._tempVec2A.set(resolved.dirX, resolved.dirY);
    }
    return this._windDriftUV(this._tempVec2A);
  }

  /**
   * Keep spawns over the playable map band — large billboards + outdoors mask discard
   * anything vertically/horizontally off the _Outdoors atlas.
   * @private
   */
  _sanitizeSpawnUV(u, v, geom, drift) {
    const { halfU, halfV } = this._maxSpriteNormHalfExtent(geom);
    const edgePad = Math.max(halfU, halfV) + 0.03;
    const maxUpwindDepth = UPWIND_SPAWN_DEPTH + OFF_STAGE_MARGIN * 0.35;

    let uOut = u;
    let vOut = Math.max(MAP_CORE_UV_MIN, Math.min(MAP_CORE_UV_MAX, v));

    if (drift.du < -0.01) {
      const minU = 1.0 + edgePad * 0.35;
      const maxU = 1.0 + edgePad + maxUpwindDepth;
      uOut = Math.max(minU, Math.min(maxU, u));
    } else if (drift.du > 0.01) {
      const maxU = -edgePad * 0.35;
      const minU = -(edgePad + maxUpwindDepth);
      uOut = Math.min(maxU, Math.max(minU, u));
    } else {
      uOut = Math.max(MAP_CORE_UV_MIN, Math.min(MAP_CORE_UV_MAX, u));
    }

    if (drift.dv < -0.01) {
      const minV = 1.0 + edgePad * 0.35;
      const maxV = 1.0 + edgePad + maxUpwindDepth;
      vOut = Math.max(minV, Math.min(maxV, vOut));
    } else if (drift.dv > 0.01) {
      const maxV = -edgePad * 0.35;
      const minV = -(edgePad + maxUpwindDepth);
      vOut = Math.min(maxV, Math.max(minV, vOut));
    }

    return { u: uOut, v: vOut };
  }

  /** @private */
  _invalidateViewSpawnCache() {
    this._viewSpawnState.cacheKey = '';
    this._viewSpawnState.points = null;
    this._viewSpawnState.pointCount = 0;
  }

  /**
   * Refresh camera-view _Ash spawn candidates (brightness-weighted, outdoors-filtered).
   * @private
   * @param {number} [nowMs]
   * @returns {boolean}
   */
  _updateViewAshSpawnCache(nowMs) {
    const geom = this._sceneGeometry;
    const cam = this._mainCamera;
    if (!geom || !cam || !this._viewProjCache) return false;

    const groundZ = GROUND_Z + this._activeFloorIndex + (Number(this.params.ashHeightOffset) || 0.28);
    updateSceneViewProjectionFromCamera(cam, groundZ, this._viewProjCache, this._viewProjTemps);
    if (!this._viewProjCache.isValid) return false;

    const rawView = worldBoundsToNormUv(
      this._viewProjCache.vMinX,
      this._viewProjCache.vMinY,
      this._viewProjCache.vMaxX,
      this._viewProjCache.vMaxY,
      geom,
    );
    const viewUv = padNormUvRect(rawView, VIEW_UV_PAD);

    const floorKey = window.MapShine?.floorStack?.getActiveFloor?.()?.compositorKey ?? null;
    const cacheKey = [
      floorKey ?? 'none',
      viewUv.uMin.toFixed(3),
      viewUv.uMax.toFixed(3),
      viewUv.vMin.toFixed(3),
      viewUv.vMax.toFixed(3),
    ].join('|');

    const now = Number(nowMs) || performance.now();
    if (
      cacheKey === this._viewSpawnState.cacheKey
      && (now - this._viewSpawnState.lastRefreshAt) < VIEW_SPAWN_CACHE_MIN_INTERVAL * 1000
    ) {
      return this._viewSpawnState.pointCount > 0;
    }

    const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
    let points = null;
    if (compositor && floorKey) {
      const ashRgba = compositor.getCpuPixelsForFloor(floorKey, 'ash');
      const ashDims = compositor.getOutputDims?.('ash');
      const ashW = ashDims?.width ?? 0;
      const ashH = ashDims?.height ?? 0;
      const outdoorsRgba = compositor.getCpuPixelsForFloor(floorKey, 'outdoors');
      const outdoorsDims = compositor.getOutputDims?.('outdoors');
      if (ashRgba && ashW > 1 && ashH > 1) {
        points = scanAshMaskPointsInView(ashRgba, ashW, ashH, viewUv, {
          outdoorsRgba,
          outdoorsW: outdoorsDims?.width ?? 0,
          outdoorsH: outdoorsDims?.height ?? 0,
        });
      }
    }

    this._viewSpawnState.points = points;
    this._viewSpawnState.viewUv = viewUv;
    this._viewSpawnState.pointCount = points ? Math.floor(points.length / 3) : 0;
    this._viewSpawnState.cacheKey = cacheKey;
    this._viewSpawnState.lastRefreshAt = now;
    this._viewSpawnState.floorKey = floorKey;
    return this._viewSpawnState.pointCount > 0;
  }

  /** @private */
  _isSpriteInView(sprite, viewUv = this._viewSpawnState.viewUv) {
    if (!sprite?.mesh?.visible || sprite._pendingDeactivate || !viewUv) return false;
    if (sprite._fadePhase === 'out' || (sprite.fadeMul ?? 0) <= 0.05) return false;
    return isNormUvInView(sprite.normU, sprite.normV, viewUv, 0.02);
  }

  /** @private */
  _countSpritesInView(viewUv = this._viewSpawnState.viewUv) {
    let count = 0;
    for (const sprite of this._ashSprites) {
      if (this._isSpriteInView(sprite, viewUv)) count += 1;
    }
    return count;
  }

  /**
   * Top up visible-camera puffs on bright _Ash mask texels.
   * @private
   */
  _maintainViewAshCoverage(strength, ws) {
    const geom = this._sceneGeometry;
    if (!geom || !this._texturePicker || this._isStrengthZero(strength)) return;

    const viewUv = this._viewSpawnState.viewUv;
    if (!viewUv) return;

    const activeTotal = Math.max(0, this._lastActiveTotal);
    const minInView = Math.min(
      activeTotal,
      Math.max(MIN_IN_VIEW_SPRITES, Math.round(activeTotal * 0.4)),
    );
    if (this._countSpritesInView(viewUv) >= minInView) return;

    const used = this._collectUsedTextures();
    let placed = 0;

    const candidates = this._ashSprites.filter((sprite) => {
      if (!sprite.mesh.visible || sprite._pendingDeactivate) return false;
      if (this._isSpriteInView(sprite, viewUv)) return false;
      return true;
    });

    candidates.sort((a, b) => {
      const view = viewUv;
      const aDist = Math.hypot(
        a.normU - (view.uMin + view.uMax) * 0.5,
        a.normV - (view.vMin + view.vMax) * 0.5,
      );
      const bDist = Math.hypot(
        b.normU - (view.uMin + view.uMax) * 0.5,
        b.normV - (view.vMin + view.vMax) * 0.5,
      );
      return bDist - aDist;
    });

    for (const sprite of candidates) {
      if (placed >= minInView - this._countSpritesInView(viewUv)) break;
      sprite.clearPendingDeactivate();
      sprite._awaitingRecycle = false;
      sprite.randomizeAppearance(strength, this._texturePicker, used, {
        spawnRotationRad: this._pickSpawnRotationRad(),
      });
      this._spawnInViewAtAsh(sprite, geom, ws.windSpeed);
      placed += 1;
    }
  }

  /** @private */
  _windDriftUV(wind) {
    const len = Math.hypot(wind.x, wind.y);
    if (len < 1e-6) {
      this._tempDriftUV.du = 0;
      this._tempDriftUV.dv = 0;
      this._tempDriftUV.len = 0;
      return this._tempDriftUV;
    }
    this._tempDriftUV.du = wind.x / len;
    this._tempDriftUV.dv = -(wind.y / len);
    this._tempDriftUV.len = len;
    return this._tempDriftUV;
  }

  /** @private */
  _isPastDownwindSceneEdge(sprite, drift) {
    if (drift.du > 0.01 && sprite.normU > 1) return true;
    if (drift.du < -0.01 && sprite.normU < 0) return true;
    if (drift.dv > 0.01 && sprite.normV > 1) return true;
    if (drift.dv < -0.01 && sprite.normV < 0) return true;
    return false;
  }

  /** @private */
  _maxSpriteNormHalfExtent(geom) {
    const scaleMax = Math.max(
      Number(this.params.spriteScaleMax) || 1400,
      Number(this.params.spriteScaleMin) || 400,
    );
    const worldHalf = scaleMax * 0.5;
    return {
      halfU: worldHalf / Math.max(1, geom.sceneW),
      halfV: worldHalf / Math.max(1, geom.sceneH),
    };
  }

  /** @private */
  _computeSpawnArcPadding(geom) {
    const { halfU, halfV } = this._maxSpriteNormHalfExtent(geom);
    const spritePad = Math.max(halfU, halfV) * (1 + SPAWN_ARC_SPRITE_PAD);
    return OFF_STAGE_MARGIN + spritePad;
  }

  /** @private */
  _spawnUVFromArc(along01, geom, drift, depth) {
    const pad = this._computeSpawnArcPadding(geom);
    const du = drift.du;
    const dv = drift.dv;
    const len = Math.hypot(du, dv);
    const t = Math.max(0, Math.min(1, along01));

    if (len < 1e-6) {
      const span = 1 + pad * 2;
      this._tempSpawnUV.u = -pad + Math.random() * span;
      this._tempSpawnUV.v = -pad + Math.random() * span;
      return this._tempSpawnUV;
    }

    const wu = du / len;
    const wv = dv / len;
    const pu = -wv;
    const pv = wu;
    const corners = [
      [-pad, -pad],
      [1 + pad, -pad],
      [1 + pad, 1 + pad],
      [-pad, 1 + pad],
    ];

    let tMin = Infinity;
    let tMax = -Infinity;
    let wMin = Infinity;
    for (const [cu, cv] of corners) {
      const proj = cu * pu + cv * pv;
      tMin = Math.min(tMin, proj);
      tMax = Math.max(tMax, proj);
      wMin = Math.min(wMin, cu * wu + cv * wv);
    }

    const targetW = wMin - depth;
    const alongT = tMin + t * (tMax - tMin);
    const det = pu * wv - pv * wu;
    if (Math.abs(det) < 1e-8) {
      this._tempSpawnUV.u = wu >= 0 ? -depth : 1 + depth;
      this._tempSpawnUV.v = -pad + t * (1 + pad * 2);
      return this._tempSpawnUV;
    }

    this._tempSpawnUV.u = (alongT * wv - pv * targetW) / det;
    this._tempSpawnUV.v = (pu * targetW - alongT * wu) / det;
    return this._tempSpawnUV;
  }

  /** @private */
  _advanceSpawnArcWalker(windSpeed) {
    const speed = Math.max(0, Math.min(1, Number(windSpeed) || 0));
    const stepScale = 0.016 + speed * 0.1;
    const jumpChance = 0.004 + speed * 0.028;
    if (Math.random() < jumpChance) {
      this._spawnArcWalker = Math.random();
      this._spawnArcClumping = 0.15 + Math.random() * 0.2;
    } else {
      this._spawnArcWalker += (Math.random() * 2 - 1) * stepScale * 2;
      this._spawnArcWalker -= Math.floor(this._spawnArcWalker);
      if (this._spawnArcWalker < 0) this._spawnArcWalker += 1;
      this._spawnArcClumping = Math.min(1, (this._spawnArcClumping ?? 0.5) + 0.1 * (1 - speed * 0.65));
    }
    const jitter = (Math.random() * 2 - 1) * (0.01 + speed * 0.012);
    return Math.max(0, Math.min(1, this._spawnArcWalker + jitter));
  }

  /** @private */
  _fadeInDurationForWind(windSpeed) {
    const base = Number(this.params.fadeInDuration) || ASH_FADE_IN_SEC;
    const speed = Math.max(0, Math.min(1, Number(windSpeed) || 0));
    return Math.max(0.4, base * (1 - speed * 0.4));
  }

  /** @private */
  _spawnUpwindOffStage(sprite, geom, drift, windSpeed) {
    sprite.beginFadeIn(this._fadeInDurationForWind(windSpeed));
    const depth = UPWIND_SPAWN_DEPTH + Math.random() * OFF_STAGE_MARGIN;
    const along = this._advanceSpawnArcWalker(windSpeed);
    const raw = this._spawnUVFromArc(along, geom, drift, depth);
    const sanitized = this._sanitizeSpawnUV(raw.u, raw.v, geom, drift);
    sprite.normU = sanitized.u;
    sprite.normV = sanitized.v;
    this._applySpriteLocalPosition(sprite, geom);
  }

  /**
   * Spawn in the current camera view on a bright _Ash mask texel (preferred).
   * @private
   */
  _spawnInViewAtAsh(sprite, geom, windSpeed) {
    sprite.beginFadeIn(this._fadeInDurationForWind(windSpeed));
    sprite._awaitingRecycle = false;

    const pick = pickWeightedAshSpawnPoint(this._viewSpawnState.points);
    if (pick) {
      const jitterU = (Math.random() * 2 - 1) * 0.014;
      const jitterV = (Math.random() * 2 - 1) * 0.014;
      sprite.normU = Math.max(0, Math.min(1, pick.u + jitterU));
      sprite.normV = Math.max(0, Math.min(1, pick.v + jitterV));
    } else {
      const uv = this._viewSpawnState.viewUv;
      if (uv) {
        sprite.normU = uv.uMin + Math.random() * Math.max(1e-4, uv.uMax - uv.uMin);
        sprite.normV = uv.vMin + Math.random() * Math.max(1e-4, uv.vMax - uv.vMin);
      } else {
        this._spawnOnMap(sprite, geom, windSpeed);
        return;
      }
    }

    this._applySpriteLocalPosition(sprite, geom);
  }

  /** @private Fallback when view/_Ash data unavailable. */
  _spawnOnMap(sprite, geom, windSpeed) {
    sprite.beginFadeIn(this._fadeInDurationForWind(windSpeed));
    sprite.normU = MAP_CORE_UV_MIN + Math.random() * (MAP_CORE_UV_MAX - MAP_CORE_UV_MIN);
    sprite.normV = MAP_CORE_UV_MIN + Math.random() * (MAP_CORE_UV_MAX - MAP_CORE_UV_MIN);
    this._applySpriteLocalPosition(sprite, geom);
  }

  /**
   * @param {AshCloudSprite} sprite
   * @param {NonNullable<AshCloudEffectV2['_sceneGeometry']>} geom
   * @param {{ du: number, dv: number, len: number }} drift
   * @param {number} windSpeed
   * @private
   */
  _spawnSpriteInitial(sprite, geom, drift, windSpeed) {
    void drift;
    if (this._viewSpawnState.pointCount > 0 || this._viewSpawnState.viewUv) {
      this._spawnInViewAtAsh(sprite, geom, windSpeed);
      return;
    }
    this._spawnOnMap(sprite, geom, windSpeed);
  }

  /** @private */
  _pickSpawnRotationRad() {
    return (Math.random() * 2 - 1) * (12 * Math.PI / 180);
  }

  /** @private */
  _collectUsedTextures() {
    const used = new Set();
    for (const sprite of this._ashSprites) {
      if (!sprite.mesh.visible) continue;
      const tex = sprite.getTexture();
      if (tex) used.add(tex);
    }
    return used;
  }

  /** @private */
  _initNewlyVisibleSprites(strength, previousVisibleTotal) {
    const geom = this._sceneGeometry;
    if (!geom || !this._texturePicker) return;

    const used = this._collectUsedTextures();
    const ws = this._getAshWeatherState();
    const drift = this._resolveSpawnDrift(ws);
    const windSpeed = ws.windSpeed;
    let idx = 0;

    for (const sprite of this._ashSprites) {
      if (!sprite.mesh.visible) continue;
      if (idx >= previousVisibleTotal) {
        sprite.randomizeAppearance(strength, this._texturePicker, used, {
          spawnRotationRad: this._pickSpawnRotationRad(),
        });
        this._spawnSpriteInitial(sprite, geom, drift, windSpeed);
      } else if (!Number.isFinite(sprite.spawnRotationRad)) {
        sprite.setSpawnRotation(this._pickSpawnRotationRad());
      }
      idx++;
    }
  }

  /** @private */
  _resetVisibleSprites(strength) {
    const geom = this._sceneGeometry;
    if (!geom || !this._texturePicker) return;

    this._updateViewAshSpawnCache(performance.now());

    const used = new Set();
    const ws = this._getAshWeatherState();
    const drift = this._resolveSpawnDrift(ws);
    const windSpeed = ws.windSpeed;
    this._spawnArcWalker = Math.random();
    this._spawnArcClumping = 0.45 + Math.random() * 0.35;

    for (const sprite of this._ashSprites) {
      if (!sprite.mesh.visible) continue;
      sprite.randomizeAppearance(strength, this._texturePicker, used, {
        spawnRotationRad: this._pickSpawnRotationRad(),
      });
      this._spawnSpriteInitial(sprite, geom, drift, windSpeed);
    }
    this._needsSpriteRespread = false;
  }

  /** @private */
  _targetActiveCount(strength, windSpeed) {
    const windBoost = 0.6 + 0.4 * Math.max(0, Math.min(1, windSpeed));
    const t = Math.max(0, Math.min(1, strength * windBoost));
    const poolMax = Math.min(
      MAX_ACTIVE_SPRITES,
      Math.max(MIN_ACTIVE_SPRITES, Math.round(Number(this.params.spritePoolSize) || 24)),
    );
    return Math.round(MIN_ACTIVE_SPRITES + (poolMax - MIN_ACTIVE_SPRITES) * t);
  }

  /** @private */
  _updateActiveSpriteCount(strength, windSpeed) {
    const total = this._targetActiveCount(strength, windSpeed);
    const previousVisibleTotal = this._lastActiveTotal >= 0 ? this._lastActiveTotal : 0;
    const countChanged = total !== this._lastActiveTotal;
    this._lastActiveTotal = total;

    for (let i = 0; i < this._ashSprites.length; i++) {
      const sprite = this._ashSprites[i];
      const shouldBeActive = i < total;

      if (shouldBeActive) {
        if (sprite._pendingDeactivate) {
          sprite.clearPendingDeactivate();
          sprite.mesh.visible = true;
          sprite.beginFadeIn(this._fadeInDurationForWind(windSpeed));
        } else if (!sprite.mesh.visible) {
          sprite.mesh.visible = true;
        }
      } else if (sprite.mesh.visible && !sprite._pendingDeactivate) {
        sprite.markPendingDeactivate();
      }
    }

    if (countChanged && total > previousVisibleTotal && previousVisibleTotal >= 0 && this._texturePicker) {
      this._initNewlyVisibleSprites(strength, previousVisibleTotal);
    }
  }

  /**
   * @param {AshCloudSprite} sprite
   * @private
   */
  _updateSpriteLifecycle(sprite, delta, geom, drift, windSpeed) {
    if (sprite._pendingDeactivate) {
      const fadeDone = sprite.updateFade(delta) === 'complete';
      this._applySpriteLocalPosition(sprite, geom);
      if (fadeDone && sprite.fadeMul <= 0.001) {
        sprite.mesh.visible = false;
        sprite.clearPendingDeactivate();
        sprite.fadeMul = 1;
      }
      return;
    }

    sprite.updateFade(delta);

    const pastEdge = this._isPastDownwindSceneEdge(sprite, drift);
    const fadeOut = Number(this.params.fadeOutDuration) || ASH_FADE_OUT_SEC;

    if (sprite._fadePhase === 'out' && !pastEdge) {
      sprite.beginFadeIn(this._fadeInDurationForWind(windSpeed));
    } else if (pastEdge && sprite._fadePhase === 'steady' && sprite.fadeMul > 0.001) {
      sprite.beginFadeOut(fadeOut);
    }

    if (sprite._fadePhase === 'steady' && sprite.fadeMul <= 0.001 && pastEdge) {
      sprite._awaitingRecycle = true;
    }

    if (sprite._awaitingRecycle && sprite._fadePhase === 'steady' && sprite.fadeMul <= 0.001) {
      this._updateViewAshSpawnCache(performance.now());
      this._spawnInViewAtAsh(sprite, geom, windSpeed);
    } else {
      this._applySpriteLocalPosition(sprite, geom);
    }
  }

  /**
   * @param {number} delta
   * @param {{ windSpeed: number }} ws
   * @private
   */
  _simulateSprites(delta, ws) {
    const wind = this._windVelocity;
    const geom = this._sceneGeometry;
    if (!geom) return;

    const viewW = Math.max(1, geom.maxX - geom.minX);
    const viewH = Math.max(1, geom.maxY - geom.minY);
    const worldScale = Math.max(viewW, viewH) * 0.35;
    const normScaleU = worldScale / Math.max(1, geom.sceneW);
    const normScaleV = worldScale / Math.max(1, geom.sceneH);
    const drift = this._windDriftUV(wind);
    const windSpeed = ws.windSpeed;

    for (const sprite of this._ashSprites) {
      if (!sprite.mesh.visible) continue;

      if (drift.len > 1e-6) {
        const baseAngle = Math.atan2(wind.y, wind.x);
        const angle = baseAngle + (sprite.windAngleRad ?? 0);
        const speed = drift.len * (sprite.windSpeedMult ?? 1) * delta;
        sprite.normU += Math.cos(angle) * speed * normScaleU;
        sprite.normV -= Math.sin(angle) * speed * normScaleV;
      }

      const orbitStrength = Math.max(0, Number(this.params.driftOrbitStrength) ?? 0);
      if (orbitStrength > 1e-6) {
        const orbit = (sprite.orbitRadius ?? 0.0015) * orbitStrength;
        sprite.orbitPhase += delta * (sprite.orbitSpeed ?? 0.7);
        sprite.normU += Math.cos(sprite.orbitPhase) * orbit * normScaleU;
        sprite.normV += Math.sin(sprite.orbitPhase * 1.27) * orbit * normScaleV;
      }

      this._updateSpriteLifecycle(sprite, delta, geom, drift, windSpeed);
    }
    this._syncAshAnchor();
  }

  /** @private */
  _advanceWindSim(delta, windDirX, windDirY, windSpeed) {
    const p = this.params;
    const targetSpd = Math.max(windSpeed * p.windInfluence * p.driftSpeed, p.minDriftSpeed || 0);
    const resp = Math.max(0, p.driftResponsiveness ?? 0.45);
    const maxSpd = Math.max(0, p.driftMaxSpeed ?? 0.55);
    const alpha = resp > 0 ? (1 - Math.exp(-resp * delta)) : 1;

    this._tempVec2A.set(windDirX, windDirY);
    if (this._tempVec2A.lengthSq() > 1e-6) this._tempVec2A.normalize();
    this._tempVec2A.multiplyScalar(targetSpd);
    this._windVelocity.lerp(this._tempVec2A, alpha);
    const vl = this._windVelocity.length();
    if (vl > maxSpd && vl > 1e-6) this._windVelocity.multiplyScalar(maxSpd / vl);
  }

  /** @private */
  _updateShaderUniforms(ws) {
    const p = this.params;
    const ashColor = p.ashColor ?? { r: 0.157, g: 0.149, b: 0.141 };
    const warpTime = this._lastElapsed * Math.max(0, Number(p.domainWarpSpeed) ?? 1);
    const warpStrength = Math.max(0, Number(p.domainWarpStrength) ?? 0);
    const revealScale = Math.max(1e-8, Number(p.revealNoiseScale) ?? 0.00012);
    const revealThreshold = Number(p.revealThreshold) ?? 0.55;
    const revealSoftness = Number(p.revealSoftness) ?? 0.18;
    const opacityCap = Math.max(0, Number(p.opacityCap) ?? 0.14);

    for (const sprite of this._ashSprites) {
      if (!sprite.mesh.visible) continue;
      const u = sprite.material?.uniforms;
      if (!u) continue;

      if (u.uAshColor?.value?.set) u.uAshColor.value.set(ashColor.r, ashColor.g, ashColor.b);
      if (u.uOpacityCap) u.uOpacityCap.value = opacityCap;
      if (u.uWarpSeed?.value?.set) u.uWarpSeed.value.set(sprite.warpSeedX ?? 0, sprite.warpSeedY ?? 0);
      if (u.uWarpStrength) u.uWarpStrength.value = warpStrength;
      if (u.uTime) u.uTime.value = warpTime;
      if (u.uRevealNoiseScale) u.uRevealNoiseScale.value = revealScale;
      if (u.uRevealThreshold) u.uRevealThreshold.value = revealThreshold;
      if (u.uRevealSoftness) u.uRevealSoftness.value = revealSoftness;
      if (u.uRevealSeed?.value?.set) {
        u.uRevealSeed.value.set(sprite.revealSeedX ?? 0, sprite.revealSeedY ?? 0);
      }
    }

    void ws;
  }

  /** @private */
  _updateMaskUniforms() {
    const geom = this._sceneGeometry;
    const fd = window.MapShine?.sceneComposer?.foundrySceneData ?? null;
    const d = canvas?.dimensions;
    const rect = d?.sceneRect ?? d;
    const sceneX = geom?.sceneX ?? Number(rect?.x ?? fd?.sceneX ?? d?.sceneX ?? 0);
    const sceneY = geom?.sceneY ?? Number(rect?.y ?? fd?.sceneY ?? d?.sceneY ?? 0);
    const sceneW = geom?.sceneW ?? Number(rect?.width ?? fd?.sceneWidth ?? d?.sceneWidth ?? 4000);
    const sceneH = geom?.sceneH ?? Number(rect?.height ?? fd?.sceneHeight ?? d?.sceneHeight ?? 3000);
    const sceneDimW = Number(d?.width ?? fd?.width ?? sceneW);
    const sceneDimH = Number(d?.height ?? fd?.height ?? sceneH);

    const maskPayload = {
      outdoorsMask: this._outdoorsMask,
      outdoorsMasks: this._outdoorsMasks,
      floorIdTex: this._floorIdTex,
      fallbackWhite: this._fallbackWhite,
      sceneOriginX: sceneX,
      sceneOriginY: sceneY,
      sceneW,
      sceneH,
      sceneDimW,
      sceneDimH,
    };

    for (const sprite of this._ashSprites) {
      if (!sprite.mesh.visible) continue;
      applyAshCloudMaskUniforms(sprite.material, maskPayload);
    }
  }

  /** @private */
  _isEnvironmentExternallyDriven() {
    try {
      return window.MapShine?.environmentControlApi?.isExternallyDriven?.() === true;
    } catch (_) {
      return false;
    }
  }

  /** @private */
  _getAshWeatherState() {
    const { ashIntensity, windSpeed, windDirX, windDirY } = this._readAshChannelScalars();

    let envelope = 1.0;
    try {
      envelope = weatherController?.getAshEmissionEnvelope?.() ?? 1.0;
    } catch (_) {}

    const strength = Math.max(0, Math.min(1, ashIntensity * envelope));

    return {
      weatherEnabled: this.enabled !== false && this.params.enabled !== false,
      ashIntensity,
      envelope,
      strength,
      windDirX,
      windDirY,
      windSpeed,
    };
  }

  /** @private */
  _isStrengthZero(strength) {
    return (strength ?? 0) < ASH_STRENGTH_EPSILON;
  }
}
