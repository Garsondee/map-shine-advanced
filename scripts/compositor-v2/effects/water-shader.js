/**
 * @fileoverview GLSL shaders for V2 Water Effect.
 *
 * V2 design: fullscreen post-processing pass that applies water tint, wave
 * distortion, caustics, specular (GGX), foam, murk, rain ripples,
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
 *   - Water occluder alpha (tWaterOccluderAlpha; screen-space tile union, not tWaterData SDF)
 *
 * Preserved from V1 (all visual features):
 *   - Texture-based noise (replaces procedural hash for fast compile)
 *   - Rain ripple cellular automaton
 *   - Storm distortion vector field
 *   - Multi-octave wave system with warp, evolution, and wind coupling
 *   - Shore foam with curl noise breakup + floating foam clumps
 *   - Shader-based foam flecks (ifdef USE_FOAM_FLECKS)
 *   - Murk (subsurface silt/algae)
 *   - GGX specular with anisotropy + optional surface chaos (patchy roughness, capillary normals)
 *   - Chromatic aberration (runtime toggle + thresholded Kawase blur)
 *   - Multi-tap refraction (ifdef USE_WATER_REFRACTION_MULTITAP)
 *   - SDF-based edge masking for distortion and chromatic aberration
 *   - Debug views (raw mask, inside, SDF, exposure, normals, wave height)
 *   - Screen UV → Foundry → scene UV coordinate pipeline
 *
 * @module compositor-v2/effects/water-shader
 */

import { DepthShaderChunks } from '../../effects/DepthShaderChunks.js';

/**
 * Returns the fragment shader source.
 * The old rain ripple/storm cellular automaton loops have been replaced with a
 * simple noise-based precipitation distortion that is GPU-safe on all drivers.
 * This function is kept as an alias for backward compatibility with callers
 * that previously used the "safe" variant.
 * @returns {string} GLSL fragment shader source
 */
export function getFragmentShaderSafe() {
  return getFragmentShader();
}

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
// tNoiseMap: use texture2DLodEXT(..., 0.0) so sampling does not rely on implicit
// screen-space gradients inside loops (ANGLE/D3D X3595). Three maps this to textureLod on WebGL2.

#ifdef USE_WATER_SPEC_BLOOM_RT
layout(location = 1) out highp vec4 pc_fragColor1;
#define MSA_BLOOM_RT_ZERO pc_fragColor1 = vec4(0.0)
#define MSA_BLOOM_RT_COMMIT(rgb) pc_fragColor1 = vec4(max((rgb), vec3(0.0)), 1.0)
#else
#define MSA_BLOOM_RT_ZERO
#define MSA_BLOOM_RT_COMMIT(rgb)
#endif

// ── Texture samplers ─────────────────────────────────────────────────────
uniform sampler2D tDiffuse;       // Scene RT (lit + sky + filter; user CC runs after water in FloorCompositor)
uniform sampler2D tNoiseMap;      // 512x512 RGBA seeded noise
uniform sampler2D tWaterData;     // SDF data (R=SDF, G=exposure, BA=normals)
uniform float uHasWaterData;      // 1.0 when tWaterData is valid
uniform float uWaterEnabled;      // Master enable
// 1 when this slice borrows another floor's packed water mask (upper band + river below).
uniform float uCrossSliceWaterData;

uniform sampler2D tWaterRawMask;  // Raw composited water mask (for foam edge)
uniform float uHasWaterRawMask;   // 1.0 when tWaterRawMask is valid
uniform float uWaterRawMaskThreshold; // [0..1], matches mask binarization (authoritative coverage)
uniform vec2 uWaterRawMaskTexelSize;  // 1 / dimensions of composited _Water RT (edge AA in UV)

uniform sampler2D tWaterOccluderAlpha; // Screen-space upper-floor occluder mask
uniform float uHasWaterOccluderAlpha;  // 1.0 when occluder mask is valid
uniform sampler2D tOverheadRoofBlock;  // Water-source floor overhead-only bus mask
uniform float uHasOverheadRoofBlock;   // 1.0 when tOverheadRoofBlock is valid
uniform sampler2D tSliceAlpha;         // Authoritative per-level albedo alpha (pre-post chain)
uniform float uHasSliceAlpha;          // 1.0 when tSliceAlpha is valid
// Post-merge: pre-multiplied transmittance from all upper bg layers (baked RT).
uniform sampler2D tWaterBgAlphaMask;
uniform float uHasWaterBgAlphaMask;
// Debug: 0 off; 3 = fullscreen yellow (water gate skipped). 1/2 = magenta/cyan only where water mask inside>0 (not uniforms — those are global per pass).
uniform float uDebugWaterPassTint;

uniform vec2 uWaterDataTexelSize; // 1.0 / tWaterData dimensions

// ── Tint ─────────────────────────────────────────────────────────────────
uniform vec3 uTintColor;
uniform float uTintStrength;

// ── Waves ────────────────────────────────────────────────────────────────
uniform float uWaveScale;
// Legacy: phase advance is fully encoded in uWaveTime (integrated in JS). Kept for API compat; not used in Gerstner phase.
uniform float uWaveSpeed;
uniform float uWaveStrength;
uniform float uWaveMotion01;
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
uniform float uWaveBreakupStrength;
uniform float uWaveBreakupScale;
uniform float uWaveBreakupSpeed;
uniform float uWaveBreakupWarp;
uniform float uWaveBreakupDistortionStrength;
uniform float uWaveBreakupSpecularStrength;
uniform float uWaveMicroNormalStrength;
uniform float uWaveMicroNormalScale;
uniform float uWaveMicroNormalSpeed;
uniform float uWaveMicroNormalWarp;
uniform float uWaveMicroNormalDistortionStrength;
uniform float uWaveMicroNormalSpecularStrength;

// ── Chromatic aberration ─────────────────────────────────────────────────
uniform float uChromaticAberrationEnabled;
uniform float uChromaticAberrationStrengthPx;
uniform float uChromaticAberrationThreshold;
uniform float uChromaticAberrationThresholdSoftness;
uniform float uChromaticAberrationKawaseBlurPx;
uniform float uChromaticAberrationSampleSpread;
uniform float uChromaticAberrationEdgeCenter;
uniform float uChromaticAberrationEdgeFeather;
uniform float uChromaticAberrationEdgeGamma;
uniform float uChromaticAberrationEdgeMin;
uniform float uChromaticAberrationDeadzone;
uniform float uChromaticAberrationDeadzoneSoftness;

// ── Distortion edge masking ──────────────────────────────────────────────
uniform float uDistortionEdgeCenter;
uniform float uDistortionEdgeFeather;
uniform float uDistortionEdgeGamma;
uniform float uDistortionShoreRemapLo;
uniform float uDistortionShoreRemapHi;
uniform float uDistortionShorePow;
uniform float uDistortionShoreMin;

// ── Precipitation distortion ─────────────────────────────────────────────
uniform float uRainEnabled;
uniform float uRainPrecipitation;
uniform float uRainDistortionStrengthPx;
uniform float uRainDistortionScale;
uniform float uRainDistortionSpeed;
uniform sampler2D tOutdoorsMask;
uniform float uHasOutdoorsMask;
uniform float uOutdoorsMaskFlipY;
uniform float uRainIndoorDampingEnabled;
uniform float uRainIndoorDampingStrength;

// ── Wind ─────────────────────────────────────────────────────────────────
uniform vec2 uWindDir;
uniform vec2 uPrevWindDir;
uniform vec2 uTargetWindDir;
uniform float uWindDirBlend;
uniform float uWindSpeed;
uniform vec2 uWindOffsetUv;
uniform float uWindTime;
uniform float uWaveTime;

uniform float uLockWaveTravelToWind;
uniform float uWaveDirOffsetRad;
uniform float uWaveAppearanceRotRad;
uniform float uWaveTriBlendAngleRad;
uniform float uWaveTriSideWeight;

// ── Specular (GGX) ──────────────────────────────────────────────────────
uniform float uSpecStrength;
uniform float uSpecPower;
uniform float uSpecModel;
uniform float uSpecClamp;
uniform float uSpecForceFlatNormal;
uniform float uSpecDisableMasking;
uniform float uSpecDisableRainSlope;

uniform vec3 uSpecSunDir;
uniform float uSpecSunElevationDeg;
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
uniform float uSpecSurfaceChaos;
uniform float uSpecF0;
uniform float uSpecMaskGamma;
uniform float uSpecSkyTint;
uniform float uSpecShoreBias;
uniform float uSpecDistortionNormalStrength;
uniform float uSpecAnisotropy;
uniform float uSpecAnisoRatio;

// ── Specular Highlights (additive sharp highlights) ────────────────────
uniform float uSpecHighlightsEnabled;
uniform float uSpecHighlightsStrength;
uniform float uSpecHighlightsPower;
uniform float uSpecHighlightsClamp;
uniform vec3 uSpecHighlightsSunDir;
uniform float uSpecHighlightsSunAzimuthDeg;
uniform float uSpecHighlightsSunElevationDeg;
uniform float uSpecHighlightsSunIntensity;
uniform float uSpecHighlightsNormalStrength;
uniform float uSpecHighlightsNormalScale;
uniform float uSpecHighlightsRoughnessMin;
uniform float uSpecHighlightsRoughnessMax;
uniform float uSpecHighlightsF0;
uniform float uSpecHighlightsSkyTint;
uniform float uSpecHighlightsMaskGamma;
uniform float uSpecHighlightsShoreBias;

// Extra linear energy written to bloom specular RT (beauty pass unchanged)
uniform float uBloomSpecularEmitMul;

uniform float uSpecUseSunAngle;
uniform float uSpecSunElevationFalloffEnabled;
uniform float uSpecSunElevationFalloffStart;
uniform float uSpecSunElevationFalloffEnd;
uniform float uSpecSunElevationFalloffCurve;
uniform sampler2D tCloudShadow;
uniform float uHasCloudShadow;
uniform float uCloudShadowEnabled;
uniform float uCloudShadowDarkenStrength;
uniform float uCloudShadowDarkenCurve;
uniform float uCloudShadowSpecularKill;
uniform float uCloudShadowSpecularCurve;
uniform sampler2D tBuildingShadow;
uniform float uHasBuildingShadow;
uniform sampler2D tOverheadShadow;
uniform float uHasOverheadShadow;

// ShadowManagerV2 Combined Shadow (for murk darkening)
uniform sampler2D tCombinedShadow;
uniform float uHasCombinedShadow;
uniform float uMurkShadowEnabled;
uniform float uMurkShadowStrength;


// ── Cloud Reflection ───────────────────────────────────────────────────────────
uniform float uCloudReflectionEnabled;
uniform float uCloudReflectionStrength;
uniform sampler2D tCloudTopTexture;
uniform float uHasCloudTopTexture;

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

// ── Shore Foam (Advanced) ────────────────────────────────────────────────
uniform float uShoreFoamEnabled;
uniform float uShoreFoamStrength;
uniform float uShoreFoamThreshold;
uniform float uShoreFoamScale;
uniform float uShoreFoamSpeed;
uniform float uShoreFoamCoverage;
uniform vec2 uShoreFoamSeedOffset;
uniform float uShoreFoamTimeOffset;

// Shore Foam Appearance
uniform vec3 uShoreFoamColor;
uniform float uShoreFoamOpacity;
uniform float uShoreFoamBrightness;
uniform float uShoreFoamContrast;
uniform float uShoreFoamGamma;
uniform vec3 uShoreFoamTint;
uniform float uShoreFoamTintStrength;
uniform float uShoreFoamColorVariation;

// Shore Foam Lighting
uniform float uShoreFoamLightingEnabled;
uniform float uShoreFoamAmbientLight;
uniform float uShoreFoamSceneLightInfluence;
uniform float uShoreFoamDarknessResponse;

// Shore Foam Complexity
uniform float uShoreFoamFilamentsEnabled;
uniform float uShoreFoamFilamentsStrength;
uniform float uShoreFoamFilamentsScale;
uniform float uShoreFoamFilamentsLength;
uniform float uShoreFoamFilamentsWidth;
uniform float uShoreFoamThicknessVariation;
uniform float uShoreFoamThicknessScale;
uniform float uShoreFoamEdgeDetail;
uniform float uShoreFoamEdgeDetailScale;

// Shore Foam Distortion & Evolution
uniform float uShoreFoamWaveDistortionStrength;
uniform float uShoreFoamNoiseDistortionEnabled;
uniform float uShoreFoamNoiseDistortionStrength;
uniform float uShoreFoamNoiseDistortionScale;
uniform float uShoreFoamNoiseDistortionSpeed;
uniform float uShoreFoamEvolutionEnabled;
uniform float uShoreFoamEvolutionSpeed;
uniform float uShoreFoamEvolutionAmount;
uniform float uShoreFoamEvolutionScale;

// Shore Foam Coverage
uniform float uShoreFoamCoreWidth;
uniform float uShoreFoamCoreFalloff;
uniform float uShoreFoamTailWidth;
uniform float uShoreFoamTailFalloff;
uniform float uShoreFoamFadeCurve;

// ── Floating Foam ────────────────────────────────────────────────────────
uniform float uFloatingFoamStrength;
uniform float uFloatingFoamCoverage;
uniform float uFloatingFoamScale;
uniform float uFloatingFoamWaveDistortion;

// Floating Foam Advanced (Phase 1)
uniform vec3 uFloatingFoamColor;
uniform float uFloatingFoamOpacity;
uniform float uFloatingFoamBrightness;
uniform float uFloatingFoamContrast;
uniform float uFloatingFoamGamma;
uniform vec3 uFloatingFoamTint;
uniform float uFloatingFoamTintStrength;
uniform float uFloatingFoamColorVariation;

// Floating Foam Lighting
uniform float uFloatingFoamLightingEnabled;
uniform float uFloatingFoamAmbientLight;
uniform float uFloatingFoamSceneLightInfluence;
uniform float uFloatingFoamDarknessResponse;

// Floating Foam Shadow Casting
uniform float uFloatingFoamShadowEnabled;
uniform float uFloatingFoamShadowStrength;
uniform float uFloatingFoamShadowSoftness;
uniform float uFloatingFoamShadowDepth;

// Floating Foam Complexity (Phase 2)
uniform float uFloatingFoamFilamentsEnabled;
uniform float uFloatingFoamFilamentsStrength;
uniform float uFloatingFoamFilamentsScale;
uniform float uFloatingFoamFilamentsLength;
uniform float uFloatingFoamFilamentsWidth;
uniform float uFloatingFoamThicknessVariation;
uniform float uFloatingFoamThicknessScale;
uniform float uFloatingFoamEdgeDetail;
uniform float uFloatingFoamEdgeDetailScale;
uniform float uFloatingFoamLayerCount;
uniform float uFloatingFoamLayerOffset;

// Floating Foam Distortion & Evolution
uniform float uFloatingFoamWaveDistortionStrength;
uniform float uFloatingFoamNoiseDistortionEnabled;
uniform float uFloatingFoamNoiseDistortionStrength;
uniform float uFloatingFoamNoiseDistortionScale;
uniform float uFloatingFoamNoiseDistortionSpeed;
uniform float uFloatingFoamEvolutionEnabled;
uniform float uFloatingFoamEvolutionSpeed;
uniform float uFloatingFoamEvolutionAmount;
uniform float uFloatingFoamEvolutionScale;

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
// 1 when floor-depth blur is active and water mask floor is below the viewed top floor
// (that water sits on a Kawase-blurred composite — soften sharp procedural layers).
uniform float uFloorDepthBlurWaterSoft;

// Water depth shadow
uniform float uWaterDepthShadowEnabled;
uniform float uWaterDepthShadowStrength;
uniform float uWaterDepthShadowMinBrightness;

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
  float a = texture2DLodEXT(tNoiseMap, (i + 0.5) * NOISE_INV, 0.0).r;
  float b = texture2DLodEXT(tNoiseMap, (i + vec2(1.5, 0.5)) * NOISE_INV, 0.0).r;
  float c = texture2DLodEXT(tNoiseMap, (i + vec2(0.5, 1.5)) * NOISE_INV, 0.0).r;
  float d = texture2DLodEXT(tNoiseMap, (i + vec2(1.5, 1.5)) * NOISE_INV, 0.0).r;
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// V1 compatibility: older code calls valueNoise().
float valueNoise(vec2 p) {
  return valueNoise2D(p);
}

