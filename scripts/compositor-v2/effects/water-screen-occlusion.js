/**
 * Screen-space occlusion shared with WaterEffectV2 / water-shader.js.
 * Splashes and bubbles sample the same RTs and GLSL thresholds as the water pass.
 *
 * @module compositor-v2/effects/water-screen-occlusion
 */

/** Splash/bubble shader marker — bump {@link SPLASH_OCCLUSION_SHADER_EPOCH} when GLSL changes. */
export const SPLASH_OCCLUSION_MASK_MARKER = '/* MS_WATER_SPLASHES_MASKING_V2 */';
export const SPLASH_OCCLUSION_SHADER_EPOCH = 4;

/**
 * GLSL helpers (must stay in sync with water-shader.js).
 * @type {string}
 */
export const WATER_SCREEN_OCCLUSION_GLSL = `
float msaWaterOccluderAlphaSoft(vec2 screenUv) {
  if (uHasWaterOccluderAlpha < 0.5) return 0.0;
  vec2 px = 1.0 / max(uResolution, vec2(1.0));
  float c = texture2D(tWaterOccluderAlpha, screenUv).a;
  float n = texture2D(tWaterOccluderAlpha, screenUv + vec2(0.0, px.y)).a;
  float s = texture2D(tWaterOccluderAlpha, screenUv - vec2(0.0, px.y)).a;
  float e = texture2D(tWaterOccluderAlpha, screenUv + vec2(px.x, 0.0)).a;
  float w = texture2D(tWaterOccluderAlpha, screenUv - vec2(px.x, 0.0)).a;
  return 0.72 * c + 0.07 * (n + s + e + w);
}

float msaWaterRoofBlockOcc(vec2 screenUv) {
  if (uHasOverheadRoofBlock < 0.5) return 0.0;
  return smoothstep(0.34, 0.66, texture2D(tOverheadRoofBlock, screenUv).a);
}

float msaWaterSourceScreenOcc(vec2 screenUv) {
  float deck = msaWaterRoofBlockOcc(screenUv);
  if (deck < 0.001) return 0.0;
  if (uHasSliceAlpha > 0.5) {
    return deck * smoothstep(0.10, 0.88, texture2D(tSliceAlpha, screenUv).a);
  }
  return deck;
}

float msaWaterBgTransmittanceAt(vec2 screenUv) {
  if (uHasWaterBgAlphaMask < 0.5) return 1.0;
  return clamp(texture2D(tWaterBgAlphaMask, screenUv).r, 0.0, 1.0);
}
`;

export const SPLASH_OCCLUSION_UNIFORM_DECL =
  'uniform sampler2D tWaterOccluderAlpha;\n' +
  'uniform float uHasWaterOccluderAlpha;\n' +
  'uniform sampler2D tOverheadRoofBlock;\n' +
  'uniform float uHasOverheadRoofBlock;\n' +
  'uniform sampler2D tSliceAlpha;\n' +
  'uniform float uHasSliceAlpha;\n' +
  'uniform sampler2D tWaterBgAlphaMask;\n' +
  'uniform float uHasWaterBgAlphaMask;\n' +
  'uniform vec2 uResolution;\n';

/**
 * Particle alpha gate (inverse of water visibility at the same screen UV).
 * @type {string}
 */
