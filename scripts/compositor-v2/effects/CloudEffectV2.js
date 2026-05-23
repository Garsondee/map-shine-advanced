/**
 * @fileoverview CloudEffectV2 — sprite-based volumetric cloud orchestrator.
 *
 * REFACTOR NOTE (procedural → sprites):
 * REMOVED: _densityRT, _topDensityRT, _shadowDensityRT, _createDensityMaterial,
 *   _createCloudTopMaterial, 6-octave Simplex/FBM shaders, 5-layer noise wind,
 *   domain warp, blocker/occluder RT path.
 * NEW: CloudSprite pool + PNG assets, ortho _cloudScene capture, per-sprite
 *   shadow materials, slim outdoors mask compositor, 3 world blit planes.
 *
 * @module compositor-v2/effects/CloudEffectV2
 */

import { createLogger } from '../../core/log.js';
import { loadTexture } from '../../assets/loader.js';
import { weatherController } from '../../core/WeatherController.js';
import { resolveEffectShadowSun2D } from '../shadow-system/ShadowSunDirection.js';
import {
  CloudSprite,
  CloudTexturePicker,
  CLOUD_ASSET_BASE,
  COVER_FOR_MAX,
  COVER_FOR_MIN,
  FULL_CLOUD_FILES,
  LAYER_COUNT,
  LAYER_PARALLAX,
  LAYER_POOL_COUNTS,
  MAX_ACTIVE_SPRITES,
  MAX_SPRITE_POOL_SIZE,
  MIN_ACTIVE_SPRITES,
  SPARSE_CLOUD_FILES,
  SPRITE_FADE_DURATION_SEC,
} from './cloud-sprites/CloudSprite.js';
import { createCloudLayerMaterialTemplate, createShadowMaskMaterial } from './cloud-sprites/cloud-shaders.js';
import { getCloudControlSchema } from './cloud-sprites/cloud-control-schema.js';

const log = createLogger('CloudEffectV2');

/** Norm-space margin beyond 0..1 before a sprite is recycled off the downwind edge. */
const OFF_STAGE_MARGIN = 0.28;
/** Extra norm-space depth for upwind spawns (fully off-stage before drifting in). */
const UPWIND_SPAWN_DEPTH = 0.2;
/** Scene-span padding for wrap/roam bounds (fraction of scene width/height). */
const WRAP_BOUNDS_PAD = 0.24;
/** Extra norm-space padding beyond sprite half-extent on the spawn arc. */
const SPAWN_ARC_SPRITE_PAD = 0.06;

export class CloudEffectV2 {
  constructor() {
    this.enabled = true;
    this._initialized = false;
    this._assetsLoaded = false;

    this.params = {
      enabled: true,
      internalResolutionScale: 0.5,
      shadowResolutionScale: 0.35,
      cloudCover: 0.5,

      // Sprite pool
      spritePoolSize: 40,
      spriteScaleMin: 1000,
      spriteScaleMax: 3000,
      spriteOpacityMin: 0.6,
      spriteOpacityMax: 1.0,
      sparseWeight: -1,

      // Shadow
      shadowOpacity: 0.7,
      shadowSoftness: 0.9,
      shadowOffsetScale: 0.3,
      minShadowBrightness: 0.0,
      shadowSceneFadeSoftness: 0.025,

      // Cloud tops (screen capture + 3D overlay)
      cloudTopOpacity: 1.0,
      cloudTopAlphaStart: 0.2,
      cloudTopAlphaEnd: 0.6,
      cloudTopFadeStart: 0.24,
      cloudTopFadeEnd: 0.39,
      cloudBrightness: 1.01,
      skyTintStrength: 0.85,
      sunLightingStrength: 0.65,
      nightDimStrength: 0.75,
      overlayDomainWarpStrength: 0.035,
      spriteBoilStrength: 0.025,
      domainWarpSpeed: 1.0,
      driftOrbitStrength: 0.15,
      lightningCloudEnabled: true,
      lightningCloudBrightnessBoost: 3.0,
      lightningCloudContrastBoost: 2.5,
      lightningCloudTintStrength: 0.8,

      // Elevated blit planes (3 fixed layers)
      cloudLayerCoverageScale: 3.0,
      cloudLayerDepthScaleStep: 0.18,
      cloudLayerHeightFromGround: 200,
      cloudLayer1HeightFromGround: 0,
      cloudLayer2HeightFromGround: 150,
      cloudLayer3HeightFromGround: 300,
      cloudLayerZSpacing: 220,
      cloudLayerBaseOffsetFromEmitter: -2200,
      cloudLayerEdgeSoftness: 0.12,
      cloudLayerOpacityBase: 0.75,
      cloudLayerOpacityFalloff: 0.35,
      cloudLayerOuterReveal: 0.3,
      cloudLayerMidReveal: 0.9,
      cloudLayerNoiseScale: 0.0008,
      cloudLayerNoiseSoftness: 0.12,
      cloudLayerDriftStrength: 0.02,
      cloudLayerDriftDepthBoost: 0.015,
      layerParallaxBase: 1.0,
      layer1ParallaxMult: 1.0,
      layer2ParallaxMult: 0.64,
      layer3ParallaxMult: 0.28,

      // Wind
      windInfluence: 1.33,
      driftSpeed: 0.01,
      minDriftSpeed: 0.002,
      driftResponsiveness: 0.4,
      driftMaxSpeed: 0.5,
    };

    this._shadowRT = null;
    this._shadowWindowRT = null;
    this._shadowRawRT = null;
    this._cloudTopRT = null;

    this._shadowMaskMat = null;
    this._cloudLayerMatTemplate = null;
    this._texturePicker = null;

    this._quadScene = null;
    this._quadCam = null;
    this._quad = null;

    this._cloudScene = null;
    this._cloudAnchor = null;
    this._cloudLayerGroups = [];
    this._cloudSprites = [];
    this._cloudCaptureCam = null;

    this._cloudLayerScene = null;
    this._cloudLayerMeshes = [];
    this._cloudLayerCount = 3;

    this._renderer = null;
    this._busScene = null;
    this._mainCamera = null;
    this._outdoorsMask = null;
    this._outdoorsMasks = [null, null, null, null];
    this._floorIdTex = null;

    this._sparseTextures = [];
    this._fullTextures = [];

    this._fallbackWhite = null;
    this._windOffset = null;
    this._windVelocity = null;

    this._sunDir = null;
    this._driverShadowSoftnessScale = 1.0;
    this._driverShadowLengthScale = 1.0;
    this._tintNight = null;
    this._tintSunrise = null;
    this._tintDay = null;
    this._tintSunset = null;
    this._tintResult = null;
    /** @type {{ skyTintColor: { r: number, g: number, b: number }, sunAzimuthDeg: number, sunElevationDeg: number, skyIntensity01: number, sceneDarkness01: number }} */
    this._skyState = {
      skyTintColor: { r: 1.0, g: 1.0, b: 1.0 },
      sunAzimuthDeg: 180.0,
      sunElevationDeg: 45.0,
      skyIntensity01: 1.0,
      sceneDarkness01: 0.0,
    };
    this._lightingCacheBucket = '';
    this._lastAppliedLightingBucket = '';

    this._tempVec2A = null;
    this._tempVec2B = null;
    this._tempDriftUV = { du: 0, dv: 0, len: 0 };
    this._tempSpawnUV = { u: 0, v: 0 };
    this._tempSize = null;
    this._lastElapsed = 0;
    this._needsNeutralClear = false;
    this._cloudCoverZeroLF = false;
    this._cloudCoverEpsilon = 0.0001;

    this._viewBounds = { minX: 0, minY: 0, maxX: 4000, maxY: 3000 };
    this._sceneBounds = { minX: 0, minY: 0, maxX: 4000, maxY: 3000 };
    this._captureBounds = { minX: 0, minY: 0, maxX: 4000, maxY: 3000 };
    this._wrapBounds = { minX: 0, minY: 0, maxX: 4000, maxY: 3000 };
    this._sceneBoundsValid = false;
    this._lastSceneBoundsKey = '';
    this._sceneGeometry = null;
    this._needsSpriteRespread = false;
    /** @type {number[]} Sprites allocated per depth layer. */
    this._layerPoolSizes = [...LAYER_POOL_COUNTS];
    this._lastActiveTotal = -1;
    this._savedCloudScenePos = null;
    /** 0..1 walker along the wind-perpendicular spawn arc (clumps vs scatter). */
    this._spawnArcWalker = Math.random();
    /** Rises while the walker creeps; drops on long jumps (larger cloud clumps). */
    this._spawnArcClumping = 0.5;

    this._lastFullW = 0;
    this._lastFullH = 0;
    this._lastInternalW = 0;
    this._lastInternalH = 0;
    this._lastShadowInternalW = 0;
    this._lastShadowInternalH = 0;
    this._lastRTSceneKey = '';
    this._activePerfRecorder = null;

    /** Cached shadow pass keys — skip RT work when inputs are unchanged (no active sprites only). */
    this._shadowRawCacheKey = '';
    this._shadowMaskCacheKey = '';
    this._cloudTopCacheKey = '';
    /** World-space bucket size for view-bound driven shadow mask UVs. */
    this._shadowViewQuant = 2.5;
    this._shadowCacheStats = {
      rawHit: 0, rawMiss: 0, rawStale: 0,
      maskHit: 0, maskMiss: 0,
      cloudTopHit: 0, cloudTopMiss: 0,
      lastMissReason: '',
    };
  }

  // ── Performance Recorder ───────────────────────────────────────────────────

  /** @private */
  _bindPerfRecorder() {
    try {
      const recorder = window.MapShine?.performanceRecorder;
      this._activePerfRecorder = recorder?.enabled ? recorder : null;
    } catch (_) {
      this._activePerfRecorder = null;
    }
  }

  /** @private */
  _beginPerfSpan(name, phase = 'render', options = {}) {
    try {
      const recorder = this._activePerfRecorder;
      if (!recorder?.enabled || typeof recorder.beginEffectCall !== 'function') return null;
      return recorder.beginEffectCall(`cloud.${phase}.${name}`, phase, options);
    } catch (_) {
      return null;
    }
  }

  /** @private */
  _beginLegacyAggregateSpan(effectKey, phase) {
    try {
      const recorder = this._activePerfRecorder;
      if (!recorder?.enabled || typeof recorder.beginEffectCall !== 'function') return null;
      return recorder.beginEffectCall(effectKey, phase, { cpuOnly: true });
    } catch (_) {
      return null;
    }
  }

