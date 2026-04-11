/**
 * @fileoverview LightingEffectV2 — V2 lighting post-processing pass.
 *
 * HEALTH-WIRING BADGE (Map Shine Breaker Box):
 * If you change this effect's lifecycle, lightRT/darkness targets, compose shader,
 * or inputs from cloud / overhead / building shadows / window light, you MUST
 * update HealthEvaluator contracts/wiring for `LightingEffectV2` and any related
 * dependency edges to prevent silent failures.
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
 *   - Levels-aware Foundry light/darkness mesh visibility via
 *     `isLightVisibleForPerspective` each frame (matches Levels light masking).
 *   - Multi-floor: by default screen-space roof/ceiling gating and building-shadow
 *     roof suppression apply **only on the top floor** (`restrictRoofScreenLightOcclusionToTopFloor`
 *     = true). Otherwise upper-floor roof alpha in screen UV carves holes in building
 *     shadows and Foundry lights on lower floors. Set the flag false for legacy
 *     “gate on every floor” (can mis-mask downstairs).
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
import { isLightVisibleForPerspective } from '../../foundry/elevation-context.js';
import { createLightingPerspectiveContext } from '../LightingPerspectiveContext.js';
import { getFoundryTimePhaseHours, getFoundrySunlightFactor, getWrappedHourProgress } from '../../core/foundry-time-phases.js';

const log = createLogger('LightingEffectV2');
const MODULE_ID = 'map-shine-advanced';
const LIGHT_ENHANCEMENT_FLAG_KEY = 'lightEnhancements';

/** Dropped from UI/schema (never wired or obsolete) — remove if merged from old saves */
const LEGACY_LIGHTING_PARAM_KEYS = [
  'outdoorBrightness',
  'darknessEffect',
  'upperFloorTransmissionSoftness',
  'sunIndoorGain',
  'sunBlurRadiusPx',
  'lightningOutsideEnabled',
  'lightningOutsideGain',
  'lightningOutsideShadowEnabled',
  'lightningOutsideShadowStrength',
  'lightningOutsideShadowRadiusPx',
  'lightningOutsideShadowEdgeGain',
  'lightningOutsideShadowInvert',
  'debugShowLightBuffer',
  'debugLightBufferExposure',
  'debugShowDarknessBuffer',
  'debugShowRopeMask',
];

const clamp01 = (n) => Math.max(0, Math.min(1, n));

const readFoundryDarkness01 = () => {
  try {
    const sceneLevel = canvas?.scene?.environment?.darknessLevel;
    if (Number.isFinite(sceneLevel)) return clamp01(sceneLevel);
  } catch (_) {}
  try {
    const envLevel = canvas?.environment?.darknessLevel;
    if (Number.isFinite(envLevel)) return clamp01(envLevel);
  } catch (_) {}
  return 0.0;
};

