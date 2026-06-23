/**
 * @fileoverview BloomEffectV2 — V2 screen-space bloom post-processing pass.
 *
 * Single shared mip-chain bloom — half-res Gaussian mips, tent upsample, additive
 * combine in one final pass. Surface and atmosphere differ only in composite weights.
 *
 * Fog clip: vision mask applied in the high-pass shader before blur.
 * Outdoor spill: final combine attenuates bloom on dark outdoor pixels using the
 * original scene buffer (no pre-bloom snapshot RT).
 *
 * @module compositor-v2/effects/BloomEffectV2
 */

import { createLogger } from '../../core/log.js';
import {
  GLSL_DECODE_OUTDOORS_MASK,
  GLSL_SCREEN_TO_SCENE_UV,
  applySceneViewProjectionToUniforms,
  createSceneViewProjectionCache,
  updateSceneViewProjectionFromCamera,
} from '../scene-view-projection.js';

const log = createLogger('BloomEffectV2');

/** Mip levels in each bloom chain. */
const BLOOM_N_MIPS = 5;
/** Round-robin GPU timer slots for nested bloom render spans (one active query per frame). */
const BLOOM_GPU_SLOT_COUNT = 4;
const BLOOM_GPU_SLOTS = {
  prep: { index: 0, count: BLOOM_GPU_SLOT_COUNT },
  highPass: { index: 1, count: BLOOM_GPU_SLOT_COUNT },
  blurMips: { index: 2, count: BLOOM_GPU_SLOT_COUNT },
  output: { index: 3, count: BLOOM_GPU_SLOT_COUNT },
};
/** Fullscreen draws when bloom active: highPass + mip blurs + composite + upsample + final combine. */
const BLOOM_ACTIVE_FULLSCREEN_PASSES = 1 + (BLOOM_N_MIPS * 2) + 1 + 1 + 1;
/** Per-mip separable Gaussian tap counts (unified — max of surface/atmo per level). */
const SURFACE_MIP_KERNEL_TAPS = [5, 5, 7, 7, 9];
const ATMO_MIP_KERNEL_TAPS = [5, 7, 7, 9, 9];
const UNIFIED_MIP_KERNEL_TAPS = SURFACE_MIP_KERNEL_TAPS.map(
  (s, i) => Math.max(s, ATMO_MIP_KERNEL_TAPS[i]),
);
/** Per-mip spread multiplier at radius scale 1.0 (mip downscale carries reach). */
const SURFACE_MIP_SPREAD_PX = [3, 4, 5, 6, 7];
const ATMO_MIP_SPREAD_PX = [5, 7, 9, 12, 16];
/** Weighted mip combine factors. */
const BLOOM_MIP_FACTORS = [1, 0.8, 0.6, 0.4, 0.2];
/** UI / param range caps for radius sliders. */
const ATMO_RADIUS_MAX = 12;
/** Half-res → full-res tent upsample spread. */
const FULLRES_UPSAMPLE_SPREAD = 1.5;
const SURFACE_RADIUS_MAX = 2;

/** Precompute Gaussian weights for a separable kernel (matches UnrealBloomPass). */
function buildGaussianCoefficients(kernelRadius) {
  const coefficients = [];
  for (let i = 0; i < kernelRadius; i++) {
    coefficients.push(
      0.39894 * Math.exp(-0.5 * i * i / (kernelRadius * kernelRadius)) / kernelRadius,
    );
  }
  return coefficients;
}

const BLOOM_FULLSCREEN_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** Separable Gaussian blur (horizontal or vertical). KERNEL_RADIUS set per material. */
const BLOOM_GAUSSIAN_FRAG = /* glsl */`
  uniform sampler2D colorTexture;
  uniform vec2 invSize;
  uniform vec2 direction;
  uniform float uRadiusScale;
  uniform float gaussianCoefficients[KERNEL_RADIUS];
  varying vec2 vUv;

  void main() {
    float scale = max(uRadiusScale, 0.001);
    float weightSum = gaussianCoefficients[0];
    vec3 diffuseSum = texture2D(colorTexture, vUv).rgb * weightSum;
    for (int i = 1; i < KERNEL_RADIUS; i++) {
      float x = float(i);
      float w = gaussianCoefficients[i];
      vec2 uvOffset = direction * invSize * x * scale;
      vec3 sample1 = texture2D(colorTexture, vUv + uvOffset).rgb;
      vec3 sample2 = texture2D(colorTexture, vUv - uvOffset).rgb;
      diffuseSum += (sample1 + sample2) * w;
      weightSum += 2.0 * w;
    }
    gl_FragColor = vec4(diffuseSum / max(weightSum, 1.0e-5), 1.0);
  }
`;

/** Upsample half-res bloom composite to full-res with a small tent filter. */
const BLOOM_UPSAMPLE_FRAG = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform vec2 uTexelSize;
  varying vec2 vUv;

  void main() {
    vec3 sum = texture2D(tDiffuse, vUv).rgb * 4.0;
    sum += texture2D(tDiffuse, vUv + vec2( uTexelSize.x, 0.0)).rgb;
    sum += texture2D(tDiffuse, vUv + vec2(-uTexelSize.x, 0.0)).rgb;
    sum += texture2D(tDiffuse, vUv + vec2(0.0,  uTexelSize.y)).rgb;
    sum += texture2D(tDiffuse, vUv + vec2(0.0, -uTexelSize.y)).rgb;
    vec2 d = uTexelSize * ${FULLRES_UPSAMPLE_SPREAD.toFixed(1)};
    sum += texture2D(tDiffuse, vUv + vec2( d.x,  d.y)).rgb;
    sum += texture2D(tDiffuse, vUv + vec2(-d.x,  d.y)).rgb;
    sum += texture2D(tDiffuse, vUv + vec2( d.x, -d.y)).rgb;
    sum += texture2D(tDiffuse, vUv + vec2(-d.x, -d.y)).rgb;
    gl_FragColor = vec4(sum / 12.0, 1.0);
  }
`;

/** Shared GLSL for sampling FogOfWar vision in bloom high-pass (Foundry scene UV). */
const BLOOM_FOG_VISION_GLSL = /* glsl */`
  ${GLSL_SCREEN_TO_SCENE_UV}

  float msBloomSampleMaskSoft(sampler2D tex, vec2 uv, vec2 texel, float radiusPx) {
    float r = clamp(radiusPx, 0.0, 32.0);
    if (r <= 0.01) return texture2D(tex, uv).r;

    vec2 d1 = texel * max(1.0, r * 0.5);
    vec2 d2 = texel * max(1.0, r);

    float c = texture2D(tex, uv).r * 0.25;
    float cross = 0.0;
    cross += texture2D(tex, uv + vec2(d1.x, 0.0)).r;
    cross += texture2D(tex, uv + vec2(-d1.x, 0.0)).r;
    cross += texture2D(tex, uv + vec2(0.0, d1.y)).r;
    cross += texture2D(tex, uv + vec2(0.0, -d1.y)).r;
    float diag = 0.0;
    diag += texture2D(tex, uv + vec2(d2.x, d2.y)).r;
    diag += texture2D(tex, uv + vec2(-d2.x, d2.y)).r;
    diag += texture2D(tex, uv + vec2(d2.x, -d2.y)).r;
    diag += texture2D(tex, uv + vec2(-d2.x, -d2.y)).r;
    return c + cross * 0.125 + diag * 0.0625;
  }

  float msBloomMaskEdge01(float sampleVal, float softnessPx) {
    float softness = max(softnessPx, 0.0);
    float d = max(fwidth(sampleVal), 1e-4);
    float dPx = (sampleVal - 0.5) / d;
    return (softness <= 0.01)
      ? step(0.5, sampleVal)
      : smoothstep(-softness, softness, dPx);
  }

  float msBloomVisionVisible(vec2 sceneUvRaw, vec2 visionTexel, float softnessPx) {
    float inScene = msInSceneBounds(sceneUvRaw);
    vec2 visionUv = clamp(sceneUvRaw, 0.0, 1.0);
    float vision = msBloomSampleMaskSoft(tVision, visionUv, visionTexel, softnessPx);
    return msBloomMaskEdge01(vision, softnessPx) * inScene;
  }
`;

const BLOOM_HIGH_PASS_FRAG = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform sampler2D tVision;
  uniform float uFogInputMaskEnabled;
  uniform float uVisionSoftnessPx;
  uniform vec2 uVisionTexelSize;
  uniform vec2 uFogSceneOrigin;
  uniform vec2 uFogSceneSize;
  uniform vec2 uViewCorner00;
  uniform vec2 uViewCorner10;
  uniform vec2 uViewCorner01;
  uniform vec2 uViewCorner11;
  uniform vec2 uSceneDimensions;
  uniform vec3 defaultColor;
  uniform float defaultOpacity;
  uniform float luminosityThreshold;
  uniform float smoothWidth;
  varying vec2 vUv;

  ${BLOOM_FOG_VISION_GLSL}

  float bloomLuma(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
  }

  void main() {
    vec4 texel = texture2D(tDiffuse, vUv);
    vec3 rgb = texel.rgb;
    if (uFogInputMaskEnabled > 0.5) {
      vec2 sceneUvRaw = msScreenUvToSceneUvRaw(
        vUv, uViewCorner00, uViewCorner10, uViewCorner01, uViewCorner11,
        uFogSceneOrigin, uFogSceneSize, uSceneDimensions
      );
      float visible = msBloomVisionVisible(sceneUvRaw, uVisionTexelSize, uVisionSoftnessPx);
      rgb *= visible;
    }
    float luma = bloomLuma(rgb);

    float rq = clamp(luma - luminosityThreshold + smoothWidth * 0.5, 0.0, smoothWidth);
    float curve = smoothWidth > 0.001
      ? (rq * rq) / (2.0 * smoothWidth)
      : max(luma - luminosityThreshold, 0.0);

    float intensity = max(luma - luminosityThreshold, curve);
    vec3 extracted = rgb * (intensity / max(luma, 1.0e-5));

    gl_FragColor = vec4(extracted, texel.a);
  }
`;