// Three octaves (RGB) — fourth octave removed vs V1 FBM: fewer texture fetches
// and faster compile, with weights nudged to keep similar contrast in warp/rain/murk.
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
    texture2DLodEXT(tNoiseMap, (i + 0.5) * NOISE_INV, 0.0).r,
    texture2DLodEXT(tNoiseMap, (i + vec2(1.5, 0.5)) * NOISE_INV, 0.0).r, u.x), mix(
    texture2DLodEXT(tNoiseMap, (i + vec2(0.5, 1.5)) * NOISE_INV, 0.0).r,
    texture2DLodEXT(tNoiseMap, (i + vec2(1.5, 1.5)) * NOISE_INV, 0.0).r, u.x), u.y);

  p = octRot * p * 2.0;
  p = mod(p, NOISE_SIZE);
  i = floor(p); f = fract(p); u = f * f * (3.0 - 2.0 * f);
  i = mod(i, NOISE_SIZE);
  float n1 = mix(mix(
    texture2DLodEXT(tNoiseMap, (i + 0.5) * NOISE_INV, 0.0).g,
    texture2DLodEXT(tNoiseMap, (i + vec2(1.5, 0.5)) * NOISE_INV, 0.0).g, u.x), mix(
    texture2DLodEXT(tNoiseMap, (i + vec2(0.5, 1.5)) * NOISE_INV, 0.0).g,
    texture2DLodEXT(tNoiseMap, (i + vec2(1.5, 1.5)) * NOISE_INV, 0.0).g, u.x), u.y);

  p = octRot * p * 2.0;
  p = mod(p, NOISE_SIZE);
  i = floor(p); f = fract(p); u = f * f * (3.0 - 2.0 * f);
  i = mod(i, NOISE_SIZE);
  float n2 = mix(mix(
    texture2DLodEXT(tNoiseMap, (i + 0.5) * NOISE_INV, 0.0).b,
    texture2DLodEXT(tNoiseMap, (i + vec2(1.5, 0.5)) * NOISE_INV, 0.0).b, u.x), mix(
    texture2DLodEXT(tNoiseMap, (i + vec2(0.5, 1.5)) * NOISE_INV, 0.0).b,
    texture2DLodEXT(tNoiseMap, (i + vec2(1.5, 1.5)) * NOISE_INV, 0.0).b, u.x), u.y);

  return (n0 - 0.5) * 1.14 + (n1 - 0.5) * 0.62 + (n2 - 0.5) * 0.36;
}

float safe01(float v) { return clamp(v, 0.0, 1.0); }

float smoothCycle01(float phase01) {
  // C1-continuous periodic envelope in [0,1].
  // Avoids the derivative cusps from triangle waves that can read as moving seams.
  return 0.5 - 0.5 * cos(6.2831853 * phase01);
}

vec2 safeNormalize2(vec2 v) {
  float l = length(v);
  return (l > 1e-6) ? (v / l) : vec2(0.0);
}

// _Outdoors mask (scene UV). Declared before warp/wave so indoor shelter can
// scale wind time consistently with foam/murk (see main() indoorWindMotion).
float sampleOutdoorsMask(vec2 sceneUv01) {
  float y = (uOutdoorsMaskFlipY > 0.5) ? (1.0 - sceneUv01.y) : sceneUv01.y;
  vec2 uv = vec2(sceneUv01.x, y);
  return texture2D(tOutdoorsMask, uv).r;
}

// Same shaping as main(): strong shelter indoors, tiny baseline to avoid 0-time seams.
float waterIndoorWindMotion01(vec2 sceneUv01) {
  if (uHasOutdoorsMask < 0.5) return 1.0;
  float o = clamp(sampleOutdoorsMask(sceneUv01), 0.0, 1.0);
  return max(0.05, pow(o, 2.2));
}

// ── Precipitation distortion ─────────────────────────────────────────────
// Simple noise-based surface agitation driven by precipitation amount.
// No nested loops — GPU-safe on all drivers.
vec2 computeRainOffsetPx(vec2 uv) {
  if (uRainEnabled < 0.5) return vec2(0.0);
  float p = safe01(uRainPrecipitation);
  if (p < 0.001) return vec2(0.0);

  float sc = max(0.5, uRainDistortionScale);
  float sp = max(0.0, uRainDistortionSpeed);
  float px = clamp(uRainDistortionStrengthPx, 0.0, 24.0);

  // Primary layer: fbmNoise; secondary: valueNoise2D (cheaper, still organic at rain scales).
  float t = uTime * sp;
  vec2 domain = uv * sc;
  float n1x = (valueNoise2D(domain + vec2(t * 0.13, -t * 0.09) + vec2(11.7, 7.3)) - 0.5) * 2.0;
  float n1y = (valueNoise2D(domain + vec2(-t * 0.11, t * 0.14) + vec2(31.1, 19.9)) - 0.5) * 2.0;
  vec2 dom2 = domain * 1.73 + vec2(t * 0.17, t * 0.07) + vec2(5.3, 41.1);
  float n2x = (valueNoise2D(dom2) - 0.5) * 2.0;
  float n2y = (valueNoise2D(domain * 1.73 + vec2(-t * 0.08, -t * 0.15) + vec2(23.7, 3.9)) - 0.5) * 2.0;

  vec2 offset = vec2(n1x * 0.58 + n2x * 0.42, n1y * 0.58 + n2y * 0.42);

  // Precipitation ramps in smoothly — light rain = subtle, heavy rain = strong
  float ramp = smoothstep(0.0, 0.6, p) * (0.5 + 0.5 * p);

  vec2 noisy = offset * px * ramp;

  // Wind shear: bias rain ripples downwind (uWindSpeed is gust-shaped 0..1 from WaterEffectV2).
  float wind01 = clamp(uWindSpeed, 0.0, 1.0);
  vec2 wRaw = uWindDir;
  float wlen = length(wRaw);
  wRaw = (wlen > 1e-6) ? (wRaw / wlen) : vec2(1.0, 0.0);
  float sa = (uHasSceneRect > 0.5)
    ? (uSceneRect.z / max(1.0, uSceneRect.w))
    : (uResolution.x / max(1.0, uResolution.y));
  vec2 windBasis = normalize(vec2(wRaw.x * sa, wRaw.y));
  vec2 windShear = windBasis * px * ramp * (2.5 + 9.5 * wind01);

  return noisy + windShear;
}

vec2 curlNoise2D(vec2 p) {
  float e = 0.02;
  float n1 = valueNoise2D(p + vec2(0.0, e));
  float n2 = valueNoise2D(p - vec2(0.0, e));
  float n3 = valueNoise2D(p + vec2(e, 0.0));
  float n4 = valueNoise2D(p - vec2(e, 0.0));
  return vec2((n1 - n2) / (2.0 * e), -(n3 - n4) / (2.0 * e));
}

float sceneAspectRatio() {
  return (uHasSceneRect > 0.5)
    ? (uSceneRect.z / max(1.0, uSceneRect.w))
    : (uResolution.x / max(1.0, uResolution.y));
}

vec2 effectUv(vec2 sceneUv) {
  // Keep procedural domains isotropic on non-square maps.
  float sceneAspect = sceneAspectRatio();
  return vec2(sceneUv.x * sceneAspect, sceneUv.y);
}

// ── Wave / Warp ──────────────────────────────────────────────────────────
vec2 warpUv(vec2 sceneUv, float motion01) {
  float m = clamp(motion01, 0.0, 1.0);
  float inShelter = waterIndoorWindMotion01(sceneUv);
  // Important: do NOT advect the wave *domain* using uWindOffsetUv.
  // Gerstner phase advances via uWaveTime (integrated in JS), not UV offset.
  // Advecting the domain as well can partially cancel / overtake the phase travel
  // and produces a standing-wave / ping-pong look.
  vec2 uv = sceneUv;
  // Use uWindTime (monotonically wind-driven) for warp drift speed.
  // This keeps all warp motion locked to the wind: as wind increases the
  // warp pattern advances faster, and it never reverses direction.
  float warpT = uWindTime * inShelter * max(0.0, uWaveWarpTimeSpeed) * m;
  float sceneAspect = sceneAspectRatio();
  vec2 windF = uWindDir;
  float wl = length(windF);
  windF = (wl > 1e-6) ? (windF / wl) : vec2(1.0, 0.0);
  // Keep wind in Foundry/scene UV space (Y-down), matching CloudEffectV2.
  vec2 windDir = vec2(windF.x, windF.y);
  vec2 windBasis = normalize(vec2(windDir.x * sceneAspect, windDir.y));
  vec2 windPerp = vec2(-windBasis.y, windBasis.x);
  vec2 basis = vec2(sceneUv.x * sceneAspect, sceneUv.y);
  float along = dot(basis, windBasis);
  float across = dot(basis, windPerp);
  vec2 streakUv = windBasis * (along * 2.75) + windPerp * (across * 1.0);
  // No oscillating pulse — warp strength is controlled by uWaveWarpLargeStrength.
  // Any sin/cos multiplier here would cause periodic amplitude variation that
  // contributes to the ping-pong appearance.
  // All FBM offsets are along/across the wind axis using warpT.
  // Previously these used fixed screen axes (e.g. vec2(t*0.07, -t*0.05))
  // which caused the sampled UV to drift perpendicular to the wave travel
  // direction, making waves appear to reverse and ping-pong.
  // Sample two noise values per warp layer: one for along-wind, one for cross-wind.
  // Displace uv along windBasis/windPerp so warp is coherent with wave travel.
  // Raw vec2(nA, nB) displacement causes arbitrary-direction warp drift -> ping-pong.
  float lf1 = (valueNoise2D(streakUv * 0.23 + vec2(19.1, 7.3) - windBasis * (warpT * 0.07)) - 0.5) * 2.0;
  float lf2 = (valueNoise2D(streakUv * 0.23 + vec2(3.7, 23.9) - windPerp  * (warpT * 0.04)) - 0.5) * 2.0;
  uv += (windBasis * lf1 + windPerp * lf2) * clamp(uWaveWarpLargeStrength, 0.0, 1.0);
  float n1 = (valueNoise2D((uv * 2.1) + vec2(13.7, 9.2) - windBasis * (warpT * 0.11)) - 0.5) * 2.0;
  float n2 = (valueNoise2D((uv * 2.1) + vec2(41.3, 27.9) - windPerp  * (warpT * 0.06)) - 0.5) * 2.0;
  uv += (windBasis * n1 + windPerp * n2) * clamp(uWaveWarpSmallStrength, 0.0, 1.0);
  // Micro warp: single value-noise octaves (4 taps each) — visually similar, less work than fbmNoise.
  float n3 = (valueNoise2D(uv * 4.7 + vec2(7.9, 19.1) - windBasis * (warpT * 0.15)) - 0.5) * 2.0;
  float n4 = (valueNoise2D(uv * 4.7 + vec2(29.4, 3.3) - windPerp  * (warpT * 0.05)) - 0.5) * 2.0;
  uv += (windBasis * n3 + windPerp * n4) * clamp(uWaveWarpMicroStrength, 0.0, 1.0);
  return uv;
}

float waveSeaState(vec2 sceneUv, float motion01) {
  if (uWaveEvolutionEnabled < 0.5) return 0.5;
  float sp = max(0.0, uWaveEvolutionSpeed) * clamp(motion01, 0.0, 1.0);
  float sc = max(0.01, uWaveEvolutionScale);
  float inShelter = waterIndoorWindMotion01(sceneUv);
  // Sample spatially-varying noise to break up the evolution into patches.
  // Use uWindTime so the pattern only advances with wind, never reverses.
  vec2 evoUv = effectUv(sceneUv);
  float n = valueNoise2D(evoUv * sc + vec2(uWindTime * inShelter * sp * 0.23, -uWindTime * inShelter * sp * 0.19));
  // Map each pixel's noise to a slowly-crawling phase, then use a smooth periodic
  // envelope. This keeps modulation non-negative while removing cusp-like seam bands.
  float phase = fract(uWindTime * inShelter * sp * 0.05 + n);
  return smoothCycle01(phase);
}

vec2 rotate2D(vec2 v, float a) {
  float s = sin(a); float c = cos(a);
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}

float hash11(float p) { return fract(sin(p) * 43758.5453123); }

float msLuminance(vec3 rgb) {
  return dot(rgb, vec3(0.2126, 0.7152, 0.0722));
}

float waveAngleOffsetSeed(int i) {
  if (i == 0) return 0.00;
  if (i == 1) return 0.25;
  if (i == 2) return -0.32;
  if (i == 3) return 0.58;
  if (i == 4) return -0.71;
  if (i == 5) return 0.94;
  return -1.15;
}

float waveWavelengthMul(int i) {
  if (i == 0) return 1.00; // Primary Swell
  if (i == 1) return 0.52; // Secondary Swell
  if (i == 2) return 0.29; // Large Chop
  if (i == 3) return 0.14; // Medium Chop
  if (i == 4) return 0.08; // Small Chop
  if (i == 5) return 0.04; // Micro Ripples
  return 0.02;
}

vec4 gerstnerWave(vec2 uv, vec2 dir, float wavelength, float steepness, float t, float phaseOffset) {
  float lambda = max(wavelength, 1e-3);
  float k = 6.2831853 / lambda;
  float omega = sqrt(2.0 * k); // Controls physical speed of wave propagation
  float phase = k * dot(dir, uv) - (omega * t) + phaseOffset;

  float cosP = cos(phase);
  float sinP = sin(phase);

  float a = steepness / max(k, 1e-4);
  float h = a * sinP;
  vec2 dxy = dir * (steepness * cosP);
  float dz = steepness * sinP;

  return vec4(h, dxy.x, dxy.y, dz);
}

// Vectorized Gerstner accumulation: 4 sin/cos pairs per batch instead of 4 scalar loops.
void gerstnerAccum4(
  inout float totalH,
  inout vec2 totalDxy,
  inout float totalDz,
  vec2 uv,
  vec2 windBasis,
  float t,
  float jitterField,
  float globalSteepness,
  float windStrength,
  float timeScale,
  float steepnessNorm,
  float steepnessWeightBase,
  float jitterLo,
  float jitterHi,
  float jitterDenom,
  float wlMulScale,
  vec4 wlMul,
  vec4 angleSeed,
  vec4 octaveBase,
  vec4 activeMask,
  bool addDz
) {
  float ws = mix(0.4, 1.2, windStrength);
  vec4 wl = max(vec4(0.02), wlMulScale * wlMul);
  vec4 k = 6.2831853 / wl;
  vec4 omega = sqrt(9.8 * k);

  vec2 dir0 = rotate2D(windBasis, angleSeed.x * ws);
  vec2 dir1 = rotate2D(windBasis, angleSeed.y * ws);
  vec2 dir2 = rotate2D(windBasis, angleSeed.z * ws);
  vec2 dir3 = rotate2D(windBasis, angleSeed.w * ws);

  vec4 dotU = vec4(dot(dir0, uv), dot(dir1, uv), dot(dir2, uv), dot(dir3, uv));
  vec4 phaseJitter = jitterField * mix(vec4(jitterLo), vec4(jitterHi), octaveBase / max(1.0, jitterDenom));
  vec4 phase = k * dotU - (omega * t * timeScale) + phaseJitter;
  vec4 cosP = cos(phase);
  vec4 sinP = sin(phase);
  vec4 steepnessWeight = pow(vec4(steepnessWeightBase), octaveBase);
  vec4 octaveSteepness = (globalSteepness * steepnessWeight * steepnessNorm) * activeMask;

  vec4 hContrib = (octaveSteepness / k) * sinP;
  totalH += hContrib.x + hContrib.y + hContrib.z + hContrib.w;

  totalDxy += dir0 * (octaveSteepness.x * cosP.x);
  totalDxy += dir1 * (octaveSteepness.y * cosP.y);
  totalDxy += dir2 * (octaveSteepness.z * cosP.z);
  totalDxy += dir3 * (octaveSteepness.w * cosP.w);

  if (addDz) {
    totalDz += octaveSteepness.x * sinP.x
             + octaveSteepness.y * sinP.y
             + octaveSteepness.z * sinP.z
             + octaveSteepness.w * sinP.w;
  }
}

