/**
 * @fileoverview V2 Window Light Effect — scene-UV compositor masks (PaintedShadow-style).
 *
 * Window glow is sampled from GpuSceneMaskCompositor `_Windows` / `_Structural`
 * masks in Foundry scene UV space (same placement as PaintedShadowEffectV2).
 * Per-floor stacking uses compositor floor-id + per-band mask slots 0–3.
 *
 * Emit pass renders into a scene-UV RT (mask resolution, PaintedShadow-style).
 * Lighting compose applies token-style `litColor *= (1 + win)` so glow brightens
 * albedo without flat additive wash (matches token-manager window light path).
 *
 * @module compositor-v2/effects/WindowLightEffectV2
 */

import { createLogger } from '../../core/log.js';
import { resolveCompositorLightningFlash01 } from '../lightning/resolve-compositor-lightning-flash.js';
import { LightingDirector } from '../../core/LightingDirector.js';
import { weatherController } from '../../core/WeatherController.js';
import {
  DEFAULT_TOD_ANCHOR_HOURS,
  readColorCorrectionParamsFromUi,
  TOD_ANCHOR_META,
} from '../../core/tod-anchor-spec.js';
import {
  clamp,
  evaluateTodTimeline,
  isTimelineEnabledParam,
  makeTodGrade,
  neutralTodGrade,
  normalizeTintMultiplier,
  TOD_ANCHOR_COUNT,
  TOD_TINT_MAX,
  TOD_TINT_MIN,
  TOD_TINT_NEUTRAL,
  wrapHour24,
} from '../../core/tod-timeline.js';
import { loadAssetBundle, loadTexture, probeMaskFile } from '../../assets/loader.js';
import { getMaskTextureManifest, maskTextureManifestMatchesLoadContext } from '../../settings/mask-manifest-flags.js';
import { resolveCompositorFloorMaskTexture } from '../../masks/resolve-compositor-outdoors.js';
import { getViewedLevelBackgroundSrc } from '../../foundry/levels-scene-flags.js';
import {
  applySceneViewProjectionToUniforms,
  createSceneViewProjectionCache,
  updateSceneViewProjectionFromCamera,
} from '../scene-view-projection.js';
import { allocateRtReadbackBuffer, decodeReadbackPixel } from '../../utils/rt-pixel-readback.js';

const log = createLogger('WindowLightEffectV2');

const WINDOW_MASK_ALIASES = ['windows', 'structural'];
const SPECULAR_MASK_ALIASES = ['specular'];

/** Scale emit RT values for compose `litColor *= (1 + win)` — not display albedo. */
const WINDOW_ILLUM_SCALE = 0.22;

/** Matches GpuSceneMaskCompositor scalar mask tier (windows / structural). */
const SCENE_MASK_EMIT_MAX = 4096;

const wlTodTintSliderKeys = (index) => ({
  r: `tod${index}TintR`,
  g: `tod${index}TintG`,
  b: `tod${index}TintB`,
  color: `tod${index}TintColor`,
});

/**
 * Per-anchor window-light grade (tod0..tod7). Bold chroma + tints mirroring Camera Grade day/night.
 * @type {ReadonlyArray<{ intensityScale: number, exposure: number, saturation: number, tintColor: { r: number, g: number, b: number } }>}
 */
const DEFAULT_WINDOW_LIGHT_TOD_ANCHORS = Object.freeze([
  { intensityScale: 1.05, exposure: 0.15, saturation: 1.85, tintColor: { r: 0.6, g: 0.75, b: 3 } },
  { intensityScale: 0.95, exposure: 0.05, saturation: 1.55, tintColor: { r: 1.4, g: 0.85, b: 2.3 } },
  { intensityScale: 1.25, exposure: 0.25, saturation: 1.75, tintColor: { r: 3, g: 1.15, b: 0.85 } },
  { intensityScale: 1.15, exposure: 0.2, saturation: 1.65, tintColor: { r: 1.45, g: 1.2, b: 0.95 } },
  { intensityScale: 1.1, exposure: 0.15, saturation: 1.55, tintColor: { r: 0.8, g: 0.95, b: 1.35 } },
  { intensityScale: 1.12, exposure: 0.12, saturation: 1.6, tintColor: { r: 1.3, g: 1.05, b: 1.0 } },
  { intensityScale: 1.28, exposure: 0.3, saturation: 1.8, tintColor: { r: 3, g: 1.2, b: 0.9 } },
  { intensityScale: 1.0, exposure: 0.1, saturation: 1.78, tintColor: { r: 0.65, g: 0.7, b: 2.15 } },
]);

/** Baseline window-light params (prismatic glass + timeline on by default). */
const WINDOW_LIGHT_CORE_DEFAULTS = Object.freeze({
  enabled: true,
  intensity: 12.85,
  falloff: 1,
  color: { r: 1, g: 1, b: 1 },
  cloudInfluence: 1,
  cloudShadowContrast: 4,
  cloudShadowBias: -1,
  cloudShadowGamma: 4,
  cloudShadowMinLight: 0,
  glassRefractionEnabled: true,
  rgbShiftAmount: 5.88,
  rgbShiftAngle: 30,
  rgbShiftSpread: 0.35,
  rgbShiftEdgeWeight: 0.55,
  rgbFringeSaturation: 1.35,
  rgbFringeBalance: { r: 1, g: 1, b: 1 },
  rgbShiftAnimate: true,
  rgbShiftAnimSpeed: 0.45,
  rgbShiftAnimWobbleDeg: 28,
  specularBoost: 2,
  sparkleEnabled: true,
  sparkleStrength: 1.35,
  sparkleSpeed: 1.2,
  sparkleScale: 38,
  sparkleThreshold: 0.12,
  sparkleEdgeBias: 0.72,
  sparkleColor: { r: 1, g: 0.98, b: 0.92 },
  lightningWindowEnabled: true,
  lightningWindowIntensityBoost: 5,
  lightningWindowContrastBoost: 4,
  lightningWindowRgbBoost: 3,
  todTimelineEnabled: true,
  useCameraGradeAnchorHours: true,
});

/** @returns {Record<string, *>} */
const buildDefaultWindowLightTodParams = () => {
  const out = {
    todTimelineEnabled: WINDOW_LIGHT_CORE_DEFAULTS.todTimelineEnabled,
    useCameraGradeAnchorHours: WINDOW_LIGHT_CORE_DEFAULTS.useCameraGradeAnchorHours,
  };
  for (let i = 0; i < TOD_ANCHOR_COUNT; i += 1) {
    const anchor = DEFAULT_WINDOW_LIGHT_TOD_ANCHORS[i];
    out[`tod${i}Hour`] = DEFAULT_TOD_ANCHOR_HOURS[i] ?? 0;
    out[`tod${i}IntensityScale`] = anchor.intensityScale;
    out[`tod${i}Exposure`] = anchor.exposure;
    out[`tod${i}Saturation`] = anchor.saturation;
    out[`tod${i}TintR`] = anchor.tintColor.r;
    out[`tod${i}TintG`] = anchor.tintColor.g;
    out[`tod${i}TintB`] = anchor.tintColor.b;
  }
  return out;
};

const EMIT_CLOUD_GLSL = /* glsl */`
  vec2 wlSceneUvToWorld(vec2 sceneUv, vec2 sceneOrigin, vec2 sceneSize, vec2 sceneDimensions) {
    vec2 foundryXY = sceneUv * sceneSize + sceneOrigin;
    return vec2(foundryXY.x, sceneDimensions.y - foundryXY.y);
  }

  vec2 wlWorldToScreenUv(vec2 worldXY, vec2 boundsMin, vec2 boundsMax) {
    return clamp((worldXY - boundsMin) / max(boundsMax - boundsMin, vec2(1e-5)), 0.0, 1.0);
  }

  float wlSampleCloudShadowFactor(
    vec2 sceneUv,
    vec2 sceneOrigin,
    vec2 sceneSize,
    vec2 sceneDimensions,
    vec2 boundsMin,
    vec2 boundsMax,
    sampler2D cloudTex,
    float hasCloudTex,
    float contrast,
    float bias,
    float gamma,
    float minLight
  ) {
    if (hasCloudTex < 0.5) return 1.0;
    vec2 worldXY = wlSceneUvToWorld(sceneUv, sceneOrigin, sceneSize, sceneDimensions);
    vec2 screenUv = wlWorldToScreenUv(worldXY, boundsMin, boundsMax);
    float s = clamp(texture2D(cloudTex, screenUv).r, 0.0, 1.0);
    s = clamp((s - 0.5) * max(contrast, 0.0) + 0.5 + bias, 0.0, 1.0);
    s = pow(s, max(gamma, 0.01));
    return max(s, clamp(minLight, 0.0, 1.0));
  }
`;

const WL_REFRACT_GLSL = /* glsl */`
  float wlMaskLuma(vec4 mask, float falloff) {
    vec3 shaped = pow(clamp(mask.rgb, 0.0, 1.0), vec3(max(falloff, 0.001)));
    return dot(shaped, vec3(0.2126, 0.7152, 0.0722)) * mask.a;
  }

  vec4 wlSampleWindowMaskAtFloor(float floorIdx, vec2 sceneUv, vec2 offsetUv) {
    vec2 suv = clamp(sceneUv + offsetUv, 0.0, 1.0);
    vec4 maskOut = vec4(0.0);
    if (floorIdx < 0.5 && uHasWindow0 > 0.5) {
      if (uWindow0FlipY > 0.5) suv.y = 1.0 - suv.y;
      maskOut = texture2D(tWindow0, suv);
    } else if (floorIdx < 1.5 && uHasWindow1 > 0.5) {
      if (uWindow1FlipY > 0.5) suv.y = 1.0 - suv.y;
      maskOut = texture2D(tWindow1, suv);
    } else if (floorIdx < 2.5 && uHasWindow2 > 0.5) {
      if (uWindow2FlipY > 0.5) suv.y = 1.0 - suv.y;
      maskOut = texture2D(tWindow2, suv);
    } else if (floorIdx >= 2.5 && uHasWindow3 > 0.5) {
      if (uWindow3FlipY > 0.5) suv.y = 1.0 - suv.y;
      maskOut = texture2D(tWindow3, suv);
    }
    return maskOut;
  }

  float wlSampleSpecularAtFloor(float floorIdx, vec2 sceneUv) {
    vec2 suv = clamp(sceneUv, 0.0, 1.0);
    float specOut = 0.0;
    if (floorIdx < 0.5 && uHasSpecular0 > 0.5) {
      if (uSpecular0FlipY > 0.5) suv.y = 1.0 - suv.y;
      specOut = texture2D(tSpecular0, suv).r;
    } else if (floorIdx < 1.5 && uHasSpecular1 > 0.5) {
      if (uSpecular1FlipY > 0.5) suv.y = 1.0 - suv.y;
      specOut = texture2D(tSpecular1, suv).r;
    } else if (floorIdx < 2.5 && uHasSpecular2 > 0.5) {
      if (uSpecular2FlipY > 0.5) suv.y = 1.0 - suv.y;
      specOut = texture2D(tSpecular2, suv).r;
    } else if (floorIdx >= 2.5 && uHasSpecular3 > 0.5) {
      if (uSpecular3FlipY > 0.5) suv.y = 1.0 - suv.y;
      specOut = texture2D(tSpecular3, suv).r;
    }
    return specOut;
  }

  float wlMaskEdge(float floorIdx, vec2 sceneUv, vec2 texelSize, float falloff) {
    vec2 t = texelSize;
    float c = wlMaskLuma(wlSampleWindowMaskAtFloor(floorIdx, sceneUv, vec2(0.0)), falloff);
    float l = wlMaskLuma(wlSampleWindowMaskAtFloor(floorIdx, sceneUv, vec2(-t.x, 0.0)), falloff);
    float r = wlMaskLuma(wlSampleWindowMaskAtFloor(floorIdx, sceneUv, vec2(t.x, 0.0)), falloff);
    float d = wlMaskLuma(wlSampleWindowMaskAtFloor(floorIdx, sceneUv, vec2(0.0, -t.y)), falloff);
    float u = wlMaskLuma(wlSampleWindowMaskAtFloor(floorIdx, sceneUv, vec2(0.0, t.y)), falloff);
    return clamp((abs(l - r) + abs(d - u)) * 2.5, 0.0, 1.0);
  }

  vec2 wlHash22(vec2 p) {
    return fract(sin(vec2(
      dot(p, vec2(127.1, 311.7)),
      dot(p, vec2(269.5, 183.3))
    )) * 43758.5453);
  }

  float wlSparklePointAt(vec2 p, vec2 cell, float layerIdx, float timeSlot, float t, float speed, float spawnCut) {
    float spawn = wlHash22(cell + vec2(timeSlot * 19.0 + layerIdx * 47.0, timeSlot * 0.31 + layerIdx * 3.0)).x;
    if (spawn < spawnCut) return 0.0;

    vec2 rnd = wlHash22(cell + vec2(71.2 + layerIdx * 13.0, timeSlot * 23.0 + layerIdx));
    vec2 center = cell + rnd * 0.82 + 0.09;
    float d = length(p - center);
    float core = exp(-d * 30.0);
    float halo = exp(-d * 8.5) * 0.45;
    float peak = core * (1.0 + halo * 2.0);

    float phase = wlHash22(cell + vec2(layerIdx * 5.7, timeSlot * 0.41)).x * 6.2831853;
    float twinkle = 0.5 + 0.5 * sin(t * max(speed, 0.05) * 3.2 + phase);
    return peak * twinkle;
  }

  float wlSparkleLayer(vec2 uvTexel, float cellTexel, float layerIdx, float timeSlot, float t, float speed, float spawnCut) {
    float layerScale = cellTexel * (1.0 + 0.41 * layerIdx);
    vec2 jitter = wlHash22(vec2(layerIdx * 19.3 + timeSlot * 0.17, timeSlot * 0.09 + 4.1)) * cellTexel * 2.5;
    vec2 p = (uvTexel + jitter) / layerScale;
    vec2 baseCell = floor(p);
    float bestPeak = 0.0;
    for (int oy = -1; oy <= 1; oy++) {
      for (int ox = -1; ox <= 1; ox++) {
        vec2 cell = baseCell + vec2(float(ox), float(oy));
        float pt = wlSparklePointAt(p, cell, layerIdx, timeSlot, t, speed, spawnCut);
        bestPeak = max(bestPeak, pt);
      }
    }
    return bestPeak;
  }

  // Random cloud in camera view: density = cells across visible frustum width (not whole map).
  float wlSparklePointField(
    vec2 sceneUv,
    vec2 maskTexelSize,
    float cellScale,
    float t,
    float speed,
    float hasView,
    vec2 viewUvMin,
    vec2 viewUvMax
  ) {
    if (hasView > 0.5) {
      float inView = step(viewUvMin.x, sceneUv.x) * step(viewUvMin.y, sceneUv.y)
                   * step(sceneUv.x, viewUvMax.x) * step(sceneUv.y, viewUvMax.y);
      if (inView < 0.5) return 0.0;
    }

    float cells = max(cellScale, 6.0);
    float mapW = 1.0 / max(maskTexelSize.x, 1e-6);
    float mapH = 1.0 / max(maskTexelSize.y, 1e-6);
    vec2 spanUv = max(viewUvMax - viewUvMin, vec2(1e-4));
    if (hasView < 0.5) spanUv = vec2(1.0);
    vec2 spanTexel = spanUv * vec2(mapW, mapH);
    float cellTexel = max(max(spanTexel.x, spanTexel.y) / cells, 1.0);
    vec2 uvTexel = sceneUv / max(maskTexelSize, vec2(1e-6));
    float spawnCut = mix(0.93, 0.62, clamp(cells / 120.0, 0.0, 1.0));

    float repopRate = max(speed, 0.05) * 0.28;
    float slotT = t * repopRate;
    float timeSlot = floor(slotT);
    float timePrev = max(timeSlot - 1.0, 0.0);
    float slotBlend = smoothstep(0.0, 1.0, fract(slotT));

    float cur = 0.0;
    cur = max(cur, wlSparkleLayer(uvTexel, cellTexel, 0.0, timeSlot, t, speed, spawnCut));
    cur = max(cur, wlSparkleLayer(uvTexel, cellTexel, 1.0, timeSlot, t, speed, spawnCut));
    cur = max(cur, wlSparkleLayer(uvTexel, cellTexel, 2.0, timeSlot, t, speed, spawnCut));

    float prev = 0.0;
    prev = max(prev, wlSparkleLayer(uvTexel, cellTexel, 0.0, timePrev, t, speed, spawnCut));
    prev = max(prev, wlSparkleLayer(uvTexel, cellTexel, 1.0, timePrev, t, speed, spawnCut));
    prev = max(prev, wlSparkleLayer(uvTexel, cellTexel, 2.0, timePrev, t, speed, spawnCut));

    float peak = mix(prev, cur, slotBlend);
    return smoothstep(0.65, 0.9, peak);
  }

  vec3 wlApplyFringeSaturation(vec3 chroma, float satAmt) {
    float luma = dot(chroma, vec3(0.2126, 0.7152, 0.0722));
    vec3 grey = vec3(luma);
    float sat = clamp(satAmt, 0.0, 3.0);
    return max(mix(grey, chroma, sat), vec3(0.0));
  }
`;