  /** @param {object|null} token @private */
  _endPerfSpan(token) {
    if (!token) return;
    try {
      const recorder = this._activePerfRecorder ?? window.MapShine?.performanceRecorder;
      recorder?.endEffectCall?.(token);
    } catch (_) {}
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} busScene
   * @param {THREE.Camera} mainCamera
   */
  initialize(renderer, busScene, mainCamera) {
    const THREE = window.THREE;
    if (!THREE) { log.error('THREE not available'); return; }

    this._renderer = renderer;
    this._busScene = busScene;
    this._mainCamera = mainCamera;

    this._windOffset = new THREE.Vector2(0, 0);
    this._windVelocity = new THREE.Vector2(0, 0);
    this._tempVec2A = new THREE.Vector2();
    this._tempVec2B = new THREE.Vector2();
    this._tempSize = new THREE.Vector2();

    this._sunDir = new THREE.Vector2(0, 1);
    this._tintNight = new THREE.Vector3(0.13, 0.15, 0.20);
    this._tintSunrise = new THREE.Vector3(1.00, 0.70, 0.50);
    this._tintDay = new THREE.Vector3(1.00, 1.00, 1.00);
    this._tintSunset = new THREE.Vector3(1.00, 0.60, 0.40);
    this._tintResult = new THREE.Vector3(1.00, 1.00, 1.00);

    this._quadScene = new THREE.Scene();
    this._quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this._quad.frustumCulled = false;
    this._quadScene.add(this._quad);

    this._cloudScene = new THREE.Scene();
    this._cloudAnchor = new THREE.Group();
    this._cloudAnchor.name = 'CloudAnchor';
    this._cloudScene.add(this._cloudAnchor);
    this._cloudLayerGroups = [];
    for (let i = 0; i < LAYER_COUNT; i++) {
      const group = new THREE.Group();
      group.renderOrder = i;
      this._cloudAnchor.add(group);
      this._cloudLayerGroups.push(group);
    }

    this._cloudCaptureCam = new THREE.OrthographicCamera(0, 1, 1, 0, -5000, 5000);
    this._cloudCaptureCam.position.set(0, 0, 1000);
    this._cloudCaptureCam.up.set(0, 1, 0);
    this._cloudCaptureCam.lookAt(0, 0, 0);
    this._savedCloudScenePos = new THREE.Vector3();

    this._shadowMaskMat = createShadowMaskMaterial(THREE);
    this._cloudLayerMatTemplate = createCloudLayerMaterialTemplate(THREE);
    this._ensureCloudLayerPlanes();
    this._ensureFallbackWhite();

    this._initialized = true;
    log.info('CloudEffectV2 initialized');

    this._loadCloudTextures()
      .then(() => {
        this._assetsLoaded = true;
        this._buildSpritePool();
        log.info(`CloudEffectV2 loaded ${this._sparseTextures.length} sparse + ${this._fullTextures.length} full textures`);
      })
      .catch((err) => {
        log.error('CloudEffectV2 asset load failed:', err);
      });
  }

  /** Re-sync sun direction after ShadowDriverState.publish (eliminates 1-frame lag). */
  syncSunFromDriver() {
    this._calcSunDir();
  }

  /**
   * Receives live sky state from FloorCompositor (after SkyColorEffectV2 update).
   * @param {{ skyTintColor?: { r?: number, g?: number, b?: number }, sunAzimuthDeg?: number, sunElevationDeg?: number, skyIntensity01?: number, sceneDarkness01?: number }} state
   */
  setSkyState(state = {}) {
    const tint = state?.skyTintColor;
    this._skyState = {
      skyTintColor: {
        r: Math.max(0.0, Number(tint?.r) || 1.0),
        g: Math.max(0.0, Number(tint?.g) || 1.0),
        b: Math.max(0.0, Number(tint?.b) || 1.0),
      },
      sunAzimuthDeg: Number.isFinite(Number(state?.sunAzimuthDeg)) ? Number(state.sunAzimuthDeg) : 180.0,
      sunElevationDeg: Number.isFinite(Number(state?.sunElevationDeg)) ? Number(state.sunElevationDeg) : 45.0,
      skyIntensity01: Number.isFinite(Number(state?.skyIntensity01))
        ? Math.max(0.0, Math.min(1.0, Number(state.skyIntensity01)))
        : 1.0,
      sceneDarkness01: Number.isFinite(Number(state?.sceneDarkness01))
        ? Math.max(0.0, Math.min(1.0, Number(state.sceneDarkness01)))
        : 0.0,
    };
  }

  /**
   * Tweakpane / preset hook — apply a single param and run side effects.
   * @param {string} paramId
   * @param {*} value
   */
  applyParamChange(paramId, value) {
    if (!this.params || !Object.prototype.hasOwnProperty.call(this.params, paramId)) return;
    if (typeof value === 'number' && !Number.isFinite(value)) return;
    this.params[paramId] = value;
    if (paramId === 'spritePoolSize' && this._assetsLoaded) {
      this._buildSpritePool();
    } else if (paramId === 'sparseWeight' && this._assetsLoaded) {
      this._texturePicker = new CloudTexturePicker(this._sparseTextures, this._fullTextures, this.params);
      this._resetVisibleSprites(this._getWeatherState().cloudCover);
    }
    if (this._paramAffectsShadowPassCache(paramId)) {
      this._invalidateShadowPassCache();
    }
  }

  setOutdoorsMask(texture) {
    const t = texture ?? null;
    if (this._outdoorsMask === t) return;
    this._outdoorsMask = t;
    this._invalidateShadowPassCache();
  }

  setOutdoorsMasks(textures) {
    if (!Array.isArray(textures)) return;
    let changed = false;
    for (let i = 0; i < 4; i++) {
      const t = textures[i] ?? null;
      if (this._outdoorsMasks[i] !== t) {
        this._outdoorsMasks[i] = t;
        changed = true;
      }
    }
    if (changed) this._invalidateShadowPassCache();
  }

  setFloorIdTexture(texture) {
    const t = texture ?? null;
    if (this._floorIdTex === t) return;
    this._floorIdTex = t;
    this._invalidateShadowPassCache();
  }

  /** @deprecated Blocker path removed; kept for FloorCompositor compatibility. */
  setUpperFloorOccluderMask(_texture) {}

  /** @deprecated Blocker path removed; kept for FloorCompositor compatibility. */
  setUpperFloorMaskBuilder(_fn) {}

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
  async _loadCloudTextures() {
    const THREE = window.THREE;
    if (!THREE) return;

    const loadFolder = async (folder, files) => {
      const out = [];
      for (const file of files) {
        const url = `${CLOUD_ASSET_BASE}/${folder}/${file}`;
        try {
          const tex = await loadTexture(url, { role: 'MASK_COLOR', suppressProbeErrors: true });
          if (!tex) continue;
          tex.generateMipmaps = false;
          tex.minFilter = THREE.LinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.wrapS = THREE.ClampToEdgeWrapping;
          tex.wrapT = THREE.ClampToEdgeWrapping;
          out.push(tex);
        } catch (err) {
          log.warn(`CloudEffectV2: failed to load ${url}`, err);
        }
      }
      return out;
    };

    const [sparse, full] = await Promise.all([
      loadFolder('sparse', SPARSE_CLOUD_FILES),
      loadFolder('full', FULL_CLOUD_FILES),
    ]);
    this._sparseTextures = sparse;
    this._fullTextures = full;
  }

  /** @private */
  _buildSpritePool() {
    const THREE = window.THREE;
    if (!THREE || !this._cloudScene) return;

    for (const sprite of this._cloudSprites) {
      try { this._cloudLayerGroups[sprite.layerIndex]?.remove(sprite.mesh); } catch (_) {}
      sprite.dispose();
    }
    this._cloudSprites = [];

    const maxPool = Math.max(1, Math.min(MAX_SPRITE_POOL_SIZE, Math.round(Number(this.params.spritePoolSize) || 40)));
    const counts = this._splitPoolCounts(maxPool);
    this._layerPoolSizes = counts;

    for (let layer = 0; layer < LAYER_COUNT; layer++) {
      const group = this._cloudLayerGroups[layer];
      if (!group) continue;
      for (let i = 0; i < counts[layer]; i++) {
        const sprite = new CloudSprite(THREE, this._sparseTextures, this._fullTextures, this.params);
        sprite.layerIndex = layer;
        sprite.mesh.renderOrder = layer;
        group.add(sprite.mesh);
        this._cloudSprites.push(sprite);
      }
    }

    this._updateViewBounds();
    if (!this._updateSceneBounds()) {
      this._needsSpriteRespread = true;
    }
    this._updateWrapBounds();
    const ws = this._getWeatherState();
    this._texturePicker = new CloudTexturePicker(this._sparseTextures, this._fullTextures, this.params);
    this._lastActiveTotal = -1;
    this._calcSunDir();
    this._updateActiveSpriteCount(ws.cloudCover);
    if (this._sceneBoundsValid) {
      this._resetVisibleSprites(ws.cloudCover);
    } else {
      this._needsSpriteRespread = true;
    }
  }

  /** @private */
  _getGroundZ() {
    const sc = window.MapShine?.sceneComposer;
    const groundZRaw = Number(sc?.groundZ);
    if (Number.isFinite(groundZRaw)) return groundZRaw;
    const meshZ = Number(sc?.basePlaneMesh?.position?.z);
    if (Number.isFinite(meshZ)) return meshZ;
    return 1000;
  }

  /**
   * Resolve scene rect in Three world XY (matches FloorRenderBus / SceneRectScissor).
   * Prefers `canvas.dimensions.sceneRect` for x/y/w/h; uses composer height for Y flip.
   * @returns {boolean} true when bounds changed
   * @private
   */
  _updateSceneBounds() {
    const fd = window.MapShine?.sceneComposer?.foundrySceneData ?? null;
    const d = typeof canvas !== 'undefined' ? canvas?.dimensions : null;
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
    this._sceneBounds.minX = minX;
    this._sceneBounds.minY = minY;
    this._sceneBounds.maxX = maxX;
    this._sceneBounds.maxY = maxY;
    this._sceneBoundsValid = true;
    return changed;
  }

  /**
   * @param {import('./cloud-sprites/CloudSprite.js').CloudSprite} sprite
   * @param {NonNullable<CloudEffectV2['_sceneGeometry']>} geom
   * @private
   */
  _applySpriteLocalPosition(sprite, geom) {
    sprite.mesh.position.set(
      (sprite.normU - 0.5) * geom.sceneW,
      (0.5 - sprite.normV) * geom.sceneH,
      -(sprite.layerIndex ?? 0) * 0.01,
    );
  }

  /** @private */
  _syncCloudAnchor() {
    const geom = this._sceneGeometry;
    const anchor = this._cloudAnchor;
    if (!geom || !anchor) return;
    anchor.position.set(geom.centerX, geom.centerY, this._getGroundZ());
  }

  /** @private */
  _applyAllVisibleSpriteLocalPositions() {
    const geom = this._sceneGeometry;
    if (!geom) return;
    this._syncCloudAnchor();
    for (const sprite of this._cloudSprites) {
      if (!sprite.mesh.visible) continue;
      this._applySpriteLocalPosition(sprite, geom);
    }
  }

