/**
 * @fileoverview V2 Water Splashes Effect — per-floor particle systems from _Water masks.
 *
 * HEALTH-WIRING BADGE (Map Shine Breaker Box):
 * If you change populate/init, BatchedRenderer wiring, per-floor `_floorStates`,
 * or the water-enabled gating path, you MUST update HealthEvaluator contracts for
 * `WaterSplashesEffectV2` (and edges from `WaterEffectV2`) to prevent silent failures.
 *
 * Architecture:
 *   Owns a three.quarks BatchedRenderer added to the FloorRenderBus scene via
 *   addEffectOverlay(). For each tile with a `_Water` mask, scans the mask on
 *   the CPU to build edge (shoreline) and interior spawn point lists, then
 *   creates foam plume + rain splash particle systems. Systems are grouped by
 *   floor index. All floors from ground through the active level (that have
 *   splash data) stay attached so lower-level water is visible when looking
 *   downward from above.
 *
 * Follows the same proven pattern as FireEffectV2:
 *   - Self-contained V2 class with its own BatchedRenderer
 *   - worldSpace: true — absolute world-space particle positions
 *   - Emitters as children of BatchedRenderer (transitive scene membership)
 *   - Async texture loading with await before system creation
 *   - Non-zero emission rates (no bridge / external data dependency)
 *   - Floor-aware system swapping
 *   - Added to bus via renderBus.addEffectOverlay()
 *
 * Replaces the legacy 3-layer foam bridge:
 *   WaterEffectV2._syncLegacyFoamParticles → WeatherParticlesV2 → WeatherParticles._foamSystem
 *
 * @module compositor-v2/effects/WaterSplashesEffectV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { probeMaskFile } from '../../assets/loader.js';
import {
  tileHasLevelsRange,
  readTileLevelsFlags,
  resolveV14NativeDocFloorIndexMin,
  getViewedLevelBackgroundSrc,
  hasV14NativeLevels,
} from '../../foundry/levels-scene-flags.js';
// OVERLAY_THREE_LAYER intentionally not imported — splashes use layer 0 only
// and rely on LayerOrderPolicy FLOOR_EFFECTS band for correct stacking.
import {
  WaterEdgeMaskShape,
  WaterInteriorMaskShape,
  FoamPlumeLifecycleBehavior,
  SplashRingLifecycleBehavior,
  scanWaterEdgePoints,
  scanWaterInteriorPoints,
} from './water-splash-behaviors.js';
import {
  ParticleSystem as QuarksParticleSystem,
  BatchedRenderer,
  IntervalValue,
  ColorRange,
  Vector4,
  RenderMode,
  ConstantValue,
} from '../../libs/three.quarks.module.js';

import {
  GROUND_Z,
  effectUnderOverheadOrder,
} from '../LayerOrderPolicy.js';
import { resolveEffectWindWorld } from './resolve-effect-wind.js';

const log = createLogger('WaterSplashesV2');

/** Detect legacy splash darken block for one-shot shader upgrade. */
const SHADOW_DARKEN_V1_ANCHOR = '// MS_WATER_SPLASHES_SHADOW_DARKEN_V1';

/** Strip/replace prior volume modulation when upgrading splash shaders. */
const SPLASH_VOLUME_BEGIN = '// MS_WATER_SPLASHES_VOLUME_PRE_TONE_BEGIN';
const SPLASH_VOLUME_END = '// MS_WATER_SPLASHES_VOLUME_PRE_TONE_END';

/** Stronger crest lift in daytime (linear, before tone map) — night stays ~unchanged via `day`. */
const SPLASH_PRE_TONE_SUN_RIM = 2.06;
/** Darker splash centre vs hotspot rim for perceptual sparkle (HDR before tone map). */
const SPLASH_VOL_BOWL_IN = 0.72;
const SPLASH_VOL_BOWL_OUT = 1.09;
/** Extra rim gain on top of crest (day-gated inside GLSL). */
const SPLASH_PRE_TONE_SUN_CREST_PLUS = 0.72;

/**
 * Radial variation before `#include <tonemapping_fragment>`: dim disk interiors vs hot rim so
 * sunlit foam reads sparkly; `uSplashAmbientDay` scales only daytime punch.
 */
const SPLASH_VOLUME_PRE_TONE_FS = `
  ${SPLASH_VOLUME_BEGIN}
#ifdef USE_UV
  {
    float _sr = clamp(length(vUv - vec2(0.5)) * 2.0, 0.0, 1.0);
    float _day = clamp(uSplashAmbientDay, 0.0, 1.0);
    float _bowl = mix(${SPLASH_VOL_BOWL_IN.toFixed(3)}, ${SPLASH_VOL_BOWL_OUT.toFixed(3)},
      smoothstep(0.04, 0.86, _sr));
    float _crest = 1.0 + (${(0.22).toFixed(3)} + ${SPLASH_PRE_TONE_SUN_CREST_PLUS.toFixed(3)} * _day) * smoothstep(0.62, 0.997, _sr);
    float _sunRim = mix(1.0, ${SPLASH_PRE_TONE_SUN_RIM.toFixed(3)},
      _day * smoothstep(0.68, 0.997, _sr));
    gl_FragColor.rgb *= _bowl * _crest * _sunRim;
  }
#endif
  ${SPLASH_VOLUME_END}
`;

