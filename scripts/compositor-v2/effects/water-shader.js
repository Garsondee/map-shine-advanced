/**
 * @fileoverview GLSL shaders for V2 Water Effect.
 *
 * V2 design: fullscreen post-processing pass that applies water tint, wave
 * distortion, caustics, specular (GGX), foam, murk, sand, rain ripples,
 * chromatic aberration, and debug views to water areas defined by SDF data.
 *
 * Carried over verbatim from V1 WaterEffectV2 — the full water shader.
 *
 * Still stripped from V1:
 *   - Token mask (tTokenMask)
 *
 * Backfilled in V2:
 *   - Depth pass occlusion
 *   - Cloud shadow integration (tCloudShadow)
 *   - Outdoors mask / indoor damping (tOutdoorsMask)
 *   - Water occluder alpha (tWaterOccluderAlpha)
 *
 * Preserved from V1 (all visual features):
 *   - Texture-based noise (replaces procedural hash for fast compile)
 *   - Rain ripple cellular automaton
 *   - Storm distortion vector field
 *   - Multi-octave wave system with warp, evolution, and wind coupling
 *   - Shore foam with curl noise breakup + floating foam clumps
 *   - Shader-based foam flecks (ifdef USE_FOAM_FLECKS)
 *   - Sand / sediment layer (ifdef USE_SAND)
 *   - Murk (subsurface silt/algae)
 *   - GGX specular with anisotropy
 *   - Chromatic aberration (ifdef USE_WATER_CHROMATIC_ABERRATION)
 *   - Multi-tap refraction (ifdef USE_WATER_REFRACTION_MULTITAP)
 *   - SDF-based edge masking for distortion and chromatic aberration
 *   - Debug views (raw mask, inside, SDF, exposure, normals, wave height)
 *   - Screen UV → Foundry → scene UV coordinate pipeline
 *
 * @module compositor-v2/effects/water-shader
 */

import { DepthShaderChunks } from '../../effects/DepthShaderChunks.js';

// ─── Vertex Shader ───────────────────────────────────────────────────────────

export function getVertexShader() {
  return /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;
}

// ─── Fragment Shader ─────────────────────────────────────────────────────────