/** Full-screen emit pass — scene-UV RT (PaintedShadow / building-shadow project pass pattern). */
// vUv is scene-rect UV (same as compose sceneUvFoundry and mask placement).
const EMIT_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const EMIT_FRAG = `
  uniform float uEffectEnabled;
  uniform float uDebugForceMagenta;
  uniform float uIntensity;
  uniform float uFalloff;
  uniform vec3 uColor;
  uniform float uForcedFloorIndex;
  uniform float uMaxVisibleFloorIndex;
  uniform sampler2D tWindow0;
  uniform sampler2D tWindow1;
  uniform sampler2D tWindow2;
  uniform sampler2D tWindow3;
  uniform float uHasWindow0;
  uniform float uHasWindow1;
  uniform float uHasWindow2;
  uniform float uHasWindow3;
  uniform float uWindow0FlipY;
  uniform float uWindow1FlipY;
  uniform float uWindow2FlipY;
  uniform float uWindow3FlipY;
  uniform sampler2D tSpecular0;
  uniform sampler2D tSpecular1;
  uniform sampler2D tSpecular2;
  uniform sampler2D tSpecular3;
  uniform float uHasSpecular0;
  uniform float uHasSpecular1;
  uniform float uHasSpecular2;
  uniform float uHasSpecular3;
  uniform float uSpecular0FlipY;
  uniform float uSpecular1FlipY;
  uniform float uSpecular2FlipY;
  uniform float uSpecular3FlipY;
  uniform sampler2D tFloorIdTex;
  uniform float uHasFloorIdTex;
  uniform float uFloorIdFlipY;
  uniform vec2 uMaskTexelSize;
  uniform float uTime;
  uniform float uGlassRefractionEnabled;
  uniform float uRgbShiftAmount;
  uniform float uRgbShiftAngle;
  uniform float uRgbShiftSpread;
  uniform float uRgbShiftEdgeWeight;
  uniform float uRgbShiftAnimate;
  uniform float uRgbShiftAnimSpeed;
  uniform float uRgbShiftAnimWobbleDeg;
  uniform float uRgbFringeSaturation;
  uniform vec3 uRgbFringeBalance;
  uniform float uSpecularBoost;
  uniform float uSparkleEnabled;
  uniform float uSparkleStrength;
  uniform float uSparkleSpeed;
  uniform float uSparkleScale;
  uniform float uSparkleThreshold;
  uniform float uSparkleEdgeBias;
  uniform vec3 uSparkleColor;
  uniform float uLightningWindowEnabled;
  uniform float uLightningFlash01;
  uniform float uLightningWindowIntensityBoost;
  uniform float uLightningWindowContrastBoost;
  uniform float uLightningWindowRgbBoost;
  uniform float uCloudFactor;
  uniform float uCloudInfluence;
  uniform sampler2D uCloudShadowTex;
  uniform float uHasCloudShadowTex;
  uniform float uCloudShadowContrast;
  uniform float uCloudShadowBias;
  uniform float uCloudShadowGamma;
  uniform float uCloudShadowMinLight;
  uniform vec2 uViewBoundsMin;
  uniform vec2 uViewBoundsMax;
  uniform float uHasSparkleView;
  uniform vec2 uSparkleViewUvMin;
  uniform vec2 uSparkleViewUvMax;
  uniform vec2 uSceneOrigin;
  uniform vec2 uSceneSize;
  uniform vec2 uSceneDimensions;
  uniform float uTodEnabled;
  uniform float uTodIntensityScale;
  uniform float uTodExposure;
  uniform float uTodSaturation;
  uniform vec3 uTodTint;
  varying vec2 vUv;

  ${EMIT_CLOUD_GLSL}
  ${WL_REFRACT_GLSL}

  vec3 wlApplyTodGrade(vec3 rgb, float enabled, float intensityScale,
                       float exposureStops, float saturation, vec3 tint) {
    if (enabled < 0.5) return rgb;

    float expMul = exp2(clamp(exposureStops, -3.0, 3.0));
    vec3 graded = rgb * (max(intensityScale, 0.0) * expMul);

    vec3 tintClamped = clamp(tint, vec3(0.0), vec3(3.0));
    if (abs(tintClamped.r - 1.0) + abs(tintClamped.g - 1.0) + abs(tintClamped.b - 1.0) > 1e-4) {
      float lumaIn = dot(graded, vec3(0.2126, 0.7152, 0.0722));
      graded *= tintClamped;
      float lumaOut = dot(graded, vec3(0.2126, 0.7152, 0.0722));
      if (lumaOut > 1e-5) {
        graded *= (lumaIn / lumaOut);
      }
    }

    float sat = clamp(saturation, 0.0, 2.0);
    float lumaBefore = dot(graded, vec3(0.2126, 0.7152, 0.0722));
    vec3 chroma = graded - vec3(lumaBefore);
    vec3 saturated = vec3(lumaBefore) + chroma * sat;
    saturated = max(saturated, vec3(0.0));
    float lumaAfter = dot(saturated, vec3(0.2126, 0.7152, 0.0722));
    if (lumaAfter > 1e-5 && lumaBefore > 1e-5) {
      saturated *= (lumaBefore / lumaAfter);
    }
    graded = saturated;

    return min(max(graded, vec3(0.0)), vec3(6.0));
  }

  void main() {
    if (uEffectEnabled < 0.5) {
      gl_FragColor = vec4(0.0);
      return;
    }

    vec2 sceneUv = clamp(vUv, 0.0, 1.0);
    float floorIdx = 0.0;

    if (uForcedFloorIndex >= 0.0) {
      floorIdx = clamp(uForcedFloorIndex, 0.0, 3.0);
    } else if (uHasFloorIdTex > 0.5) {
      vec2 fidUv = sceneUv;
      if (uFloorIdFlipY > 0.5) fidUv.y = 1.0 - fidUv.y;
      floorIdx = floor(texture2D(tFloorIdTex, fidUv).r * 255.0 + 0.5);
      if (floorIdx < 0.0) floorIdx = 0.0;
      if (uMaxVisibleFloorIndex >= 0.0 && floorIdx > uMaxVisibleFloorIndex + 0.5) {
        gl_FragColor = vec4(0.0);
        return;
      }
    }

    vec4 mask = wlSampleWindowMaskAtFloor(floorIdx, sceneUv, vec2(0.0));
    float windowLuma = wlMaskLuma(mask, uFalloff);
    if (mask.a < 0.02 || windowLuma < 0.02) {
      gl_FragColor = vec4(0.0);
      return;
    }

    float flash01 = (uLightningWindowEnabled > 0.5) ? clamp(uLightningFlash01, 0.0, 1.0) : 0.0;
    float flashMul = 1.0 + flash01 * max(uLightningWindowIntensityBoost, 0.0);
    float contrastPow = 1.0 / (1.0 + flash01 * max(uLightningWindowContrastBoost, 0.0));

    float useRefract = (uGlassRefractionEnabled > 0.5 && uRgbShiftAmount > 0.001) ? 1.0 : 0.0;
    float useSparkle = uSparkleEnabled;
    float useSpecular = max(uSpecularBoost, 0.0);

    vec3 lightMap;
    float edgeAmt = wlMaskEdge(floorIdx, sceneUv, uMaskTexelSize, uFalloff);

    if (useRefract > 0.5) {
      float shiftPx = uRgbShiftAmount * (1.0 + flash01 * max(uLightningWindowRgbBoost, 0.0));
      float edgeW = clamp(uRgbShiftEdgeWeight, 0.0, 1.0);
      shiftPx *= mix(1.0, edgeAmt, edgeW);

      float angle = uRgbShiftAngle;
      if (uRgbShiftAnimate > 0.5) {
        float wobbleRad = uRgbShiftAnimWobbleDeg * 0.01745329252;
        float tAnim = uTime * max(uRgbShiftAnimSpeed, 0.01);
        angle += sin(tAnim) * wobbleRad * 1.35;
        angle += sin(tAnim * 1.71 + 0.8) * wobbleRad * 0.62;
        vec2 facetRnd = wlHash22(floor(sceneUv * 24.0));
        angle += (facetRnd.x - 0.5) * wobbleRad * 1.15;
        shiftPx *= 1.0 + 0.18 * sin(tAnim * 0.92 + facetRnd.y * 6.28);
      }

      vec2 shiftDir = vec2(cos(angle), sin(angle));
      float spread = clamp(uRgbShiftSpread, 0.0, 1.0);
      vec2 rOffset = shiftDir * shiftPx * (1.0 + spread) * uMaskTexelSize;
      vec2 bOffset = -shiftDir * shiftPx * (1.0 + spread) * uMaskTexelSize;

      float maskR = wlMaskLuma(wlSampleWindowMaskAtFloor(floorIdx, sceneUv, rOffset), uFalloff);
      float maskG = wlMaskLuma(wlSampleWindowMaskAtFloor(floorIdx, sceneUv, vec2(0.0)), uFalloff);
      float maskB = wlMaskLuma(wlSampleWindowMaskAtFloor(floorIdx, sceneUv, bOffset), uFalloff);

      vec3 chromaRaw = vec3(maskR, maskG, maskB);
      chromaRaw = wlApplyFringeSaturation(chromaRaw, uRgbFringeSaturation);
      chromaRaw *= clamp(uRgbFringeBalance, vec3(0.0), vec3(3.0));
      lightMap = pow(max(chromaRaw, vec3(0.0)), vec3(max(uFalloff, 0.001)));
      lightMap = pow(max(lightMap, vec3(0.0)), vec3(contrastPow));
    } else {
      float lum = wlMaskLuma(mask, uFalloff);
      if (lum < 0.001) {
        gl_FragColor = vec4(0.0);
        return;
      }
      lightMap = vec3(lum);
      lightMap = pow(max(lightMap, vec3(0.0)), vec3(contrastPow));
    }

    float lumCheck = dot(lightMap, vec3(0.2126, 0.7152, 0.0722));
    if (lumCheck < 0.001) {
      gl_FragColor = vec4(0.0);
      return;
    }

    vec3 emit = lightMap * uColor * uIntensity * ${WINDOW_ILLUM_SCALE.toFixed(6)} * flashMul;

    if (useSpecular > 0.001) {
      float spec = wlSampleSpecularAtFloor(floorIdx, sceneUv);
      float specGate = smoothstep(0.03, 0.12, windowLuma);
      emit += emit * spec * uSpecularBoost * specGate;
    }

    if (useSparkle > 0.5 && uSparkleStrength > 0.001) {
      float coreGate = smoothstep(uSparkleThreshold, 1.0, lumCheck);
      float edgeGate = mix(coreGate, edgeAmt, clamp(uSparkleEdgeBias, 0.0, 1.0));
      float spark = wlSparklePointField(
        sceneUv,
        uMaskTexelSize,
        uSparkleScale,
        uTime,
        uSparkleSpeed,
        uHasSparkleView,
        uSparkleViewUvMin,
        uSparkleViewUvMax
      );
      emit += uSparkleColor * spark * uSparkleStrength * 2.8 * edgeGate * mask.a;
    }

    emit = wlApplyTodGrade(emit, uTodEnabled, uTodIntensityScale, uTodExposure, uTodSaturation, uTodTint);
    float cloudDimming = mix(1.0, clamp(uCloudFactor, 0.0, 1.0), clamp(uCloudInfluence, 0.0, 1.0));
    float cloudShadow = wlSampleCloudShadowFactor(
      sceneUv,
      uSceneOrigin,
      uSceneSize,
      uSceneDimensions,
      uViewBoundsMin,
      uViewBoundsMax,
      uCloudShadowTex,
      uHasCloudShadowTex,
      uCloudShadowContrast,
      uCloudShadowBias,
      uCloudShadowGamma,
      uCloudShadowMinLight
    );
    emit *= cloudDimming * cloudShadow;
    if (uDebugForceMagenta > 0.5 && dot(emit, emit) > 1e-8) {
      emit = vec3(1.0, 0.0, 1.0);
    }
    // Soft HDR shoulder (replaces hard min(emit, 0.85) — that flattened window light to SDR).
    emit = emit / (vec3(1.0) + emit * 0.14);
    gl_FragColor = vec4(emit, 1.0);
  }
`;

function _wlProbeSampleMaskTexture(tex, u, v) {
  const img = tex?.image ?? tex?.source?.data ?? null;
  if (!img) return null;
  const w = img.width ?? img.videoWidth ?? 0;
  const h = img.height ?? img.videoHeight ?? 0;
  if (!(w > 0 && h > 0)) return null;
  const px = Math.max(0, Math.min(w - 1, Math.floor(Math.max(0, Math.min(1, u)) * (w - 1))));
  const py = Math.max(0, Math.min(h - 1, Math.floor(Math.max(0, Math.min(1, v)) * (h - 1))));
  try {
    if (img.data && img.width && img.height) {
      const i = (py * w + px) * 4;
      const r = img.data[i] / 255;
      const g = img.data[i + 1] / 255;
      const b = img.data[i + 2] / 255;
      const a = img.data[i + 3] / 255;
      return { r, g, b, a, luma: 0.2126 * r + 0.7152 * g + 0.0722 * b };
    }
    if (typeof document !== 'undefined') {
      if (!_wlProbeSampleMaskTexture._canvas) {
        _wlProbeSampleMaskTexture._canvas = document.createElement('canvas');
        _wlProbeSampleMaskTexture._ctx = _wlProbeSampleMaskTexture._canvas.getContext('2d', { willReadFrequently: true });
      }
      const c = _wlProbeSampleMaskTexture._canvas;
      const ctx = _wlProbeSampleMaskTexture._ctx;
      if (!ctx) return null;
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      } else {
        ctx.clearRect(0, 0, w, h);
      }
      ctx.drawImage(img, 0, 0, w, h);
      const d = ctx.getImageData(px, py, 1, 1).data;
      const r = d[0] / 255;
      const g = d[1] / 255;
      const b = d[2] / 255;
      const a = d[3] / 255;
      return { r, g, b, a, luma: 0.2126 * r + 0.7152 * g + 0.0722 * b };
    }
  } catch (_) {}
  return null;
}

