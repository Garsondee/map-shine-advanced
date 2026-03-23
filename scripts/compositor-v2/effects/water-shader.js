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
 *   - Water occluder alpha (tWaterOccluderAlpha)
 *
 * Preserved from V1 (all visual features):
 *   - Texture-based noise (replaces procedural hash for fast compile)
 *   - Rain ripple cellular automaton
 *   - Storm distortion vector field
 *   - Multi-octave wave system with warp, evolution, and wind coupling
 *   - Shore foam with curl noise breakup + floating foam clumps
 *   - Shader-based foam flecks (ifdef USE_FOAM_FLECKS)
 *   - Murk (subsurface silt/algae)
 *   - GGX specular with anisotropy
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

  p = octRot * p * 2.0;
  p = mod(p, NOISE_SIZE);
  i = floor(p); f = fract(p); u = f * f * (3.0 - 2.0 * f);
  i = mod(i, NOISE_SIZE);
  float n3 = mix(mix(
    texture2DLodEXT(tNoiseMap, (i + 0.5) * NOISE_INV, 0.0).a,
    texture2DLodEXT(tNoiseMap, (i + vec2(1.5, 0.5)) * NOISE_INV, 0.0).a, u.x), mix(
    texture2DLodEXT(tNoiseMap, (i + vec2(0.5, 1.5)) * NOISE_INV, 0.0).a,
    texture2DLodEXT(tNoiseMap, (i + vec2(1.5, 1.5)) * NOISE_INV, 0.0).a, u.x), u.y);

  return (n0 - 0.5) * 1.1 + (n1 - 0.5) * 0.605
       + (n2 - 0.5) * 0.33275 + (n3 - 0.5) * 0.183;
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

  // Two offset FBM layers with different drift rates for organic motion
  float t = uTime * sp;
  vec2 domain = uv * sc;
  float n1x = fbmNoise(domain + vec2(t * 0.13, -t * 0.09) + vec2(11.7, 7.3));
  float n1y = fbmNoise(domain + vec2(-t * 0.11, t * 0.14) + vec2(31.1, 19.9));
  float n2x = fbmNoise(domain * 1.73 + vec2(t * 0.17, t * 0.07) + vec2(5.3, 41.1));
  float n2y = fbmNoise(domain * 1.73 + vec2(-t * 0.08, -t * 0.15) + vec2(23.7, 3.9));

  // Blend two layers for complex motion without cellular artifacts
  vec2 offset = vec2(n1x * 0.6 + n2x * 0.4, n1y * 0.6 + n2y * 0.4);

  // Precipitation ramps in smoothly — light rain = subtle, heavy rain = strong
  float ramp = smoothstep(0.0, 0.6, p) * (0.5 + 0.5 * p);

  return offset * px * ramp;
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
  // Important: do NOT advect the wave *domain* using uWindOffsetUv.
  // The waves already travel via the phase term in addWave() (omega * uWindTime).
  // Advecting the domain as well can partially cancel / overtake the phase travel
  // and produces a standing-wave / ping-pong look.
  vec2 uv = sceneUv;
  // Use uWindTime (monotonically wind-driven) for warp drift speed.
  // This keeps all warp motion locked to the wind: as wind increases the
  // warp pattern advances faster, and it never reverses direction.
  float warpT = uWindTime * max(0.0, uWaveWarpTimeSpeed) * m;
  float sceneAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
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
  float lf1 = fbmNoise(streakUv * 0.23 + vec2(19.1, 7.3) - windBasis * (warpT * 0.07));
  float lf2 = fbmNoise(streakUv * 0.23 + vec2(3.7, 23.9) - windPerp  * (warpT * 0.04));
  uv += (windBasis * lf1 + windPerp * lf2) * clamp(uWaveWarpLargeStrength, 0.0, 1.0);
  float n1 = fbmNoise((uv * 2.1) + vec2(13.7, 9.2) - windBasis * (warpT * 0.11));
  float n2 = fbmNoise((uv * 2.1) + vec2(41.3, 27.9) - windPerp  * (warpT * 0.06));
  uv += (windBasis * n1 + windPerp * n2) * clamp(uWaveWarpSmallStrength, 0.0, 1.0);
  float n3 = fbmNoise(uv * 4.7 + vec2(7.9, 19.1) - windBasis * (warpT * 0.15));
  float n4 = fbmNoise(uv * 4.7 + vec2(29.4, 3.3) - windPerp  * (warpT * 0.05));
  uv += (windBasis * n3 + windPerp * n4) * clamp(uWaveWarpMicroStrength, 0.0, 1.0);
  return uv;
}

float waveSeaState(vec2 sceneUv, float motion01) {
  if (uWaveEvolutionEnabled < 0.5) return 0.5;
  float sp = max(0.0, uWaveEvolutionSpeed) * clamp(motion01, 0.0, 1.0);
  float sc = max(0.01, uWaveEvolutionScale);
  // Sample spatially-varying noise to break up the evolution into patches.
  // Use uWindTime so the pattern only advances with wind, never reverses.
  float n = fbmNoise(sceneUv * sc + vec2(uWindTime * sp * 0.23, -uWindTime * sp * 0.19));
  // Map each pixel's noise to a slowly-crawling phase, then use a smooth periodic
  // envelope. This keeps modulation non-negative while removing cusp-like seam bands.
  float phase = fract(uWindTime * sp * 0.05 + n);
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
  if (i == 1) return 0.37;
  if (i == 2) return -0.41;
  if (i == 3) return 0.73;
  return -0.85;
}

