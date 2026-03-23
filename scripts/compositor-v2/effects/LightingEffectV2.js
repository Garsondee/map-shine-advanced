/**
 * @fileoverview LightingEffectV2 — V2 lighting post-processing pass.
 *
 * Reads the bus scene RT (albedo + overlays) and applies ambient light,
 * dynamic light sources, darkness sources, and coloration to produce the
 * final lit image.
 *
 * Reuses the V1 ThreeLightSource and ThreeDarknessSource classes for
 * individual light mesh rendering — they output additive light contribution
 * to a dedicated light accumulation RT.
 *
 * Simplified compared to V1 LightingEffect:
 *   - No outdoors mask differentiation (Step 7+)
 *   - No overhead/building/bush/tree shadow integration (Step 8+)
 *   - No upper floor transmission (later)
 *   - No roof alpha pass (later)
 *   - No rope/token mask passes (later)
 *
 * Cloud shadow IS integrated: a shadow factor texture (1.0=lit, 0.0=shadowed)
 * is passed in from CloudEffectV2 and multiplies totalIllumination so the scene
 * darkens under cloud cover. Lights still punch through (they add on top of the
 * shadow-dimmed ambient rather than being gated by it).
 *
 * @module compositor-v2/effects/LightingEffectV2
 */

import { createLogger } from '../../core/log.js';
import { ThreeLightSource } from '../../effects/ThreeLightSource.js';
import { ThreeDarknessSource } from '../../effects/ThreeDarknessSource.js';

const log = createLogger('LightingEffectV2');
const MODULE_ID = 'map-shine-advanced';
const LIGHT_ENHANCEMENT_FLAG_KEY = 'lightEnhancements';

export class LightingEffectV2 {
  constructor() {
    /** @type {boolean} */
    this._initialized = false;
    /** @type {boolean} */
    this._enabled = true;
    /** @type {boolean} */
    this._lightsSynced = false;
    /** @type {number} Last seen count of scene light-enhancement entries */
    this._lastEnhancementCount = -1;

    // ── Tuning parameters (match V1 defaults) ──────────────────────────
    this.params = {
      enabled: true,
      globalIllumination: 1.3,
      lightIntensity: 0.25,
      colorationStrength: 1.0,
      wallInsetPx: 6.0,
      upperFloorTransmissionEnabled: false,
      upperFloorTransmissionStrength: 0.6,
      upperFloorTransmissionSoftness: 1.5,
      darknessEffect: 1.0,
      outdoorBrightness: 1.0,
      lightAnimWindInfluence: 1.0,
      lightAnimOutdoorPower: 2.0,
      lightningOutsideEnabled: true,
      lightningOutsideGain: 1.25,
      lightningOutsideShadowEnabled: true,
      lightningOutsideShadowStrength: 0.75,
      lightningOutsideShadowRadiusPx: 520.0,
      lightningOutsideShadowEdgeGain: 6.0,
      lightningOutsideShadowInvert: false,
      darknessLevel: 0.0,
      negativeDarknessStrength: 1.0,
      darknessPunchGain: 2.0,
      sunIndoorGain: 0.0,
      sunBlurRadiusPx: 5.0,
      debugShowLightBuffer: false,
      debugLightBufferExposure: 1.0,
      debugShowDarknessBuffer: false,
      debugShowRopeMask: false,
    };

    // ── Light management ────────────────────────────────────────────────
    /** @type {Map<string, ThreeLightSource>} Foundry positive lights */
    this._lights = new Map();
    /** @type {Map<string, ThreeDarknessSource>} Foundry darkness sources */
    this._darknessSources = new Map();

    // ── GPU resources (created in initialize) ───────────────────────────
    /** @type {THREE.Scene|null} Scene containing ThreeLightSource meshes */
    this._lightScene = null;
    /** @type {THREE.Scene|null} Scene containing ThreeDarknessSource meshes */
    this._darknessScene = null;
    /** @type {THREE.WebGLRenderTarget|null} Light accumulation RT */
    this._lightRT = null;
    /** @type {THREE.WebGLRenderTarget|null} Darkness accumulation RT */
    this._darknessRT = null;

    // ── Compose pass ────────────────────────────────────────────────────
    /** @type {THREE.Scene|null} */
    this._composeScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._composeCamera = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._composeMaterial = null;
    /** @type {THREE.Mesh|null} */
    this._composeQuad = null;

    // ── Foundry hooks ───────────────────────────────────────────────────
    /** @type {Array<{hook: string, id: number}>} */
    this._hookIds = [];

    // One-shot diagnostic to trace why building shadows might be invisible.
    this._dbgLoggedBuildingShadowOnce = false;

    /** @type {THREE.Vector2|null} Reusable size vector */
    this._sizeVec = null;
  }

  /** @private */
  _onSceneUpdate(scene, changes) {
    if (!this._initialized) return;
    if (!scene) return;

    const activeSceneId = canvas?.scene?.id;
    const sceneId = scene?.id ?? scene?._id;
    if (!activeSceneId || !sceneId || String(activeSceneId) !== String(sceneId)) return;

    const moduleFlags = changes?.flags?.[MODULE_ID];
    if (!moduleFlags || !Object.prototype.hasOwnProperty.call(moduleFlags, LIGHT_ENHANCEMENT_FLAG_KEY)) return;

    this.syncAllLights();
  }

  /**
   * Read per-light enhancement config from scene flags.
   * @private
   * @returns {Map<string, object>}
   */
  _getLightEnhancementConfigMap() {
    const map = new Map();
    const scene = canvas?.scene;
    if (!scene) return map;

    let raw;
    try {
      raw = scene.getFlag?.(MODULE_ID, LIGHT_ENHANCEMENT_FLAG_KEY);
    } catch (_) {
      raw = scene?.flags?.[MODULE_ID]?.[LIGHT_ENHANCEMENT_FLAG_KEY];
    }

    const list = Array.isArray(raw)
      ? raw
      : (Array.isArray(raw?.lights) ? raw.lights : (Array.isArray(raw?.items) ? raw.items : []));

    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const id = entry.id != null ? String(entry.id) : '';
      if (!id) continue;
      const config = (entry.config && typeof entry.config === 'object') ? entry.config : entry;
      if (!config || typeof config !== 'object') continue;
      map.set(id, config);
    }