/** @param {string} fs */
function stripSplashVolumeBlock(fs) {
  if (typeof fs !== 'string') return fs;
  const re = new RegExp(
    '\\n?\\s*' + SPLASH_VOLUME_BEGIN.replace(/\//g, '\\/').replace(/\./g, '\\.') + '[\\s\\S]*?' +
    SPLASH_VOLUME_END.replace(/\//g, '\\/').replace(/\./g, '\\.') + '\\s*\\n?',
    'g',
  );
  return fs.replace(re, '\n');
}

/**
 * @param {string} fs
 * @returns {string}
 */
function injectSplashVolumeBeforeTonemapping(fs) {
  if (typeof fs !== 'string') return fs;
  let s = stripSplashVolumeBlock(fs);
  const tonemap = '#include <tonemapping_fragment>';
  if (!s.includes(tonemap)) return s;
  return s.replace(tonemap, `${SPLASH_VOLUME_PRE_TONE_FS}\n\t${tonemap}`);
}

/** Injected into patched particle fragment shaders (screen UV, same as ShadowManager). */
const SPLASH_SHADOW_UNIFORM_DECL =
  'uniform sampler2D uCombinedShadowMap;\n' +
  'uniform sampler2D uCombinedShadowMapRaw;\n' +
  'uniform float uHasCombinedShadowRaw;\n' +
  'uniform float uSplashAmbientDay;\n';

/**
 * Ground lighting for foam/splashes ({@link SHADOW_DARKEN_FS}): conservative occlusion
 * (min filtered + raw), a steep shade curve toward open water, plus a daylight axis from sky
 * / Foundry darkness so noon can hit white spray without glowing at night.
 */
const SPLASH_OCCLUSION_DEADBAND = 0.055;
const SPLASH_OCCLUSION_POWER = 2.02;
const SPLASH_OCCLUSION_RGB_FLOOR = 0.032;
/** Base linear multiplier before daylight / occlusion shoulders (post-tone). */
const SPLASH_SURFACE_RGB_GAIN = 2.52;
/** Extra multiplication when shadows show open sky / sun-lit water (`occ` gate). */
const SPLASH_NOON_RGB_BOOST = 4.62;
/** Lower ⇒ noon curve engages earlier ⇒ brighter shafts without raising shadow floors. */
const SPLASH_NOON_OPEN_GATE = 0.325;
/** Headroom — real display still clamps later; avoids flattening mids in the multiplier. */
const SPLASH_RGB_POST_CAP = 48.0;
const SPLASH_ALPHA_OCCLUSION_FLOOR = 0.34;
/** Post-tone HDR shoulder: ramps extra gain toward sun-lit open water. */
const SPLASH_SUN_SHOULDER_MAX = 4.85;
/** Soft-open × occ used for shoulders (moderates shadow edge chatter). */
const SPLASH_SUN_OPEN_POW = 0.73;
/** `smoothstep` low edge for sunshine key vs combined shadow luminance `occ`. */
const SPLASH_SUN_OCC_GATE_LO = 0.20;
/** Perceived sparkle: bleach dull sunlit greys toward white (post-tone additive). */
const SPLASH_SUN_VEIL = 1.06;

/**
 * GLSL appended after `#include <tonemapping_fragment>` so shadow response is not
 * undone by tone mapping; scales RGB and alpha for foam/splashes/bubbles.
 */
const SHADOW_DARKEN_FS = `
  // MS_WATER_SPLASHES_SHADOW_DARKEN_V10
  {
    vec2 msUv = vec2(
      (gl_FragCoord.x + 0.5) / max(uResolution.x, 1.0),
      (gl_FragCoord.y + 0.5) / max(uResolution.y, 1.0)
    );
    float filt = clamp(texture2D(uCombinedShadowMap, msUv).r, 0.0, 1.0);
    float occ = filt;
    if (uHasCombinedShadowRaw > 0.5) {
      float raw = clamp(texture2D(uCombinedShadowMapRaw, msUv).r, 0.0, 1.0);
      occ = min(filt, raw);
    }
    float open = clamp((occ - ${SPLASH_OCCLUSION_DEADBAND.toFixed(3)}) / max(1.0 - ${SPLASH_OCCLUSION_DEADBAND.toFixed(3)}, 1e-3), 0.0, 1.0);
    float shade = mix(${SPLASH_OCCLUSION_RGB_FLOOR.toFixed(3)}, 1.0, pow(open, ${SPLASH_OCCLUSION_POWER.toFixed(3)}));
    float day = clamp(uSplashAmbientDay, 0.0, 1.0);
    float noon = mix(1.0, ${SPLASH_NOON_RGB_BOOST.toFixed(3)}, day * smoothstep(${SPLASH_NOON_OPEN_GATE.toFixed(3)}, 0.999, occ));
    float sunKey = clamp(day * pow(open, ${SPLASH_SUN_OPEN_POW.toFixed(3)}) * smoothstep(${SPLASH_SUN_OCC_GATE_LO.toFixed(3)}, 1.002, occ), 0.0, 1.0);
    float shoulder = mix(1.0, ${SPLASH_SUN_SHOULDER_MAX.toFixed(3)}, sunKey);
    float rgbMul = clamp(${SPLASH_SURFACE_RGB_GAIN.toFixed(3)} * shade * noon * shoulder, 0.02, ${SPLASH_RGB_POST_CAP.toFixed(2)});
    vec3 tinted = clamp(gl_FragColor.rgb * rgbMul, 0.0, 1.0);
    float peak = max(max(tinted.r, tinted.g), tinted.b);
    float veilNeed = clamp(1.0 - peak * ${(1.18).toFixed(3)}, 0.0, 1.0);
    tinted = clamp(tinted + ${SPLASH_SUN_VEIL.toFixed(3)} * sunKey * veilNeed * sunKey, 0.0, 1.0);
    gl_FragColor.rgb = tinted;
    float aGate = sqrt(open * 0.88 + 0.12);
    float aMul = mix(${SPLASH_ALPHA_OCCLUSION_FLOOR.toFixed(3)}, 1.0, aGate);
    gl_FragColor.a = clamp(gl_FragColor.a * aMul, 0.0, 1.0);
  }
`;

/**
 * Strip misplaced darken blocks, prepend splash volume modulation, append shadow darken after tonemap.
 * @param {string} fs
 * @returns {string}
 */
function patchSplashParticleFragmentShader(fs) {
  let s = injectSplashVolumeBeforeTonemapping(fs);
  return injectShadowDarkenAfterTonemapping(s);
}

/**
 * Strip misplaced V2–V10 darken blocks, then append darken after tonemapping when present.
 * @param {string} fs
 * @returns {string}
 */
function injectShadowDarkenAfterTonemapping(fs) {
  let s = fs
    .replace(/\/\/ MS_WATER_SPLASHES_SHADOW_DARKEN_V2\s*\{[\s\S]*?\}\s*/g, '')
    .replace(/\/\/ MS_WATER_SPLASHES_SHADOW_DARKEN_V3\s*\{[\s\S]*?\}\s*/g, '')
    .replace(/\/\/ MS_WATER_SPLASHES_SHADOW_DARKEN_V4\s*\{[\s\S]*?\}\s*/g, '')
    .replace(/\/\/ MS_WATER_SPLASHES_SHADOW_DARKEN_V5\s*\{[\s\S]*?\}\s*/g, '')
    .replace(/\/\/ MS_WATER_SPLASHES_SHADOW_DARKEN_V6\s*\{[\s\S]*?\}\s*/g, '')
    .replace(/\/\/ MS_WATER_SPLASHES_SHADOW_DARKEN_V7\s*\{[\s\S]*?\}\s*/g, '')
    .replace(/\/\/ MS_WATER_SPLASHES_SHADOW_DARKEN_V8\s*\{[\s\S]*?\}\s*/g, '')
    .replace(/\/\/ MS_WATER_SPLASHES_SHADOW_DARKEN_V9\s*\{[\s\S]*?\}\s*/g, '')
    .replace(/\/\/ MS_WATER_SPLASHES_SHADOW_DARKEN_V10\s*\{[\s\S]*?\}\s*/g, '');
  const tonemap = '#include <tonemapping_fragment>';
  if (s.includes(tonemap)) {
    return s.replace(tonemap, `${tonemap}\n${SHADOW_DARKEN_FS}`);
  }
  if (s.includes('#include <soft_fragment>')) {
    return s.replace('#include <soft_fragment>', `#include <soft_fragment>${SHADOW_DARKEN_FS}`);
  }
  return `${s}${SHADOW_DARKEN_FS}`;
}

/** Legacy uniform block injected before V2 (removed from new patches). */
const SHADOW_DECL_V1_LEGACY =
  'uniform sampler2D uBuildingShadowMap;\n' +
  'uniform float uHasBuildingShadow;\n' +
  'uniform float uBuildingShadowOpacity;\n' +
  'uniform vec2 uBldSceneOrigin;\n' +
  'uniform vec2 uBldSceneSize;\n' +
  'uniform vec2 uCanvasDimensions;\n' +
  'uniform sampler2D uOverheadShadowMap;\n' +
  'uniform float uHasOverheadShadow;\n' +
  'uniform float uOverheadShadowOpacity;\n' +
  'uniform sampler2D uCombinedShadowMap;\n' +
  'uniform float uHasCombinedScreenShadow;\n';

// Spatial bucket size for splitting large water masks into smaller emitters (px).
const BUCKET_SIZE = 2500;

const WATER_MASK_FORMATS = ['webp', 'png', 'jpg', 'jpeg'];
const WATER_SPLASH_BATCH_OVERLAY_PREFIX = 'ms_water_splash_batch_';

// ─── WaterSplashesEffectV2 ──────────────────────────────────────────────────

export class WaterSplashesEffectV2 {
  /**
   * @param {import('../FloorRenderBus.js').FloorRenderBus} renderBus
   */
  constructor(renderBus) {
    this._renderBus = renderBus;
    this._enabled = true;
    this._initialized = false;

    /**
     * Scalar cache for shared splash occlusion uniforms (resolution, water mask, etc.).
     * Per-system floor-presence texture is tracked separately on userData.
     * @type {{ vf:number, wm:string|null, wmv:number, rx:number, ry:number, sbx:number, sby:number, sbw:number, sbh:number, gen:number }|null}
     */
    this._lastOcclusionGlobals = null;
    /** @type {string|null} Last compact per-floor occlusion binding diagnostic key. */
    this._lastOcclusionSelectionLogKey = null;

    /** Bumped when `onFloorChange` actually changes which floors are active. @type {number} */
    this._activeFloorsGeneration = 0;

    /**
     * Cached drawing-buffer pixel size (DPR-scaled). Refreshed on compositor resize
     * and init — avoids per-frame getDrawingBufferSize on the renderer.
     * @type {number}
     */
    this._drawingBufferW = 1;
    /** @type {number} */
    this._drawingBufferH = 1;

    /**
     * Throttle view-dependent spawn filtering; setViewBoundsUv currently allocates.
     * @type {number}
     */
    this._lastViewSpawnUpdateAtMs = 0;

    // Cache for direct mask probing so we don't repeatedly 404-spam hosted setups.
    // Key: basePathWithSuffix + formats. Value: { url, image } or null when missing.
    this._directMaskCache = new Map();

    /** @type {Map<number, BatchedRenderer>} per-floor quarks batch renderers */
    this._batchRenderers = new Map();

    /**
     * Per-floor cached system sets. Key: floorIndex.
     * Value: { foamSystems: QuarksParticleSystem[], splashSystems: [] }
     * @type {Map<number, object>}
     */
    this._floorStates = new Map();

    /**
     * Set of floor indices whose systems are currently in the BatchedRenderer.
     * @type {Set<number>}
     */
    this._activeFloors = new Set();

    /** @type {THREE.Texture|null} Foam sprite texture (foam.webp) */
    this._foamTexture = null;
    /** @type {THREE.Texture|null} Generic particle texture for splash rings */
    this._splashTexture = null;
    /** @type {Promise<void>|null} Resolves when sprite textures are loaded */
    this._texturesReady = null;

    /** @type {boolean} One-time debug log guard for populate point counts */
    this._loggedPopulateCountsOnce = false;

    /** @type {boolean} One-time debug log guard for runtime registration probes */
    this._loggedRuntimeDebugOnce = false;

    /** @type {THREE.Vector2|null} reused drawing-buffer size vector */
    this._tempVec2 = null;

    /** 1×1 white — bound when combined shadow RT is not ready so the shader always samples a valid texture. */
    this._combinedShadowFallbackTex = null;

    /** @type {{ sx:number, syWorld:number, sw:number, sh:number }|null} cached scene bounds for mask sampling */
    this._sceneBounds = null;

    /** @type {Array<QuarksParticleSystem>} reused systems list */
    this._tempSystems = [];

    /** @type {Array<QuarksParticleSystem>} reused foam systems list */
    this._tempFoamSystems = [];
    /** @type {Array<QuarksParticleSystem>} reused splash systems list */
    this._tempSplashSystems = [];

    /** @type {Array<QuarksParticleSystem>} snapshot of all active-floor systems (updated in onFloorChange) */
    this._activeSystemsFlat = [];

    /**
     * Hardcoded parameters for the built-in underwater bubbles layer.
     * These are intentionally not exposed to the UI — edit here to tune.
     * The bubbles layer runs inside the same BatchedRenderer as splashes.
     */
    this.bubblesParams = {
      enabled: true,

      tintStrength: 1.41,
      tintJitter: 1.0,
      tintAColorR: 0.74,
      tintAColorG: 0.8,
      tintAColorB: 0.71,
      tintBColorR: 0.51,
      tintBColorG: 0.87,
      tintBColorB: 0.76,

      foamEnabled: true,
      foamRate: 14.8,
      foamSizeMin: 35,
      foamSizeMax: 373,
      foamLifeMin: 1.2,
      foamLifeMax: 3.25,
      foamPeakOpacity: 0.88,
      foamColorR: 0.97,
      foamColorG: 0.982,
      foamColorB: 1.0,
      foamWindDriftScale: 2,

      splashEnabled: true,
      splashRate: 47,
      splashSizeMin: 35,
      splashSizeMax: 77,
      splashLifeMin: 0.3,
      splashLifeMax: 0.8,
      splashPeakOpacity: 0.7,
      splashWindDriftScale: 1.0,
    };

    // Controller wrapper so the V2 UI callback can target `_waterSplashesEffect.bubbles`
    // and use the same param propagation + persistence logic as other effects.
    // This is intentionally a thin proxy over `bubblesParams`.
    this.bubbles = {
      params: this.bubblesParams,
      get enabled() { return !!this.params.enabled; },
      set enabled(v) { this.params.enabled = !!v; },
    };

    // Effect parameters — tuneable from Tweakpane UI.
    this.params = {
      enabled: true,

      // Tint jitter (applied in lifecycle behaviors)
      tintStrength: 2.0,
      tintJitter: 0.75,
      tintAColorR: 1.24,
      tintAColorG: 1.54,
      tintAColorB: 1.32,
      tintBColorR: 0.10,
      tintBColorG: 0.55,
      tintBColorB: 0.75,

      // Foam plumes (shoreline)
      foamEnabled: true,
      foamRate: 54.3,
      foamSizeMin: 102,
      foamSizeMax: 167,
      foamLifeMin: 0.5,
      foamLifeMax: 1,
      foamPeakOpacity: 0.64,
      foamColorR: 0.17,
      foamColorG: 0.24,
      foamColorB: 0.15,
      foamWindDriftScale: 2,

      // Rain splashes (interior)
      splashEnabled: true,
      splashRate: 234.8,
      splashSizeMin: 99,
      splashSizeMax: 457,
      splashLifeMin: 0.3,
      splashLifeMax: 0.8,
      splashPeakOpacity: 0.84,
      splashWindDriftScale: 1.0,

      // Scan settings
      edgeScanStride: 2,
      interiorScanStride: 4,
      maskThreshold: 0.15,
    };

    log.debug('WaterSplashesEffectV2 created');
  }

  // ── Private: Material patching (floor occlusion) ──────────────────────────

  /**
   * Patch a material (MeshBasicMaterial or ShaderMaterial) to consult the
   * screen-space floor-presence RT and occlude particles under upper-floor tiles.
   *
   * The floor-presence texture is authored by DistortionManager and is already
   * aligned with the main camera using a screen-space prepass.
   * @private
   */
  _patchFloorPresenceMaterial(material) {
    const THREE = window.THREE;
    if (!material || !THREE) return;

    material.userData = material.userData || {};
    let uniforms = material.userData._msFloorPresenceUniforms;
    if (!uniforms) {
      uniforms = {
        uFloorPresenceMap: { value: null },
        uHasFloorPresenceMap: { value: 0.0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uWaterMask: { value: null },
        uHasWaterMask: { value: 0.0 },
        uUseWaterMaskClip: { value: 1.0 },
        uWaterFlipV: { value: 0.0 },
        uSceneBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
        uCombinedShadowMap: { value: null },
        uCombinedShadowMapRaw: { value: null },
        uHasCombinedShadowRaw: { value: 0.0 },
        uSplashAmbientDay: { value: 1.0 },
      };
      material.userData._msFloorPresenceUniforms = uniforms;
    } else {
      if (!uniforms.uCombinedShadowMap) {
        uniforms.uCombinedShadowMap = { value: null };
      }
      if (!uniforms.uCombinedShadowMapRaw) {
        uniforms.uCombinedShadowMapRaw = { value: null };
      }
      if (uniforms.uHasCombinedShadowRaw === undefined) {
        uniforms.uHasCombinedShadowRaw = { value: 0.0 };
      }
      if (uniforms.uSplashAmbientDay === undefined) {
        uniforms.uSplashAmbientDay = { value: 1.0 };
      }
    }

    const isShaderMat = material.isShaderMaterial === true;
    const marker = '/* MS_WATER_SPLASHES_MASKING_V1 */';

    // Sprite batch ShaderMaterial: nothing to do once mask + volume + V10 lighting are present.
    if (isShaderMat && typeof material.fragmentShader === 'string'
      && material.fragmentShader.includes(marker)
      && material.fragmentShader.includes(SPLASH_VOLUME_BEGIN)
      && material.fragmentShader.includes('MS_WATER_SPLASHES_SHADOW_DARKEN_V10')) {
      // One-shot hot upgrade: older masked shaders sampled floor presence from
      // alpha only. Some occluder passes encode coverage in R, so use max(R, A).
      if (material.fragmentShader.includes('texture2D(uFloorPresenceMap, fpScreenUV).a')) {
        material.fragmentShader = material.fragmentShader.replace(
          /float floorPresence = texture2D\(uFloorPresenceMap, fpScreenUV\)\.a;/g,
          'vec4 fpSample = texture2D(uFloorPresenceMap, fpScreenUV);\n    float floorPresence = max(fpSample.r, fpSample.a);'
        );
        material.needsUpdate = true;
      }
      const uni = material.uniforms || (material.uniforms = {});
      uni.uFloorPresenceMap = uniforms.uFloorPresenceMap;
      uni.uHasFloorPresenceMap = uniforms.uHasFloorPresenceMap;
      uni.uResolution = uniforms.uResolution;
      uni.uWaterMask = uniforms.uWaterMask;
      uni.uHasWaterMask = uniforms.uHasWaterMask;
      uni.uUseWaterMaskClip = uniforms.uUseWaterMaskClip;
      uni.uWaterFlipV = uniforms.uWaterFlipV;
      uni.uSceneBounds = uniforms.uSceneBounds;
      uni.uCombinedShadowMap = uniforms.uCombinedShadowMap;
      uni.uCombinedShadowMapRaw = uniforms.uCombinedShadowMapRaw;
      uni.uHasCombinedShadowRaw = uniforms.uHasCombinedShadowRaw;
      uni.uSplashAmbientDay = uniforms.uSplashAmbientDay;
      return;
    }

    // Direct patch path for three.quarks SpriteBatch ShaderMaterial.
    // onBeforeCompile does NOT run for already-compiled ShaderMaterials.
    if (isShaderMat) {
      const uni = material.uniforms || (material.uniforms = {});
      uni.uFloorPresenceMap = uniforms.uFloorPresenceMap;
      uni.uHasFloorPresenceMap = uniforms.uHasFloorPresenceMap;
      uni.uResolution = uniforms.uResolution;

      uni.uWaterMask = uniforms.uWaterMask;
      uni.uHasWaterMask = uniforms.uHasWaterMask;
      uni.uUseWaterMaskClip = uniforms.uUseWaterMaskClip;
      uni.uWaterFlipV = uniforms.uWaterFlipV;
      uni.uSceneBounds = uniforms.uSceneBounds;
      uni.uCombinedShadowMap = uniforms.uCombinedShadowMap;
      uni.uCombinedShadowMapRaw = uniforms.uCombinedShadowMapRaw;
      uni.uHasCombinedShadowRaw = uniforms.uHasCombinedShadowRaw;
      uni.uSplashAmbientDay = uniforms.uSplashAmbientDay;

      let shaderChanged = false;

      // Vertex shader: add varying world position.
      if (typeof material.vertexShader === 'string') {
        const beforeVS = material.vertexShader;
        let vs = material.vertexShader;

        if (!vs.includes('varying vec3 vMsWorldPos')) {
          vs = vs.replace('void main() {', 'varying vec3 vMsWorldPos;\nvoid main() {');
        }

        // Prefer per-vertex world pos for correct sprite clipping. If quarks uses
        // rotatedPosition (billboard corner offset), include it so the varying
        // interpolates across the full quad.
        const hasRotatedPosition = /\brotatedPosition\b/.test(vs);
        const legacyAssign = 'vMsWorldPos = (modelMatrix * vec4(offset, 1.0)).xyz;';
        const desiredAssign = hasRotatedPosition
          ? 'vMsWorldPos = (modelMatrix * vec4(offset, 1.0)).xyz;\n  vMsWorldPos.xy += rotatedPosition;'
          : legacyAssign;

        if (vs.includes(legacyAssign) && !vs.includes(desiredAssign)) {
          vs = vs.replace(legacyAssign, desiredAssign);
        }
        if (!vs.includes('vMsWorldPos =') && vs.includes('#include <soft_vertex>')) {
          vs = vs.replace('#include <soft_vertex>', '#include <soft_vertex>\n  ' + desiredAssign);
        }
        // Fallback: the quarks SpriteBatch shader has neither #include <soft_vertex>
        // nor the legacy assign anchor. Without this, vMsWorldPos stays vec3(0),
        // fails the scene-bounds check, and every particle is fully discarded.
        if (!vs.includes('vMsWorldPos =') && vs.includes('void main()')) {
          const posAttr = /\battribute\s+\S+\s+offset\b/.test(vs) ? 'offset' : 'position';
          const fallbackAssign = `vMsWorldPos = (modelMatrix * vec4(${posAttr}, 1.0)).xyz;`;
          vs = vs.replace('void main() {', `void main() {\n  ${fallbackAssign}`);
        }

        if (vs !== beforeVS) {
          material.vertexShader = vs;
          shaderChanged = true;
        }
      }

      // Fragment shader: inject water mask clip + floor occluder.
      if (typeof material.fragmentShader === 'string') {
        const beforeFS = material.fragmentShader;
        let fs = material.fragmentShader;

        if (fs.includes(SHADOW_DARKEN_V1_ANCHOR)) {
          const v1Body = /\/\/ MS_WATER_SPLASHES_SHADOW_DARKEN_V1\s*\{[\s\S]*?gl_FragColor\.rgb \*= msShadowMul;\s*\}/m;
          fs = fs.replace(v1Body, '');
          if (fs.includes('uniform sampler2D uBuildingShadowMap')) {
            fs = fs.replace(SHADOW_DECL_V1_LEGACY, SPLASH_SHADOW_UNIFORM_DECL);
          } else if (!fs.includes('uniform sampler2D uCombinedShadowMapRaw')) {
            fs = fs.replace(marker + '\n', marker + '\n' + SPLASH_SHADOW_UNIFORM_DECL);
          }
          fs = patchSplashParticleFragmentShader(fs);
          material.fragmentShader = fs;
          shaderChanged = true;
        }

        fs = material.fragmentShader;

        if (!fs.includes(marker)) {
          // NOTE: Do not rely on a specific uniform anchor like `uniform sampler2D map;`.
          // three.quarks batch shaders may not include that symbol.
          // Instead, inject our declarations near the top of the fragment shader.
          const header =
            'varying vec3 vMsWorldPos;\n' +
            'uniform sampler2D uFloorPresenceMap;\n' +
            'uniform float uHasFloorPresenceMap;\n' +
            'uniform vec2 uResolution;\n' +
            'uniform sampler2D uWaterMask;\n' +
            'uniform float uHasWaterMask;\n' +
            'uniform float uUseWaterMaskClip;\n' +
            'uniform float uWaterFlipV;\n' +
            'uniform vec4 uSceneBounds;\n' +
            marker + '\n' +
            SPLASH_SHADOW_UNIFORM_DECL;

          // Place after the last precision statement if present, otherwise at start.
          const precRE = /precision\s+(?:lowp|mediump|highp)\s+float\s*;\s*/g;
          let lastPrecEnd = -1;
          for (;;) {
            const m = precRE.exec(fs);
            if (!m) break;
            lastPrecEnd = precRE.lastIndex;
          }
          if (lastPrecEnd >= 0) {
            fs = fs.slice(0, lastPrecEnd) + '\n' + header + fs.slice(lastPrecEnd);
          } else {
            fs = header + fs;
          }

          const maskBlock =
            '  // Water mask clip: suppress particles outside the raw _Water mask (prevents land leaks).\n' +
            '  if (uUseWaterMaskClip > 0.5 && uHasWaterMask > 0.5) {\n' +
            '    vec2 uvMask = vec2(\n' +
            '      (vMsWorldPos.x - uSceneBounds.x) / uSceneBounds.z,\n' +
            '      (vMsWorldPos.y - uSceneBounds.y) / uSceneBounds.w\n' +
            '    );\n' +
            '    if (uWaterFlipV > 0.5) uvMask.y = 1.0 - uvMask.y;\n' +
            '    if (uvMask.x < 0.0 || uvMask.x > 1.0 || uvMask.y < 0.0 || uvMask.y > 1.0) {\n' +
            '      gl_FragColor.a *= 0.0;\n' +
            '    } else {\n' +
            '      float m = texture2D(uWaterMask, uvMask).r;\n' +
            '      gl_FragColor.a *= m;\n' +
            '    }\n' +
            '  }\n' +
            '\n' +
            '  // Floor occluder: suppress particles under upper floors (screen-space).\n' +
            '  if (uHasFloorPresenceMap > 0.5) {\n' +
            '    vec2 fpScreenUV = gl_FragCoord.xy / uResolution;\n' +
            '    vec4 fpSample = texture2D(uFloorPresenceMap, fpScreenUV);\n' +
            '    float floorPresence = max(fpSample.r, fpSample.a);\n' +
            '    gl_FragColor.a *= (1.0 - floorPresence);\n' +
            '  }\n';

          if (fs.includes('#include <soft_fragment>')) {
            fs = fs.replace('#include <soft_fragment>', maskBlock + '#include <soft_fragment>');
          } else {
            // Fallback: inject at top of main; no guarantee of soft particles.
            fs = fs.replace(marker + '\n', marker + '\n' + maskBlock);
          }

          fs = patchSplashParticleFragmentShader(fs);
          material.fragmentShader = fs;
          shaderChanged = true;
        } else if (!fs.includes(SPLASH_VOLUME_BEGIN)
          || !fs.includes('MS_WATER_SPLASHES_SHADOW_DARKEN_V10')) {
          let fsUp = fs;
          if (!fsUp.includes('uniform sampler2D uCombinedShadowMapRaw')) {
            if (/\buniform\s+sampler2D\s+uCombinedShadowMap\s*;\s*/m.test(fsUp)) {
              fsUp = fsUp.replace(
                /\buniform\s+sampler2D\s+uCombinedShadowMap\s*;\s*/m,
                SPLASH_SHADOW_UNIFORM_DECL
              );
            } else {
              fsUp = fsUp.replace(marker + '\n', marker + '\n' + SPLASH_SHADOW_UNIFORM_DECL);
            }
          }
          fsUp = patchSplashParticleFragmentShader(fsUp);
          material.fragmentShader = fsUp;
          shaderChanged = true;
        }

        if (material.fragmentShader !== beforeFS) shaderChanged = true;
      }

      if (shaderChanged) material.needsUpdate = true;
      return;
    }

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uFloorPresenceMap = uniforms.uFloorPresenceMap;
      shader.uniforms.uHasFloorPresenceMap = uniforms.uHasFloorPresenceMap;
      shader.uniforms.uResolution = uniforms.uResolution;

      shader.uniforms.uWaterMask = uniforms.uWaterMask;
      shader.uniforms.uHasWaterMask = uniforms.uHasWaterMask;
      shader.uniforms.uUseWaterMaskClip = uniforms.uUseWaterMaskClip;
      shader.uniforms.uWaterFlipV = uniforms.uWaterFlipV;
      shader.uniforms.uSceneBounds = uniforms.uSceneBounds;

      shader.uniforms.uCombinedShadowMap = uniforms.uCombinedShadowMap;
      shader.uniforms.uCombinedShadowMapRaw = uniforms.uCombinedShadowMapRaw;
      shader.uniforms.uHasCombinedShadowRaw = uniforms.uHasCombinedShadowRaw;
      shader.uniforms.uSplashAmbientDay = uniforms.uSplashAmbientDay;

      // Inject world position varying (works for quarks SpriteBatch and MeshBasicMaterial)
      shader.vertexShader = shader.vertexShader
        .replace(
          'void main() {',
          'varying vec3 vMsWorldPos;\nvoid main() {'
        )
        .replace(
          '#include <soft_vertex>',
          '#include <soft_vertex>\n  vMsWorldPos = (modelMatrix * vec4(offset, 1.0)).xyz;'
        );

      shader.fragmentShader = patchSplashParticleFragmentShader(
        shader.fragmentShader
          .replace(
            'void main() {',
            'varying vec3 vMsWorldPos;\n' +
            'uniform sampler2D uFloorPresenceMap;\nuniform float uHasFloorPresenceMap;\nuniform vec2 uResolution;\n' +
            'uniform sampler2D uWaterMask;\nuniform float uHasWaterMask;\nuniform float uUseWaterMaskClip;\nuniform float uWaterFlipV;\nuniform vec4 uSceneBounds;\n' +
            SPLASH_SHADOW_UNIFORM_DECL +
            'void main() {'
          )
          .replace(
            '#include <soft_fragment>',
            '  // Water mask clip: suppress particles outside the raw _Water mask (prevents land leaks).\n' +
            '  if (uUseWaterMaskClip > 0.5 && uHasWaterMask > 0.5) {\n' +
            '    vec2 uvMask = vec2(\n' +
            '      (vMsWorldPos.x - uSceneBounds.x) / uSceneBounds.z,\n' +
            '      (vMsWorldPos.y - uSceneBounds.y) / uSceneBounds.w\n' +
            '    );\n' +
            '    if (uWaterFlipV > 0.5) uvMask.y = 1.0 - uvMask.y;\n' +
            '    if (uvMask.x < 0.0 || uvMask.x > 1.0 || uvMask.y < 0.0 || uvMask.y > 1.0) {\n' +
            '      gl_FragColor.a *= 0.0;\n' +
            '    } else {\n' +
            '      float m = texture2D(uWaterMask, uvMask).r;\n' +
            '      gl_FragColor.a *= m;\n' +
            '    }\n' +
            '  }\n' +
            '  // Floor-presence gate: occlude particles under the current floor\'s solid tiles.\n' +
            '  if (uHasFloorPresenceMap > 0.5) {\n' +
            '    vec2 fpScreenUV = gl_FragCoord.xy / uResolution;\n' +
            '    // Coverage can be encoded in either R (presence masks) or A (scene RTs).\n' +
            '    vec4 fpSample = texture2D(uFloorPresenceMap, fpScreenUV);\n' +
            '    float floorPresence = max(fpSample.r, fpSample.a);\n' +
            '    gl_FragColor.a *= (1.0 - floorPresence);\n' +
            '  }\n' +
            '#include <soft_fragment>'
          )
      );
    };

    material.needsUpdate = true;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    if (this.params && Object.prototype.hasOwnProperty.call(this.params, 'enabled')) {
      this.params.enabled = this._enabled;
    }
  }

  /**
   * Water splashes are a dependent visual layer for WaterEffectV2.
   * If the parent water pass is disabled, hide splashes entirely so foam/splash
   * sprites cannot glare on dry terrain where only `_Water` masks exist.
   * @returns {boolean}
   * @private
   */
  _isParentWaterEffectEnabled() {
    try {
      const waterEffect = window.MapShine?.effectComposer?._floorCompositorV2?._waterEffect;
      if (!waterEffect) return true;
      return (waterEffect.enabled !== false) && (waterEffect.params?.enabled !== false);
    } catch (_) {
      return true;
    }
  }

  /** Keep batched particle draw order aligned with authored floor bands. @private */
  _updateBatchRenderOrder(maxFloorIndex) {
    void maxFloorIndex;
    for (const floorIndex of this._floorStates.keys()) {
      const st = this._floorStates.get(floorIndex);
      const br = st?.batchRenderer ?? null;
      if (!br) continue;
      const fi = Number.isFinite(Number(floorIndex)) ? Number(floorIndex) : 0;
      br.renderOrder = effectUnderOverheadOrder(fi, 50);
    }
  }

  /**
   * @param {number} floorIndex
   * @returns {string}
   * @private
   */
  _overlayKeyForFloor(floorIndex) {
    const fi = Number.isFinite(Number(floorIndex)) ? Number(floorIndex) : 0;
    return `${WATER_SPLASH_BATCH_OVERLAY_PREFIX}${fi}`;
  }

  /**
   * @param {number} floorIndex
   * @returns {BatchedRenderer|null}
   * @private
   */
  _createBatchedRendererForFloor(floorIndex) {
    const br = new BatchedRenderer();
    br.frustumCulled = false;
    br.renderOrder = effectUnderOverheadOrder(floorIndex, 50);
    try {
      if (br.layers && typeof br.layers.set === 'function') {
        br.layers.set(0);
      }
    } catch (_) {}
    return br;
  }

  /**
   * Resolve the exact upper-floor occluder texture for a splash floor.
   * Prefer rebuilding from per-level scene RT diagnostics so the occluder
   * matches the current splash floor's "floors above me" set.
   *
   * Falls back to FloorCompositor's shared `_waterOccluderRT` when diagnostics
   * are unavailable.
   *
   * @param {any} floorCompositor
   * @param {number} splashFloorIndex
   * @returns {import('three').Texture|null}
   * @private
   */
  _resolveUpperFloorOccluderTexture(floorCompositor, splashFloorIndex) {
    const fc = floorCompositor ?? null;
    if (!fc) return null;
    const sf = Number(splashFloorIndex);
    if (!Number.isFinite(sf)) return null;

    try {
      if (typeof fc.getUpperSceneOccluderTextureForFloorIndex === 'function') {
        const tex = fc.getUpperSceneOccluderTextureForFloorIndex(sf);
        if (tex) return tex;
      }
    } catch (_) {}

    return fc?._waterOccluderRT?.texture ?? null;
  }

  /**
   * Resolve the raw water mask texture for a specific splash floor.
   *
   * `WaterEffectV2.getWaterMaskTexture()` follows the currently resolved water
   * floor. Stacked splash batches can include lower-floor systems while viewing
   * from above, so they need their authored floor's raw mask for land clipping.
   *
   * @param {any} waterEffect
   * @param {number} systemFloorIndex
   * @param {import('three').Texture|null} fallbackTex
   * @returns {{ texture: import('three').Texture|null, source: string }}
   * @private
   */
  _resolveWaterMaskTexForSplashFloor(waterEffect, systemFloorIndex, fallbackTex) {
    const we = waterEffect ?? null;
    const fallback = fallbackTex ?? null;
    const sfi = Number(systemFloorIndex);
    if (!we || !Number.isFinite(sfi)) {
      return { texture: fallback, source: fallback ? 'active-water-mask' : 'none' };
    }

    try {
      if (typeof we.getWaterMaskTextureForFloor === 'function') {
        const tex = we.getWaterMaskTextureForFloor(sfi);
        if (tex) return { texture: tex, source: 'floor-water-mask-api' };
      }
    } catch (_) {}

    try {
      const floorData = we._floorWater?.get?.(sfi);
      const tex = floorData?.rawMask ?? floorData?.waterData?.rawMaskTexture ?? null;
      if (tex) return { texture: tex, source: 'floor-water-mask' };
    } catch (_) {}

    return { texture: fallback, source: fallback ? 'active-water-mask-fallback' : 'none' };
  }

  /**
   * Append all particle systems from a floor state into `out` without spread / extra arrays.
   * @private
   */
  _appendSystemsFromFloorState(st, out) {
    if (!st || !out) return;
    const pushArr = (arr) => {
      if (!arr || !arr.length) return;
      for (let i = 0; i < arr.length; i++) out.push(arr[i]);
    };
    pushArr(st.foamSystems);
    pushArr(st.splashSystems);
    pushArr(st.foamSystems2);
    pushArr(st.splashSystems2);
  }

  /**
   * Rebuild `_activeSystemsFlat` from `_activeFloors` (call after floor activation changes).
   * @private
   */
  _rebuildActiveSystemsFlat() {
    const flat = this._activeSystemsFlat;
    flat.length = 0;
    for (const floorIndex of this._activeFloors) {
      const st = this._floorStates.get(floorIndex);
      if (!st) continue;
      this._appendSystemsFromFloorState(st, flat);
    }
  }

  /** Refresh drawing-buffer dimensions from the live renderer (init + compositor resize). */
  _refreshDrawingBufferSize() {
    const renderer = window.MapShine?.renderer || window.canvas?.app?.renderer;
    if (!renderer || !window.THREE) {
      this._drawingBufferW = 1;
      this._drawingBufferH = 1;
      return;
    }
    if (!this._tempVec2) this._tempVec2 = new window.THREE.Vector2();
    const size = this._tempVec2;
    if (typeof renderer.getDrawingBufferSize === 'function') {
      renderer.getDrawingBufferSize(size);
    } else if (typeof renderer.getSize === 'function') {
      renderer.getSize(size);
      const dpr = typeof renderer.getPixelRatio === 'function'
        ? renderer.getPixelRatio()
        : (window.devicePixelRatio || 1);
      size.multiplyScalar(dpr);
    }
    this._drawingBufferW = size.x || 1;
    this._drawingBufferH = size.y || 1;
  }

  /**
   * Viewport resize hook (invoked from FloorCompositor.onResize).
   * Keeps splash shader resolution uniforms aligned with the drawing buffer without per-frame queries.
   */
  syncDrawingBufferSize() {
    this._refreshDrawingBufferSize();
  }

  /**
   * Floor-presence / upper-scene texture for one splash floor when the camera is on `viewFloor`.
   * Lower floors while viewing from above need the stacked upper-scene occluder.
   * @private
   */
  _resolveFloorPresenceTexForSplashFloor(floorCompositor, viewFloor, systemFloorIndex, floorPresenceTex) {
    const view = Number(viewFloor);
    const sfi = Number(systemFloorIndex);
    if (Number.isFinite(sfi) && Number.isFinite(view) && sfi < view) {
      const upperTex = this._resolveUpperFloorOccluderTexture(floorCompositor, sfi);
      if (upperTex) return { texture: upperTex, source: 'upper-scene-occluder' };
      return {
        texture: floorPresenceTex ?? null,
        source: floorPresenceTex ? 'floor-presence-fallback' : 'none',
      };
    }
    return {
      texture: floorPresenceTex ?? null,
      source: floorPresenceTex ? 'floor-presence' : 'none',
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  initialize() {
    if (this._initialized) return;
    const THREE = window.THREE;
    if (!THREE) { log.warn('initialize: THREE not available'); return; }

    // Start loading sprite textures (populate() will await this).
    this._texturesReady = this._loadTextures();

    this._refreshDrawingBufferSize();

    this._initialized = true;
    log.info('WaterSplashesEffectV2 initialized');
  }

  /**
   * Populate water splash systems for all tiles with _Water masks.
   * Groups spawn points by floor index. Call after FloorRenderBus.populate().
   *
   * @param {object} foundrySceneData - Scene geometry data
   */
  async populate(foundrySceneData) {
    if (!this._initialized) { log.warn('populate: not initialized'); return; }
    this.clear();

    // Wait for foam/splash sprite textures before creating systems.
    if (this._texturesReady) await this._texturesReady;

    const tileDocs = canvas?.scene?.tiles?.contents ?? [];

    const floors = window.MapShine?.floorStack?.getFloors() ?? [];
    const d = canvas?.dimensions;
    if (!d) { log.warn('populate: no canvas dimensions'); return; }

    const sceneWidth = d.sceneWidth || d.width;
    const sceneHeight = d.sceneHeight || d.height;
    // Foundry scene origin (top-left, Y-down).
    const foundrySceneX = d.sceneX || 0;
    const foundrySceneY = d.sceneY || 0;
    // Three.js scene origin (Y-up).
    const sceneX = foundrySceneX;
    const sceneY = (d.height || sceneHeight) - foundrySceneY - sceneHeight;

    // Cache for per-frame shader uniform binding.
    this._sceneBounds = {
      sx: sceneX,
      syWorld: sceneY,
      sw: sceneWidth,
      sh: sceneHeight,
    };

    // Collect water edge + interior points per floor from all tiles.
    // Key: floorIndex, Value: { edgeArrays: Float32Array[], interiorArrays: Float32Array[] }
    const floorWaterData = new Map();

    // ── Process background image(s) first (if they have _Water masks) ────────
    // Mirror FireEffectV2 floor attribution: resolve level backgrounds to their
    // FloorStack index so background-derived splashes don't pin to floor 0.
    const scene = canvas?.scene ?? null;
    const seenBgWaterKeys = new Set();

    /**
     * @param {string} bgSrcRaw
     * @param {number} floorIndex
     */
    const ingestBackgroundWater = async (bgSrcRaw, floorIndex) => {
      const bgSrc = typeof bgSrcRaw === 'string' ? bgSrcRaw.trim() : '';
      if (!bgSrc) return;

      const dotIdx = bgSrc.lastIndexOf('.');
      const bgBasePath = dotIdx > 0 ? bgSrc.substring(0, dotIdx) : bgSrc;
      const fi = Number.isFinite(Number(floorIndex)) ? Math.max(0, Math.floor(Number(floorIndex))) : 0;
      const dedupeKey = `${fi}|${bgBasePath}`;
      if (seenBgWaterKeys.has(dedupeKey)) return;

      let image = null;
      const waterResult = await probeMaskFile(bgBasePath, '_Water');
      if (waterResult?.path) {
        image = await this._loadImage(waterResult.path);
      }
      // probeMaskFile already checked all formats and cached the result.
      // No need for fallback GET probing - it just causes 404 spam.
      if (!image) return;

      // Background fills the entire scene rect.
      const bgX = foundrySceneX;
      const bgY = foundrySceneY;
      const bgW = sceneWidth;
      const bgH = sceneHeight;

      const bgEdgePoints = scanWaterEdgePoints(
        image, this.params.maskThreshold, this.params.edgeScanStride
      );
      const bgInteriorPoints = scanWaterInteriorPoints(
        image, this.params.maskThreshold, this.params.interiorScanStride
      );

      const convertToSceneUV = (localPoints) => {
        if (!localPoints) return null;
        const sceneGlobal = new Float32Array(localPoints.length);
        for (let i = 0; i < localPoints.length; i += 3) {
          const foundryPx = bgX + localPoints[i] * bgW;
          const foundryPy = bgY + localPoints[i + 1] * bgH;
          sceneGlobal[i] = (foundryPx - foundrySceneX) / sceneWidth;
          sceneGlobal[i + 1] = (foundryPy - foundrySceneY) / sceneHeight;
          sceneGlobal[i + 2] = localPoints[i + 2];
        }
        return sceneGlobal;
      };

      const sceneEdge = convertToSceneUV(bgEdgePoints);
      const sceneInterior = convertToSceneUV(bgInteriorPoints);
      if (sceneEdge || sceneInterior) {
        if (!floorWaterData.has(fi)) {
          floorWaterData.set(fi, { edgeArrays: [], interiorArrays: [] });
        }
        const floorEntry = floorWaterData.get(fi);
        if (sceneEdge) floorEntry.edgeArrays.push(sceneEdge);
        if (sceneInterior) floorEntry.interiorArrays.push(sceneInterior);
        seenBgWaterKeys.add(dedupeKey);
        log.info(`  background → floor ${fi}, ${sceneEdge ? sceneEdge.length / 3 : 0} edge pts, ${sceneInterior ? sceneInterior.length / 3 : 0} interior pts`);
      }
    };

    if (hasV14NativeLevels(scene) && floors.length > 0) {
      for (const f of floors) {
        const lid = f?.levelId;
        if (typeof lid !== 'string' || !lid.length) continue;
        let bgSrc = '';
        try {
          const lvl = scene.levels?.get?.(lid);
          bgSrc = String(lvl?.background?.src || '').trim();
        } catch (_) {}
        if (!bgSrc) continue;
        await ingestBackgroundWater(bgSrc, f.index);
      }
    }

    // Always probe viewed-level fallback too (covers init races and non-level bands).
    {
      const fallbackSrc = getViewedLevelBackgroundSrc(scene)
        ?? scene?.background?.src
        ?? '';
      const activeFi = window.MapShine?.floorStack?.getActiveFloor?.();
      const fi = (floors.length > 1 && Number.isFinite(Number(activeFi?.index)))
        ? Number(activeFi.index)
        : 0;
      await ingestBackgroundWater(String(fallbackSrc || ''), fi);
    }

    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;

      const tileId = tileDoc.id ?? tileDoc._id;
      if (!tileId) continue;

      const dotIdx = src.lastIndexOf('.');
      const basePath = dotIdx > 0 ? src.substring(0, dotIdx) : src;

      let image = null;
      const waterResult = await probeMaskFile(basePath, '_Water');
      if (waterResult?.path) {
        image = await this._loadImage(waterResult.path);
      }
      // probeMaskFile already checked all formats and cached the result.
      // No need for fallback GET probing - it just causes 404 spam.
      if (!image) continue;

      // Scan for edge (shoreline) points.
      const tileEdgePoints = scanWaterEdgePoints(
        image, this.params.maskThreshold, this.params.edgeScanStride
      );
      // Scan for interior points.
      const tileInteriorPoints = scanWaterInteriorPoints(
        image, this.params.maskThreshold, this.params.interiorScanStride
      );

      if (!tileEdgePoints && !tileInteriorPoints) continue;

      // Convert tile-local UVs → scene-global UVs.
      const tileX = Number(tileDoc.x) || 0;
      const tileY = Number(tileDoc.y) || 0;
      const tileW = Number(tileDoc.width) || 1;
      const tileH = Number(tileDoc.height) || 1;

      const convertToSceneUV = (localPoints) => {
        if (!localPoints) return null;
        const sceneGlobal = new Float32Array(localPoints.length);
        for (let i = 0; i < localPoints.length; i += 3) {
          const foundryPx = tileX + localPoints[i] * tileW;
          const foundryPy = tileY + localPoints[i + 1] * tileH;
          sceneGlobal[i]     = (foundryPx - foundrySceneX) / sceneWidth;
          sceneGlobal[i + 1] = (foundryPy - foundrySceneY) / sceneHeight;
          sceneGlobal[i + 2] = localPoints[i + 2]; // strength/brightness unchanged
        }
        return sceneGlobal;
      };

      const sceneEdge = convertToSceneUV(tileEdgePoints);
      const sceneInterior = convertToSceneUV(tileInteriorPoints);

      // Resolve floor index.
      const floorIndex = this._resolveFloorIndex(tileDoc, floors);
      if (!floorWaterData.has(floorIndex)) {
        floorWaterData.set(floorIndex, { edgeArrays: [], interiorArrays: [] });
      }
      const floorEntry = floorWaterData.get(floorIndex);
      if (sceneEdge) floorEntry.edgeArrays.push(sceneEdge);
      if (sceneInterior) floorEntry.interiorArrays.push(sceneInterior);

      log.info(`  tile '${tileId}' → floor ${floorIndex}, ${sceneEdge ? sceneEdge.length / 3 : 0} edge pts, ${sceneInterior ? sceneInterior.length / 3 : 0} interior pts`);
    }

    // Build particle systems per floor.
    let totalSystems = 0;
    for (const [floorIndex, { edgeArrays, interiorArrays }] of floorWaterData) {
      // Merge edge arrays.
      const mergedEdgeRaw = this._mergeFloat32Arrays(edgeArrays);
      // Merge interior arrays.
      const mergedInteriorRaw = this._mergeFloat32Arrays(interiorArrays);

      // Prevent scene-border spawning from full-bleed masks touching scene edges.
      const mergedEdge = this._filterSceneEdgeUvPoints(mergedEdgeRaw, sceneWidth, sceneHeight);
      const mergedInterior = this._filterSceneEdgeUvPoints(mergedInteriorRaw, sceneWidth, sceneHeight);

      // One-time diagnostics: show whether scans produced any points.
      if (!this._loggedPopulateCountsOnce) {
        try {
          log.info('[WaterSplashesEffectV2] floor scan summary', {
            floorIndex,
            edgePoints: mergedEdge ? (mergedEdge.length / 3) : 0,
            interiorPoints: mergedInterior ? (mergedInterior.length / 3) : 0,
            edgeArrays: edgeArrays?.length ?? 0,
            interiorArrays: interiorArrays?.length ?? 0,
          });
        } catch (_) {}
      }

      const state = this._buildFloorSystems(
        mergedEdge, mergedInterior, sceneWidth, sceneHeight, sceneX, sceneY, floorIndex
      );
      this._floorStates.set(floorIndex, state);
      totalSystems += state.foamSystems.length + state.splashSystems.length
        + (state.foamSystems2?.length ?? 0) + (state.splashSystems2?.length ?? 0);
      if (state.batchRenderer) {
        this._batchRenderers.set(Number(floorIndex), state.batchRenderer);
        const overlayKey = this._overlayKeyForFloor(floorIndex);
        this._renderBus.addEffectOverlay(
          overlayKey,
          state.batchRenderer,
          Number(floorIndex),
          { overlayRole: 'stackedFloorEffect' }
        );
      }
    }

    if (!this._loggedPopulateCountsOnce) {
      this._loggedPopulateCountsOnce = true;
      try {
        const keys = [...this._floorStates.keys()];
        const overlayKeys = keys.map((fi) => this._overlayKeyForFloor(fi));
        const batchCount = [...this._floorStates.values()].filter((st) => !!st?.batchRenderer).length;
        log.info('[WaterSplashesEffectV2] populate summary', {
          floors: keys,
          totalSystems,
          batchCount,
          overlayKeys,
        });
      } catch (_) {}
    }

    if (totalSystems > 0) {
      // Activate the current floor's systems.
      this._activateCurrentFloor();
    }

    log.info(`WaterSplashesEffectV2 populated: ${floorWaterData.size} floor(s), ${totalSystems} system(s)`);
  }

  /**
   * White 1×1 texture — `texture2D(...).r` is 1.0 so splashes stay un-tinted until a real combined shadow RT exists.
   * @returns {import('three').Texture|null}
   * @private
   */
  _ensureCombinedShadowFallbackTexture() {
    const THREE = window.THREE;
    if (!THREE) return null;
    if (this._combinedShadowFallbackTex) return this._combinedShadowFallbackTex;
    const data = new Uint8Array([255, 255, 255, 255]);
    const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    if ('flipY' in tex) tex.flipY = false;
    this._combinedShadowFallbackTex = tex;
    return tex;
  }

  /**
   * 0 = night / heavy scene darkness, 1 = bright noon sky — drives GLSL noon boost
   * without treating shadow maps as the only lighting cue.
   * @returns {number}
   * @private
   */
  _computeSplashAmbientDay01() {
    const fc = (() => {
      try { return window.MapShine?.effectComposer?._floorCompositorV2 ?? null; } catch (_) { return null; }
    })();
    const sky = fc?._skyColorEffect;
    const skyIntensityRaw = Number(sky?._composeMaterial?.uniforms?.uIntensity?.value);
    const skyIntensity01 = Number.isFinite(skyIntensityRaw)
      ? Math.max(0.0, Math.min(1.0, skyIntensityRaw))
      : 1.0;
    const canvas = window.canvas;
    const weatherEnv = weatherController?.getEnvironment?.() ?? null;
    const sceneDarknessRaw = Number(canvas?.scene?.environment?.darknessLevel);
    const envDarknessRaw = Number(canvas?.environment?.darknessLevel);
    const sceneDarkness01 = Number.isFinite(sceneDarknessRaw)
      ? Math.max(0.0, Math.min(1.0, sceneDarknessRaw))
      : (Number.isFinite(envDarknessRaw) ? Math.max(0.0, Math.min(1.0, envDarknessRaw)) : 0.0);
    const effectiveDarknessRaw = Number(weatherEnv?.effectiveDarkness);
    const effectiveDarkness01 = Number.isFinite(effectiveDarknessRaw)
      ? Math.max(0.0, Math.min(1.0, effectiveDarknessRaw))
      : 0.0;
    const dark01 = Math.max(sceneDarkness01, effectiveDarkness01);
    return Math.max(0.0, Math.min(1.0, skyIntensity01 * (1.0 - 0.92 * dark01)));
  }

  /**
   * Bind ShadowManager combined shadow RTs (+ sky/day factor) onto splash shaders.
   * Call after the authoritative shadow combine for this frame (post-cloud merge),
   * immediately before `_renderPerLevelPipeline` draws the bus overlay.
   */
  syncShadowDarkeningUniforms() {
    if (!this._initialized || this._batchRenderers.size === 0) return;
    const splashesEnabled = !!this.params?.enabled;
    const bubblesEnabled = !!this.bubblesParams?.enabled;
    const parentWaterEnabled = this._isParentWaterEffectEnabled();
    const shouldRender = this._enabled && parentWaterEnabled && (splashesEnabled || bubblesEnabled);
    if (!shouldRender) return;

    let fc = null;
    try { fc = window.MapShine?.effectComposer?._floorCompositorV2 ?? null; } catch (_) {}

    const smFx = fc?._shadowManagerEffect ?? null;
    const combinedTex = smFx?.combinedShadowTexture ?? null;
    const texForShader = combinedTex ?? this._ensureCombinedShadowFallbackTexture();
    const rawTexSm = smFx?.combinedShadowRawTexture ?? null;
    const texRawForShader = rawTexSm ?? texForShader;
    const hasSeparateRaw = !!(rawTexSm && combinedTex && rawTexSm !== combinedTex);
    const splashAmbientDay = this._computeSplashAmbientDay01();

    const resX = this._drawingBufferW;
    const resY = this._drawingBufferH;

    const systems = this._activeSystemsFlat;

    const applyU = (u) => {
      if (!u) return;
      if (u.uCombinedShadowMap) u.uCombinedShadowMap.value = texForShader;
      if (u.uCombinedShadowMapRaw) u.uCombinedShadowMapRaw.value = texRawForShader;
      if (u.uHasCombinedShadowRaw) u.uHasCombinedShadowRaw.value = hasSeparateRaw ? 1.0 : 0.0;
      if (u.uSplashAmbientDay) u.uSplashAmbientDay.value = splashAmbientDay;
      if (u.uResolution) u.uResolution.value.set(resX, resY);
    };

    for (const sys of systems) {
      if (!sys) continue;
      const floorIndex = Number(sys.userData?._msFloorIndex);
      const st = Number.isFinite(floorIndex) ? this._floorStates.get(floorIndex) : null;
      const br = st?.batchRenderer ?? null;
      const batches = br?.batches;
      const map = br?.systemToBatchIndex;
      if (sys.material) {
        applyU(sys.material.userData?._msFloorPresenceUniforms);
      }
      const idx = (map && typeof map.get === 'function') ? map.get(sys) : undefined;
      const batch = (idx !== undefined && batches) ? batches[idx] : null;
      const batchMat = batch?.material;
      if (batchMat) {
        applyU(batchMat.userData?._msFloorPresenceUniforms);
        const bu = batchMat.uniforms;
        if (bu?.uCombinedShadowMap) bu.uCombinedShadowMap.value = texForShader;
        if (bu?.uCombinedShadowMapRaw) bu.uCombinedShadowMapRaw.value = texRawForShader;
        if (bu?.uHasCombinedShadowRaw) bu.uHasCombinedShadowRaw.value = hasSeparateRaw ? 1.0 : 0.0;
        if (bu?.uSplashAmbientDay) bu.uSplashAmbientDay.value = splashAmbientDay;
        if (bu?.uResolution) bu.uResolution.value.set(resX, resY);
      }
    }
  }

  /**
   * Per-frame update. Steps the BatchedRenderer simulation.
   * @param {{ elapsed: number, delta: number }} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized || this._batchRenderers.size === 0) return;
    const splashesEnabled = !!this.params?.enabled;
    const bubblesEnabled = !!this.bubblesParams?.enabled;
    const parentWaterEnabled = this._isParentWaterEffectEnabled();
    const shouldRender = this._enabled && parentWaterEnabled && (splashesEnabled || bubblesEnabled);

    // Hide immediately when water is disabled to prevent lingering bright residual.
    for (const br of this._batchRenderers.values()) {
      br.visible = shouldRender;
    }
    if (!shouldRender) return;

    // Optional diagnostics for cases where systems were activated before the
    // user set the debug flag. This runs once when enabled and prints the
    // BatchedRenderer + system registration state.
    // Enable at runtime (any of these):
    //   globalThis.debugWaterSplashesLogs = true
    //   window.debugWaterSplashesLogs = true
    //   window.MapShine.debugWaterSplashesLogs = true
    try {
      const dbg = (globalThis.debugWaterSplashesLogs === true)
        || (window.debugWaterSplashesLogs === true)
        || (window.MapShine?.debugWaterSplashesLogs === true);
      if (dbg && !this._loggedRuntimeDebugOnce) {
        this._loggedRuntimeDebugOnce = true;
        const anyFloor = this._activeFloors.keys().next().value;
        const br = this._floorStates.get(anyFloor)?.batchRenderer ?? null;
        const mapSize = br?.systemToBatchIndex?.size ?? null;
        const batchCount = br?.batches?.length ?? null;
        const state = (anyFloor !== undefined) ? this._floorStates.get(anyFloor) : null;
        const anySys = state ? ([...(state.foamSystems ?? []), ...(state.splashSystems ?? [])][0] ?? null) : null;
        const idx = (anySys && br?.systemToBatchIndex?.get) ? br.systemToBatchIndex.get(anySys) : null;
        const batch = (idx !== null && idx !== undefined && br?.batches) ? br.batches[idx] : null;
        log.info('[WaterSplashesEffectV2] runtime debug probe', {
          activeFloors: [...this._activeFloors],
          floorStateKeys: [...this._floorStates.keys()],
          mapSize,
          batchCount,
          anySystemCtor: anySys?.constructor?.name ?? null,
          anyEmission: (anySys?.emissionOverTime?.a ?? anySys?.emissionOverTime?.value) ?? null,
          anyHasEmitter: !!anySys?.emitter,
          anyEmitterParent: anySys?.emitter?.parent?.type ?? null,
          anyMaterialHasMap: !!anySys?.material?.map,
          anyBatchHasMaterial: !!batch?.material,
          anyBatchMaterialHasMap: !!(batch?.material?.uniforms?.map?.value || batch?.material?.map),
          batchRendererParent: br?.parent?.type ?? null,
          batchRendererLayer: br?.layers?.mask ?? null,
        });
      }
    } catch (_) {}

    // Compute dt for three.quarks (matches FireEffectV2 time scaling).
    const deltaSec = typeof timeInfo?.motionDelta === 'number'
      ? timeInfo.motionDelta
      : (typeof timeInfo?.delta === 'number' ? timeInfo.delta : 0.016);
    const clampedDelta = Math.min(deltaSec, 0.1);
    const simSpeed = (weatherController && typeof weatherController.simulationSpeed === 'number')
      ? weatherController.simulationSpeed : 2.0;
    const dt = clampedDelta * 0.001 * 750 * simSpeed;

    // View-dependent spawn concentration is disabled.
    // It set _msEmissionScaleDynamic=0.0 for out-of-view buckets; since 0??fallback
    // returns 0 (not nullish), those systems were permanently silenced. All systems
    // now fall through to _msEmissionScale (the per-bucket weight set at creation),
    // matching how FireEffectV2 handles emission.

    // Update per-frame emission rates and params.
    this._updateSystemParams(splashesEnabled, bubblesEnabled);

    // Bind floor-presence occlusion uniforms.
    try {
      const fc = window.MapShine?.effectComposer?._floorCompositorV2 ?? null;
      const floorPresenceTex = fc?._distortionEffect?.floorPresenceTarget?.texture ?? null;
      const viewFloorRaw = window.MapShine?.floorStack?.getActiveFloor?.()?.index ?? 0;
      const vfKey = Number.isFinite(Number(viewFloorRaw)) ? Number(viewFloorRaw) : 0;

      const waterEffect = fc?._waterEffect ?? null;
      const waterMaskTex = (waterEffect && typeof waterEffect.getWaterMaskTexture === 'function')
        ? waterEffect.getWaterMaskTexture()
        : null;

      // Legacy foam determines whether the mask needs V flipping (mask metadata / texture.flipY).
      let waterFlipV = false;
      if (waterMaskTex) {
        try {
          const mm = window.MapShine?.maskManager;
          const rec = mm?.getRecord ? mm.getRecord('water.scene') : null;
          if (rec && typeof rec.uvFlipY === 'boolean') {
            waterFlipV = rec.uvFlipY;
          } else if (typeof waterMaskTex?.flipY === 'boolean') {
            waterFlipV = waterMaskTex.flipY === false;
          } else {
            waterFlipV = false;
          }
        } catch (_) {
          waterFlipV = waterMaskTex?.flipY === false;
        }
      }

      const sceneBounds = this._sceneBounds;
      const resX = this._drawingBufferW;
      const resY = this._drawingBufferH;
      const wmv = waterFlipV ? 1 : 0;
      const wmUuid = waterMaskTex?.uuid ?? null;
      const sbx = sceneBounds?.sx ?? NaN;
      const sby = sceneBounds?.syWorld ?? NaN;
      const sbw = sceneBounds?.sw ?? NaN;
      const sbh = sceneBounds?.sh ?? NaN;

      if (!this._lastOcclusionGlobals) {
        this._lastOcclusionGlobals = {
          vf: NaN,
          wm: null,
          wmv: -1,
          rx: -1,
          ry: -1,
          sbx: NaN,
          sby: NaN,
          sbw: NaN,
          sbh: NaN,
          gen: -1,
        };
      }
      const L = this._lastOcclusionGlobals;
      const globalsChanged = (
        L.vf !== vfKey
        || L.wm !== wmUuid
        || L.wmv !== wmv
        || L.rx !== resX
        || L.ry !== resY
        || L.sbx !== sbx
        || L.sby !== sby
        || L.sbw !== sbw
        || L.sbh !== sbh
        || L.gen !== this._activeFloorsGeneration
      );

      if (globalsChanged) {
        L.vf = vfKey;
        L.wm = wmUuid;
        L.wmv = wmv;
        L.rx = resX;
        L.ry = resY;
        L.sbx = sbx;
        L.sby = sby;
        L.sbw = sbw;
        L.sbh = sbh;
        L.gen = this._activeFloorsGeneration;
      }

      const wantsWaterClip = 1.0;
      const systems = this._activeSystemsFlat;

      const applyOcclusionUniforms = (u, fpTex, systemWaterMaskTex) => {
        if (!u) return;
        const wantsFloorPresenceClip = fpTex ? 1.0 : 0.0;
        u.uFloorPresenceMap.value = fpTex;
        u.uHasFloorPresenceMap.value = (fpTex && wantsFloorPresenceClip > 0.5) ? 1.0 : 0.0;
        u.uResolution.value.set(resX, resY);
        u.uWaterMask.value = systemWaterMaskTex;
        u.uHasWaterMask.value = systemWaterMaskTex ? 1.0 : 0.0;
        if (u.uUseWaterMaskClip) u.uUseWaterMaskClip.value = wantsWaterClip;
        if (u.uWaterFlipV) u.uWaterFlipV.value = waterFlipV ? 1.0 : 0.0;
        if (sceneBounds && u.uSceneBounds?.value?.set) {
          u.uSceneBounds.value.set(sceneBounds.sx, sceneBounds.syWorld, sceneBounds.sw, sceneBounds.sh);
        }
      };

      const selectionDiag = globalsChanged ? new Map() : null;
      for (const sys of systems) {
        if (!sys) continue;
        const systemFloorIndex = Number(sys.userData?._msFloorIndex);
        const fpMeta = this._resolveFloorPresenceTexForSplashFloor(fc, vfKey, systemFloorIndex, floorPresenceTex);
        const fpTex = fpMeta.texture ?? null;
        const wmMeta = this._resolveWaterMaskTexForSplashFloor(waterEffect, systemFloorIndex, waterMaskTex);
        const systemWaterMaskTex = wmMeta.texture ?? null;
        const fpId = fpTex?.uuid ?? null;
        const wmId = systemWaterMaskTex?.uuid ?? null;
        if (
          !globalsChanged
          && sys.userData?._msLastSplashFpUuid === fpId
          && sys.userData?._msLastSplashWmUuid === wmId
        ) continue;
        if (sys.userData) {
          sys.userData._msLastSplashFpUuid = fpId;
          sys.userData._msLastSplashWmUuid = wmId;
        }

        if (selectionDiag && Number.isFinite(systemFloorIndex) && !selectionDiag.has(systemFloorIndex)) {
          selectionDiag.set(systemFloorIndex, {
            fp: fpMeta.source,
            fpId,
            wm: wmMeta.source,
            wmId,
          });
        }

        const st = Number.isFinite(systemFloorIndex) ? this._floorStates.get(systemFloorIndex) : null;
        const br = st?.batchRenderer ?? null;
        const batches = br?.batches;
        const map = br?.systemToBatchIndex;

        if (sys.material) {
          let u = sys.material.userData?._msFloorPresenceUniforms;
          if (!u) this._patchFloorPresenceMaterial(sys.material);
          u = sys.material.userData?._msFloorPresenceUniforms;
          applyOcclusionUniforms(u, fpTex, systemWaterMaskTex);
        }

        const idx = (map && typeof map.get === 'function') ? map.get(sys) : undefined;
        const batch = (idx !== undefined && batches) ? batches[idx] : null;
        const batchMat = batch?.material;
        if (batchMat) {
          let u = batchMat.userData?._msFloorPresenceUniforms;
          if (!u) this._patchFloorPresenceMaterial(batchMat);
          u = batchMat.userData?._msFloorPresenceUniforms;
          applyOcclusionUniforms(u, fpTex, systemWaterMaskTex);
        }
      }

      if (selectionDiag?.size) {
        try {
          const summary = [...selectionDiag.entries()]
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map(([floor, m]) => ({
              floor,
              floorPresence: m.fp,
              floorPresenceTex: m.fpId,
              waterMask: m.wm,
              waterMaskTex: m.wmId,
            }));
          const diagKey = JSON.stringify({ viewFloor: vfKey, summary });
          if (diagKey !== this._lastOcclusionSelectionLogKey) {
            this._lastOcclusionSelectionLogKey = diagKey;
            log.info('[WaterSplashesEffectV2] occlusion bindings', { viewFloor: vfKey, bindings: summary });
          }
        } catch (_) {}
      }
    } catch (_) {}

    // Step each active floor's BatchedRenderer.
    for (const floorIndex of this._activeFloors) {
      const br = this._floorStates.get(floorIndex)?.batchRenderer ?? null;
      if (!br) continue;
      try {
        br.update(dt);
      } catch (err) {
        log.warn('WaterSplashesEffectV2: BatchedRenderer.update threw, skipping frame:', err);
      }
    }
  }

  /**
   * Reduce spawn points and emission to the camera-visible world rectangle (+margin).
   * This matches legacy WeatherParticles foam behavior to avoid spreading emission
   * across the entire map when the camera is zoomed in.
   * @private
   */
  _updateViewDependentSpawning() {
    try {
      const sceneComposer = window.MapShine?.sceneComposer;
      const mainCamera = sceneComposer?.camera;
      if (!sceneComposer || !mainCamera) return;

      const zoom = Number.isFinite(sceneComposer.currentZoom)
        ? sceneComposer.currentZoom
        : (Number.isFinite(sceneComposer.zoom) ? sceneComposer.zoom : 1.0);

      const viewportWidth = sceneComposer.baseViewportWidth || window.innerWidth;
      const viewportHeight = sceneComposer.baseViewportHeight || window.innerHeight;
      const visibleW = viewportWidth / Math.max(1e-6, zoom);
      const visibleH = viewportHeight / Math.max(1e-6, zoom);

      const marginScale = 1.2;
      const desiredW = visibleW * marginScale;
      const desiredH = visibleH * marginScale;

      // Clamp the view rectangle to the scene rect in world-space (Y-up).
      let sceneX = 0;
      let sceneY = 0;
      let sceneW = 0;
      let sceneH = 0;
      try {
        const d = canvas?.dimensions;
        const rect = d?.sceneRect;
        const totalH = d?.height ?? 0;
        if (rect && typeof rect.x === 'number') {
          sceneX = rect.x;
          sceneW = rect.width;
          sceneH = rect.height;
          sceneY = (totalH > 0) ? (totalH - (rect.y + rect.height)) : rect.y;
        } else if (d) {
          sceneX = d.sceneX ?? 0;
          sceneW = d.sceneWidth ?? d.width ?? 0;
          sceneH = d.sceneHeight ?? d.height ?? 0;
          sceneY = (totalH > 0) ? (totalH - ((d.sceneY ?? 0) + sceneH)) : (d.sceneY ?? 0);
        }
      } catch (_) {}

      const camX = mainCamera.position.x;
      const camY = mainCamera.position.y;

      let minX = camX - desiredW / 2;
      let maxX = camX + desiredW / 2;
      let minY = camY - desiredH / 2;
      let maxY = camY + desiredH / 2;

      if (sceneW > 0 && sceneH > 0) {
        const sMinX = sceneX;
        const sMaxX = sceneX + sceneW;
        const sMinY = sceneY;
        const sMaxY = sceneY + sceneH;
        minX = Math.max(sMinX, minX);
        maxX = Math.min(sMaxX, maxX);
        minY = Math.max(sMinY, minY);
        maxY = Math.min(sMaxY, maxY);
      }

      const emitW = Math.max(1, maxX - minX);
      const emitH = Math.max(1, maxY - minY);
      if (emitW <= 1 || emitH <= 1) return;

      // Convert world-space view bounds to scene UV bounds used by mask scan points.
      // Points were built in Foundry scene-UV (Y-down), so v = 1 - (worldY - sceneY) / sceneH.
      const u0 = (minX - sceneX) / Math.max(1e-6, sceneW);
      const u1 = (maxX - sceneX) / Math.max(1e-6, sceneW);
      const v0 = 1.0 - ((minY - sceneY) / Math.max(1e-6, sceneH));
      const v1 = 1.0 - ((maxY - sceneY) / Math.max(1e-6, sceneH));
      const uMin = Math.max(0.0, Math.min(1.0, Math.min(u0, u1)));
      const uMax = Math.max(0.0, Math.min(1.0, Math.max(u0, u1)));
      const vMin = Math.max(0.0, Math.min(1.0, Math.min(v0, v1)));
      const vMax = Math.max(0.0, Math.min(1.0, Math.max(v0, v1)));

      // Collect active systems by type (avoid per-frame allocations).
      const foamSystems = this._tempFoamSystems;
      const splashSystems = this._tempSplashSystems;
      foamSystems.length = 0;
      splashSystems.length = 0;
      for (const floorIndex of this._activeFloors) {
        const st = this._floorStates.get(floorIndex);
        if (!st) continue;
        const fa = st.foamSystems;
        if (fa) for (let i = 0; i < fa.length; i++) foamSystems.push(fa[i]);
        const sa = st.splashSystems;
        if (sa) for (let i = 0; i < sa.length; i++) splashSystems.push(sa[i]);
      }

      const updateWeightsFor = (systems) => {
        // First pass: filter shapes + accumulate visible points.
        let totalVisible = 0;
        for (const sys of systems) {
          if (!sys?.userData) continue;
          const shape = sys.emitterShape || sys.shape;
          if (shape && typeof shape.setViewBoundsUv === 'function') {
            shape.setViewBoundsUv(uMin, uMax, vMin, vMax);
          }
          const activeCount = (shape && typeof shape.getActivePointCount === 'function')
            ? shape.getActivePointCount()
            : null;
          sys.userData._msActivePointCount = Number.isFinite(activeCount) ? activeCount : null;
          if (Number.isFinite(activeCount) && activeCount > 0) totalVisible += activeCount;
        }

        // Fail-open guard: if camera bounds filtering produced zero visible points
        // for an entire system class, treat it as a bounds mismatch and revert to
        // full point-cloud emission instead of collapsing all rates to zero.
        if (totalVisible <= 0) {
          for (const sys of systems) {
            if (!sys?.userData) continue;
            const shape = sys.emitterShape || sys.shape;
            const all = shape?._allPoints;
            if (all && all.length >= 3) {
              try { shape.points = all; } catch (_) {}
              try { sys.userData._msActivePointCount = Math.floor(all.length / 3); } catch (_) {}
            }
            // Clear dynamic override so emission falls back to base bucket weights.
            delete sys.userData._msEmissionScaleDynamic;
          }
          return;
        }

        // Second pass: normalize dynamic emission weights.
        for (const sys of systems) {
          if (!sys?.userData) continue;
          const activeCount = sys.userData._msActivePointCount;
          if (!Number.isFinite(activeCount) || activeCount <= 0 || totalVisible <= 0) {
            sys.userData._msEmissionScaleDynamic = 0.0;
          } else {
            sys.userData._msEmissionScaleDynamic = activeCount / totalVisible;
          }
        }
      };

      updateWeightsFor(foamSystems);
      updateWeightsFor(splashSystems);
    } catch (_) {
      // If anything about the camera/view state isn't available, leave full-scene emission.
    }
  }

  /**
   * Called when the visible floor range changes.
   * @param {number} maxFloorIndex
   */
  onFloorChange(maxFloorIndex) {
    if (!this._initialized) return;

    // Keep water particles in the active floor's render-order band so they are
    // not fully overwritten by tile draws on upper floors.
    this._updateBatchRenderOrder(maxFloorIndex);

    const desired = new Set();
    const activeFloorIndex = Number(maxFloorIndex);
    // Register every populated floor from ground through the active level so
    // lower-level splashes/bubbles stay alive and visible when the camera
    // looks downward from a higher floor.
    if (Number.isFinite(activeFloorIndex)) {
      for (const idx of this._floorStates.keys()) {
        const fi = Number(idx);
        if (Number.isFinite(fi) && fi <= activeFloorIndex) desired.add(fi);
      }
    }

    const prevFloors = this._activeFloors;
    let floorsDirty = prevFloors.size !== desired.size;
    if (!floorsDirty) {
      for (const x of desired) {
        if (!prevFloors.has(x)) {
          floorsDirty = true;
          break;
        }
      }
    }
    if (!floorsDirty) {
      for (const x of prevFloors) {
        if (!desired.has(x)) {
          floorsDirty = true;
          break;
        }
      }
    }
    if (floorsDirty) {
      this._activeFloorsGeneration++;
      this._lastOcclusionGlobals = null;
    }

    // Deactivate floors that should no longer be visible.
    for (const idx of prevFloors) {
      if (!desired.has(idx)) this._deactivateFloor(idx);
    }
    // Activate floors that are newly visible.
    for (const idx of desired) {
      if (!prevFloors.has(idx)) this._activateFloor(idx);
    }

    log.info(`onFloorChange(${maxFloorIndex}): active=[${[...desired]}] states=[${[...this._floorStates.keys()]}]`);
    this._activeFloors = desired;
    this._rebuildActiveSystemsFlat();
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  clear() {
    for (const idx of this._activeFloors) {
      this._deactivateFloor(idx);
    }
    this._activeFloors.clear();
    this._activeSystemsFlat.length = 0;
    for (const floorIndex of this._floorStates.keys()) {
      try { this._renderBus.removeEffectOverlay(this._overlayKeyForFloor(floorIndex)); } catch (_) {}
    }

    for (const [, state] of this._floorStates) {
      this._disposeFloorState(state);
    }
    this._floorStates.clear();
    this._batchRenderers.clear();
  }

  dispose() {
    this.clear();
    this._foamTexture?.dispose();
    this._splashTexture?.dispose();
    this._combinedShadowFallbackTex?.dispose?.();
    this._foamTexture = null;
    this._splashTexture = null;
    this._combinedShadowFallbackTex = null;
    this._batchRenderers.clear();
    this._initialized = false;
    log.info('WaterSplashesEffectV2 disposed');
  }

  // ── Private: System building ───────────────────────────────────────────────

  /**
   * Build foam + splash systems from merged points for a single floor.
   * Edge points → foam plume systems. Interior points → rain splash systems.
   * Points are spatially bucketed for efficiency.
   * @private
   */
  _buildFloorSystems(edgePoints, interiorPoints, sceneW, sceneH, sceneX, sceneY, floorIndex) {
    const batchRenderer = this._createBatchedRendererForFloor(floorIndex);
    const state = { foamSystems: [], splashSystems: [], foamSystems2: [], splashSystems2: [], batchRenderer };

    // Build foam plume systems from edge points.
    if (edgePoints && edgePoints.length >= 3 && this.params.foamEnabled) {
      const buckets = this._spatialBucket(edgePoints, sceneW, sceneH, sceneX, sceneY);
      const totalEdge = edgePoints.length / 3;
      for (const [, arr] of buckets) {
        if (arr.length < 3) continue;
        const bucketPoints = new Float32Array(arr);
        const weight = totalEdge > 0 ? (bucketPoints.length / 3 / totalEdge) : 1.0;
        const shape = new WaterEdgeMaskShape(
          bucketPoints, sceneW, sceneH, sceneX, sceneY,
          GROUND_Z + (Number(floorIndex) || 0), 0.3
        );
        const sys = this._createFoamSystem(shape, weight, floorIndex);
        if (sys) state.foamSystems.push(sys);
      }
    }

    // Build splash systems from interior points.
    if (interiorPoints && interiorPoints.length >= 3 && this.params.splashEnabled) {
      const buckets = this._spatialBucket(interiorPoints, sceneW, sceneH, sceneX, sceneY);
      const totalInterior = interiorPoints.length / 3;
      for (const [, arr] of buckets) {
        if (arr.length < 3) continue;
        const bucketPoints = new Float32Array(arr);
        const weight = totalInterior > 0 ? (bucketPoints.length / 3 / totalInterior) : 1.0;
        const shape = new WaterInteriorMaskShape(
          bucketPoints, sceneW, sceneH, sceneX, sceneY,
          GROUND_Z + (Number(floorIndex) || 0), 0.3
        );
        const sys = this._createSplashSystem(shape, weight, floorIndex);
        if (sys) state.splashSystems.push(sys);
      }
    }

    // Build underwater bubbles foam systems (same edge points, separate params/lifecycle).
    if (edgePoints && edgePoints.length >= 3 && this.bubblesParams.enabled && this.bubblesParams.foamEnabled) {
      const buckets = this._spatialBucket(edgePoints, sceneW, sceneH, sceneX, sceneY);
      const totalEdge = edgePoints.length / 3;
      for (const [, arr] of buckets) {
        if (arr.length < 3) continue;
        const bucketPoints = new Float32Array(arr);
        const weight = totalEdge > 0 ? (bucketPoints.length / 3 / totalEdge) : 1.0;
        const shape = new WaterEdgeMaskShape(
          bucketPoints, sceneW, sceneH, sceneX, sceneY,
          GROUND_Z + (Number(floorIndex) || 0), 0.3
        );
        const sys = this._createBubbleFoamSystem(shape, weight, floorIndex);
        if (sys) state.foamSystems2.push(sys);
      }
    }

    // Build underwater bubbles splash systems (same interior points, separate params/lifecycle).
    if (interiorPoints && interiorPoints.length >= 3 && this.bubblesParams.enabled && this.bubblesParams.splashEnabled) {
      const buckets = this._spatialBucket(interiorPoints, sceneW, sceneH, sceneX, sceneY);
      const totalInterior = interiorPoints.length / 3;
      for (const [, arr] of buckets) {
        if (arr.length < 3) continue;
        const bucketPoints = new Float32Array(arr);
        const weight = totalInterior > 0 ? (bucketPoints.length / 3 / totalInterior) : 1.0;
        const shape = new WaterInteriorMaskShape(
          bucketPoints, sceneW, sceneH, sceneX, sceneY,
          GROUND_Z + (Number(floorIndex) || 0), 0.3
        );
        const sys = this._createBubbleSplashSystem(shape, weight, floorIndex);
        if (sys) state.splashSystems2.push(sys);
      }
    }

    return state;
  }

  /** @private */
  _createFoamSystem(shape, weight, floorIndex = 0) {
    const THREE = window.THREE;
    if (!THREE) return null;

    const material = new THREE.MeshBasicMaterial({
      map: this._foamTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
      color: 0xffffff,
      side: THREE.DoubleSide,
    });
    material.toneMapped = false;
    this._patchFloorPresenceMaterial(material);

    const p = this.params;
    const lifeMin = Math.max(0.01, p.foamLifeMin ?? 0.8);
    const lifeMax = Math.max(lifeMin, p.foamLifeMax ?? 2.0);
    const sizeMin = Math.max(0.1, p.foamSizeMin ?? 30);
    const sizeMax = Math.max(sizeMin, p.foamSizeMax ?? 90);

    // NOTE: Weight distributes the global rate across bucketed systems. With many buckets
    // (e.g. 30–50), naive `rate * weight` can drop below 0.1 and effectively not render.
    // FireEffectV2 works largely because its base emission rates are an order of magnitude
    // higher; match that expectation here.
    const foamRateMult = 40.0;
    const foamRate = Math.max(0.0, Number(p.foamRate) || 0) * foamRateMult;

    const foamLifecycle = new FoamPlumeLifecycleBehavior(this, floorIndex);

    const system = new QuarksParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      startColor: new ColorRange(new Vector4(1, 1, 1, 1), new Vector4(1, 1, 1, 1)),
      worldSpace: true,
      maxParticles: 3000,
      emissionOverTime: new IntervalValue(
        Math.max(1.0, foamRate * weight * 0.5),
        Math.max(2.0, foamRate * weight)
      ),
      shape,
      material,
      renderMode: RenderMode.BillBoard,
      renderOrder: 200000,
      startRotation: new IntervalValue(0, Math.PI * 2),
      behaviors: [foamLifecycle],
    });

    system.userData = {
      ownerEffect: this,
      _msEmissionScale: weight,
      isFoam: true,
    };

    // Match FireEffectV2: explicitly start systems so quarks cannot stay paused.
    if (typeof system.play === 'function') system.play();

    return system;
  }

  /** @private */
  _createSplashSystem(shape, weight, floorIndex = 0) {
    const THREE = window.THREE;
    if (!THREE) return null;

    // Splash rings use the generic particle texture (or foam texture as fallback).
    const material = new THREE.MeshBasicMaterial({
      map: this._splashTexture || this._foamTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
      color: 0xffffff,
      side: THREE.DoubleSide,
    });
    material.toneMapped = false;
    this._patchFloorPresenceMaterial(material);

    const p = this.params;
    const lifeMin = Math.max(0.01, p.splashLifeMin ?? 0.3);
    const lifeMax = Math.max(lifeMin, p.splashLifeMax ?? 0.8);
    const sizeMin = Math.max(0.1, p.splashSizeMin ?? 8);
    const sizeMax = Math.max(sizeMin, p.splashSizeMax ?? 25);

    const splashRateMult = 40.0;
    const splashRate = Math.max(0.0, Number(p.splashRate) || 0) * splashRateMult;

    const splashLifecycle = new SplashRingLifecycleBehavior(this, floorIndex);

    // Splash emission is gated by precipitation — when it's not raining,
    // the behavior's _precipMult drives alpha to 0 so particles are invisible.
    // We still emit at base rate so particles are ready when rain starts.
    const system = new QuarksParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      startColor: new ColorRange(new Vector4(1, 1, 1, 1), new Vector4(1, 1, 1, 1)),
      worldSpace: true,
      maxParticles: 4000,
      emissionOverTime: new IntervalValue(
        Math.max(1.0, splashRate * weight * 0.5),
        Math.max(2.0, splashRate * weight)
      ),
      shape,
      material,
      renderMode: RenderMode.BillBoard,
      renderOrder: 200001,
      startRotation: new IntervalValue(0, Math.PI * 2),
      behaviors: [splashLifecycle],
    });

    system.userData = {
      ownerEffect: this,
      _msEmissionScale: weight,
      isSplash: true,
    };

    // Match FireEffectV2: explicitly start systems so quarks cannot stay paused.
    if (typeof system.play === 'function') system.play();

    return system;
  }

  /**
   * Create a foam plume system for the underwater bubbles layer.
   * Uses bubblesParams for size/rate/life, and its own lifecycle behavior
   * instance so the tint/opacity params are independent from splashes.
   * @private
   */
  _createBubbleFoamSystem(shape, weight, floorIndex = 0) {
    const THREE = window.THREE;
    if (!THREE) return null;

    const material = new THREE.MeshBasicMaterial({
      map: this._foamTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
      color: 0xffffff,
      side: THREE.DoubleSide,
    });
    material.toneMapped = false;
    this._patchFloorPresenceMaterial(material);

    const p = this.bubblesParams;
    const lifeMin = Math.max(0.01, p.foamLifeMin ?? 1.2);
    const lifeMax = Math.max(lifeMin, p.foamLifeMax ?? 10.0);
    const sizeMin = Math.max(0.1, p.foamSizeMin ?? 35);
    const sizeMax = Math.max(sizeMin, p.foamSizeMax ?? 373);

    const foamRateMult = 20.0;
    const foamRate = Math.max(0.0, Number(p.foamRate) || 0) * foamRateMult;

    // Lifecycle reads bubblesParams but needs `_sceneBounds` from this effect for outdoors sampling.
    const bubbleFoamOwner = { params: p };
    Object.defineProperty(bubbleFoamOwner, '_sceneBounds', { get: () => this._sceneBounds });
    const foamLifecycle = new FoamPlumeLifecycleBehavior(bubbleFoamOwner, floorIndex);

    const system = new QuarksParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      startColor: new ColorRange(new Vector4(1, 1, 1, 1), new Vector4(1, 1, 1, 1)),
      worldSpace: true,
      maxParticles: 3000,
      emissionOverTime: new IntervalValue(
        Math.max(1.0, foamRate * weight * 0.5),
        Math.max(2.0, foamRate * weight)
      ),
      shape,
      material,
      renderMode: RenderMode.BillBoard,
      renderOrder: 200000,
      startRotation: new IntervalValue(0, Math.PI * 2),
      behaviors: [foamLifecycle],
    });

    system.userData = {
      ownerEffect: this,
      _msEmissionScale: weight,
      isFoam: true,
      isBubbles: true,
    };

    // Match FireEffectV2: explicitly start systems so quarks cannot stay paused.
    if (typeof system.play === 'function') system.play();

    return system;
  }

  /**
   * Create a splash ring system for the underwater bubbles layer.
   * Uses bubblesParams for size/rate/life.
   * @private
   */
  _createBubbleSplashSystem(shape, weight, floorIndex = 0) {
    const THREE = window.THREE;
    if (!THREE) return null;

    const material = new THREE.MeshBasicMaterial({
      map: this._splashTexture || this._foamTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
      color: 0xffffff,
      side: THREE.DoubleSide,
    });
    material.toneMapped = false;
    this._patchFloorPresenceMaterial(material);

    const p = this.bubblesParams;
    const lifeMin = Math.max(0.01, p.splashLifeMin ?? 0.3);
    const lifeMax = Math.max(lifeMin, p.splashLifeMax ?? 0.8);
    const sizeMin = Math.max(0.1, p.splashSizeMin ?? 35);
    const sizeMax = Math.max(sizeMin, p.splashSizeMax ?? 77);

    const splashRateMult = 20.0;
    const splashRate = Math.max(0.0, Number(p.splashRate) || 0) * splashRateMult;

    const bubbleSplashOwner = { params: p };
    Object.defineProperty(bubbleSplashOwner, '_sceneBounds', { get: () => this._sceneBounds });
    const splashLifecycle = new SplashRingLifecycleBehavior(bubbleSplashOwner, floorIndex);

    const system = new QuarksParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      startColor: new ColorRange(new Vector4(1, 1, 1, 1), new Vector4(1, 1, 1, 1)),
      worldSpace: true,
      maxParticles: 4000,
      emissionOverTime: new IntervalValue(
        Math.max(1.0, splashRate * weight * 0.5),
        Math.max(2.0, splashRate * weight)
      ),
      shape,
      material,
      renderMode: RenderMode.BillBoard,
      renderOrder: 200001,
      startRotation: new IntervalValue(0, Math.PI * 2),
      behaviors: [splashLifecycle],
    });

    system.userData = {
      ownerEffect: this,
      _msEmissionScale: weight,
      isSplash: true,
      isBubbles: true,
    };

    // Match FireEffectV2: explicitly start systems so quarks cannot stay paused.
    if (typeof system.play === 'function') system.play();

    return system;
  }

  // ── Private: Floor switching ───────────────────────────────────────────────

  /** Activate only the current active floor's systems. @private */
  _activateCurrentFloor() {
    const floorStack = window.MapShine?.floorStack;
    const activeFloor = floorStack?.getActiveFloor();
    const activeFloorIndex = Number.isFinite(activeFloor?.index) ? Number(activeFloor.index) : 0;
    this.onFloorChange(activeFloorIndex);
  }

  /** Add a floor's systems to the BatchedRenderer. @private */
  _activateFloor(floorIndex) {
    const state = this._floorStates.get(floorIndex);
    const br = state?.batchRenderer ?? null;
    if (!state || !br) return;

    const allSystems = [];
    this._appendSystemsFromFloorState(state, allSystems);
    for (const sys of allSystems) {
      if (sys?.userData) sys.userData._msFloorIndex = floorIndex;
      try { br.addSystem(sys); } catch (_) {}
      // Emitters as children of BatchedRenderer — transitive scene membership.
      if (sys.emitter) br.add(sys.emitter);
    }

    const batches = br.batches;
    const map = br.systemToBatchIndex;
    for (const sys of allSystems) {
      if (!sys) continue;
      const idx = (map && typeof map.get === 'function') ? map.get(sys) : undefined;
      const batch = (idx !== undefined && batches) ? batches[idx] : null;
      const batchMat = batch?.material;
      if (batchMat) this._patchFloorPresenceMaterial(batchMat);
    }

    // Optional diagnostics for "systems exist but nothing renders".
    // Enable at runtime: window.MapShine.debugWaterSplashesLogs = true
    try {
      const dbg = (globalThis.debugWaterSplashesLogs === true)
        || (window.debugWaterSplashesLogs === true)
        || (window.MapShine?.debugWaterSplashesLogs === true);
      if (dbg) {
        const mapSize = br?.systemToBatchIndex?.size ?? null;
        const batchCount = br?.batches?.length ?? null;
        const first = allSystems[0] ?? null;
        const idx = (first && br?.systemToBatchIndex?.get) ? br.systemToBatchIndex.get(first) : null;
        const batch = (idx !== null && idx !== undefined && br?.batches) ? br.batches[idx] : null;
        log.info('[WaterSplashesEffectV2] activateFloor debug', {
          floorIndex,
          systems: allSystems.length,
          mapSize,
          batchCount,
          firstSystemCtor: first?.constructor?.name ?? null,
          firstEmission: (first?.emissionOverTime?.a ?? first?.emissionOverTime?.value) ?? null,
          firstHasEmitter: !!first?.emitter,
          firstEmitterParent: first?.emitter?.parent?.type ?? null,
          firstMaterialHasMap: !!first?.material?.map,
          firstBatchHasMaterial: !!batch?.material,
          firstBatchMaterialHasMap: !!(batch?.material?.uniforms?.map?.value || batch?.material?.map),
          cameraLayerMask: window.MapShine?.sceneComposer?.camera?.layers?.mask ?? null,
        });
      }
    } catch (_) {}

    log.debug(`activated floor ${floorIndex} (${allSystems.length} systems)`);
  }

  /** Remove a floor's systems from the BatchedRenderer. @private */
  _deactivateFloor(floorIndex) {
    const state = this._floorStates.get(floorIndex);
    const br = state?.batchRenderer ?? null;
    if (!state || !br) return;

    const allSystems = [];
    this._appendSystemsFromFloorState(state, allSystems);
    for (const sys of allSystems) {
      try { br.deleteSystem(sys); } catch (_) {}
      if (sys.emitter) br.remove(sys.emitter);
    }
    log.debug(`deactivated floor ${floorIndex}`);
  }

  /** Dispose all systems in a floor state. @private */
  _disposeFloorState(state) {
    const br = state?.batchRenderer ?? null;
    const allSystems = [];
    this._appendSystemsFromFloorState(state, allSystems);
    for (const sys of allSystems) {
      try {
        if (br) br.deleteSystem(sys);
      } catch (_) {}
      if (sys.emitter && br) {
        br.remove(sys.emitter);
      }
      try { sys.material?.dispose(); } catch (_) {}
    }
    state.foamSystems.length = 0;
    state.splashSystems.length = 0;
    if (state.foamSystems2) state.foamSystems2.length = 0;
    if (state.splashSystems2) state.splashSystems2.length = 0;
    if (state.batchRenderer) state.batchRenderer = null;
  }

  // ── Private: Per-frame param sync ──────────────────────────────────────────

  /** Update emission rates based on current params + weather. @private */
  _updateSystemParams(splashesEnabled = true, bubblesEnabled = true) {
    const p = this.params;

    let wind01 = 0.15;
    try {
      wind01 = resolveEffectWindWorld().speed01;
    } catch (_) {}
    const foamWindMul = 0.42 + 0.58 * wind01;
    const splashWindPrecipMul = 0.55 + 0.45 * wind01;

    // Keep emission strong enough to remain visible after spatial bucketing.
    // `_createFoamSystem/_createSplashSystem` apply the same multipliers.
    const foamRateMult = 40.0;
    const splashRateMult = 40.0;

    // Get current precipitation for splash rate modulation.
    let precip = 0;
    try {
      const state = weatherController?.getCurrentState?.();
      precip = state?.precipitation ?? 0;
      if (!Number.isFinite(precip)) precip = 0;
    } catch (_) {}

    for (const [, state] of this._floorStates) {
      if (!state) continue;

      // Foam systems: emission proportional to foamRate.
      if (splashesEnabled) for (const sys of state.foamSystems) {
        if (!sys?.userData) continue;

        // Live-sync life/size so Tweakpane changes take effect immediately for new particles.
        try {
          const lifeMin = Math.max(0.01, Number(p.foamLifeMin) || 0.8);
          const lifeMax = Math.max(lifeMin, Number(p.foamLifeMax) || 2.0);
          if (sys.startLife) {
            sys.startLife.a = lifeMin;
            sys.startLife.b = lifeMax;
          }
          const sizeMin = Math.max(0.1, Number(p.foamSizeMin) || 30);
          const sizeMax = Math.max(sizeMin, Number(p.foamSizeMax) || 90);
          if (sys.startSize) {
            sys.startSize.a = sizeMin;
            sys.startSize.b = sizeMax;
          }
        } catch (_) {}

        const w = (sys.userData._msEmissionScaleDynamic ?? sys.userData._msEmissionScale) ?? 1.0;
        if (!Number.isFinite(w) || w <= 0) {
          if (sys.emissionOverTime) {
            sys.emissionOverTime.a = 0.0;
            sys.emissionOverTime.b = 0.0;
          }
          continue;
        }
        const foamRate = Math.max(0.0, Number(p.foamRate) || 0) * foamRateMult * foamWindMul;
        if (sys.emissionOverTime) {
          sys.emissionOverTime.a = Math.max(1.0, foamRate * w * 0.5);
          sys.emissionOverTime.b = Math.max(2.0, foamRate * w);
        }
      }

      // Splash systems: emission modulated by precipitation.
      if (splashesEnabled) for (const sys of state.splashSystems) {
        if (!sys?.userData) continue;

        // Live-sync life/size so Tweakpane changes take effect immediately for new particles.
        try {
          const lifeMin = Math.max(0.01, Number(p.splashLifeMin) || 0.3);
          const lifeMax = Math.max(lifeMin, Number(p.splashLifeMax) || 0.8);
          if (sys.startLife) {
            sys.startLife.a = lifeMin;
            sys.startLife.b = lifeMax;
          }
          const sizeMin = Math.max(0.1, Number(p.splashSizeMin) || 8);
          const sizeMax = Math.max(sizeMin, Number(p.splashSizeMax) || 25);
          if (sys.startSize) {
            sys.startSize.a = sizeMin;
            sys.startSize.b = sizeMax;
          }
        } catch (_) {}

        const w = (sys.userData._msEmissionScaleDynamic ?? sys.userData._msEmissionScale) ?? 1.0;
        if (!Number.isFinite(w) || w <= 0) {
          if (sys.emissionOverTime) {
            sys.emissionOverTime.a = 0.0;
            sys.emissionOverTime.b = 0.0;
          }
          continue;
        }
        const splashRate = Math.max(0.0, Number(p.splashRate) || 0) * splashRateMult;
        // Scale emission by precipitation so splashes only appear when it rains.
        const precipScale = Math.max(0, Math.min(1.0, precip)) * splashWindPrecipMul;
        if (sys.emissionOverTime) {
          // Keep a small baseline so systems remain alive/ready; visual intensity is still
          // strongly gated by precipitation via SplashRingLifecycleBehavior alpha.
          const baseA = splashRate * w * 0.5;
          const baseB = splashRate * w;
          sys.emissionOverTime.a = Math.max(0.2, baseA * precipScale);
          sys.emissionOverTime.b = Math.max(0.5, baseB * precipScale);
        }
      }

      // Bubbles foam systems: hardcoded rates from bubblesParams.
      const bp = this.bubblesParams;
      const bubbleFoamRate = Math.max(0.0, Number(bp.foamRate) || 0) * foamRateMult * foamWindMul;
      if (bubblesEnabled) for (const sys of (state.foamSystems2 ?? [])) {
        if (!sys?.userData) continue;
        const w = (sys.userData._msEmissionScaleDynamic ?? sys.userData._msEmissionScale) ?? 1.0;
        if (!Number.isFinite(w) || w <= 0) {
          if (sys.emissionOverTime) { sys.emissionOverTime.a = 0.0; sys.emissionOverTime.b = 0.0; }
          continue;
        }
        if (sys.emissionOverTime) {
          sys.emissionOverTime.a = Math.max(1.0, bubbleFoamRate * w * 0.5);
          sys.emissionOverTime.b = Math.max(2.0, bubbleFoamRate * w);
        }
      }

      // Bubbles splash systems: hardcoded rates from bubblesParams.
      const bubbleSplashRate = Math.max(0.0, Number(bp.splashRate) || 0) * splashRateMult;
      const bubbleSplashScale = Math.max(0, Math.min(1.0, precip)) * splashWindPrecipMul;
      if (bubblesEnabled) for (const sys of (state.splashSystems2 ?? [])) {
        if (!sys?.userData) continue;
        const w = (sys.userData._msEmissionScaleDynamic ?? sys.userData._msEmissionScale) ?? 1.0;
        if (!Number.isFinite(w) || w <= 0) {
          if (sys.emissionOverTime) { sys.emissionOverTime.a = 0.0; sys.emissionOverTime.b = 0.0; }
          continue;
        }
        if (sys.emissionOverTime) {
          sys.emissionOverTime.a = Math.max(0.2, bubbleSplashRate * w * 0.5 * bubbleSplashScale);
          sys.emissionOverTime.b = Math.max(0.5, bubbleSplashRate * w * bubbleSplashScale);
        }
      }
    }
  }

  // ── Private: Texture loading ───────────────────────────────────────────────

  /**
   * Load foam and splash sprite textures. Returns a promise that resolves
   * when both are loaded.
   * @returns {Promise<void>}
   * @private
   */
  _loadTextures() {
    const THREE = window.THREE;
    if (!THREE) return Promise.resolve();
    const loader = new THREE.TextureLoader();

    const foamP = new Promise((resolve) => {
      loader.load('modules/map-shine-advanced/assets/foam.webp', (tex) => {
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.generateMipmaps = true;
        tex.needsUpdate = true;
        this._foamTexture = tex;
        resolve();
      }, undefined, () => { log.warn('Failed to load foam.webp'); resolve(); });
    });

    // Use the generic particle texture for splash rings.
    const splashP = new Promise((resolve) => {
      loader.load('modules/map-shine-advanced/assets/particle.webp', (tex) => {
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = true;
        tex.needsUpdate = true;
        this._splashTexture = tex;
        resolve();
      }, undefined, () => { log.warn('Failed to load particle.webp'); resolve(); });
    });

    return Promise.all([foamP, splashP]).then(() => {
      log.info('Water splash textures loaded');
    });
  }

  /**
   * Load an image from URL and return the HTMLImageElement.
   * @private
   */
  _loadImage(url) {
    return this._loadImageInternal(url, { suppressWarn: false });
  }

  /**
   * @param {string} url
   * @param {{ suppressWarn?: boolean }} [opts]
   * @returns {Promise<HTMLImageElement|null>}
   * @private
   */
  _loadImageInternal(url, opts = {}) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => {
        if (!opts?.suppressWarn) log.warn(`Failed to load water mask image: ${url}`);
        resolve(null);
      };
      img.src = url;
    });
  }

  /**
   * Try loading a mask image by probing common formats via Image() GET.
   * This intentionally avoids FilePicker and HEAD probing, which can fail on
   * some hosted setups even when GET succeeds.
   *
   * @param {string} basePathWithSuffix - e.g. "modules/foo/bar_Map_Water" (no extension)
   * @param {{ formats?: string[] }} [opts]
   * @returns {Promise<{ url: string, image: HTMLImageElement } | null>}
   * @private
   */
  async _tryLoadMaskImage(basePathWithSuffix, opts = {}) {
    if (!basePathWithSuffix) return null;
    const formats = Array.isArray(opts?.formats) && opts.formats.length ? opts.formats : WATER_MASK_FORMATS;
    const cacheKey = `${basePathWithSuffix}::${formats.join(',')}`;

    if (this._directMaskCache?.has(cacheKey)) {
      return this._directMaskCache.get(cacheKey);
    }

    for (const ext of formats) {
      const url = `${basePathWithSuffix}.${ext}`;
      const img = await this._loadImageInternal(url, { suppressWarn: true });
      if (img) {
        const hit = { url, image: img };
        this._directMaskCache.set(cacheKey, hit);
        return hit;
      }
    }

    this._directMaskCache.set(cacheKey, null);
    return null;
  }

  // ── Private: Utility ──────────────────────────────────────────────────────

  /**
   * Merge multiple Float32Arrays into one.
   * @param {Float32Array[]} arrays
   * @returns {Float32Array|null}
   * @private
   */
  _mergeFloat32Arrays(arrays) {
    if (!arrays || arrays.length === 0) return null;
    const totalLen = arrays.reduce((sum, arr) => sum + (arr?.length ?? 0), 0);
    if (totalLen === 0) return null;
    const merged = new Float32Array(totalLen);
    let offset = 0;
    for (const arr of arrays) {
      if (!arr) continue;
      merged.set(arr, offset);
      offset += arr.length;
    }
    return merged;
  }

  /**
   * Remove spawn points that are too close to scene UV borders.
   * This prevents shoreline/interior emitters from treating map borders as
   * valid spawn regions when full-bleed water masks touch the scene edge.
   *
   * @param {Float32Array|null} points - Packed (u, v, strength) triples
   * @param {number} sceneW
   * @param {number} sceneH
   * @returns {Float32Array|null}
   * @private
   */
  _filterSceneEdgeUvPoints(points, sceneW, sceneH) {
    if (!points || points.length < 3) return points;

    // Keep this hardcoded for now; applies equally to splashes and bubbles.
    const edgeInsetPx = 24;
    if (!Number.isFinite(sceneW) || !Number.isFinite(sceneH) || sceneW <= 0 || sceneH <= 0 || edgeInsetPx <= 0) {
      return points;
    }

    const uInset = Math.max(0, Math.min(0.49, edgeInsetPx / sceneW));
    const vInset = Math.max(0, Math.min(0.49, edgeInsetPx / sceneH));
    if (uInset <= 0 && vInset <= 0) return points;

    const maxLen = points.length;
    const kept = new Float32Array(maxLen);
    let keptCount = 0;

    for (let i = 0; i < maxLen; i += 3) {
      const u = points[i];
      const v = points[i + 1];
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      if (u <= uInset || u >= (1.0 - uInset) || v <= vInset || v >= (1.0 - vInset)) continue;

      kept[keptCount++] = u;
      kept[keptCount++] = v;
      kept[keptCount++] = points[i + 2];
    }

    if (keptCount === 0) return null;
    if (keptCount === maxLen) return points;
    return new Float32Array(kept.buffer, 0, keptCount);
  }

  /**
   * Spatially bucket (u,v,strength) points for efficient emitter splitting.
   * @param {Float32Array} points - Packed triples
   * @param {number} sceneW
   * @param {number} sceneH
   * @param {number} sceneX
   * @param {number} sceneY
   * @returns {Map<number, number[]>}
   * @private
   */
  _spatialBucket(points, sceneW, sceneH, sceneX, sceneY) {
    const buckets = new Map();
    for (let i = 0; i < points.length; i += 3) {
      const u = points[i];
      const v = points[i + 1];
      const s = points[i + 2];
      if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(s) || s <= 0) continue;
      const worldX = sceneX + u * sceneW;
      const worldY = sceneY + (1.0 - v) * sceneH;
      const bx = Math.floor(worldX / BUCKET_SIZE);
      const by = Math.floor(worldY / BUCKET_SIZE);
      const key = ((bx & 0xFFFF) << 16) | (by & 0xFFFF);
      let arr = buckets.get(key);
      if (!arr) { arr = []; buckets.set(key, arr); }
      arr.push(u, v, s);
    }
    return buckets;
  }

  // ── Private: Floor resolution ──────────────────────────────────────────────

  /** Same logic as FireEffectV2 and FloorRenderBus. @private */
  _resolveFloorIndex(tileDoc, floors) {
    if (!floors || floors.length <= 1) return 0;

    if (tileHasLevelsRange(tileDoc)) {
      const flags = readTileLevelsFlags(tileDoc);
      const tileBottom = Number(flags.rangeBottom);
      const tileTop = Number(flags.rangeTop);
      const tileMid = (tileBottom + tileTop) / 2;

      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileMid >= f.elevationMin && tileMid < f.elevationMax) return i;
      }
      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileBottom <= f.elevationMax && f.elevationMin <= tileTop) return i;
      }
    }

    const v14Idx = resolveV14NativeDocFloorIndexMin(tileDoc, globalThis.canvas?.scene);
    if (v14Idx !== null) return v14Idx;

    // Same fallback path as FireEffectV2/FloorCompositor: resolve native level ids.
    try {
      if (hasV14NativeLevels(globalThis.canvas?.scene)) {
        const singleLevel = tileDoc?.level ?? tileDoc?._source?.level;
        if (typeof singleLevel === 'string' && singleLevel.length > 0) {
          for (let i = 0; i < floors.length; i += 1) {
            if (floors[i].levelId === singleLevel) return i;
          }
        }
        const levelsSet = tileDoc?.levels;
        if (levelsSet?.size) {
          for (const lid of levelsSet) {
            for (let i = 0; i < floors.length; i += 1) {
              if (floors[i].levelId === lid) return i;
            }
          }
        }
      }
    } catch (_) {}

    const elev = Number.isFinite(Number(tileDoc?.elevation)) ? Number(tileDoc.elevation) : 0;
    for (let i = 0; i < floors.length; i++) {
      const f = floors[i];
      if (elev >= f.elevationMin && elev <= f.elevationMax) return i;
    }
    return 0;
  }

  // ── Static schema (Tweakpane) ───────────────────────────────────────────

  /**
   * Tweakpane control schema for WaterSplashesEffectV2.
   * @returns {object}
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'tint-jitter',
          label: 'Tint (Jitter)',
          type: 'inline',
          parameters: [
            'tintStrength',
            'tintJitter',
            'tintAColorR',
            'tintAColorG',
            'tintAColorB',
            'tintBColorR',
            'tintBColorG',
            'tintBColorB',
          ]
        },
        {
          name: 'foam',
          label: 'Foam (Shoreline)',
          type: 'inline',
          parameters: [
            'foamEnabled',
            'foamRate',
            'foamPeakOpacity',
            'foamLifeMin',
            'foamLifeMax',
            'foamSizeMin',
            'foamSizeMax',
            'foamWindDriftScale',
            'foamColorR',
            'foamColorG',
            'foamColorB',
          ]
        },
        {
          name: 'splashes',
          label: 'Splashes (Rain on Water)',
          type: 'inline',
          separator: true,
          parameters: [
            'splashEnabled',
            'splashRate',
            'splashPeakOpacity',
            'splashLifeMin',
            'splashLifeMax',
            'splashSizeMin',
            'splashSizeMax',
            'splashWindDriftScale',
          ]
        },
        {
          name: 'mask-scan',
          label: 'Mask Scan / Density',
          type: 'inline',
          separator: true,
          parameters: [
            'maskThreshold',
            'edgeScanStride',
            'interiorScanStride',
          ]
        }
      ],
      parameters: {
        tintStrength: { type: 'slider', label: 'Strength', min: 0, max: 2, step: 0.01, default: 2.0 },
        tintJitter: { type: 'slider', label: 'Jitter', min: 0, max: 2, step: 0.01, default: 0.75 },
        tintAColorR: { type: 'slider', label: 'A R', min: 0, max: 2, step: 0.01, default: 1.24 },
        tintAColorG: { type: 'slider', label: 'A G', min: 0, max: 2, step: 0.01, default: 1.54 },
        tintAColorB: { type: 'slider', label: 'A B', min: 0, max: 2, step: 0.01, default: 1.32 },
        tintBColorR: { type: 'slider', label: 'B R', min: 0, max: 2, step: 0.01, default: 0.10 },
        tintBColorG: { type: 'slider', label: 'B G', min: 0, max: 2, step: 0.01, default: 0.55 },
        tintBColorB: { type: 'slider', label: 'B B', min: 0, max: 2, step: 0.01, default: 0.75 },

        foamEnabled: { type: 'boolean', label: 'Enabled', default: true },
        foamRate: { type: 'slider', label: 'Rate', min: 0, max: 200, step: 0.1, default: 54.3 },
        foamPeakOpacity: { type: 'slider', label: 'Peak Opacity', min: 0, max: 1, step: 0.01, default: 0.64 },
        foamLifeMin: { type: 'slider', label: 'Life Min', min: 0.05, max: 20, step: 0.05, default: 0.5 },
        foamLifeMax: { type: 'slider', label: 'Life Max', min: 0.05, max: 20, step: 0.05, default: 1.0 },
        foamSizeMin: { type: 'slider', label: 'Size Min', min: 1, max: 1000, step: 1, default: 102 },
        foamSizeMax: { type: 'slider', label: 'Size Max', min: 1, max: 1000, step: 1, default: 167 },
        foamWindDriftScale: { type: 'slider', label: 'Wind Drift', min: 0, max: 2, step: 0.01, default: 2.0 },
        foamColorR: { type: 'slider', label: 'Color R', min: 0, max: 2, step: 0.01, default: 0.17 },
        foamColorG: { type: 'slider', label: 'Color G', min: 0, max: 2, step: 0.01, default: 0.24 },
        foamColorB: { type: 'slider', label: 'Color B', min: 0, max: 2, step: 0.01, default: 0.15 },

        splashEnabled: { type: 'boolean', label: 'Enabled', default: true },
        splashRate: { type: 'slider', label: 'Rate', min: 0, max: 400, step: 0.1, default: 234.8 },
        splashPeakOpacity: { type: 'slider', label: 'Peak Opacity', min: 0, max: 1, step: 0.01, default: 0.84 },
        splashLifeMin: { type: 'slider', label: 'Life Min', min: 0.05, max: 10, step: 0.05, default: 0.3 },
        splashLifeMax: { type: 'slider', label: 'Life Max', min: 0.05, max: 10, step: 0.05, default: 0.8 },
        splashSizeMin: { type: 'slider', label: 'Size Min', min: 1, max: 1000, step: 1, default: 99 },
        splashSizeMax: { type: 'slider', label: 'Size Max', min: 1, max: 1000, step: 1, default: 457 },
        splashWindDriftScale: { type: 'slider', label: 'Splash Wind Drift', min: 0, max: 2, step: 0.01, default: 1.0 },

        maskThreshold: { type: 'slider', label: 'Water Threshold', min: 0.0, max: 1.0, step: 0.01, default: 0.15 },
        edgeScanStride: { type: 'slider', label: 'Edge Stride', min: 1, max: 16, step: 1, default: 2 },
        interiorScanStride: { type: 'slider', label: 'Interior Stride', min: 1, max: 32, step: 1, default: 4 },
      }
    };
  }

  /**
   * Separate Tweakpane control schema for the built-in underwater bubbles layer.
   * This maps to `effect.bubblesParams` via special-case routing in FloorCompositor
   * and canvas-replacement.
   *
   * @returns {object}
   */
  static getBubblesControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'tint-jitter',
          label: 'Tint (Jitter)',
          type: 'inline',
          parameters: [
            'tintStrength',
            'tintJitter',
            'tintAColorR',
            'tintAColorG',
            'tintAColorB',
            'tintBColorR',
            'tintBColorG',
            'tintBColorB',
          ]
        },
        {
          name: 'foam',
          label: 'Bubbles (Shoreline)',
          type: 'inline',
          parameters: [
            'foamEnabled',
            'foamRate',
            'foamPeakOpacity',
            'foamLifeMin',
            'foamLifeMax',
            'foamSizeMin',
            'foamSizeMax',
            'foamWindDriftScale',
            'foamColorR',
            'foamColorG',
            'foamColorB',
          ]
        },
        {
          name: 'splashes',
          label: 'Rings (Interior)',
          type: 'inline',
          separator: true,
          parameters: [
            'splashEnabled',
            'splashRate',
            'splashPeakOpacity',
            'splashLifeMin',
            'splashLifeMax',
            'splashSizeMin',
            'splashSizeMax',
            'splashWindDriftScale',
          ]
        },
      ],
      parameters: {
        tintStrength: { type: 'slider', label: 'Strength', min: 0, max: 2, step: 0.01, default: 1.41 },
        tintJitter: { type: 'slider', label: 'Jitter', min: 0, max: 2, step: 0.01, default: 1.00 },
        tintAColorR: { type: 'slider', label: 'A R', min: 0, max: 2, step: 0.01, default: 0.74 },
        tintAColorG: { type: 'slider', label: 'A G', min: 0, max: 2, step: 0.01, default: 0.8 },
        tintAColorB: { type: 'slider', label: 'A B', min: 0, max: 2, step: 0.01, default: 0.71 },
        tintBColorR: { type: 'slider', label: 'B R', min: 0, max: 2, step: 0.01, default: 0.51 },
        tintBColorG: { type: 'slider', label: 'B G', min: 0, max: 2, step: 0.01, default: 0.87 },
        tintBColorB: { type: 'slider', label: 'B B', min: 0, max: 2, step: 0.01, default: 0.76 },

        foamEnabled: { type: 'boolean', label: 'Enabled', default: true },
        foamRate: { type: 'slider', label: 'Rate', min: 0, max: 200, step: 0.1, default: 14.8 },
        foamPeakOpacity: { type: 'slider', label: 'Peak Opacity', min: 0, max: 1, step: 0.01, default: 0.88 },
        foamLifeMin: { type: 'slider', label: 'Life Min', min: 0.05, max: 20, step: 0.05, default: 1.2 },
        foamLifeMax: { type: 'slider', label: 'Life Max', min: 0.05, max: 20, step: 0.05, default: 3.25 },
        foamSizeMin: { type: 'slider', label: 'Size Min', min: 1, max: 1000, step: 1, default: 35 },
        foamSizeMax: { type: 'slider', label: 'Size Max', min: 1, max: 1000, step: 1, default: 373 },
        foamWindDriftScale: { type: 'slider', label: 'Wind Drift', min: 0, max: 2, step: 0.01, default: 2.0 },
        foamColorR: { type: 'slider', label: 'Color R', min: 0, max: 2, step: 0.01, default: 0.97 },
        foamColorG: { type: 'slider', label: 'Color G', min: 0, max: 2, step: 0.01, default: 0.982 },
        foamColorB: { type: 'slider', label: 'Color B', min: 0, max: 2, step: 0.01, default: 1.0 },

        splashEnabled: { type: 'boolean', label: 'Enabled', default: true },
        splashRate: { type: 'slider', label: 'Rate', min: 0, max: 400, step: 0.1, default: 47 },
        splashPeakOpacity: { type: 'slider', label: 'Peak Opacity', min: 0, max: 1, step: 0.01, default: 0.7 },
        splashLifeMin: { type: 'slider', label: 'Life Min', min: 0.05, max: 10, step: 0.05, default: 0.3 },
        splashLifeMax: { type: 'slider', label: 'Life Max', min: 0.05, max: 10, step: 0.05, default: 0.8 },
        splashSizeMin: { type: 'slider', label: 'Size Min', min: 1, max: 1000, step: 1, default: 35 },
        splashSizeMax: { type: 'slider', label: 'Size Max', min: 1, max: 1000, step: 1, default: 77 },
        splashWindDriftScale: { type: 'slider', label: 'Splash Wind Drift', min: 0, max: 2, step: 0.01, default: 1.0 },
      }
    };
  }
}
