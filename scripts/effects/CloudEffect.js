/**
 * @fileoverview Cloud Effect - Procedural cloud shadows and optional cloud tops
 * Generates cloud density and shadow textures for atmospheric effects.
 * @module effects/CloudEffect
 */

import { EffectBase, RenderLayers, TILE_FEATURE_LAYERS, OVERLAY_THREE_LAYER } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('CloudEffect');

/**
 * Cloud Effect - Procedural cloud system
 * 
 * Generates:
 * - cloudDensityTarget: Raw cloud coverage texture
 * - cloudShadowTarget: Shadow factor texture (1.0 = lit, 0.0 = shadowed)
 * 
 * Features:
 * - World-space coordinates (clouds pinned to map, not camera)
 * - Time-of-day shadow offset (sun direction alignment)
 * - Wind-driven cloud drift
 * - Multi-layer noise for natural cloud shapes
 * - Zoom-dependent cloud top visibility
 */
export class CloudEffect extends EffectBase {
  constructor() {
    super('cloud', RenderLayers.ENVIRONMENTAL, 'low');

    this.priority = 5; // Before OverheadShadowsEffect (10)
    this.alwaysRender = true;

    // Clouds are a scene-wide overlay above all floors. Running this per-floor
    // would compute cloud density N times and accumulate duplicated cloud geometry
    // in the scene render target. The active-floor outdoors mask is kept current
    // by the EffectMaskRegistry subscription in connectToRegistry().
    this.floorScope = 'global';

    // Clouds are time-based animation (wind drift + procedural noise time).
    // If we allow RenderLoop idle throttling, clouds will appear to only move
    // during camera motion (since that's when the pipeline re-renders).
    this.requiresContinuousRender = true;

    /** @type {THREE.ShaderMaterial|null} */
    this.densityMaterial = null;

    /** @type {THREE.ShaderMaterial|null} */
    this.shadowMaterial = null;

    /** @type {THREE.WebGLRenderTarget|null} */
    this.cloudDensityTarget = null;

    /** @type {THREE.WebGLRenderTarget|null} */
    this.cloudShadowDensityTarget = null;

    /** @type {THREE.WebGLRenderTarget|null} */
    this.cloudShadowTarget = null;

    /** @type {THREE.WebGLRenderTarget|null} */
    this.cloudShadowRawTarget = null;

    /** @type {THREE.WebGLRenderTarget|null} */
    this.cloudTopDensityTarget = null;

    /** @type {THREE.WebGLRenderTarget|null} */
    this.cloudTopTarget = null;

    /** @type {THREE.WebGLRenderTarget|null} */
    this.cloudShadowBlockerTarget = null;

    /** @type {THREE.WebGLRenderTarget|null} */
    this.cloudTopBlockerTarget = null;

    this._publishedCloudShadowTex = null;
    this._publishedCloudShadowRawTex = null;
    this._publishedCloudDensityTex = null;
    this._publishedCloudShadowBlockerTex = null;
    this._publishedCloudTopBlockerTex = null;

    /** @type {THREE.ShaderMaterial|null} */
    this.cloudTopMaterial = null;

    /** @type {THREE.Scene|null} */
    this.quadScene = null;

    /** @type {THREE.OrthographicCamera|null} */
    this.quadCamera = null;

    /** @type {THREE.Mesh|null} */
    this.quadMesh = null;

    /** @type {THREE.Mesh|null} */
    this.baseMesh = null;

    /** @type {THREE.Mesh|null} */
    this.cloudTopOverlayMesh = null;

    /** @type {THREE.ShaderMaterial|null} */
    this.cloudTopOverlayMaterial = null;

    /** @type {THREE.Texture|null} */
    this.outdoorsMask = null;

    /** @type {function|null} Unsubscribe from EffectMaskRegistry */
    this._registryUnsub = null;

    /** @type {THREE.Vector2|null} */
    this.sunDir = null;

    // Accumulated wind offset for cloud drift
    this._windOffset = null; // Lazy init as THREE.Vector2

    // Inertial wind velocity (UV units / second)
    this._windVelocity = null; // Lazy init as THREE.Vector2

    // For cloud-top shading: a modified sun direction so shading is visible even at midday
    this._shadeSunDir = null; // Lazy init as THREE.Vector2

    // Multi-layer wind offsets
    this._layerWindOffsets = null; // Lazy init as Array<THREE.Vector2>
    this._layerWindVelocities = null; // Lazy init as Array<THREE.Vector2>
    this._layerSpeedMult = [0.6, 0.85, 1.0, 1.15, 1.3];
    this._layerDirAngle = [-0.03, -0.015, 0.0, 0.015, 0.03];
    // PERF: Use typed arrays for uniform arrays to avoid per-frame flatten() work and
    // reduce JS engine property lookup overhead during uniform uploads.
    this._layerParallax = new Float32Array([0.05, 0.12, 0.2, 0.28, 0.35]);
    this._layerCoverMult = new Float32Array([0.35, 0.65, 1.0, 0.65, 0.35]);
    this._layerNoiseScaleMult = new Float32Array([0.85, 0.95, 1.0, 1.15, 1.3]);
    this._layerWeight = new Float32Array([0.35, 0.65, 1.0, 0.65, 0.35]);

    this.params = {
      enabled: true,

      // Performance
      internalResolutionScale: 0.5,
      updateEveryNFrames: 1,

      // Cloud generation
      cloudCover: 0.5,        // Base cloud coverage (0-1), driven by WeatherController
      noiseScale: 0.5,        // Scale of noise pattern (higher = smaller clouds)
      noiseDetail: 4,         // Number of noise octaves (1-6)
      cloudSharpness: 0.0,    // Edge sharpness (0 = soft, 1 = hard)
      noiseTimeSpeed: 0.011,
      cloudBrightness: 1.01,   // Cloud top brightness

      // Domain warping (wispy/swirly look)
      domainWarpEnabled: true,
      domainWarpStrength: 0.005,
      domainWarpScale: 1.05,
      domainWarpSpeed: 0.115,
      domainWarpTimeOffsetY: 10,

      // Cloud top shading
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

      cloudTopSoftKnee: 1.8,

      // Shadow settings
      shadowOpacity: 0.7,     // How dark cloud shadows are
      shadowSoftness: 0.9,    // Blur amount for shadow edges
      shadowOffsetScale: 0.3, // How far shadows offset based on sun angle

      // Cloud top visibility (zoom-dependent)
      cloudTopMode: 'aboveEverything',
      cloudTopOpacity: 1.0,   // Max opacity of visible cloud layer (0 = shadows only)
      cloudTopFadeStart: 0.24, // Zoom level where cloud tops start appearing
      cloudTopFadeEnd: 0.39,   // Zoom level where cloud tops are fully visible

      // Wind drift
      windInfluence: 1.33,     // How much wind affects cloud movement
      driftSpeed: 0.01,       // Base drift speed multiplier
      minDriftSpeed: 0.002,

      driftResponsiveness: 0.4,
      driftMaxSpeed: 0.5,

      layerParallaxBase: 1.0,

      layer1Enabled: true,
      layer1Opacity: 0.35,
      layer1Coverage: 0.33,
      layer1Scale: 1.34,
      layer1ParallaxMult: 0,
      layer1SpeedMult: 0.99,
      layer1DirDeg: -1.7,

      layer2Enabled: true,
      layer2Opacity: 0.7,
      layer2Coverage: 0.57,
      layer2Scale: 1.22,
      layer2ParallaxMult: 0,
      layer2SpeedMult: 1.07,
      layer2DirDeg: -0.86,

      layer3Enabled: true,
      layer3Opacity: 0.19,
      layer3Coverage: 0.9,
      layer3Scale: 3.0,
      layer3ParallaxMult: 0,
      layer3SpeedMult: 0.94,
      layer3DirDeg: 0.0,

      layer4Enabled: true,
      layer4Opacity: 0.17,
      layer4Coverage: 0.46,
      layer4Scale: 1.72,
      layer4ParallaxMult: 0,
      layer4SpeedMult: 0.94,
      layer4DirDeg: 0.86,

      layer5Enabled: true,
      layer5Opacity: 0.13,
      layer5Coverage: 0.62,
      layer5Scale: 1.52,
      layer5ParallaxMult: 0,
      layer5SpeedMult: 1.07,
      layer5DirDeg: -0.6,

      // Minimum shadow brightness (prevents crushing blacks)
      minShadowBrightness: 0.0
    };

    // Performance: reusable objects
    this._tempSize = null;

    // Performance: pooled override state for blocker renders (avoid per-frame allocations)
    this._overrideObjects = [];
    this._overrideProps = [];
    this._overrideCount = 0;

    // Performance: reusable config objects for maskManager.setTexture
    this._maskTextureConfigCloudShadow = {
      space: 'screenUv',
      source: 'renderTarget',
      channels: 'r',
      uvFlipY: false,
      lifecycle: 'dynamicPerFrame',
      width: null,
      height: null
    };
    this._maskTextureConfigCloudShadowRaw = {
      space: 'screenUv',
      source: 'renderTarget',
      channels: 'r',
      uvFlipY: false,
      lifecycle: 'dynamicPerFrame',
      width: null,
      height: null
    };
    this._maskTextureConfigCloudDensity = {
      space: 'screenUv',
      source: 'renderTarget',
      channels: 'r',
      uvFlipY: false,
      lifecycle: 'dynamicPerFrame',
      width: null,
      height: null
    };
    this._maskTextureConfigCloudShadowBlocker = {
      space: 'screenUv',
      source: 'renderTarget',
      channels: 'rgba',
      uvFlipY: false,
      lifecycle: 'dynamicPerFrame',
      width: null,
      height: null
    };
    this._maskTextureConfigCloudTopBlocker = {
      space: 'screenUv',
      source: 'renderTarget',
      channels: 'rgba',
      uvFlipY: false,
      lifecycle: 'dynamicPerFrame',
      width: null,
      height: null
    };
    this._lastUpdateHash = null;

    this._tempVec2A = null;
    this._tempVec2B = null;

    this._frameCounter = 0;
    this._lastCamX = null;
    this._lastCamY = null;
    this._lastCamZoom = null;
    this._lastViewMinX = null;
    this._lastViewMinY = null;
    this._lastViewMaxX = null;
    this._lastViewMaxY = null;
    this._motionCooldownFrames = 0;

    this._lastRenderFullWidth = 0;
    this._lastRenderFullHeight = 0;
    this._lastInternalWidth = 0;
    this._lastInternalHeight = 0;

    this._forceUpdateFrames = 0;
    this._forceRecomposeFrames = 0;
    this._blockersDirty = true;
    this._lastElapsed = 0;

    this._cloudTopDensityValid = false;

    // Treat near-zero cloud cover as disabled for performance, but keep one
    // transition frame to publish neutral textures and avoid stale cloud masks.
    this._cloudCoverEpsilon = 0.0001;
    this._cloudCoverZeroLastFrame = false;
    this._needsNeutralCloudClear = false;
  }

  isActive() {
    // Only force continuous rendering while clouds are enabled and weather isn't globally disabled.
    // (If weather is disabled, CloudEffect.render() produces neutral textures and we don't need
    // per-frame updates.)
    if (!this.enabled) return false;

    const weatherState = this._getEffectiveWeatherState();
    if (!weatherState.weatherEnabled) return false;

    const coverIsZero = this._isCloudCoverEffectivelyZero(weatherState.cloudCover);
    if (coverIsZero) {
      if (!this._cloudCoverZeroLastFrame) {
        this._needsNeutralCloudClear = true;
      }
      this._cloudCoverZeroLastFrame = true;
      return this._needsNeutralCloudClear;
    }

    this._cloudCoverZeroLastFrame = false;
    this._needsNeutralCloudClear = false;
    return true;
  }

  requestUpdate(frames = 2) {
    const n = (typeof frames === 'number' && Number.isFinite(frames)) ? (frames | 0) : 2;
    const f = Math.max(1, n);
    this._forceUpdateFrames = Math.max(this._forceUpdateFrames, f);
  }

  requestRecompose(frames = 2) {
    const n = (typeof frames === 'number' && Number.isFinite(frames)) ? (frames | 0) : 2;
    const f = Math.max(1, n);
    this._forceRecomposeFrames = Math.max(this._forceRecomposeFrames, f);
  }

  requestBlockerUpdate(frames = 2) {
    this._blockersDirty = true;
    this.requestRecompose(frames);
  }