vec3 calculateWaveForWind(vec2 sceneUv, float t, float motion01, vec2 windDirInput) {
    float sceneAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));

    // Travel basis: live wind (optionally) + authored heading offset (deg).
    // uWaveAppearanceRotRad is applied later to slopes in main() so crests/normals
    // can be corrected without changing this propagation axis.
    vec2 wRaw = safeNormalize2(windDirInput);
    if (length(wRaw) < 1e-5) wRaw = vec2(1.0, 0.0);
    vec2 wBase = (uLockWaveTravelToWind > 0.5) ? wRaw : vec2(1.0, 0.0);
    vec2 wTravel = rotate2D(wBase, uWaveDirOffsetRad);
    if (length(wTravel) < 1e-5) wTravel = vec2(1.0, 0.0);
    wTravel = normalize(wTravel);
    
    // 1. GLOBAL TURBULENCE (Optimized)
    float windStrength = clamp(uWindSpeed, 0.0, 1.5);
    float turbulenceAmt = mix(0.05, 0.3, windStrength); 

    // 2. DOMAIN COORDINATES
    vec2 uv = warpUv(sceneUv, motion01) * max(0.01, uWaveScale);
    uv = vec2(uv.x * sceneAspect, uv.y);

    // 3. LOCAL WIND ROTATION (Simplified)
    float windNoise = valueNoise2D(uv * 0.08 + vec2(t * 0.01, -t * 0.005));
    float localRotation = (windNoise - 0.5) * turbulenceAmt * 1.57;
    vec2 windBasis = rotate2D(wTravel, localRotation);

    // 4. SPATIAL PHASE JITTER (Simplified)
    float jitterField = valueNoise2D(uv * 0.2 + vec2(-t * 0.02, t * 0.01));

    float totalH = 0.0;
    vec2 totalDxy = vec2(0.0);
    float totalDz = 0.0;

    float globalSteepness = clamp(mix(0.3, 1.2, motion01), 0.1, 1.6);
    const float invPrimaryCount = 1.0 / 7.0;

    gerstnerAccum4(
      totalH, totalDxy, totalDz,
      uv, windBasis, t, jitterField,
      globalSteepness, windStrength,
      1.0, invPrimaryCount, 0.78,
      1.0, 4.0, 7.0,
      2.0,
      vec4(1.00, 0.52, 0.29, 0.14),
      vec4(0.00, 0.25, -0.32, 0.58),
      vec4(0.0, 1.0, 2.0, 3.0),
      vec4(1.0),
      true
    );
    gerstnerAccum4(
      totalH, totalDxy, totalDz,
      uv, windBasis, t, jitterField,
      globalSteepness, windStrength,
      1.0, invPrimaryCount, 0.78,
      1.0, 4.0, 7.0,
      2.0,
      vec4(0.08, 0.04, 0.02, 1.0),
      vec4(-0.71, 0.94, -1.15, 0.0),
      vec4(4.0, 5.0, 6.0, 0.0),
      vec4(1.0, 1.0, 1.0, 0.0),
      true
    );

    // 5. HIGH-FREQUENCY GRAINY NOISE BREAKUP
    // Add very fine, grainy noise to break up perfectly smooth surfaces
    vec2 grainUv = uv * 25.0 + vec2(t * 2.3, -t * 1.7);
    float grainNoise = valueNoise2D(grainUv) * 0.03;
    float grainNoise2 = valueNoise2D(grainUv * 1.73 + vec2(0.5, 0.3)) * 0.02;
    totalH += grainNoise + grainNoise2;

    // 6. SECONDARY GERSTNER LAYER (different angle, vec4 batch)
    vec2 windBasis2 = rotate2D(windBasis, 0.4);
    float totalH2 = 0.0;
    vec2 totalDxy2 = vec2(0.0);
    float totalDz2 = 0.0;
    gerstnerAccum4(
      totalH2, totalDxy2, totalDz2,
      uv, windBasis2, t, jitterField,
      globalSteepness, windStrength,
      0.8, 0.4 / 3.0, 0.7,
      0.5, 2.0, 3.0,
      1.5,
      vec4(0.14, 0.08, 0.04, 1.0),
      vec4(0.58, -0.71, 0.94, 0.0) * 0.6,
      vec4(0.0, 1.0, 2.0, 0.0),
      vec4(1.0, 1.0, 1.0, 0.0),
      false
    );

    // Blend secondary layer
    totalH += totalH2 * 0.3;
    totalDxy += totalDxy2 * 0.3;

    // 7. TROCHOIDAL PEAK SHARPENING
    // This ensures peaks are sharp and troughs are wide (less like a sine wave)
    float pinchMod = mix(0.7, 0.25, motion01);
    float pinch = max(pinchMod, 1.0 - abs(totalDz));
    vec2 slope = totalDxy / pinch;

    // 8. FINAL GRAINY BREAKUP ON SLOPES
    // Add high-frequency noise directly to slopes for specular breakup
    vec2 slopeGrainUv = uv * 40.0 + vec2(t * 3.1, -t * 2.1);
    vec2 slopeGrain = vec2(
        valueNoise2D(slopeGrainUv) - 0.5,
        valueNoise2D(slopeGrainUv + vec2(0.7, 0.3)) - 0.5
    ) * 0.015;
    slope += slopeGrain;

    return vec3(totalH, slope.x, slope.y);
}

vec3 calculateWave(vec2 sceneUv, float t, float motion01) {
  // Dual-spectrum wind direction blending: evaluate wavefield for the previous
  // and target wind directions and blend height + gradient.
  // This prevents low-frequency wave domain from "snapping" when wind rotates.
  float s = clamp(uWindDirBlend, 0.0, 1.0);
  if (s < 1e-4) {
    vec3 w = calculateWaveForWind(sceneUv, t, motion01, uPrevWindDir);
    return w;
  }
  if (s > 0.9999) {
    vec3 w = calculateWaveForWind(sceneUv, t, motion01, uTargetWindDir);
    return w;
  }

  vec3 a = calculateWaveForWind(sceneUv, t, motion01, uPrevWindDir);
  vec3 b = calculateWaveForWind(sceneUv, t, motion01, uTargetWindDir);
  vec2 blendWind = safeNormalize2(mix(uPrevWindDir, uTargetWindDir, s));
  return mix(a, b, s);
}

float waveHeight(vec2 sceneUv, float t, float motion01) { return calculateWave(sceneUv, t, motion01).x; }
vec2 waveGrad2D(vec2 sceneUv, float t, float motion01) { return calculateWave(sceneUv, t, motion01).yz; }

vec2 smoothFlow2D(vec2 sceneUv) {
  // NOTE: We intentionally do NOT use tWaterData.ba as a flow/normal field.
  // waveGradPre is already the analytical dH/dSceneUv from calculateWave.
  // Scale it gently; the caller applies uSpecNormalStrength * uSpecNormalScale.
  return vec2(0.0);
}

vec2 specWaveSlopeFromGrad(vec2 waveGradPre) {
  // waveGradPre is already the analytical dH/dSceneUv from calculateWave.
  // Scale it gently; the caller applies uSpecNormalStrength * uSpecNormalScale.
  return waveGradPre * 2.0;
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

// Continuous coverage/intensity from composited _Water.
// This preserves authored soft gradients directly (0..1) so every downstream
// effect can follow mask intensity instead of a thresholded cutoff.
float waterRawMaskIntensity(vec2 sceneUv01) {
  if (uHasWaterRawMask < 0.5) return 1.0;
  return clamp(texture2D(tWaterRawMask, sceneUv01).r, 0.0, 1.0);
}

// Legacy authoritative gate helper kept for compatibility; now intensity-driven.
float waterRawMaskAuthoritative(vec2 sceneUv01) {
  return waterRawMaskIntensity(sceneUv01);
}

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
  inside = max(clamp(uChromaticAberrationEdgeMin, 0.0, 1.0), inside);

  // Deadzone near shoreline edge (water-land transition) to prevent CA overlap
  // artifacts where mask transitions are sharp.
  float dz = max(0.0, uChromaticAberrationDeadzone);
  float dzSoft = max(1e-5, uChromaticAberrationDeadzoneSoftness);
  float edgeDelta = max(0.0, c - sdf01);
  float deadzoneMask = smoothstep(dz, dz + dzSoft, edgeDelta);
  return inside * deadzoneMask;
}

// ── Foam flecks (shader-based) ───────────────────────────────────────────
#ifdef USE_FOAM_FLECKS
float getShaderFlecks(vec2 sceneUv, float inside, float shore, float rainAmt, vec2 rainOffPx, float indoorWindMotion) {
  if (uFoamFlecksIntensity < 0.01) return 0.0;
  float sceneAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
  vec2 windF = uWindDir; float windLen = length(windF);
  windF = (windLen > 1e-6) ? (windF / windLen) : vec2(1.0, 0.0);
  vec2 windDir = vec2(windF.x, windF.y);
  vec2 windBasis = normalize(vec2(windDir.x * sceneAspect, windDir.y));
  float tWind = uWindTime * indoorWindMotion;
  float fleckSpeed = uShoreFoamSpeed * 2.5 + 0.15;
  vec2 fleckOffset = windBasis * (tWind * fleckSpeed);
  vec2 foamWindOffsetUv = uWindOffsetUv * indoorWindMotion;
  vec2 foamSceneUv = sceneUv - (foamWindOffsetUv * 0.5);
  vec2 fleckBasis = vec2(foamSceneUv.x * sceneAspect, foamSceneUv.y);
  fleckBasis += windBasis * 0.02;
  float fleckScale = clamp(uShoreFoamScale, 0.1, 6000.0);
  vec2 fleckUv1 = fleckBasis * fleckScale - fleckOffset * 400.0;
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
  float fleckMask = smoothstep(0.2, 0.6, rainAmt);
  float windFactor = 0.3 + 0.7 * clamp(uWindSpeed, 0.0, 1.0);
  return clamp(fleckDots * fleckMask * windFactor * clamp(uFoamFlecksIntensity, 0.0, 2.0), 0.0, 1.0);
}
#else
float getShaderFlecks(vec2 sceneUv, float inside, float shore, float rainAmt, vec2 rainOffPx, float indoorWindMotion) { return 0.0; }
#endif

// V1-accurate FBM: layered value noise with lacunarity/gain, returns [-1..1].
// Matches DistortionManager's fbm(p, octaves, lacunarity, gain) exactly.
float waterFbm(vec2 p, int octaves, float lacunarity, float gain) {
  float sum = 0.0;
  float amp = 1.0;
  float freq = 1.0;
  float maxAmp = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    // valueNoise returns [0..1]; remap to [-1..1] for signed accumulation.
    sum += (valueNoise(p * freq) * 2.0 - 1.0) * amp;
    maxAmp += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return sum / maxAmp;
}

// Caustics: ridged blend of two panned noise-map samples (replaces per-pixel FBM).
float causticsPattern(vec2 sceneUv, float t, float scale, float speed, float sharpness) {
  vec2 p = effectUv(sceneUv) * scale * NOISE_INV;
  float tt = t * speed;
  vec2 uv1 = fract(p + vec2(tt * 0.12, -tt * 0.09));
  vec2 uv2 = fract(p * 1.7 + vec2(-tt * 0.08, tt * 0.11));
  float n1 = texture2DLodEXT(tNoiseMap, uv1, 0.0).r;
  float n2 = texture2DLodEXT(tNoiseMap, uv2, 0.0).g;
  float nn = clamp(0.6 * n1 + 0.4 * n2, 0.0, 1.0);
  float ridge = 1.0 - abs(2.0 * nn - 1.0);
  float s = max(0.1, sharpness);
  float w = 0.18 / (1.0 + s * 0.65);
  return smoothstep(1.0 - w, 1.0, ridge);
}

` + getFragmentShaderPart2();
}

// Continuation of the fragment shader — split for file-size manageability.
function getFragmentShaderPart2() {
  return /* glsl */`

// ── Foam ─────────────────────────────────────────────────────────────────
// Floating foam data structure
struct FloatingFoamData {
  float amount;
  vec3 color;
  float opacity;
  float shadowStrength;
  float lightFactor;
  float darkScale;
};

