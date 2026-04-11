/**
 * @fileoverview CloudEffectV2 — V2 procedural cloud system.
 *
 * HEALTH-WIRING BADGE (Map Shine Breaker Box):
 * If you change this effect's lifecycle, render targets, floor/context gating,
 * or downstream texture outputs, you MUST update HealthEvaluator contracts/wiring
 * for `CloudEffectV2` to prevent silent failures.
 *
 * Outputs:
 *   - _shadowRT  : Shadow factor (1.0=lit, 0.0=shadowed). Fed into LightingEffectV2
 *                  as a multiplier so cloud shadow darkens scene illumination.
 *   - _cloudTopRT: RGBA cloud-top texture source for elevated world-space cloud planes.
 *
 * ## Cloud shadow vs overhead / upper floors
 *
 * The lit-scene shadow factor (`_shadowRT`) multiplies outdoors-masked cloud
 * darkness by (1) an overhead-tile blocker mask (CLOUD_SHADOW_BLOCKER capture)
 * and (2) a cross-floor mask of tile alpha for floors strictly above the active
 * band (`renderFloorMaskTo` with `includeHiddenAboveFloors`), so cloud shadows
 * do not leak under upper-floor slabs that are normally hidden by floor slicing.
 * ShadowManagerV2 still composes cloud with separate overhead/building factors.
 * The outdoors mask gates cloud shadow where authored.
 *
 * ## Pipeline position in FloorCompositor
 *
 *   Bus → sceneRT
 *     → Lighting(cloudShadowRT) → postA
 *     → SkyColor → ColorCorrection → Water → Bloom → …
 *     → Elevated Cloud Planes (world-space, stacked near weather emitter height)
 *
 * @module compositor-v2/effects/CloudEffectV2
 */

import { createLogger } from '../../core/log.js';
import { TILE_FEATURE_LAYERS } from '../../core/render-layers.js';
import { weatherController } from '../../core/WeatherController.js';

const log = createLogger('CloudEffectV2');

// ─────────────────────────────────────────────────────────────────────────────

export class CloudEffectV2 {
  constructor() {
    /** @type {boolean} */
    this.enabled = true;
    /** @type {boolean} */
    this._initialized = false;

    // ── Params (mirrors V1 CloudEffect defaults) ─────────────────────
    this.params = {
      enabled: true,
      internalResolutionScale: 0.5,

      // Generation
      cloudCover: 0.5,
      noiseScale: 0.5,
      noiseDetail: 4,
      cloudSharpness: 0.0,
      noiseTimeSpeed: 0.011,
      cloudBrightness: 1.01,
      cloudTopSoftKnee: 1.8,

      // Domain warp
      domainWarpEnabled: true,
      domainWarpStrength: 0.005,
      domainWarpScale: 1.05,
      domainWarpSpeed: 0.115,
      domainWarpTimeOffsetY: 10,

      // Cloud-top shading
      cloudTopShadingEnabled: true,
      cloudTopShadingStrength: 0.99,
      cloudTopNormalStrength: 0.96,
      cloudTopAOIntensity: 2.0,
      cloudTopEdgeHighlight: 0,
      cloudTopPeakDetailEnabled: false,
      cloudTopPeakDetailStrength: 0.32,
      cloudTopPeakDetailScale: 92.5,
      cloudTopPeakDetailSpeed: 0.08,
      cloudTopPeakDetailStart: 0.14,
      cloudTopPeakDetailEnd: 0.82,

      // Shadow
      shadowOpacity: 0.7,
      shadowSoftness: 0.9,
      shadowOffsetScale: 0.3,
      minShadowBrightness: 0.0,
      shadowSceneFadeSoftness: 0.025,

      // Cloud tops
      cloudTopMode: 'aboveEverything',
      cloudTopOpacity: 1.0,
      cloudTopAlphaStart: 0.2,
      cloudTopAlphaEnd: 0.6,
      cloudTopParallaxFactor: 1.0,
      cloudTopDepthParallaxStrength: 0.6,
      cloudTopFadeStart: 0.24,
      cloudTopFadeEnd: 0.39,
      cloudLayerCount: 3,
      cloudLayerCoverageScale: 3.0,
      cloudLayerDepthScaleStep: 0.18,
      cloudLayerHeightFromGround: 200,
      cloudLayer1HeightFromGround: 0,
      cloudLayer2HeightFromGround: 150,
      cloudLayer3HeightFromGround: 300,
      cloudLayerZSpacing: 220,
      cloudLayerBaseOffsetFromEmitter: -2200,
      // Edge softness is applied to the world-space mesh boundary (mesh = coverageScale * scene).
      // With the default coverageScale=3, the mesh edge is 1 scene-width outside the scene.
      // 0.12 of mesh width ≈ 36% of scene width of fade at each edge, giving smooth falloff
      // well outside the viewport without being invisible within the scene.
      cloudLayerEdgeSoftness: 0.12,
      cloudLayerOpacityBase: 0.75,
      cloudLayerOpacityFalloff: 0.35,
      cloudLayerUvScaleStep: 0.25,
      cloudLayerDriftStrength: 0.02,
      cloudLayerDriftDepthBoost: 0.015,
      cloudLayerSliceStrength: 0.7,
      cloudLayerSliceScale: 2.2,
      cloudLayerSliceContrast: 1.3,
      cloudLayerSliceSpeed: 0.015,
      cloudLayerSliceSpacing: 2.0,

      // Wind
      windInfluence: 1.33,
      driftSpeed: 0.01,
      minDriftSpeed: 0.002,
      driftResponsiveness: 0.4,
      driftMaxSpeed: 0.5,
      layerParallaxBase: 1.0,

      // 5 cloud layers
      layer1Enabled: true,  layer1Opacity: 0.35, layer1Coverage: 0.33, layer1Scale: 1.34, layer1ParallaxMult: 1.00, layer1SpeedMult: 0.99, layer1DirDeg: -1.7,
      layer2Enabled: true,  layer2Opacity: 0.70, layer2Coverage: 0.57, layer2Scale: 1.22, layer2ParallaxMult: 0.82, layer2SpeedMult: 1.07, layer2DirDeg: -0.86,
      layer3Enabled: true,  layer3Opacity: 0.19, layer3Coverage: 0.90, layer3Scale: 3.00, layer3ParallaxMult: 0.64, layer3SpeedMult: 0.94, layer3DirDeg: 0.0,
      layer4Enabled: true,  layer4Opacity: 0.17, layer4Coverage: 0.46, layer4Scale: 1.72, layer4ParallaxMult: 0.46, layer4SpeedMult: 0.94, layer4DirDeg: 0.86,
      layer5Enabled: true,  layer5Opacity: 0.13, layer5Coverage: 0.62, layer5Scale: 1.52, layer5ParallaxMult: 0.28, layer5SpeedMult: 1.07, layer5DirDeg: -0.6,
    };

    // ── Render targets ────────────────────────────────────────────────
    /** @type {THREE.WebGLRenderTarget|null} Overscanned density for shadow offset+blur */
    this._shadowDensityRT = null;
    /** @type {THREE.WebGLRenderTarget|null} Normal-bounds density (cloud tops + consumers) */
    this._densityRT       = null;
    /** @type {THREE.WebGLRenderTarget|null} Parallaxed multi-layer density for cloud tops */
    this._topDensityRT    = null;
    /** @type {THREE.WebGLRenderTarget|null} Final shadow factor (bound into LightingEffectV2) */
    this._shadowRT        = null;
    /** @type {THREE.WebGLRenderTarget|null} Shadow without outdoors mask (indoor consumers) */
    this._shadowRawRT     = null;
    /** @type {THREE.WebGLRenderTarget|null} RGBA cloud-top overlay */
    this._cloudTopRT      = null;
    /** @type {THREE.WebGLRenderTarget|null} Overhead-tile blocker mask for shadow occlusion */
    this._blockerRT       = null;
    /** @type {THREE.WebGLRenderTarget|null} Tile alpha for floors above active (same res as shadow RTs) */
    this._upperFloorOccluderRT = null;

    // ── Materials ─────────────────────────────────────────────────────
    this._densityMat      = null;
    this._shadowMat       = null;
    this._cloudTopMat     = null;
    this._cloudLayerMatTemplate = null;

    // ── Scenes / cameras / quads ──────────────────────────────────────
    this._quadScene = null;
    this._quadCam   = null;
    /** @type {THREE.Mesh|null} Reused fullscreen quad; material swapped per pass */
    this._quad      = null;
    /** @type {THREE.Scene|null} Elevated cloud layer scene rendered with main camera */
    this._cloudLayerScene = null;
    /** @type {Array<THREE.Mesh>} */
    this._cloudLayerMeshes = [];
    /** @type {number} */
    this._cloudLayerCount = 4;

    // ── External references (set by FloorCompositor) ──────────────────
    this._renderer    = null;
    /** @type {THREE.Scene|null} FloorRenderBus scene — used for blocker pass */
    this._busScene    = null;
    this._mainCamera  = null;
    /** @type {THREE.Texture|null} Outdoors mask (legacy single-texture path) */
    this._outdoorsMask = null;

    /** @type {Array<THREE.Texture|null>} Per-floor outdoors masks (0..3) */
    this._outdoorsMasks = [null, null, null, null];

    /** @type {THREE.Texture|null} World-space floor ID texture (topmost floor per pixel) */
    this._floorIdTex = null;
    /** @type {THREE.Texture|null} Optional external upper-floor mask (overrides built-in RT when set) */
    this._upperFloorOccluderMask = null;

    /**
     * Builds tile alpha into `_upperFloorOccluderRT` (same dimensions as shadow RTs).
     * Assigned by FloorCompositor: delegates to FloorRenderBus.renderFloorMaskTo.
     * @type {((renderer: import('three').WebGLRenderer, camera: import('three').Camera, target: import('three').WebGLRenderTarget) => void)|null}
     */
    this._upperFloorMaskBuilder = null;

    /** @type {boolean} Whether `_upperFloorOccluderRT` was filled this frame for pass 2b */
    this._upperFloorMaskValid = false;

    /** @type {THREE.DataTexture|null} */
    this._fallbackWhite = null;

    // ── Wind simulation ───────────────────────────────────────────────
    this._windOffset    = null;
    this._windVelocity  = null;
    this._layerWindOffsets     = null; // Array<THREE.Vector2> length 5
    this._layerWindVelocities  = null; // Array<THREE.Vector2> length 5
    /** @type {Float32Array|null} Flat [x0,y0, x1,y1, …] for uniform upload */
    this._layerWindOffsetsFlat = null;

    // Per-layer config typed arrays (mutated in-place; avoid GC allocs per frame)
    this._layerSpeedMult      = new Float32Array(5);
    this._layerDirAngle       = new Float32Array(5);
    this._layerParallax       = new Float32Array(5);
    this._layerTopParallax    = new Float32Array(5);
    this._layerCoverMult      = new Float32Array(5);
    this._layerNoiseScaleMult = new Float32Array(5);
    this._layerWeight         = new Float32Array(5);

    // ── Sun direction & time-of-day tint ─────────────────────────────
    this._sunDir      = null;
    this._shadeSunDir = null;
    this._tintNight   = null;
    this._tintSunrise = null;
    this._tintDay     = null;
    this._tintSunset  = null;
    this._tintResult  = null;

    // ── Temp / state ──────────────────────────────────────────────────
    this._tempVec2A = null;
    this._tempVec2B = null;
    this._tempSize  = null;
    this._lastElapsed         = 0;
    this._cloudTopDensityValid = false;
    this._needsNeutralClear   = false;
    this._cloudCoverZeroLF    = false; // zero-cover last frame
    this._cloudCoverEpsilon   = 0.0001;

    // ── Blocker pass: visibility override pool (avoid per-frame allocs) ──
    this._blockerOverrideObjs  = [];
    this._blockerOverrideVis   = [];
    this._blockerOverrideCount = 0;

    // ── RT size cache ─────────────────────────────────────────────────
    this._lastFullW     = 0;
    this._lastFullH     = 0;
    this._lastInternalW = 0;
    this._lastInternalH = 0;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Create GPU resources. Called by FloorCompositor after renderer is ready.
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene}  busScene   FloorRenderBus scene (used in blocker pass)
   * @param {THREE.Camera} mainCamera Main perspective camera
   */
  initialize(renderer, busScene, mainCamera) {
    const THREE = window.THREE;
    if (!THREE) { log.error('THREE not available'); return; }

    this._renderer   = renderer;
    this._busScene   = busScene;
    this._mainCamera = mainCamera;

    // Wind state
    this._windOffset           = new THREE.Vector2(0, 0);
    this._windVelocity         = new THREE.Vector2(0, 0);
    this._layerWindOffsets     = Array.from({ length: 5 }, () => new THREE.Vector2());
    this._layerWindVelocities  = Array.from({ length: 5 }, () => new THREE.Vector2());
    this._layerWindOffsetsFlat = new Float32Array(10);

    // Temp helpers
    this._tempVec2A = new THREE.Vector2();
    this._tempVec2B = new THREE.Vector2();
    this._tempSize  = new THREE.Vector2();

    // Sun / tint
    this._sunDir      = new THREE.Vector2(0, 1);
    this._shadeSunDir = new THREE.Vector2(0, 1);
    this._tintNight   = new THREE.Vector3(0.13, 0.15, 0.20);
    this._tintSunrise = new THREE.Vector3(1.00, 0.70, 0.50);
    this._tintDay     = new THREE.Vector3(1.00, 1.00, 1.00);
    this._tintSunset  = new THREE.Vector3(1.00, 0.60, 0.40);
    this._tintResult  = new THREE.Vector3(1.00, 1.00, 1.00);

    // Fullscreen quad for internal passes
    this._quadScene = new THREE.Scene();
    this._quadCam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._quad      = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this._quad.frustumCulled = false;
    this._quadScene.add(this._quad);

    // Elevated cloud planes (world-space), rendered after the post chain.
    this._cloudLayerScene = new THREE.Scene();

    this._createDensityMaterial();
    this._createShadowMaterial();
    this._createCloudTopMaterial();
    this._createCloudLayerMaterialTemplate();
    this._ensureCloudLayerPlanes();

    this._ensureFallbackWhite();

    this._initialized = true;
    log.info('CloudEffectV2 initialized');
  }

  /** Supply the outdoors mask texture (legacy single-texture path). */
  setOutdoorsMask(texture) { this._outdoorsMask = texture ?? null; }

  /** Supply per-floor outdoors masks (indices 0..3). Missing entries may be null. */
  setOutdoorsMasks(textures) {
    if (!Array.isArray(textures)) return;
    for (let i = 0; i < 4; i++) this._outdoorsMasks[i] = textures[i] ?? null;
  }