function _wlProbeCreateRtReadBuffer(rt) {
  return allocateRtReadbackBuffer(rt, 1);
}

function _wlProbeDecodeRtChannels(buf, rt) {
  const { linear } = decodeReadbackPixel(buf, rt, 0);
  return {
    r: Math.max(0, linear[0]),
    g: Math.max(0, linear[1]),
    b: Math.max(0, linear[2]),
    a: Math.max(0, linear[3]),
  };
}

function _wlProbeScanRtMaxLuma(renderer, rt, gridSize = 8) {
  if (!renderer || !rt?.width || !rt?.height) return null;
  const gs = Math.max(2, Math.min(32, Math.floor(Number(gridSize) || 8)));
  const buf = _wlProbeCreateRtReadBuffer(rt);
  let maxLuma = 0;
  let maxAt = { u: 0, v: 0 };
  let sampleCount = 0;
  for (let gy = 0; gy < gs; gy += 1) {
    for (let gx = 0; gx < gs; gx += 1) {
      const u = (gx + 0.5) / gs;
      const v = (gy + 0.5) / gs;
      const px = Math.max(0, Math.min(rt.width - 1, Math.floor(u * (rt.width - 1))));
      const py = Math.max(0, Math.min(rt.height - 1, rt.height - 1 - Math.floor(v * (rt.height - 1))));
      try {
        renderer.readRenderTargetPixels(rt, px, py, 1, 1, buf);
        const { r, g, b } = _wlProbeDecodeRtChannels(buf, rt);
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        sampleCount += 1;
        if (luma > maxLuma) {
          maxLuma = luma;
          maxAt = { u, v };
        }
      } catch (_) {}
    }
  }
  return { maxLuma, maxAt, gridSize: gs, sampleCount };
}

function _wlProbeSampleRtPixel(renderer, rt, u, v) {
  if (!renderer || !rt?.width || !rt?.height) return null;
  const px = Math.max(0, Math.min(rt.width - 1, Math.floor(Math.max(0, Math.min(1, u)) * (rt.width - 1))));
  const py = Math.max(0, Math.min(rt.height - 1, Math.floor(Math.max(0, Math.min(1, v)) * (rt.height - 1))));
  const buf = _wlProbeCreateRtReadBuffer(rt);
  try {
    renderer.readRenderTargetPixels(rt, px, py, 1, 1, buf);
    const { r, g, b, a } = _wlProbeDecodeRtChannels(buf, rt);
    return { r, g, b, a, luma: 0.2126 * r + 0.7152 * g + 0.0722 * b, px, py };
  } catch (_) {
    return null;
  }
}

function _worldToSceneUvFoundry(wx, wy) {
  const dims = canvas?.dimensions;
  if (!dims) return null;
  const sr = dims.sceneRect ?? dims;
  const sceneX = Number(sr.x ?? 0);
  const sceneY = Number(sr.y ?? 0);
  const sceneW = Number(sr.width ?? dims.sceneWidth ?? dims.width ?? 1);
  const sceneH = Number(sr.height ?? dims.sceneHeight ?? dims.height ?? 1);
  const canvasH = Number(dims.height ?? 1);
  const foundryY = canvasH - wy;
  return {
    u: (wx - sceneX) / Math.max(1e-5, sceneW),
    v: 1.0 - (foundryY - sceneY) / Math.max(1e-5, sceneH),
  };
}