    return map;
  }

  /**
   * Merge scene-flag light enhancements (cookie/output tuning) into an ambient
   * light doc-shaped object before handing it to ThreeLightSource.
   * @private
   * @param {object} doc
   * @param {Map<string, object>|null} [enhancementMap]
   * @returns {object}
   */
  _mergeLightEnhancementsIntoDoc(doc, enhancementMap = null) {
    if (!doc) return doc;

    const id = doc?.id ?? doc?._id;
    if (!id) return doc;

    const map = enhancementMap ?? this._getLightEnhancementConfigMap();
    const enhancement = map.get(String(id));
    if (!enhancement || typeof enhancement !== 'object') return doc;

    const baseConfig = (doc.config && typeof doc.config === 'object') ? doc.config : {};
    const nextConfig = { ...baseConfig, ...enhancement };
    if (baseConfig.darknessResponse && enhancement.darknessResponse && typeof enhancement.darknessResponse === 'object') {
      nextConfig.darknessResponse = { ...baseConfig.darknessResponse, ...enhancement.darknessResponse };
    }

    // Preserve the live runtime document when possible, but provide a plain
    // doc-shaped object with guaranteed id/config fields for ThreeLightSource.
    return {
      ...doc,
      id,
      _id: id,
      x: doc?.x,
      y: doc?.y,
      hidden: doc?.hidden,
      negative: doc?.negative,
      config: nextConfig,
    };
  }

  /**
   * Compatibility accessor used by effects that inject additive light meshes
   * directly into the lighting accumulation scene (e.g. candle glow buckets).
   * @returns {THREE.Scene|null}
   */
  get lightScene() {
    return this._lightScene;
  }

  // ── UI schema (moved from V1 LightingEffect) ─────────────────────────────

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        { name: 'illumination', label: 'Global Illumination', type: 'inline', parameters: ['globalIllumination', 'lightIntensity', 'colorationStrength'] },
        { name: 'occlusion', label: 'Occlusion', type: 'inline', parameters: ['wallInsetPx', 'upperFloorTransmissionEnabled', 'upperFloorTransmissionStrength', 'upperFloorTransmissionSoftness'] },
        { name: 'darkness', label: 'Darkness Response', type: 'inline', parameters: ['darknessEffect', 'outdoorBrightness', 'negativeDarknessStrength', 'darknessPunchGain'] },
        { name: 'sun', label: 'Sun Lights (Indoor Fill)', type: 'inline', parameters: ['sunIndoorGain', 'sunBlurRadiusPx'] },
        { name: 'lightAnim', label: 'Light Animation Behaviour', type: 'inline', parameters: ['lightAnimWindInfluence', 'lightAnimOutdoorPower'] },
        {
          name: 'lightning', label: 'Lightning (Outside)', type: 'inline',
          parameters: ['lightningOutsideEnabled', 'lightningOutsideGain', 'lightningOutsideShadowEnabled', 'lightningOutsideShadowStrength', 'lightningOutsideShadowRadiusPx', 'lightningOutsideShadowEdgeGain', 'lightningOutsideShadowInvert']
        },
        { name: 'debug', label: 'Debug', type: 'folder', expanded: false, parameters: ['debugShowLightBuffer', 'debugLightBufferExposure', 'debugShowDarknessBuffer', 'debugShowRopeMask'] }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        globalIllumination: { type: 'slider', min: 0, max: 2, step: 0.1, default: 1.3 },
        lightIntensity: { type: 'slider', min: 0, max: 2, step: 0.05, default: 0.25, label: 'Light Intensity' },
        colorationStrength: { type: 'slider', min: 0, max: 500, step: 0.05, default: 1.0, label: 'Coloration Strength' },
        wallInsetPx: { type: 'slider', min: 0, max: 40, step: 0.5, default: 6.0, label: 'Wall Inset (px)' },
        upperFloorTransmissionEnabled: { type: 'boolean', default: false, label: 'Upper Floor Through-Gaps' },
        upperFloorTransmissionStrength: { type: 'slider', min: 0, max: 2, step: 0.05, default: 0.6, label: 'Upper Light Strength' },
        upperFloorTransmissionSoftness: { type: 'slider', min: 0.25, max: 4, step: 0.05, default: 1.5, label: 'Upper Light Softness' },
        darknessEffect: { type: 'slider', min: 0, max: 2, step: 0.05, default: 1.0, label: 'Darkness Effect' },
        outdoorBrightness: { type: 'slider', min: 0.5, max: 2.5, step: 0.05, default: 1.0, label: 'Outdoor Brightness' },
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
        sunIndoorGain: { type: 'slider', min: 0, max: 20, step: 0.25, default: 0.0, label: 'Indoor Gain' },
        sunBlurRadiusPx: { type: 'slider', min: 0, max: 40, step: 1, default: 5.0, label: 'Blur Radius (px)' },
        debugShowLightBuffer: { type: 'boolean', default: false },
        debugLightBufferExposure: { type: 'number', default: 1.0 },
        debugShowDarknessBuffer: { type: 'boolean', default: false },
        debugShowRopeMask: { type: 'boolean', default: false }
      }
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Create GPU resources. Call once after FloorCompositor is ready.
   * @param {number} w - Drawing buffer width
   * @param {number} h - Drawing buffer height
   */
  initialize(w, h) {
    const THREE = window.THREE;
    if (!THREE) return;

    this._sizeVec = new THREE.Vector2();

    // ── Light accumulation RT (HDR, additive blending) ────────────────
    const rtOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this._lightRT = new THREE.WebGLRenderTarget(w, h, rtOpts);
    // Linear storage: light accumulation is additive in linear space.
    this._lightRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this._darknessRT = new THREE.WebGLRenderTarget(w, h, {
      ...rtOpts,
      type: THREE.UnsignedByteType,
    });
    // Linear storage: darkness mask is a scalar, not a colour.
    this._darknessRT.texture.colorSpace = THREE.LinearSRGBColorSpace;

    // ── Scenes for light/darkness meshes ──────────────────────────────
    this._lightScene = new THREE.Scene();
    this._darknessScene = new THREE.Scene();

    // ── Compose pass ──────────────────────────────────────────────────
    this._composeScene = new THREE.Scene();
    this._composeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._composeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tScene:   { value: null },
        tLight:   { value: null },
        tDarkness: { value: null },
        // Cloud shadow: factor texture from CloudEffectV2 (1.0=lit, 0.0=shadowed).
        // Multiplies totalIllumination so ambient dims under clouds while dynamic
        // lights (which add on top) still punch through the shadow.
        tCloudShadow:    { value: null },
        uHasCloudShadow: { value: 0 },
        tCloudShadowRaw:    { value: null },
        uHasCloudShadowRaw: { value: 0 },
        // Building shadow: greyscale factor from BuildingShadowsEffectV2.
        // Applied after cloud shadow — dims only the ambient component.
        tBuildingShadow:     { value: null },
        uHasBuildingShadow:  { value: 0 },
        uBuildingShadowOpacity: { value: 0.75 },
        tOverheadRoofAlpha: { value: null },
        uHasOverheadRoofAlpha: { value: 0 },
        tOverheadRoofBlock: { value: null },
        uHasOverheadRoofBlock: { value: 0 },
        // Foundry canvas dimensions (includes padding). Matches CloudEffectV2.
        // Used to convert Three world Y-up into Foundry world Y-down.
        uSceneDimensions: { value: new THREE.Vector2(1, 1) },
        // Overhead shadow: per-frame screen-space shadow from OverheadShadowsEffectV2.
        // Sampled directly at vUv (screen-space RT). Dims ambient only.
        tOverheadShadow:     { value: null },
        uHasOverheadShadow:  { value: 0 },
        uOverheadShadowOpacity: { value: 1.0 },
        // World-space UV reconstruction for building shadow sampling.
        // The bake RT is in scene UV space (0..1 = scene rect in Foundry world coords).
        // To sample it correctly, reconstruct world XY per fragment from the
        // camera frustum corners (same approach as CloudEffectV2).
        // uViewBoundsMin/Max: world-space XY of the viewport corners at ground plane.
        // uSceneOrigin/Size: scene rect origin + size in Foundry world coords (pixels).
        uBldViewBoundsMin: { value: new THREE.Vector2(0, 0) },
        uBldViewBoundsMax: { value: new THREE.Vector2(1, 1) },
        // Four world-space corners (XY) of the camera frustum at the ground plane.
        // Needed because the ground-plane footprint may not be axis-aligned.
        // Corner mapping follows vUv: (0,0)=bottom-left, (1,0)=bottom-right,
        // (0,1)=top-left, (1,1)=top-right.
        uBldViewCorner00: { value: new THREE.Vector2(0, 0) },
        uBldViewCorner10: { value: new THREE.Vector2(1, 0) },
        uBldViewCorner01: { value: new THREE.Vector2(0, 1) },
        uBldViewCorner11: { value: new THREE.Vector2(1, 1) },
        uBldSceneOrigin:   { value: new THREE.Vector2(0, 0) },
        uBldSceneSize:     { value: new THREE.Vector2(1, 1) },
        uDarknessLevel:      { value: 0.0 },
        uAmbientBrightest:   { value: new THREE.Color(1, 1, 1) },
        uAmbientDarkness:    { value: new THREE.Color(0.141, 0.141, 0.282) },
        uGlobalIllumination: { value: 1.3 },
        uLightIntensity:     { value: 0.25 },
        uColorationStrength: { value: 1.0 },
        uNegativeDarknessStrength: { value: 1.0 },
        uDarknessPunchGain:        { value: 2.0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tScene;
        uniform sampler2D tLight;
        uniform sampler2D tDarkness;
        uniform sampler2D tCloudShadow;
        uniform float uHasCloudShadow;
        uniform sampler2D tCloudShadowRaw;
        uniform float uHasCloudShadowRaw;
        uniform sampler2D tBuildingShadow;
        uniform float uHasBuildingShadow;
        uniform float uBuildingShadowOpacity;
        uniform sampler2D tOverheadRoofAlpha;
        uniform float uHasOverheadRoofAlpha;
        uniform sampler2D tOverheadRoofBlock;
        uniform float uHasOverheadRoofBlock;
        uniform vec2  uSceneDimensions;
        uniform vec2 uBldViewBoundsMin;
        uniform vec2 uBldViewBoundsMax;
        uniform vec2 uBldViewCorner00;
        uniform vec2 uBldViewCorner10;
        uniform vec2 uBldViewCorner01;
        uniform vec2 uBldViewCorner11;
        uniform vec2 uBldSceneOrigin;
        uniform vec2 uBldSceneSize;
        uniform sampler2D tOverheadShadow;
        uniform float uHasOverheadShadow;
        uniform float uOverheadShadowOpacity;
        uniform float uDarknessLevel;
        uniform vec3 uAmbientBrightest;
        uniform vec3 uAmbientDarkness;
        uniform float uGlobalIllumination;
        uniform float uLightIntensity;
        uniform float uColorationStrength;
        uniform float uNegativeDarknessStrength;
        uniform float uDarknessPunchGain;
        varying vec2 vUv;

        float perceivedBrightness(vec3 c) {
          return dot(c, vec3(0.2126, 0.7152, 0.0722));
        }

        void main() {
          vec4 baseColor = texture2D(tScene, vUv);
          vec4 lightSample = texture2D(tLight, vUv);
          float darknessMask = clamp(texture2D(tDarkness, vUv).r, 0.0, 1.0);

          float master = max(uLightIntensity, 0.0);
          float baseDarknessLevel = clamp(uDarknessLevel, 0.0, 1.0);

          // Ambient: interpolate between day and night based on darkness level.
          vec3 ambientDay   = uAmbientBrightest * max(uGlobalIllumination, 0.0);
          vec3 ambientNight = uAmbientDarkness  * max(uGlobalIllumination, 0.0);
          vec3 ambient = mix(ambientDay, ambientNight, baseDarknessLevel);

          // Light contribution (additive accumulation from ThreeLightSources).
          vec3 safeLights = max(lightSample.rgb, vec3(0.0));
          float lightI = max(max(safeLights.r, safeLights.g), safeLights.b);
          // Dynamic light should be masked by currently visible overhead/tree
          // coverage, not by the hard blocker map used for precipitation.
          float roofLightVisibility = 1.0;
          if (uHasOverheadRoofAlpha > 0.5) {
            vec4 roofSample = texture2D(tOverheadRoofAlpha, vUv);
            float roofAlpha = clamp(max(roofSample.a, max(roofSample.r, max(roofSample.g, roofSample.b))), 0.0, 1.0);
            // Use hard blocker silhouette for strict light occlusion, but gate it
            // by runtime visibility so hover-faded reveal still works.
            float roofBlockAlpha = roofAlpha;
            if (uHasOverheadRoofBlock > 0.5) {
              vec4 roofBlockSample = texture2D(tOverheadRoofBlock, vUv);
              roofBlockAlpha = clamp(max(roofBlockSample.a, max(roofBlockSample.r, max(roofBlockSample.g, roofBlockSample.b))), 0.0, 1.0);
            }
            float visibleGate = step(0.03, roofAlpha);
            float visibleOcclusion = clamp(roofBlockAlpha * visibleGate, 0.0, 1.0);
            roofLightVisibility = 1.0 - visibleOcclusion;
          }
          float lightIVisible = lightI * roofLightVisibility;
          vec3 directLight = vec3(lightIVisible) * master;

          // Darkness punch: strong nearby lights reduce the effective darkness
          // level locally, letting the ambient brighten under torches/lamps.
          float lightTermI = max(lightIVisible * master, 0.0);
          float punch = 1.0 - exp(-lightTermI * max(uDarknessPunchGain, 0.0));
          float localDarknessLevel = clamp(
            baseDarknessLevel * (1.0 - punch * max(uNegativeDarknessStrength, 0.0)),
            0.0, 1.0
          );
          vec3 punchedAmbient = mix(ambientDay, ambientNight, localDarknessLevel);

          // Darkness mask from ThreeDarknessSource meshes.
          float punchedMask = clamp(
            darknessMask - punch * max(uNegativeDarknessStrength, 0.0),
            0.0, 1.0
          );
          vec3 ambientAfterDark = punchedAmbient * (1.0 - punchedMask);

          // Total illumination = ambient (after darkness) + dynamic lights.
          vec3 totalIllumination = ambientAfterDark + directLight;

          // Cloud shadow: dims the ambient component only.
          // Dynamic lights are NOT gated so torches/lamps still punch through clouds.
          if (uHasCloudShadow > 0.5) {
            float shadowFactor = clamp(texture2D(tCloudShadow, vUv).r, 0.0, 1.0);
            // Roof tiles can be authored as "indoors" in the outdoors mask. On
            // visible roof pixels, prefer the raw cloud shadow (before outdoors
            // masking) so rooftops still receive moving cloud shadows.
            if (uHasCloudShadowRaw > 0.5 && uHasOverheadRoofAlpha > 0.5) {
              float rawShadowFactor = clamp(texture2D(tCloudShadowRaw, vUv).r, 0.0, 1.0);
              vec4 roofSample = texture2D(tOverheadRoofAlpha, vUv);
              float roofAlpha = clamp(max(roofSample.a, max(roofSample.r, max(roofSample.g, roofSample.b))), 0.0, 1.0);
              shadowFactor = mix(shadowFactor, rawShadowFactor, roofAlpha);
            }
            // Only dim the ambient portion; keep dynamic-light additive intact.
            vec3 ambientPortion = ambientAfterDark;
            totalIllumination = ambientPortion * shadowFactor + directLight;
          }

          // Building shadow: dims only the ambient component.
          // World-stable UV reconstruction: vUv maps 0..1 across the viewport.
          // Reconstruct world XY by lerping the camera frustum corners, then
          // normalise by scene rect to get scene UV (0..1 = scene rect).
          // This matches CloudEffectV2's uViewBoundsMin/Max approach exactly.
          if (uHasBuildingShadow > 0.5) {
            // Reconstruct world XY at this fragment using bilinear interpolation
            // over the four ground-plane frustum corners.
            vec2 w0 = mix(uBldViewCorner00, uBldViewCorner10, vUv.x);
            vec2 w1 = mix(uBldViewCorner01, uBldViewCorner11, vUv.x);
            vec2 worldXY = mix(w0, w1, vUv.y);
            // Convert Three world → Foundry scene UV (verbatim contract used by CloudEffectV2).
            float foundryX = worldXY.x;
            float foundryY = uSceneDimensions.y - worldXY.y;
            vec2 sceneUvFoundry = (vec2(foundryX, foundryY) - uBldSceneOrigin) / max(uBldSceneSize, vec2(1e-5));
            sceneUvFoundry = clamp(sceneUvFoundry, 0.0, 1.0);

            // BuildingShadowsEffectV2 now outputs scene-space UV directly aligned
            // with sceneUvFoundry, so do not apply an additional Y flip here.
            float bldShadow = clamp(texture2D(tBuildingShadow, sceneUvFoundry).r, 0.0, 1.0);

            float shadowMix = mix(1.0, bldShadow, uBuildingShadowOpacity);
            // Suppress building shadow where visible overhead roof pixels exist.
            // Use alpha primarily (with RGB fallback) so live roof fade opacity
            // can smoothly attenuate this suppression.
            if (uHasOverheadRoofAlpha > 0.5) {
              vec4 roofSample = texture2D(tOverheadRoofAlpha, vUv);
              float roofAlpha = clamp(max(roofSample.a, max(roofSample.r, max(roofSample.g, roofSample.b))), 0.0, 1.0);
              shadowMix = mix(shadowMix, 1.0, roofAlpha);
            }
            // Apply only to ambient contribution; dynamic lights punch through.
            vec3 ambientComponent = totalIllumination - directLight;
            ambientComponent *= shadowMix;
            totalIllumination = ambientComponent + directLight;
          }

          // Overhead shadow: screen-space shadow from overhead tiles.
          // RGB carries roof/fluid-tinted shadow factor, alpha carries tile-projection factor.
          // Dims ambient only — dynamic lights punch through.
          if (uHasOverheadShadow > 0.5) {
            vec4 ovSample = texture2D(tOverheadShadow, vUv);
            vec3 ovShadowRgb = clamp(ovSample.rgb, vec3(0.0), vec3(1.0));
            float tileProjectionFactor = clamp(ovSample.a, 0.0, 1.0);
            vec3 combinedShadowFactor = ovShadowRgb * tileProjectionFactor;
            vec3 ovMix = mix(vec3(1.0), combinedShadowFactor, clamp(uOverheadShadowOpacity, 0.0, 1.0));
            vec3 ambientComp = totalIllumination - directLight;
            ambientComp *= ovMix;
            totalIllumination = ambientComp + directLight;
          }

          // Minimum illumination floor to prevent pure black.
          vec3 minIllum = mix(ambientDay, ambientNight, localDarknessLevel) * 0.1;
          totalIllumination = max(totalIllumination, minIllum);

          // Apply illumination to albedo.
          vec3 litColor = baseColor.rgb * totalIllumination;

          // Coloration: lights tint the surface proportional to surface brightness.
          float reflection = perceivedBrightness(baseColor.rgb);
          vec3 coloration = safeLights * master * reflection * max(uColorationStrength, 0.0) * roofLightVisibility;
          litColor += coloration;

          gl_FragColor = vec4(litColor, baseColor.a);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    this._composeMaterial.toneMapped = false;

    this._composeQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this._composeMaterial
    );
    this._composeQuad.frustumCulled = false;
    this._composeScene.add(this._composeQuad);

    // ── Foundry hooks for light CRUD ──────────────────────────────────
    this._registerHook('createAmbientLight', (doc) => this._onLightCreate(doc));
    this._registerHook('updateAmbientLight', (doc, changes) => this._onLightUpdate(doc, changes));
    this._registerHook('deleteAmbientLight', (doc) => this._onLightDelete(doc));
    this._registerHook('updateScene', (scene, changes) => this._onSceneUpdate(scene, changes));

    this._initialized = true;
    log.info(`LightingEffectV2 initialized (${w}x${h})`);
  }

  // ── Light sync ────────────────────────────────────────────────────────

  /**
   * Full sync of all Foundry light sources. Call once after canvas is ready.
   */
  syncAllLights() {
    if (!this._initialized) return;

    // Dispose existing
    for (const light of this._lights.values()) {
      if (light.mesh) this._lightScene.remove(light.mesh);
      light.dispose();
    }
    this._lights.clear();
    for (const ds of this._darknessSources.values()) {
      if (ds.mesh) this._darknessScene.remove(ds.mesh);
      ds.dispose();
    }
    this._darknessSources.clear();

    // Read Foundry placeables
    let docs = [];
    try {
      const placeables = canvas?.lighting?.placeables;
      if (placeables && placeables.length > 0) {
        docs = placeables.map(p => p.document).filter(Boolean);
      }
    } catch (_) {}
    if (docs.length === 0) {
      try {
        const lightDocs = canvas?.scene?.lights;
        if (lightDocs && lightDocs.size > 0) {
          docs = Array.from(lightDocs.values());
        }
      } catch (_) {}
    }

    const enhancementMap = this._getLightEnhancementConfigMap();
    this._lastEnhancementCount = enhancementMap.size;
    for (const doc of docs) {
      this._addLightFromDoc(doc, enhancementMap);
    }

    this._lightsSynced = true;
    log.info(`LightingEffectV2: synced ${this._lights.size} lights, ${this._darknessSources.size} darkness sources`);
  }

  /**
   * Create a ThreeLightSource or ThreeDarknessSource from a Foundry doc
   * and add it to the appropriate scene.
   * @param {object} doc - Foundry AmbientLight document
   * @private
   */
  _addLightFromDoc(doc, enhancementMap = null) {
    if (!doc?.id && !doc?._id) return;
    let plainDoc = doc;
    try {
      plainDoc = (typeof doc?.toObject === 'function') ? doc.toObject() : { ...doc };
      if (plainDoc.id === undefined && plainDoc._id !== undefined) plainDoc.id = plainDoc._id;
    } catch (_) {
      plainDoc = doc;
    }

    const mergedDoc = this._mergeLightEnhancementsIntoDoc(plainDoc, enhancementMap);
    const id = mergedDoc.id ?? mergedDoc._id;
    const isNegative = mergedDoc?.config?.negative === true || mergedDoc?.negative === true;

    if (isNegative) {
      if (this._darknessSources.has(id)) return;
      try {
        const ds = new ThreeDarknessSource(mergedDoc);
        ds.init();
        this._darknessSources.set(id, ds);
        if (ds.mesh && this._darknessScene) {
          this._darknessScene.add(ds.mesh);
        }
      } catch (err) {
        log.warn('Failed to create darkness source:', id, err);
      }
    } else {
      if (this._lights.has(id)) return;
      try {
        const light = new ThreeLightSource(mergedDoc);
        light.init();
        this._lights.set(id, light);
        if (light.mesh && this._lightScene) {
          this._lightScene.add(light.mesh);
        }
      } catch (err) {
        log.warn('Failed to create light source:', id, err);
      }
    }
  }

  // ── Foundry hook handlers ─────────────────────────────────────────────

  /** @private */
  _onLightCreate(doc) {
    if (!this._initialized) return;
    this._addLightFromDoc(doc);
  }

  /** @private */
  _onLightUpdate(doc, changes) {
    if (!this._initialized) return;
    const id = doc?.id ?? doc?._id;
    if (!id) return;

    // Merge changes into a plain object for updateData.
    let merged = doc;
    try {
      merged = (typeof doc.toObject === 'function') ? doc.toObject() : { ...doc };
      if (changes && typeof changes === 'object') {
        let expanded = changes;
        if (Object.keys(changes).some(k => k.includes('.')) && foundry?.utils?.expandObject) {
          expanded = foundry.utils.expandObject(changes);
        }
        if (foundry?.utils?.mergeObject) {
          merged = foundry.utils.mergeObject(merged, expanded, { inplace: false, overwrite: true });
        } else {
          merged = { ...merged, ...expanded };
        }
      }
      if (merged.id === undefined && merged._id !== undefined) merged.id = merged._id;
    } catch (_) {}

    merged = this._mergeLightEnhancementsIntoDoc(merged);

    const isNegative = merged?.config?.negative === true || merged?.negative === true;

    // Handle type flip (positive ↔ negative)
    if (isNegative && this._lights.has(id)) {
      const old = this._lights.get(id);
      if (old.mesh) this._lightScene?.remove(old.mesh);
      old.dispose();
      this._lights.delete(id);
      this._addLightFromDoc(merged);
      return;
    }
    if (!isNegative && this._darknessSources.has(id)) {
      const old = this._darknessSources.get(id);
      if (old.mesh) this._darknessScene?.remove(old.mesh);
      old.dispose();
      this._darknessSources.delete(id);
      this._addLightFromDoc(merged);
      return;
    }

    // Normal update
    if (this._lights.has(id)) {
      this._lights.get(id).updateData(merged);
    } else if (this._darknessSources.has(id)) {
      this._darknessSources.get(id).updateData(merged);
    } else {
      // Light not tracked yet — create it
      this._addLightFromDoc(merged);
    }
  }

  /** @private */
  _onLightDelete(doc) {
    if (!this._initialized) return;
    const id = doc?.id ?? doc?._id;
    if (!id) return;

    if (this._lights.has(id)) {
      const light = this._lights.get(id);
      if (light.mesh) this._lightScene?.remove(light.mesh);
      light.dispose();
      this._lights.delete(id);
    }
    if (this._darknessSources.has(id)) {
      const ds = this._darknessSources.get(id);
      if (ds.mesh) this._darknessScene?.remove(ds.mesh);
      ds.dispose();
      this._darknessSources.delete(id);
    }
  }

  // ── Per-frame update ──────────────────────────────────────────────────

  /**
   * Update light animations and composite uniforms.
   * @param {{ elapsed: number, delta: number }} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized || !this._enabled) return;

    // Sync darkness level and ambient colors from Foundry canvas environment.
    // canvas.environment exposes darknessLevel (0=bright, 1=dark) and the
    // scene's configured ambient colors for brightest/darkest lighting states.
    try {
      const env = canvas?.environment;
      if (env) {
        this.params.darknessLevel = env.darknessLevel ?? 0;

        // Sync ambient colors if Foundry exposes them (v11+).
        // ambientBrightest / ambientDarkness are Color objects or hex strings.
        const u = this._composeMaterial?.uniforms;
        if (u) {
          if (env.ambientBrightest) {
            try {
              const c = env.ambientBrightest;
              if (typeof c === 'object' && 'r' in c) {
                u.uAmbientBrightest.value.setRGB(c.r ?? 1, c.g ?? 1, c.b ?? 1);
              } else if (typeof c === 'number') {
                u.uAmbientBrightest.value.setHex(c);
              }
            } catch (_) {}
          }
          if (env.ambientDarkness) {
            try {
              const c = env.ambientDarkness;
              if (typeof c === 'object' && 'r' in c) {
                u.uAmbientDarkness.value.setRGB(c.r ?? 0.141, c.g ?? 0.141, c.b ?? 0.282);
              } else if (typeof c === 'number') {
                u.uAmbientDarkness.value.setHex(c);
              }
            } catch (_) {}
          }
        }
      }
    } catch (_) {}

    const sceneDarkness = this.params.darknessLevel;

    // Update light animations
    for (const light of this._lights.values()) {
      try {
        light.updateAnimation(timeInfo, sceneDarkness);
      } catch (_) {}
    }
    for (const ds of this._darknessSources.values()) {
      try {
        ds.updateAnimation(timeInfo);
      } catch (_) {}
    }

    // Update compose uniforms
    const u = this._composeMaterial?.uniforms;
    if (u) {
      u.uDarknessLevel.value = this.params.darknessLevel;
      u.uGlobalIllumination.value = this.params.globalIllumination;
      u.uLightIntensity.value = this.params.lightIntensity;
      u.uColorationStrength.value = this.params.colorationStrength;
      u.uNegativeDarknessStrength.value = this.params.negativeDarknessStrength;
      u.uDarknessPunchGain.value = this.params.darknessPunchGain;
    }
  }

  // ── Render ────────────────────────────────────────────────────────────

  /**
   * Execute the lighting post-processing pass:
   *   1. Render light meshes → lightRT (additive accumulation)
   *   1b. Render windowLightScene → lightRT (additive, no clear)
   *   2. Render darkness meshes → darknessRT
   *   3. Compose: sceneRT * (ambient + lights - darkness) → outputRT
   *
   * Window light is fed into the light accumulation buffer so the compose
   * shader applies it as `albedo * totalIllumination` — this tints the glow
   * by the surface colour, preserving hue instead of washing it out.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera - The main perspective camera
   * @param {THREE.WebGLRenderTarget} sceneRT - Bus scene input
   * @param {THREE.WebGLRenderTarget} outputRT - Where to write the lit result
   * @param {THREE.Scene|null} [windowLightScene=null] - Optional extra scene
   *   rendered additively into lightRT after ThreeLightSource meshes.
   * @param {THREE.Texture|null} [cloudShadowTexture=null] - Shadow factor from
   *   CloudEffectV2 (1.0=lit, 0.0=shadowed). Dims ambient illumination under clouds.
   * @param {THREE.Texture|null} [buildingShadowTexture=null] - Shadow factor from
   *   BuildingShadowsEffectV2 (1.0=lit, 0.0=shadowed). Applied in scene UV space;
   *   uSceneBounds + uCanvasSize are updated from canvas.dimensions each frame.
   * @param {THREE.Texture|null} [overheadShadowTexture=null] - Screen-space shadow
   *   factor from OverheadShadowsEffectV2 (1.0=lit, 0.0=shadowed). Sampled at vUv.
   * @param {THREE.Texture|null} [overheadRoofAlphaTexture=null] - Screen-space overhead
   *   roof visibility mask from OverheadShadowsEffectV2. Building shadow is
   *   suppressed where this mask indicates a visible overhead roof.
   * @param {THREE.Texture|null} [overheadRoofBlockTexture=null] - Screen-space
   *   overhead roof blocker mask. Used for hard direct-light blocking so lights
   *   do not leak through overhead tiles that block light.
   */
  render(renderer, camera, sceneRT, outputRT, windowLightScene = null, cloudShadowTexture = null, cloudShadowRawTexture = null, buildingShadowTexture = null, overheadShadowTexture = null, buildingShadowOpacity = 0.75, overheadRoofAlphaTexture = null, overheadRoofBlockTexture = null) {
    if (!this._initialized || !this._enabled || !sceneRT) return;
    if (!this._lightRT || !this._darknessRT || !this._composeMaterial) return;

    // Lazy sync lights on first render frame
    if (!this._lightsSynced) {
      this.syncAllLights();
      // One-shot diagnostic: confirm pipeline inputs are valid.
      log.info('LightingEffectV2 first render:',
        'sceneRT', sceneRT?.width, 'x', sceneRT?.height,
        '| lightRT', this._lightRT?.width, 'x', this._lightRT?.height,
        '| outputRT', outputRT?.width, 'x', outputRT?.height,
        '| windowLightScene children', windowLightScene?.children?.length ?? 'none'
      );
    }

    // Some worlds hydrate scene flag data slightly after initial canvas/light
    // construction. If enhancement entries appear later, force a one-shot resync
    // so initial-load light coloration/intensity matches post-move updates.
    try {
      const enhancementCount = this._getLightEnhancementConfigMap().size;
      if (this._lightsSynced && enhancementCount !== this._lastEnhancementCount) {
        this.syncAllLights();
      }
    } catch (_) {
    }

    // Ensure RTs match drawing buffer size
    renderer.getDrawingBufferSize(this._sizeVec);
    const w = Math.max(1, this._sizeVec.x);
    const h = Math.max(1, this._sizeVec.y);
    if (this._lightRT.width !== w || this._lightRT.height !== h) {
      this._lightRT.setSize(w, h);
      this._darknessRT.setSize(w, h);
    }

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    // ── Pass 1: Accumulate light contributions ────────────────────────
    // Save camera layer mask — ThreeLightSource meshes live on layer 0.
    const prevLayerMask = camera.layers.mask;
    camera.layers.enableAll();

    renderer.setRenderTarget(this._lightRT);
    renderer.setClearColor(0x000000, 1);
    renderer.autoClear = true;
    if (this._lightScene) {
      renderer.render(this._lightScene, camera);
    }

    // ── Pass 1b: Window light → lightRT (additive, no clear) ─────────
    // Window light overlays use AdditiveBlending so they accumulate on top
    // of the ThreeLightSource contributions without clearing the buffer.
    if (windowLightScene) {
      try {
        renderer.autoClear = false;
        renderer.render(windowLightScene, camera);
      } catch (err) {
        log.error('LightingEffectV2: window light render failed:', err);
      } finally {
        renderer.autoClear = true;
      }
    }

    // ── Pass 2: Accumulate darkness contributions ─────────────────────
    renderer.setRenderTarget(this._darknessRT);
    renderer.setClearColor(0x000000, 1);
    renderer.autoClear = true;
    if (this._darknessScene) {
      renderer.render(this._darknessScene, camera);
    }

    // Restore camera layer mask
    camera.layers.mask = prevLayerMask;

    // ── Pass 3: Compose ───────────────────────────────────────────────
    const cu = this._composeMaterial.uniforms;
    cu.tScene.value = sceneRT.texture;
    cu.tLight.value = this._lightRT.texture;
    cu.tDarkness.value = this._darknessRT.texture;
    // Bind cloud shadow factor texture (null-safe: shader gates on uHasCloudShadow).
    if (cloudShadowTexture) {
      cu.tCloudShadow.value    = cloudShadowTexture;
      cu.uHasCloudShadow.value = 1;
    } else {
      cu.tCloudShadow.value    = null;
      cu.uHasCloudShadow.value = 0;
    }
    if (cloudShadowRawTexture) {
      cu.tCloudShadowRaw.value = cloudShadowRawTexture;
      cu.uHasCloudShadowRaw.value = 1;
    } else {
      cu.tCloudShadowRaw.value = null;
      cu.uHasCloudShadowRaw.value = 0;
    }
    // Bind building shadow factor texture (null-safe: shader gates on uHasBuildingShadow).
    if (buildingShadowTexture) {
      cu.tBuildingShadow.value    = buildingShadowTexture;
      cu.uHasBuildingShadow.value = 1;
      const op = Number.isFinite(Number(buildingShadowOpacity))
        ? Math.max(0.0, Math.min(1.0, Number(buildingShadowOpacity)))
        : 0.75;
      cu.uBuildingShadowOpacity.value = op;

      if (!this._dbgLoggedBuildingShadowOnce) {
        this._dbgLoggedBuildingShadowOnce = true;
        try {
          log.info('LightingEffectV2 building shadow bind:',
            'tex', buildingShadowTexture?.uuid || 'ok',
            '| opacity', op,
            '| has', cu.uHasBuildingShadow.value
          );
        } catch (_) {}
      }
      // World-stable UV reconstruction — same approach as CloudEffectV2:
      // Pass camera frustum world-space corners + scene rect so the fragment
      // shader can reconstruct world XY and convert to scene UV per-pixel.
      // This is view-stable at any pan/zoom level.
      try {
        const dims = canvas?.dimensions;
        const sc = window.MapShine?.sceneComposer;
        const cam = camera;
        if (cam && dims) {
          let vMinX = 0, vMinY = 0, vMaxX = 1, vMaxY = 1;
          // Default corners derived from min/max (orthographic / fallback).
          let c00x = 0, c00y = 0, c10x = 1, c10y = 0, c01x = 0, c01y = 1, c11x = 1, c11y = 1;
          if (cam.isOrthographicCamera) {
            vMinX = cam.position.x + cam.left   / cam.zoom;
            vMinY = cam.position.y + cam.bottom / cam.zoom;
            vMaxX = cam.position.x + cam.right  / cam.zoom;
            vMaxY = cam.position.y + cam.top    / cam.zoom;

            c00x = vMinX; c00y = vMinY;
            c10x = vMaxX; c10y = vMinY;
            c01x = vMinX; c01y = vMaxY;
            c11x = vMaxX; c11y = vMaxY;
          } else {
            // Perspective camera: compute stable bounds at the ground plane using
            // NDC unprojection (same approach as WaterEffectV2). This avoids any
            // mismatch between FOV/aspect assumptions and the camera projection.
            const THREE = window.THREE;
            const groundZ = sc?.basePlaneMesh?.position?.z ?? (sc?.groundZ ?? 0);
            if (THREE) {
              const ndc = new THREE.Vector3();
              const world = new THREE.Vector3();
              const dir = new THREE.Vector3();
              let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

              // Map NDC corners to our vUv corner convention:
              // (-1,-1) -> (0,0), (1,-1)->(1,0), (-1,1)->(0,1), (1,1)->(1,1)
              const corners = [
                { ndcX: -1, ndcY: -1, key: '00' },
                { ndcX:  1, ndcY: -1, key: '10' },
                { ndcX: -1, ndcY:  1, key: '01' },
                { ndcX:  1, ndcY:  1, key: '11' },
              ];

              for (const c of corners) {
                ndc.set(c.ndcX, c.ndcY, 0.5);
                world.copy(ndc).unproject(cam);
                dir.copy(world).sub(cam.position);
                const dz = dir.z;
                if (Math.abs(dz) < 1e-6) continue;
                const t = (groundZ - cam.position.z) / dz;
                if (!Number.isFinite(t) || t <= 0) continue;
                const ix = cam.position.x + dir.x * t;
                const iy = cam.position.y + dir.y * t;
                if (ix < minX) minX = ix; if (iy < minY) minY = iy;
                if (ix > maxX) maxX = ix; if (iy > maxY) maxY = iy;

                if (c.key === '00') { c00x = ix; c00y = iy; }
                else if (c.key === '10') { c10x = ix; c10y = iy; }
                else if (c.key === '01') { c01x = ix; c01y = iy; }
                else if (c.key === '11') { c11x = ix; c11y = iy; }
              }

              if (minX !== Infinity) {
                vMinX = minX; vMinY = minY; vMaxX = maxX; vMaxY = maxY;
              }
            }
          }
          cu.uBldViewBoundsMin.value.set(vMinX, vMinY);
          cu.uBldViewBoundsMax.value.set(vMaxX, vMaxY);
          cu.uBldViewCorner00.value.set(c00x, c00y);
          cu.uBldViewCorner10.value.set(c10x, c10y);
          cu.uBldViewCorner01.value.set(c01x, c01y);
          cu.uBldViewCorner11.value.set(c11x, c11y);
          // Scene rect in Foundry world coords (Y-down). The bake canvas is
          // authored in this space (see OutdoorsMaskProviderV2: flipY=false).
          // Three.js camera Y is also world-space Y (matching Foundry scene coords
          // after Coordinates.toWorld conversion), so no extra flip needed here.
          const sr = dims.sceneRect ?? dims;
          cu.uBldSceneOrigin.value.set(sr.x ?? 0, sr.y ?? 0);
          cu.uBldSceneSize.value.set(
            sr.width  ?? dims.sceneWidth  ?? 1,
            sr.height ?? dims.sceneHeight ?? 1
          );
          cu.uSceneDimensions.value.set(
            dims.width  ?? 1,
            dims.height ?? 1
          );
        }
      } catch (_) {}
    } else {
      cu.tBuildingShadow.value    = null;
      cu.uHasBuildingShadow.value = 0;
    }
    if (overheadRoofAlphaTexture) {
      cu.tOverheadRoofAlpha.value = overheadRoofAlphaTexture;
      cu.uHasOverheadRoofAlpha.value = 1;
    } else {
      cu.tOverheadRoofAlpha.value = null;
      cu.uHasOverheadRoofAlpha.value = 0;
    }
    if (overheadRoofBlockTexture) {
      cu.tOverheadRoofBlock.value = overheadRoofBlockTexture;
      cu.uHasOverheadRoofBlock.value = 1;
    } else {
      cu.tOverheadRoofBlock.value = null;
      cu.uHasOverheadRoofBlock.value = 0;
    }
    // Bind overhead shadow texture (screen-space, sampled directly at vUv).
    if (overheadShadowTexture) {
      cu.tOverheadShadow.value       = overheadShadowTexture;
      cu.uHasOverheadShadow.value    = 1;
      cu.uOverheadShadowOpacity.value = 1.0;
    } else {
      cu.tOverheadShadow.value    = null;
      cu.uHasOverheadShadow.value = 0;
    }

    renderer.setRenderTarget(outputRT);
    renderer.setClearColor(0x000000, 1);
    renderer.autoClear = true;
    renderer.render(this._composeScene, this._composeCamera);

    // Restore renderer state
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
  }

  // ── Resize ────────────────────────────────────────────────────────────

  /**
   * Resize internal RTs.
   * @param {number} w
   * @param {number} h
   */
  onResize(w, h) {
    const rw = Math.max(1, w);
    const rh = Math.max(1, h);
    if (this._lightRT) this._lightRT.setSize(rw, rh);
    if (this._darknessRT) this._darknessRT.setSize(rw, rh);
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** @private */
  _registerHook(hookName, fn) {
    const id = Hooks.on(hookName, fn);
    this._hookIds.push({ hook: hookName, id });
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  dispose() {
    // Unhook Foundry events
    for (const { hook, id } of this._hookIds) {
      try { Hooks.off(hook, id); } catch (_) {}
    }
    this._hookIds.length = 0;

    // Dispose light sources
    for (const light of this._lights.values()) {
      try { if (light.mesh) this._lightScene?.remove(light.mesh); } catch (_) {}
      try { light.dispose(); } catch (_) {}
    }
    this._lights.clear();

    for (const ds of this._darknessSources.values()) {
      try { if (ds.mesh) this._darknessScene?.remove(ds.mesh); } catch (_) {}
      try { ds.dispose(); } catch (_) {}
    }
    this._darknessSources.clear();

    // Dispose GPU resources
    try { this._lightRT?.dispose(); } catch (_) {}
    try { this._darknessRT?.dispose(); } catch (_) {}
    try { this._composeMaterial?.dispose(); } catch (_) {}
    try { this._composeQuad?.geometry?.dispose(); } catch (_) {}

    this._lightScene = null;
    this._darknessScene = null;
    this._lightRT = null;
    this._darknessRT = null;
    this._composeScene = null;
    this._composeCamera = null;
    this._composeMaterial = null;
    this._composeQuad = null;
    this._lightsSynced = false;
    this._lastEnhancementCount = -1;
    this._initialized = false;

    log.info('LightingEffectV2 disposed');
  }
}