const BLOOM_DUAL_COMPOSITE_FRAG = /* glsl */`
  varying vec2 vUv;
  uniform sampler2D blurTexture1;
  uniform sampler2D blurTexture2;
  uniform sampler2D blurTexture3;
  uniform sampler2D blurTexture4;
  uniform sampler2D blurTexture5;
  uniform float uSurfaceActive;
  uniform float uAtmoActive;
  uniform float uSurfaceStrength;
  uniform float uSurfaceRadius;
  uniform float uSurfaceBlend;
  uniform float uAtmoStrength;
  uniform float uAtmoRadius;
  uniform float uAtmoBlend;
  uniform float bloomFactors[5];
  uniform vec3 uSurfaceTintColors[5];
  uniform vec3 uAtmoTintColors[5];

  float lerpBloomFactor(const in float factor, const in float bloomRadius) {
    float mirrorFactor = 1.2 - factor;
    return mix(factor, mirrorFactor, bloomRadius);
  }

  void main() {
    vec3 m1 = texture2D(blurTexture1, vUv).rgb;
    vec3 m2 = texture2D(blurTexture2, vUv).rgb;
    vec3 m3 = texture2D(blurTexture3, vUv).rgb;
    vec3 m4 = texture2D(blurTexture4, vUv).rgb;
    vec3 m5 = texture2D(blurTexture5, vUv).rgb;
    vec3 bloom = vec3(0.0);
    if (uSurfaceActive > 0.5) {
      bloom += uSurfaceStrength * uSurfaceBlend * (
        lerpBloomFactor(bloomFactors[0], uSurfaceRadius) * uSurfaceTintColors[0] * m1 +
        lerpBloomFactor(bloomFactors[1], uSurfaceRadius) * uSurfaceTintColors[1] * m2 +
        lerpBloomFactor(bloomFactors[2], uSurfaceRadius) * uSurfaceTintColors[2] * m3 +
        lerpBloomFactor(bloomFactors[3], uSurfaceRadius) * uSurfaceTintColors[3] * m4 +
        lerpBloomFactor(bloomFactors[4], uSurfaceRadius) * uSurfaceTintColors[4] * m5
      );
    }
    if (uAtmoActive > 0.5) {
      bloom += uAtmoStrength * uAtmoBlend * (
        lerpBloomFactor(bloomFactors[0], uAtmoRadius) * uAtmoTintColors[0] * m1 +
        lerpBloomFactor(bloomFactors[1], uAtmoRadius) * uAtmoTintColors[1] * m2 +
        lerpBloomFactor(bloomFactors[2], uAtmoRadius) * uAtmoTintColors[2] * m3 +
        lerpBloomFactor(bloomFactors[3], uAtmoRadius) * uAtmoTintColors[3] * m4 +
        lerpBloomFactor(bloomFactors[4], uAtmoRadius) * uAtmoTintColors[4] * m5
      );
    }
    gl_FragColor = vec4(bloom, 1.0);
  }
`;

const BLOOM_FINAL_COMBINE_FRAG = /* glsl */`
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform sampler2D uOutdoorsMask;
  uniform float uHasOutdoorsMask;
  uniform float uOutdoorsMaskFlipY;
  uniform float uSpillEnabled;
  uniform float uSpillLumLo;
  uniform float uSpillLumHi;
  uniform vec2 uViewCorner00;
  uniform vec2 uViewCorner10;
  uniform vec2 uViewCorner01;
  uniform vec2 uViewCorner11;
  uniform vec2 uSceneOrigin;
  uniform vec2 uSceneSize;
  uniform vec2 uSceneDimensions;
  varying vec2 vUv;

  ${GLSL_SCREEN_TO_SCENE_UV}
  ${GLSL_DECODE_OUTDOORS_MASK}

  void main() {
    vec3 scene = texture2D(tScene, vUv).rgb;
    vec3 bloom = texture2D(tBloom, vUv).rgb;
    float bloomKeep = 1.0;

    if (uSpillEnabled > 0.5 && uHasOutdoorsMask > 0.5) {
      vec2 sceneUvRaw = msScreenUvToSceneUvRaw(
        vUv, uViewCorner00, uViewCorner10, uViewCorner01, uViewCorner11,
        uSceneOrigin, uSceneSize, uSceneDimensions
      );
      float inScene = msInSceneBounds(sceneUvRaw);
      vec2 maskUv = clamp(sceneUvRaw, 0.0, 1.0);
      if (uOutdoorsMaskFlipY > 0.5) maskUv.y = 1.0 - maskUv.y;
      float outdoor = msDecodeOutdoorsMaskSample(texture2D(uOutdoorsMask, maskUv)) * inScene;

      float preLum = max(scene.r, max(scene.g, scene.b));
      float localBright = smoothstep(uSpillLumLo, max(uSpillLumHi, uSpillLumLo + 1.0e-4), preLum);
      bloomKeep = mix(1.0, localBright, outdoor);
    }

    gl_FragColor = vec4(scene + bloom * bloomKeep, 1.0);
  }
`;