export const SPLASH_WATER_SCREEN_OCCLUSION_CLIP_GLSL =
  '  vec2 msaScreenUv = gl_FragCoord.xy / max(uResolution, vec2(1.0));\n' +
  '  float msaRawW = 1.0;\n' +
  '  if (uUseWaterMaskClip > 0.5 && uHasWaterMask > 0.5) {\n' +
  '    vec2 uvMask = vec2(\n' +
  '      (vMsWorldPos.x - uSceneBounds.x) / uSceneBounds.z,\n' +
  '      (vMsWorldPos.y - uSceneBounds.y) / uSceneBounds.w\n' +
  '    );\n' +
  '    if (uWaterFlipV > 0.5) uvMask.y = 1.0 - uvMask.y;\n' +
  '    if (uvMask.x < 0.0 || uvMask.x > 1.0 || uvMask.y < 0.0 || uvMask.y > 1.0) {\n' +
  '      msaRawW = 0.0;\n' +
  '    } else {\n' +
  '      msaRawW = texture2D(uWaterMask, uvMask).r;\n' +
  '    }\n' +
  '    gl_FragColor.a *= msaRawW;\n' +
  '  }\n' +
  '  if (uHasWaterOccluderAlpha > 0.5) {\n' +
  '    float occ = msaWaterOccluderAlphaSoft(msaScreenUv);\n' +
  '    gl_FragColor.a *= (1.0 - smoothstep(0.36, 0.64, occ));\n' +
  '  }\n' +
  '  if (uHasOverheadRoofBlock > 0.5) {\n' +
  '    float srcOcc = msaWaterSourceScreenOcc(msaScreenUv);\n' +
  '    float sourceOverheadGate = srcOcc * smoothstep(0.02, 0.08, msaRawW);\n' +
  '    gl_FragColor.a *= (1.0 - sourceOverheadGate);\n' +
  '  }\n' +
  '  if (uHasWaterBgAlphaMask > 0.5) {\n' +
  '    gl_FragColor.a *= msaWaterBgTransmittanceAt(msaScreenUv);\n' +
  '  }\n';

/** @param {string} fs @returns {boolean} */
export function splashShaderHasWaterScreenOcclusion(fs) {
  return typeof fs === 'string'
    && fs.includes(SPLASH_OCCLUSION_MASK_MARKER)
    && fs.includes('msaWaterOccluderAlphaSoft');
}

/**
 * @param {import('three')} THREE
 * @returns {object}
 */