  /**
   * @param {import('./cloud-sprites/CloudSprite.js').CloudSprite} sprite
   * @param {NonNullable<CloudEffectV2['_sceneGeometry']>} geom
   * @param {number} u
   * @param {number} v
   * @private
   */
  _placeSpriteAtNorm(sprite, geom, u, v) {
    sprite.normU = u;
    sprite.normV = v;
    this._applySpriteLocalPosition(sprite, geom);
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

  /**
   * True when the sprite center has crossed the scene edge on the downwind side.
   * @private
   */
  _isPastDownwindSceneEdge(sprite, drift) {
    if (drift.du > 0.01 && sprite.normU > 1) return true;
    if (drift.du < -0.01 && sprite.normU < 0) return true;
    if (drift.dv > 0.01 && sprite.normV > 1) return true;
    if (drift.dv < -0.01 && sprite.normV < 0) return true;
    return false;
  }

  /**
   * True when the sprite has drifted far enough past the downwind edge to recycle.
   * @private
   */
  _hasExitedDownwind(sprite, drift) {
    const m = OFF_STAGE_MARGIN;
    if (drift.du > 0.01 && sprite.normU > 1 + m) return true;
    if (drift.du < -0.01 && sprite.normU < -m) return true;
    if (drift.dv > 0.01 && sprite.normV > 1 + m) return true;
    if (drift.dv < -0.01 && sprite.normV < -m) return true;
    return false;
  }

  /**
   * Worst-case sprite half-extent in norm U/V (largest layer + scale max).
   * @private
   */
  _maxSpriteNormHalfExtent(geom) {
    const p = this.params;
    const scaleMax = Math.max(
      Number(p.spriteScaleMax) || 3000,
      Number(p.spriteScaleMin) || 1000,
    );
    const layerBoost = 1 + Math.max(0, LAYER_COUNT - 1) * 0.12;
    const worldHalf = scaleMax * layerBoost * 0.5;
    return {
      halfU: worldHalf / Math.max(1, geom.sceneW),
      halfV: worldHalf / Math.max(1, geom.sceneH),
    };
  }

  /**
   * Norm-space pad so sprite billboards cover scene edges on the spawn arc.
   * @private
   */
  _computeSpawnArcPadding(geom) {
    const { halfU, halfV } = this._maxSpriteNormHalfExtent(geom);
    const spritePad = Math.max(halfU, halfV) * (1 + SPAWN_ARC_SPRITE_PAD);
    return OFF_STAGE_MARGIN + spritePad;
  }

  /**
   * Map arc parameter + upwind depth to norm UV on the padded spawn boundary.
   * Works for any wind bearing (full diagonal upwind edge, not just one axis).
   * @private
   */
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

  /**
   * Random-walk along the spawn arc; calm wind clumps, strong wind scatters.
   * @private
   * @returns {number} 0..1 position along arc
   */
  _advanceSpawnArcWalker(windSpeed) {
    const speed = Math.max(0, Math.min(1, Number(windSpeed) || 0));
    const stepScale = 0.016 + speed * 0.1;
    const jumpChance = 0.004 + speed * 0.028;
    const jumped = Math.random() < jumpChance;

    if (jumped) {
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

  /** @private Slightly enlarge sprites while the arc walker is clumping. */
  _applySpawnClumpScale(sprite) {
    const clump = this._spawnArcClumping ?? 0.5;
    if (clump <= 0.58) return;
    const boost = 1 + (clump - 0.58) * 0.42;
    sprite.root.scale.multiplyScalar(boost);
  }

  /**
   * Place sprite off-stage upwind so it drifts into view. Never changes texture.
   * @private
   */
  _spawnUpwindOffStage(sprite, geom, drift, windSpeed) {
    sprite.beginFadeIn(SPRITE_FADE_DURATION_SEC);
    const depth = UPWIND_SPAWN_DEPTH + Math.random() * OFF_STAGE_MARGIN;
    const along = this._advanceSpawnArcWalker(windSpeed);
    const { u, v } = this._spawnUVFromArc(along, geom, drift, depth);
    sprite.normU = u;
    sprite.normV = v;
    this._applySpriteLocalPosition(sprite, geom);
  }

  /** @private */
  _initNewlyVisibleSprites(cover, previousVisibleTotal) {
    const geom = this._sceneGeometry;
    if (!geom || !this._texturePicker) return;

    const used = this._collectUsedTextures();
    const drift = this._windDriftUV(this._windVelocity);
    const windSpeed = this._getWeatherState().windSpeed;
    let visibleIndex = 0;

    for (const sprite of this._cloudSprites) {
      if (!sprite.mesh.visible) continue;
      visibleIndex++;
      if (previousVisibleTotal >= 0 && visibleIndex <= previousVisibleTotal) continue;

      if (!sprite.getTexture()) {
        sprite.randomizeAppearance(cover, sprite.layerIndex, this._texturePicker, used, {
          spawnRotationRad: this._pickSpawnRotationRad(),
        });
        this._applySpawnClumpScale(sprite);
      } else if (!Number.isFinite(sprite.spawnRotationRad)) {
        sprite.setSpawnRotation(this._pickSpawnRotationRad());
      }
      this._spawnUpwindOffStage(sprite, geom, drift, windSpeed);
    }
  }

  /** @private */
  _resetVisibleSprites(cover) {
    this._invalidateShadowPassCache();
    this._updateSceneBounds();
    const geom = this._sceneGeometry;
    if (!geom || !this._sceneBoundsValid) {
      this._needsSpriteRespread = true;
      return;
    }

    const visible = this._cloudSprites.filter((s) => s.mesh.visible);
    const count = visible.length;
    if (count === 0) return;

    const drift = this._windDriftUV(this._windVelocity);
    const windSpeed = this._getWeatherState().windSpeed;
    const pad = this._computeSpawnArcPadding(geom);
    const used = new Set();
    this._spawnArcWalker = Math.random();
    this._spawnArcClumping = 0.45 + Math.random() * 0.35;

    for (let i = 0; i < count; i++) {
      const sprite = visible[i];
      sprite.randomizeAppearance(cover, sprite.layerIndex, this._texturePicker, used, {
        spawnRotationRad: this._pickSpawnRotationRad(),
      });
      this._applySpawnClumpScale(sprite);

      let u;
      let v;
      if (i / count < 0.35) {
        const along = this._advanceSpawnArcWalker(windSpeed);
        const depth = Math.random() * (UPWIND_SPAWN_DEPTH + OFF_STAGE_MARGIN);
        ({ u, v } = this._spawnUVFromArc(along, geom, drift, depth));
      } else {
        const span = 1 + pad * 2;
        const along = this._advanceSpawnArcWalker(windSpeed);
        ({ u, v } = this._spawnUVFromArc(along, geom, drift, 0));
        const mix = 0.25 + Math.random() * 0.75;
        u = u * (1 - mix) + (-pad + Math.random() * span) * mix;
        v = v * (1 - mix) + (-pad + Math.random() * span) * mix;
      }
      this._placeSpriteAtNorm(sprite, geom, u, v);
      sprite.beginFadeIn(SPRITE_FADE_DURATION_SEC);
    }
    this._needsSpriteRespread = false;
  }

  /** @private @param {import('./cloud-sprites/CloudSprite.js').CloudSprite} [exclude] */
  _collectUsedTextures(exclude) {
    const used = new Set();
    for (const sprite of this._cloudSprites) {
      if (!sprite.mesh.visible || sprite === exclude) continue;
      const tex = sprite.getTexture();
      if (tex) used.add(tex);
    }
    return used;
  }

  /** @private */
  _splitPoolCounts(total) {
    const base = LAYER_POOL_COUNTS;
    const baseSum = base.reduce((a, b) => a + b, 0);
    const counts = base.map((n) => Math.max(1, Math.round((n / baseSum) * total)));
    let sum = counts.reduce((a, b) => a + b, 0);
    while (sum > total) {
      const idx = counts.indexOf(Math.max(...counts));
      counts[idx]--;
      sum--;
    }
    while (sum < total) {
      counts[0]++;
      sum++;
    }
    return counts;
  }

  // ── Wind ──────────────────────────────────────────────────────────────────

  advanceWind(delta) {
    if (!this._initialized || !this.params.enabled) return;
    this._bindPerfRecorder();
    const _perfToken = this._beginPerfSpan('advanceWind', 'update');
    try {
      const ws = this._getWeatherState();
      if (!ws.weatherEnabled || this._isCoverZero(ws.cloudCover)) return;
      this._advanceWindSim(delta, ws.windDirX, ws.windDirY, ws.windSpeed);
    } finally {
      this._endPerfSpan(_perfToken);
    }
  }

  /** @private */
  _advanceWindSim(delta, windDirX, windDirY, windSpeed) {
    const p = this.params;
    const targetSpd = Math.max(windSpeed * p.windInfluence * p.driftSpeed, p.minDriftSpeed || 0);
    const resp = Math.max(0, p.driftResponsiveness ?? 2.5);
    const maxSpd = Math.max(0, p.driftMaxSpeed ?? 0.05);
    const alpha = resp > 0 ? (1 - Math.exp(-resp * delta)) : 1;

    this._tempVec2A.set(windDirX, windDirY);
    if (this._tempVec2A.lengthSq() > 1e-6) this._tempVec2A.normalize();
    this._tempVec2A.multiplyScalar(targetSpd);
    this._windVelocity.lerp(this._tempVec2A, alpha);
    const vl = this._windVelocity.length();
    if (vl > maxSpd && vl > 1e-6) this._windVelocity.multiplyScalar(maxSpd / vl);
    this._windOffset.x -= this._windVelocity.x * delta;
    this._windOffset.y -= this._windVelocity.y * delta;
    if (!Number.isFinite(this._windOffset.x)) this._windOffset.x = 0;
    if (!Number.isFinite(this._windOffset.y)) this._windOffset.y = 0;
  }

  // ── Update ────────────────────────────────────────────────────────────────

  /** @param {{ elapsed: number, delta: number }} timeInfo */
  update(timeInfo) {
    if (!this._initialized || !this.params.enabled) return;
    this._bindPerfRecorder();
    this._lastElapsed = timeInfo?.elapsed ?? 0;
    const delta = Math.max(0, Number(timeInfo?.delta) || 0.016);

    let _perfToken = this._beginPerfSpan('weatherGate', 'update');
    const ws = this._getWeatherState();
    if (!ws.weatherEnabled || this._isCoverZero(ws.cloudCover)) {
      if (!this._cloudCoverZeroLF) this._needsNeutralClear = true;
      this._cloudCoverZeroLF = true;
      this._endPerfSpan(_perfToken);
      return;
    }
    this._cloudCoverZeroLF = false;
    this._needsNeutralClear = false;
    this._endPerfSpan(_perfToken);

    _perfToken = this._beginPerfSpan('sunAndViewBounds.calc', 'update');
    this._calcSunDir();
    this._updateViewBounds();
    const sceneBoundsChanged = this._updateSceneBounds();
    this._updateCaptureCamera();
    this._updateWrapBounds();
    this._endPerfSpan(_perfToken);

    _perfToken = this._beginPerfSpan('sunAndViewBounds.sprites', 'update');
    if ((sceneBoundsChanged || this._needsSpriteRespread) && this._assetsLoaded && this._texturePicker) {
      this._resetVisibleSprites(ws.cloudCover);
    } else {
      this._applyAllVisibleSpriteLocalPositions();
    }
    this._endPerfSpan(_perfToken);

    _perfToken = this._beginPerfSpan('spriteSim.count', 'update');
    if (this._assetsLoaded) {
      this._updateActiveSpriteCount(ws.cloudCover);
    }
    this._endPerfSpan(_perfToken);

    _perfToken = this._beginPerfSpan('spriteSim.simulate', 'update');
    if (this._assetsLoaded) {
      this._simulateSprites(delta);
    }
    this._endPerfSpan(_perfToken);

    _perfToken = this._beginPerfSpan('shadowUniforms', 'update');
    this._updateShadowMaskUniforms();
    this._endPerfSpan(_perfToken);

    _perfToken = this._beginPerfSpan('layerUniforms', 'update');
    this._updateCloudLayerUniforms();
    this._endPerfSpan(_perfToken);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  /** @param {THREE.WebGLRenderer} renderer */
  render(renderer) {
    if (!this._initialized || !this.params.enabled) return;

    this._bindPerfRecorder();
    const _legacyToken = this._beginLegacyAggregateSpan('cloud', 'render');
    let _perfToken = this._beginPerfSpan('ensureTargets', 'render', { cpuOnly: true });
    renderer.getDrawingBufferSize(this._tempSize);
    const fullW = Math.max(1, this._tempSize.x);
    const fullH = Math.max(1, this._tempSize.y);
    this._ensureRenderTargets(fullW, fullH);
    this._endPerfSpan(_perfToken);

    const prevTarget = renderer.getRenderTarget();

    try {
      const ws = this._getWeatherState();
      if (!ws.weatherEnabled || this._isCoverZero(ws.cloudCover) || this._needsNeutralClear
          || !this._assetsLoaded) {
        _perfToken = this._beginPerfSpan('neutralClear', 'render', { cpuOnly: true });
        try {
          this._renderNeutral(renderer);
          this._needsNeutralClear = false;
        } finally {
          this._endPerfSpan(_perfToken);
        }
        return;
      }

      _perfToken = this._beginPerfSpan('prep', 'render', { cpuOnly: true });
      this.syncSunFromDriver();
      this._updateSkyLighting();
      this._updateViewBounds();
      this._updateSceneBounds();
      this._updateCaptureCamera();

      const zoom = this._getZoom();
      const fadeStart = Number(this.params.cloudTopFadeStart) || 0.24;
      const fadeEnd = Math.max(fadeStart + 0.01, Number(this.params.cloudTopFadeEnd) || 0.39);
      const topFade = this._smoothstep(fadeEnd, fadeStart, zoom);
      const topVisible = topFade > 0.01;

      const staticKey = this._computeShadowStaticCacheKey();
      const perFrameShadow = this._requiresPerFrameShadowPasses();
      const rawCacheHit = !perFrameShadow && staticKey === this._shadowRawCacheKey && !!this._shadowRawCacheKey;
      const maskKey = this._computeShadowMaskCacheKey(staticKey);
      const maskCacheHit = rawCacheHit && maskKey === this._shadowMaskCacheKey && !!this._shadowMaskCacheKey;
      const cloudTopKey = this._computeCloudTopCacheKey(staticKey, topFade);
      const animatedCloudTop = this._isAnimatedCloudTop();
      const cloudTopCacheHit = !animatedCloudTop && !perFrameShadow
        && cloudTopKey === this._cloudTopCacheKey && !!this._cloudTopCacheKey;

      if (rawCacheHit) this._shadowCacheStats.rawHit++;
      else {
        this._shadowCacheStats.rawMiss++;
        if (perFrameShadow) {
          this._shadowCacheStats.lastMissReason = 'motionActive';
        } else if (!this._shadowRawCacheKey) {
          this._shadowCacheStats.lastMissReason = 'coldStart';
        } else if (staticKey !== this._shadowRawCacheKey) {
          this._shadowCacheStats.lastMissReason = 'staticKeyChanged';
        } else {
          this._shadowCacheStats.lastMissReason = 'unknown';
        }
      }
      if (maskCacheHit) this._shadowCacheStats.maskHit++;
      else this._shadowCacheStats.maskMiss++;
      if (topVisible && this._cloudTopRT) {
        if (cloudTopCacheHit) this._shadowCacheStats.cloudTopHit++;
        else this._shadowCacheStats.cloudTopMiss++;
      }

      this._updateShadowMaskUniforms();
      this._endPerfSpan(_perfToken);

      if (rawCacheHit) {
        _perfToken = this._beginPerfSpan('shadowRaw.cacheSkip', 'render', { cpuOnly: true });
        this._endPerfSpan(_perfToken);
      } else {
        _perfToken = this._beginPerfSpan('shadowRaw', 'render');
        try {
          this._renderShadows(renderer);
          this._shadowRawCacheKey = staticKey;
          this._shadowMaskCacheKey = '';
          this._cloudTopCacheKey = '';
        } finally {
          this._endPerfSpan(_perfToken);
        }
      }

      if (maskCacheHit) {
        _perfToken = this._beginPerfSpan('shadowMasked.cacheSkip', 'render', { cpuOnly: true });
        this._endPerfSpan(_perfToken);
      } else {
        _perfToken = this._beginPerfSpan('shadowMasked', 'render');
        try {
          this._applyShadowMasks(renderer, this._shadowRT, true);
          this._applyShadowMasks(renderer, this._shadowWindowRT, false);
          this._shadowMaskCacheKey = maskKey;
        } finally {
          this._endPerfSpan(_perfToken);
        }
      }

      if (topVisible && this._cloudTopRT) {
        if (cloudTopCacheHit) {
          _perfToken = this._beginPerfSpan('cloudTop.cacheSkip', 'render', { cpuOnly: true });
          this._endPerfSpan(_perfToken);
        } else {
          _perfToken = this._beginPerfSpan('cloudTop', 'render');
          try {
            this._renderCloudTops(renderer, topFade);
            this._cloudTopCacheKey = cloudTopKey;
          } finally {
            this._endPerfSpan(_perfToken);
          }
        }
      } else if (this._cloudTopRT) {
        _perfToken = this._beginPerfSpan('cloudTop.clear', 'render', { cpuOnly: true });
        try {
          this._cloudTopCacheKey = '';
          renderer.setRenderTarget(this._cloudTopRT);
          renderer.setClearColor(0x000000, 0);
          renderer.clear();
        } finally {
          this._endPerfSpan(_perfToken);
        }
      }
    } finally {
      renderer.setRenderTarget(prevTarget);
      this._endPerfSpan(_legacyToken);
    }
  }

  /** @param {THREE.WebGLRenderer} renderer @param {THREE.WebGLRenderTarget|null} outputRT */
  blitCloudTops(renderer, outputRT) {
    if (!this._initialized || !this._cloudTopRT || !this._cloudLayerScene || !this._mainCamera) return;
    const ws = this._getWeatherState();
    if (!ws.weatherEnabled || this._isCoverZero(ws.cloudCover) || !this._assetsLoaded) return;
    if (this.params.cloudTopOpacity <= 0) return;

    const zoom = this._getZoom();
    const fadeStart = Number(this.params.cloudTopFadeStart) || 0.24;
    const fadeEnd = Math.max(fadeStart + 0.01, Number(this.params.cloudTopFadeEnd) || 0.39);
    if (this._smoothstep(fadeEnd, fadeStart, zoom) <= 0.01) return;

    this._bindPerfRecorder();
    const _legacyToken = this._beginLegacyAggregateSpan('cloud.blitTops', 'render');
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevLayerMask = this._mainCamera.layers.mask;
    try {
      let _perfToken = this._beginPerfSpan('blitTops.syncTexture', 'render', { cpuOnly: true });
      try {
        this._syncCloudLayerTexture();
      } finally {
        this._endPerfSpan(_perfToken);
      }

      _perfToken = this._beginPerfSpan('blitTops.updateTransforms', 'render', { cpuOnly: true });
      try {
        this._updateCloudLayerTransforms();
        this._updateCloudLayerUniforms();
      } finally {
        this._endPerfSpan(_perfToken);
      }

      _perfToken = this._beginPerfSpan('blitTops.layerDraw', 'render');
      try {
        renderer.setRenderTarget(outputRT);
        renderer.autoClear = false;
        this._mainCamera.layers.enable(0);
        renderer.render(this._cloudLayerScene, this._mainCamera);
      } finally {
        this._endPerfSpan(_perfToken);
      }
    } finally {
      this._mainCamera.layers.mask = prevLayerMask;
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
      this._endPerfSpan(_legacyToken);
    }
  }

  // ── Shadow pass cache ─────────────────────────────────────────────────────

  /** @private */
  _invalidateShadowPassCache() {
    this._shadowRawCacheKey = '';
    this._shadowMaskCacheKey = '';
    this._cloudTopCacheKey = '';
  }

  /**
   * Drifting sprites, fades, and panning all need fresh shadow RTs every frame.
   * Cache only when no sprites are visible (neutral / zero-cover clears).
   * @private
   * @returns {boolean}
   */
  _requiresPerFrameShadowPasses() {
    return (this._lastActiveTotal ?? 0) > 0;
  }

  /** @private @param {string} paramId */
  _paramAffectsShadowPassCache(paramId) {
    return paramId.startsWith('shadow')
      || paramId === 'internalResolutionScale'
      || paramId === 'shadowResolutionScale'
      || paramId.startsWith('cloudTop')
      || paramId === 'cloudBrightness'
      || paramId === 'skyTintStrength'
      || paramId === 'sunLightingStrength'
      || paramId === 'nightDimStrength'
      || paramId === 'overlayDomainWarpStrength'
      || paramId === 'spriteBoilStrength'
      || paramId === 'domainWarpSpeed'
      || paramId === 'driftOrbitStrength'
      || paramId === 'lightningCloudEnabled'
      || paramId === 'lightningCloudBrightnessBoost'
      || paramId === 'lightningCloudContrastBoost'
      || paramId === 'lightningCloudTintStrength'
      || paramId === 'spritePoolSize'
      || paramId === 'spriteOpacityMin'
      || paramId === 'spriteOpacityMax';
  }

  /** @private */
  _quantizeShadowBucket(value, step) {
    const s = Math.max(1e-9, Number(step) || 1);
    const v = Number(value);
    if (!Number.isFinite(v)) return 0;
    return Math.round(v / s);
  }

  /** @private @param {THREE.Texture|null|undefined} tex */
  _textureShadowCacheToken(tex) {
    if (!tex) return '0';
    return String(tex.uuid ?? tex.id ?? tex);
  }

  /** @private — static inputs only; active sprites bypass cache via `_requiresPerFrameShadowPasses`. */
  _computeShadowStaticCacheKey() {
    const p = this.params;
    return [
      this._lastShadowInternalW,
      this._lastShadowInternalH,
      this._lastSceneBoundsKey,
      this._quantizeShadowBucket(this._sunDir?.x ?? 0, 0.04),
      this._quantizeShadowBucket(this._sunDir?.y ?? 0, 0.04),
      this._quantizeShadowBucket(p.shadowOpacity, 0.02),
      this._quantizeShadowBucket(p.shadowOffsetScale, 0.02),
      this._lastActiveTotal,
    ].join('|');
  }

  /** @private @param {string} staticKey */
  _computeShadowMaskCacheKey(staticKey) {
    const p = this.params;
    const vb = this._viewBounds;
    const maskTokens = this._outdoorsMasks.map((tex) => this._textureShadowCacheToken(tex));
    return [
      staticKey,
      this._quantizeShadowBucket(vb.minX, this._shadowViewQuant),
      this._quantizeShadowBucket(vb.minY, this._shadowViewQuant),
      this._quantizeShadowBucket(vb.maxX, this._shadowViewQuant),
      this._quantizeShadowBucket(vb.maxY, this._shadowViewQuant),
      this._quantizeShadowBucket(this._getZoom(), 0.05),
      this._quantizeShadowBucket(p.shadowSoftness, 0.05),
      this._quantizeShadowBucket(p.minShadowBrightness, 0.05),
      this._quantizeShadowBucket(p.shadowSceneFadeSoftness, 0.01),
      this._textureShadowCacheToken(this._outdoorsMask),
      this._textureShadowCacheToken(this._floorIdTex),
      maskTokens.join(','),
    ].join('|');
  }

  /** @private @param {string} staticKey @param {number} topFade */
  _computeCloudTopCacheKey(staticKey, topFade) {
    const p = this.params;
    const lightingBucket = this._computeLightingCacheBucket();
    return [
      staticKey,
      this._quantizeShadowBucket(topFade, 0.08),
      this._quantizeShadowBucket(p.cloudTopOpacity, 0.02),
      this._quantizeShadowBucket(p.cloudBrightness, 0.02),
      this._quantizeShadowBucket(p.skyTintStrength, 0.05),
      this._quantizeShadowBucket(p.sunLightingStrength, 0.05),
      this._quantizeShadowBucket(p.nightDimStrength, 0.05),
      this._quantizeShadowBucket(p.spriteBoilStrength, 0.005),
      lightingBucket,
    ].join('|');
  }

  /** @returns {Readonly<typeof this._shadowCacheStats> & { rawHitPct: number, maskHitPct: number, cloudTopHitPct: number }} */
  getShadowCacheStats() {
    const s = this._shadowCacheStats;
    const rawTotal = s.rawHit + s.rawMiss;
    const maskTotal = s.maskHit + s.maskMiss;
    const topTotal = s.cloudTopHit + s.cloudTopMiss;
    return {
      ...s,
      rawHitPct: rawTotal > 0 ? (s.rawHit / rawTotal) * 100 : 0,
      maskHitPct: maskTotal > 0 ? (s.maskHit / maskTotal) * 100 : 0,
      cloudTopHitPct: topTotal > 0 ? (s.cloudTopHit / topTotal) * 100 : 0,
      perFrameShadow: this._requiresPerFrameShadowPasses(),
      spritesActive: (this._lastActiveTotal ?? 0) > 0,
    };
  }

  // ── Render passes ─────────────────────────────────────────────────────────

  /** @private */
  _renderShadows(renderer) {
    const p = this.params;
    const shadowOpacity = Math.max(0, Math.min(1, Number(p.shadowOpacity) || 0.7));

    renderer.setRenderTarget(this._shadowRawRT);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();

    if (shadowOpacity <= 0.001) return;

    const dist = (Number(p.shadowOffsetScale) || 0.3) * 5000
      * Math.max(0.05, Number(this._driverShadowLengthScale) || 1.0);

    this._savedCloudScenePos.copy(this._cloudScene.position);
    this._cloudScene.position.set(-this._sunDir.x * dist, -this._sunDir.y * dist, 0);

    for (const sprite of this._cloudSprites) {
      if (!sprite.mesh.visible) continue;
      sprite.syncShadowOpacity(shadowOpacity);
    }

    const cam = this._cloudCaptureCam;
    const prevLayerMask = cam.layers.mask;
    cam.layers.set(1);
    renderer.render(this._cloudScene, cam);
    cam.layers.mask = prevLayerMask;

    this._cloudScene.position.copy(this._savedCloudScenePos);
  }

  /** @private @param {THREE.WebGLRenderTarget|null} [target] @param {boolean} [applyOutdoorsMask=true] */
  _applyShadowMasks(renderer, target = null, applyOutdoorsMask = true) {
    const u = this._shadowMaskMat?.uniforms;
    if (u?.tShadowRaw) u.tShadowRaw.value = this._shadowRawRT?.texture ?? null;
    if (u?.uApplyOutdoorsMask) u.uApplyOutdoorsMask.value = applyOutdoorsMask ? 1 : 0;
    this._quad.material = this._shadowMaskMat;
    renderer.setRenderTarget(target ?? this._shadowRT);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.render(this._quadScene, this._quadCam);
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {number} topFade 0..1
   * @private
   */
  _renderCloudTops(renderer, topFade) {
    const p = this.params;
    const opacityMul = Math.max(0, Number(p.cloudTopOpacity) || 0) * topFade;
    for (const sprite of this._cloudSprites) {
      if (!sprite.mesh.visible) continue;
      sprite.renderOpacityMul = opacityMul;
      sprite.syncDisplayOpacity();
    }

    renderer.setRenderTarget(this._cloudTopRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();

    const cam = this._cloudCaptureCam;
    const prevLayerMask = cam.layers.mask;
    cam.layers.set(0);
    renderer.render(this._cloudScene, cam);
    cam.layers.mask = prevLayerMask;

    for (const sprite of this._cloudSprites) {
      if (!sprite.mesh.visible) continue;
      sprite.renderOpacityMul = 1;
      sprite.syncDisplayOpacity();
    }
  }

  /** @private */
  _renderNeutral(renderer) {
    this._invalidateShadowPassCache();
    if (this._shadowRT) {
      renderer.setRenderTarget(this._shadowRT);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear();
    }
    if (this._shadowWindowRT) {
      renderer.setRenderTarget(this._shadowWindowRT);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear();
    }
    if (this._shadowRawRT) {
      renderer.setRenderTarget(this._shadowRawRT);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear();
    }
    if (this._cloudTopRT) {
      renderer.setRenderTarget(this._cloudTopRT);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
    }
  }

  /** @private @returns {{ iW: number, iH: number }} */
  _computeInternalTargetSize(fullW, fullH, scale) {
    const geom = this._sceneGeometry;
    const sceneW = Math.max(1, geom?.sceneW ?? fullW);
    const sceneH = Math.max(1, geom?.sceneH ?? fullH);
    const sceneAspect = sceneW / sceneH;
    const refMax = Math.max(fullW, fullH) * scale;
    if (sceneAspect >= 1) {
      return {
        iW: Math.max(1, Math.round(refMax)),
        iH: Math.max(1, Math.round(refMax / sceneAspect)),
      };
    }
    return {
      iH: Math.max(1, Math.round(refMax)),
      iW: Math.max(1, Math.round(refMax * sceneAspect)),
    };
  }

  /** @private */
  _ensureRenderTargets(fullW, fullH) {
    const THREE = window.THREE;
    if (!THREE) return;

    const topScale = Math.max(0.1, Math.min(1.0, this.params.internalResolutionScale ?? 0.5));
    const shadowScale = Math.max(0.1, Math.min(1.0, this.params.shadowResolutionScale ?? 0.35));
    const { iW: topW, iH: topH } = this._computeInternalTargetSize(fullW, fullH, topScale);
    const { iW: shadowW, iH: shadowH } = this._computeInternalTargetSize(fullW, fullH, shadowScale);

    const topUnchanged = topW === this._lastInternalW && topH === this._lastInternalH
      && this._lastSceneBoundsKey === this._lastRTSceneKey;
    const shadowSizeUnchanged = shadowW === this._lastShadowInternalW && shadowH === this._lastShadowInternalH
      && this._lastSceneBoundsKey === this._lastRTSceneKey;

    if (topUnchanged && shadowSizeUnchanged) {
      this._lastFullW = fullW;
      this._lastFullH = fullH;
      return;
    }

    this._lastRTSceneKey = this._lastSceneBoundsKey;
    this._lastFullW = fullW;
    this._lastFullH = fullH;

    const opts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
    };
    const make = (existing, w, h) => {
      if (existing) { existing.setSize(w, h); return existing; }
      return new THREE.WebGLRenderTarget(w, h, { ...opts });
    };

    if (!topUnchanged) {
      this._lastInternalW = topW;
      this._lastInternalH = topH;
      this._cloudTopRT = make(this._cloudTopRT, topW, topH);
    }

    if (!shadowSizeUnchanged) {
      this._lastShadowInternalW = shadowW;
      this._lastShadowInternalH = shadowH;
      this._shadowRT = make(this._shadowRT, shadowW, shadowH);
      this._shadowWindowRT = make(this._shadowWindowRT, shadowW, shadowH);
      this._shadowRawRT = make(this._shadowRawRT, shadowW, shadowH);
      if (this._shadowMaskMat?.uniforms?.uTexelSize) {
        this._shadowMaskMat.uniforms.uTexelSize.value.set(1 / shadowW, 1 / shadowH);
      }
      this._invalidateShadowPassCache();
    }
  }

  onResize(w, h) { this._ensureRenderTargets(Math.max(1, w), Math.max(1, h)); }

  onFloorChange() {
    this._lastSceneBoundsKey = '';
    this._invalidateShadowPassCache();
    if (this._assetsLoaded && this._texturePicker) {
      this._resetVisibleSprites(this._getWeatherState().cloudCover);
    } else {
      this._needsSpriteRespread = true;
    }
  }

  // ── Simulation helpers ────────────────────────────────────────────────────

  /** @private */
  _updateViewBounds() {
    const fd = window.MapShine?.sceneComposer?.foundrySceneData ?? null;
    const d = canvas?.dimensions;
    const rect = d?.sceneRect ?? d;
    const sceneW = Number(rect?.width ?? fd?.sceneWidth ?? d?.sceneWidth ?? 4000);
    const sceneH = Number(rect?.height ?? fd?.sceneHeight ?? d?.sceneHeight ?? 3000);
    const sceneX = Number(rect?.x ?? fd?.sceneX ?? d?.sceneX ?? 0);
    const sceneY = Number(rect?.y ?? fd?.sceneY ?? d?.sceneY ?? 0);
    const worldH = Number(fd?.height ?? d?.height ?? sceneH);

    let vMinX = sceneX;
    let vMinY = worldH - (sceneY + sceneH);
    let vMaxX = sceneX + sceneW;
    let vMaxY = worldH - sceneY;
    const sc = window.MapShine?.sceneComposer;
    if (sc && this._mainCamera) {
      const cam = this._mainCamera;
      if (cam.isOrthographicCamera) {
        const camPos = cam.position;
        const zoom = Math.max(1e-6, cam.zoom ?? 1);
        vMinX = camPos.x + cam.left / zoom;
        vMinY = camPos.y + cam.bottom / zoom;
        vMaxX = camPos.x + cam.right / zoom;
        vMaxY = camPos.y + cam.top / zoom;
      } else {
        const groundZRaw = Number(sc.groundZ);
        const groundZ = Number.isFinite(groundZRaw) ? groundZRaw : (Number(sc.basePlaneMesh?.position?.z) || 0);
        const dist = Math.max(1e-3, Math.abs((cam.position?.z ?? 0) - groundZ));
        const fovRad = (Number(cam.fov) || 60) * Math.PI / 180;
        const halfH = dist * Math.tan(fovRad * 0.5);
        const aspect = Number(cam.aspect) || ((sc.baseViewportWidth || 1) / Math.max(1, (sc.baseViewportHeight || 1)));
        const halfW = halfH * aspect;
        vMinX = cam.position.x - halfW;
        vMaxX = cam.position.x + halfW;
        vMinY = cam.position.y - halfH;
        vMaxY = cam.position.y + halfH;
      }
    }

    this._viewBounds.minX = vMinX;
    this._viewBounds.minY = vMinY;
    this._viewBounds.maxX = vMaxX;
    this._viewBounds.maxY = vMaxY;
  }

  /** @private */
  _updateWrapBounds() {
    const src = this._sceneBoundsValid ? this._sceneBounds : this._viewBounds;
    const minX = src.minX;
    const minY = src.minY;
    const maxX = src.maxX;
    const maxY = src.maxY;
    const spanW = Math.max(1, maxX - minX);
    const spanH = Math.max(1, maxY - minY);
    const pad = WRAP_BOUNDS_PAD;
    this._wrapBounds.minX = minX - spanW * pad;
    this._wrapBounds.minY = minY - spanH * pad;
    this._wrapBounds.maxX = maxX + spanW * pad;
    this._wrapBounds.maxY = maxY + spanH * pad;
  }

  /** @private */
  _getCaptureBounds() {
    if (this._sceneBoundsValid) return this._sceneBounds;
    return this._viewBounds;
  }

  /** @private */
  _syncCaptureBounds() {
    const src = this._getCaptureBounds();
    const spanW = Math.max(1, src.maxX - src.minX);
    const spanH = Math.max(1, src.maxY - src.minY);
    const pad = OFF_STAGE_MARGIN + UPWIND_SPAWN_DEPTH;
    this._captureBounds.minX = src.minX - spanW * pad;
    this._captureBounds.minY = src.minY - spanH * pad;
    this._captureBounds.maxX = src.maxX + spanW * pad;
    this._captureBounds.maxY = src.maxY + spanH * pad;
  }

  /** @private */
  _updateCaptureCamera() {
    const cam = this._cloudCaptureCam;
    if (!cam) return;
    this._syncCaptureBounds();
    const cMinX = this._captureBounds.minX;
    const cMinY = this._captureBounds.minY;
    const cMaxX = this._captureBounds.maxX;
    const cMaxY = this._captureBounds.maxY;

    const cx = (cMinX + cMaxX) * 0.5;
    const cy = (cMinY + cMaxY) * 0.5;
    const halfW = (cMaxX - cMinX) * 0.5;
    const halfH = (cMaxY - cMinY) * 0.5;

    cam.left = -halfW;
    cam.right = halfW;
    cam.bottom = -halfH;
    cam.top = halfH;
    cam.updateProjectionMatrix();

    const groundZ = this._getGroundZ();
    cam.position.set(cx, cy, groundZ + 1000);
    cam.lookAt(cx, cy, groundZ);
  }

  /** @private Sun-aligned angle at spawn; sprites keep this until recycled. */
  _getSpawnSunAngle() {
    const sun = this._sunDir;
    if (!sun) return 0;
    return Math.atan2(sun.y, sun.x) - (Math.PI / 2);
  }

  /** @private Small per-sprite jitter on top of spawn sun angle. */
  _pickSpawnRotationRad() {
    return this._getSpawnSunAngle() + (Math.random() * 2 - 1) * (4 * Math.PI / 180);
  }

  /** @private */
  _layerParallaxMult(layerIndex) {
    const p = this.params;
    const base = Math.max(0, Number(p.layerParallaxBase) || 1);
    const keys = [p.layer1ParallaxMult, p.layer2ParallaxMult, p.layer3ParallaxMult];
    const mult = Number(keys[layerIndex]);
    return base * (Number.isFinite(mult) ? mult : LAYER_PARALLAX[layerIndex] ?? 1);
  }

  /** @private */
  _computeActiveTotal(cover) {
    const c = Math.max(0, Math.min(1, cover));
    if (c <= COVER_FOR_MIN) return MIN_ACTIVE_SPRITES;
    if (c >= COVER_FOR_MAX) return MAX_ACTIVE_SPRITES;
    const t = (c - COVER_FOR_MIN) / (COVER_FOR_MAX - COVER_FOR_MIN);
    return Math.round(MIN_ACTIVE_SPRITES + t * (MAX_ACTIVE_SPRITES - MIN_ACTIVE_SPRITES));
  }

  /** @private */
  _updateActiveSpriteCount(cover) {
    const total = Math.min(this._cloudSprites.length, this._computeActiveTotal(cover));
    const previousVisibleTotal = this._lastActiveTotal;
    const countChanged = total !== previousVisibleTotal;
    this._lastActiveTotal = total;
    const layerCounts = this._splitPoolCounts(total);
    let idx = 0;
    for (let layer = 0; layer < LAYER_COUNT; layer++) {
      const poolSize = this._layerPoolSizes[layer] ?? 0;
      const activeInLayer = layerCounts[layer] ?? 0;
      for (let i = 0; i < poolSize; i++, idx++) {
        const sprite = this._cloudSprites[idx];
        if (!sprite) continue;
        sprite.layerIndex = layer;
        const shouldBeActive = i < activeInLayer;

        if (shouldBeActive) {
          if (sprite._pendingDeactivate) {
            sprite.clearPendingDeactivate();
            sprite.mesh.visible = true;
            sprite.beginFadeIn(SPRITE_FADE_DURATION_SEC);
          } else if (!sprite.mesh.visible) {
            sprite.mesh.visible = true;
          }
        } else if (sprite.mesh.visible && !sprite._pendingDeactivate) {
          sprite.markPendingDeactivate();
        }
      }
    }
    if (countChanged && total > previousVisibleTotal && previousVisibleTotal >= 0 && this._texturePicker) {
      this._initNewlyVisibleSprites(cover, previousVisibleTotal);
    }
    if (countChanged && previousVisibleTotal >= 0) {
      this._invalidateShadowPassCache();
    }
  }

  /** @private */
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
    if (sprite._fadePhase === 'out' && !pastEdge) {
      sprite.beginFadeIn(SPRITE_FADE_DURATION_SEC);
    } else if (pastEdge && sprite._fadePhase === 'steady' && sprite.fadeMul > 0.001) {
      sprite.beginFadeOut(SPRITE_FADE_DURATION_SEC);
    }

    if (sprite._fadePhase === 'steady' && sprite.fadeMul <= 0.001 && pastEdge) {
      sprite._awaitingRecycle = true;
    }

    if (sprite._awaitingRecycle && sprite._fadePhase === 'steady' && sprite.fadeMul <= 0.001) {
      this._spawnUpwindOffStage(sprite, geom, drift, windSpeed);
    } else {
      this._applySpriteLocalPosition(sprite, geom);
    }
  }

  /** @private */
  _simulateSprites(delta) {
    const wind = this._windVelocity;
    const geom = this._sceneGeometry;
    if (!geom) return;

    const bounds = this._wrapBounds;
    const viewW = Math.max(1, bounds.maxX - bounds.minX);
    const viewH = Math.max(1, bounds.maxY - bounds.minY);
    const worldScale = Math.max(viewW, viewH) * 0.35;
    const normScaleU = worldScale / Math.max(1, geom.sceneW);
    const normScaleV = worldScale / Math.max(1, geom.sceneH);
    const drift = this._windDriftUV(wind);
    const windSpeed = this._getWeatherState().windSpeed;
    let spriteIdx = 0;
    for (let layer = 0; layer < LAYER_COUNT; layer++) {
      const layerCount = this._layerPoolSizes[layer] ?? 0;
      for (let i = 0; i < layerCount && spriteIdx < this._cloudSprites.length; i++, spriteIdx++) {
        const sprite = this._cloudSprites[spriteIdx];
        if (!sprite?.mesh.visible) continue;

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
    }
    this._syncCloudAnchor();
  }

  /** @private */
  _updateSkyLighting() {
    const lighting = this._resolveCloudLighting();
    if (!lighting) return;

    const bucket = this._computeLightingCacheBucket();
    const staticLightingChanged = bucket !== this._lastAppliedLightingBucket;
    this._lastAppliedLightingBucket = bucket;

    const lightning = this._resolveLightningFlash();
    const boilStrength = Math.max(0, Number(this.params.spriteBoilStrength) ?? 0);
    const warpSpeed = Math.max(0, Number(this.params.domainWarpSpeed) ?? 1);
    const warpTime = this._lastElapsed * warpSpeed;

    for (const sprite of this._cloudSprites) {
      if (!sprite.mesh.visible) continue;
      const u = sprite.displayMaterial?.uniforms;
      if (!u) continue;

      if (u.uTime) u.uTime.value = warpTime;
      if (u.uLightningFlash01) u.uLightningFlash01.value = lightning.flash01;
      if (lightning.flash01 > 0) {
        if (u.uLightningFlashColor?.value?.set) {
          u.uLightningFlashColor.value.set(lightning.colorR, lightning.colorG, lightning.colorB);
        }
        if (u.uLightningBrightnessBoost) u.uLightningBrightnessBoost.value = lightning.brightnessBoost;
        if (u.uLightningContrastBoost) u.uLightningContrastBoost.value = lightning.contrastBoost;
        if (u.uLightningTintStrength) u.uLightningTintStrength.value = lightning.tintStrength;
      }

      if (staticLightingChanged) {
        const {
          tint,
          sunDirX,
          sunDirY,
          sunElevation01,
          skyIntensity,
          nightDim,
          brightness,
          skyTintStrength,
          sunLightingStrength,
        } = lighting;
        if (u.uSkyTint?.value?.set) u.uSkyTint.value.set(tint.x, tint.y, tint.z);
        if (u.uSkyTintStrength) u.uSkyTintStrength.value = skyTintStrength;
        if (u.uSunDir?.value?.set) u.uSunDir.value.set(sunDirX, sunDirY);
        if (u.uSunElevation01) u.uSunElevation01.value = sunElevation01;
        if (u.uSkyIntensity) u.uSkyIntensity.value = skyIntensity;
        if (u.uSunLightingStrength) u.uSunLightingStrength.value = sunLightingStrength;
        if (u.uBrightness) u.uBrightness.value = brightness;
        if (u.uNightDim) u.uNightDim.value = nightDim;
        if (u.uWarpSeed?.value?.set) u.uWarpSeed.value.set(sprite.warpSeedX ?? 0, sprite.warpSeedY ?? 0);
        if (u.uWarpStrength) u.uWarpStrength.value = boilStrength;
      }
    }
  }

  /**
   * Reads live landscape + map-point lightning flash from MapShine environment.
   * @private
   */
  _resolveLightningFlash() {
    const p = this.params;
    const disabled = p.lightningCloudEnabled === false;
    const brightnessBoost = Math.max(0, Number(p.lightningCloudBrightnessBoost) ?? 3.0);
    const contrastBoost = Math.max(0, Number(p.lightningCloudContrastBoost) ?? 2.5);
    const tintStrength = Math.max(0, Math.min(1, Number(p.lightningCloudTintStrength) ?? 0.8));
    if (disabled) {
      return {
        flash01: 0,
        colorR: 0.43,
        colorG: 0.5,
        colorB: 0.67,
        brightnessBoost,
        contrastBoost,
        tintStrength,
      };
    }

    let flash01 = 0;
    let landscape01 = 0;
    let mapPoint01 = 0;
    let colorR = 0.43;
    let colorG = 0.5;
    let colorB = 0.67;
    let envContrast = 0;
    try {
      const env = window.MapShine?.environment;
      landscape01 = Math.max(0, Math.min(1, Number(env?.landscapeLightningFlash01) || 0));
      mapPoint01 = Math.max(0, Math.min(1, Number(env?.lightningFlash01) || 0));
      flash01 = Math.max(landscape01, mapPoint01);
      envContrast = Math.max(0, Number(env?.landscapeLightningFlashContrast) || 0);
      if (landscape01 >= mapPoint01 && landscape01 > 0) {
        const lr = Number(env?.landscapeLightningFlashColorR);
        const lg = Number(env?.landscapeLightningFlashColorG);
        const lb = Number(env?.landscapeLightningFlashColorB);
        if (Number.isFinite(lr)) colorR = lr;
        if (Number.isFinite(lg)) colorG = lg;
        if (Number.isFinite(lb)) colorB = lb;
      } else if (mapPoint01 > 0) {
        colorR = 0.55;
        colorG = 0.62;
        colorB = 0.82;
      }
    } catch (_) {}

    const contrastMul = 1.0 + envContrast * 0.35;
    return {
      flash01,
      colorR: Math.max(0.01, colorR),
      colorG: Math.max(0.01, colorG),
      colorB: Math.max(0.01, colorB),
      brightnessBoost,
      contrastBoost: contrastBoost * contrastMul,
      tintStrength,
    };
  }

  /** @private Cloud-top RT must refresh every frame when sprite boil or lightning animates. */
  _isAnimatedCloudTop() {
    if ((Number(this.params.spriteBoilStrength) || 0) > 0.001) return true;
    if (this.params.lightningCloudEnabled === false) return false;
    return (this._resolveLightningFlash()?.flash01 ?? 0) > 0.002;
  }

  /** @private */
  _computeLightingCacheBucket() {
    const lighting = this._resolveCloudLighting();
    if (!lighting) return '0';
    const bucket = [
      this._quantizeShadowBucket(lighting.tint.x, 0.04),
      this._quantizeShadowBucket(lighting.tint.y, 0.04),
      this._quantizeShadowBucket(lighting.tint.z, 0.04),
      this._quantizeShadowBucket(lighting.sunDirX, 0.08),
      this._quantizeShadowBucket(lighting.sunDirY, 0.08),
      this._quantizeShadowBucket(lighting.sunElevation01, 0.05),
      this._quantizeShadowBucket(lighting.skyIntensity, 0.05),
      this._quantizeShadowBucket(lighting.nightDim, 0.05),
      this._quantizeShadowBucket(this._resolveLightningFlash()?.flash01 ?? 0, 0.04),
      this._quantizeShadowBucket(Math.max(0, Number(this.params.spriteBoilStrength) ?? 0), 0.005),
    ].join(',');
    this._lightingCacheBucket = bucket;
    return bucket;
  }

  /** @private */
  _resolveCloudLighting() {
    if (!this._tintResult || !this._sunDir) return null;

    const p = this.params;
    const fallback = this._calcTimeOfDayTint();
    const sky = this._skyState?.skyTintColor;
    const tintStrength = Math.max(0, Math.min(1.5, Number(p.skyTintStrength) ?? 0.85));
    const t = this._tintResult;

    const skyR = Number(sky?.r);
    const skyG = Number(sky?.g);
    const skyB = Number(sky?.b);
    if (Number.isFinite(skyR) && Number.isFinite(skyG) && Number.isFinite(skyB) && tintStrength > 0) {
      const blend = Math.min(1, tintStrength);
      t.set(
        fallback.x * (1 - blend) + skyR * blend,
        fallback.y * (1 - blend) + skyG * blend,
        fallback.z * (1 - blend) + skyB * blend,
      );
    } else if (fallback) {
      t.copy(fallback);
    }

    const elevDeg = Number(this._skyState?.sunElevationDeg);
    const sunElevation01 = Number.isFinite(elevDeg)
      ? Math.max(0, Math.min(1, (elevDeg + 8) / 98))
      : this._estimateSunElevation01FromHour();

    const skyIntensity = Math.max(0, Math.min(1, Number(this._skyState?.skyIntensity01) ?? 1.0));
    const sceneDarkness = Math.max(0, Math.min(1, Number(this._skyState?.sceneDarkness01) ?? 0));
    const nightDimStrength = Math.max(0, Math.min(1, Number(p.nightDimStrength) ?? 0.75));
    const nightDim = sceneDarkness * nightDimStrength;

    let sunDirX = Number(this._sunDir.x);
    let sunDirY = Number(this._sunDir.y);
    const sunLenSq = (sunDirX * sunDirX) + (sunDirY * sunDirY);
    if (!Number.isFinite(sunLenSq) || sunLenSq < 1e-8) {
      sunDirX = 0;
      sunDirY = 1;
    } else {
      const inv = 1 / Math.sqrt(sunLenSq);
      sunDirX *= inv;
      sunDirY *= inv;
    }

    return {
      tint: t,
      sunDirX,
      sunDirY,
      sunElevation01,
      skyIntensity,
      nightDim,
      brightness: Math.max(0.05, Number(p.cloudBrightness) || 1),
      skyTintStrength: tintStrength,
      sunLightingStrength: Math.max(0, Math.min(1, Number(p.sunLightingStrength) ?? 0.65)),
    };
  }

  /** @private Fallback sun height when SkyColor elevation is unavailable. */
  _estimateSunElevation01FromHour() {
    let hour = 12;
    try { if (typeof weatherController?.timeOfDay === 'number') hour = weatherController.timeOfDay; } catch (_) {}
    hour = ((hour % 24) + 24) % 24;
    const noonDist = Math.min(Math.abs(hour - 12), 24 - Math.abs(hour - 12));
    return Math.max(0, Math.min(1, 1 - (noonDist / 6)));
  }

  /** @private @deprecated Use _updateSkyLighting — kept as alias for any external callers. */
  _updateSpriteColors() {
    this._updateSkyLighting();
  }

  /** @private */
  _updateShadowMaskUniforms() {
    const u = this._shadowMaskMat?.uniforms;
    if (!u) return;

    const p = this.params;
    const sceneRect = canvas?.dimensions?.sceneRect;
    const sceneX = sceneRect?.x ?? 0;
    const sceneY = sceneRect?.y ?? 0;
    const sceneW = sceneRect?.width ?? 4000;
    const sceneH = sceneRect?.height ?? 3000;

    u.uShadowSoftness.value = (Number(p.shadowSoftness) || 0)
      * (Number(this._driverShadowSoftnessScale) || 1.0);
    u.uMinBrightness.value = Number(p.minShadowBrightness) || 0;
    u.uSceneFadeSoftness.value = Math.max(0, Number(p.shadowSceneFadeSoftness ?? 0.025));
    u.uZoom.value = this._getZoom();
    u.uViewBoundsMin.value.set(this._viewBounds.minX, this._viewBounds.minY);
    u.uViewBoundsMax.value.set(this._viewBounds.maxX, this._viewBounds.maxY);
    this._syncCaptureBounds();
    u.uCaptureBoundsMin.value.set(this._captureBounds.minX, this._captureBounds.minY);
    u.uCaptureBoundsMax.value.set(this._captureBounds.maxX, this._captureBounds.maxY);
    u.uSceneOrigin.value.set(sceneX, sceneY);
    u.uSceneSize.value.set(sceneW, sceneH);
    u.uSceneDimensions.value.set(
      canvas?.dimensions?.width ?? sceneW,
      canvas?.dimensions?.height ?? sceneH,
    );

    u.tFloorIdTex.value = this._floorIdTex ?? null;
    u.uHasFloorIdTex.value = this._floorIdTex ? 1 : 0;
    const fw = this._fallbackWhite;
    u.tOutdoorsMask0.value = this._outdoorsMasks[0] ?? fw ?? null;
    u.tOutdoorsMask1.value = this._outdoorsMasks[1] ?? fw ?? null;
    u.tOutdoorsMask2.value = this._outdoorsMasks[2] ?? fw ?? null;
    u.tOutdoorsMask3.value = this._outdoorsMasks[3] ?? fw ?? null;
    const anyPerFloor = !!(this._outdoorsMasks[0] || this._outdoorsMasks[1]
      || this._outdoorsMasks[2] || this._outdoorsMasks[3]);
    u.uHasOutdoorsMask.value = (anyPerFloor || this._outdoorsMask) ? 1 : 0;
    u.tOutdoorsMask.value = this._outdoorsMask ?? fw ?? null;
    const anyTex = this._outdoorsMasks.find((t) => !!t) ?? this._outdoorsMask ?? null;
    u.uOutdoorsMaskFlipY.value = anyTex?.flipY ? 1.0 : 0.0;
    u.tShadowRaw.value = this._shadowRawRT?.texture ?? null;
  }

  /** @private */
  _ensureCloudLayerPlanes() {
    const THREE = window.THREE;
    if (!THREE) return;
    if (!this._cloudLayerScene) this._cloudLayerScene = new THREE.Scene();

    const desiredCount = LAYER_COUNT;
    this._cloudLayerCount = desiredCount;

    while (this._cloudLayerMeshes.length < desiredCount) {
      const layerIndex = this._cloudLayerMeshes.length;
      const mat = this._cloudLayerMatTemplate.clone();
      mat.uniforms = THREE.UniformsUtils.clone(this._cloudLayerMatTemplate.uniforms);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 22000 + layerIndex;
      this._cloudLayerScene.add(mesh);
      this._cloudLayerMeshes.push(mesh);
    }

    while (this._cloudLayerMeshes.length > desiredCount) {
      const mesh = this._cloudLayerMeshes.pop();
      if (!mesh) continue;
      try { this._cloudLayerScene.remove(mesh); } catch (_) {}
      try { mesh.geometry?.dispose?.(); } catch (_) {}
      try { mesh.material?.dispose?.(); } catch (_) {}
    }
  }

  /** @private */
  _syncCloudLayerTexture() {
    const tex = this._cloudTopRT?.texture ?? null;
    for (const mesh of this._cloudLayerMeshes) {
      if (mesh?.material?.uniforms?.tCloudTop) {
        mesh.material.uniforms.tCloudTop.value = tex;
      }
    }
  }

  /** @private */
  _updateCloudLayerTransforms() {
    const cam = this._mainCamera;
    if (!cam || !this._cloudLayerMeshes.length) return;
    const d = canvas?.dimensions;
    const rect = d?.sceneRect;
    const sceneX = rect?.x ?? d?.sceneX ?? 0;
    const sceneY = rect?.y ?? d?.sceneY ?? 0;
    const sceneW = rect?.width ?? d?.sceneWidth ?? d?.width ?? 4000;
    const sceneH = rect?.height ?? d?.sceneHeight ?? d?.height ?? 3000;
    const worldH = d?.height ?? (sceneY + sceneH);
    const centerX = sceneX + sceneW * 0.5;
    const centerY = worldH - (sceneY + sceneH * 0.5);

    const sceneComposer = window.MapShine?.sceneComposer;
    const groundZRaw = Number(sceneComposer?.groundZ);
    const groundZ = Number.isFinite(groundZRaw) ? groundZRaw : 0;
    const emitterZRaw = Number(sceneComposer?.weatherEmitterZ);
    const emitterZ = Number.isFinite(emitterZRaw) ? emitterZRaw : (groundZ + 4300);
    const camZRaw = Number(cam.position?.z);
    const camZ = Number.isFinite(camZRaw) ? camZRaw : (groundZ + 1000);
    const heightFromGround = Number(this.params.cloudLayerHeightFromGround);
    const layerHeights = [
      Number(this.params.cloudLayer1HeightFromGround),
      Number(this.params.cloudLayer2HeightFromGround),
      Number(this.params.cloudLayer3HeightFromGround),
    ];
    const baseOffsetFromEmitter = Number(this.params.cloudLayerBaseOffsetFromEmitter);
    const fallbackEmitterOffset = Number.isFinite(baseOffsetFromEmitter) ? baseOffsetFromEmitter : -2200;
    const layerSpacing = Math.max(20, Number(this.params.cloudLayerZSpacing) || 220);
    const targetBaseZ = Number.isFinite(heightFromGround)
      ? (groundZ + heightFromGround)
      : (emitterZ + fallbackEmitterOffset);
    const highestPlaneOffset = Math.max(0, (this._cloudLayerMeshes.length - 1)) * layerSpacing;
    const baseZ = Math.min(targetBaseZ, camZ - 120 - highestPlaneOffset);
    const coverageScale = Math.max(1, Number(this.params.cloudLayerCoverageScale) || 3.0);
    const depthScaleStep = Math.max(0, Number(this.params.cloudLayerDepthScaleStep) || 0.18);

    let zShiftDown = 0;
    const maxAllowedZ = camZ - 120;
    let maxDesiredZ = -Infinity;
    for (let i = 0; i < this._cloudLayerMeshes.length; i++) {
      const h = layerHeights[i];
      if (Number.isFinite(h)) maxDesiredZ = Math.max(maxDesiredZ, groundZ + h);
    }
    if (Number.isFinite(maxDesiredZ) && maxDesiredZ > maxAllowedZ) {
      zShiftDown = maxDesiredZ - maxAllowedZ;
    }

    for (let i = 0; i < this._cloudLayerMeshes.length; i++) {
      const mesh = this._cloudLayerMeshes[i];
      if (!mesh) continue;
      const layerOffsetIndex = i - 1;
      const depthScale = coverageScale * (1.0 + Math.abs(layerOffsetIndex) * depthScaleStep);
      let z = baseZ + (i * layerSpacing);
      const h = layerHeights[i];
      if (Number.isFinite(h)) z = (groundZ + h) - zShiftDown;
      mesh.position.set(centerX, centerY, z);
      mesh.scale.set(sceneW * depthScale, sceneH * depthScale, 1);
      mesh.visible = this.params.enabled && this.params.cloudTopOpacity > 0;
    }
  }

  /** @private */
  _updateCloudLayerUniforms() {
    this._ensureCloudLayerPlanes();
    if (!this._cloudLayerMeshes.length) return;

    const d = canvas?.dimensions;
    const rect = d?.sceneRect;
    const sceneX = rect?.x ?? d?.sceneX ?? 0;
    const sceneY = rect?.y ?? d?.sceneY ?? 0;
    const sceneW = rect?.width ?? d?.sceneWidth ?? d?.width ?? 4000;
    const sceneH = rect?.height ?? d?.sceneHeight ?? d?.height ?? 3000;
    const worldH = d?.height ?? (sceneY + sceneH);
    const centerX = sceneX + sceneW * 0.5;
    const centerY = worldH - (sceneY + sceneH * 0.5);

    const camPos = this._mainCamera?.position;
    const camX = Number(camPos?.x);
    const camY = Number(camPos?.y);
    const coverageScale = Math.max(1, Number(this.params.cloudLayerCoverageScale) || 3.0);
    const driftStrength = Math.max(0, Number(this.params.cloudLayerDriftStrength) || 0.02);
    const driftDepthBoost = Math.max(0, Number(this.params.cloudLayerDriftDepthBoost) || 0.015);
    const opacityBase = Math.max(0, Number(this.params.cloudLayerOpacityBase) || 0.75);
    const opacityFalloff = Math.max(0, Math.min(1, Number(this.params.cloudLayerOpacityFalloff) ?? 0.35));
    const outerReveal = Math.max(0.05, Math.min(1, Number(this.params.cloudLayerOuterReveal) ?? 0.3));
    const midReveal = Math.max(0.05, Math.min(1, Number(this.params.cloudLayerMidReveal) ?? 0.9));
    const layerReveals = [outerReveal, midReveal, outerReveal];
    const layerNoiseSeeds = [
      [17.3, 8.1],
      [91.7, 42.3],
      [203.5, 156.8],
    ];
    const noiseScale = Math.max(1e-6, Number(this.params.cloudLayerNoiseScale) || 0.0002);
    const noiseSoftness = Math.max(0.001, Number(this.params.cloudLayerNoiseSoftness) ?? 0.015);
    const edgeSoftness = Math.max(0.01, Number(this.params.cloudLayerEdgeSoftness) || 0.12);
    const opacity = Math.max(0, Number(this.params.cloudTopOpacity) || 0);
    const zoom = this._getZoom();
    const fadeStart = Number(this.params.cloudTopFadeStart) || 0.24;
    const fadeEnd = Math.max(fadeStart + 0.01, Number(this.params.cloudTopFadeEnd) || 0.39);
    const topFade = this._smoothstep(fadeEnd, fadeStart, zoom);
    const warpSpeed = Math.max(0, Number(this.params.domainWarpSpeed) ?? 1);
    const overlayWarp = Math.max(0, Number(this.params.overlayDomainWarpStrength) ?? 0);
    const warpTime = this._lastElapsed * warpSpeed;

    const sceneComposer = window.MapShine?.sceneComposer;
    const groundZRaw = Number(sceneComposer?.groundZ);
    const groundZ = Number.isFinite(groundZRaw) ? groundZRaw : 0;
    const camZRaw = Number(camPos?.z);
    const camZ = Number.isFinite(camZRaw) ? camZRaw : (groundZ + 1000);
    const camZSpan = Math.max(1e-3, camZ - groundZ);

    for (let i = 0; i < this._cloudLayerMeshes.length; i++) {
      const mesh = this._cloudLayerMeshes[i];
      const u = mesh?.material?.uniforms;
      if (!u) continue;

      const layerScale = coverageScale;
      const halfW = (sceneW * layerScale) * 0.5;
      const halfH = (sceneH * layerScale) * 0.5;

      u.uViewBoundsMin.value.set(centerX - halfW, centerY - halfH);
      u.uViewBoundsMax.value.set(centerX + halfW, centerY + halfH);
      this._syncCaptureBounds();
      u.uCaptureBoundsMin.value.set(this._captureBounds.minX, this._captureBounds.minY);
      u.uCaptureBoundsMax.value.set(this._captureBounds.maxX, this._captureBounds.maxY);
      u.uAlphaStart.value = Math.max(0, Math.min(0.99, Number(this.params.cloudTopAlphaStart) ?? 0.2));
      u.uAlphaEnd.value = Math.max(u.uAlphaStart.value + 0.01, Math.min(1, Number(this.params.cloudTopAlphaEnd) ?? 0.6));
      u.uEdgeSoftness.value = edgeSoftness;
      u.uLayerReveal.value = layerReveals[i] ?? midReveal;
      const seed = layerNoiseSeeds[i] ?? layerNoiseSeeds[1];
      u.uNoiseSeed.value.set(seed[0], seed[1]);
      u.uNoiseScale.value = noiseScale;
      u.uNoiseSoftness.value = noiseSoftness;
      if (u.uWarpTime) u.uWarpTime.value = warpTime;
      if (u.uWarpStrength) u.uWarpStrength.value = overlayWarp;
      if (u.uWarpSpeed) u.uWarpSpeed.value = warpSpeed;

      const layerZRaw = Number(mesh?.position?.z);
      const layerZ = Number.isFinite(layerZRaw) ? layerZRaw : groundZ;
      const height01 = Math.max(0, Math.min(1, (layerZ - groundZ) / camZSpan));
      const parallaxStrength = this._layerParallaxMult(i) * height01;
      const nCamX = Number.isFinite(camX) ? ((camX - centerX) / Math.max(1, sceneW)) : 0;
      const nCamY = Number.isFinite(camY) ? ((camY - centerY) / Math.max(1, sceneH)) : 0;
      const wind = this._windOffset;
      const windNormX = Math.tanh((wind?.x ?? 0) * 0.08);
      const windNormY = Math.tanh((wind?.y ?? 0) * 0.08);

      u.uUvOffset.value.set(
        (windNormX * driftStrength) + (nCamX * parallaxStrength * driftDepthBoost * 6.0),
        (windNormY * driftStrength) + (nCamY * parallaxStrength * driftDepthBoost * 6.0),
      );

      const layerOpacity = opacityBase * Math.max(0, 1.0 - opacityFalloff * i);
      u.uOpacityMul.value = opacity * layerOpacity * topFade;
    }
  }

  // ── Control schema ────────────────────────────────────────────────────────

  static getControlSchema() {
    return getCloudControlSchema();
  }

  // ── Accessors ───────────────────────────────────────────────────────────

  get cloudShadowTexture() { return this._shadowRT?.texture ?? null; }

  /** View-aligned cloud shadow for window lights (no indoors/outdoors mask gate). */
  get cloudShadowWindowTexture() { return this._shadowWindowRT?.texture ?? null; }

  get cloudShadowRawTexture() { return this._shadowRawRT?.texture ?? null; }

  get cloudShadowViewBounds() {
    return {
      minX: Number(this._viewBounds.minX) || 0,
      minY: Number(this._viewBounds.minY) || 0,
      maxX: Number(this._viewBounds.maxX) || 0,
      maxY: Number(this._viewBounds.maxY) || 0,
    };
  }

  /** @deprecated Procedural density removed; returns cloud top texture for debug compatibility. */
  get cloudDensityTexture() { return this._cloudTopRT?.texture ?? null; }

  get cloudTopTexture() { return this._cloudTopRT?.texture ?? null; }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** @private True while Camera Path (or similar) owns the environment ramp. */
  _isEnvironmentExternallyDriven() {
    try {
      return window.MapShine?.environmentControlApi?.isExternallyDriven?.() === true;
    } catch (_) {
      return false;
    }
  }

  /** @private */
  _getWeatherState() {
    let cloudCover = this.params.cloudCover ?? 0.5;
    let windSpeed = 0.07;
    let windDirX = 1.0;
    let windDirY = 0.0;
    const externalDrive = this._isEnvironmentExternallyDriven();
    try {
      if (weatherController) {
        const wcInitialized = weatherController.initialized === true;
        let s = null;
        if (externalDrive) {
          // Camera Path ramps write target/current directly; getCurrentState() can
          // still return the neutral disabled snapshot when weather is toggled off.
          s = weatherController.currentState ?? weatherController.targetState;
        } else if (typeof weatherController.getCurrentState === 'function') {
          s = weatherController.getCurrentState();
        } else {
          s = weatherController.currentState;
        }
        if (s && (wcInitialized || externalDrive)) {
          if (typeof s.cloudCover === 'number') cloudCover = s.cloudCover;
          if (typeof s.windSpeedMS === 'number' && Number.isFinite(s.windSpeedMS)) {
            windSpeed = Math.max(0.0, Math.min(1.0, s.windSpeedMS / 78.0));
          } else if (typeof s.windSpeed === 'number' && Number.isFinite(s.windSpeed)) {
            windSpeed = Math.max(0.0, Math.min(1.0, s.windSpeed));
          }
          if (s.windDirection) {
            windDirX = s.windDirection.x ?? windDirX;
            windDirY = s.windDirection.y ?? windDirY;
          }
        }
      }
    } catch (_) {}

    const weatherGloballyEnabled = !(weatherController && weatherController.enabled === false);
    return {
      weatherEnabled: (externalDrive || weatherGloballyEnabled) && this.enabled,
      cloudCover: Math.max(0, Math.min(1, Number(cloudCover) || 0)),
      windDirX,
      windDirY,
      windSpeed,
    };
  }

  /** @private */
  _isCoverZero(cover) { return (cover ?? 0) < this._cloudCoverEpsilon; }

  /** @private */
  _getZoom() {
    const sc = window.MapShine?.sceneComposer;
    if (sc?.currentZoom !== undefined) return sc.currentZoom;
    if (!this._mainCamera) return 1;
    if (this._mainCamera.isOrthographicCamera) return this._mainCamera.zoom;
    const z = this._mainCamera.position.z;
    return z > 0.1 ? 10000 / z : 1;
  }

  /** @private */
  _smoothstep(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0 + 1e-8)));
    return t * t * (3 - 2 * t);
  }

  /** @private */
  setDriver(driverState = null) {
    if (!driverState) return;
    const dir = driverState.sun?.dir;
    const x = Number(dir?.x);
    const y = Number(dir?.y);
    if (Number.isFinite(x) && Number.isFinite(y) && this._sunDir) {
      this._sunDir.set(x, y);
    }
    let tuningChanged = false;
    const newSoftness = Number(driverState.tuning?.shadowSoftnessScale);
    if (Number.isFinite(newSoftness) && this._driverShadowSoftnessScale !== newSoftness) {
      this._driverShadowSoftnessScale = newSoftness;
      tuningChanged = true;
    }
    const newLength = Number(driverState.tuning?.shadowLengthScale);
    if (Number.isFinite(newLength) && this._driverShadowLengthScale !== newLength) {
      this._driverShadowLengthScale = newLength;
      tuningChanged = true;
    }
    if (tuningChanged) this._invalidateShadowPassCache();
  }

  /** @private */
  _calcSunDir() {
    if (!this._sunDir) return;
    const driver = window.MapShine?.__shadowDriverState;
    const d = driver?.sun?.dir;
    const dx = Number(d?.x);
    const dy = Number(d?.y);
    if (Number.isFinite(dx) && Number.isFinite(dy)) {
      this._sunDir.set(dx, dy);
      return;
    }
    const sky = window.MapShine?.effectComposer?._floorCompositorV2?._skyColorEffect
      ?? window.MapShine?.floorCompositorV2?._skyColorEffect;
    const sun2d = resolveEffectShadowSun2D({
      azimuthDeg: sky?.currentSunAzimuthDeg,
      elevationDeg: sky?.currentSunElevationDeg,
    });
    this._sunDir.set(sun2d.x, sun2d.y);
  }

  /** @private */
  _calcTimeOfDayTint() {
    if (!this._tintResult) return null;
    let hour = 12;
    try { if (typeof weatherController?.timeOfDay === 'number') hour = weatherController.timeOfDay; } catch (_) {}
    hour = ((hour % 24) + 24) % 24;
    const t = this._tintResult;
    if (hour < 5) t.copy(this._tintNight);
    else if (hour < 6) t.lerpVectors(this._tintNight, this._tintSunrise, hour - 5);
    else if (hour < 7) t.lerpVectors(this._tintSunrise, this._tintDay, hour - 6);
    else if (hour < 17) t.copy(this._tintDay);
    else if (hour < 18) t.lerpVectors(this._tintDay, this._tintSunset, hour - 17);
    else if (hour < 19) t.lerpVectors(this._tintSunset, this._tintNight, hour - 18);
    else t.copy(this._tintNight);
    return t;
  }

  dispose() {
    for (const sprite of this._cloudSprites) {
      try { this._cloudLayerGroups[sprite.layerIndex]?.remove(sprite.mesh); } catch (_) {}
      sprite.dispose();
    }
    this._cloudSprites = [];

    for (const k of ['_shadowRT', '_shadowWindowRT', '_shadowRawRT', '_cloudTopRT']) {
      try { this[k]?.dispose(); } catch (_) {}
      this[k] = null;
    }

    for (const k of ['_shadowMaskMat', '_cloudLayerMatTemplate']) {
      try { this[k]?.dispose(); } catch (_) {}
      this[k] = null;
    }

    try { this._fallbackWhite?.dispose(); } catch (_) {}
    this._fallbackWhite = null;

    try { this._quad?.geometry?.dispose(); } catch (_) {}
    for (const mesh of this._cloudLayerMeshes) {
      try { mesh?.geometry?.dispose?.(); } catch (_) {}
      try { mesh?.material?.dispose?.(); } catch (_) {}
    }
    this._cloudLayerMeshes = [];
    this._quad = null;
    this._quadScene = null;
    this._cloudLayerScene = null;
    this._cloudScene = null;
    this._cloudAnchor = null;
    this._cloudLayerGroups = [];
    this._invalidateShadowPassCache();
    this._initialized = false;
    this._assetsLoaded = false;
    log.info('CloudEffectV2 disposed');
  }
}