// waveGradPre: pre-computed waveGrad2D result from main() to avoid redundant wave calculation.
void getFoamData(vec2 sceneUv, float shore, float inside, vec2 rainOffPx, vec2 waveGradPre, float sceneLuma, float darkness, float outdoorStrength, float indoorWindMotion, out float shoreFoamOut, out FloatingFoamData floatingOut) {
  vec2 foamWindOffsetUv = uWindOffsetUv * indoorWindMotion;
  vec2 foamSceneUv = sceneUv - (foamWindOffsetUv * 0.5);
  float sceneAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
  vec2 foamBasis = vec2(foamSceneUv.x * sceneAspect, foamSceneUv.y);
  vec2 windF = uWindDir; float windLen = length(windF);
  windF = (windLen > 1e-6) ? (windF / windLen) : vec2(1.0, 0.0);
  vec2 windDir = vec2(windF.x, windF.y);
  vec2 windBasis = normalize(vec2(windDir.x * sceneAspect, windDir.y));
  float tWind = uWindTime * indoorWindMotion;

  // Shoreline foam uses floating-style pattern generation with a shore band mask.
  float shoreFoamAmount = 0.0;
  
  #ifdef USE_SHORE_FOAM
  if (uShoreFoamEnabled > 0.5 && uShoreFoamStrength > 0.01) {
    float shoreTime = tWind + uShoreFoamTimeOffset;
    vec2 shoreUv = (foamBasis + uShoreFoamSeedOffset) * max(0.1, uShoreFoamScale);
    shoreUv -= windBasis * (shoreTime * uShoreFoamSpeed);
    
    float waveDistortStr = clamp(uShoreFoamWaveDistortionStrength, 0.0, 5.0);
    shoreUv += waveGradPre * waveDistortStr * 0.15;
    vec2 texel = 1.0 / max(uResolution, vec2(1.0));
    vec2 rainUv = rainOffPx * texel;
    vec2 rainBasis = vec2(rainUv.x * sceneAspect, rainUv.y);
    shoreUv += rainBasis * waveDistortStr * 0.1;
    
    if (uShoreFoamNoiseDistortionEnabled > 0.5 && uShoreFoamNoiseDistortionStrength > 0.01) {
      float noiseDistStr = clamp(uShoreFoamNoiseDistortionStrength, 0.0, 2.0);
      float noiseDistScale = max(0.1, uShoreFoamNoiseDistortionScale);
      float noiseDistSpeed = max(0.0, uShoreFoamNoiseDistortionSpeed);
      
      vec2 noiseUv = (foamBasis + uShoreFoamSeedOffset * 1.7) * noiseDistScale;
      float noiseTime = shoreTime * noiseDistSpeed;
      
      float sn1x = valueNoise(noiseUv + vec2(noiseTime, 0.0));
      float sn1y = valueNoise(noiseUv + vec2(0.0, noiseTime) + 11.3);
      float sn2x = valueNoise(noiseUv * 2.3 + vec2(noiseTime * 1.3, 0.0) + 23.7);
      float sn2y = valueNoise(noiseUv * 2.3 + vec2(0.0, noiseTime * 1.3) + 41.1);
      
      vec2 noiseOffset = vec2(
        (sn1x - 0.5) * 0.7 + (sn2x - 0.5) * 0.3,
        (sn1y - 0.5) * 0.7 + (sn2y - 0.5) * 0.3
      );
      
      shoreUv += noiseOffset * noiseDistStr;
    }
    
    vec2 shoreEvolUv = shoreUv;
    if (uShoreFoamEvolutionEnabled > 0.5 && uShoreFoamEvolutionAmount > 0.01) {
      float evolSpeed = max(0.0, uShoreFoamEvolutionSpeed);
      float evolScale = max(0.1, uShoreFoamEvolutionScale);
      float evolAmount = clamp(uShoreFoamEvolutionAmount, 0.0, 1.0);
      
      float evolTime = shoreTime * evolSpeed * 0.1;
      
      vec2 evolWarpUv = (foamBasis + uShoreFoamSeedOffset * 2.4) * evolScale;
      float sew1 = valueNoise(evolWarpUv + vec2(evolTime, 0.0));
      float sew2 = valueNoise(evolWarpUv + vec2(0.0, evolTime) + 19.3);
      float sew3 = valueNoise(evolWarpUv * 1.7 + vec2(evolTime * 0.7, evolTime * 0.7) + 37.7);
      
      vec2 evolWarp = vec2(
        (sew1 - 0.5) * 0.5 + (sew3 - 0.5) * 0.3,
        (sew2 - 0.5) * 0.5 + (sew3 - 0.5) * 0.3
      );
      
      shoreEvolUv = mix(shoreUv, shoreUv + evolWarp, evolAmount);
    }
    
    float shoreC1 = valueNoise(shoreEvolUv);
    float shoreC2 = valueNoise(shoreEvolUv * 2.1 + 5.2);
    float shoreBase = shoreC1 * 0.7 + shoreC2 * 0.3;
    float complexShore = shoreBase;
    
    if (uShoreFoamThicknessVariation > 0.01) {
      float thickScale = max(0.1, uShoreFoamThicknessScale);
      float sthick1 = valueNoise(shoreEvolUv * thickScale);
      float sthick2 = valueNoise(shoreEvolUv * thickScale * 2.3 + 5.7);
      float thickness = sthick1 * 0.6 + sthick2 * 0.4;
      thickness = mix(1.0, thickness, clamp(uShoreFoamThicknessVariation, 0.0, 1.0));
      complexShore *= thickness;
    }
    
    if (uShoreFoamFilamentsEnabled > 0.5 && uShoreFoamFilamentsStrength > 0.01) {
      float filScale = max(0.1, uShoreFoamFilamentsScale);
      float filLength = clamp(uShoreFoamFilamentsLength, 0.1, 4.0);
      float filWidth = clamp(uShoreFoamFilamentsWidth, 0.01, 0.5);
      
      vec2 sfilUv = shoreEvolUv * filScale;
      vec2 windStretch = windBasis * filLength;
      
      float filaments = 0.0;
      for (int i = 0; i < 3; i++) {
        float angle = float(i) * 0.523599;
        vec2 rotUv = vec2(
          sfilUv.x * cos(angle) - sfilUv.y * sin(angle),
          sfilUv.x * sin(angle) + sfilUv.y * cos(angle)
        );
        rotUv += windStretch * float(i) * 0.3;
        
        float fil = valueNoise(rotUv * vec2(1.0, filLength));
        fil = smoothstep(1.0 - filWidth, 1.0, fil);
        filaments = max(filaments, fil);
      }
      
      float filStr = clamp(uShoreFoamFilamentsStrength, 0.0, 1.0);
      complexShore = max(complexShore, filaments * filStr);
    }
    
    if (uShoreFoamEdgeDetail > 0.01) {
      float edgeScale = max(0.1, uShoreFoamEdgeDetailScale);
      float sedge1 = valueNoise(shoreEvolUv * edgeScale * 3.0);
      float sedge2 = valueNoise(shoreEvolUv * edgeScale * 7.0 + 11.9);
      float edgeNoise = sedge1 * 0.6 + sedge2 * 0.4;
      
      float edgeStr = clamp(uShoreFoamEdgeDetail, 0.0, 1.0);
      float edgeOffset = (edgeNoise - 0.5) * edgeStr * 0.3;
      complexShore = clamp(complexShore + edgeOffset, 0.0, 1.0);
    }
    
    // Distance remap: widen band (~2x reach) and apply a curve so foam
    // is strong very near shore but falls off quickly.
    float distWide = clamp(shore / max(0.01, uShoreFoamThreshold * 0.5), 0.0, 1.0);
    float fadeCurve = max(0.25, uShoreFoamFadeCurve);
    float distNormalized = pow(distWide, fadeCurve);
    float coreWidth = clamp(uShoreFoamCoreWidth, 0.01, 1.0);
    float coreFalloff = max(0.01, uShoreFoamCoreFalloff);
    float coreMask = smoothstep(coreWidth + coreFalloff, coreWidth, distNormalized);
    float tailWidth = clamp(uShoreFoamTailWidth, 0.01, 1.0);
    float tailFalloff = max(0.01, uShoreFoamTailFalloff);
    float tailMask = smoothstep(tailWidth + tailFalloff, 0.0, distNormalized);

    float shoreCoverage = clamp(uShoreFoamCoverage, 0.0, 1.0);
    float shoreClumps = smoothstep(1.0 - shoreCoverage, 1.0, complexShore);
    float shoreBand = clamp(max(coreMask, tailMask), 0.0, 1.0);
    shoreFoamAmount = clamp(shoreClumps * shoreBand, 0.0, 1.0);
    shoreFoamAmount *= inside * max(0.0, uShoreFoamStrength);
  }
  #endif

  vec2 clumpUv = foamBasis * max(0.1, uFloatingFoamScale);
  clumpUv -= windBasis * (tWind * (0.02 + uShoreFoamSpeed * 0.05));
  
  // Enhanced wave distortion (much stronger)
  if (uFloatingFoamWaveDistortion > 0.01) {
    float foamDistort = clamp(uFloatingFoamWaveDistortion, 0.0, 2.0);
    float waveDistortStr = clamp(uFloatingFoamWaveDistortionStrength, 0.0, 5.0);
    // Use pre-computed wave gradient from main() instead of recalculating
    clumpUv += waveGradPre * foamDistort * waveDistortStr * 0.2;
    vec2 texel = 1.0 / max(uResolution, vec2(1.0));
    vec2 rainUv = rainOffPx * texel;
    vec2 rainBasis = vec2(rainUv.x * sceneAspect, rainUv.y);
    float rainFoamScale = max(1.0, uFloatingFoamScale * 0.35);
    clumpUv += rainBasis * foamDistort * waveDistortStr * rainFoamScale * 0.15;
  }
  
  // Random noise distortion for organic movement
  if (uFloatingFoamNoiseDistortionEnabled > 0.5 && uFloatingFoamNoiseDistortionStrength > 0.01) {
    float noiseDistStr = clamp(uFloatingFoamNoiseDistortionStrength, 0.0, 2.0);
    float noiseDistScale = max(0.1, uFloatingFoamNoiseDistortionScale);
    float noiseDistSpeed = max(0.0, uFloatingFoamNoiseDistortionSpeed);
    
    vec2 noiseUv = foamBasis * noiseDistScale;
    float noiseTime = tWind * noiseDistSpeed;
    
    // Multi-octave curl noise for organic distortion
    float n1x = valueNoise(noiseUv + vec2(noiseTime, 0.0));
    float n1y = valueNoise(noiseUv + vec2(0.0, noiseTime) + 17.3);
    float n2x = valueNoise(noiseUv * 2.3 + vec2(noiseTime * 1.3, 0.0) + 31.7);
    float n2y = valueNoise(noiseUv * 2.3 + vec2(0.0, noiseTime * 1.3) + 53.1);
    
    vec2 noiseOffset = vec2(
      (n1x - 0.5) * 0.7 + (n2x - 0.5) * 0.3,
      (n1y - 0.5) * 0.7 + (n2y - 0.5) * 0.3
    );
    
    clumpUv += noiseOffset * noiseDistStr;
  }
  
  // Temporal evolution - slowly evolve shape over time
  vec2 evolutionUv = clumpUv;
  if (uFloatingFoamEvolutionEnabled > 0.5 && uFloatingFoamEvolutionAmount > 0.01) {
    float evolSpeed = max(0.0, uFloatingFoamEvolutionSpeed);
    float evolScale = max(0.1, uFloatingFoamEvolutionScale);
    float evolAmount = clamp(uFloatingFoamEvolutionAmount, 0.0, 1.0);
    
    float evolTime = tWind * evolSpeed * 0.1; // Slow evolution
    
    // Create evolving domain warp
    vec2 evolWarpUv = foamBasis * evolScale;
    float ew1 = valueNoise(evolWarpUv + vec2(evolTime, 0.0));
    float ew2 = valueNoise(evolWarpUv + vec2(0.0, evolTime) + 23.7);
    float ew3 = valueNoise(evolWarpUv * 1.7 + vec2(evolTime * 0.7, evolTime * 0.7) + 47.3);
    
    vec2 evolWarp = vec2(
      (ew1 - 0.5) * 0.5 + (ew3 - 0.5) * 0.3,
      (ew2 - 0.5) * 0.5 + (ew3 - 0.5) * 0.3
    );
    
    evolutionUv = mix(clumpUv, clumpUv + evolWarp, evolAmount);
  }
  // Base clumps (use evolution UV)
  float clumpC1 = valueNoise(evolutionUv);
  float clumpC2 = valueNoise(evolutionUv * 2.1 + 5.2);
  float c = clumpC1 * 0.7 + clumpC2 * 0.3;
  
  // Phase 2: Multi-layer complexity
  float complexFoam = c;
  int layerCount = int(clamp(uFloatingFoamLayerCount, 1.0, 4.0));
  
  // Add multiple octaves for thickness variation (use evolution UV)
  if (uFloatingFoamThicknessVariation > 0.01) {
    float thickScale = max(0.1, uFloatingFoamThicknessScale);
    float thick1 = valueNoise(evolutionUv * thickScale);
    float thick2 = valueNoise(evolutionUv * thickScale * 2.3 + 7.1);
    float thickness = thick1 * 0.6 + thick2 * 0.4;
    thickness = mix(1.0, thickness, clamp(uFloatingFoamThicknessVariation, 0.0, 1.0));
    complexFoam *= thickness;
  }
  
  // Add filaments and tendrils (Phase 2)
  if (uFloatingFoamFilamentsEnabled > 0.5 && uFloatingFoamFilamentsStrength > 0.01) {
    float filScale = max(0.1, uFloatingFoamFilamentsScale);
    float filLength = clamp(uFloatingFoamFilamentsLength, 0.1, 4.0);
    float filWidth = clamp(uFloatingFoamFilamentsWidth, 0.01, 0.5);
    
    // Create elongated filaments using directional noise (use evolution UV)
    vec2 filUv = evolutionUv * filScale;
    vec2 windStretch = windBasis * filLength;
    
    // Multiple filament layers at different angles
    float filaments = 0.0;
    for (int i = 0; i < 3; i++) {
      float angle = float(i) * 0.523599; // ~30 degrees apart
      vec2 rotUv = vec2(
        filUv.x * cos(angle) - filUv.y * sin(angle),
        filUv.x * sin(angle) + filUv.y * cos(angle)
      );
      rotUv += windStretch * float(i) * 0.3;
      
      // Elongated noise for filaments
      float fil = valueNoise(rotUv * vec2(1.0, filLength));
      fil = smoothstep(1.0 - filWidth, 1.0, fil);
      filaments = max(filaments, fil);
    }
    
    float filStr = clamp(uFloatingFoamFilamentsStrength, 0.0, 1.0);
    complexFoam = max(complexFoam, filaments * filStr);
  }
  
  // Add edge detail and breakup (Phase 2, use evolution UV)
  if (uFloatingFoamEdgeDetail > 0.01) {
    float edgeScale = max(0.1, uFloatingFoamEdgeDetailScale);
    float edge1 = valueNoise(evolutionUv * edgeScale * 3.0);
    float edge2 = valueNoise(evolutionUv * edgeScale * 7.0 + 13.7);
    float edgeNoise = edge1 * 0.6 + edge2 * 0.4;
    
    // Apply edge detail as erosion/expansion
    float edgeStr = clamp(uFloatingFoamEdgeDetail, 0.0, 1.0);
    float edgeOffset = (edgeNoise - 0.5) * edgeStr * 0.3;
    complexFoam = clamp(complexFoam + edgeOffset, 0.0, 1.0);
  }
  
  float clumps = smoothstep(1.0 - clamp(uFloatingFoamCoverage, 0.0, 1.0), 1.0, complexFoam);
  float deepMask = smoothstep(0.15, 0.65, 1.0 - shore);
  float floatingFoamAmount = clumps * inside * max(0.0, uFloatingFoamStrength) * deepMask;
  float raw01 = (uHasWaterRawMask > 0.5) ? texture2D(tWaterRawMask, sceneUv).r : inside;
  float rawMask = smoothstep(0.70, 0.95, clamp(raw01, 0.0, 1.0));
  float floatingFoamMaskAmount = clumps * inside * max(0.0, uFloatingFoamStrength) * rawMask;
  // Shore foam processing
  shoreFoamOut = clamp(shoreFoamAmount, 0.0, 1.0);

  // Floating foam processing (NEW - Phase 1)
  float floatingBase = clamp(floatingFoamAmount + floatingFoamMaskAmount, 0.0, 1.0);
  
  // Apply color variation noise
  vec2 colorVarUv = clumpUv * 0.3;
  float colorVar = valueNoise(colorVarUv) * 2.0 - 1.0;
  colorVar *= clamp(uFloatingFoamColorVariation, 0.0, 1.0);
  
  // Base color with variation
  vec3 baseColor = clamp(uFloatingFoamColor, vec3(0.0), vec3(1.0));
  vec3 tintColor = clamp(uFloatingFoamTint, vec3(0.0), vec3(1.0));
  float tintStr = clamp(uFloatingFoamTintStrength, 0.0, 1.0);
  vec3 foamColor = mix(baseColor, tintColor, tintStr);
  
  // Apply color variation (subtle hue shift)
  foamColor = foamColor * (1.0 + colorVar * 0.15);
  
  // Brightness/Contrast/Gamma adjustments (color-only; do not alter coverage mask)
  float foamBright = clamp(uFloatingFoamBrightness, 0.0, 1.25);
  float foamContrast = max(0.0, uFloatingFoamContrast);
  float foamGamma = max(0.01, uFloatingFoamGamma);

  foamColor = foamColor * foamBright;
  foamColor = ((foamColor - 0.5) * foamContrast) + 0.5;
  foamColor = pow(max(foamColor, vec3(0.0)), vec3(foamGamma));
  foamColor = clamp(foamColor, vec3(0.0), vec3(0.92));
  
  // Lighting calculation (applied AFTER opacity blending for proper darkness)
  // Keep darkness response active even when explicit foam lighting is disabled;
  // otherwise foam can read as self-illuminated at night.
  float lightFactor = 1.0;
  float darkResponse = clamp(uFloatingFoamDarknessResponse, 0.0, 1.0);
  // Scene darkness convention: 1 = darkest. Keep response linear with darkness.
  float darkScale = mix(1.0, 0.02, darkness * darkResponse);
  if (uFloatingFoamLightingEnabled > 0.5) {
    float ambient = clamp(uFloatingFoamAmbientLight, 0.0, 1.0);
    float sceneInfluence = clamp(uFloatingFoamSceneLightInfluence, 0.0, 1.0);

    // Scene lighting contribution with a small bounce floor so ambient=0 does
    // not crush foam fully black against nearby lit water.
    float sceneLit = smoothstep(0.02, 0.35, sceneLuma);
    float sceneBounceFloor = clamp(0.08 + sceneLuma * 0.32, 0.0, 0.32);
    sceneLit = max(sceneLit, sceneBounceFloor);

    // Ambient should still be artist-controllable, but avoid dark-zone glow.
    // Use a soft light gate (never fully zero) plus night attenuation.
    float ambientLitGate = mix(0.20, 1.0, smoothstep(0.06, 0.55, sceneLit));
    float ambientNightAtten = mix(1.0, 0.10, darkness);
    // Ambient only lifts foam where _Outdoors is non-black.
    float outdoorsAmbientGate = 1.0;
    if (uHasOutdoorsMask > 0.5) {
      outdoorsAmbientGate = smoothstep(0.01, 0.08, clamp(outdoorStrength, 0.0, 1.0));
    }
    float ambientEff = ambient * ambientLitGate * ambientNightAtten * outdoorsAmbientGate;

    // Base follows local scene light; ambient adds fill biased by scene influence.
    float litBase = sceneLit;
    lightFactor = litBase + ambientEff * (0.55 + 0.45 * sceneInfluence);
    lightFactor = clamp(lightFactor, 0.0, 1.0);
  }
  
  // Opacity control
  float opacity = clamp(uFloatingFoamOpacity, 0.0, 1.0);
  
  // Shadow strength calculation
  float shadowStr = 0.0;
  if (uFloatingFoamShadowEnabled > 0.5) {
    float shadowBase = clamp(uFloatingFoamShadowStrength, 0.0, 1.0);
    float shadowDepth = clamp(uFloatingFoamShadowDepth, 0.0, 1.0);
    float shadowSoft = clamp(uFloatingFoamShadowSoftness, 0.0, 1.0);
    
    // Shadow intensity based on foam density
    float densityFactor = smoothstep(0.1, 0.6, floatingBase);
    shadowStr = shadowBase * densityFactor * shadowDepth;
    
    // Soften shadow edges
    shadowStr *= mix(1.0, floatingBase, shadowSoft);
  }
  
  floatingOut.amount = floatingBase;
  // Match shore foam: bake scene-luminance response into albedo (lightFactor was computed but unused).
  floatingOut.color = foamColor * lightFactor;
  floatingOut.opacity = opacity;
  floatingOut.shadowStrength = shadowStr;
  floatingOut.lightFactor = lightFactor;
  floatingOut.darkScale = darkScale;
}