export class WindowLightEffectV2 {
  constructor() {
    this._enabled = true;
    this._initialized = false;
    this._scene = null;
    this._drawCamera = null;
    this._emitMaterial = null;
    this._activeFloorIndex = 0;
    this._renderFloorIndex = null;
    this._renderFloorSliceStrict = false;
    this._debugForceMagenta = false;
    this._lastDrawStats = null;
    this._lastFoundrySceneData = null;
    /** Scene-UV emit RT for compose (full pass only). */
    this._emitRT = null;
    this._emitRtSig = '';
    /** Scene-UV emit RT for shadow prepass only (never sampled by compose). */
    this._shadowLiftEmitRT = null;
    this._shadowLiftEmitRtSig = '';
    /** Legacy diagnostics shim — one entry per compositor floor slot with a mask. */
    this._overlays = new Map();
    /** @type {(import('three').Texture|null)[]} Compositor slots (raw). */
    this._windowMasks = [null, null, null, null];
    /** @type {(import('three').Texture|null)[]} Distinct per-floor masks for draw (PaintedShadow-style). */
    this._litWindowMasks = [null, null, null, null];
    /** @type {(import('three').Texture|null)[]} Compositor specular slots (raw). */
    this._specularMasks = [null, null, null, null];
    /** @type {(import('three').Texture|null)[]} Per-floor specular for draw. */
    this._litSpecularMasks = [null, null, null, null];
    /** @type {Map<string, import('three').Texture|null>} */
    this._windowBundleByBasePath = new Map();
    /** @type {Set<string>} */
    this._windowBundleLoadsInFlight = new Set();
    /** @type {Set<string>} */
    this._windowBundleMissPaths = new Set();
    /** @type {Map<string, number>} */
    this._windowBundleLastAttemptMs = new Map();
    /** @type {import('three').Texture|null} */
    this._floorIdTex = null;
    /** @type {import('three').Texture|null} 1×1 black — unbound sampler slots must never stay null. */
    this._fallbackMaskTex = null;
    /** @type {import('../scene-view-projection.js').SceneViewProjectionCache} */
    this._viewProjectionCache = createSceneViewProjectionCache();
    this._clipTmpNdcVec = null;
    this._clipTmpWorldVec = null;
    this._clipTmpDirVec = null;
    /** @type {import('three').Texture|null} */
    this._cloudShadowTex = null;
    /** @type {{ enabled: boolean, global?: object, interior?: object }|null} */
    this._cameraTimelineGradeState = { enabled: false };
    /** @type {{ exposure: number, saturation: number, tintColor: object, intensityScale: number }|null} */
    this._lastEvaluatedTodGrade = null;
    /** Monotonic frame id — incremented by {@link #beginFrame}. */
    this._frameId = 0;
    /** Last frame where {@link #syncFrameOcclusion} completed. */
    this._occlusionSyncedFrameId = -1;
    /** When false, {@link #_rebuildLitWindowMasks} is a no-op until masks change. */
    this._litMasksDirty = true;
    /** Cache key for the last successful {@link #drawWindowLightPass} (legacy diagnostic). */
    this._emitDrawCacheKey = '';
    /** Cache key for last successful full-purpose emit (per floor / frame). */
    this._lastFullEmitCacheKey = '';
    /**
     * True only after a successful `purpose:'full'` emit draw this frame.
     * @type {boolean}
     */
    this._emitComposeValid = false;
    /** True after a successful `shadowLift` draw this frame (see {@link #getShadowLiftTexture}). */
    this._shadowLiftValid = false;
    /** @type {boolean} */
    this._fullEmitDrawCacheEnabled = false;
    /** @type {number} Matches {@link LightingEffectV2} `internalWindowResolutionScale`. */
    this._emitResolutionScale = 1.0;
    /** @type {number} Drawing buffer width for emit size cap (0 = use mask size until synced). */
    this._emitBufferW = 0;
    /** @type {number} Drawing buffer height for emit size cap (0 = use mask size until synced). */
    this._emitBufferH = 0;
    this._emitSizeProbeVec = null;
    /** @type {{ shadowLiftDraws: number, fullDraws: number, skippedFullDraws: number }} */
    this._emitPerfSession = { shadowLiftDraws: 0, fullDraws: 0, skippedFullDraws: 0 };

    this.params = {
      hasWindowMask: false,
      ...WINDOW_LIGHT_CORE_DEFAULTS,
      ...buildDefaultWindowLightTodParams(),
    };

    log.debug('WindowLightEffectV2 created (scene-UV compositor)');
  }

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    this.params.enabled = this._enabled;
    if (this._emitMaterial?.uniforms?.uEffectEnabled) {
      this._emitMaterial.uniforms.uEffectEnabled.value = this._enabled ? 1.0 : 0.0;
    }
  }

  static getControlSchema() {
    const timelineGroups = [];
    const timelineParams = {
      todTimelineEnabled: {
        type: 'boolean',
        default: WINDOW_LIGHT_CORE_DEFAULTS.todTimelineEnabled,
        label: 'Enable time-of-day timeline',
        tooltip: 'Blends eight clock anchors as Map Shine time advances. Adjusts window glow intensity, exposure, saturation, and tint per anchor.',
      },
      useCameraGradeAnchorHours: {
        type: 'boolean',
        default: WINDOW_LIGHT_CORE_DEFAULTS.useCameraGradeAnchorHours,
        label: 'Use Camera Grade anchor hours',
        tooltip: 'When enabled, blend points follow Camera Grade clock-hour sliders instead of the local hour sliders below.',
      },
    };

    const addTintMultiplierSliders = (index, channelDefaults) => {
      const keys = wlTodTintSliderKeys(index);
      const tintTooltip = 'Per-channel hue bias (1 = neutral, 0–3). Raise R / lower B for warmth; overall brightness is preserved. Not a 0–255 colour.';
      for (const ch of ['R', 'G', 'B']) {
        const key = keys[ch.toLowerCase()];
        timelineParams[key] = {
          type: 'slider',
          label: `Tint ${ch}`,
          min: TOD_TINT_MIN,
          max: TOD_TINT_MAX,
          step: 0.01,
          default: channelDefaults[ch.toLowerCase()],
          throttle: 50,
          tooltip: tintTooltip,
        };
      }
      return [keys.r, keys.g, keys.b];
    };

    for (const meta of TOD_ANCHOR_META) {
      const i = meta.index;
      const anchor = DEFAULT_WINDOW_LIGHT_TOD_ANCHORS[i];
      const defaultHour = DEFAULT_TOD_ANCHOR_HOURS[i] ?? 0;
      const tintKeys = addTintMultiplierSliders(i, anchor.tintColor);
      const sectionLabel = `${meta.label} (~${meta.clockHint})`;
      const params = [
        `tod${i}Hour`,
        `tod${i}IntensityScale`,
        `tod${i}Exposure`,
        `tod${i}Saturation`,
        ...tintKeys,
      ];
      timelineGroups.push({
        name: `wl-tod-anchor-${i}`,
        label: sectionLabel,
        type: 'folder',
        advanced: true,
        expanded: false,
        parameters: params,
      });
      timelineParams[`tod${i}Hour`] = {
        type: 'slider',
        label: 'Clock hour',
        min: 0,
        max: 24,
        step: 0.05,
        default: defaultHour,
        throttle: 50,
        tooltip: `When the scene clock is near this anchor (${meta.clockHint} by default). Ignored when "Use Camera Grade anchor hours" is on.`,
      };
      timelineParams[`tod${i}IntensityScale`] = {
        type: 'slider',
        label: 'Intensity scale',
        min: 0,
        max: 3,
        step: 0.01,
        default: anchor.intensityScale,
        throttle: 50,
        tooltip: 'Window glow brightness multiplier at this anchor. Stacks with the master Intensity slider.',
      };
      timelineParams[`tod${i}Exposure`] = {
        type: 'slider',
        label: 'Exposure',
        min: -3,
        max: 3,
        step: 0.01,
        default: anchor.exposure,
        throttle: 50,
        tooltip: 'Exposure in stops for window glow at this anchor.',
      };
      timelineParams[`tod${i}Saturation`] = {
        type: 'slider',
        label: 'Saturation',
        min: 0,
        max: 2,
        step: 0.01,
        default: anchor.saturation,
        throttle: 50,
        tooltip: 'Chroma strength for window glow at this anchor (1 = neutral). Brightness is preserved — only hue richness changes.',
      };
    }

    return {
      enabled: true,
      help: {
        title: 'Window Light',
        summary: [
          'Emissive window glow from GpuSceneMaskCompositor _Windows masks (scene UV, per-floor stack).',
          'Glass Refraction splits R/G/B mask samples for prismatic window fringes; Sparkle & Glint adds animated highlights (_Specular mask).',
          'Cloud dimming ties window glow to overcast weather and cloud shadow maps.',
          'Time-of-day timeline uses the same eight clock anchors as Camera Grade.',
        ].join('\n\n'),
      },
      groups: [
        { name: 'status', label: 'Effect Status', type: 'inline', advanced: true, parameters: ['textureStatus'] },
        { name: 'lighting', label: 'Window Light', type: 'folder', expanded: true, parameters: ['intensity', 'falloff', 'color'] },
        {
          name: 'wl-glass-refraction',
          label: 'Glass Refraction',
          type: 'folder',
          expanded: false,
          parameters: [
            'glassRefractionEnabled',
            'rgbShiftAmount',
            'rgbShiftAngle',
            'rgbShiftSpread',
            'rgbShiftEdgeWeight',
            'rgbFringeSaturation',
            'rgbFringeBalance',
          ],
        },
        {
          name: 'wl-refraction-animation',
          label: 'Refraction Animation',
          type: 'folder',
          expanded: false,
          advanced: true,
          parameters: ['rgbShiftAnimate', 'rgbShiftAnimSpeed', 'rgbShiftAnimWobbleDeg'],
        },
        {
          name: 'wl-sparkle-glint',
          label: 'Sparkle & Glint',
          type: 'folder',
          expanded: false,
          parameters: [
            'sparkleEnabled',
            'sparkleStrength',
            'sparkleSpeed',
            'sparkleScale',
            'sparkleThreshold',
            'sparkleEdgeBias',
            'sparkleColor',
            'specularBoost',
          ],
        },
        {
          name: 'wl-lightning-windows',
          label: 'Lightning on Windows',
          type: 'folder',
          expanded: false,
          advanced: true,
          parameters: [
            'lightningWindowEnabled',
            'lightningWindowIntensityBoost',
            'lightningWindowContrastBoost',
            'lightningWindowRgbBoost',
          ],
        },
        { name: 'environment', label: 'Environment', type: 'folder', expanded: false, parameters: ['cloudInfluence'] },
        {
          name: 'cloudShadows',
          label: 'Cloud Shadows',
          type: 'folder',
          expanded: false,
          parameters: ['cloudShadowContrast', 'cloudShadowBias', 'cloudShadowGamma', 'cloudShadowMinLight'],
        },
        {
          name: 'wl-tod-timeline',
          label: 'Time-of-day window light',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: ['todTimelineEnabled', 'useCameraGradeAnchorHours'],
        },
        ...timelineGroups,
      ],
      parameters: {
        hasWindowMask: { type: 'boolean', default: true, hidden: true },
        textureStatus: { type: 'string', label: 'Mask Status', default: 'Checking...', readonly: true },
        intensity: {
          type: 'slider',
          label: 'Intensity',
          min: 0.0,
          max: 20.0,
          step: 0.05,
          default: WINDOW_LIGHT_CORE_DEFAULTS.intensity,
          tooltip: 'Window glow strength — multiplicative brighten (1 + light), not flat overlay.',
        },
        falloff: {
          type: 'slider',
          label: 'Falloff (Gamma)',
          min: 0.5,
          max: 5.0,
          step: 0.05,
          default: WINDOW_LIGHT_CORE_DEFAULTS.falloff,
        },
        color: {
          type: 'color',
          label: 'Light Color',
          default: { ...WINDOW_LIGHT_CORE_DEFAULTS.color },
        },
        cloudInfluence: {
          type: 'slider',
          label: 'Cloud Dimming',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: WINDOW_LIGHT_CORE_DEFAULTS.cloudInfluence,
          tooltip: 'How much overcast weather and cloud shadows dim window glow (0 = ignore clouds).',
        },
        cloudShadowContrast: {
          type: 'slider',
          label: 'Shadow Contrast',
          min: 0.0,
          max: 4.0,
          step: 0.01,
          default: WINDOW_LIGHT_CORE_DEFAULTS.cloudShadowContrast,
        },
        cloudShadowBias: {
          type: 'slider',
          label: 'Shadow Bias',
          min: -1.0,
          max: 1.0,
          step: 0.01,
          default: WINDOW_LIGHT_CORE_DEFAULTS.cloudShadowBias,
        },
        cloudShadowGamma: {
          type: 'slider',
          label: 'Shadow Gamma',
          min: 0.1,
          max: 4.0,
          step: 0.01,
          default: WINDOW_LIGHT_CORE_DEFAULTS.cloudShadowGamma,
        },
        cloudShadowMinLight: {
          type: 'slider',
          label: 'Min Light',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: WINDOW_LIGHT_CORE_DEFAULTS.cloudShadowMinLight,
        },
        glassRefractionEnabled: {
          type: 'boolean',
          default: true,
          label: 'Glass Refraction',
          tooltip: 'Per-channel mask RGB shift for prismatic window fringes. Set RGB Shift to 0 to disable fringes while leaving this on.',
        },
        rgbShiftAmount: {
          type: 'slider',
          label: 'RGB Shift (px)',
          min: 0.0,
          max: 16.0,
          step: 0.01,
          default: WINDOW_LIGHT_CORE_DEFAULTS.rgbShiftAmount,
          tooltip: 'Chromatic offset in mask texels along the shift angle.',
        },
        rgbShiftAngle: {
          type: 'slider',
          label: 'Shift Angle (deg)',
          min: 0.0,
          max: 360.0,
          step: 1.0,
          default: WINDOW_LIGHT_CORE_DEFAULTS.rgbShiftAngle,
        },
        rgbShiftSpread: {
          type: 'slider',
          label: 'Spectral Spread',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: WINDOW_LIGHT_CORE_DEFAULTS.rgbShiftSpread,
          tooltip: 'Widens R vs B separation (0 = symmetric).',
        },
        rgbShiftEdgeWeight: {
          type: 'slider',
          label: 'Edge Fringe Weight',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: WINDOW_LIGHT_CORE_DEFAULTS.rgbShiftEdgeWeight,
          tooltip: '1 = chromatic shift strongest on mask edges (pane borders).',
        },
        rgbFringeSaturation: {
          type: 'slider',
          label: 'Fringe Saturation',
          min: 0.0,
          max: 3.0,
          step: 0.01,
          default: WINDOW_LIGHT_CORE_DEFAULTS.rgbFringeSaturation,
        },
        rgbFringeBalance: {
          type: 'color',
          label: 'Fringe RGB Balance',
          default: { ...WINDOW_LIGHT_CORE_DEFAULTS.rgbFringeBalance },
          tooltip: 'Per-channel multiplier on chromatic fringe before falloff.',
        },
        rgbShiftAnimate: {
          type: 'boolean',
          default: true,
          label: 'Animate Refraction',
        },
        rgbShiftAnimSpeed: {
          type: 'slider',
          label: 'Animation Speed',
          min: 0.0,
          max: 3.0,
          step: 0.01,
          default: WINDOW_LIGHT_CORE_DEFAULTS.rgbShiftAnimSpeed,
        },
        rgbShiftAnimWobbleDeg: {
          type: 'slider',
          label: 'Angle Wobble (deg)',
          min: 0.0,
          max: 90.0,
          step: 0.5,
          default: WINDOW_LIGHT_CORE_DEFAULTS.rgbShiftAnimWobbleDeg,
          tooltip: 'Peak swing of refraction angle while animated. Higher = more visible rainbow drift.',
        },
        specularBoost: {
          type: 'slider',
          label: 'Specular Boost',
          min: 0.0,
          max: 5.0,
          step: 0.05,
          default: WINDOW_LIGHT_CORE_DEFAULTS.specularBoost,
          tooltip: 'Multiplies emit where _Specular mask is bright.',
        },
        sparkleEnabled: {
          type: 'boolean',
          default: true,
          label: 'Sparkle Enabled',
        },
        sparkleStrength: {
          type: 'slider',
          label: 'Sparkle Strength',
          min: 0.0,
          max: 5.0,
          step: 0.01,
          default: 1.35,
        },
        sparkleSpeed: {
          type: 'slider',
          label: 'Sparkle Speed',
          min: 0.0,
          max: 4.0,
          step: 0.01,
          default: WINDOW_LIGHT_CORE_DEFAULTS.sparkleSpeed,
          tooltip: 'Twinkle rate and how fast spawn locations shuffle (higher = quicker repopulation). Glints do not drift on the map.',
        },
        sparkleScale: {
          type: 'slider',
          label: 'Sparkle Density',
          min: 12.0,
          max: 120.0,
          step: 1.0,
          default: 38.0,
          tooltip: 'Glint cells across the visible camera view (not the whole map). Higher = more sparkles in what you see. Lower = fewer, larger gaps.',
        },
        sparkleThreshold: {
          type: 'slider',
          label: 'Sparkle Core Threshold',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.12,
        },
        sparkleEdgeBias: {
          type: 'slider',
          label: 'Sparkle Edge Bias',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.72,
          tooltip: '0 = bright mask cores; 1 = pane edges.',
        },
        sparkleColor: {
          type: 'color',
          label: 'Sparkle Tint',
          default: { ...WINDOW_LIGHT_CORE_DEFAULTS.sparkleColor },
        },
        lightningWindowEnabled: {
          type: 'boolean',
          default: true,
          label: 'Lightning Coupling',
        },
        lightningWindowIntensityBoost: {
          type: 'slider',
          label: 'Flash Intensity Boost',
          min: 0.0,
          max: 5.0,
          step: 0.05,
          default: WINDOW_LIGHT_CORE_DEFAULTS.lightningWindowIntensityBoost,
        },
        lightningWindowContrastBoost: {
          type: 'slider',
          label: 'Flash Contrast Boost',
          min: 0.0,
          max: 4.0,
          step: 0.05,
          default: WINDOW_LIGHT_CORE_DEFAULTS.lightningWindowContrastBoost,
        },
        lightningWindowRgbBoost: {
          type: 'slider',
          label: 'Flash RGB Shift Boost',
          min: 0.0,
          max: 3.0,
          step: 0.01,
          default: WINDOW_LIGHT_CORE_DEFAULTS.lightningWindowRgbBoost,
        },
        ...timelineParams,
      },
    };
  }

  getEffectiveIntensity() {
    return Math.max(0.0, Number(this.params.intensity) || 0);
  }

  /** Call once at the start of each FloorCompositor frame before occlusion sync. */
  beginFrame() {
    this._frameId += 1;
    this._emitComposeValid = false;
    this._shadowLiftValid = false;
    this._invalidateEmitDrawCache();
  }

  /** Reset emit draw counters (Performance Recorder session start). */
  resetEmitPerfSession() {
    this._emitPerfSession.shadowLiftDraws = 0;
    this._emitPerfSession.fullDraws = 0;
    this._emitPerfSession.skippedFullDraws = 0;
  }

  /**
   * @param {number} scale
   */
  setEmitResolutionScale(scale) {
    const next = this._sanitizeEmitResolutionScale(scale);
    if (next === this._emitResolutionScale) return;
    this._emitResolutionScale = next;
    this._emitRtSig = '';
    this._shadowLiftEmitRtSig = '';
    this._invalidateEmitDrawCache();
  }

  /**
   * @param {number} w
   * @param {number} h
   */
  setEmitDrawingBufferSize(w, h) {
    const bw = Math.max(0, Math.floor(Number(w) || 0));
    const bh = Math.max(0, Math.floor(Number(h) || 0));
    if (bw === this._emitBufferW && bh === this._emitBufferH) return;
    this._emitBufferW = bw;
    this._emitBufferH = bh;
    this._emitRtSig = '';
    this._shadowLiftEmitRtSig = '';
    this._invalidateEmitDrawCache();
  }

  /** @returns {object} Live emit stats for Performance Recorder `lighting.live.emit`. */
  getEmitPerformanceSnapshot() {
    const emitTex = this.getEmitTexture();
    const last = this._lastDrawStats ?? null;
    return {
      emitRt: this._emitRT
        ? { w: this._emitRT.width, h: this._emitRT.height, scale: this._emitResolutionScale }
        : null,
      lastDraw: last ? {
        path: last.path,
        purpose: last.purpose,
        drew: last.drew,
        cached: last.cached === true,
        emitRt: last.emitRt,
      } : null,
      windowLightTextureSource: this._emitComposeValid && emitTex ? 'emit' : 'none',
      sessionCounters: { ...this._emitPerfSession },
      lastFullEmitCacheKey: this._lastFullEmitCacheKey || null,
    };
  }

  /**
   * @param {number} n
   * @returns {number}
   * @private
   */
  _sanitizeEmitResolutionScale(n) {
    const v = Number(n);
    return Number.isFinite(v) ? Math.max(0.25, Math.min(1.0, v)) : 1.0;
  }

  /** @private */
  _invalidateEmitDrawCache() {
    this._lastFullEmitCacheKey = '';
    this._emitDrawCacheKey = '';
    this._emitComposeValid = false;
  }

  /**
   * @param {import('three').Texture|null} maskTex
   * @returns {{ w: number, h: number }}
   * @private
   */
  _computeEmitTargetDimensions(_maskTex) {
    // Emit is a scene-UV atlas (0..1 = scene rect). Size to the compositor scene
    // rect — not raw bundle image pixels (often 6k+ and misaligned with compose UV).
    const sceneDim = this._resolveSceneMaskEmitDimensions();
    const scale = this._emitResolutionScale;
    return {
      w: Math.max(1, Math.floor(sceneDim.w * scale)),
      h: Math.max(1, Math.floor(sceneDim.h * scale)),
    };
  }

  /**
   * Fallback emit size when mask textures lack pixel metadata (GPU RT path).
   * @returns {{ w: number, h: number }}
   * @private
   */
  _resolveSceneMaskEmitDimensions() {
    const dims = globalThis.canvas?.dimensions;
    const sr = dims?.sceneRect ?? dims;
    const sceneW = Number(sr?.width ?? dims?.sceneWidth ?? dims?.width) || 0;
    const sceneH = Number(sr?.height ?? dims?.sceneHeight ?? dims?.height) || 0;
    if (sceneW < 1 || sceneH < 1) return { w: 1, h: 1 };
    const maxTex = Number(window.MapShine?.renderer?.capabilities?.maxTextureSize) || SCENE_MASK_EMIT_MAX;
    const targetMax = Math.min(SCENE_MASK_EMIT_MAX, maxTex);
    const scale = Math.min(
      1.0,
      targetMax / Math.max(1, sceneW),
      targetMax / Math.max(1, sceneH),
    );
    return {
      w: Math.max(1, Math.round(sceneW * scale)),
      h: Math.max(1, Math.round(sceneH * scale)),
    };
  }

  /**
   * @param {THREE.WebGLRenderer|null} renderer
   * @private
   */
  _syncEmitDrawingBufferFromRenderer(renderer) {
    if (!renderer || typeof renderer.getDrawingBufferSize !== 'function') return;
    const THREE = window.THREE;
    if (!THREE) return;
    if (!this._emitSizeProbeVec) this._emitSizeProbeVec = new THREE.Vector2();
    renderer.getDrawingBufferSize(this._emitSizeProbeVec);
    const bw = Math.max(0, Math.floor(this._emitSizeProbeVec.x));
    const bh = Math.max(0, Math.floor(this._emitSizeProbeVec.y));
    if (bw >= 8 && bh >= 8) {
      this.setEmitDrawingBufferSize(bw, bh);
    }
  }

  /**
   * @returns {string}
   * @private
   */
  _buildFullEmitCacheKey() {
    const maskTex = this._resolveEmitMaskReference();
    const maskDim = maskTex ? this._maskImageSize(maskTex) : null;
    const maskSig = maskTex
      ? `${maskTex.uuid}|${maskDim?.w ?? 0}x${maskDim?.h ?? 0}`
      : 'none';
    const cloudUuid = this._cloudShadowTex?.uuid ?? 'none';
    const floor = Number.isFinite(this._renderFloorIndex)
      ? String(Math.floor(this._renderFloorIndex))
      : 'all';
    const todBucket = Math.floor((this._resolveTimelineHour() ?? 0) * 4);
    const p = this.params;
    return [
      this._frameId,
      'full',
      floor,
      maskSig,
      this._emitRtSig,
      cloudUuid,
      todBucket,
      Number(p.intensity ?? 0).toFixed(3),
      p.glassRefractionEnabled !== false ? 1 : 0,
      p.sparkleEnabled !== false ? 1 : 0,
      Number(p.rgbShiftAmount ?? 0).toFixed(2),
    ].join('|');
  }

  initialize() {
    if (this._initialized) return;
    const THREE = window.THREE;
    if (!THREE) { log.warn('initialize: THREE not available'); return; }

    this._scene = new THREE.Scene();
    this._scene.name = 'WindowLightScene';
    this._drawCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._ensureFallbackTextures(THREE);
    const fb = this._fallbackMaskTex;
    this._buildSceneUvEmitPass(fb);

    this._scene.userData.onBindWindowLightPass = (rw, rh, renderCamera) => {
      this._bindWindowLightPass(rw, rh, renderCamera);
    };

    this._scene.userData.onAfterWindowLightPass = () => {};

    this._scene.userData.drawWindowLightPass = (renderer, camera, options) => {
      this.drawWindowLightPass(renderer, camera, options);
    };

    this._scene.userData.getWindowLightTexture = () => this.getEmitTexture();

    this._initialized = true;
    log.info('WindowLightEffectV2 initialized (scene-UV compositor)');
  }

  clear() {}

  dispose() {
    if (this._scene?.userData) {
      delete this._scene.userData.onBindWindowLightPass;
      delete this._scene.userData.onAfterWindowLightPass;
      delete this._scene.userData.drawWindowLightPass;
      delete this._scene.userData.getWindowLightTexture;
    }
    try { this._emitMaterial?.dispose(); } catch (_) {}
    try { this._emitRT?.dispose(); } catch (_) {}
    try { this._shadowLiftEmitRT?.dispose(); } catch (_) {}
    try { this._scene?.children?.[0]?.geometry?.dispose(); } catch (_) {}
    try { this._fallbackMaskTex?.dispose(); } catch (_) {}
    this._emitMaterial = null;
    this._emitRT = null;
    this._shadowLiftEmitRT = null;
    this._drawCamera = null;
    this._fallbackMaskTex = null;
    this._scene = null;
    this._initialized = false;
    this._windowMasks = [null, null, null, null];
    this._litWindowMasks = [null, null, null, null];
    this._specularMasks = [null, null, null, null];
    this._litSpecularMasks = [null, null, null, null];
    this._windowBundleByBasePath.clear();
    this._windowBundleLoadsInFlight.clear();
    this._windowBundleMissPaths.clear();
    this._windowBundleLastAttemptMs.clear();
    this._floorIdTex = null;
    this._overlays.clear();
  }

  onFloorChange(maxFloorIndex) {
    const prev = this._activeFloorIndex;
    this._activeFloorIndex = Number.isFinite(Number(maxFloorIndex)) ? Number(maxFloorIndex) : 0;
    if (prev !== this._activeFloorIndex) {
      log.info(`WindowLightEffectV2 floor visibility: ${prev} -> ${this._activeFloorIndex}`);
    }
  }

  setRenderFloorIndex(floorIndex = null, sliceStrict = false) {
    const next = (floorIndex !== null && floorIndex !== undefined) ? Number(floorIndex) : null;
    this._renderFloorIndex = (next !== null && Number.isFinite(next)) ? next : null;
    this._renderFloorSliceStrict = this._renderFloorIndex !== null ? !!sliceStrict : false;
    this._invalidateEmitDrawCache();
  }

  async populate(foundrySceneData) {
    if (!this._initialized) { log.warn('populate: not initialized'); return; }
    this._lastFoundrySceneData = foundrySceneData;
    this._primeWindowBundleLoadsForAllFloors();
    this.syncFrameOcclusion(null);
    const slotCount = this._windowMasks.filter(Boolean).length;
    log.info(`WindowLightEffectV2 populated: compositor window slots=${slotCount}`);
  }

  update(timeInfo) {
    if (!this._initialized || !this._enabled) return;

    const polledActiveFloor = Number(window.MapShine?.floorStack?.getActiveFloor?.()?.index);
    if (Number.isFinite(polledActiveFloor) && polledActiveFloor !== this._activeFloorIndex) {
      this.onFloorChange(polledActiveFloor);
    }

    const u = this._emitMaterial?.uniforms;
    if (!u) return;

    u.uEffectEnabled.value = this._enabled ? 1.0 : 0.0;
    u.uDebugForceMagenta.value = this._debugForceMagenta ? 1.0 : 0.0;
    u.uIntensity.value = this.getEffectiveIntensity();
    u.uFalloff.value = Math.max(0.01, Number(this.params.falloff) || 1);

    const c = this.params.color;
    if (c && typeof c === 'object') {
      u.uColor.value.setRGB(Number(c.r) || 0, Number(c.g) || 0, Number(c.b) || 0);
    }

    if (u.uTime) {
      u.uTime.value = Number(timeInfo?.elapsed) || 0;
    }

    this._syncCloudUniformsFromParams(u);
    this._updateSceneBounds();
    this._pushTodUniforms();
    this._pushRefractionUniforms(u);
  }

  /**
   * @param {string} paramId
   * @param {*} _value
   */
  applyParamChange(paramId, _value) {
    if (!this._initialized || !this._emitMaterial) return;
    const u = this._emitMaterial.uniforms;
    if (
      paramId === 'todTimelineEnabled'
      || paramId === 'useCameraGradeAnchorHours'
      || paramId.startsWith('tod')
    ) {
      this._pushTodUniforms();
    }
    if (
      paramId === 'glassRefractionEnabled'
      || paramId.startsWith('rgb')
      || paramId.startsWith('sparkle')
      || paramId === 'specularBoost'
      || paramId.startsWith('lightningWindow')
    ) {
      this._pushRefractionUniforms(u);
    }
    if (paramId === 'color' && u.uColor) {
      const col = this.params.color;
      if (col && typeof col === 'object') {
        u.uColor.value.setRGB(Number(col.r) || 0, Number(col.g) || 0, Number(col.b) || 0);
      }
    }
  }

  /** @private */
  _pushRefractionUniforms(u) {
    if (!u) return;
    const p = this.params;

    if (u.uGlassRefractionEnabled) {
      u.uGlassRefractionEnabled.value = p.glassRefractionEnabled !== false ? 1.0 : 0.0;
    }
    if (u.uRgbShiftAmount) u.uRgbShiftAmount.value = Math.max(0.0, Number(p.rgbShiftAmount) || 0);
    if (u.uRgbShiftAngle) {
      u.uRgbShiftAngle.value = (Number(p.rgbShiftAngle) || 0) * (Math.PI / 180.0);
    }
    if (u.uRgbShiftSpread) u.uRgbShiftSpread.value = clamp(Number(p.rgbShiftSpread) || 0, 0, 1);
    if (u.uRgbShiftEdgeWeight) u.uRgbShiftEdgeWeight.value = clamp(Number(p.rgbShiftEdgeWeight) || 0, 0, 1);
    if (u.uRgbShiftAnimate) u.uRgbShiftAnimate.value = p.rgbShiftAnimate !== false ? 1.0 : 0.0;
    if (u.uRgbShiftAnimSpeed) u.uRgbShiftAnimSpeed.value = Math.max(0.0, Number(p.rgbShiftAnimSpeed) || 0);
    if (u.uRgbShiftAnimWobbleDeg) {
      u.uRgbShiftAnimWobbleDeg.value = Math.max(0.0, Number(p.rgbShiftAnimWobbleDeg) || 0);
    }
    if (u.uRgbFringeSaturation) {
      u.uRgbFringeSaturation.value = Math.max(0.0, Number(p.rgbFringeSaturation) || 1);
    }
    if (u.uRgbFringeBalance) {
      const bal = p.rgbFringeBalance;
      if (bal && typeof bal === 'object') {
        u.uRgbFringeBalance.value.set(
          Math.max(0, Number(bal.r) || 1),
          Math.max(0, Number(bal.g) || 1),
          Math.max(0, Number(bal.b) || 1),
        );
      }
    }
    if (u.uSpecularBoost) u.uSpecularBoost.value = Math.max(0.0, Number(p.specularBoost) || 0);
    if (u.uSparkleEnabled) u.uSparkleEnabled.value = p.sparkleEnabled !== false ? 1.0 : 0.0;
    if (u.uSparkleStrength) u.uSparkleStrength.value = Math.max(0.0, Number(p.sparkleStrength) || 0);
    if (u.uSparkleSpeed) u.uSparkleSpeed.value = Math.max(0.0, Number(p.sparkleSpeed) || 0);
    if (u.uSparkleScale) u.uSparkleScale.value = clamp(Number(p.sparkleScale) || 38, 12, 120);
    if (u.uSparkleThreshold) u.uSparkleThreshold.value = clamp(Number(p.sparkleThreshold) || 0, 0, 1);
    if (u.uSparkleEdgeBias) u.uSparkleEdgeBias.value = clamp(Number(p.sparkleEdgeBias) || 0, 0, 1);
    if (u.uSparkleColor) {
      const sc = p.sparkleColor;
      if (sc && typeof sc === 'object') {
        u.uSparkleColor.value.set(
          Number(sc.r) || 1,
          Number(sc.g) || 1,
          Number(sc.b) || 1,
        );
      }
    }

    let flash01 = 0.0;
    try {
      flash01 = resolveCompositorLightningFlash01();
    } catch (_) {}
    if (u.uLightningWindowEnabled) {
      u.uLightningWindowEnabled.value = p.lightningWindowEnabled !== false ? 1.0 : 0.0;
    }
    if (u.uLightningFlash01) u.uLightningFlash01.value = flash01;
    if (u.uLightningWindowIntensityBoost) {
      u.uLightningWindowIntensityBoost.value = Math.max(0.0, Number(p.lightningWindowIntensityBoost) || 0);
    }
    if (u.uLightningWindowContrastBoost) {
      u.uLightningWindowContrastBoost.value = Math.max(0.0, Number(p.lightningWindowContrastBoost) || 0);
    }
    if (u.uLightningWindowRgbBoost) {
      u.uLightningWindowRgbBoost.value = Math.max(0.0, Number(p.lightningWindowRgbBoost) || 0);
    }
  }

  /** @private @returns {boolean} */
  _isTodTimelineEnabled() {
    return isTimelineEnabledParam(this.params?.todTimelineEnabled)
      && this.params.enabled !== false
      && this._enabled;
  }

  /** @private */
  _readTodTint(index) {
    const p = this.params;
    const keys = wlTodTintSliderKeys(index);
    const fallbackTint = DEFAULT_WINDOW_LIGHT_TOD_ANCHORS[index]?.tintColor
      ?? { r: TOD_TINT_NEUTRAL, g: TOD_TINT_NEUTRAL, b: TOD_TINT_NEUTRAL };

    const readChannel = (key, fb) => {
      if (!Object.prototype.hasOwnProperty.call(p, key)) return fb;
      const v = Number(p[key]);
      return Number.isFinite(v) ? v : fb;
    };

    const hasSlider = [keys.r, keys.g, keys.b].some((k) => Object.prototype.hasOwnProperty.call(p, k));
    const rgb = hasSlider
      ? normalizeTintMultiplier({
        r: readChannel(keys.r, fallbackTint.r),
        g: readChannel(keys.g, fallbackTint.g),
        b: readChannel(keys.b, fallbackTint.b),
      })
      : normalizeTintMultiplier(p[keys.color] ?? fallbackTint);

    p[keys.r] = rgb.r;
    p[keys.g] = rgb.g;
    p[keys.b] = rgb.b;
    p[keys.color] = { ...rgb };
    return rgb;
  }

  /** @private */
  _resolveAnchorHour(index) {
    const p = this.params;
    const fallback = DEFAULT_TOD_ANCHOR_HOURS[index] ?? 0;
    if (isTimelineEnabledParam(p.useCameraGradeAnchorHours)) {
      const ccParams = readColorCorrectionParamsFromUi();
      const ccKey = `tod${index}Hour`;
      if (ccParams && Number.isFinite(Number(ccParams[ccKey]))) {
        return wrapHour24(Number(ccParams[ccKey]));
      }
    }
    return wrapHour24(p[`tod${index}Hour`] ?? fallback);
  }

  /** @private */
  _readTodAnchor(index) {
    const p = this.params;
    const fallback = DEFAULT_WINDOW_LIGHT_TOD_ANCHORS[index];
    return {
      hour: this._resolveAnchorHour(index),
      grade: {
        intensityScale: clamp(p[`tod${index}IntensityScale`] ?? fallback?.intensityScale ?? 1, 0, 3),
        exposure: clamp(p[`tod${index}Exposure`] ?? fallback?.exposure ?? 0, -10, 10),
        saturation: clamp(p[`tod${index}Saturation`] ?? fallback?.saturation ?? 1, 0, 4),
        tintColor: this._readTodTint(index),
      },
    };
  }

  /** @private */
  _evaluateWindowLightTod(hourRaw) {
    const anchors = [];
    for (let i = 0; i < TOD_ANCHOR_COUNT; i += 1) {
      anchors.push(this._readTodAnchor(i));
    }
    this.params.todAnchors = anchors.map((anchor) => ({
      hour: anchor.hour,
      grade: {
        intensityScale: anchor.grade.intensityScale,
        exposure: anchor.grade.exposure,
        saturation: anchor.grade.saturation,
        tintColor: { ...anchor.grade.tintColor },
      },
    }));
    return evaluateTodTimeline(hourRaw, anchors);
  }

  /** @private @returns {number} */
  _resolveTimelineHour() {
    try {
      const hour = Number(LightingDirector.get()?.hour);
      if (Number.isFinite(hour)) return wrapHour24(hour);
    } catch (_) {}
    const wcHour = Number(weatherController?.timeOfDay);
    if (Number.isFinite(wcHour)) return wrapHour24(wcHour);
    try {
      const panelHour = Number(window.MapShine?.controlPanel?.controlState?.timeOfDay);
      if (Number.isFinite(panelHour)) return wrapHour24(panelHour);
    } catch (_) {}
    return 12.0;
  }

  /** @private */
  _pushTodUniforms() {
    const u = this._emitMaterial?.uniforms;
    if (!u?.uTodEnabled) return;

    const applyTimeline = this._isTodTimelineEnabled();
    u.uTodEnabled.value = applyTimeline ? 1.0 : 0.0;

    const grade = applyTimeline
      ? this._evaluateWindowLightTod(this._resolveTimelineHour())
      : neutralTodGrade();

    this._lastEvaluatedTodGrade = grade;

    u.uTodIntensityScale.value = Math.max(0, Number(grade.intensityScale) || 0);
    u.uTodExposure.value = Number(grade.exposure) || 0;
    u.uTodSaturation.value = Number.isFinite(Number(grade.saturation)) ? Number(grade.saturation) : 1;
    u.uTodTint.value.set(
      grade.tintColor.r ?? TOD_TINT_NEUTRAL,
      grade.tintColor.g ?? TOD_TINT_NEUTRAL,
      grade.tintColor.b ?? TOD_TINT_NEUTRAL,
    );
  }

  /**
   * Live ToD diagnostics for console inspection.
   * @returns {object}
   */
  getTodDebugState() {
    const u = this._emitMaterial?.uniforms;
    const hour = this._resolveTimelineHour();
    const grade = this._isTodTimelineEnabled()
      ? this._evaluateWindowLightTod(hour)
      : neutralTodGrade();
    return {
      timelineEnabled: this._isTodTimelineEnabled(),
      useCameraGradeAnchorHours: isTimelineEnabledParam(this.params?.useCameraGradeAnchorHours),
      hour,
      evaluatedGrade: grade,
      anchors: this.params.todAnchors ?? null,
      uniforms: u ? {
        uTodEnabled: u.uTodEnabled?.value ?? null,
        uTodIntensityScale: u.uTodIntensityScale?.value ?? null,
        uTodExposure: u.uTodExposure?.value ?? null,
        uTodSaturation: u.uTodSaturation?.value ?? null,
        uTodTint: u.uTodTint?.value
          ? { r: u.uTodTint.value.x, g: u.uTodTint.value.y, b: u.uTodTint.value.z }
          : null,
      } : null,
      cameraTimelineGradeState: this._cameraTimelineGradeState ?? null,
    };
  }

  render(_renderer, _camera) {}

  // ── FloorCompositor hooks ───────────────────────────────────────────────────

  setOutdoorsMask(_mask) {}
  setCloudShadowTexture(texture, screenW, screenH, _viewBounds = null) {
    this._cloudShadowTex = texture ?? null;
    this._invalidateEmitDrawCache();
    const u = this._emitMaterial?.uniforms;
    if (!u) return;
    u.uCloudShadowTex.value = this._cloudShadowTex ?? this._fallbackMaskTex ?? null;
    u.uHasCloudShadowTex.value = this._cloudShadowTex ? 1.0 : 0.0;
    const w = Math.max(1, Number(screenW) || 1);
    const h = Math.max(1, Number(screenH) || 1);
    void w;
    void h;
    void _viewBounds;
  }
  setOverheadRoofAlphaTexture(_tex, _w, _h) {}
  setCeilingTransmittanceTexture(_tex) {}
  setSkyState(_state) {}
  setTimelineGradeState(state) {
    this._cameraTimelineGradeState = state ?? { enabled: false };
  }
  setDriver(_driverState) {}
  applyOutdoorsClip(_renderer, _camera, _targetRT, _outdoorsMaskOverride) {}

  applyPostFilterBoost(_renderer, _baseRT, _outputRT, _windowTex, _gain = 1.0) {
    return false;
  }

  /**
   * Refresh per-floor window mask slots from GpuSceneMaskCompositor (PaintedShadow-style).
   * @param {*} _floorCompositor
   */
  syncFrameOcclusion(_floorCompositor) {
    const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
    this._windowMasks = [null, null, null, null];
    this._litWindowMasks = [null, null, null, null];
    this._specularMasks = [null, null, null, null];
    this._litSpecularMasks = [null, null, null, null];
    this._floorIdTex = null;
    this.params.hasWindowMask = false;
    this._litMasksDirty = true;

    if (!compositor) return;

    try {
      const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
      this._primeWindowBundleLoadsForAllFloors();
      for (const floor of floors) {
        const idx = Number(floor?.index);
        if (!Number.isFinite(idx) || idx < 0 || idx > 3) continue;
        this._windowMasks[idx] = this._resolveCompositorWindowMaskForFloor(floor, compositor);
        this._specularMasks[idx] = this._resolveCompositorSpecularMaskForFloor(floor, compositor);
        if (!this._windowMasks[idx]) {
          this._tryAssignWindowBundleMaskForFloor(idx);
        }
        this._stampMaskTextureDimensions(this._windowMasks[idx]);
        this._stampMaskTextureDimensions(this._specularMasks[idx]);
      }

      const groundMask = this._windowMasks[0] ?? null;
      for (let idx = 1; idx < 4; idx += 1) {
        const tex = this._windowMasks[idx];
        if (!tex || !groundMask?.uuid || tex.uuid !== groundMask.uuid) continue;
        const replaced = this._tryAssignWindowBundleMaskForFloor(idx, groundMask.uuid);
        if (!replaced) this._windowMasks[idx] = null;
      }

      this._rebuildLitWindowMasks();
      this._rebuildLitSpecularMasks();

      if (this._litWindowMasks.some((_t, i) => this._hasValidWindowMask(i))) {
        this._floorIdTex = compositor.floorIdTarget?.texture ?? null;
        this.params.hasWindowMask = true;
      }
    this._emitRtSig = '';
    this._shadowLiftEmitRtSig = '';
    this._invalidateEmitDrawCache();
    this._refreshOverlayShim();
    } catch (err) {
      log.warn('syncFrameOcclusion failed:', err);
    }
  }

  setDebugForceMagenta(enabled = true) {
    this._debugForceMagenta = enabled === true;
    const u = this._emitMaterial?.uniforms?.uDebugForceMagenta;
    if (u) u.value = this._debugForceMagenta ? 1.0 : 0.0;
    return this._debugForceMagenta;
  }

  /** Scene-UV window glow texture after the full emit pass (compose blit source). */
  getEmitTexture() {
    return this._emitRT?.texture ?? null;
  }

  /** Stripped emit for dynamic-light shadow lift (separate RT — not used by compose). */
  getShadowLiftTexture() {
    if (!this._shadowLiftValid) return null;
    return this._shadowLiftEmitRT?.texture ?? null;
  }

  /** @returns {boolean} Whether compose may sample emit after a full draw this frame. */
  isEmitValidForCompose() {
    return this._emitComposeValid === true && !!this._emitRT?.texture;
  }

  getRenderTargetDiagnostics(renderer = null, lightingEffect = null, options = {}) {
    const r = renderer ?? globalThis.MapShine?.renderer ?? null;
    const rt = this._emitRT ?? null;

    const scan = (rt && r) ? _wlProbeScanRtMaxLuma(r, rt, 8) : null;
    const screenUv = options?.screenUv ?? null;
    let rtAtClick = null;
    if (rt && r && screenUv && Number.isFinite(screenUv.u) && Number.isFinite(screenUv.v)) {
      rtAtClick = _wlProbeSampleRtPixel(r, rt, screenUv.u, screenUv.v);
    }

    return {
      rtWidth: rt?.width ?? null,
      rtHeight: rt?.height ?? null,
      rtMaxLuma: scan?.maxLuma ?? null,
      rtMaxAt: scan?.maxAt ?? null,
      rtAtClick,
      compositorWindowSlots: this._windowMasks.map((t, i) => (t ? i : null)).filter((x) => x !== null),
      litWindowSlots: this._litWindowMasks.map((t, i) => (this._hasValidWindowMask(i) ? i : null)).filter((x) => x !== null),
      hasFloorIdTex: !!this._floorIdTex,
      renderFloorIndex: Number.isFinite(this._renderFloorIndex) ? this._renderFloorIndex : null,
      lastDrawStats: this._lastDrawStats ? { ...this._lastDrawStats } : null,
      debugForceMagenta: !!this._debugForceMagenta,
    };
  }

  probeAtWorld(wx, wy, options = {}) {
    const wxN = Number(wx);
    const wyN = Number(wy);
    const out = {
      worldX: wxN,
      worldY: wyN,
      enabled: !!this._enabled && !!this.params?.enabled,
      initialized: !!this._initialized,
      compositorSlots: this._windowMasks.map((t, i) => (t ? i : null)).filter((x) => x !== null),
      litWindowSlots: this._litWindowMasks.map((_t, i) => (this._hasValidWindowMask(i) ? i : null)).filter((x) => x !== null),
      runtime: {},
      blockers: [],
      hints: [],
      verdict: 'unknown',
    };

    if (!Number.isFinite(wxN) || !Number.isFinite(wyN)) {
      out.error = 'invalid-coordinates';
      out.verdict = 'invalid';
      return out;
    }
    if (!this._initialized) {
      out.blockers.push('effect_not_initialized');
      out.verdict = 'no_light';
      return out;
    }
    if (!this._enabled || !this.params?.enabled) {
      out.blockers.push('effect_disabled');
      out.verdict = 'no_light';
    }
    if (!this.params.hasWindowMask) {
      out.blockers.push('no_compositor_window_masks');
    }

    const sceneUv = _worldToSceneUvFoundry(wxN, wyN);
    out.sceneUv = sceneUv;

    let bestSample = null;
    let bestFloor = null;
    if (sceneUv) {
      for (let fi = 0; fi < 4; fi += 1) {
        if (!this._hasValidWindowMask(fi)) continue;
        const tex = this._litWindowMasks[fi];
        if (!tex) continue;
        const flipY = tex.flipY ? 1 : 0;
        const su = sceneUv.u;
        let sv = sceneUv.v;
        if (flipY) sv = 1.0 - sv;
        const sample = _wlProbeSampleMaskTexture(tex, su, sv);
        if (sample && sample.luma > (bestSample?.luma ?? 0)) {
          bestSample = sample;
          bestFloor = fi;
        }
      }
    }

    out.maskSample = bestSample;
    out.floorIndex = bestFloor;
    if (bestSample && bestSample.a >= 0.01 && bestSample.luma > 0.001) {
      out.verdict = 'would_emit';
      out.hints.push('Compositor mask would emit — check emit RT or debug magenta.');
    } else if (!this.params.hasWindowMask) {
      out.verdict = 'no_light';
    } else {
      out.verdict = 'no_light';
      out.blockers.push('no_mask_energy_at_world');
    }

    const ms = globalThis.MapShine ?? {};
    out.renderDiagnostics = this.getRenderTargetDiagnostics(ms.renderer ?? null, null, options);
    return out;
  }

  getPipelineStatus() {
    const fc = globalThis.MapShine?.effectComposer?._floorCompositorV2 ?? null;
    const le = fc?._lightingEffect ?? null;
    return {
      enabled: !!this._enabled && this.params?.enabled !== false,
      initialized: !!this._initialized,
      hasWindowMask: !!this.params?.hasWindowMask,
      compositorWindowSlots: this._windowMasks.map((t, i) => (t ? i : null)).filter((x) => x !== null),
      litWindowSlots: this._litWindowMasks.map((_t, i) => (this._hasValidWindowMask(i) ? i : null)).filter((x) => x !== null),
      hasFloorIdTex: !!this._floorIdTex,
      activeFloorIndex: this._activeFloorIndex,
      renderFloorIndex: this._renderFloorIndex,
      renderFloorSliceStrict: this._renderFloorSliceStrict,
      emitRtSize: this._emitRT
        ? { w: this._emitRT.width, h: this._emitRT.height }
        : null,
      lastDrawStats: this._lastDrawStats,
      lightingEnabled: le?.enabled !== false && le?.params?.enabled !== false,
      windowLightRtSize: this._emitRT
        ? { w: this._emitRT.width, h: this._emitRT.height }
        : null,
      winScenePassedToLighting: !!(fc && this._scene && this._enabled),
      hasCloudShadowTex: !!this._cloudShadowTex,
      cloudInfluence: Number(this.params.cloudInfluence) || 0,
      todTimelineEnabled: this._isTodTimelineEnabled(),
      todHour: this._resolveTimelineHour(),
      todGrade: this._lastEvaluatedTodGrade,
    };
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera|null} camera
   * @param {{ purpose?: 'full'|'shadowLift' }} [options]
   */
  drawWindowLightPass(renderer, camera, options = {}) {
    if (!this._enabled || !renderer || !this._initialized || !this._scene || !this._emitMaterial) {
      this._emitComposeValid = false;
      this._shadowLiftValid = false;
      this._lastDrawStats = { skipReason: 'disabled_or_unready', drew: false };
      return;
    }

    this._syncEmitDrawingBufferFromRenderer(renderer);

    if (!this.params.hasWindowMask) {
      this._emitComposeValid = false;
      this._shadowLiftValid = false;
      this._lastDrawStats = { skipReason: 'no_compositor_masks', drew: false };
      return;
    }

    const purpose = options?.purpose === 'shadowLift' ? 'shadowLift' : 'full';
    const shadowLiftOnly = purpose === 'shadowLift';
    if (shadowLiftOnly) {
      this._emitComposeValid = false;
      this._shadowLiftValid = false;
    }

    if (camera) this._syncViewProjectionUniforms(camera);
    this._updateSceneBounds();
    if (!shadowLiftOnly) {
      this._syncCloudUniformsFromParams(this._emitMaterial.uniforms);
      this._pushTodUniforms();
      this._pushRefractionUniforms(this._emitMaterial.uniforms);
    }

    this._rebuildLitWindowMasks();
    if (!shadowLiftOnly) {
      this._rebuildLitSpecularMasks();
    }

    const savedEmitUniforms = shadowLiftOnly
      ? this._pushEmitShadowLiftUniforms(this._emitMaterial.uniforms)
      : null;

    if (!shadowLiftOnly && this._fullEmitDrawCacheEnabled) {
      const cacheKey = this._buildFullEmitCacheKey();
      const maskForDim = this._resolveEmitMaskReference();
      const expectedDim = maskForDim ? this._computeEmitTargetDimensions(maskForDim) : null;
      const rtReady = this._emitRT?.texture
        && expectedDim
        && this._emitRT.width === expectedDim.w
        && this._emitRT.height === expectedDim.h
        && this._emitRT.width >= 8
        && this._emitRT.height >= 8;
      if (
        cacheKey
        && cacheKey === this._lastFullEmitCacheKey
        && rtReady
      ) {
        this._emitPerfSession.skippedFullDraws += 1;
        this._emitComposeValid = true;
        this._lastDrawStats = {
          path: 'sceneUvEmitRt.cached',
          purpose: 'full',
          drew: false,
          cached: true,
          floor: Number.isFinite(this._renderFloorIndex) ? this._renderFloorIndex : null,
          emitRt: { w: this._emitRT.width, h: this._emitRT.height },
          cacheKey,
        };
        return;
      }
    }

    const strictFloor = Number(this._renderFloorIndex);
    if (this._renderFloorSliceStrict && Number.isFinite(strictFloor)) {
      const fi = Math.max(0, Math.min(3, Math.floor(strictFloor)));
      if (!this._hasValidWindowMask(fi)) {
        const THREE = window.THREE;
        const clearRt = THREE ? this._ensurePurposeEmitTarget(THREE, purpose) : null;
        if (clearRt) {
          const prevTarget = renderer.getRenderTarget();
          const drawState = this._prepareWindowLightDrawState(renderer, clearRt);
          try {
            // _prepareWindowLightDrawState already bound emit RT and cleared it.
          } finally {
            renderer.setRenderTarget(prevTarget);
            this._restoreWindowLightDrawState(renderer, drawState);
          }
        }
        this._lastDrawStats = {
          skipReason: 'no_lit_window_mask_for_floor',
          floor: fi,
          drew: false,
          clearedEmitRt: true,
        };
        if (shadowLiftOnly) {
          this._shadowLiftValid = true;
        } else {
          this._emitComposeValid = false;
          this._lastFullEmitCacheKey = null;
        }
        return;
      }
    }

    const THREE = window.THREE;
    const emitTarget = THREE ? this._ensurePurposeEmitTarget(THREE, purpose) : null;
    if (!emitTarget) {
      this._shadowLiftValid = false;
      this._lastDrawStats = { skipReason: 'emit_rt_unready', drew: false };
      return;
    }

    this._bindCompositorMaskUniforms();
    this._bindFloorSliceUniforms();

    const stats = {
      path: shadowLiftOnly ? 'sceneUvEmitRt.shadowLift' : 'sceneUvEmitRt',
      purpose,
      cached: false,
      floorSlots: this._windowMasks.map((t, i) => (t ? i : null)).filter((x) => x !== null),
      litWindowSlots: this._litWindowMasks.map((_t, i) => (this._hasValidWindowMask(i) ? i : null)).filter((x) => x !== null),
      hasFloorId: !!this._floorIdTex,
      emitRt: { w: emitTarget.width, h: emitTarget.height, scale: this._emitResolutionScale },
    };

    const prevTarget = renderer.getRenderTarget();
    const drawState = this._prepareWindowLightDrawState(renderer, emitTarget);

    try {
      renderer.setRenderTarget(emitTarget);
      renderer.render(this._scene, this._drawCamera);
      stats.drew = true;
      this._emitDrawCacheKey = `${this._frameId}|${purpose}|${this._renderFloorIndex ?? 'all'}`;
      if (shadowLiftOnly) {
        this._emitPerfSession.shadowLiftDraws += 1;
        this._shadowLiftValid = true;
        this._invalidateEmitDrawCache();
      } else {
        this._emitPerfSession.fullDraws += 1;
        this._emitComposeValid = true;
        const fullKey = this._buildFullEmitCacheKey();
        this._lastFullEmitCacheKey = fullKey;
        stats.cacheKey = fullKey;
      }
    } finally {
      this._restoreEmitShadowLiftUniforms(this._emitMaterial.uniforms, savedEmitUniforms);
      renderer.setRenderTarget(prevTarget);
      this._restoreWindowLightDrawState(renderer, drawState);
      this._lastDrawStats = stats;
    }
  }

  /**
   * Strip expensive EMIT_FRAG branches for source-shadow dynamic-light lift only.
   * Building/SkyReach/Painted paths use max(rgb) presence — not sparkle/refraction/ToD.
   * @param {Record<string, { value: number }>} u
   * @returns {Record<string, number>|null}
   * @private
   */
  _pushEmitShadowLiftUniforms(u) {
    if (!u) return null;
    const saved = {};
    const snap = (key) => {
      const slot = u[key];
      if (!slot) return;
      saved[key] = slot.value;
    };
    snap('uGlassRefractionEnabled');
    snap('uSparkleEnabled');
    snap('uSpecularBoost');
    snap('uLightningWindowEnabled');
    snap('uTodEnabled');
    snap('uCloudInfluence');
    if (u.uGlassRefractionEnabled) u.uGlassRefractionEnabled.value = 0.0;
    if (u.uSparkleEnabled) u.uSparkleEnabled.value = 0.0;
    if (u.uSpecularBoost) u.uSpecularBoost.value = 0.0;
    if (u.uLightningWindowEnabled) u.uLightningWindowEnabled.value = 0.0;
    if (u.uTodEnabled) u.uTodEnabled.value = 0.0;
    if (u.uCloudInfluence) u.uCloudInfluence.value = 0.0;
    if (u.uIntensity) {
      u.uIntensity.value = Math.max(0.0, Number(this.params.intensity) || 0);
    }
    return saved;
  }

  /**
   * @param {Record<string, { value: number }>} u
   * @param {Record<string, number>|null} saved
   * @private
   */
  _restoreEmitShadowLiftUniforms(u, saved) {
    if (!u || !saved) return;
    for (const key of Object.keys(saved)) {
      const slot = u[key];
      if (slot) slot.value = saved[key];
    }
  }

  _buildSceneUvEmitPass(fallbackTex = null) {
    const THREE = window.THREE;
    const fb = fallbackTex ?? this._fallbackMaskTex ?? null;
    const c = this.params.color;
    const cr = (c && typeof c === 'object') ? (Number(c.r) || 1) : 1;
    const cg = (c && typeof c === 'object') ? (Number(c.g) || 0.96) : 0.96;
    const cb = (c && typeof c === 'object') ? (Number(c.b) || 0.85) : 0.85;

    this._emitMaterial = new THREE.ShaderMaterial({
      name: 'MapShineWindowLightEmit',
      uniforms: {
        uEffectEnabled: { value: this._enabled ? 1.0 : 0.0 },
        uDebugForceMagenta: { value: 0.0 },
        uIntensity: { value: Math.max(0.0, Number(this.params.intensity) || 0) },
        uFalloff: { value: Math.max(0.01, Number(this.params.falloff) || 1) },
        uColor: { value: new THREE.Color(cr, cg, cb) },
        uForcedFloorIndex: { value: -1.0 },
        uMaxVisibleFloorIndex: { value: -1.0 },
        tWindow0: { value: fb },
        tWindow1: { value: fb },
        tWindow2: { value: fb },
        tWindow3: { value: fb },
        uHasWindow0: { value: 0.0 },
        uHasWindow1: { value: 0.0 },
        uHasWindow2: { value: 0.0 },
        uHasWindow3: { value: 0.0 },
        uWindow0FlipY: { value: 0.0 },
        uWindow1FlipY: { value: 0.0 },
        uWindow2FlipY: { value: 0.0 },
        uWindow3FlipY: { value: 0.0 },
        tFloorIdTex: { value: fb },
        uHasFloorIdTex: { value: 0.0 },
        uFloorIdFlipY: { value: 1.0 },
        uCloudFactor: { value: 1.0 },
        uCloudInfluence: { value: Math.max(0.0, Math.min(1.0, Number(this.params.cloudInfluence) || 0.0)) },
        uCloudShadowTex: { value: fb },
        uHasCloudShadowTex: { value: 0.0 },
        uCloudShadowContrast: { value: Math.max(0.0, Number(this.params.cloudShadowContrast) || 1.0) },
        uCloudShadowBias: { value: Number(this.params.cloudShadowBias) || 0.0 },
        uCloudShadowGamma: { value: Math.max(0.01, Number(this.params.cloudShadowGamma) || 1.0) },
        uCloudShadowMinLight: { value: Math.max(0.0, Math.min(1.0, Number(this.params.cloudShadowMinLight) || 0.0)) },
        uViewBoundsMin: { value: new THREE.Vector2(0, 0) },
        uViewBoundsMax: { value: new THREE.Vector2(1, 1) },
        uHasSparkleView: { value: 0.0 },
        uSparkleViewUvMin: { value: new THREE.Vector2(0, 0) },
        uSparkleViewUvMax: { value: new THREE.Vector2(1, 1) },
        uViewCorner00: { value: new THREE.Vector2(0, 0) },
        uViewCorner10: { value: new THREE.Vector2(1, 0) },
        uViewCorner01: { value: new THREE.Vector2(0, 1) },
        uViewCorner11: { value: new THREE.Vector2(1, 1) },
        uSceneOrigin: { value: new THREE.Vector2(0, 0) },
        uSceneSize: { value: new THREE.Vector2(1, 1) },
        uSceneDimensions: { value: new THREE.Vector2(1, 1) },
        uTodEnabled: { value: 0.0 },
        uTodIntensityScale: { value: 1.0 },
        uTodExposure: { value: 0.0 },
        uTodSaturation: { value: 1.0 },
        uTodTint: { value: new THREE.Color(TOD_TINT_NEUTRAL, TOD_TINT_NEUTRAL, TOD_TINT_NEUTRAL) },
        tSpecular0: { value: fb },
        tSpecular1: { value: fb },
        tSpecular2: { value: fb },
        tSpecular3: { value: fb },
        uHasSpecular0: { value: 0.0 },
        uHasSpecular1: { value: 0.0 },
        uHasSpecular2: { value: 0.0 },
        uHasSpecular3: { value: 0.0 },
        uSpecular0FlipY: { value: 0.0 },
        uSpecular1FlipY: { value: 0.0 },
        uSpecular2FlipY: { value: 0.0 },
        uSpecular3FlipY: { value: 0.0 },
        uMaskTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        uTime: { value: 0.0 },
        uGlassRefractionEnabled: { value: 1.0 },
        uRgbShiftAmount: { value: 4.42 },
        uRgbShiftAngle: { value: 30.0 * (Math.PI / 180.0) },
        uRgbShiftSpread: { value: 0.35 },
        uRgbShiftEdgeWeight: { value: 0.55 },
        uRgbShiftAnimate: { value: 1.0 },
        uRgbShiftAnimSpeed: { value: 0.55 },
        uRgbShiftAnimWobbleDeg: { value: 28.0 },
        uRgbFringeSaturation: { value: 1.35 },
        uRgbFringeBalance: { value: new THREE.Vector3(1, 1, 1) },
        uSpecularBoost: { value: 2.0 },
        uSparkleEnabled: { value: 1.0 },
        uSparkleStrength: { value: 1.35 },
        uSparkleSpeed: { value: 1.4 },
        uSparkleScale: { value: 38.0 },
        uSparkleThreshold: { value: 0.12 },
        uSparkleEdgeBias: { value: 0.72 },
        uSparkleColor: { value: new THREE.Color(1, 0.98, 0.92) },
        uLightningWindowEnabled: { value: 1.0 },
        uLightningFlash01: { value: 0.0 },
        uLightningWindowIntensityBoost: { value: 1.0 },
        uLightningWindowContrastBoost: { value: 1.75 },
        uLightningWindowRgbBoost: { value: 0.35 },
      },
      vertexShader: EMIT_VERT,
      fragmentShader: EMIT_FRAG,
      toneMapped: false,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._emitMaterial);
    quad.frustumCulled = false;
    this._scene.add(quad);
    this._pushTodUniforms();
    this._pushRefractionUniforms(this._emitMaterial.uniforms);
  }

  _maskImageSize(tex) {
    const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
    if (compositor?.getMaskTexturePixelSize) {
      return compositor.getMaskTexturePixelSize(tex);
    }
    const img = tex?.image ?? tex?.source?.data ?? null;
    let w = Number(img?.width) || Number(tex?._msaWidth) || Number(tex?.width) || 0;
    let h = Number(img?.height) || Number(tex?._msaHeight) || Number(tex?.height) || 0;
    return {
      w: Math.max(1, w || 1),
      h: Math.max(1, h || 1),
    };
  }

  /** @private */
  _stampMaskTextureDimensions(tex) {
    if (!tex) return;
    const { w, h } = this._maskImageSize(tex);
    if (w > 1) tex._msaWidth = w;
    if (h > 1) tex._msaHeight = h;
  }

  _resolveEmitMaskReference() {
    return this._litWindowMasks.find((_t, i) => this._hasValidWindowMask(i))
      ?? this._windowMasks.find((t) => !!t)
      ?? this._fallbackMaskTex
      ?? null;
  }

  /**
   * @param {object} THREE
   * @param {'full'|'shadowLift'} purpose
   * @returns {import('three').WebGLRenderTarget|null}
   * @private
   */
  _ensurePurposeEmitTarget(THREE, purpose) {
    const maskTex = this._resolveEmitMaskReference();
    if (!maskTex) return null;

    const shadowLiftOnly = purpose === 'shadowLift';
    const { w, h } = this._computeEmitTargetDimensions(maskTex);
    const sig = `${w}x${h}|${maskTex.uuid ?? ''}|${this._emitResolutionScale}`;
    let rt = shadowLiftOnly ? this._shadowLiftEmitRT : this._emitRT;
    const sigRef = shadowLiftOnly ? '_shadowLiftEmitRtSig' : '_emitRtSig';
    if (rt && this[sigRef] === sig) return rt;

    const prevSig = this[sigRef];
    const le = window.MapShine?.effectComposer?._floorCompositorV2?._lightingEffect ?? null;
    const useHalf = le?.params?.windowLightUseHalfFloat !== false;
    const rtOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: useHalf ? THREE.HalfFloatType : THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    };

    if (!rt) {
      rt = new THREE.WebGLRenderTarget(w, h, rtOpts);
      rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
      rt.texture.flipY = false;
      rt.texture.wrapS = THREE.ClampToEdgeWrapping;
      rt.texture.wrapT = THREE.ClampToEdgeWrapping;
      if (shadowLiftOnly) this._shadowLiftEmitRT = rt;
      else this._emitRT = rt;
    } else {
      rt.setSize(w, h);
      rt.texture.flipY = false;
      rt.texture.wrapS = THREE.ClampToEdgeWrapping;
      rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    }
    if (!shadowLiftOnly && prevSig && prevSig !== sig) {
      this._invalidateEmitDrawCache();
    }
    this[sigRef] = sig;
    return rt;
  }

  _ensureFallbackTextures(THREE) {
    if (this._fallbackMaskTex) return;
    try {
      const data = new Uint8Array([0, 0, 0, 0]);
      this._fallbackMaskTex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
      this._fallbackMaskTex.needsUpdate = true;
      this._fallbackMaskTex.flipY = false;
      this._fallbackMaskTex.generateMipmaps = false;
      this._fallbackMaskTex.minFilter = THREE.NearestFilter;
      this._fallbackMaskTex.magFilter = THREE.NearestFilter;
      this._fallbackMaskTex.name = 'MapShineWindowLightMaskFallback';
    } catch (err) {
      log.warn('_ensureFallbackTextures failed:', err);
      this._fallbackMaskTex = null;
    }
  }

  _refreshOverlayShim() {
    this._overlays.clear();
    for (let i = 0; i < 4; i += 1) {
      if (this._hasValidWindowMask(i)) {
        this._overlays.set(`__compositor_floor_${i}__`, { floorIndex: i });
      }
    }
  }

  /**
   * @param {number} rw
   * @param {number} rh
   * @param {import('three').Camera|null} renderCamera
   * @private
   */
  _bindWindowLightPass(rw, rh, renderCamera) {
    void rw;
    void rh;
    this._syncViewProjectionUniforms(renderCamera ?? null);
    this._updateSceneBounds();
    const u = this._emitMaterial?.uniforms;
    if (u) this._syncCloudUniformsFromParams(u);
  }

  /** @private */
  _syncCloudUniformsFromParams(u) {
    if (!u) return;
    const weather = window.MapShine?.weatherController ?? null;
    const env = weather?.getEnvironment?.() ?? {};
    const overcastFactor = Math.max(0.0, Math.min(1.0, Number(env?.overcastFactor) || 0.0));
    const stormFactor = Math.max(0.0, Math.min(1.0, Number(env?.stormFactor) || 0.0));
    const cloudFactor = Math.max(0.0, Math.min(1.0, (1.0 - overcastFactor * 0.55) * (1.0 - stormFactor * 0.25)));
    u.uCloudFactor.value = cloudFactor;
    u.uCloudInfluence.value = Math.max(0.0, Math.min(1.0, Number(this.params.cloudInfluence) || 0.0));
    u.uCloudShadowContrast.value = Math.max(0.0, Number(this.params.cloudShadowContrast) || 1.0);
    u.uCloudShadowBias.value = Number(this.params.cloudShadowBias) || 0.0;
    u.uCloudShadowGamma.value = Math.max(0.01, Number(this.params.cloudShadowGamma) || 1.0);
    u.uCloudShadowMinLight.value = Math.max(0.0, Math.min(1.0, Number(this.params.cloudShadowMinLight) || 0.0));
    u.uCloudShadowTex.value = this._cloudShadowTex ?? this._fallbackMaskTex ?? null;
    u.uHasCloudShadowTex.value = this._cloudShadowTex ? 1.0 : 0.0;
  }

  /** @private Match LightingEffectV2 compose: bilinear view corners + scene rect. */
  _syncViewProjectionUniforms(camera) {
    const dims = canvas?.dimensions;
    if (!dims) return;

    const sc = window.MapShine?.sceneComposer ?? null;
    const cam = camera ?? sc?.camera ?? null;
    if (!cam) return;

    const groundZ = sc?.basePlaneMesh?.position?.z ?? (sc?.groundZ ?? 0);
    const THREE = window.THREE;
    if (!this._clipTmpNdcVec && THREE) {
      this._clipTmpNdcVec = new THREE.Vector3();
      this._clipTmpWorldVec = new THREE.Vector3();
      this._clipTmpDirVec = new THREE.Vector3();
    }

    updateSceneViewProjectionFromCamera(
      cam,
      groundZ,
      this._viewProjectionCache,
      {
        ndc: this._clipTmpNdcVec,
        world: this._clipTmpWorldVec,
        dir: this._clipTmpDirVec,
      },
    );

    applySceneViewProjectionToUniforms(this._viewProjectionCache, this._emitMaterial?.uniforms);

    const fd = this._lastFoundrySceneData ?? sc?.foundrySceneData ?? null;
    this._applySceneRectUniforms(this._emitMaterial?.uniforms, dims, fd);
  }

  /**
   * Scene rect + canvas dimensions — must match LightingEffectV2 compose (not raw fd.width).
   * @param {Record<string, *>|null} uniforms
   * @param {object|null} dims
   * @param {object|null} foundrySceneData
   * @private
   */
  _applySceneRectUniforms(uniforms, dims, foundrySceneData) {
    const u = uniforms;
    if (!u?.uSceneOrigin || !u?.uSceneSize || !u?.uSceneDimensions) return;

    const fd = foundrySceneData ?? null;
    const sr = dims?.sceneRect ?? dims;
    const sceneX = Number(sr?.x ?? 0);
    const sceneY = Number(sr?.y ?? 0);
    const sceneW = Number(sr?.width ?? dims?.sceneWidth ?? fd?.sceneWidth ?? 1);
    const sceneH = Number(sr?.height ?? dims?.sceneHeight ?? fd?.sceneHeight ?? 1);
    const canvasW = Number(dims?.width ?? fd?.width ?? 1);
    const canvasH = Number(dims?.height ?? fd?.height ?? 1);

    u.uSceneOrigin.value.set(sceneX, sceneY);
    u.uSceneSize.value.set(sceneW, sceneH);
    u.uSceneDimensions.value.set(canvasW, canvasH);
    this._syncSparkleViewUniforms(fd, sceneX, sceneY, sceneW, sceneH, canvasH);
  }

  /**
   * Scene-UV bounds of the ground-plane camera frustum for sparkle density gating.
   * @private
   */
  _worldXYToSceneUv(wx, wy, sceneX, sceneY, sceneW, sceneH, canvasH) {
    const foundryY = canvasH - wy;
    return {
      u: (wx - sceneX) / Math.max(1e-5, sceneW),
      v: (foundryY - sceneY) / Math.max(1e-5, sceneH),
    };
  }

  /** @private */
  _syncSparkleViewUniforms(fd, sceneX, sceneY, sceneW, sceneH, canvasH) {
    const u = this._emitMaterial?.uniforms;
    if (!u?.uSparkleViewUvMin || !u?.uSparkleViewUvMax) return;

    const cache = this._viewProjectionCache;
    if (!cache?.isValid) {
      u.uHasSparkleView.value = 0.0;
      u.uSparkleViewUvMin.value.set(0, 0);
      u.uSparkleViewUvMax.value.set(1, 1);
      return;
    }

    const corners = [
      [cache.c00x, cache.c00y],
      [cache.c10x, cache.c10y],
      [cache.c01x, cache.c01y],
      [cache.c11x, cache.c11y],
    ];
    let minU = 1;
    let minV = 1;
    let maxU = 0;
    let maxV = 0;
    for (const [wx, wy] of corners) {
      const uv = this._worldXYToSceneUv(wx, wy, sceneX, sceneY, sceneW, sceneH, canvasH);
      minU = Math.min(minU, uv.u);
      minV = Math.min(minV, uv.v);
      maxU = Math.max(maxU, uv.u);
      maxV = Math.max(maxV, uv.v);
    }

    const pad = 0.05;
    u.uHasSparkleView.value = 1.0;
    u.uSparkleViewUvMin.value.set(
      Math.max(0, minU - pad),
      Math.max(0, minV - pad),
    );
    u.uSparkleViewUvMax.value.set(
      Math.min(1, maxU + pad),
      Math.min(1, maxV + pad),
    );
  }

  /** @private */
  _updateSceneBounds() {
    const dims = canvas?.dimensions ?? null;
    const fd = this._lastFoundrySceneData
      ?? window.MapShine?.sceneComposer?.foundrySceneData
      ?? null;
    this._applySceneRectUniforms(this._emitMaterial?.uniforms, dims, fd);
  }

  _levelContextForFloorIndex(floorIndex) {
    try {
      const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
      const floor = floors.find((f) => Number(f?.index) === Number(floorIndex)) ?? null;
      if (!floor) return window.MapShine?.activeLevelContext ?? null;
      const bottom = Number(floor.elevationMin);
      const top = Number(floor.elevationMax);
      if (!Number.isFinite(bottom)) return window.MapShine?.activeLevelContext ?? null;
      return { bottom, top: Number.isFinite(top) ? top : undefined };
    } catch (_) {
      return window.MapShine?.activeLevelContext ?? null;
    }
  }

  _resolveCompositorWindowMaskForFloor(floor, compositor) {
    const key = floor?.compositorKey;
    const idx = Number(floor?.index);
    if (!compositor || !key) return null;

    const lvlCtx = this._levelContextForFloorIndex(idx);
    const gpu = resolveCompositorFloorMaskTexture(compositor, WINDOW_MASK_ALIASES, lvlCtx);
    if (gpu?.texture) return gpu.texture;

    return compositor.getFloorTexture?.(key, 'windows')
      ?? compositor.getFloorTexture?.(key, 'structural')
      ?? null;
  }

  _resolveCompositorSpecularMaskForFloor(floor, compositor) {
    const key = floor?.compositorKey;
    const idx = Number(floor?.index);
    if (!compositor || !key) return null;

    const lvlCtx = this._levelContextForFloorIndex(idx);
    const gpu = resolveCompositorFloorMaskTexture(compositor, SPECULAR_MASK_ALIASES, lvlCtx);
    if (gpu?.texture) return gpu.texture;

    return compositor.getFloorTexture?.(key, 'specular') ?? null;
  }

  /** @private */
  _rebuildLitSpecularMasks() {
    for (let idx = 0; idx < 4; idx += 1) {
      this._litSpecularMasks[idx] = this._specularMasks[idx] ?? null;
    }
  }

  /**
   * @param {number} floorIndex
   * @returns {boolean}
   * @private
   */
  _hasValidSpecularMask(floorIndex) {
    const idx = Number(floorIndex);
    if (!Number.isFinite(idx) || idx < 0 || idx > 3) return false;
    const mask = this._litSpecularMasks?.[idx] ?? null;
    const fb = this._fallbackMaskTex;
    if (!mask) return false;
    if (!fb) return true;
    return mask !== fb && mask.uuid !== fb.uuid;
  }

  _resolveBasePathForFloorIndex(floorIndex) {
    try {
      const sc = window.MapShine?.sceneComposer ?? null;
      const scene = canvas?.scene ?? null;
      if (!sc || !scene || typeof sc.extractBasePath !== 'function') return null;
      const levels = scene?.levels?.sorted ?? scene?.levels?.contents ?? [];
      const target = levels.find((l) => Number(l?.index) === Number(floorIndex)) ?? null;
      const bgSrc = target?.background?.src ?? null;
      if (typeof bgSrc !== 'string' || !bgSrc.trim()) return null;
      const bp = sc.extractBasePath(bgSrc.trim());
      return (typeof bp === 'string' && bp.trim()) ? bp.trim() : null;
    } catch (_) {
      return null;
    }
  }

  _resolveViewedLevelWindowProbeInfo() {
    try {
      const scene = canvas?.scene ?? null;
      const viewedSrc = getViewedLevelBackgroundSrc(scene);
      const ext = (() => {
        const s = String(viewedSrc || '');
        const noQuery = s.split('?')[0];
        const dot = noQuery.lastIndexOf('.');
        return dot >= 0 ? noQuery.slice(dot + 1).toLowerCase() : 'webp';
      })();
      return { viewedSrc: viewedSrc || null, ext: ext || 'webp' };
    } catch (_) {
      return { viewedSrc: null, ext: 'webp' };
    }
  }

  _resolveWindowProbeInfoForFloorIndex(floorIndex) {
    try {
      const scene = canvas?.scene ?? null;
      const levels = scene?.levels?.sorted ?? scene?.levels?.contents ?? [];
      const target = levels.find((l) => Number(l?.index) === Number(floorIndex)) ?? null;
      const bgSrc = target?.background?.src ?? null;
      if (typeof bgSrc !== 'string' || !bgSrc.trim()) {
        return this._resolveViewedLevelWindowProbeInfo();
      }
      const s = bgSrc.trim();
      const noQuery = s.split('?')[0];
      const dot = noQuery.lastIndexOf('.');
      const ext = dot >= 0 ? noQuery.slice(dot + 1).toLowerCase() : 'webp';
      return { viewedSrc: s, ext: ext || 'webp' };
    } catch (_) {
      return this._resolveViewedLevelWindowProbeInfo();
    }
  }

  async _probeWindowMaskTextureForBasePath(basePath, floorIndex = null) {
    if (!basePath) return null;
    const info = Number.isFinite(Number(floorIndex))
      ? this._resolveWindowProbeInfoForFloorIndex(Number(floorIndex))
      : this._resolveViewedLevelWindowProbeInfo();

    try {
      const scene = canvas?.scene ?? null;
      const flag = getMaskTextureManifest(scene);
      const maskSourceSrc = info.viewedSrc ?? null;
      if (flag && maskTextureManifestMatchesLoadContext(flag, basePath, maskSourceSrc)) {
        for (const key of ['windows', 'structural']) {
          const p = flag?.pathsByMaskId?.[key] ?? null;
          if (typeof p === 'string' && p.trim()) {
            const tex = await loadTexture(p.trim(), { suppressProbeErrors: true });
            if (tex) return tex;
          }
        }
      }
    } catch (_) {}

    const suffixes = ['_Windows', '_Structural', '_windows', '_structural'];
    for (const suffix of suffixes) {
      const probed = await probeMaskFile(basePath, suffix, { allowConventionProbe: false });
      const resolvedPath = probed?.path ?? null;
      if (!resolvedPath) continue;
      try {
        const tex = await loadTexture(resolvedPath, { suppressProbeErrors: true });
        if (tex) return tex;
      } catch (_) {}
    }
    return null;
  }

  /**
   * Load per-level `_Windows` / `_Structural` when compositor slot is empty or ground-duplicated.
   * @param {number} floorIndex
   * @param {string} [groundMaskUuid]
   * @returns {boolean}
   * @private
   */
  _tryAssignWindowBundleMaskForFloor(floorIndex, groundMaskUuid = null) {
    const idx = Number(floorIndex);
    if (!Number.isFinite(idx) || idx < 0 || idx > 3) return false;
    const floorBasePath = this._resolveBasePathForFloorIndex(idx);
    if (!floorBasePath) return false;
    const cached = this._windowBundleByBasePath.get(floorBasePath) ?? null;
    if (!this._windowBundleByBasePath.has(floorBasePath) || cached == null) {
      this._scheduleWindowBundleLoadForBasePath(floorBasePath, idx);
    }
    if (!cached?.uuid) return false;
    if (groundMaskUuid && cached.uuid === groundMaskUuid) return false;
    this._windowMasks[idx] = cached;
    return true;
  }

  /** @private */
  _rebuildLitWindowMasks() {
    if (!this._litMasksDirty) return;
    this._litMasksDirty = false;
    const groundUuid = this._windowMasks[0]?.uuid ?? null;
    this._litWindowMasks = [null, null, null, null];
    for (let idx = 0; idx < 4; idx += 1) {
      if (idx === 0) {
        this._litWindowMasks[0] = this._windowMasks[0] ?? null;
        continue;
      }
      const bundleMask = this._getDistinctBundleMaskForFloor(idx, groundUuid);
      if (bundleMask) {
        this._litWindowMasks[idx] = bundleMask;
        continue;
      }
      const compositorMask = this._windowMasks[idx] ?? null;
      if (compositorMask?.uuid && compositorMask.uuid !== groundUuid) {
        this._litWindowMasks[idx] = compositorMask;
        continue;
      }
      this._litWindowMasks[idx] = null;
    }
  }

  /**
   * @param {number} floorIndex
   * @param {string|null} groundMaskUuid
   * @returns {import('three').Texture|null}
   * @private
   */
  _getDistinctBundleMaskForFloor(floorIndex, groundMaskUuid) {
    const floorBasePath = this._resolveBasePathForFloorIndex(floorIndex);
    if (!floorBasePath) return null;
    const cached = this._windowBundleByBasePath.get(floorBasePath) ?? null;
    if (cached?.uuid && (!groundMaskUuid || cached.uuid !== groundMaskUuid)) {
      return cached;
    }
    if (!this._windowBundleByBasePath.has(floorBasePath) || cached == null) {
      this._scheduleWindowBundleLoadForBasePath(floorBasePath, floorIndex);
    }
    return null;
  }

  /** @private */
  _primeWindowBundleLoadsForAllFloors() {
    for (let idx = 1; idx < 4; idx += 1) {
      const floorBasePath = this._resolveBasePathForFloorIndex(idx);
      if (floorBasePath) this._scheduleWindowBundleLoadForBasePath(floorBasePath, idx);
    }
  }

  _scheduleWindowBundleLoadForBasePath(basePath, floorIndex = null) {
    if (!basePath || this._windowBundleLoadsInFlight.has(basePath)) return;
    if (this._windowBundleMissPaths.has(basePath)) return;
    const now = Date.now();
    const last = Number(this._windowBundleLastAttemptMs.get(basePath) ?? 0);
    if (last > 0 && (now - last) < 1200) return;
    this._windowBundleLastAttemptMs.set(basePath, now);
    this._windowBundleLoadsInFlight.add(basePath);
    const run = async () => {
      try {
        const directTex = await this._probeWindowMaskTextureForBasePath(basePath, floorIndex);
        if (directTex) {
          this._windowBundleByBasePath.set(basePath, directTex);
          return;
        }
        const result = await loadAssetBundle(basePath, null, {
          skipBaseTexture: true,
          suppressProbeErrors: true,
          bypassCache: true,
          maskIds: ['windows', 'structural'],
          allowConventionProbe: true,
          maskConventionFallback: 'full',
        });
        const masks = result?.bundle?.masks ?? [];
        const hit = Array.isArray(masks)
          ? masks.find((m) => {
            const id = String(m?.id ?? m?.type ?? '').toLowerCase();
            const suffix = String(m?.suffix ?? '').toLowerCase();
            return id.includes('window') || id.includes('structural')
              || suffix === '_windows' || suffix === '_structural';
          })
          : null;
        const bundleTex = hit?.texture ?? null;
        this._windowBundleByBasePath.set(basePath, bundleTex);
        if (!bundleTex) this._windowBundleMissPaths.add(basePath);
      } catch (_) {
        this._windowBundleByBasePath.set(basePath, null);
        this._windowBundleMissPaths.add(basePath);
      } finally {
        this._windowBundleLoadsInFlight.delete(basePath);
      }
    };
    void run();
  }

  /**
   * @param {number} floorIndex
   * @returns {boolean}
   * @private
   */
  _hasValidWindowMask(floorIndex) {
    const idx = Number(floorIndex);
    if (!Number.isFinite(idx) || idx < 0 || idx > 3) return false;
    const mask = this._litWindowMasks?.[idx] ?? null;
    const fb = this._fallbackMaskTex;
    if (!mask) return false;
    if (!fb) return true;
    return mask !== fb && mask.uuid !== fb.uuid;
  }

  _bindCompositorMaskUniforms() {
    const u = this._emitMaterial?.uniforms;
    if (!u) return;

    const fallback = this._fallbackMaskTex ?? null;

    for (let i = 0; i < 4; i += 1) {
      const valid = this._hasValidWindowMask(i);
      const tex = valid ? (this._litWindowMasks[i] ?? fallback) : fallback;
      u[`tWindow${i}`].value = tex ?? fallback;
      u[`uHasWindow${i}`].value = valid ? 1.0 : 0.0;
      u[`uWindow${i}FlipY`].value = (valid && this._litWindowMasks[i]?.flipY) ? 1.0 : 0.0;
    }

    for (let i = 0; i < 4; i += 1) {
      const specValid = this._hasValidSpecularMask(i);
      const specTex = specValid ? (this._litSpecularMasks[i] ?? fallback) : fallback;
      u[`tSpecular${i}`].value = specTex ?? fallback;
      u[`uHasSpecular${i}`].value = specValid ? 1.0 : 0.0;
      u[`uSpecular${i}FlipY`].value = (specValid && this._litSpecularMasks[i]?.flipY) ? 1.0 : 0.0;
    }

    u.tFloorIdTex.value = this._floorIdTex ?? fallback;
    u.uHasFloorIdTex.value = this._floorIdTex ? 1.0 : 0.0;
    u.uFloorIdFlipY.value = 1.0;

    const refMask = this._resolveEmitMaskReference();
    if (u.uMaskTexelSize && refMask) {
      const { w, h } = this._maskImageSize(refMask);
      u.uMaskTexelSize.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
    }
  }

  _bindFloorSliceUniforms() {
    const u = this._emitMaterial?.uniforms;
    if (!u) return;

    const renderFloor = Number(this._renderFloorIndex);
    if (Number.isFinite(renderFloor)) {
      if (this._renderFloorSliceStrict) {
        u.uForcedFloorIndex.value = Math.max(0, Math.min(3, renderFloor));
        u.uMaxVisibleFloorIndex.value = -1.0;
      } else {
        u.uForcedFloorIndex.value = -1.0;
        u.uMaxVisibleFloorIndex.value = Math.max(0, Math.min(3, renderFloor));
      }
    } else {
      u.uForcedFloorIndex.value = -1.0;
      u.uMaxVisibleFloorIndex.value = -1.0;
    }
  }

  _prepareWindowLightDrawState(renderer, rt) {
    const THREE = window.THREE;
    const prev = {
      viewport: null,
      scissorTest: renderer.getScissorTest?.() ?? false,
      autoClear: renderer.autoClear,
      clearColor: null,
      clearAlpha: null,
    };
    if (THREE?.Vector4 && typeof renderer.getViewport === 'function') {
      prev.viewport = new THREE.Vector4();
      renderer.getViewport(prev.viewport);
    }
    if (typeof renderer.getClearColor === 'function') {
      prev.clearColor = new THREE.Color();
      renderer.getClearColor(prev.clearColor);
      prev.clearAlpha = renderer.getClearAlpha?.() ?? 1;
    }
    renderer.setScissorTest(false);
    // Must bind emit RT before clear — Pass 1 leaves the active target on `_lightRT`.
    if (rt) {
      renderer.setRenderTarget(rt);
      if (typeof renderer.setViewport === 'function') {
        renderer.setViewport(0, 0, Math.max(1, rt.width), Math.max(1, rt.height));
      }
    }
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    return prev;
  }

  _restoreWindowLightDrawState(renderer, prev) {
    if (prev?.viewport && typeof renderer.setViewport === 'function') {
      renderer.setViewport(prev.viewport.x, prev.viewport.y, prev.viewport.z, prev.viewport.w);
    }
    if (typeof renderer.setScissorTest === 'function') {
      renderer.setScissorTest(prev?.scissorTest ?? false);
    }
    if (prev?.clearColor && typeof renderer.setClearColor === 'function') {
      renderer.setClearColor(prev.clearColor, prev.clearAlpha ?? 1);
    }
    renderer.autoClear = prev?.autoClear ?? true;
  }
}
