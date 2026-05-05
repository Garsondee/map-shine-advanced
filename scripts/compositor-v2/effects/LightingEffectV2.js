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
 * dynamic light sources, darkness sources, and chroma-weighted surface tint
 * (so neutral lamp RGB does not duplicate the luminance channel) to produce the
 * lit image.
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
import { isLightVisibleForPerspective, getPerspectiveForRenderFloorIndex } from '../../foundry/elevation-context.js';
import { createLightingPerspectiveContext } from '../LightingPerspectiveContext.js';
import { computeTimeOfDayDarkness01 } from '../../core/foundry-time-phases.js';
import { getAuthoritativeAmbientLightDocuments } from '../../foundry/ambient-light-documents.js';

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
  const sceneLevel = canvas?.scene?.environment?.darknessLevel;
  if (Number.isFinite(sceneLevel)) return clamp01(sceneLevel);
  const envLevel = canvas?.environment?.darknessLevel;
  if (Number.isFinite(envLevel)) return clamp01(envLevel);
  return 0.0;
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
    /** @type {Map<string, object>|null} Cached per-scene enhancement map */
    this._cachedEnhancementMap = null;
    /** @type {string|null} Cache key for enhancement map */
    this._cachedEnhancementKey = null;
    /** @type {string|number|null} Scene id used by enhancement cache */
    this._cachedEnhancementSceneId = null;
    /** @type {boolean} */
    this._perspectiveRefreshDirty = true;
    /** @type {number} */
    this._lastPerspectiveRefreshAtSec = -Infinity;
    /** @type {Map<string, number>} Per-light next allowed animation update time (seconds) */
    this._nextAnimationUpdateAtSec = new Map();
    /**
     * One-shot: old scenes only stored `globalIllumination`; copy that value into
     * {@link #params.ambientDayScale} and {@link #params.ambientNightScale} when they
     * are still at schema defaults so existing worlds keep their look.
     * @type {boolean}
     */
    this._legacyGlobalIlluminationSeeded = false;

    // ── Tuning parameters (match V1 defaults) ──────────────────────────
    this.params = {
      enabled: true,
      /**
       * Legacy single scale (hidden). Superseded by ambientDayScale / ambientNightScale;
       * still loaded from old saves so {@link #_seedAmbientFromLegacyGlobalIfNeeded} can migrate.
       */
      globalIllumination: 1.3,
      /** Scales Foundry ambient brightest colour at darkness 0 (noon / bright scenes). */
      ambientDayScale: 1.3,
      /** Scales Foundry ambient darkness colour at darkness 1 (night). */
      ambientNightScale: 1.3,
      lightIntensity: 0.25,
      /** Scales the minimum illumination floor under darkness (see compose shader). */
      minIlluminationScale: 1.0,
      colorationStrength: 1.0,
      /** Extra coupling of surface albedo luma into the tint path only. */
      colorationReflectivity: 1.0,
      /**
       * Pre-tint saturation on the RGB light buffer (0 = neutral, >0 richer chroma for tint).
       * Does not re-introduce white boost alone; achromatic lights stay gated by chroma weight.
       */
      colorationSaturation: 0.0,
      /** Curve on chroma detection: >1 requires more saturated lights before full tint. */
      colorationChromaCurve: 1.0,
      /**
       * Mix toward legacy behaviour: 0 = tint only from saturated (non-grey) RGB, 1 = ignore chroma gate
       * (old “full RGB” colouration, can double-count white with luminance).
       */
      colorationAchromaticMix: 0.0,
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
      /**
       * Optional tone curve on the lighting pass output (None recommended if Colour Correction
       * tone mapping is already enabled).
       */
      composeToneMapping: 0,
      composeToneExposure: 1.0,
      /** Multiplies building-shadow opacity when applied to ambient in this pass (0 = off). */
      ambientBuildingShadowMix: 1.0,
      /** How much cloud / combined shadow darkens ambient here (0 = ignore, 1 = full). */
      cloudShadowAmbientInfluence: 1.0,
      /** Scales overhead shadow strength on ambient only (0 = off). */
      overheadShadowAmbientInfluence: 1.0,
      /** Internal render scale for source lights RT (1.0 = full resolution). */
      internalLightResolutionScale: 1.0,
      /** Internal render scale for window glow RT (1.0 = full resolution). */
      internalWindowResolutionScale: 1.0,
      /** Internal render scale for darkness RT (1.0 = full resolution). */
      internalDarknessResolutionScale: 1.0,
      /** Use half-float for window light RT (false allows 8-bit to cut bandwidth). */
      windowLightUseHalfFloat: true,
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
    /** @type {THREE.Vector3|null} Reusable projection helper vector */
    this._tmpNdcVec = null;
    /** @type {THREE.Vector3|null} Reusable projection helper vector */
    this._tmpWorldVec = null;
    /** @type {THREE.Vector3|null} Reusable projection helper vector */
    this._tmpDirVec = null;
    /** @type {Array<{ndcX:number,ndcY:number,key:string}>} Stable corner descriptors */
    this._perspectiveCornerDefs = [
      { ndcX: -1, ndcY: -1, key: '00' },
      { ndcX:  1, ndcY: -1, key: '10' },
      { ndcX: -1, ndcY:  1, key: '01' },
      { ndcX:  1, ndcY:  1, key: '11' },
    ];
    /** @type {WeakSet<object>} Tracks normalized outdoors mask textures */
    this._normalizedOutdoorsTextures = new WeakSet();
    /** @type {number|null} Cached tone mapping mode define */
    this._composeToneMappingMode = null;
    /** @type {{r:number,g:number,b:number}|null} Cached ambientBrightest RGB */
    this._lastAmbientBrightestRgb = null;
    /** @type {{r:number,g:number,b:number}|null} Cached ambientDarkness RGB */
    this._lastAmbientDarknessRgb = null;
    /** @type {number|null} Cached ambientBrightest hex */
    this._lastAmbientBrightestHex = null;
    /** @type {number|null} Cached ambientDarkness hex */
    this._lastAmbientDarknessHex = null;

    /**
     * Per-frame Levels/floor snapshot from `FloorCompositor` (optional).
     * When null, `render()` falls back to {@link createLightingPerspectiveContext}.
     * @type {import('../LightingPerspectiveContext.js').LightingPerspectiveContext|null}
     */
    this._lightingPerspectiveContext = null;

    /**
     * When set, Foundry light visibility uses this FloorStack band midpoint instead of
     * the global viewer perspective so each multi-floor lit slice only receives lights
     * for that floor pass.
     * @type {number|null}
     */
    this._renderFloorIndexForLights = null;
  }

  /**
   * @private
   * @param {number} n
   * @returns {number}
   */
  _sanitizeResolutionScale(n) {
    const v = Number(n);
    return Number.isFinite(v) ? Math.max(0.25, Math.min(1.0, v)) : 1.0;
  }

  /**
   * @private
   * @param {number} baseW
   * @param {number} baseH
   * @param {number} scale
   * @returns {{ w: number, h: number }}
   */
  _scaledTargetSize(baseW, baseH, scale) {
    const s = this._sanitizeResolutionScale(scale);
    return {
      w: Math.max(1, Math.round(baseW * s)),
      h: Math.max(1, Math.round(baseH * s)),
    };
  }

  /**
   * @private
   * @param {THREE.Texture|null|undefined} texture
   */
  _normalizeOutdoorsMaskTexture(texture) {
    const tex = texture;
    if (!tex || this._normalizedOutdoorsTextures.has(tex)) return;
    const THREE = window.THREE;
    if (!THREE) return;
    let texChanged = false;
    if (tex.wrapS !== THREE.ClampToEdgeWrapping) { tex.wrapS = THREE.ClampToEdgeWrapping; texChanged = true; }
    if (tex.wrapT !== THREE.ClampToEdgeWrapping) { tex.wrapT = THREE.ClampToEdgeWrapping; texChanged = true; }
    if (tex.minFilter !== THREE.LinearFilter) { tex.minFilter = THREE.LinearFilter; texChanged = true; }
    if (tex.magFilter !== THREE.LinearFilter) { tex.magFilter = THREE.LinearFilter; texChanged = true; }
    if (tex.generateMipmaps !== false) { tex.generateMipmaps = false; texChanged = true; }
    if (texChanged) tex.needsUpdate = true;
    this._normalizedOutdoorsTextures.add(tex);
  }

  /**
   * @param {import('../LightingPerspectiveContext.js').LightingPerspectiveContext|null} ctx
   */
  setLightingPerspectiveContext(ctx) {
    this._lightingPerspectiveContext = ctx;
    this._perspectiveRefreshDirty = true;
  }

  /**
   * Per-level compositor pass: gate AmbientLights for this floor index only.
   * Pass `null` after per-level passes complete (see FloorCompositor).
   * @param {number|null} [floorIndex=null]
   */
  setRenderFloorIndexForLights(floorIndex = null) {
    const n = Number(floorIndex);
    this._renderFloorIndexForLights = Number.isFinite(n) ? n : null;
    this._perspectiveRefreshDirty = true;
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

    this._invalidateEnhancementCache();
    this.syncAllLights();
  }

  /**
   * Read per-light enhancement config from scene flags.
   * @private
   * @returns {Map<string, object>}
   */
  _getLightEnhancementConfigMap() {
    const scene = canvas?.scene;
    if (!scene) return new Map();
    const sceneId = scene?.id ?? scene?._id ?? null;

    let raw;
    try {
      raw = scene.getFlag?.(MODULE_ID, LIGHT_ENHANCEMENT_FLAG_KEY);
    } catch (_) {
      raw = scene?.flags?.[MODULE_ID]?.[LIGHT_ENHANCEMENT_FLAG_KEY];
    }

    const list = Array.isArray(raw)
      ? raw
      : (Array.isArray(raw?.lights) ? raw.lights : (Array.isArray(raw?.items) ? raw.items : []));
    const rawLen = list.length;
    const firstId = rawLen > 0 && list[0] && list[0].id != null ? String(list[0].id) : '';
    const lastId = rawLen > 1 && list[rawLen - 1] && list[rawLen - 1].id != null ? String(list[rawLen - 1].id) : '';
    const cacheKey = `${rawLen}|${firstId}|${lastId}`;
    if (this._cachedEnhancementMap
        && this._cachedEnhancementSceneId === sceneId
        && this._cachedEnhancementKey === cacheKey) {
      return this._cachedEnhancementMap;
    }

    const map = new Map();

    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const id = entry.id != null ? String(entry.id) : '';
      if (!id) continue;
      const config = (entry.config && typeof entry.config === 'object') ? entry.config : entry;
      if (!config || typeof config !== 'object') continue;
      map.set(id, config);
    }

    this._cachedEnhancementMap = map;
    this._cachedEnhancementKey = cacheKey;
    this._cachedEnhancementSceneId = sceneId;
    return map;
  }

  /** @private */
  _invalidateEnhancementCache() {
    this._cachedEnhancementMap = null;
    this._cachedEnhancementKey = null;
    this._cachedEnhancementSceneId = null;
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
    // Shallow spread would replace the whole `animation` object with a partial enhancement
    // (e.g. only speed), dropping `type` / `intensity` and breaking ThreeLightSource torch detection.
    if (baseConfig.animation && typeof baseConfig.animation === 'object'
        && enhancement.animation && typeof enhancement.animation === 'object') {
      nextConfig.animation = { ...baseConfig.animation, ...enhancement.animation };
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
        {
          name: 'ambientFloor',
          label: 'Ambient & minimum floor',
          type: 'folder',
          expanded: true,
          parameters: ['ambientDayScale', 'ambientNightScale', 'minIlluminationScale'],
        },
        {
          name: 'dynamicLuma',
          label: 'Dynamic lights (luminance)',
          type: 'folder',
          expanded: true,
          parameters: ['lightIntensity'],
        },
        {
          name: 'surfaceTint',
          label: 'Surface tint (RGB light buffer)',
          type: 'folder',
          expanded: true,
          parameters: [
            'colorationStrength',
            'colorationReflectivity',
            'colorationSaturation',
            'colorationChromaCurve',
            'colorationAchromaticMix',
          ],
        },
        {
          name: 'composeTonemap',
          label: 'Lighting pass tone map',
          type: 'folder',
          expanded: false,
          parameters: ['composeToneMapping', 'composeToneExposure'],
        },
        {
          name: 'ambientShadowMix',
          label: 'Ambient shadow mixing',
          type: 'folder',
          expanded: false,
          parameters: [
            'ambientBuildingShadowMix',
            'cloudShadowAmbientInfluence',
            'overheadShadowAmbientInfluence',
          ],
        },
        {
          name: 'occlusion',
          label: 'Occlusion',
          type: 'folder',
          expanded: false,
          parameters: [
            'wallInsetPx',
            'restrictRoofScreenLightOcclusionToTopFloor',
            'upperFloorTransmissionEnabled',
            'upperFloorTransmissionStrength',
          ],
        },
        {
          name: 'darkness',
          label: 'Darkness response',
          type: 'folder',
          expanded: false,
          parameters: ['interiorDarkness', 'negativeDarknessStrength', 'darknessPunchGain'],
        },
        {
          name: 'lightAnim',
          label: 'Light animation',
          type: 'folder',
          expanded: false,
          parameters: ['lightAnimWindInfluence', 'lightAnimOutdoorPower'],
        },
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        globalIllumination: {
          type: 'slider',
          min: 0,
          max: 2,
          step: 0.1,
          default: 1.3,
          label: 'Illumination scale (legacy)',
          hidden: true,
          tooltip: 'Deprecated: use Day ambient and Night ambient. Kept so old module data still loads.',
        },
        ambientDayScale: {
          type: 'slider',
          min: 0,
          max: 3.5,
          step: 0.05,
          default: 1.3,
          label: 'Day ambient (noon)',
          tooltip: 'Scales Foundry “ambient brightest” at low darkness only. Raise for brighter midday without lifting night.',
        },
        ambientNightScale: {
          type: 'slider',
          min: 0,
          max: 3.5,
          step: 0.05,
          default: 1.3,
          label: 'Night ambient fill',
          tooltip: 'Scales Foundry “ambient darkness” at high darkness. Lower for deeper night while keeping day bright.',
        },
        minIlluminationScale: {
          type: 'slider',
          min: 0,
          max: 3,
          step: 0.05,
          default: 1.0,
          label: 'Minimum light floor',
          tooltip: 'Scales the darkest-scene safety floor so interiors never clip to pure black.',
        },
        lightIntensity: { type: 'slider', min: 0, max: 2, step: 0.05, default: 0.25, label: 'Light intensity' },
        colorationStrength: {
          type: 'slider',
          min: 0,
          max: 40,
          step: 0.05,
          default: 1.0,
          label: 'Tint strength',
          tooltip: 'How strongly coloured light tints surfaces (achromatic / white lights are excluded by default).',
        },
        colorationReflectivity: {
          type: 'slider',
          min: 0,
          max: 2,
          step: 0.05,
          default: 1.0,
          label: 'Tint vs albedo',
          tooltip: 'Couples tint to surface brightness (albedo luma); lower flattens tint on dark pixels.',
        },
        colorationSaturation: {
          type: 'slider',
          min: -1,
          max: 2,
          step: 0.05,
          default: 0.0,
          label: 'Tint input saturation',
          tooltip: 'Pre-boosts chroma in the light buffer before tint (0 = as rendered).',
        },
        colorationChromaCurve: {
          type: 'slider',
          min: 0.25,
          max: 4,
          step: 0.05,
          default: 1.0,
          label: 'Chroma sharpness',
          tooltip: 'Higher values need more saturated lamp colours before tint reaches full strength.',
        },
        colorationAchromaticMix: {
          type: 'slider',
          min: 0,
          max: 1,
          step: 0.05,
          default: 0.0,
          label: 'Neutral light bleed',
          tooltip: 'Blends toward legacy behaviour where white lights also drove the tint path (can brighten greys).',
        },
        composeToneMapping: {
          type: 'list',
          label: 'Tone mapping',
          options: { None: 0, 'ACES Filmic': 1, Reinhard: 2 },
          default: 0,
          tooltip: 'Applied at the end of the lighting pass. Prefer None if Colour Correction already tone maps.',
        },
        composeToneExposure: {
          type: 'slider',
          min: 0.25,
          max: 4,
          step: 0.05,
          default: 1.0,
          label: 'Tone-map exposure',
          tooltip: 'Linear gain before tone mapping (only when tone mapping is not None).',
        },
        ambientBuildingShadowMix: {
          type: 'slider',
          min: 0,
          max: 1,
          step: 0.05,
          default: 1.0,
          label: 'Building shadow on ambient',
          tooltip: 'Scales how much baked building shadow darkens ambient illumination in this pass.',
        },
        cloudShadowAmbientInfluence: {
          type: 'slider',
          min: 0,
          max: 1,
          step: 0.05,
          default: 1.0,
          label: 'Cloud shadow on ambient',
          tooltip: 'Reduces cloud (or combined) shadow on ambient only; dynamic lights stay full strength.',
        },
        overheadShadowAmbientInfluence: {
          type: 'slider',
          min: 0,
          max: 1,
          step: 0.05,
          default: 1.0,
          label: 'Overhead shadow on ambient',
          tooltip: 'Scales overhead tile shadow on ambient; torches and lamps still punch through.',
        },
        wallInsetPx: { type: 'slider', min: 0, max: 40, step: 0.5, default: 6.0, label: 'Wall Inset (px)' },
        restrictRoofScreenLightOcclusionToTopFloor: {
          type: 'boolean',
          default: true,
          label: 'Multi-floor: roof gate & building roof-cutout top floor only',
          tooltip: 'When on (recommended for 2+ floors), Foundry lights use screen-space roof alpha only on the top floor so upstairs stamps do not cut lower-floor lights. Building shadows skip roof-cutout on the uppermost band when 2+ floors exist (that band’s map art is often on the roof layer and would otherwise suppress all building shadows). Single-floor maps unchanged. Turn off for legacy “always gate” on lights.',
        },
        upperFloorTransmissionEnabled: { type: 'boolean', default: false, label: 'Upper Floor Through-Gaps' },
        upperFloorTransmissionStrength: { type: 'slider', min: 0, max: 2, step: 0.05, default: 0.6, label: 'Upper Light Strength' },
        interiorDarkness: {
          type: 'slider',
          min: 0,
          max: 1.5,
          step: 0.05,
          default: 0.0,
          label: 'Interior Darkness',
          tooltip: 'Extra dim on mask-classified interiors (ambient only). Fades out automatically under Foundry / window light so torches and overlap regions do not stay muddy; specular in the scene buffer scales with total illumination.',
        },
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
    this._tmpNdcVec = new THREE.Vector3();
    this._tmpWorldVec = new THREE.Vector3();
    this._tmpDirVec = new THREE.Vector3();

    // ── Light accumulation RT (HDR, additive blending) ────────────────
    const rtOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    const lightSize = this._scaledTargetSize(w, h, this.params.internalLightResolutionScale);
    const windowSize = this._scaledTargetSize(w, h, this.params.internalWindowResolutionScale);
    const darknessSize = this._scaledTargetSize(w, h, this.params.internalDarknessResolutionScale);
    this._lightRT = new THREE.WebGLRenderTarget(lightSize.w, lightSize.h, rtOpts);
    // Linear storage: light accumulation is additive in linear space.
    this._lightRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
    const windowRtOpts = {
      ...rtOpts,
      type: this.params.windowLightUseHalfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
    };
    this._windowLightRT = new THREE.WebGLRenderTarget(windowSize.w, windowSize.h, windowRtOpts);
    this._windowLightRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this._darknessRT = new THREE.WebGLRenderTarget(darknessSize.w, darknessSize.h, {
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
      defines: {
        COMPOSE_TONEMAP_MODE: 0,
      },
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
        uAmbientDayScale:   { value: 1.3 },
        uAmbientNightScale: { value: 1.3 },
        uLightIntensity:     { value: 0.25 },
        uMinIlluminationScale: { value: 1.0 },
        uColorationStrength: { value: 1.0 },
        uColorationReflectivity: { value: 1.0 },
        uColorationSaturation: { value: 0.0 },
        uColorationChromaCurve: { value: 1.0 },
        uColorationAchromaticMix: { value: 0.0 },
        uComposeToneExposure: { value: 1.0 },
        uCloudShadowAmbientInfluence: { value: 1.0 },
        uOverheadShadowAmbientInfluence: { value: 1.0 },
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
        uOutdoorsForRoofLightTexelSize: { value: new THREE.Vector2(0, 0) },
        // Half-res T from OverheadShadowsEffectV2: single source for geometric ceiling gate.
        tCeilingLightTransmittance: { value: null },
        uHasCeilingLightTransmittance: { value: 0 },
      },
      // IMPORTANT:
      // These shader sources are embedded in JS template literals (backticks).
      // Never include backticks inside shader comments/strings; it will break JS parsing.
      vertexShader: /* glsl */`
        precision highp float;
        precision highp int;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        precision highp int;
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
        uniform float uAmbientDayScale;
        uniform float uAmbientNightScale;
        uniform float uLightIntensity;
        uniform float uMinIlluminationScale;
        uniform float uColorationStrength;
        uniform float uColorationReflectivity;
        uniform float uColorationSaturation;
        uniform float uColorationChromaCurve;
        uniform float uColorationAchromaticMix;
        uniform float uComposeToneExposure;
        uniform float uCloudShadowAmbientInfluence;
        uniform float uOverheadShadowAmbientInfluence;
        uniform float uNegativeDarknessStrength;
        uniform float uDarknessPunchGain;
        uniform float uInteriorDarkness;
        uniform float uApplyRoofOcclusionToSources;
        uniform float uApplyRoofOcclusionToWindow;
        uniform float uApplyRoofOcclusionToBuilding;
        uniform sampler2D tOutdoorsForRoofLight;
        uniform float uHasOutdoorsForRoofLight;
        uniform float uOutdoorsForRoofLightFlipY;
        uniform vec2 uOutdoorsForRoofLightTexelSize;
        uniform sampler2D tCeilingLightTransmittance;
        uniform float uHasCeilingLightTransmittance;
        varying vec2 vUv;

        float perceivedBrightness(vec3 c) {
          return dot(c, vec3(0.2126, 0.7152, 0.0722));
        }

        float rgbSaturation(vec3 c) {
          float mn = min(min(c.r, c.g), c.b);
          float mx = max(max(c.r, c.g), c.b);
          return (mx > 1e-4) ? clamp((mx - mn) / mx, 0.0, 1.0) : 0.0;
        }

        vec3 ACESFilmicToneMapping(vec3 x) {
          float a = 2.51;
          float b = 0.03;
          float c = 2.43;
          float d = 0.59;
          float e = 0.14;
          return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
        }

        vec3 ReinhardToneMapping(vec3 x) {
          return x / (x + vec3(1.0));
        }

        void main() {
          vec4 baseColor = texture2D(tScene, vUv);
          vec4 srcSample = texture2D(tLightSources, vUv);
          vec3 srcLights = max(srcSample.rgb, vec3(0.0));
          vec3 winLights = max(texture2D(tLightWindow, vUv).rgb, vec3(0.0));
          float darknessMask = clamp(texture2D(tDarkness, vUv).r, 0.0, 1.0);

          float master = max(uLightIntensity, 0.0);
          float baseDarknessLevel = clamp(uDarknessLevel, 0.0, 1.0);

          // Ambient: interpolate between day and night based on darkness level.
          // Day and night scales are separate so you can run bright noon and deep night together.
          vec3 ambientDay   = uAmbientBrightest * max(uAmbientDayScale, 0.0);
          vec3 ambientNight = uAmbientDarkness  * max(uAmbientNightScale, 0.0);
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
            vec4 odIdC = texture2D(tOutdoorsForRoofLight, clamp(ouvId, 0.0, 1.0));
            vec4 odId = odIdC;
            // Robust decode for interior dimming:
            // - outdoors masks are authored mostly binary (0/1)
            // - composed/filtered textures can introduce tiny mid-tone rows
            //   that become visible as horizontal dark bands when scaled by
            //   uInteriorDarkness.
            // Snap near-extremes to remove seam/banding noise while preserving
            // real indoor/outdoor transitions.
            float outdoorRaw = clamp(max(odId.r, max(odId.g, odId.b)), 0.0, 1.0);
            float outdoorMid = smoothstep(0.18, 0.82, outdoorRaw);
            float outdoorLoHi = (outdoorRaw <= 0.10) ? 0.0 : ((outdoorRaw >= 0.90) ? 1.0 : outdoorMid);
            // Transparent/invalid outdoors pixels should not darken ambient.
            // In those regions treat as "outdoors" (1.0), then blend toward the
            // decoded RGB classification only where alpha is confidently present.
            // Interior-darkness should only trust clearly authored alpha.
            // Soft alpha ramps (from filtering/composition) can form thin
            // horizontal rows that interiorDarkness amplifies; treat those as
            // outdoors to avoid residual banding.
            float outdoorsAlphaValid = step(0.5, clamp(odId.a, 0.0, 1.0));
            isOutdoorForInteriorDim = mix(1.0, outdoorLoHi, outdoorsAlphaValid);
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
          // White/direct illumination channel:
          // - Foundry lights: read from accumulated alpha (luminosity-aware in ThreeLightSource)
          // - Window light: continue deriving from RGB
          float srcWhite = max(srcSample.a, 0.0) * visS;
          float winWhite = max(max(winLights.r, winLights.g), winLights.b) * visW;
          float lightI = max(srcWhite, winWhite);
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
          // Only apply interior-darkness where the mask confidently indicates
          // "indoors". This rejects low-level mask noise/seams that otherwise
          // become visible as broad banding when interior darkness is increased.
          float indoorSignal = clamp(1.0 - isOutdoorForInteriorDimSafe, 0.0, 1.0);
          float indoorConfidence = smoothstep(0.30, 0.70, indoorSignal);
          // tScene includes additive specular; litColor = baseColor * totalIllumination. If we
          // crush ambientAfterDark on interiors while directLight is only moderate, totalIllumination
          // stays low and specular highlights (already in baseColor) read flat. Fade interior
          // crush where the same dynamic channel used for darkness punch is strong (Foundry
          // srcSample.a and window whites, scaled by uLightIntensity).
          // Keep suppression for bright direct-light overlap, but avoid fully
          // flattening interior darkness under moderate baseline illumination.
          float interiorDarkLightSuppression = smoothstep(0.12, 0.65, lightTermI);
          float indoorConfidenceForDim = indoorConfidence * (1.0 - interiorDarkLightSuppression);
          ambientAfterDark *= max(0.0, 1.0 - uInteriorDarkness * indoorConfidenceForDim);

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
            float shadowFactorMix = mix(
              1.0,
              shadowFactor,
              clamp(uCloudShadowAmbientInfluence, 0.0, 1.0)
            );
            vec3 ambientPortion = ambientAfterDark;
            totalIllumination = ambientPortion * shadowFactorMix + directLight;
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
            float shadowFactorMixC = mix(
              1.0,
              shadowFactor,
              clamp(uCloudShadowAmbientInfluence, 0.0, 1.0)
            );
            // Only dim the ambient portion; keep dynamic-light additive intact.
            vec3 ambientPortion = ambientAfterDark;
            totalIllumination = ambientPortion * shadowFactorMixC + directLight;
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
            float ovAmt = clamp(uOverheadShadowOpacity, 0.0, 1.0)
              * clamp(uOverheadShadowAmbientInfluence, 0.0, 1.0);
            vec3 ovMix = mix(vec3(1.0), combinedShadowFactor, ovAmt);
            vec3 ambientComp = totalIllumination - directLight;
            ambientComp *= ovMix;
            totalIllumination = ambientComp + directLight;
          }

          // Minimum illumination floor to prevent pure black.
          vec3 minIllum = mix(ambientDay, ambientNight, localDarknessLevel)
            * (0.1 * max(uMinIlluminationScale, 0.0));
          totalIllumination = max(totalIllumination, minIllum);

          // Apply illumination to albedo.
          vec3 litColor = baseColor.rgb * totalIllumination;

          // Colouration: only the chromatic part of the RGB light buffer tints albedo.
          // Luminance for neutral / uncoloured Foundry lights already comes from tLightSources.a
          // (see directLight), so repeating full RGB here used to double-count white light.
          vec3 lumaW = vec3(0.2126, 0.7152, 0.0722);
          float lSL = dot(safeLights, lumaW);
          vec3 greySL = vec3(lSL);
          vec3 safeForColor = safeLights;
          float csat = uColorationSaturation;
          if (abs(csat) > 1e-5) {
            safeForColor = clamp(mix(greySL, safeLights, 1.0 + csat), 0.0, 3.5);
          }
          float lightSat = rgbSaturation(safeForColor);
          float chromaW = pow(max(lightSat, 0.0), max(uColorationChromaCurve, 0.001));
          chromaW = mix(chromaW, 1.0, clamp(uColorationAchromaticMix, 0.0, 1.0));

          float reflection = perceivedBrightness(baseColor.rgb) * max(uColorationReflectivity, 0.0);
          vec3 coloration = safeForColor * master * reflection
            * max(uColorationStrength, 0.0) * chromaW;
          litColor += coloration;

          vec3 outRgb = litColor * max(uComposeToneExposure, 0.0);
          #if COMPOSE_TONEMAP_MODE == 1
            outRgb = ACESFilmicToneMapping(outRgb);
          #elif COMPOSE_TONEMAP_MODE == 2
            outRgb = ReinhardToneMapping(outRgb);
          #endif
          gl_FragColor = vec4(outRgb, baseColor.a);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    this._composeToneMappingMode = 0;
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
    // Full dispose+rebuild so wall-clipped LOS geometry and materials are not reused
    // across floors (placeables/embedded docs can change; baked polygons must match the active band).
    this._registerHook('mapShineLevelContextChanged', () => {
      this.syncAllLights();
    });
    this._registerHook('lightingRefresh', () => {
      this._reconcileMissingEmbeddedLights();
      this._markPerspectiveRefreshDirty();
    });

    this._initialized = true;
    log.info(`LightingEffectV2 initialized (${w}x${h})`);
  }

  // ── Light sync ────────────────────────────────────────────────────────

  /** @private @param {unknown} id */
  _lightMapKey(id) {
    if (id == null || id === '') return '';
    return String(id);
  }

  /**
   * Drop V2 meshes for scene lights that no longer exist, then add any missing docs.
   * Runs on `lightingRefresh` so a missed `deleteAmbientLight` hook cannot leave ghosts;
   * also fixes the old early-return when embedded collection was empty (no pruning).
   * @private
   */
  _reconcileMissingEmbeddedLights() {
    if (!this._initialized || !this._lightsSynced) return;
    const docs = getAuthoritativeAmbientLightDocuments();
    const enhancementMap = this._getLightEnhancementConfigMap();

    const validPositive = new Set();
    const validNegative = new Set();
    for (const doc of docs) {
      const key = this._lightMapKey(doc?.id ?? doc?._id);
      if (!key) continue;
      const isNegative = doc?.config?.negative === true || doc?.negative === true;
      if (isNegative) validNegative.add(key);
      else validPositive.add(key);
    }

    let pruned = 0;
    for (const key of [...this._lights.keys()]) {
      if (validPositive.has(key)) continue;
      const light = this._lights.get(key);
      if (light?.mesh) this._lightScene?.remove(light.mesh);
      light?.dispose?.();
      this._lights.delete(key);
      this._nextAnimationUpdateAtSec.delete(key);
      pruned += 1;
    }
    for (const key of [...this._darknessSources.keys()]) {
      if (validNegative.has(key)) continue;
      const ds = this._darknessSources.get(key);
      if (ds?.mesh) this._darknessScene?.remove(ds.mesh);
      ds?.dispose?.();
      this._darknessSources.delete(key);
      this._nextAnimationUpdateAtSec.delete(key);
      pruned += 1;
    }

    let added = 0;
    for (const doc of docs) {
      const key = this._lightMapKey(doc?.id ?? doc?._id);
      if (!key) continue;
      const isNegative = doc?.config?.negative === true || doc?.negative === true;
      if (isNegative) {
        if (!this._darknessSources.has(key)) {
          this._addLightFromDoc(doc, enhancementMap);
          added += 1;
        }
      } else if (!this._lights.has(key)) {
        this._addLightFromDoc(doc, enhancementMap);
        added += 1;
      }
    }
    if (pruned > 0) {
      log.info(`LightingEffectV2: pruned ${pruned} stale light/darkness slot(s) not on scene`);
    }
    if (added > 0) {
      log.info(`LightingEffectV2: reconciled ${added} embedded light(s) missing from V2 maps`);
    }
  }

  /**
   * Full sync of all Foundry light sources. Call once after canvas is ready.
   */
  syncAllLights() {
    if (!this._initialized) return;
    this._nextAnimationUpdateAtSec.clear();

    // `_lightScene` is shared with PlayerLightEffectV2 (torch/flashlight) and
    // CandleFlamesEffectV2 (glow group). Those meshes are not in `_lights`, so a
    // normal "clear _lights" pass would leave them parented — looks like a Foundry
    // light disk after every AmbientLight is deleted. Detach foreign children first;
    // those effects re-attach on their next update if still enabled.
    if (this._lightScene) {
      const trackedMeshes = new Set();
      for (const light of this._lights.values()) {
        if (light?.mesh) trackedMeshes.add(light.mesh);
      }
      for (const ch of [...this._lightScene.children]) {
        if (!trackedMeshes.has(ch)) {
          try { this._lightScene.remove(ch); } catch (_) {}
        }
      }
    }

    // Dispose existing Foundry-tracked light sources
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

    // Prefer embedded collection: includes every AmbientLight on the scene for all levels.
    // `canvas.lighting.placeables` is only objects on the PIXI layer (often current level only).
    const docs = getAuthoritativeAmbientLightDocuments();

    const enhancementMap = this._getLightEnhancementConfigMap();
    this._lastEnhancementCount = enhancementMap.size;
    for (const doc of docs) {
      this._addLightFromDoc(doc, enhancementMap);
    }

    this._lightsSynced = true;
    this._perspectiveRefreshDirty = true;
    log.info(`LightingEffectV2: synced ${this._lights.size} lights, ${this._darknessSources.size} darkness sources`);
  }

  /**
   * Prefer the live embedded AmbientLight document from the scene collection so
   * level membership / flags match Foundry after navigation (avoids stale refs on ThreeLightSource).
   * @private
   * @param {ThreeLightSource|ThreeDarknessSource} source
   * @returns {object|null|undefined}
   */
  _liveAmbientDocForGating(source) {
    const lightsCollection = canvas?.scene?.lights;
    const id = source?.id ?? source?.document?.id;
    if (!lightsCollection || id == null) return source?.document ?? null;
    return lightsCollection.get?.(id) ?? lightsCollection.get?.(String(id)) ?? source?.document ?? null;
  }

  /**
   * Toggle Three.js light/darkness mesh visibility from Levels elevation rules
   * (`isLightVisibleForPerspective`). Uses live `canvas.scene.lights` docs when
   * available so token/level changes apply without a full resync.
   * @private
   */
  _refreshLightsForLevelsPerspective() {
    if (!this._initialized) return;
    const sceneDarkness = readFoundryDarkness01();

    for (const light of this._lights.values()) {
      if (!light?.mesh) continue;
      const doc = this._liveAmbientDocForGating(light);
      light.mesh.visible = this._isDocVisibleForLighting(doc, sceneDarkness);
    }

    for (const ds of this._darknessSources.values()) {
      if (!ds?.mesh) continue;
      const doc = this._liveAmbientDocForGating(ds);
      ds.mesh.visible = this._isDocVisibleForLighting(doc, sceneDarkness);
    }
  }

  /** @private */
  _markPerspectiveRefreshDirty() {
    this._perspectiveRefreshDirty = true;
  }

  /**
   * Refresh light visibility when dirty, with a low-frequency watchdog.
   * @private
   * @param {number} nowSec
   */
  _refreshLightsForLevelsPerspectiveIfNeeded(nowSec) {
    const t = Number.isFinite(nowSec) ? nowSec : 0;
    const elapsed = t - this._lastPerspectiveRefreshAtSec;
    const watchdogIntervalSec = 0.35;
    if (!this._perspectiveRefreshDirty && elapsed < watchdogIntervalSec) return;
    this._refreshLightsForLevelsPerspective();
    this._perspectiveRefreshDirty = false;
    this._lastPerspectiveRefreshAtSec = t;
  }

  /**
   * Reduce animation work for non-visible torch/flame lights.
   * @private
   * @param {ThreeLightSource|ThreeDarknessSource} source
   * @param {number} tSec
   * @returns {boolean}
   */
  _shouldDecimateAnimationUpdate(source, tSec) {
    if (!source) return false;
    if (source?.mesh?.visible !== false) return false;
    const animType = String(source?.document?.config?.animation?.type || '').toLowerCase();
    const isTorchLike = animType === 'torch' || animType === 'flame';
    if (!isTorchLike) return false;

    const id = String(source?.id ?? source?.document?.id ?? source?.document?._id ?? '');
    if (!id) return false;
    const nextAt = Number(this._nextAnimationUpdateAtSec.get(id));
    if (Number.isFinite(nextAt) && tSec < nextAt) return true;
    this._nextAnimationUpdateAtSec.set(id, tSec + (1 / 12));
    return false;
  }

  /**
   * Foundry visibility gate for AmbientLight docs:
   * - Levels/perspective visibility
   * - hidden flag
   * - darkness activation range (`config.darkness.{min,max}`)
   * @private
   * @param {object|null|undefined} doc
   * @param {number} sceneDarkness
   * @returns {boolean}
   */
  _isDocVisibleForLighting(doc, sceneDarkness) {
    if (!doc) return false;
    const pOverride = this._renderFloorIndexForLights != null
      ? getPerspectiveForRenderFloorIndex(this._renderFloorIndexForLights)
      : null;
    if (!isLightVisibleForPerspective(doc, pOverride)) return false;
    if (doc.hidden === true) return false;

    const d = clamp01(Number.isFinite(sceneDarkness) ? sceneDarkness : readFoundryDarkness01());
    const darknessRange = doc?.config?.darkness ?? doc?.darkness;
    if (!darknessRange || typeof darknessRange !== 'object') return true;

    const minRaw = Number(darknessRange.min);
    const maxRaw = Number(darknessRange.max);
    const hasMin = Number.isFinite(minRaw);
    const hasMax = Number.isFinite(maxRaw);
    if (!hasMin && !hasMax) return true;

    const min = hasMin ? clamp01(minRaw) : 0;
    const max = hasMax ? clamp01(maxRaw) : 1;
    const low = Math.min(min, max);
    const high = Math.max(min, max);
    return d >= low && d <= high;
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
    const id = this._lightMapKey(mergedDoc.id ?? mergedDoc._id);
    if (!id) return;
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
    this._markPerspectiveRefreshDirty();
  }

  /** @private */
  _onLightUpdate(doc, changes) {
    if (!this._initialized) return;
    const id = this._lightMapKey(doc?.id ?? doc?._id);
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
      this._markPerspectiveRefreshDirty();
      return;
    }
    if (!isNegative && this._darknessSources.has(id)) {
      const old = this._darknessSources.get(id);
      if (old.mesh) this._darknessScene?.remove(old.mesh);
      old.dispose();
      this._darknessSources.delete(id);
      this._addLightFromDoc(merged);
      this._markPerspectiveRefreshDirty();
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
    this._markPerspectiveRefreshDirty();
  }

  /** @private */
  _onLightDelete(doc) {
    if (!this._initialized) return;
    const id = this._lightMapKey(doc?.id ?? doc?._id);
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
    this._nextAnimationUpdateAtSec.delete(String(id));
    this._markPerspectiveRefreshDirty();
  }

  /**
   * One-shot migration from the old single `globalIllumination` control into
   * `ambientDayScale` / `ambientNightScale` when the latter are still at defaults
   * but legacy differs (typical old module / preset JSON).
   * @private
   */
  _seedAmbientFromLegacyGlobalIfNeeded() {
    if (this._legacyGlobalIlluminationSeeded) return;
    this._legacyGlobalIlluminationSeeded = true;
    const p = this.params;
    const g = p.globalIllumination;
    if (g === undefined || g === null || !Number.isFinite(Number(g))) return;
    const def = 1.3;
    const gv = Number(g);
    const day = Number(p.ambientDayScale);
    const night = Number(p.ambientNightScale);
    if (!Number.isFinite(day) || !Number.isFinite(night)) return;
    if (Math.abs(day - def) < 1e-5 && Math.abs(night - def) < 1e-5 && Math.abs(gv - def) > 1e-5) {
      p.ambientDayScale = gv;
      p.ambientNightScale = gv;
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
    const env = canvas?.environment;
    if (env) {
      this.params.darknessLevel = readFoundryDarkness01();
      const u = this._composeMaterial?.uniforms;
      if (u) {
        const bright = env.ambientBrightest;
        if (bright && typeof bright === 'object' && 'r' in bright) {
          const r = Number(bright.r ?? 1);
          const g = Number(bright.g ?? 1);
          const b = Number(bright.b ?? 1);
          const prev = this._lastAmbientBrightestRgb;
          if (!prev || prev.r !== r || prev.g !== g || prev.b !== b) {
            u.uAmbientBrightest.value.setRGB(r, g, b);
            this._lastAmbientBrightestRgb = { r, g, b };
            this._lastAmbientBrightestHex = null;
          }
        } else if (typeof bright === 'number' && Number.isFinite(bright) && this._lastAmbientBrightestHex !== bright) {
          u.uAmbientBrightest.value.setHex(bright);
          this._lastAmbientBrightestHex = bright;
          this._lastAmbientBrightestRgb = null;
        }
        const dark = env.ambientDarkness;
        if (dark && typeof dark === 'object' && 'r' in dark) {
          const r = Number(dark.r ?? 0.141);
          const g = Number(dark.g ?? 0.141);
          const b = Number(dark.b ?? 0.282);
          const prev = this._lastAmbientDarknessRgb;
          if (!prev || prev.r !== r || prev.g !== g || prev.b !== b) {
            u.uAmbientDarkness.value.setRGB(r, g, b);
            this._lastAmbientDarknessRgb = { r, g, b };
            this._lastAmbientDarknessHex = null;
          }
        } else if (typeof dark === 'number' && Number.isFinite(dark) && this._lastAmbientDarknessHex !== dark) {
          u.uAmbientDarkness.value.setHex(dark);
          this._lastAmbientDarknessHex = dark;
          this._lastAmbientDarknessRgb = null;
        }
      }
    }

    let sceneDarkness = clamp01(this.params.darknessLevel);
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
    this.params.darknessLevel = sceneDarkness;

    // Update light animations
    const foundrySceneDarkness = readFoundryDarkness01();
    const tSec = (timeInfo && typeof timeInfo.elapsed === 'number') ? timeInfo.elapsed : 0;
    for (const light of this._lights.values()) {
      if (!this._shouldDecimateAnimationUpdate(light, tSec) && typeof light?.updateAnimation === 'function') {
        light.updateAnimation(timeInfo, sceneDarkness);
      }
      if (light?.mesh) {
        const doc = this._liveAmbientDocForGating(light);
        light.mesh.visible = this._isDocVisibleForLighting(doc, foundrySceneDarkness);
      }
    }
    for (const ds of this._darknessSources.values()) {
      if (!this._shouldDecimateAnimationUpdate(ds, tSec) && typeof ds?.updateAnimation === 'function') {
        ds.updateAnimation(timeInfo);
      }
      if (ds?.mesh) {
        const doc = this._liveAmbientDocForGating(ds);
        ds.mesh.visible = this._isDocVisibleForLighting(doc, foundrySceneDarkness);
      }
    }

    // Update compose uniforms
    const u = this._composeMaterial?.uniforms;
    if (u) {
      this._seedAmbientFromLegacyGlobalIfNeeded();
      for (const k of LEGACY_LIGHTING_PARAM_KEYS) {
        if (Object.prototype.hasOwnProperty.call(this.params, k)) delete this.params[k];
      }
      // `uDarknessLevel` drives the ambient day/night blend in the compose shader.
      u.uDarknessLevel.value = clamp01(sceneDarkness);
      u.uAmbientDayScale.value = Math.max(0, Number(this.params.ambientDayScale) || 0);
      u.uAmbientNightScale.value = Math.max(0, Number(this.params.ambientNightScale) || 0);
      u.uLightIntensity.value = this.params.lightIntensity;
      u.uMinIlluminationScale.value = Math.max(0, Number(this.params.minIlluminationScale) || 0);
      u.uColorationStrength.value = this.params.colorationStrength;
      u.uColorationReflectivity.value = Math.max(0, Number(this.params.colorationReflectivity) || 0);
      u.uColorationSaturation.value = Number(this.params.colorationSaturation) || 0;
      u.uColorationChromaCurve.value = Math.max(0.001, Number(this.params.colorationChromaCurve) || 1);
      u.uColorationAchromaticMix.value = clamp01(Number(this.params.colorationAchromaticMix) || 0);
      const toneMode = Math.max(0, Math.min(2, Math.round(Number(this.params.composeToneMapping) || 0)));
      if (this._composeToneMappingMode !== toneMode) {
        this._composeToneMappingMode = toneMode;
        this._composeMaterial.defines.COMPOSE_TONEMAP_MODE = toneMode;
        this._composeMaterial.needsUpdate = true;
      }
      u.uComposeToneExposure.value = Math.max(0, Number(this.params.composeToneExposure) || 1);
      u.uCloudShadowAmbientInfluence.value = clamp01(Number(this.params.cloudShadowAmbientInfluence) ?? 1);
      u.uOverheadShadowAmbientInfluence.value = clamp01(Number(this.params.overheadShadowAmbientInfluence) ?? 1);
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
    const enhancementCount = this._getLightEnhancementConfigMap().size;
    if (this._lightsSynced && enhancementCount !== this._lastEnhancementCount) {
      this._invalidateEnhancementCache();
      this.syncAllLights();
    }

    // Ensure RTs match drawing buffer size
    renderer.getDrawingBufferSize(this._sizeVec);
    const w = Math.max(1, this._sizeVec.x);
    const h = Math.max(1, this._sizeVec.y);
    const lightSize = this._scaledTargetSize(w, h, this.params.internalLightResolutionScale);
    const windowSize = this._scaledTargetSize(w, h, this.params.internalWindowResolutionScale);
    const darknessSize = this._scaledTargetSize(w, h, this.params.internalDarknessResolutionScale);
    if (this._lightRT.width !== lightSize.w || this._lightRT.height !== lightSize.h) this._lightRT.setSize(lightSize.w, lightSize.h);
    if (this._windowLightRT.width !== windowSize.w || this._windowLightRT.height !== windowSize.h) this._windowLightRT.setSize(windowSize.w, windowSize.h);
    if (this._darknessRT.width !== darknessSize.w || this._darknessRT.height !== darknessSize.h) this._darknessRT.setSize(darknessSize.w, darknessSize.h);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    const persp = this._lightingPerspectiveContext ?? createLightingPerspectiveContext();
    const cu0 = this._composeMaterial.uniforms;
    const transmissionEnabled = this.params.upperFloorTransmissionEnabled === true;
    const rawTransmission = Number(this.params.upperFloorTransmissionStrength);
    const transmission = transmissionEnabled && Number.isFinite(rawTransmission)
      ? Math.max(0, Math.min(1, rawTransmission))
      : 0;
    const occlusionWeight = 1.0 - transmission;
    const restrictRoofToTop = this.params.restrictRoofScreenLightOcclusionToTopFloor === true;
    const roofScreenOcclusionScale = persp.getRoofScreenOcclusionScale(restrictRoofToTop);
    cu0.uApplyRoofOcclusionToSources.value = occlusionWeight * roofScreenOcclusionScale;
    cu0.uApplyRoofOcclusionToWindow.value = 0.0;
    const onUppermostMultiFloor = persp.isMultiFloor
      && persp.activeFloorIndex === persp.topFloorIndex
      && persp.topFloorIndex > 0;
    const buildingRoofOcclusionScale = onUppermostMultiFloor ? 0.0 : roofScreenOcclusionScale;
    cu0.uApplyRoofOcclusionToBuilding.value = buildingRoofOcclusionScale;

    // FloorCompositor may invoke render() once per visible level per frame; an earlier pass
    // clears _perspectiveRefreshDirty so later passes must not skip visibility refresh.
    this._markPerspectiveRefreshDirty();
    this._refreshLightsForLevelsPerspectiveIfNeeded(
      (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? (performance.now() / 1000)
        : 0
    );

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
        // WindowLight shaders use gl_FragCoord / uScreenSize for roof/ceiling masks.
        // uScreenSize must match THIS RT (set above), not values pushed earlier in the
        // frame — Lighting resizes these RTs after FloorCompositor.bind, and zoom/DPR
        // can otherwise desync roof sampling → apparent fade/pulse when panning or zooming.
        try {
          windowLightScene.userData?.onBindWindowLightPass?.(
            this._windowLightRT.width,
            this._windowLightRT.height,
          );
        } catch (_) {}
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
          const ndc = this._tmpNdcVec;
          const world = this._tmpWorldVec;
          const dir = this._tmpDirVec;
          if (THREE && ndc && world && dir) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            let validCornerCount = 0;

            for (const c of this._perspectiveCornerDefs) {
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
              validCornerCount += 1;

              if (c.key === '00') { c00x = ix; c00y = iy; }
              else if (c.key === '10') { c10x = ix; c10y = iy; }
              else if (c.key === '01') { c01x = ix; c01y = iy; }
              else if (c.key === '11') { c11x = ix; c11y = iy; }
            }

            if (minX !== Infinity) {
              vMinX = minX; vMinY = minY; vMaxX = maxX; vMaxY = maxY;
            }
            // If any corner ray misses the ground plane, never keep mixed
            // default 0..1 corners; that can create horizontal/diagonal UV bands.
            // Fall back to axis-aligned bounds corners for a stable mapping.
            if (validCornerCount < 4 && minX !== Infinity) {
              c00x = minX; c00y = minY;
              c10x = maxX; c10y = minY;
              c01x = minX; c01y = maxY;
              c11x = maxX; c11y = maxY;
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

    if (buildingShadowTexture) {
      cu.tBuildingShadow.value    = buildingShadowTexture;
      cu.uHasBuildingShadow.value = 1;
      const opBase = Number.isFinite(Number(buildingShadowOpacity))
        ? Math.max(0.0, Math.min(1.0, Number(buildingShadowOpacity)))
        : 0.75;
      const ambBld = Number(this.params?.ambientBuildingShadowMix);
      const bMix = Number.isFinite(ambBld) ? clamp01(ambBld) : 1.0;
      cu.uBuildingShadowOpacity.value = opBase * bMix;

      if (!this._dbgLoggedBuildingShadowOnce) {
        this._dbgLoggedBuildingShadowOnce = true;
        try {
          log.info('LightingEffectV2 building shadow bind:',
            'tex', buildingShadowTexture?.uuid || 'ok',
            '| opacity', cu.uBuildingShadowOpacity.value,
            '| has', cu.uHasBuildingShadow.value
          );
        } catch (_) {}
      }
    } else {
      cu.tBuildingShadow.value    = null;
      cu.uHasBuildingShadow.value = 0;
    }

    if (outdoorsMaskTexture) {
      this._normalizeOutdoorsMaskTexture(outdoorsMaskTexture);
      cu.tOutdoorsForRoofLight.value = outdoorsMaskTexture;
      cu.uHasOutdoorsForRoofLight.value = 1;
      cu.uOutdoorsForRoofLightFlipY.value = outdoorsMaskTexture.flipY ? 1.0 : 0.0;
      const tw = Number(outdoorsMaskTexture?.image?.width) || Number(outdoorsMaskTexture?.source?.data?.width) || 0;
      const th = Number(outdoorsMaskTexture?.image?.height) || Number(outdoorsMaskTexture?.source?.data?.height) || 0;
      cu.uOutdoorsForRoofLightTexelSize.value.set(
        tw > 0 ? 1.0 / tw : 0.0,
        th > 0 ? 1.0 / th : 0.0,
      );
    } else {
      cu.tOutdoorsForRoofLight.value = null;
      cu.uHasOutdoorsForRoofLight.value = 0;
      cu.uOutdoorsForRoofLightFlipY.value = 0;
      cu.uOutdoorsForRoofLightTexelSize.value.set(0, 0);
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
    if (this._lightRT) {
      const sz = this._scaledTargetSize(rw, rh, this.params.internalLightResolutionScale);
      this._lightRT.setSize(sz.w, sz.h);
    }
    if (this._windowLightRT) {
      const sz = this._scaledTargetSize(rw, rh, this.params.internalWindowResolutionScale);
      this._windowLightRT.setSize(sz.w, sz.h);
    }
    if (this._darknessRT) {
      const sz = this._scaledTargetSize(rw, rh, this.params.internalDarknessResolutionScale);
      this._darknessRT.setSize(sz.w, sz.h);
    }
  }

  /**
   * Remove scene-flag `lightEnhancements` rows whose ids are not on the scene (GM only).
   * @private
   * @returns {Promise<{ removed: number }>}
   */
  async _repairOrphanLightEnhancementFlags() {
    const scene = canvas?.scene;
    if (!scene) return { removed: 0 };
    try {
      if (!game?.user?.isGM) {
        log.warn('repair lightEnhancements: GM only');
        return { removed: 0 };
      }
    } catch (_) {
      return { removed: 0 };
    }

    const liveIds = new Set();
    for (const d of getAuthoritativeAmbientLightDocuments()) {
      const k = this._lightMapKey(d?.id ?? d?._id);
      if (k) liveIds.add(k);
    }

    let raw;
    try {
      raw = scene.getFlag?.(MODULE_ID, LIGHT_ENHANCEMENT_FLAG_KEY);
    } catch (_) {
      raw = scene?.flags?.[MODULE_ID]?.[LIGHT_ENHANCEMENT_FLAG_KEY];
    }

    const list = Array.isArray(raw)
      ? raw
      : (Array.isArray(raw?.lights) ? raw.lights : (Array.isArray(raw?.items) ? raw.items : []));
    if (!list.length) return { removed: 0 };

    const next = [];
    let removed = 0;
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const id = this._lightMapKey(entry.id);
      if (!id) continue;
      if (!liveIds.has(id)) {
        removed += 1;
        continue;
      }
      next.push(entry);
    }
    if (removed === 0) return { removed: 0 };

    const version = (raw && typeof raw === 'object' && Number.isFinite(raw.version)) ? raw.version : 1;
    await scene.setFlag(MODULE_ID, LIGHT_ENHANCEMENT_FLAG_KEY, { version, lights: next });
    this._invalidateEnhancementCache();
    log.info(`LightingEffectV2: stripped ${removed} orphan lightEnhancement entr(y/ies) from scene flags`);
    return { removed };
  }

  /**
   * Dispose all Three.js light/darkness meshes and rebuild from Foundry scene data.
   * @param {{ repairSceneFlags?: boolean, foundryLightingRefresh?: boolean }} [options]
   * @returns {Promise<{ ok: boolean, reason?: string, orphansRemoved?: number }>}
   */
  async forceRebuildFromFoundry(options = {}) {
    const repairSceneFlags = options.repairSceneFlags === true;
    const foundryLightingRefresh = options.foundryLightingRefresh !== false;

    if (!this._initialized) {
      log.warn('LightingEffectV2.forceRebuildFromFoundry: not initialized');
      return { ok: false, reason: 'not_initialized' };
    }

    this._invalidateEnhancementCache();
    this.syncAllLights();

    let orphansRemoved = 0;
    if (repairSceneFlags) {
      const r = await this._repairOrphanLightEnhancementFlags();
      orphansRemoved = r.removed ?? 0;
      if (orphansRemoved > 0) this.syncAllLights();
      try {
        await globalThis.window?.MapShine?.lightEnhancementStore?.load?.(canvas?.scene);
      } catch (_) {}
    }

    if (foundryLightingRefresh) {
      try {
        Hooks.callAll('lightingRefresh');
      } catch (_) {}
    } else {
      this._reconcileMissingEmbeddedLights();
    }

    return { ok: true, orphansRemoved };
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
    this._invalidateEnhancementCache();
    this._perspectiveRefreshDirty = true;
    this._lastPerspectiveRefreshAtSec = -Infinity;
    this._nextAnimationUpdateAtSec.clear();
    this._initialized = false;
    this._lightingPerspectiveContext = null;
    this._renderFloorIndexForLights = null;
    this._legacyGlobalIlluminationSeeded = false;

    log.info('LightingEffectV2 disposed');
  }
}