float waveWavelengthMul(int i) {
  if (i == 0) return 1.00;
  if (i == 1) return 0.61;
  if (i == 2) return 0.37;
  if (i == 3) return 0.22;
  return 0.13;
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

vec3 calculateWaveForWind(vec2 sceneUv, float t, float motion01, vec2 windDirInput) {
  float sceneAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
  
  vec2 windBasis = safeNormalize2(windDirInput);
  if (dot(windBasis, windBasis) < 1e-6) windBasis = vec2(1.0, 0.0);

  float travelRot = (uLockWaveTravelToWind > 0.5) ? 0.0 : uWaveDirOffsetRad;
  vec2 wind = rotate2D(windBasis, travelRot);
  windBasis = safeNormalize2(wind);

  float m01 = clamp(motion01, 0.0, 1.0);
  float sea01 = waveSeaState(sceneUv, motion01);
  float evoAmt = clamp(uWaveEvolutionAmount, 0.0, 1.0);
  float evo = mix(1.0 - evoAmt, 1.0 + evoAmt, sea01);

  float baseWavelength = mix(3.0, 12.0, m01);
  float directionalSpread = mix(0.9, 0.3, m01);
  
  // CRITICAL: Max global steepness must stay strictly below 1.0 or the wave will loop 
  // onto itself, causing infinite gradients, shaking, and surface intersection.
  float globalSteepness = clamp(mix(0.3, 0.85, m01) * evo, 0.01, 0.95);

  // Apply domain warping to base UV to retain organic shape
  // warpUv gives a slowly drifting offset based on uWindTime
  vec2 uv = warpUv(sceneUv, motion01) * max(0.01, uWaveScale);
  uv = vec2(uv.x * sceneAspect, uv.y);

  float totalH = 0.0;
  vec2 totalDxy = vec2(0.0);
  float totalDz = 0.0;

  const int WAVE_COUNT = 5;
  
  // Calculate normalization sum so total steepness across all octaves == globalSteepness
  float steepnessSum = 0.0;
  for (int i = 0; i < WAVE_COUNT; i++) {
    steepnessSum += pow(0.75, float(i));
  }

  for (int i = 0; i < WAVE_COUNT; i++) {
    float octave = float(i);
    float angle = waveAngleOffsetSeed(i) * directionalSpread;
    float wavelength = max(0.08, baseWavelength * waveWavelengthMul(i));
    
    // Distribute strict steepness budget 
    float steepnessWeight = pow(0.75, octave) / steepnessSum;
    float steepness = globalSteepness * steepnessWeight;
    
    vec2 dir = rotate2D(windBasis, angle);
    
    // Pseudo-random phase offset to break repetitive grid patterns
    float phaseOffset = fract(sin(octave * 12.9898) * 43758.5453) * 6.2831853;

    vec4 w = gerstnerWave(uv, dir, wavelength, steepness, t, phaseOffset);
    
    totalH += w.x;
    totalDxy += w.yz;
    totalDz += w.w;
  }

  // Calculate sharp slopes safely
  float pinch = max(0.05, 1.0 - totalDz);
  vec2 slope = totalDxy / pinch;

  return vec3(totalH, slope.x, slope.y);
}

vec2 waveDetailPerturbGrad(vec2 sceneUv, float motion01, vec2 windDirInput) {
  float m01 = clamp(motion01, 0.0, 1.0);
  float sceneAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
  vec2 wind = safeNormalize2(windDirInput);
  if (dot(wind, wind) < 1e-6) wind = vec2(1.0, 0.0);
  vec2 windBasis = normalize(vec2(wind.x * sceneAspect, wind.y));
  vec2 windPerp = vec2(-windBasis.y, windBasis.x);
  vec2 basis = vec2(sceneUv.x * sceneAspect, sceneUv.y);
  vec2 detailG = vec2(0.0);

  float breakupStrength = clamp(uWaveBreakupStrength, 0.0, 1.0);
  float breakupDist = clamp(uWaveBreakupDistortionStrength, 0.0, 1.0);
  if (breakupStrength > 1e-4 && breakupDist > 1e-4) {
    float bScale = max(0.01, uWaveBreakupScale);
    float bSpeed = max(0.0, uWaveBreakupSpeed) * m01;
    float bWarp = clamp(uWaveBreakupWarp, 0.0, 2.0);
    vec2 bUv = basis * bScale - windBasis * (uWaveTime * bSpeed * 0.11) - windPerp * (uWaveTime * bSpeed * 0.05);
    float bw = valueNoise2D(bUv * 0.17 + vec2(13.1, 9.7)) - 0.5;
    bUv += (windBasis + windPerp * 0.65) * (bw * 0.65 * bWarp);
    float bn1 = valueNoise2D(bUv + vec2(17.3, 5.9));
    float bn2 = valueNoise2D(bUv + vec2(3.1, 29.7));
    vec2 bVec = (vec2(bn1, bn2) - 0.5);
    bVec.x *= sceneAspect;
    float bAmt = clamp(breakupStrength * breakupDist, 0.0, 1.0);
    bAmt = bAmt * (1.15 + 1.85 * bAmt);
    detailG += bVec * (0.95 * bAmt);
  }

  float microStrength = clamp(uWaveMicroNormalStrength, 0.0, 1.0);
  float microDist = clamp(uWaveMicroNormalDistortionStrength, 0.0, 1.0);
  if (microStrength > 1e-4 && microDist > 1e-4) {
    float mScale = max(0.01, uWaveMicroNormalScale);
    float mSpeed = max(0.0, uWaveMicroNormalSpeed) * m01;
    float mWarp = clamp(uWaveMicroNormalWarp, 0.0, 2.0);
    vec2 mUv = basis * mScale - windBasis * (uWaveTime * mSpeed * 0.15) - windPerp * (uWaveTime * mSpeed * 0.07);
    float mw = valueNoise2D(mUv * 0.27 + vec2(41.7, 12.4)) - 0.5;
    mUv += (windPerp + windBasis * 0.4) * (mw * 0.55 * mWarp);
    float mn1 = valueNoise2D(mUv + vec2(7.3, 37.1));
    float mn2 = valueNoise2D(mUv + vec2(29.9, 11.6));
    vec2 mVec = (vec2(mn1, mn2) - 0.5);
    mVec.x *= sceneAspect;
    float mAmt = clamp(microStrength * microDist, 0.0, 1.0);
    mAmt = mAmt * (1.25 + 2.15 * mAmt);
    detailG += mVec * (0.78 * mAmt);
  }

  return detailG;
}

vec3 calculateWave(vec2 sceneUv, float t, float motion01) {
  // Dual-spectrum wind direction blending: evaluate wavefield for the previous
  // and target wind directions and blend height + gradient.
  // This prevents the low-frequency wave domain from “snapping” when wind rotates.
  float s = clamp(uWindDirBlend, 0.0, 1.0);
  if (s < 1e-4) {
    vec3 w = calculateWaveForWind(sceneUv, t, motion01, uPrevWindDir);
    w.yz += waveDetailPerturbGrad(sceneUv, motion01, uPrevWindDir);
    return w;
  }
  if (s > 0.9999) {
    vec3 w = calculateWaveForWind(sceneUv, t, motion01, uTargetWindDir);
    w.yz += waveDetailPerturbGrad(sceneUv, motion01, uTargetWindDir);
    return w;
  }

  vec3 a = calculateWaveForWind(sceneUv, t, motion01, uPrevWindDir);
  vec3 b = calculateWaveForWind(sceneUv, t, motion01, uTargetWindDir);
  vec3 w = mix(a, b, s);
  vec2 blendWind = safeNormalize2(mix(uPrevWindDir, uTargetWindDir, s));
  w.yz += waveDetailPerturbGrad(sceneUv, motion01, blendWind);
  return w;
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
  // Keep wind in Foundry/scene UV space (Y-down).
  vec2 windBasis = normalize(vec2(windF.x * sceneAspect, windF.y));

  float scale = max(0.01, uSpecMicroScale);
  vec2 p = basis * scale - windBasis * (t * 0.12);

  float eps = 0.75;
  float n0 = fbmNoise(p);
  float nx = fbmNoise(p + vec2(eps, 0.0));
  float ny = fbmNoise(p + vec2(0.0, eps));
  vec2 g = vec2(nx - n0, ny - n0) / eps;
  g *= 2.25;
  return g;
}

 // Reuses the pre-computed waveGrad2D result instead of the extremely expensive
 // 4-tap finite difference (which called waveHeight 4 times = 40 wave evaluations).
 // The analytical gradient from calculateWave is mathematically equivalent and
 // visually indistinguishable, but ~40x cheaper.
 vec2 specWaveSlopeFromGrad(vec2 waveGradPre) {
  // waveGradPre is already the analytical dH/dSceneUv from calculateWave.
  // Scale it gently; the caller applies uSpecNormalStrength * uSpecNormalScale.
  return waveGradPre * 2.0;
 }

// ── Flow-aligned specular slope (Mode 4) ────────────────────────────────
// Produces a specular normal field whose dominant direction is always
// windward. Unlike wave-gradient normals (which oscillate due to wave
// interference) or combinedVec (coupled to refractive distortion), this
// field is built from a monotonically-advected FBM domain, so the highlight
// never "boomerangs" even as individual wave crests pass through.
//
// Three-layer construction:
//   L0  Low-freq base flow  — FBM domain advected by uWindOffsetUv (CPU
//       accumulator: always increases along wind, never reverses). Finite
//       differences give a gradient that has a net component pointing in
//       the downwind half-plane on every frame.
//   L1  Mid-freq curl warp  — curl noise over the advected domain adds
//       organic lateral swirl without reversing the dominant direction.
//   L2  High-freq micro     — specMicroSlope2D at low weight for sparkle.
//
// All arithmetic stays in the wind-aligned (windBasis, windPerp) basis so
// per-frame sign changes due to multi-wave interference are eliminated.
vec2 specFlowAlignedSlope2D(vec2 sceneUv, float t) {
  float sceneAspect = (uHasSceneRect > 0.5)
    ? (uSceneRect.z / max(1.0, uSceneRect.w))
    : (uResolution.x / max(1.0, uResolution.y));

  // Wind basis in scene UV space (Y-down, matches CloudEffectV2 convention).
  vec2 windF = uWindDir;
  float wl = length(windF);
  windF = (wl > 1e-6) ? (windF / wl) : vec2(1.0, 0.0);
  vec2 windBasis = normalize(vec2(windF.x * sceneAspect, windF.y));
  vec2 windPerp  = vec2(-windBasis.y, windBasis.x);

  // Aspect-corrected scene position.
  vec2 basis = vec2(sceneUv.x * sceneAspect, sceneUv.y);

  // ── L0: Low-frequency base flow ───────────────────────────────────────
  // Shift the FBM domain by the monotonic CPU-side wind offset.
  // uWindOffsetUv grows strictly in the wind direction, so this domain
  // never reverses — the resulting gradient always has a positive projection
  // onto windBasis.
  //
  // We project the offset onto the wind/perp axes independently so the
  // domain shift is always coherent with the wind frame (avoids arbitrary-
  // angle drift that could partially cancel the base flow).
  float flowScale = max(0.01, uSpecMicroScale * 0.45);
  vec2 windOff = uWindOffsetUv; // monotonic (x,y) in scene-UV units
  float offAlong  = dot(windOff, windBasis);
  float offAcross = dot(windOff, windPerp);
  // Stretch more along wind than across to produce elongated streaks.
  vec2 flowDomain = basis * flowScale
                  - windBasis * (offAlong  * 2.5)
                  - windPerp  * (offAcross * 0.8);

  // Finite-difference gradient of the FBM — gives slope direction.
  // We use a relatively large epsilon so the gradient captures the
  // low-frequency surface tilt rather than noise texture detail.
  float eps0 = 0.55;
  float f0  = fbmNoise(flowDomain);
  float fx0 = fbmNoise(flowDomain + windBasis * eps0);
  float fy0 = fbmNoise(flowDomain + windPerp  * eps0);
  // Gradient in (along, across) space then convert back to sceneUv.
  vec2 gradL0 = vec2((fx0 - f0) / eps0, (fy0 - f0) / eps0);
  // Bias toward wind direction: add a small constant component so the net
  // slope is always partially "downwind" regardless of the noise value.
  // This is the key difference from Mode 1/2: even in calm areas the
  // specular highlight tilts slightly windward instead of sitting flat.
  gradL0 += vec2(0.30, 0.0); // constant downwind component
  // Convert from wind-basis to sceneUv basis.
  vec2 slopeL0 = windBasis * gradL0.x + windPerp * gradL0.y;

  // ── L1: Mid-frequency curl detail ────────────────────────────────────
  // Curl noise over the same advected domain — produces lateral swirl that
  // reads as water surface turbulence. Curl of a scalar field is guaranteed
  // divergence-free, so it adds variation without cancelling the base flow.
  float curlScale = max(0.01, uSpecMicroScale * 1.2);
  // Advance the curl domain with uWindTime (also monotonic) at a slower rate
  // so the swirl patterns evolve smoothly over time.
  vec2 curlDomain = basis * curlScale - windBasis * (t * 0.07) - windPerp * (t * 0.031);
  vec2 curlSlope  = curlNoise2D(curlDomain) * 0.5;

  // ── L2: High-frequency micro sparkle ─────────────────────────────────
  // The existing specMicroSlope2D is kept at low weight so individual sun
  // sparkles remain on the surface. It already uses uWindTime monotonically.
  vec2 microSlope = specMicroSlope2D(sceneUv, t) * 0.25;

  // ── Combine ───────────────────────────────────────────────────────────
  // L0 dominates (sets the windward "tilt"), L1 adds swirl, L2 adds sparkle.
  vec2 combined = slopeL0 * 0.65 + curlSlope * 0.25 + microSlope * 0.10;
  return combined;
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
float getShaderFlecks(vec2 sceneUv, float inside, float shore, float rainAmt, vec2 rainOffPx) {
  if (uFoamFlecksIntensity < 0.01) return 0.0;
  float sceneAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
  vec2 windF = uWindDir; float windLen = length(windF);
  windF = (windLen > 1e-6) ? (windF / windLen) : vec2(1.0, 0.0);
  vec2 windDir = vec2(windF.x, windF.y);
  vec2 windBasis = normalize(vec2(windDir.x * sceneAspect, windDir.y));
  float tWind = uWindTime;
  float fleckSpeed = uShoreFoamSpeed * 2.5 + 0.15;
  vec2 fleckOffset = windBasis * (tWind * fleckSpeed);
  vec2 foamWindOffsetUv = uWindOffsetUv;
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
float getShaderFlecks(vec2 sceneUv, float inside, float shore, float rainAmt, vec2 rainOffPx) { return 0.0; }
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
void getFoamData(vec2 sceneUv, float shore, float inside, vec2 rainOffPx, vec2 waveGradPre, float sceneLuma, float darkness, out float shoreFoamOut, out FloatingFoamData floatingOut) {
  vec2 foamWindOffsetUv = uWindOffsetUv;
  vec2 foamSceneUv = sceneUv - (foamWindOffsetUv * 0.5);
  float sceneAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
  vec2 foamBasis = vec2(foamSceneUv.x * sceneAspect, foamSceneUv.y);
  vec2 windF = uWindDir; float windLen = length(windF);
  windF = (windLen > 1e-6) ? (windF / windLen) : vec2(1.0, 0.0);
  vec2 windDir = vec2(windF.x, windF.y);
  vec2 windBasis = normalize(vec2(windDir.x * sceneAspect, windDir.y));
  float tWind = uWindTime;

  // ═══════════════════════════════════════════════════════════════════════════
  // NEW ADVANCED SHORE FOAM SYSTEM (based on floating foam techniques)
  // ═══════════════════════════════════════════════════════════════════════════
  
  float shoreFoamAmount = 0.0;
  
  if (uShoreFoamEnabled > 0.5 && uShoreFoamStrength > 0.01) {
    // Base UV for shore foam
    vec2 shoreUv = foamBasis * max(0.1, uShoreFoamScale);
    shoreUv -= windBasis * (tWind * uShoreFoamSpeed);
    
    // Enhanced wave distortion
    float waveDistortStr = clamp(uShoreFoamWaveDistortionStrength, 0.0, 5.0);
    shoreUv += waveGradPre * waveDistortStr * 0.15;
    vec2 texel = 1.0 / max(uResolution, vec2(1.0));
    vec2 rainUv = rainOffPx * texel;
    vec2 rainBasis = vec2(rainUv.x * sceneAspect, rainUv.y);
    shoreUv += rainBasis * waveDistortStr * 0.1;
    
    // Random noise distortion for organic movement
    if (uShoreFoamNoiseDistortionEnabled > 0.5 && uShoreFoamNoiseDistortionStrength > 0.01) {
      float noiseDistStr = clamp(uShoreFoamNoiseDistortionStrength, 0.0, 2.0);
      float noiseDistScale = max(0.1, uShoreFoamNoiseDistortionScale);
      float noiseDistSpeed = max(0.0, uShoreFoamNoiseDistortionSpeed);
      
      vec2 noiseUv = foamBasis * noiseDistScale;
      float noiseTime = tWind * noiseDistSpeed;
      
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
    
    // Temporal evolution
    vec2 shoreEvolUv = shoreUv;
    if (uShoreFoamEvolutionEnabled > 0.5 && uShoreFoamEvolutionAmount > 0.01) {
      float evolSpeed = max(0.0, uShoreFoamEvolutionSpeed);
      float evolScale = max(0.1, uShoreFoamEvolutionScale);
      float evolAmount = clamp(uShoreFoamEvolutionAmount, 0.0, 1.0);
      
      float evolTime = tWind * evolSpeed * 0.1;
      
      vec2 evolWarpUv = foamBasis * evolScale;
      float sew1 = valueNoise(evolWarpUv + vec2(evolTime, 0.0));
      float sew2 = valueNoise(evolWarpUv + vec2(0.0, evolTime) + 19.3);
      float sew3 = valueNoise(evolWarpUv * 1.7 + vec2(evolTime * 0.7, evolTime * 0.7) + 37.7);
      
      vec2 evolWarp = vec2(
        (sew1 - 0.5) * 0.5 + (sew3 - 0.5) * 0.3,
        (sew2 - 0.5) * 0.5 + (sew3 - 0.5) * 0.3
      );
      
      shoreEvolUv = mix(shoreUv, shoreUv + evolWarp, evolAmount);
    }
    
    // Base foam pattern
    float sc1 = valueNoise(shoreEvolUv);
    float sc2 = valueNoise(shoreEvolUv * 2.1 + 7.3);
    float shoreBase = sc1 * 0.7 + sc2 * 0.3;
    
    // Complexity layers
    float complexShore = shoreBase;
    
    // Thickness variation
    if (uShoreFoamThicknessVariation > 0.01) {
      float thickScale = max(0.1, uShoreFoamThicknessScale);
      float sthick1 = valueNoise(shoreEvolUv * thickScale);
      float sthick2 = valueNoise(shoreEvolUv * thickScale * 2.3 + 5.7);
      float thickness = sthick1 * 0.6 + sthick2 * 0.4;
      thickness = mix(1.0, thickness, clamp(uShoreFoamThicknessVariation, 0.0, 1.0));
      complexShore *= thickness;
    }
    
    // Filaments and tendrils
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
    
    // Edge detail
    if (uShoreFoamEdgeDetail > 0.01) {
      float edgeScale = max(0.1, uShoreFoamEdgeDetailScale);
      float sedge1 = valueNoise(shoreEvolUv * edgeScale * 3.0);
      float sedge2 = valueNoise(shoreEvolUv * edgeScale * 7.0 + 11.9);
      float edgeNoise = sedge1 * 0.6 + sedge2 * 0.4;
      
      float edgeStr = clamp(uShoreFoamEdgeDetail, 0.0, 1.0);
      float edgeOffset = (edgeNoise - 0.5) * edgeStr * 0.3;
      complexShore = clamp(complexShore + edgeOffset, 0.0, 1.0);
    }
    
    // Distance-based coverage (core and tail)
    float distNormalized = clamp(shore / max(0.01, uShoreFoamThreshold), 0.0, 1.0);
    
    // Core: solid foam at shoreline
    float coreWidth = clamp(uShoreFoamCoreWidth, 0.01, 1.0);
    float coreFalloff = max(0.01, uShoreFoamCoreFalloff);
    float coreMask = smoothstep(coreWidth + coreFalloff, coreWidth, distNormalized);
    
    // Tail: textured foam extending inland
    float tailWidth = clamp(uShoreFoamTailWidth, 0.01, 1.0);
    float tailFalloff = max(0.01, uShoreFoamTailFalloff);
    float tailMask = smoothstep(tailWidth + tailFalloff, 0.0, distNormalized);
    
    // Combine core (solid) and tail (textured)
    float coreFoam = coreMask;
    float tailFoam = complexShore * tailMask;
    
    shoreFoamAmount = clamp(max(coreFoam, tailFoam), 0.0, 1.0);
    shoreFoamAmount *= inside * max(0.0, uShoreFoamStrength);
  }

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
  
  // Brightness/Contrast/Gamma adjustments
  float foamBright = clamp(uFloatingFoamBrightness, -1.0, 1.0);
  float foamContrast = max(0.0, uFloatingFoamContrast);
  float foamGamma = max(0.01, uFloatingFoamGamma);
  
  floatingBase = clamp(floatingBase + foamBright, 0.0, 1.0);
  floatingBase = (floatingBase - 0.5) * foamContrast + 0.5;
  floatingBase = pow(clamp(floatingBase, 0.0, 1.0), foamGamma);
  
  // Lighting calculation (applied AFTER opacity blending for proper darkness)
  float lightFactor = 1.0;
  float darkScale = 1.0;
  if (uFloatingFoamLightingEnabled > 0.5) {
    float ambient = clamp(uFloatingFoamAmbientLight, 0.0, 1.0);
    float sceneInfluence = clamp(uFloatingFoamSceneLightInfluence, 0.0, 1.0);
    float darkResponse = clamp(uFloatingFoamDarknessResponse, 0.0, 1.0);
    
    // Scene lighting contribution
    float sceneLit = smoothstep(0.02, 0.35, sceneLuma);
    sceneLit = mix(ambient, 1.0, sceneLit);
    
    // Darkness response - much stronger at night (0.05 instead of 0.25)
    darkScale = mix(1.0, 0.05, darkness * darkResponse);
    
    lightFactor = sceneLit * sceneInfluence + ambient * (1.0 - sceneInfluence);
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
  floatingOut.color = foamColor;
  floatingOut.opacity = opacity;
  floatingOut.shadowStrength = shadowStr;
  floatingOut.lightFactor = lightFactor;
  floatingOut.darkScale = darkScale;
}

// ── Murk (subsurface silt/algae) ─────────────────────────────────────────
vec3 applyMurk(vec2 sceneUv, float t, float inside, float shore, float outdoorStrength, vec3 baseColor, out float murkFactorOut) {
  murkFactorOut = 0.0;
  if (uMurkEnabled < 0.5) return baseColor;
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
  float waveMotion01 = clamp(uWaveMotion01, 0.0, 1.0);
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
    if (d < 6.5) { float wv = 0.5 + 0.5 * waveHeight(sceneUv, uWaveTime, waveMotion01); gl_FragColor = vec4(vec3(wv), 1.0); return; }
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
  vec2 waveGrad = waveGrad2D(sceneUv, uWaveTime, waveMotion01);
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
  
  // Apply a mild power curve to distortionPx to boost strong distortion while
  // keeping low settings subtle.
  float distortionPx = uDistortionStrengthPx * 1.5;
  
  vec2 combinedVec = waveGrad * waveStrength + flowN * 0.35;
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

  if (uChromaticAberrationEnabled > 0.5) {
    vec2 texel2 = 1.0 / max(uResolution, vec2(1.0));
    float caPxBase = clamp(uChromaticAberrationStrengthPx, 0.0, 12.0);
    float caThresh = clamp(uChromaticAberrationThreshold, 0.0, 1.0);
    float caSoft = max(0.001, uChromaticAberrationThresholdSoftness);
    float lumBase = msLuminance(refracted.rgb);
    float caLumaGate = smoothstep(caThresh - caSoft, caThresh + caSoft, lumBase);
    vec2 dir = offsetUv; float dirLen = length(dir);
    vec2 dirN = (dirLen > 1e-6) ? (dir / dirLen) : vec2(1.0, 0.0);
    vec2 perpN = vec2(-dirN.y, dirN.x);

    // Gate CA by shoreline mask + luminance threshold. Keep it independent from
    // distortion edge masking so CA controls still work when refraction settings
    // are dialed low or multi-tap is disabled.
    float caEdgeMask = chromaticInsideFromSdf(sdf01) * caLumaGate;
    float caPx = caPxBase * caEdgeMask;
    float spread = clamp(uChromaticAberrationSampleSpread, 0.25, 3.0);
    float kawasePx = clamp(uChromaticAberrationKawaseBlurPx, 0.0, 8.0);

    vec2 caUv = dirN * (caPx * texel2) * zoom;
    vec2 axisBlurUv = dirN * (kawasePx * texel2) * spread * zoom;
    vec2 perpBlurUv = perpN * (kawasePx * texel2) * spread * zoom;

    vec2 uvR = clamp(uv1 + caUv, vec2(0.001), vec2(0.999));
    vec2 uvB = clamp(uv1 - caUv, vec2(0.001), vec2(0.999));

    float vR0 = refractTapValid(uvR);
    float vR1 = refractTapValid(clamp(uvR + axisBlurUv, vec2(0.001), vec2(0.999)));
    float vR2 = refractTapValid(clamp(uvR - axisBlurUv, vec2(0.001), vec2(0.999)));
    float vR3 = refractTapValid(clamp(uvR + perpBlurUv, vec2(0.001), vec2(0.999)));
    float vR4 = refractTapValid(clamp(uvR - perpBlurUv, vec2(0.001), vec2(0.999)));

    float vB0 = refractTapValid(uvB);
    float vB1 = refractTapValid(clamp(uvB + axisBlurUv, vec2(0.001), vec2(0.999)));
    float vB2 = refractTapValid(clamp(uvB - axisBlurUv, vec2(0.001), vec2(0.999)));
    float vB3 = refractTapValid(clamp(uvB + perpBlurUv, vec2(0.001), vec2(0.999)));
    float vB4 = refractTapValid(clamp(uvB - perpBlurUv, vec2(0.001), vec2(0.999)));

    float rW0 = 0.34 * vR0;
    float rW1 = 0.165 * vR1;
    float rW2 = 0.165 * vR2;
    float rW3 = 0.165 * vR3;
    float rW4 = 0.165 * vR4;
    float bW0 = 0.34 * vB0;
    float bW1 = 0.165 * vB1;
    float bW2 = 0.165 * vB2;
    float bW3 = 0.165 * vB3;
    float bW4 = 0.165 * vB4;

    float rSum = max(1e-5, rW0 + rW1 + rW2 + rW3 + rW4);
    float bSum = max(1e-5, bW0 + bW1 + bW2 + bW3 + bW4);

    float r0 = (vR0 > 0.5) ? texture2D(tDiffuse, uvR).r : refracted.r;
    float r1 = (vR1 > 0.5) ? texture2D(tDiffuse, clamp(uvR + axisBlurUv, vec2(0.001), vec2(0.999))).r : refracted.r;
    float r2 = (vR2 > 0.5) ? texture2D(tDiffuse, clamp(uvR - axisBlurUv, vec2(0.001), vec2(0.999))).r : refracted.r;
    float r3 = (vR3 > 0.5) ? texture2D(tDiffuse, clamp(uvR + perpBlurUv, vec2(0.001), vec2(0.999))).r : refracted.r;
    float r4 = (vR4 > 0.5) ? texture2D(tDiffuse, clamp(uvR - perpBlurUv, vec2(0.001), vec2(0.999))).r : refracted.r;

    float b0 = (vB0 > 0.5) ? texture2D(tDiffuse, uvB).b : refracted.b;
    float b1 = (vB1 > 0.5) ? texture2D(tDiffuse, clamp(uvB + axisBlurUv, vec2(0.001), vec2(0.999))).b : refracted.b;
    float b2 = (vB2 > 0.5) ? texture2D(tDiffuse, clamp(uvB - axisBlurUv, vec2(0.001), vec2(0.999))).b : refracted.b;
    float b3 = (vB3 > 0.5) ? texture2D(tDiffuse, clamp(uvB + perpBlurUv, vec2(0.001), vec2(0.999))).b : refracted.b;
    float b4 = (vB4 > 0.5) ? texture2D(tDiffuse, clamp(uvB - perpBlurUv, vec2(0.001), vec2(0.999))).b : refracted.b;

    float rChannel = (r0 * rW0 + r1 * rW1 + r2 * rW2 + r3 * rW3 + r4 * rW4) / rSum;
    float bChannel = (b0 * bW0 + b1 * bW1 + b2 * bW2 + b3 * bW3 + b4 * bW4) / bSum;
    refracted.rgb = vec3(rChannel, refracted.g, bChannel);
  }

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

  // Foam (pass pre-computed waveGrad to avoid redundant calculateWave call)
  float sceneLuma = dot(col, vec3(0.299, 0.587, 0.114));
  float darkness = clamp(uSceneDarkness, 0.0, 1.0);
  
  float shoreFoamAmount;
  FloatingFoamData floatingFoam;
  getFoamData(sceneUv, shore, inside, rainOffPx, waveGrad, sceneLuma, darkness, shoreFoamAmount, floatingFoam);
  
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
    getFoamData(shadowUv, shore, inside, rainOffPx, waveGrad, sceneLuma, darkness, shoreFoamShadow, shadowFoam);
    
    float shadowDarken = shadowFoam.amount * floatingFoam.shadowStrength;
    col *= (1.0 - shadowDarken);
  }
  
  // Shore foam rendering (NEW ADVANCED SYSTEM)
  if (shoreFoamAmount > 0.01) {
    // Color processing
    vec3 shoreFoamColor = uShoreFoamColor;
    
    // Apply tint
    if (uShoreFoamTintStrength > 0.01) {
      float tintStr = clamp(uShoreFoamTintStrength, 0.0, 1.0);
      shoreFoamColor = mix(shoreFoamColor, uShoreFoamTint, tintStr);
    }
    
    // Color variation
    if (uShoreFoamColorVariation > 0.01) {
      vec2 colorVarUv = sceneUv * 3.0 + vec2(uWindTime * 0.05);
      float colorVar = valueNoise(colorVarUv);
      float varAmount = clamp(uShoreFoamColorVariation, 0.0, 1.0);
      shoreFoamColor = mix(shoreFoamColor, shoreFoamColor * (0.8 + colorVar * 0.4), varAmount);
    }
    
    // Brightness, contrast, gamma
    float brightness = clamp(uShoreFoamBrightness, 0.0, 2.0);
    float contrast = clamp(uShoreFoamContrast, 0.0, 2.0);
    float gamma = max(0.1, uShoreFoamGamma);
    
    shoreFoamColor = shoreFoamColor * brightness;
    shoreFoamColor = ((shoreFoamColor - 0.5) * contrast) + 0.5;
    shoreFoamColor = pow(max(shoreFoamColor, vec3(0.0)), vec3(gamma));
    shoreFoamColor = clamp(shoreFoamColor, vec3(0.0), vec3(1.0));
    
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
    
    // Opacity and blending
    float shoreOpacity = clamp(uShoreFoamOpacity, 0.0, 1.0);
    float shoreAlpha = clamp(shoreFoamAmount * shoreOpacity, 0.0, 1.0);
    
    // Blend foam color first
    col = mix(col, shoreFoamColor, shoreAlpha);
    // THEN apply darkness for proper night darkening
    col *= shoreDarkScale;
  }
  
  // Apply floating foam with independent color and FULL opacity control
  if (floatingFoam.amount > 0.01) {
    float floatingAlpha = clamp(floatingFoam.amount * floatingFoam.opacity, 0.0, 1.0);
    // Blend foam color first (without darkness)
    col = mix(col, floatingFoam.color, floatingAlpha);
    // THEN apply darkness to the final result for proper night darkening
    col *= floatingFoam.darkScale;
  }

  // Shader flecks (drive by combined foam presence)
  float fleckDriver = clamp(max(shoreFoamAmount, floatingFoam.amount), 0.0, 1.0);
  float shaderFlecks = getShaderFlecks(sceneUv, inside, shore, fleckDriver, rainOffPx);
  vec3 fleckCol = mix(uShoreFoamColor, floatingFoam.color, clamp(floatingFoam.amount, 0.0, 1.0));
  col += fleckCol * shaderFlecks * 0.8;

  // Apply screen-space cloud shadows globally to water + foam + caustics + murk
  col *= max(0.0, 1.0 - cloudDarken);

  // Specular (GGX)
  vec2 slope;
  if (uSpecNormalMode > 3.5) {
    // Mode 4 (default): flow-aligned slope.
    // Built from a monotonically-advected FBM domain (uWindOffsetUv) so the
    // dominant highlight direction is always windward and never ping-pongs.
    // curl noise adds organic lateral swirl; specMicroSlope2D adds sparkle.
    slope = specFlowAlignedSlope2D(sceneUv, uWindTime) * clamp(uSpecNormalStrength, 0.0, 10.0);
    slope *= clamp(uSpecNormalScale, 0.0, 1.0);
  } else if (uSpecNormalMode > 2.5) {
    // Mode 3: use the stabilized distortion vector as the specular slope.
    // This is intentionally coupled to the same field that drives refraction,
    // and avoids the problematic wave normal/height gradients.
    slope = combinedVec * (0.90 * clamp(uSpecNormalStrength, 0.0, 10.0));
    slope *= clamp(uSpecNormalScale, 0.0, 1.0);
  } else if (uSpecNormalMode > 1.5) {
    // Mode 2: wave slope from analytical gradient. Reuses the waveGrad already
    // computed for distortion — eliminates the old 4-tap finite difference that
    // called waveHeight 4 times (= 40 wave evaluations per pixel).
    slope = specWaveSlopeFromGrad(waveGrad) * clamp(uSpecNormalStrength, 0.0, 10.0);
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

  // Sun elevation falloff: reduce specular at low sun angles (dawn/dusk)
  if (uSpecSunElevationFalloffEnabled > 0.5 && uSpecUseSunAngle > 0.5) {
    // Extract sun elevation from uSpecSunDir.z (normalized, so Z is sin(elevation))
    float sunElevationRad = asin(clamp(uSpecSunDir.z, -1.0, 1.0));
    float sunElevationDeg = sunElevationRad * 57.2957795; // rad to deg
    
    float falloffStart = clamp(uSpecSunElevationFalloffStart, 0.0, 90.0);
    float falloffEnd = clamp(uSpecSunElevationFalloffEnd, 0.0, 90.0);
    float falloffCurve = max(0.1, uSpecSunElevationFalloffCurve);
    
    // Ensure start > end for proper falloff range
    float rangeStart = max(falloffStart, falloffEnd + 0.1);
    float rangeEnd = min(falloffEnd, falloffStart - 0.1);
    
    // Smoothstep from full specular (above start) to zero (below end)
    float elevationFactor = smoothstep(rangeEnd, rangeStart, sunElevationDeg);
    elevationFactor = pow(elevationFactor, falloffCurve);
    
    spec *= elevationFactor;
  }

  // Combined shadow suppression: cloud, building, and overhead shadows
  float combinedShadow = 0.0;
  
  // Cloud shadow
  if (uCloudShadowEnabled > 0.5 && cloudShadow > 1e-5) {
    combinedShadow = max(combinedShadow, cloudShadow);
  }
  
  // Building shadow (world-space sampled)
  if (uHasBuildingShadow > 0.5) {
    float buildingShadowVal = 1.0 - texture2D(tBuildingShadow, vUv).r;
    combinedShadow = max(combinedShadow, buildingShadowVal);
  }
  
  // Overhead shadow (screen-space sampled)
  if (uHasOverheadShadow > 0.5) {
    float overheadShadowVal = 1.0 - texture2D(tOverheadShadow, vUv).r;
    combinedShadow = max(combinedShadow, overheadShadowVal);
  }
  
  // Apply combined shadow to specular
  if (combinedShadow > 1e-5) {
    float kStrength = clamp(uCloudShadowSpecularKill, 0.0, 1.0);
    float kCurve = max(0.01, uCloudShadowSpecularCurve);
    float litPow = pow(clamp(1.0 - combinedShadow, 0.0, 1.0), kCurve);
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
