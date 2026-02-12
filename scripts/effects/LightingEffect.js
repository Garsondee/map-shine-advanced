/**
 * @fileoverview Lighting Effect
 * Implements dynamic lighting for the scene base plane.
 * Replaces Foundry's PIXI lighting with a multipass Three.js approach.
 * @module effects/LightingEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';

import { ThreeLightSource } from './ThreeLightSource.js'; // Import the class above
import { ThreeDarknessSource } from './ThreeDarknessSource.js';
import { LightRegistry } from './LightRegistry.js';
import { MapShineLightAdapter } from './MapShineLightAdapter.js';
import { ROPE_MASK_LAYER } from './EffectComposer.js';

const log = createLogger('LightingEffect');

// TEMPORARY KILL-SWITCH: Disable lighting effect for perf testing.
// Set to true to skip all lighting passes and render scene directly.
// Currently FALSE so normal rendering works while we profile other systems.
const DISABLE_LIGHTING_EFFECT = false;

export class LightingEffect extends EffectBase {
  constructor() {
    super('lighting', RenderLayers.POST_PROCESSING, 'low');
    
    this.priority = 1; 
    
    // UI Parameters matching Foundry VTT + Custom Tweaks
    // NOTE: LightingEffect now ONLY handles lighting math (ambient + dynamic lights).
    // All tone mapping, exposure, contrast, saturation is handled by ColorCorrectionEffect.
    // See docs/CONTRAST-DARKNESS-ANALYSIS.md for rationale.
    this.params = {
      enabled: true,
      globalIllumination: 1.2, // Multiplier for ambient
      lightIntensity: 0.2, // Master multiplier for dynamic lights
      colorationStrength: 3.0,
      darknessEffect: 0.5, // Scales Foundry's darknessLevel
      darknessLevel: 0.0, // Read-only mostly, synced from canvas

      // Light Animation Behaviour
      // Global wind coupling for motion-animated lights (e.g. cableswing).
      // Per-light motion tuning lives under document.config.animation.
      lightAnimWindInfluence: 1.0,
      // Controls how aggressively the _Outdoors mask gates wind:
      // outdoorFactor = pow(outdoorsMask, lightAnimOutdoorPower)
      lightAnimOutdoorPower: 2.0,

      // Outdoor brightness control: adjusts outdoor areas relative to darkness level
      // At darkness 0: outdoors *= outdoorBrightness (boost daylight)
      // At darkness 1: outdoors *= (2.0 - outdoorBrightness) (dim night)
      outdoorBrightness: 1.7, // 1.0 = no change, 2.0 = double brightness at day

      lightningOutsideEnabled: true,
      lightningOutsideGain: 1.25,

      lightningOutsideShadowEnabled: true,
      lightningOutsideShadowStrength: 0.75,
      lightningOutsideShadowRadiusPx: 520.0,
      lightningOutsideShadowEdgeGain: 6.0,
      lightningOutsideShadowInvert: false,

      wallInsetPx: 6.0,

      negativeDarknessStrength: 1.0, // Controls subtractive darkness strength
      darknessPunchGain: 2.0,

      // Sun Lights (indoor fill)
      // Boost applied only to interior (low outdoors mask) regions.
      sunIndoorGain: 1.0,
      // Blur radius in pixels applied to the sun light buffer to soften edges.
      sunBlurRadiusPx: 5.0,

      debugShowLightBuffer: undefined,
      debugLightBufferExposure: undefined,
      debugShowDarknessBuffer: undefined,
      debugShowRopeMask: undefined,
    };

    this.lights = new Map(); 
    this.darknessSources = new Map(); 
    
    /**
     * MapShine-native renderables (driven by scene flags) rendered using the
     * existing ThreeLightSource shaders as an incremental step.
     * @type {Map<string, ThreeLightSource>}
     */
    this.mapshineLights = new Map();

    /** @type {Map<string, ThreeDarknessSource>} */
    this.mapshineDarknessSources = new Map();
    
    this.lightScene = null;     
    this.sunLightScene = null;
    this.darknessScene = null;  
    this.darknessTarget = null; 
    this.sunLightTarget = null;
    this.roofAlphaTarget = null; 
    this.weatherRoofAlphaTarget = null;
    this.ropeMaskTarget = null;
    this.tokenMaskTarget = null;
    this.masksTarget = null;
    
    this._quadMesh = null;

    this.outdoorsMask = null;
    this.outdoorsScene = null;
    this.outdoorsMesh = null;
    this.outdoorsMaterial = null;
    this.outdoorsTarget = null;
    
    this._effectiveDarkness = null;
    
    this._tempSize = null; 

    this._baseMesh = null;

    this._publishedRoofAlphaTex = null;
    this._publishedWeatherRoofAlphaTex = null;
    this._publishedOutdoorsTex = null;
    this._publishedRopeMaskTex = null;
    this._publishedTokenMaskTex = null;
    
    this._transparentTex = null;

    this._masksPackScene = null;
    this._masksPackCamera = null;
    this._masksPackMesh = null;
    this._masksPackMaterial = null;

    /**
     * Unified data registry for lights (Foundry + future MapShine-native lights).
     * Rendering is still performed by ThreeLightSource/ThreeDarknessSource.
     * @type {LightRegistry}
     */
    this.lightRegistry = new LightRegistry();

    /**
     * Set of Foundry light IDs that are overridden by MapShine enhanced lights.
     * These lights should not be rendered (to avoid double-lighting).
     * Rebuilt whenever MapShine lights are reloaded from scene flags.
     * @type {Set<string>}
     */
    this._overriddenFoundryLightIds = new Set();

    /**
     * Metadata for MapShine-native lights (targetLayers, cookies, etc.).
     * Keyed by the prefixed id (e.g., 'mapshine:abc123').
     * @type {Map<string, {targetLayers: 'ground'|'overhead'|'both', cookieTexture?: string, cookieRotation?: number, cookieScale?: number, cookieTint?: string}>}
     */
    this._mapshineLightMeta = new Map();

    /** @type {Array<{hook: string, fn: Function}>} */
    this._hookRegistrations = [];

    /** @type {number|null} */
    this._syncRetryTimeoutId = null;
    this._syncFailCount = 0;
  }

  _getFoundryLightDocById(id) {
    if (!id) return null;

    const key = String(id);

    try {
      const doc = canvas?.scene?.lights?.get?.(key);
      if (doc) return doc;
    } catch (_) {
    }

    try {
      const placeable = canvas?.lighting?.get?.(key);
      const doc = placeable?.document;
      if (doc) return doc;
    } catch (_) {
    }

    try {
      const placeable = canvas?.lighting?.placeables?.find?.((p) => String(p?.document?.id) === key);
      const doc = placeable?.document;
      if (doc) return doc;
    } catch (_) {
    }

    return null;
  }

  _getFoundryEnhancementConfigFallback(id) {
    if (!id) return null;
    const scene = canvas?.scene;
    if (!scene) return null;

    let raw;
    try {
      // Prefer Foundry's flag accessor; during early initialization the flags
      // may not be fully materialized on scene.flags yet, but getFlag works.
      raw = scene.getFlag?.('map-shine-advanced', 'lightEnhancements');
    } catch (_) {
      raw = null;
    }

    if (raw === null || raw === undefined) {
      try {
        raw = scene?.flags?.['map-shine-advanced']?.lightEnhancements;
      } catch (_) {
        raw = null;
      }
    }

    const container = Array.isArray(raw)
      ? { lights: raw }
      : (raw && typeof raw === 'object')
        ? raw
        : null;

    const list = Array.isArray(container?.lights)
      ? container.lights
      : (Array.isArray(container?.items) ? container.items : []);

    const entry = list.find?.((e) => String(e?.id ?? '') === String(id)) ?? null;
    const cfg = entry?.config ?? entry;
    if (cfg && typeof cfg === 'object') return cfg;
    return null;
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'illumination',
          label: 'Global Illumination',
          type: 'inline',
          parameters: ['globalIllumination', 'lightIntensity', 'colorationStrength']
        },
        {
          name: 'occlusion',
          label: 'Occlusion',
          type: 'inline',
          parameters: ['wallInsetPx']
        },
        {
          name: 'darkness',
          label: 'Darkness Response',
          type: 'inline',
          parameters: ['darknessEffect', 'outdoorBrightness', 'negativeDarknessStrength', 'darknessPunchGain']
        },
        {
          name: 'sun',
          label: 'Sun Lights (Indoor Fill)',
          type: 'inline',
          parameters: ['sunIndoorGain', 'sunBlurRadiusPx']
        },
        {
          name: 'lightAnim',
          label: 'Light Animation Behaviour',
          type: 'inline',
          parameters: ['lightAnimWindInfluence', 'lightAnimOutdoorPower']
        },
        {
          name: 'lightning',
          label: 'Lightning (Outside)',
          type: 'inline',
          parameters: [
            'lightningOutsideEnabled',
            'lightningOutsideGain',
            'lightningOutsideShadowEnabled',
            'lightningOutsideShadowStrength',
            'lightningOutsideShadowRadiusPx',
            'lightningOutsideShadowEdgeGain',
            'lightningOutsideShadowInvert'
          ]
        },
        {
          name: 'debug',
          label: 'Debug',
          type: 'folder',
          expanded: false,
          parameters: ['debugShowLightBuffer', 'debugLightBufferExposure', 'debugShowDarknessBuffer', 'debugShowRopeMask']
        },
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        globalIllumination: { type: 'slider', min: 0, max: 2, step: 0.1, default: 1.2 },
        lightIntensity: { type: 'slider', min: 0, max: 2, step: 0.05, default: 0.2, label: 'Light Intensity' },
        colorationStrength: { type: 'slider', min: 0, max: 500, step: 0.05, default: 3.0, label: 'Coloration Strength' },
        wallInsetPx: { type: 'slider', min: 0, max: 40, step: 0.5, default: 6.0, label: 'Wall Inset (px)' },
        darknessEffect: { type: 'slider', min: 0, max: 2, step: 0.05, default: 0.5, label: 'Darkness Effect' },
        outdoorBrightness: { type: 'slider', min: 0.5, max: 2.5, step: 0.05, default: 1.7, label: 'Outdoor Brightness' },
        lightAnimWindInfluence: { type: 'slider', min: 0, max: 3, step: 0.05, default: 1.0, label: 'Wind Influence' },
        lightAnimOutdoorPower: { type: 'slider', min: 0, max: 6, step: 0.25, default: 2.0, label: 'Outdoor Power' },
        lightningOutsideEnabled: { type: 'boolean', default: true, label: 'Enabled' },
        lightningOutsideGain: { type: 'slider', min: 0, max: 3, step: 0.05, default: 1.25, label: 'Flash Gain' },
        lightningOutsideShadowEnabled: { type: 'boolean', default: true, label: 'Edge Shadows' },
        lightningOutsideShadowStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.75, label: 'Shadow Strength' },
        lightningOutsideShadowRadiusPx: { type: 'slider', min: 0, max: 2500, step: 10, default: 520.0, label: 'Shadow Radius (px)' },
        lightningOutsideShadowEdgeGain: { type: 'slider', min: 0, max: 25, step: 0.25, default: 6.0, label: 'Edge Gain' },
        lightningOutsideShadowInvert: { type: 'boolean', default: false, label: 'Invert Side' },
        negativeDarknessStrength: { type: 'slider', min: 0, max: 3, step: 0.1, default: 1.0, label: 'Negative Darkness Strength' },
        darknessPunchGain: { type: 'slider', min: 0, max: 10, step: 0.1, default: 2.0, label: 'Darkness Punch Gain' },
        sunIndoorGain: { type: 'slider', min: 0, max: 20, step: 0.25, default: 1.0, label: 'Indoor Gain' },
        sunBlurRadiusPx: { type: 'slider', min: 0, max: 40, step: 1, default: 5.0, label: 'Blur Radius (px)' },
        debugShowLightBuffer: { type: 'boolean', default: false },
        debugLightBufferExposure: { type: 'number', default: 1.0 },
        debugShowDarknessBuffer: { type: 'boolean', default: false },
        debugShowRopeMask: { type: 'boolean', default: false },
      }
    };
  }

  initialize(renderer, scene, camera) {
    const THREE = window.THREE;
    this.renderer = renderer;
    this.mainCamera = camera;

    if (!this._transparentTex) {
      const data = new Uint8Array([0, 0, 0, 0]);
      this._transparentTex = new THREE.DataTexture(data, 1, 1);
      this._transparentTex.needsUpdate = true;
    }

    this.lightScene = new THREE.Scene();
    this.lightScene.background = new THREE.Color(0x000000); 

    // Separate buffer for Sun Lights (indoor fill). We composite this only into
    // indoor areas so Sun Lights don't over-brighten outdoors.
    this.sunLightScene = new THREE.Scene();
    this.sunLightScene.background = new THREE.Color(0x000000);

    this.darknessScene = new THREE.Scene();
    this.darknessScene.background = new THREE.Color(0x000000);

    this.outdoorsScene = new THREE.Scene();

    this._rebuildOutdoorsProjection();

    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._masksPackScene = new THREE.Scene();
    this._masksPackCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._masksPackMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tRoofAlpha: { value: null },
        tRopeMask: { value: null },
        tOutdoorsMask: { value: null },
        tTokenMask: { value: null },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tRoofAlpha;
        uniform sampler2D tRopeMask;
        uniform sampler2D tOutdoorsMask;
        uniform sampler2D tTokenMask;
        varying vec2 vUv;

        void main() {
          float roofA = texture2D(tRoofAlpha, vUv).a;
          float ropeA = texture2D(tRopeMask, vUv).a;
          float outdoorsR = texture2D(tOutdoorsMask, vUv).r;
          float tokenA = texture2D(tTokenMask, vUv).a;
          gl_FragColor = vec4(outdoorsR, ropeA, tokenA, roofA);
        }
      `,
      depthWrite: false,
      depthTest: false,
      transparent: false,
    });

    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, 
        tLight: { value: null },   
        tSunLight: { value: null },
        tDarkness: { value: null }, 
        tMasks: { value: null },
        tWindowLight: { value: null },
        tOverheadShadow: { value: null }, 
        tBuildingShadow: { value: null }, 
        tBushShadow: { value: null }, 
        tTreeShadow: { value: null }, 
        tCloudShadow: { value: null },
        tCloudTop: { value: null },
        uHasWindowLight: { value: 0.0 },
        uRopeWindowLightBoost: { value: 0.0 },
        uDarknessLevel: { value: 0.0 },
        uAmbientBrightest: { value: new THREE.Color(1, 1, 1) },
        uAmbientDarkness: { value: new THREE.Color(0.141, 0.141, 0.282) },
        uGlobalIllumination: { value: 1.0 },
        uLightIntensity: { value: 1.0 },
        uColorationStrength: { value: 1.0 },
        uOverheadShadowOpacity: { value: 0.0 },
        uOverheadShadowAffectsLights: { value: 0.75 },
        uBuildingShadowOpacity: { value: 0.0 },
        uBushShadowOpacity: { value: 0.0 },
        uTreeShadowOpacity: { value: 0.0 },
        uTreeSelfShadowStrength: { value: 1.0 },
        uCloudShadowOpacity: { value: 0.0 },
        uShadowSunDir: { value: new THREE.Vector2(1, 0) },
        uShadowZoom: { value: 1.0 },
        uBushShadowLength: { value: 0.0 },
        uTreeShadowLength: { value: 0.0 },
        uCompositeTexelSize: { value: new THREE.Vector2(1, 1) },
        uViewportHeight: { value: 1080.0 },
        uOutdoorBrightness: { value: 1.0 },
        uSunIndoorGain: { value: 1.0 },
        uSunBlurRadiusPx: { value: 0.0 },
        uLightningFlash01: { value: 0.0 },
        uLightningOutsideGain: { value: 0.0 },
        uLightningStrikeUv: { value: new THREE.Vector2(0.5, 0.5) },
        uLightningStrikeDir: { value: new THREE.Vector2(0.0, 1.0) },
        uLightningShadowEnabled: { value: 0.0 },
        uLightningShadowStrength: { value: 0.0 },
        uLightningShadowRadiusPx: { value: 0.0 },
        uLightningShadowEdgeGain: { value: 0.0 },
        uLightningShadowInvert: { value: 0.0 },
        uNegativeDarknessStrength: { value: 1.0 },
        uDarknessPunchGain: { value: 2.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform sampler2D tLight;
        uniform sampler2D tSunLight;
        uniform sampler2D tDarkness;
        uniform sampler2D tMasks;
        uniform sampler2D tWindowLight;
        uniform sampler2D tOverheadShadow;
        uniform sampler2D tBuildingShadow;
        uniform sampler2D tBushShadow;
        uniform sampler2D tTreeShadow;
        uniform sampler2D tCloudShadow;
        uniform sampler2D tCloudTop;
        uniform float uHasWindowLight;
        uniform float uRopeWindowLightBoost;
        uniform float uDarknessLevel;
        uniform vec3 uAmbientBrightest;
        uniform vec3 uAmbientDarkness;
        uniform float uGlobalIllumination;
        uniform float uLightIntensity;
        uniform float uColorationStrength;
        uniform float uOverheadShadowOpacity;
        uniform float uOverheadShadowAffectsLights;
        uniform float uBuildingShadowOpacity;
        uniform float uBushShadowOpacity;
        uniform float uTreeShadowOpacity;
        uniform float uTreeSelfShadowStrength;
        uniform float uCloudShadowOpacity;
        uniform vec2  uShadowSunDir;
        uniform float uShadowZoom;
        uniform float uBushShadowLength;
        uniform float uTreeShadowLength;
        uniform vec2  uCompositeTexelSize;
        uniform float uViewportHeight;
        uniform float uOutdoorBrightness;
        uniform float uSunIndoorGain;
        uniform float uSunBlurRadiusPx;
        uniform float uLightningFlash01;
        uniform float uLightningOutsideGain;
        uniform vec2  uLightningStrikeUv;
        uniform vec2  uLightningStrikeDir;
        uniform float uLightningShadowEnabled;
        uniform float uLightningShadowStrength;
        uniform float uLightningShadowRadiusPx;
        uniform float uLightningShadowEdgeGain;
        uniform float uLightningShadowInvert;
        uniform float uNegativeDarknessStrength;
        uniform float uDarknessPunchGain;
        varying vec2 vUv;

        float perceivedBrightness(vec3 c) {
          return dot(c, vec3(0.2126, 0.7152, 0.0722));
        }

        float msSaturate(float x) { return clamp(x, 0.0, 1.0); }

        vec3 sampleSunLight(vec2 uv) {
          // Small gaussian-ish blur kernel in screen UV to soften sun-light edges.
          // Uses pixel radius converted to UV via uCompositeTexelSize.
          float rpx = max(uSunBlurRadiusPx, 0.0);
          if (rpx <= 0.001) {
            return texture2D(tSunLight, uv).rgb;
          }

          vec2 o = uCompositeTexelSize * rpx;

          vec3 c = vec3(0.0);
          c += texture2D(tSunLight, uv).rgb * 4.0;
          c += texture2D(tSunLight, uv + vec2( o.x, 0.0)).rgb * 2.0;
          c += texture2D(tSunLight, uv + vec2(-o.x, 0.0)).rgb * 2.0;
          c += texture2D(tSunLight, uv + vec2(0.0,  o.y)).rgb * 2.0;
          c += texture2D(tSunLight, uv + vec2(0.0, -o.y)).rgb * 2.0;
          c += texture2D(tSunLight, uv + vec2( o.x,  o.y)).rgb;
          c += texture2D(tSunLight, uv + vec2( o.x, -o.y)).rgb;
          c += texture2D(tSunLight, uv + vec2(-o.x,  o.y)).rgb;
          c += texture2D(tSunLight, uv + vec2(-o.x, -o.y)).rgb;
          return c * (1.0 / 16.0);
        }

        void main() {
          vec4 baseColor = texture2D(tDiffuse, vUv);
          vec4 lightSample = texture2D(tLight, vUv);
          float darknessMask = clamp(texture2D(tDarkness, vUv).r, 0.0, 1.0);

          vec4 masks = texture2D(tMasks, vUv);
          float outdoorStrengthBase = clamp(masks.r, 0.0, 1.0);
          float ropeMask = clamp(masks.g, 0.0, 1.0);
          float tokenMask = clamp(masks.b, 0.0, 1.0);
          float roofAlphaRaw = clamp(masks.a, 0.0, 1.0);

          float master = max(uLightIntensity, 0.0);
          float baseDarknessLevel = clamp(uDarknessLevel, 0.0, 1.0);
          vec3 ambientDay = uAmbientBrightest * max(uGlobalIllumination, 0.0);
          vec3 ambientNight = uAmbientDarkness * max(uGlobalIllumination, 0.0);
          vec3 ambient = mix(ambientDay, ambientNight, baseDarknessLevel);

          float roofAlpha = roofAlphaRaw * (1.0 - ropeMask);
          float lightVisibility = 1.0 - roofAlpha;

          float shadowTex = texture2D(tOverheadShadow, vUv).r;
          float shadowOpacity = clamp(uOverheadShadowOpacity, 0.0, 1.0);
          float rawShadowFactor = mix(1.0, shadowTex, shadowOpacity);

          float buildingTex = texture2D(tBuildingShadow, vUv).r;
          float buildingOpacity = clamp(uBuildingShadowOpacity, 0.0, 1.0);
          float rawBuildingFactor = mix(1.0, buildingTex, buildingOpacity);

          vec2 bushDir = normalize(uShadowSunDir);
          float bushPixelLen = uBushShadowLength * max(uViewportHeight, 1.0) * max(uShadowZoom, 0.0001);
          vec2 bushOffsetUv = bushDir * bushPixelLen * uCompositeTexelSize;
          float bushTex = texture2D(tBushShadow, vUv + bushOffsetUv).r;
          // Bush shadow target packs coverage in G (see BushEffect shadow shader).
          // If the current pixel is part of the bush itself, don't apply bush shadows
          // to it (prevents the shadow from appearing on top of the bush overlay).
          float bushSelfCoverage = texture2D(tBushShadow, vUv).g;
          float bushOpacity = clamp(uBushShadowOpacity, 0.0, 1.0);
          float rawBushFactor = mix(1.0, bushTex, bushOpacity);
          rawBushFactor = mix(rawBushFactor, 1.0, clamp(bushSelfCoverage, 0.0, 1.0));

          float treePixelLen = uTreeShadowLength * max(uViewportHeight, 1.0) * max(uShadowZoom, 0.0001);
          vec2 treeOffsetUv = bushDir * treePixelLen * uCompositeTexelSize;
          float treeTex = texture2D(tTreeShadow, vUv + treeOffsetUv).r;
          // Tree shadow target packs coverage in G (see TreeEffect shadow shader).
          // If the current pixel is part of the tree itself, don't apply tree shadows
          // to it (prevents the shadow from appearing on top of the tree overlay).
          float treeSelfCoverage = texture2D(tTreeShadow, vUv).g;
          float treeOpacity = clamp(uTreeShadowOpacity, 0.0, 1.0);
          float rawTreeFactor = mix(1.0, treeTex, treeOpacity);
          rawTreeFactor = mix(rawTreeFactor, 1.0, clamp(treeSelfCoverage, 0.0, 1.0));

          float cloudTex = texture2D(tCloudShadow, vUv).r;
          float cloudOpacity = clamp(uCloudShadowOpacity, 0.0, 1.0);
          float cloudFactor = mix(1.0, cloudTex, cloudOpacity);

          float shadowFactor = mix(rawShadowFactor, 1.0, roofAlphaRaw);
          float buildingFactor = mix(rawBuildingFactor, 1.0, roofAlphaRaw);
          float bushFactor = mix(rawBushFactor, 1.0, roofAlphaRaw);
          float treeFactor = mix(rawTreeFactor, 1.0, roofAlphaRaw);

          float outdoorStrength = max(outdoorStrengthBase, roofAlphaRaw);
          shadowFactor = mix(1.0, shadowFactor, outdoorStrength);
          buildingFactor = mix(1.0, buildingFactor, outdoorStrength);
          bushFactor = mix(1.0, bushFactor, outdoorStrength);
          treeFactor = mix(1.0, treeFactor, outdoorStrength);

          float combinedShadowFactor = shadowFactor * buildingFactor * bushFactor * treeFactor * cloudFactor;

          float kd = clamp(uOverheadShadowAffectsLights, 0.0, 1.0);
          vec3 shadedAmbient = ambient * combinedShadowFactor;

          vec3 baseLights = lightSample.rgb * lightVisibility * (1.0 - ropeMask);
          bool badLight = (baseLights.r != baseLights.r) || (baseLights.g != baseLights.g) || (baseLights.b != baseLights.b);
          if (badLight) {
            baseLights = vec3(0.0);
          }

          vec3 shadedLights = mix(baseLights, baseLights * combinedShadowFactor, kd);

          vec3 windowLightIllum = vec3(0.0);
          if (uHasWindowLight > 0.5) {
            windowLightIllum = texture2D(tWindowLight, vUv).rgb;
          }

          vec3 safeLights = max(shadedLights, vec3(0.0));
          float lightI = max(max(safeLights.r, safeLights.g), safeLights.b);

          // Sun Light (indoor fill) contribution: only apply in indoor regions.
          // Indoors are represented by low outdoors mask values.
          vec3 sunSample = max(sampleSunLight(vUv), vec3(0.0));
          float sunI = max(max(sunSample.r, sunSample.g), sunSample.b);
          float indoorGate = msSaturate(1.0 - outdoorStrengthBase);
          // Match the same visibility gating applied to normal light buffer.
          float dayBoostSun = uOutdoorBrightness;
          float nightDimSun = clamp(2.0 - uOutdoorBrightness, 0.0, 1.0);
          float sunOutdoorRef = mix(dayBoostSun, nightDimSun, uDarknessLevel);
          sunI *= max(uSunIndoorGain, 0.0) * sunOutdoorRef * indoorGate * lightVisibility * (1.0 - ropeMask);

          vec3 totalIllumination = shadedAmbient + vec3(lightI) * master;

          float dMask = clamp(darknessMask, 0.0, 1.0);
          float lightTermI = max((lightI + sunI) * master, 0.0);
          float punch = 1.0 - exp(-lightTermI * max(uDarknessPunchGain, 0.0));

          float localDarknessLevel = clamp(baseDarknessLevel * (1.0 - punch * max(uNegativeDarknessStrength, 0.0)), 0.0, 1.0);
          vec3 shadedAmbientPunched = mix(ambientDay, ambientNight, localDarknessLevel) * combinedShadowFactor;

          // Treat window light as an ambient-like illumination term, shaded by the
          // same overhead/bush/tree/building/cloud factors.
          shadedAmbientPunched += windowLightIllum * combinedShadowFactor;

          float punchedMask = clamp(dMask - punch * max(uNegativeDarknessStrength, 0.0), 0.0, 1.0);

          vec3 ambientAfterDark = shadedAmbientPunched * (1.0 - punchedMask);
          totalIllumination = ambientAfterDark + vec3(lightI) * master;

          // Apply sun illumination after darkness is punched so it acts like
          // a fill light for dim interiors without affecting outdoor exposure.
          totalIllumination += vec3(sunI) * master;

          bool badIllum = (totalIllumination.r != totalIllumination.r) ||
                          (totalIllumination.g != totalIllumination.g) ||
                          (totalIllumination.b != totalIllumination.b);
          if (badIllum) {
            totalIllumination = ambient;
          }

          vec3 minIllum = mix(ambientDay, ambientNight, localDarknessLevel) * 0.1;
          totalIllumination = max(totalIllumination, minIllum);

          vec3 litColor = baseColor.rgb * totalIllumination;

          float reflection = perceivedBrightness(baseColor.rgb);
          vec3 coloration = safeLights * master * reflection * max(uColorationStrength, 0.0);
          litColor += coloration;

          // Optional rope boost: apply window lighting as illumination (albedo * light)
          // instead of additive-on-top, to preserve saturation.
          if (uHasWindowLight > 0.5 && uRopeWindowLightBoost > 0.0001 && ropeMask > 0.001) {
            float ropeLuma = perceivedBrightness(baseColor.rgb);
            float ropeGate = smoothstep(0.25, 0.6, ropeLuma);
            vec3 ropeWindowIllum = windowLightIllum * max(uRopeWindowLightBoost, 0.0) * ropeMask * ropeGate;
            litColor += baseColor.rgb * ropeWindowIllum;
          }

          float dayBoost = uOutdoorBrightness;
          float nightDim = clamp(2.0 - uOutdoorBrightness, 0.0, 1.0);
          float outdoorMultiplier = mix(dayBoost, nightDim, uDarknessLevel);

          float flash01 = msSaturate(uLightningFlash01);
          float flashGain = max(uLightningOutsideGain, 0.0);

          float shadow = 0.0;
          if (flash01 > 0.0001 && uLightningShadowEnabled > 0.5) {
            vec2 ts = max(uCompositeTexelSize, vec2(1.0 / 4096.0));
            vec2 suv = clamp(uLightningStrikeUv, vec2(0.001), vec2(0.999));

            float sx1 = texture2D(tMasks, clamp(suv + vec2(ts.x, 0.0), vec2(0.001), vec2(0.999))).r;
            float sx0 = texture2D(tMasks, clamp(suv - vec2(ts.x, 0.0), vec2(0.001), vec2(0.999))).r;
            float sy1 = texture2D(tMasks, clamp(suv + vec2(0.0, ts.y), vec2(0.001), vec2(0.999))).r;
            float sy0 = texture2D(tMasks, clamp(suv - vec2(0.0, ts.y), vec2(0.001), vec2(0.999))).r;

            vec2 grad = vec2(sx1 - sx0, sy1 - sy0);
            float gl2 = dot(grad, grad);
            vec2 edgeN = (gl2 > 1e-6) ? (grad * inversesqrt(gl2)) : vec2(0.0, 1.0);

            vec2 dir = uLightningStrikeDir;
            float dl2 = dot(dir, dir);
            dir = (dl2 > 1e-6) ? (dir * inversesqrt(dl2)) : vec2(0.0, -1.0);

            float sideSign = (dot(edgeN, dir) >= 0.0) ? 1.0 : -1.0;
            sideSign = mix(sideSign, -sideSign, step(0.5, uLightningShadowInvert));

            float plane = sideSign * dot(edgeN, (vUv - suv));
            float halfPlane = step(0.0, plane);

            float edgeStrength = msSaturate(sqrt(gl2) * max(uLightningShadowEdgeGain, 0.0));

            vec2 dv = (vUv - suv);
            float distPx = length(dv / ts);
            float radius = max(uLightningShadowRadiusPx, 0.0);
            float distFactor = (radius > 0.5) ? (1.0 - smoothstep(0.0, radius, distPx)) : 1.0;

            shadow = halfPlane * edgeStrength * distFactor * msSaturate(uLightningShadowStrength);
          }

          outdoorMultiplier *= (1.0 + flash01 * flashGain * (1.0 - shadow));
          float finalMultiplier = mix(1.0, outdoorMultiplier, outdoorStrength);
          litColor *= finalMultiplier;

          vec4 cloudTop = texture2D(tCloudTop, vUv);
          vec3 cloudRgb = cloudTop.rgb;
          float cloudDark = mix(1.0, 0.25, clamp(uDarknessLevel, 0.0, 1.0));

          float cloudOutdoorMult = mix(1.0, outdoorMultiplier, outdoorStrength);
          cloudRgb *= cloudOutdoorMult;

          cloudRgb *= cloudDark;
          cloudRgb *= (1.0 - min(punchedMask * 2.0, 1.0));
          litColor = mix(litColor, cloudRgb, cloudTop.a);

          gl_FragColor = vec4(litColor, baseColor.a);
        }
      `,
      depthWrite: false,
      depthTest: false,
      transparent: false,
    });

    // Debug materials are deferred — created on first use via
    // _ensureDebugMaterials() to avoid compiling 3 extra shader programs
    // that are only needed when the user activates a debug view.
    this.debugLightBufferMaterial = null;
    this.debugRopeMaskMaterial = null;
    this.debugDarknessBufferMaterial = null;

    this._quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMaterial);
    this.quadScene.add(this._quadMesh);

    this._masksPackMesh = new THREE.Mesh(this._quadMesh.geometry, this._masksPackMaterial);
    this._masksPackScene.add(this._masksPackMesh);

    // Hooks to Foundry
    // Store refs so we can remove them in dispose() (avoid duplicate hook registrations
    // on scene transitions / hot reload).
    const createHandler = (doc) => this.onLightUpdate(doc);
    const updateHandler = (doc, changes) => this.onLightUpdate(doc, changes);
    const deleteHandler = (doc) => this.onLightDelete(doc);

    Hooks.on('createAmbientLight', createHandler);
    Hooks.on('updateAmbientLight', updateHandler);
    Hooks.on('deleteAmbientLight', deleteHandler);
    this._hookRegistrations.push({ hook: 'createAmbientLight', fn: createHandler });
    this._hookRegistrations.push({ hook: 'updateAmbientLight', fn: updateHandler });
    this._hookRegistrations.push({ hook: 'deleteAmbientLight', fn: deleteHandler });
    
    // Listen for lightingRefresh to rebuild any lights that were created before
    // Foundry computed their LOS polygons (fixes lights extending through walls
    // on initial creation/paste).
    const lightingRefreshHandler = () => this.onLightingRefresh();
    Hooks.on('lightingRefresh', lightingRefreshHandler);
    this._hookRegistrations.push({ hook: 'lightingRefresh', fn: lightingRefreshHandler });
    
    // Watch for scene-flag updates which might modify MapShine-native enhanced lights
    // or Foundry-first light enhancements.
    const updateSceneHandler = (sceneDoc, changes) => {
      try {
        if (!sceneDoc || !canvas?.scene) return;
        if (sceneDoc.id !== canvas.scene.id) return;

        const keys = changes && typeof changes === 'object' ? Object.keys(changes) : [];
        const flagKeyChanged = keys.some((k) => k === 'flags' || (typeof k === 'string' && k.startsWith('flags.map-shine-advanced')));
        const namespaceChanged = !!(changes?.flags && changes.flags['map-shine-advanced']);
        if (!flagKeyChanged && !namespaceChanged) return;

        this._reloadMapshineLightsFromScene();

        const enhancementStore = window.MapShine?.lightEnhancementStore;
        if (enhancementStore && typeof enhancementStore.load === 'function') {
          enhancementStore.load(sceneDoc)
            .then(() => {
              canvas?.lighting?.placeables?.forEach?.((p) => this.onLightUpdate(p.document));
            })
            .catch(() => {});
        }
      } catch (_) {
      }
    };

    Hooks.on('updateScene', updateSceneHandler);
    this._hookRegistrations.push({ hook: 'updateScene', fn: updateSceneHandler });
    
    // Initial Load
    this.syncAllLights();
  }

  _toFoundryLikeDocForMapshineEntity(entity) {
    const id = `mapshine:${entity.id}`;
    const a = entity.animation;
    const dr = entity.darknessResponse;

    // 1) Defaults/snapshot values from the MapShine entity (scene flags)
    let x = entity.transform?.x ?? 0;
    let y = entity.transform?.y ?? 0;

    let dim = entity.photometry?.dim ?? 0;
    let bright = entity.photometry?.bright ?? 0;
    let attenuation = entity.photometry?.attenuation ?? 0.5;
    let alpha = entity.photometry?.alpha ?? 0.5;
    let luminosity = entity.photometry?.luminosity ?? 0.5;
    let color = entity.color;

    // 2) Critical: if this MapShine light is linked to a Foundry light, override
    // the snapshot physical light properties with the live Foundry document.
    // Enhancements (cookie/output shaping) still come from flags.
    if (entity.linkedFoundryLightId) {
      const doc = this._getFoundryLightDocById(entity.linkedFoundryLightId);
      if (doc) {
        x = Number(doc?.x ?? x);
        y = Number(doc?.y ?? y);

        const c = doc?.config ?? {};
        dim = Number(c?.dim ?? dim);
        bright = Number(c?.bright ?? bright);
        if (Number.isFinite(c?.attenuation)) attenuation = c.attenuation;
        if (Number.isFinite(c?.alpha)) alpha = c.alpha;
        if (Number.isFinite(c?.luminosity)) luminosity = c.luminosity;
        if (c?.color !== undefined) color = c.color;
      }
    }

    const hasCookieTex = (typeof entity.cookieTexture === 'string' && entity.cookieTexture.trim());
    const cookieEnabled = (entity.cookieEnabled === true) || (entity.cookieEnabled === undefined && !!hasCookieTex);

    return {
      id,
      x,
      y,
      config: {
        dim,
        bright,
        attenuation,
        alpha,
        luminosity,
        color,

        // MapShine-only shaping
        outputGain: entity.outputGain,
        outerWeight: entity.outerWeight,
        innerWeight: entity.innerWeight,

        darknessResponse: (dr && typeof dr === 'object') ? { ...dr } : undefined,

        // Cookie params always come from flags
        cookieEnabled,
        cookieTexture: entity.cookieTexture,
        cookieRotation: entity.cookieRotation,
        cookieScale: entity.cookieScale,
        cookieTint: entity.cookieTint,
        cookieStrength: entity.cookieStrength,
        cookieContrast: entity.cookieContrast,
        cookieGamma: entity.cookieGamma,
        cookieInvert: entity.cookieInvert === true,
        cookieColorize: entity.cookieColorize === true,

        animation: (a && typeof a === 'object')
          ? { ...a, type: a.type ?? null }
          : {}
      }
    };
  }

  _syncMapshineRenderables(entities) {
    const keep = new Set();

    // Three.js layer constants for layer-aware lighting
    // These can be used in future to render ground-only vs overhead-only lights
    const GROUND_LIGHT_LAYER = 22;
    const OVERHEAD_LIGHT_LAYER = 23;

    for (const entity of entities) {
      if (!entity?.id) continue;
      const id = `mapshine:${entity.id}`;
      keep.add(id);

      // Respect enabled flag: a disabled MapShine light should contribute nothing.
      // We actively remove any existing renderables so toggling enabled is immediate.
      if (entity.enabled === false) {
        try {
          if (this.mapshineLights.has(id)) {
            const ls = this.mapshineLights.get(id);
            if (ls?.mesh) {
              this.lightScene?.remove(ls.mesh);
              this.sunLightScene?.remove(ls.mesh);
            }
            ls?.dispose?.();
            this.mapshineLights.delete(id);
          }
        } catch (_) {
        }

        try {
          if (this.mapshineDarknessSources.has(id)) {
            const ds = this.mapshineDarknessSources.get(id);
            if (ds?.mesh) this.darknessScene?.remove(ds.mesh);
            ds?.dispose?.();
            this.mapshineDarknessSources.delete(id);
          }
        } catch (_) {
        }

        // Still keep metadata up to date (e.g. targetLayers) if present.
        const targetLayers = entity.targetLayers || 'both';
        this._mapshineLightMeta.set(id, {
          targetLayers,
          cookieTexture: entity.cookieTexture,
          cookieRotation: entity.cookieRotation,
          cookieScale: entity.cookieScale,
          cookieTint: entity.cookieTint
        });
        continue;
      }

      const doc = this._toFoundryLikeDocForMapshineEntity(entity);

      // Store layer targeting metadata
      const targetLayers = entity.targetLayers || 'both';
      this._mapshineLightMeta.set(id, {
        targetLayers,
        cookieTexture: entity.cookieTexture,
        cookieRotation: entity.cookieRotation,
        cookieScale: entity.cookieScale,
        cookieTint: entity.cookieTint
      });

      if (entity.isDarkness) {
        if (this.mapshineLights.has(id)) {
          const ls = this.mapshineLights.get(id);
          if (ls?.mesh) {
            this.lightScene?.remove(ls.mesh);
            this.sunLightScene?.remove(ls.mesh);
          }
          ls?.dispose?.();
          this.mapshineLights.delete(id);
        }

        if (this.mapshineDarknessSources.has(id)) {
          this.mapshineDarknessSources.get(id).updateData(doc);
        } else {
          const source = new ThreeDarknessSource(doc);
          source.init();
          this.mapshineDarknessSources.set(id, source);
          if (source.mesh && this.darknessScene) {
            // Assign Three.js layers based on targetLayers
            this._applyLayerTargeting(source.mesh, targetLayers, GROUND_LIGHT_LAYER, OVERHEAD_LIGHT_LAYER);
            this.darknessScene.add(source.mesh);
          }
        }
      } else {
        if (this.mapshineDarknessSources.has(id)) {
          const ds = this.mapshineDarknessSources.get(id);
          if (ds?.mesh) this.darknessScene?.remove(ds.mesh);
          ds?.dispose?.();
          this.mapshineDarknessSources.delete(id);
        }

        const isSunLight = entity?.darknessResponse?.enabled === true;

        if (this.mapshineLights.has(id)) {
          this.mapshineLights.get(id).updateData(doc);
          // Update layer targeting on existing mesh
          const src = this.mapshineLights.get(id);
          if (src?.mesh) {
            // Move between scenes if the light changed type.
            try {
              if (isSunLight) {
                this.lightScene?.remove(src.mesh);
                if (this.sunLightScene && src.mesh?.parent !== this.sunLightScene) {
                  this.sunLightScene.add(src.mesh);
                }
              } else {
                this.sunLightScene?.remove(src.mesh);
                if (this.lightScene && src.mesh?.parent !== this.lightScene) {
                  this.lightScene.add(src.mesh);
                }
              }
            } catch (_) {
            }
            this._applyLayerTargeting(src.mesh, targetLayers, GROUND_LIGHT_LAYER, OVERHEAD_LIGHT_LAYER);
          }
        } else {
          const source = new ThreeLightSource(doc);
          source.init();
          this.mapshineLights.set(id, source);
          if (source.mesh && (this.lightScene || this.sunLightScene)) {
            // Assign Three.js layers based on targetLayers
            this._applyLayerTargeting(source.mesh, targetLayers, GROUND_LIGHT_LAYER, OVERHEAD_LIGHT_LAYER);

            if (isSunLight) {
              this.sunLightScene?.add(source.mesh);
            } else {
              this.lightScene?.add(source.mesh);
            }
          }
        }
      }
    }

    for (const [id, src] of this.mapshineLights) {
      if (keep.has(id)) continue;
      try {
        if (src?.mesh) {
          this.lightScene?.remove(src.mesh);
          this.sunLightScene?.remove(src.mesh);
        }
        src?.dispose?.();
      } catch (_) {
      }
      this.mapshineLights.delete(id);
      this._mapshineLightMeta.delete(id);
    }

    for (const [id, src] of this.mapshineDarknessSources) {
      if (keep.has(id)) continue;
      try {
        if (src?.mesh) this.darknessScene?.remove(src.mesh);
        src?.dispose?.();
      } catch (_) {
      }
      this.mapshineDarknessSources.delete(id);
      this._mapshineLightMeta.delete(id);
    }
  }

  /**
   * Apply Three.js layer targeting to a light mesh based on targetLayers setting.
   * @param {THREE.Mesh} mesh
   * @param {'ground'|'overhead'|'both'} targetLayers
   * @param {number} groundLayer - Three.js layer for ground-only lights
   * @param {number} overheadLayer - Three.js layer for overhead-only lights
   * @private
   */
  _applyLayerTargeting(mesh, targetLayers, groundLayer, overheadLayer) {
    if (!mesh?.layers) return;

    // Always enable layer 0 (default) so the light renders in the combined pass
    mesh.layers.enable(0);

    // Enable/disable specific layers for future layer-filtered rendering
    if (targetLayers === 'ground') {
      mesh.layers.enable(groundLayer);
      mesh.layers.disable(overheadLayer);
    } else if (targetLayers === 'overhead') {
      mesh.layers.disable(groundLayer);
      mesh.layers.enable(overheadLayer);
    } else {
      // 'both' - enable both layers
      mesh.layers.enable(groundLayer);
      mesh.layers.enable(overheadLayer);
    }
  }

  /**
   * Get metadata for a MapShine-native light by its prefixed id.
   * @param {string} id - Prefixed id (e.g., 'mapshine:abc123')
   * @returns {{targetLayers: string, cookieTexture?: string, cookieRotation?: number, cookieScale?: number, cookieTint?: string}|null}
   */
  getMapshineLightMeta(id) {
    return this._mapshineLightMeta.get(id) || null;
  }

  /**
   * Get all MapShine-native lights filtered by target layer.
   * @param {'ground'|'overhead'|'both'} layer
   * @returns {ThreeLightSource[]}
   */
  getMapshineLightsByLayer(layer) {
    const result = [];
    for (const [id, source] of this.mapshineLights) {
      const meta = this._mapshineLightMeta.get(id);
      const targetLayers = meta?.targetLayers || 'both';
      if (targetLayers === layer || targetLayers === 'both' || layer === 'both') {
        result.push(source);
      }
    }
    return result;
  }

  _reloadMapshineLightsFromScene() {
    try {
      const msEntities = MapShineLightAdapter.readEntities(canvas?.scene);
      this.lightRegistry.setMapshineEntities(msEntities);
      this._rebuildOverriddenFoundrySet(msEntities);
      this._syncMapshineRenderables(msEntities);
      this._applyFoundryOverrides();
    } catch (_) {
      this.lightRegistry.setMapshineEntities([]);
      this._overriddenFoundryLightIds.clear();
      this._syncMapshineRenderables([]);
    }
  }

  /**
   * Rebuild the set of Foundry light IDs that should be suppressed because
   * a MapShine enhanced light overrides them.
   * @param {ILightEntity[]} entities
   * @private
   */
  _rebuildOverriddenFoundrySet(entities) {
    this._overriddenFoundryLightIds.clear();
    if (!Array.isArray(entities)) return;

    for (const e of entities) {
      if (!e?.enabled) continue;
      if (e.overrideFoundry && e.linkedFoundryLightId) {
        this._overriddenFoundryLightIds.add(String(e.linkedFoundryLightId));
      }
    }
  }

  /**
   * Hide or show Foundry light renderables based on override state.
   * Called after MapShine lights are reloaded.
   * @private
   */
  _applyFoundryOverrides() {
    const sceneDarkness = this._getSceneDarknessLevel();
    for (const [id, source] of this.lights.entries()) {
      const suppressed = this._overriddenFoundryLightIds.has(id);
      const isActive = this._isLightActiveForDarkness(source?.document, sceneDarkness);
      if (source?.mesh) {
        source.mesh.visible = isActive && !suppressed;
      }
    }
    for (const [id, source] of this.darknessSources.entries()) {
      const suppressed = this._overriddenFoundryLightIds.has(id);
      const isActive = this._isLightActiveForDarkness(source?.document, sceneDarkness);
      if (source?.mesh) {
        source.mesh.visible = isActive && !suppressed;
      }
    }
  }

  _rebuildOutdoorsProjection() {
    const THREE = window.THREE;
    if (!THREE) return;

    if (this.outdoorsMesh && this.outdoorsScene) {
      this.outdoorsScene.remove(this.outdoorsMesh);
    }
    this.outdoorsMesh = null;
    this.outdoorsMaterial = null;

    if (!this.outdoorsScene || !this.outdoorsMask || !this._baseMesh) {
      return;
    }

    this.outdoorsMaterial = new THREE.MeshBasicMaterial({
      map: this.outdoorsMask,
      transparent: false,
      depthWrite: false,
      depthTest: false
    });

    this.outdoorsMesh = new THREE.Mesh(this._baseMesh.geometry, this.outdoorsMaterial);
    this.outdoorsMesh.position.copy(this._baseMesh.position);
    this.outdoorsMesh.rotation.copy(this._baseMesh.rotation);
    this.outdoorsMesh.scale.copy(this._baseMesh.scale);

    this.outdoorsScene.add(this.outdoorsMesh);
  }

  onResize(width, height) {
    const THREE = window.THREE;
    if (this.lightTarget) this.lightTarget.dispose();
    if (this.sunLightTarget) this.sunLightTarget.dispose();
    if (this.darknessTarget) this.darknessTarget.dispose();
    this.lightTarget = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType // HDR capable
    });

    this.sunLightTarget = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType // HDR capable
    });
  }

  setBaseMesh(baseMesh, assetBundle) {
    const THREE = window.THREE;
    if (!assetBundle || !assetBundle.masks) return;

    this._baseMesh = baseMesh;

    const outdoorsData = assetBundle.masks.find(m => m.id === 'outdoors');

    this.outdoorsMask = outdoorsData?.texture || null;

    this._rebuildOutdoorsProjection();
  }

  syncAllLights() {
    // During Foundry startup, LightingEffect.initialize() can run before the lighting
    // layer has finished constructing its placeables. If we sync too early, we can
    // miss applying enhancements (cookies) until a later user-driven update.
    // Make this deterministic by retrying briefly and falling back to scene docs.
    let lightingReady = false;
    let docs = [];

    try {
      const placeables = canvas?.lighting?.placeables;
      if (Array.isArray(placeables) && placeables.length > 0) {
        lightingReady = true;
        docs = placeables.map((p) => p?.document).filter(Boolean);
      }
    } catch (_) {
    }

    // Fallback: build from scene light documents even if placeables aren't ready yet.
    // This ensures cookies/enhancements can still apply on first render.
    if (docs.length === 0) {
      try {
        const sceneLights = canvas?.scene?.lights;
        const list = Array.isArray(sceneLights?.contents)
          ? sceneLights.contents
          : (typeof sceneLights?.forEach === 'function')
            ? (() => {
              const tmp = [];
              sceneLights.forEach((d) => tmp.push(d));
              return tmp;
            })()
            : [];
        if (list.length > 0) docs = list;
      } catch (_) {
      }
    }

    // If we still don't have any docs but the scene claims there are lights, retry.
    // This catches the common race where placeables are created just after we initialize.
    try {
      const expected = Number(canvas?.scene?.lights?.size ?? 0);
      const haveAny = docs.length > 0;
      if (!haveAny && expected > 0) {
        this._syncFailCount = Math.min(20, (this._syncFailCount || 0) + 1);
        const delayMs = Math.min(4000, 100 * Math.pow(2, Math.max(0, this._syncFailCount - 1)));
        if (this._syncRetryTimeoutId !== null) {
          try { clearTimeout(this._syncRetryTimeoutId); } catch (_) {}
          this._syncRetryTimeoutId = null;
        }
        this._syncRetryTimeoutId = setTimeout(() => {
          this.syncAllLights();
        }, delayMs);
        return;
      }
    } catch (_) {
    }

    // We reached a stable enough state to build lights; clear any pending retry.
    if (this._syncRetryTimeoutId !== null) {
      try { clearTimeout(this._syncRetryTimeoutId); } catch (_) {}
      this._syncRetryTimeoutId = null;
    }
    this._syncFailCount = 0;

    this.lights.forEach(l => l.dispose());
    this.lights.clear();
    this.darknessSources.forEach(d => d.dispose());
    this.darknessSources.clear();

    this.mapshineLights.forEach((l) => l?.dispose?.());
    this.mapshineLights.clear();
    this.mapshineDarknessSources.forEach((d) => d?.dispose?.());
    this.mapshineDarknessSources.clear();
    
    // Reset registry + rebuild from Foundry.
    this.lightRegistry.foundryLights.clear();
    this.lightRegistry.foundryDarkness.clear();

    // Load MapShine-native enhanced lights (if any) and build renderables.
    this._reloadMapshineLightsFromScene();

    this.lightRegistry.version++;

    // If placeables are ready, prefer them (they reflect visibility/hidden state);
    // otherwise use the doc fallback gathered above.
    if (lightingReady) {
      try {
        canvas.lighting.placeables.forEach(p => this.onLightUpdate(p.document));
      } catch (_) {
        docs.forEach((d) => this.onLightUpdate(d));
      }
    } else {
      docs.forEach((d) => this.onLightUpdate(d));
    }

    // Ensure a frame is rendered after a full rebuild even if the render loop is
    // currently idle-throttled.
    try {
      window.MapShine?.renderLoop?.requestRender?.();
      window.MapShine?.renderLoop?.requestContinuousRender?.(100);
    } catch (_) {
    }
  }

  _mergeLightDocChanges(doc, changes) {
    if (!doc) return doc;

    let base;
    try {
      base = (typeof doc.toObject === 'function') ? doc.toObject() : doc;
    } catch (_) {
      base = doc;
    }

    // Foundry toObject() often returns _id instead of id; normalize for downstream lookups.
    if (base && base.id === undefined && base._id !== undefined) {
      base = { ...base, id: base._id };
    }

    // Common path: on initial sync or create events we often call onLightUpdate(doc)
    // without a changes payload. Always return a plain object so downstream merging
    // (including MapShine enhancements like cookies) behaves consistently.
    if (!changes || typeof changes !== 'object') return base;

    let expandedChanges = changes;
    try {
      const hasDotKeys = Object.keys(changes).some((k) => k.includes('.'));
      if (hasDotKeys && foundry?.utils?.expandObject) {
        expandedChanges = foundry.utils.expandObject(changes);
      }
    } catch (_) {
      expandedChanges = changes;
    }

    try {
      if (foundry?.utils?.mergeObject) {
        const merged = foundry.utils.mergeObject(base, expandedChanges, {
          inplace: false,
          overwrite: true,
          recursive: true,
          insertKeys: true,
          insertValues: true
        });
        if (merged && merged.id === undefined && merged._id !== undefined) {
          merged.id = merged._id;
        }
        return merged;
      }
    } catch (_) {
    }

    const merged = { ...base, ...expandedChanges };
    if (base?.config || expandedChanges?.config) {
      merged.config = { ...(base?.config ?? {}), ...(expandedChanges?.config ?? {}) };
    }
    if (merged && merged.id === undefined && merged._id !== undefined) {
      merged.id = merged._id;
    }
    return merged;
  }

  _applyFoundryEnhancements(doc) {
    if (!doc) return doc;

    const docId = doc.id ?? doc._id;
    if (!docId) return doc;

    const store = window.MapShine?.lightEnhancementStore;
    const enhancement = store?.getCached?.(docId);
    let config = enhancement?.config;

    // If the in-memory cache isn't populated for some reason, fall back to directly
    // reading scene flags synchronously so enhancements can't temporarily "drop"
    // during Foundry doc updates.
    if (!config || typeof config !== 'object') {
      config = this._getFoundryEnhancementConfigFallback(docId);
    }

    if (!config || typeof config !== 'object') return doc;

    // Normalize numeric types (scene flags can sometimes deserialize numbers as strings).
    const n = (v, d) => {
      const x = (typeof v === 'string') ? Number(v) : v;
      return Number.isFinite(x) ? x : d;
    };

    const normalized = {
      ...config,
      cookieRotation: (config.cookieRotation !== undefined) ? n(config.cookieRotation, undefined) : undefined,
      cookieScale: (config.cookieScale !== undefined) ? n(config.cookieScale, undefined) : undefined,
      cookieStrength: (config.cookieStrength !== undefined) ? n(config.cookieStrength, 1.0) : undefined,
      cookieContrast: (config.cookieContrast !== undefined) ? n(config.cookieContrast, 1.0) : undefined,
      cookieGamma: (config.cookieGamma !== undefined) ? n(config.cookieGamma, 1.0) : undefined,
      outputGain: (config.outputGain !== undefined) ? n(config.outputGain, 1.0) : undefined,
      outerWeight: (config.outerWeight !== undefined) ? n(config.outerWeight, 0.5) : undefined,
      innerWeight: (config.innerWeight !== undefined) ? n(config.innerWeight, 0.5) : undefined,
    };

    // Only allow enhancement-owned keys to merge into Foundry's config.
    // This prevents legacy/stale keys stored in scene flags (e.g. luminosity/alpha)
    // from overriding the live Foundry light configuration after a reload.
    const enh = {};
    const allow = (k) => {
      if (normalized[k] !== undefined) enh[k] = normalized[k];
    };

    // Cookie/gobo
    allow('cookieEnabled');
    allow('cookieTexture');
    allow('cookieRotation');
    allow('cookieScale');
    allow('cookieTint');
    allow('cookieStrength');
    allow('cookieContrast');
    allow('cookieGamma');
    allow('cookieInvert');
    allow('cookieColorize');

    // Output shaping
    allow('outputGain');
    allow('outerWeight');
    allow('innerWeight');

    // Layer targeting
    allow('targetLayers');

    // Darkness response (sun lights)
    allow('darknessResponse');

    if (Object.keys(enh).length === 0) return { ...doc, id: docId };

    return {
      ...doc,
      id: docId,
      config: {
        ...(doc?.config ?? {}),
        ...enh
      }
    };
  }

  onLightUpdate(doc, changes) {
    const mergedDoc = this._mergeLightDocChanges(doc, changes);
    const targetDoc = this._applyFoundryEnhancements(mergedDoc);
    const sceneDarkness = this._getSceneDarknessLevel();

    const targetLayers = (targetDoc?.config?.targetLayers === 'ground' || targetDoc?.config?.targetLayers === 'overhead')
      ? targetDoc.config.targetLayers
      : 'both';

    const GROUND_LIGHT_LAYER = 22;
    const OVERHEAD_LIGHT_LAYER = 23;

    const isNegative = (targetDoc?.config?.negative === true) || (targetDoc?.negative === true);

    // Update unified data model.
    try {
      const entity = LightRegistry.fromFoundryAmbientLightDoc(targetDoc);
      this.lightRegistry.upsertFoundryEntity(entity);
    } catch (_) {
    }

    const isSuppressed = this._overriddenFoundryLightIds.has(targetDoc.id);

    // If this Foundry light is overridden by a linked MapShine light, update that
    // MapShine renderable immediately so physical properties stay authoritative.
    if (isSuppressed) {
      try {
        for (const msEntity of this.lightRegistry.mapshineLights.values()) {
          if (!msEntity?.enabled) continue;
          if (msEntity.overrideFoundry !== true) continue;
          if (String(msEntity.linkedFoundryLightId ?? '') !== String(targetDoc.id)) continue;

          const msId = `mapshine:${msEntity.id}`;
          const msDoc = this._toFoundryLikeDocForMapshineEntity(msEntity);
          if (msEntity.isDarkness) {
            const ds = this.mapshineDarknessSources.get(msId);
            if (ds) ds.updateData(msDoc);
          } else {
            const ls = this.mapshineLights.get(msId);
            if (ls) ls.updateData(msDoc);
          }
        }
      } catch (_) {
      }
    }

    const isSunLight = targetDoc?.config?.darknessResponse?.enabled === true;

    if (isNegative) {
      if (this.darknessSources.has(targetDoc.id)) {
        this.darknessSources.get(targetDoc.id).updateData(targetDoc);
        const src = this.darknessSources.get(targetDoc.id);
        if (src?.mesh) {
          const isActive = this._isLightActiveForDarkness(targetDoc, sceneDarkness);
          src.mesh.visible = isActive && !isSuppressed;
          this._applyLayerTargeting(src.mesh, targetLayers, GROUND_LIGHT_LAYER, OVERHEAD_LIGHT_LAYER);
        }
      } else {
        const source = new ThreeDarknessSource(targetDoc);
        source.init();
        this.darknessSources.set(targetDoc.id, source);
        if (source.mesh && this.darknessScene) {
          const isActive = this._isLightActiveForDarkness(targetDoc, sceneDarkness);
          source.mesh.visible = isActive && !isSuppressed;
          this._applyLayerTargeting(source.mesh, targetLayers, GROUND_LIGHT_LAYER, OVERHEAD_LIGHT_LAYER);
          this.darknessScene.add(source.mesh);
        }
      }

      if (this.lights.has(targetDoc.id)) {
        const source = this.lights.get(targetDoc.id);
        if (source?.mesh) {
          this.lightScene?.remove(source.mesh);
          this.sunLightScene?.remove(source.mesh);
        }
        source?.dispose();
        this.lights.delete(targetDoc.id);
      }
      return;
    }

    // Ensure any prior darkness source is disposed when switching to a normal light.
    if (this.darknessSources.has(targetDoc.id)) {
      const ds = this.darknessSources.get(targetDoc.id);
      if (ds?.mesh) this.darknessScene?.remove(ds.mesh);
      ds?.dispose();
      this.darknessSources.delete(targetDoc.id);
    }

    if (this.lights.has(targetDoc.id)) {
      const src = this.lights.get(targetDoc.id);
      src.updateData(targetDoc);
      if (src?.mesh) {
        const isActive = this._isLightActiveForDarkness(targetDoc, sceneDarkness);
        src.mesh.visible = isActive && !isSuppressed;
        try {
          if (isSunLight) {
            this.lightScene?.remove(src.mesh);
            if (this.sunLightScene && src.mesh?.parent !== this.sunLightScene) this.sunLightScene.add(src.mesh);
          } else {
            this.sunLightScene?.remove(src.mesh);
            if (this.lightScene && src.mesh?.parent !== this.lightScene) this.lightScene.add(src.mesh);
          }
        } catch (_) {
        }
        this._applyLayerTargeting(src.mesh, targetLayers, GROUND_LIGHT_LAYER, OVERHEAD_LIGHT_LAYER);
      }
    } else {
      const source = new ThreeLightSource(targetDoc);
      source.init();
      this.lights.set(targetDoc.id, source);
      if (source.mesh && (this.lightScene || this.sunLightScene)) {
        const isActive = this._isLightActiveForDarkness(targetDoc, sceneDarkness);
        source.mesh.visible = isActive && !isSuppressed;
        this._applyLayerTargeting(source.mesh, targetLayers, GROUND_LIGHT_LAYER, OVERHEAD_LIGHT_LAYER);
        if (isSunLight) this.sunLightScene?.add(source.mesh);
        else this.lightScene?.add(source.mesh);
      }
    }
  }

  onLightDelete(doc) {
    try {
      this.lightRegistry.removeFoundryEntity(doc.id);
    } catch (_) {
    }

    if (this.darknessSources.has(doc.id)) {
      const source = this.darknessSources.get(doc.id);
      if (source.mesh && this.darknessScene) this.darknessScene.remove(source.mesh);
      source.dispose();
      this.darknessSources.delete(doc.id);
    }

    if (this.lights.has(doc.id)) {
      const source = this.lights.get(doc.id);
      if (source.mesh) this.lightScene.remove(source.mesh);
      source.dispose();
      this.lights.delete(doc.id);
    }
  }

  /**
   * Handle lightingRefresh hook - rebuilds lights that were created before
   * Foundry computed their LOS polygons (fixes lights extending through walls)
   * 
   * CRITICAL: We must re-apply enhancements before calling updateData() because
   * source.document may be stale (missing cookie config). If we call updateData()
   * with a doc that has no cookieTexture, _updateCookieFromConfig() will CLEAR
   * the cookie. See docs/LIGHT-COOKIE-RESET-ISSUE.md for full analysis.
   */
  onLightingRefresh() {
    try {
      const sceneDarkness = this._getSceneDarknessLevel();

      // Rebuild all Foundry lights to pick up updated LOS polygons
      // Re-apply enhancements to ensure cookies aren't cleared by stale documents
      for (const [id, source] of this.lights) {
        if (source && source.document) {
          const enhancedDoc = this._applyFoundryEnhancements(source.document);
          source.updateData(enhancedDoc, true);
          const isSuppressed = this._overriddenFoundryLightIds.has(source.id);
          const isActive = this._isLightActiveForDarkness(enhancedDoc, sceneDarkness);
          if (source.mesh) source.mesh.visible = isActive && !isSuppressed;
        }
      }
      
      // Also rebuild MapShine-native lights (these store enhancements directly)
      for (const [id, source] of this.mapshineLights) {
        if (source && source.document) {
          source.updateData(source.document, true);
          const isActive = this._isLightActiveForDarkness(source.document, sceneDarkness);
          if (source.mesh) source.mesh.visible = isActive;
        }
      }
    } catch (e) {
      log.error('Failed to handle lightingRefresh:', e);
    }
  }

  getEffectiveDarkness() {
    let d = this.params?.darknessLevel;
    try {
      const env = canvas?.environment;
      if (env && typeof env.darknessLevel === 'number') {
        d = env.darknessLevel;
      }
    } catch (_) {
    }

    d = (typeof d === 'number' && isFinite(d)) ? d : 0.0;
    const scale = (typeof this.params?.darknessEffect === 'number' && isFinite(this.params.darknessEffect))
      ? this.params.darknessEffect
      : 1.0;

    const eff = Math.max(0.0, Math.min(1.0, d * scale));
    this._effectiveDarkness = eff;
    return eff;
  }

  _getSceneDarknessLevel() {
    let d = this.params?.darknessLevel;
    try {
      const env = canvas?.environment;
      if (env && typeof env.darknessLevel === 'number') {
        d = env.darknessLevel;
      }
    } catch (_) {
    }

    return (typeof d === 'number' && isFinite(d)) ? Math.max(0.0, Math.min(1.0, d)) : 0.0;
  }

  _isLightActiveForDarkness(doc, darknessLevel) {
    if (!doc) return false;

    if (doc.hidden === true) return false;

    const config = doc.config ?? {};
    const angle = Number(config.angle ?? 360);
    const dim = Number(config.dim ?? 0);
    const bright = Number(config.bright ?? 0);
    const radius = Math.max(dim, bright);

    if (!(radius > 0) || !(angle > 0)) return false;

    const range = (config.darkness && typeof config.darkness === 'object') ? config.darkness : {};
    const min0 = Number.isFinite(range.min) ? range.min : 0.0;
    const max0 = Number.isFinite(range.max) ? range.max : 1.0;
    const min = Math.max(0.0, Math.min(1.0, Math.min(min0, max0)));
    const max = Math.max(0.0, Math.min(1.0, Math.max(min0, max0)));

    const d = (typeof darknessLevel === 'number' && Number.isFinite(darknessLevel))
      ? Math.max(0.0, Math.min(1.0, darknessLevel))
      : 0.0;

    return d >= min && d <= max;
  }

  _getEffectiveZoom() {
    // Prefer sceneComposer.currentZoom (FOV-based zoom system)
    try {
      const sceneComposer = window.MapShine?.sceneComposer;
      const z0 = sceneComposer?.currentZoom;
      if (typeof z0 === 'number' && isFinite(z0) && z0 > 0) return z0;
    } catch (_) {
    }

    const cam = this.mainCamera;
    if (!cam) return 1.0;

    // OrthographicCamera: zoom is a direct property
    if (cam.isOrthographicCamera) {
      const z = cam.zoom;
      if (typeof z === 'number' && isFinite(z) && z > 0) return z;
      return 1.0;
    }

    // PerspectiveCamera fallback: derive zoom from FOV + camera distance.
    // This matches the FOV-based zoom system used elsewhere.
    try {
      const THREE = window.THREE;
      const renderer = this.renderer;
      const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
      const camZ = cam.position?.z;
      const fovDeg = cam.fov;

      if (THREE && renderer && typeof camZ === 'number' && isFinite(camZ) && typeof fovDeg === 'number' && isFinite(fovDeg)) {
        const dist = Math.abs(camZ - groundZ);
        if (dist > 0.0001) {
          // PERF: reuse temp vector if available
          if (!this._tempSize) this._tempSize = new THREE.Vector2();
          const size = this._tempSize;
          renderer.getDrawingBufferSize(size);
          const hPx = size.y;

          const fovRad = fovDeg * (Math.PI / 180);
          const worldH = 2.0 * dist * Math.tan(fovRad * 0.5);
          const z = hPx / Math.max(1e-6, worldH);
          if (typeof z === 'number' && isFinite(z) && z > 0) return z;
        }
      }
    } catch (_) {
    }

    return 1.0;
  }

  update(timeInfo) {
    if (DISABLE_LIGHTING_EFFECT) return;
    if (!this.enabled) return;

    const THREE = window.THREE;

    // Sync Environment Data
    if (canvas.scene && canvas.environment) {
      this.params.darknessLevel = canvas.environment.darknessLevel;
      // (Ambient colors sync omitted here to keep this patch focused.)
    }

    const sceneDarkness = this._getSceneDarknessLevel();

    // Build sky tint object for Darkness Response lights.
    // SkyColorEffect exposes currentSkyTintColor (RGB multiplier from sky temperature)
    // and params controlling whether to apply it and at what intensity.
    // Reuse cached object to avoid per-frame allocation (GC pressure).
    if (!this._cachedSkyTint) this._cachedSkyTint = { r: 1, g: 1, b: 1, intensity: 0 };
    const skyTint = this._cachedSkyTint;
    skyTint.intensity = 0; // disabled by default
    try {
      const sce = window.MapShine?.skyColorEffect;
      if (sce && sce.params?.skyTintDarknessLightsEnabled && sce.currentSkyTintColor) {
        const tintIntensity = Math.max(0.0, sce.params.skyTintDarknessLightsIntensity ?? 1.0);
        if (tintIntensity > 0) {
          const c = sce.currentSkyTintColor;
          skyTint.r = c.r;
          skyTint.g = c.g;
          skyTint.b = c.b;
          skyTint.intensity = tintIntensity;
        }
      }
    } catch (_) {}

    // Update animations first, THEN apply darkness gating visibility.
    // updateAnimation() can trigger rebuildGeometry() (e.g. zoom-driven wall
    // inset updates), which replaces the mesh. Setting visibility before the
    // animation would target the OLD mesh, leaving the NEW mesh visible=true
    // for one frame — causing the flicker on darkness-gated lights during zoom.
    for (const light of this.lights.values()) {
      light.updateAnimation(timeInfo, sceneDarkness, skyTint);
      const isActive = this._isLightActiveForDarkness(light.document, sceneDarkness);
      const isSuppressed = this._overriddenFoundryLightIds.has(light.id);
      if (light.mesh) light.mesh.visible = isActive && !isSuppressed;
    }

    // Update MapShine-native lights using the same animation system for now.
    for (const light of this.mapshineLights.values()) {
      light.updateAnimation(timeInfo, sceneDarkness, skyTint);
      const isActive = this._isLightActiveForDarkness(light.document, sceneDarkness);
      if (light.mesh) light.mesh.visible = isActive;
    }

    // Update Animations for all darkness sources
    for (const ds of this.darknessSources.values()) {
      ds.updateAnimation(timeInfo);
      const isActive = this._isLightActiveForDarkness(ds.document, sceneDarkness);
      const isSuppressed = this._overriddenFoundryLightIds.has(ds.id);
      if (ds.mesh) ds.mesh.visible = isActive && !isSuppressed;
    }

    for (const ds of this.mapshineDarknessSources.values()) {
      ds.updateAnimation(timeInfo);
      const isActive = this._isLightActiveForDarkness(ds.document, sceneDarkness);
      if (ds.mesh) ds.mesh.visible = isActive;
    }

    // Update Composite Uniforms
    const u = this.compositeMaterial.uniforms;
    if (u.uDarknessLevel) u.uDarknessLevel.value = this.getEffectiveDarkness();
    if (u.uGlobalIllumination) u.uGlobalIllumination.value = this.params.globalIllumination;
    if (u.uLightIntensity) u.uLightIntensity.value = this.params.lightIntensity;
    if (u.uColorationStrength) u.uColorationStrength.value = this.params.colorationStrength;
    if (u.uOutdoorBrightness) u.uOutdoorBrightness.value = this.params.outdoorBrightness;
    if (u.uSunIndoorGain) u.uSunIndoorGain.value = this.params.sunIndoorGain;
    if (u.uSunBlurRadiusPx) u.uSunBlurRadiusPx.value = this.params.sunBlurRadiusPx;
    if (u.uNegativeDarknessStrength) u.uNegativeDarknessStrength.value = this.params.negativeDarknessStrength;

    // Lightning outside flash (published by LightningEffect)
    try {
      const env = window.MapShine?.environment;
      const flash01 = (env && typeof env.lightningFlash01 === 'number' && Number.isFinite(env.lightningFlash01))
        ? Math.max(0.0, Math.min(1.0, env.lightningFlash01))
        : 0.0;

      const strikeUv = (env && env.lightningStrikeUv && typeof env.lightningStrikeUv === 'object')
        ? env.lightningStrikeUv
        : null;
      const strikeDir = (env && env.lightningStrikeDir && typeof env.lightningStrikeDir === 'object')
        ? env.lightningStrikeDir
        : null;

      const enabled = !!this.params.lightningOutsideEnabled;
      const gain = (typeof this.params.lightningOutsideGain === 'number' && Number.isFinite(this.params.lightningOutsideGain))
        ? Math.max(0.0, this.params.lightningOutsideGain)
        : 0.0;

      const shadowEnabled = !!this.params.lightningOutsideShadowEnabled;
      const shadowStrength = (typeof this.params.lightningOutsideShadowStrength === 'number' && Number.isFinite(this.params.lightningOutsideShadowStrength))
        ? Math.max(0.0, Math.min(1.0, this.params.lightningOutsideShadowStrength))
        : 0.0;
      const shadowRadiusPx = (typeof this.params.lightningOutsideShadowRadiusPx === 'number' && Number.isFinite(this.params.lightningOutsideShadowRadiusPx))
        ? Math.max(0.0, this.params.lightningOutsideShadowRadiusPx)
        : 0.0;
      const shadowEdgeGain = (typeof this.params.lightningOutsideShadowEdgeGain === 'number' && Number.isFinite(this.params.lightningOutsideShadowEdgeGain))
        ? Math.max(0.0, this.params.lightningOutsideShadowEdgeGain)
        : 0.0;
      const shadowInvert = !!this.params.lightningOutsideShadowInvert;

      if (u.uLightningFlash01) u.uLightningFlash01.value = enabled ? flash01 : 0.0;
      if (u.uLightningOutsideGain) u.uLightningOutsideGain.value = enabled ? gain : 0.0;

      if (u.uLightningStrikeUv?.value && strikeUv && typeof strikeUv.x === 'number' && typeof strikeUv.y === 'number') {
        u.uLightningStrikeUv.value.set(strikeUv.x, strikeUv.y);
      }

      if (u.uLightningStrikeDir?.value && strikeDir && typeof strikeDir.x === 'number' && typeof strikeDir.y === 'number') {
        u.uLightningStrikeDir.value.set(strikeDir.x, strikeDir.y);
      }

      if (u.uLightningShadowEnabled) u.uLightningShadowEnabled.value = (enabled && shadowEnabled) ? 1.0 : 0.0;
      if (u.uLightningShadowStrength) u.uLightningShadowStrength.value = shadowStrength;
      if (u.uLightningShadowRadiusPx) u.uLightningShadowRadiusPx.value = shadowRadiusPx;
      if (u.uLightningShadowEdgeGain) u.uLightningShadowEdgeGain.value = shadowEdgeGain;
      if (u.uLightningShadowInvert) u.uLightningShadowInvert.value = shadowInvert ? 1.0 : 0.0;
    } catch (e) {
      if (u.uLightningFlash01) u.uLightningFlash01.value = 0.0;
      if (u.uLightningOutsideGain) u.uLightningOutsideGain.value = 0.0;

      if (u.uLightningShadowEnabled) u.uLightningShadowEnabled.value = 0.0;
      if (u.uLightningShadowStrength) u.uLightningShadowStrength.value = 0.0;
      if (u.uLightningShadowRadiusPx) u.uLightningShadowRadiusPx.value = 0.0;
      if (u.uLightningShadowEdgeGain) u.uLightningShadowEdgeGain.value = 0.0;
      if (u.uLightningShadowInvert) u.uLightningShadowInvert.value = 0.0;
    }

    if (u.uDarknessPunchGain) {
      u.uDarknessPunchGain.value = this.params.darknessPunchGain;
    }

    if (this.debugDarknessBufferMaterial?.uniforms?.uStrength) {
      this.debugDarknessBufferMaterial.uniforms.uStrength.value = this.params.negativeDarknessStrength;
    }

    if (this.debugDarknessBufferMaterial?.uniforms?.uGain) {
      this.debugDarknessBufferMaterial.uniforms.uGain.value = this.params.darknessPunchGain;
    }

    try {
      const env = canvas?.environment;
      const setThreeColorLoose = (target, input, fallback = 0xffffff) => {
        try {
          if (!target) return;
          if (input && typeof input === 'object' && 'r' in input && 'g' in input && 'b' in input) {
            target.set(input.r, input.g, input.b);
            return;
          }
          if (typeof input === 'string' || typeof input === 'number') {
            target.set(input);
            return;
          }
          target.set(fallback);
        } catch (e) {
          try {
            target.set(fallback);
          } catch (e2) {}
        }
      };

      if (THREE && env?.colors && u.uAmbientBrightest?.value && u.uAmbientDarkness?.value) {
        setThreeColorLoose(u.uAmbientBrightest.value, env.colors.ambientDaylight, 0xffffff);
        setThreeColorLoose(u.uAmbientDarkness.value, env.colors.ambientDarkness, 0x242448);
      }
    } catch (e) {
    }

    // Drive overhead shadow uniforms from OverheadShadowsEffect (if present).
    try {
      const overhead = window.MapShine?.overheadShadowsEffect;
      if (overhead && overhead.params && overhead.enabled && overhead.shadowTarget) {
        u.uOverheadShadowOpacity.value = overhead.params.opacity ?? 0.0;
        u.uOverheadShadowAffectsLights.value = overhead.params.affectsLights ?? 0.75;
      } else {
        // No active overhead shadows; disable effect in shader.
        u.uOverheadShadowOpacity.value = 0.0;
      }
    } catch (e) {
      u.uOverheadShadowOpacity.value = 0.0;
    }

    // Drive building shadow opacity from BuildingShadowsEffect (if present).
    try {
      const building = window.MapShine?.buildingShadowsEffect;
      if (building && building.params && building.enabled && building.shadowTarget) {
        const baseOpacity = building.params.opacity ?? 0.0;
        const ti = (typeof building.timeIntensity === 'number')
          ? THREE.MathUtils.clamp(building.timeIntensity, 0.0, 1.0)
          : 1.0;
        u.uBuildingShadowOpacity.value = baseOpacity * ti;
      } else {
        u.uBuildingShadowOpacity.value = 0.0;
      }
    } catch (e) {
      u.uBuildingShadowOpacity.value = 0.0;
    }

    // Drive bush shadow opacity and length from BushEffect (if present).
    try {
      const bush = window.MapShine?.bushEffect;
      if (bush && bush.params && bush.enabled && bush.shadowTarget) {
        const baseOpacity = bush.params.shadowOpacity ?? 0.0;
        u.uBushShadowOpacity.value = baseOpacity;
        if (typeof bush.params.shadowLength === 'number') {
          u.uBushShadowLength.value = bush.params.shadowLength;
        }
      } else {
        u.uBushShadowOpacity.value = 0.0;
      }
    } catch (e) {
      u.uBushShadowOpacity.value = 0.0;
    }

    // Drive tree shadow opacity, length, and self-shadow behavior from TreeEffect (if present).
    try {
      const tree = window.MapShine?.treeEffect;
      if (tree && tree.params && tree.enabled && tree.shadowTarget) {
        const baseOpacity = tree.params.shadowOpacity ?? 0.0;
        u.uTreeShadowOpacity.value = baseOpacity;
        if (typeof tree.params.shadowLength === 'number') {
          u.uTreeShadowLength.value = tree.params.shadowLength;
        }

        let selfStrength = 1.0;
        if (typeof tree.getHoverFade === 'function') {
          const f = tree.getHoverFade();
          if (typeof f === 'number' && isFinite(f)) {
            selfStrength = Math.max(0.0, Math.min(1.0, f));
          }
        }
        u.uTreeSelfShadowStrength.value = selfStrength;
      } else {
        u.uTreeShadowOpacity.value = 0.0;
        u.uTreeSelfShadowStrength.value = 1.0;
      }
    } catch (e) {
      u.uTreeShadowOpacity.value = 0.0;
      u.uTreeSelfShadowStrength.value = 1.0;
    }

    // --- Shared sun/zoom data for screen-space shadows (overhead, building, bush) ---
    try {
      const overhead = window.MapShine?.overheadShadowsEffect;
      const THREE = window.THREE;

      if (overhead && overhead.sunDir && THREE) {
        u.uShadowSunDir.value.copy(overhead.sunDir);
      } else if (weatherController && THREE) {
        // Fallback: recompute sunDir from WeatherController.timeOfDay and
        // global sunLatitude, mirroring OverheadShadowsEffect logic.
        let hour = 12.0;
        try {
          if (typeof weatherController.timeOfDay === 'number') {
            hour = weatherController.timeOfDay;
          }
        } catch (e) {}

        const t = (hour % 24.0) / 24.0;
        const azimuth = (t - 0.5) * Math.PI;
        // Read sun latitude from the global Environment source of truth
        const globalLat = window.MapShine?.uiManager?.globalParams?.sunLatitude;
        const lat = (typeof globalLat === 'number')
          ? THREE.MathUtils.clamp(globalLat, 0.0, 1.0)
          : (overhead && overhead.params && typeof overhead.params.sunLatitude === 'number')
            ? THREE.MathUtils.clamp(overhead.params.sunLatitude, 0.0, 1.0)
            : 0.5;
        const x = -Math.sin(azimuth);
        const y = Math.cos(azimuth) * lat;
        u.uShadowSunDir.value.set(x, y);
      }

      // Zoom factor - works with both OrthographicCamera and PerspectiveCamera
      if (this.mainCamera) {
        u.uShadowZoom.value = this._getEffectiveZoom();
      }
    } catch (e) {
      // keep previous values
    }
  }

  render(renderer, scene, camera) {
    if (DISABLE_LIGHTING_EFFECT) return;
    if (!this.enabled) return;

    const THREE = window.THREE;

    // Ensure we have a light accumulation target that matches the current
    // drawing buffer size. This avoids a black screen if onResize has not
    // been called yet.
    // PERFORMANCE: Reuse Vector2 instead of allocating every frame
    if (!this._tempSize) this._tempSize = new THREE.Vector2();
    const size = this._tempSize;
    renderer.getDrawingBufferSize(size);

    if (!this.lightTarget) {
      this.lightTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.HalfFloatType // HDR capable
      });
    } else if (this.lightTarget.width !== size.x || this.lightTarget.height !== size.y) {
      this.lightTarget.setSize(size.x, size.y);
    }

    if (!this.sunLightTarget) {
      this.sunLightTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.HalfFloatType // HDR capable
      });
    } else if (this.sunLightTarget.width !== size.x || this.sunLightTarget.height !== size.y) {
      this.sunLightTarget.setSize(size.x, size.y);
    }

    if (!this.darknessTarget) {
      this.darknessTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else if (this.darknessTarget.width !== size.x || this.darknessTarget.height !== size.y) {
      this.darknessTarget.setSize(size.x, size.y);
    }

    if (!this.roofAlphaTarget) {
      this.roofAlphaTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else if (this.roofAlphaTarget.width !== size.x || this.roofAlphaTarget.height !== size.y) {
      this.roofAlphaTarget.setSize(size.x, size.y);
    }

    if (!this.weatherRoofAlphaTarget) {
      this.weatherRoofAlphaTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else if (this.weatherRoofAlphaTarget.width !== size.x || this.weatherRoofAlphaTarget.height !== size.y) {
      this.weatherRoofAlphaTarget.setSize(size.x, size.y);
    }

    if (!this.ropeMaskTarget) {
      this.ropeMaskTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else if (this.ropeMaskTarget.width !== size.x || this.ropeMaskTarget.height !== size.y) {
      this.ropeMaskTarget.setSize(size.x, size.y);
    }

    if (!this.tokenMaskTarget) {
      this.tokenMaskTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else if (this.tokenMaskTarget.width !== size.x || this.tokenMaskTarget.height !== size.y) {
      this.tokenMaskTarget.setSize(size.x, size.y);
    }

    if (!this.masksTarget) {
      this.masksTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else if (this.masksTarget.width !== size.x || this.masksTarget.height !== size.y) {
      this.masksTarget.setSize(size.x, size.y);
    }

    const hasOutdoorsProjection = !!(this.outdoorsScene && this.outdoorsMesh && this.outdoorsMask);
    if (hasOutdoorsProjection) {
      if (!this.outdoorsTarget) {
        this.outdoorsTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          format: THREE.RGBAFormat,
          type: THREE.UnsignedByteType
        });
      } else if (this.outdoorsTarget.width !== size.x || this.outdoorsTarget.height !== size.y) {
        this.outdoorsTarget.setSize(size.x, size.y);
      }
    }

    try {
      const mm = window.MapShine?.maskManager;
      if (mm) {
        const roofTex = this.roofAlphaTarget?.texture;
        if (roofTex && roofTex !== this._publishedRoofAlphaTex) {
          this._publishedRoofAlphaTex = roofTex;
          mm.setTexture('roofAlpha.screen', roofTex, {
            space: 'screenUv',
            source: 'renderTarget',
            channels: 'a',
            uvFlipY: false,
            lifecycle: 'dynamicPerFrame',
            width: this.roofAlphaTarget?.width ?? null,
            height: this.roofAlphaTarget?.height ?? null
          });
        }

        const weatherRoofTex = this.weatherRoofAlphaTarget?.texture;
        if (weatherRoofTex && weatherRoofTex !== this._publishedWeatherRoofAlphaTex) {
          this._publishedWeatherRoofAlphaTex = weatherRoofTex;
          mm.setTexture('weatherRoofAlpha.screen', weatherRoofTex, {
            space: 'screenUv',
            source: 'renderTarget',
            channels: 'a',
            uvFlipY: false,
            lifecycle: 'dynamicPerFrame',
            width: this.weatherRoofAlphaTarget?.width ?? null,
            height: this.weatherRoofAlphaTarget?.height ?? null
          });
        }

        const ropeMaskTex = this.ropeMaskTarget?.texture;
        if (ropeMaskTex && ropeMaskTex !== this._publishedRopeMaskTex) {
          this._publishedRopeMaskTex = ropeMaskTex;
          mm.setTexture('ropeMask.screen', ropeMaskTex, {
            space: 'screenUv',
            source: 'renderTarget',
            channels: 'a',
            uvFlipY: false,
            lifecycle: 'dynamicPerFrame',
            width: this.ropeMaskTarget?.width ?? null,
            height: this.ropeMaskTarget?.height ?? null
          });
        }

        const tokenMaskTex = this.tokenMaskTarget?.texture;
        if (tokenMaskTex && tokenMaskTex !== this._publishedTokenMaskTex) {
          this._publishedTokenMaskTex = tokenMaskTex;
          mm.setTexture('tokenMask.screen', tokenMaskTex, {
            space: 'screenUv',
            source: 'renderTarget',
            channels: 'a',
            uvFlipY: false,
            lifecycle: 'dynamicPerFrame',
            width: this.tokenMaskTarget?.width ?? null,
            height: this.tokenMaskTarget?.height ?? null
          });
        }

        const outdoorsTex = this.outdoorsTarget?.texture;
        if (outdoorsTex && outdoorsTex !== this._publishedOutdoorsTex) {
          this._publishedOutdoorsTex = outdoorsTex;
          mm.setTexture('outdoors.screen', outdoorsTex, {
            space: 'screenUv',
            source: 'renderTarget',
            channels: 'r',
            uvFlipY: false,
            lifecycle: 'dynamicPerFrame',
            width: this.outdoorsTarget?.width ?? null,
            height: this.outdoorsTarget?.height ?? null
          });
        }
      }
    } catch (e) {
    }

    const ROOF_LAYER = 20;
    const WEATHER_ROOF_LAYER = 21;
    const TOKEN_MASK_LAYER = 26;
    const previousLayersMask = this.mainCamera.layers.mask;
    const previousTarget = renderer.getRenderTarget();

    // IMPORTANT: This block mutates camera layers and render targets.
    // If it throws, and we don't restore in a finally, the camera can get
    // stuck on ROOF_LAYER, making it look like "only overhead tiles render".
    const roofOverrides = [];
    let prevAutoClear = renderer.autoClear;
    let prevAutoClear2 = renderer.autoClear;
    const _tmpEnabledTokenMaskLayer = this._tmpEnabledTokenMaskLayer || (this._tmpEnabledTokenMaskLayer = []);

    try {
      // Before rendering roof layers, temporarily hide any hover-hidden tiles
      // so they don't appear in the roofAlphaTarget. This prevents hover-hidden
      // tiles from lingering visually even though their sprite opacity is 0.
      const roofMaskBit = 1 << ROOF_LAYER;
      const weatherRoofMaskBit = 1 << WEATHER_ROOF_LAYER;
      const tileManager = window.MapShine?.tileManager;

      scene.traverse((object) => {
        if (!object.isSprite || !object.layers || !object.material) return;

        const isRoof = (object.layers.mask & roofMaskBit) !== 0;
        const isWeatherRoof = (object.layers.mask & weatherRoofMaskBit) !== 0;
        if (!isRoof && !isWeatherRoof) return;

        let hoverHidden = false;
        try {
          const tileId = object.userData?.foundryTileId;
          const data = tileId ? tileManager?.tileSprites?.get(tileId) : null;
          hoverHidden = !!data?.hoverHidden;
        } catch (_) {
        }

        const mat = object.material;
        if (typeof mat.opacity !== 'number') return;
        roofOverrides.push({ object, opacity: mat.opacity });
        mat.opacity = hoverHidden ? 0.0 : mat.opacity;
      });

      this.mainCamera.layers.set(ROOF_LAYER);
      renderer.setRenderTarget(this.roofAlphaTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(scene, this.mainCamera);

      this.mainCamera.layers.set(WEATHER_ROOF_LAYER);
      renderer.setRenderTarget(this.weatherRoofAlphaTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(scene, this.mainCamera);

      this.mainCamera.layers.set(ROPE_MASK_LAYER);
      renderer.setRenderTarget(this.ropeMaskTarget);
      renderer.setClearColor(0x000000, 0);

      prevAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.clear(true, true, true);
      renderer.render(scene, this.mainCamera);
      renderer.autoClear = prevAutoClear;

      this.mainCamera.layers.set(TOKEN_MASK_LAYER);
      renderer.setRenderTarget(this.tokenMaskTarget);
      renderer.setClearColor(0x000000, 0);

      prevAutoClear2 = renderer.autoClear;
      renderer.autoClear = false;
      renderer.clear(true, true, true);

      _tmpEnabledTokenMaskLayer.length = 0;

      try {
        const tokenManager = window.MapShine?.tokenManager;
        const tokenSprites = tokenManager?.tokenSprites;
        if (tokenSprites && typeof tokenSprites.values === 'function') {
          const tokenLayerMask = (1 << TOKEN_MASK_LAYER);
          for (const data of tokenSprites.values()) {
            const sprite = data?.sprite;
            if (!sprite?.layers) continue;
            const had = (sprite.layers.mask & tokenLayerMask) !== 0;
            if (!had) {
              sprite.layers.enable(TOKEN_MASK_LAYER);
              _tmpEnabledTokenMaskLayer.push(sprite);
            }
          }
        }

        const gl = renderer.getContext();
        // Avoid per-frame allocation from gl.getParameter(gl.COLOR_WRITEMASK)
        // Default WebGL state is [true, true, true, true], restore to that after render
        try {
          gl.colorMask(false, false, false, false);
          renderer.render(scene, this.mainCamera);
        } finally {
          gl.colorMask(true, true, true, true);
        }
      } catch (e) {
      } finally {
        try {
          for (let i = 0; i < _tmpEnabledTokenMaskLayer.length; i++) {
            _tmpEnabledTokenMaskLayer[i].layers.disable(TOKEN_MASK_LAYER);
          }
        } catch (e) {
        }
      }

      renderer.clear(true, false, false);
      renderer.render(scene, this.mainCamera);
      renderer.autoClear = prevAutoClear2;
    } finally {
      // Restore original opacities even if an intermediate render pass threw.
      try {
        for (const { object, opacity } of roofOverrides) {
          if (object?.material) object.material.opacity = opacity;
        }
      } catch (_) {
      }

      // Always restore camera layers and render target.
      try { this.mainCamera.layers.mask = previousLayersMask; } catch (_) {}
      try { renderer.setRenderTarget(previousTarget); } catch (_) {}
      try { renderer.autoClear = prevAutoClear2; } catch (_) {}
    }

    // into outdoorsTarget using the main camera. This produces a
    // screen-aligned outdoors factor we can safely sample with vUv in
    // the composite shader without introducing world-space pinning
    // errors.
    if (hasOutdoorsProjection && this.outdoorsTarget) {
      const prevTarget2 = renderer.getRenderTarget();
      renderer.setRenderTarget(this.outdoorsTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this.outdoorsScene, this.mainCamera);
      renderer.setRenderTarget(prevTarget2);
    }

    // 0.75 Pack single-channel masks into a single RGBA texture to reduce
    // sampler pressure in the composite shader.
    if (this.masksTarget && this._masksPackScene && this._masksPackCamera && this._masksPackMaterial) {
      const prevTargetPack = renderer.getRenderTarget();
      this._masksPackMaterial.uniforms.tRoofAlpha.value = this.roofAlphaTarget?.texture ?? this._transparentTex;
      this._masksPackMaterial.uniforms.tRopeMask.value = this.ropeMaskTarget?.texture ?? this._transparentTex;
      this._masksPackMaterial.uniforms.tTokenMask.value = this.tokenMaskTarget?.texture ?? this._transparentTex;
      this._masksPackMaterial.uniforms.tOutdoorsMask.value = (hasOutdoorsProjection && this.outdoorsTarget?.texture)
        ? this.outdoorsTarget.texture
        : this._transparentTex;

      renderer.setRenderTarget(this.masksTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this._masksPackScene, this._masksPackCamera);
      renderer.setRenderTarget(prevTargetPack);
    }

    // 1. Accumulate Lights into lightTarget
    const oldTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.lightTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();

    if (this.lightScene && this.mainCamera) {
      const prevMask = this.mainCamera.layers.mask;
      try {
        // Render all light meshes regardless of layer configuration.
        this.mainCamera.layers.enableAll();
        renderer.render(this.lightScene, this.mainCamera);
      } finally {
        this.mainCamera.layers.mask = prevMask;
      }
    }

    // 1.25 Accumulate Sun Lights (indoor fill) into sunLightTarget
    renderer.setRenderTarget(this.sunLightTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();

    if (this.sunLightScene && this.mainCamera) {
      const prevMaskSun = this.mainCamera.layers.mask;
      try {
        this.mainCamera.layers.enableAll();
        renderer.render(this.sunLightScene, this.mainCamera);
      } finally {
        this.mainCamera.layers.mask = prevMaskSun;
      }
    }

    // 1.5 Accumulate Darkness into darknessTarget
    renderer.setRenderTarget(this.darknessTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    if (this.darknessScene && this.mainCamera) {
      const prevMask2 = this.mainCamera.layers.mask;
      try {
        this.mainCamera.layers.enableAll();
        renderer.render(this.darknessScene, this.mainCamera);
      } finally {
        this.mainCamera.layers.mask = prevMask2;
      }
    }

    // 2. Composite: use lightTarget as tLight and roofAlphaTarget as tRoofAlpha.
    // Base scene texture comes from EffectComposer via setInputTexture(tDiffuse).
    const cu = this.compositeMaterial.uniforms;
    cu.tLight.value = this.lightTarget.texture;
    cu.tSunLight.value = this.sunLightTarget?.texture ?? this._transparentTex;
    cu.tDarkness.value = this.darknessTarget.texture;
    cu.tMasks.value = this.masksTarget?.texture ?? this._transparentTex;
    cu.uViewportHeight.value = size.y;
    if (cu.uCompositeTexelSize?.value) {
      cu.uCompositeTexelSize.value.set(1 / Math.max(1, size.x), 1 / Math.max(1, size.y));
    }

    try {
      const wle = window.MapShine?.windowLightEffect;
      const tex = (wle && typeof wle.getLightTexture === 'function') ? wle.getLightTexture() : (wle?.lightTarget?.texture ?? null);
      cu.tWindowLight.value = tex || this._transparentTex;
      cu.uHasWindowLight.value = tex ? 1.0 : 0.0;
    } catch (_) {
      cu.tWindowLight.value = this._transparentTex;
      cu.uHasWindowLight.value = 0.0;
    }

    try {
      const ui = window.MapShine?.uiManager;
      const rb = ui?.ropeBehaviorDefaults;
      const ropeBoost = (rb && rb.rope && Number.isFinite(rb.rope.windowLightBoost)) ? rb.rope.windowLightBoost : 0.0;
      const chainBoost = (rb && rb.chain && Number.isFinite(rb.chain.windowLightBoost)) ? rb.chain.windowLightBoost : 0.0;
      cu.uRopeWindowLightBoost.value = Math.max(0.0, Math.max(ropeBoost, chainBoost));
    } catch (_) {
      cu.uRopeWindowLightBoost.value = 0.0;
    }

    // Bind overhead shadow texture if available.
    try {
      const overhead = window.MapShine?.overheadShadowsEffect;
      cu.tOverheadShadow.value = (overhead && overhead.shadowTarget)
        ? overhead.shadowTarget.texture
        : null;
    } catch (e) {
      cu.tOverheadShadow.value = null;
    }

    // Bind building shadow texture if available.
    try {
      const building = window.MapShine?.buildingShadowsEffect;
      cu.tBuildingShadow.value = (building && building.shadowTarget)
        ? building.shadowTarget.texture
        : null;
    } catch (e) {
      cu.tBuildingShadow.value = null;
    }

    // Bind bush shadow texture if available.
    try {
      const bush = window.MapShine?.bushEffect;
      cu.tBushShadow.value = (bush && bush.shadowTarget)
        ? bush.shadowTarget.texture
        : null;
    } catch (e) {
      cu.tBushShadow.value = null;
    }

    // Bind tree shadow texture if available.
    try {
      const tree = window.MapShine?.treeEffect;
      cu.tTreeShadow.value = (tree && tree.shadowTarget)
        ? tree.shadowTarget.texture
        : null;
    } catch (e) {
      cu.tTreeShadow.value = null;
    }

    // Bind cloud shadow and cloud top textures if available.
    try {
      const cloud = window.MapShine?.cloudEffect;
      cu.tCloudShadow.value = (cloud && cloud.cloudShadowTarget)
        ? cloud.cloudShadowTarget.texture
        : null;
      cu.tCloudTop.value = this._transparentTex;
      // Drive cloud shadow opacity from CloudEffect params
      cu.uCloudShadowOpacity.value = (cloud && cloud.enabled && cloud.params)
        ? (cloud.params.shadowOpacity ?? 0.0)
        : 0.0;
    } catch (e) {
      cu.tCloudShadow.value = null;
      cu.tCloudTop.value = this._transparentTex;
      cu.uCloudShadowOpacity.value = 0.0;
    }

    renderer.setRenderTarget(oldTarget);

    // Debug views — materials are lazily created on first use to avoid
    // compiling 3 extra shader programs during loading.
    const wantsDebug = this.params?.debugShowRopeMask || this.params?.debugShowLightBuffer || this.params?.debugShowDarknessBuffer;
    if (wantsDebug) this._ensureDebugMaterials();

    if (this.params?.debugShowRopeMask && this._quadMesh && this.debugRopeMaskMaterial) {
      this.debugRopeMaskMaterial.uniforms.tRopeMask.value = this.ropeMaskTarget?.texture ?? null;
      this._quadMesh.material = this.debugRopeMaskMaterial;
    } else if (this.params?.debugShowLightBuffer && this._quadMesh && this.debugLightBufferMaterial) {
      this.debugLightBufferMaterial.uniforms.tLight.value = this.lightTarget.texture;
      this.debugLightBufferMaterial.uniforms.uExposure.value = this.params.debugLightBufferExposure ?? 1.0;
      this._quadMesh.material = this.debugLightBufferMaterial;
    } else if (this.params?.debugShowDarknessBuffer && this._quadMesh && this.debugDarknessBufferMaterial) {
      this.debugDarknessBufferMaterial.uniforms.tDarkness.value = this.darknessTarget.texture;
      this.debugDarknessBufferMaterial.uniforms.uStrength.value = this.params.negativeDarknessStrength ?? 1.0;
      this.debugDarknessBufferMaterial.uniforms.tLight.value = this.lightTarget.texture;
      this.debugDarknessBufferMaterial.uniforms.uGain.value = this.params.darknessPunchGain ?? 2.0;
      this._quadMesh.material = this.debugDarknessBufferMaterial;
    } else if (this._quadMesh) {
      this._quadMesh.material = this.compositeMaterial;
    }

    renderer.render(this.quadScene, this.quadCamera);
  }

  /**
   * Lazily create the debug visualization materials on first use.
   * Saves ~3 shader programs from compiling during loading.
   * @private
   */
  _ensureDebugMaterials() {
    if (this.debugLightBufferMaterial) return; // already created
    const THREE = window.THREE;
    if (!THREE) return;

    this.debugLightBufferMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tLight: { value: null },
        uExposure: { value: 1.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tLight;
        uniform float uExposure;
        varying vec2 vUv;
        vec3 reinhard(vec3 c) { return c / (c + 1.0); }
        void main() {
          vec3 c = texture2D(tLight, vUv).rgb * max(uExposure, 0.0);
          c = reinhard(max(c, vec3(0.0)));
          gl_FragColor = vec4(c, 1.0);
        }
      `,
      depthWrite: false, depthTest: false, transparent: false,
    });

    this.debugRopeMaskMaterial = new THREE.ShaderMaterial({
      uniforms: { tRopeMask: { value: null } },
      vertexShader: `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
      `,
      fragmentShader: `
        uniform sampler2D tRopeMask;
        varying vec2 vUv;
        void main() {
          float m = texture2D(tRopeMask, vUv).a;
          gl_FragColor = vec4(m, m, m, 1.0);
        }
      `,
      depthWrite: false, depthTest: false, transparent: false,
    });

    this.debugDarknessBufferMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDarkness: { value: null },
        uStrength: { value: 1.0 },
        tLight: { value: null },
        uGain: { value: 2.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
      `,
      fragmentShader: `
        uniform sampler2D tDarkness;
        uniform float uStrength;
        uniform sampler2D tLight;
        uniform float uGain;
        varying vec2 vUv;
        void main() {
          float d = texture2D(tDarkness, vUv).r;
          vec3 lrgb = texture2D(tLight, vUv).rgb;
          float li = max(max(lrgb.r, lrgb.g), lrgb.b);
          float punch = 1.0 - exp(-max(li, 0.0) * max(uGain, 0.0));
          float punched = clamp(d - punch * max(uStrength, 0.0), 0.0, 1.0);
          gl_FragColor = vec4(punched, d, punch, 1.0);
        }
      `,
      depthWrite: false, depthTest: false, transparent: false,
    });
  }

  setInputTexture(texture) {
    if (this.compositeMaterial) {
      this.compositeMaterial.uniforms.tDiffuse.value = texture;
    }
  }

  dispose() {
    if (this._syncRetryTimeoutId !== null) {
      try { clearTimeout(this._syncRetryTimeoutId); } catch (_) {}
      this._syncRetryTimeoutId = null;
    }
    this._syncFailCount = 0;

    for (const { hook, fn } of this._hookRegistrations) {
      try {
        Hooks.off(hook, fn);
      } catch (_) {
      }
    }
    this._hookRegistrations = [];

    try {
      this.sunLightTarget?.dispose?.();
      this.sunLightTarget = null;
    } catch (_) {
    }

    try {
      this.lights.forEach((l) => l?.dispose?.());
      this.lights.clear();
      this.darknessSources.forEach((d) => d?.dispose?.());
      this.darknessSources.clear();

      this.mapshineLights.forEach((l) => l?.dispose?.());
      this.mapshineLights.clear();
      this.mapshineDarknessSources.forEach((d) => d?.dispose?.());
      this.mapshineDarknessSources.clear();
    } catch (_) {
    }

    super.dispose();
  }
}