// ── Murk (subsurface silt/algae) ─────────────────────────────────────────
vec3 applyMurk(vec2 sceneUv, float t, float inside, float shore, float outdoorStrength, float indoorWindMotion, vec3 baseColor, out float murkFactorOut) {
  murkFactorOut = 0.0;
  if (uMurkEnabled < 0.5) return baseColor;
  #ifndef USE_MURK
  return baseColor;
  #else
  float murkIntensity = clamp(uMurkIntensity, 0.0, 2.0);
  if (murkIntensity <= 1e-6) return baseColor;
  float murkScale = max(0.1, uMurkScale);
  float murkSpeed = max(0.0, uMurkSpeed);
  float sceneAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
  // Offset by a large constant so the FBM domain centre sits far from the
  // scene UV [0,1] boundary. Without this offset the low-frequency FBM bands
  // have a visible seam/edge at the scene extents (tiling artifact).
  vec2 murkBasis = vec2(sceneUv.x * sceneAspect, sceneUv.y) + vec2(47.3, 31.7);
  vec2 windF = uWindDir; float windLen = length(windF);
  windF = (windLen > 1e-6) ? (windF / windLen) : vec2(1.0, 0.0);
  vec2 windBasis = normalize(vec2(windF.x * sceneAspect, windF.y));
  vec2 windPerp = vec2(-windBasis.y, windBasis.x);
  float tWind = uWindTime * indoorWindMotion;
  vec2 cloudUv = murkBasis * murkScale;
  vec2 cloudDrift = windBasis * (tWind * murkSpeed * 0.22);
  vec2 cloudWarp = curlNoise2D((cloudUv - cloudDrift) * 0.45) * 0.45;
  float cloudA = valueNoise2D(cloudUv - cloudDrift + cloudWarp);
  float cloudB = valueNoise2D(cloudUv * 0.57 - cloudDrift * 0.73 + windPerp * 0.35 + vec2(17.3, 9.1) - cloudWarp * 0.35);
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
  // Same domain offset as murkBasis to keep grain seamlessly continuous
  // across the scene UV [0,1] extents.
  vec2 grainBasis = vec2(sceneUv.x * sceneAspect, sceneUv.y) + vec2(47.3, 31.7);
  float grainPhase = tWind * (murkSpeed + grainSpeed);
  vec2 grainDrift = windBasis * (grainPhase * 1.8);
  // Keep the fine-grain evolution locked to the wind basis so the suspended
  // silt motion always aligns with wind direction.
  vec2 grainEvo = windBasis * (tWind * grainSpeed * 0.95) + windPerp * (tWind * grainSpeed * 0.22);
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
  
  // Apply ShadowManagerV2 combined shadow darkening to murk
  float shadowDarken = 1.0;
  if (uMurkShadowEnabled > 0.5 && uHasCombinedShadow > 0.5) {
    float shadowLit = texture2D(tCombinedShadow, vUv).r;
    float shadowOcclusion = clamp(1.0 - shadowLit, 0.0, 1.0);
    float shadowStrength = clamp(uMurkShadowStrength, 0.0, 2.0);
    shadowDarken = 1.0 - (shadowOcclusion * shadowStrength);
  }
  
  vec3 muckyCol = mix(murkColor * 0.6, murkColor, cloud);
  muckyCol *= murkDarkScale * localLight * shadowDarken;
  muckyCol += grain * 0.35 * murkDarkScale * localLight * shadowDarken;
  return mix(baseColor, muckyCol, murkFactor);
  #endif
}

// Upper-floor screen mask: 5-tap cross filter + shared smooth band. The RT is a
// union of axis-aligned tile quads; without filtering + soft transition the
// silhouette shows stair-stepping (often mistaken for water SDF issues).
float waterOccluderAlphaSoft(vec2 screenUv) {
  if (uHasWaterOccluderAlpha < 0.5) return 0.0;
  vec2 px = 1.0 / max(uResolution, vec2(1.0));
  float c = texture2D(tWaterOccluderAlpha, screenUv).a;
  float n = texture2D(tWaterOccluderAlpha, screenUv + vec2(0.0, px.y)).a;
  float s = texture2D(tWaterOccluderAlpha, screenUv - vec2(0.0, px.y)).a;
  float e = texture2D(tWaterOccluderAlpha, screenUv + vec2(px.x, 0.0)).a;
  float w = texture2D(tWaterOccluderAlpha, screenUv - vec2(px.x, 0.0)).a;
  // Center-heavy blend: previous 0.52/0.12 cross-filter dilated occlusion into
  // authored alpha holes (bridge gaps) and clipped ground water from above.
  return 0.72 * c + 0.07 * (n + s + e + w);
}

// Non-_Water bus tiles on the water-source floor (cached deck mask).
float waterRoofBlockOcc(vec2 screenUv) {
  if (uHasOverheadRoofBlock < 0.5) return 0.0;
  return smoothstep(0.34, 0.66, texture2D(tOverheadRoofBlock, screenUv).a);
}

// Deck mask × source slice scene alpha (screen-space punch over river UV).
float waterSourceScreenOcc(vec2 screenUv) {
  float deck = waterRoofBlockOcc(screenUv);
  if (deck < 0.001) return 0.0;
  if (uHasSliceAlpha > 0.5) {
    return deck * smoothstep(0.10, 0.88, texture2D(tSliceAlpha, screenUv).a);
  }
  return deck;
}

// Post-merge background transmittance mask in screen UV.
// 1.0 = no upper/background coverage between water source floor and viewer.
// 0.0 = fully blocked by stacked background albedo above the water source.
float waterBgTransmittanceAt(vec2 screenUv) {
  if (uHasWaterBgAlphaMask < 0.5) return 1.0;
  return clamp(texture2D(tWaterBgAlphaMask, screenUv).r, 0.0, 1.0);
}

// Safe sampling for refraction/distortion taps.
// Prevents pulling pixels from:
//   - Occluded (upper-floor) regions
//   - Outside the water body near shore/edges
float refractTapValid(vec2 screenUv) {
  float vOcc = 1.0;
  // Occluder gating in screen UV.
  if (uHasWaterOccluderAlpha > 0.5) {
    float occ = waterOccluderAlphaSoft(screenUv);
    vOcc = 1.0 - smoothstep(0.34, 0.66, occ);
  }
  float vRoof = 1.0 - waterSourceScreenOcc(screenUv);
  float vBg = waterBgTransmittanceAt(screenUv);

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
    insideS *= waterRawMaskIntensity(suv);
    return insideS * vOcc * vRoof * vBg;
  }

  return vOcc * vRoof * vBg;
}

// Softly reject distortion taps as they approach/leak past screen borders.
// This prevents hard UV pinning artifacts in map edges/corners when refraction
// offsets push outside the valid scene framebuffer area.
float screenUvEdgeFade(vec2 screenUv) {
  vec2 px = 1.0 / max(uResolution, vec2(1.0));
  float soft = max(2.0 * max(px.x, px.y), 1e-5);
  vec2 edge = min(screenUv, vec2(1.0) - screenUv);
  float minEdge = min(edge.x, edge.y);
  return smoothstep(0.0, soft, minEdge);
}

vec4 sampleRefractedSafe(vec2 screenUv, vec4 fallback) {
  return (refractTapValid(screenUv) > 0.5) ? texture2D(tDiffuse, screenUv) : fallback;
}

// ── Specular Highlights Function ─────────────────────────────────────────────
vec3 calculateSpecularHighlights(
  vec2 sceneUv, float inside, vec3 N, vec3 V, vec3 L, float NoL, float NoV,
  float distInside, float edgeStability, float shore, vec2 waveGrad,
  vec2 rainOffPx, float indoorWindMotion, float outdoorStrength, float sceneLuma,
  float darkness, float combinedShadow, float structuralShadow
) {
  // Use tighter roughness range for sharper highlights
  float p01 = clamp((uSpecHighlightsPower - 1.0) / 127.0, 0.0, 1.0);
  float rMin = clamp(uSpecHighlightsRoughnessMin, 0.001, 1.0);
  float rMax = clamp(uSpecHighlightsRoughnessMax, 0.001, 1.0);
  float rough = mix(rMax, rMin, p01);

  // Enhanced normal for highlights (stronger response to waves)
  vec2 waveSlope = specWaveSlopeFromGrad(waveGrad) * clamp(uSpecHighlightsNormalStrength, 0.0, 10.0);
  waveSlope *= clamp(uSpecHighlightsNormalScale, 0.0, 1.0);
  vec3 waveNormal = normalize(vec3(-waveSlope.x, -waveSlope.y, 1.0));
  vec3 Nhl = normalize(mix(N, waveNormal, clamp(uSpecHighlightsNormalStrength, 0.0, 1.0)));

  // GGX calculation for highlights (same sun-angle toggle as main specular)
  vec3 Lhl = (uSpecUseSunAngle > 0.5) ? normalize(uSpecHighlightsSunDir) : vec3(0.0, 0.0, 1.0);
  vec3 Hhl = normalize(Lhl + V);
  float NoLhl = clamp(dot(Nhl, Lhl), 0.0, 1.0);
  float NoVhl = clamp(dot(Nhl, V), 0.0, 1.0);
  float NoHhl = clamp(dot(Nhl, Hhl), 0.0, 1.0);
  float VoHhl = clamp(dot(V, Hhl), 0.0, 1.0);

  float alpha = max(0.001, rough * rough);
  float alpha2 = alpha * alpha;

  // GGX Normal Distribution Function
  float denom = NoHhl * NoHhl * (alpha2 - 1.0) + 1.0;
  float D = alpha2 / (3.14159265 * denom * denom);

  // Geometry function
  float k = rough * 0.5;
  float G1V = NoVhl / max(1e-6, NoVhl * (1.0 - k) + k);
  float G1L = NoLhl / max(1e-6, NoLhl * (1.0 - k) + k);
  float G = G1V * G1L;

  // Fresnel
  float f0 = clamp(uSpecHighlightsF0, 0.0, 1.0);
  vec3 F0 = vec3(f0);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - VoHhl, 5.0);

  // Specular calculation
  vec3 specHighlights = (((D * G) * F) / max(1e-6, 4.0 * NoVhl * NoLhl)) * NoLhl;

  // Apply sun elevation falloff for highlights
  if (uSpecUseSunAngle > 0.5 && uSpecSunElevationFalloffEnabled > 0.5) {
    float elevation = uSpecHighlightsSunElevationDeg;
    float elevationFactor = 1.0;
    if (elevation < uSpecSunElevationFalloffStart) {
      elevationFactor = smoothstep(uSpecSunElevationFalloffEnd, uSpecSunElevationFalloffStart, elevation);
    }
    specHighlights *= elevationFactor;
  }

  // Shadow suppression for highlights
  if (uCloudShadowEnabled > 0.5 && uHasCloudShadow > 0.5) {
    float cloudShadow = texture2D(tCloudShadow, sceneUv).r;
    float kStrength = clamp(uCloudShadowSpecularKill, 0.0, 1.0);
    float kCurve = max(0.01, uCloudShadowSpecularCurve);
    float litPow = pow(clamp(1.0 - combinedShadow, 0.0, 1.0), kCurve);
    specHighlights *= mix(1.0, litPow, kStrength);
  }
  specHighlights *= (1.0 - 0.75 * structuralShadow);

  // Masking for highlights (stricter than main specular)
  if (uSpecHighlightsEnabled > 0.5) {
    float specMask = pow(clamp(distInside, 0.0, 1.0), clamp(uSpecHighlightsMaskGamma, 0.05, 12.0));
    specHighlights *= specMask;
    specHighlights *= edgeStability;
    float shoreBias = mix(1.0, shore, clamp(uSpecHighlightsShoreBias, 0.0, 1.0));
    specHighlights *= shoreBias;
  }

  // Strength and intensity for highlights
  float strength = clamp(uSpecHighlightsStrength, 0.0, 250.0) / 50.0;
  specHighlights *= strength * clamp(uSpecHighlightsSunIntensity, 0.0, 10.0);

  // Indoor/outdoor modulation for highlights
  if (uHasOutdoorsMask > 0.5) {
    specHighlights *= mix(0.15, 1.0, clamp(outdoorStrength, 0.0, 1.0));
  }
  specHighlights *= mix(1.0, 0.1, clamp(uSceneDarkness, 0.0, 1.0));

  // Sky tint for highlights
  vec3 skyCol = clamp(uSkyColor, vec3(0.0), vec3(1.0));
  float skyI = clamp(uSkyIntensity, 0.0, 1.0);
  float skySpecI = mix(0.08, 1.0, skyI);
  vec3 tint = mix(vec3(1.0), skyCol, clamp(uSpecHighlightsSkyTint, 0.0, 1.0));
  vec3 specHighlightsCol = specHighlights * tint * skySpecI;

  // Clamping for highlights
  float sClamp = max(0.0, uSpecHighlightsClamp);
  if (sClamp > 0.0) {
    specHighlightsCol = min(specHighlightsCol, vec3(sClamp));
  }

  return specHighlightsCol;
}