export function createSplashOcclusionUniforms(THREE) {
  return {
    tWaterOccluderAlpha: { value: null },
    uHasWaterOccluderAlpha: { value: 0.0 },
    tOverheadRoofBlock: { value: null },
    uHasOverheadRoofBlock: { value: 0.0 },
    tSliceAlpha: { value: null },
    uHasSliceAlpha: { value: 0.0 },
    tWaterBgAlphaMask: { value: null },
    uHasWaterBgAlphaMask: { value: 0.0 },
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
}

/**
 * Same textures WaterEffectV2.render() binds for post-merge / per-level passes.
 *
 * @param {object|null} floorCompositor
 * @param {number} viewFloor
 * @param {number} systemFloorIndex
 * @param {boolean} [deferFrameOccluders=false]
 * @returns {{ waterOccluderAlpha: import('three').Texture|null, overheadRoofBlock: import('three').Texture|null, sliceAlpha: import('three').Texture|null, waterBgAlphaMask: import('three').Texture|null, source: string }}
 */
export function resolveSplashOcclusionBindings(
  floorCompositor,
  viewFloor,
  systemFloorIndex,
  deferFrameOccluders = false,
) {
  const view = Number(viewFloor);
  const sfi = Number(systemFloorIndex);
  if (!Number.isFinite(sfi) || !Number.isFinite(view)) {
    return {
      waterOccluderAlpha: null,
      overheadRoofBlock: null,
      sliceAlpha: null,
      waterBgAlphaMask: null,
      source: 'invalid',
    };
  }
  if (deferFrameOccluders && sfi <= view) {
    return {
      waterOccluderAlpha: null,
      overheadRoofBlock: null,
      sliceAlpha: null,
      waterBgAlphaMask: null,
      source: 'frame-occluder-deferred',
    };
  }

  const fc = floorCompositor ?? null;
  let waterFi = -1;
  try {
    waterFi = Number(fc?._resolveWaterSourceFloorForView?.(view) ?? -1);
  } catch (_) {}

  let waterOccluderAlpha = null;
  let occSource = 'none';
  if (sfi < view) {
    waterOccluderAlpha = fc?._frameSplashUpperOccluderTexByFloor?.get?.(sfi) ?? null;
    occSource = waterOccluderAlpha ? 'upper-scene-occluder-cached' : 'upper-scene-occluder-missing';
    if (!waterOccluderAlpha && sfi === waterFi) {
      waterOccluderAlpha = fc?._frameUpperWaterOccluderRT?.texture ?? null;
      if (waterOccluderAlpha) occSource = 'frame-upper-water-occluder';
    }
  }

  let overheadRoofBlock = null;
  let roofSource = 'none';
  if (sfi === waterFi && waterFi >= 0) {
    overheadRoofBlock = fc?._frameWaterSourceDeckTex ?? null;
    roofSource = overheadRoofBlock ? 'water-source-deck-mask' : 'water-source-deck-missing';
  } else if (sfi === view) {
    overheadRoofBlock = fc?._frameSameFloorOverheadOccluderRT?.texture
      ?? window.MapShine?.__frameSameFloorOverheadOccluderTex
      ?? null;
    roofSource = overheadRoofBlock ? 'same-floor-overhead-occluder' : 'same-floor-overhead-missing';
  }

  let sliceAlpha = null;
  if (sfi === waterFi && waterFi >= 0) {
    sliceAlpha = fc?._frameWaterSourceSliceTex ?? null;
  }

  const waterBgAlphaMask = fc?._frameWaterBgAlphaMaskTex
    ?? window.MapShine?.__frameWaterBgAlphaMaskTex
    ?? null;

  return {
    waterOccluderAlpha,
    overheadRoofBlock,
    sliceAlpha,
    waterBgAlphaMask,
    source: `${occSource}|${roofSource}`,
  };
}

/**
 * @param {object|null} u - material.userData._msSplashOcclusionUniforms
 * @param {ReturnType<typeof resolveSplashOcclusionBindings>} bindings
 * @param {number} resX
 * @param {number} resY
 * @param {import('three').Texture|null} systemWaterMaskTex
 * @param {object} [waterClip]
 */
export function applySplashOcclusionUniforms(
  u,
  bindings,
  resX,
  resY,
  systemWaterMaskTex,
  waterClip = {},
) {
  if (!u || !bindings) return;
  const b = bindings;
  u.tWaterOccluderAlpha.value = b.waterOccluderAlpha;
  u.uHasWaterOccluderAlpha.value = b.waterOccluderAlpha ? 1.0 : 0.0;
  u.tOverheadRoofBlock.value = b.overheadRoofBlock;
  u.uHasOverheadRoofBlock.value = b.overheadRoofBlock ? 1.0 : 0.0;
  u.tSliceAlpha.value = b.sliceAlpha;
  u.uHasSliceAlpha.value = b.sliceAlpha ? 1.0 : 0.0;
  u.tWaterBgAlphaMask.value = b.waterBgAlphaMask;
  u.uHasWaterBgAlphaMask.value = b.waterBgAlphaMask ? 1.0 : 0.0;
  u.uResolution.value.set(resX, resY);
  u.uWaterMask.value = systemWaterMaskTex;
  u.uHasWaterMask.value = systemWaterMaskTex ? 1.0 : 0.0;
  if (u.uUseWaterMaskClip) u.uUseWaterMaskClip.value = waterClip.useWaterMaskClip ?? 1.0;
  if (u.uWaterFlipV) u.uWaterFlipV.value = waterClip.waterFlipV ? 1.0 : 0.0;
  if (waterClip.sceneBounds && u.uSceneBounds?.value?.set) {
    u.uSceneBounds.value.set(
      waterClip.sceneBounds.sx,
      waterClip.sceneBounds.syWorld,
      waterClip.sceneBounds.sw,
      waterClip.sceneBounds.sh,
    );
  }
}

/**
 * Inject water-parity occlusion into a quarks fragment shader (after soft_fragment).
 * @param {string} fs
 * @returns {string}
 */
export function injectSplashWaterScreenOcclusion(fs) {
  if (typeof fs !== 'string') return fs;
  const marker = SPLASH_OCCLUSION_MASK_MARKER;
  let out = fs;
  if (!out.includes('msaWaterOccluderAlphaSoft')) {
    if (out.includes(marker)) {
      out = out.replace(marker + '\n', `${marker}\n${WATER_SCREEN_OCCLUSION_GLSL}\n`);
    }
  }
  if (out.includes('msaScreenUv = gl_FragCoord')) {
    return repairSplashWaterMaskAlphaClip(out);
  }
  if (out.includes('#include <soft_fragment>')) {
    return out.replace(
      '#include <soft_fragment>',
      `#include <soft_fragment>\n${SPLASH_WATER_SCREEN_OCCLUSION_CLIP_GLSL}`,
    );
  }
  return out.replace(marker + '\n', `${marker}\n${WATER_SCREEN_OCCLUSION_GLSL}\n${SPLASH_WATER_SCREEN_OCCLUSION_CLIP_GLSL}`);
}

/**
 * Strip legacy floor-presence masking and re-inject V2 block after soft_fragment.
 * @param {string} fs
 * @returns {string}
 */
export function repairSplashOcclusionShaderIfLegacy(fs) {
  if (typeof fs !== 'string' || !fs.includes('#include <soft_fragment>')) return fs;
  let s = fs;
  if (s.includes('uFloorPresenceMap') || s.includes('uHasFloorPresenceMap')) {
    s = s.replace(
      /\s*\/\/ Floor-presence gate:[\s\S]*?gl_FragColor\.a \*= \(1\.0 - floorPresence\);\s*\}\s*/g,
      '\n',
    );
    s = s.replace(
      /\s*\/\/ Water mask clip:[\s\S]*?gl_FragColor\.a \*= m;\s*\}\s*\}\s*/g,
      '\n',
    );
    s = s.replace(
      /\s*if \(uHasFloorPresenceMap > 0\.5\)[\s\S]*?gl_FragColor\.a \*= \(1\.0 - floorPresence\);\s*\}\s*/g,
      '\n',
    );
    s = s.replace(
      /uniform sampler2D uFloorPresenceMap;\s*uniform float uHasFloorPresenceMap;\s*uniform vec2 uResolution;\s*uniform vec2 uFloorPresenceScissorOrigin;\s*uniform vec2 uFloorPresenceScissorSize;\s*uniform float uFloorPresenceThreshold;\s*uniform float uFloorPresenceSoftness;\s*/g,
      'uniform vec2 uResolution;\n',
    );
    s = s.replace(
      /uniform sampler2D uFloorPresenceMap;\s*uniform float uHasFloorPresenceMap;\s*uniform vec2 uResolution;\s*/g,
      'uniform vec2 uResolution;\n',
    );
  }
  if (!splashShaderHasWaterScreenOcclusion(s)) {
    s = injectSplashWaterScreenOcclusion(s);
  }
  return repairSplashWaterMaskAlphaClip(s);
}

/**
 * Epoch 3 shaders computed msaRawW for overhead gating but omitted the land clip.
 * @param {string} fs
 * @returns {string}
 */
export function repairSplashWaterMaskAlphaClip(fs) {
  if (typeof fs !== 'string' || !fs.includes('msaRawW')) return fs;
  if (fs.includes('gl_FragColor.a *= msaRawW')) return fs;
  if (!fs.includes('texture2D(uWaterMask, uvMask)')) return fs;
  return fs.replace(
    /(msaRawW = texture2D\(uWaterMask, uvMask\)\.r;\n\s*\}\n)(\s*\}\n\s*if \(uHasWaterOccluderAlpha)/,
    '$1    gl_FragColor.a *= msaRawW;\n$2',
  );
}