export function getFragmentShader() {
  return /* glsl */`
// ── Texture samplers ─────────────────────────────────────────────────────
uniform sampler2D tDiffuse;       // Scene RT (post-lighting)
uniform sampler2D tNoiseMap;      // 512x512 RGBA seeded noise
uniform sampler2D tWaterData;     // SDF data (R=SDF, G=exposure, BA=normals)
uniform float uHasWaterData;      // 1.0 when tWaterData is valid
uniform float uWaterEnabled;      // Master enable

uniform sampler2D tWaterRawMask;  // Raw composited water mask (for foam edge)
uniform float uHasWaterRawMask;   // 1.0 when tWaterRawMask is valid

uniform sampler2D tWaterOccluderAlpha; // Screen-space upper-floor occluder mask
uniform float uHasWaterOccluderAlpha;  // 1.0 when occluder mask is valid

uniform vec2 uWaterDataTexelSize; // 1.0 / tWaterData dimensions

// ── Tint ─────────────────────────────────────────────────────────────────
uniform vec3 uTintColor;
uniform float uTintStrength;

// ── Waves ────────────────────────────────────────────────────────────────
uniform float uWaveScale;
uniform float uWaveSpeed;
uniform float uWaveStrength;
uniform float uDistortionStrengthPx;

uniform float uWaveWarpLargeStrength;
uniform float uWaveWarpSmallStrength;
uniform float uWaveWarpMicroStrength;
uniform float uWaveWarpTimeSpeed;

uniform float uWaveEvolutionEnabled;
uniform float uWaveEvolutionSpeed;
uniform float uWaveEvolutionAmount;
uniform float uWaveEvolutionScale;
uniform float uWaveIndoorDampingEnabled;
uniform float uWaveIndoorDampingStrength;
uniform float uWaveIndoorMinFactor;

// ── Chromatic aberration ─────────────────────────────────────────────────
uniform float uChromaticAberrationStrengthPx;
uniform float uChromaticAberrationEdgeCenter;
uniform float uChromaticAberrationEdgeFeather;
uniform float uChromaticAberrationEdgeGamma;
uniform float uChromaticAberrationEdgeMin;

// ── Distortion edge masking ──────────────────────────────────────────────
uniform float uDistortionEdgeCenter;
uniform float uDistortionEdgeFeather;
uniform float uDistortionEdgeGamma;
uniform float uDistortionShoreRemapLo;
uniform float uDistortionShoreRemapHi;
uniform float uDistortionShorePow;
uniform float uDistortionShoreMin;

// ── Rain ─────────────────────────────────────────────────────────────────
uniform float uRainEnabled;
uniform float uRainPrecipitation;
uniform float uRainSplit;
uniform float uRainBlend;
uniform float uRainGlobalStrength;
uniform sampler2D tOutdoorsMask;
uniform float uHasOutdoorsMask;
uniform float uOutdoorsMaskFlipY;
uniform float uRainIndoorDampingEnabled;
uniform float uRainIndoorDampingStrength;

uniform float uRainRippleStrengthPx;
uniform float uRainRippleScale;
uniform float uRainRippleSpeed;
uniform float uRainRippleDensity;
uniform float uRainRippleSharpness;

uniform float uRainRippleJitter;
uniform float uRainRippleRadiusMin;
uniform float uRainRippleRadiusMax;
uniform float uRainRippleWidthScale;
uniform float uRainRippleSecondaryEnabled;
uniform float uRainRippleSecondaryStrength;
uniform float uRainRippleSecondaryPhaseOffset;

uniform float uRainStormStrengthPx;
uniform float uRainStormScale;
uniform float uRainStormSpeed;
uniform float uRainStormCurl;

uniform float uRainStormRateBase;
uniform float uRainStormRateSpeedScale;
uniform float uRainStormSizeMin;
uniform float uRainStormSizeMax;
uniform float uRainStormWidthMinScale;
uniform float uRainStormWidthMaxScale;
uniform float uRainStormDecay;
uniform float uRainStormCoreWeight;
uniform float uRainStormRingWeight;
uniform float uRainStormSwirlStrength;
uniform float uRainStormMicroEnabled;
uniform float uRainStormMicroStrength;
uniform float uRainStormMicroScale;
uniform float uRainStormMicroSpeed;

uniform float uRainMaxCombinedStrengthPx;

// ── Wind ─────────────────────────────────────────────────────────────────
uniform vec2 uWindDir;
uniform float uWindSpeed;
uniform vec2 uWindOffsetUv;
uniform float uWindTime;

uniform float uLockWaveTravelToWind;
uniform float uWaveDirOffsetRad;
uniform float uWaveAppearanceRotRad;

// ── Specular (GGX) ──────────────────────────────────────────────────────
uniform float uSpecStrength;
uniform float uSpecPower;
uniform float uSpecModel;
uniform float uSpecClamp;
uniform float uSpecForceFlatNormal;
uniform float uSpecDisableMasking;
uniform float uSpecDisableRainSlope;

uniform vec3 uSpecSunDir;
uniform float uSpecSunIntensity;
uniform float uSpecNormalStrength;
uniform float uSpecNormalScale;
uniform float uSpecNormalMode;
uniform float uSpecMicroStrength;
uniform float uSpecMicroScale;
uniform float uSpecAAStrength;
uniform float uSpecWaveStepMul;
uniform float uSpecRoughnessMin;
uniform float uSpecRoughnessMax;
uniform float uSpecF0;
uniform float uSpecMaskGamma;
uniform float uSpecSkyTint;
uniform float uSpecShoreBias;
uniform float uSpecDistortionNormalStrength;
uniform float uSpecAnisotropy;
uniform float uSpecAnisoRatio;
uniform sampler2D tCloudShadow;
uniform float uHasCloudShadow;
uniform float uCloudShadowEnabled;
uniform float uCloudShadowDarkenStrength;
uniform float uCloudShadowDarkenCurve;
uniform float uCloudShadowSpecularKill;
uniform float uCloudShadowSpecularCurve;

// ── Caustics ─────────────────────────────────────────────────────────────
uniform float uCausticsEnabled;
uniform float uCausticsIntensity;
uniform float uCausticsScale;
uniform float uCausticsSpeed;
uniform float uCausticsSharpness;
uniform float uCausticsEdgeLo;
uniform float uCausticsEdgeHi;
uniform float uCausticsBrightnessMaskEnabled;
uniform float uCausticsBrightnessThreshold;
uniform float uCausticsBrightnessSoftness;
uniform float uCausticsBrightnessGamma;

// ── Foam ─────────────────────────────────────────────────────────────────
uniform vec3 uFoamColor;
uniform float uFoamStrength;
uniform float uFoamThreshold;
uniform float uFoamScale;
uniform float uFoamSpeed;

uniform float uFoamCurlStrength;
uniform float uFoamCurlScale;
uniform float uFoamCurlSpeed;

uniform float uFoamBreakupStrength1;
uniform float uFoamBreakupScale1;
uniform float uFoamBreakupSpeed1;
uniform float uFoamBreakupStrength2;
uniform float uFoamBreakupScale2;
uniform float uFoamBreakupSpeed2;

uniform float uFoamBlackPoint;
uniform float uFoamWhitePoint;
uniform float uFoamGamma;
uniform float uFoamContrast;
uniform float uFoamBrightness;

uniform float uFloatingFoamStrength;
uniform float uFloatingFoamCoverage;
uniform float uFloatingFoamScale;
uniform float uFloatingFoamWaveDistortion;

uniform float uFoamFlecksIntensity;

// ── Murk ─────────────────────────────────────────────────────────────────
uniform float uMurkEnabled;
uniform float uMurkIntensity;
uniform vec3 uMurkColor;
uniform float uMurkScale;
uniform float uMurkSpeed;
uniform float uMurkDepthLo;
uniform float uMurkDepthHi;
uniform float uMurkGrainScale;
uniform float uMurkGrainSpeed;
uniform float uMurkGrainStrength;
uniform float uMurkDepthFade;

// ── Sand ─────────────────────────────────────────────────────────────────
uniform float uSandIntensity;
uniform vec3 uSandColor;
uniform float uSandContrast;
uniform float uSandChunkScale;
uniform float uSandChunkSpeed;
uniform float uSandGrainScale;
uniform float uSandGrainSpeed;
uniform float uSandBillowStrength;

uniform float uSandCoverage;
uniform float uSandChunkSoftness;
uniform float uSandSpeckCoverage;
uniform float uSandSpeckSoftness;
uniform float uSandDepthLo;
uniform float uSandDepthHi;
uniform float uSandAnisotropy;
uniform float uSandDistortionStrength;
uniform float uSandAdditive;

// ── Debug ────────────────────────────────────────────────────────────────
uniform float uDebugView;

// ── Global ───────────────────────────────────────────────────────────────
uniform float uTime;
uniform vec2 uResolution;
uniform float uZoom;

uniform vec4 uViewBounds;         // (minX, minY, maxX, maxY) in Three world
uniform vec2 uSceneDimensions;    // Foundry canvas dimensions (width, height)
uniform vec4 uSceneRect;          // (sceneX, sceneY, sceneW, sceneH) in Foundry
uniform float uHasSceneRect;

uniform vec3 uSkyColor;
uniform float uSkyIntensity;
uniform float uSceneDarkness;
uniform float uActiveLevelElevation;

uniform float uUseSdfMask;

${DepthShaderChunks.uniforms}
${DepthShaderChunks.linearize}

varying vec2 vUv;

// Forward declarations
float waterInsideFromSdf(float sdf01);
vec2 waveGrad2D(vec2 sceneUv, float t, float motion01);
vec2 curlNoise2D(vec2 p);

// ── Noise — deterministic 512×512 RGBA random map (tNoiseMap) ───────────
const float NOISE_SIZE = 512.0;
const float NOISE_INV = 1.0 / NOISE_SIZE;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  float n = hash12(p);
  return vec2(n, hash12(p + n + 19.19));
}

float valueNoise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = texture2D(tNoiseMap, (i + 0.5) * NOISE_INV).r;
  float b = texture2D(tNoiseMap, (i + vec2(1.5, 0.5)) * NOISE_INV).r;
  float c = texture2D(tNoiseMap, (i + vec2(0.5, 1.5)) * NOISE_INV).r;
  float d = texture2D(tNoiseMap, (i + vec2(1.5, 1.5)) * NOISE_INV).r;
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// V1 compatibility: older code calls valueNoise().
float valueNoise(vec2 p) {
  return valueNoise2D(p);
}

float fbmNoise(vec2 p) {
  const mat2 octRot = mat2(0.8, 0.6, -0.6, 0.8);
  vec2 i, f, u;

  // Wrap to the noise tile to avoid huge texture coordinates.
  // Even with RepeatWrapping, very large UVs lose precision and can produce
  // visible banding artifacts in specular highlights.
  p = mod(p, NOISE_SIZE);

  i = floor(p); f = fract(p); u = f * f * (3.0 - 2.0 * f);
  i = mod(i, NOISE_SIZE);
  float n0 = mix(mix(
    texture2D(tNoiseMap, (i + 0.5) * NOISE_INV).r,
    texture2D(tNoiseMap, (i + vec2(1.5, 0.5)) * NOISE_INV).r, u.x), mix(
    texture2D(tNoiseMap, (i + vec2(0.5, 1.5)) * NOISE_INV).r,
    texture2D(tNoiseMap, (i + vec2(1.5, 1.5)) * NOISE_INV).r, u.x), u.y);

  p = octRot * p * 2.0;
  p = mod(p, NOISE_SIZE);
  i = floor(p); f = fract(p); u = f * f * (3.0 - 2.0 * f);
  i = mod(i, NOISE_SIZE);
  float n1 = mix(mix(
    texture2D(tNoiseMap, (i + 0.5) * NOISE_INV).g,
    texture2D(tNoiseMap, (i + vec2(1.5, 0.5)) * NOISE_INV).g, u.x), mix(
    texture2D(tNoiseMap, (i + vec2(0.5, 1.5)) * NOISE_INV).g,
    texture2D(tNoiseMap, (i + vec2(1.5, 1.5)) * NOISE_INV).g, u.x), u.y);

  p = octRot * p * 2.0;
  p = mod(p, NOISE_SIZE);
  i = floor(p); f = fract(p); u = f * f * (3.0 - 2.0 * f);
  i = mod(i, NOISE_SIZE);
  float n2 = mix(mix(
    texture2D(tNoiseMap, (i + 0.5) * NOISE_INV).b,
    texture2D(tNoiseMap, (i + vec2(1.5, 0.5)) * NOISE_INV).b, u.x), mix(
    texture2D(tNoiseMap, (i + vec2(0.5, 1.5)) * NOISE_INV).b,
    texture2D(tNoiseMap, (i + vec2(1.5, 1.5)) * NOISE_INV).b, u.x), u.y);

  p = octRot * p * 2.0;
  p = mod(p, NOISE_SIZE);
  i = floor(p); f = fract(p); u = f * f * (3.0 - 2.0 * f);
  i = mod(i, NOISE_SIZE);
  float n3 = mix(mix(
    texture2D(tNoiseMap, (i + 0.5) * NOISE_INV).a,
    texture2D(tNoiseMap, (i + vec2(1.5, 0.5)) * NOISE_INV).a, u.x), mix(
    texture2D(tNoiseMap, (i + vec2(0.5, 1.5)) * NOISE_INV).a,
    texture2D(tNoiseMap, (i + vec2(1.5, 1.5)) * NOISE_INV).a, u.x), u.y);

  return (n0 - 0.5) * 1.1 + (n1 - 0.5) * 0.605
       + (n2 - 0.5) * 0.33275 + (n3 - 0.5) * 0.183;
}

float safe01(float v) { return clamp(v, 0.0, 1.0); }

vec2 safeNormalize2(vec2 v) {
  float l = length(v);
  return (l > 1e-6) ? (v / l) : vec2(0.0);
}

// ── Rain ripples ─────────────────────────────────────────────────────────
float rainRipple(vec2 uv, float t, out vec2 dirOut) {
  float sc = max(1.0, uRainRippleScale);
  vec2 p = uv * sc;
  vec2 baseCell = floor(p);
  vec2 f = fract(p) - 0.5;

  float density = clamp(uRainRippleDensity, 0.0, 1.0);
  float sharp = max(0.1, uRainRippleSharpness);
  float width = 0.06 / sharp;

  float jitterAmt = clamp(uRainRippleJitter, 0.0, 1.0);
  float rMinBase = clamp(uRainRippleRadiusMin, 0.0, 0.95);
  float rMaxBase = clamp(uRainRippleRadiusMax, rMinBase + 0.001, 0.95);
  float widthScale = clamp(uRainRippleWidthScale, 0.05, 5.0);
  float secEnabled = (uRainRippleSecondaryEnabled > 0.5) ? 1.0 : 0.0;
  float secStrength = max(0.0, uRainRippleSecondaryStrength);
  float secPhaseOff = fract(max(0.0, uRainRippleSecondaryPhaseOffset));

  vec2 vAccum = vec2(0.0);
  float wAccum = 0.0;

  for (int yi = 0; yi < 3; yi++) {
    for (int xi = 0; xi < 3; xi++) {
      vec2 o = vec2(float(xi - 1), float(yi - 1));
      vec2 cell = baseCell + o;
      float rnd = hash12(cell);
      float cellActive = step(1.0 - density, rnd);
      if (cellActive < 0.5) continue;
      float phase01 = fract(t * max(0.0, uRainRippleSpeed) + rnd);
      vec2 jitter = (hash22(cell + vec2(7.1, 19.3)) - 0.5) * jitterAmt;
      float rMin = mix(rMinBase, min(rMinBase + 0.12, rMaxBase), hash12(cell + vec2(3.3, 11.7)));
      float rMax = mix(max(rMinBase + 0.18, rMin), rMaxBase, hash12(cell + vec2(13.9, 2.1)));
      float cellWidth = width * widthScale * mix(0.75, 1.35, hash12(cell + vec2(5.7, 29.1)));
      vec2 gv = (f - o) - jitter;
      float r = length(gv);
      float ringCenter = mix(rMin, rMax, phase01);
      float ring = exp(-pow((r - ringCenter) / max(0.001, cellWidth), 2.0));
      float wobble = 0.5 + 0.5 * sin((r - ringCenter) * (40.0 * sharp) - t * (6.0 + 8.0 * sharp));
      float amp = ring * wobble;
      float phase02 = fract(phase01 + secPhaseOff + (rnd - 0.5) * 0.2);
      float ringCenter2 = mix(rMin, rMax, phase02);
      float ring2 = exp(-pow((r - ringCenter2) / max(0.001, cellWidth * 1.25), 2.0));
      float wobble2 = 0.5 + 0.5 * sin((r - ringCenter2) * (28.0 * sharp) - t * (4.0 + 6.0 * sharp));
      amp += ring2 * wobble2 * secStrength * secEnabled;
      vec2 dir = safeNormalize2(gv);
      vAccum += dir * amp;
      wAccum += amp;
    }
  }

  float a = 1.0 - exp(-wAccum * 1.6);
  dirOut = safeNormalize2(vAccum);
  return safe01(a);
}

// ── Storm distortion ─────────────────────────────────────────────────────
vec2 rainStorm(vec2 uv, float t) {
  float sc = max(1.0, uRainStormScale);
  float sp = max(0.0, uRainStormSpeed);
  vec2 p = uv * sc;
  vec2 baseCell = floor(p);
  vec2 f = fract(p) - 0.5;
  float rate = max(0.0, uRainStormRateBase) + sp * max(0.0, uRainStormRateSpeedScale);
  float chaos = max(0.0, uRainStormCurl);
  vec2 vAccum = vec2(0.0);
  float wAccum = 0.0;

  for (int yi = 0; yi < 3; yi++) {
    for (int xi = 0; xi < 3; xi++) {
      vec2 o = vec2(float(xi - 1), float(yi - 1));
      vec2 cell = baseCell + o;
      float cellSeed = hash12(cell);
      float timeSeed = t * rate + cellSeed * 11.0;
      float k = floor(timeSeed);
      float phase = fract(timeSeed);
      float e = hash12(cell + vec2(k, k * 1.23));
      vec2 jitter = (hash22(cell + vec2(k, k * 0.77) + vec2(17.3, 9.1)) - 0.5) * 0.95;
      vec2 gv = (f - o) - jitter;
      float r = length(gv);
      float sizeMin = max(0.001, uRainStormSizeMin);
      float sizeMax = max(sizeMin, uRainStormSizeMax);
      float size = mix(sizeMin, sizeMax, hash12(cell + vec2(5.1, 13.7)));
      float wMin = max(0.001, uRainStormWidthMinScale);
      float wMax = max(wMin, uRainStormWidthMaxScale);
      float ww = max(0.001, size * mix(wMin, wMax, hash12(cell + vec2(29.9, 3.7))));
      float env = exp(-phase * max(0.0, uRainStormDecay));
      float core = exp(-pow(r / max(1e-4, size * 0.55), 2.0));
      float ringCenter = phase * size;
      float ring = exp(-pow((r - ringCenter) / max(1e-4, ww), 2.0));
      float coreW = max(0.0, uRainStormCoreWeight);
      float ringW = max(0.0, uRainStormRingWeight);
      float amp = (core * coreW + ring * ringW) * env;
      amp *= mix(0.65, 1.25, e);
      vec2 dir = safeNormalize2(gv);
      vec2 tan = vec2(-dir.y, dir.x);
      float swirl = (e - 0.5) * 2.0;
      vec2 local = dir * amp;
      local += tan * amp * max(0.0, uRainStormSwirlStrength) * swirl * chaos;
      vAccum += local;
      wAccum += amp;
    }
  }

  if (uRainStormMicroEnabled > 0.5) {
    float microSc = max(0.0, uRainStormMicroScale);
    float microSp = max(0.0, uRainStormMicroSpeed);
    float micro = fbmNoise(uv * (sc * microSc) + vec2(sin(t * microSp), cos(t * microSp * 1.13)) * 2.3);
    vAccum += vec2(micro, -micro) * max(0.0, uRainStormMicroStrength) * chaos;
  }

  float a = 1.0 - exp(-wAccum * 1.15);
  return safeNormalize2(vAccum) * safe01(a);
}

vec2 computeRainOffsetPx(vec2 uv) {
  if (uRainEnabled < 0.5) return vec2(0.0);
  float p = safe01(uRainPrecipitation);
  if (p < 0.001) return vec2(0.0);
  float split = safe01(uRainSplit);
  float blend = clamp(uRainBlend, 0.0, 0.25);
  float wStorm = (blend > 1e-6) ? smoothstep(split - blend, split + blend, p) : step(split, p);
  float wRipple = (1.0 - wStorm) * smoothstep(0.0, max(1e-4, split), p);
  vec2 rippleDir = vec2(0.0);
  float rippleAmt = rainRipple(uv, uTime, rippleDir);
  float ripplePx = clamp(uRainRippleStrengthPx, 0.0, 64.0);
  vec2 rippleOffPx = rippleDir * rippleAmt * ripplePx;
  vec2 stormV = rainStorm(uv, uTime);
  float stormLen = length(stormV);
  vec2 stormDir = (stormLen > 1e-6) ? (stormV / stormLen) : vec2(0.0);
  float stormAmt = clamp(stormLen, 0.0, 1.0);
  float stormPx = clamp(uRainStormStrengthPx, 0.0, 64.0);
  vec2 stormOffPx = stormDir * stormAmt * stormPx;
  vec2 offPx = (rippleOffPx * wRipple + stormOffPx * wStorm) * clamp(uRainGlobalStrength, 0.0, 2.0);
  float maxPx = clamp(uRainMaxCombinedStrengthPx, 0.0, 64.0);
  float lenPx = length(offPx);
  if (maxPx > 1e-4 && lenPx > maxPx) offPx *= (maxPx / max(1e-6, lenPx));
  return offPx;
}

vec2 curlNoise2D(vec2 p) {
  float e = 0.02;
  float n1 = fbmNoise(p + vec2(0.0, e));
  float n2 = fbmNoise(p - vec2(0.0, e));
  float n3 = fbmNoise(p + vec2(e, 0.0));
  float n4 = fbmNoise(p - vec2(e, 0.0));
  return vec2((n1 - n2) / (2.0 * e), -(n3 - n4) / (2.0 * e));
}

// ── Wave / Warp ──────────────────────────────────────────────────────────
vec2 warpUv(vec2 sceneUv, float motion01) {
  float m = clamp(motion01, 0.0, 1.0);
  vec2 windOffsetUv = vec2(uWindOffsetUv.x, -uWindOffsetUv.y) * m;
  vec2 uv = sceneUv - windOffsetUv;
  float timeWarp = uTime * max(0.0, uWaveWarpTimeSpeed) * m;
  float sceneAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
  vec2 windF = uWindDir;
  float wl = length(windF);
  windF = (wl > 1e-6) ? (windF / wl) : vec2(1.0, 0.0);
  vec2 windDir = vec2(windF.x, -windF.y);
  vec2 windBasis = normalize(vec2(windDir.x * sceneAspect, windDir.y));
  vec2 windPerp = vec2(-windBasis.y, windBasis.x);
  vec2 basis = vec2(sceneUv.x * sceneAspect, sceneUv.y);
  float along = dot(basis, windBasis);
  float across = dot(basis, windPerp);
  vec2 streakUv = windBasis * (along * 2.75) + windPerp * (across * 1.0);
  float largeWarpPulse = 0.90 + 0.10 * sin(uTime * 0.27);
  float lf1 = fbmNoise(streakUv * 0.23 + vec2(19.1, 7.3) + vec2(timeWarp * 0.07, -timeWarp * 0.05));
  float lf2 = fbmNoise(streakUv * 0.23 + vec2(3.7, 23.9) + vec2(-timeWarp * 0.04, timeWarp * 0.06));
  uv += vec2(lf1, lf2) * clamp(uWaveWarpLargeStrength, 0.0, 1.0) * largeWarpPulse;
  float n1 = fbmNoise((uv * 2.1) + vec2(13.7, 9.2) + vec2(timeWarp * 0.11, timeWarp * 0.09));
  float n2 = fbmNoise((uv * 2.1) + vec2(41.3, 27.9) + vec2(-timeWarp * 0.08, timeWarp * 0.10));
  uv += vec2(n1, n2) * clamp(uWaveWarpSmallStrength, 0.0, 1.0);
  float n3 = fbmNoise(uv * 4.7 + vec2(7.9, 19.1) + vec2(timeWarp * 0.15, -timeWarp * 0.12));
  float n4 = fbmNoise(uv * 4.7 + vec2(29.4, 3.3) + vec2(-timeWarp * 0.13, -timeWarp * 0.10));
  uv += vec2(n3, n4) * clamp(uWaveWarpMicroStrength, 0.0, 1.0);
  return uv;
}

float waveSeaState(vec2 sceneUv, float motion01) {
  if (uWaveEvolutionEnabled < 0.5) return 0.5;
  float sp = max(0.0, uWaveEvolutionSpeed) * clamp(motion01, 0.0, 1.0);
  float sc = max(0.01, uWaveEvolutionScale);
  float n = fbmNoise(sceneUv * sc + vec2(uTime * sp * 0.23, -uTime * sp * 0.19));
  float phase = uTime * sp + n * 2.7;
  return 0.5 + 0.5 * sin(phase);
}

vec2 rotate2D(vec2 v, float a) {
  float s = sin(a); float c = cos(a);
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}

float hash11(float p) { return fract(sin(p) * 43758.5453123); }

float msLuminance(vec3 rgb) {
  return dot(rgb, vec3(0.2126, 0.7152, 0.0722));
}

void waveMods(vec2 lf, float seed, out float kMul, out float dirRot) {
  float a = lf.x; float b = lf.y;
  float r1 = hash11(seed * 13.17 + 1.0);
  float r2 = hash11(seed * 29.73 + 2.0);
  dirRot = clamp((a * (0.20 + 0.60 * r1) + b * (0.20 + 0.60 * r2)) * 0.35, -0.55, 0.55);
  float km = 1.0 + (a * (0.15 + 0.25 * r2) + b * (0.10 + 0.25 * r1)) * 0.10;
  kMul = clamp(km, 0.75, 1.25);
}

float sharpSin(float phase, float sharpness, out float dHdPhase) {
  float s = sin(phase);
  float a = max(abs(s), 1e-5);
  float shaped = sign(s) * pow(a, sharpness);
  dHdPhase = sharpness * pow(a, sharpness - 1.0) * cos(phase);
  return shaped;
}

void addWave(vec2 p, vec2 dir, float k, float amp, float sharpness, float omega, float t, inout float h, inout vec2 gSceneUv) {
  float phase = dot(p, dir) * k - omega * t;
  float d;
  float w = sharpSin(phase, sharpness, d);
  h += amp * w;
  float bunch = 1.0 + 0.35 * abs(w);
  gSceneUv += amp * d * (k * dir) * uWaveScale * bunch;
}

vec3 calculateWave(vec2 sceneUv, float t, float motion01) {
  const float TAU = 6.2831853;
  vec2 windF = uWindDir;
  float wl = length(windF);
  windF = (wl > 1e-5) ? (windF / wl) : vec2(1.0, 0.0);
  vec2 wind = vec2(windF.x, -windF.y);
  float travelRot = (uLockWaveTravelToWind > 0.5) ? 0.0 : uWaveDirOffsetRad;
  wind = rotate2D(wind, travelRot);
  vec2 uvF = warpUv(sceneUv, motion01);
  vec2 p = uvF * uWaveScale;
  vec2 lf = vec2(fbmNoise(sceneUv * 0.11 + vec2(11.3, 17.9)), fbmNoise(sceneUv * 0.11 + vec2(37.1, 5.7)));
  float h = 0.0; vec2 g = vec2(0.0);
  float sea01 = waveSeaState(sceneUv, motion01);
  float evoAmt = clamp(uWaveEvolutionAmount, 0.0, 1.0);
  float evo = mix(1.0 - evoAmt, 1.0 + evoAmt, sea01);
  float breathing = 0.8 + 0.2 * sin(uTime * 0.5 * clamp(motion01, 0.0, 1.0));
  float wavePulse = evo * breathing;
  vec2 swellP = p;
  vec2 chopP = p * 2.618;
  vec2 crossWind = rotate2D(wind, 0.78);
  float chopBreathing = 0.7 + 0.3 * cos(uTime * 0.7 * clamp(motion01, 0.0, 1.0));
  float chopPulse = evo * chopBreathing;

  float kMul0; float r0; waveMods(lf, 1.0, kMul0, r0);
  float k0 = (TAU * 0.61) * kMul0;
  addWave(swellP, rotate2D(wind, -0.60 + r0), k0, 0.40 * wavePulse, 2.20, (1.05 + 0.62 * sqrt(k0)), t, h, g);
  float kMul1; float r1; waveMods(lf, 2.0, kMul1, r1);
  float k1 = (TAU * 0.97) * kMul1;
  addWave(swellP, rotate2D(wind, -0.15 + r1), k1, 0.28 * wavePulse, 2.55, (1.05 + 0.62 * sqrt(k1)), t, h, g);
  float kMul2; float r2; waveMods(lf, 3.0, kMul2, r2);
  float k2 = (TAU * 1.43) * kMul2;
  addWave(swellP, rotate2D(wind, 0.20 + r2), k2, 0.16 * wavePulse, 2.85, (1.05 + 0.62 * sqrt(k2)), t, h, g);
  float kMul3; float r3; waveMods(lf, 4.0, kMul3, r3);
  float k3 = (TAU * 1.88) * kMul3;
  addWave(chopP, rotate2D(crossWind, 0.25 + r3), k3, 0.10 * chopPulse, 3.10, (1.18 + 0.72 * sqrt(k3)), t, h, g);
  float kMul4; float r4; waveMods(lf, 5.0, kMul4, r4);
  float k4 = (TAU * 2.71) * kMul4;
  addWave(chopP, rotate2D(crossWind, -0.35 + r4), k4, 0.06 * chopPulse, 3.35, (1.18 + 0.72 * sqrt(k4)), t, h, g);

  return vec3(h, g / max(uWaveScale, 1e-3));
}

float waveHeight(vec2 sceneUv, float t, float motion01) { return calculateWave(sceneUv, t, motion01).x; }
vec2 waveGrad2D(vec2 sceneUv, float t, float motion01) { return calculateWave(sceneUv, t, motion01).yz; }

vec2 smoothFlow2D(vec2 sceneUv) {
  // NOTE: We intentionally do NOT use tWaterData.ba as a flow/normal field.
  // It has produced stable diagonal artifacts in specular.
  // tWaterData is still used for sdf/exposure in .r/.g.
  return vec2(0.0);
}

vec2 specMicroSlope2D(vec2 sceneUv, float t) {
  float sceneAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
  vec2 basis = vec2(sceneUv.x * sceneAspect, sceneUv.y);
  vec2 windF = uWindDir; float wl = length(windF);
  windF = (wl > 1e-6) ? (windF / wl) : vec2(1.0, 0.0);
  windF.y = -windF.y;
  vec2 windBasis = normalize(vec2(windF.x * sceneAspect, windF.y));

  float scale = max(0.01, uSpecMicroScale);
  vec2 p = basis * scale + windBasis * (t * 0.12);

  float eps = 0.75;
  float n0 = fbmNoise(p);
  float nx = fbmNoise(p + vec2(eps, 0.0));
  float ny = fbmNoise(p + vec2(0.0, eps));
  vec2 g = vec2(nx - n0, ny - n0) / eps;
  g *= 2.25;
  return g;
}

 vec2 specWaveSlopeFromHeight2D(vec2 sceneUv, float t) {
  float sceneAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
  float stepMul = max(0.5, uSpecWaveStepMul);
  vec2 e = max(uWaterDataTexelSize * (1.25 * stepMul), vec2(1.0 / 2048.0) * stepMul);
  // Central differences are smoother and reduce single-pixel streaking.
  float hXp = waveHeight(sceneUv + vec2(e.x, 0.0), t, 1.0);
  float hXm = waveHeight(sceneUv - vec2(e.x, 0.0), t, 1.0);
  float hYp = waveHeight(sceneUv + vec2(0.0, e.y), t, 1.0);
  float hYm = waveHeight(sceneUv - vec2(0.0, e.y), t, 1.0);
  vec2 dh = vec2((hXp - hXm) * sceneAspect, (hYp - hYm)) / max(1e-6, 2.0);
  // Keep it gentle; the caller scales further via uniforms.
  return dh * 2.0;
 }

// ── Coordinate conversion ────────────────────────────────────────────────
vec2 screenUvToFoundry(vec2 screenUv) {
  float threeX = mix(uViewBounds.x, uViewBounds.z, screenUv.x);
  float threeY = mix(uViewBounds.y, uViewBounds.w, screenUv.y);
  return vec2(threeX, uSceneDimensions.y - threeY);
}

vec2 foundryToSceneUv(vec2 foundryPos) {
  return (foundryPos - uSceneRect.xy) / max(uSceneRect.zw, vec2(1e-5));
}

float remap01(float v, float lo, float hi) { return clamp((v - lo) / max(1e-5, hi - lo), 0.0, 1.0); }

float sampleOutdoorsMask(vec2 sceneUv01) {
  float y = (uOutdoorsMaskFlipY > 0.5) ? (1.0 - sceneUv01.y) : sceneUv01.y;
  vec2 uv = vec2(sceneUv01.x, y);
  return texture2D(tOutdoorsMask, uv).r;
}

float shoreFactor(float shore01) {
  float lo = clamp(uDistortionShoreRemapLo, 0.0, 1.0);
  float hi = clamp(uDistortionShoreRemapHi, 0.0, 1.0);
  float a = min(lo, hi - 1e-4);
  float b = max(hi, a + 1e-4);
  float s = remap01(clamp(shore01, 0.0, 1.0), a, b);
  s = pow(s, max(0.01, uDistortionShorePow));
  return max(clamp(uDistortionShoreMin, 0.0, 1.0), clamp(s, 0.0, 1.0));
}

float waterInsideFromSdf(float sdf01) { return smoothstep(0.52, 0.48, sdf01); }

float distortionInsideFromSdf(float sdf01) {
  float c = clamp(uDistortionEdgeCenter, 0.0, 1.0);
  float f = max(0.0, uDistortionEdgeFeather);
  float inside = (f > 1e-6) ? smoothstep(c + f, c - f, sdf01) : step(sdf01, c);
  return pow(clamp(inside, 0.0, 1.0), max(0.01, uDistortionEdgeGamma));
}

float chromaticInsideFromSdf(float sdf01) {
  float c = clamp(uChromaticAberrationEdgeCenter, 0.0, 1.0);
  float f = max(0.0, uChromaticAberrationEdgeFeather);
  float inside = (f > 1e-6) ? smoothstep(c + f, c - f, sdf01) : step(sdf01, c);
  inside = pow(clamp(inside, 0.0, 1.0), max(0.01, uChromaticAberrationEdgeGamma));
  return max(clamp(uChromaticAberrationEdgeMin, 0.0, 1.0), inside);
}

// ── Foam flecks (shader-based) ───────────────────────────────────────────
#ifdef USE_FOAM_FLECKS
float getShaderFlecks(vec2 sceneUv, float shore, float inside, float foamAmount) {
  if (uFoamFlecksIntensity < 0.01) return 0.0;
  float sceneAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
  vec2 windF = uWindDir; float windLen = length(windF);
  windF = (windLen > 1e-6) ? (windF / windLen) : vec2(1.0, 0.0);
  vec2 windDir = vec2(windF.x, -windF.y);
  vec2 windBasis = normalize(vec2(windDir.x * sceneAspect, windDir.y));
  float tWind = uWindTime;
  float fleckSpeed = uFoamSpeed * 2.5 + 0.15;
  vec2 fleckOffset = windBasis * (tWind * fleckSpeed);
  vec2 foamWindOffsetUv = vec2(uWindOffsetUv.x, -uWindOffsetUv.y);
  vec2 foamSceneUv = sceneUv - (foamWindOffsetUv * 0.5);
  vec2 fleckBasis = vec2(foamSceneUv.x * sceneAspect, foamSceneUv.y);
  fleckBasis += windBasis * 0.02;
  vec2 fleckUv1 = fleckBasis * 800.0 - fleckOffset * 400.0;
  vec2 fleckUv2 = fleckBasis * 1200.0 - fleckOffset * 600.0;
  vec2 fleckUv3 = fleckBasis * 500.0 - fleckOffset * 250.0;
  float n1 = valueNoise(fleckUv1);
  float n2 = valueNoise(fleckUv2);
  float n3 = valueNoise(fleckUv3);
  float threshold = 0.82;
  float dot1 = smoothstep(threshold, threshold + 0.08, n1);
  float dot2 = smoothstep(threshold + 0.02, threshold + 0.10, n2);
  float dot3 = smoothstep(threshold - 0.02, threshold + 0.06, n3);
  float fleckDots = dot1 * 0.5 + dot2 * 0.3 + dot3 * 0.2;
  float fleckMask = smoothstep(0.2, 0.6, foamAmount);
  float windFactor = 0.3 + 0.7 * clamp(uWindSpeed, 0.0, 1.0);
  return clamp(fleckDots * fleckMask * windFactor * clamp(uFoamFlecksIntensity, 0.0, 2.0), 0.0, 1.0);
}
#else
float getShaderFlecks(vec2 sceneUv, float shore, float inside, float foamAmount) { return 0.0; }
#endif

// V1-accurate FBM: layered value noise with lacunarity/gain, returns [-1..1].
// Matches DistortionManager's fbm(p, octaves, lacunarity, gain) exactly.
float waterFbm(vec2 p, int octaves, float lacunarity, float gain) {
  float sum = 0.0;
  float amp = 1.0;
  float freq = 1.0;
  float maxAmp = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    // valueNoise returns [0..1]; remap to [-1..1] for signed accumulation.
    sum += (valueNoise(p * freq) * 2.0 - 1.0) * amp;
    maxAmp += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return sum / maxAmp;
}

// V1-accurate caustics: ridged FBM produces thin bright filaments, not blobs.
// Matches DistortionManager causticsPattern() exactly.
float causticsPattern(vec2 sceneUv, float t, float scale, float speed, float sharpness) {
  vec2 p = sceneUv * scale;
  float tt = t * speed;
  float n1 = waterFbm(p + vec2(tt * 0.12, -tt * 0.09), 4, 2.0, 0.5);
  float n2 = waterFbm(p * 1.7 + vec2(-tt * 0.08, tt * 0.11), 3, 2.1, 0.55);
  // Blend two FBM layers, then remap to [0..1].
  float n = 0.6 * n1 + 0.4 * n2;
  float nn = clamp(0.5 + 0.5 * n, 0.0, 1.0);
  // Ridged transform: 1 - |2x - 1| creates thin bright filaments at peaks.
  float ridge = 1.0 - abs(2.0 * nn - 1.0);
  // Sharpness controls filament width: high sharpness = narrower, brighter lines.
  float s = max(0.1, sharpness);
  float w = 0.18 / (1.0 + s * 0.65);
  float c = smoothstep(1.0 - w, 1.0, ridge);
  return c;
}
` + getFragmentShaderPart2();
}