  _renderTileBlockerLayer(renderer, target, layerId) {
    const THREE = window.THREE;
    if (!THREE || !renderer || !target || !this.mainCamera || !this.mainScene) return;

    const bit = 1 << layerId;

    this._overrideCount = 0;

    try {
      this.mainScene.traverse((obj) => {
        if (!obj) return;
        if (!obj.visible && obj.userData?.textureReady !== false) return;
        const mask = obj.layers?.mask;
        if (typeof mask !== 'number' || (mask & bit) === 0) return;

        const m = obj.material;
        if (!m || !m.isSpriteMaterial) return;

        // Expand pool if needed
        if (this._overrideCount >= this._overrideObjects.length) {
          this._overrideObjects.push(null);
          this._overrideProps.push({
            visible: true,
            m: null,
            map: null,
            alphaMap: null,
            opacity: 1.0,
            transparent: false,
            alphaTest: 0.0,
            depthTest: false,
            depthWrite: false,
            blending: 0,
            color: null
          });
        }

        // Save state
        const index = this._overrideCount;
        this._overrideObjects[index] = obj;
        const props = this._overrideProps[index];
        props.visible = !!obj.visible;
        props.m = m;
        props.map = m.map;
        props.alphaMap = m.alphaMap;
        props.opacity = m.opacity;
        props.transparent = m.transparent;
        props.alphaTest = m.alphaTest;
        props.depthTest = m.depthTest;
        props.depthWrite = m.depthWrite;
        props.blending = m.blending;
        props.color = m.color ? m.color.getHex() : null;
        this._overrideCount++;

        m.map = null;
        m.alphaMap = null;
        if (m.color) m.color.setHex(0xffffff);
        m.opacity = 1.0;
        m.transparent = true;
        m.alphaTest = 0.0;
        m.depthTest = false;
        m.depthWrite = false;
        m.blending = THREE.NoBlending;
        m.needsUpdate = true;

        // IMPORTANT: tiles start life as invisible until their texture finishes loading.
        // We still want them to contribute to blocker masks immediately so effect-stack
        // overrides apply on first frame.
        if (!obj.visible && obj.userData?.textureReady === false) {
          obj.visible = true;
        }
      });

      this.mainCamera.layers.set(layerId);
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this.mainScene, this.mainCamera);
    } finally {
      for (let i = this._overrideCount - 1; i >= 0; i--) {
        const obj = this._overrideObjects[i];
        const props = this._overrideProps[i];
        const m = props?.m;
        if (obj) obj.visible = props.visible;
        if (m) {
          m.map = props.map;
          m.alphaMap = props.alphaMap;
          if (m.color && typeof props.color === 'number') m.color.setHex(props.color);
          m.opacity = props.opacity;
          m.transparent = props.transparent;
          m.alphaTest = props.alphaTest;
          m.depthTest = props.depthTest;
          m.depthWrite = props.depthWrite;
          m.blending = props.blending;
          m.needsUpdate = true;
        }

        // Clear references to avoid holding objects longer than necessary.
        this._overrideObjects[i] = null;
        props.m = null;
      }
    }
  }

  /**
   * @param {number} fullWidth
   * @param {number} fullHeight
   * @returns {{width:number,height:number}}
   * @private
   */
  _getInternalRenderSize(fullWidth, fullHeight) {
    const scale = (this.params && typeof this.params.internalResolutionScale === 'number')
      ? this.params.internalResolutionScale
      : 0.5;
    const s = Math.max(0.1, Math.min(1.0, scale));
    const width = Math.max(1, Math.floor(fullWidth * s));
    const height = Math.max(1, Math.floor(fullHeight * s));
    return { width, height };
  }

  /**
   * Receive base mesh and asset bundle for outdoors mask access.
   * @param {THREE.Mesh} baseMesh
   * @param {MapAssetBundle} assetBundle
   */
  setBaseMesh(baseMesh, assetBundle) {
    this.baseMesh = baseMesh;
    if (assetBundle?.masks) {
      const outdoorsData = assetBundle.masks.find(m => m.id === 'outdoors' || m.type === 'outdoors');
      this.outdoorsMask = outdoorsData?.texture || null;
    }
  }

  /**
   * Subscribe to the EffectMaskRegistry for 'outdoors' mask updates.
   * @param {import('../assets/EffectMaskRegistry.js').EffectMaskRegistry} registry
   */
  connectToRegistry(registry) {
    if (this._registryUnsub) { this._registryUnsub(); this._registryUnsub = null; }
    this._registryUnsub = registry.subscribe('outdoors', (texture) => {
      this.outdoorsMask = texture;
    });
  }

  /**
   * GLSL-like smoothstep implemented in JS.
   * @param {number} edge0
   * @param {number} edge1
   * @param {number} x
   * @returns {number}
   * @private
   */
  _smoothstep(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(edge1 - edge0, 1e-6)));
    return t * t * (3 - 2 * t);
  }

  _isCloudCoverEffectivelyZero(cloudCover) {
    const cover = Number.isFinite(cloudCover) ? cloudCover : 0.0;
    return cover <= this._cloudCoverEpsilon;
  }

  _getEffectiveWeatherState() {
    let cloudCover = this.params.cloudCover;
    // Prefer real-world windSpeedMS (m/s) but keep existing tuning by mapping 78 m/s => 1.0.
    let windSpeed01 = 0.07;
    let windDirX = 1.0;
    let windDirY = 0.0;

    try {
      const state = weatherController?.getCurrentState?.();
      if (state) {
        cloudCover = state.cloudCover ?? cloudCover;
        if (typeof state.windSpeedMS === 'number' && Number.isFinite(state.windSpeedMS)) {
          windSpeed01 = Math.max(0.0, Math.min(1.0, state.windSpeedMS / 78.0));
        } else if (typeof state.windSpeed === 'number' && Number.isFinite(state.windSpeed)) {
          windSpeed01 = Math.max(0.0, Math.min(1.0, state.windSpeed));
        }
        if (state.windDirection) {
          windDirX = state.windDirection.x ?? windDirX;
          windDirY = state.windDirection.y ?? windDirY;
        }
      }
    } catch (_) {
    }

    const normalizedCloudCover = Math.max(0.0, Math.min(1.0, Number(cloudCover) || 0.0));
    return {
      weatherEnabled: !(weatherController && weatherController.enabled === false) && this.enabled,
      cloudCover: normalizedCloudCover,
      windSpeed: windSpeed01,
      windDirX,
      windDirY
    };
  }

  /**
   * UI control schema for Tweakpane
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'cloud-generation',
          label: 'Cloud Generation',
          type: 'inline',
          parameters: ['noiseScale', 'noiseDetail', 'cloudSharpness', 'noiseTimeSpeed']
        },
        {
          name: 'domain-warping',
          label: 'Domain Warping (Wisps)',
          type: 'inline',
          separator: false,
          parameters: ['domainWarpEnabled', 'domainWarpStrength', 'domainWarpScale', 'domainWarpSpeed', 'domainWarpTimeOffsetY']
        },
        {
          name: 'shadow-settings',
          label: 'Cloud Shadows',
          type: 'inline',
          separator: true,
          parameters: ['shadowOpacity', 'shadowSoftness', 'shadowOffsetScale', 'minShadowBrightness']
        },
        {
          name: 'cloud-tops',
          label: 'Cloud Tops (Zoom)',
          type: 'inline',
          separator: true,
          parameters: ['cloudTopMode', 'cloudTopOpacity', 'cloudTopFadeStart', 'cloudTopFadeEnd', 'cloudBrightness']
        },
        {
          name: 'cloud-top-shading',
          label: 'Cloud Top Shading',
          type: 'inline',
          separator: false,
          parameters: ['cloudTopShadingEnabled', 'cloudTopShadingStrength', 'cloudTopNormalStrength', 'cloudTopAOIntensity', 'cloudTopEdgeHighlight']
        },
        {
          name: 'cloud-top-peaks',
          label: 'Cloud Top Peaks',
          type: 'inline',
          separator: false,
          parameters: ['cloudTopPeakDetailEnabled', 'cloudTopPeakDetailStrength', 'cloudTopPeakDetailScale', 'cloudTopPeakDetailSpeed', 'cloudTopPeakDetailStart', 'cloudTopPeakDetailEnd']
        },
        {
          name: 'cloud-top-composite',
          label: 'Cloud Top Composite',
          type: 'inline',
          separator: false,
          parameters: ['cloudTopSoftKnee']
        },
        {
          name: 'wind',
          label: 'Wind & Drift',
          type: 'inline',
          separator: true,
          parameters: ['windInfluence', 'driftSpeed', 'minDriftSpeed', 'driftResponsiveness', 'driftMaxSpeed']
        },
        {
          name: 'layer-base',
          label: 'Cloud Layers (Base)',
          type: 'inline',
          separator: true,
          parameters: ['layerParallaxBase']
        },
        {
          name: 'layer-1',
          label: 'Layer 1',
          type: 'folder',
          expanded: false,
          separator: false,
          parameters: ['layer1Enabled', 'layer1Opacity', 'layer1Scale', 'layer1Coverage', 'layer1ParallaxMult', 'layer1SpeedMult', 'layer1DirDeg']
        },
        {
          name: 'layer-2',
          label: 'Layer 2',
          type: 'folder',
          expanded: false,
          separator: false,
          parameters: ['layer2Enabled', 'layer2Opacity', 'layer2Scale', 'layer2Coverage', 'layer2ParallaxMult', 'layer2SpeedMult', 'layer2DirDeg']
        },
        {
          name: 'layer-3',
          label: 'Layer 3 (Main)',
          type: 'folder',
          expanded: false,
          separator: false,
          parameters: ['layer3Enabled', 'layer3Opacity', 'layer3Scale', 'layer3Coverage', 'layer3ParallaxMult', 'layer3SpeedMult', 'layer3DirDeg']
        },
        {
          name: 'layer-4',
          label: 'Layer 4',
          type: 'folder',
          expanded: false,
          separator: false,
          parameters: ['layer4Enabled', 'layer4Opacity', 'layer4Scale', 'layer4Coverage', 'layer4ParallaxMult', 'layer4SpeedMult', 'layer4DirDeg']
        },
        {
          name: 'layer-5',
          label: 'Layer 5',
          type: 'folder',
          expanded: false,
          separator: false,
          parameters: ['layer5Enabled', 'layer5Opacity', 'layer5Scale', 'layer5Coverage', 'layer5ParallaxMult', 'layer5SpeedMult', 'layer5DirDeg']
        }
      ],
      parameters: {
        noiseScale: {
          type: 'slider',
          label: 'Cloud Scale',
          min: 0.5,
          max: 8.0,
          step: 0.1,
          default: 0.5
        },
        noiseDetail: {
          type: 'slider',
          label: 'Detail (Octaves)',
          min: 1,
          max: 6,
          step: 1,
          default: 4
        },
        cloudSharpness: {
          type: 'slider',
          label: 'Edge Sharpness',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.0
        },
        noiseTimeSpeed: {
          type: 'slider',
          label: 'Internal Motion',
          min: 0.0,
          max: 0.05,
          step: 0.001,
          default: 0.011
        },
        domainWarpEnabled: {
          type: 'boolean',
          label: 'Enabled',
          default: true
        },
        domainWarpStrength: {
          type: 'slider',
          label: 'Strength',
          min: 0.0,
          max: 0.5,
          step: 0.005,
          default: 0.005
        },
        domainWarpScale: {
          type: 'slider',
          label: 'Warp Scale',
          min: 0.25,
          max: 10.0,
          step: 0.05,
          default: 1.05
        },
        domainWarpSpeed: {
          type: 'slider',
          label: 'Warp Speed',
          min: 0.0,
          max: 0.5,
          step: 0.005,
          default: 0.115
        },
        domainWarpTimeOffsetY: {
          type: 'slider',
          label: 'Y Offset',
          min: 0.0,
          max: 10.0,
          step: 0.1,
          default: 10.0
        },
        shadowOpacity: {
          type: 'slider',
          label: 'Shadow Darkness',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.7
        },
        shadowSoftness: {
          type: 'slider',
          label: 'Shadow Softness',
          min: 0.5,
          max: 10.0,
          step: 0.1,
          default: 0.9
        },
        shadowOffsetScale: {
          type: 'slider',
          label: 'Shadow Offset',
          min: 0.0,
          max: 0.3,
          step: 0.01,
          default: 0.3
        },
        minShadowBrightness: {
          type: 'slider',
          label: 'Min Brightness',
          min: 0.0,
          max: 0.5,
          step: 0.01,
          default: 0.0
        },
        cloudTopMode: {
          type: 'list',
          label: 'Cloud Top Mode',
          options: {
            'Outdoors Only': 'outdoorsOnly',
            'Above Everything (Fade Mask)': 'aboveEverything'
          },
          default: 'aboveEverything'
        },
        cloudTopOpacity: {
          type: 'slider',
          label: 'Cloud Top Opacity',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 1.0
        },
        cloudTopFadeStart: {
          type: 'slider',
          label: 'Fade Start Zoom',
          min: 0.1,
          max: 1.0,
          step: 0.01,
          default: 0.24
        },
        cloudTopFadeEnd: {
          type: 'slider',
          label: 'Fade End Zoom',
          min: 0.1,
          max: 1.0,
          step: 0.01,
          default: 0.39
        },
        windInfluence: {
          type: 'slider',
          label: 'Wind Influence',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.33
        },
        driftSpeed: {
          type: 'slider',
          label: 'Drift Speed',
          min: 0.0,
          max: 0.1,
          step: 0.001,
          default: 0.01
        },
        minDriftSpeed: {
          type: 'slider',
          label: 'Min Drift Speed',
          min: 0.0,
          max: 0.05,
          step: 0.0005,
          default: 0.002
        },
        driftResponsiveness: {
          type: 'slider',
          label: 'Responsiveness',
          min: 0.1,
          max: 10.0,
          step: 0.1,
          default: 0.4
        },
        driftMaxSpeed: {
          type: 'slider',
          label: 'Max Speed',
          min: 0.0,
          max: 0.5,
          step: 0.01,
          default: 0.5
        },
        layerParallaxBase: {
          type: 'slider',
          label: 'Base Parallax',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 1.0
        },
        layer1Enabled: { type: 'boolean', label: 'Enabled', default: true },
        layer1Opacity: { type: 'slider', label: 'Opacity', min: 0.0, max: 1.0, step: 0.01, default: 0.35 },
        layer1Scale: { type: 'slider', label: 'Scale Mult', min: 0.25, max: 3.0, step: 0.01, default: 1.34 },
        layer1Coverage: { type: 'slider', label: 'Coverage Mult', min: 0.0, max: 2.0, step: 0.01, default: 0.33 },
        layer1ParallaxMult: { type: 'slider', label: 'Parallax Mult', min: 0.0, max: 2.5, step: 0.01, default: 0.0 },
        layer1SpeedMult: { type: 'slider', label: 'Speed Mult', min: 0.0, max: 2.0, step: 0.01, default: 0.99 },
        layer1DirDeg: { type: 'slider', label: 'Direction Offset (deg)', min: -10.0, max: 10.0, step: 0.1, default: -1.7 },

        layer2Enabled: { type: 'boolean', label: 'Enabled', default: true },
        layer2Opacity: { type: 'slider', label: 'Opacity', min: 0.0, max: 1.0, step: 0.01, default: 0.7 },
        layer2Scale: { type: 'slider', label: 'Scale Mult', min: 0.25, max: 3.0, step: 0.01, default: 1.22 },
        layer2Coverage: { type: 'slider', label: 'Coverage Mult', min: 0.0, max: 2.0, step: 0.01, default: 0.57 },
        layer2ParallaxMult: { type: 'slider', label: 'Parallax Mult', min: 0.0, max: 2.5, step: 0.01, default: 0.0 },
        layer2SpeedMult: { type: 'slider', label: 'Speed Mult', min: 0.0, max: 2.0, step: 0.01, default: 1.07 },
        layer2DirDeg: { type: 'slider', label: 'Direction Offset (deg)', min: -10.0, max: 10.0, step: 0.1, default: -0.86 },

        layer3Enabled: { type: 'boolean', label: 'Enabled', default: true },
        layer3Opacity: { type: 'slider', label: 'Opacity', min: 0.0, max: 1.0, step: 0.01, default: 0.19 },
        layer3Scale: { type: 'slider', label: 'Scale Mult', min: 0.25, max: 3.0, step: 0.01, default: 3.0 },
        layer3Coverage: { type: 'slider', label: 'Coverage Mult', min: 0.0, max: 2.0, step: 0.01, default: 0.9 },
        layer3ParallaxMult: { type: 'slider', label: 'Parallax Mult', min: 0.0, max: 2.5, step: 0.01, default: 0.0 },
        layer3SpeedMult: { type: 'slider', label: 'Speed Mult', min: 0.0, max: 2.0, step: 0.01, default: 0.94 },
        layer3DirDeg: { type: 'slider', label: 'Direction Offset (deg)', min: -10.0, max: 10.0, step: 0.1, default: 0.0 },

        layer4Enabled: { type: 'boolean', label: 'Enabled', default: true },
        layer4Opacity: { type: 'slider', label: 'Opacity', min: 0.0, max: 1.0, step: 0.01, default: 0.17 },
        layer4Scale: { type: 'slider', label: 'Scale Mult', min: 0.25, max: 3.0, step: 0.01, default: 1.72 },
        layer4Coverage: { type: 'slider', label: 'Coverage Mult', min: 0.0, max: 2.0, step: 0.01, default: 0.46 },
        layer4ParallaxMult: { type: 'slider', label: 'Parallax Mult', min: 0.0, max: 2.5, step: 0.01, default: 0.0 },
        layer4SpeedMult: { type: 'slider', label: 'Speed Mult', min: 0.0, max: 2.0, step: 0.01, default: 0.94 },
        layer4DirDeg: { type: 'slider', label: 'Direction Offset (deg)', min: -10.0, max: 10.0, step: 0.1, default: 0.86 },

        layer5Enabled: { type: 'boolean', label: 'Enabled', default: true },
        layer5Opacity: { type: 'slider', label: 'Opacity', min: 0.0, max: 1.0, step: 0.01, default: 0.13 },
        layer5Scale: { type: 'slider', label: 'Scale Mult', min: 0.25, max: 3.0, step: 0.01, default: 1.52 },
        layer5Coverage: { type: 'slider', label: 'Coverage Mult', min: 0.0, max: 2.0, step: 0.01, default: 0.62 },
        layer5ParallaxMult: { type: 'slider', label: 'Parallax Mult', min: 0.0, max: 2.5, step: 0.01, default: 0.0 },
        layer5SpeedMult: { type: 'slider', label: 'Speed Mult', min: 0.0, max: 2.0, step: 0.01, default: 1.07 },
        layer5DirDeg: { type: 'slider', label: 'Direction Offset (deg)', min: -10.0, max: 10.0, step: 0.1, default: -0.6 },
        cloudBrightness: {
          type: 'slider',
          label: 'Cloud Brightness',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.01
        },
        cloudTopShadingEnabled: {
          type: 'boolean',
          label: 'Enable Shading',
          default: true
        },
        cloudTopShadingStrength: {
          type: 'slider',
          label: 'Shading Strength',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 0.99
        },
        cloudTopNormalStrength: {
          type: 'slider',
          label: 'Normal Strength',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 0.96
        },
        cloudTopAOIntensity: {
          type: 'slider',
          label: 'AO Intensity',
          min: 0.0,
          max: 4.0,
          step: 0.05,
          default: 2.0
        },
        cloudTopEdgeHighlight: {
          type: 'slider',
          label: 'Edge Highlight',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 0.0
        },

        cloudTopPeakDetailEnabled: {
          type: 'boolean',
          label: 'Enable Peaks',
          default: false
        },
        cloudTopPeakDetailStrength: {
          type: 'slider',
          label: 'Peak Strength',
          min: 0.0,
          max: 0.5,
          step: 0.01,
          default: 0.32
        },
        cloudTopPeakDetailScale: {
          type: 'slider',
          label: 'Peak Scale',
          min: 1.0,
          max: 200.0,
          step: 0.5,
          default: 92.5
        },
        cloudTopPeakDetailSpeed: {
          type: 'slider',
          label: 'Peak Speed',
          min: 0.0,
          max: 0.5,
          step: 0.01,
          default: 0.08
        },
        cloudTopPeakDetailStart: {
          type: 'slider',
          label: 'Peak Start',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.14
        },
        cloudTopPeakDetailEnd: {
          type: 'slider',
          label: 'Peak End',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.82
        },
        cloudTopSoftKnee: {
          type: 'slider',
          label: 'Soft Knee',
          min: 0.0,
          max: 10.0,
          step: 0.1,
          default: 1.8
        }
      }
    };
  }

  initialize(renderer, scene, camera) {
    const THREE = window.THREE;
    if (!THREE) {
      log.error('THREE not available during initialization');
      return;
    }

    this.renderer = renderer;
    this.mainScene = scene;
    this.mainCamera = camera;

    // Initialize wind offset
    this._windOffset = new THREE.Vector2(0, 0);
    this._windVelocity = new THREE.Vector2(0, 0);

    // Initialize multi-layer wind offsets
    this._layerWindOffsets = [
      new THREE.Vector2(0, 0),
      new THREE.Vector2(0, 0),
      new THREE.Vector2(0, 0),
      new THREE.Vector2(0, 0),
      new THREE.Vector2(0, 0)
    ];

    // PERF: Flat uniform array for uLayerWindOffsets (vec2[5]) to avoid Three.js flatten()
    // repeatedly calling Vector2.toArray during uploads.
    this._layerWindOffsetsFlat = new Float32Array(10);

    this._layerWindVelocities = [
      new THREE.Vector2(0, 0),
      new THREE.Vector2(0, 0),
      new THREE.Vector2(0, 0),
      new THREE.Vector2(0, 0),
      new THREE.Vector2(0, 0)
    ];

    this._tempVec2A = new THREE.Vector2();
    this._tempVec2B = new THREE.Vector2();

    this._tintNight = new THREE.Vector3(0.13, 0.15, 0.2);
    this._tintSunrise = new THREE.Vector3(1.0, 0.7, 0.5);
    this._tintDay = new THREE.Vector3(1.0, 1.0, 1.0);
    this._tintSunset = new THREE.Vector3(1.0, 0.6, 0.4);
    this._tintResult = new THREE.Vector3(1.0, 1.0, 1.0);

    // Create quad scene for full-screen passes
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // Create cloud density material with procedural noise
    this._createDensityMaterial();

    // Create shadow material (samples density with offset + blur)
    this._createShadowMaterial();

    // Create cloud top material (visible cloud layer with zoom fade)
    this._createCloudTopMaterial();

    // Create quad mesh
    const quadGeometry = new THREE.PlaneGeometry(2, 2);
    this.quadMesh = new THREE.Mesh(quadGeometry, this.densityMaterial);
    this.quadScene.add(this.quadMesh);

    // Cloud tops overlay quad: rendered in OVERLAY_THREE_LAYER so it is never
    // included in the post-processing chain (prevents water distortion affecting clouds).
    this.cloudTopOverlayMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tCloudTop: { value: null }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tCloudTop;
        varying vec2 vUv;
        void main() {
          gl_FragColor = texture2D(tCloudTop, vUv);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending
    });

    this.cloudTopOverlayMesh = new THREE.Mesh(quadGeometry, this.cloudTopOverlayMaterial);
    this.cloudTopOverlayMesh.layers.set(OVERLAY_THREE_LAYER);
    this.cloudTopOverlayMesh.renderOrder = 2000;
    this.cloudTopOverlayMesh.frustumCulled = false;
    this.cloudTopOverlayMesh.visible = false;
    if (this.mainScene) this.mainScene.add(this.cloudTopOverlayMesh);

    log.info('CloudEffect initialized');
  }

  /**
   * Create the cloud density generation material.
   * Uses layered simplex noise for natural cloud shapes.
   * @private
   */

  _createDensityMaterial() {
    const THREE = window.THREE;

    this.densityMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0.0 },
        uCloudCover: { value: this.params.cloudCover },
        uNoiseScale: { value: this.params.noiseScale },
        uNoiseDetail: { value: this.params.noiseDetail },
        uCloudSharpness: { value: this.params.cloudSharpness },
        uNoiseTimeSpeed: { value: this.params.noiseTimeSpeed },
        uDomainWarpEnabled: { value: this.params.domainWarpEnabled ? 1.0 : 0.0 },
        uDomainWarpStrength: { value: this.params.domainWarpStrength },
        uDomainWarpScale: { value: this.params.domainWarpScale },
        uDomainWarpSpeed: { value: this.params.domainWarpSpeed },
        uDomainWarpTimeOffsetY: { value: this.params.domainWarpTimeOffsetY },
        // NOTE: Use flat Float32Array so setValueV2fArray can skip flatten() entirely.
        uLayerWindOffsets: { value: this._layerWindOffsetsFlat || new Float32Array(10) },
        uLayerParallax: { value: this._layerParallax },
        uLayerCoverMult: { value: this._layerCoverMult },
        uLayerNoiseScaleMult: { value: this._layerNoiseScaleMult },
        uLayerWeight: { value: this._layerWeight },
        // 0.0 = no parallax (world-pinned density for shadows), 1.0 = full parallax (cloud tops)
        uParallaxScale: { value: 0.0 },
        // 0.0 = union blend (good for total occlusion), 1.0 = summed blend (helps layers read separately)
        uCompositeMode: { value: 0.0 },
        // Soft-knee saturation applied ONLY in compositeMode=1 for cloud-top packed density.
        // Higher values approach 1.0 faster; 0 disables.
        uCompositeSoftKnee: { value: this.params.cloudTopSoftKnee },
        // When enabled, discard pixels outside the scene rect.
        // NOTE: Disabled for shadow density generation so sun-offset shadows have valid off-map samples.
        uClipToScene: { value: 0.0 },
        uResolution: { value: new THREE.Vector2(1024, 1024) },

        // World-space coordinate conversion (view bounds in world coords)
        uViewBoundsMin: { value: new THREE.Vector2(0, 0) },
        uViewBoundsMax: { value: new THREE.Vector2(1, 1) },
        // Scene rect (EXCLUDES padding): world origin + size
        uSceneOrigin: { value: new THREE.Vector2(0, 0) },
        uSceneSize: { value: new THREE.Vector2(1, 1) }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
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
        uniform vec2 uLayerWindOffsets[5];
        uniform float uLayerParallax[5];
        uniform float uLayerCoverMult[5];
        uniform float uLayerNoiseScaleMult[5];
        uniform float uLayerWeight[5];
        uniform float uParallaxScale;
        uniform float uCompositeMode;
        uniform float uCompositeSoftKnee;
        uniform float uClipToScene;
        uniform vec2 uResolution;
        uniform vec2 uViewBoundsMin;
        uniform vec2 uViewBoundsMax;
        uniform vec2 uSceneOrigin;
        uniform vec2 uSceneSize;

        varying vec2 vUv;

        // Simplex 2D noise
        vec3 permute(vec3 x) { return mod(((x*34.0)+1.0)*x, 289.0); }

        float snoise(vec2 v) {
          const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                             -0.577350269189626, 0.024390243902439);
          vec2 i  = floor(v + dot(v, C.yy));
          vec2 x0 = v - i + dot(i, C.xx);
          vec2 i1;
          i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
          vec4 x12 = x0.xyxy + C.xxzz;
          x12.xy -= i1;
          i = mod(i, 289.0);
          vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                         + i.x + vec3(0.0, i1.x, 1.0));
          vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy),
                                  dot(x12.zw,x12.zw)), 0.0);
          m = m*m;
          m = m*m;
          vec3 x = 2.0 * fract(p * C.www) - 1.0;
          vec3 h = abs(x) - 0.5;
          vec3 ox = floor(x + 0.5);
          vec3 a0 = x - ox;
          m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
          vec3 g;
          g.x = a0.x * x0.x + h.x * x0.y;
          g.yz = a0.yz * x12.xz + h.yz * x12.yw;
          return 130.0 * dot(m, g);
        }

        // Fractal Brownian Motion (layered noise)
        float fbm(vec2 p, int octaves) {
          float value = 0.0;
          float amplitude = 0.5;
          float frequency = 1.0;
          float maxValue = 0.0;

          for (int i = 0; i < 6; i++) {
            if (i >= octaves) break;
            value += amplitude * snoise(p * frequency);
            maxValue += amplitude;
            amplitude *= 0.5;
            frequency *= 2.0;
          }

          return value / maxValue;
        }

        float sampleLayer(vec2 baseWorldPos, vec2 cameraPinnedPos, int layerIndex, int octaves) {
          float parallax = uLayerParallax[layerIndex] * uParallaxScale;
          vec2 layerWorldPos = mix(baseWorldPos, cameraPinnedPos, parallax);

          if (uClipToScene > 0.5) {
            vec2 sceneMin = uSceneOrigin;
            vec2 sceneMax = uSceneOrigin + uSceneSize;
            layerWorldPos = clamp(layerWorldPos, sceneMin, sceneMax);
          }

          float w = max(uSceneSize.x, 1.0);
          float h = max(uSceneSize.y, 1.0);
          float s = min(w, h);
          vec2 aspect = vec2(w / s, h / s);

          vec2 layerUV = ((layerWorldPos - uSceneOrigin) / uSceneSize) * aspect;
          layerUV += uLayerWindOffsets[layerIndex] * aspect;

          // Domain warping for wispy/swirly clouds
          float time = uTime * uDomainWarpSpeed;
          vec2 warpUV = layerUV * uDomainWarpScale;
          vec2 warp = vec2(
            snoise(warpUV + vec2(time, 0.0)),
            snoise(warpUV + vec2(0.0, time + uDomainWarpTimeOffsetY))
          );
          warp *= step(0.5, uDomainWarpEnabled);

          float wispStrength = uDomainWarpStrength;
          vec2 noiseUV = layerUV * (uNoiseScale * uLayerNoiseScaleMult[layerIndex]);
          noiseUV += warp * wispStrength;

          float noise = fbm(noiseUV * 4.0 + vec2(uTime * uNoiseTimeSpeed), octaves);
          noise = noise * 0.5 + 0.5;

          float cover = clamp(uCloudCover * uLayerCoverMult[layerIndex], 0.0, 1.0);
          float threshold = 1.0 - cover;
          float cloud = smoothstep(threshold - 0.1, threshold + 0.1, noise);

          float sharpMix = uCloudSharpness;
          float softCloud = cloud;
          float hardCloud = step(threshold, noise);
          cloud = mix(softCloud, hardCloud, sharpMix);

          return clamp(cloud * uLayerWeight[layerIndex], 0.0, 1.0);
        }

        void main() {
          vec2 viewSize = uViewBoundsMax - uViewBoundsMin;

          // Pinned-to-world position (no parallax)
          vec2 baseWorldPos = mix(uViewBoundsMin, uViewBoundsMax, vUv);

          // Clip clouds to the actual scene rect (exclude padding)
          vec2 sceneMax = uSceneOrigin + uSceneSize;
          if (uClipToScene > 0.5) {
            if (baseWorldPos.x < uSceneOrigin.x || baseWorldPos.y < uSceneOrigin.y ||
                baseWorldPos.x > sceneMax.x || baseWorldPos.y > sceneMax.y) {
              gl_FragColor = vec4(0.0);
              return;
            }
          }

          // Pinned-to-camera/screen position (full parallax)
          // Uses scene center as reference so this stays stable as the camera pans.
          vec2 cameraPinnedPos = (uSceneOrigin + 0.5 * uSceneSize) + (vUv - 0.5) * viewSize;

          int octaves = int(uNoiseDetail);

          float l0 = sampleLayer(baseWorldPos, cameraPinnedPos, 0, octaves);
          float l1 = sampleLayer(baseWorldPos, cameraPinnedPos, 1, octaves);
          float l2 = sampleLayer(baseWorldPos, cameraPinnedPos, 2, octaves);
          float l3 = sampleLayer(baseWorldPos, cameraPinnedPos, 3, octaves);
          float l4 = sampleLayer(baseWorldPos, cameraPinnedPos, 4, octaves);

          float composite = 0.0;
          if (uCompositeMode < 0.5) {
            // Union blend so multiple layers contribute instead of collapsing to the max.
            // Good for “total occlusion” (shadows).
            float inv = 1.0;
            inv *= (1.0 - l0);
            inv *= (1.0 - l1);
            inv *= (1.0 - l2);
            inv *= (1.0 - l3);
            inv *= (1.0 - l4);
            composite = clamp(1.0 - inv, 0.0, 1.0);
          } else {
            // Summed blend reads more like stacked layers (helps parallax/direction differences show).
            float x = (l0 + l1 + l2 + l3 + l4) / 2.0;
            // Soft-knee saturation prevents hard 1.0 plateaus when layers stack.
            // As x increases, composite approaches 1.0 asymptotically.
            float k = max(0.0, uCompositeSoftKnee);
            if (k > 1e-5) composite = 1.0 - exp(-k * max(0.0, x));
            else composite = clamp(x, 0.0, 1.0);
            composite = clamp(composite, 0.0, 1.0);
          }

          // Output format:
          // - Shadows/world density: grayscale in RGB, alpha=1
          // - Cloud tops density: RGB = mid/inner/outer bands, A = composite for alpha + shading
          if (uCompositeMode < 0.5) {
            gl_FragColor = vec4(composite, composite, composite, 1.0);
          } else {
            float inner = max(l1, l3);
            float outer = max(l0, l4);
            gl_FragColor = vec4(l2, inner, outer, composite);
          }
        }
      `,
      depthWrite: false,
      depthTest: false
    });
  }

  /**
   * Create the shadow generation material.
   * Samples cloud density with sun-direction offset and applies blur.
   * @private
   */
  _createShadowMaterial() {
    const THREE = window.THREE;

    this.shadowMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tCloudDensity: { value: null },
        // 0.0 = grayscale density in RGB with alpha=1 (cloudDensityTarget)
        // 1.0 = packed bands in RGB with composite density in alpha (cloudTopDensityTarget)
        uDensityMode: { value: 0.0 },
        tOutdoorsMask: { value: null },
        uHasOutdoorsMask: { value: 0.0 },
        uShadowOpacity: { value: this.params.shadowOpacity },
        uShadowSoftness: { value: this.params.shadowSoftness },
        uTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        uZoom: { value: 1.0 },
        uMinBrightness: { value: this.params.minShadowBrightness },
        // Sun offset for shadow displacement (in WORLD space)
        uShadowOffsetWorld: { value: new THREE.Vector2(0, 0) },

        uViewBoundsMin: { value: new THREE.Vector2(0, 0) },
        uViewBoundsMax: { value: new THREE.Vector2(1, 1) },
        uSceneOrigin: { value: new THREE.Vector2(0, 0) },
        uSceneSize: { value: new THREE.Vector2(1, 1) },

        // The world-space bounds that the density texture covers.
        // For shadows we render an overscanned density so offset+blur never samples out of range.
        uDensityBoundsMin: { value: new THREE.Vector2(0, 0) },
        uDensityBoundsMax: { value: new THREE.Vector2(1, 1) },

        // Per-tile blocker mask: 1.0 means this pixel should NOT receive cloud shadows
        tBlockerMask: { value: null },
        uHasBlockerMask: { value: 0.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tCloudDensity;
        uniform float uDensityMode;
        uniform sampler2D tOutdoorsMask;
        uniform float uHasOutdoorsMask;
        uniform float uShadowOpacity;
        uniform float uShadowSoftness;
        uniform vec2 uTexelSize;
        uniform float uZoom;
        uniform float uMinBrightness;
        uniform vec2 uShadowOffsetWorld;

        uniform vec2 uViewBoundsMin;
        uniform vec2 uViewBoundsMax;
        uniform vec2 uSceneOrigin;
        uniform vec2 uSceneSize;

        uniform vec2 uDensityBoundsMin;
        uniform vec2 uDensityBoundsMax;

        uniform sampler2D tBlockerMask;
        uniform float uHasBlockerMask;

        varying vec2 vUv;

        float readDensity(vec2 uv) {
          vec4 t = texture2D(tCloudDensity, uv);
          return (uDensityMode < 0.5) ? t.r : t.a;
        }

        void main() {
          vec2 baseWorldPos = mix(uViewBoundsMin, uViewBoundsMax, vUv);
          vec2 sceneMax = uSceneOrigin + uSceneSize;
          if (baseWorldPos.x < uSceneOrigin.x || baseWorldPos.y < uSceneOrigin.y ||
              baseWorldPos.x > sceneMax.x || baseWorldPos.y > sceneMax.y) {
            gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
            return;
          }

          // Sample density in WORLD space to avoid screen-space seams and wrapping artefacts.
          // Map world position into the density texture's UVs using the density bounds.
          vec2 shadowWorldPos = baseWorldPos + uShadowOffsetWorld;
          vec2 densitySize = max(uDensityBoundsMax - uDensityBoundsMin, vec2(1e-3));
          vec2 shadowUV = (shadowWorldPos - uDensityBoundsMin) / densitySize;
          shadowUV = clamp(shadowUV, vec2(0.0), vec2(1.0));

          // Apply blur for soft shadow edges
          // Scale blur by zoom so softness is consistent in world space
          float blurPixels = uShadowSoftness * 20.0 * uZoom;
          vec2 stepUv = uTexelSize * blurPixels;

          float accum = 0.0;
          float weightSum = 0.0;

          // 3x3 blur kernel - sample around the OFFSET position
          for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
              vec2 sUv = clamp(shadowUV + vec2(float(dx), float(dy)) * stepUv, vec2(0.0), vec2(1.0));
              float w = 1.0;
              if (dx == 0 && dy == 0) w = 2.0; // Center bias
              float v = readDensity(sUv);
              accum += v * w;
              weightSum += w;
            }
          }

          float blurredDensity = accum / max(weightSum, 0.001);

          // Calculate shadow factor (1.0 = fully lit, 0.0 = fully shadowed)
          float shadowStrength = blurredDensity * uShadowOpacity;
          float shadowFactor = 1.0 - shadowStrength;

          // Apply minimum brightness floor to prevent crushing blacks
          shadowFactor = max(shadowFactor, uMinBrightness);

          // Apply outdoors mask LAST (after blur) to prevent bleeding into interiors
          if (uHasOutdoorsMask > 0.5) {
            float outdoors = texture2D(tOutdoorsMask, vUv).r;
            // Only apply shadow outdoors; indoors get full brightness (1.0)
            shadowFactor = mix(1.0, shadowFactor, outdoors);
          }

          // Apply per-tile blocker mask: blocked pixels always receive full brightness.
          if (uHasBlockerMask > 0.5) {
            float b = texture2D(tBlockerMask, vUv).a;
            shadowFactor = mix(shadowFactor, 1.0, clamp(b, 0.0, 1.0));
          }

          gl_FragColor = vec4(shadowFactor, shadowFactor, shadowFactor, 1.0);
        }
      `,
      depthWrite: false,
      depthTest: false
    });
  }

  /**
   * Create the cloud top material.
   * Renders cloud density as a visible white overlay with zoom-based fade.
   * Uses normalized zoom (0-1 range based on zoom limits) for map-size independence.
   * @private
   */
  _createCloudTopMaterial() {
    const THREE = window.THREE;

    this.cloudTopMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tCloudDensity: { value: null },
        // 0.0 = grayscale density in RGB with alpha=1 (cloudDensityTarget)
        // 1.0 = packed bands in RGB with composite density in alpha (cloudTopDensityTarget)
        uDensityMode: { value: 1.0 },
        uTime: { value: 0.0 },
        tOutdoorsMask: { value: null },
        uHasOutdoorsMask: { value: 0.0 },
        uOutdoorsMaskStrength: { value: 1.0 },
        uCloudTopOpacity: { value: this.params.cloudTopOpacity },
        uNormalizedZoom: { value: 0.5 },
        uFadeStart: { value: this.params.cloudTopFadeStart },
        uFadeEnd: { value: this.params.cloudTopFadeEnd },
        uCloudColor: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
        uSkyTint: { value: new THREE.Vector3(0.9, 0.95, 1.0) },
        uTimeOfDayTint: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
        uTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        uSunDir: { value: new THREE.Vector2(0.0, 1.0) },
        uCloudBrightness: { value: this.params.cloudBrightness },
        uShadingEnabled: { value: 1.0 },
        uShadingStrength: { value: 1.0 },
        uNormalStrength: { value: 1.0 },
        uAOIntensity: { value: 1.0 },
        uEdgeHighlight: { value: 1.0 },

        uPeakDetailEnabled: { value: 1.0 },
        uPeakDetailStrength: { value: this.params.cloudTopPeakDetailStrength },
        uPeakDetailScale: { value: this.params.cloudTopPeakDetailScale },
        uPeakDetailSpeed: { value: this.params.cloudTopPeakDetailSpeed },
        uPeakDetailStart: { value: this.params.cloudTopPeakDetailStart },
        uPeakDetailEnd: { value: this.params.cloudTopPeakDetailEnd },

        // Per-tile blocker mask: 1.0 means this pixel should NOT receive cloud tops
        tBlockerMask: { value: null },
        uHasBlockerMask: { value: 0.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tCloudDensity;
        uniform float uDensityMode;
        uniform float uTime;
        uniform sampler2D tOutdoorsMask;
        uniform float uHasOutdoorsMask;
        uniform float uOutdoorsMaskStrength;
        uniform float uCloudTopOpacity;
        uniform float uNormalizedZoom;
        uniform float uFadeStart;
        uniform float uFadeEnd;
        uniform vec3 uCloudColor;
        uniform vec3 uSkyTint;
        uniform vec3 uTimeOfDayTint;
        uniform vec2 uTexelSize;
        uniform vec2 uSunDir;
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

        uniform sampler2D tBlockerMask;
        uniform float uHasBlockerMask;

        varying vec2 vUv;

        float fbm2D(vec2 p);

        float applyPeakDetail(vec2 uv, float d) {
          float peakMask = smoothstep(uPeakDetailStart, uPeakDetailEnd, d);
          float n = fbm2D(uv * uPeakDetailScale + vec2(uTime * uPeakDetailSpeed));
          n = n * 2.0 - 1.0;
          return clamp(d + n * uPeakDetailStrength * peakMask, 0.0, 1.0);
        }

        float readDensity(vec2 uv) {
          vec4 t = texture2D(tCloudDensity, uv);
          float d = (uDensityMode < 0.5) ? t.r : t.a;
          if (uPeakDetailEnabled > 0.5) {
            d = applyPeakDetail(uv, d);
          }
          return d;
        }

        float hash21(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        float noise2D(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
        }

        float fbm2D(vec2 p) {
          float v = 0.0;
          float a = 0.5;
          for (int i = 0; i < 4; i++) {
            v += a * noise2D(p);
            p *= 2.02;
            a *= 0.5;
          }
          return v;
        }

        vec3 shadeCloud(vec2 uv, float density, vec3 baseColor) {
          // Density gradient (treat density as a heightfield)
          float dN = readDensity(uv + vec2(0.0,  uTexelSize.y));
          float dS = readDensity(uv + vec2(0.0, -uTexelSize.y));
          float dE = readDensity(uv + vec2( uTexelSize.x, 0.0));
          float dW = readDensity(uv + vec2(-uTexelSize.x, 0.0));

          vec2 grad = vec2(dE - dW, dN - dS);
          float gradMag = length(grad);

          vec3 n = normalize(vec3(-grad.x * 4.0 * uNormalStrength, -grad.y * 4.0 * uNormalStrength, 1.0));
          vec3 l = normalize(vec3(uSunDir.x, uSunDir.y, 0.35));

          float ndotl = clamp(dot(n, l), 0.0, 1.0);

          // Gentle puffy shading
          float shade = mix(0.65, 1.3, ndotl);
          shade = mix(1.0, shade, clamp(uShadingStrength, 0.0, 2.0));

          float dN2 = readDensity(uv + vec2(0.0,  uTexelSize.y * 6.0));
          float dS2 = readDensity(uv + vec2(0.0, -uTexelSize.y * 6.0));
          float dE2 = readDensity(uv + vec2( uTexelSize.x * 6.0, 0.0));
          float dW2 = readDensity(uv + vec2(-uTexelSize.x * 6.0, 0.0));

          float avgLocal = 0.25 * (dN + dS + dE + dW);
          float avgWide = 0.25 * (dN2 + dS2 + dE2 + dW2);
          float cavity = max(0.0, 0.55 * (avgLocal - density) + 0.45 * (avgWide - density));

          float macro = smoothstep(0.0, 0.05, cavity);
          macro = pow(macro, 0.75);
          float dN3 = readDensity(uv + vec2(0.0,  uTexelSize.y * 2.0));
          float dS3 = readDensity(uv + vec2(0.0, -uTexelSize.y * 2.0));
          float dE3 = readDensity(uv + vec2( uTexelSize.x * 2.0, 0.0));
          float dW3 = readDensity(uv + vec2(-uTexelSize.x * 2.0, 0.0));
          float avgMicro = 0.25 * (dN3 + dS3 + dE3 + dW3);
          float micro = abs(avgMicro - density);
          float fuzzCavity = smoothstep(0.0, 0.06, micro + cavity * 0.35);

          float aoStrength = clamp(uAOIntensity / 2.0, 0.0, 1.0);
          float aoTerm = (0.60 * macro + 0.40 * fuzzCavity);
          float ao = 1.0 - aoStrength * aoTerm * 0.9;
          ao = clamp(ao, 0.45, 1.10);

          // Sun-facing edge highlight
          vec2 ld = normalize(uSunDir);
          float facing = 0.0;
          if (gradMag > 1e-5) {
            facing = clamp(dot(normalize(grad), ld), 0.0, 1.0);
          }
          float edge = smoothstep(0.03, 0.12, gradMag);
          float edgeHighlight = edge * facing * 0.25 * uEdgeHighlight;

          vec3 c = baseColor * shade * ao;
          c += edgeHighlight;
          return c;
        }

        void main() {
          // Sample cloud density (no sun offset - we want clouds directly overhead)
          vec4 densTex = texture2D(tCloudDensity, vUv);
          float density = readDensity(vUv);
          float dMid = densTex.r;
          float dInner = densTex.g;
          float dOuter = densTex.b;

          if (uDensityMode < 0.5) {
            dMid = density;
            dInner = density;
            dOuter = density;
          }

          if (uPeakDetailEnabled > 0.5) {
            float peakMask = smoothstep(uPeakDetailStart, uPeakDetailEnd, density);
            float n = fbm2D(vUv * uPeakDetailScale + vec2(uTime * uPeakDetailSpeed));
            n = n * 2.0 - 1.0;
            float d = n * uPeakDetailStrength * peakMask;
            dMid = clamp(dMid + d * 0.75, 0.0, 1.0);
            dInner = clamp(dInner + d * 0.55, 0.0, 1.0);
            dOuter = clamp(dOuter + d * 0.35, 0.0, 1.0);
          }

          // Calculate zoom-based fade
          // When zoomed OUT (low normalizedZoom), clouds are visible
          // When zoomed IN (high normalizedZoom), clouds fade out
          // This creates the effect of being "under" the clouds when zoomed in
          float zoomFade = 1.0 - smoothstep(uFadeStart, uFadeEnd, uNormalizedZoom);

          // Soft cloud edges with density threshold
          float cloudAlpha = smoothstep(0.2, 0.6, density);

          // Final alpha combines density, zoom fade, and user opacity
          float alpha = cloudAlpha * zoomFade * uCloudTopOpacity;

          // Cloud color with slight sky tint for realism, then apply time-of-day tint
          vec3 baseColor = mix(uSkyTint, uCloudColor, density * 0.5 + 0.5);

          // Multi-band weighting for a more obviously layered look
          // (mid is densest; inner/outer are lighter coverage)
          float sum = max(dMid + dInner + dOuter, 1e-3);
          vec3 layered = (
            baseColor * 1.05 * dMid +
            baseColor * 0.97 * dInner +
            baseColor * 0.90 * dOuter
          ) / sum;

          vec3 color = layered * uTimeOfDayTint;
          color *= uCloudBrightness;

          // Add top shading to give volume
          if (uShadingEnabled > 0.5) {
            color = shadeCloud(vUv, density, color);
          }

          // Apply outdoors mask - only show cloud tops outdoors
          if (uHasOutdoorsMask > 0.5) {
            float outdoors = texture2D(tOutdoorsMask, vUv).r;
            float maskStrength = clamp(uOutdoorsMaskStrength, 0.0, 1.0);
            alpha *= mix(1.0, outdoors, maskStrength);
          }

          // Apply per-tile blocker mask: blocked pixels always get zero alpha.
          if (uHasBlockerMask > 0.5) {
            vec4 bm = texture2D(tBlockerMask, vUv);
            float b = max(max(bm.r, bm.g), max(bm.b, bm.a));
            b = step(0.01, b);
            alpha *= (1.0 - b);
          }

          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending
    });
  }

  /**
   * Get effective zoom level from camera.
   * @returns {number} Zoom level (1.0 = default)
   * @private
   */
  _getEffectiveZoom() {
    const sceneComposer = window.MapShine?.sceneComposer;
    if (sceneComposer?.currentZoom !== undefined) {
      return sceneComposer.currentZoom;
    }

    if (!this.mainCamera) return 1.0;

    if (this.mainCamera.isOrthographicCamera) {
      return this.mainCamera.zoom;
    }

    const baseDist = 10000.0;
    const dist = this.mainCamera.position.z;
    return (dist > 0.1) ? (baseDist / dist) : 1.0;
  }

  /**
   * Calculate sun direction from time of day.
   * @returns {THREE.Vector2} Normalized sun direction
   * @private
   */
  _calculateSunDirection() {
    const THREE = window.THREE;
    if (!THREE) return null;

    let hour = 12.0;
    try {
      if (weatherController && typeof weatherController.timeOfDay === 'number') {
        hour = weatherController.timeOfDay;
      }
    } catch (e) {
      // Fallback to noon
    }

    // Map hour to sun azimuth (same logic as OverheadShadowsEffect)
    const t = (hour % 24.0) / 24.0;
    const azimuth = (t - 0.5) * Math.PI;

    const x = -Math.sin(azimuth);
    const y = Math.cos(azimuth) * 0.3; // Slight vertical component

    if (!this.sunDir) {
      this.sunDir = new THREE.Vector2(x, y);
    } else {
      this.sunDir.set(x, y);
    }

    return this.sunDir;
  }

  /**
   * Calculate time-of-day tint for cloud tops.
   * Clouds tint warm at sunrise/sunset, white at midday, dark blue-gray at night.
   * @returns {THREE.Vector3} RGB tint color
   * @private
   */
  _calculateTimeOfDayTint() {
    if (!this._tintResult) return null;

    let hour = 12.0;
    try {
      if (weatherController && typeof weatherController.timeOfDay === 'number') {
        hour = weatherController.timeOfDay;
      }
    } catch (e) {
      // Fallback to noon
    }

    // Normalize to [0, 24) to match clockface and other time-of-day systems.
    hour = ((hour % 24) + 24) % 24;

    const tint = this._tintResult;

    // Sunrise: 5-7 (night -> sunrise -> day)
    // Sunset:  17-19 (day -> sunset -> night)
    // Night:   19-5
    if (hour < 5 || hour >= 19) {
      tint.copy(this._tintNight);
    } else if (hour < 6) {
      const t = hour - 5;
      tint.lerpVectors(this._tintNight, this._tintSunrise, t);
    } else if (hour < 7) {
      const t = hour - 6;
      tint.lerpVectors(this._tintSunrise, this._tintDay, t);
    } else if (hour < 17) {
      tint.copy(this._tintDay);
    } else if (hour < 18) {
      const t = hour - 17;
      tint.lerpVectors(this._tintDay, this._tintSunset, t);
    } else if (hour < 19) {
      const t = hour - 18;
      tint.lerpVectors(this._tintSunset, this._tintNight, t);
    }

    return tint;
  }

  onResize(width, height) {
    const THREE = window.THREE;
    if (!width || !height || !THREE) return;

    const internal = this._getInternalRenderSize(width, height);
    const iW = internal.width;
    const iH = internal.height;

    this._lastRenderFullWidth = width;
    this._lastRenderFullHeight = height;
    this._lastInternalWidth = iW;
    this._lastInternalHeight = iH;

    // Cloud density render target
    if (!this.cloudDensityTarget) {
      this.cloudDensityTarget = new THREE.WebGLRenderTarget(iW, iH, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.cloudDensityTarget.setSize(iW, iH);
    }

    // Shadow density render target (overscanned world bounds; same resolution)
    if (!this.cloudShadowDensityTarget) {
      this.cloudShadowDensityTarget = new THREE.WebGLRenderTarget(iW, iH, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.cloudShadowDensityTarget.setSize(iW, iH);
    }

    // Cloud shadow render target
    if (!this.cloudShadowTarget) {
      this.cloudShadowTarget = new THREE.WebGLRenderTarget(iW, iH, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.cloudShadowTarget.setSize(iW, iH);
    }

    // Cloud shadow render target (UNMASKED - for indoor consumers like WindowLight)
    if (!this.cloudShadowRawTarget) {
      this.cloudShadowRawTarget = new THREE.WebGLRenderTarget(iW, iH, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.cloudShadowRawTarget.setSize(iW, iH);
    }

    // Cloud top density render target (parallaxed multi-layer density)
    if (!this.cloudTopDensityTarget) {
      this.cloudTopDensityTarget = new THREE.WebGLRenderTarget(iW, iH, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.cloudTopDensityTarget.setSize(iW, iH);
    }

    this._cloudTopDensityValid = false;

    // Cloud top render target (RGBA for alpha blending)
    if (!this.cloudTopTarget) {
      this.cloudTopTarget = new THREE.WebGLRenderTarget(iW, iH, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.cloudTopTarget.setSize(iW, iH);
    }

    // Cloud shadow blocker mask (tiles which do NOT receive cloud shadows)
    if (!this.cloudShadowBlockerTarget) {
      this.cloudShadowBlockerTarget = new THREE.WebGLRenderTarget(iW, iH, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.cloudShadowBlockerTarget.setSize(iW, iH);
    }

    // Cloud top blocker mask (tiles which do NOT receive cloud tops)
    if (!this.cloudTopBlockerTarget) {
      this.cloudTopBlockerTarget = new THREE.WebGLRenderTarget(iW, iH, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else {
      this.cloudTopBlockerTarget.setSize(iW, iH);
    }

    // Update material uniforms
    if (this.densityMaterial?.uniforms) {
      this.densityMaterial.uniforms.uResolution.value.set(iW, iH);
    }

    if (this.shadowMaterial?.uniforms) {
      this.shadowMaterial.uniforms.uTexelSize.value.set(1 / iW, 1 / iH);
    }

    if (this.cloudTopMaterial?.uniforms) {
      this.cloudTopMaterial.uniforms.uTexelSize.value.set(1 / iW, 1 / iH);
    }
  }

  /**
   * @override
   * Advance the cloud wind simulation once per render frame.
   *
   * Called by EffectComposer once per frame BEFORE the per-floor loop begins.
   * Moving all accumulative state here (_windOffset, _windVelocity,
   * _layerWindOffsets) ensures cloud drift runs at 1× frame speed regardless
   * of how many times update() is invoked per frame in the floor render loop.
   *
   * @param {TimeInfo} timeInfo
   */
  prepareFrame(timeInfo) {
    if (!this.densityMaterial || !this.shadowMaterial || !this.enabled) return;
    const weatherState = this._getEffectiveWeatherState();
    if (!weatherState.weatherEnabled || this._isCloudCoverEffectivelyZero(weatherState.cloudCover)) return;
    this._advanceWindSimulation(
      timeInfo?.delta ?? 0.016,
      weatherState.windDirX,
      weatherState.windDirY,
      weatherState.windSpeed
    );
  }

  /**
   * Advance accumulated wind state (_windOffset, _windVelocity, _layerWindOffsets,
   * _layerWindVelocities, _layerWindOffsetsFlat) by one frame delta.
   * Called from prepareFrame() — not from update() — so accumulation is 1× per frame.
   *
   * @param {number} delta - Frame delta in seconds
   * @param {number} windDirX - Normalised wind direction X
   * @param {number} windDirY - Normalised wind direction Y
   * @param {number} windSpeed - Wind speed (0–1 scale)
   * @private
   */
  _advanceWindSimulation(delta, windDirX, windDirY, windSpeed) {
    const THREE = window.THREE;
    if (!THREE) return;

    // Note: uLayerWindOffsets are *sampling offsets* (added to UV). Increasing the sampling
    // coordinate makes the visual pattern appear to move the opposite direction. So we subtract
    // displacement here so clouds drift WITH the wind direction.
    const windDrivenSpeed = windSpeed * this.params.windInfluence * this.params.driftSpeed;
    const minDriftSpeed = Math.max(0.0, Number(this.params.minDriftSpeed) || 0.0);
    const targetBaseSpeed = Math.max(windDrivenSpeed, minDriftSpeed);
    const responsiveness = Math.max(0.0, this.params.driftResponsiveness ?? 2.5);
    const maxSpeed = Math.max(0.0, this.params.driftMaxSpeed ?? 0.05);
    const lerpAlpha = responsiveness > 0.0 ? (1.0 - Math.exp(-responsiveness * delta)) : 1.0;

    if (!this._tempVec2A) this._tempVec2A = new THREE.Vector2();
    if (!this._tempVec2B) this._tempVec2B = new THREE.Vector2();

    // Legacy single offset (kept for stability/debug)
    if (this._windOffset && this._windVelocity) {
      this._tempVec2A.set(windDirX, windDirY);
      if (this._tempVec2A.lengthSq() > 1e-6) this._tempVec2A.normalize();
      this._tempVec2A.multiplyScalar(targetBaseSpeed);
      this._windVelocity.lerp(this._tempVec2A, lerpAlpha);
      const vLen = this._windVelocity.length();
      if (vLen > maxSpeed && vLen > 1e-6) this._windVelocity.multiplyScalar(maxSpeed / vLen);
      // IMPORTANT: Do NOT modulo-wrap offsets.
      // Wrapping introduces a discontinuity which looks like clouds "teleporting".
      this._windOffset.x -= this._windVelocity.x * delta;
      this._windOffset.y -= this._windVelocity.y * delta;
      if (!Number.isFinite(this._windOffset.x)) this._windOffset.x = 0.0;
      if (!Number.isFinite(this._windOffset.y)) this._windOffset.y = 0.0;
    }

    // Multi-layer offsets: subtle speed + direction differences, parallax handled in shader
    if (this._layerWindOffsets && this._layerWindVelocities) {
      const baseParallax = Math.max(0.0, Math.min(1.0, this.params.layerParallaxBase ?? 0.2));
      const toRad = Math.PI / 180;
      const l1Enabled = !!this.params.layer1Enabled; const l2Enabled = !!this.params.layer2Enabled;
      const l3Enabled = !!this.params.layer3Enabled; const l4Enabled = !!this.params.layer4Enabled;
      const l5Enabled = !!this.params.layer5Enabled;
      this._layerSpeedMult[0] = this.params.layer1SpeedMult; this._layerSpeedMult[1] = this.params.layer2SpeedMult;
      this._layerSpeedMult[2] = this.params.layer3SpeedMult; this._layerSpeedMult[3] = this.params.layer4SpeedMult;
      this._layerSpeedMult[4] = this.params.layer5SpeedMult;
      this._layerDirAngle[0] = (this.params.layer1DirDeg ?? 0) * toRad; this._layerDirAngle[1] = (this.params.layer2DirDeg ?? 0) * toRad;
      this._layerDirAngle[2] = (this.params.layer3DirDeg ?? 0) * toRad; this._layerDirAngle[3] = (this.params.layer4DirDeg ?? 0) * toRad;
      this._layerDirAngle[4] = (this.params.layer5DirDeg ?? 0) * toRad;
      this._layerParallax[0] = Math.max(0.0, Math.min(1.0, baseParallax * (this.params.layer1ParallaxMult ?? 1.0)));
      this._layerParallax[1] = Math.max(0.0, Math.min(1.0, baseParallax * (this.params.layer2ParallaxMult ?? 1.0)));
      this._layerParallax[2] = Math.max(0.0, Math.min(1.0, baseParallax * (this.params.layer3ParallaxMult ?? 1.0)));
      this._layerParallax[3] = Math.max(0.0, Math.min(1.0, baseParallax * (this.params.layer4ParallaxMult ?? 1.0)));
      this._layerParallax[4] = Math.max(0.0, Math.min(1.0, baseParallax * (this.params.layer5ParallaxMult ?? 1.0)));
      this._layerNoiseScaleMult[0] = this.params.layer1Scale; this._layerNoiseScaleMult[1] = this.params.layer2Scale;
      this._layerNoiseScaleMult[2] = this.params.layer3Scale; this._layerNoiseScaleMult[3] = this.params.layer4Scale;
      this._layerNoiseScaleMult[4] = this.params.layer5Scale;
      this._layerCoverMult[0] = this.params.layer1Coverage; this._layerCoverMult[1] = this.params.layer2Coverage;
      this._layerCoverMult[2] = this.params.layer3Coverage; this._layerCoverMult[3] = this.params.layer4Coverage;
      this._layerCoverMult[4] = this.params.layer5Coverage;
      this._layerWeight[0] = l1Enabled ? (this.params.layer1Opacity ?? 0.0) : 0.0;
      this._layerWeight[1] = l2Enabled ? (this.params.layer2Opacity ?? 0.0) : 0.0;
      this._layerWeight[2] = l3Enabled ? (this.params.layer3Opacity ?? 0.0) : 0.0;
      this._layerWeight[3] = l4Enabled ? (this.params.layer4Opacity ?? 0.0) : 0.0;
      this._layerWeight[4] = l5Enabled ? (this.params.layer5Opacity ?? 0.0) : 0.0;
      this._tempVec2A.set(windDirX, windDirY);
      if (this._tempVec2A.lengthSq() > 1e-6) this._tempVec2A.normalize();
      for (let i = 0; i < this._layerWindOffsets.length; i++) {
        const a = this._layerDirAngle[i] ?? 0.0;
        const ca = Math.cos(a); const sa = Math.sin(a);
        const dx = this._tempVec2A.x * ca - this._tempVec2A.y * sa;
        const dy = this._tempVec2A.x * sa + this._tempVec2A.y * ca;
        const speedMult = (this._layerSpeedMult[i] ?? 1.0);
        this._tempVec2B.set(dx, dy).multiplyScalar(targetBaseSpeed * speedMult);
        const v = this._layerWindVelocities[i];
        v.lerp(this._tempVec2B, lerpAlpha);
        const vMax = maxSpeed * speedMult; const vLayerLen = v.length();
        if (vLayerLen > vMax && vLayerLen > 1e-6) v.multiplyScalar(vMax / vLayerLen);
        const o = this._layerWindOffsets[i];
        // IMPORTANT: Do NOT modulo-wrap offsets — causes a discontinuity (clouds "teleporting").
        o.x -= v.x * delta; o.y -= v.y * delta;
        if (!Number.isFinite(o.x)) o.x = 0.0;
        if (!Number.isFinite(o.y)) o.y = 0.0;
      }
      // PERF: Keep uLayerWindOffsets as a flat typed array to skip Three.js flatten() overhead.
      if (this._layerWindOffsetsFlat) {
        const flat = this._layerWindOffsetsFlat;
        for (let i = 0; i < this._layerWindOffsets.length; i++) {
          const o = this._layerWindOffsets[i]; const j = i * 2;
          flat[j] = o.x; flat[j + 1] = o.y;
        }
      }
    }
  }

  update(timeInfo) {
    if (!this.densityMaterial || !this.shadowMaterial || !this.enabled) return;

    this._lastElapsed = timeInfo?.elapsed ?? 0;

    const THREE = window.THREE;
    if (!THREE) return;

    const weatherState = this._getEffectiveWeatherState();
    const cloudCover = weatherState.cloudCover;

    // If weather is globally disabled or cloud cover is zero, skip uniform binding.
    // Wind simulation advance is already a no-op in prepareFrame() for this case.
    if (!weatherState.weatherEnabled || this._isCloudCoverEffectivelyZero(cloudCover)) {
      const du = this.densityMaterial?.uniforms;
      if (du?.uCloudCover) du.uCloudCover.value = 0.0;
      return;
    }

    // Wind simulation advance (_windOffset, _windVelocity, _layerWindOffsets,
    // _layerWindVelocities, _layerWindOffsetsFlat) is performed in prepareFrame()
    // via _advanceWindSimulation(). Values are already up-to-date when update() runs.

    // Calculate sun direction for shadow offset
    this._calculateSunDirection();

    // Get scene dimensions for world-space coordinates
    const sceneRect = canvas?.dimensions?.sceneRect;
    const sceneX = sceneRect?.x ?? 0;
    const sceneY = sceneRect?.y ?? 0;
    const sceneWidth = sceneRect?.width ?? 4000;
    const sceneHeight = sceneRect?.height ?? 3000;

    // Calculate view bounds in world coordinates for ZERO PARALLAX shadows.
    // Use the Three.js camera + sceneComposer zoom, which are already
    // synchronized with Foundry via the camera follower.
    const sceneComposer = window.MapShine?.sceneComposer;
    let viewMinX = 0;
    let viewMinY = 0;
    let viewMaxX = sceneWidth;
    let viewMaxY = sceneHeight;

    if (sceneComposer && this.mainCamera) {
      const zoom = sceneComposer.currentZoom || 1.0;
      const viewportWidth = sceneComposer.baseViewportWidth || window.innerWidth;
      const viewportHeight = sceneComposer.baseViewportHeight || window.innerHeight;

      // At zoom=1, viewport pixels = world units. At other zooms, visible
      // world size = viewport / zoom.
      const visibleWorldWidth = viewportWidth / zoom;
      const visibleWorldHeight = viewportHeight / zoom;

      // Camera center in world coords
      const camX = this.mainCamera.position.x;
      const camY = this.mainCamera.position.y;

      // View bounds centered on camera
      viewMinX = camX - visibleWorldWidth / 2;
      viewMinY = camY - visibleWorldHeight / 2;
      viewMaxX = camX + visibleWorldWidth / 2;
      viewMaxY = camY + visibleWorldHeight / 2;
    }

    // Update density material uniforms
    const du = this.densityMaterial.uniforms;
    du.uTime.value = timeInfo?.elapsed ?? 0;
    du.uCloudCover.value = cloudCover;
    du.uNoiseScale.value = this.params.noiseScale;
    du.uNoiseDetail.value = this.params.noiseDetail;
    du.uCloudSharpness.value = this.params.cloudSharpness;
    if (du.uNoiseTimeSpeed) du.uNoiseTimeSpeed.value = this.params.noiseTimeSpeed;
    if (du.uDomainWarpEnabled) du.uDomainWarpEnabled.value = this.params.domainWarpEnabled ? 1.0 : 0.0;
    if (du.uDomainWarpStrength) du.uDomainWarpStrength.value = this.params.domainWarpStrength;
    if (du.uDomainWarpScale) du.uDomainWarpScale.value = this.params.domainWarpScale;
    if (du.uDomainWarpSpeed) du.uDomainWarpSpeed.value = this.params.domainWarpSpeed;
    if (du.uDomainWarpTimeOffsetY) du.uDomainWarpTimeOffsetY.value = this.params.domainWarpTimeOffsetY;

    // PERF: Do not replace uniform.value objects/arrays per frame.
    // We mutate the underlying typed arrays in place.
    if (du.uCompositeSoftKnee) du.uCompositeSoftKnee.value = Number(this.params.cloudTopSoftKnee) || 0.0;
    if (du.uSceneOrigin) du.uSceneOrigin.value.set(sceneX, sceneY);
    du.uSceneSize.value.set(sceneWidth, sceneHeight);
    du.uViewBoundsMin.value.set(viewMinX, viewMinY);
    du.uViewBoundsMax.value.set(viewMaxX, viewMaxY);

    const zoom = this._getEffectiveZoom();

    // Update shadow material uniforms
    const su = this.shadowMaterial.uniforms;
    su.uShadowOpacity.value = this.params.shadowOpacity;
    su.uShadowSoftness.value = this.params.shadowSoftness;
    su.uMinBrightness.value = this.params.minShadowBrightness;
    su.uZoom.value = zoom;

    if (su.uSceneOrigin) su.uSceneOrigin.value.set(sceneX, sceneY);
    if (su.uSceneSize) su.uSceneSize.value.set(sceneWidth, sceneHeight);
    if (su.uViewBoundsMin) su.uViewBoundsMin.value.set(viewMinX, viewMinY);
    if (su.uViewBoundsMax) su.uViewBoundsMax.value.set(viewMaxX, viewMaxY);

    // Calculate sun offset in WORLD SPACE for shadow displacement.
    // Sampling density in world space avoids screen-space seams caused by UV wrapping.
    const offsetWorldUnits = this.params.shadowOffsetScale * 5000.0;
    if (this.sunDir) {
      su.uShadowOffsetWorld.value.set(
        this.sunDir.x * offsetWorldUnits,
        this.sunDir.y * offsetWorldUnits
      );
    } else {
      su.uShadowOffsetWorld.value.set(0, 0);
    }

    // Compute overscanned density bounds so offset+blur taps stay within the density texture.
    // This prevents the blur kernel from sampling clamped texture edges (screen-space banding).
    const viewWidth = viewMaxX - viewMinX;
    const viewHeight = viewMaxY - viewMinY;
    const iW = this.cloudDensityTarget?.width ?? 1024;
    const iH = this.cloudDensityTarget?.height ?? 1024;
    const worldPerPixelX = viewWidth / Math.max(1, iW);
    const worldPerPixelY = viewHeight / Math.max(1, iH);

    const blurPixels = (this.params.shadowSoftness ?? 0.0) * 20.0 * zoom;
    const blurWorldX = blurPixels * worldPerPixelX;
    const blurWorldY = blurPixels * worldPerPixelY;

    const absOffX = Math.abs(su.uShadowOffsetWorld.value.x);
    const absOffY = Math.abs(su.uShadowOffsetWorld.value.y);
    const marginX = absOffX + blurWorldX * 2.0 + worldPerPixelX * 4.0;
    const marginY = absOffY + blurWorldY * 2.0 + worldPerPixelY * 4.0;

    const densityMinX = viewMinX - marginX;
    const densityMinY = viewMinY - marginY;
    const densityMaxX = viewMaxX + marginX;
    const densityMaxY = viewMaxY + marginY;

    if (su.uDensityBoundsMin) su.uDensityBoundsMin.value.set(densityMinX, densityMinY);
    if (su.uDensityBoundsMax) su.uDensityBoundsMax.value.set(densityMaxX, densityMaxY);

    // Set outdoors mask for shadow material
    const le = window.MapShine?.lightingEffect;
    if (le?.outdoorsTarget) {
      su.tOutdoorsMask.value = le.outdoorsTarget.texture;
      su.uHasOutdoorsMask.value = 1.0;
    } else if (this.outdoorsMask) {
      su.tOutdoorsMask.value = this.outdoorsMask;
      su.uHasOutdoorsMask.value = 1.0;
    } else {
      su.uHasOutdoorsMask.value = 0.0;
    }

    // Update cloud top material uniforms
    if (this.cloudTopMaterial) {
      const tu = this.cloudTopMaterial.uniforms;
      tu.uCloudTopOpacity.value = this.params.cloudTopOpacity;
      tu.uFadeStart.value = this.params.cloudTopFadeStart;
      tu.uFadeEnd.value = this.params.cloudTopFadeEnd;
      tu.uCloudBrightness.value = this.params.cloudBrightness;
      if (tu.uTime) tu.uTime.value = timeInfo?.elapsed ?? 0;

      if (tu.uShadingEnabled) tu.uShadingEnabled.value = this.params.cloudTopShadingEnabled ? 1.0 : 0.0;
      if (tu.uShadingStrength) tu.uShadingStrength.value = this.params.cloudTopShadingStrength;
      if (tu.uNormalStrength) tu.uNormalStrength.value = this.params.cloudTopNormalStrength;
      if (tu.uAOIntensity) tu.uAOIntensity.value = Number(this.params.cloudTopAOIntensity) || 0.0;
      if (tu.uEdgeHighlight) tu.uEdgeHighlight.value = this.params.cloudTopEdgeHighlight;

      if (tu.uPeakDetailEnabled) tu.uPeakDetailEnabled.value = this.params.cloudTopPeakDetailEnabled ? 1.0 : 0.0;
      if (tu.uPeakDetailStrength) tu.uPeakDetailStrength.value = this.params.cloudTopPeakDetailStrength;
      if (tu.uPeakDetailScale) tu.uPeakDetailScale.value = this.params.cloudTopPeakDetailScale;
      if (tu.uPeakDetailSpeed) tu.uPeakDetailSpeed.value = this.params.cloudTopPeakDetailSpeed;
      if (tu.uPeakDetailStart) tu.uPeakDetailStart.value = this.params.cloudTopPeakDetailStart;
      if (tu.uPeakDetailEnd) tu.uPeakDetailEnd.value = this.params.cloudTopPeakDetailEnd;

      // Use a stronger lateral sun direction for cloud-top shading so it reads at midday.
      // This does NOT affect ground shadows (those use uShadowOffsetWorld + overscanned density sampling).
      if (this.sunDir && tu.uSunDir) {
        if (!this._shadeSunDir) this._shadeSunDir = new THREE.Vector2(0.0, 1.0);
        this._shadeSunDir.copy(this.sunDir);
        const mag = this._shadeSunDir.length();
        const minMag = 0.6;
        if (mag < minMag) {
          if (mag < 1e-5) this._shadeSunDir.set(minMag, 0.0);
          else this._shadeSunDir.multiplyScalar(minMag / mag);
        }
        tu.uSunDir.value.copy(this._shadeSunDir);
      }

      // Drive zoom fade based on the *actual* zoom value.
      // The fadeStart/fadeEnd controls are expressed in zoom units (like Foundry zoom),
      // so normalizing here breaks the expected behavior.
      tu.uNormalizedZoom.value = zoom;

      // Fade outdoors masking based on zoom, if in the above-everything mode.
      // zoomFade is 1.0 when zoomed OUT (cloud tops visible) and 0.0 when zoomed IN.
      // We want the outdoors mask to have the opposite behavior:
      // - zoomed in: mask fully applied (keep indoors clear)
      // - zoomed out: mask fades out so clouds can appear above everything
      if (this.params.cloudTopMode === 'aboveEverything') {
        const fadeStart = this.params.cloudTopFadeStart;
        const fadeEnd = this.params.cloudTopFadeEnd;
        const zoomFade = 1.0 - this._smoothstep(fadeStart, fadeEnd, zoom);
        tu.uOutdoorsMaskStrength.value = 1.0 - zoomFade;
      } else {
        tu.uOutdoorsMaskStrength.value = 1.0;
      }

      // Apply time-of-day tint for sunrise/sunset coloring
      const tint = this._calculateTimeOfDayTint();
      tu.uTimeOfDayTint.value.copy(tint);

      // Set outdoors mask for cloud top material
      if (le?.outdoorsTarget) {
        tu.tOutdoorsMask.value = le.outdoorsTarget.texture;
        tu.uHasOutdoorsMask.value = 1.0;
      } else if (this.outdoorsMask) {
        tu.tOutdoorsMask.value = this.outdoorsMask;
        tu.uHasOutdoorsMask.value = 1.0;
      } else {
        tu.uHasOutdoorsMask.value = 0.0;
      }
    }
  }

  render(renderer, scene, camera) {
    const THREE = window.THREE;
    if (!THREE || !this.quadScene || !this.quadCamera) return;

    if (!this.densityMaterial || !this.shadowMaterial) return;

    // If weather is disabled OR cloud cover is zero we still must render neutral
    // targets so downstream consumers immediately see "no clouds".
    const weatherState = this._getEffectiveWeatherState();
    const weatherEnabled = weatherState.weatherEnabled;
    const coverIsZero = this._isCloudCoverEffectivelyZero(weatherState.cloudCover);
    const shouldRenderNeutral = !weatherEnabled || coverIsZero || this._needsNeutralCloudClear;

    // Ensure render targets exist
    if (!this._tempSize) this._tempSize = new THREE.Vector2();
    renderer.getDrawingBufferSize(this._tempSize);
    const width = this._tempSize.x;
    const height = this._tempSize.y;

    const internal = this._getInternalRenderSize(width, height);
    const iW = internal.width;
    const iH = internal.height;

    if (!this.cloudDensityTarget || !this.cloudShadowTarget || !this.cloudShadowRawTarget) {
      this.onResize(width, height);
    } else if (this.cloudDensityTarget.width !== iW || this.cloudDensityTarget.height !== iH) {
      this.onResize(width, height);
    } else if (this._lastRenderFullWidth !== width || this._lastRenderFullHeight !== height) {
      this.onResize(width, height);
    }

    const previousTarget = renderer.getRenderTarget();
    const previousLayersMask = this.mainCamera?.layers?.mask;

    try {
      // Cloud shadows/tops look noticeably worse when temporally sliced.
      // Always update every frame; keep requestUpdate/requestRecompose hooks for external callers.
      const shouldUpdateThisFrame = true;
      const shouldRecomposeThisFrame = (this._forceRecomposeFrames > 0) || this._blockersDirty;

    // Clear textures to neutral values and skip all simulation work.
    if (shouldRenderNeutral) {
      renderer.setRenderTarget(this.cloudDensityTarget);
      renderer.setClearColor(0x000000, 1);
      renderer.clear();

      renderer.setRenderTarget(this.cloudShadowRawTarget);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear();

      renderer.setRenderTarget(this.cloudShadowTarget);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear();

      if (this.cloudTopDensityTarget) {
        renderer.setRenderTarget(this.cloudTopDensityTarget);
        renderer.setClearColor(0x000000, 1);
        renderer.clear();
      }
      if (this.cloudTopTarget) {
        renderer.setRenderTarget(this.cloudTopTarget);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
      }

      if (this.cloudShadowBlockerTarget) {
        renderer.setRenderTarget(this.cloudShadowBlockerTarget);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
      }
      if (this.cloudTopBlockerTarget) {
        renderer.setRenderTarget(this.cloudTopBlockerTarget);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
      }

      try {
        const mm = window.MapShine?.maskManager;
        if (mm) {
          const shadowTex = this.cloudShadowTarget?.texture;
          if (shadowTex && shadowTex !== this._publishedCloudShadowTex) {
            this._publishedCloudShadowTex = shadowTex;
            const cfg = this._maskTextureConfigCloudShadow;
            cfg.width = this.cloudShadowTarget?.width ?? null;
            cfg.height = this.cloudShadowTarget?.height ?? null;
            mm.setTexture('cloudShadow.screen', shadowTex, cfg);
          }

          const shadowRawTex = this.cloudShadowRawTarget?.texture;
          if (shadowRawTex && shadowRawTex !== this._publishedCloudShadowRawTex) {
            this._publishedCloudShadowRawTex = shadowRawTex;
            const cfg = this._maskTextureConfigCloudShadowRaw;
            cfg.width = this.cloudShadowRawTarget?.width ?? null;
            cfg.height = this.cloudShadowRawTarget?.height ?? null;
            mm.setTexture('cloudShadowRaw.screen', shadowRawTex, cfg);
          }

          const densityTex = this.cloudDensityTarget?.texture;
          if (densityTex && densityTex !== this._publishedCloudDensityTex) {
            this._publishedCloudDensityTex = densityTex;
            const cfg = this._maskTextureConfigCloudDensity;
            cfg.width = this.cloudDensityTarget?.width ?? null;
            cfg.height = this.cloudDensityTarget?.height ?? null;
            mm.setTexture('cloudDensity.screen', densityTex, cfg);
          }
        }
      } catch (e) {
      }

      if (this.cloudTopOverlayMaterial?.uniforms) {
        this.cloudTopOverlayMaterial.uniforms.tCloudTop.value = null;
      }
      if (this.cloudTopOverlayMesh) {
        this.cloudTopOverlayMesh.visible = false;
      }

      this._needsNeutralCloudClear = false;

      renderer.setRenderTarget(previousTarget);
      return;
    }

    this._cloudCoverZeroLastFrame = false;
    this._needsNeutralCloudClear = false;

    if (!shouldUpdateThisFrame && !shouldRecomposeThisFrame) {
      renderer.setRenderTarget(previousTarget);
      return;
    }

    if ((shouldUpdateThisFrame || shouldRecomposeThisFrame) && this.mainCamera && this.mainScene) {
        if (this.cloudShadowBlockerTarget) {
          this._renderTileBlockerLayer(renderer, this.cloudShadowBlockerTarget, TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
        }

        if (this.cloudTopBlockerTarget) {
          this._renderTileBlockerLayer(renderer, this.cloudTopBlockerTarget, TILE_FEATURE_LAYERS.CLOUD_TOP_BLOCKER);
        }
    }

    if (this._forceRecomposeFrames > 0) this._forceRecomposeFrames--;
    this._blockersDirty = false;

    if (!shouldUpdateThisFrame) {
        // Pass 2a: Generate UNMASKED cloud shadow from density (for indoor consumers)
        {
          const su = this.shadowMaterial.uniforms;
          const prevHasMask = su.uHasOutdoorsMask ? su.uHasOutdoorsMask.value : 0.0;
          const prevMaskTex = su.tOutdoorsMask ? su.tOutdoorsMask.value : null;

          if (su.uDensityMode) su.uDensityMode.value = 0.0;
          if (su.uHasOutdoorsMask) su.uHasOutdoorsMask.value = 0.0;
          if (su.tOutdoorsMask) su.tOutdoorsMask.value = null;

          this.shadowMaterial.uniforms.tCloudDensity.value = this.cloudShadowDensityTarget.texture;

          if (this.shadowMaterial.uniforms.tBlockerMask) {
            this.shadowMaterial.uniforms.tBlockerMask.value = this.cloudShadowBlockerTarget?.texture ?? null;
          }
          if (this.shadowMaterial.uniforms.uHasBlockerMask) {
            this.shadowMaterial.uniforms.uHasBlockerMask.value = this.cloudShadowBlockerTarget?.texture ? 1.0 : 0.0;
          }
          this.quadMesh.material = this.shadowMaterial;
          renderer.setRenderTarget(this.cloudShadowRawTarget);
          renderer.setClearColor(0xffffff, 1);
          renderer.clear();
          renderer.render(this.quadScene, this.quadCamera);

          if (su.uHasOutdoorsMask) su.uHasOutdoorsMask.value = prevHasMask;
          if (su.tOutdoorsMask) su.tOutdoorsMask.value = prevMaskTex;
        }

        // Pass 2b: Generate cloud shadow from density (OUTDOORS-MASKED)
        if (this.shadowMaterial.uniforms.uDensityMode) this.shadowMaterial.uniforms.uDensityMode.value = 0.0;
        this.shadowMaterial.uniforms.tCloudDensity.value = this.cloudShadowDensityTarget.texture;

        if (this.shadowMaterial.uniforms.tBlockerMask) {
          this.shadowMaterial.uniforms.tBlockerMask.value = this.cloudShadowBlockerTarget?.texture ?? null;
        }
        if (this.shadowMaterial.uniforms.uHasBlockerMask) {
          this.shadowMaterial.uniforms.uHasBlockerMask.value = this.cloudShadowBlockerTarget?.texture ? 1.0 : 0.0;
        }
        this.quadMesh.material = this.shadowMaterial;
        renderer.setRenderTarget(this.cloudShadowTarget);
        renderer.setClearColor(0xffffff, 1);
        renderer.clear();
        renderer.render(this.quadScene, this.quadCamera);

        // Pass 4: Generate cloud tops (visible cloud layer with zoom fade)
        if (this.cloudTopMaterial && this.cloudTopTarget) {
          const usePacked = !!this.cloudTopDensityTarget && !!this._cloudTopDensityValid;
          if (this.cloudTopMaterial.uniforms.uDensityMode) {
            this.cloudTopMaterial.uniforms.uDensityMode.value = usePacked ? 1.0 : 0.0;
          }
          this.cloudTopMaterial.uniforms.tCloudDensity.value = usePacked
            ? this.cloudTopDensityTarget.texture
            : this.cloudDensityTarget.texture;

          if (this.cloudTopMaterial.uniforms.tBlockerMask) {
            this.cloudTopMaterial.uniforms.tBlockerMask.value = this.cloudTopBlockerTarget?.texture ?? null;
          }
          if (this.cloudTopMaterial.uniforms.uHasBlockerMask) {
            this.cloudTopMaterial.uniforms.uHasBlockerMask.value = this.cloudTopBlockerTarget?.texture ? 1.0 : 0.0;
          }

          this.quadMesh.material = this.cloudTopMaterial;
          renderer.setRenderTarget(this.cloudTopTarget);
          renderer.setClearColor(0x000000, 0);
          renderer.clear();
          renderer.render(this.quadScene, this.quadCamera);
        }

        if (this.cloudTopOverlayMaterial?.uniforms) {
          this.cloudTopOverlayMaterial.uniforms.tCloudTop.value = this.cloudTopTarget?.texture || null;
        }
        if (this.cloudTopOverlayMesh) {
          this.cloudTopOverlayMesh.visible = !!(this.enabled && this.cloudTopTarget && this.cloudTopTarget.texture);
        }

        renderer.setRenderTarget(previousTarget);
        return;
      }

    if (this._forceUpdateFrames > 0) this._forceUpdateFrames--;

    // Pass 1a: Generate world-pinned cloud density for SHADOWS (overscanned bounds)
    if (this.densityMaterial.uniforms.uClipToScene) this.densityMaterial.uniforms.uClipToScene.value = 0.0;
    if (this.densityMaterial.uniforms.uParallaxScale) this.densityMaterial.uniforms.uParallaxScale.value = 0.0;
    if (this.densityMaterial.uniforms.uCompositeMode) this.densityMaterial.uniforms.uCompositeMode.value = 0.0;

    // Temporarily override density view bounds to cover the overscanned region.
    const du = this.densityMaterial.uniforms;
    const prevMinX = du.uViewBoundsMin.value.x;
    const prevMinY = du.uViewBoundsMin.value.y;
    const prevMaxX = du.uViewBoundsMax.value.x;
    const prevMaxY = du.uViewBoundsMax.value.y;

    const su = this.shadowMaterial.uniforms;
    if (du.uViewBoundsMin && su.uDensityBoundsMin) du.uViewBoundsMin.value.copy(su.uDensityBoundsMin.value);
    if (du.uViewBoundsMax && su.uDensityBoundsMax) du.uViewBoundsMax.value.copy(su.uDensityBoundsMax.value);

    this.quadMesh.material = this.densityMaterial;
    renderer.setRenderTarget(this.cloudShadowDensityTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(this.quadScene, this.quadCamera);

    // Restore normal view bounds for the standard density target.
    du.uViewBoundsMin.value.set(prevMinX, prevMinY);
    du.uViewBoundsMax.value.set(prevMaxX, prevMaxY);

    // Pass 1b: Generate world-pinned cloud density (normal bounds) for other consumers
    this.quadMesh.material = this.densityMaterial;
    renderer.setRenderTarget(this.cloudDensityTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(this.quadScene, this.quadCamera);

    // Pass 2a: Generate UNMASKED cloud shadow from density (for indoor consumers)
    {
      const su = this.shadowMaterial.uniforms;
      const prevHasMask = su.uHasOutdoorsMask ? su.uHasOutdoorsMask.value : 0.0;
      const prevMaskTex = su.tOutdoorsMask ? su.tOutdoorsMask.value : null;

      if (su.uDensityMode) su.uDensityMode.value = 0.0;
      if (su.uHasOutdoorsMask) su.uHasOutdoorsMask.value = 0.0;
      if (su.tOutdoorsMask) su.tOutdoorsMask.value = null;

      this.shadowMaterial.uniforms.tCloudDensity.value = this.cloudShadowDensityTarget.texture;

      if (this.shadowMaterial.uniforms.tBlockerMask) {
        this.shadowMaterial.uniforms.tBlockerMask.value = this.cloudShadowBlockerTarget?.texture ?? null;
      }
      if (this.shadowMaterial.uniforms.uHasBlockerMask) {
        this.shadowMaterial.uniforms.uHasBlockerMask.value = this.cloudShadowBlockerTarget?.texture ? 1.0 : 0.0;
      }
      this.quadMesh.material = this.shadowMaterial;
      renderer.setRenderTarget(this.cloudShadowRawTarget);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear();
      renderer.render(this.quadScene, this.quadCamera);

      if (su.uHasOutdoorsMask) su.uHasOutdoorsMask.value = prevHasMask;
      if (su.tOutdoorsMask) su.tOutdoorsMask.value = prevMaskTex;
    }

    // Pass 2b: Generate cloud shadow from density (OUTDOORS-MASKED)
    if (this.shadowMaterial.uniforms.uDensityMode) this.shadowMaterial.uniforms.uDensityMode.value = 0.0;
    this.shadowMaterial.uniforms.tCloudDensity.value = this.cloudShadowDensityTarget.texture;

    if (this.shadowMaterial.uniforms.tBlockerMask) {
      this.shadowMaterial.uniforms.tBlockerMask.value = this.cloudShadowBlockerTarget?.texture ?? null;
    }
    if (this.shadowMaterial.uniforms.uHasBlockerMask) {
      this.shadowMaterial.uniforms.uHasBlockerMask.value = this.cloudShadowBlockerTarget?.texture ? 1.0 : 0.0;
    }
    this.quadMesh.material = this.shadowMaterial;
    renderer.setRenderTarget(this.cloudShadowTarget);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.render(this.quadScene, this.quadCamera);

    // Pass 3: Generate parallaxed multi-layer density for cloud tops (this MUST NOT drive ground shadows)
    if (this.cloudTopDensityTarget) {
      if (this.densityMaterial.uniforms.uClipToScene) this.densityMaterial.uniforms.uClipToScene.value = 1.0;
      if (this.densityMaterial.uniforms.uParallaxScale) this.densityMaterial.uniforms.uParallaxScale.value = 1.0;
      if (this.densityMaterial.uniforms.uCompositeMode) this.densityMaterial.uniforms.uCompositeMode.value = 1.0;
      this.quadMesh.material = this.densityMaterial;
      renderer.setRenderTarget(this.cloudTopDensityTarget);
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
      renderer.render(this.quadScene, this.quadCamera);

      this._cloudTopDensityValid = true;
    }

    // Pass 4: Generate cloud tops (visible cloud layer with zoom fade)
    if (this.cloudTopMaterial && this.cloudTopTarget) {
      const usePacked = !!this.cloudTopDensityTarget && !!this._cloudTopDensityValid;
      if (this.cloudTopMaterial.uniforms.uDensityMode) {
        this.cloudTopMaterial.uniforms.uDensityMode.value = usePacked ? 1.0 : 0.0;
      }
      this.cloudTopMaterial.uniforms.tCloudDensity.value = usePacked
        ? this.cloudTopDensityTarget.texture
        : this.cloudDensityTarget.texture;

      if (this.cloudTopMaterial.uniforms.tBlockerMask) {
        this.cloudTopMaterial.uniforms.tBlockerMask.value = this.cloudTopBlockerTarget?.texture ?? null;
      }
      if (this.cloudTopMaterial.uniforms.uHasBlockerMask) {
        this.cloudTopMaterial.uniforms.uHasBlockerMask.value = this.cloudTopBlockerTarget?.texture ? 1.0 : 0.0;
      }

      this.quadMesh.material = this.cloudTopMaterial;
      renderer.setRenderTarget(this.cloudTopTarget);
      renderer.setClearColor(0x000000, 0); // Transparent background
      renderer.clear();
      renderer.render(this.quadScene, this.quadCamera);
    }

    if (this.cloudTopOverlayMaterial?.uniforms) {
      this.cloudTopOverlayMaterial.uniforms.tCloudTop.value = this.cloudTopTarget?.texture || null;
    }
    if (this.cloudTopOverlayMesh) {
      this.cloudTopOverlayMesh.visible = !!(this.enabled && this.cloudTopTarget && this.cloudTopTarget.texture);
    }

    try {
      const mm = window.MapShine?.maskManager;
      if (mm) {
        const shadowTex = this.cloudShadowTarget?.texture;
        if (shadowTex && shadowTex !== this._publishedCloudShadowTex) {
          this._publishedCloudShadowTex = shadowTex;
          const cfg = this._maskTextureConfigCloudShadow;
          cfg.width = this.cloudShadowTarget?.width ?? null;
          cfg.height = this.cloudShadowTarget?.height ?? null;
          mm.setTexture('cloudShadow.screen', shadowTex, cfg);
        }

        const shadowRawTex = this.cloudShadowRawTarget?.texture;
        if (shadowRawTex && shadowRawTex !== this._publishedCloudShadowRawTex) {
          this._publishedCloudShadowRawTex = shadowRawTex;
          const cfg = this._maskTextureConfigCloudShadowRaw;
          cfg.width = this.cloudShadowRawTarget?.width ?? null;
          cfg.height = this.cloudShadowRawTarget?.height ?? null;
          mm.setTexture('cloudShadowRaw.screen', shadowRawTex, cfg);
        }

        const densityTex = this.cloudDensityTarget?.texture;
        if (densityTex && densityTex !== this._publishedCloudDensityTex) {
          this._publishedCloudDensityTex = densityTex;
          const cfg = this._maskTextureConfigCloudDensity;
          cfg.width = this.cloudDensityTarget?.width ?? null;
          cfg.height = this.cloudDensityTarget?.height ?? null;
          mm.setTexture('cloudDensity.screen', densityTex, cfg);
        }

        const shadowBlockerTex = this.cloudShadowBlockerTarget?.texture;
        if (shadowBlockerTex && shadowBlockerTex !== this._publishedCloudShadowBlockerTex) {
          this._publishedCloudShadowBlockerTex = shadowBlockerTex;
          const cfg = this._maskTextureConfigCloudShadowBlocker;
          cfg.width = this.cloudShadowBlockerTarget?.width ?? null;
          cfg.height = this.cloudShadowBlockerTarget?.height ?? null;
          mm.setTexture('cloudShadowBlocker.screen', shadowBlockerTex, cfg);
        }

        const topBlockerTex = this.cloudTopBlockerTarget?.texture;
        if (topBlockerTex && topBlockerTex !== this._publishedCloudTopBlockerTex) {
          this._publishedCloudTopBlockerTex = topBlockerTex;
          const cfg = this._maskTextureConfigCloudTopBlocker;
          cfg.width = this.cloudTopBlockerTarget?.width ?? null;
          cfg.height = this.cloudTopBlockerTarget?.height ?? null;
          mm.setTexture('cloudTopBlocker.screen', topBlockerTex, cfg);
        }
      }
    } catch (e) {
    }

  } finally {
    renderer.setRenderTarget(previousTarget);
    if (this.mainCamera && typeof previousLayersMask === 'number') this.mainCamera.layers.mask = previousLayersMask;
  }
 }

  dispose() {
    if (this._registryUnsub) { this._registryUnsub(); this._registryUnsub = null; }
    if (this.cloudTopOverlayMesh && this.mainScene) {
      try {
        this.mainScene.remove(this.cloudTopOverlayMesh);
      } catch (_) {
      }
    }
    this.cloudTopOverlayMesh = null;
    if (this.cloudTopOverlayMaterial) {
      try {
        this.cloudTopOverlayMaterial.dispose();
      } catch (_) {
      }
    }
    this.cloudTopOverlayMaterial = null;

    if (this.cloudDensityTarget) {
      this.cloudDensityTarget.dispose();
      this.cloudDensityTarget = null;
    }
    if (this.cloudShadowDensityTarget) {
      this.cloudShadowDensityTarget.dispose();
      this.cloudShadowDensityTarget = null;
    }
    if (this.cloudShadowTarget) {
      this.cloudShadowTarget.dispose();
      this.cloudShadowTarget = null;
    }
    if (this.cloudShadowRawTarget) {
      this.cloudShadowRawTarget.dispose();
      this.cloudShadowRawTarget = null;
    }
    if (this.cloudTopDensityTarget) {
      this.cloudTopDensityTarget.dispose();
      this.cloudTopDensityTarget = null;
    }
    if (this.cloudTopTarget) {
      this.cloudTopTarget.dispose();
      this.cloudTopTarget = null;
    }

    if (this.cloudShadowBlockerTarget) {
      this.cloudShadowBlockerTarget.dispose();
      this.cloudShadowBlockerTarget = null;
    }

    if (this.cloudTopBlockerTarget) {
      this.cloudTopBlockerTarget.dispose();
      this.cloudTopBlockerTarget = null;
    }
    if (this.densityMaterial) {
      this.densityMaterial.dispose();
      this.densityMaterial = null;
    }
    if (this.shadowMaterial) {
      this.shadowMaterial.dispose();
      this.shadowMaterial = null;
    }
    if (this.cloudTopMaterial) {
      this.cloudTopMaterial.dispose();
      this.cloudTopMaterial = null;
    }
    if (this.quadMesh && this.quadScene) {
      this.quadScene.remove(this.quadMesh);
      this.quadMesh.geometry?.dispose();
      this.quadMesh = null;
    }
    this.quadScene = null;
    this.quadCamera = null;

    log.info('CloudEffect disposed');
  }
}