const computeTimeOfDayDarkness01 = (hourRaw) => {
  const h = Number(hourRaw);
  if (!Number.isFinite(h)) return null;

  const safeHour = ((h % 24) + 24) % 24;
  const phases = getFoundryTimePhaseHours();

  // Match StateApplier._updateSceneDarkness() anchors.
  const dawnDuskDarkness = 0.55;
  const noonDarkness = 0.0;
  const midnightDarkness = 0.95;

  const dayProgress = getWrappedHourProgress(safeHour, phases.sunrise, phases.sunset);
  let targetDarkness;

  if (Number.isFinite(dayProgress)) {
    const sunlight = Math.pow(getFoundrySunlightFactor(safeHour, phases), 0.85);
    targetDarkness = dawnDuskDarkness + ((noonDarkness - dawnDuskDarkness) * sunlight);
  } else {
    const nightProgress = getWrappedHourProgress(safeHour, phases.sunset, phases.sunrise);
    if (Number.isFinite(nightProgress)) {
      const moonArc = Math.pow(Math.max(0, Math.sin(Math.PI * nightProgress)), 0.8);
      targetDarkness = dawnDuskDarkness + ((midnightDarkness - dawnDuskDarkness) * moonArc);
    } else {
      targetDarkness = midnightDarkness;
    }
  }

  return clamp01(targetDarkness);
};

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
      /**
       * When true (default), on multi-floor maps screen-space roof gating and
       * roof→building-shadow suppression run only on the top floor — avoids
       * upstairs roof stamps on lower views. When false, legacy full gating on
       * all floors (can imprint upper ceilings on ground).
       */
      restrictRoofScreenLightOcclusionToTopFloor: true,
      /** Extra ambient dim on _Outdoors-masked *interior* pixels (0 = off). Outdoors unchanged. */
      interiorDarkness: 0.0,
      lightAnimWindInfluence: 1.0,
      lightAnimOutdoorPower: 2.0,
      darknessLevel: 0.0,
      negativeDarknessStrength: 1.0,
      darknessPunchGain: 2.0,
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
    /** @type {THREE.WebGLRenderTarget|null} Foundry light mesh accumulation RT */
    this._lightRT = null;
    /** @type {THREE.WebGLRenderTarget|null} Window glow accumulation RT (compose combines with {@link #_lightRT}) */
    this._windowLightRT = null;
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

    /**
     * Per-frame Levels/floor snapshot from `FloorCompositor` (optional).
     * When null, `render()` falls back to {@link createLightingPerspectiveContext}.
     * @type {import('../LightingPerspectiveContext.js').LightingPerspectiveContext|null}
     */
    this._lightingPerspectiveContext = null;
  }

  /**
   * @param {import('../LightingPerspectiveContext.js').LightingPerspectiveContext|null} ctx
   */
  setLightingPerspectiveContext(ctx) {
    this._lightingPerspectiveContext = ctx;
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
        { name: 'occlusion', label: 'Occlusion', type: 'inline', parameters: ['wallInsetPx', 'restrictRoofScreenLightOcclusionToTopFloor', 'upperFloorTransmissionEnabled', 'upperFloorTransmissionStrength'] },
        { name: 'darkness', label: 'Darkness Response', type: 'inline', parameters: ['interiorDarkness', 'negativeDarknessStrength', 'darknessPunchGain'] },
        { name: 'lightAnim', label: 'Light Animation Behaviour', type: 'inline', parameters: ['lightAnimWindInfluence', 'lightAnimOutdoorPower'] },
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        globalIllumination: { type: 'slider', min: 0, max: 2, step: 0.1, default: 1.3, label: 'Illumination scale' },
        lightIntensity: { type: 'slider', min: 0, max: 2, step: 0.05, default: 0.25, label: 'Light Intensity' },
        colorationStrength: { type: 'slider', min: 0, max: 500, step: 0.05, default: 1.0, label: 'Coloration Strength' },
        wallInsetPx: { type: 'slider', min: 0, max: 40, step: 0.5, default: 6.0, label: 'Wall Inset (px)' },
        restrictRoofScreenLightOcclusionToTopFloor: {
          type: 'boolean',
          default: true,
          label: 'Multi-floor: roof gate & building roof-cutout top floor only',
          tooltip: 'When on (recommended for 2+ floors), Foundry lights use screen-space roof alpha only on the top floor so upstairs stamps do not cut lower-floor lights. Building shadows skip roof-cutout on the uppermost band when 2+ floors exist (that band’s map art is often on the roof layer and would otherwise suppress all building shadows). Single-floor maps unchanged. Turn off for legacy “always gate” on lights.',
        },
        upperFloorTransmissionEnabled: { type: 'boolean', default: false, label: 'Upper Floor Through-Gaps' },
        upperFloorTransmissionStrength: { type: 'slider', min: 0, max: 2, step: 0.05, default: 0.6, label: 'Upper Light Strength' },
        interiorDarkness: { type: 'slider', min: 0, max: 1.5, step: 0.05, default: 0.0, label: 'Interior Darkness' },
        lightAnimWindInfluence: { type: 'slider', min: 0, max: 3, step: 0.05, default: 1.0, label: 'Wind Influence' },
        lightAnimOutdoorPower: { type: 'slider', min: 0, max: 6, step: 0.25, default: 2.0, label: 'Outdoor Power' },
        negativeDarknessStrength: { type: 'slider', min: 0, max: 3, step: 0.1, default: 1.0, label: 'Negative Darkness Strength' },
        darknessPunchGain: { type: 'slider', min: 0, max: 10, step: 0.1, default: 2.0, label: 'Darkness Punch Gain' },
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
    this._windowLightRT = new THREE.WebGLRenderTarget(w, h, rtOpts);
    this._windowLightRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
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
        tLightSources: { value: null },
        tLightWindow:  { value: null },
        tDarkness: { value: null },
        // Cloud shadow: factor texture from CloudEffectV2 (1.0=lit, 0.0=shadowed).
        // Multiplies totalIllumination so ambient dims under clouds while dynamic
        // lights (which add on top) still punch through the shadow.
        tCloudShadow:    { value: null },
        uHasCloudShadow: { value: 0 },
        tCloudShadowRaw:    { value: null },
        uHasCloudShadowRaw: { value: 0 },
        tCombinedShadow:    { value: null },
        uHasCombinedShadow: { value: 0 },
        tCombinedShadowRaw:    { value: null },
        uHasCombinedShadowRaw: { value: 0 },
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
        uInteriorDarkness:         { value: 0.0 },
        // Screen-space roof mask: apply to Foundry lights only on ground floor;
        // apply to window-glow channel only on upper floors (window shader disables
        // uAllowRoofGate there — compose must still suppress leaks onto water/lower views).
        uApplyRoofOcclusionToSources: { value: 1.0 },
        uApplyRoofOcclusionToWindow:  { value: 0.0 },
        uApplyRoofOcclusionToBuilding: { value: 1.0 },
        // _Outdoors mask (scene UV): gate roof/tree *light* occlusion so interior
        // pixels under overhead stamps still receive Foundry lights (see fragment).
        tOutdoorsForRoofLight: { value: null },
        uHasOutdoorsForRoofLight: { value: 0 },
        uOutdoorsForRoofLightFlipY: { value: 0 },
        // Half-res T from OverheadShadowsEffectV2: single source for geometric ceiling gate.
        tCeilingLightTransmittance: { value: null },
        uHasCeilingLightTransmittance: { value: 0 },
      },
      // IMPORTANT:
      // These shader sources are embedded in JS template literals (backticks).
      // Never include backticks inside shader comments/strings; it will break JS parsing.
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tScene;
        uniform sampler2D tLightSources;
        uniform sampler2D tLightWindow;
        uniform sampler2D tDarkness;
        uniform sampler2D tCloudShadow;
        uniform float uHasCloudShadow;
        uniform sampler2D tCloudShadowRaw;
        uniform float uHasCloudShadowRaw;
        uniform sampler2D tCombinedShadow;
        uniform float uHasCombinedShadow;
        uniform sampler2D tCombinedShadowRaw;
        uniform float uHasCombinedShadowRaw;
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
        uniform float uInteriorDarkness;
        uniform float uApplyRoofOcclusionToSources;
        uniform float uApplyRoofOcclusionToWindow;
        uniform float uApplyRoofOcclusionToBuilding;
        uniform sampler2D tOutdoorsForRoofLight;
        uniform float uHasOutdoorsForRoofLight;
        uniform float uOutdoorsForRoofLightFlipY;
        uniform sampler2D tCeilingLightTransmittance;
        uniform float uHasCeilingLightTransmittance;
        varying vec2 vUv;

        float perceivedBrightness(vec3 c) {
          return dot(c, vec3(0.2126, 0.7152, 0.0722));
        }

        void main() {
          vec4 baseColor = texture2D(tScene, vUv);
          vec3 srcLights = max(texture2D(tLightSources, vUv).rgb, vec3(0.0));
          vec3 winLights = max(texture2D(tLightWindow, vUv).rgb, vec3(0.0));
          float darknessMask = clamp(texture2D(tDarkness, vUv).r, 0.0, 1.0);

          float master = max(uLightIntensity, 0.0);
          float baseDarknessLevel = clamp(uDarknessLevel, 0.0, 1.0);

          // Ambient: interpolate between day and night based on darkness level.
          vec3 ambientDay   = uAmbientBrightest * max(uGlobalIllumination, 0.0);
          vec3 ambientNight = uAmbientDarkness  * max(uGlobalIllumination, 0.0);
          vec3 ambient = mix(ambientDay, ambientNight, baseDarknessLevel);

          // Scene UV (Foundry space) for masks authored in scene rect — shared by
          // building shadow and _Outdoors–gated roof light occlusion.
          vec2 w0s = mix(uBldViewCorner00, uBldViewCorner10, vUv.x);
          vec2 w1s = mix(uBldViewCorner01, uBldViewCorner11, vUv.x);
          vec2 worldXYs = mix(w0s, w1s, vUv.y);
          float foundryXs = worldXYs.x;
          float foundryYs = uSceneDimensions.y - worldXYs.y;
          vec2 sceneUvRaw = (vec2(foundryXs, foundryYs) - uBldSceneOrigin) / max(uBldSceneSize, vec2(1e-5));
          vec2 sceneUvFoundry = clamp(sceneUvRaw, 0.0, 1.0);
          float inSceneBounds =
            step(0.0, sceneUvRaw.x) *
            step(0.0, sceneUvRaw.y) *
            step(sceneUvRaw.x, 1.0) *
            step(sceneUvRaw.y, 1.0);

          // Interior vs outdoor (_Outdoors mask) — dim ambient on indoor pixels only.
          float isOutdoorForInteriorDim = 1.0;
          if (uHasOutdoorsForRoofLight > 0.5) {
            vec2 ouvId = sceneUvFoundry;
            if (uOutdoorsForRoofLightFlipY > 0.5) ouvId.y = 1.0 - ouvId.y;
            vec4 odId = texture2D(tOutdoorsForRoofLight, ouvId);
            float odAId = clamp(odId.a, 0.0, 1.0);
            isOutdoorForInteriorDim = (odAId > 0.08) ? step(0.45, odId.r) : 1.0;
          }

          // Roof / tree canopy: prefer packed ceiling transmittance T (half-res blit from
          // OverheadShadows) so geometric gating matches one source; else derive from
          // roof alpha + block. _Outdoors still applies bounded indoor relief.
          float stampedVis = 1.0;
          float roofAlphaComposite = 0.0;
          float roofBlockComposite = 0.0;
          float roofAlphaLive = 0.0;
          if (uHasOverheadRoofAlpha > 0.5) {
            vec4 roofSampleLive = texture2D(tOverheadRoofAlpha, vUv);
            roofAlphaLive = clamp(max(roofSampleLive.a, max(roofSampleLive.r, max(roofSampleLive.g, roofSampleLive.b))), 0.0, 1.0);
          }
          if (uHasCeilingLightTransmittance > 0.5) {
            stampedVis = clamp(texture2D(tCeilingLightTransmittance, vUv).r, 0.0, 1.0);
            roofAlphaComposite = 1.0 - stampedVis;
          } else {
            if (uHasOverheadRoofAlpha > 0.5) {
              vec4 roofSample = texture2D(tOverheadRoofAlpha, vUv);
              float roofAlpha = clamp(max(roofSample.a, max(roofSample.r, max(roofSample.g, roofSample.b))), 0.0, 1.0);
              roofAlphaComposite = roofAlpha;
              float roofOcc = smoothstep(0.10, 0.14, roofAlpha);
              stampedVis = 1.0 - roofOcc;
            }
            if (uHasOverheadRoofBlock > 0.5) {
              vec4 roofBlockSample = texture2D(tOverheadRoofBlock, vUv);
              float roofBlock = clamp(max(roofBlockSample.a, max(roofBlockSample.r, max(roofBlockSample.g, roofBlockSample.b))), 0.0, 1.0);
              roofBlockComposite = roofBlock;
              // IMPORTANT INVARIANT:
              // The hard blocker MUST be multiplied by the live roof visibility weight
              // (roofVisWeight). If this multiplication is removed or roofVisWeight
              // comes from non-live alpha, hover-revealed trees/overheads will leave a
              // persistent “stuck mask” that either over-suppresses or leaks lights.
              float roofVisWeight = smoothstep(0.08, 0.14, roofAlphaComposite);
              float roofBlockOcc = smoothstep(0.42, 0.48, roofBlock) * roofVisWeight;
              stampedVis *= (1.0 - roofBlockOcc);
            }
          }
          float roofLightVisibility = stampedVis;
          if (uHasOutdoorsForRoofLight > 0.5 && inSceneBounds > 0.5) {
            // Relief is intended to prevent “stuck dark” indoor pixels under overhead capture
            // while roofs/trees are being hover-revealed. When the occluder is visibly present,
            // lights should remain masked. Gate relief by live roof alpha so it ramps in only
            // as the roof/tree fades out.
            // Outside sceneRect (canvas padding): sceneUvFoundry is clamped — do not sample
            // _Outdoors there or roof relief bleeds from the mask border (see inSceneBounds).
            float revealWeight = 1.0 - smoothstep(0.20, 0.60, roofAlphaLive);
            vec2 ouv = sceneUvFoundry;
            if (uOutdoorsForRoofLightFlipY > 0.5) ouv.y = 1.0 - ouv.y;
            vec4 od = texture2D(tOutdoorsForRoofLight, ouv);
            float odA = clamp(od.a, 0.0, 1.0);
            float indoorReliefRaw = (odA > 0.08) ? (1.0 - step(0.45, od.r)) : 0.0;
            float isOutdoorSample = (odA > 0.08) ? step(0.45, od.r) : 0.0;
            float ceilingPresent = (uHasCeilingLightTransmittance > 0.5)
              ? smoothstep(0.16, 0.20, 1.0 - stampedVis)
              : max(
                smoothstep(0.10, 0.14, roofAlphaComposite),
                smoothstep(0.42, 0.48, roofBlockComposite) * smoothstep(0.08, 0.14, roofAlphaComposite)
              );
            float occ = 1.0 - stampedVis;
            float albedoB = perceivedBrightness(baseColor.rgb);
            // Occluded + typically-dark receiver (roof art) — block mask relief / porch lift.
            // Use smoothstep so mid-gray ground under eaves is not treated like a roof tile.
            float roofLikeDark = 1.0 - smoothstep(0.11, 0.29, albedoB);
            float suppressRoofLeak = smoothstep(0.12, 0.16, occ) * roofLikeDark;
            // Cap relief under ceiling, but brighter receivers (ground under eaves) recover more.
            float reliefAtten = mix(1.0, 0.22, ceilingPresent);
            reliefAtten = mix(reliefAtten, 1.0, smoothstep(0.14, 0.34, albedoB) * ceilingPresent * 0.92);
            float indoorRelief = indoorReliefRaw * reliefAtten;
            indoorRelief *= (1.0 - suppressRoofLeak);
            roofLightVisibility = mix(stampedVis, 1.0, indoorRelief * revealWeight);
            // Outdoor-classified pixels get indoorReliefRaw = 0 but still sit under overhead
            // capture (porch, courtyard under balcony): restore lights unless dark roof art.
            float underOverhead = smoothstep(0.06, 0.10, occ);
            float porchLift = isOutdoorSample * underOverhead * (1.0 - suppressRoofLeak);
            roofLightVisibility = max(roofLightVisibility, porchLift * 0.92 * revealWeight);
            // Indoor mask under overhead (room below ceiling capture) still needs playable light
            // when the receiver is not classified as dark roof art.
            float interiorUnderHang = (1.0 - isOutdoorSample) * underOverhead * (1.0 - suppressRoofLeak);
            roofLightVisibility = max(roofLightVisibility, interiorUnderHang * 0.52 * revealWeight);
          }
          float visS = mix(1.0, roofLightVisibility, clamp(uApplyRoofOcclusionToSources, 0.0, 1.0));
          float visW = mix(1.0, roofLightVisibility, clamp(uApplyRoofOcclusionToWindow, 0.0, 1.0));
          vec3 safeLights = srcLights * visS + winLights * visW;
          float lightI = max(max(safeLights.r, safeLights.g), safeLights.b);
          float lightIVisible = lightI;
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
          // Padding / outside sceneRect: sceneUvFoundry is clamped — _Outdoors would
          // sample the map border and smear interior classification (horizontal bands
          // in the grey margin). Match building-shadow guard.
          float isOutdoorForInteriorDimSafe = mix(1.0, isOutdoorForInteriorDim, inSceneBounds);
          ambientAfterDark *= max(0.0, 1.0 - uInteriorDarkness * (1.0 - isOutdoorForInteriorDimSafe));

          // Total illumination = ambient (after darkness) + dynamic lights.
          vec3 totalIllumination = ambientAfterDark + directLight;

          // Unified shadow path: cloud + overhead composition from ShadowManagerV2.
          // Dynamic lights are NOT gated so torches/lamps still punch through.
          if (uHasCombinedShadow > 0.5) {
            float shadowFactor = clamp(texture2D(tCombinedShadow, vUv).r, 0.0, 1.0);
            if (uHasCombinedShadowRaw > 0.5 && uHasOverheadRoofAlpha > 0.5) {
              float rawShadowFactor = clamp(texture2D(tCombinedShadowRaw, vUv).r, 0.0, 1.0);
              vec4 roofSample = texture2D(tOverheadRoofAlpha, vUv);
              float roofAlpha = clamp(max(roofSample.a, max(roofSample.r, max(roofSample.g, roofSample.b))), 0.0, 1.0);
              // Raw shadow has no outdoors / upper-floor masking. Interior pixels still
              // get overhead roof alpha (ceiling capture); only blend raw on outdoor-classified
              // pixels so multi-floor indoor rooms keep masked cloud shadow.
              float rawMix = roofAlpha * isOutdoorForInteriorDimSafe;
              shadowFactor = mix(shadowFactor, rawShadowFactor, rawMix);
            }
            vec3 ambientPortion = ambientAfterDark;
            totalIllumination = ambientPortion * shadowFactor + directLight;
          }

          // Legacy cloud-only path: dims the ambient component only.
          // Dynamic lights are NOT gated so torches/lamps still punch through clouds.
          if (uHasCombinedShadow < 0.5 && uHasCloudShadow > 0.5) {
            float shadowFactor = clamp(texture2D(tCloudShadow, vUv).r, 0.0, 1.0);
            // On outdoor pixels under overhead capture, prefer raw cloud (moving
            // shadows on rooftops). Indoors, keep masked cloud only — roof alpha
            // still stamps ceilings in screen space on upper floors.
            if (uHasCloudShadowRaw > 0.5 && uHasOverheadRoofAlpha > 0.5) {
              float rawShadowFactor = clamp(texture2D(tCloudShadowRaw, vUv).r, 0.0, 1.0);
              vec4 roofSample = texture2D(tOverheadRoofAlpha, vUv);
              float roofAlpha = clamp(max(roofSample.a, max(roofSample.r, max(roofSample.g, roofSample.b))), 0.0, 1.0);
              float rawMix = roofAlpha * isOutdoorForInteriorDimSafe;
              shadowFactor = mix(shadowFactor, rawShadowFactor, rawMix);
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
            // BuildingShadowsEffectV2 outputs scene-space UV aligned with sceneUvFoundry.
            float bldShadow = clamp(texture2D(tBuildingShadow, sceneUvFoundry).r, 0.0, 1.0);
            // Guard scene padding / outside-scene pixels: do NOT clamp-sample edge texels
            // from tBuildingShadow there, otherwise dark bands appear at map borders.
            bldShadow = mix(1.0, bldShadow, inSceneBounds);

            float shadowMix = mix(1.0, bldShadow, uBuildingShadowOpacity);
            // Suppress building shadow where visible overhead roof pixels exist.
            // Use alpha primarily (with RGB fallback) so live roof fade opacity
            // can smoothly attenuate this suppression.
            if (uHasOverheadRoofAlpha > 0.5) {
              vec4 roofSample = texture2D(tOverheadRoofAlpha, vUv);
              float roofAlpha = clamp(max(roofSample.a, max(roofSample.r, max(roofSample.g, roofSample.b))), 0.0, 1.0);
              float roofSuppress = mix(0.0, roofAlpha, clamp(uApplyRoofOcclusionToBuilding, 0.0, 1.0));
              shadowMix = mix(shadowMix, 1.0, roofSuppress);
            }
            // Apply only to ambient contribution; dynamic lights punch through.
            vec3 ambientComponent = totalIllumination - directLight;
            ambientComponent *= shadowMix;
            totalIllumination = ambientComponent + directLight;
          }

          // Overhead shadow: screen-space shadow from overhead tiles.
          // RGB carries roof/fluid-tinted shadow factor, alpha carries tile-projection factor.
          // Dims ambient only — dynamic lights punch through.
          if (uHasCombinedShadow < 0.5 && uHasOverheadShadow > 0.5) {
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
          vec3 coloration = safeLights * master * reflection * max(uColorationStrength, 0.0);
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
   * Toggle Three.js light/darkness mesh visibility from Levels elevation rules
   * (`isLightVisibleForPerspective`). Uses live `canvas.scene.lights` docs when
   * available so token/level changes apply without a full resync.
   * @private
   */
  _refreshLightsForLevelsPerspective() {
    if (!this._initialized) return;
    const lightsCollection = canvas?.scene?.lights;

    for (const light of this._lights.values()) {
      if (!light?.mesh) continue;
      let doc = light.document;
      try {
        const id = light.id ?? light.document?.id;
        if (lightsCollection && id != null) {
          const live = lightsCollection.get?.(id) ?? lightsCollection.get?.(String(id));
          if (live) doc = live;
        }
      } catch (_) {}
      light.mesh.visible = isLightVisibleForPerspective(doc);
    }

    for (const ds of this._darknessSources.values()) {
      if (!ds?.mesh) continue;
      let doc = ds.document;
      try {
        const id = ds.id ?? ds.document?.id;
        if (lightsCollection && id != null) {
          const live = lightsCollection.get?.(id) ?? lightsCollection.get?.(String(id));
          if (live) doc = live;
        }
      } catch (_) {}
      ds.mesh.visible = isLightVisibleForPerspective(doc);
    }
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
        this.params.darknessLevel = readFoundryDarkness01();

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

    let sceneDarkness = clamp01(this.params.darknessLevel);
    try {
      const wc = window.MapShine?.weatherController;
      const timeDark = computeTimeOfDayDarkness01(wc?.timeOfDay);

      // Prefer the darker of:
      // - Foundry scene darkness (if it is being updated)
      // - Map Shine time-of-day darkness (always available from control state)
      if (Number.isFinite(timeDark)) {
        sceneDarkness = Math.max(sceneDarkness, timeDark);
      }

      // Optional weather responsiveness: allow Map Shine effectiveDarkness to
      // increase darkness further under heavy weather.
      const envState = wc?.getEnvironment?.();
      const eff = Number(envState?.effectiveDarkness);
      if (Number.isFinite(eff)) sceneDarkness = Math.max(sceneDarkness, clamp01(eff));
    } catch (_) {}
    this.params.darknessLevel = sceneDarkness;

    // Update light animations
    for (const light of this._lights.values()) {
      try {
        const visibleForPerspective = isLightVisibleForPerspective(light?.document);
        if (light?.mesh) {
          light.mesh.visible = visibleForPerspective && (light?.document?.hidden !== true);
        }
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
      for (const k of LEGACY_LIGHTING_PARAM_KEYS) {
        if (Object.prototype.hasOwnProperty.call(this.params, k)) delete this.params[k];
      }
      // `uDarknessLevel` drives the ambient day/night blend in the compose shader.
      u.uDarknessLevel.value = clamp01(sceneDarkness);
      u.uGlobalIllumination.value = this.params.globalIllumination;
      u.uLightIntensity.value = this.params.lightIntensity;
      u.uColorationStrength.value = this.params.colorationStrength;
      u.uNegativeDarknessStrength.value = this.params.negativeDarknessStrength;
      u.uDarknessPunchGain.value = this.params.darknessPunchGain;
      u.uInteriorDarkness.value = Math.max(0, Number(this.params.interiorDarkness) || 0);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────

  /**
   * Execute the lighting post-processing pass:
   *   1. Render light meshes → lightRT (Foundry sources only)
   *   1b. Render windowLightScene → windowLightRT
   *   2. Render darkness meshes → darknessRT
   *   3. Compose: sceneRT * (ambient + lights - darkness) → outputRT
   *
   * Compose merges `lightRT` + `windowLightRT` into total illumination so window
   * glow tints by surface albedo. Roof masks gate channels independently (sources
   * vs window) by active floor so upper-floor lights stay visible without window
   * glow washing water and other areas.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera - The main perspective camera
   * @param {THREE.WebGLRenderTarget} sceneRT - Bus scene input
   * @param {THREE.WebGLRenderTarget} outputRT - Where to write the lit result
   * @param {THREE.Scene|null} [windowLightScene=null] - Optional scene rendered
   *   into `windowLightRT` (not combined with Foundry lights until compose).
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
   * @param {THREE.Texture|null} [outdoorsMaskTexture=null] - _Outdoors mask in
   *   scene UV (same as CloudEffectV2). When set, roof/tree light occlusion
   *   applies only on outdoor pixels so interior lights survive under roofs.
   * @param {THREE.Texture|null} [ceilingTransmittanceTexture=null] - Half-res R
   *   packed T from OverheadShadowsEffectV2 (1 = pass light, 0 = ceiling blocks).
   * @param {THREE.Texture|null} [combinedShadowTexture=null] - Unified shadow factor
   *   from ShadowManagerV2 (cloud + overhead composition).
   * @param {THREE.Texture|null} [combinedShadowRawTexture=null] - Optional unified
   *   raw-shadow variant used on roof pixels.
   */
  render(renderer, camera, sceneRT, outputRT, windowLightScene = null, cloudShadowTexture = null, cloudShadowRawTexture = null, buildingShadowTexture = null, overheadShadowTexture = null, buildingShadowOpacity = 0.75, overheadRoofAlphaTexture = null, overheadRoofBlockTexture = null, outdoorsMaskTexture = null, ceilingTransmittanceTexture = null, combinedShadowTexture = null, combinedShadowRawTexture = null) {
    if (!this._initialized || !this._enabled || !sceneRT) return;
    if (!this._lightRT || !this._windowLightRT || !this._darknessRT || !this._composeMaterial) return;

    // Lazy sync lights on first render frame
    if (!this._lightsSynced) {
      this.syncAllLights();
      // One-shot diagnostic: confirm pipeline inputs are valid.
      log.info('LightingEffectV2 first render:',
        'sceneRT', sceneRT?.width, 'x', sceneRT?.height,
        '| lightRT', this._lightRT?.width, 'x', this._lightRT?.height,
        '| windowLightRT', this._windowLightRT?.width, 'x', this._windowLightRT?.height,
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
      this._windowLightRT.setSize(w, h);
      this._darknessRT.setSize(w, h);
    }

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    try {
      const persp = this._lightingPerspectiveContext ?? createLightingPerspectiveContext();
      const cu0 = this._composeMaterial.uniforms;
      const transmissionEnabled = this.params.upperFloorTransmissionEnabled === true;
      const rawTransmission = Number(this.params.upperFloorTransmissionStrength);
      const transmission = transmissionEnabled && Number.isFinite(rawTransmission)
        ? Math.max(0, Math.min(1, rawTransmission))
        : 0;
      const occlusionWeight = 1.0 - transmission;
      const restrictRoofToTop = this.params.restrictRoofScreenLightOcclusionToTopFloor === true;
      // 0f7b217: on lower floors of multi-floor scenes, screen-space roof alpha must not
      // suppress building shadows or gate Foundry lights (upper roof still in tOverheadRoofAlpha).
      const roofScreenOcclusionScale = persp.getRoofScreenOcclusionScale(restrictRoofToTop);
      cu0.uApplyRoofOcclusionToSources.value = occlusionWeight * roofScreenOcclusionScale;
      // Window overlays: floor-isolated elsewhere; compose-level roof gating off (0f7b217).
      cu0.uApplyRoofOcclusionToWindow.value = 0.0;
      // Building shadows are scene-UV; screen-space roof alpha still suppresses them where
      // tOverheadRoofAlpha is high. On the *uppermost* band of a multi-floor map, the main
      // level art often lives on ROOF_LAYER (tile over underground background) so the roof
      // visibility pass covers the whole viewport and wipes building shadows entirely.
      // Foundry light roof gating keeps using roofScreenOcclusionScale; building shadows rely
      // on BuildingShadowsEffectV2's receiver _Outdoors gate instead for that case.
      const onUppermostMultiFloor = persp.isMultiFloor
        && persp.activeFloorIndex === persp.topFloorIndex
        && persp.topFloorIndex > 0;
      const buildingRoofOcclusionScale = onUppermostMultiFloor ? 0.0 : roofScreenOcclusionScale;
      cu0.uApplyRoofOcclusionToBuilding.value = buildingRoofOcclusionScale;
    } catch (_) {
      const cu0 = this._composeMaterial.uniforms;
      cu0.uApplyRoofOcclusionToSources.value = 1.0;
      cu0.uApplyRoofOcclusionToWindow.value = 0.0;
      cu0.uApplyRoofOcclusionToBuilding.value = 1.0;
    }

    this._refreshLightsForLevelsPerspective();

    // ── Pass 1: Accumulate Foundry light mesh contributions ───────────
    // Save camera layer mask — ThreeLightSource meshes live on layer 0.
    const prevLayerMask = camera.layers.mask;
    camera.layers.enableAll();

    renderer.setRenderTarget(this._lightRT);
    renderer.setClearColor(0x000000, 1);
    renderer.autoClear = true;
    if (this._lightScene) {
      renderer.render(this._lightScene, camera);
    }

    // ── Pass 1b: Window glow → separate RT (compose merges with roof gating) ─
    renderer.setRenderTarget(this._windowLightRT);
    renderer.setClearColor(0x000000, 1);
    renderer.autoClear = true;
    if (windowLightScene) {
      try {
        renderer.render(windowLightScene, camera);
      } catch (err) {
        log.error('LightingEffectV2: window light render failed:', err);
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
    cu.tLightSources.value = this._lightRT.texture;
    cu.tLightWindow.value = this._windowLightRT.texture;
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
    if (combinedShadowTexture) {
      cu.tCombinedShadow.value = combinedShadowTexture;
      cu.uHasCombinedShadow.value = 1;
    } else {
      cu.tCombinedShadow.value = null;
      cu.uHasCombinedShadow.value = 0;
    }
    if (combinedShadowRawTexture) {
      cu.tCombinedShadowRaw.value = combinedShadowRawTexture;
      cu.uHasCombinedShadowRaw.value = 1;
    } else {
      cu.tCombinedShadowRaw.value = null;
      cu.uHasCombinedShadowRaw.value = 0;
    }
    // View→scene UV uniforms for compose (building shadow + _Outdoors roof-light gate).
    try {
      const dims = canvas?.dimensions;
      const sc = window.MapShine?.sceneComposer;
      const cam = camera;
      if (cam && dims) {
        let vMinX = 0, vMinY = 0, vMaxX = 1, vMaxY = 1;
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
          const THREE = window.THREE;
          const groundZ = sc?.basePlaneMesh?.position?.z ?? (sc?.groundZ ?? 0);
          if (THREE) {
            const ndc = new THREE.Vector3();
            const world = new THREE.Vector3();
            const dir = new THREE.Vector3();
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

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
    } else {
      cu.tBuildingShadow.value    = null;
      cu.uHasBuildingShadow.value = 0;
    }

    if (outdoorsMaskTexture) {
      cu.tOutdoorsForRoofLight.value = outdoorsMaskTexture;
      cu.uHasOutdoorsForRoofLight.value = 1;
      cu.uOutdoorsForRoofLightFlipY.value = outdoorsMaskTexture.flipY ? 1.0 : 0.0;
    } else {
      cu.tOutdoorsForRoofLight.value = null;
      cu.uHasOutdoorsForRoofLight.value = 0;
      cu.uOutdoorsForRoofLightFlipY.value = 0;
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
    if (ceilingTransmittanceTexture) {
      cu.tCeilingLightTransmittance.value = ceilingTransmittanceTexture;
      cu.uHasCeilingLightTransmittance.value = 1;
    } else {
      cu.tCeilingLightTransmittance.value = null;
      cu.uHasCeilingLightTransmittance.value = 0;
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
    if (this._windowLightRT) this._windowLightRT.setSize(rw, rh);
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
    try { this._windowLightRT?.dispose(); } catch (_) {}
    try { this._darknessRT?.dispose(); } catch (_) {}
    try { this._composeMaterial?.dispose(); } catch (_) {}
    try { this._composeQuad?.geometry?.dispose(); } catch (_) {}

    this._lightScene = null;
    this._darknessScene = null;
    this._lightRT = null;
    this._windowLightRT = null;
    this._darknessRT = null;
    this._composeScene = null;
    this._composeCamera = null;
    this._composeMaterial = null;
    this._composeQuad = null;
    this._lightsSynced = false;
    this._lastEnhancementCount = -1;
    this._initialized = false;
    this._lightingPerspectiveContext = null;

    log.info('LightingEffectV2 disposed');
  }
}