  /** Supply the compositor floor ID texture (GpuSceneMaskCompositor.floorIdTarget.texture). */
  setFloorIdTexture(texture) { this._floorIdTex = texture ?? null; }

  /** Supply a screen-space mask for floors above active floor (alpha=occluded). */
  setUpperFloorOccluderMask(texture) { this._upperFloorOccluderMask = texture ?? null; }

  /**
   * Register the mask builder (typically FloorRenderBus.renderFloorMaskTo wrapper).
   * Target RT matches internal cloud shadow resolution.
   * @param {((renderer: import('three').WebGLRenderer, camera: import('three').Camera, target: import('three').WebGLRenderTarget) => void)|null} fn
   */
  setUpperFloorMaskBuilder(fn) {
    this._upperFloorMaskBuilder = typeof fn === 'function' ? fn : null;
  }

  /** @private */
  _ensureFallbackWhite() {
    const THREE = window.THREE;
    if (!THREE) return;
    if (this._fallbackWhite) return;
    const data = new Uint8Array([255, 255, 255, 255]);
    this._fallbackWhite = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    this._fallbackWhite.needsUpdate = true;
    this._fallbackWhite.flipY = false;
    this._fallbackWhite.generateMipmaps = false;
    this._fallbackWhite.minFilter = THREE.NearestFilter;
    this._fallbackWhite.magFilter = THREE.NearestFilter;
  }

  // ── Wind advance ──────────────────────────────────────────────────────────

  /**
   * Advance wind simulation by one frame delta. Called from FloorCompositor
   * BEFORE update() so accumulation happens exactly once per frame.
   * @param {number} delta Seconds
   */
  advanceWind(delta) {
    if (!this._initialized || !this.params.enabled) return;
    const ws = this._getWeatherState();
    if (!ws.weatherEnabled || this._isCoverZero(ws.cloudCover)) return;
    this._advanceWindSim(delta, ws.windDirX, ws.windDirY, ws.windSpeed);
  }

  /** @private */
  _advanceWindSim(delta, windDirX, windDirY, windSpeed) {
    const p = this.params;
    const targetSpd = Math.max(windSpeed * p.windInfluence * p.driftSpeed, p.minDriftSpeed || 0);
    const resp   = Math.max(0, p.driftResponsiveness ?? 2.5);
    const maxSpd = Math.max(0, p.driftMaxSpeed ?? 0.05);
    const alpha  = resp > 0 ? (1 - Math.exp(-resp * delta)) : 1;
    const toRad  = Math.PI / 180;

    // Global base offset
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

    // Per-layer offsets with individual speed/direction offsets
    const baseParallax = Math.max(0, Math.min(1, p.layerParallaxBase ?? 1));
    for (let i = 0; i < 5; i++) {
      const n = i + 1;
      this._layerSpeedMult[i]      = p[`layer${n}SpeedMult`]     ?? 1;
      this._layerDirAngle[i]       = (p[`layer${n}DirDeg`]       ?? 0) * toRad;
      this._layerParallax[i]       = Math.max(0, Math.min(1, baseParallax * (p[`layer${n}ParallaxMult`] ?? 1)));
      this._layerNoiseScaleMult[i] = p[`layer${n}Scale`]          ?? 1;
      this._layerCoverMult[i]      = p[`layer${n}Coverage`]       ?? 0.5;
      this._layerWeight[i]         = p[`layer${n}Enabled`] ? (p[`layer${n}Opacity`] ?? 0) : 0;
    }

    this._tempVec2A.set(windDirX, windDirY);
    if (this._tempVec2A.lengthSq() > 1e-6) this._tempVec2A.normalize();

    for (let i = 0; i < 5; i++) {
      const a  = this._layerDirAngle[i];
      const ca = Math.cos(a); const sa = Math.sin(a);
      const sm = this._layerSpeedMult[i];
      this._tempVec2B.set(
        this._tempVec2A.x * ca - this._tempVec2A.y * sa,
        this._tempVec2A.x * sa + this._tempVec2A.y * ca
      ).multiplyScalar(targetSpd * sm);
      const v = this._layerWindVelocities[i];
      v.lerp(this._tempVec2B, alpha);
      const vml = maxSpd * sm; const vll = v.length();
      if (vll > vml && vll > 1e-6) v.multiplyScalar(vml / vll);
      const o = this._layerWindOffsets[i];
      o.x -= v.x * delta; o.y -= v.y * delta;
      if (!Number.isFinite(o.x)) o.x = 0;
      if (!Number.isFinite(o.y)) o.y = 0;
      this._layerWindOffsetsFlat[i * 2]     = o.x;
      this._layerWindOffsetsFlat[i * 2 + 1] = o.y;
    }
  }

  // ── Per-frame uniform update ───────────────────────────────────────────────