// ── Main ─────────────────────────────────────────────────────────────────
void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  // Mode 3 only at top: fullscreen yellow (water gate skipped alarm).
  // Modes 1–2 are handled after per-pixel inside exists — uHasWaterData is a
  // uniform (true for the whole quad whenever any water exists), so gating on
  // it alone still tints every pixel cyan/magenta.
  if (uDebugWaterPassTint > 2.5) {
    MSA_BLOOM_RT_ZERO;
    gl_FragColor = vec4(1.0, 1.0, 0.0, 1.0);
    return;
  }
  float isEnabled = step(0.5, uWaterEnabled) * step(0.5, uHasWaterData);
  if (isEnabled < 0.5) { MSA_BLOOM_RT_ZERO; gl_FragColor = base; return; }
  // Occluder mask: upper-floor tiles rendered to screen-space RT (tile union →
  // stair-step edges). Soft-filter + blend instead of a hard 0.5 test.
  float occluderBlend = 0.0;
  if (uHasWaterOccluderAlpha > 0.5) {
    float occ = waterOccluderAlphaSoft(vUv);
    occluderBlend = smoothstep(0.36, 0.64, occ);
  }
  if (occluderBlend > 0.995) {
    MSA_BLOOM_RT_ZERO;
    gl_FragColor = base;
    return;
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
        MSA_BLOOM_RT_ZERO;
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
    if (inScene < 0.5) { MSA_BLOOM_RT_ZERO; gl_FragColor = base; return; }
    sceneUv = clamp(sceneUv, vec2(0.0), vec2(1.0));
  }

  vec4 wd = texture2D(tWaterData, sceneUv);
  float sdf01 = wd.r;
  float exposure01 = wd.g;
  float rawAuth = waterRawMaskIntensity(sceneUv);
  // Hybrid: raw mask controls authoritative water coverage, SDF/exposure still
  // drive shoreline/depth-dependent shaping for distortion/specular/foam.
  float inside = rawAuth;
  float shore = clamp(exposure01 * rawAuth, 0.0, 1.0);
  float distInside = (uUseSdfMask > 0.5)
    ? distortionInsideFromSdf(sdf01)
    : inside;
  distInside *= rawAuth;
  if (uHasWaterBgAlphaMask > 0.5) {
    float m = texture2D(tWaterBgAlphaMask, vUv).r;
    inside *= m;
    distInside *= m;
  }
  // Water-source floor: cached deck mask × live slice alpha, gated by raw water.
  {
    float srcOcc = waterSourceScreenOcc(vUv);
    float sourceOverheadGate = srcOcc * smoothstep(0.02, 0.08, rawAuth);
    inside *= (1.0 - sourceOverheadGate);
    distInside *= (1.0 - sourceOverheadGate);
  }
  // Borrowed lower-floor water on this slice: suppress wherever **this** slice's
  // bus levelSceneRT is opaque (tiles / deck over river holes).
  // Sample tSliceAlpha at **vUv** like tDiffuse / base — it is the same
  // camera-rendered RT in screen projection. tWaterData stays in **sceneUv**
  // (map 0–1 texture space); mixing the two UV spaces caused a sliding blank
  // that followed the camera.
  // Do NOT require uHasWaterOccluderAlpha: that mask is built only from *higher*
  // floors, so middle slices never got slice punch when the roof mask was weak.
  //
  // Do not punch native water with slice alpha: even a narrow smoothstep(0.93…)
  // on levelSceneRT can be ~1 across most pixels (opaque bg / PM), which removed
  // all water on every floor. Borrowed-only path below is the supported case.
  if (uCrossSliceWaterData > 0.5) {
    float sheetOpaque = 0.0;
    if (uHasSliceAlpha > 0.5) {
      float sliceA = texture2D(tSliceAlpha, vUv).a;
      // Softer ramp than 0.05–0.96: mid-alpha is sensitive to filtering / PM RTs and
      // was causing “swimming” at punch boundaries on borrowed middle-floor water.
      sheetOpaque = smoothstep(0.10, 0.88, sliceA);
    } else if (uHasWaterOccluderAlpha > 0.5) {
      sheetOpaque = smoothstep(0.10, 0.88, base.a);
    }
    inside *= (1.0 - sheetOpaque);
    distInside *= (1.0 - sheetOpaque);
  }
  // Occluder plumbing debug: 1 = magenta (RT bound), 2 = cyan (no RT). Uses
  // per-pixel inside from tWaterData — not the uHasWaterData uniform.
  // Mix toward base where the occluder mask is strong so debug matches culling.
  if (uDebugWaterPassTint > 0.5 && uDebugWaterPassTint <= 2.5) {
    MSA_BLOOM_RT_ZERO;
    if (inside > 0.01) {
      vec3 dbg = (uDebugWaterPassTint > 1.5) ? vec3(0.0, 1.0, 1.0) : vec3(1.0, 0.0, 1.0);
      float occVis = (uHasWaterOccluderAlpha > 0.5) ? waterOccluderAlphaSoft(vUv) : 0.0;
      float occBlend = smoothstep(0.36, 0.64, occVis);
      vec3 rgb = mix(dbg, base.rgb, occBlend);
      gl_FragColor = vec4(rgb, 1.0);
    } else {
      gl_FragColor = base;
    }
    return;
  }
  // Extra stability fade near the binary water-mask transition.
  // Prevents bright specular/caustics edge flicker when the water boundary is thin.
  float edgeStability = smoothstep(0.12, 0.42, clamp(distInside, 0.0, 1.0));
  float distMask = distInside * shoreFactor(shore);
  float waveMotion01 = clamp(uWaveMotion01, 0.0, 1.0);
  float outdoorStrength = 1.0;
  if (uHasOutdoorsMask > 0.5) {
    outdoorStrength = sampleOutdoorsMask(worldSceneUv);
  }
  // Same factor for foam/murk drift and Gerstner phase (see waterIndoorWindMotion01).
  float waveShelter01 = waterIndoorWindMotion01(sceneUv);
  float indoorWindMotion = waveShelter01;

  // Placeholder for sky reflection (will be calculated later)
  vec3 skyReflection = vec3(0.0);

  // Debug views
  if (uDebugView > 0.5) {
    float d = floor(uDebugView + 0.5);
    if (d < 1.5) {
      MSA_BLOOM_RT_ZERO;
      if (uHasWaterRawMask < 0.5) gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0);
      else gl_FragColor = vec4(vec3(texture2D(tWaterRawMask, sceneUv).r), 1.0);
      return;
    }
    if (d < 2.5) { MSA_BLOOM_RT_ZERO; gl_FragColor = vec4(vec3(inside), 1.0); return; }
    if (d < 3.5) { MSA_BLOOM_RT_ZERO; gl_FragColor = vec4(vec3(sdf01), 1.0); return; }
    if (d < 4.5) { MSA_BLOOM_RT_ZERO; gl_FragColor = vec4(vec3(exposure01), 1.0); return; }
    if (d < 5.5) { MSA_BLOOM_RT_ZERO; vec2 nn = smoothFlow2D(sceneUv); gl_FragColor = vec4(nn * 0.5 + 0.5, 0.0, 1.0); return; }
    if (d < 6.5) {
      MSA_BLOOM_RT_ZERO;
      float wv = 0.5 + 0.5 * waveHeight(sceneUv, uWaveTime * waveShelter01, waveMotion01);
      gl_FragColor = vec4(vec3(wv), 1.0);
      return;
    }
    if (d < 7.5) { MSA_BLOOM_RT_ZERO; gl_FragColor = vec4(vec3(distMask), 1.0); return; }
    if (d < 8.5) {
      MSA_BLOOM_RT_ZERO;
      float occ = (uHasWaterOccluderAlpha > 0.5) ? waterOccluderAlphaSoft(vUv) : 0.0;
      gl_FragColor = vec4(vec3(occ), 1.0);
      return;
    }
    if (d < 9.5) {
      MSA_BLOOM_RT_ZERO;
      gl_FragColor = vec4(skyReflection, base.a);
      return;
    }
    MSA_BLOOM_RT_ZERO;
    gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); return;
  }

  if (inside < 0.01) { MSA_BLOOM_RT_ZERO; gl_FragColor = base; return; }

  // Animated distortion (single calculateWave: reuse height + gradient).
  // waveShelter01: per-pixel _Outdoors shelter (computed above with indoorWindMotion).
  float waveTimePix = uWaveTime * waveShelter01;
  vec3 waveState = calculateWave(sceneUv, waveTimePix, waveMotion01);
  vec2 waveGrad = waveState.yz;
  float waveH = waveState.x;
  // Rotate analytical slopes for refraction/specular without changing travel axis
  // (Gerstner dirs use wind + waveDirOffsetDeg; this is purely visual correction).
  waveGrad = rotate2D(waveGrad, uWaveAppearanceRotRad);
  vec2 flowN = smoothFlow2D(sceneUv);
  
  // Amplify the base wave strength here. Because we fixed Gerstner self-intersections,
  // the gradients are now mathematically bounded, so the old strength multipliers
  // result in gradients that are too weak for impressive refraction.
  float waveStrength = uWaveStrength * 2.5;
  
  if (uWaveIndoorDampingEnabled > 0.5) {
    float dampStrength = clamp(uWaveIndoorDampingStrength, 0.0, 1.0);
    float minFactor = clamp(uWaveIndoorMinFactor, 0.0, 1.0);
    float waveMult = mix(1.0, mix(minFactor, 1.0, outdoorStrength), dampStrength);
    waveStrength *= waveMult;
  }

  // Crest/trough + micro-hash modulate refraction (height is already computed).
  float hn = clamp(waveH * 3.1, -1.0, 1.0);
  float crestMod = smoothstep(-0.4, 0.62, 0.5 + 0.5 * hn);
  float sceneAspectW = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
  vec2 basisW = vec2(sceneUv.x * sceneAspectW, sceneUv.y);
  float wTurb = uWindTime * waveShelter01;
  float ampHash = 0.90 + 0.14 * ((valueNoise2D(basisW * 8.1 + vec2(-wTurb * 0.041, wTurb * 0.033)) - 0.5) * 2.0);
  float waveStrengthEff = waveStrength * mix(0.93, 1.09, crestMod) * clamp(ampHash, 0.82, 1.12);

  // Perpendicular noise warps fronts so Gerstner sums read less like stripes.
  float lateralChaos = (valueNoise2D(basisW * 5.0 + vec2(wTurb * 0.063, -wTurb * 0.051)) - 0.5) * 2.0;
  vec2 perpG = vec2(-waveGrad.y, waveGrad.x);
  float latWt = 0.15 * (0.42 + 0.58 * crestMod);
  
  // Apply a mild power curve to distortionPx to boost strong distortion while
  // keeping low settings subtle.
  float distortionPx = uDistortionStrengthPx * 1.5;
  
  vec2 combinedVec = waveGrad * waveStrengthEff + perpG * (lateralChaos * latWt) + flowN * 0.35;
  // Less aggressive normalization so strong waves can actually warp the UV significantly
  combinedVec = combinedVec / (1.0 + 0.35 * length(combinedVec));
  float m = length(combinedVec);
  float dirMask = smoothstep(0.01, 0.06, m);
  vec2 combinedN = (m > 1e-6) ? (combinedVec / m) * dirMask : vec2(0.0);
  
  // Much sharper amplitude ramp, peaking faster to ensure strong visual warping
  float amp = smoothstep(0.0, 0.15, m); 
  amp = pow(amp, 0.85); // give it a slightly fuller body

  vec2 texel = 1.0 / max(uResolution, vec2(1.0));
  float px = clamp(distortionPx, 0.0, 128.0); // increased cap
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
  if (uCrossSliceWaterData > 0.5) {
    offsetUvRaw *= 0.14;
  }
  vec2 offsetUv = offsetUvRaw * distMask;
  vec2 uv1Candidate = vUv + offsetUv;
  vec2 uv1 = clamp(uv1Candidate, vec2(0.001), vec2(0.999));

  // If the distorted center UV would sample outside the water body or into an
  // occluder, smoothly pin the distortion to zero at this pixel.
  float v1 = refractTapValid(uv1Candidate);
  float edgeFade = screenUvEdgeFade(uv1Candidate);
  offsetUv *= v1;
  offsetUv *= edgeFade;
  uv1 = clamp(vUv + offsetUv, vec2(0.001), vec2(0.999));
  vec4 centerSample = texture2D(tDiffuse, uv1);

  #ifdef USE_WATER_REFRACTION_MULTITAP
  // Two-sample kernel along distortion: center (uv1) + outer — one fewer tap/valid than 3-point.
  vec2 uvO = clamp(vUv + offsetUv * 1.18, vec2(0.001), vec2(0.999));
  float vo = refractTapValid(uvO);
  vec4 tapO = (vo > 0.5) ? texture2D(tDiffuse, uvO) : centerSample;
  float wc = 0.56;
  float wo = 0.44 * vo;
  float wSum = max(1e-6, wc + wo);
  vec4 refracted = (centerSample * wc + tapO * wo) / wSum;
  #else
  vec4 refracted = centerSample;
  #endif

  #ifdef USE_CHROMATIC_ABERRATION
  if (uChromaticAberrationEnabled > 0.5) {
    vec2 texel2 = 1.0 / max(uResolution, vec2(1.0));
    float caPxBase = clamp(uChromaticAberrationStrengthPx, 0.0, 12.0);
    float caThresh = clamp(uChromaticAberrationThreshold, 0.0, 1.0);
    float caSoft = max(0.001, uChromaticAberrationThresholdSoftness);
    float lumBase = msLuminance(refracted.rgb);
    float caLumaGate = smoothstep(caThresh - caSoft, caThresh + caSoft, lumBase);
    vec2 dir = offsetUv; float dirLen = length(dir);
    vec2 dirN = (dirLen > 1e-6) ? (dir / dirLen) : vec2(1.0, 0.0);

    // Gate CA by shoreline mask + luminance threshold, then confine it to a
    // narrow raw-mask transition band to avoid broad color fringing.
    // This keeps CA local to the shoreline even when _Water has soft gradients.
    float caSdfMask = chromaticInsideFromSdf(sdf01);
    float caRawEdgeBand = clamp(4.0 * rawAuth * (1.0 - rawAuth), 0.0, 1.0);
    caRawEdgeBand = pow(caRawEdgeBand, 1.9);
    // Require actual mask gradient so wide soft plateaus don't get broad CA tint.
    float rawGrad = length(vec2(dFdx(rawAuth), dFdy(rawAuth)));
    float caGradGate = smoothstep(0.006, 0.03, rawGrad);
    float caEdgeMask = caSdfMask * caRawEdgeBand * caGradGate * caLumaGate;
    float caPx = caPxBase * caEdgeMask;
    float spread = clamp(uChromaticAberrationSampleSpread, 0.25, 3.0);
    float kawasePx = clamp(uChromaticAberrationKawaseBlurPx, 0.0, 8.0);

    vec2 caUv = dirN * (caPx * texel2) * zoom;
    vec2 axisBlurUv = dirN * (kawasePx * texel2) * spread * zoom;

    vec2 uvR = clamp(uv1 + caUv, vec2(0.001), vec2(0.999));
    vec2 uvB = clamp(uv1 - caUv, vec2(0.001), vec2(0.999));
    vec2 uvRp = clamp(uvR + axisBlurUv, vec2(0.001), vec2(0.999));
    vec2 uvRm = clamp(uvR - axisBlurUv, vec2(0.001), vec2(0.999));
    vec2 uvBp = clamp(uvB + axisBlurUv, vec2(0.001), vec2(0.999));
    vec2 uvBm = clamp(uvB - axisBlurUv, vec2(0.001), vec2(0.999));

    float vR0 = refractTapValid(uvR);
    float vRp = refractTapValid(uvRp);
    float vRm = refractTapValid(uvRm);
    float vB0 = refractTapValid(uvB);
    float vBp = refractTapValid(uvBp);
    float vBm = refractTapValid(uvBm);

    float rW0 = 0.50 * vR0;
    float rWp = 0.25 * vRp;
    float rWm = 0.25 * vRm;
    float bW0 = 0.50 * vB0;
    float bWp = 0.25 * vBp;
    float bWm = 0.25 * vBm;

    float rSum = max(1e-5, rW0 + rWp + rWm);
    float bSum = max(1e-5, bW0 + bWp + bWm);

    float r0 = (vR0 > 0.5) ? texture2D(tDiffuse, uvR).r : refracted.r;
    float rp = (vRp > 0.5) ? texture2D(tDiffuse, uvRp).r : refracted.r;
    float rm = (vRm > 0.5) ? texture2D(tDiffuse, uvRm).r : refracted.r;

    float b0 = (vB0 > 0.5) ? texture2D(tDiffuse, uvB).b : refracted.b;
    float bp = (vBp > 0.5) ? texture2D(tDiffuse, uvBp).b : refracted.b;
    float bm = (vBm > 0.5) ? texture2D(tDiffuse, uvBm).b : refracted.b;

    float rChannel = (r0 * rW0 + rp * rWp + rm * rWm) / rSum;
    float bChannel = (b0 * bW0 + bp * bWp + bm * bWm) / bSum;
    vec3 caRgb = vec3(rChannel, refracted.g, bChannel);
    float caBlend = clamp(caEdgeMask, 0.0, 1.0);
    refracted.rgb = mix(refracted.rgb, caRgb, caBlend);
  }
  #endif

  vec3 col = refracted.rgb;

  // Read cloud shadow early for specular/foam use, but apply it to the color later.
  float cloudShadow = 0.0;
  float cloudDarken = 0.0;
  if (uCloudShadowEnabled > 0.5 && uHasCloudShadow > 0.5) {
    float cloudLitRaw = texture2D(tCloudShadow, vUv).r;
    cloudShadow = clamp(1.0 - cloudLitRaw, 0.0, 1.0);
    float dStrength = clamp(uCloudShadowDarkenStrength, 0.0, 4.0);
    float dCurve = max(0.01, uCloudShadowDarkenCurve);
    cloudDarken = dStrength * pow(cloudShadow, dCurve);
  }
  // ShadowManager combined already folds cloud into the lit factor (foam/murk).
  // Applying legacy cloudDarken on top would double-darken vs the lit scene in tDiffuse.
  if (uHasCombinedShadow > 0.5) {
    cloudDarken = 0.0;
  }

  // Structural shadows (building + overhead): used to darken foam and fully suppress specular.
  // Match LightingEffectV2 conventions:
  // - Building shadow is scene-space (sceneUv) factor in [0..1], where 1 = lit.
  // - Overhead shadow uses RGB factor modulated by alpha tile-projection.
  float buildingShadow = 0.0;
  if (uHasBuildingShadow > 0.5) {
    float bldLit = clamp(texture2D(tBuildingShadow, sceneUv).r, 0.0, 1.0);
    buildingShadow = 1.0 - bldLit;
  }
  float overheadShadow = 0.0;
  if (uHasOverheadShadow > 0.5) {
    vec4 ov = texture2D(tOverheadShadow, vUv);
    vec3 ovRgb = clamp(ov.rgb, vec3(0.0), vec3(1.0));
    float ovA = clamp(ov.a, 0.0, 1.0);
    vec3 ovCombined = ovRgb * ovA;
    float ovLit = clamp(dot(ovCombined, vec3(0.3333333)), 0.0, 1.0);
    overheadShadow = 1.0 - ovLit;
  }
  float structuralShadow = max(buildingShadow, overheadShadow);
  // Legacy path (no tCombinedShadow): crush foam in deep shadow — reads shiny in light, not emissive in shade.
  float foamStructuralDarken = mix(1.0, 0.06, pow(structuralShadow, 1.15));
  // Reduce foam visibility under building shadows specifically.
  float foamBuildingShadowFade = mix(1.0, 0.06, pow(buildingShadow, 1.1));

  vec2 msUvShadow = vec2(
    (gl_FragCoord.x + 0.5) / max(uResolution.x, 1.0),
    (gl_FragCoord.y + 0.5) / max(uResolution.y, 1.0)
  );
  float combinedShadowLit = 1.0;
  float combinedShadowOcc = 0.0;
  if (uHasCombinedShadow > 0.5) {
    combinedShadowLit = clamp(texture2D(tCombinedShadow, msUvShadow).r, 0.0, 1.0);
    combinedShadowOcc = clamp(1.0 - combinedShadowLit, 0.0, 1.0);
  }

  // ShadowManagerV2 combined map (screen vUv, R = lit factor). When bound, shore +
  // floating foam use this for color and alpha so they track cloud + overhead + building
  // the same way as water particles and murk (avoids double-applying structural).
  float foamColorLitMul = foamStructuralDarken;
  float foamAlphaLitMul = foamBuildingShadowFade;
  if (uHasCombinedShadow > 0.5) {
    foamColorLitMul = combinedShadowLit;
    foamAlphaLitMul = combinedShadowLit;
  }
  // Foam should darken in shadow without "disappearing". Use a stronger color-only
  // curve than water base and keep alpha mostly ownership/coverage-driven.
  float foamShadowColorMul = pow(clamp(foamColorLitMul, 0.0, 1.0), 1.65);

  // Murk
  float murkFactor = 0.0;
  col = applyMurk(sceneUv, uTime, inside, shore, outdoorStrength, indoorWindMotion, col, murkFactor);

  // Tint - use darkening approach instead of brightening
  float sceneDarkness = clamp(uSceneDarkness, 0.0, 1.0);
  // Reduce tint strength significantly at night
  float tintStrengthMultiplier = mix(1.0, 0.01, sceneDarkness);
  float effectiveTint = clamp(uTintStrength, 0.0, 1.0) * tintStrengthMultiplier * (1.0 - (murkFactor * 0.5));
  float k = effectiveTint * inside * shore;
  
  // Darken the water with tint instead of brightening
  vec3 darkenedTintColor = mix(uTintColor, uTintColor * 0.01, sceneDarkness);
  // Use multiply instead of mix to darken
  col = mix(col, col * darkenedTintColor, k);

  // Caustics (underwater highlight patterns) — V1-accurate ridged-FBM filaments.
  #ifdef USE_CAUSTICS
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

    // Wave-following caustics:
    // Use the same UV offset field as refraction (offsetUvRaw) so caustics
    // visibly "track" wave motion, breaking up regular/parallel patterns.
    // Wind-aware caustics: bias distortion by how local crest direction aligns
    // with wind, so caustics "feel" advected in a more coherent direction.
    float windLen = length(uWindDir);
    vec2 windBasis = (windLen > 1e-6)
      ? normalize(vec2(uWindDir.x * sceneAspectW, uWindDir.y))
      : vec2(1.0, 0.0);
    float crestsAlign = abs(dot(safeNormalize2(perpG), windBasis)); // perpG ~= crest direction
    float alignW = mix(0.85, 1.15, crestsAlign);

    float caWarpStrength = (0.16 + 0.28 * crestMod) * alignW;
    vec2 causticsUv = sceneUv + offsetUvRaw * caWarpStrength;
    // Add a small perpendicular component for extra breakup without changing
    // the dominant travel direction.
    causticsUv += perpG * (px * texel) * amp * 0.06 * (0.35 + 0.65 * crestMod) * alignW;

    float causticsSharpEff = clamp(uCausticsSharpness * (0.55 + 1.25 * crestMod), 0.05, 2.0);
    coverage *= (0.65 + 0.70 * crestMod);

    // V1-accurate dual-layer blend: soft base + sharp detail.
    // Wind-speed coupling: gustier wind speeds up underwater highlight motion.
    float wind01 = clamp(uWindSpeed, 0.0, 1.0);
    float caWind = 1.0 + 0.65 * wind01;
    float c = causticsPattern(causticsUv, uTime * caWind, uCausticsScale, uCausticsSpeed, causticsSharpEff);

    // V1-accurate cloud-shadow caustics kill.
    float causticsCloudLit = 1.0;
    if (uHasCombinedShadow > 0.5) {
      causticsCloudLit = combinedShadowLit;
    } else if (uCloudShadowEnabled > 0.5 && uHasCloudShadow > 0.5) {
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
    causticsAmt *= edgeStability;
    // Treat caustics as LIGHT (illumination) instead of pigment.
    // WindowLightEffectV2 contributes to the lighting accumulation buffer, then
    // LightingEffect composes as: litColor = albedo * totalIllumination.
    // We approximate that behaviour here by multiplying the current colour by a
    // caustics illumination term, which preserves underlying albedo detail.
    float cLight = c * causticsAmt * 1.35;
    // Caustics are razor-thin FBM filaments — like extra specular; Kawase-blurred
    // tiles underneath need the same energy reduction as spec/foam softening.
    cLight *= mix(1.0, 0.10, uFloorDepthBlurWaterSoft);
    vec3 warm = vec3(1.0, 1.0, 0.85);
    vec3 causticsTint = mix(vec3(1.0), warm, 0.85);
    // Small tint toward water hue, but keep it mostly warm-white so it reads as light.
    causticsTint = mix(causticsTint, clamp(uTintColor, vec3(0.0), vec3(1.0)), 0.08);
    col *= (vec3(1.0) + causticsTint * cLight);
  }
  #endif

  // Foam (pass pre-computed waveGrad to avoid redundant calculateWave call)
  float sceneLuma = dot(col, vec3(0.299, 0.587, 0.114));
  float darkness = clamp(uSceneDarkness, 0.0, 1.0);

  // WaterSplashesEffectV2 MS_WATER_SPLASHES_SHADOW_DARKEN_V3: combined shadow at
  // pixel UV (gl_FragCoord / uResolution), then rgb *= csh and a *= csh. Advanced
  // floating foam uses this path so it tracks the same grid as bus particles (vUv
  // can sit off the combined RT in some viewport/post setups).
  float splashCombinedCsh = combinedShadowLit;
  
  float shoreFoamAmount;
  FloatingFoamData floatingFoam;
  getFoamData(sceneUv, shore, inside, rainOffPx, waveGrad, sceneLuma, darkness, outdoorStrength, indoorWindMotion, shoreFoamAmount, floatingFoam);
  // Softer foam presence + less pop vs blurred bus (mask still drives physics above).
  float fdbFoam = uFloorDepthBlurWaterSoft;
  float shoreFoamVis = shoreFoamAmount * mix(1.0, 0.58, fdbFoam);
  float floatFoamAmtVis = floatingFoam.amount * mix(1.0, 0.58, fdbFoam);
  float foamCoverageVis = clamp(max(shoreFoamVis, floatFoamAmtVis), 0.0, 1.0);
  float floatFoamCoverageVis = clamp(floatFoamAmtVis, 0.0, 1.0);
  
  // Apply floating foam shadow to water surface BEFORE foam rendering
  // Shadow offset based on sun direction (like building shadows)
  if (floatingFoam.shadowStrength > 0.01) {
    vec3 sunDir = normalize(uSpecSunDir);
    // Project sun direction onto XY plane for shadow offset
    vec2 shadowOffset = vec2(sunDir.x, sunDir.y) * 0.002; // Small offset in UV space
    vec2 shadowUv = sceneUv + shadowOffset;
    
    // Sample foam at offset position for directional shadow
    float shoreFoamShadow;
    FloatingFoamData shadowFoam;
    getFoamData(shadowUv, shore, inside, rainOffPx, waveGrad, sceneLuma, darkness, outdoorStrength, indoorWindMotion, shoreFoamShadow, shadowFoam);
    
    float shadowDarken = shadowFoam.amount * floatingFoam.shadowStrength;
    shadowDarken *= mix(1.0, 0.22, uFloorDepthBlurWaterSoft);
    col *= (1.0 - shadowDarken);
  }
  
  // Shore foam rendering (NEW ADVANCED SYSTEM)
  if (shoreFoamVis > 0.01) {
    // Color processing
    vec3 shoreFoamColor = uShoreFoamColor;
    
    // Apply tint
    if (uShoreFoamTintStrength > 0.01) {
      float tintStr = clamp(uShoreFoamTintStrength, 0.0, 1.0);
      shoreFoamColor = mix(shoreFoamColor, uShoreFoamTint, tintStr);
    }
    
    // Color variation
    if (uShoreFoamColorVariation > 0.01) {
      vec2 colorVarUv = effectUv(sceneUv) * 3.0 + vec2((uWindTime * indoorWindMotion) * 0.05);
      float colorVar = valueNoise(colorVarUv);
      float varAmount = clamp(uShoreFoamColorVariation, 0.0, 1.0);
      shoreFoamColor = mix(shoreFoamColor, shoreFoamColor * (0.8 + colorVar * 0.4), varAmount);
    }
    
    // Brightness, contrast, gamma (cap brightness so foam cannot blow past scene albedo)
    float brightness = clamp(uShoreFoamBrightness, 0.0, 1.25);
    float contrast = clamp(uShoreFoamContrast, 0.0, 2.0);
    float gamma = max(0.1, uShoreFoamGamma);
    
    shoreFoamColor = shoreFoamColor * brightness;
    shoreFoamColor = ((shoreFoamColor - 0.5) * contrast) + 0.5;
    shoreFoamColor = pow(max(shoreFoamColor, vec3(0.0)), vec3(gamma));
    shoreFoamColor = clamp(shoreFoamColor, vec3(0.0), vec3(0.92));
    
    // Lighting calculation
    float shoreLightFactor = 1.0;
    float shoreDarkScale = 1.0;
    if (uShoreFoamLightingEnabled > 0.5) {
      float ambient = clamp(uShoreFoamAmbientLight, 0.0, 1.0);
      float sceneInfluence = clamp(uShoreFoamSceneLightInfluence, 0.0, 1.0);
      float darkResponse = clamp(uShoreFoamDarknessResponse, 0.0, 1.0);
      
      float sceneLit = smoothstep(0.02, 0.35, sceneLuma);
      sceneLit = mix(ambient, 1.0, sceneLit);
      
      shoreDarkScale = mix(1.0, 0.05, darkness * darkResponse);
      
      shoreLightFactor = sceneLit * sceneInfluence + ambient * (1.0 - sceneInfluence);
      shoreLightFactor = clamp(shoreLightFactor, 0.0, 1.0);
    }
    
    // Apply lighting to color
    shoreFoamColor *= shoreLightFactor;
    shoreFoamColor *= foamShadowColorMul;
    shoreFoamColor = mix(shoreFoamColor, col, 0.42 * fdbFoam);
    // Scene-referred cap: foam is diffusive, not emissive. Keeps normal-blended
    // WaterSplashes particles from stacking into clipped white on top.
    shoreFoamColor = clamp(shoreFoamColor, vec3(0.0), vec3(1.0));
    
    // Opacity and blending
    float shoreOpacity = clamp(uShoreFoamOpacity, 0.0, 1.0);
    float shoreAlpha = clamp(shoreFoamVis * shoreOpacity, 0.0, 1.0);
    shoreAlpha *= mix(1.0, 0.20, uFloorDepthBlurWaterSoft);
    
    // Blend foam color first (standard src-over; clamp output for downstream passes)
    col = clamp(mix(col, shoreFoamColor, shoreAlpha), vec3(0.0), vec3(1.0));
    // THEN apply darkness for proper night darkening
    col *= shoreDarkScale;
  }
  
  // Apply floating foam with independent color and FULL opacity control
  if (floatFoamAmtVis > 0.01) {
    float floatingAlpha = clamp(floatFoamAmtVis * floatingFoam.opacity, 0.0, 1.0);
    floatingAlpha *= mix(1.0, 0.20, uFloorDepthBlurWaterSoft);
    vec3 floatingFoamColor = mix(floatingFoam.color, col, 0.42 * fdbFoam);
    // SkyColorEffectV2-driven lift for floating foam:
    // brighten foam primarily outdoors so ambient can stay near zero without
    // losing daytime readability.
    vec3 skyColFoam = clamp(uSkyColor, vec3(0.0), vec3(1.0));
    float skyLumFoam = dot(skyColFoam, vec3(0.299, 0.587, 0.114));
    float skyIFoam = clamp(uSkyIntensity, 0.0, 1.0);
    float skyBoost = 1.0;
    if (uHasOutdoorsMask > 0.5) {
      float outdoorFoam = clamp(outdoorStrength, 0.0, 1.0);
      // Outdoors receive most of the sky lift; indoors get only a small residual.
      float skyLift = (0.08 + 0.52 * outdoorFoam) * skyIFoam * (0.45 + 0.55 * skyLumFoam);
      skyBoost += skyLift;
    } else {
      // Fallback when no outdoors mask exists.
      skyBoost += 0.20 * skyIFoam * (0.45 + 0.55 * skyLumFoam);
    }
    // Prevent multiplicative "HDR foam" that reads self-lit vs particle splashes.
    skyBoost = min(skyBoost, 1.22);
    floatingFoamColor *= skyBoost;
    float floatingShadowMul = foamShadowColorMul;
    if (uHasCombinedShadow > 0.5) {
      floatingShadowMul = foamShadowColorMul;
    } else {
      floatingShadowMul = foamShadowColorMul;
    }
    // Keep foam silhouette/coverage stable in shadow. Darken albedo only; avoid
    // coupling shadow response to alpha, which reads as "transparent foam".
    floatingFoamColor *= floatingShadowMul;
    // Apply floating-foam darkness to the foam layer itself. Applying darkness to
    // final col here makes the whole water pixel dim and still allows later specular
    // to re-brighten foam areas.
    floatingFoamColor *= floatingFoam.darkScale;
    floatingFoamColor = clamp(floatingFoamColor, vec3(0.0), vec3(1.0));
    // Blend foam color onto water
    col = clamp(mix(col, floatingFoamColor, floatingAlpha), vec3(0.0), vec3(1.0));
  }

  // Shader flecks (drive by combined foam presence) — same lit factor as splashes when combined
  float fleckShadowMul = foamColorLitMul;
  if (uHasCombinedShadow > 0.5) {
    fleckShadowMul = splashCombinedCsh;
  }
  float fleckDriver = clamp(max(shoreFoamVis, floatFoamAmtVis) * (uHasCombinedShadow > 0.5 ? splashCombinedCsh : foamAlphaLitMul), 0.0, 1.0);
  float shaderFlecks = getShaderFlecks(sceneUv, inside, shore, fleckDriver, rainOffPx, indoorWindMotion);
  vec3 fleckCol = mix(uShoreFoamColor, floatingFoam.color, clamp(floatFoamAmtVis, 0.0, 1.0)) * fleckShadowMul;
  float fleckW = shaderFlecks * 0.45 * mix(1.0, 0.07, uFloorDepthBlurWaterSoft);
  vec3 fleckAdd = fleckCol * fleckW;
  fleckAdd = min(fleckAdd, vec3(0.28));
  col = clamp(col + fleckAdd, vec3(0.0), vec3(1.0));

  // Apply screen-space cloud shadows globally to water + foam + caustics + murk
  col *= max(0.0, 1.0 - cloudDarken);

  // Sun specular / sharp highlights must follow the lit scene in tDiffuse. Shadow RTs
  // and uSceneDarkness do not cover every dark region (interiors, night albedo, etc.).
  // Min(center, refracted) keeps glints subdued when either the surface pixel or the
  // refracted sample is in a dark part of the map.
  float specEnvLuma = min(msLuminance(base.rgb), msLuminance(refracted.rgb));
  float specSceneLightMul = smoothstep(0.018, 0.24, specEnvLuma);

  // Specular (GGX)
  vec2 slope;
  // Pure Gerstner wave system - all surface detail from mathematical waves
  if (uSpecNormalMode > 1.5) {
    // Mode 2+: wave slope from analytical gradient. Reuses the waveGrad already
    // computed for distortion - eliminates the old 4-tap finite difference that
    // called waveHeight 4 times (= 40 wave evaluations per pixel).
    slope = specWaveSlopeFromGrad(waveGrad) * clamp(uSpecNormalStrength, 0.0, 10.0);
    slope *= clamp(uSpecNormalScale, 0.0, 1.0);
  } else if (uSpecNormalMode > 0.5) {
    // Mode 1: flat/camera-facing normal (simplified - no micro-normal)
    // This avoids the hard-edged artifacts from wave-gradient normals.
    slope = vec2(0.0, 0.0);
  } else {
    // Mode 0: legacy wave-gradient slope.
    slope = (waveGrad * waveStrength) * clamp(uSpecNormalStrength, 0.0, 10.0);
    slope *= clamp(uSpecNormalScale, 0.0, 1.0);
  }

  // Add distortion-driven micro-normal (precipitation noise).
  if (uSpecDisableRainSlope < 0.5) {
    vec2 rainSlope = rainOffPx / max(1.0, uRainDistortionStrengthPx);
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
    vec2 t = wd2; vec2 b = vec2(-t.y, t.x);
    vec2 s = vec2(dot(slope, t), dot(slope, b));
    float ratio = clamp(uSpecAnisoRatio, 1.0, 16.0);
    s = vec2(s.x * mix(1.0, 1.0/ratio, an), s.y * mix(1.0, ratio, an));
    slope = t * s.x + b * s.y;
  }

  vec3 N = normalize(vec3(-slope.x, -slope.y, 1.0));
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 L = normalize(uSpecSunDir);
  
  // Sun angle toggle: if disabled, use zenith direction (no directional specular)
  if (uSpecUseSunAngle < 0.5) {
    L = vec3(0.0, 0.0, 1.0);
  }
  
  float NoV = clamp(dot(N, V), 0.0, 1.0);
  float NoL = clamp(dot(N, L), 0.0, 1.0);
  vec3 H = normalize(L + V);
  float NoH = clamp(dot(N, H), 0.0, 1.0);
  float VoH = clamp(dot(V, H), 0.0, 1.0);
  float p01 = clamp((uSpecPower - 1.0) / 23.0, 0.0, 1.0);
  float rMin = clamp(uSpecRoughnessMin, 0.001, 1.0);
  float rMax = clamp(uSpecRoughnessMax, 0.001, 1.0);
  float rough = mix(max(rMax, min(rMin, rMax) + 1e-4), min(rMin, rMax), p01);

  // High-fidelity roughness modulation:
  // - Increase roughness when the surface is more turbulent (wave distortion energy).
  // - Increase roughness near shore where foam/murk breaks up smooth reflections.
  float waveTurb01 = clamp(m, 0.0, 1.0);
  float foamAmt = clamp(max(shoreFoamAmount, floatingFoam.amount), 0.0, 1.0);
  float shallow01 = clamp(shore, 0.0, 1.0);
  float dynRough = 0.07 * waveTurb01 + 0.11 * shallow01 + 0.08 * foamAmt;
  
  // Additional roughness for low sun angles (dawn/dusk)
  // Prevents sharp glancing highlights when sun is near horizon
  if (uSpecSunElevationFalloffEnabled > 0.5 && uSpecUseSunAngle > 0.5) {
    float sunElevationDeg = uSpecSunElevationDeg;
    float lowSunRough = smoothstep(25.0, 5.0, sunElevationDeg) * 0.3;
    dynRough += lowSunRough;
  }
  
  rough = clamp(rough + dynRough, 0.001, 1.0);

  // Spatial roughness variation: patchy "oil/silt/wind" micro-roughness so GGX
  // isn't uniform across the surface (reads as natural water vs filtered pool).
  float chR = clamp(uSpecSurfaceChaos, 0.0, 1.0);
  if (chR > 1e-4) {
    vec2 wfR = uWindDir;
    float wlR = length(wfR);
    wfR = (wlR > 1e-6) ? (wfR / wlR) : vec2(1.0, 0.0);
    vec2 wbR = normalize(vec2(wfR.x * sceneAspectW, wfR.y));
    vec2 wpR = vec2(-wbR.y, wbR.x);
    vec2 basisR = vec2(sceneUv.x * sceneAspectW, sceneUv.y);
    vec2 rDom = basisR * 2.8 - wbR * (uWindTime * 0.09) - wpR * (uWindTime * 0.044);
    float rN = valueNoise2D(rDom + vec2(101.3, 67.1));
    float rN2 = valueNoise2D(rDom * 1.87 - vec2(uWindTime * 0.062, uWindTime * 0.031));
    float rPatch = mix(rN, rN2, 0.35);
    rough = clamp(rough + chR * (0.032 + 0.145 * rPatch), 0.001, 1.0);
  }

  // Specular AA: if the normal/slope varies too fast across pixels, GGX produces
  // sub-pixel sparkles (thin scratchy lines). Increase roughness locally to
  // band-limit the highlight.
  vec2 fw = fwidth(slope);
  float slopeFw = clamp(length(fw), 0.0, 1.0);
  float aa = slopeFw * clamp(uSpecAAStrength, 0.0, 10.0);
  rough = clamp(rough + aa, 0.001, 1.0);
  // Widen highlight lobe when underlying scene was Kawase-blurred (matches softer bus).
  rough = mix(rough, clamp(rough * 3.35 + 0.14, 0.001, 0.98), uFloorDepthBlurWaterSoft);

  vec3 spec;
  if (uSpecModel > 0.5) {
    // Stable fallback model: Blinn-Phong style specular.
    // This cannot explode like GGX and is useful for debugging.
    float shininess = mix(16.0, 512.0, p01);
    shininess = mix(shininess, max(5.0, shininess * 0.22), uFloorDepthBlurWaterSoft);
    float blinn = pow(max(NoH, 0.0), shininess);
    float f0 = clamp(uSpecF0, 0.0, 1.0);
    float fres = f0 + (1.0 - f0) * pow(1.0 - VoH, 5.0);
    spec = vec3(blinn * fres) * NoL;
    spec *= mix(1.0, 0.42, uFloorDepthBlurWaterSoft);
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

    vec3 specPrimary = (((D * G) * F) / max(1e-6, 4.0 * NoV * NoL)) * NoL;
    specPrimary *= mix(1.0, 0.42, uFloorDepthBlurWaterSoft);

    // Second broader lobe ("sheen"): adds water-like body on top of mirror glints.
    // Weight is driven by wave turbulence + crestiness; energy is normalized
    // to avoid blowing out specular.
    float sheenW = clamp(0.10 + 0.40 * waveTurb01 + 0.18 * crestMod - 0.08 * shallow01, 0.0, 0.65);
    sheenW *= mix(1.0, 0.18, uFloorDepthBlurWaterSoft);
    float rough2 = clamp(rough * (1.55 + 0.75 * waveTurb01) + 0.02 + 0.10 * shallow01, 0.001, 1.0);
    float alpha2 = max(0.001, rough2 * rough2);
    float a22 = alpha2 * alpha2;
    float dDen2 = (NoH * NoH) * (a22 - 1.0) + 1.0;
    float D2 = a22 / max(1e-6, 3.14159265 * dDen2 * dDen2);
    float ggxK2 = (rough2 + 1.0); ggxK2 = (ggxK2 * ggxK2) / 8.0;
    float Gv2 = NoV / max(1e-6, NoV * (1.0 - ggxK2) + ggxK2);
    float Gl2 = NoL / max(1e-6, NoL * (1.0 - ggxK2) + ggxK2);
    float G2 = Gv2 * Gl2;
    vec3 specSheen = (((D2 * G2) * F) / max(1e-6, 4.0 * NoV * NoL)) * NoL;

    spec = specPrimary + specSheen * sheenW;
    // Simple energy normalization for stability.
    spec *= 1.0 / (1.0 + sheenW * 0.85);
  }

  // Sun elevation falloff: dramatically reduce specular at low sun angles (dawn/dusk)
  if (uSpecSunElevationFalloffEnabled > 0.5 && uSpecUseSunAngle > 0.5) {
    float sunElevationDeg = uSpecSunElevationDeg;

    float falloffStart = clamp(uSpecSunElevationFalloffStart, 0.0, 90.0);
    float falloffEnd = clamp(uSpecSunElevationFalloffEnd, 0.0, 90.0);
    float falloffCurve = max(0.1, uSpecSunElevationFalloffCurve);
    
    // Ensure start > end for proper falloff range
    float rangeStart = max(falloffStart, falloffEnd + 0.1);
    float rangeEnd = min(falloffEnd, falloffStart - 0.1);
    
    // Much more aggressive falloff curve
    float elevationFactor = smoothstep(rangeEnd, rangeStart, sunElevationDeg);
    elevationFactor = pow(elevationFactor, falloffCurve);
    
    // Additional aggressive falloff for very low sun angles
    // Below 15°, reduce specular dramatically
    if (sunElevationDeg < 15.0) {
      float lowSunFactor = smoothstep(0.0, 15.0, sunElevationDeg);
      lowSunFactor = pow(lowSunFactor, 4.0); // Very steep curve
      elevationFactor = min(elevationFactor, lowSunFactor);
    }
    
    // Near horizon (below 8°), almost eliminate specular
    if (sunElevationDeg < 8.0) {
      float horizonFactor = smoothstep(0.0, 8.0, sunElevationDeg);
      horizonFactor = pow(horizonFactor, 6.0); // Extremely steep
      elevationFactor = min(elevationFactor, horizonFactor * 0.1);
    }
    
    spec *= elevationFactor;
  }

  // Combined shadow suppression: cloud, building, and overhead shadows
  float combinedShadow = 0.0;

  if (uHasCombinedShadow > 0.5) {
    combinedShadow = combinedShadowOcc;
  } else {
    // Cloud shadow
    if (uCloudShadowEnabled > 0.5 && cloudShadow > 1e-5) {
      combinedShadow = max(combinedShadow, cloudShadow);
    }

    // Structural shadows (building + overhead) are already sampled above.
    combinedShadow = max(combinedShadow, structuralShadow);
  }
  
  // Apply combined shadow to specular
  if (combinedShadow > 1e-5) {
    float kStrength = clamp(uCloudShadowSpecularKill, 0.0, 1.0);
    float kCurve = max(0.01, uCloudShadowSpecularCurve);
    float litPow = pow(clamp(1.0 - combinedShadow, 0.0, 1.0), kCurve);
    spec *= mix(1.0, litPow, kStrength);
  }
  // Structural shadows suppress 75% of specular at full shadow.
  if (uHasCombinedShadow > 0.5) {
    spec *= (1.0 - 0.75 * combinedShadowOcc);
  } else {
    spec *= (1.0 - 0.75 * structuralShadow);
  }
  if (uSpecDisableMasking < 0.5) {
    float specMask = pow(clamp(distInside, 0.0, 1.0), clamp(uSpecMaskGamma, 0.05, 12.0));
    spec *= specMask;
    spec *= edgeStability;
    float shoreBias = mix(1.0, shore, clamp(uSpecShoreBias, 0.0, 1.0));
    spec *= shoreBias;
  }
  float strength = clamp(uSpecStrength, 0.0, 250.0) / 50.0;
  spec *= strength * clamp(uSpecSunIntensity, 0.0, 10.0);
  // Indoor water should have much dimmer highlights.
  // With outdoors mask: 0.0 (indoor) -> 10% spec, 1.0 (outdoor) -> full spec.
  if (uHasOutdoorsMask > 0.5) {
    spec *= mix(0.10, 1.0, clamp(outdoorStrength, 0.0, 1.0));
  }
  spec *= mix(1.0, 0.05, clamp(uSceneDarkness, 0.0, 1.0));
  vec3 skyCol = clamp(uSkyColor, vec3(0.0), vec3(1.0));
  float skyI = clamp(uSkyIntensity, 0.0, 1.0);
  float skySpecI = mix(0.08, 1.0, skyI);
  vec3 tint = mix(vec3(1.0), skyCol, clamp(uSpecSkyTint, 0.0, 1.0));
  vec3 specCol = spec * tint * skySpecI;
  // Floating foam should read as diffuse/frothy, not mirror-bright.
  specCol *= mix(1.0, 0.02, floatFoamCoverageVis);
  float sClamp = max(0.0, uSpecClamp);
  if (sClamp > 0.0) {
    specCol = min(specCol, vec3(sClamp));
  }
  specCol *= mix(1.0, 0.18, uFloorDepthBlurWaterSoft);
  specCol *= specSceneLightMul;
  col += specCol;

  // ── Specular Highlights (additive sharp highlights) ─────────────────────
  vec3 specHighlightsCol = vec3(0.0);
  if (uSpecHighlightsEnabled > 0.5) {
    specHighlightsCol = calculateSpecularHighlights(
      sceneUv, inside, N, V, L, NoL, NoV, distInside, edgeStability, shore, 
      waveGrad, rainOffPx, indoorWindMotion, outdoorStrength, sceneLuma, 
      darkness, combinedShadow, structuralShadow
    );
    specHighlightsCol *= mix(1.0, 0.02, floatFoamCoverageVis);
    specHighlightsCol *= specSceneLightMul;
    col += specHighlightsCol;
  }

  vec3 specBloomAccum = specCol + specHighlightsCol;

  // Subtle ambient shadow for water depth
  // Reduces brightness in deeper water and adds gentle curvature falloff
  float waterDepthAmbientMul = 1.0;
  if (uWaterDepthShadowEnabled > 0.5) {
    float waterDepth = max(0.0, 1.0 - distInside);
    float ambientShadow = 1.0 - uWaterDepthShadowStrength * waterDepth * waterDepth;
    ambientShadow = max(uWaterDepthShadowMinBrightness, ambientShadow);
    col *= ambientShadow;
    waterDepthAmbientMul = ambientShadow;
  }
  specBloomAccum *= waterDepthAmbientMul;

  // ── Cloud Reflection ───────────────────────────────────────────────────────
  if (uCloudReflectionEnabled > 0.5 && uHasCloudTopTexture > 0.5) {
    // Sample the combined cloud tops from CloudEffectV2
    vec4 cloudTopColor = texture2D(tCloudTopTexture, vUv);

    // Simple Fresnel effect for reflection
    float fresnel = pow(1.0 - NoV, 3.0);
    
    // Calculate reflection strength
    float reflectionStrength = clamp(uCloudReflectionStrength, 0.0, 1.0);
    reflectionStrength *= fresnel;
    
    // Apply shadow suppression
    reflectionStrength *= (1.0 - combinedShadow * 0.5);
    reflectionStrength *= mix(1.0, 0.12, floatFoamCoverageVis);
    
    // Indoor damping
    if (uHasOutdoorsMask > 0.5) {
      reflectionStrength *= mix(0.1, 1.0, clamp(outdoorStrength, 0.0, 1.0));
    }
    
    // Scene darkness affects reflection
    reflectionStrength *= mix(1.0, 0.1, clamp(uSceneDarkness, 0.0, 1.0));
    
    // Blend cloud reflection with water color
    col = mix(col, cloudTopColor.rgb, clamp(reflectionStrength * cloudTopColor.a, 0.0, 1.0));
  }

  col = mix(col, base.rgb, occluderBlend);
  specBloomAccum *= (1.0 - occluderBlend);
  MSA_BLOOM_RT_COMMIT(specBloomAccum * clamp(uBloomSpecularEmitMul, 0.0, 12.0));
  // LevelCompositePass is straight-alpha source-over. If we keep output a = base.a,
  // punched-through tile holes (base.a ≈ 0) zero out premultiplied contribution even
  // when col holds water — upper-floor holes then show void instead of lower water.
  float waterOutA = max(base.a, clamp(inside, 0.0, 1.0));
  waterOutA = mix(waterOutA, base.a, occluderBlend);
  gl_FragColor = vec4(col, waterOutA);
}
`;
}