// Continuation of the fragment shader — split for file-size manageability.
function getFragmentShaderPart2() {
  return /* glsl */`

// ── Foam ─────────────────────────────────────────────────────────────────
float getFoamBaseAmount(vec2 sceneUv, float shore, float inside, vec2 rainOffPx) {
  vec2 foamWindOffsetUv = vec2(uWindOffsetUv.x, -uWindOffsetUv.y);
  vec2 foamSceneUv = sceneUv - (foamWindOffsetUv * 0.5);
  float sceneAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
  vec2 foamBasis = vec2(foamSceneUv.x * sceneAspect, foamSceneUv.y);
  vec2 windF = uWindDir; float windLen = length(windF);
  windF = (windLen > 1e-6) ? (windF / windLen) : vec2(1.0, 0.0);
  vec2 windDir = vec2(windF.x, -windF.y);
  vec2 windBasis = normalize(vec2(windDir.x * sceneAspect, windDir.y));
  float tWind = uWindTime;
  vec2 curlP = foamBasis * max(0.01, uFoamCurlScale) - windBasis * (tWind * uFoamCurlSpeed);
  foamBasis += curlNoise2D(curlP) * clamp(uFoamCurlStrength, 0.0, 1.0);
  vec2 foamUv = foamBasis * max(0.1, uFoamScale) - windBasis * (tWind * uFoamSpeed * 0.5);
  float f1 = valueNoise(foamUv);
  float f2 = valueNoise(foamUv * 1.7 + 1.2);
  float bubbles = (f1 + f2) * 0.5;
  float b1 = fbmNoise(foamBasis * max(0.1, uFoamBreakupScale1));
  float b2 = fbmNoise(foamBasis * max(0.1, uFoamBreakupScale2));
  float breakup = 0.5 + 0.5 * (b1 * clamp(uFoamBreakupStrength1, 0.0, 1.0) + b2 * clamp(uFoamBreakupStrength2, 0.0, 1.0));
  breakup = clamp(breakup, 0.0, 1.0);
  float bubblesAdd = max(0.0, bubbles - 0.5) * 0.30;
  float breakupAdd = max(0.0, breakup - 0.5) * 0.35;
  float foamMask = shore + bubblesAdd + breakupAdd;
  float shoreFoamAmount = smoothstep(uFoamThreshold, uFoamThreshold - 0.15, foamMask);
  shoreFoamAmount *= inside * max(0.0, uFoamStrength);

  vec2 clumpUv = foamBasis * max(0.1, uFloatingFoamScale);
  clumpUv -= windBasis * (tWind * (0.02 + uFoamSpeed * 0.05));
  if (uFloatingFoamWaveDistortion > 0.01) {
    float foamDistort = clamp(uFloatingFoamWaveDistortion, 0.0, 2.0);
    vec2 waveGrad = waveGrad2D(sceneUv, uTime, 1.0);
    clumpUv += waveGrad * foamDistort * 0.1;
    vec2 texel = 1.0 / max(uResolution, vec2(1.0));
    vec2 rainUv = rainOffPx * texel;
    vec2 rainBasis = vec2(rainUv.x * sceneAspect, rainUv.y);
    float rainFoamScale = max(1.0, uFloatingFoamScale * 0.35);
    clumpUv += rainBasis * foamDistort * rainFoamScale;
  }
  float c1 = valueNoise(clumpUv);
  float c2 = valueNoise(clumpUv * 2.1 + 5.2);
  float c = c1 * 0.7 + c2 * 0.3;
  float clumps = smoothstep(1.0 - clamp(uFloatingFoamCoverage, 0.0, 1.0), 1.0, c);
  float deepMask = smoothstep(0.15, 0.65, 1.0 - shore);
  float floatingFoamAmount = clumps * inside * max(0.0, uFloatingFoamStrength) * deepMask;
  float raw01 = (uHasWaterRawMask > 0.5) ? texture2D(tWaterRawMask, sceneUv).r : inside;
  float rawMask = smoothstep(0.70, 0.95, clamp(raw01, 0.0, 1.0));
  float floatingFoamMaskAmount = clumps * inside * max(0.0, uFloatingFoamStrength) * rawMask;
  float foamAmount = clamp(shoreFoamAmount + floatingFoamAmount + floatingFoamMaskAmount, 0.0, 1.0);
  float bp = clamp(uFoamBlackPoint, 0.0, 1.0);
  float wp = clamp(uFoamWhitePoint, 0.0, 1.0);
  foamAmount = clamp((foamAmount - bp) / max(1e-5, wp - bp), 0.0, 1.0);
  foamAmount = pow(foamAmount, max(0.01, uFoamGamma));
  foamAmount = (foamAmount - 0.5) * max(0.0, uFoamContrast) + 0.5;
  return clamp(foamAmount + uFoamBrightness, 0.0, 1.0);
}

// ── Sand / Sediment ──────────────────────────────────────────────────────
#ifdef USE_SAND
float sandMask(vec2 sceneUv, float shore, float inside, float sceneAspect) {
  float depth = clamp(1.0 - shore, 0.0, 1.0);
  float dLo = clamp(uSandDepthLo, 0.0, 1.0);
  float dHi = clamp(uSandDepthHi, 0.0, 1.0);
  float lo = min(dLo, dHi - 0.001);
  float hi = max(dHi, lo + 0.001);
  float depthMask = smoothstep(lo, hi, depth);
  vec2 sandWindOffsetUv = vec2(uWindOffsetUv.x, -uWindOffsetUv.y);
  vec2 sandSceneUv = sceneUv - (sandWindOffsetUv * max(0.0, uSandChunkSpeed));
  float sandDist = clamp(uSandDistortionStrength, 0.0, 1.0);
  if (sandDist > 1e-4) {
    vec2 waveGrad = waveGrad2D(sceneUv, uWindTime, 1.0);
    waveGrad = rotate2D(waveGrad, uWaveAppearanceRotRad + 1.5707963);
    vec2 warp = waveGrad * uWaveStrength;
    sandSceneUv += warp * (0.045 * sandDist);
  }
  vec2 sandBasis = vec2(sandSceneUv.x * sceneAspect, sandSceneUv.y);
  vec2 windF = uWindDir; float wl = length(windF);
  windF = (wl > 1e-6) ? (windF / wl) : vec2(1.0, 0.0);
  windF.y = -windF.y;
  vec2 windBasis = normalize(vec2(windF.x * sceneAspect, windF.y));
  vec2 perp = vec2(-windBasis.y, windBasis.x);
  float aniso = clamp(uSandAnisotropy, 0.0, 1.0);
  float alongScale = mix(1.0, 0.35, aniso);
  float acrossScale = mix(1.0, 3.0, aniso);
  float along2 = dot(sandBasis, windBasis) * alongScale;
  float across2 = dot(sandBasis, perp) * acrossScale;
  sandBasis = windBasis * along2 + perp * across2;
  vec2 curlP = sandBasis * (0.5 + 1.25 * max(0.01, uSandChunkScale)) - windBasis * (uTime * (0.03 + 0.14 * max(0.0, uSandChunkSpeed)));
  sandBasis += curlNoise2D(curlP) * clamp(uSandBillowStrength, 0.0, 1.0) * 0.35;
  float chunkN = clamp(0.5 + 0.5 * fbmNoise(sandBasis * max(0.05, uSandChunkScale) + vec2(uTime * 0.05, -uTime * 0.04)), 0.0, 1.0);
  float evolveN = clamp(0.5 + 0.5 * fbmNoise(sandBasis * max(0.03, uSandChunkScale * 0.65) + vec2(-uTime * 0.03, uTime * 0.02)), 0.0, 1.0);
  float chunk = 0.55 * chunkN + 0.45 * evolveN;
  float cov = clamp(uSandCoverage, 0.0, 1.0);
  float chunkTh = mix(0.85, 0.45, cov);
  float chunkSoft = max(0.001, uSandChunkSoftness);
  float chunkMask = smoothstep(chunkTh, chunkTh + chunkSoft, chunk);
  float sandContrast = max(0.01, uSandContrast);
  chunkMask = pow(clamp(chunkMask, 0.0, 1.0), sandContrast);
  vec2 grainUv = sandBasis * max(1.0, uSandGrainScale);
  grainUv += windBasis * (uTime * (0.08 + 0.35 * max(0.0, uSandGrainSpeed)));
  grainUv += curlNoise2D(grainUv * 0.02 + vec2(uTime * 0.4, -uTime * 0.3)) * 0.65;
  float g1 = valueNoise(grainUv + vec2(uTime * uSandGrainSpeed * 0.6));
  float g2 = valueNoise(grainUv * 1.7 + 3.1 + vec2(-uTime * uSandGrainSpeed * 0.45));
  float grit = (g1 * 0.65 + g2 * 0.35);
  float speckCov = clamp(uSandSpeckCoverage, 0.0, 1.0);
  float speckTh = mix(0.95, 0.55, speckCov);
  float speckSoft = max(0.001, uSandSpeckSoftness);
  float speck = smoothstep(speckTh, speckTh + speckSoft, grit);
  speck = pow(clamp(speck, 0.0, 1.0), sandContrast);
  float sandAlpha = speck * chunkMask * inside * depthMask;
  sandAlpha *= clamp(uSandIntensity, 0.0, 1.0) * 1.15;
  return sandAlpha;
}
#endif

// ── Murk (subsurface silt/algae) ─────────────────────────────────────────
vec3 applyMurk(vec2 sceneUv, float t, float inside, float shore, float outdoorStrength, vec3 baseColor, out float murkFactorOut) {
  murkFactorOut = 0.0;
  if (uMurkEnabled < 0.5) return baseColor;
  float murkIntensity = clamp(uMurkIntensity, 0.0, 2.0);
  if (murkIntensity <= 1e-6) return baseColor;
  float murkScale = max(0.1, uMurkScale);
  float murkSpeed = max(0.0, uMurkSpeed);
  float sceneAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
  vec2 murkBasis = vec2(sceneUv.x * sceneAspect, sceneUv.y);
  vec2 windF = uWindDir; float windLen = length(windF);
  windF = (windLen > 1e-6) ? (windF / windLen) : vec2(1.0, 0.0);
  vec2 windBasis = normalize(vec2(windF.x * sceneAspect, windF.y));
  vec2 windPerp = vec2(-windBasis.y, windBasis.x);
  float tWind = uWindTime;
  vec2 cloudUv = murkBasis * murkScale;
  vec2 cloudDrift = windBasis * (tWind * murkSpeed * 0.22);
  vec2 cloudWarp = curlNoise2D((cloudUv - cloudDrift) * 0.45) * 0.45;
  float cloudA = fbmNoise(cloudUv - cloudDrift + cloudWarp);
  float cloudB = fbmNoise(cloudUv * 0.57 - cloudDrift * 0.73 + windPerp * 0.35 + vec2(17.3, 9.1) - cloudWarp * 0.35);
  float cloud = clamp(0.5 + 0.5 * (0.65 * cloudA + 0.35 * cloudB), 0.0, 1.0);
  cloud = smoothstep(0.30, 0.78, cloud);
  float depthLo = clamp(uMurkDepthLo, 0.0, 1.0);
  float depthHi = clamp(uMurkDepthHi, 0.0, 1.0);
  float mdLo = min(depthLo, depthHi - 0.001);
  float mdHi = max(depthHi, mdLo + 0.001);
  float depthMask = smoothstep(mdLo, mdHi, clamp(shore, 0.0, 1.0));
  float depthFactor = pow(depthMask, max(0.1, uMurkDepthFade));
  float grainScale = max(10.0, uMurkGrainScale);
  float grainSpeed = max(0.0, uMurkGrainSpeed);
  vec2 grainBasis = vec2(sceneUv.x * sceneAspect, sceneUv.y);
  float grainPhase = tWind * (murkSpeed + grainSpeed);
  vec2 grainDrift = windBasis * (grainPhase * 1.8);
  vec2 grainEvo = vec2(t * grainSpeed * 0.85, -t * grainSpeed * 0.71);
  vec2 gUv1 = grainBasis * (grainScale * 1.0) - grainDrift + grainEvo;
  vec2 gUv2 = grainBasis * (grainScale * 2.35) - grainDrift * 2.1 - grainEvo * 1.6 + vec2(23.4, 7.1);
  vec2 gUv3 = grainBasis * (grainScale * 4.9) - grainDrift * 3.0 + grainEvo * 2.4 + vec2(-11.8, 31.6);
  vec2 gWarp = curlNoise2D((grainBasis * grainScale * 0.018) + grainEvo * 0.12 - windBasis * (grainPhase * 0.20)) * 2.0;
  gUv1 += gWarp * 0.20; gUv2 += gWarp * 0.12; gUv3 += gWarp * 0.08;
  float g1 = valueNoise(gUv1);
  float g2 = valueNoise(gUv2);
  float g3 = valueNoise(gUv3);
  float grit = clamp(0.55 * g1 + 0.30 * g2 + 0.15 * g3, 0.0, 1.0);
  float grain = pow(grit, 14.0) * clamp(uMurkGrainStrength, 0.0, 2.0);
  grain *= smoothstep(0.45, 0.95, cloud) * depthFactor;
  float murkFactor = clamp(cloud * depthFactor * murkIntensity * inside, 0.0, 1.0);
  murkFactorOut = murkFactor;
  vec3 murkColor = clamp(uMurkColor, vec3(0.0), vec3(1.0));
  float darkness = clamp(uSceneDarkness, 0.0, 1.0);
  float murkDarkScale = mix(1.0, 0.22, darkness);
  float baseLuma = dot(baseColor, vec3(0.299, 0.587, 0.114));
  float localLight = clamp(0.35 + baseLuma * 0.85, 0.2, 1.0);
  vec3 muckyCol = mix(murkColor * 0.6, murkColor, cloud);
  muckyCol *= murkDarkScale * localLight;
  muckyCol += grain * 0.35 * murkDarkScale * localLight;
  return mix(baseColor, muckyCol, murkFactor);
}

// Safe sampling for refraction/distortion taps.
// Prevents pulling pixels from:
//   - Occluded (upper-floor) regions
//   - Outside the water body near shore/edges
float refractTapValid(vec2 screenUv) {
  float vOcc = 1.0;
  // Occluder gating in screen UV.
  if (uHasWaterOccluderAlpha > 0.5) {
    float occ = texture2D(tWaterOccluderAlpha, screenUv).a;
    // Soft cutoff so refraction smoothly pins at the silhouette edge.
    vOcc = 1.0 - smoothstep(0.45, 0.55, occ);
  }

  // Water-body gating: if the shifted UV lands outside the water mask,
  // reject it so we don't pull pixels from above-water areas.
  if (uHasSceneRect > 0.5) {
    vec2 foundryPos = screenUvToFoundry(screenUv);
    vec2 suv = foundryToSceneUv(foundryPos);
    float inScene = step(0.0, suv.x) * step(suv.x, 1.0) * step(0.0, suv.y) * step(suv.y, 1.0);
    if (inScene < 0.5) return 0.0;
    vec4 wdS = texture2D(tWaterData, clamp(suv, vec2(0.0), vec2(1.0)));
    float insideS = (uUseSdfMask > 0.5)
      ? waterInsideFromSdf(wdS.r)
      : smoothstep(0.02, 0.08, wdS.g);
    return insideS * vOcc;
  }

  return vOcc;
}

vec4 sampleRefractedSafe(vec2 screenUv, vec4 fallback) {
  return (refractTapValid(screenUv) > 0.5) ? texture2D(tDiffuse, screenUv) : fallback;
}

// ── Main ─────────────────────────────────────────────────────────────────
void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  float isEnabled = step(0.5, uWaterEnabled) * step(0.5, uHasWaterData);
  if (isEnabled < 0.5) { gl_FragColor = base; return; }
  // Occluder mask: when viewing upper floors, we render upper-floor tiles
  // into this mask. Any non-zero alpha means the current pixel is covered
  // by an upper-floor tile and should not receive water shading.
  if (uHasWaterOccluderAlpha > 0.5) {
    float occ = texture2D(tWaterOccluderAlpha, vUv).a;
    // Use a relatively high cutoff so soft alpha edges / shadows in upper-floor
    // art don't suppress water far away from the visible tile silhouette.
    if (occ > 0.5) {
      gl_FragColor = base;
      return;
    }
  }

  // Depth occlusion: fallback only.
  // When an explicit occluder mask is provided, prefer it over depth.
  // Depth can be extremely sensitive (upper floors may be ~1 unit above ground)
  // and can suppress water too aggressively.
  if (uHasWaterOccluderAlpha < 0.5 && uDepthEnabled > 0.5) {
    float deviceDepth = texture2D(uDepthTexture, vUv).r;
    // deviceDepth ~ 1.0 means background / nothing rendered into depth.
    if (deviceDepth < 0.9999) {
      float storedLinear = msa_linearizeDepth(deviceDepth);
      float ratio = storedLinear / max(uGroundDistance, 1.0);
      float aboveGround = max(0.0, uGroundDistance - storedLinear);
      float aboveActiveFloor = aboveGround - uActiveLevelElevation;
      // Relative threshold so upper-floor tiles don't fully cull lower-floor water.
      if (ratio < 0.99995 && aboveActiveFloor > 0.5) {
        gl_FragColor = base;
        return;
      }
    }
  }

  vec2 sceneUv = vUv;
  vec2 worldSceneUv = vUv;
  if (uHasSceneRect > 0.5) {
    vec2 foundryPos = screenUvToFoundry(vUv);
    sceneUv = foundryToSceneUv(foundryPos);
    worldSceneUv = sceneUv;
    float inScene = step(0.0, sceneUv.x) * step(sceneUv.x, 1.0) * step(0.0, sceneUv.y) * step(sceneUv.y, 1.0);
    if (inScene < 0.5) { gl_FragColor = base; return; }
    sceneUv = clamp(sceneUv, vec2(0.0), vec2(1.0));
  }

  vec4 wd = texture2D(tWaterData, sceneUv);
  float sdf01 = wd.r;
  float exposure01 = wd.g;
  float inside = (uUseSdfMask > 0.5)
    ? waterInsideFromSdf(sdf01)
    : smoothstep(0.02, 0.08, exposure01);
  float shore = clamp(exposure01, 0.0, 1.0);
  float distInside = (uUseSdfMask > 0.5)
    ? distortionInsideFromSdf(sdf01)
    : inside;
  float distMask = distInside * shoreFactor(shore);
  float outdoorStrength = 1.0;
  if (uHasOutdoorsMask > 0.5) {
    outdoorStrength = sampleOutdoorsMask(worldSceneUv);
  }

  // Debug views
  if (uDebugView > 0.5) {
    float d = floor(uDebugView + 0.5);
    if (d < 1.5) {
      if (uHasWaterRawMask < 0.5) gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0);
      else gl_FragColor = vec4(vec3(texture2D(tWaterRawMask, sceneUv).r), 1.0);
      return;
    }
    if (d < 2.5) { gl_FragColor = vec4(vec3(inside), 1.0); return; }
    if (d < 3.5) { gl_FragColor = vec4(vec3(sdf01), 1.0); return; }
    if (d < 4.5) { gl_FragColor = vec4(vec3(exposure01), 1.0); return; }
    if (d < 5.5) { vec2 nn = smoothFlow2D(sceneUv); gl_FragColor = vec4(nn * 0.5 + 0.5, 0.0, 1.0); return; }
    if (d < 6.5) { float wv = 0.5 + 0.5 * waveHeight(sceneUv, uWindTime, 1.0); gl_FragColor = vec4(vec3(wv), 1.0); return; }
    // DebugView mapping matches the UI schema:
    // 7 = Distortion, 8 = Occluder
    if (d < 7.5) { gl_FragColor = vec4(vec3(distMask), 1.0); return; }
    if (d < 8.5) {
      float occ = (uHasWaterOccluderAlpha > 0.5) ? texture2D(tWaterOccluderAlpha, vUv).a : 0.0;
      gl_FragColor = vec4(vec3(occ), 1.0);
      return;
    }
    gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); return;
  }

  if (inside < 0.01) { gl_FragColor = base; return; }

  // Animated distortion
  vec2 waveGrad = waveGrad2D(sceneUv, uWindTime, 1.0);
  waveGrad = rotate2D(waveGrad, uWaveAppearanceRotRad + 1.5707963);
  vec2 flowN = vec2(0.0);
  float waveStrength = uWaveStrength;
  if (uWaveIndoorDampingEnabled > 0.5) {
    float dampStrength = clamp(uWaveIndoorDampingStrength, 0.0, 1.0);
    float minFactor = clamp(uWaveIndoorMinFactor, 0.0, 1.0);
    float waveMult = mix(1.0, mix(minFactor, 1.0, outdoorStrength), dampStrength);
    waveStrength *= waveMult;
  }
  float distortionPx = uDistortionStrengthPx;
  vec2 combinedVec = waveGrad * waveStrength;
  combinedVec = combinedVec / (1.0 + 0.75 * length(combinedVec));
  float m = length(combinedVec);
  float dirMask = smoothstep(0.01, 0.06, m);
  vec2 combinedN = (m > 1e-6) ? (combinedVec / m) * dirMask : vec2(0.0);
  float amp = smoothstep(0.0, 0.30, m); amp *= amp;
  vec2 texel = 1.0 / max(uResolution, vec2(1.0));
  float px = clamp(distortionPx, 0.0, 64.0);
  float zoom = max(uZoom, 0.001);
  vec2 offsetUvRaw = combinedN * (px * texel) * amp * zoom;

  // Rain distortion
  vec2 rainOffPx = computeRainOffsetPx(worldSceneUv);
  if (uRainIndoorDampingEnabled > 0.5) {
    float dampStrength = clamp(uRainIndoorDampingStrength, 0.0, 1.0);
    float indoorMult = mix(1.0, outdoorStrength, dampStrength);
    rainOffPx *= indoorMult;
  }
  offsetUvRaw += (rainOffPx * texel) * zoom;
  vec2 offsetUv = offsetUvRaw * distMask;
  vec2 uv1 = clamp(vUv + offsetUv, vec2(0.001), vec2(0.999));

  // If the distorted center UV would sample outside the water body or into an
  // occluder, smoothly pin the distortion to zero at this pixel.
  float v1 = refractTapValid(uv1);
  offsetUv *= v1;
  uv1 = clamp(vUv + offsetUv, vec2(0.001), vec2(0.999));
  vec4 centerSample = texture2D(tDiffuse, uv1);

  #ifdef USE_WATER_REFRACTION_MULTITAP
  vec2 uv0 = clamp(vUv + offsetUv * 0.55, vec2(0.001), vec2(0.999));
  vec2 uv2 = clamp(vUv + offsetUv * 1.55, vec2(0.001), vec2(0.999));
  float v0 = refractTapValid(uv0);
  float v2 = refractTapValid(uv2);
  vec4 tap0 = (v0 > 0.5) ? texture2D(tDiffuse, uv0) : centerSample;
  vec4 tap2 = (v2 > 0.5) ? texture2D(tDiffuse, uv2) : centerSample;
  // Renormalize weights so partial invalid taps don't create edge halos.
  float w0 = 0.25 * v0;
  float w1 = 0.50;
  float w2 = 0.25 * v2;
  float wSum = max(1e-6, w0 + w1 + w2);
  vec4 refracted = (tap0 * w0 + centerSample * w1 + tap2 * w2) / wSum;
  #else
  vec4 refracted = centerSample;
  #endif

  #ifdef USE_WATER_CHROMATIC_ABERRATION
  vec2 texel2 = 1.0 / max(uResolution, vec2(1.0));
  float caPx = clamp(uChromaticAberrationStrengthPx, 0.0, 12.0);
  vec2 dir = offsetUv; float dirLen = length(dir);
  vec2 dirN = (dirLen > 1e-6) ? (dir / dirLen) : vec2(1.0, 0.0);
  // Gate by both SDF edge mask AND distMask so RGB samples never land outside
  // the water body or in occluded (upper-floor) areas near the shoreline.
  float caEdgeMask = chromaticInsideFromSdf(sdf01) * clamp(distMask, 0.0, 1.0);
  vec2 caUv = dirN * (caPx * texel2) * clamp(0.25 + 2.0 * distMask, 0.0, 2.5) * zoom * caEdgeMask;
  vec2 uvR = clamp(uv1 + caUv, vec2(0.001), vec2(0.999));
  vec2 uvB = clamp(uv1 - caUv, vec2(0.001), vec2(0.999));
  // Prevent RGB shift from pulling pixels from occluded (upper-floor) regions.
  float occR = (uHasWaterOccluderAlpha > 0.5) ? texture2D(tWaterOccluderAlpha, uvR).a : 0.0;
  float occB = (uHasWaterOccluderAlpha > 0.5) ? texture2D(tWaterOccluderAlpha, uvB).a : 0.0;
  vec4 sR = texture2D(tDiffuse, uvR);
  vec4 sB = texture2D(tDiffuse, uvB);
  // Fall back to centre sample for any channel whose shifted UV is occluded.
  float rChannel = (occR > 0.5) ? refracted.r : sR.r;
  float bChannel = (occB > 0.5) ? refracted.b : sB.b;
  refracted.rgb = vec3(rChannel, refracted.g, bChannel);
  #endif

  vec3 col = refracted.rgb;

  // Cloud shadows (screen-space), shared from CloudEffect output.
  float cloudShadow = 0.0;
  if (uCloudShadowEnabled > 0.5 && uHasCloudShadow > 0.5) {
    float cloudLitRaw = texture2D(tCloudShadow, vUv).r;
    cloudShadow = clamp(1.0 - cloudLitRaw, 0.0, 1.0);
    float dStrength = clamp(uCloudShadowDarkenStrength, 0.0, 4.0);
    float dCurve = max(0.01, uCloudShadowDarkenCurve);
    float darken = dStrength * pow(cloudShadow, dCurve);
    col *= max(0.0, 1.0 - darken);
  }

  // Murk
  float murkFactor = 0.0;
  col = applyMurk(sceneUv, uTime, inside, shore, outdoorStrength, col, murkFactor);

  // Tint
  float effectiveTint = clamp(uTintStrength, 0.0, 1.0) * (1.0 - (murkFactor * 0.5));
  float k = effectiveTint * inside * shore;
  col = mix(col, uTintColor, k);

  // Caustics (underwater highlight patterns) — V1-accurate ridged-FBM filaments.
  if (uCausticsEnabled > 0.5) {
    float lo = clamp(uCausticsEdgeLo, 0.0, 1.0);
    float hi = clamp(uCausticsEdgeHi, 0.0, 1.0);
    float edgeLo = min(lo, hi - 0.001);
    float edgeHi = max(hi, edgeLo + 0.001);
    // V1: edge blur uses blurred depth; we use shore directly (no separate blur tap).
    float edge = smoothstep(edgeLo, edgeHi, clamp(shore, 0.0, 1.0));

    // V1-accurate depth/coverage: shallow water + shoreline boost.
    float depth = clamp(1.0 - shore, 0.0, 1.0);
    float shallow = pow(1.0 - depth, 1.1);
    float baseCoverage = 0.22;
    float shoreBoost = clamp(shore, 0.0, 1.0);
    float coverage = max(shallow, mix(baseCoverage, 1.0, shoreBoost));

    // V1-accurate dual-layer blend: soft base + sharp detail.
    float cSharp = causticsPattern(sceneUv, uTime, uCausticsScale, uCausticsSpeed, uCausticsSharpness);
    float cSoft  = causticsPattern(sceneUv, uTime * 0.85, uCausticsScale * 0.55, uCausticsSpeed * 0.65, max(0.1, uCausticsSharpness * 0.35));
    float c = clamp(0.65 * cSoft + 0.95 * cSharp, 0.0, 1.0);

    // V1-accurate cloud-shadow caustics kill.
    float causticsCloudLit = 1.0;
    if (uCloudShadowEnabled > 0.5 && uHasCloudShadow > 0.5) {
      float cloudLitRaw = texture2D(tCloudShadow, vUv).r;
      float cs = clamp(1.0 - cloudLitRaw, 0.0, 1.0);
      causticsCloudLit = max(0.0, 1.0 - cs);
    }

    // Brightness thresholding (V1): gate caustics to bright scene areas.
    float brightnessGate = 1.0;
    if (uCausticsBrightnessMaskEnabled > 0.5) {
      float lum = msLuminance(col);
      float th = max(0.0, uCausticsBrightnessThreshold);
      float soft = max(0.0, uCausticsBrightnessSoftness);
      float g = smoothstep(th, th + soft, lum);
      g = pow(max(g, 0.0), max(0.01, uCausticsBrightnessGamma));
      brightnessGate = clamp(g, 0.0, 1.0);
    }

    float causticsAmt = clamp(uCausticsIntensity, 0.0, 8.0) * coverage;
    causticsAmt *= edge * causticsCloudLit * brightnessGate * inside;
    // Treat caustics as LIGHT (illumination) instead of pigment.
    // WindowLightEffectV2 contributes to the lighting accumulation buffer, then
    // LightingEffect composes as: litColor = albedo * totalIllumination.
    // We approximate that behaviour here by multiplying the current colour by a
    // caustics illumination term, which preserves underlying albedo detail.
    float cLight = c * causticsAmt * 1.35;
    vec3 warm = vec3(1.0, 1.0, 0.85);
    vec3 causticsTint = mix(vec3(1.0), warm, 0.85);
    // Small tint toward water hue, but keep it mostly warm-white so it reads as light.
    causticsTint = mix(causticsTint, clamp(uTintColor, vec3(0.0), vec3(1.0)), 0.08);
    col *= (vec3(1.0) + causticsTint * cLight);
  }

  // Sand
  #ifdef USE_SAND
  float sandAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
  float sandAlpha = sandMask(sceneUv, shore, inside, sandAspect);
  col = mix(col, uSandColor, sandAlpha);
  col += uSandColor * (sandAlpha * clamp(uSandAdditive, 0.0, 1.0));
  #endif

  // Foam
  float foamAmount = getFoamBaseAmount(sceneUv, shore, inside, rainOffPx);
  float foamVisual = clamp(foamAmount, 0.0, 1.0);
  float foamAlpha = smoothstep(0.08, 0.35, foamVisual);
  foamAlpha = pow(foamAlpha, 0.75);
  float sceneLuma = dot(col, vec3(0.299, 0.587, 0.114));
  float darkness = clamp(uSceneDarkness, 0.0, 1.0);
  float foamDarkScale = mix(1.0, 0.08, darkness);
  float foamLightScale = clamp(sceneLuma * 1.15, 0.0, 1.0);
  vec3 foamCol = uFoamColor * max(0.02, foamLightScale) * foamDarkScale;
  col = mix(col, foamCol, foamAlpha);

  // Shader flecks
  float shaderFlecks = getShaderFlecks(sceneUv, shore, inside, foamAlpha);
  col += foamCol * shaderFlecks * 0.8;

  // Specular (GGX)
  vec2 slope;
  if (uSpecNormalMode > 2.5) {
    // Mode 3: use the stabilized distortion vector as the specular slope.
    // This is intentionally coupled to the same field that drives refraction,
    // and avoids the problematic wave normal/height gradients.
    slope = combinedVec * (0.90 * clamp(uSpecNormalStrength, 0.0, 10.0));
    slope *= clamp(uSpecNormalScale, 0.0, 1.0);
  } else if (uSpecNormalMode > 1.5) {
    // Mode 2: height-derived wave slope (finite-difference). Smooth and wave-like.
    slope = specWaveSlopeFromHeight2D(sceneUv, uWindTime) * clamp(uSpecNormalStrength, 0.0, 10.0);
    slope *= clamp(uSpecNormalScale, 0.0, 1.0);
  } else if (uSpecNormalMode > 0.5) {
    // Mode 1: flat/camera-facing normal + smooth procedural micro-normal.
    // This avoids the hard-edged artifacts from wave-gradient normals.
    slope = specMicroSlope2D(sceneUv, uWindTime) * clamp(uSpecMicroStrength, 0.0, 10.0);
  } else {
    // Mode 0: legacy wave-gradient slope.
    slope = (waveGrad * waveStrength) * clamp(uSpecNormalStrength, 0.0, 10.0);
    slope *= clamp(uSpecNormalScale, 0.0, 1.0);
  }

  // Add distortion-driven micro-normal (primarily rain ripples).
  if (uSpecDisableRainSlope < 0.5) {
    vec2 rainSlope = rainOffPx / max(1.0, uRainMaxCombinedStrengthPx);
    slope += (rainSlope * 0.9) * clamp(uSpecDistortionNormalStrength, 0.0, 5.0);
  }

  if (uSpecForceFlatNormal > 0.5) {
    slope = vec2(0.0);
  }

  // Soft saturation to prevent huge slopes from turning into sharp bands.
  // Similar idea to combinedVec normalization used for distortion.
  slope = slope / (1.0 + 0.85 * length(slope));

  // Anisotropy
  float an = clamp(uSpecAnisotropy, 0.0, 1.0);
  if (an > 1e-4) {
    vec2 wd2 = uWindDir; float wl2 = length(wd2);
    wd2 = (wl2 > 1e-6) ? (wd2 / wl2) : vec2(1.0, 0.0);
    wd2.y = -wd2.y;
    vec2 t = wd2; vec2 b = vec2(-t.y, t.x);
    vec2 s = vec2(dot(slope, t), dot(slope, b));
    float ratio = clamp(uSpecAnisoRatio, 1.0, 16.0);
    s = vec2(s.x * mix(1.0, 1.0/ratio, an), s.y * mix(1.0, ratio, an));
    slope = t * s.x + b * s.y;
  }

  vec3 N = normalize(vec3(-slope.x, -slope.y, 1.0));
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 L = normalize(uSpecSunDir);
  float NoV = clamp(dot(N, V), 0.0, 1.0);
  float NoL = clamp(dot(N, L), 0.0, 1.0);
  vec3 H = normalize(L + V);
  float NoH = clamp(dot(N, H), 0.0, 1.0);
  float VoH = clamp(dot(V, H), 0.0, 1.0);
  float p01 = clamp((uSpecPower - 1.0) / 23.0, 0.0, 1.0);
  float rMin = clamp(uSpecRoughnessMin, 0.001, 1.0);
  float rMax = clamp(uSpecRoughnessMax, 0.001, 1.0);
  float rough = mix(max(rMax, min(rMin, rMax) + 1e-4), min(rMin, rMax), p01);

  // Specular AA: if the normal/slope varies too fast across pixels, GGX produces
  // sub-pixel sparkles (thin scratchy lines). Increase roughness locally to
  // band-limit the highlight.
  vec2 fw = fwidth(slope);
  float slopeFw = clamp(length(fw), 0.0, 1.0);
  float aa = slopeFw * clamp(uSpecAAStrength, 0.0, 10.0);
  rough = clamp(rough + aa, 0.001, 1.0);

  vec3 spec;
  if (uSpecModel > 0.5) {
    // Stable fallback model: Blinn-Phong style specular.
    // This cannot explode like GGX and is useful for debugging.
    float shininess = mix(16.0, 512.0, p01);
    float blinn = pow(max(NoH, 0.0), shininess);
    float f0 = clamp(uSpecF0, 0.0, 1.0);
    float fres = f0 + (1.0 - f0) * pow(1.0 - VoH, 5.0);
    spec = vec3(blinn * fres) * NoL;
  } else {
    // Default model: GGX microfacet.
    float alpha = max(0.001, rough * rough);
    float a2 = alpha * alpha;
    float dDen = (NoH * NoH) * (a2 - 1.0) + 1.0;
    float D = a2 / max(1e-6, 3.14159265 * dDen * dDen);
    float ggxK = (rough + 1.0); ggxK = (ggxK * ggxK) / 8.0;
    float Gv = NoV / max(1e-6, NoV * (1.0 - ggxK) + ggxK);
    float Gl = NoL / max(1e-6, NoL * (1.0 - ggxK) + ggxK);
    float G = Gv * Gl;
    float f0 = clamp(uSpecF0, 0.0, 1.0);
    vec3 F0 = vec3(f0);
    vec3 F = F0 + (1.0 - F0) * pow(1.0 - VoH, 5.0);
    vec3 specBRDF = (D * G) * F / max(1e-6, 4.0 * NoV * NoL);
    spec = specBRDF * NoL;
  }

  if (uCloudShadowEnabled > 0.5 && cloudShadow > 1e-5) {
    float kStrength = clamp(uCloudShadowSpecularKill, 0.0, 1.0);
    float kCurve = max(0.01, uCloudShadowSpecularCurve);
    float litPow = pow(clamp(1.0 - cloudShadow, 0.0, 1.0), kCurve);
    spec *= mix(1.0, litPow, kStrength);
  }
  if (uSpecDisableMasking < 0.5) {
    float specMask = pow(clamp(distInside, 0.0, 1.0), clamp(uSpecMaskGamma, 0.05, 12.0));
    spec *= specMask;
    float shoreBias = mix(1.0, shore, clamp(uSpecShoreBias, 0.0, 1.0));
    spec *= shoreBias;
  }
  float strength = clamp(uSpecStrength, 0.0, 250.0) / 50.0;
  spec *= strength * clamp(uSpecSunIntensity, 0.0, 10.0);
  spec *= mix(1.0, 0.05, clamp(uSceneDarkness, 0.0, 1.0));
  vec3 skyCol = clamp(uSkyColor, vec3(0.0), vec3(1.0));
  float skyI = clamp(uSkyIntensity, 0.0, 1.0);
  float skySpecI = mix(0.08, 1.0, skyI);
  vec3 tint = mix(vec3(1.0), skyCol, clamp(uSpecSkyTint, 0.0, 1.0));
  vec3 specCol = spec * tint * skySpecI;
  float sClamp = max(0.0, uSpecClamp);
  if (sClamp > 0.0) {
    specCol = min(specCol, vec3(sClamp));
  }
  col += specCol;

  gl_FragColor = vec4(col, base.a);
}
`;
}