  /** @param {{ elapsed: number, delta: number }} timeInfo */
  update(timeInfo) {
    if (!this._initialized || !this.params.enabled) return;
    this._lastElapsed = timeInfo?.elapsed ?? 0;

    const ws = this._getWeatherState();
    if (!ws.weatherEnabled || this._isCoverZero(ws.cloudCover)) {
      if (!this._cloudCoverZeroLF) this._needsNeutralClear = true;
      this._cloudCoverZeroLF = true;
      if (this._densityMat?.uniforms?.uCloudCover) this._densityMat.uniforms.uCloudCover.value = 0;
      return;
    }
    this._cloudCoverZeroLF  = false;
    this._needsNeutralClear = false;

    this._calcSunDir();

    const sceneRect = canvas?.dimensions?.sceneRect;
    const sceneX = sceneRect?.x ?? 0;
    const sceneY = sceneRect?.y ?? 0;
    const sceneW = sceneRect?.width  ?? 4000;
    const sceneH = sceneRect?.height ?? 3000;

    const sc = window.MapShine?.sceneComposer;
    let vMinX = 0, vMinY = 0, vMaxX = sceneW, vMaxY = sceneH;
    if (sc && this._mainCamera) {
      const cam = this._mainCamera;
      if (cam.isOrthographicCamera) {
        const camPos = cam.position;
        vMinX = camPos.x + cam.left   / cam.zoom;
        vMinY = camPos.y + cam.bottom / cam.zoom;
        vMaxX = camPos.x + cam.right  / cam.zoom;
        vMaxY = camPos.y + cam.top    / cam.zoom;
      } else {
        // Perspective camera: derive stable view bounds at ground plane.
        // The camera is top-down, looking along -Z with no tilt, and zoom is
        // implemented by varying FOV (see SceneComposer.setupCamera()).
        const groundZ = sc.groundZ ?? 0;
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

    const p  = this.params;
    const du = this._densityMat?.uniforms;
    if (du) {
      du.uTime.value               = this._lastElapsed;
      du.uCloudCover.value         = ws.cloudCover;
      du.uNoiseScale.value         = p.noiseScale;
      du.uNoiseDetail.value        = p.noiseDetail;
      du.uCloudSharpness.value     = p.cloudSharpness;
      du.uNoiseTimeSpeed.value     = p.noiseTimeSpeed;
      du.uDomainWarpEnabled.value  = p.domainWarpEnabled  ? 1 : 0;
      du.uDomainWarpStrength.value = p.domainWarpStrength;
      du.uDomainWarpScale.value    = p.domainWarpScale;
      du.uDomainWarpSpeed.value    = p.domainWarpSpeed;
      du.uDomainWarpTimeOffsetY.value = p.domainWarpTimeOffsetY;
      du.uCompositeSoftKnee.value  = Number(p.cloudTopSoftKnee) || 0;
      du.uSceneOrigin.value.set(sceneX, sceneY);
      du.uSceneSize.value.set(sceneW, sceneH);
      du.uViewBoundsMin.value.set(vMinX, vMinY);
      du.uViewBoundsMax.value.set(vMaxX, vMaxY);
      // Flat typed arrays skip Three.js per-frame flatten overhead
      du.uLayerWindOffsets.value    = this._layerWindOffsetsFlat;
      du.uLayerParallax.value       = this._layerParallax;
      du.uLayerCoverMult.value      = this._layerCoverMult;
      du.uLayerNoiseScaleMult.value = this._layerNoiseScaleMult;
      du.uLayerWeight.value         = this._layerWeight;
    }

    const zoom = this._getZoom();
    const su   = this._shadowMat?.uniforms;
    if (su) {
      su.uShadowOpacity.value  = p.shadowOpacity;
      su.uShadowSoftness.value = p.shadowSoftness;
      su.uMinBrightness.value  = p.minShadowBrightness;
      su.uSceneFadeSoftness.value = Math.max(0, p.shadowSceneFadeSoftness ?? 0.025);
      su.uZoom.value           = zoom;
      su.uSceneOrigin.value.set(sceneX, sceneY);
      su.uSceneSize.value.set(sceneW, sceneH);
      su.uViewBoundsMin.value.set(vMinX, vMinY);
      su.uViewBoundsMax.value.set(vMaxX, vMaxY);
      su.uSceneDimensions.value.set(
        canvas?.dimensions?.width  ?? sceneW,
        canvas?.dimensions?.height ?? sceneH
      );

      // World-space shadow offset (sun-direction displacement)
      const offW = p.shadowOffsetScale * 5000;
      // Keep cast direction aligned with Building/Overhead conventions:
      // shadows project opposite the sun direction in world UV.
      su.uShadowOffsetWorld.value.set(-this._sunDir.x * offW, -this._sunDir.y * offW);

      // Overscanned density bounds so blur kernel stays inside density texture
      const iW = this._densityRT?.width ?? 1024;
      const iH = this._densityRT?.height ?? 1024;
      const viewW = vMaxX - vMinX; const viewH = vMaxY - vMinY;
      const wpx = viewW / Math.max(1, iW); const wpy = viewH / Math.max(1, iH);
      const blurPx = (p.shadowSoftness ?? 0) * 20 * zoom;
      const absOX = Math.abs(su.uShadowOffsetWorld.value.x);
      const absOY = Math.abs(su.uShadowOffsetWorld.value.y);
      const mX = absOX + blurPx * wpx * 2 + wpx * 4;
      const mY = absOY + blurPx * wpy * 2 + wpy * 4;
      su.uDensityBoundsMin.value.set(vMinX - mX, vMinY - mY);
      su.uDensityBoundsMax.value.set(vMaxX + mX, vMaxY + mY);

      // Multi-floor outdoors mask selection: provide floorId + per-floor masks.
      // Fallback: legacy single outdoors mask.
      su.tFloorIdTex.value    = this._floorIdTex ?? null;
      su.uHasFloorIdTex.value = this._floorIdTex ? 1 : 0;
      const fw = this._fallbackWhite;
      su.tOutdoorsMask0.value = this._outdoorsMasks[0] ?? fw ?? null;
      su.tOutdoorsMask1.value = this._outdoorsMasks[1] ?? fw ?? null;
      su.tOutdoorsMask2.value = this._outdoorsMasks[2] ?? fw ?? null;
      su.tOutdoorsMask3.value = this._outdoorsMasks[3] ?? fw ?? null;
      const anyPerFloor = !!(this._outdoorsMasks[0] || this._outdoorsMasks[1] || this._outdoorsMasks[2] || this._outdoorsMasks[3]);
      su.uHasOutdoorsMask.value = (anyPerFloor || this._outdoorsMask) ? 1 : 0;
      // Legacy binding for scenes without floorId support.
      su.tOutdoorsMask.value = this._outdoorsMask ?? fw ?? null;

      // Outdoors mask textures are authored in Foundry Y-down space.
      // If the GPU texture has flipY=true, we must flip the sampling Y to match.
      // (This mirrors WaterEffectV2's uOutdoorsMaskFlipY concept.)
      const anyTex = this._outdoorsMasks.find(t => !!t) ?? this._outdoorsMask ?? null;
      su.uOutdoorsMaskFlipY.value = anyTex?.flipY ? 1.0 : 0.0;
      su.tUpperFloorMask.value = null;
      su.uHasUpperFloorMask.value = 0.0;
      su.uSunDir.value.copy(this._sunDir);
    }

    const tu = this._cloudTopMat?.uniforms;
    if (tu) {
      tu.uTime.value            = this._lastElapsed;
      tu.uCloudTopOpacity.value = p.cloudTopOpacity;
      tu.uAlphaStart.value      = Math.max(0, Math.min(0.99, p.cloudTopAlphaStart ?? 0.2));
      tu.uAlphaEnd.value        = Math.max(tu.uAlphaStart.value + 0.01, Math.min(1.0, p.cloudTopAlphaEnd ?? 0.6));
      tu.uFadeStart.value       = p.cloudTopFadeStart;
      tu.uFadeEnd.value         = p.cloudTopFadeEnd;
      tu.uCloudBrightness.value = p.cloudBrightness;
      tu.uShadingEnabled.value  = p.cloudTopShadingEnabled ? 1 : 0;
      tu.uShadingStrength.value = p.cloudTopShadingStrength;
      tu.uNormalStrength.value  = p.cloudTopNormalStrength;
      tu.uAOIntensity.value     = Number(p.cloudTopAOIntensity) || 0;
      tu.uEdgeHighlight.value   = p.cloudTopEdgeHighlight;
      tu.uPeakDetailEnabled.value  = p.cloudTopPeakDetailEnabled ? 1 : 0;
      tu.uPeakDetailStrength.value = p.cloudTopPeakDetailStrength;
      tu.uPeakDetailScale.value    = p.cloudTopPeakDetailScale;
      tu.uPeakDetailSpeed.value    = p.cloudTopPeakDetailSpeed;
      tu.uPeakDetailStart.value    = p.cloudTopPeakDetailStart;
      tu.uPeakDetailEnd.value      = p.cloudTopPeakDetailEnd;
      tu.uNormalizedZoom.value     = zoom;

      // Boost lateral sun magnitude for cloud-top shading visibility at midday
      this._shadeSunDir.copy(this._sunDir);
      const mag = this._shadeSunDir.length();
      if (mag < 0.6) {
        if (mag < 1e-5) this._shadeSunDir.set(0.6, 0);
        else this._shadeSunDir.multiplyScalar(0.6 / mag);
      }
      tu.uSunDir.value.copy(this._shadeSunDir);

      // Fade outdoors mask when zoomed out in aboveEverything mode
      if (p.cloudTopMode === 'aboveEverything') {
        // Elevated world-space clouds should not be hard-clipped by outdoors masks.
        // Keep masking behavior only for explicit outdoorsOnly mode.
        tu.uOutdoorsMaskStrength.value = 0;
      } else {
        tu.uOutdoorsMaskStrength.value = 1;
      }

      const tint = this._calcTimeOfDayTint();
      if (tint) tu.uTimeOfDayTint.value.copy(tint);

      tu.tFloorIdTex.value    = this._floorIdTex ?? null;
      tu.uHasFloorIdTex.value = this._floorIdTex ? 1 : 0;
      const fw = this._fallbackWhite;
      tu.tOutdoorsMask0.value = this._outdoorsMasks[0] ?? fw ?? null;
      tu.tOutdoorsMask1.value = this._outdoorsMasks[1] ?? fw ?? null;
      tu.tOutdoorsMask2.value = this._outdoorsMasks[2] ?? fw ?? null;
      tu.tOutdoorsMask3.value = this._outdoorsMasks[3] ?? fw ?? null;
      const anyPerFloor = !!(this._outdoorsMasks[0] || this._outdoorsMasks[1] || this._outdoorsMasks[2] || this._outdoorsMasks[3]);
      tu.uHasOutdoorsMask.value = (anyPerFloor || this._outdoorsMask) ? 1 : 0;
      tu.tOutdoorsMask.value = this._outdoorsMask ?? fw ?? null;

      const anyTex = this._outdoorsMasks.find(t => !!t) ?? this._outdoorsMask ?? null;
      tu.uOutdoorsMaskFlipY.value = anyTex?.flipY ? 1.0 : 0.0;
      // Keep view→scene transform in sync so world-anchored mask sampling is correct.
      tu.uViewBoundsMin.value.set(vMinX, vMinY);
      tu.uViewBoundsMax.value.set(vMaxX, vMaxY);
      tu.uSceneOrigin.value.set(sceneX, sceneY);
      tu.uSceneSize.value.set(sceneW, sceneH);
      tu.uSceneDimensions.value.set(
        canvas?.dimensions?.width  ?? sceneW,
        canvas?.dimensions?.height ?? sceneH
      );
    }

    this._updateCloudLayerUniforms(vMinX, vMinY, vMaxX, vMaxY);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  /**
   * Execute all cloud render passes.
   * After this returns:
   *   - `this.cloudShadowTexture` is the shadow factor texture (feed into LightingEffectV2)
   *   - `this.cloudTopTexture`    is the RGBA cloud-top texture (blit after lighting)
   *
   * @param {THREE.WebGLRenderer} renderer
   */
  render(renderer) {
    if (!this._initialized || !this.params.enabled) return;

    renderer.getDrawingBufferSize(this._tempSize);
    const fullW = Math.max(1, this._tempSize.x);
    const fullH = Math.max(1, this._tempSize.y);
    this._ensureRenderTargets(fullW, fullH);

    const prevTarget = renderer.getRenderTarget();

    try {
      const ws = this._getWeatherState();
      if (!ws.weatherEnabled || this._isCoverZero(ws.cloudCover) || this._needsNeutralClear) {
        this._renderNeutral(renderer);
        this._needsNeutralClear = false;
        return;
      }

      const du = this._densityMat.uniforms;
      const su = this._shadowMat.uniforms;

      this._prepareShadowOcclusionMasks(renderer);

      // ── Pass 1a: Overscanned density for shadow offset+blur ──────────
      du.uClipToScene.value   = 0;
      du.uParallaxScale.value = 0;
      du.uCompositeMode.value = 0;

      // Temporarily widen view bounds to the pre-computed overscanned region
      const prevMinX = du.uViewBoundsMin.value.x;
      const prevMinY = du.uViewBoundsMin.value.y;
      const prevMaxX = du.uViewBoundsMax.value.x;
      const prevMaxY = du.uViewBoundsMax.value.y;
      if (su.uDensityBoundsMin) du.uViewBoundsMin.value.copy(su.uDensityBoundsMin.value);
      if (su.uDensityBoundsMax) du.uViewBoundsMax.value.copy(su.uDensityBoundsMax.value);

      this._quad.material = this._densityMat;
      renderer.setRenderTarget(this._shadowDensityRT);
      renderer.setClearColor(0x000000, 1); renderer.clear();
      renderer.render(this._quadScene, this._quadCam);

      // Restore normal view bounds for subsequent passes
      du.uViewBoundsMin.value.set(prevMinX, prevMinY);
      du.uViewBoundsMax.value.set(prevMaxX, prevMaxY);

      // ── Pass 1b: Normal-bounds density (cloud tops + other consumers) ─
      this._quad.material = this._densityMat;
      renderer.setRenderTarget(this._densityRT);
      renderer.setClearColor(0x000000, 1); renderer.clear();
      renderer.render(this._quadScene, this._quadCam);

      // ── Pass 2a: Raw shadow (no outdoors mask, no blocker mask) ─────
      // Used by indoor consumers (e.g. window-light projection) that should
      // still respond to cloud coverage even under overhead blockers.
      {
        const prevHasMask = su.uHasOutdoorsMask.value;
        const prevMaskTex = su.tOutdoorsMask.value;
        const prevHasUpperMask = su.uHasUpperFloorMask.value;
        const prevUpperMaskTex = su.tUpperFloorMask.value;
        su.uDensityMode.value    = 0;
        su.uHasOutdoorsMask.value = 0;
        su.tOutdoorsMask.value   = null;
        su.tCloudDensity.value   = this._shadowDensityRT.texture;
        su.tBlockerMask.value    = this._blockerRT?.texture ?? null;
        su.uHasBlockerMask.value = 0;
        su.tUpperFloorMask.value = this._upperFloorOccluderMask ?? null;
        su.uHasUpperFloorMask.value = 0;
        this._quad.material = this._shadowMat;
        renderer.setRenderTarget(this._shadowRawRT);
        renderer.setClearColor(0xffffff, 1); renderer.clear();
        renderer.render(this._quadScene, this._quadCam);
        su.uHasOutdoorsMask.value = prevHasMask;
        su.tOutdoorsMask.value    = prevMaskTex;
        su.uHasUpperFloorMask.value = prevHasUpperMask;
        su.tUpperFloorMask.value = prevUpperMaskTex;
      }

      // ── Pass 2b: Outdoors-masked shadow (fed into LightingEffectV2) ───
      // Blocker + upper-floor masks remove cloud darkening under roofs / slabs.
      su.uDensityMode.value    = 0;
      su.tCloudDensity.value   = this._shadowDensityRT.texture;
      su.tBlockerMask.value    = this._blockerRT?.texture ?? null;
      su.uHasBlockerMask.value = this._blockerRT ? 1.0 : 0.0;
      {
        const upperTex = this._upperFloorOccluderMask
          ?? (this._upperFloorMaskValid ? (this._upperFloorOccluderRT?.texture ?? null) : null);
        su.tUpperFloorMask.value = upperTex;
        su.uHasUpperFloorMask.value = upperTex ? 1.0 : 0.0;
      }
      this._quad.material = this._shadowMat;
      renderer.setRenderTarget(this._shadowRT);
      renderer.setClearColor(0xffffff, 1); renderer.clear();
      renderer.render(this._quadScene, this._quadCam);

      // ── Pass 3: Parallaxed multi-layer density for cloud tops ─────────
      if (this._topDensityRT) {
        // Keep cloud-top density un-clipped so elevated cloud layers can extend
        // beyond the scene rect with soft edge falloff.
        du.uClipToScene.value   = 0;
        // Cloud-top parallax only. Shadow passes above keep uParallaxScale=0
        // so shadows remain anchored in world space.
        const topParallaxFactor = Math.max(0, Number(this.params.cloudTopParallaxFactor) || 0);
        const depthStrength = Math.max(0, Number(this.params.cloudTopDepthParallaxStrength) || 0);
        for (let i = 0; i < 5; i++) {
          // Foreground layers get more camera-relative drift, background layers less.
          const depthWeight = 1 - (i / 4);
          this._layerTopParallax[i] = Math.max(0, this._layerParallax[i] + (depthStrength * depthWeight));
        }
        du.uLayerParallax.value = this._layerTopParallax;
        du.uParallaxScale.value = topParallaxFactor;
        du.uCompositeMode.value = 1;
        this._quad.material = this._densityMat;
        renderer.setRenderTarget(this._topDensityRT);
        renderer.setClearColor(0x000000, 1); renderer.clear();
        renderer.render(this._quadScene, this._quadCam);
        // Restore canonical layer parallax array for future shadow-oriented passes.
        du.uLayerParallax.value = this._layerParallax;
        this._cloudTopDensityValid = true;
      }

      // ── Pass 4: Cloud-top RGBA ─────────────────────────────────────────
      if (this._cloudTopRT && this._cloudTopMat) {
        const usePacked = this._cloudTopDensityValid && !!this._topDensityRT;
        this._cloudTopMat.uniforms.uDensityMode.value  = usePacked ? 1 : 0;
        this._cloudTopMat.uniforms.tCloudDensity.value = usePacked
          ? this._topDensityRT.texture
          : this._densityRT.texture;
        // Overhead blocker mask is for shadow occlusion only.
        // Applying it to cloud-top alpha punches tile-shaped holes in the cloud layer,
        // which makes underlying post effects/world content show through even at
        // cloudCover=1 and cloudTopOpacity=1.
        this._cloudTopMat.uniforms.tBlockerMask.value    = null;
        this._cloudTopMat.uniforms.uHasBlockerMask.value = 0;
        this._quad.material = this._cloudTopMat;
        renderer.setRenderTarget(this._cloudTopRT);
        renderer.setClearColor(0x000000, 0); renderer.clear();
        renderer.render(this._quadScene, this._quadCam);
      }

    } finally {
      renderer.setRenderTarget(prevTarget);
    }
  }

  /**
   * Render elevated cloud planes into the current post target.
   * Call this after the post chain so clouds sit above grade/water/bloom.
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} outputRT
   */
  blitCloudTops(renderer, outputRT) {
    if (!this._initialized || !this._cloudTopRT || !this._cloudLayerScene || !this._mainCamera) return;
    const ws = this._getWeatherState();
    if (!ws.weatherEnabled || this._isCoverZero(ws.cloudCover)) return;
    if (this.params.cloudTopOpacity <= 0) return;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevLayerMask = this._mainCamera.layers.mask;
    try {
      this._syncCloudLayerTexture();
      this._updateCloudLayerTransforms();
      renderer.setRenderTarget(outputRT);
      renderer.autoClear = false;
      this._mainCamera.layers.enable(0);
      renderer.render(this._cloudLayerScene, this._mainCamera);
    } finally {
      this._mainCamera.layers.mask = prevLayerMask;
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
  }

  // ── Blocker mask ───────────────────────────────────────────────────────────

  /**
   * Populate `_blockerRT` and `_upperFloorOccluderRT` before shadow passes.
   * @param {THREE.WebGLRenderer} renderer
   * @private
   */
  _prepareShadowOcclusionMasks(renderer) {
    this._upperFloorMaskValid = false;
    this._renderBlockerMask(renderer);

    if (!this._upperFloorOccluderRT) return;

    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    const activeIdx = Number(window.MapShine?.floorStack?.getActiveFloor?.()?.index ?? 0);
    const hasUpperFloors = floors.length > 1
      && Number.isFinite(activeIdx)
      && (activeIdx + 1) < floors.length;

    const prevTarget = renderer.getRenderTarget();
    if (!hasUpperFloors) {
      try {
        renderer.setRenderTarget(this._upperFloorOccluderRT);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
      } catch (_) {}
      renderer.setRenderTarget(prevTarget);
      return;
    }

    if (!this._upperFloorMaskBuilder || !this._mainCamera) {
      try {
        renderer.setRenderTarget(this._upperFloorOccluderRT);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
      } catch (_) {}
      renderer.setRenderTarget(prevTarget);
      return;
    }

    try {
      this._upperFloorMaskBuilder(renderer, this._mainCamera, this._upperFloorOccluderRT);
      this._upperFloorMaskValid = true;
    } catch (e) {
      log.warn('CloudEffectV2: upper-floor cloud shadow mask failed:', e);
      try {
        renderer.setRenderTarget(this._upperFloorOccluderRT);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
      } catch (_) {}
    } finally {
      renderer.setRenderTarget(prevTarget);
    }
  }

  /**
   * Render the overhead-tile blocker mask for the current frame.
   *
   * Uses layer-based culling via CLOUD_SHADOW_BLOCKER (layer 23) instead of
   * traversing the full bus scene and toggling visibility per object. Overhead
   * tiles are assigned to this layer in FloorRenderBus._addTileMesh, so the
   * camera only sees blockers — no per-frame full-scene traversal.
   *
   * Floor filtering: only overhead tiles ABOVE the active floor should block
   * cloud shadows. Tiles below active are already hidden by bus visibility.
   * Tiles ON the active floor are visible in the bus but must NOT block, so
   * we temporarily hide them during this pass. This is O(active-floor-overhead)
   * instead of the old O(all-bus-objects) approach.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @private
   */
  _renderBlockerMask(renderer) {
    if (!this._busScene || !this._mainCamera || !this._blockerRT) return;

    const activeFloorIndex = Number(
      window.MapShine?.floorStack?.getActiveFloor?.()?.index ?? 0
    );

    // Temporarily hide overhead tiles ON the active floor — they should not
    // block cloud shadows. Only iterate top-level bus scene children (tiles),
    // not the full scene graph. Much cheaper than the old full traverse.
    const overrideObjs = this._blockerOverrideObjs;
    const overrideVis  = this._blockerOverrideVis;
    let count = 0;
    const children = this._busScene.children;
    for (let i = 0, len = children.length; i < len; i++) {
      const obj = children[i];
      if (!obj.visible) continue;
      const ud = obj.userData;
      if (!ud?.isOverhead) continue;
      // Only hide overhead tiles on the active floor. Above-active tiles
      // should block; below-active tiles are already hidden by bus visibility.
      if (Number(ud.floorIndex) !== activeFloorIndex) continue;
      if (count >= overrideObjs.length) {
        overrideObjs.push(null);
        overrideVis.push(false);
      }
      overrideObjs[count] = obj;
      overrideVis[count]  = true;
      obj.visible = false;
      count++;
    }
    this._blockerOverrideCount = count;

    const prevTarget    = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevLayerMask = this._mainCamera.layers.mask;
    try {
      // Render ONLY objects on the CLOUD_SHADOW_BLOCKER layer (23).
      // Overhead tiles are assigned to this layer at creation time in the bus.
      this._mainCamera.layers.set(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
      renderer.setRenderTarget(this._blockerRT);
      renderer.autoClear = true;
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this._busScene, this._mainCamera);
    } finally {
      // Restore active-floor overhead tile visibility
      for (let i = 0; i < count; i++) overrideObjs[i].visible = overrideVis[i];
      this._mainCamera.layers.mask = prevLayerMask;
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
  }

  // ── Neutral clear (no clouds) ──────────────────────────────────────────────

  /** @private */
  _renderNeutral(renderer) {
    const rt = (target, r, g, b, a) => {
      renderer.setRenderTarget(target);
      renderer.setClearColor(r * 0xffffff | 0, a);
      renderer.clear();
    };
    // Shadow = white (fully lit), density/tops = black transparent
    if (this._shadowRT)        { renderer.setRenderTarget(this._shadowRT);    renderer.setClearColor(0xffffff, 1); renderer.clear(); }
    if (this._shadowRawRT)     { renderer.setRenderTarget(this._shadowRawRT); renderer.setClearColor(0xffffff, 1); renderer.clear(); }
    if (this._densityRT)       { renderer.setRenderTarget(this._densityRT);   renderer.setClearColor(0x000000, 1); renderer.clear(); }
    if (this._shadowDensityRT) { renderer.setRenderTarget(this._shadowDensityRT); renderer.setClearColor(0x000000, 1); renderer.clear(); }
    if (this._topDensityRT)    { renderer.setRenderTarget(this._topDensityRT); renderer.setClearColor(0x000000, 1); renderer.clear(); }
    if (this._cloudTopRT)      { renderer.setRenderTarget(this._cloudTopRT);  renderer.setClearColor(0x000000, 0); renderer.clear(); }
    if (this._upperFloorOccluderRT) {
      renderer.setRenderTarget(this._upperFloorOccluderRT);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
    }
    void rt; // suppress unused warning
  }

  // ── Render target management ───────────────────────────────────────────────

  /** @private */
  _ensureRenderTargets(fullW, fullH) {
    const THREE = window.THREE;
    if (!THREE) return;

    const scale = Math.max(0.1, Math.min(1.0, this.params.internalResolutionScale ?? 0.5));
    const iW = Math.max(1, Math.round(fullW * scale));
    const iH = Math.max(1, Math.round(fullH * scale));

    if (iW === this._lastInternalW && iH === this._lastInternalH &&
        fullW === this._lastFullW   && fullH === this._lastFullH) return;

    this._lastFullW = fullW; this._lastFullH = fullH;
    this._lastInternalW = iW; this._lastInternalH = iH;

    const opts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
    };
    const make = (existing) => {
      if (existing) { existing.setSize(iW, iH); return existing; }
      return new THREE.WebGLRenderTarget(iW, iH, { ...opts });
    };
    this._shadowDensityRT = make(this._shadowDensityRT);
    this._densityRT       = make(this._densityRT);
    this._topDensityRT    = make(this._topDensityRT);
    this._shadowRT        = make(this._shadowRT);
    this._shadowRawRT     = make(this._shadowRawRT);
    this._cloudTopRT      = make(this._cloudTopRT);
    this._blockerRT       = make(this._blockerRT);
    this._upperFloorOccluderRT = make(this._upperFloorOccluderRT);
    this._cloudTopDensityValid = false;

    // Update texel-size uniforms
    if (this._shadowMat?.uniforms?.uTexelSize)   this._shadowMat.uniforms.uTexelSize.value.set(1 / iW, 1 / iH);
    if (this._cloudTopMat?.uniforms?.uTexelSize) this._cloudTopMat.uniforms.uTexelSize.value.set(1 / iW, 1 / iH);
    if (this._densityMat?.uniforms?.uResolution) this._densityMat.uniforms.uResolution.value.set(iW, iH);
  }

  onResize(w, h) { this._ensureRenderTargets(Math.max(1, w), Math.max(1, h)); }

  onFloorChange() { /* bus visibility is handled by FloorRenderBus; no extra work needed */ }

  // ── Static schema (mirrors V1 CloudEffect.getControlSchema exactly) ───────

  /**
   * Tweakpane control schema for CloudEffectV2.
   * Param names are identical to V1 CloudEffect so the same UI registration
   * code and _propagateToV2 mirroring can drive both systems.
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        { name: 'cloud-generation',  label: 'Cloud Generation',       type: 'inline', parameters: ['noiseScale', 'noiseDetail', 'cloudSharpness', 'noiseTimeSpeed'] },
        { name: 'domain-warping',    label: 'Domain Warping (Wisps)', type: 'inline', separator: false, parameters: ['domainWarpEnabled', 'domainWarpStrength', 'domainWarpScale', 'domainWarpSpeed', 'domainWarpTimeOffsetY'] },
        { name: 'shadow-settings',   label: 'Cloud Shadows',          type: 'inline', separator: true,  parameters: ['shadowOpacity', 'shadowSoftness', 'shadowOffsetScale', 'minShadowBrightness', 'shadowSceneFadeSoftness'] },
        { name: 'cloud-tops',        label: 'Cloud Tops (Zoom)',      type: 'inline', separator: true,  parameters: ['cloudTopMode', 'cloudTopOpacity', 'cloudTopAlphaStart', 'cloudTopAlphaEnd', 'cloudTopParallaxFactor', 'cloudTopDepthParallaxStrength', 'cloudTopFadeStart', 'cloudTopFadeEnd', 'cloudBrightness'] },
        { name: 'cloud-layer-space', label: 'Cloud Layer Space',      type: 'inline', separator: false, parameters: ['cloudLayerCount', 'cloudLayerCoverageScale', 'cloudLayerDepthScaleStep', 'cloudLayerHeightFromGround', 'cloudLayer1HeightFromGround', 'cloudLayer2HeightFromGround', 'cloudLayer3HeightFromGround', 'cloudLayerZSpacing', 'cloudLayerBaseOffsetFromEmitter', 'cloudLayerEdgeSoftness'] },
        { name: 'cloud-layer-look',  label: 'Cloud Layer Look',       type: 'inline', separator: false, parameters: ['cloudLayerOpacityBase', 'cloudLayerOpacityFalloff', 'cloudLayerUvScaleStep', 'cloudLayerDriftStrength', 'cloudLayerDriftDepthBoost'] },
        { name: 'cloud-layer-slices',label: 'Cloud Layer 3D Slices',  type: 'inline', separator: false, parameters: ['cloudLayerSliceStrength', 'cloudLayerSliceScale', 'cloudLayerSliceContrast', 'cloudLayerSliceSpeed', 'cloudLayerSliceSpacing'] },
        { name: 'cloud-top-shading', label: 'Cloud Top Shading',      type: 'inline', separator: false, parameters: ['cloudTopShadingEnabled', 'cloudTopShadingStrength', 'cloudTopNormalStrength', 'cloudTopAOIntensity', 'cloudTopEdgeHighlight'] },
        { name: 'cloud-top-peaks',   label: 'Cloud Top Peaks',        type: 'inline', separator: false, parameters: ['cloudTopPeakDetailEnabled', 'cloudTopPeakDetailStrength', 'cloudTopPeakDetailScale', 'cloudTopPeakDetailSpeed', 'cloudTopPeakDetailStart', 'cloudTopPeakDetailEnd'] },
        { name: 'cloud-top-composite', label: 'Cloud Top Composite',  type: 'inline', separator: false, parameters: ['cloudTopSoftKnee'] },
        { name: 'wind',              label: 'Wind & Drift',           type: 'inline', separator: true,  parameters: ['windInfluence', 'driftSpeed', 'minDriftSpeed', 'driftResponsiveness', 'driftMaxSpeed'] },
        { name: 'layer-base',        label: 'Cloud Layers (Base)',    type: 'inline', separator: true,  parameters: ['layerParallaxBase'] },
        { name: 'layer-1', label: 'Layer 1', type: 'folder', expanded: false, separator: false, parameters: ['layer1Enabled', 'layer1Opacity', 'layer1Scale', 'layer1Coverage', 'layer1ParallaxMult', 'layer1SpeedMult', 'layer1DirDeg'] },
        { name: 'layer-2', label: 'Layer 2', type: 'folder', expanded: false, separator: false, parameters: ['layer2Enabled', 'layer2Opacity', 'layer2Scale', 'layer2Coverage', 'layer2ParallaxMult', 'layer2SpeedMult', 'layer2DirDeg'] },
        { name: 'layer-3', label: 'Layer 3 (Main)', type: 'folder', expanded: false, separator: false, parameters: ['layer3Enabled', 'layer3Opacity', 'layer3Scale', 'layer3Coverage', 'layer3ParallaxMult', 'layer3SpeedMult', 'layer3DirDeg'] },
        { name: 'layer-4', label: 'Layer 4', type: 'folder', expanded: false, separator: false, parameters: ['layer4Enabled', 'layer4Opacity', 'layer4Scale', 'layer4Coverage', 'layer4ParallaxMult', 'layer4SpeedMult', 'layer4DirDeg'] },
        { name: 'layer-5', label: 'Layer 5', type: 'folder', expanded: false, separator: false, parameters: ['layer5Enabled', 'layer5Opacity', 'layer5Scale', 'layer5Coverage', 'layer5ParallaxMult', 'layer5SpeedMult', 'layer5DirDeg'] },
      ],
      parameters: {
        noiseScale:           { type: 'slider', label: 'Cloud Scale',       min: 0.05, max: 8.0,  step: 0.05,  default: 0.5   },
        noiseDetail:          { type: 'slider', label: 'Detail (Octaves)',   min: 1,    max: 6,    step: 1,     default: 4     },
        cloudSharpness:       { type: 'slider', label: 'Edge Sharpness',    min: 0.0,  max: 1.0,  step: 0.01,  default: 0.0   },
        noiseTimeSpeed:       { type: 'slider', label: 'Internal Motion',   min: 0.0,  max: 0.05, step: 0.001, default: 0.011 },
        domainWarpEnabled:    { type: 'boolean',label: 'Enabled',                                              default: true  },
        domainWarpStrength:   { type: 'slider', label: 'Strength',          min: 0.0,  max: 0.5,  step: 0.005, default: 0.005 },
        domainWarpScale:      { type: 'slider', label: 'Warp Scale',        min: 0.25, max: 10.0, step: 0.05,  default: 1.05  },
        domainWarpSpeed:      { type: 'slider', label: 'Warp Speed',        min: 0.0,  max: 0.5,  step: 0.005, default: 0.115 },
        domainWarpTimeOffsetY:{ type: 'slider', label: 'Y Offset',          min: 0.0,  max: 10.0, step: 0.1,   default: 10.0  },
        shadowOpacity:        { type: 'slider', label: 'Shadow Darkness',   min: 0.0,  max: 1.0,  step: 0.01,  default: 0.7   },
        shadowSoftness:       { type: 'slider', label: 'Shadow Softness',   min: 0.5,  max: 10.0, step: 0.1,   default: 0.9   },
        shadowOffsetScale:    { type: 'slider', label: 'Shadow Offset',     min: 0.0,  max: 0.3,  step: 0.01,  default: 0.3   },
        minShadowBrightness:  { type: 'slider', label: 'Min Brightness',    min: 0.0,  max: 0.5,  step: 0.01,  default: 0.0   },
        shadowSceneFadeSoftness:{ type: 'slider', label: 'Scene Edge Fade',   min: 0.0,  max: 0.15, step: 0.005, default: 0.025 },
        cloudTopMode:         { type: 'list',   label: 'Cloud Top Mode',    options: { 'Outdoors Only': 'outdoorsOnly', 'Above Everything (Fade Mask)': 'aboveEverything' }, default: 'aboveEverything' },
        cloudTopOpacity:      { type: 'slider', label: 'Cloud Top Opacity', min: 0.0,  max: 1.0,  step: 0.01,  default: 1.0   },
        cloudTopAlphaStart:   { type: 'slider', label: 'Edge Fade Start',    min: 0.0,  max: 0.8,  step: 0.01,  default: 0.2   },
        cloudTopAlphaEnd:     { type: 'slider', label: 'Edge Fade End',      min: 0.05, max: 1.0,  step: 0.01,  default: 0.6   },
        cloudTopParallaxFactor:{ type: 'slider',label: 'Top Parallax',      min: 0.0,  max: 2.0,  step: 0.05,  default: 1.0   },
        cloudTopDepthParallaxStrength:{ type: 'slider',label: 'Depth Parallax', min: 0.0, max: 2.0, step: 0.05, default: 0.6 },
        cloudTopFadeStart:    { type: 'slider', label: 'Fade Start Zoom',   min: 0.1,  max: 1.0,  step: 0.01,  default: 0.24  },
        cloudTopFadeEnd:      { type: 'slider', label: 'Fade End Zoom',     min: 0.1,  max: 1.0,  step: 0.01,  default: 0.39  },
        cloudLayerCount:      { type: 'slider', label: 'Layer Count (Fixed)', min: 3,   max: 3,    step: 1,     default: 3     },
        cloudLayerCoverageScale:{ type: 'slider', label: 'Coverage Scale',   min: 1.0,  max: 8.0,  step: 0.05,  default: 3.0   },
        cloudLayerDepthScaleStep:{ type: 'slider', label: 'Depth Scale Step',min: 0.0,  max: 0.6,  step: 0.01,  default: 0.18  },
        cloudLayerHeightFromGround:{ type: 'slider', label: 'Base Cloud Height (From Ground)', min: -2000.0, max: 300.0, step: 1.0, default: 200.0 },
        cloudLayer1HeightFromGround:{ type: 'slider', label: 'Layer 1 Height (From Ground)', min: 0.0, max: 12000.0, step: 10.0, default: 0.0 },
        cloudLayer2HeightFromGround:{ type: 'slider', label: 'Layer 2 Height (From Ground)', min: 0.0, max: 12000.0, step: 10.0, default: 150.0 },
        cloudLayer3HeightFromGround:{ type: 'slider', label: 'Layer 3 Height (From Ground)', min: 0.0, max: 12000.0, step: 10.0, default: 300.0 },
        cloudLayerZSpacing:   { type: 'slider', label: 'Duplicate Layer Up/Down Offset',   min: 20.0, max: 1200.0,step: 5.0,  default: 220.0 },
        cloudLayerBaseOffsetFromEmitter:{ type: 'slider', label: 'Legacy Emitter Offset', min: -5000.0, max: 2000.0, step: 10.0, default: -2200.0 },
        cloudLayerEdgeSoftness:{ type: 'slider', label: 'Edge Softness',     min: 0.01, max: 0.5,  step: 0.01,  default: 0.12  },
        cloudLayerOpacityBase:{ type: 'slider', label: 'Base Layer Opacity', min: 0.1,  max: 1.5,  step: 0.01,  default: 0.75  },
        cloudLayerOpacityFalloff:{ type: 'slider', label: 'Opacity Falloff', min: 0.0,  max: 1.0,  step: 0.01,  default: 0.35  },
        cloudLayerUvScaleStep:{ type: 'slider', label: 'UV Scale Step',      min: 0.0,  max: 1.0,  step: 0.01,  default: 0.25  },
        cloudLayerDriftStrength:{ type: 'slider', label: 'Drift Strength',   min: 0.0,  max: 0.2,  step: 0.001, default: 0.02  },
        cloudLayerDriftDepthBoost:{ type: 'slider', label: 'Depth Drift Boost', min: 0.0, max: 0.2, step: 0.001, default: 0.015 },
        cloudLayerSliceStrength:{ type: 'slider', label: '3D Slice Strength', min: 0.0, max: 1.0,  step: 0.01,  default: 0.7   },
        cloudLayerSliceScale: { type: 'slider', label: '3D Slice Scale',     min: 0.2,  max: 8.0,  step: 0.05,  default: 2.2   },
        cloudLayerSliceContrast:{ type: 'slider', label: '3D Slice Contrast',min: 0.5,  max: 3.0,  step: 0.01,  default: 1.3   },
        cloudLayerSliceSpeed: { type: 'slider', label: '3D Slice Speed',     min: 0.0,  max: 0.2,  step: 0.001, default: 0.015 },
        cloudLayerSliceSpacing:{ type: 'slider', label: '3D Slice Spacing',  min: 0.0,  max: 8.0,  step: 0.05,  default: 2.0   },
        cloudBrightness:      { type: 'slider', label: 'Cloud Brightness',  min: 0.8,  max: 1.5,  step: 0.01,  default: 1.01  },
        cloudTopShadingEnabled:    { type: 'boolean', label: 'Shading Enabled',   default: true  },
        cloudTopShadingStrength:   { type: 'slider',  label: 'Shading Strength',  min: 0.0, max: 1.0, step: 0.01, default: 0.99 },
        cloudTopNormalStrength:    { type: 'slider',  label: 'Normal Strength',   min: 0.0, max: 2.0, step: 0.01, default: 0.96 },
        cloudTopAOIntensity:       { type: 'slider',  label: 'AO Intensity',      min: 0.0, max: 5.0, step: 0.1,  default: 2.0  },
        cloudTopEdgeHighlight:     { type: 'slider',  label: 'Edge Highlight',    min: 0.0, max: 1.0, step: 0.01, default: 0.0  },
        cloudTopPeakDetailEnabled: { type: 'boolean', label: 'Peak Detail',       default: false },
        cloudTopPeakDetailStrength:{ type: 'slider',  label: 'Peak Strength',     min: 0.0, max: 1.0, step: 0.01, default: 0.32 },
        cloudTopPeakDetailScale:   { type: 'slider',  label: 'Peak Scale',        min: 10,  max: 200, step: 1,    default: 92.5 },
        cloudTopPeakDetailSpeed:   { type: 'slider',  label: 'Peak Speed',        min: 0.0, max: 0.5, step: 0.01, default: 0.08 },
        cloudTopPeakDetailStart:   { type: 'slider',  label: 'Peak Start',        min: 0.0, max: 1.0, step: 0.01, default: 0.14 },
        cloudTopPeakDetailEnd:     { type: 'slider',  label: 'Peak End',          min: 0.0, max: 1.0, step: 0.01, default: 0.82 },
        cloudTopSoftKnee:     { type: 'slider', label: 'Composite Soft Knee', min: 0.0, max: 5.0, step: 0.1,   default: 1.8   },
        windInfluence:        { type: 'slider', label: 'Wind Influence',    min: 0.0,  max: 2.0,  step: 0.01,  default: 1.33  },
        driftSpeed:           { type: 'slider', label: 'Drift Speed',       min: 0.0,  max: 0.1,  step: 0.001, default: 0.01  },
        minDriftSpeed:        { type: 'slider', label: 'Min Drift Speed',   min: 0.0,  max: 0.05, step: 0.001, default: 0.002 },
        driftResponsiveness:  { type: 'slider', label: 'Responsiveness',    min: 0.0,  max: 1.0,  step: 0.01,  default: 0.4   },
        driftMaxSpeed:        { type: 'slider', label: 'Max Speed',         min: 0.0,  max: 2.0,  step: 0.01,  default: 0.5   },
        layerParallaxBase:    { type: 'slider', label: 'Parallax Base',     min: 0.0,  max: 3.0,  step: 0.1,   default: 1.0   },
        layer1Enabled:  { type: 'boolean', label: 'Enabled', default: true  }, layer1Opacity:  { type: 'slider', label: 'Opacity',   min: 0, max: 1, step: 0.01, default: 0.35 }, layer1Coverage: { type: 'slider', label: 'Coverage',  min: 0, max: 1, step: 0.01, default: 0.33 }, layer1Scale:    { type: 'slider', label: 'Scale',     min: 0.5, max: 5, step: 0.05, default: 1.34 }, layer1ParallaxMult: { type: 'slider', label: 'Parallax', min: 0, max: 2, step: 0.05, default: 1.00 }, layer1SpeedMult: { type: 'slider', label: 'Speed',    min: 0, max: 3, step: 0.01, default: 0.99 }, layer1DirDeg: { type: 'slider', label: 'Direction°', min: -180, max: 180, step: 0.1, default: -1.7 },
        layer2Enabled:  { type: 'boolean', label: 'Enabled', default: true  }, layer2Opacity:  { type: 'slider', label: 'Opacity',   min: 0, max: 1, step: 0.01, default: 0.70 }, layer2Coverage: { type: 'slider', label: 'Coverage',  min: 0, max: 1, step: 0.01, default: 0.57 }, layer2Scale:    { type: 'slider', label: 'Scale',     min: 0.5, max: 5, step: 0.05, default: 1.22 }, layer2ParallaxMult: { type: 'slider', label: 'Parallax', min: 0, max: 2, step: 0.05, default: 0.82 }, layer2SpeedMult: { type: 'slider', label: 'Speed',    min: 0, max: 3, step: 0.01, default: 1.07 }, layer2DirDeg: { type: 'slider', label: 'Direction°', min: -180, max: 180, step: 0.1, default: -0.86 },
        layer3Enabled:  { type: 'boolean', label: 'Enabled', default: true  }, layer3Opacity:  { type: 'slider', label: 'Opacity',   min: 0, max: 1, step: 0.01, default: 0.19 }, layer3Coverage: { type: 'slider', label: 'Coverage',  min: 0, max: 1, step: 0.01, default: 0.90 }, layer3Scale:    { type: 'slider', label: 'Scale',     min: 0.5, max: 5, step: 0.05, default: 3.00 }, layer3ParallaxMult: { type: 'slider', label: 'Parallax', min: 0, max: 2, step: 0.05, default: 0.64 }, layer3SpeedMult: { type: 'slider', label: 'Speed',    min: 0, max: 3, step: 0.01, default: 0.94 }, layer3DirDeg: { type: 'slider', label: 'Direction°', min: -180, max: 180, step: 0.1, default: 0.0 },
        layer4Enabled:  { type: 'boolean', label: 'Enabled', default: true  }, layer4Opacity:  { type: 'slider', label: 'Opacity',   min: 0, max: 1, step: 0.01, default: 0.17 }, layer4Coverage: { type: 'slider', label: 'Coverage',  min: 0, max: 1, step: 0.01, default: 0.46 }, layer4Scale:    { type: 'slider', label: 'Scale',     min: 0.5, max: 5, step: 0.05, default: 1.72 }, layer4ParallaxMult: { type: 'slider', label: 'Parallax', min: 0, max: 2, step: 0.05, default: 0.46 }, layer4SpeedMult: { type: 'slider', label: 'Speed',    min: 0, max: 3, step: 0.01, default: 0.94 }, layer4DirDeg: { type: 'slider', label: 'Direction°', min: -180, max: 180, step: 0.1, default: 0.86 },
        layer5Enabled:  { type: 'boolean', label: 'Enabled', default: true  }, layer5Opacity:  { type: 'slider', label: 'Opacity',   min: 0, max: 1, step: 0.01, default: 0.13 }, layer5Coverage: { type: 'slider', label: 'Coverage',  min: 0, max: 1, step: 0.01, default: 0.62 }, layer5Scale:    { type: 'slider', label: 'Scale',     min: 0.5, max: 5, step: 0.05, default: 1.52 }, layer5ParallaxMult: { type: 'slider', label: 'Parallax', min: 0, max: 2, step: 0.05, default: 0.28 }, layer5SpeedMult: { type: 'slider', label: 'Speed',    min: 0, max: 3, step: 0.01, default: 1.07 }, layer5DirDeg: { type: 'slider', label: 'Direction°', min: -180, max: 180, step: 0.1, default: -0.6 },
      },
    };
  }

  // ── Accessors (used by FloorCompositor / LightingEffectV2) ────────────────

  /** @type {THREE.Texture|null} Shadow factor texture — bind into LightingEffectV2 */
  get cloudShadowTexture() { return this._shadowRT?.texture ?? null; }

  /** @type {THREE.Texture|null} Raw shadow (no outdoors mask) — for indoor consumers */
  get cloudShadowRawTexture() { return this._shadowRawRT?.texture ?? null; }

  /**
   * Current world-space bounds used when rendering the shadow pass.
   * Consumers sampling cloud shadow textures in world space must use these
   * exact bounds for stable pan/zoom mapping.
   * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null}
   */
  get cloudShadowViewBounds() {
    const u = this._shadowMat?.uniforms;
    if (!u?.uViewBoundsMin?.value || !u?.uViewBoundsMax?.value) return null;
    return {
      minX: Number(u.uViewBoundsMin.value.x) || 0,
      minY: Number(u.uViewBoundsMin.value.y) || 0,
      maxX: Number(u.uViewBoundsMax.value.x) || 0,
      maxY: Number(u.uViewBoundsMax.value.y) || 0,
    };
  }

  /** @type {THREE.Texture|null} Cloud density — for other consumers */
  get cloudDensityTexture() { return this._densityRT?.texture ?? null; }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** @private */
  _getWeatherState() {
    // Default to params.cloudCover so V2 mode (where WeatherController is not
    // initialized and currentState.cloudCover stays at 0) still renders clouds.
    // Mirrors V1 CloudEffect._getEffectiveWeatherState() which uses the same fallback.
    let cloudCover = this.params.cloudCover ?? 0.5;
    let windSpeed  = 0.07;
    let windDirX   = 1.0;
    let windDirY   = 0.0;
    try {
      if (weatherController) {
        const s = (typeof weatherController.getCurrentState === 'function')
          ? weatherController.getCurrentState()
          : weatherController.currentState;
        // Only read WeatherController state when it has actually been initialized
        // (weatherController.initialize() was awaited). In V2 mode that call is
        // skipped, so initialized===false and currentState is at constructor
        // defaults (cloudCover=0). Overriding params.cloudCover with that 0
        // would suppress all clouds and shadows in V2.
        const wcInitialized = weatherController.initialized === true;
        if (s && wcInitialized) {
          if (typeof s.cloudCover === 'number') {
            // When WeatherController is initialized, weather cloud cover is the
            // authoritative runtime source. This ensures Weather Cloud Cover = 0
            // truly clears clouds instead of being clamped by the local fallback.
            cloudCover = s.cloudCover;
          }
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

    const normalized = Math.max(0, Math.min(1, Number(cloudCover) || 0));
    return {
      // Mirror V1 semantics: weather can be disabled globally.
      weatherEnabled: !(weatherController && weatherController.enabled === false) && this.enabled,
      cloudCover: normalized,
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
  _calcSunDir() {
    // Keep cloud sun direction in lockstep with other V2 effects so shadow/light
    // motion does not appear mirrored on one axis relative to trees/buildings.
    let x = 0.0;
    let y = -1.0;

    const sky = window.MapShine?.effectComposer?._floorCompositorV2?._skyColorEffect;
    const overhead = window.MapShine?.effectComposer?._floorCompositorV2?._overheadShadowEffect;
    const latitude = Number(overhead?.params?.sunLatitude ?? 0.3);
    const lat = Math.max(0.0, Math.min(1.0, latitude));

    if (Number.isFinite(Number(sky?.currentSunAzimuthDeg))) {
      const azimuthRad = Number(sky.currentSunAzimuthDeg) * (Math.PI / 180.0);
      x = -Math.sin(azimuthRad);
      y = -Math.cos(azimuthRad) * lat;
    } else {
      let hour = 12.0;
      try {
        if (weatherController && typeof weatherController.timeOfDay === 'number') {
          hour = weatherController.timeOfDay;
        }
      } catch (_) {}
      const t = ((hour % 24.0) + 24.0) % 24.0 / 24.0;
      const azimuth = (t - 0.5) * Math.PI;
      x = -Math.sin(azimuth);
      y = -Math.cos(azimuth) * lat;
    }

    this._sunDir.set(x, y);
  }

  /** @private */
  _calcTimeOfDayTint() {
    if (!this._tintResult) return null;
    let hour = 12;
    try { if (typeof weatherController?.timeOfDay === 'number') hour = weatherController.timeOfDay; } catch (_) {}
    hour = ((hour % 24) + 24) % 24;
    const t = this._tintResult;
    if      (hour < 5)  t.copy(this._tintNight);
    else if (hour < 6)  t.lerpVectors(this._tintNight,   this._tintSunrise, hour - 5);
    else if (hour < 7)  t.lerpVectors(this._tintSunrise, this._tintDay,     hour - 6);
    else if (hour < 17) t.copy(this._tintDay);
    else if (hour < 18) t.lerpVectors(this._tintDay,     this._tintSunset,  hour - 17);
    else if (hour < 19) t.lerpVectors(this._tintSunset,  this._tintNight,   hour - 18);
    else                t.copy(this._tintNight);
    return t;
  }

  // ── Shader material factories ──────────────────────────────────────────────

  /** @private */
  _createDensityMaterial() {
    const THREE = window.THREE;
    this._densityMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:                 { value: 0 },
        uCloudCover:           { value: 0.5 },
        uNoiseScale:           { value: 0.5 },
        uNoiseDetail:          { value: 4 },
        uCloudSharpness:       { value: 0 },
        uNoiseTimeSpeed:       { value: 0.011 },
        uDomainWarpEnabled:    { value: 1 },
        uDomainWarpStrength:   { value: 0.005 },
        uDomainWarpScale:      { value: 1.05 },
        uDomainWarpSpeed:      { value: 0.115 },
        uDomainWarpTimeOffsetY:{ value: 10 },
        uParallaxScale:        { value: 0 },
        uCompositeMode:        { value: 0 },
        uCompositeSoftKnee:    { value: 1.8 },
        uClipToScene:          { value: 0 },
        uResolution:           { value: new THREE.Vector2(1, 1) },
        uSceneOrigin:          { value: new THREE.Vector2(0, 0) },
        uSceneSize:            { value: new THREE.Vector2(4000, 3000) },
        uViewBoundsMin:        { value: new THREE.Vector2(0, 0) },
        uViewBoundsMax:        { value: new THREE.Vector2(4000, 3000) },
        // vec2[5] uploaded as flat Float32Array
        uLayerWindOffsets:     { value: new Float32Array(10) },
        uLayerParallax:        { value: new Float32Array(5) },
        uLayerCoverMult:       { value: new Float32Array(5) },
        uLayerNoiseScaleMult:  { value: new Float32Array(5) },
        uLayerWeight:          { value: new Float32Array(5) },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */`
        uniform float uTime;
        uniform float uCloudCover;
        uniform float uNoiseScale;
        uniform float uNoiseDetail;
        uniform float uCloudSharpness;
        uniform float uNoiseTimeSpeed;
        uniform float uDomainWarpEnabled;
        uniform float uDomainWarpStrength;
        uniform float uDomainWarpScale;
        uniform float uDomainWarpSpeed;
        uniform float uDomainWarpTimeOffsetY;
        uniform float uParallaxScale;
        uniform float uCompositeMode;
        uniform float uCompositeSoftKnee;
        uniform float uClipToScene;
        uniform vec2  uResolution;
        uniform vec2  uSceneOrigin;
        uniform vec2  uSceneSize;
        uniform vec2  uViewBoundsMin;
        uniform vec2  uViewBoundsMax;
        uniform vec2  uLayerWindOffsets[5];
        uniform float uLayerParallax[5];
        uniform float uLayerCoverMult[5];
        uniform float uLayerNoiseScaleMult[5];
        uniform float uLayerWeight[5];
        varying vec2 vUv;

        // Simplex 2D noise
        vec3 permute(vec3 x) { return mod(((x*34.0)+1.0)*x,289.0); }
        float snoise(vec2 v) {
          const vec4 C = vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);
          vec2 i = floor(v + dot(v,C.yy));
          vec2 x0 = v - i + dot(i,C.xx);
          vec2 i1 = (x0.x > x0.y) ? vec2(1.0,0.0) : vec2(0.0,1.0);
          vec4 x12 = x0.xyxy + C.xxzz; x12.xy -= i1;
          i = mod(i,289.0);
          vec3 p = permute(permute(i.y+vec3(0.0,i1.y,1.0))+i.x+vec3(0.0,i1.x,1.0));
          vec3 m = max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0);
          m=m*m; m=m*m;
          vec3 x=2.0*fract(p*C.www)-1.0;
          vec3 h=abs(x)-0.5;
          vec3 ox=floor(x+0.5); vec3 a0=x-ox;
          m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);
          vec3 g; g.x=a0.x*x0.x+h.x*x0.y; g.yz=a0.yz*x12.xz+h.yz*x12.yw;
          return 130.0*dot(m,g);
        }
        float fbm(vec2 p, int octaves) {
          float v=0.0,a=0.5,f=1.0,mv=0.0;
          for(int i=0;i<6;i++){
            if(i>=octaves) break;
            v+=a*snoise(p*f); mv+=a; a*=0.5; f*=2.0;
          }
          return v/mv;
        }
        float sampleLayer(vec2 baseWorld, vec2 camPinned, int li, int octaves) {
          float par = uLayerParallax[li] * uParallaxScale;
          vec2 lp = mix(baseWorld, camPinned, par);
          float w = max(uSceneSize.x,1.0); float h = max(uSceneSize.y,1.0); float s=min(w,h);
          vec2 aspect = vec2(w/s,h/s);
          vec2 uv = ((lp - uSceneOrigin) / uSceneSize) * aspect;
          uv += uLayerWindOffsets[li] * aspect;
          float t = uTime * uDomainWarpSpeed;
          vec2 warpUV = uv * uDomainWarpScale;
          vec2 warp = vec2(snoise(warpUV+vec2(t,0.0)),snoise(warpUV+vec2(0.0,t+uDomainWarpTimeOffsetY)));
          warp *= step(0.5,uDomainWarpEnabled) * uDomainWarpStrength;
          vec2 noiseUV = uv * (uNoiseScale * uLayerNoiseScaleMult[li]) + warp;
          float noise = fbm(noiseUV*4.0+vec2(uTime*uNoiseTimeSpeed),octaves)*0.5+0.5;
          float cover = clamp(uCloudCover*uLayerCoverMult[li],0.0,1.0);
          float thr = 1.0-cover;
          float cloud = smoothstep(thr-0.1,thr+0.1,noise);
          cloud = mix(cloud,step(thr,noise),uCloudSharpness);
          return clamp(cloud*uLayerWeight[li],0.0,1.0);
        }
        void main() {
          vec2 viewSize = uViewBoundsMax - uViewBoundsMin;
          vec2 baseWorld = mix(uViewBoundsMin, uViewBoundsMax, vUv);
          if (uClipToScene > 0.5) {
            vec2 sMax = uSceneOrigin + uSceneSize;
            if (baseWorld.x < uSceneOrigin.x || baseWorld.y < uSceneOrigin.y ||
                baseWorld.x > sMax.x         || baseWorld.y > sMax.y) {
              gl_FragColor = vec4(0.0); return;
            }
          }
          vec2 camPinned = (uSceneOrigin+0.5*uSceneSize)+(vUv-0.5)*viewSize;
          int octaves = int(uNoiseDetail);
          float l0=sampleLayer(baseWorld,camPinned,0,octaves);
          float l1=sampleLayer(baseWorld,camPinned,1,octaves);
          float l2=sampleLayer(baseWorld,camPinned,2,octaves);
          float l3=sampleLayer(baseWorld,camPinned,3,octaves);
          float l4=sampleLayer(baseWorld,camPinned,4,octaves);
          if (uCompositeMode < 0.5) {
            // Union blend (shadow mode)
            float inv=(1.0-l0)*(1.0-l1)*(1.0-l2)*(1.0-l3)*(1.0-l4);
            float c=clamp(1.0-inv,0.0,1.0);
            gl_FragColor=vec4(c,c,c,1.0);
          } else {
            // Packed mode (cloud-top): R=mid, G=inner, B=outer, A=composite
            float x=(l0+l1+l2+l3+l4)/2.0;
            float k=max(0.0,uCompositeSoftKnee);
            float c= k>1e-5 ? clamp(1.0-exp(-k*max(0.0,x)),0.0,1.0) : clamp(x,0.0,1.0);
            gl_FragColor=vec4(l2,max(l1,l3),max(l0,l4),c);
          }
        }
      `,
      depthWrite: false, depthTest: false,
    });
    this._densityMat.toneMapped = false;
  }

  /** @private */
  _createShadowMaterial() {
    const THREE = window.THREE;
    this._shadowMat = new THREE.ShaderMaterial({
      uniforms: {
        tCloudDensity:      { value: null },
        uDensityMode:       { value: 0 },
        tFloorIdTex:        { value: null },
        uHasFloorIdTex:     { value: 0 },
        tOutdoorsMask:      { value: null },
        tOutdoorsMask0:     { value: null },
        tOutdoorsMask1:     { value: null },
        tOutdoorsMask2:     { value: null },
        tOutdoorsMask3:     { value: null },
        uHasOutdoorsMask:   { value: 0 },
        uOutdoorsMaskFlipY: { value: 0 },
        tBlockerMask:       { value: null },
        uHasBlockerMask:    { value: 0 },
        tUpperFloorMask:    { value: null },
        uHasUpperFloorMask: { value: 0 },
        uSunDir:            { value: new THREE.Vector2(0, -1) },
        uShadowOpacity:     { value: 0.7 },
        uShadowSoftness:    { value: 0.9 },
        uTexelSize:         { value: new THREE.Vector2(1/512, 1/512) },
        uZoom:              { value: 1 },
        uMinBrightness:     { value: 0 },
        uSceneFadeSoftness: { value: 0.025 },
        uShadowOffsetWorld: { value: new THREE.Vector2(0, 0) },
        uViewBoundsMin:     { value: new THREE.Vector2(0, 0) },
        uViewBoundsMax:     { value: new THREE.Vector2(4000, 3000) },
        uSceneOrigin:       { value: new THREE.Vector2(0, 0) },
        uSceneSize:         { value: new THREE.Vector2(4000, 3000) },
        uSceneDimensions:   { value: new THREE.Vector2(4000, 3000) },
        uDensityBoundsMin:  { value: new THREE.Vector2(0, 0) },
        uDensityBoundsMax:  { value: new THREE.Vector2(4000, 3000) },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tCloudDensity;
        uniform float uDensityMode;
        uniform sampler2D tFloorIdTex;
        uniform float uHasFloorIdTex;
        uniform sampler2D tOutdoorsMask;
        uniform sampler2D tOutdoorsMask0;
        uniform sampler2D tOutdoorsMask1;
        uniform sampler2D tOutdoorsMask2;
        uniform sampler2D tOutdoorsMask3;
        uniform float uHasOutdoorsMask;
        uniform float uOutdoorsMaskFlipY;
        uniform sampler2D tBlockerMask;
        uniform float uHasBlockerMask;
        uniform sampler2D tUpperFloorMask;
        uniform float uHasUpperFloorMask;
        uniform vec2 uSunDir;
        uniform float uShadowOpacity;
        uniform float uShadowSoftness;
        uniform vec2  uTexelSize;
        uniform float uZoom;
        uniform float uMinBrightness;
        uniform float uSceneFadeSoftness;
        uniform vec2  uShadowOffsetWorld;
        uniform vec2  uViewBoundsMin;
        uniform vec2  uViewBoundsMax;
        uniform vec2  uSceneOrigin;
        uniform vec2  uSceneSize;
        uniform vec2  uSceneDimensions;
        uniform vec2  uDensityBoundsMin;
        uniform vec2  uDensityBoundsMax;
        varying vec2 vUv;

        // Convert Three world position → Foundry scene UV.
        // Matches water-shader.js screenUvToFoundry + foundryToSceneUv exactly.
        vec2 worldToSceneUv(vec2 worldPos) {
          float foundryX = worldPos.x;
          float foundryY = uSceneDimensions.y - worldPos.y;
          return (vec2(foundryX, foundryY) - uSceneOrigin) / max(uSceneSize, vec2(1e-5));
        }

        float readDensity(vec2 uv) {
          vec4 t = texture2DLodEXT(tCloudDensity, uv, 0.0);
          return (uDensityMode < 0.5) ? t.r : t.a;
        }

        float readOutdoors(vec2 sceneUvFoundry) {
          if (uHasOutdoorsMask < 0.5) return 1.0;
          vec2 maskUv = vec2(sceneUvFoundry.x, (uOutdoorsMaskFlipY > 0.5) ? (1.0 - sceneUvFoundry.y) : sceneUvFoundry.y);
          if (uHasFloorIdTex > 0.5) {
            // floorIdTarget is authored in Three Y-up scene UV; flip Y to sample it.
            vec2 sceneUvThree = vec2(sceneUvFoundry.x, 1.0 - sceneUvFoundry.y);
            float fid = texture2D(tFloorIdTex, sceneUvThree).r;
            float idx = floor(fid * 255.0 + 0.5);
            // _Outdoors masks are Foundry Y-down — sample with sceneUvFoundry.
            if (idx < 0.5) return texture2D(tOutdoorsMask0, maskUv).r;
            if (idx < 1.5) return texture2D(tOutdoorsMask1, maskUv).r;
            if (idx < 2.5) return texture2D(tOutdoorsMask2, maskUv).r;
            return texture2D(tOutdoorsMask3, maskUv).r;
          }
          return texture2D(tOutdoorsMask, maskUv).r;
        }

        float offsetScaleLimit(float uvCoord, float delta) {
          if (abs(delta) < 1e-6) return 1.0;
          if (delta > 0.0) return min(1.0, (1.0 - uvCoord) / delta);
          return min(1.0, uvCoord / -delta);
        }

        void main() {
          vec2 baseWorld = mix(uViewBoundsMin, uViewBoundsMax, vUv);
          vec2 sceneUvCheck = worldToSceneUv(baseWorld);
          // Soft scene boundary fade: shadow fades smoothly to 1.0 (fully lit) outside
          // the scene rect. Hard discard creates a sharp rectangular edge at the
          // scene/padding boundary visible as a box in the middle of the viewport.
          float sf = max(uSceneFadeSoftness, 0.001);
          float sfX = smoothstep(-sf, 0.0, sceneUvCheck.x) * smoothstep(1.0 + sf, 1.0, sceneUvCheck.x);
          float sfY = smoothstep(-sf, 0.0, sceneUvCheck.y) * smoothstep(1.0 + sf, 1.0, sceneUvCheck.y);
          float sceneMask = sfX * sfY;
          if (sceneMask < 0.001) { gl_FragColor = vec4(1.0); return; }

          // Sample density at sun-offset world position
          vec2 shadowWorld = baseWorld + uShadowOffsetWorld;
          vec2 densSize = max(uDensityBoundsMax - uDensityBoundsMin, vec2(1e-3));
          vec2 shadowUV = clamp((shadowWorld - uDensityBoundsMin) / densSize, vec2(0.0), vec2(1.0));

          // 3x3 blur kernel weighted by softness
          float blurPx = uShadowSoftness * 20.0 * uZoom;
          vec2 stepUv = uTexelSize * blurPx;
          float accum = 0.0; float wsum = 0.0;
          for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
              float w = (dx == 0 && dy == 0) ? 2.0 : 1.0;
              vec2 s = clamp(shadowUV + vec2(float(dx),float(dy))*stepUv, vec2(0.0), vec2(1.0));
              accum += readDensity(s) * w; wsum += w;
            }
          }
          float density = accum / max(wsum, 0.001);
          float factor = max(1.0 - density * uShadowOpacity, uMinBrightness);

          // Outdoors mask: shadow only falls outdoors.
          // Sample at scene UV derived from world position so the mask is
          // anchored to the world, not stretched across the screen (vUv).
          if (uHasOutdoorsMask > 0.5) {
            vec2 sceneUvRaw = worldToSceneUv(baseWorld);
            float outdoorsInScene =
              step(0.0, sceneUvRaw.x) * step(sceneUvRaw.x, 1.0) *
              step(0.0, sceneUvRaw.y) * step(sceneUvRaw.y, 1.0);
            vec2 sceneUvFoundry = clamp(sceneUvRaw, vec2(0.0), vec2(1.0));
            float outdoors = readOutdoors(sceneUvFoundry);
            factor = mix(1.0, factor, mix(1.0, outdoors, outdoorsInScene));
          }

          // Blocker mask: overhead tiles cancel shadow (rooftops stay bright)
          if (uHasBlockerMask > 0.5) {
            float b = texture2D(tBlockerMask, vUv).a;
            factor = mix(factor, 1.0, clamp(b, 0.0, 1.0));
          }

          // Floors above the active level occlude cloud shadows beneath them.
          if (uHasUpperFloorMask > 0.5) {
            vec2 viewSpan = max(uViewBoundsMax - uViewBoundsMin, vec2(1e-3));
            vec2 shadowDeltaUv = uShadowOffsetWorld / viewSpan;
            // Use the exact cloud-shadow world offset projected into this pass UV,
            // so upper-floor occlusion and cloud shadow travel stay phase-locked.
            vec2 upperDeltaUv = shadowDeltaUv;
            float upperScaleX = clamp(offsetScaleLimit(vUv.x, upperDeltaUv.x), 0.0, 1.0);
            float upperScaleY = clamp(offsetScaleLimit(vUv.y, upperDeltaUv.y), 0.0, 1.0);
            vec2 upperUv = vUv + vec2(
              upperDeltaUv.x * upperScaleX,
              upperDeltaUv.y * upperScaleY
            );

            vec4 ubTex0 = texture2D(tUpperFloorMask, clamp(vUv, 0.0, 1.0));
            vec4 ubTex1 = texture2D(tUpperFloorMask, clamp(upperUv, 0.0, 1.0));
            float ub0 = max(max(ubTex0.r, ubTex0.g), max(ubTex0.b, ubTex0.a));
            float ub1 = max(max(ubTex1.r, ubTex1.g), max(ubTex1.b, ubTex1.a));
            float ub = max(ub0, ub1);
            factor = mix(factor, 1.0, clamp(ub, 0.0, 1.0));
          }

          // Blend shadow back toward 1.0 (lit) near scene rect edges so there is
          // no hard rectangular transition between shadow and the padding area.
          factor = mix(1.0, factor, sceneMask);
          gl_FragColor = vec4(factor, factor, factor, 1.0);
        }
      `,
      depthWrite: false, depthTest: false,
      extensions: { shaderTextureLOD: true },
    });
    this._shadowMat.toneMapped = false;
  }

  /** @private */
  _createCloudTopMaterial() {
    const THREE = window.THREE;
    this._cloudTopMat = new THREE.ShaderMaterial({
      uniforms: {
        tCloudDensity:         { value: null },
        uDensityMode:          { value: 0 },
        uTime:                 { value: 0 },
        tFloorIdTex:           { value: null },
        uHasFloorIdTex:        { value: 0 },
        tOutdoorsMask:         { value: null },
        tOutdoorsMask0:        { value: null },
        tOutdoorsMask1:        { value: null },
        tOutdoorsMask2:        { value: null },
        tOutdoorsMask3:        { value: null },
        uHasOutdoorsMask:      { value: 0 },
        uOutdoorsMaskStrength: { value: 1 },
        uOutdoorsMaskFlipY:    { value: 0 },
        // View→world→scene UV conversion for outdoors mask sampling
        uViewBoundsMin:        { value: new THREE.Vector2(0, 0) },
        uViewBoundsMax:        { value: new THREE.Vector2(4000, 3000) },
        uSceneOrigin:          { value: new THREE.Vector2(0, 0) },
        uSceneSize:            { value: new THREE.Vector2(4000, 3000) },
        uSceneDimensions:      { value: new THREE.Vector2(4000, 3000) },
        tBlockerMask:          { value: null },
        uHasBlockerMask:       { value: 0 },
        uCloudTopOpacity:      { value: 1 },
        uAlphaStart:           { value: 0.2 },
        uAlphaEnd:             { value: 0.6 },
        uNormalizedZoom:       { value: 1 },
        uFadeStart:            { value: 0.24 },
        uFadeEnd:              { value: 0.39 },
        uCloudColor:           { value: new THREE.Vector3(1, 1, 1) },
        uSkyTint:              { value: new THREE.Vector3(0.7, 0.8, 1) },
        uTimeOfDayTint:        { value: new THREE.Vector3(1, 1, 1) },
        uTexelSize:            { value: new THREE.Vector2(1/512, 1/512) },
        uSunDir:               { value: new THREE.Vector2(0, 1) },
        uCloudBrightness:      { value: 1 },
        uShadingEnabled:       { value: 1 },
        uShadingStrength:      { value: 0.99 },
        uNormalStrength:       { value: 0.96 },
        uAOIntensity:          { value: 2 },
        uEdgeHighlight:        { value: 0 },
        uPeakDetailEnabled:    { value: 0 },
        uPeakDetailStrength:   { value: 0.32 },
        uPeakDetailScale:      { value: 92.5 },
        uPeakDetailSpeed:      { value: 0.08 },
        uPeakDetailStart:      { value: 0.14 },
        uPeakDetailEnd:        { value: 0.82 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tCloudDensity;
        uniform float uDensityMode;
        uniform float uTime;
        uniform sampler2D tFloorIdTex;
        uniform float uHasFloorIdTex;
        uniform sampler2D tOutdoorsMask;
        uniform sampler2D tOutdoorsMask0;
        uniform sampler2D tOutdoorsMask1;
        uniform sampler2D tOutdoorsMask2;
        uniform sampler2D tOutdoorsMask3;
        uniform float uHasOutdoorsMask;
        uniform float uOutdoorsMaskStrength;
        uniform float uOutdoorsMaskFlipY;
        uniform vec2  uViewBoundsMin;
        uniform vec2  uViewBoundsMax;
        uniform vec2  uSceneOrigin;
        uniform vec2  uSceneSize;
        uniform vec2  uSceneDimensions;
        uniform sampler2D tBlockerMask;
        uniform float uHasBlockerMask;
        uniform float uCloudTopOpacity;
        uniform float uAlphaStart;
        uniform float uAlphaEnd;
        uniform float uNormalizedZoom;
        uniform float uFadeStart;
        uniform float uFadeEnd;
        uniform vec3  uCloudColor;
        uniform vec3  uSkyTint;
        uniform vec3  uTimeOfDayTint;
        uniform vec2  uTexelSize;
        uniform vec2  uSunDir;
        uniform float uCloudBrightness;
        uniform float uShadingEnabled;
        uniform float uShadingStrength;
        uniform float uNormalStrength;
        uniform float uAOIntensity;
        uniform float uEdgeHighlight;
        uniform float uPeakDetailEnabled;
        uniform float uPeakDetailStrength;
        uniform float uPeakDetailScale;
        uniform float uPeakDetailSpeed;
        uniform float uPeakDetailStart;
        uniform float uPeakDetailEnd;
        varying vec2 vUv;

        float hash21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123); }
        float noise2D(vec2 p){
          vec2 i=floor(p); vec2 f=fract(p);
          float a=hash21(i),b=hash21(i+vec2(1,0)),c=hash21(i+vec2(0,1)),d=hash21(i+vec2(1,1));
          vec2 u=f*f*(3.0-2.0*f);
          return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);
        }
        float fbm2D(vec2 p){ float v=0.0,a=0.5; for(int i=0;i<4;i++){v+=a*noise2D(p);p*=2.02;a*=0.5;} return v; }

        // Convert Three world position → Foundry scene UV.
        // Matches water-shader.js screenUvToFoundry + foundryToSceneUv exactly.
        vec2 worldToSceneUv(vec2 worldPos) {
          float foundryX = worldPos.x;
          float foundryY = uSceneDimensions.y - worldPos.y;
          return (vec2(foundryX, foundryY) - uSceneOrigin) / max(uSceneSize, vec2(1e-5));
        }

        float readOutdoors(vec2 sceneUvFoundry) {
          if (uHasOutdoorsMask < 0.5) return 1.0;
          vec2 maskUv = vec2(sceneUvFoundry.x, (uOutdoorsMaskFlipY > 0.5) ? (1.0 - sceneUvFoundry.y) : sceneUvFoundry.y);
          if (uHasFloorIdTex > 0.5) {
            // floorIdTarget is authored in Three Y-up scene UV; flip Y to sample it.
            vec2 sceneUvThree = vec2(sceneUvFoundry.x, 1.0 - sceneUvFoundry.y);
            float fid = texture2D(tFloorIdTex, sceneUvThree).r;
            float idx = floor(fid * 255.0 + 0.5);
            // _Outdoors masks are Foundry Y-down — sample with sceneUvFoundry.
            if (idx < 0.5) return texture2D(tOutdoorsMask0, maskUv).r;
            if (idx < 1.5) return texture2D(tOutdoorsMask1, maskUv).r;
            if (idx < 2.5) return texture2D(tOutdoorsMask2, maskUv).r;
            return texture2D(tOutdoorsMask3, maskUv).r;
          }
          return texture2D(tOutdoorsMask, maskUv).r;
        }

        float readDensity(vec2 uv) {
          vec4 t = texture2D(tCloudDensity, uv);
          float d = (uDensityMode < 0.5) ? t.r : t.a;
          if (uPeakDetailEnabled > 0.5) {
            float pm = smoothstep(uPeakDetailStart, uPeakDetailEnd, d);
            float n = fbm2D(uv*uPeakDetailScale+vec2(uTime*uPeakDetailSpeed))*2.0-1.0;
            d = clamp(d + n*uPeakDetailStrength*pm, 0.0, 1.0);
          }
          return d;
        }

        vec3 shadeCloud(vec2 uv, float density, vec3 base) {
          float dN=readDensity(uv+vec2(0.0, uTexelSize.y));
          float dS=readDensity(uv+vec2(0.0,-uTexelSize.y));
          float dE=readDensity(uv+vec2( uTexelSize.x,0.0));
          float dW=readDensity(uv+vec2(-uTexelSize.x,0.0));
          vec2 grad=vec2(dE-dW,dN-dS);
          vec3 n=normalize(vec3(-grad.x*4.0*uNormalStrength,-grad.y*4.0*uNormalStrength,1.0));
          vec3 l=normalize(vec3(uSunDir.x,uSunDir.y,0.35));
          float ndotl=clamp(dot(n,l),0.0,1.0);
          float shade=mix(0.65,1.3,ndotl);
          shade=mix(1.0,shade,clamp(uShadingStrength,0.0,2.0));
          float avgL=0.25*(dN+dS+dE+dW);
          float dN2=readDensity(uv+vec2(0.0, uTexelSize.y*6.0));
          float dS2=readDensity(uv+vec2(0.0,-uTexelSize.y*6.0));
          float dE2=readDensity(uv+vec2( uTexelSize.x*6.0,0.0));
          float dW2=readDensity(uv+vec2(-uTexelSize.x*6.0,0.0));
          float avgW=0.25*(dN2+dS2+dE2+dW2);
          float cavity=max(0.0,0.55*(avgL-density)+0.45*(avgW-density));
          float ao=1.0-clamp(uAOIntensity/2.0,0.0,1.0)*smoothstep(0.0,0.05,cavity)*0.9;
          ao=clamp(ao,0.45,1.10);
          float gMag=length(grad);
          float facing=gMag>1e-5 ? clamp(dot(normalize(grad),normalize(uSunDir)),0.0,1.0) : 0.0;
          float edge=smoothstep(0.03,0.12,gMag)*facing*0.25*uEdgeHighlight;
          return base*shade*ao+edge;
        }

        void main() {
          float density = readDensity(vUv);
          vec4 densTex  = texture2D(tCloudDensity, vUv);
          float zoomFade = 1.0 - smoothstep(uFadeStart, uFadeEnd, uNormalizedZoom);
          // uAlphaStart/uAlphaEnd control the density ramp so cloud edges can be
          // tuned from wispy (low start) to crisp (high start approaching end).
          float alpha = smoothstep(uAlphaStart, uAlphaEnd, density) * zoomFade * uCloudTopOpacity;

          float dMid   = (uDensityMode < 0.5) ? density : densTex.r;
          float dInner = (uDensityMode < 0.5) ? density : densTex.g;
          float dOuter = (uDensityMode < 0.5) ? density : densTex.b;

          vec3 base = mix(uSkyTint, uCloudColor, density*0.5+0.5);
          float sum = max(dMid+dInner+dOuter, 1e-3);
          vec3 layered = (base*1.05*dMid + base*0.97*dInner + base*0.90*dOuter) / sum;
          vec3 color = layered * uTimeOfDayTint * uCloudBrightness;
          if (uShadingEnabled > 0.5) color = shadeCloud(vUv, density, color);

          if (uHasOutdoorsMask > 0.5) {
            // Reconstruct world position from vUv then convert to Foundry scene UV.
            vec2 worldPos = mix(uViewBoundsMin, uViewBoundsMax, vUv);
            vec2 sceneUvRaw = worldToSceneUv(worldPos);
            float outdoorsInScene =
              step(0.0, sceneUvRaw.x) * step(sceneUvRaw.x, 1.0) *
              step(0.0, sceneUvRaw.y) * step(sceneUvRaw.y, 1.0);
            vec2 sceneUvFoundry = clamp(sceneUvRaw, vec2(0.0), vec2(1.0));
            float o = readOutdoors(sceneUvFoundry);
            float oEff = mix(1.0, o, outdoorsInScene);
            alpha *= mix(1.0, oEff, clamp(uOutdoorsMaskStrength, 0.0, 1.0));
          }
          if (uHasBlockerMask > 0.5) {
            vec4 bTex = texture2D(tBlockerMask, vUv);
            float b = max(max(bTex.r, bTex.g), max(bTex.b, bTex.a));
            // Soft fade at tile boundaries instead of a hard binary step.
            alpha *= (1.0 - smoothstep(0.01, 0.15, b));
          }
          if (alpha < 0.001) discard;
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.NormalBlending,
    });
    this._cloudTopMat.toneMapped = false;
  }

  /** @private */
  _createCloudLayerMaterialTemplate() {
    const THREE = window.THREE;
    this._cloudLayerMatTemplate = new THREE.ShaderMaterial({
      uniforms: {
        tCloudTop:       { value: null },
        uViewBoundsMin:  { value: new THREE.Vector2(0, 0) },
        uViewBoundsMax:  { value: new THREE.Vector2(4000, 3000) },
        uUvOffset:       { value: new THREE.Vector2(0, 0) },
        uUvScale:        { value: 1 },
        uOpacityMul:     { value: 1 },
        uEdgeSoftness:   { value: 0.2 },
        uTime:           { value: 0 },
        uLayerSlice:     { value: 0 },
        uSliceStrength:  { value: 0.45 },
        uSliceScale:     { value: 2.2 },
        uSliceContrast:  { value: 1.3 },
        uSliceSpeed:     { value: 0.015 },
      },
      vertexShader: /* glsl */`
        varying vec2 vWorldXY;
        void main() {
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldXY = worldPos.xy;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tCloudTop;
        uniform vec2 uViewBoundsMin;
        uniform vec2 uViewBoundsMax;
        uniform vec2 uUvOffset;
        uniform float uUvScale;
        uniform float uOpacityMul;
        uniform float uEdgeSoftness;
        uniform float uTime;
        uniform float uLayerSlice;
        uniform float uSliceStrength;
        uniform float uSliceScale;
        uniform float uSliceContrast;
        uniform float uSliceSpeed;
        varying vec2 vWorldXY;

        float hash13(vec3 p) {
          return fract(sin(dot(p, vec3(127.1, 311.7, 191.999))) * 43758.5453123);
        }
        float noise3D(vec3 p) {
          vec3 i = floor(p);
          vec3 f = fract(p);
          vec3 u = f * f * (3.0 - 2.0 * f);
          float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
          float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
          float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
          float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
          float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
          float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
          float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
          float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
          float nx00 = mix(n000, n100, u.x);
          float nx10 = mix(n010, n110, u.x);
          float nx01 = mix(n001, n101, u.x);
          float nx11 = mix(n011, n111, u.x);
          float nxy0 = mix(nx00, nx10, u.y);
          float nxy1 = mix(nx01, nx11, u.y);
          return mix(nxy0, nxy1, u.z);
        }
        float fbm3D(vec3 p) {
          float v = 0.0;
          float a = 0.5;
          for (int i = 0; i < 3; i++) {
            v += a * noise3D(p);
            p *= 2.03;
            a *= 0.5;
          }
          return v;
        }

        void main() {
          vec2 span = max(uViewBoundsMax - uViewBoundsMin, vec2(1e-5));
          // uvWorld is [0,1] across the physical mesh world bounds — used for edge fade
          // so the fade is anchored to the mesh boundary, not the UV wrap seam.
          vec2 uvWorld = (vWorldXY - uViewBoundsMin) / span;
          vec2 uv = uvWorld;
          uv = ((uv - 0.5) / max(uUvScale, 1e-3)) + 0.5 + uUvOffset;
          // Fade out as UV exits [0,1] so clamp sampling does not smear border texels
          // along the cloud mesh edges (notably visible on left/top boundaries).
          const float UV_EDGE_FADE = 0.03;
          float uvMaskX = smoothstep(-UV_EDGE_FADE, 0.0, uv.x) * smoothstep(1.0 + UV_EDGE_FADE, 1.0, uv.x);
          float uvMaskY = smoothstep(-UV_EDGE_FADE, 0.0, uv.y) * smoothstep(1.0 + UV_EDGE_FADE, 1.0, uv.y);
          float uvSampleMask = uvMaskX * uvMaskY;
          // Non-repeating sample to avoid periodic seams in the middle of the effect.
          // Repeating (fract) creates visible tile boundaries because tCloudTop is not
          // authored as a perfectly tileable texture.
          vec2 uvSample = clamp(uv, vec2(0.0), vec2(1.0));
          vec4 c = texture2D(tCloudTop, uvSample);
          c.a *= uvSampleMask;
          // Edge fade based on world-space UV (pre-fract) so the soft boundary is
          // always at the physical mesh edge.
          float edgeDist = min(min(uvWorld.x, 1.0 - uvWorld.x), min(uvWorld.y, 1.0 - uvWorld.y));
          float edgeSoft = max(uEdgeSoftness, 1e-4);
          // smoothstep(0, edgeSoft, ...) fades cleanly from 0 at the mesh edge to 1 inward.
          float edgeMask = smoothstep(0.0, edgeSoft, edgeDist);

          vec2 sliceXY = uvWorld + vec2(uLayerSlice * 0.131, uLayerSlice * 0.073);
          float sliceZ = (uLayerSlice * 6.0) + (uTime * uSliceSpeed * 2.0);
          vec3 slicePos = vec3(sliceXY * uSliceScale, sliceZ);
          float sliceN = fbm3D(slicePos);
          float sliceMask = clamp((sliceN - 0.5) * uSliceContrast + 0.5, 0.0, 1.0);
          float s = clamp(uSliceStrength, 0.0, 1.0);
          float shapedSlice = mix(1.0, pow(sliceMask, 2.2 - (2.0 * s)), s);
          float densitySlice = mix(1.0, (sliceMask * 0.75 + 0.25), s);

          c.rgb *= densitySlice;
          c.a *= (uOpacityMul * edgeMask * shapedSlice);
          if (c.a < 0.001) discard;
          gl_FragColor = c;
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
    });
    this._cloudLayerMatTemplate.toneMapped = false;
  }

  /** @private */
  _ensureCloudLayerPlanes() {
    const THREE = window.THREE;
    if (!THREE || !this._cloudLayerScene || !this._cloudLayerMatTemplate) return;

    const desiredCount = 3;
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
      if (!mesh?.material?.uniforms?.tCloudTop) continue;
      mesh.material.uniforms.tCloudTop.value = tex;
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
    const layerHeight1 = Number(this.params.cloudLayer1HeightFromGround);
    const layerHeight2 = Number(this.params.cloudLayer2HeightFromGround);
    const layerHeight3 = Number(this.params.cloudLayer3HeightFromGround);
    const baseOffsetFromEmitter = Number(this.params.cloudLayerBaseOffsetFromEmitter);
    const fallbackEmitterOffset = Number.isFinite(baseOffsetFromEmitter) ? baseOffsetFromEmitter : -2200;
    const layerSpacing = Math.max(20, Number(this.params.cloudLayerZSpacing) || 220);
    const targetBaseZ = Number.isFinite(heightFromGround)
      ? (groundZ + heightFromGround)
      : (emitterZ + fallbackEmitterOffset);
    // Interpret the base height as the LOWEST cloud plane height (closest to ground),
    // and stack duplicate planes upward by spacing. Clamp the lowest plane so the
    // highest plane stays in front of the camera.
    const highestPlaneOffset = Math.max(0, (this._cloudLayerMeshes.length - 1)) * layerSpacing;
    const baseZ = Math.min(targetBaseZ, camZ - 120 - highestPlaneOffset);
    const coverageScale = Math.max(1, Number(this.params.cloudLayerCoverageScale) || 3.0);
    const depthScaleStep = Math.max(0, Number(this.params.cloudLayerDepthScaleStep) || 0.18);

    const usePerLayerHeights = Number.isFinite(layerHeight1) || Number.isFinite(layerHeight2) || Number.isFinite(layerHeight3);
    const perHeights = [layerHeight1, layerHeight2, layerHeight3];

    // If per-layer heights push some layers above the camera, we shift ALL layers
    // down together to keep them visible while preserving relative separation.
    // Clamping each layer individually collapses them onto the same Z and makes it
    // look like only one layer exists.
    let zShiftDown = 0;
    const maxAllowedZ = camZ - 120;
    if (usePerLayerHeights) {
      let maxDesiredZ = -Infinity;
      for (let i = 0; i < this._cloudLayerMeshes.length; i++) {
        const h = perHeights[i];
        if (!Number.isFinite(h)) continue;
        maxDesiredZ = Math.max(maxDesiredZ, groundZ + h);
      }
      if (Number.isFinite(maxDesiredZ) && maxDesiredZ > maxAllowedZ) {
        zShiftDown = maxDesiredZ - maxAllowedZ;
      }
    }

    for (let i = 0; i < this._cloudLayerMeshes.length; i++) {
      const mesh = this._cloudLayerMeshes[i];
      if (!mesh) continue;
      const layerOffsetIndex = i - 1;
      // Keep the per-layer scale variation symmetric using layerOffsetIndex.
      const depthScale = coverageScale * (1.0 + Math.abs(layerOffsetIndex) * depthScaleStep);

      let z = baseZ + (i * layerSpacing);
      if (usePerLayerHeights) {
        const h = perHeights[i];
        if (Number.isFinite(h)) z = (groundZ + h) - zShiftDown;
      }

      mesh.position.set(centerX, centerY, z);
      mesh.scale.set(sceneW * depthScale, sceneH * depthScale, 1);
      mesh.visible = this.params.enabled && this.params.cloudTopOpacity > 0;
    }
  }

  /** @private */
  _updateCloudLayerUniforms(vMinX, vMinY, vMaxX, vMaxY) {
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

    const sceneComposer = window.MapShine?.sceneComposer;
    const groundZRaw = Number(sceneComposer?.groundZ);
    const groundZ = Number.isFinite(groundZRaw) ? groundZRaw : 0;
    const camZRaw = Number(camPos?.z);
    const camZ = Number.isFinite(camZRaw) ? camZRaw : (groundZ + 1000);
    const camZSpan = Math.max(1e-3, camZ - groundZ);

    const opacity = Math.max(0, Number(this.params.cloudTopOpacity) || 0);
    const coverageScale = Math.max(1, Number(this.params.cloudLayerCoverageScale) || 3.0);
    const uvScaleStep = Math.max(0, Number(this.params.cloudLayerUvScaleStep) || 0.25);
    const driftStrength = Math.max(0, Number(this.params.cloudLayerDriftStrength) || 0.02);
    const driftDepthBoost = Math.max(0, Number(this.params.cloudLayerDriftDepthBoost) || 0.015);
    const opacityBase    = Math.max(0, Number(this.params.cloudLayerOpacityBase) || 0.75);
    const opacityFalloff = Math.max(0, Math.min(1, Number(this.params.cloudLayerOpacityFalloff) ?? 0.35));
    const edgeSoftness   = Math.max(0.01, Number(this.params.cloudLayerEdgeSoftness) || 0.12);
    const sliceStrength = Math.max(0, Math.min(1, Number(this.params.cloudLayerSliceStrength) || 0.7));
    const sliceScale = Math.max(0.1, Number(this.params.cloudLayerSliceScale) || 2.2);
    const sliceContrast = Math.max(0.1, Number(this.params.cloudLayerSliceContrast) || 1.3);
    const sliceSpeed = Math.max(0, Number(this.params.cloudLayerSliceSpeed) || 0.015);
    const sliceSpacing = Math.max(0, Number(this.params.cloudLayerSliceSpacing) || 2.0);

    const perHeights = [
      Number(this.params.cloudLayer1HeightFromGround),
      Number(this.params.cloudLayer2HeightFromGround),
      Number(this.params.cloudLayer3HeightFromGround)
    ];

    for (let i = 0; i < this._cloudLayerMeshes.length; i++) {
      const mesh = this._cloudLayerMeshes[i];
      const u = mesh?.material?.uniforms;
      if (!u) continue;
      const layerOffsetIndex = i - 1;
      const layerScale = coverageScale;
      const halfW = (sceneW * layerScale) * 0.5;
      const halfH = (sceneH * layerScale) * 0.5;
      const wind = this._windOffset;
      // Use layer world bounds (not camera view bounds) so cloud coverage and
      // edge gradients remain stable across pans and scene-edge traversal.
      u.uViewBoundsMin.value.set(centerX - halfW, centerY - halfH);
      u.uViewBoundsMax.value.set(centerX + halfW, centerY + halfH);
      // Per-layer variation so stacked planes don't look identical.
      // Keep offsets bounded to prevent clamped sampling from collapsing onto
      // texture edges and to avoid introducing repeating seams.
      const h = perHeights[i];
      const hSeed = Number.isFinite(h) ? (h * 0.001) : 0;
      const seedX = (layerOffsetIndex * 0.17) + (Math.sin(hSeed + i * 1.7) * 0.06);
      const seedY = (layerOffsetIndex * -0.11) + (Math.cos(hSeed + i * 2.3) * 0.06);
      const scaleVar = 1.0 + (layerOffsetIndex * 0.15);
      u.uUvScale.value = (1.0 + uvScaleStep) * Math.max(0.5, scaleVar);

      // Camera-relative parallax cue: layers shift differently as the camera pans.
      // This makes low clouds feel "closer" to the map and makes spacing actually
      // read as depth even in a near-top-down camera.
      const nCamX = Number.isFinite(camX) ? ((camX - centerX) / Math.max(1, sceneW * layerScale)) : 0;
      const nCamY = Number.isFinite(camY) ? ((camY - centerY) / Math.max(1, sceneH * layerScale)) : 0;
      // Scale by actual height so layers at/near ground don't "slide like sky".
      const layerZRaw = Number(mesh?.position?.z);
      const layerZ = Number.isFinite(layerZRaw) ? layerZRaw : groundZ;
      const height01 = Math.max(0, Math.min(1, (layerZ - groundZ) / camZSpan));
      const parallaxMul = layerOffsetIndex * driftDepthBoost * 6.0 * height01;
      // Wind offset is unbounded over time. Compress it smoothly into [-1,1]
      // so UV offsets remain bounded without discontinuous modulo jumps.
      const windNormX = Math.tanh((wind?.x ?? 0) * 0.08);
      const windNormY = Math.tanh((wind?.y ?? 0) * 0.08);

      u.uUvOffset.value.set(
        (windNormX * driftStrength) + seedX + (nCamX * parallaxMul),
        (windNormY * driftStrength) + seedY + (nCamY * parallaxMul)
      );
      // Apply depth falloff: layer 0 (lowest/closest) gets full opacityBase,
      // higher layers get progressively less opacity to simulate sky depth.
      const layerOpacity = opacityBase * Math.max(0, 1.0 - opacityFalloff * i);
      u.uOpacityMul.value = opacity * layerOpacity;
      u.uEdgeSoftness.value = edgeSoftness;
      u.uTime.value = this._lastElapsed;
      u.uLayerSlice.value = layerOffsetIndex * sliceSpacing;
      u.uSliceStrength.value = sliceStrength;
      u.uSliceScale.value = sliceScale;
      u.uSliceContrast.value = sliceContrast;
      u.uSliceSpeed.value = sliceSpeed;
    }
  }

  // ── Getters ────────────────────────────────────────────────────────────────

  /**
   * Get the cloud top render target texture for use by other effects
   * @returns {THREE.Texture|null} The cloud top texture
   */
  get cloudTopTexture() {
    return this._cloudTopRT?.texture ?? null;
  }

  // ── Dispose ────────────────────────────────────────────────────────────────

  dispose() {
    const rts = [
      '_shadowDensityRT', '_densityRT', '_topDensityRT',
      '_shadowRT', '_shadowRawRT', '_cloudTopRT', '_blockerRT', '_upperFloorOccluderRT',
    ];
    for (const k of rts) { try { this[k]?.dispose(); } catch (_) {} this[k] = null; }

    const mats = ['_densityMat', '_shadowMat', '_cloudTopMat', '_cloudLayerMatTemplate'];
    for (const k of mats) { try { this[k]?.dispose(); } catch (_) {} this[k] = null; }

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

    this._upperFloorMaskBuilder = null;
    this._upperFloorMaskValid = false;

    this._initialized = false;
    log.info('CloudEffectV2 disposed');
  }
}