export class BloomEffectV2 {
  constructor() {
    /** @type {boolean} */
    this._initialized = false;

    this.params = {
      enabled: true,
      strength: 1.08,
      radius: 1,
      threshold: 3.01,
      tintColor: { r: 1, g: 1, b: 1 },
      blendOpacity: 1.0,
      // Wide atmospheric scatter from the same bright extract (air catching surface light).
      atmoEnabled: true,
      atmoStrength: 0.42,
      atmoRadius: 3.5,
      atmoTintColor: { r: 1, g: 0.92, b: 0.78 },
      atmoBlendOpacity: 0.72,
      // WaterEffectV2 writes a linear specular mask; injected here before bloom threshold.
      waterSpecularBloomEnabled: true,
      waterSpecularBloomStrength: 8,
      waterSpecularBloomGamma: 0.81,
      // During landscape/map-point lightning the scene gets a broad HDR lift; bloom
      // can turn that into visible bands — adapt threshold/strength while strikes play.
      lightningBloomAdaptEnabled: true,
      lightningBloomThresholdBoost: 2.0,
      lightningBloomStrengthMul: 0.3,
      lightningBloomRadiusMul: 0.55,
      lightningBloomSmoothWidth: 0.45,
      lightningBloomBlendMul: 0.65,
      lightningBloomPassthroughPeak: 0.88,
      lightningBloomMapPointWeight: 0.15,
      // Outdoor spill: blur from indoor window glow lands on dark outdoor ground —
      // suppress bloom there unless the base HDR scene is already bright locally.
      outdoorSpillSuppressEnabled: true,
      outdoorSpillLumLoMul: 0.42,
      outdoorSpillLumHiMul: 0.92,
      // Clip convolved bloom to current LOS (FogOfWar vision mask).
      fogClipEnabled: true,
    };

    /** @type {number} Effective pass strength after lightning adaptation. */
    this._effectiveStrength = 0.4;
    /** @type {number} Effective pass threshold after lightning adaptation. */
    this._effectiveThreshold = 2;
    /** @type {number} Effective surface radius after lightning adaptation. */
    this._effectiveRadius = 1;
    /** @type {number} Effective blend opacity after lightning adaptation. */
    this._effectiveBlendOpacity = 1;
    /** @type {number} Effective atmospheric strength after lightning adaptation. */
    this._effectiveAtmoStrength = 0.42;
    /** @type {number} Effective atmospheric radius after lightning adaptation. */
    this._effectiveAtmoRadius = 3.5;
    /** @type {number} Effective atmospheric blend opacity after lightning adaptation. */
    this._effectiveAtmoBlendOpacity = 0.72;
    /** @type {boolean} Skip bloom entirely during the brightest strike peak. */
    this._lightningPassthrough = false;

    // ── Bloom GPU resources ──────────────────────────────────────────────
    /** @type {THREE.ShaderMaterial|null} Luminance high-pass extract. */
    this._bloomHighPassMaterial = null;
    /** @type {Object|null} High-pass uniforms (smoothWidth for lightning adapt). */
    this._bloomHighPassUniforms = null;
    /** @type {THREE.ShaderMaterial[]} Unified separable Gaussian blur per mip. */
    this._blurMaterials = [];
    /** @type {THREE.Vector2|null} Blur axis scratch (horizontal). */
    this._blurDirX = null;
    /** @type {THREE.Vector2|null} Blur axis scratch (vertical). */
    this._blurDirY = null;
    /** @type {THREE.ShaderMaterial|null} Dual-layer mip composite (half-res). */
    this._bloomCompositeMaterial = null;
    /** @type {THREE.ShaderMaterial|null} Scene + bloom final combine. */
    this._bloomFinalCombineMaterial = null;
    /** @type {THREE.Vector3[]} Per-mip tint colors (surface). */
    this._bloomTintColors = null;
    /** @type {THREE.Vector3[]} Per-mip tint colors (atmosphere). */
    this._atmoTintColors = null;
    /** @type {THREE.WebGLRenderTarget|null} Half-res bright extract. */
    this._bloomBrightRT = null;
    /** @type {THREE.WebGLRenderTarget[]} Shared mip blur targets. */
    this._bloomMipRTs = [];
    /** @type {THREE.WebGLRenderTarget|null} Blur ping-pong scratch. */
    this._bloomBlurPingRT = null;
    /** @type {THREE.WebGLRenderTarget|null} Dual-layer composite output (half-res). */
    this._bloomCompositeRT = null;
    /** @type {THREE.WebGLRenderTarget|null} Full-res bloom layer (upsampled, bloom-only). */
    this._bloomFullResRT = null;
    /** @type {THREE.ShaderMaterial|null} Half-res → full-res tent upsample. */
    this._bloomUpsampleMaterial = null;
    /** @type {THREE.Scene|null} Fullscreen quad scene for internal bloom passes. */
    this._bloomProcessScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._bloomProcessCamera = null;
    /** @type {THREE.Mesh|null} */
    this._bloomProcessQuad = null;

    /**
     * Optional full-res scratch for water-specular pre-composite only.
     * @type {THREE.WebGLRenderTarget|null}
     */
    this._sceneSourceRT = null;

    // Copy/blit resources for RT-to-RT transfers
    /** @type {THREE.Scene|null} */
    this._copyScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._copyCamera = null;
    /** @type {THREE.MeshBasicMaterial|null} */
    this._copyMaterial = null;
    /** @type {THREE.Mesh|null} */
    this._copyQuad = null;

    /** @type {THREE.Vector3|null} */
    this._tintVec = null;
    /** @type {THREE.Vector3|null} */
    this._atmoTintVec = null;
    this._lastTintR = null;
    this._lastTintG = null;
    this._lastTintB = null;
    this._lastAtmoTintR = null;
    this._lastAtmoTintG = null;
    this._lastAtmoTintB = null;

    /** @type {THREE.Texture|null} Second target from WaterEffectV2 MRT (linear RGB mask). */
    this._waterSpecBloomTexture = null;

    /** @type {THREE.Scene|null} */
    this._waterBloomCompositeScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._waterBloomCompositeCamera = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._waterBloomCompositeMaterial = null;
    /** @type {THREE.DataTexture|null} */
    this._black1x1Texture = null;

    /** @type {THREE.Texture|null} Active-floor / stacked `_Outdoors` for spill suppression. */
    this._outdoorsMask = null;

    /** @type {THREE.Texture|null} Current vision mask from FogOfWarEffectV2. */
    this._fogVisionTexture = null;
    /** @type {number} Fog vision softness px (from FoW bindings). */
    this._fogVisionSoftnessPx = 0;
    /** @type {THREE.Vector2|null} Fog vision texel size scratch. */
    this._fogVisionTexelSize = null;

    /** @type {import('../scene-view-projection.js').SceneViewProjectionCache} */
    this._viewProjectionCache = createSceneViewProjectionCache();
    this._projTmpNdc = null;
    this._projTmpWorld = null;
    this._projTmpDir = null;

    this._finalCombineScene = null;
    this._finalCombineCamera = null;

    /** @type {import('../../core/diagnostics/PerformanceRecorder.js').PerformanceRecorder|null} */
    this._activePerfRecorder = null;
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

  /**
   * @param {string} name
   * @param {'update'|'render'} [phase='update']
   * @param {{ cpuOnly?: boolean, gpuSlot?: { index: number, count: number } }} [options={}]
   * @returns {object|null}
   * @private
   */
  _beginPerfSpan(name, phase = 'update', options = {}) {
    try {
      const recorder = this._activePerfRecorder;
      if (!recorder?.enabled || typeof recorder.beginEffectCall !== 'function') return null;
      const opts = { cpuOnly: options.cpuOnly === true };
      if (options.gpuSlot) opts.gpuSlot = options.gpuSlot;
      return recorder.beginEffectCall(`bloom.${phase}.${name}`, phase, opts);
    } catch (_) {
      return null;
    }
  }

  /**
   * Live bloom inventory for Performance Recorder exports.
   * @param {THREE.WebGLRenderer|null} [renderer=null]
   * @returns {object}
   */
  getPerformanceRecorderSnapshot(renderer = null) {
    const THREE = window.THREE;
    const p = this.params ?? {};
    const db = renderer?.getDrawingBufferSize?.(THREE ? new THREE.Vector2() : null) ?? null;
    const fullW = this._sceneSourceRT?.width ?? this._bloomFullResRT?.width ?? db?.x ?? 0;
    const fullH = this._sceneSourceRT?.height ?? this._bloomFullResRT?.height ?? db?.y ?? 0;
    const halfW = Math.round(fullW / 2);
    const halfH = Math.round(fullH / 2);

    const surfaceActive = this._effectiveStrength > 1e-6 && this._effectiveBlendOpacity > 1e-6;
    const atmoActive = p.atmoEnabled !== false
      && this._effectiveAtmoStrength > 1e-6
      && this._effectiveAtmoBlendOpacity > 1e-6;
    const bloomActive = !!p.enabled
      && !this._lightningPassthrough
      && (surfaceActive || atmoActive);

    const useWaterBloom = !!this._waterSpecBloomTexture
      && p.waterSpecularBloomEnabled !== false
      && (Number(p.waterSpecularBloomStrength) > 1e-6);
    const useFogInputMask = p.fogClipEnabled !== false && !!this._fogVisionTexture;
    const useSpillSuppress = p.outdoorSpillSuppressEnabled !== false && !!this._outdoorsMask;

    const estimateRtMb = (w, h, halfFloat = true) => {
      const ww = Math.max(0, Number(w) || 0);
      const hh = Math.max(0, Number(h) || 0);
      if (ww === 0 || hh === 0) return 0;
      return (ww * hh * (halfFloat ? 8 : 4)) / (1024 * 1024);
    };

    let estimatedFullscreenPasses = 0;
    if (bloomActive) {
      if (useWaterBloom) estimatedFullscreenPasses += 1;
      estimatedFullscreenPasses += BLOOM_ACTIVE_FULLSCREEN_PASSES;
    }

    const rtInventory = [
      {
        id: 'sceneSource',
        w: fullW,
        h: fullH,
        halfRes: false,
        estMb: useWaterBloom ? estimateRtMb(fullW, fullH, true) : 0,
      },
      {
        id: 'bloomBright',
        w: halfW,
        h: halfH,
        halfRes: true,
        estMb: estimateRtMb(halfW, halfH, true),
      },
      {
        id: 'bloomComposite',
        w: halfW,
        h: halfH,
        halfRes: true,
        estMb: estimateRtMb(halfW, halfH, true),
      },
      {
        id: 'bloomFullRes',
        w: fullW,
        h: fullH,
        halfRes: false,
        estMb: estimateRtMb(fullW, fullH, true),
      },
    ];
    for (let i = 0; i < BLOOM_N_MIPS; i++) {
      const mip = this._bloomMipRTs[i];
      const mw = mip?.width ?? Math.max(1, Math.round(halfW / (2 ** i)));
      const mh = mip?.height ?? Math.max(1, Math.round(halfH / (2 ** i)));
      rtInventory.push({
        id: `sharedMip${i}`,
        w: mw,
        h: mh,
        halfRes: true,
        estMb: estimateRtMb(mw, mh, true),
      });
    }

    return {
      enabled: !!p.enabled,
      passthrough: !!this._lightningPassthrough,
      surfaceActive,
      atmoActive,
      bloomActive,
      fogClipActive: useFogInputMask,
      outdoorSpillActive: useSpillSuppress,
      waterBloomInject: useWaterBloom,
      drawingBuffer: db ? { w: db.x, h: db.y } : null,
      rtFull: { w: fullW, h: fullH },
      rtHalf: { w: halfW, h: halfH },
      mipLevels: BLOOM_N_MIPS,
      estimatedFullscreenPassesPerFrame: estimatedFullscreenPasses,
      effective: {
        threshold: this._effectiveThreshold,
        strength: this._effectiveStrength,
        radius: this._effectiveRadius,
        blendOpacity: this._effectiveBlendOpacity,
        atmoStrength: this._effectiveAtmoStrength,
        atmoRadius: this._effectiveAtmoRadius,
        atmoBlendOpacity: this._effectiveAtmoBlendOpacity,
      },
      params: {
        threshold: Number(p.threshold) || 0,
        strength: Number(p.strength) || 0,
        radius: Number(p.radius) || 0,
        atmoEnabled: p.atmoEnabled !== false,
        atmoStrength: Number(p.atmoStrength) || 0,
        atmoRadius: Number(p.atmoRadius) || 0,
        fogClipEnabled: p.fogClipEnabled !== false,
        outdoorSpillSuppressEnabled: p.outdoorSpillSuppressEnabled !== false,
        waterSpecularBloomEnabled: p.waterSpecularBloomEnabled !== false,
      },
      rtInventory,
      estimatedRtVramMb: Math.round(rtInventory.reduce((s, rt) => s + (rt.estMb || 0), 0) * 100) / 100,
    };
  }

  /** @param {object|null} token @private */
  _endPerfSpan(token) {
    if (!token) return;
    try {
      const recorder = this._activePerfRecorder ?? window.MapShine?.performanceRecorder;
      recorder?.endEffectCall?.(token);
    } catch (_) {}
  }

  // ── UI schema (moved from V1 BloomEffect) ────────────────────────────────

  static getControlSchema() {
    const white = { r: 1, g: 1, b: 1 };
    const warm = { r: 1, g: 0.96, b: 0.88 };
    const neon = { r: 0.75, g: 0.92, b: 1 };

    return {
      enabled: true,
      help: {
        title: 'Bloom (glow)',
        summary: [
          'Separable Gaussian mip-chain bloom — smooth gradients without Vogel-disk grain. Mip downscaling provides wide atmospheric reach.',
          'No tile masks required. Runs after the main scene is composited (post-processing).',
          'Surface and atmosphere share threshold, fog clip, water specular inject, and lightning adaptation — only strength, radius, tint, and mix are independent.',
          'Water specular can feed a dedicated linear mask (see Water → Bloom link) so sun glints bloom strongly without over-brightening the base image.',
          'During lightning strikes bloom can adapt automatically (Lightning strike folder) to avoid banded halos from broad HDR flash lifts.',
          'Fog clip (advanced) uses the Fog of War vision mask so bloom cannot spill into unexplored or out-of-LOS areas.',
          'Performance: one shared mip-chain blur; surface and atmosphere differ in composite weights only. Disable atmosphere or lower radii on weak GPUs.',
          'Persistence: these controls save with the scene (not World Based).',
        ].join('\n\n'),
        glossary: {
          Strength: 'Surface glow intensity — tight halo on bright pixels (lamps, fire, specular).',
          Radius: 'Surface glow spread (0–2). Small values stay near the source; 2 is a wide surface halo.',
          Threshold: 'Brightness cutoff (linear). Only pixels above this contribute to bloom.',
          'Glow tint': 'Tint on the surface bloom layer.',
          'Blend opacity': 'Mix for the surface bloom layer.',
          'Atmosphere enabled': 'Wide secondary bloom from the same bright extract (air catching light).',
          'Atmosphere strength': 'Intensity of the wide atmospheric scatter.',
          'Atmosphere radius': 'Atmospheric spread (0–12). Much larger than surface — simulates air glow.',
          'Atmosphere tint': 'Tint on the atmospheric layer (warm dusk haze by default).',
          'Atmosphere blend': 'Mix for the atmospheric bloom layer.',
          'Water bloom (specular)': 'Adds linear HDR from water specular/highlight mask before threshold — strong glints without crushing the beauty pass.',
          'Water bloom strength': 'How much of the water mask is added into the bloom input (linear).',
          'Water bloom gamma': 'Curve on the injected mask (<1 = punchier peaks, >1 = softer).',
          'Lightning adapt': 'While distant or map-point lightning is active, bloom raises its cutoff and softens the knee so broad HDR flashes do not turn into banded halos.',
          'Lightning threshold boost': 'Extra linear cutoff added during strikes (keeps the flash wash out of bloom).',
          'Lightning strength mul': 'Bloom strength multiplier at full strike intensity (0 = off).',
          'Lightning radius mul': 'Bloom radius multiplier at full strike intensity.',
          'Lightning smooth width': 'Wider high-pass knee during strikes — reduces banding at the cutoff edge.',
          'Lightning blend mul': 'Overall bloom mix multiplier at full strike intensity.',
          'Lightning passthrough peak': 'Above this strike weight, bloom is skipped for one frame path (flash already reads as glow).',
          'Lightning map-point weight': 'How much localized arc flashes contribute to adaptation (lower keeps arc bloom).',
          'Outdoor spill suppress': 'Stops window-light bloom halos from washing onto dark outdoor ground around buildings (_Outdoors mask).',
          'Outdoor spill lum lo': 'Outdoor pixels darker than threshold × this keep no spill bloom.',
          'Outdoor spill lum hi': 'Full outdoor bloom returns when base HDR exceeds threshold × this.',
          'Fog clip': 'Zeros HDR bloom input outside token line-of-sight before the blur runs, so in-fog lights cannot bleed into visible areas.',
        },
      },
      groups: [
        {
          name: 'look',
          label: 'Surface',
          type: 'folder',
          expanded: true,
          parameters: ['strength', 'radius', 'threshold'],
        },
        {
          name: 'atmosphere',
          label: 'Atmosphere',
          type: 'folder',
          expanded: true,
          parameters: ['atmoEnabled', 'atmoStrength', 'atmoRadius', 'atmoTintColor', 'atmoBlendOpacity'],
        },
        {
          name: 'water-spec-bloom',
          label: 'Water specular (bloom)',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: ['waterSpecularBloomEnabled', 'waterSpecularBloomStrength', 'waterSpecularBloomGamma'],
        },
        {
          name: 'grade',
          label: 'Surface grade',
          type: 'folder',
          expanded: true,
          parameters: ['tintColor', 'blendOpacity'],
        },
        {
          name: 'lightning-strike',
          label: 'Lightning strike',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: [
            'lightningBloomAdaptEnabled',
            'lightningBloomThresholdBoost',
            'lightningBloomStrengthMul',
            'lightningBloomRadiusMul',
            'lightningBloomSmoothWidth',
            'lightningBloomBlendMul',
            'lightningBloomPassthroughPeak',
            'lightningBloomMapPointWeight',
          ],
        },
        {
          name: 'outdoor-spill',
          label: 'Outdoor spill (window glow)',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: [
            'outdoorSpillSuppressEnabled',
            'outdoorSpillLumLoMul',
            'outdoorSpillLumHiMul',
          ],
        },
        {
          name: 'fog-clip',
          label: 'Fog clip (vision)',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: ['fogClipEnabled'],
        },
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        strength: {
          type: 'slider',
          label: 'Surface strength',
          min: 0,
          max: 3,
          step: 0.01,
          default: 1.08,
          tooltip: 'Tight surface glow on bright pixels (hot source / specular).',
        },
        radius: {
          type: 'slider',
          label: 'Surface radius',
          min: 0,
          max: SURFACE_RADIUS_MAX,
          step: 0.01,
          default: 1,
          tooltip: 'Spread of the tight surface halo (0–2).',
        },
        threshold: {
          type: 'slider',
          label: 'Threshold',
          min: 0,
          max: 4,
          step: 0.01,
          default: 3.01,
          tooltip: 'Linear brightness floor; only brighter pixels bloom. With the Linear HDR pipeline the merged scene can exceed 1.0, so this range was extended — 1.0 means "only true highlights bloom".',
        },
        tintColor: {
          type: 'color',
          colorType: 'float',
          label: 'Surface tint',
          default: { r: 1, g: 1, b: 1 },
          tooltip: 'Tint on the tight surface bloom.',
        },
        blendOpacity: {
          type: 'slider',
          label: 'Surface blend',
          min: 0,
          max: 1,
          step: 0.01,
          default: 1.0,
          tooltip: 'Mix for the surface bloom layer.',
        },
        atmoEnabled: {
          type: 'boolean',
          default: true,
          label: 'Atmosphere enabled',
          tooltip: 'Wide secondary bloom from the same bright pixels — air catching surface light.',
        },
        atmoStrength: {
          type: 'slider',
          label: 'Atmosphere strength',
          min: 0,
          max: 3,
          step: 0.01,
          default: 0.42,
          tooltip: 'Intensity of the wide atmospheric scatter.',
        },
        atmoRadius: {
          type: 'slider',
          label: 'Atmosphere radius',
          min: 0,
          max: ATMO_RADIUS_MAX,
          step: 0.05,
          default: 3.5,
          tooltip: `Atmospheric spread (0–${ATMO_RADIUS_MAX}). Much wider than surface — haze and air glow.`,
        },
        atmoTintColor: {
          type: 'color',
          colorType: 'float',
          label: 'Atmosphere tint',
          default: { r: 1, g: 0.92, b: 0.78 },
          tooltip: 'Tint on the atmospheric layer (warm haze by default).',
        },
        atmoBlendOpacity: {
          type: 'slider',
          label: 'Atmosphere blend',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.72,
          tooltip: 'Mix for the atmospheric bloom layer.',
        },
        waterSpecularBloomEnabled: {
          type: 'boolean',
          default: true,
          label: 'Link water specular',
          tooltip: 'When on (and water renders a mask), add water specular energy into the bloom input before threshold.',
        },
        waterSpecularBloomStrength: {
          type: 'slider',
          label: 'Water bloom strength',
          min: 0,
          max: 8,
          step: 0.01,
          default: 8,
          tooltip: 'Linear HDR added from the water specular mask. Push high for aggressive sun glints.',
        },
        waterSpecularBloomGamma: {
          type: 'slider',
          label: 'Water bloom gamma',
          min: 0.35,
          max: 3,
          step: 0.01,
          default: 0.81,
          tooltip: 'Shapes the injected mask before bloom (1 = linear). Lower emphasizes peaks.',
        },
        lightningBloomAdaptEnabled: {
          type: 'boolean',
          default: true,
          label: 'Adapt during strikes',
          tooltip: 'Raise bloom cutoff and soften the high-pass knee while lightning flashes are active to avoid banded halos.',
        },
        lightningBloomThresholdBoost: {
          type: 'slider',
          label: 'Strike threshold boost',
          min: 0,
          max: 4,
          step: 0.05,
          default: 2.0,
          tooltip: 'Added to the linear threshold at full strike intensity — keeps broad flash wash out of bloom.',
        },
        lightningBloomStrengthMul: {
          type: 'slider',
          label: 'Strike strength mul',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.3,
          tooltip: 'Bloom strength multiplier when a strike is at peak (flash already adds glow).',
        },
        lightningBloomRadiusMul: {
          type: 'slider',
          label: 'Strike radius mul',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.55,
          tooltip: 'Bloom spread multiplier at full strike intensity — tighter blur reduces banding.',
        },
        lightningBloomSmoothWidth: {
          type: 'slider',
          label: 'Strike smooth width',
          min: 0.05,
          max: 1.5,
          step: 0.01,
          default: 0.45,
          tooltip: 'High-pass knee width during strikes (wider = softer cutoff, fewer bands).',
        },
        lightningBloomBlendMul: {
          type: 'slider',
          label: 'Strike blend mul',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.65,
          tooltip: 'Blend opacity multiplier at full strike intensity.',
        },
        lightningBloomPassthroughPeak: {
          type: 'slider',
          label: 'Passthrough peak',
          min: 0.5,
          max: 1,
          step: 0.01,
          default: 0.88,
          tooltip: 'Skip bloom entirely above this strike weight — useful for the brightest flash peak.',
        },
        lightningBloomMapPointWeight: {
          type: 'slider',
          label: 'Map-point adapt weight',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.15,
          tooltip: 'How much localized arc flashes affect adaptation (lower preserves arc bloom).',
        },
        outdoorSpillSuppressEnabled: {
          type: 'boolean',
          default: true,
          label: 'Suppress outdoor spill',
          tooltip: 'Remove bloom on dark outdoor pixels (_Outdoors) so indoor window glow does not halo onto surrounding ground.',
        },
        outdoorSpillLumLoMul: {
          type: 'slider',
          label: 'Spill lum lo (× threshold)',
          min: 0.05,
          max: 1.5,
          step: 0.01,
          default: 0.42,
          tooltip: 'Outdoor pixels below threshold × this lose spilled bloom entirely.',
        },
        outdoorSpillLumHiMul: {
          type: 'slider',
          label: 'Spill lum hi (× threshold)',
          min: 0.1,
          max: 2.0,
          step: 0.01,
          default: 0.92,
          tooltip: 'Outdoor pixels above threshold × this keep full bloom (sun, torches, water glints).',
        },
        fogClipEnabled: {
          type: 'boolean',
          default: true,
          label: 'Clip to vision (FoW)',
          tooltip: 'Mask bloom source pixels to current token LOS before blur — stops distant in-fog glow from leaking into seen areas.',
        },
      },
      presets: {
        'Clear Noon': {
          strength: 0.55,
          radius: 0.35,
          threshold: 1.15,
          tintColor: { ...white },
          blendOpacity: 1.0,
        },
        'Golden Hour': {
          strength: 0.75,
          radius: 0.55,
          threshold: 1.0,
          tintColor: { ...warm },
          blendOpacity: 1.0,
        },
        'Overcast Day': {
          strength: 0.35,
          radius: 0.55,
          threshold: 1.25,
          tintColor: { r: 0.92, g: 0.96, b: 1.0 },
          blendOpacity: 0.85,
        },
        Storm: {
          strength: 0.25,
          radius: 0.7,
          threshold: 1.45,
          tintColor: { r: 0.85, g: 0.92, b: 1.0 },
          blendOpacity: 0.8,
        },
        'Moonlit Night': {
          strength: 0.5,
          radius: 0.4,
          threshold: 0.95,
          tintColor: { r: 0.75, g: 0.86, b: 1.0 },
          blendOpacity: 0.9,
        },
        'Interior Night': {
          strength: 0.65,
          radius: 0.35,
          threshold: 0.9,
          tintColor: { r: 1.0, g: 0.88, b: 0.68 },
          blendOpacity: 1.0,
        },
        Subtle: {
          strength: 0.45,
          radius: 0.2,
          threshold: 1.15,
          tintColor: { ...white },
          blendOpacity: 1.0,
        },
        Strong: {
          strength: 0.9,
          radius: 0.75,
          threshold: 0.95,
          tintColor: { ...white },
          blendOpacity: 1.0,
        },
        Dreamy: {
          strength: 1.1,
          radius: 1.0,
          threshold: 0.85,
          tintColor: { ...warm },
          blendOpacity: 1.0,
        },
        Neon: {
          strength: 1.8,
          radius: 0.3,
          threshold: 0.55,
          tintColor: { ...neon },
          blendOpacity: 1.0,
        },
      },
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * @param {number} w - Render target width
   * @param {number} h - Render target height
   */
  initialize(w, h) {
    const THREE = window.THREE;
    if (!THREE) {
      log.warn('THREE not available — bloom disabled');
      return;
    }

    this._buildBloomBlurResources(w, h);

    this._sceneSourceRT = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this._sceneSourceRT.texture.colorSpace = THREE.LinearSRGBColorSpace;

    this._bloomFullResRT = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this._bloomFullResRT.texture.colorSpace = THREE.LinearSRGBColorSpace;

    this._projTmpNdc = new THREE.Vector3();
    this._projTmpWorld = new THREE.Vector3();
    this._projTmpDir = new THREE.Vector3();

    this._fogVisionTexelSize = new THREE.Vector2(1, 1);

    this._buildFinalCombinePass();

    // Copy scene for RT-to-RT blits
    this._copyScene = new THREE.Scene();
    this._copyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._copyMaterial = new THREE.MeshBasicMaterial({ map: null });
    this._copyMaterial.toneMapped = false;
    this._copyQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this._copyMaterial
    );
    this._copyQuad.frustumCulled = false;
    this._copyScene.add(this._copyQuad);

    const blackPx = new Uint8Array([0, 0, 0, 255]);
    this._black1x1Texture = new THREE.DataTexture(blackPx, 1, 1, THREE.RGBAFormat);
    this._black1x1Texture.needsUpdate = true;

    this._waterBloomCompositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tWaterSpecBloom: { value: this._black1x1Texture },
        uWaterBloomMix: { value: 0 },
        uWaterBloomGamma: { value: 1.0 },
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
        uniform sampler2D tWaterSpecBloom;
        uniform float uWaterBloomMix;
        uniform float uWaterBloomGamma;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          vec3 h0 = texture2D(tWaterSpecBloom, vUv).rgb * uWaterBloomMix;
          float g = max(0.05, uWaterBloomGamma);
          vec3 h = pow(max(h0, vec3(0.0)), vec3(g));
          gl_FragColor = vec4(c.rgb + h, c.a);
        }
      `,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const wbQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this._waterBloomCompositeMaterial
    );
    wbQuad.frustumCulled = false;
    this._waterBloomCompositeScene = new THREE.Scene();
    this._waterBloomCompositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._waterBloomCompositeScene.add(wbQuad);

    this._tintVec = new THREE.Vector3(1, 1, 1);
    this._atmoTintVec = new THREE.Vector3(1, 0.92, 0.78);
    this._updateTintColor();
    this._updateAtmoTintColor();

    this._initialized = true;
    log.info(`BloomEffectV2 initialized (${w}x${h}, shared mip-chain bloom)`);
  }

  /**
   * @param {typeof window.THREE} THREE
   * @param {number} kernelRadius
   * @returns {THREE.ShaderMaterial}
   * @private
   */
  _createGaussianBlurMaterial(THREE, kernelRadius) {
    return new THREE.ShaderMaterial({
      defines: { KERNEL_RADIUS: kernelRadius },
      uniforms: {
        colorTexture: { value: null },
        invSize: { value: new THREE.Vector2(0.5, 0.5) },
        direction: { value: new THREE.Vector2(1, 0) },
        uRadiusScale: { value: 1.0 },
        gaussianCoefficients: { value: buildGaussianCoefficients(kernelRadius) },
      },
      vertexShader: BLOOM_FULLSCREEN_VERT,
      fragmentShader: BLOOM_GAUSSIAN_FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
  }

  /**
   * Build mip-chain bloom resources (separable Gaussian per mip).
   * @param {number} w
   * @param {number} h
   * @private
   */
  _buildBloomBlurResources(w, h) {
    const THREE = window.THREE;
    const rtOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    };

    let resx = Math.round(w / 2);
    let resy = Math.round(h / 2);

    this._bloomBrightRT = new THREE.WebGLRenderTarget(resx, resy, rtOpts);
    this._bloomBrightRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this._bloomBrightRT.texture.generateMipmaps = false;

    this._bloomMipRTs = [];
    for (let i = 0; i < BLOOM_N_MIPS; i++) {
      const rt = new THREE.WebGLRenderTarget(resx, resy, rtOpts);
      rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
      rt.texture.generateMipmaps = false;
      this._bloomMipRTs.push(rt);

      resx = Math.round(resx / 2);
      resy = Math.round(resy / 2);
    }

    this._bloomCompositeRT = new THREE.WebGLRenderTarget(
      Math.round(w / 2),
      Math.round(h / 2),
      rtOpts,
    );
    this._bloomCompositeRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this._bloomCompositeRT.texture.generateMipmaps = false;

    this._bloomBlurPingRT = new THREE.WebGLRenderTarget(
      Math.round(w / 2),
      Math.round(h / 2),
      rtOpts,
    );
    this._bloomBlurPingRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this._bloomBlurPingRT.texture.generateMipmaps = false;

    this._blurDirX = new THREE.Vector2(1, 0);
    this._blurDirY = new THREE.Vector2(0, 1);

    this._blurMaterials = UNIFIED_MIP_KERNEL_TAPS.map(
      (k) => this._createGaussianBlurMaterial(THREE, k),
    );

    this._bloomUpsampleMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uTexelSize: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: BLOOM_FULLSCREEN_VERT,
      fragmentShader: BLOOM_UPSAMPLE_FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    this._bloomHighPassUniforms = {
      tDiffuse: { value: null },
      tVision: { value: null },
      uFogInputMaskEnabled: { value: 0.0 },
      uVisionSoftnessPx: { value: 0.0 },
      uVisionTexelSize: { value: new THREE.Vector2(1, 1) },
      uFogSceneOrigin: { value: new THREE.Vector2(0, 0) },
      uFogSceneSize: { value: new THREE.Vector2(1, 1) },
      uViewCorner00: { value: new THREE.Vector2(0, 0) },
      uViewCorner10: { value: new THREE.Vector2(1, 0) },
      uViewCorner01: { value: new THREE.Vector2(0, 1) },
      uViewCorner11: { value: new THREE.Vector2(1, 1) },
      uSceneDimensions: { value: new THREE.Vector2(1, 1) },
      luminosityThreshold: { value: this.params.threshold },
      smoothWidth: { value: 0.01 },
      defaultColor: { value: new THREE.Color(0) },
      defaultOpacity: { value: 0 },
    };
    this._bloomHighPassMaterial = new THREE.ShaderMaterial({
      extensions: { derivatives: true },
      uniforms: this._bloomHighPassUniforms,
      vertexShader: BLOOM_FULLSCREEN_VERT,
      fragmentShader: BLOOM_HIGH_PASS_FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    this._bloomTintColors = [];
    this._atmoTintColors = [];
    for (let i = 0; i < BLOOM_N_MIPS; i++) {
      this._bloomTintColors.push(new THREE.Vector3(1, 1, 1));
      this._atmoTintColors.push(new THREE.Vector3(1, 1, 1));
    }

    this._bloomCompositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        blurTexture1: { value: this._bloomMipRTs[0].texture },
        blurTexture2: { value: this._bloomMipRTs[1].texture },
        blurTexture3: { value: this._bloomMipRTs[2].texture },
        blurTexture4: { value: this._bloomMipRTs[3].texture },
        blurTexture5: { value: this._bloomMipRTs[4].texture },
        uSurfaceActive: { value: 1.0 },
        uAtmoActive: { value: 1.0 },
        uSurfaceStrength: { value: this.params.strength },
        uSurfaceRadius: { value: this.params.radius / SURFACE_RADIUS_MAX },
        uSurfaceBlend: { value: this.params.blendOpacity },
        uAtmoStrength: { value: this.params.atmoStrength },
        uAtmoRadius: { value: this.params.atmoRadius / ATMO_RADIUS_MAX },
        uAtmoBlend: { value: this.params.atmoBlendOpacity },
        bloomFactors: { value: BLOOM_MIP_FACTORS },
        uSurfaceTintColors: { value: this._bloomTintColors },
        uAtmoTintColors: { value: this._atmoTintColors },
      },
      vertexShader: BLOOM_FULLSCREEN_VERT,
      fragmentShader: BLOOM_DUAL_COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    this._bloomProcessScene = new THREE.Scene();
    this._bloomProcessCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._bloomProcessQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this._bloomHighPassMaterial,
    );
    this._bloomProcessQuad.frustumCulled = false;
    this._bloomProcessScene.add(this._bloomProcessQuad);
  }

  /**
   * @private
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.ShaderMaterial} material
   * @param {THREE.WebGLRenderTarget} targetRT
   */
  _renderBloomFullscreen(renderer, material, targetRT) {
    this._bloomProcessQuad.material = material;
    renderer.setRenderTarget(targetRT);
    renderer.clear();
    renderer.render(this._bloomProcessScene, this._bloomProcessCamera);
  }

  /**
   * Separable Gaussian blur from `srcTex` into `destRT` (H → ping, V → dest).
   * @private
   */
  _gaussianBlurMip(renderer, srcTex, destRT, mipIndex, radius, layerOpts = {}) {
    const radiusMax = layerOpts.radiusMax ?? SURFACE_RADIUS_MAX;
    const spreadBase = layerOpts.spreadBase ?? 0.55;
    const spreadGain = layerOpts.spreadGain ?? 1.0;
    const spreadTable = layerOpts.spreadTable ?? SURFACE_MIP_SPREAD_PX;
    const blurMaterials = layerOpts.blurMaterials ?? this._blurMaterials;

    const w = destRT.width;
    const h = destRT.height;
    const mat = blurMaterials[mipIndex] ?? blurMaterials[blurMaterials.length - 1];
    if (!mat) return;

    const baseSpread = spreadTable[mipIndex] ?? spreadTable[spreadTable.length - 1];
    const radiusNorm = Math.max(0, Number(radius) || 0) / Math.max(radiusMax, 1e-3);
    const radiusScale = (spreadBase + radiusNorm * spreadGain) * (baseSpread / 4.0);

    if (this._bloomBlurPingRT.width !== w || this._bloomBlurPingRT.height !== h) {
      this._bloomBlurPingRT.setSize(w, h);
    }

    const u = mat.uniforms;
    u.invSize.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
    u.uRadiusScale.value = radiusScale;

    u.colorTexture.value = srcTex;
    u.direction.value.copy(this._blurDirX);
    this._renderBloomFullscreen(renderer, mat, this._bloomBlurPingRT);

    u.colorTexture.value = this._bloomBlurPingRT.texture;
    u.direction.value.copy(this._blurDirY);
    this._renderBloomFullscreen(renderer, mat, destRT);
  }

  /**
   * Upsample half-res bloom composite to full-res (tent filter only — no full-res polish).
   * @private
   */
  _upsampleBloom(renderer, halfResTex, fullW, fullH) {
    if (!this._bloomFullResRT || !this._bloomUpsampleMaterial) {
      return halfResTex;
    }

    if (this._bloomFullResRT.width !== fullW || this._bloomFullResRT.height !== fullH) {
      this._bloomFullResRT.setSize(fullW, fullH);
    }

    const up = this._bloomUpsampleMaterial.uniforms;
    up.tDiffuse.value = halfResTex;
    up.uTexelSize.value.set(1 / Math.max(1, fullW), 1 / Math.max(1, fullH));
    this._renderBloomFullscreen(renderer, this._bloomUpsampleMaterial, this._bloomFullResRT);

    return this._bloomFullResRT.texture;
  }

  /**
   * @private
   * @returns {{ spreadTable: number[], radiusMax: number, spreadBase: number, spreadGain: number, blurRadius: number }}
   */
  _resolveBlurChainOpts(surfaceActive, atmoActive) {
    if (atmoActive) {
      return {
        spreadTable: ATMO_MIP_SPREAD_PX,
        radiusMax: ATMO_RADIUS_MAX,
        spreadBase: 0.7,
        spreadGain: 2.2,
        blurRadius: this._effectiveAtmoRadius,
      };
    }
    return {
      spreadTable: SURFACE_MIP_SPREAD_PX,
      radiusMax: SURFACE_RADIUS_MAX,
      spreadBase: 0.55,
      spreadGain: 1.0,
      blurRadius: this._effectiveRadius,
    };
  }

  /**
   * Shared mip-chain blur + dual-layer composite + full-res upsample (bloom-only buffer).
   * @private
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Texture} sceneTex
   * @param {number} fullW
   * @param {number} fullH
   * @param {THREE.Camera|null} camera
   */
  _runBloomCore(renderer, sceneTex, fullW, fullH, camera = null) {
    const surfaceActive = this._effectiveStrength > 1e-6 && this._effectiveBlendOpacity > 1e-6;
    const atmoActive = this.params.atmoEnabled !== false
      && this._effectiveAtmoStrength > 1e-6
      && this._effectiveAtmoBlendOpacity > 1e-6;

    let _perfToken = this._beginPerfSpan('core.highPass', 'render', { gpuSlot: BLOOM_GPU_SLOTS.highPass });
    this._syncHighPassFogUniforms(camera);
    this._bloomHighPassUniforms.tDiffuse.value = sceneTex;
    this._bloomHighPassUniforms.luminosityThreshold.value = this._effectiveThreshold;
    this._renderBloomFullscreen(renderer, this._bloomHighPassMaterial, this._bloomBrightRT);
    this._endPerfSpan(_perfToken);

    const blurOpts = this._resolveBlurChainOpts(surfaceActive, atmoActive);
    _perfToken = this._beginPerfSpan('core.blurMips', 'render', { gpuSlot: BLOOM_GPU_SLOTS.blurMips });
    let inputTex = this._bloomBrightRT.texture;
    for (let i = 0; i < BLOOM_N_MIPS; i++) {
      this._gaussianBlurMip(renderer, inputTex, this._bloomMipRTs[i], i, blurOpts.blurRadius, blurOpts);
      inputTex = this._bloomMipRTs[i].texture;
    }
    this._endPerfSpan(_perfToken);

    _perfToken = this._beginPerfSpan('core.composite', 'render', { cpuOnly: true });
    const cu = this._bloomCompositeMaterial.uniforms;
    cu.uSurfaceActive.value = surfaceActive ? 1.0 : 0.0;
    cu.uAtmoActive.value = atmoActive ? 1.0 : 0.0;
    cu.uSurfaceStrength.value = this._effectiveStrength;
    cu.uSurfaceRadius.value = Math.min(1, Math.max(0, this._effectiveRadius / SURFACE_RADIUS_MAX));
    cu.uSurfaceBlend.value = this._effectiveBlendOpacity;
    cu.uAtmoStrength.value = this._effectiveAtmoStrength;
    cu.uAtmoRadius.value = Math.min(1, Math.max(0, this._effectiveAtmoRadius / ATMO_RADIUS_MAX));
    cu.uAtmoBlend.value = this._effectiveAtmoBlendOpacity;
    cu.uSurfaceTintColors.value = this._bloomTintColors;
    cu.uAtmoTintColors.value = this._atmoTintColors;
    this._renderBloomFullscreen(renderer, this._bloomCompositeMaterial, this._bloomCompositeRT);
    this._endPerfSpan(_perfToken);

    _perfToken = this._beginPerfSpan('core.upscale', 'render', { cpuOnly: true });
    this._upsampleBloom(renderer, this._bloomCompositeRT.texture, fullW, fullH);
    this._endPerfSpan(_perfToken);
  }

  // ── Per-frame update ──────────────────────────────────────────────────

  /**
   * Bind `_Outdoors` for outdoor bloom spill suppression (white = outdoor).
   * @param {THREE.Texture|null} texture
   */
  setOutdoorsMask(texture) {
    this._outdoorsMask = texture ?? null;
    const u = this._bloomFinalCombineMaterial?.uniforms;
    if (!u) return;
    u.uOutdoorsMask.value = texture ?? null;
    u.uHasOutdoorsMask.value = texture ? 1.0 : 0.0;
    u.uOutdoorsMaskFlipY.value = texture?.flipY ? 1.0 : 0.0;
  }

  /**
   * Bind FogOfWar textures for bloom spill clipping.
   * @param {{
   *   active?: boolean,
   *   visionTexture?: import('three').Texture|null,
   *   exploredTexture?: import('three').Texture|null,
   *   explorationEnabled?: boolean,
   *   exploredOpacity?: number,
   *   softnessPx?: number,
   *   visionTexelSize?: { x?: number, y?: number },
   *   exploredTexelSize?: { x?: number, y?: number },
   *   sceneOrigin?: { x?: number, y?: number },
   *   sceneSize?: { x?: number, y?: number },
   * }|null} bindings
   */
  setFogClipBindings(bindings) {
    const active = bindings?.active === true && bindings?.visionTexture;
    this._fogVisionTexture = active ? bindings.visionTexture : null;
    this._fogVisionSoftnessPx = Math.max(0, Number(bindings?.softnessPx) || 0);
    const vts = bindings?.visionTexelSize;
    this._fogVisionTexelSize?.set(
      Math.max(1e-6, Number(vts?.x) || 1),
      Math.max(1e-6, Number(vts?.y) || 1),
    );
    this._fogBindingsOrigin = active && bindings?.sceneOrigin
      ? { x: Number(bindings.sceneOrigin.x) || 0, y: Number(bindings.sceneOrigin.y) || 0 }
      : null;
    this._fogBindingsSize = active && bindings?.sceneSize
      ? {
        x: Math.max(1, Number(bindings.sceneSize.x) || 1),
        y: Math.max(1, Number(bindings.sceneSize.y) || 1),
      }
      : null;
  }

  /**
   * @private
   * @param {THREE.Camera|null} camera
   */
  _syncSceneProjectionUniforms(uniforms, camera) {
    const dims = canvas?.dimensions;
    const cam = camera
      ?? window.MapShine?.sceneComposer?.camera
      ?? null;
    if (!uniforms || !cam || !dims) return;

    const sc = window.MapShine?.sceneComposer;
    const groundZ = sc?.basePlaneMesh?.position?.z ?? (sc?.groundZ ?? 0);
    updateSceneViewProjectionFromCamera(
      cam,
      groundZ,
      this._viewProjectionCache,
      { ndc: this._projTmpNdc, world: this._projTmpWorld, dir: this._projTmpDir },
    );
    applySceneViewProjectionToUniforms(this._viewProjectionCache, uniforms);

    const sr = dims.sceneRect ?? dims;
    const originUniform = uniforms.uFogSceneOrigin ?? uniforms.uSceneOrigin;
    const sizeUniform = uniforms.uFogSceneSize ?? uniforms.uSceneSize;
    if (originUniform?.value) {
      originUniform.value.set(Number(sr?.x) || 0, Number(sr?.y) || 0);
    }
    if (sizeUniform?.value) {
      sizeUniform.value.set(
        Math.max(1, Number(sr?.width) || Number(dims.width) || 1),
        Math.max(1, Number(sr?.height) || Number(dims.height) || 1),
      );
    }
    if (uniforms.uSceneDimensions) {
      uniforms.uSceneDimensions.value.set(
        Number(dims.width) || 1,
        Number(dims.height) || 1,
      );
    }
  }

  /**
   * @private
   * @param {THREE.Camera|null} camera
   */
  _syncHighPassFogUniforms(camera) {
    const u = this._bloomHighPassUniforms;
    if (!u) return;

    const active = this._fogVisionTexture && this.params.fogClipEnabled !== false;
    const black = this._black1x1Texture;
    u.uFogInputMaskEnabled.value = active ? 1.0 : 0.0;
    u.tVision.value = active ? this._fogVisionTexture : black;
    u.uVisionSoftnessPx.value = this._fogVisionSoftnessPx;
    u.uVisionTexelSize.value.set(
      this._fogVisionTexelSize?.x ?? 1,
      this._fogVisionTexelSize?.y ?? 1,
    );

    if (active) {
      this._syncSceneProjectionUniforms(u, camera);
      if (this._fogBindingsOrigin) {
        u.uFogSceneOrigin.value.set(this._fogBindingsOrigin.x, this._fogBindingsOrigin.y);
      }
      if (this._fogBindingsSize) {
        u.uFogSceneSize.value.set(this._fogBindingsSize.x, this._fogBindingsSize.y);
      }
    }
  }

  /**
   * @private
   */
  _buildFinalCombinePass() {
    const THREE = window.THREE;
    if (!THREE) return;

    this._bloomFinalCombineMaterial = new THREE.ShaderMaterial({
      extensions: { derivatives: true },
      uniforms: {
        tScene: { value: null },
        tBloom: { value: null },
        uOutdoorsMask: { value: null },
        uHasOutdoorsMask: { value: 0.0 },
        uOutdoorsMaskFlipY: { value: 0.0 },
        uSpillEnabled: { value: 1.0 },
        uSpillLumLo: { value: 0.8 },
        uSpillLumHi: { value: 1.8 },
        uViewCorner00: { value: new THREE.Vector2(0, 0) },
        uViewCorner10: { value: new THREE.Vector2(1, 0) },
        uViewCorner01: { value: new THREE.Vector2(0, 1) },
        uViewCorner11: { value: new THREE.Vector2(1, 1) },
        uSceneOrigin: { value: new THREE.Vector2(0, 0) },
        uSceneSize: { value: new THREE.Vector2(1, 1) },
        uSceneDimensions: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: BLOOM_FINAL_COMBINE_FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._bloomFinalCombineMaterial);
    quad.frustumCulled = false;
    this._finalCombineScene = new THREE.Scene();
    this._finalCombineScene.add(quad);
    this._finalCombineCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /**
   * @private
   * @param {THREE.Camera|null} camera
   */
  _syncFinalCombineProjectionUniforms(camera) {
    this._syncSceneProjectionUniforms(this._bloomFinalCombineMaterial?.uniforms, camera);
  }

  /**
   * @private
   */
  _copyRT(renderer, srcTex, destRT) {
    this._copyMaterial.map = srcTex;
    renderer.setRenderTarget(destRT);
    renderer.autoClear = true;
    renderer.render(this._copyScene, this._copyCamera);
  }

  /**
   * Push current params to the bloom pass.
   * @param {{ elapsed: number, delta: number }} _timeInfo
   */
  update(_timeInfo) {
    if (!this._initialized || !this._bloomHighPassMaterial) return;
    if (!this.params.enabled) return;
    this._bindPerfRecorder();

    let _perfToken = this._beginPerfSpan('lightningAdapt', 'update', { cpuOnly: true });
    this._applyLightningAdaptationToPass();
    this._endPerfSpan(_perfToken);

    // Update tint colors if changed
    const tc = this.params.tintColor;
    if (tc.r !== this._lastTintR || tc.g !== this._lastTintG || tc.b !== this._lastTintB) {
      _perfToken = this._beginPerfSpan('tintColor', 'update', { cpuOnly: true });
      this._updateTintColor();
      this._endPerfSpan(_perfToken);
    }
    const atc = this.params.atmoTintColor;
    if (atc.r !== this._lastAtmoTintR || atc.g !== this._lastAtmoTintG || atc.b !== this._lastAtmoTintB) {
      _perfToken = this._beginPerfSpan('atmoTintColor', 'update', { cpuOnly: true });
      this._updateAtmoTintColor();
      this._endPerfSpan(_perfToken);
    }
  }

  /**
   * Apply the current tint color to all bloom mip levels.
   * @private
   */
  /**
   * @param {THREE.Texture|null} tex - RGB linear mask from WaterEffectV2, or null to disable.
   */
  setWaterSpecularBloomTexture(tex) {
    this._waterSpecBloomTexture = tex || null;
  }

  /**
   * Strike weight from MapShine environment (0..1). Landscape wash drives most
   * of the banding; map-point arcs contribute lightly so localized bloom remains.
   * @returns {number}
   * @private
   */
  _resolveLightningAdaptWeight() {
    if (this.params.lightningBloomAdaptEnabled === false) return 0;
    try {
      const env = window.MapShine?.environment;
      const landscape01 = Math.max(0, Math.min(1, Number(env?.landscapeLightningFlash01) || 0));
      const mapPoint01 = Math.max(0, Math.min(1, Number(env?.lightningFlash01) || 0));
      const mapWeight = Math.max(0, Math.min(1, Number(this.params.lightningBloomMapPointWeight) ?? 0.15));
      return Math.max(landscape01, mapPoint01 * mapWeight);
    } catch (_) {
      return 0;
    }
  }

  /**
   * Derive effective bloom pass params while lightning is active.
   * @param {number} strikeWeight
   * @returns {{
   *   strength: number,
   *   threshold: number,
   *   radius: number,
   *   blendOpacity: number,
   *   atmoStrength: number,
   *   atmoRadius: number,
   *   atmoBlendOpacity: number,
   *   smoothWidth: number,
   *   passthrough: boolean,
   * }}
   * @private
   */
  _computeLightningAdaptation(strikeWeight) {
    const p = this.params;
    const w = Math.max(0, Math.min(1, Number(strikeWeight) || 0));
    const baseStrength = Math.max(0, Number(p.strength) || 0);
    const baseThreshold = Math.max(0, Number(p.threshold) || 0);
    const baseRadius = Math.max(0, Number(p.radius) || 0);
    const baseBlend = Math.max(0, Math.min(1, Number(p.blendOpacity) ?? 1));
    const baseAtmoStrength = p.atmoEnabled === false
      ? 0
      : Math.max(0, Number(p.atmoStrength) || 0);
    const baseAtmoRadius = Math.max(0, Number(p.atmoRadius) || 0);
    const baseAtmoBlend = Math.max(0, Math.min(1, Number(p.atmoBlendOpacity) ?? 1));

    if (w <= 1e-4) {
      return {
        strength: baseStrength,
        threshold: baseThreshold,
        radius: baseRadius,
        blendOpacity: baseBlend,
        atmoStrength: baseAtmoStrength,
        atmoRadius: baseAtmoRadius,
        atmoBlendOpacity: baseAtmoBlend,
        smoothWidth: 0.01,
        passthrough: false,
      };
    }

    const thresholdBoost = Math.max(0, Number(p.lightningBloomThresholdBoost) ?? 2.0);
    const strengthMul = Math.max(0, Math.min(1, Number(p.lightningBloomStrengthMul) ?? 0.3));
    const radiusMul = Math.max(0, Math.min(1, Number(p.lightningBloomRadiusMul) ?? 0.55));
    const blendMul = Math.max(0, Math.min(1, Number(p.lightningBloomBlendMul) ?? 0.65));
    const smoothPeak = Math.max(0.05, Number(p.lightningBloomSmoothWidth) ?? 0.45);
    const passthroughPeak = Math.max(0.5, Math.min(1, Number(p.lightningBloomPassthroughPeak) ?? 0.88));

    const lerp = (a, b) => a + (b - a) * w;
    const effectiveStrength = baseStrength * lerp(1, strengthMul);
    const effectiveThreshold = baseThreshold + w * thresholdBoost;
    const effectiveRadius = baseRadius * lerp(1, radiusMul);
    const effectiveBlend = baseBlend * lerp(1, blendMul);
    const effectiveAtmoStrength = baseAtmoStrength * lerp(1, strengthMul);
    const effectiveAtmoRadius = baseAtmoRadius * lerp(1, radiusMul);
    const effectiveAtmoBlend = baseAtmoBlend * lerp(1, blendMul);
    const anyBloom = (effectiveStrength > 1e-6 && effectiveBlend > 1e-6)
      || (effectiveAtmoStrength > 1e-6 && effectiveAtmoBlend > 1e-6);
    const passthrough = w >= passthroughPeak || !anyBloom;

    return {
      strength: effectiveStrength,
      threshold: effectiveThreshold,
      radius: effectiveRadius,
      blendOpacity: effectiveBlend,
      atmoStrength: effectiveAtmoStrength,
      atmoRadius: effectiveAtmoRadius,
      atmoBlendOpacity: effectiveAtmoBlend,
      smoothWidth: lerp(0.01, smoothPeak),
      passthrough,
    };
  }

  /**
   * Push strike-aware params to the bloom pass. Called from update() and render()
   * so bloom reads the same-frame environment (weather lightning publishes after update).
   * @private
   */
  _applyLightningAdaptationToPass() {
    if (!this._bloomHighPassMaterial) return;

    const adapt = this._computeLightningAdaptation(this._resolveLightningAdaptWeight());
    this._lightningPassthrough = adapt.passthrough;
    this._effectiveStrength = adapt.strength;
    this._effectiveThreshold = adapt.threshold;
    this._effectiveRadius = adapt.radius;
    this._effectiveBlendOpacity = adapt.blendOpacity;
    this._effectiveAtmoStrength = adapt.atmoStrength;
    this._effectiveAtmoRadius = adapt.atmoRadius;
    this._effectiveAtmoBlendOpacity = adapt.atmoBlendOpacity;

    if (this._bloomHighPassUniforms?.smoothWidth) {
      this._bloomHighPassUniforms.smoothWidth.value = adapt.smoothWidth;
    }
  }

  _updateTintColor() {
    if (!this._bloomTintColors || !this._tintVec) return;

    const tc = this.params.tintColor;
    this._tintVec.set(tc.r, tc.g, tc.b);

    for (let i = 0; i < this._bloomTintColors.length; i++) {
      this._bloomTintColors[i].copy(this._tintVec);
    }

    this._lastTintR = tc.r;
    this._lastTintG = tc.g;
    this._lastTintB = tc.b;
  }

  _updateAtmoTintColor() {
    if (!this._atmoTintColors || !this._atmoTintVec) return;

    const tc = this.params.atmoTintColor;
    this._atmoTintVec.set(tc.r, tc.g, tc.b);

    for (let i = 0; i < this._atmoTintColors.length; i++) {
      this._atmoTintColors[i].copy(this._atmoTintVec);
    }

    this._lastAtmoTintR = tc.r;
    this._lastAtmoTintG = tc.g;
    this._lastAtmoTintB = tc.b;
  }

  // ── Render ────────────────────────────────────────────────────────────

  /**
   * Copy input → output (used when bloom is disabled or strength is zero).
   * @returns {boolean}
   * @private
   */
  _passthrough(renderer, inputRT, outputRT) {
    if (!this._copyMaterial || !inputRT?.texture || !outputRT) return false;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    try {
      this._copyMaterial.map = inputRT.texture;
      renderer.setRenderTarget(outputRT);
      renderer.autoClear = true;
      renderer.render(this._copyScene, this._copyCamera);
      return true;
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
  }

  /**
   * Execute the bloom post-processing pass.
   *
   * Flow:
   * 1. Optional water-spec composite → scene source texture
   * 2. High-pass extract (fog mask in shader) → half-res bright buffer
   * 3. Single shared Gaussian mip chain → dual-layer composite → upsample
   * 4. Final combine: original scene + bloom layer (+ optional outdoor spill)
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} inputRT
   * @param {THREE.WebGLRenderTarget} outputRT
   * @param {THREE.Camera|null} [camera=null] - For `_Outdoors` spill UV projection.
   * @returns {boolean} True when outputRT was written (bloom or passthrough).
   */
  render(renderer, inputRT, outputRT, camera = null) {
    if (!this._initialized || !this._bloomHighPassMaterial || !inputRT || !outputRT) return false;
    this._bindPerfRecorder();

    let _perfToken = this._beginPerfSpan('lightningAdapt', 'render', { cpuOnly: true });
    this._applyLightningAdaptationToPass();
    this._endPerfSpan(_perfToken);

    const p = this.params;
    const surfaceActive = this._effectiveStrength > 1e-6 && this._effectiveBlendOpacity > 1e-6;
    const atmoActive = p.atmoEnabled !== false
      && this._effectiveAtmoStrength > 1e-6
      && this._effectiveAtmoBlendOpacity > 1e-6;
    if (
      !this.params.enabled
      || this._lightningPassthrough
      || (!surfaceActive && !atmoActive)
    ) {
      _perfToken = this._beginPerfSpan('passthrough', 'render');
      try {
        return this._passthrough(renderer, inputRT, outputRT);
      } finally {
        this._endPerfSpan(_perfToken);
      }
    }

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const fullW = inputRT.width;
    const fullH = inputRT.height;

    try {
      const p0 = this.params;
      const useWaterBloom = this._waterSpecBloomTexture
        && p0.waterSpecularBloomEnabled !== false
        && (Number(p0.waterSpecularBloomStrength) > 1e-6);

      let sceneTex = inputRT.texture;
      if (useWaterBloom && this._waterBloomCompositeMaterial && this._waterBloomCompositeScene) {
        _perfToken = this._beginPerfSpan('prepInput.waterComposite', 'render', { gpuSlot: BLOOM_GPU_SLOTS.prep });
        const wm = this._waterBloomCompositeMaterial.uniforms;
        wm.tDiffuse.value = inputRT.texture;
        wm.tWaterSpecBloom.value = this._waterSpecBloomTexture;
        wm.uWaterBloomMix.value = Number(p0.waterSpecularBloomStrength) || 0;
        wm.uWaterBloomGamma.value = Math.max(0.05, Number(p0.waterSpecularBloomGamma) || 1.0);
        renderer.setRenderTarget(this._sceneSourceRT);
        renderer.autoClear = true;
        renderer.render(this._waterBloomCompositeScene, this._waterBloomCompositeCamera);
        sceneTex = this._sceneSourceRT.texture;
        this._endPerfSpan(_perfToken);
      }

      _perfToken = this._beginPerfSpan('bloomPass', 'render', { cpuOnly: true });
      this._runBloomCore(renderer, sceneTex, fullW, fullH, camera);
      this._endPerfSpan(_perfToken);

      _perfToken = this._beginPerfSpan('finalCombine.prep', 'render', { cpuOnly: true });
      const fu = this._bloomFinalCombineMaterial.uniforms;
      fu.tScene.value = inputRT.texture;
      fu.tBloom.value = this._bloomFullResRT.texture;
      const useSpillSuppress = p0.outdoorSpillSuppressEnabled !== false && !!this._outdoorsMask;
      fu.uSpillEnabled.value = useSpillSuppress ? 1.0 : 0.0;
      if (useSpillSuppress) {
        const effThreshold = Math.max(0, Number(this._effectiveThreshold) || Number(p0.threshold) || 0);
        fu.uSpillLumLo.value = effThreshold * Math.max(0.01, Number(p0.outdoorSpillLumLoMul) ?? 0.42);
        fu.uSpillLumHi.value = effThreshold * Math.max(0.02, Number(p0.outdoorSpillLumHiMul) ?? 0.92);
      }
      this._syncFinalCombineProjectionUniforms(camera);
      this._endPerfSpan(_perfToken);

      _perfToken = this._beginPerfSpan('finalCombine.draw', 'render', { gpuSlot: BLOOM_GPU_SLOTS.output });
      renderer.setRenderTarget(outputRT);
      renderer.autoClear = true;
      renderer.render(this._finalCombineScene, this._finalCombineCamera);
      this._endPerfSpan(_perfToken);
    } catch (e) {
      _perfToken = this._beginPerfSpan('errorPassthrough', 'render');
      try {
        this._copyMaterial.map = inputRT.texture;
        renderer.setRenderTarget(outputRT);
        renderer.autoClear = true;
        renderer.render(this._copyScene, this._copyCamera);
      } catch (_) {}
      this._endPerfSpan(_perfToken);

      if (Math.random() < 0.01) {
        log.warn('BloomEffectV2 render error:', e);
      }
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
    return true;
  }

  // ── Resize ────────────────────────────────────────────────────────────

  /**
   * Resize internal render targets and the bloom mip chain.
   * @param {number} w
   * @param {number} h
   */
  onResize(w, h) {
    if (this._bloomBrightRT) {
      this._bloomBrightRT.setSize(Math.round(w / 2), Math.round(h / 2));
    }
    if (this._bloomCompositeRT) {
      this._bloomCompositeRT.setSize(Math.round(w / 2), Math.round(h / 2));
    }
    if (this._bloomBlurPingRT) {
      this._bloomBlurPingRT.setSize(Math.round(w / 2), Math.round(h / 2));
    }
    let resx = Math.round(w / 2);
    let resy = Math.round(h / 2);
    for (let i = 0; i < this._bloomMipRTs.length; i++) {
      this._bloomMipRTs[i]?.setSize(resx, resy);
      resx = Math.round(resx / 2);
      resy = Math.round(resy / 2);
    }
    if (this._bloomFullResRT) {
      this._bloomFullResRT.setSize(w, h);
    }
    if (this._sceneSourceRT) {
      this._sceneSourceRT.setSize(w, h);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  dispose() {
    try { this._bloomHighPassMaterial?.dispose(); } catch (_) {}
    for (const mat of this._blurMaterials) {
      try { mat?.dispose(); } catch (_) {}
    }
    try { this._bloomCompositeMaterial?.dispose(); } catch (_) {}
    try { this._bloomFinalCombineMaterial?.dispose(); } catch (_) {}
    try { this._bloomUpsampleMaterial?.dispose(); } catch (_) {}
    try { this._bloomFullResRT?.dispose(); } catch (_) {}
    try { this._bloomBrightRT?.dispose(); } catch (_) {}
    try { this._bloomCompositeRT?.dispose(); } catch (_) {}
    try { this._bloomBlurPingRT?.dispose(); } catch (_) {}
    for (const rt of this._bloomMipRTs) {
      try { rt?.dispose(); } catch (_) {}
    }
    try { this._bloomProcessQuad?.geometry?.dispose(); } catch (_) {}
    try { this._sceneSourceRT?.dispose(); } catch (_) {}
    try { this._copyMaterial?.dispose(); } catch (_) {}
    try { this._copyQuad?.geometry?.dispose(); } catch (_) {}
    try {
      const q = this._waterBloomCompositeScene?.children?.[0];
      if (q?.geometry) q.geometry.dispose();
    } catch (_) {}
    try {
      const fq = this._finalCombineScene?.children?.[0];
      if (fq?.geometry) fq.geometry.dispose();
    } catch (_) {}
    try { this._waterBloomCompositeMaterial?.dispose(); } catch (_) {}
    try { this._black1x1Texture?.dispose(); } catch (_) {}
    this._waterBloomCompositeScene = null;
    this._waterBloomCompositeCamera = null;
    this._waterBloomCompositeMaterial = null;
    this._black1x1Texture = null;
    this._waterSpecBloomTexture = null;
    this._bloomHighPassMaterial = null;
    this._bloomHighPassUniforms = null;
    this._blurMaterials = [];
    this._blurDirX = null;
    this._blurDirY = null;
    this._bloomUpsampleMaterial = null;
    this._bloomCompositeMaterial = null;
    this._bloomFinalCombineMaterial = null;
    this._bloomTintColors = null;
    this._atmoTintColors = null;
    this._bloomBrightRT = null;
    this._bloomMipRTs = [];
    this._bloomBlurPingRT = null;
    this._bloomCompositeRT = null;
    this._bloomFullResRT = null;
    this._bloomProcessScene = null;
    this._bloomProcessCamera = null;
    this._bloomProcessQuad = null;
    this._sceneSourceRT = null;
    this._outdoorsMask = null;
    this._fogVisionTexture = null;
    this._finalCombineScene = null;
    this._finalCombineCamera = null;
    this._copyScene = null;
    this._copyCamera = null;
    this._copyMaterial = null;
    this._copyQuad = null;
    this._tintVec = null;
    this._initialized = false;
    log.info('BloomEffectV2 disposed');
  }
}
