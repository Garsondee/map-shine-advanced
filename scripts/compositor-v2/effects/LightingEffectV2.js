/**
 * @fileoverview LightingEffectV2 — V2 lighting post-processing pass.
 *
 * HEALTH-WIRING BADGE (Map Shine Breaker Box):
 * If you change this effect's lifecycle, lightRT/darkness targets, compose shader,
 * or inputs from cloud / overhead / building shadows / window light, or the
 * half-res ceiling transmittance pass, you MUST
 * update HealthEvaluator contracts/wiring for `LightingEffectV2` and any related
 * dependency edges to prevent silent failures.
 *
 * Reads the bus scene RT (albedo + overlays) and applies ambient light,
 * dynamic light sources, darkness sources, and HDR radiance from the light buffer
 * to produce the lit image.
 *
 * Reuses the V1 ThreeLightSource and ThreeDarknessSource classes for
 * individual light mesh rendering — they max-blend into a dedicated light accumulation RT.
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
 * multiplies ambient in the compose pass. Structural building+painted occlusion
 * additionally scales the HDR light-buffer contribution (direct + colouration) so
 * wide AmbientLights cannot shine through those shadows; gameplay-scale lights clear
 * that occlusion via structural shadow override.
 *
 * Structural shadows (overhead / building / painted) are pre-multiplied by
 * ShadowManagerV2 into the combined shadow RT consumed as
 * `tUnifiedShadowFactor`; the compose pass dims ambient once. Painted shadow
 * is split back out so lift/influence apply only to non-painted terms.
 * Overhead stamp + vegetation billboard terms are factored out before
 * `dynamicShadowLiftCombined` so outdoor porch/daylight lift does not erase them.
 * Building shadow is also sampled separately (`tBuildingShadowLit`) so outdoor
 * daylight ambient can respect structural occlusion when unified shadow is lifted.
 * Legacy per-effect fallbacks (`tOverheadShadow`, cloud-only) were removed —
 * ShadowManagerV2 owns the combined factor.
 *
 * **Point light gain (`lightIntensity`):** Applied in {@link ThreeLightSource} as
 * `uComposeLightGain` on HDR radiance before max-blend into `_lightRT`.
 * Falloff uses {@link POINT_LIGHT_FALLOFF_GLSL}. Buffer RGB = Foundry tinted colour
 * (`lampHue × CI gel × mag`); alpha = mag. Compose: additive HDR `totalIllum = ambient + direct`
 * where direct uses lamp mag only; day/night ambient from Foundry env × ambientDay/Night scales.
 * Max-blend.
 * Torch / flashlight {@link ThreeLightSource} instances are updated
 * from here each frame/when params change. Window glow is unchanged.
 *
 * @module compositor-v2/effects/LightingEffectV2
 */

import { createLogger } from '../../core/log.js';
import { ThreeLightSource } from '../../effects/ThreeLightSource.js';
import { ThreeDarknessSource } from '../../effects/ThreeDarknessSource.js';
import { isLightVisibleForPerspective, getPerspectiveForRenderFloorIndex } from '../../foundry/elevation-context.js';
import { createLightingPerspectiveContext } from '../LightingPerspectiveContext.js';
import {
  computeTimeOfDayDarkness01,
  getFoundrySunlightFactor,
} from '../../core/foundry-time-phases.js';
import { getAuthoritativeAmbientLightDocuments } from '../../foundry/ambient-light-documents.js';
import { LightingDirector } from '../../core/LightingDirector.js';
import {
  GLSL_DECODE_OUTDOORS_MASK,
  applySceneViewProjectionToUniforms,
  createSceneViewProjectionCache,
  updateSceneViewProjectionFromCamera,
} from '../scene-view-projection.js';
import {
  DEFAULT_POINT_LIGHT_FALLOFF_EXPONENT,
  POINT_LIGHT_FALLOFF_PARAM_KEYS,
  applyFalloffAttenuationUniforms,
  applyPointLightFalloffUniforms,
  brightNormFromLightUniforms,
  getPointLightFalloffTuningFromParams,
  MSA_LIGHT_RADIANCE_GLSL,
} from '../../scene/point-light-falloff.js';
import { resolveEffectEnabled } from '../../effects/resolve-effect-enabled.js';

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

/** Compose-time defaults when saved ambient scales are all zero (uniform-only; does not mutate params). */
const MSA_AMBIENT_COMPOSE_DEFAULTS = Object.freeze({
  dayOutdoor: 0.92,
  dayIndoor: 0.62,
  nightOutdoor: 0.32,
  nightIndoor: 0.27,
  minIllum: 0.22,
});

const readFoundryDarkness01 = () => {
  const sceneLevel = canvas?.scene?.environment?.darknessLevel;
  if (Number.isFinite(sceneLevel)) return clamp01(sceneLevel);
  const envLevel = canvas?.environment?.darknessLevel;
  if (Number.isFinite(envLevel)) return clamp01(envLevel);
  return 0.0;
};

/** Reproject scene-UV window emit into screen-space for compose (matches compose world→scene UV). */
const WINDOW_EMIT_BLIT_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const WINDOW_EMIT_BLIT_FRAG = /* glsl */`
  uniform sampler2D tEmit;
  uniform vec2 uSceneDimensions;
  uniform vec2 uBldViewCorner00;
  uniform vec2 uBldViewCorner10;
  uniform vec2 uBldViewCorner01;
  uniform vec2 uBldViewCorner11;
  uniform vec2 uBldSceneOrigin;
  uniform vec2 uBldSceneSize;
  varying vec2 vUv;

  void main() {
    vec2 w0s = mix(uBldViewCorner00, uBldViewCorner10, vUv.x);
    vec2 w1s = mix(uBldViewCorner01, uBldViewCorner11, vUv.x);
    vec2 worldXYs = mix(w0s, w1s, vUv.y);
    float foundryXs = worldXYs.x;
    float foundryYs = uSceneDimensions.y - worldXYs.y;
    vec2 sceneUvRaw = (vec2(foundryXs, foundryYs) - uBldSceneOrigin) / max(uBldSceneSize, vec2(1e-5));
    vec2 inBounds2 = step(vec2(0.0), sceneUvRaw) * step(sceneUvRaw, vec2(1.0));
    float inSceneBounds = inBounds2.x * inBounds2.y;
    vec2 sceneUvFoundry = clamp(sceneUvRaw, 0.0, 1.0);
    vec3 win = max(texture2D(tEmit, sceneUvFoundry).rgb, vec3(0.0));
    float winL = max(win.r, max(win.g, win.b));
    win *= smoothstep(0.10, 0.24, winL);
    win = min(win, vec3(1.25)) * inSceneBounds;
    gl_FragColor = vec4(win, 1.0);
  }
`;

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
    /** @type {boolean} Static compose uniforms need to be re-parsed from params */
    this._paramsDirty = true;
    /** @type {string|null} Last light-buffer uniform signature pushed to meshes */
    this._lastLightBufferUniformSig = null;
    /** @type {boolean} Force push coloration/gain uniforms to ThreeLightSource */
    this._lightBufferUniformsDirty = true;
    /** @type {string|null} Cached falloff tuning signature for mesh uniform push */
    this._lastFalloffTuningSig = null;
    /**
     * One-shot: old scenes only stored `globalIllumination`; copy that value into
     * {@link #params.ambientDayScale} and {@link #params.ambientNightScale} when they
     * are still at schema defaults so existing worlds keep their look.
     * @type {boolean}
     */
    this._legacyGlobalIlluminationSeeded = false;
    /** @type {boolean} */
    this._splitAmbientParamsMigrated = false;

    // ── Tuning parameters (match V1 defaults) ──────────────────────────
    this.params = {
      enabled: true,
      /**
       * Legacy single scale (hidden). Superseded by ambientDayScale / ambientNightScale;
       * still loaded from old saves so {@link #_seedAmbientFromLegacyGlobalIfNeeded} can migrate.
       */
      globalIllumination: 0,
      /** Scales Foundry ambient brightest colour at darkness 0 (noon / bright scenes). */
      ambientDayScale: 0,
      /** Outdoor day ambient (_Outdoors mask); falls back to ambientDayScale when unset. */
      ambientDayScaleOutdoor: 0,
      /** Indoor day ambient (_Outdoors mask); falls back to ambientDayScale when unset. */
      ambientDayScaleIndoor: 0,
      /** Scales Foundry ambient darkness colour at darkness 1 (night). */
      ambientNightScale: 0,
      ambientNightScaleOutdoor: 0,
      ambientNightScaleIndoor: 0,
      lightIntensity: 0.75,
      /** Half-life falloff: normalized radius per halving at Foundry attenuation 0 (gentle). */
      falloffHalfInAtAtt0: 0.52,
      /** Foundry zone hardness at attenuation 1 (bright ring); larger = softer, fills radius. */
      falloffHalfInAtAtt1: 0.22,
      falloffHalfOutAtAtt0: 0.38,
      falloffHalfOutAtAtt1: 0.22,
      falloffHalfMin: 0.02,
      falloffEdgeSoftBoostIn: 0.1,
      falloffEdgeSoftBoostOut: 0.08,
      falloffBrightNormInfluence: 0.92,
      falloffDimRingWeight: 1.0,
      falloffRimAAScale: 0.38,
      falloffAttCurvePower: 1.0,
      falloffRimBandAtAtt0: 0.16,
      falloffRimBandAtAtt1: 0.08,
      falloffExponent: DEFAULT_POINT_LIGHT_FALLOFF_EXPONENT,
      /** Scales the minimum illumination floor under darkness (see compose shader). */
      minIlluminationScale: 0,
      /** Compose boost on saturated radiance excess (1 = off; ~2.5 matches Foundry-like CI). */
      colorationStrength: 3.2,
      /** Multiplier on buffer colorMix before strength. */
      colorationMixScale: 1.0,
      /** Exponent on scaled colorMix (CI curve). */
      colorationMixPower: 3.65,
      /** Hard cap on effective gel weight [0..1]. */
      colorationMaxMix: 0.69,
      /** smoothstep low edge for gel vs lampEnergyA (higher = tint starts further in). */
      colorationFalloffStart: 0.0,
      /** smoothstep high edge on lamp energy (wider = softer colour penumbra). */
      colorationFalloffEnd: 0.35,
      /** Exponent on falloff mask after smoothstep. */
      colorationFalloffPower: 1.0,
      /** Scales lampEnergyA before colour falloff (boost without moving photometric alpha). */
      colorationEnergyGain: 1.0,
      /** Boost lamp chroma before tint (0 = as buffer; 1 = full sat push). */
      colorationSaturation: 0.0,
      /** Extra saturation in compose tint path. */
      colorationSaturationBoost: 1.4,
      /** Darkens tinted result (0 = off; 1 = strong). */
      colorationDarken: 0.0,
      /** Brightens tinted result (additive on peak; can wash colour). */
      colorationBrighten: 0.0,
      /** 1 = preserve max RGB peak after tint; 0 = allow peak to change. */
      colorationPeakPreserve: 1.0,
      /** Couples gel to surface albedo luma (0 = vivid on stone). */
      colorationReflectivity: 0.0,
      /** Exponent on buffer colorMix (chroma gate). */
      colorationChromaCurve: 1.0,
      /** Blends colorMix toward 1 (legacy bleed from neutral buffer). */
      colorationAchromaticMix: 0.0,
      /** Hue shift on lamp colour (-1..1 = full rotation). */
      colorationHueShift: 0.0,
      wallInsetPx: 6.0,
      /** Padded wall segments for light LOS raycast (reduces bleed through thin walls). */
      wallPaddingPx: 2.0,
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
      negativeDarknessStrength: 2.0,
      darknessPunchGain: 0,
      /**
       * Deprecated. Retained only for legacy save compatibility; the lighting pass now always
       * outputs linear HDR. Tone mapping is owned exclusively by `ColorCorrectionEffectV2`.
       * These values are force-coerced to None/1.0 in `_syncStaticParamUniforms`.
       */
      composeToneMapping: 0,
      composeToneExposure: 1.0,
      /**
       * Amplifies darkness from the unified combined shadow texture (1 = as authored,
       * up to 10 = treat subtle penumbra as much deeper shadow for tuning).
       */
      combinedShadowEffectStrength: 2,
      /** How much cloud / combined shadow darkens ambient here (0 = ignore, 1 = full). */
      cloudShadowAmbientInfluence: 0.45,
      /** Scales overhead shadow strength on ambient only (0 = off). */
      overheadShadowAmbientInfluence: 1.0,
      /** How strongly dynamic lights neutralize ambient shadow darkening (0 = off, 1 = full). */
      dynamicLightShadowOverrideStrength: 0,
      /**
       * Outdoor daylight ambient slice (calendar day × low Foundry darkness): weight applied so
       * building+painted shadow resists lifts that flatten unified shadow; shadow override still clears both.
       */
      structuralSunAmbientOcclusion: 1.0,
      /**
       * Multiplies HDR light-buffer output (direct white channel + additive tint path) by
       * building×painted structural lit texture. Gameplay-scale lights clear via structural
       * shadow override only. 0 = legacy (fills and tints bypass structural shadow).
       */
      directStructuralOcclusionStrength: 0.5,
      /** Internal render scale for source lights RT (1.0 = full resolution). */
      internalLightResolutionScale: 1.0,
      /** Internal render scale for window glow RT (1.0 = full resolution). */
      internalWindowResolutionScale: 1.0,
      /** Internal render scale for darkness RT (1.0 = full resolution). */
      internalDarknessResolutionScale: 1.0,
      /** Use half-float for window light RT (false allows 8-bit to cut bandwidth). */
      windowLightUseHalfFloat: true,
      /**
       * Window glow indirect illumination in compose (`totalIllumination += win × gain`).
       * Separate from point-lamp HDR in `_lightRT`.
       */
      windowEmissiveGain: 1.0,
      /** Pow shaping on window mag in compose (lower = hotter cores, less flat wash). */
      windowIndirectContrast: 0.65,
      /** Mix window hue into indirect illumination (0 = neutral white). */
      windowWarmthTint: 0.62,
      /** Scales indirect window spill by wall albedo luma (keeps texture on masonry). */
      windowAlbedoCoupling: 0.78,
      /** Small additive highlight on litColor after multiply (HDR-linear; not frame multiply). */
      windowScreenSpill: 0.55,
    };

    // ── Light management ────────────────────────────────────────────────
    /** @type {Map<string, ThreeLightSource>} Foundry positive lights */
    this._lights = new Map();
    /** @type {Map<string, ThreeDarknessSource>} Foundry darkness sources */
    this._darknessSources = new Map();
    // OPTIMIZATION: Flat arrays for zero-GC iteration in hot loops
    this._lightList = [];
    this._darknessList = [];

    // ── GPU resources (created in initialize) ───────────────────────────
    /** @type {THREE.Scene|null} Scene containing ThreeLightSource meshes */
    this._lightScene = null;
    /** @type {THREE.Scene|null} Scene containing ThreeDarknessSource meshes */
    this._darknessScene = null;
    /** @type {THREE.WebGLRenderTarget|null} Foundry light mesh accumulation RT */
    this._lightRT = null;
    /** @type {THREE.WebGLRenderTarget|null} Screen-space window glow for compose (reprojected from emit). */
    this._windowLightRT = null;
    /** @type {boolean} True after emit→{@link #_windowLightRT} blit succeeds this frame. */
    this._windowComposeBlitValid = false;
    /** @type {THREE.Scene|null} */
    this._windowEmitBlitScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._windowEmitBlitCamera = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._windowEmitBlitMaterial = null;
    /** @type {THREE.WebGLRenderTarget|null} Darkness accumulation RT */
    this._darknessRT = null;

    /** @type {THREE.WebGLRenderTarget|null} Half-res packed ceiling light transmittance T in R (see {@link #renderCeilingTransmittancePass}). */
    this.ceilingTransmittanceTarget = null;
    /** @type {THREE.Scene|null} */
    this._ceilingTransmittanceScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._ceilingTransmittanceCamera = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._ceilingTransmittanceMaterial = null;
    /**
     * True after {@link #renderCeilingTransmittancePass} or {@link #preserveCeilingTransmittanceFromPreviousFrame}
     * this frame (avoids binding cleared-white RT as valid T).
     * @type {boolean}
     */
    this._ceilingTransmittanceWritten = false;

    // ── Compose pass ────────────────────────────────────────────────────
    /** @type {THREE.Scene|null} */
    this._composeScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._composeCamera = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._composeMaterial = null;
    /** @type {THREE.Mesh|null} */
    this._composeQuad = null;

    /** @type {THREE.WebGLRenderTarget|null} Multi-floor max-blend accumulator A */
    this._stackedLightRtA = null;
    /** @type {THREE.WebGLRenderTarget|null} Multi-floor max-blend accumulator B */
    this._stackedLightRtB = null;
    /** @type {THREE.WebGLRenderTarget|null} Current stacked light-buffer result */
    this._stackedLightResult = null;
    /** @type {THREE.Scene|null} */
    this._stackLightScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._stackLightCamera = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._stackLightMaterial = null;
    /** @type {boolean} */
    this._stackedLightActive = false;
    /** @type {number} */
    this._stackedLightLayerCount = 0;

    // ── Foundry hooks ───────────────────────────────────────────────────
    /** @type {Array<{hook: string, id: number}>} */
    this._hookIds = [];

    // One-shot diagnostic to trace why building shadows might be invisible.
    this._dbgLoggedBuildingShadowOnce = false;

    /** @type {THREE.WebGLRenderer|null} Last renderer from hot paths; used to clear ceiling RT on resize. */
    this._lastCompositorRenderer = null;

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
    // OPTIMIZATION: Pre-allocated objects to prevent per-frame GC
    this._lightSize = { w: 1, h: 1 };
    this._windowSize = { w: 1, h: 1 };
    this._darknessSize = { w: 1, h: 1 };
    /** @type {{w:number,h:number,lightScale:number,windowScale:number,darknessScale:number}} */
    this._lastRtSizeState = { w: -1, h: -1, lightScale: NaN, windowScale: NaN, darknessScale: NaN };
    /** @type {Set<string>} Reused by _reconcileMissingEmbeddedLights */
    this._validPositiveCache = new Set();
    /** @type {Set<string>} Reused by _reconcileMissingEmbeddedLights */
    this._validNegativeCache = new Set();
    this._lastAmbientBrightestRgb = { r: -1, g: -1, b: -1 };
    this._lastAmbientDarknessRgb = { r: -1, g: -1, b: -1 };
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

    /**
     * Which floor's Foundry lights currently occupy {@link #_lightRT}.
     * @type {number|null}
     */
    this._lightRtContentFloor = null;
    /**
     * Validity snapshot for {@link #renderLightOverrideMasks} foundry draw reuse in
     * {@link #render}.
     * @type {{valid:boolean,floorIndex:number,rtW:number,rtH:number,lightGain:number}}
     */
    this._lightMaskPrepassCache = {
      valid: false,
      floorIndex: -1,
      rtW: 0,
      rtH: 0,
      lightGain: NaN,
    };

    this._viewProjectionCache = createSceneViewProjectionCache();

    /** @type {import('../../core/diagnostics/PerformanceRecorder.js').PerformanceRecorder|null} */
    this._activePerfRecorder = null;

    /**
     * Session counters for Performance Recorder exports (reset when recorder starts).
     * @type {{ prepassReuse: number, prepassRedraw: number, lightOverrideDraws: number, composeDraws: number, ceilingTransmittanceDraws: number, stackedLightAccumulates: number }}
     */
    this._perfSession = {
      prepassReuse: 0,
      prepassRedraw: 0,
      lightOverrideDraws: 0,
      composeDraws: 0,
      ceilingTransmittanceDraws: 0,
      stackedLightAccumulates: 0,
    };
  }

  // ── Performance Recorder ───────────────────────────────────────────────────

  /**
   * Live lighting inventory + tuning knobs for performance exports.
   * @returns {object}
   */
  getPerformanceRecorderSnapshot() {
    let visibleLights = 0;
    let visibleDarkness = 0;
    const lights = this._lightList;
    for (let i = 0; i < lights.length; i++) {
      if (lights[i]?.mesh?.visible) visibleLights += 1;
    }
    const darks = this._darknessList;
    for (let i = 0; i < darks.length; i++) {
      if (darks[i]?.mesh?.visible) visibleDarkness += 1;
    }

    const drawingBuffer = this._sizeVec
      ? { w: this._sizeVec.x, h: this._sizeVec.y }
      : null;

    const estimateRtMb = (w, h, halfFloat = true) => {
      const ww = Math.max(0, Number(w) || 0);
      const hh = Math.max(0, Number(h) || 0);
      if (ww === 0 || hh === 0) return 0;
      const bpp = halfFloat ? 8 : 4;
      return (ww * hh * bpp) / (1024 * 1024);
    };

    const p = this.params ?? {};
    const wle = this._resolveWindowLightEffect();
    const emitLive = wle?.getEmitPerformanceSnapshot?.() ?? null;
    const emitRt = emitLive?.emitRt;
    const rtInventory = [
      {
        id: 'lightRT',
        w: this._lightRT?.width ?? this._lightSize.w,
        h: this._lightRT?.height ?? this._lightSize.h,
        scale: this._sanitizeResolutionScale(p.internalLightResolutionScale),
        halfFloat: true,
        estMb: estimateRtMb(this._lightRT?.width ?? this._lightSize.w, this._lightRT?.height ?? this._lightSize.h, true),
      },
      ...(emitRt ? [{
        id: 'windowEmitRT',
        w: emitRt.w,
        h: emitRt.h,
        scale: Number(emitRt.scale) || this._sanitizeResolutionScale(p.internalWindowResolutionScale),
        halfFloat: !!p.windowLightUseHalfFloat,
        estMb: estimateRtMb(emitRt.w, emitRt.h, !!p.windowLightUseHalfFloat),
      }] : []),
      {
        id: 'darknessRT',
        w: this._darknessRT?.width ?? this._darknessSize.w,
        h: this._darknessRT?.height ?? this._darknessSize.h,
        scale: this._sanitizeResolutionScale(p.internalDarknessResolutionScale),
        halfFloat: true,
        estMb: estimateRtMb(this._darknessRT?.width ?? this._darknessSize.w, this._darknessRT?.height ?? this._darknessSize.h, true),
      },
    ];
    if (this.ceilingTransmittanceTarget) {
      const cw = this.ceilingTransmittanceTarget.width ?? 0;
      const ch = this.ceilingTransmittanceTarget.height ?? 0;
      rtInventory.push({
        id: 'ceilingTransmittance',
        w: cw,
        h: ch,
        scale: 0.5,
        halfFloat: false,
        estMb: estimateRtMb(cw, ch, false),
      });
    }
    if (this._stackedLightRtA) {
      rtInventory.push({
        id: 'stackedLightRtA',
        w: this._stackedLightRtA.width,
        h: this._stackedLightRtA.height,
        scale: this._sanitizeResolutionScale(p.internalLightResolutionScale),
        halfFloat: true,
        estMb: estimateRtMb(this._stackedLightRtA.width, this._stackedLightRtA.height, true),
      });
    }
    if (this._stackedLightRtB) {
      rtInventory.push({
        id: 'stackedLightRtB',
        w: this._stackedLightRtB.width,
        h: this._stackedLightRtB.height,
        scale: this._sanitizeResolutionScale(p.internalLightResolutionScale),
        halfFloat: true,
        estMb: estimateRtMb(this._stackedLightRtB.width, this._stackedLightRtB.height, true),
      });
    }

    const estVramMb = rtInventory.reduce((s, r) => s + (r.estMb || 0), 0);
    const prepassTotal = this._perfSession.prepassReuse + this._perfSession.prepassRedraw;

    return {
      initialized: this._initialized,
      enabled: this._enabled && !!p.enabled,
      lightsSynced: this._lightsSynced,
      sourceCounts: {
        foundryLights: this._lights.size,
        foundryDarkness: this._darknessSources.size,
        visibleLights,
        visibleDarkness,
        lightEnhancements: this._getLightEnhancementConfigMap().size,
      },
      perspective: {
        renderFloorIndexForLights: this._renderFloorIndexForLights,
        lightRtContentFloor: this._lightRtContentFloor,
        activeFloorIndex: this._lightingPerspectiveContext?.activeFloorIndex ?? null,
        stackedLightActive: this._stackedLightActive,
        stackedLightLayerCount: this._stackedLightLayerCount,
      },
      drawingBuffer,
      renderTargets: rtInventory,
      estimatedRtVramMb: Math.round(estVramMb * 100) / 100,
      lightMaskPrepassCache: { ...this._lightMaskPrepassCache },
      ceilingTransmittanceWrittenThisFrame: this._ceilingTransmittanceWritten,
      resolutionScales: {
        internalLightResolutionScale: this._sanitizeResolutionScale(p.internalLightResolutionScale),
        internalWindowResolutionScale: this._sanitizeResolutionScale(p.internalWindowResolutionScale),
        internalDarknessResolutionScale: this._sanitizeResolutionScale(p.internalDarknessResolutionScale),
        windowLightUseHalfFloat: !!p.windowLightUseHalfFloat,
      },
      perfTuningParams: {
        lightIntensity: Number(p.lightIntensity) || 0,
        colorationStrength: Number(p.colorationStrength) || 0,
        directStructuralOcclusionStrength: Number(p.directStructuralOcclusionStrength) || 0,
        restrictRoofScreenLightOcclusionToTopFloor: p.restrictRoofScreenLightOcclusionToTopFloor !== false,
      },
      sessionCounters: {
        ...this._perfSession,
        prepassReusePct: prepassTotal > 0
          ? Math.round((this._perfSession.prepassReuse / prepassTotal) * 1000) / 10
          : null,
      },
      emit: emitLive,
      windowLightCompose: {
        blitOk: this._windowComposeBlitValid === true,
        composePath: 'sceneUvEmit',
        emit: emitLive?.emitRt
          ? { w: emitLive.emitRt.w, h: emitLive.emitRt.h }
          : null,
        compose: this._windowLightRT
          ? { w: this._windowLightRT.width, h: this._windowLightRT.height }
          : null,
        textureSource: emitLive?.windowLightTextureSource ?? 'emit',
      },
      windowLightTextureSource: emitLive?.windowLightTextureSource ?? 'emit',
    };
  }

  /** Reset perf session counters (Performance Recorder start). */
  resetPerformanceRecorderSession() {
    try {
      this._resolveWindowLightEffect()?.resetEmitPerfSession?.();
    } catch (_) {}
    this._perfSession.prepassReuse = 0;
    this._perfSession.prepassRedraw = 0;
    this._perfSession.lightOverrideDraws = 0;
    this._perfSession.composeDraws = 0;
    this._perfSession.ceilingTransmittanceDraws = 0;
    this._perfSession.stackedLightAccumulates = 0;
  }

  /** @private */
  _bindPerfRecorder() {
    try {
      const recorder = window.MapShine?.performanceRecorder;
      this._activePerfRecorder = recorder?.enabled ? recorder : null;
    } catch (_) {
      this._activePerfRecorder = null;
    }
  }

  /**
   * @param {string} name
   * @param {'update'|'render'} [phase='update']
   * @param {{ cpuOnly?: boolean }} [options={}]
   * @returns {object|null}
   * @private
   */
  _beginPerfSpan(name, phase = 'update', options = {}) {
    try {
      const recorder = this._activePerfRecorder;
      if (!recorder?.enabled || typeof recorder.beginEffectCall !== 'function') return null;
      const opts = { cpuOnly: options.cpuOnly === true };
      if (options.gpuSlot) opts.gpuSlot = options.gpuSlot;
      return recorder.beginEffectCall(`lighting.${phase}.${name}`, phase, opts);
    } catch (_) {
      return null;
    }
  }

  /**
   * @returns {import('./WindowLightEffectV2.js').WindowLightEffectV2|null}
   * @private
   */
  _resolveWindowLightEffect() {
    try {
      return window.MapShine?.effectComposer?._floorCompositorV2?._windowLightEffect ?? null;
    } catch (_) {
      return null;
    }
  }

  /**
   * @param {THREE.WebGLRenderer|null} renderer
   * @private
   */
  _syncWindowLightEmitContext(renderer) {
    const wle = this._resolveWindowLightEffect();
    if (!wle) return;
    wle.setEmitResolutionScale?.(this._sanitizeResolutionScale(this.params.internalWindowResolutionScale));
    if (renderer) {
      wle._syncEmitDrawingBufferFromRenderer?.(renderer);
      if (this._sizeVec && typeof renderer.getDrawingBufferSize === 'function') {
        renderer.getDrawingBufferSize(this._sizeVec);
        const bw = Math.floor(this._sizeVec.x);
        const bh = Math.floor(this._sizeVec.h);
        if (bw >= 8 && bh >= 8) {
          wle.setEmitDrawingBufferSize?.(bw, bh);
        }
      }
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
   * @param {{w:number,h:number}} out
   */
  _calcScaledSize(baseW, baseH, scale, out) {
    let s = +scale;
    if (s !== s) s = 1.0; // Fast NaN check
    else if (s < 0.25) s = 0.25;
    else if (s > 1.0) s = 1.0;

    out.w = Math.max(1, Math.round(baseW * s));
    out.h = Math.max(1, Math.round(baseH * s));
  }

  /** @private */
  _syncRenderTargetSizes(w, h) {
    const state = this._lastRtSizeState;
    const lightScale = this._sanitizeResolutionScale(this.params.internalLightResolutionScale);
    const windowScale = this._sanitizeResolutionScale(this.params.internalWindowResolutionScale);
    const darknessScale = this._sanitizeResolutionScale(this.params.internalDarknessResolutionScale);
    if (
      state.w === w && state.h === h
      && state.lightScale === lightScale
      && state.windowScale === windowScale
      && state.darknessScale === darknessScale
    ) {
      return;
    }

    state.w = w;
    state.h = h;
    state.lightScale = lightScale;
    state.windowScale = windowScale;
    state.darknessScale = darknessScale;

    this._calcScaledSize(w, h, lightScale, this._lightSize);
    this._calcScaledSize(w, h, windowScale, this._windowSize);
    this._calcScaledSize(w, h, darknessScale, this._darknessSize);

    if (this._lightRT && (this._lightRT.width !== this._lightSize.w || this._lightRT.height !== this._lightSize.h)) {
      this._lightRT.setSize(this._lightSize.w, this._lightSize.h);
    }
    if (this._stackedLightRtA && (this._stackedLightRtA.width !== this._lightSize.w || this._stackedLightRtA.height !== this._lightSize.h)) {
      this._stackedLightRtA.setSize(this._lightSize.w, this._lightSize.h);
    }
    if (this._stackedLightRtB && (this._stackedLightRtB.width !== this._lightSize.w || this._stackedLightRtB.height !== this._lightSize.h)) {
      this._stackedLightRtB.setSize(this._lightSize.w, this._lightSize.h);
    }
    if (this._windowLightRT && (this._windowLightRT.width !== this._windowSize.w || this._windowLightRT.height !== this._windowSize.h)) {
      this._windowLightRT.setSize(this._windowSize.w, this._windowSize.h);
      this._windowComposeBlitValid = false;
    }
    if (this._lastCompositorRenderer) {
      this._syncWindowLightEmitContext(this._lastCompositorRenderer);
    }
    if (this._darknessRT && (this._darknessRT.width !== this._darknessSize.w || this._darknessRT.height !== this._darknessSize.h)) {
      this._darknessRT.setSize(this._darknessSize.w, this._darknessSize.h);
    }

    const THREE = window.THREE;
    if (THREE) {
      const ctW = Math.max(1, Math.floor(w / 2));
      const ctH = Math.max(1, Math.floor(h / 2));
      if (!this.ceilingTransmittanceTarget) {
        this.ceilingTransmittanceTarget = new THREE.WebGLRenderTarget(ctW, ctH, {
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          format: THREE.RGBAFormat,
          type: THREE.UnsignedByteType,
        });
      } else if (this.ceilingTransmittanceTarget.width !== ctW || this.ceilingTransmittanceTarget.height !== ctH) {
        this.ceilingTransmittanceTarget.setSize(ctW, ctH);
      }
      try {
        const r = this._lastCompositorRenderer;
        if (r && this.ceilingTransmittanceTarget) {
          const prevTarget = r.getRenderTarget();
          r.setRenderTarget(this.ceilingTransmittanceTarget);
          r.setClearColor(0xffffff, 1);
          r.clear();
          r.setRenderTarget(prevTarget);
        }
      } catch (_) {}
    }
  }

  /**
   * Clears {@link #_ceilingTransmittanceWritten} at the start of each compositor frame
   * (call before {@link OverheadStampEffectV2#render}).
   */
  beginFrameCeilingTransmittance() {
    this._ceilingTransmittanceWritten = false;
  }

  /**
   * When overhead roof captures were reused from cache, retain last frame’s half-res T.
   */
  preserveCeilingTransmittanceFromPreviousFrame() {
    this._ceilingTransmittanceWritten = !!this.ceilingTransmittanceTarget?.texture;
  }

  /**
   * Half-res transmittance for dynamic lights under ceilings (R channel, linear 0..1).
   * @returns {THREE.Texture|null}
   */
  get ceilingTransmittanceTexture() {
    return this.ceilingTransmittanceTarget?.texture || null;
  }

  /**
   * Texture for {@link #render} compose only after a successful blit or preserve this frame.
   * @returns {THREE.Texture|null}
   */
  get ceilingTransmittanceTextureForLighting() {
    return (this._ceilingTransmittanceWritten && this.ceilingTransmittanceTarget?.texture)
      ? this.ceilingTransmittanceTarget.texture
      : null;
  }

  /**
   * Lazy fullscreen pass: roofVisibility + roofBlock → T (matches compose thresholds).
   * @private
   */
  _ensureCeilingTransmittancePass() {
    const THREE = window.THREE;
    if (!THREE || this._ceilingTransmittanceScene) return;

    this._ceilingTransmittanceCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._ceilingTransmittanceScene = new THREE.Scene();
    this._ceilingTransmittanceMaterial = new THREE.ShaderMaterial({
      depthWrite: false,
      depthTest: false,
      uniforms: {
        tRoofVis: { value: null },
        tRoofBlock: { value: null },
        uHasRoofVis: { value: 0 },
        uHasRoofBlock: { value: 0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tRoofVis;
        uniform sampler2D tRoofBlock;
        uniform float uHasRoofVis;
        uniform float uHasRoofBlock;
        varying vec2 vUv;
        void main() {
          float T = 1.0;
          float roofVisOcc = 0.0;
          if (uHasRoofVis > 0.5) {
            vec4 rv = texture2D(tRoofVis, vUv);
            float a = clamp(max(rv.a, max(rv.r, max(rv.g, rv.b))), 0.0, 1.0);
            roofVisOcc = smoothstep(0.10, 0.14, a);
            T *= (1.0 - roofVisOcc);
          }
          if (uHasRoofBlock > 0.5) {
            vec4 rb = texture2D(tRoofBlock, vUv);
            float b = clamp(max(rb.a, max(rb.r, max(rb.g, rb.b))), 0.0, 1.0);
            float roofBlockOcc = smoothstep(0.42, 0.48, b) * roofVisOcc;
            T *= (1.0 - roofBlockOcc);
          }
          gl_FragColor = vec4(T, T, T, 1.0);
        }
      `,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._ceilingTransmittanceMaterial);
    mesh.frustumCulled = false;
    this._ceilingTransmittanceScene.add(mesh);
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Texture|null} roofVisTex
   * @param {THREE.Texture|null} roofBlockTex
   */
  renderCeilingTransmittancePass(renderer, roofVisTex, roofBlockTex) {
    if (!renderer || !roofVisTex || !roofBlockTex || !this.ceilingTransmittanceTarget) {
      return;
    }
    this._perfSession.ceilingTransmittanceDraws += 1;
    this._bindPerfRecorder();
    const _perfToken = this._beginPerfSpan('ceilingTransmittance.draw', 'render');
    this._ensureCeilingTransmittancePass();
    if (!this._ceilingTransmittanceMaterial || !this._ceilingTransmittanceScene
      || !this._ceilingTransmittanceCamera) {
      this._endPerfSpan(_perfToken);
      return;
    }
    const m = this._ceilingTransmittanceMaterial;
    m.uniforms.tRoofVis.value = roofVisTex;
    m.uniforms.tRoofBlock.value = roofBlockTex;
    m.uniforms.uHasRoofVis.value = 1.0;
    m.uniforms.uHasRoofBlock.value = 1.0;

    const prev = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(this.ceilingTransmittanceTarget);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear();
      renderer.render(this._ceilingTransmittanceScene, this._ceilingTransmittanceCamera);
      this._ceilingTransmittanceWritten = true;
    } finally {
      renderer.setRenderTarget(prev);
      this._endPerfSpan(_perfToken);
    }
  }

  /** @private */
  _syncViewSceneUniforms(camera) {
    const cu = this._composeMaterial?.uniforms;
    const dims = canvas?.dimensions;
    const cam = camera;
    if (!cu || !cam || !dims) return;

    const sc = window.MapShine?.sceneComposer;
    const groundZ = sc?.basePlaneMesh?.position?.z ?? (sc?.groundZ ?? 0);

    updateSceneViewProjectionFromCamera(
      cam,
      groundZ,
      this._viewProjectionCache,
      {
        ndc: this._tmpNdcVec,
        world: this._tmpWorldVec,
        dir: this._tmpDirVec,
      },
    );

    applySceneViewProjectionToUniforms(this._viewProjectionCache, cu);

    const sr = dims.sceneRect ?? dims;
    cu.uBldSceneOrigin.value.set(sr.x ?? 0, sr.y ?? 0);
    cu.uBldSceneSize.value.set(
      sr.width ?? dims.sceneWidth ?? 1,
      sr.height ?? dims.sceneHeight ?? 1,
    );
    cu.uSceneDimensions.value.set(
      dims.width ?? 1,
      dims.height ?? 1,
    );
  }

  /** @private */
  _ensureWindowEmitBlitPass() {
    const THREE = window.THREE;
    if (!THREE || this._windowEmitBlitScene) return;

    this._windowEmitBlitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._windowEmitBlitScene = new THREE.Scene();
    this._windowEmitBlitMaterial = new THREE.ShaderMaterial({
      depthWrite: false,
      depthTest: false,
      uniforms: {
        tEmit: { value: null },
        uSceneDimensions: { value: new THREE.Vector2(1, 1) },
        uBldViewCorner00: { value: new THREE.Vector2(0, 0) },
        uBldViewCorner10: { value: new THREE.Vector2(1, 0) },
        uBldViewCorner01: { value: new THREE.Vector2(0, 1) },
        uBldViewCorner11: { value: new THREE.Vector2(1, 1) },
        uBldSceneOrigin: { value: new THREE.Vector2(0, 0) },
        uBldSceneSize: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: WINDOW_EMIT_BLIT_VERT,
      fragmentShader: WINDOW_EMIT_BLIT_FRAG,
    });
    this._windowEmitBlitMaterial.toneMapped = false;
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._windowEmitBlitMaterial);
    quad.frustumCulled = false;
    this._windowEmitBlitScene.add(quad);
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera
   * @param {THREE.Texture|null} emitTex
   * @returns {boolean}
   * @private
   */
  _blitWindowEmitToComposeRT(renderer, camera, emitTex) {
    this._windowComposeBlitValid = false;
    if (!emitTex || !this._windowLightRT || !renderer || !camera) return false;

    const THREE = window.THREE;
    if (!THREE) return false;

    this._ensureWindowEmitBlitPass();
    const bm = this._windowEmitBlitMaterial;
    const cu = this._composeMaterial?.uniforms;
    if (!bm || !cu) return false;

    this._syncViewSceneUniforms(camera);
    bm.uniforms.tEmit.value = emitTex;
    bm.uniforms.uSceneDimensions.value.copy(cu.uSceneDimensions.value);
    bm.uniforms.uBldViewCorner00.value.copy(cu.uBldViewCorner00.value);
    bm.uniforms.uBldViewCorner10.value.copy(cu.uBldViewCorner10.value);
    bm.uniforms.uBldViewCorner01.value.copy(cu.uBldViewCorner01.value);
    bm.uniforms.uBldViewCorner11.value.copy(cu.uBldViewCorner11.value);
    bm.uniforms.uBldSceneOrigin.value.copy(cu.uBldSceneOrigin.value);
    bm.uniforms.uBldSceneSize.value.copy(cu.uBldSceneSize.value);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    try {
      renderer.setRenderTarget(this._windowLightRT);
      renderer.setClearColor(0x000000, 1);
      renderer.autoClear = true;
      renderer.clear();
      renderer.render(this._windowEmitBlitScene, this._windowEmitBlitCamera);
      this._windowComposeBlitValid = true;
      return true;
    } catch (err) {
      log.warn('_blitWindowEmitToComposeRT failed:', err);
      return false;
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
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
    // Cache dimensions once; render() reads these every frame.
    const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
    if (compositor?.getMaskTexturePixelSize) {
      const dim = compositor.getMaskTexturePixelSize(tex);
      tex._msaWidth = dim.w;
      tex._msaHeight = dim.h;
    } else {
      tex._msaWidth = Number(tex?.image?.width) || Number(tex?.source?.data?.width) || 0;
      tex._msaHeight = Number(tex?.image?.height) || Number(tex?.source?.data?.height) || 0;
    }
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

  /**
   * UI/settings callback used by the V2 control bridge.
   * @param {string} paramId
   * @param {unknown} value
   */
  applyParamChange(paramId, value) {
    if (!this.params || !Object.prototype.hasOwnProperty.call(this.params, paramId)) return;
    this.params[paramId] = value;
    this._paramsDirty = true;
    if (
      paramId === 'lightIntensity'
      || paramId === 'colorationStrength'
      || paramId === 'colorationMixScale'
      || paramId === 'colorationMaxMix'
      || paramId === 'colorationReflectivity'
    ) {
      this._pushLightBufferUniformsToMeshes();
    }
    if (POINT_LIGHT_FALLOFF_PARAM_KEYS.includes(paramId)) this._pushPointLightFalloffUniforms();
    if (paramId === 'wallInsetPx' || paramId === 'wallPaddingPx') this.syncAllLights();
  }

  /** @private */
  _markParamsDirty() {
    this._paramsDirty = true;
  }

  /** @private */
  _syncStaticParamUniforms() {
    if (!this._paramsDirty) return;
    const u = this._composeMaterial?.uniforms;
    if (!u) return;

    this._seedAmbientFromLegacyGlobalIfNeeded();
    for (const k of LEGACY_LIGHTING_PARAM_KEYS) {
      if (Object.prototype.hasOwnProperty.call(this.params, k)) delete this.params[k];
    }
    this._pushEffectiveAmbientUniforms(u);
    u.uWindowEmissiveGain.value = Math.max(0, Number(this.params.windowEmissiveGain) || 0);
    u.uWindowIndirectContrast.value = Math.max(
      0.35,
      Math.min(1.25, Number(this.params.windowIndirectContrast) ?? 0.65),
    );
    u.uWindowWarmthTint.value = clamp01(Number(this.params.windowWarmthTint) ?? 0.62);
    u.uWindowAlbedoCoupling.value = Math.max(0, Number(this.params.windowAlbedoCoupling) ?? 0.78);
    u.uWindowScreenSpill.value = Math.max(0, Number(this.params.windowScreenSpill) ?? 0.55);
    u.uChromaticRadianceGain.value = Math.max(1.0, Number(this.params.colorationStrength) || 4.0);
    u.uColorationReflectivity.value = clamp01(Number(this.params.colorationReflectivity) ?? 0);
    u.uColorationSaturationBoost.value = Math.max(0, Number(this.params.colorationSaturationBoost) || 0);
    u.uColorationFalloffStart.value = Math.max(0, Number(this.params.colorationFalloffStart) || 0);
    u.uColorationFalloffEnd.value = Math.max(
      u.uColorationFalloffStart.value + 0.001,
      Number(this.params.colorationFalloffEnd) || 0.35,
    );
    u.uColorationFalloffPower.value = Math.max(0.01, Number(this.params.colorationFalloffPower) || 1);
    u.uColorationEnergyGain.value = Math.max(0, Number(this.params.colorationEnergyGain) || 1);
    u.uColorationMixPower.value = Math.max(0.01, Number(this.params.colorationMixPower) || 1);
    this._lightBufferUniformsDirty = true;
    // Linear HDR refactor (Phase 0): the lighting pass must emit unclamped linear light.
    // Tone mapping is owned by ColorCorrectionEffectV2; we hard-coerce these to safe values
    // regardless of stored params so legacy scenes that set ACES/Reinhard here stop double-applying.
    this.params.composeToneMapping = 0;
    this.params.composeToneExposure = 1.0;
    if (this._composeToneMappingMode !== 0) {
      this._composeToneMappingMode = 0;
      this._composeMaterial.defines.COMPOSE_TONEMAP_MODE = 0;
      this._composeMaterial.needsUpdate = true;
    }
    u.uComposeToneExposure.value = 1.0;
    u.uCombinedShadowEffectStrength.value = Math.max(
      1.0,
      Math.min(10.0, Number(this.params.combinedShadowEffectStrength) || 1.0)
    );
    u.uCloudShadowAmbientInfluence.value = clamp01(Number(this.params.cloudShadowAmbientInfluence) ?? 1);
    u.uOverheadShadowAmbientInfluence.value = clamp01(Number(this.params.overheadShadowAmbientInfluence) ?? 1);
    u.uDynamicLightShadowOverrideStrength.value = clamp01(Number(this.params.dynamicLightShadowOverrideStrength) ?? 0.65);
    u.uStructuralSunAmbientOcclusion.value = clamp01(Number(this.params.structuralSunAmbientOcclusion) ?? 1.0);
    u.uDirectStructuralOcclusionStrength.value = clamp01(Number(this.params.directStructuralOcclusionStrength) ?? 1.0);
    u.uNegativeDarknessStrength.value = this.params.negativeDarknessStrength;
    u.uDarknessPunchGain.value = this.params.darknessPunchGain;
    u.uInteriorDarkness.value = Math.max(0, Number(this.params.interiorDarkness) || 0);
    this._paramsDirty = false;
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
      raw = scene.flags?.[MODULE_ID]?.[LIGHT_ENHANCEMENT_FLAG_KEY]
        ?? scene.getFlag?.(MODULE_ID, LIGHT_ENHANCEMENT_FLAG_KEY);
    } catch (_) {}

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

  /**
   * Latest dynamic-light accumulation texture (previous frame when sampled by
   * pre-light shadow passes).
   * @returns {THREE.Texture|null}
   */
  get dynamicLightTexture() {
    return this._lightRT?.texture ?? null;
  }

  /** @returns {THREE.Texture|null} Alias for {@link dynamicLightTexture} (post-merge CC local override). */
  get lightTexture() {
    return this.dynamicLightTexture;
  }

  /**
   * Begin accumulating per-floor `_lightRT` layers for post-merge CC local override.
   * @param {THREE.WebGLRenderer} renderer
   */
  beginStackedLightBuffer(renderer) {
    if (!renderer || !this._stackedLightRtA) return;
    this._bindPerfRecorder();
    const _perfToken = this._beginPerfSpan('stackedLight.begin', 'render');
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this._stackedLightRtA);
    // Alpha must be 0 — max-blend with a=1 clear would leave influence at 1.0 map-wide.
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.setRenderTarget(prevTarget);
    this._stackedLightResult = this._stackedLightRtA;
    this._stackedLightActive = true;
    this._stackedLightLayerCount = 0;
    this._endPerfSpan(_perfToken);
  }

  /**
   * Max-blend the current floor's `_lightRT` into the stacked accumulator.
   * @param {THREE.WebGLRenderer} renderer
   */
  accumulateStackedLightBuffer(renderer) {
    if (!renderer || !this._lightRT?.texture || !this._stackLightMaterial) return;
    this._perfSession.stackedLightAccumulates += 1;
    if (!this._stackedLightActive) this.beginStackedLightBuffer(renderer);

    const accumTex = this._stackedLightResult?.texture ?? this._stackedLightRtA?.texture;
    if (!accumTex) return;

    const out = (this._stackedLightResult === this._stackedLightRtA)
      ? this._stackedLightRtB
      : this._stackedLightRtA;
    if (!out) return;

    this._bindPerfRecorder();
    const _perfToken = this._beginPerfSpan('stackedLight.accumulate', 'render');
    this._stackLightMaterial.uniforms.tAccum.value = accumTex;
    this._stackLightMaterial.uniforms.tLayer.value = this._lightRT.texture;

    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(out);
    renderer.render(this._stackLightScene, this._stackLightCamera);
    renderer.setRenderTarget(prevTarget);

    this._stackedLightResult = out;
    this._stackedLightLayerCount += 1;
    this._endPerfSpan(_perfToken);
  }

  /**
   * Stacked gameplay-light buffer for post-merge CC (falls back to last floor when inactive).
   * @returns {THREE.Texture|null}
   */
  getStackedDynamicLightTexture() {
    if (this._stackedLightActive && this._stackedLightLayerCount > 0 && this._stackedLightResult?.texture) {
      return this._stackedLightResult.texture;
    }
    return this.dynamicLightTexture;
  }

  /**
   * Texture + alpha baseline for post-merge CC local ToD override.
   * Raw `_lightRT` and stacked buffers clear alpha=0; CC subtracts {@link #getLocalLightBufferBinding}.alphaBaseline.
   * @returns {{ texture: THREE.Texture|null, alphaBaseline: number }}
   */
  getLocalLightBufferBinding() {
    const stackedActive = this._stackedLightActive && this._stackedLightLayerCount > 0;
    if (stackedActive && this._stackedLightResult?.texture) {
      return { texture: this._stackedLightResult.texture, alphaBaseline: 0.0 };
    }
    const tex = this.dynamicLightTexture;
    return { texture: tex ?? null, alphaBaseline: 0.0 };
  }

  /** Reset stacked light accumulation for the next frame. */
  endStackedLightBuffer() {
    this._stackedLightActive = false;
    this._stackedLightLayerCount = 0;
  }

  /**
   * Latest window-glow accumulation texture, used by downstream post passes
   * that need to identify directly illuminated pixels.
   * @returns {THREE.Texture|null}
   */
  get windowLightTexture() {
    try {
      const wle = this._resolveWindowLightEffect();
      if (!wle?.isEmitValidForCompose?.()) return null;
      return wle.getEmitTexture?.() ?? null;
    } catch (_) {}
    return null;
  }

  /**
   * Alias for {@link #windowLightTexture} (legacy shadow-prepass naming).
   * @returns {THREE.Texture|null}
   */
  get windowLightOverrideTexture() {
    return this.windowLightTexture;
  }

  setSkyOcclusionTexture(texture) {
    const u = this._composeMaterial?.uniforms;
    if (!u?.tSkyOcclusion || !u?.uHasSkyOcclusion) return;
    u.tSkyOcclusion.value = texture ?? null;
    u.uHasSkyOcclusion.value = texture ? 1.0 : 0.0;
    this._shadowContextForLights = texture ? { skyOcclusion01: 1.0 } : null;
  }

  // ── UI schema (moved from V1 LightingEffect) ─────────────────────────────

  static getControlSchema() {
    return {
      enabled: true,
      help: {
        title: 'Light Physics',
        summary: [
          'This panel controls linear HDR light transport: Foundry point lights, ambient day/night fill, and shadow occlusion.',
          'It does not own exposure, brightness, or tone mapping. Use Camera Grade for the HDR to LDR look.',
          'Shadows dim ambient/sky light. Point lights are preserved so torches and lamps create readable pools at night.'
        ].join('\n\n'),
        glossary: {
          'Day ambient': 'Foundry ambientBrightest at low darkness; outdoor vs indoor scales use the _Outdoors mask.',
          'Night ambient': 'Foundry ambientDarkness at high darkness; outdoor/indoor split for porches vs rooms.',
          'Point light gain':
            'Multiplies AmbientLight/torch emission in ThreeLightSource before max-blend into `_lightRT`. Tune falloff shape under Point light falloff (half-life). Overlaps take the brighter sample, not the sum. Window glow unaffected.',
          'Minimum light floor': 'Safety floor that prevents pure-black collapse without replacing actual lights.'
        },
      },
      groups: [
        {
          name: 'ambientFloor',
          label: 'Ambient light (linear HDR)',
          type: 'folder',
          expanded: true,
          parameters: [
            'ambientDayScaleOutdoor',
            'ambientDayScaleIndoor',
            'ambientNightScaleOutdoor',
            'ambientNightScaleIndoor',
            'minIlluminationScale',
          ],
        },
        {
          name: 'dynamicLuma',
          label: 'Point lights',
          type: 'folder',
          expanded: true,
          parameters: ['lightIntensity'],
        },
        {
          name: 'windowCompose',
          label: 'Window glow (compose)',
          type: 'folder',
          expanded: false,
          parameters: [
            'windowEmissiveGain',
            'windowIndirectContrast',
            'windowWarmthTint',
            'windowAlbedoCoupling',
            'windowScreenSpill',
          ],
        },
        {
          name: 'pointFalloff',
          label: 'Point light falloff (half-life)',
          type: 'folder',
          expanded: true,
          parameters: [
            'falloffHalfInAtAtt0',
            'falloffHalfInAtAtt1',
            'falloffHalfOutAtAtt0',
            'falloffHalfOutAtAtt1',
            'falloffHalfMin',
            'falloffEdgeSoftBoostIn',
            'falloffEdgeSoftBoostOut',
            'falloffBrightNormInfluence',
            'falloffDimRingWeight',
            'falloffRimAAScale',
            'falloffAttCurvePower',
            'falloffRimBandAtAtt0',
            'falloffRimBandAtAtt1',
            'falloffExponent',
          ],
        },
        {
          name: 'colorationIntensity',
          label: 'Lamp colour (HDR radiance buffer)',
          type: 'folder',
          advanced: true,
          expanded: true,
          parameters: [
            'colorationMixScale',
            'colorationMaxMix',
            'colorationMixPower',
            'colorationStrength',
            'colorationReflectivity',
            'colorationSaturationBoost',
            'colorationFalloffStart',
            'colorationFalloffEnd',
            'colorationFalloffPower',
            'colorationEnergyGain',
          ],
        },
        {
          name: 'ambientShadowMix',
          label: 'Ambient occlusion from shadows',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: [
            'combinedShadowEffectStrength',
            'cloudShadowAmbientInfluence',
            'overheadShadowAmbientInfluence',
            'dynamicLightShadowOverrideStrength',
            'structuralSunAmbientOcclusion',
            'directStructuralOcclusionStrength',
          ],
        },
        {
          name: 'occlusion',
          label: 'Roof / floor occlusion',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: [
            'wallInsetPx',
            'wallPaddingPx',
            'restrictRoofScreenLightOcclusionToTopFloor',
            'upperFloorTransmissionEnabled',
            'upperFloorTransmissionStrength',
          ],
        },
        {
          name: 'darkness',
          label: 'Advanced darkness response',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: ['interiorDarkness', 'negativeDarknessStrength', 'darknessPunchGain'],
        },
        {
          name: 'lightAnim',
          label: 'Advanced light animation',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: ['lightAnimWindInfluence', 'lightAnimOutdoorPower'],
        },
        {
          name: 'perfTuning',
          label: 'Performance (internal RT scale)',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: [
            'internalLightResolutionScale',
            'internalWindowResolutionScale',
            'internalDarknessResolutionScale',
            'windowLightUseHalfFloat',
          ],
        },
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        globalIllumination: {
          type: 'slider',
          min: 0,
          max: 2,
          step: 0.1,
          default: 0,
          label: 'Illumination scale (legacy)',
          hidden: true,
          tooltip: 'Deprecated: use Day ambient and Night ambient. Kept so old module data still loads.',
        },
        ambientDayScale: {
          type: 'slider',
          min: 0,
          max: 3.5,
          step: 0.05,
          default: 1,
          label: 'Day ambient (legacy)',
          hidden: true,
          tooltip: 'Deprecated: use Outdoor/Indoor day ambient. Loaded for old saves.',
        },
        ambientDayScaleOutdoor: {
          type: 'slider',
          min: 0,
          max: 3.5,
          step: 0.05,
          default: 0.92,
          label: 'Day ambient — outdoor',
          tooltip: 'Scales Foundry ambient brightest on outdoor-classified pixels (porches, courtyards, sky reach).',
        },
        ambientDayScaleIndoor: {
          type: 'slider',
          min: 0,
          max: 3.5,
          step: 0.05,
          default: 0.62,
          label: 'Day ambient — indoor',
          tooltip: 'Scales Foundry ambient brightest on indoor-classified pixels (rooms under roof capture).',
        },
        ambientNightScale: {
          type: 'slider',
          min: 0,
          max: 2,
          step: 0.05,
          default: 0.32,
          label: 'Night ambient (legacy)',
          hidden: true,
          tooltip: 'Deprecated: use Outdoor/Indoor night ambient.',
        },
        ambientNightScaleOutdoor: {
          type: 'slider',
          min: 0,
          max: 2,
          step: 0.05,
          default: 0.32,
          label: 'Night ambient — outdoor',
          tooltip: 'Scales Foundry ambientDarkness on outdoor pixels at high darkness.',
        },
        ambientNightScaleIndoor: {
          type: 'slider',
          min: 0,
          max: 2,
          step: 0.05,
          default: 0.27,
          label: 'Night ambient — indoor',
          tooltip: 'Scales Foundry ambientDarkness on indoor pixels; usually slightly lower than outdoor.',
        },
        minIlluminationScale: {
          type: 'slider',
          min: 0,
          max: 3,
          step: 0.05,
          default: 0.12,
          label: 'Minimum light floor',
          tooltip: 'Scales the darkest-scene safety floor so interiors never clip to pure black.',
        },
        lightIntensity: {
          type: 'slider',
          min: 0,
          max: 2,
          step: 0.05,
          default: 0.75,
          label: 'Point light gain',
          tooltip:
            'Emission multiplier on Foundry lamp meshes (`uComposeLightGain`) before `_lightRT` accumulation; compose reads the RT as-is so buffer overlap or noise does not get a second brightness pass. Torch/flash meshes follow the same value. Separate from Window glow / Day-night ambient.',
        },
        falloffHalfInAtAtt0: {
          type: 'slider',
          min: 0.01,
          max: 2.0,
          step: 0.005,
          default: 0.52,
          label: 'Halving dist. (att 0, bright)',
          tooltip:
            'Maps to Foundry smoothstep hardness in the bright ring (larger = softer, wider bright fill). Attenuation 0.5 uses the geometric mean vs the att=1 value.',
        },
        falloffHalfInAtAtt1: {
          type: 'slider',
          min: 0.005,
          max: 1.0,
          step: 0.005,
          default: 0.22,
          label: 'Halving dist. (att 1, bright)',
          tooltip:
            'Tweak scale for bright-ring softness. Attenuation now drives Foundry hardness (att 1 ≈ linear smoothstep); lower slider = tighter core.',
        },
        falloffHalfOutAtAtt0: {
          type: 'slider',
          min: 0.01,
          max: 2.0,
          step: 0.005,
          default: 0.38,
          label: 'Halving dist. (att 0, dim)',
          tooltip: 'Dim-ring hardness when attenuation is 0 (outer falloff to the photometric edge).',
        },
        falloffHalfOutAtAtt1: {
          type: 'slider',
          min: 0.005,
          max: 1.0,
          step: 0.005,
          default: 0.22,
          label: 'Halving dist. (att 1, dim)',
          tooltip: 'Dim-ring hardness at Attenuation 1 — should stay high enough to reach the dim radius before the edge fade.',
        },
        falloffHalfMin: {
          type: 'slider',
          min: 0.001,
          max: 0.5,
          step: 0.001,
          default: 0.02,
          label: 'Min halving step',
          tooltip: 'Floor when lerping halving distances (prevents extreme hardness).',
        },
        falloffEdgeSoftBoostIn: {
          type: 'slider',
          min: 0,
          max: 1.5,
          step: 0.01,
          default: 0.10,
          label: 'Edge soft → bright ring',
          tooltip: 'How much per-light edge softness widens the bright-ring halving distance.',
        },
        falloffEdgeSoftBoostOut: {
          type: 'slider',
          min: 0,
          max: 1.5,
          step: 0.01,
          default: 0.08,
          label: 'Edge soft → dim ring',
          tooltip: 'How much edge softness widens the dim-ring halving distance.',
        },
        falloffBrightNormInfluence: {
          type: 'slider',
          min: 0,
          max: 2.0,
          step: 0.01,
          default: 0.92,
          label: 'Bright radius scale',
          tooltip:
            'Scales halving in the bright disk vs Foundry bright/dim radius ratio (larger bright radius → wider core).',
        },
        falloffDimRingWeight: {
          type: 'slider',
          min: 0.05,
          max: 2.5,
          step: 0.01,
          default: 1.0,
          label: 'Dim ring weight',
          tooltip: 'Weight of the outer (dim) ring vs bright (Foundry sums both zones). 1.0 matches core Foundry balance.',
        },
        falloffRimAAScale: {
          type: 'slider',
          min: 0.02,
          max: 2.0,
          step: 0.01,
          default: 0.38,
          label: 'Rim AA width',
          tooltip: 'Width of the anti-alias fade at the photometric outer edge (fraction of fade band).',
        },
        falloffAttCurvePower: {
          type: 'slider',
          min: 1.0,
          max: 4.0,
          step: 0.05,
          default: 1.0,
          label: 'Attenuation curve',
          tooltip:
            'At 1.0, Foundry Attenuation 0 / 0.5 / 1 map evenly between the att=0 and att=1 halving distances (0.5 sits in the middle). Above 1.0 bends toward Attenuation 1 — at 2.5, Attenuation 0.5 looks almost like 0. Keep at 1.0 while tuning the halving-distance sliders.',
        },
        falloffRimBandAtAtt0: {
          type: 'slider',
          min: 0.01,
          max: 1.0,
          step: 0.01,
          default: 0.16,
          label: 'Rim band (att 0)',
          tooltip: 'Outer-edge AA band width at attenuation 0.',
        },
        falloffRimBandAtAtt1: {
          type: 'slider',
          min: 0.005,
          max: 0.5,
          step: 0.005,
          default: 0.08,
          label: 'Rim band (att 1)',
          tooltip: 'Outer-edge AA band width at attenuation 1.',
        },
        falloffExponent: {
          type: 'slider',
          min: 0.5,
          max: 8.0,
          step: 0.05,
          default: DEFAULT_POINT_LIGHT_FALLOFF_EXPONENT,
          label: 'Falloff exponent bias',
          tooltip: 'Slight modifier on legacy exponent uniform (2 ≈ neutral). Affects rim band + halving bias.',
        },
        colorationStrength: {
          type: 'slider',
          min: 1,
          max: 12,
          step: 0.1,
          default: 3.2,
          label: 'Saturation boost gain',
          tooltip: 'Extra albedo saturation push at high CI only (does not map CI 0.5 vs 1.0 — that is linear from the lamp). Leave at default unless you want punchier colour.',
        },
        colorationReflectivity: {
          type: 'slider',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.0,
          label: 'Coloration reflectivity',
          tooltip: '0 = vivid lamp hue on stone; 1 = tint follows albedo luma (weaker on dark cobble). Use 0 for torches.',
        },
        colorationMixScale: {
          type: 'slider',
          min: 0,
          max: 4,
          step: 0.05,
          default: 1.0,
          label: 'CI buffer scale',
          tooltip: 'Scales Foundry Color Intensity in the buffer (1.0 = full CI from the lamp; 0.4 = 40% max saturation).',
        },
        colorationMixPower: {
          type: 'slider',
          min: 0.1,
          max: 6,
          step: 0.05,
          default: 3.65,
          label: 'CI curve power',
          tooltip: 'Exponent on Foundry CI before compose (1 = linear; >1 widens gap between 0.5 and 1.0; <1 compresses mid CI).',
        },
        colorationMaxMix: {
          type: 'slider',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.69,
          label: 'Max CI mix',
          tooltip: 'Caps how much Foundry Color Intensity can push the buffer toward lamp hue [0..1].',
        },
        colorationEnergyGain: {
          type: 'slider',
          min: 0,
          max: 16,
          step: 0.1,
          default: 1.0,
          label: 'Colour energy gain',
          tooltip: 'Scales lamp energy before the colour penumbra smoothstep (extends colour toward the rim when >1).',
        },
        colorationFalloffStart: {
          type: 'slider',
          min: 0,
          max: 2,
          step: 0.005,
          default: 0.0,
          label: 'Colour falloff start',
          tooltip: 'Lamp-energy level where colour tint begins (smoothstep low edge).',
        },
        colorationFalloffEnd: {
          type: 'slider',
          min: 0.001,
          max: 4,
          step: 0.01,
          default: 0.35,
          label: 'Colour falloff end',
          tooltip: 'Lamp-energy level where CI reaches full strength. Raise (e.g. 0.5–0.8) for softer colour penumbra; must stay below typical lamp core energy or colour stays weak in the centre.',
        },
        colorationFalloffPower: {
          type: 'slider',
          min: 0.1,
          max: 12,
          step: 0.05,
          default: 1.0,
          label: 'Colour falloff curve',
          tooltip: 'Exponent on the colour penumbra mask (>1 = softer).',
        },
        colorationSaturation: {
          type: 'slider',
          min: -2,
          max: 4,
          step: 0.05,
          default: 0.0,
          label: 'Lamp saturation',
          tooltip: 'Pushes lamp chroma before tint (0 = buffer hue).',
        },
        colorationSaturationBoost: {
          type: 'slider',
          min: -2,
          max: 6,
          step: 0.05,
          default: 1.4,
          label: 'Saturation boost',
          tooltip: 'Pushes chroma after the lamp tint (0.5–1.5 typical). Does not change lamp brightness.',
        },
        colorationDarken: {
          type: 'slider',
          min: 0,
          max: 3,
          step: 0.05,
          default: 0.0,
          label: 'Darken tinted',
          tooltip: 'Scales down lit result where tint is active (deeper reds).',
        },
        colorationBrighten: {
          type: 'slider',
          min: -2,
          max: 4,
          step: 0.05,
          default: 0.0,
          label: 'Brighten tinted',
          tooltip: 'Adds peak multiplier where tint is active (can wash colour).',
        },
        colorationPeakPreserve: {
          type: 'slider',
          min: 0,
          max: 1,
          step: 0.01,
          default: 1.0,
          label: 'Peak preserve',
          tooltip: '1 = match white-light max channel after tint; 0 = allow peak to change.',
        },
        colorationHueShift: {
          type: 'slider',
          min: -1,
          max: 1,
          step: 0.01,
          default: 0.0,
          label: 'Hue shift',
          tooltip: 'Rotates lamp hue before tint (-1..1 = full wheel).',
        },
        colorationChromaCurve: {
          type: 'slider',
          min: 0.1,
          max: 8,
          step: 0.05,
          default: 1.0,
          label: 'Chroma curve',
          tooltip: 'Exponent on buffer color mix (higher = needs more CI before full tint).',
        },
        colorationAchromaticMix: {
          type: 'slider',
          min: 0,
          max: 1,
          step: 0.05,
          default: 0.0,
          label: 'Neutral bleed',
          tooltip: 'Blends color mix toward 1 (tint even when buffer chroma is low).',
        },
        composeToneMapping: {
          type: 'list',
          label: 'Tone mapping (deprecated)',
          options: { None: 0 },
          default: 0,
          hidden: true,
          tooltip: 'Deprecated: lighting pass always outputs linear HDR. Tone mapping is owned by Color Correction.',
        },
        composeToneExposure: {
          type: 'slider',
          min: 1,
          max: 1,
          step: 0.05,
          default: 1.0,
          label: 'Tone-map exposure (deprecated)',
          hidden: true,
          tooltip: 'Deprecated: forced to 1.0. Use Color Correction exposure instead.',
        },
        combinedShadowEffectStrength: {
          type: 'slider',
          min: 1,
          max: 4,
          step: 0.05,
          default: 2,
          label: 'Combined shadow strength',
          tooltip:
            'Amplifies unified shadow darkness on ambient only (1 = authored, 4 = very deep). Strong lights can still clear shadow override on structural paths.',
        },
        cloudShadowAmbientInfluence: {
          type: 'slider',
          min: 0,
          max: 1,
          step: 0.05,
          default: 0.45,
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
        dynamicLightShadowOverrideStrength: {
          type: 'slider',
          min: 0,
          max: 1,
          step: 0.05,
          default: 0,
          label: 'Dynamic light shadow override',
          tooltip:
            'Clears ambient shadow near bright gameplay lights (torch/flashlight). Uses stricter sensing than older builds so faint HDRI-style fill does not erase building/painted shadows; strong lights still lift.',
        },
        structuralSunAmbientOcclusion: {
          type: 'slider',
          min: 0,
          max: 1,
          step: 0.05,
          default: 1.0,
          label: 'Structural shadow vs sky/day fill',
          tooltip:
            'For outdoor pixels under daylight: building + painted shadows stay darker than unified ambient lifts alone (minimum of unified shadow and structural occlusion). Dynamic shadow override still clears structural shadows near torches/player lights. Set to 0 for legacy behaviour.',
        },
        directStructuralOcclusionStrength: {
          type: 'slider',
          min: 0,
          max: 1,
          step: 0.05,
          default: 0.5,
          label: 'Structural occlusion on HDR lights',
          tooltip:
            'Darkens the Foundry HDR light accumulation (ambient disks/torches/colour spill) wherever building+painted shadows are dark. Strong gameplay lights clear this via Structural shadow override. Set to 0 to restore fills that bypass structural shadows entirely.',
        },
        wallInsetPx: { type: 'slider', min: 0, max: 40, step: 0.5, default: 6.0, label: 'Wall Inset (px)' },
        wallPaddingPx: {
          type: 'slider',
          min: 0,
          max: 12,
          step: 0.5,
          default: 2.0,
          label: 'Wall Padding (px)',
          tooltip: 'Expands blocking wall segments during light LOS raycasts. Reduces glow bleeding through thin or diagonal walls. Also applies to candle/fire glow pools.',
        },
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
        negativeDarknessStrength: { type: 'slider', min: 0, max: 3, step: 0.1, default: 2.0, label: 'Negative Darkness Strength' },
        darknessPunchGain: { type: 'slider', min: 0, max: 10, step: 0.1, default: 0, label: 'Darkness Punch Gain' },
        internalLightResolutionScale: {
          type: 'slider',
          min: 0.25,
          max: 1,
          step: 0.05,
          default: 1,
          label: 'Foundry lights RT scale',
          tooltip: 'Internal resolution for `_lightRT` and stacked light buffers. Lower values reduce fill rate; point lights may soften slightly.',
        },
        internalWindowResolutionScale: {
          type: 'slider',
          min: 0.25,
          max: 1,
          step: 0.05,
          default: 1,
          label: 'Window emit RT scale',
          tooltip: 'Scales the scene-UV emit RT relative to compositor mask resolution (1.0 = native mask size). Do not cap to drawing-buffer size — that smears glow in compose.',
        },
        internalDarknessResolutionScale: {
          type: 'slider',
          min: 0.25,
          max: 1,
          step: 0.05,
          default: 1,
          label: 'Darkness RT scale',
          tooltip: 'Internal resolution for the darkness accumulation RT.',
        },
        windowLightUseHalfFloat: {
          type: 'boolean',
          default: true,
          label: 'Window emit half-float',
          tooltip: 'When false, emit RT uses 8-bit (less VRAM/bandwidth; may band on bright windows).',
        },
        windowEmissiveGain: {
          type: 'slider',
          min: 0,
          max: 4,
          step: 0.05,
          default: 1,
          label: 'Window indirect gain',
          tooltip: 'Scales HDR window spill in compose (emit strength is on Window Light → Intensity).',
        },
        windowIndirectContrast: {
          type: 'slider',
          min: 0.35,
          max: 1.2,
          step: 0.02,
          default: 0.55,
          label: 'Window contrast',
          tooltip: 'Lower = hotter window cores and softer penumbra (less flat grey at high intensity).',
        },
        windowWarmthTint: {
          type: 'slider',
          min: 0,
          max: 1,
          step: 0.02,
          default: 0.62,
          label: 'Window warmth tint',
          tooltip: 'How much emit colour tints nearby walls in compose (0 = neutral white spill).',
        },
        windowAlbedoCoupling: {
          type: 'slider',
          min: 0,
          max: 1.5,
          step: 0.02,
          default: 0.78,
          label: 'Wall texture coupling',
          tooltip: 'Scales indirect spill by wall albedo luma so masonry keeps texture while floors brighten.',
        },
        windowScreenSpill: {
          type: 'slider',
          min: 0,
          max: 2,
          step: 0.05,
          default: 0.55,
          label: 'Window core glow',
          tooltip: 'Small additive warm highlight on lit pixels at window cores (HDR-linear; not a full-frame multiply).',
        },
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

    // ── Light accumulation RT (HDR, max blending) ─────────────────────
    const rtOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    // OPTIMIZATION: Mutates pre-allocated objects instead of creating new ones
    this._calcScaledSize(w, h, this.params.internalLightResolutionScale, this._lightSize);
    this._calcScaledSize(w, h, this.params.internalWindowResolutionScale, this._windowSize);
    this._calcScaledSize(w, h, this.params.internalDarknessResolutionScale, this._darknessSize);
    this._lightRT = new THREE.WebGLRenderTarget(this._lightSize.w, this._lightSize.h, rtOpts);
    // Linear storage: light accumulation is max-blended in linear space.
    this._lightRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
    const windowRtOpts = {
      ...rtOpts,
      type: this.params.windowLightUseHalfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
    };
    this._windowLightRT = new THREE.WebGLRenderTarget(this._windowSize.w, this._windowSize.h, windowRtOpts);
    this._windowLightRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this._darknessRT = new THREE.WebGLRenderTarget(this._darknessSize.w, this._darknessSize.h, {
      ...rtOpts,
      type: THREE.UnsignedByteType,
    });
    // Linear storage: darkness mask is a scalar, not a colour.
    this._darknessRT.texture.colorSpace = THREE.LinearSRGBColorSpace;

    const ctW = Math.max(1, Math.floor(w / 2));
    const ctH = Math.max(1, Math.floor(h / 2));
    this.ceilingTransmittanceTarget = new THREE.WebGLRenderTarget(ctW, ctH, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
    });

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
        uHasLightWindow: { value: 0.0 },
        uWindowLightScreenSpace: { value: 1.0 },
        tDarkness: { value: null },
        // Cloud shadow: factor texture from CloudEffectV2 (1.0=lit, 0.0=shadowed).
        // Multiplies totalIllumination so ambient dims under clouds while dynamic
        // lights (which add on top) still punch through the shadow.
        // Unified shadow factor from ShadowManagerV2: the single occlusion
        // input to the lighting compose pass.
        // Building shadow lit texture (scene UV): recomposed for structural-vs-day-ambient split.
        tBuildingShadowLit: { value: null },
        uHasBuildingShadowLit: { value: 0 },
        tUnifiedShadowFactor: { value: null },
        tUnifiedShadowRaw: { value: null },
        uHasShadowRaw: { value: 0 },
        uHasCombinedShadow: { value: 0 },
        tVegetationBillboardShadow: { value: null },
        uHasVegetationBillboardShadow: { value: 0 },
        uVegetationBillboardOpacity: { value: 1.0 },
        // compose so dynamic-light lift / cloud ambient influence do not erase artistic shadow.
        tPaintedShadowLit: { value: null },
        uHasPaintedShadowLit: { value: 0 },
        tPaintedShadowAtAndAboveLit: { value: null },
        uHasPaintedShadowAtAndAboveLit: { value: 0 },
        uPaintedShadowMgrOpacity: { value: 1.0 },
        uLightingPaintedFloorIndex: { value: 0 },
        uPaintedShadowInCombined: { value: 1.0 },
        tOverheadRoofAlpha: { value: null },
        uHasOverheadRoofAlpha: { value: 0 },
        tOverheadRoofBlock: { value: null },
        uHasOverheadRoofBlock: { value: 0 },
        tOverheadRoofRestrictLight: { value: null },
        uHasOverheadRoofRestrictLight: { value: 0 },
        // Foundry canvas dimensions (includes padding). Matches CloudEffectV2.
        // Used to convert Three world Y-up into Foundry world Y-down.
        uSceneDimensions: { value: new THREE.Vector2(1, 1) },
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
        /** 0 at night, 1 at solar noon — gates Day ambient (noon) scale independently of Foundry darkness. */
        uCalendarDayWeight:  { value: 0.0 },
        uAmbientBrightest:   { value: new THREE.Color(1, 1, 1) },
        uAmbientDarkness:    { value: new THREE.Color(0.141, 0.141, 0.282) },
        uAmbientDayScale:    { value: 1.3 },
        uAmbientDayScaleOutdoor: { value: 0.92 },
        uAmbientDayScaleIndoor: { value: 0.62 },
        uAmbientNightScale:  { value: 0.85 },
        uAmbientNightScaleOutdoor: { value: 0.32 },
        uAmbientNightScaleIndoor: { value: 0.27 },
        uMinIlluminationScale: { value: 1.0 },
        uChromaticRadianceGain: { value: 4.0 },
        uColorationReflectivity: { value: 0.0 },
        uColorationSaturationBoost: { value: 0.0 },
        uColorationFalloffStart: { value: 0.0 },
        uColorationFalloffEnd: { value: 0.35 },
        uColorationFalloffPower: { value: 1.0 },
        uColorationEnergyGain: { value: 1.0 },
        uColorationMixPower: { value: 1.0 },
        uComposeToneExposure: { value: 1.0 },
        uCombinedShadowEffectStrength: { value: 1.0 },
        uCloudShadowAmbientInfluence: { value: 1.0 },
        uOverheadShadowAmbientInfluence: { value: 1.0 },
        uDynamicLightShadowOverrideStrength: { value: 0.65 },
        uStructuralSunAmbientOcclusion: { value: 1.0 },
        uDirectStructuralOcclusionStrength: { value: 1.0 },
        uNegativeDarknessStrength: { value: 1.0 },
        uDarknessPunchGain:        { value: 2.0 },
        uInteriorDarkness:         { value: 0.0 },
        tSkyOcclusion: { value: null },
        uHasSkyOcclusion: { value: 0.0 },
        // Screen-space roof mask: apply to Foundry lights only on ground floor;
        // apply to window-glow channel only on upper floors (window shader disables
        // uAllowRoofGate there — compose must still suppress leaks onto water/lower views).
        uApplyRoofOcclusionToSources: { value: 1.0 },
        uApplyRoofOcclusionToWindow:  { value: 0.0 },
        uWindowEmissiveGain: { value: 1.0 },
        uWindowIndirectContrast: { value: 0.65 },
        uWindowWarmthTint: { value: 0.62 },
        uWindowAlbedoCoupling: { value: 0.78 },
        uWindowScreenSpill: { value: 0.55 },
        // _Outdoors mask (scene UV): gate roof/tree *light* occlusion so interior
        // pixels under overhead stamps still receive Foundry lights (see fragment).
        tOutdoorsForRoofLight: { value: null },
        uHasOutdoorsForRoofLight: { value: 0 },
        uOutdoorsForRoofLightFlipY: { value: 0 },
        uOutdoorsForRoofLightTexelSize: { value: new THREE.Vector2(0, 0) },
        // Half-res T: roof visibility × blocker (built in {@link #renderCeilingTransmittancePass}).
        tCeilingLightTransmittance: { value: null },
        uHasCeilingLightTransmittance: { value: 0 },
        uLandscapeLightningFlash01: { value: 0.0 },
        uLandscapeLightningOutdoorGain: { value: 0.65 },
        uLandscapeLightningShadowFloor: { value: 0.06 },
        uLandscapeLightningShadowGamma: { value: 0.55 },
        uLandscapeLightningFlashContrast: { value: 1.15 },
        uLandscapeLightningFlashColor: { value: new THREE.Vector3(0.68, 0.82, 1.0) },
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

        ${GLSL_DECODE_OUTDOORS_MASK}
        ${MSA_LIGHT_RADIANCE_GLSL}

        uniform sampler2D tScene;
        uniform sampler2D tLightSources;
        uniform sampler2D tLightWindow;
        uniform float uHasLightWindow;
        uniform float uWindowLightScreenSpace;
        uniform sampler2D tDarkness;
        uniform sampler2D tUnifiedShadowFactor;
        uniform sampler2D tUnifiedShadowRaw;
        uniform float uHasShadowRaw;
        uniform float uHasCombinedShadow;
        uniform sampler2D tVegetationBillboardShadow;
        uniform float uHasVegetationBillboardShadow;
        uniform float uVegetationBillboardOpacity;
        uniform sampler2D tBuildingShadowLit;
        uniform float uHasBuildingShadowLit;
        uniform sampler2D tPaintedShadowLit;
        uniform float uHasPaintedShadowLit;
        uniform sampler2D tPaintedShadowAtAndAboveLit;
        uniform float uHasPaintedShadowAtAndAboveLit;
        uniform float uPaintedShadowMgrOpacity;
        uniform float uLightingPaintedFloorIndex;
        uniform float uPaintedShadowInCombined;
        uniform sampler2D tOverheadRoofAlpha;
        uniform float uHasOverheadRoofAlpha;
        uniform sampler2D tOverheadRoofBlock;
        uniform float uHasOverheadRoofBlock;
        uniform sampler2D tOverheadRoofRestrictLight;
        uniform float uHasOverheadRoofRestrictLight;
        uniform vec2  uSceneDimensions;
        uniform vec2 uBldViewBoundsMin;
        uniform vec2 uBldViewBoundsMax;
        uniform vec2 uBldViewCorner00;
        uniform vec2 uBldViewCorner10;
        uniform vec2 uBldViewCorner01;
        uniform vec2 uBldViewCorner11;
        uniform vec2 uBldSceneOrigin;
        uniform vec2 uBldSceneSize;
        uniform float uDarknessLevel;
        uniform float uCalendarDayWeight;
        uniform vec3 uAmbientBrightest;
        uniform vec3 uAmbientDarkness;
        uniform float uAmbientDayScale;
        uniform float uAmbientDayScaleOutdoor;
        uniform float uAmbientDayScaleIndoor;
        uniform float uAmbientNightScale;
        uniform float uAmbientNightScaleOutdoor;
        uniform float uAmbientNightScaleIndoor;
        uniform float uMinIlluminationScale;
        uniform float uChromaticRadianceGain;
        uniform float uColorationReflectivity;
        uniform float uColorationSaturationBoost;
        uniform float uColorationFalloffStart;
        uniform float uColorationFalloffEnd;
        uniform float uColorationFalloffPower;
        uniform float uColorationEnergyGain;
        uniform float uColorationMixPower;
        uniform float uComposeToneExposure;
        uniform float uCombinedShadowEffectStrength;
        uniform float uCloudShadowAmbientInfluence;
        uniform float uOverheadShadowAmbientInfluence;
        uniform float uDynamicLightShadowOverrideStrength;
        uniform float uStructuralSunAmbientOcclusion;
        uniform float uDirectStructuralOcclusionStrength;
        uniform float uNegativeDarknessStrength;
        uniform float uDarknessPunchGain;
        uniform float uInteriorDarkness;
        uniform sampler2D tSkyOcclusion;
        uniform float uHasSkyOcclusion;
        uniform float uApplyRoofOcclusionToSources;
        uniform float uApplyRoofOcclusionToWindow;
        uniform float uWindowEmissiveGain;
        uniform float uWindowIndirectContrast;
        uniform float uWindowWarmthTint;
        uniform float uWindowAlbedoCoupling;
        uniform float uWindowScreenSpill;
        uniform sampler2D tOutdoorsForRoofLight;
        uniform float uHasOutdoorsForRoofLight;
        uniform float uOutdoorsForRoofLightFlipY;
        uniform vec2 uOutdoorsForRoofLightTexelSize;
        uniform sampler2D tCeilingLightTransmittance;
        uniform float uHasCeilingLightTransmittance;
        uniform float uLandscapeLightningFlash01;
        uniform float uLandscapeLightningOutdoorGain;
        uniform float uLandscapeLightningShadowFloor;
        uniform float uLandscapeLightningShadowGamma;
        uniform float uLandscapeLightningFlashContrast;
        uniform vec3 uLandscapeLightningFlashColor;
        varying vec2 vUv;

        float landscapeLightningShadowFlashGate(vec2 screenUv) {
          if (uHasCombinedShadow < 0.5) return 1.0;
          float sf = clamp(texture2D(tUnifiedShadowFactor, screenUv).r, 0.0, 1.0);
          float g = max(0.08, uLandscapeLightningShadowGamma);
          float floorV = clamp(uLandscapeLightningShadowFloor, 0.0, 1.0);
          return mix(floorV, 1.0, pow(sf, g));
        }

        vec3 landscapeLightningFlashColorVec() {
          return max(uLandscapeLightningFlashColor, vec3(0.001));
        }

        float landscapeLightningFlashWeight(vec2 screenUv) {
          if (uLandscapeLightningFlash01 <= 0.0) return 0.0;
          float llFlash = clamp(uLandscapeLightningFlash01, 0.0, 1.0);
          float llGain = clamp(uLandscapeLightningOutdoorGain, 0.0, 16.0);
          return llFlash * llGain * landscapeLightningShadowFlashGate(screenUv);
        }

        float perceivedBrightness(vec3 c) {
          return dot(c, vec3(0.2126, 0.7152, 0.0722));
        }

        /** Combined shadow R: 1 = lit. Strength >= 1 scales up subtle darkening (penumbra). */
        float amplifyCombinedShadowLit(float lit01, float strength) {
          float s = max(strength, 1.0);
          float dark = 1.0 - clamp(lit01, 0.0, 1.0);
          return 1.0 - min(1.0, dark * s);
        }

        void main() {
          vec4 baseColor = texture2D(tScene, vUv);
          vec4 srcSample = texture2D(tLightSources, vUv);
          vec3 srcLights = max(srcSample.rgb, vec3(0.0));

          // Scene UV (Foundry space) for masks authored in scene rect — shared by
          // building shadow, window glow (scene-UV RT), and _Outdoors–gated roof light.
          vec2 w0s = mix(uBldViewCorner00, uBldViewCorner10, vUv.x);
          vec2 w1s = mix(uBldViewCorner01, uBldViewCorner11, vUv.x);
          vec2 worldXYs = mix(w0s, w1s, vUv.y);
          float foundryXs = worldXYs.x;
          float foundryYs = uSceneDimensions.y - worldXYs.y;
          vec2 sceneUvRaw = (vec2(foundryXs, foundryYs) - uBldSceneOrigin) / max(uBldSceneSize, vec2(1e-5));
          vec2 sceneUvFoundry = clamp(sceneUvRaw, 0.0, 1.0);
          vec2 inBounds2 = step(vec2(0.0), sceneUvRaw) * step(sceneUvRaw, vec2(1.0));
          float inSceneBounds = inBounds2.x * inBounds2.y;

          vec4 outdoorsRoofSample = vec4(0.0);
          float isOutdoorForInteriorDim = 1.0;
          if (uHasOutdoorsForRoofLight > 0.5) {
            vec2 ouvWin = sceneUvFoundry;
            if (uOutdoorsForRoofLightFlipY > 0.5) ouvWin.y = 1.0 - ouvWin.y;
            outdoorsRoofSample = texture2D(tOutdoorsForRoofLight, ouvWin);
            vec4 odWin = outdoorsRoofSample;
            float outdoorRawWin = clamp(max(odWin.r, max(odWin.g, odWin.b)), 0.0, 1.0);
            float outdoorMidWin = smoothstep(0.18, 0.82, outdoorRawWin);
            float outdoorLoHiWin = (outdoorRawWin <= 0.10) ? 0.0 : ((outdoorRawWin >= 0.90) ? 1.0 : outdoorMidWin);
            float outdoorsAlphaValidWin = step(0.5, clamp(odWin.a, 0.0, 1.0));
            isOutdoorForInteriorDim = mix(1.0, outdoorLoHiWin, outdoorsAlphaValidWin);
          }
          float isOutdoorForInteriorDimSafe = mix(1.0, isOutdoorForInteriorDim, inSceneBounds);

          vec3 winLights = vec3(0.0);
          if (uHasLightWindow > 0.5) {
            // Scene-UV emit atlas matches building/painted shadow passes (vUv = sceneUvFoundry).
            vec2 winEmitUv = sceneUvFoundry;
            vec3 winRaw = max(texture2D(tLightWindow, winEmitUv).rgb, vec3(0.0));
            float winLumaRaw = max(winRaw.r, max(winRaw.g, winRaw.b));
            float winGate = smoothstep(0.008, 0.055, winLumaRaw);
            vec3 winScaled = winRaw * winGate * inSceneBounds;
            float winPeak = max(max(winScaled.r, winScaled.g), winScaled.b);
            winLights = (winPeak > 1.4)
              ? (winScaled / (vec3(1.0) + winScaled * 0.16))
              : winScaled;
            winLights *= (1.0 - isOutdoorForInteriorDimSafe);
          }
          float darknessMask = clamp(texture2D(tDarkness, vUv).r, 0.0, 1.0);
          float ambientShadowMixOut = 1.0;

          float baseDarknessLevel = clamp(uDarknessLevel, 0.0, 1.0);

          // Ambient: interpolate between day and night based on darkness level.
          // Day and night scales are separate so you can run bright noon and deep night together.
          // uCalendarDayWeight (sun above horizon) zeroes day ambient at night even if
          // Foundry darkness lags the Map Shine clock.
          float calendarDayWeight = clamp(uCalendarDayWeight, 0.0, 1.0);
          float indoorAmbientW = 0.0;
          if (uHasOutdoorsForRoofLight > 0.5 && inSceneBounds > 0.5) {
            float indoorSig = clamp(1.0 - isOutdoorForInteriorDim, 0.0, 1.0);
            indoorAmbientW = smoothstep(0.20, 0.75, indoorSig);
          }
          float dayScale = mix(
            max(uAmbientDayScaleOutdoor, 0.0),
            max(uAmbientDayScaleIndoor, 0.0),
            indoorAmbientW
          );
          float nightScale = mix(
            max(uAmbientNightScaleOutdoor, 0.0),
            max(uAmbientNightScaleIndoor, 0.0),
            indoorAmbientW
          );
          vec3 ambientDay   = uAmbientBrightest * dayScale * calendarDayWeight;
          vec3 ambientNight = uAmbientDarkness  * nightScale;
          vec3 ambient = mix(ambientDay, ambientNight, baseDarknessLevel);

          vec4 roofAlphaSample = vec4(0.0);
          float roofAlphaCached = 0.0;
          if (uHasOverheadRoofAlpha > 0.5) {
            roofAlphaSample = texture2D(tOverheadRoofAlpha, vUv);
            roofAlphaCached = clamp(max(roofAlphaSample.a, max(roofAlphaSample.r, max(roofAlphaSample.g, roofAlphaSample.b))), 0.0, 1.0);
          }

          // Interior vs outdoor (_Outdoors mask) — dim ambient on indoor pixels only.
          // (outdoorsRoofSample + isOutdoorForInteriorDim computed above for window gating too.)

          // Window glow: outdoors clip restored on winLights (sky/outdoor pixels).
          // windowOutdoorBlock still used for Foundry light path context only when needed below.

          // Roof / tree canopy: prefer packed ceiling transmittance T (half-res blit from
          // OverheadShadows) so geometric gating matches one source; else derive from
          // roof alpha + block. _Outdoors still applies bounded indoor relief.
          float stampedVis = 1.0;
          float roofAlphaComposite = 0.0;
          float roofBlockComposite = 0.0;
          float roofAlphaLive = roofAlphaCached;
          if (uHasCeilingLightTransmittance > 0.5) {
            stampedVis = clamp(texture2D(tCeilingLightTransmittance, vUv).r, 0.0, 1.0);
            roofAlphaComposite = 1.0 - stampedVis;
          } else {
            if (uHasOverheadRoofAlpha > 0.5) {
              float roofAlpha = roofAlphaCached;
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
            vec4 od = outdoorsRoofSample;
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
          // Roof receiver relief:
          // Keep dynamic light response on visible overhead/roof surfaces themselves.
          // Without this, strong roof-screen occlusion can drive overhead tiles nearly
          // black at night even when direct scene lights should illuminate them.
          // Foundry "Restrict light" overhead: suppress this relief and tighten vis*
          // so local lights do not brighten those roof texels (separate mask RT).
          float restrictLightRoof = 0.0;
          if (uHasOverheadRoofRestrictLight > 0.5) {
            vec4 rlrS = texture2D(tOverheadRoofRestrictLight, vUv);
            restrictLightRoof = clamp(max(rlrS.a, max(rlrS.r, max(rlrS.g, rlrS.b))), 0.0, 1.0);
          }
          float roofReceiver = smoothstep(0.55, 0.85, roofAlphaLive);
          float rawSourceLight = max(srcSample.a, 0.0);
          // Gameplay lamps only — window emit must not gate roof relief or shadow lift
          // (compose validity / HDR window shaping caused tree & building shadow flicker).
          float rawLightPresence = smoothstep(0.015, 0.16, rawSourceLight);
          float roofReliefBoost = roofReceiver * rawLightPresence * 0.88 * (1.0 - restrictLightRoof);
          roofLightVisibility = max(roofLightVisibility, roofReliefBoost);
          float visS = mix(1.0, roofLightVisibility, clamp(uApplyRoofOcclusionToSources, 0.0, 1.0));
          float visW = mix(1.0, roofLightVisibility, clamp(uApplyRoofOcclusionToWindow, 0.0, 1.0));
          // Restrict-light roof: gate dynamic lights even when uApplyRoofOcclusion* is 0.
          // min(stampedVis, 1 - mask) drives contribution to ~0 under a solid restrict-light stamp.
          float visRestrict = min(stampedVis, 1.0 - restrictLightRoof);
          visS = mix(visS, visRestrict, restrictLightRoof);
          // Restrict-light stamps target Foundry lamp leakage on overhead texels.
          // Window glow is already indoor-gated (outdoors clip + compose outdoor block);
          // do not drive visW toward visRestrict when uApplyRoofOcclusionToWindow is off.
          visW = mix(visW, visRestrict, restrictLightRoof * clamp(uApplyRoofOcclusionToWindow, 0.0, 1.0));
          vec3 srcSafe = srcLights * visS;
          vec3 winSafe = winLights * visW;
          // HDR buffer: RGB = hue×CI×falloff; A = mag (brightness only in alpha for direct).
          vec3 lampChroma = srcSafe;
          float lampEnergyA = max(srcSample.a, 0.0) * visS;
          float lampEnergy = lampEnergyA;
          float lightIVisible = lampEnergyA;
          float chromaGain = max(uChromaticRadianceGain, 1.0);
          float chromaMag = length(lampChroma);
          vec3 lampHue = (chromaMag > 1e-5) ? (lampChroma / chromaMag) : vec3(1.0);
          // ciBase = Foundry CI for this lamp (constant in the disk); was chromaMag/mag which
          // ignored falloff and made colour full-strength until the mesh edge (binary ring).
          float ciBase = clamp(chromaMag / max(lampEnergyA, 1e-4), 0.0, 1.0);
          float ciEff = pow(ciBase, max(uColorationMixPower, 0.01));
          float eGel = lampEnergyA * max(uColorationEnergyGain, 0.0);
          float gelEnd = max(uColorationFalloffEnd, uColorationFalloffStart + 0.001);
          float gelSpatial = smoothstep(uColorationFalloffStart, gelEnd, eGel);
          gelSpatial = pow(clamp(gelSpatial, 0.0, 1.0), max(uColorationFalloffPower, 0.01));
          float gel01 = ciEff * gelSpatial;
          // MSA_COMPOSE_DIRECT_BASELINE: mag-only direct (point lamps / torches; no 1.0+ wash).
          float baseIllum = lampEnergyA;
          float colorW = clamp(gel01, 0.0, 1.0);
          vec3 directFromSources = msaLightDirectIllumination(vec3(baseIllum), lampHue, colorW);

          // Darkness punch: strong nearby lights reduce the effective darkness
          // level locally, letting the ambient brighten under torches/lamps.
          float lightTermI = max(lightIVisible, 0.0);
          float punchLightI = pow(max(lightTermI, 0.0), 0.82);
          float localLightPresenceA = pow(smoothstep(0.002, 0.92, lampEnergy), 0.28);
          if (localLightPresenceA > 0.001) {
            lightTermI = pow(max(lightTermI, 0.0), mix(0.82, 0.72, localLightPresenceA));
            punchLightI = pow(max(punchLightI, 0.0), mix(0.82, 0.62, localLightPresenceA));
          }
          // Shadow override should react as soon as gameplay lights are visibly present.
          // Use a lower activation band than darkness-punch so torch/flashlight beams
          // can clear shadows instead of being visibly darkened by them.
          float dynamicLightPresence = smoothstep(0.008, 0.38, lightIVisible);
          float dynamicShadowLift = clamp(
            dynamicLightPresence * clamp(uDynamicLightShadowOverrideStrength, 0.0, 1.0),
            0.0,
            1.0
          );
          // ShadowManager combined factor multiplies overhead × building × painted × sky-reach × …
          // Sky-reach and other subtle terms vanish if we clear shadow from baseline energy in
          // tLightSources the same way we clear for a torch. Use a stricter band for this path only
          // so faint HDR accumulation from wide AmbientLights does not erase structural shadows.
          float dlPresenceNormComb = lightIVisible;
          float dynamicLightPresenceCombined = smoothstep(0.34, 0.78, dlPresenceNormComb);
          float dynamicShadowLiftCombined = clamp(
            dynamicLightPresenceCombined * clamp(uDynamicLightShadowOverrideStrength, 0.0, 1.0),
            0.0,
            1.0
          );
          float dynamicShadowLiftStructural = clamp(
            smoothstep(0.52, 0.93, dlPresenceNormComb) * clamp(uDynamicLightShadowOverrideStrength, 0.0, 1.0),
            0.0,
            1.0
          );
          float punchGainEff = max(uDarknessPunchGain, 0.0) * mix(1.0, 0.40, localLightPresenceA);
          float punchEnvelope = smoothstep(0.0, mix(0.82, 1.18, localLightPresenceA), lightTermI);
          punchEnvelope = pow(clamp(punchEnvelope, 0.0, 1.0), 0.55);
          float punch = (1.0 - exp(-punchLightI * punchGainEff)) * punchEnvelope;
          float localDarknessLevel = clamp(
            baseDarknessLevel * (1.0 - punch * max(uNegativeDarknessStrength, 0.0)),
            0.0, 1.0
          );
          vec3 punchedAmbient = mix(ambientDay, ambientNight, localDarknessLevel);
          // Outdoor warm ambient retint removed — post-merge CC local ToD override owns
          // timeline colour in gameplay-light pools; compose keeps brightness via punch/direct.

          // Darkness mask from ThreeDarknessSource meshes.
          float punchedMask = clamp(
            darknessMask - punch * max(uNegativeDarknessStrength, 0.0),
            0.0, 1.0
          );
          vec3 ambientAfterDark = punchedAmbient * (1.0 - punchedMask);
          // Padding / outside sceneRect: sceneUvFoundry is clamped — _Outdoors would
          // sample the map border and smear interior classification (horizontal bands
          // in the grey margin). Match building-shadow guard.
          float llWeight = landscapeLightningFlashWeight(vUv) * isOutdoorForInteriorDimSafe;
          vec3 llColorVec = landscapeLightningFlashColorVec();
          // Only apply interior-darkness where the mask confidently indicates
          // "indoors". This rejects low-level mask noise/seams that otherwise
          // become visible as broad banding when interior darkness is increased.
          float skyOpenForInteriorDim = isOutdoorForInteriorDimSafe;
          if (uHasSkyOcclusion > 0.5) {
            skyOpenForInteriorDim = clamp(texture2D(tSkyOcclusion, sceneUvFoundry).r, 0.0, 1.0);
          }
          float indoorSignal = clamp(1.0 - skyOpenForInteriorDim, 0.0, 1.0);
          float indoorConfidence = smoothstep(0.30, 0.70, indoorSignal);
          // tScene includes additive specular; litColor = baseColor * totalIllumination. If we
          // crush ambientAfterDark on interiors while direct HDR is only moderate, totalIllumination
          // stays low and specular highlights (already in baseColor) read flat. Fade interior
          // crush where the HDR light buffer reads strong on this pixel (Foundry + window whites).
          // Keep suppression for bright direct-light overlap, but avoid fully
          // flattening interior darkness under moderate baseline illumination.
          float interiorDarkLightSuppression = smoothstep(0.12, 0.65, lightTermI);
          float indoorConfidenceForDim = indoorConfidence * (1.0 - interiorDarkLightSuppression);
          ambientAfterDark *= max(0.0, 1.0 - uInteriorDarkness * indoorConfidenceForDim);

          // Distant landscape lightning: cold outdoor ambient lift.
          ambientAfterDark += llColorVec * llWeight;

          // Building × painted lit texture (scene UV): shared by daylight ambient slice, direct HDR occlusion, additive tint path.
          float buildStructU = (uHasBuildingShadowLit > 0.5)
            ? clamp(texture2D(tBuildingShadowLit, sceneUvFoundry).r, 0.0, 1.0)
            : 1.0;
          float paintedStructU = 1.0;
          if (uHasPaintedShadowLit > 0.5) {
            float pbStrU = clamp(texture2D(tPaintedShadowLit, sceneUvFoundry).r, 0.0, 1.0);
            float pApplyStrU = pbStrU;
            if (uHasPaintedShadowAtAndAboveLit > 0.5 && uLightingPaintedFloorIndex > 0.5) {
              pApplyStrU = clamp(texture2D(tPaintedShadowAtAndAboveLit, sceneUvFoundry).r, 0.0, 1.0);
            }
            paintedStructU = mix(1.0, pApplyStrU, clamp(uPaintedShadowMgrOpacity, 0.0, 1.0));
          }
          float coreStructUnified = clamp(buildStructU * paintedStructU, 0.0, 1.0);
          float coreStructLiftedGlobal = mix(coreStructUnified, 1.0, dynamicShadowLiftStructural);
          float structuralDirectMul = mix(1.0, coreStructLiftedGlobal, clamp(uDirectStructuralOcclusionStrength, 0.0, 1.0));
          vec3 srcAttenuated = directFromSources * structuralDirectMul;
          vec3 attenuatedDirect = srcAttenuated;

          vec3 totalIllumination = ambientAfterDark + attenuatedDirect;

          // Unified shadow path: ShadowManagerV2 combine dims ambient here. The HDR direct
          // channel uses structuralDirectMul (building×painted); strong lights clear it.
          if (uHasCombinedShadow > 0.5) {
            float shadowFactor;
            float rawShadowFactor;
            float roofAlpha;
            float rawMix;
            float vegetationLit;
            float vegetationSample;
            float overheadLit;
            float structuralLit;
            float paintedEffective;
            float shadowFactorMix;
            float paintedApply;
            float paintedBaked;
            float nonPaintedShadow;
            float shadowSunSlice;
            float wSkySunSlice;
            vec3 ambSkySunPortion;
            vec3 ambRestPortion;
            vec3 ambientPortionLit;

            shadowFactor = clamp(texture2D(tUnifiedShadowFactor, vUv).r, 0.0, 1.0);
            if (uHasShadowRaw > 0.5 && uHasOverheadRoofAlpha > 0.5) {
              rawShadowFactor = clamp(texture2D(tUnifiedShadowRaw, vUv).r, 0.0, 1.0);
              roofAlpha = roofAlphaCached;
              rawMix = roofAlpha * isOutdoorForInteriorDimSafe;
              shadowFactor = mix(shadowFactor, rawShadowFactor, rawMix);
            }
            shadowFactor = amplifyCombinedShadowLit(shadowFactor, uCombinedShadowEffectStrength);
            vegetationLit = 1.0;
            if (uHasVegetationBillboardShadow > 0.5) {
              vegetationSample = clamp(texture2D(tVegetationBillboardShadow, vUv).r, 0.0, 1.0);
              vegetationLit = mix(1.0, vegetationSample, clamp(uVegetationBillboardOpacity, 0.0, 1.0));
            }
            overheadLit = 1.0;
            if (uHasShadowRaw > 0.5) {
              overheadLit = clamp(texture2D(tUnifiedShadowRaw, vUv).a, 0.0, 1.0);
            }
            overheadLit = mix(1.0, overheadLit, clamp(uOverheadShadowAmbientInfluence, 0.0, 1.0));
            structuralLit = clamp(shadowFactor / max(vegetationLit * overheadLit, 0.001), 0.0, 1.0);
            paintedEffective = 1.0;
            if (uPaintedShadowInCombined < 0.5 && uHasPaintedShadowLit > 0.5) {
              paintedApply = clamp(texture2D(tPaintedShadowLit, sceneUvFoundry).r, 0.0, 1.0);
              paintedEffective = mix(1.0, paintedApply, clamp(uPaintedShadowMgrOpacity, 0.0, 1.0));
              shadowFactorMix = mix(
                1.0,
                structuralLit,
                clamp(uCloudShadowAmbientInfluence, 0.0, 1.0)
              );
              shadowFactorMix = mix(shadowFactorMix, 1.0, dynamicShadowLiftCombined);
              shadowFactorMix *= paintedEffective;
            } else {
              paintedBaked = 1.0;
              if (uHasPaintedShadowLit > 0.5) {
                paintedBaked = clamp(texture2D(tPaintedShadowLit, sceneUvFoundry).r, 0.0, 1.0);
                paintedApply = paintedBaked;
                if (uHasPaintedShadowAtAndAboveLit > 0.5 && uLightingPaintedFloorIndex > 0.5) {
                  paintedApply = clamp(texture2D(tPaintedShadowAtAndAboveLit, sceneUvFoundry).r, 0.0, 1.0);
                }
                paintedEffective = mix(1.0, paintedApply, clamp(uPaintedShadowMgrOpacity, 0.0, 1.0));
              }
              nonPaintedShadow = clamp(
                structuralLit / max(paintedBaked, 0.0001),
                0.0,
                1.0
              );
              shadowFactorMix = mix(
                1.0,
                nonPaintedShadow,
                clamp(uCloudShadowAmbientInfluence, 0.0, 1.0)
              );
              shadowFactorMix = mix(shadowFactorMix, 1.0, dynamicShadowLiftCombined);
              shadowFactorMix *= paintedEffective;
            }
            shadowFactorMix = clamp(shadowFactorMix * vegetationLit * overheadLit, 0.0, 1.0);
            shadowSunSlice = min(shadowFactorMix, coreStructLiftedGlobal);
            wSkySunSlice = clamp(
              (1.0 - baseDarknessLevel)
                * calendarDayWeight
                * isOutdoorForInteriorDimSafe
                * clamp(uStructuralSunAmbientOcclusion, 0.0, 1.0),
              0.0,
              1.0
            );
            ambSkySunPortion = ambientAfterDark * wSkySunSlice;
            ambRestPortion = ambientAfterDark * (1.0 - wSkySunSlice);
            ambientPortionLit = ambSkySunPortion * shadowSunSlice + ambRestPortion * shadowFactorMix;
            {
              float cloudDirectW = clamp(uCloudShadowAmbientInfluence, 0.0, 1.0)
                * 0.5
                * calendarDayWeight
                * isOutdoorForInteriorDimSafe;
              totalIllumination = ambientPortionLit
                + attenuatedDirect * mix(1.0, shadowFactor, cloudDirectW);
            }
            ambientShadowMixOut = shadowFactorMix;
          }

          // Outdoor lightning fill after shadow combine — cold tint on illumination stack.
          {
            totalIllumination += llColorVec * llWeight;
            float llContrast = clamp(uLandscapeLightningFlashContrast, 0.0, 3.0)
              * clamp(uLandscapeLightningFlash01, 0.0, 1.0)
              * isOutdoorForInteriorDimSafe;
            if (llContrast > 0.001) {
              vec3 llCenter = llColorVec * 0.42;
              vec3 centered = totalIllumination - llCenter;
              totalIllumination = mix(
                totalIllumination,
                centered * (1.0 + llContrast) + llCenter,
                clamp(uLandscapeLightningFlash01, 0.0, 1.0) * isOutdoorForInteriorDimSafe
              );
            }
          }

          // Minimum illumination floor (scaled down where unified shadow darkens ambient so penumbra survives).
          vec3 minIllum = mix(ambientDay, ambientNight, localDarknessLevel)
            * (0.1 * max(uMinIlluminationScale, 0.0));
          float floorReach = clamp(ambientShadowMixOut, 0.0, 1.0);
          totalIllumination = max(totalIllumination, minIllum * mix(0.18, 1.0, floorReach));

          // Window light: HDR spill on illumination stack + small additive core (no litColor *=).
          if (uHasLightWindow > 0.5) {
            float winMag = max(winSafe.r, max(winSafe.g, winSafe.b));
            if (winMag > 1e-5) {
              float winGain = max(uWindowEmissiveGain, 0.0);
              float winShape = clamp(uWindowIndirectContrast, 0.35, 1.25);
              float winCore = pow(clamp(winMag, 0.0, 2.8), winShape);
              vec3 winHue = winSafe / max(winMag, 1e-4);
              float winWarmth = clamp(uWindowWarmthTint, 0.0, 1.0);
              float indirectAmt = winCore * (0.45 + 1.65 * winGain);
              float albedoCouple = clamp(uWindowAlbedoCoupling, 0.0, 1.5);
              indirectAmt *= mix(
                1.0,
                clamp(perceivedBrightness(baseColor.rgb) * 2.2, 0.5, 1.35),
                albedoCouple
              );
              vec3 winIllum = msaLightDirectIllumination(vec3(indirectAmt), winHue, winWarmth);
              totalIllumination += winIllum;
            }
          }

          vec3 litColor = baseColor.rgb * totalIllumination;

          if (uHasLightWindow > 0.5) {
            float winMagLit = max(winSafe.r, max(winSafe.g, winSafe.b));
            float spillGain = max(uWindowScreenSpill, 0.0) * max(uWindowEmissiveGain, 0.0);
            float spillAmt = smoothstep(0.06, 0.42, winMagLit) * spillGain * 0.42;
            if (spillAmt > 1e-5) {
              vec3 winHueLit = winSafe / max(winMagLit, 1e-4);
              litColor += winHueLit * spillAmt;
            }
          }
          // Albedo tint: linear in CI (exp×chromaGain flattened 0.5 vs 1.0 to the same weight).
          // Fade tint when direct already carries hue so CI steps read on illumination first.
          if (chromaMag > 1e-5 && gel01 > 1e-4) {
            float reflPB = max(perceivedBrightness(baseColor.rgb), 0.05);
            float colorReflect = mix(1.0, reflPB, clamp(uColorationReflectivity, 0.0, 1.0));
            float tintW = clamp(gel01 * colorReflect * mix(1.0, 0.18, colorW), 0.0, 1.0);
            litColor = msaLightLumaPreserveTint(litColor, lampHue, tintW);
            float satBoost = max(uColorationSaturationBoost, 0.0);
            if (satBoost > 0.001) {
              float litL = dot(litColor, MSA_LUMA_W);
              float satMul = 1.0 + satBoost * gel01 * clamp(chromaGain * 0.18, 0.0, 2.5);
              litColor = mix(vec3(litL), litColor, satMul);
            }
          }
          // Colored lightning screen flash (additive + hue mix — visible over neutral HDR lights).
          {
            litColor += llColorVec * llWeight * 0.65;
            litColor = mix(litColor, litColor * llColorVec, clamp(llWeight * 0.42, 0.0, 0.82));
          }

          // Linear HDR output: no clamp, no tone mapping. ColorCorrectionEffectV2 is the
          // sole owner of exposure and tone curves. uComposeToneExposure is forced to 1.0
          // upstream; uniform retained only for legacy save compatibility.
          gl_FragColor = vec4(litColor, baseColor.a);
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

    // ── Stacked light-buffer max blend (multi-floor post-merge CC) ───────
    this._stackedLightRtA = new THREE.WebGLRenderTarget(this._lightSize.w, this._lightSize.h, { ...rtOpts });
    this._stackedLightRtA.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this._stackedLightRtB = new THREE.WebGLRenderTarget(this._lightSize.w, this._lightSize.h, { ...rtOpts });
    this._stackedLightRtB.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this._stackLightCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._stackLightMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tAccum: { value: null },
        tLayer: { value: null },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tAccum;
        uniform sampler2D tLayer;
        varying vec2 vUv;
        void main() {
          vec4 accum = texture2D(tAccum, vUv);
          vec4 layer = texture2D(tLayer, vUv);
          gl_FragColor = max(accum, layer);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    this._stackLightMaterial.toneMapped = false;
    this._stackLightScene = new THREE.Scene();
    const stackQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._stackLightMaterial);
    stackQuad.frustumCulled = false;
    this._stackLightScene.add(stackQuad);

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
    this._bindPerfRecorder();
    const _perfToken = this._beginPerfSpan('reconcileEmbeddedLights', 'update', { cpuOnly: true });
    const docs = getAuthoritativeAmbientLightDocuments();
    const enhancementMap = this._getLightEnhancementConfigMap();

    const validPositive = this._validPositiveCache;
    const validNegative = this._validNegativeCache;
    validPositive.clear();
    validNegative.clear();
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
      pruned += 1;
    }
    for (const key of [...this._darknessSources.keys()]) {
      if (validNegative.has(key)) continue;
      const ds = this._darknessSources.get(key);
      if (ds?.mesh) this._darknessScene?.remove(ds.mesh);
      ds?.dispose?.();
      this._darknessSources.delete(key);
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
    this._endPerfSpan(_perfToken);
  }

  /**
   * Push HDR radiance + coloration uniforms into light meshes (`ThreeLightSource`, torch, glow).
   * @private
   */
  _pushLightBufferUniformsToMeshes() {
    if (!this._initialized) return;
    const g = Math.max(0, Number(this.params.lightIntensity));
    const safeGain = Number.isFinite(g) ? g : 0;
    const mixScale = Math.max(0, Number(this.params.colorationMixScale) || 0);
    const maxMix = clamp01(Number(this.params.colorationMaxMix) ?? 1);
    const sig = `${safeGain}|${mixScale}|${maxMix}`;
    if (this._lastLightBufferUniformSig === sig && !this._lightBufferUniformsDirty) return;
    this._lastLightBufferUniformSig = sig;
    this._lightBufferUniformsDirty = false;

    const apply = (uniforms) => {
      if (!uniforms) return;
      if (uniforms.uComposeLightGain) uniforms.uComposeLightGain.value = safeGain;
      if (uniforms.uColorationMixScale) uniforms.uColorationMixScale.value = mixScale;
      if (uniforms.uColorationMaxMix) uniforms.uColorationMaxMix.value = maxMix;
    };

    const resyncColoration = (light) => {
      if (!light || typeof light._syncColorationUniforms !== 'function') return;
      const doc = typeof light._resolveLiveLightDoc === 'function'
        ? (light._resolveLiveLightDoc() || light.document)
        : light.document;
      const cfg = doc?.config && typeof doc.config === 'object' ? doc.config : {};
      light._syncColorationUniforms(cfg);
    };

    for (let i = 0; i < this._lightList.length; i++) {
      const light = this._lightList[i];
      apply(light?.material?.uniforms);
      resyncColoration(light);
    }
    try {
      const pl = window.MapShine?.playerLightEffectV2;
      for (const src of [pl?._torchLightSource, pl?._flashlightLightSource]) {
        apply(src?.material?.uniforms);
        resyncColoration(src);
      }
    } catch (_) {
      /* noop */
    }
    // Candle glow buckets share _lightScene; refresh HDR emission when point-light gain changes.
    try {
      const candles = window.MapShine?.candleFlamesEffectV2;
      if (candles?.params?.glowFollowLightIntensity && candles._glowBuckets?.size) {
        candles._updateGlowFlicker?.({ elapsed: performance.now() * 0.001 });
      }
    } catch (_) {
      /* noop */
    }
  }

  /**
   * Visit every live point-light ShaderMaterial.uniforms bag (Foundry, torch, glow meshes).
   * @private
   * @param {(uniforms: Record<string, { value?: unknown }>) => void} fn
   */
  _forEachPointLightUniforms(fn) {
    if (typeof fn !== 'function') return;
    for (let i = 0; i < this._lightList.length; i++) {
      const u = this._lightList[i]?.material?.uniforms;
      if (u) fn(u);
    }
    try {
      const pl = window.MapShine?.playerLightEffectV2;
      for (const src of [pl?._torchLightSource, pl?._flashlightLightSource]) {
        const u = src?.material?.uniforms;
        if (u) fn(u);
      }
    } catch (_) {}
    try {
      const candles = window.MapShine?.candleFlamesEffectV2?._glowBuckets;
      if (candles) {
        for (const entry of candles.values()) {
          const u = entry?.lightMesh?.material?.uniforms;
          if (u) fn(u);
        }
      }
    } catch (_) {}
    try {
      const fire = window.MapShine?.fireEffectV2?._glowBucketsByFloor;
      if (fire) {
        for (const buckets of fire.values()) {
          for (const entry of buckets.values()) {
            const u = entry?.lightMesh?.material?.uniforms;
            if (u) fn(u);
          }
        }
      }
    } catch (_) {}
    try {
      const bolts = window.MapShine?.lightningEffectV2?._originFlashMeshes;
      if (bolts) {
        for (const lm of bolts) {
          const u = lm?.material?.uniforms;
          if (u) fn(u);
        }
      }
    } catch (_) {}
  }

  /**
   * Push half-life falloff tuning from `params` into all point-light materials.
   * @private
   */
  _pushPointLightFalloffUniforms() {
    if (!this._initialized) return;
    const tuning = getPointLightFalloffTuningFromParams(this.params);
    const sig = JSON.stringify(tuning);
    const exp = Math.max(
      0.5,
      Number(this.params.falloffExponent) || DEFAULT_POINT_LIGHT_FALLOFF_EXPONENT,
    );
    const sigWithExp = `${sig}|${exp}`;
    if (this._lastFalloffTuningSig !== sigWithExp) {
      this._lastFalloffTuningSig = sigWithExp;
      this._forEachPointLightUniforms((uniforms) => {
        applyPointLightFalloffUniforms(uniforms, tuning);
        if (uniforms.uFalloffExponent) uniforms.uFalloffExponent.value = exp;
      });
    }
    for (let i = 0; i < this._lightList.length; i++) {
      const light = this._lightList[i];
      const rawAtt = light?._foundryAttenuation;
      const u = light?.material?.uniforms;
      if (typeof rawAtt === 'number' && u) {
        applyFalloffAttenuationUniforms(
          u,
          rawAtt,
          tuning.attCurvePower,
          brightNormFromLightUniforms(u),
        );
      }
    }
  }

  /**
   * Full sync of all Foundry light sources. Call once after canvas is ready.
   */
  syncAllLights() {
    if (!this._initialized) return;
    this._bindPerfRecorder();

    let _perfToken = this._beginPerfSpan('syncAllLights.detachForeign', 'update', { cpuOnly: true });
    // `_lightScene` is shared with PlayerLightEffectV2 (torch/flashlight) and
    // CandleFlamesEffectV2 (glow group). Those meshes are not in `_lights`, so a
    // normal "clear _lights" pass would leave them parented — looks like a Foundry
    // light disk after every AmbientLight is deleted. Detach foreign children first;
    // those effects re-attach on their next update if still enabled.
    if (this._lightScene) {
      const trackedMeshes = new Set();
      for (let i = 0; i < this._lightList.length; i++) {
        const light = this._lightList[i];
        if (light?.mesh) trackedMeshes.add(light.mesh);
      }
      for (const ch of [...this._lightScene.children]) {
        if (!trackedMeshes.has(ch)) {
          try { this._lightScene.remove(ch); } catch (_) {}
        }
      }
    }
    this._endPerfSpan(_perfToken);

    _perfToken = this._beginPerfSpan('syncAllLights.dispose', 'update', { cpuOnly: true });
    // Dispose existing Foundry-tracked light sources
    for (let i = 0; i < this._lightList.length; i++) {
      const light = this._lightList[i];
      if (light.mesh) this._lightScene.remove(light.mesh);
      light.dispose();
    }
    this._lights.clear();
    this._lightList.length = 0;

    for (let i = 0; i < this._darknessList.length; i++) {
      const ds = this._darknessList[i];
      if (ds.mesh) this._darknessScene.remove(ds.mesh);
      ds.dispose();
    }
    this._darknessSources.clear();
    this._darknessList.length = 0;
    this._endPerfSpan(_perfToken);

    _perfToken = this._beginPerfSpan('syncAllLights.rebuildFromDocs', 'update', { cpuOnly: true });
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
    this._lastPushedLightGain = -1;
    this._lastFalloffTuningSig = null;
    this._pushLightBufferUniformsToMeshes();
    this._pushPointLightFalloffUniforms();
    log.info(`LightingEffectV2: synced ${this._lights.size} lights, ${this._darknessSources.size} darkness sources`);
    this._endPerfSpan(_perfToken);
  }

  /**
   * Prefer the cached live embedded AmbientLight document so level membership /
   * flags match Foundry without doing collection lookups in hot loops.
   * @private
   * @param {ThreeLightSource|ThreeDarknessSource} source
   * @returns {object|null|undefined}
   */
  _liveAmbientDocForGating(source) {
    return source?._cachedDoc ?? source?.document ?? null;
  }

  /**
   * Toggle Three.js light/darkness mesh visibility from Levels elevation rules
   * (`isLightVisibleForPerspective`). Uses cached live docs so token/level changes
   * apply without per-light collection lookups.
   * @private
   */
  _refreshLightsForLevelsPerspective() {
    if (!this._initialized) return;
    const _perfToken = this._beginPerfSpan('perspectiveRefresh.apply', 'update', { cpuOnly: true });
    // Phase 3: per-light "is this light visible at the current darkness?"
    // gating reads the canonical master darkness, so user-selected priority
    // (calendar/weather/slider/max) consistently drives which torches appear.
    const sceneDarkness = clamp01(LightingDirector.get().masterDarkness);
    const pOverride = this._renderFloorIndexForLights != null
      ? getPerspectiveForRenderFloorIndex(this._renderFloorIndexForLights)
      : null;

    for (let i = 0; i < this._lightList.length; i++) {
      const light = this._lightList[i];
      if (!light?.mesh) continue;
      const doc = this._liveAmbientDocForGating(light);
      light.mesh.visible = this._isDocVisibleForLighting(doc, sceneDarkness, pOverride);
    }

    for (let i = 0; i < this._darknessList.length; i++) {
      const ds = this._darknessList[i];
      if (!ds?.mesh) continue;
      const doc = this._liveAmbientDocForGating(ds);
      ds.mesh.visible = this._isDocVisibleForLighting(doc, sceneDarkness, pOverride);
    }
    this._endPerfSpan(_perfToken);
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
    if (!source || source?.mesh?.visible === false) return false;

    // OPTIMIZATION: Cache lowercase parsing and update cadence on the source itself.
    const ud = source._msaAnimCache || (source._msaAnimCache = { isTorchLike: false, lastType: null, nextUpdateAtSec: undefined });
    const animType = source?.document?.config?.animation?.type;

    if (ud.lastType !== animType) {
      ud.lastType = animType;
      const t = String(animType || '').toLowerCase();
      ud.isTorchLike = (t === 'torch' || t === 'flame');
    }

    if (!ud.isTorchLike) return false;

    const nextAt = ud.nextUpdateAtSec;
    if (nextAt !== undefined && tSec < nextAt) return true;

    ud.nextUpdateAtSec = tSec + (1 / 12);
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
   * @param {object|null|undefined} [pOverride] Hoisted perspective for current render floor
   * @returns {boolean}
   */
  _isDocVisibleForLighting(doc, sceneDarkness, pOverride = null) {
    if (!doc) return false;
    if (!isLightVisibleForPerspective(doc, pOverride)) return false;
    if (doc.hidden === true) return false;

    const d = clamp01(
      Number.isFinite(sceneDarkness)
        ? sceneDarkness
        : LightingDirector.get().masterDarkness,
    );
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
  _addLightFromDoc(doc, enhancementMap = null, cachedDoc = doc) {
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
        ds._cachedDoc = cachedDoc ?? mergedDoc;
        ds.init();
        this._darknessSources.set(id, ds);
        this._darknessList.push(ds); // OPTIMIZATION: Update flat array
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
        light._cachedDoc = cachedDoc ?? mergedDoc;
        light.init();
        this._lights.set(id, light);
        this._lightList.push(light); // OPTIMIZATION: Update flat array
        this._lastPushedLightGain = -1;
        this._lastFalloffTuningSig = null;
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
      this._addLightFromDoc(merged, null, doc ?? merged);
      this._markPerspectiveRefreshDirty();
      return;
    }
    if (!isNegative && this._darknessSources.has(id)) {
      const old = this._darknessSources.get(id);
      if (old.mesh) this._darknessScene?.remove(old.mesh);
      old.dispose();
      this._darknessSources.delete(id);
      this._addLightFromDoc(merged, null, doc ?? merged);
      this._markPerspectiveRefreshDirty();
      return;
    }

    // Normal update
    if (this._lights.has(id)) {
      const light = this._lights.get(id);
      light._cachedDoc = doc ?? merged;
      light.updateData(merged);
    } else if (this._darknessSources.has(id)) {
      const ds = this._darknessSources.get(id);
      ds._cachedDoc = doc ?? merged;
      ds.updateData(merged);
    } else {
      // Light not tracked yet — create it
      this._addLightFromDoc(merged, null, doc ?? merged);
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
      this._lightList = Array.from(this._lights.values()); // OPTIMIZATION
    }
    if (this._darknessSources.has(id)) {
      const ds = this._darknessSources.get(id);
      if (ds.mesh) this._darknessScene?.remove(ds.mesh);
      ds.dispose();
      this._darknessSources.delete(id);
      this._darknessList = Array.from(this._darknessSources.values()); // OPTIMIZATION
    }
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
    const defDay = 0;
    const defNight = 0;
    const gv = Number(g);
    const day = Number(p.ambientDayScale);
    const night = Number(p.ambientNightScale);
    if (!Number.isFinite(day) || !Number.isFinite(night)) return;
    if (
      Math.abs(day - defDay) < 1e-5 &&
      Math.abs(night - defNight) < 1e-5 &&
      Math.abs(gv - defDay) > 1e-5
    ) {
      p.ambientDayScale = gv;
      p.ambientNightScale = gv;
    }
  }

  /**
   * Copy legacy single-scale ambient into outdoor/indoor params once (saved JSON / presets).
   * @private
   */
  _migrateSplitAmbientParams() {
    if (this._splitAmbientParamsMigrated) return;
    this._splitAmbientParamsMigrated = true;
    const p = this.params;
    const legacyDay = Number(p.ambientDayScale);
    const legacyNight = Number(p.ambientNightScale);
    const dayOut = Math.max(0, Number(p.ambientDayScaleOutdoor) || 0);
    const dayIn = Math.max(0, Number(p.ambientDayScaleIndoor) || 0);
    const nightOut = Math.max(0, Number(p.ambientNightScaleOutdoor) || 0);
    const nightIn = Math.max(0, Number(p.ambientNightScaleIndoor) || 0);
    let dirty = false;
    if (dayOut < 1e-5 && dayIn < 1e-5 && legacyDay > 1e-5) {
      p.ambientDayScaleOutdoor = legacyDay;
      p.ambientDayScaleIndoor = legacyDay;
      dirty = true;
    }
    if (nightOut < 1e-5 && nightIn < 1e-5 && legacyNight > 1e-5) {
      p.ambientNightScaleOutdoor = legacyNight;
      p.ambientNightScaleIndoor = legacyNight;
      dirty = true;
    }
    if (dirty) this._markParamsDirty();
  }

  /**
   * Effective outdoor/indoor ambient scales for compose (uniforms only when saved values are zero).
   * @returns {{ dayOutdoor: number, dayIndoor: number, nightOutdoor: number, nightIndoor: number, minIllum: number }}
   * @private
   */
  _resolveEffectiveAmbientScalesForCompose() {
    this._seedAmbientFromLegacyGlobalIfNeeded();
    this._migrateSplitAmbientParams();
    const p = this.params;
    let dayOutdoor = Math.max(0, Number(p.ambientDayScaleOutdoor) || 0);
    let dayIndoor = Math.max(0, Number(p.ambientDayScaleIndoor) || 0);
    let nightOutdoor = Math.max(0, Number(p.ambientNightScaleOutdoor) || 0);
    let nightIndoor = Math.max(0, Number(p.ambientNightScaleIndoor) || 0);
    let minIllum = Math.max(0, Number(p.minIlluminationScale) || 0);

    const legacyDay = Math.max(0, Number(p.ambientDayScale) || 0);
    const legacyNight = Math.max(0, Number(p.ambientNightScale) || 0);
    if (dayOutdoor < 1e-5 && dayIndoor < 1e-5 && legacyDay > 1e-5) {
      dayOutdoor = legacyDay;
      dayIndoor = legacyDay;
    }
    if (nightOutdoor < 1e-5 && nightIndoor < 1e-5 && legacyNight > 1e-5) {
      nightOutdoor = legacyNight;
      nightIndoor = legacyNight;
    }

    const allZero = dayOutdoor < 1e-5 && dayIndoor < 1e-5
      && nightOutdoor < 1e-5 && nightIndoor < 1e-5;
    if (allZero) {
      const g = Math.max(0, Number(p.globalIllumination) || 0);
      if (g > 1e-5) {
        dayOutdoor = g;
        dayIndoor = g;
        nightOutdoor = g;
        nightIndoor = g;
        if (minIllum < 1e-5) minIllum = Math.min(g * 0.35, MSA_AMBIENT_COMPOSE_DEFAULTS.minIllum);
      } else {
        dayOutdoor = MSA_AMBIENT_COMPOSE_DEFAULTS.dayOutdoor;
        dayIndoor = MSA_AMBIENT_COMPOSE_DEFAULTS.dayIndoor;
        nightOutdoor = MSA_AMBIENT_COMPOSE_DEFAULTS.nightOutdoor;
        nightIndoor = MSA_AMBIENT_COMPOSE_DEFAULTS.nightIndoor;
        if (minIllum < 1e-5) minIllum = MSA_AMBIENT_COMPOSE_DEFAULTS.minIllum;
      }
    } else if (minIllum < 1e-5) {
      minIllum = MSA_AMBIENT_COMPOSE_DEFAULTS.minIllum;
    }

    return { dayOutdoor, dayIndoor, nightOutdoor, nightIndoor, minIllum };
  }

  /**
   * Push resolved ambient scales to compose uniforms (does not mutate {@link #params}).
   * @param {Record<string, { value: number }>} u
   * @private
   */
  _pushEffectiveAmbientUniforms(u) {
    if (!u) return;
    const eff = this._resolveEffectiveAmbientScalesForCompose();
    if (u.uAmbientDayScaleOutdoor) u.uAmbientDayScaleOutdoor.value = eff.dayOutdoor;
    if (u.uAmbientDayScaleIndoor) u.uAmbientDayScaleIndoor.value = eff.dayIndoor;
    if (u.uAmbientNightScaleOutdoor) u.uAmbientNightScaleOutdoor.value = eff.nightOutdoor;
    if (u.uAmbientNightScaleIndoor) u.uAmbientNightScaleIndoor.value = eff.nightIndoor;
    if (u.uMinIlluminationScale) u.uMinIlluminationScale.value = eff.minIllum;
    if (u.uAmbientDayScale) {
      u.uAmbientDayScale.value = Math.max(eff.dayOutdoor, eff.dayIndoor);
    }
    if (u.uAmbientNightScale) {
      u.uAmbientNightScale.value = Math.max(eff.nightOutdoor, eff.nightIndoor);
    }
  }

  /**
   * Map Shine hour for lighting (weather controller + control-panel fallback).
   * @returns {number|null}
   * @private
   */
  _resolveMapShineTimeOfDayHour() {
    const wc = window.MapShine?.weatherController;
    const fromWc = Number(wc?.timeOfDay);
    if (Number.isFinite(fromWc)) return ((fromWc % 24) + 24) % 24;
    const fromPanel = Number(window.MapShine?.controlPanel?.controlState?.timeOfDay);
    if (Number.isFinite(fromPanel)) return ((fromPanel % 24) + 24) % 24;
    return null;
  }

  /**
   * Darkness 0..1 for ambient day/night mix. Phase 3 delegates this entirely
   * to {@link LightingDirector}; the legacy in-shader Math.max merge of
   * Foundry slider + calendar + weather has moved to CPU so every consumer
   * agrees on a single value per frame.
   *
   * @returns {number}
   * @private
   */
  _resolveEffectiveSceneDarkness01() {
    return clamp01(LightingDirector.get().masterDarkness);
  }

  /**
   * Push calendar darkness + day-ambient gate uniforms on the compose pass.
   * @private
   */
  _syncComposeDarknessUniforms() {
    const u = this._composeMaterial?.uniforms;
    if (!u) return;

    const state = LightingDirector.get();
    const sceneDarkness = clamp01(state.masterDarkness);
    this.params.darknessLevel = sceneDarkness;
    u.uDarknessLevel.value = sceneDarkness;
    u.uCalendarDayWeight.value = clamp01(state.calendarDayWeight);
  }

  /**
   * Distant landscape lightning outdoor ambient boost (interiors use window pass).
   * @param {number} flash01
   * @param {number} [outdoorGain]
   */
  setLandscapeLightningFlash(flash01, outdoorGain = 0.65, opts = {}) {
    const cu = this._composeMaterial?.uniforms;
    if (!cu?.uLandscapeLightningFlash01) return;
    const f = Number(flash01);
    cu.uLandscapeLightningFlash01.value = Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : 0;
    const g = Number(outdoorGain);
    cu.uLandscapeLightningOutdoorGain.value = Number.isFinite(g) ? Math.max(0, Math.min(16, g)) : 0.65;
    const floorV = Number(opts.shadowFlashFloor);
    if (cu.uLandscapeLightningShadowFloor) {
      cu.uLandscapeLightningShadowFloor.value = Number.isFinite(floorV)
        ? Math.max(0, Math.min(1, floorV))
        : 0.2;
    }
    const gammaV = Number(opts.shadowFlashGamma);
    if (cu.uLandscapeLightningShadowGamma) {
      cu.uLandscapeLightningShadowGamma.value = Number.isFinite(gammaV)
        ? Math.max(0.08, Math.min(4, gammaV))
        : 0.55;
    }
    const contrastV = Number(opts.flashContrast);
    if (cu.uLandscapeLightningFlashContrast) {
      cu.uLandscapeLightningFlashContrast.value = Number.isFinite(contrastV)
        ? Math.max(0, Math.min(3, contrastV))
        : 1.15;
    }
    if (cu.uLandscapeLightningFlashColor) {
      const col = opts.flashColor ?? {};
      const r = Number(col.r);
      const g = Number(col.g);
      const b = Number(col.b);
      cu.uLandscapeLightningFlashColor.value.set(
        Number.isFinite(r) ? Math.max(0, Math.min(4, r)) : 0.68,
        Number.isFinite(g) ? Math.max(0, Math.min(4, g)) : 0.82,
        Number.isFinite(b) ? Math.max(0, Math.min(4, b)) : 1.0,
      );
    }
  }

  // ── Per-frame update ──────────────────────────────────────────────────

  /**
   * Update light animations and composite uniforms.
   * @param {{ elapsed: number, delta: number }} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized || !this._enabled) return;
    this._bindPerfRecorder();

    let _perfToken = this._beginPerfSpan('envAmbient', 'update', { cpuOnly: true });
    // Sync darkness level and ambient colors from Foundry canvas environment.
    // canvas.environment exposes darknessLevel (0=bright, 1=dark) and the
    // scene's configured ambient colors for brightest/darkest lighting states.
    const env = canvas?.environment;
    if (env) {
      const u = this._composeMaterial?.uniforms;
      if (u) {
        const bright = env.ambientBrightest;
        if (bright && typeof bright === 'object' && 'r' in bright) {
          const r = +(bright.r ?? 1);
          const g = +(bright.g ?? 1);
          const b = +(bright.b ?? 1);
          const prev = this._lastAmbientBrightestRgb;
          // OPTIMIZATION: Mutate existing object
          if (prev.r !== r || prev.g !== g || prev.b !== b) {
            u.uAmbientBrightest.value.setRGB(r, g, b);
            prev.r = r; prev.g = g; prev.b = b;
            this._lastAmbientBrightestHex = null;
          }
        } else if (typeof bright === 'number' && Number.isFinite(bright) && this._lastAmbientBrightestHex !== bright) {
          u.uAmbientBrightest.value.setHex(bright);
          this._lastAmbientBrightestHex = bright;
          this._lastAmbientBrightestRgb.r = -1; // Invalidate
        }
        const dark = env.ambientDarkness;
        if (dark && typeof dark === 'object' && 'r' in dark) {
          const r = +(dark.r ?? 0.141);
          const g = +(dark.g ?? 0.141);
          const b = +(dark.b ?? 0.282);
          const prev = this._lastAmbientDarknessRgb;
          if (prev.r !== r || prev.g !== g || prev.b !== b) {
            u.uAmbientDarkness.value.setRGB(r, g, b);
            prev.r = r; prev.g = g; prev.b = b;
            this._lastAmbientDarknessHex = null;
          }
        } else if (typeof dark === 'number' && Number.isFinite(dark) && this._lastAmbientDarknessHex !== dark) {
          u.uAmbientDarkness.value.setHex(dark);
          this._lastAmbientDarknessHex = dark;
          this._lastAmbientDarknessRgb.r = -1; // Invalidate
        }
      }
    }
    this._endPerfSpan(_perfToken);

    _perfToken = this._beginPerfSpan('composeDarknessUniforms', 'update', { cpuOnly: true });
    this._syncComposeDarknessUniforms();
    this._pushEffectiveAmbientUniforms(this._composeMaterial?.uniforms);
    this._endPerfSpan(_perfToken);

    // Phase 3: master darkness drives both ambient-light animation
    // (`light.updateAnimation`) and per-light visibility gating, so a single
    // value owns the entire ambient-light chain for the frame.
    const sceneDarkness = this.params.darknessLevel;
    const foundrySceneDarkness = sceneDarkness;
    const tSec = (timeInfo && typeof timeInfo.elapsed === 'number') ? timeInfo.elapsed : 0;

    _perfToken = this._beginPerfSpan('lightLoop.animationVisibility', 'update', { cpuOnly: true });
    // OPTIMIZATION: Array iteration is thousands of times faster than Map.values()
    const lights = this._lightList;
    const pOverride = this._renderFloorIndexForLights != null
      ? getPerspectiveForRenderFloorIndex(this._renderFloorIndexForLights)
      : null;
    for (let i = 0; i < lights.length; i++) {
      const light = lights[i];
      if (!this._shouldDecimateAnimationUpdate(light, tSec) && typeof light?.updateAnimation === 'function') {
        light.updateAnimation(timeInfo, sceneDarkness, null, this._shadowContextForLights ?? null);
      }
      if (light?.mesh) {
        const doc = this._liveAmbientDocForGating(light);
        light.mesh.visible = this._isDocVisibleForLighting(doc, foundrySceneDarkness, pOverride);
      }
    }
    this._endPerfSpan(_perfToken);

    _perfToken = this._beginPerfSpan('darknessLoop.animationVisibility', 'update', { cpuOnly: true });
    const darks = this._darknessList;
    for (let i = 0; i < darks.length; i++) {
      const ds = darks[i];
      if (!this._shouldDecimateAnimationUpdate(ds, tSec) && typeof ds?.updateAnimation === 'function') {
        ds.updateAnimation(timeInfo);
      }
      if (ds?.mesh) {
        const doc = this._liveAmbientDocForGating(ds);
        ds.mesh.visible = this._isDocVisibleForLighting(doc, foundrySceneDarkness, pOverride);
      }
    }
    this._endPerfSpan(_perfToken);

    _perfToken = this._beginPerfSpan('staticParamUniforms', 'update', { cpuOnly: true });
    this._syncStaticParamUniforms();
    this._endPerfSpan(_perfToken);
  }

  // ── Render ────────────────────────────────────────────────────────────

  /** @private */
  _invalidateLightMaskPrepassCache() {
    this._lightMaskPrepassCache.valid = false;
  }

  /**
   * @param {number} w
   * @param {number} h
   * @param {number} renderFloor
   * @returns {boolean}
   * @private
   */
  _canReuseLightMaskPrepassFoundryDraw(w, h, renderFloor) {
    // Always redraw for compose: prepass can run before torch/candle animation updates
    // and skips attenuation/softness changes — stale buffers read as hard on/off rims.
    return false;
  }

  /**
   * @param {number} w
   * @param {number} h
   * @param {number} floorIndex
   * @private
   */
  _markLightMaskPrepassFoundryDraw(w, h, floorIndex) {
    const lightGain = Math.max(0, Number(this.params.lightIntensity) || 0);
    this._lightMaskPrepassCache.valid = true;
    this._lightMaskPrepassCache.floorIndex = floorIndex;
    this._lightMaskPrepassCache.rtW = w;
    this._lightMaskPrepassCache.rtH = h;
    this._lightMaskPrepassCache.lightGain = lightGain;
    this._lightRtContentFloor = floorIndex;
  }

  /**
   * Refresh current-frame light textures before source shadow passes run.
   *
   * The full lighting render normally accumulates `_lightRT` and window emit
   * immediately before compose, which is too late for Building/SkyReach/Overhead
   * shadow shaders that need light presence to clear shadow strength. This pass
   * draws Foundry lights to `_lightRT` and a stripped window emit (`shadowLift`)
   * so compose draws full window glow once with roof/ceiling/cloud masks.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera
   * @param {THREE.Scene|null} [windowLightScene=null]
   * @returns {boolean} true when at least the render targets were refreshed
   */
  renderLightOverrideMasks(renderer, camera, windowLightScene = null) {
    if (!this._initialized || !this._enabled || !renderer || !camera) {
      this._invalidateLightMaskPrepassCache();
      return false;
    }
    if (!this._lightRT) {
      this._invalidateLightMaskPrepassCache();
      return false;
    }
    this._perfSession.lightOverrideDraws += 1;
    this._bindPerfRecorder();
    this._lastCompositorRenderer = renderer;
    this._syncWindowLightEmitContext(renderer);

    let _perfToken = this._beginPerfSpan('lightOverride.setup', 'render', { cpuOnly: true });
    if (!this._lightsSynced) {
      this.syncAllLights();
    }

    const enhancementCount = this._getLightEnhancementConfigMap().size;
    if (this._lightsSynced && enhancementCount !== this._lastEnhancementCount) {
      this._invalidateEnhancementCache();
      this.syncAllLights();
    }

    renderer.getDrawingBufferSize(this._sizeVec);
    const w = Math.max(1, this._sizeVec.x);
    const h = Math.max(1, this._sizeVec.y);
    this._syncRenderTargetSizes(w, h);

    // Match the later compose pass' current-frame Levels perspective.
    this._markPerspectiveRefreshDirty();
    this._refreshLightsForLevelsPerspectiveIfNeeded(
      (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? (performance.now() / 1000)
        : 0
    );
    this._pushLightBufferUniformsToMeshes();
    this._pushPointLightFalloffUniforms();
    this._endPerfSpan(_perfToken);

    const prepassFloor = Number.isFinite(this._renderFloorIndexForLights)
      ? Number(this._renderFloorIndexForLights)
      : (this._lightingPerspectiveContext?.activeFloorIndex ?? 0);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevLayerMask = camera.layers.mask;

    try {
      camera.layers.enableAll();

      _perfToken = this._beginPerfSpan('lightOverride.foundryDraw', 'render', { cpuOnly: true });
      renderer.setRenderTarget(this._lightRT);
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = true;
      if (this._lightScene) {
        renderer.render(this._lightScene, camera);
      }
      this._endPerfSpan(_perfToken);

      // Window glow for shadow lift is written to WindowLightEffectV2._emitRT (scene-UV).
      _perfToken = this._beginPerfSpan('lightOverride.windowDraw.bind', 'render', { cpuOnly: true });
      if (windowLightScene) {
        try {
          const wle = this._resolveWindowLightEffect();
          const emitW = wle?._emitRT?.width ?? 1;
          const emitH = wle?._emitRT?.height ?? 1;
          windowLightScene.userData?.onBindWindowLightPass?.(emitW, emitH, camera);
        } catch (_) {}
      }
      this._endPerfSpan(_perfToken);

      _perfToken = this._beginPerfSpan('lightOverride.windowDraw.sceneDraw', 'render', {
        gpuSlot: { index: 0, count: 2 },
      });
      if (windowLightScene) {
        if (typeof windowLightScene.userData?.drawWindowLightPass === 'function') {
          windowLightScene.userData.drawWindowLightPass(renderer, camera, { purpose: 'shadowLift' });
        } else {
          renderer.render(windowLightScene, camera);
        }
      }
      this._endPerfSpan(_perfToken);

      _perfToken = this._beginPerfSpan('lightOverride.windowDraw.outdoorsClip', 'render', { cpuOnly: true });
      this._endPerfSpan(_perfToken);
    } finally {
      camera.layers.mask = prevLayerMask;
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }

    this._markLightMaskPrepassFoundryDraw(w, h, prepassFloor);
    return true;
  }

  /**
   * Execute the lighting post-processing pass:
   *   1. Render light meshes → lightRT (Foundry sources only)
   *   1b. Render windowLightScene → WindowLightEffectV2 emit RT
   *   2. Render darkness meshes → darknessRT
   *   3. Compose: sceneRT * (ambient + lights - darkness) → outputRT
   *
   * Compose merges window glow additively after `litColor = baseColor * totalIllumination`.
   * Window emit is bound only when Pass 1b runs (effect enabled + valid emit). Roof masks gate window independently.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera - The main perspective camera
   * @param {THREE.WebGLRenderTarget} sceneRT - Bus scene input
   * @param {THREE.WebGLRenderTarget} outputRT - Where to write the lit result
   * @param {THREE.Scene|null} [windowLightScene=null] - Optional scene rendered
   *   into the window emit RT (not combined with Foundry lights until compose).
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
   * @param {THREE.Texture|null} [outdoorsMaskTexture=null] - Authored `_Outdoors`
   *   mask in scene UV. Also gates window glow at compose (outdoors-first per level).
   * @param {THREE.Texture|null} [ceilingTransmittanceTexture=null] - Half-res R
   *   packed T from {@link LightingEffectV2#ceilingTransmittanceTextureForLighting}
   *   (roof visibility × blocker), or null.
   * @param {THREE.Texture|null} [overheadRoofRestrictLightTexture=null] - Screen-space
   *   mask of overhead tiles with Foundry Restrict light (for dynamic-light gating).
   * @param {THREE.Texture|null} [combinedShadowTexture=null] - Unified shadow factor
   *   from ShadowManagerV2 (cloud + overhead composition).
   * @param {THREE.Texture|null} [combinedShadowRawTexture=null] - Optional unified
   *   raw-shadow variant used on roof pixels.
   * @param {THREE.Texture|null} [paintedShadowLitTexture=null] - Lit factor from
   *   PaintedShadowEffectV2 (same as ShadowManager tPaintedShadow). When set, compose
   *   isolates painted darkening from dynamic shadow lift.
   * @param {number} [paintedShadowMgrOpacity=1] - ShadowManagerV2 `paintedOpacity`;
   *   must match combine pass when splitting painted from combined shadow.
   */
  render(renderer, camera, sceneRT, outputRT, windowLightScene = null, cloudShadowTexture = null, cloudShadowRawTexture = null, buildingShadowTexture = null, overheadShadowTexture = null, buildingShadowOpacity = 0.75, overheadRoofAlphaTexture = null, overheadRoofBlockTexture = null, outdoorsMaskTexture = null, ceilingTransmittanceTexture = null, overheadRoofRestrictLightTexture = null, combinedShadowTexture = null, combinedShadowRawTexture = null, paintedShadowLitTexture = null, paintedShadowMgrOpacity = 1.0, paintedShadowAtAndAboveLitTexture = null, paintedShadowInCombined = true, vegetationBillboardShadowTexture = null, vegetationBillboardOpacity = 1.0) {
    if (!this._initialized || !this._enabled || !sceneRT) return;
    if (!this._lightRT || !this._windowLightRT || !this._darknessRT || !this._composeMaterial) return;
    this._windowComposeBlitValid = false;
    this._bindPerfRecorder();
    if (renderer) {
      this._lastCompositorRenderer = renderer;
      this._syncWindowLightEmitContext(renderer);
    }

    let _perfToken = this._beginPerfSpan('composeDarknessUniforms', 'render', { cpuOnly: true });
    // FloorCompositor can call render() on multiple levels per frame; keep calendar
    // darkness/day-weight current even if update() was skipped (populate-slim path).
    this._syncComposeDarknessUniforms();
    this._pushEffectiveAmbientUniforms(this._composeMaterial?.uniforms);
    this._endPerfSpan(_perfToken);

    _perfToken = this._beginPerfSpan('syncLights', 'render', { cpuOnly: true });
    // Lazy sync lights on first render frame
    if (!this._lightsSynced) {
      this.syncAllLights();
      // One-shot diagnostic: confirm pipeline inputs are valid.
      log.info('LightingEffectV2 first render:',
        'sceneRT', sceneRT?.width, 'x', sceneRT?.height,
        '| lightRT', this._lightRT?.width, 'x', this._lightRT?.height,
        '| windowEmitRT', this._resolveWindowLightEffect()?._emitRT?.width, 'x', this._resolveWindowLightEffect()?._emitRT?.height,
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
    this._endPerfSpan(_perfToken);

    _perfToken = this._beginPerfSpan('syncRtSizes', 'render', { cpuOnly: true });
    // Ensure RTs match drawing buffer size
    renderer.getDrawingBufferSize(this._sizeVec);
    const w = Math.max(1, this._sizeVec.x);
    const h = Math.max(1, this._sizeVec.y);

    this._syncRenderTargetSizes(w, h);
    this._endPerfSpan(_perfToken);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    _perfToken = this._beginPerfSpan('roofOcclusionUniforms', 'render', { cpuOnly: true });
    const persp = this._lightingPerspectiveContext ?? createLightingPerspectiveContext();
    const cu0 = this._composeMaterial.uniforms;
    const transmissionEnabled = this.params.upperFloorTransmissionEnabled === true;
    const rawTransmission = Number(this.params.upperFloorTransmissionStrength);
    const transmission = transmissionEnabled && Number.isFinite(rawTransmission)
      ? Math.max(0, Math.min(1, rawTransmission))
      : 0;
    const occlusionWeight = 1.0 - transmission;
    const restrictRoofToTop = this.params.restrictRoofScreenLightOcclusionToTopFloor === true;
    const renderFloorForOcclusion = Number.isFinite(this._renderFloorIndexForLights)
      ? Number(this._renderFloorIndexForLights)
      : persp.activeFloorIndex;
    const roofScreenOcclusionScale = (typeof persp.getRoofScreenOcclusionScaleForFloor === 'function')
      ? persp.getRoofScreenOcclusionScaleForFloor(renderFloorForOcclusion, restrictRoofToTop)
      : persp.getRoofScreenOcclusionScale(restrictRoofToTop);
    cu0.uApplyRoofOcclusionToSources.value = occlusionWeight * roofScreenOcclusionScale;
    cu0.uApplyRoofOcclusionToWindow.value = 0.0;
    cu0.uWindowEmissiveGain.value = Math.max(0.0, Number(this.params.windowEmissiveGain) || 1.0);
    cu0.uWindowIndirectContrast.value = Math.max(
      0.35,
      Math.min(1.25, Number(this.params.windowIndirectContrast) ?? 0.65),
    );
    cu0.uWindowWarmthTint.value = clamp01(Number(this.params.windowWarmthTint) ?? 0.62);
    cu0.uWindowAlbedoCoupling.value = Math.max(0, Number(this.params.windowAlbedoCoupling) ?? 0.78);
    cu0.uWindowScreenSpill.value = Math.max(0, Number(this.params.windowScreenSpill) ?? 0.55);
    this._endPerfSpan(_perfToken);

    _perfToken = this._beginPerfSpan('perspectiveRefresh', 'render', { cpuOnly: true });
    // FloorCompositor may invoke render() once per visible level per frame; an earlier pass
    // clears _perspectiveRefreshDirty so later passes must not skip visibility refresh.
    this._markPerspectiveRefreshDirty();
    this._refreshLightsForLevelsPerspectiveIfNeeded(
      (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? (performance.now() / 1000)
        : 0
    );
    this._endPerfSpan(_perfToken);

    _perfToken = this._beginPerfSpan('pushLightGain', 'render', { cpuOnly: true });
    this._pushLightBufferUniformsToMeshes();
    this._pushPointLightFalloffUniforms();
    this._endPerfSpan(_perfToken);

    const renderFloorForLights = Number.isFinite(this._renderFloorIndexForLights)
      ? Number(this._renderFloorIndexForLights)
      : (persp.activeFloorIndex ?? 0);
    const reuseFoundryPrepass = this._canReuseLightMaskPrepassFoundryDraw(w, h, renderFloorForLights);

    // ── Pass 1: Accumulate Foundry light mesh contributions ───────────
    // Save camera layer mask — ThreeLightSource meshes live on layer 0.
    const prevLayerMask = camera.layers.mask;
    camera.layers.enableAll();

    if (reuseFoundryPrepass) {
      this._perfSession.prepassReuse += 1;
      _perfToken = this._beginPerfSpan('lightSourcesDraw.reusePrepass', 'render', { cpuOnly: true });
      this._endPerfSpan(_perfToken);
    } else {
      this._perfSession.prepassRedraw += 1;
      _perfToken = this._beginPerfSpan('lightSourcesDraw', 'render', { cpuOnly: true });
      renderer.setRenderTarget(this._lightRT);
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = true;
      if (this._lightScene) {
        renderer.render(this._lightScene, camera);
      }
      this._lightRtContentFloor = renderFloorForLights;
      this._endPerfSpan(_perfToken);
    }

    // ── Pass 1b: Window glow → WindowLightEffectV2 emit RT (compose samples emit) ─
    if (windowLightScene) {
      try {
        const wle = this._resolveWindowLightEffect();
        const emitW = wle?._emitRT?.width ?? 1;
        const emitH = wle?._emitRT?.height ?? 1;
        _perfToken = this._beginPerfSpan('windowLightDraw.bind', 'render', { cpuOnly: true });
        try {
          // WindowLight shaders use gl_FragCoord / uScreenSize for roof/ceiling masks.
          // uScreenSize must match the emit RT, not the drawing buffer.
          windowLightScene.userData?.onBindWindowLightPass?.(emitW, emitH, camera);
        } catch (_) {}
        this._endPerfSpan(_perfToken);

        _perfToken = this._beginPerfSpan('windowLightDraw.sceneDraw', 'render', {
          gpuSlot: { index: 0, count: 2 },
        });
        try {
          if (typeof windowLightScene.userData?.drawWindowLightPass === 'function') {
            windowLightScene.userData.drawWindowLightPass(renderer, camera, { purpose: 'full' });
          } else {
            renderer.render(windowLightScene, camera);
          }
        } finally {
          this._endPerfSpan(_perfToken);
        }

        _perfToken = this._beginPerfSpan('windowLightDraw.outdoorsClip', 'render', { cpuOnly: true });
        this._endPerfSpan(_perfToken);
      } catch (err) {
        log.error('LightingEffectV2: window light render failed:', err);
      }

    }

    // ── Pass 2: Accumulate darkness contributions ─────────────────────
    _perfToken = this._beginPerfSpan('darknessDraw', 'render', { cpuOnly: true });
    renderer.setRenderTarget(this._darknessRT);
    renderer.setClearColor(0x000000, 1);
    renderer.autoClear = true;
    if (this._darknessScene) {
      renderer.render(this._darknessScene, camera);
    }
    this._endPerfSpan(_perfToken);

    // Restore camera layer mask
    camera.layers.mask = prevLayerMask;

    // ── Pass 3: Compose ───────────────────────────────────────────────
    _perfToken = this._beginPerfSpan('composeUniforms.coreTextures', 'render', { cpuOnly: true });
    const cu = this._composeMaterial.uniforms;
    cu.tScene.value = sceneRT.texture;
    cu.tLightSources.value = this._lightRT.texture;
    const wleCompose = this._resolveWindowLightEffect();
    const winIntensity = Math.max(0.0, Number(wleCompose?.params?.intensity) || 0);
    const winTex = (windowLightScene
      && resolveEffectEnabled(wleCompose)
      && winIntensity > 1e-5
      && wleCompose?._emitComposeValid === true)
      ? (wleCompose.getEmitTexture?.() ?? null)
      : null;
    cu.tLightWindow.value = winTex;
    cu.uHasLightWindow.value = winTex ? 1.0 : 0.0;
    cu.uWindowLightScreenSpace.value = 0.0;
    this._pushEffectiveAmbientUniforms(cu);
    cu.tDarkness.value = this._darknessRT.texture;
    this._endPerfSpan(_perfToken);

    _perfToken = this._beginPerfSpan('composeUniforms.shadowInputs', 'render', { cpuOnly: true });
    // Phase 4: ShadowManagerV2's combined shadow factor is the single shadow
    // input. The legacy cloud-only path was removed; if combined is absent,
    // the shader simply applies no shadow term.
    const hasComb = !!combinedShadowTexture;
    cu.uHasCombinedShadow.value = hasComb ? 1 : 0;
    cu.tUnifiedShadowFactor.value = combinedShadowTexture ?? null;
    const bTex = buildingShadowTexture ?? null;
    cu.tBuildingShadowLit.value = bTex;
    cu.uHasBuildingShadowLit.value = bTex ? 1 : 0;
    cu.tUnifiedShadowRaw.value = (hasComb ? combinedShadowRawTexture : null) ?? null;
    cu.uHasShadowRaw.value = (hasComb && combinedShadowRawTexture) ? 1 : 0;
    if (paintedShadowLitTexture) {
      cu.tPaintedShadowLit.value = paintedShadowLitTexture;
      cu.uHasPaintedShadowLit.value = 1;
    } else {
      cu.tPaintedShadowLit.value = null;
      cu.uHasPaintedShadowLit.value = 0;
    }
    if (paintedShadowAtAndAboveLitTexture) {
      cu.tPaintedShadowAtAndAboveLit.value = paintedShadowAtAndAboveLitTexture;
      cu.uHasPaintedShadowAtAndAboveLit.value = 1;
    } else {
      cu.tPaintedShadowAtAndAboveLit.value = null;
      cu.uHasPaintedShadowAtAndAboveLit.value = 0;
    }
    const psmo = Number(paintedShadowMgrOpacity);
    cu.uPaintedShadowMgrOpacity.value = (Number.isFinite(psmo) ? Math.max(0, Math.min(1, psmo)) : 1.0);
    const litFloorIdx = Number.isFinite(this._renderFloorIndexForLights)
      ? Number(this._renderFloorIndexForLights)
      : 0;
    cu.uLightingPaintedFloorIndex.value = Math.max(0, litFloorIdx);
    cu.uPaintedShadowInCombined.value = paintedShadowInCombined === false ? 0.0 : 1.0;
    if (vegetationBillboardShadowTexture) {
      cu.tVegetationBillboardShadow.value = vegetationBillboardShadowTexture;
      cu.uHasVegetationBillboardShadow.value = 1;
    } else {
      cu.tVegetationBillboardShadow.value = null;
      cu.uHasVegetationBillboardShadow.value = 0;
    }
    const vbo = Number(vegetationBillboardOpacity);
    cu.uVegetationBillboardOpacity.value = Number.isFinite(vbo) ? Math.max(0, Math.min(1, vbo)) : 1.0;
    this._endPerfSpan(_perfToken);

    _perfToken = this._beginPerfSpan('composeUniforms.viewScene', 'render', { cpuOnly: true });
    // View→scene UV uniforms for compose (_Outdoors roof-light gate; building
    // shadow no longer sampled here — ShadowManagerV2 combines it upstream).
    this._syncViewSceneUniforms(camera);
    this._endPerfSpan(_perfToken);

    _perfToken = this._beginPerfSpan('composeUniforms.roofMasks', 'render', { cpuOnly: true });
    if (outdoorsMaskTexture) {
      this._normalizeOutdoorsMaskTexture(outdoorsMaskTexture);
      cu.tOutdoorsForRoofLight.value = outdoorsMaskTexture;
      cu.uHasOutdoorsForRoofLight.value = 1;
      cu.uOutdoorsForRoofLightFlipY.value = outdoorsMaskTexture.flipY ? 1.0 : 0.0;
      const tw = Number(outdoorsMaskTexture._msaWidth) || 0;
      const th = Number(outdoorsMaskTexture._msaHeight) || 0;
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
    if (overheadRoofRestrictLightTexture) {
      cu.tOverheadRoofRestrictLight.value = overheadRoofRestrictLightTexture;
      cu.uHasOverheadRoofRestrictLight.value = 1;
    } else {
      cu.tOverheadRoofRestrictLight.value = null;
      cu.uHasOverheadRoofRestrictLight.value = 0;
    }
    // Phase 4: legacy `tOverheadShadow` binding removed. OverheadShadowsEffectV2
    // now contributes through ShadowManagerV2's combined shadow texture only.
    this._endPerfSpan(_perfToken);

    this._perfSession.composeDraws += 1;
    _perfToken = this._beginPerfSpan('composeDraw', 'render', {
      gpuSlot: { index: 1, count: 2 },
    });
    renderer.setRenderTarget(outputRT);
    renderer.setClearColor(0x000000, 1);
    renderer.autoClear = true;
    renderer.render(this._composeScene, this._composeCamera);
    this._endPerfSpan(_perfToken);

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
    this._lastRtSizeState.w = -1;
    this._syncRenderTargetSizes(rw, rh);
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
      raw = scene.flags?.[MODULE_ID]?.[LIGHT_ENHANCEMENT_FLAG_KEY]
        ?? scene.getFlag?.(MODULE_ID, LIGHT_ENHANCEMENT_FLAG_KEY);
    } catch (_) {}

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
    try { this._windowEmitBlitMaterial?.dispose(); } catch (_) {}
    try {
      const wq = this._windowEmitBlitScene?.children?.[0];
      wq?.geometry?.dispose?.();
    } catch (_) {}
    try { this._stackedLightRtA?.dispose(); } catch (_) {}
    try { this._stackedLightRtB?.dispose(); } catch (_) {}
    try { this._stackLightMaterial?.dispose(); } catch (_) {}
    try {
      const sq = this._stackLightScene?.children?.[0];
      sq?.geometry?.dispose?.();
    } catch (_) {}
    try { this._darknessRT?.dispose(); } catch (_) {}
    try {
      this.ceilingTransmittanceTarget?.dispose();
    } catch (_) {}
    try { this._ceilingTransmittanceMaterial?.dispose(); } catch (_) {}
    if (this._ceilingTransmittanceScene) {
      const ch = this._ceilingTransmittanceScene.children?.[0];
      if (ch?.geometry) ch.geometry.dispose();
      this._ceilingTransmittanceScene = null;
    }
    this._ceilingTransmittanceCamera = null;
    try { this._composeMaterial?.dispose(); } catch (_) {}
    try { this._composeQuad?.geometry?.dispose(); } catch (_) {}

    this._lightScene = null;
    this._darknessScene = null;
    this._lightRT = null;
    this._windowLightRT = null;
    this._windowComposeBlitValid = false;
    this._windowEmitBlitScene = null;
    this._windowEmitBlitCamera = null;
    this._windowEmitBlitMaterial = null;
    this._stackedLightRtA = null;
    this._stackedLightRtB = null;
    this._stackedLightResult = null;
    this._stackLightScene = null;
    this._stackLightCamera = null;
    this._stackLightMaterial = null;
    this._stackedLightActive = false;
    this._stackedLightLayerCount = 0;
    this._darknessRT = null;
    this.ceilingTransmittanceTarget = null;
    this._ceilingTransmittanceMaterial = null;
    this._composeScene = null;
    this._composeCamera = null;
    this._composeMaterial = null;
    this._composeQuad = null;
    this._lightsSynced = false;
    this._lastEnhancementCount = -1;
    this._invalidateEnhancementCache();
    this._perspectiveRefreshDirty = true;
    this._lastPerspectiveRefreshAtSec = -Infinity;
    this._lastCompositorRenderer = null;
    this._initialized = false;
    this._lightingPerspectiveContext = null;
    this._renderFloorIndexForLights = null;
    this._lightRtContentFloor = null;
    this._invalidateLightMaskPrepassCache();
    this._legacyGlobalIlluminationSeeded = false;

    log.info('LightingEffectV2 disposed');
  }
}
